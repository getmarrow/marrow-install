require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createStub } = require('./support/agentd-stub');
const { startAgentd, preEvent, decisionOf, writeConfig } = require('./support/agentd-harness');
const { signEnvelope } = require('../src/agentd/policy');

async function withAgentd(options, fn) {
  const stub = createStub();
  await stub.start();
  const agentd = await startAgentd({ stub, ...options });
  try {
    await fn({ stub, agentd });
  } finally {
    await agentd.stop().catch(() => {});
    await stub.stop().catch(() => {});
    agentd.cleanup();
  }
}

function allFilesUnder(dir) {
  const out = [];
  const walk = (d) => { for (const name of fs.readdirSync(d)) { const p = path.join(d, name); const s = fs.lstatSync(p); if (s.isDirectory()) walk(p); else if (s.isFile()) out.push(p); } };
  walk(dir);
  return out;
}

test('routine actions are allowed locally with no server round trip; risky ones go to the server gate', async () => {
  await withAgentd({}, async ({ stub, agentd }) => {
    for (const command of ['git status', 'ls -la', 'npm ci']) {
      assert.equal(decisionOf(await agentd.hook('claude-code', 'pre', preEvent(command))).decision, 'allow');
    }
    assert.equal(stub.count('/v1/agent/gate'), 0);
    stub.state.gateHandler = (body) => (body.action.programs.includes('npm') ? { verdict: 'allow', lease_ms: 60000 } : { verdict: 'deny', reason: 'not now' });
    assert.equal(decisionOf(await agentd.hook('claude-code', 'pre', preEvent('npm publish --access public'))).decision, 'allow');
    assert.equal(stub.count('/v1/agent/gate'), 1);
    const gateBody = stub.state.gateBodies[0];
    assert.equal(gateBody.action.local_class, 'risky');
    assert.deepEqual(gateBody.action.programs, ['npm'], 'the server sees the parsed program, not an opaque summary (ADV-06)');
    // The lease covers an immediate retry of the same action without another round trip.
    assert.equal(decisionOf(await agentd.hook('claude-code', 'pre', preEvent('npm publish --access public'))).decision, 'allow');
    assert.equal(stub.count('/v1/agent/gate'), 1);
    const denied = decisionOf(await agentd.hook('claude-code', 'pre', preEvent('terraform apply -auto-approve')));
    assert.equal(denied.decision, 'deny');
    assert.match(denied.reason, /not now/);
  });
});

test('review_required asks the owner in Claude Code and denies with the approval link in Codex', async () => {
  await withAgentd({}, async ({ stub, agentd }) => {
    stub.state.gateHandler = () => ({ verdict: 'review_required', reason: 'production deploy', approval_url: 'https://getmarrow.ai/account/approvals/apr_1' });
    const claude = decisionOf(await agentd.hook('claude-code', 'pre', preEvent('wrangler deploy')));
    assert.equal(claude.decision, 'ask');
    assert.match(claude.reason, /getmarrow\.ai\/account\/approvals\/apr_1/);
    const bypassMode = decisionOf(await agentd.hook('claude-code', 'pre', preEvent('wrangler deploy', { permission_mode: 'bypassPermissions' })));
    assert.equal(bypassMode.decision, 'deny', 'no prompt is shown in bypassPermissions mode, so review cannot become an allow');
    const codex = decisionOf(await agentd.hook('codex', 'pre', { hook_event_name: 'PreToolUse', session_id: 's', tool_use_id: 't', tool_name: 'shell', tool_input: { command: ['bash', '-lc', 'wrangler deploy'] }, cwd: '/tmp' }));
    assert.equal(codex.decision, 'deny');
    assert.match(codex.reason, /approvals\/apr_1/);
  });
});

test('server down, 5xx, timeouts and unverifiable verdicts all fail closed for risky actions (R-45)', async () => {
  await withAgentd({ settings: { gateBudgetCapMs: 600 } }, async ({ stub, agentd }) => {
    const risky = () => agentd.hook('claude-code', 'pre', preEvent('npm publish'));
    const unknown = () => agentd.hook('claude-code', 'pre', preEvent('make release'));
    for (const mode of ['500', '503', 'badsig', 'hang']) {
      stub.state.gateMode = mode;
      const started = Date.now();
      const decision = decisionOf(await risky());
      assert.equal(decision.decision, 'deny', `risky under ${mode}`);
      assert.equal(decisionOf(await unknown()).decision, 'deny', `unknown under ${mode}`);
      assert.ok(Date.now() - started < 4000, `bounded by the gate budget under ${mode}`);
    }
    stub.state.gateMode = 'normal';
    stub.state.gateHandler = () => ({ verdict: 'allow', tamperActionHash: true });
    assert.equal(decisionOf(await risky()).decision, 'deny', 'a verdict for a different action is refused');
    await stub.stop();
    assert.equal(decisionOf(await risky()).decision, 'deny', 'connection refused');
    assert.equal(decisionOf(await agentd.hook('claude-code', 'pre', preEvent('git diff'))).decision, 'allow', 'routine work continues during an outage');
    const status = (await agentd.admin('status')).json;
    assert.ok(status.decisions.by_source.gate_unavailable_fail_closed >= 9);
    assert.equal(status.decisions.by_source.outage_bypass, undefined);
  });
});

test('tamper: the governed agent cannot redirect the daemon or weaken control from local files', async () => {
  const attacker = createStub({ name: 'attacker' });
  await attacker.start();
  attacker.state.gateHandler = () => ({ verdict: 'allow' });
  try {
    await withAgentd({}, async ({ stub, agentd }) => {
      stub.state.gateHandler = () => ({ verdict: 'deny', reason: 'blocked by owner policy' });
      // 1. The agent rewrites the daemon config to point at a server it controls.
      const configPath = path.join(agentd.home, '.marrow', 'agentd', 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      fs.writeFileSync(configPath, JSON.stringify({ ...config, base_url: attacker.url }), { mode: 0o600 });
      // 2. It writes env.local with its own base URL and a key (the ADV-05 recipe).
      fs.writeFileSync(path.join(agentd.home, '.marrow', 'env.local'), `MARROW_API_KEY=mrw_test_${crypto.randomBytes(16).toString('hex')}\nMARROW_BASE_URL=${attacker.url}\n`, { mode: 0o600 });
      // 3. It flips the 0.1.6x control.json to disabled.
      fs.writeFileSync(path.join(agentd.home, '.marrow', 'control.json'), JSON.stringify({ version: 1, enabled: false, changed_at: new Date().toISOString(), change_id: `ctl_${'a'.repeat(32)}`, changed_by: 'owner_cli' }), { mode: 0o600 });
      // 4. It plants a policy bundle signed with its own key that turns control off.
      const { privateKey } = crypto.generateKeyPairSync('ed25519');
      const forged = signEnvelope({ schema: 'marrow.policy.v1', version: 99, issued_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600e3).toISOString(), control: { level: 'off', approval_receipt_id: 'forged' } }, privateKey, stub.kid);
      fs.mkdirSync(path.join(agentd.home, '.marrow', 'agentd', 'policy'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(agentd.home, '.marrow', 'agentd', 'policy', 'current.json'), JSON.stringify(forged), { mode: 0o600 });

      const integrity = (await agentd.admin('integrity')).json;
      const codes = integrity.violations.map((v) => v.code);
      assert.ok(codes.includes('config_changed_since_start'));
      assert.ok(codes.includes('base_url_not_allowed'));
      assert.ok(codes.includes('legacy_control_disable_ignored'));

      const decision = decisionOf(await agentd.hook('claude-code', 'pre', preEvent('npm publish')));
      assert.equal(decision.decision, 'deny');
      assert.match(decision.reason, /blocked by owner policy/);
      assert.equal(attacker.state.requests.length, 0, 'nothing ever reached the attacker server');

      // A restarted daemon reads the tampered files but still refuses all of them.
      await agentd.stop();
      const restarted = await startAgentd({ stub, home: agentd.home, root: agentd.root, key: agentd.key });
      try {
        const status = (await restarted.admin('status')).json;
        assert.equal(status.api.base_url, stub.url);
        assert.equal(status.api.base_url_rejected, true);
        assert.equal(status.control.level, 'enforce');
        assert.equal(status.policy.source, 'builtin_baseline');
        assert.match(String(status.policy.last_error), /bad_signature/);
        assert.equal(decisionOf(await restarted.hook('claude-code', 'pre', preEvent('npm publish'))).decision, 'deny');
        assert.equal(attacker.state.requests.length, 0);
      } finally { await restarted.stop(); }
    });
  } finally { await attacker.stop(); }
});

test('owner-only control: an agent request changes nothing until the owner approves on the server', async () => {
  await withAgentd({}, async ({ stub, agentd }) => {
    stub.state.gateHandler = () => ({ verdict: 'deny', reason: 'gated' });
    stub.publishPolicy({ control: { level: 'enforce' } });
    await agentd.admin('refresh-policy');
    const request = (await agentd.admin('control-request', { level: 'off', reason: 'agent wants to ship faster' })).json;
    assert.equal(request.changed_locally, false);
    assert.equal(request.pending_owner_approval, true);
    assert.match(request.approval_url, /^https:\/\/getmarrow\.ai\//);
    await agentd.admin('refresh-policy');
    assert.equal((await agentd.admin('status')).json.control.level, 'enforce');
    assert.equal(decisionOf(await agentd.hook('claude-code', 'pre', preEvent('npm publish'))).decision, 'deny');

    // The owner approves in the dashboard (simulated): the server signs a new policy.
    stub.approveControlRequest(request.request_id);
    await agentd.admin('refresh-policy');
    const status = (await agentd.admin('status')).json;
    assert.equal(status.control.level, 'off');
    assert.equal(status.control.authority, 'owner_signed_policy');
    assert.match(status.control.approval_receipt_id, /^oar_/);
    assert.equal(decisionOf(await agentd.hook('claude-code', 'pre', preEvent('npm publish'))).decision, 'allow');
    await agentd.admin('flush');
    const types = stub.state.events.map((e) => e.type);
    assert.ok(types.includes('control_change_requested'));
    assert.ok(types.includes('control_level_changed'));
  });
});

test('telemetry: 1,000 hook events become a handful of gzip batches with every receipt delivered', async () => {
  await withAgentd({}, async ({ stub, agentd }) => {
    const ids = [];
    for (let i = 0; i < 500; i += 1) {
      const pre = preEvent(i % 2 ? 'git status' : 'ls');
      ids.push(pre.tool_use_id);
      await agentd.hook('claude-code', 'pre', pre);
      await agentd.hook('claude-code', 'post', { ...pre, hook_event_name: 'PostToolUse', tool_response: { success: true } });
    }
    const before = stub.state.requests.length;
    assert.equal(before, 0, 'no request while hooks run');
    await agentd.admin('flush');
    const telemetryRequests = stub.count('/v1/agent/telemetry/batch');
    assert.ok(telemetryRequests <= 3, `1,000 events -> ${telemetryRequests} requests`);
    assert.ok(stub.state.batches.every((b) => b.gzip));
    const receipts = stub.state.events.filter((e) => e.type === 'decision_receipt');
    assert.deepEqual(new Set(receipts.map((r) => r.tool_use_id)), new Set(ids));
    const rollup = stub.state.events.find((e) => e.type === 'activity_rollup');
    assert.equal(rollup.counts['post|claude-code|bash|ok'], 500);
    assert.equal((await agentd.admin('status')).json.queue.pending, 0);
  });
});

test('telemetry: backpressure keeps records, overflow is counted and reported, and the queue drains itself', async () => {
  await withAgentd({ settings: { segmentMaxRecords: 10, laneMaxSegments: { high: 3, normal: 3 }, backoffMinMs: 1, backoffMaxMs: 5 } }, async ({ stub, agentd }) => {
    stub.state.telemetryMode = '503';
    for (let i = 0; i < 60; i += 1) await agentd.hook('claude-code', 'pre', preEvent('git status'));
    await agentd.admin('flush');
    let status = (await agentd.admin('status')).json;
    assert.equal(status.uploader.state, 'backoff');
    assert.equal(status.queue.depth.high, 30, 'capped at 3 segments x 10');
    assert.equal(status.queue.drops.by_reason.overflow, 30, 'every evicted receipt is counted');
    assert.equal(stub.state.events.length, 0);
    stub.state.telemetryMode = 'ok';
    await new Promise((resolve) => setTimeout(resolve, 20));
    await agentd.admin('flush');
    status = (await agentd.admin('status')).json;
    assert.equal(status.queue.pending, 0);
    assert.equal(status.queue.drops.unreported, 0);
    assert.equal(stub.state.events.filter((e) => e.type === 'decision_receipt').length, 30);
    const reported = stub.state.batches.find((b) => b.drops);
    assert.equal(reported.drops.by_reason.overflow, 30);
    const dir = path.join(agentd.home, '.marrow', 'agentd', 'queue');
    assert.deepEqual(fs.readdirSync(path.join(dir, 'high')), []);
    // A whole batch the server refuses as malformed is counted and never retried forever (R-25).
    stub.state.telemetryMode = '400';
    await agentd.hook('claude-code', 'pre', preEvent('git log'));
    await agentd.admin('flush');
    status = (await agentd.admin('status')).json;
    assert.equal(status.queue.pending, 0);
    assert.ok(status.queue.drops.by_reason.rejected >= 1);
  });
});

test('the API key never appears in status, hook output, the queue or anything sent except the auth header', async () => {
  await withAgentd({}, async ({ stub, agentd }) => {
    stub.state.gateHandler = () => ({ verdict: 'deny', reason: 'no' });
    const outputs = [];
    for (const command of ['git status', 'npm publish', 'cat ~/.marrow/env']) outputs.push((await agentd.hook('claude-code', 'pre', preEvent(command))).stdout);
    const status = (await agentd.admin('status')).stdout;
    const queueFiles = allFilesUnder(path.join(agentd.home, '.marrow', 'agentd', 'queue')).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    await agentd.admin('flush');
    const everything = [outputs.join('\n'), status, queueFiles, JSON.stringify(stub.state.events), JSON.stringify(stub.state.gateBodies)].join('\n');
    assert.equal(everything.includes(agentd.key), false);
    assert.equal(everything.includes(agentd.key.slice(0, 16)), false);
  });
});

test('config missing or unsafe: the daemon still runs on the pinned origin and reports it', async () => {
  const stub = createStub();
  await stub.start();
  const agentd = await startAgentd({ stub, configOverrides: {} });
  try {
    const configPath = path.join(agentd.home, '.marrow', 'agentd', 'config.json');
    fs.chmodSync(configPath, 0o644);
    await agentd.stop();
    const again = await startAgentd({ stub, home: agentd.home, root: agentd.root, key: agentd.key });
    try {
      const status = (await again.admin('status')).json;
      assert.ok(status.integrity.violations.some((v) => /^config_unsafe/.test(v.code)));
      assert.equal(status.api.base_url, stub.url);
    } finally { await again.stop(); }
  } finally { await stub.stop(); agentd.cleanup(); }
  assert.ok(writeConfig);
});

require('./support/isolated-environment');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createStub } = require('./support/agentd-stub');
const { scratchHome, writeDummyKey, preEvent, decisionOf, percentile } = require('./support/agentd-harness');
const { adminCall, callDaemon } = require('../src/agentd/client');
const { buildPlan, applyPlan } = require('../src/agentd/install-plan');
const { sha256File } = require('../src/agentd/fsutil');

const ctx = {};

function startDaemonProcess() {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(process.execPath, [path.join(__dirname, 'support', 'agentd-daemon-proc.js')], {
      env: { PATH: '/usr/bin:/bin', HOME: ctx.home, ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}) },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('ready\n')) resolve(child);
      else if (out.startsWith('error')) reject(new Error(out.trim()));
    });
    child.once('exit', (code) => { if (!out.includes('ready')) reject(new Error(`daemon exited ${code}`)); });
    child.stdin.end(JSON.stringify({ home: ctx.home, stubUrl: ctx.stub.url, kid: ctx.stub.kid, publicKeyPem: ctx.stub.publicKey.export({ type: 'spki', format: 'pem' }), settings: { gateBudgetCapMs: 2000 } }));
  });
}

function runShim(harness, event, payload, env = { PATH: '/usr/bin:/bin' }) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = childProcess.spawn(ctx.plan.paths.shim, [harness, event], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (status) => resolve({ status, stdout, stderr, ms: Number(process.hrtime.bigint() - started) / 1e6 }));
    child.stdin.end(JSON.stringify(payload));
  });
}

function runNodeShim(harness, event, payload) {
  return new Promise((resolve) => {
    const started = process.hrtime.bigint();
    const child = childProcess.spawn(process.execPath, [ctx.plan.hookEntry, '--home', ctx.home, harness, event], { env: { PATH: '/usr/bin:/bin' } });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', (status) => resolve({ status, stdout, ms: Number(process.hrtime.bigint() - started) / 1e6 }));
    child.stdin.end(JSON.stringify(payload));
  });
}

const admin = (op, body) => adminCall(ctx.plan.paths.socket, op, body);

test.before(async () => {
  ctx.stub = createStub();
  await ctx.stub.start();
  const { root, home } = scratchHome();
  Object.assign(ctx, { root, home });
  ctx.key = writeDummyKey(home);
  ctx.stub.expectKey(ctx.key);
  ctx.claudeSettings = path.join(home, '.claude', 'settings.json');
  ctx.codexHooks = path.join(home, 'proj', '.codex', 'hooks.json');
  ctx.mcpConfig = path.join(home, '.claude.json');
  fs.mkdirSync(path.dirname(ctx.claudeSettings), { recursive: true });
  fs.mkdirSync(path.dirname(ctx.codexHooks), { recursive: true });
  fs.writeFileSync(ctx.claudeSettings, JSON.stringify({
    permissions: { allow: ['Bash(ls:*)'] },
    hooks: {
      PreToolUse: [
        { matcher: 'Bash|Edit', hooks: [{ type: 'command', command: 'npx -y --package=@getmarrow/mcp@3.9.97 marrow-mcp claude-pre-action-hook' }] },
        { matcher: 'Write', hooks: [{ type: 'command', command: '/usr/local/bin/owner-lint-hook' }] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'npx -y --package=@getmarrow/mcp@3.9.97 marrow-mcp claude-session-hook' }] }],
    },
  }, null, 2));
  ctx.inlineKey = `mrw_test_${crypto.randomBytes(16).toString('hex')}`;
  fs.writeFileSync(ctx.mcpConfig, JSON.stringify({
    mcpServers: { marrow: { command: 'npx', args: ['-y', '@getmarrow/mcp@3.9.97', '--key', ctx.inlineKey], env: { MARROW_API_KEY: ctx.inlineKey } }, other: { command: 'x', env: { OTHER_TOKEN: 'keep-me' } } },
    projects: { '/p': { mcpServers: { marrow: { command: 'npx', args: ['marrow-mcp'], env: { MARROW_API_KEY: ctx.inlineKey } } } } },
  }), { mode: 0o600 });
  ctx.plan = buildPlan({ home, baseUrl: ctx.stub.url, harnesses: [{ harness: 'claude-code', file: ctx.claudeSettings }, { harness: 'codex', file: ctx.codexHooks }] });
  ctx.report = applyPlan(ctx.plan, { compile: true, mcpConfigFiles: [ctx.mcpConfig] });
  ctx.daemon = await startDaemonProcess();
});

test.after(async () => {
  if (ctx.daemon && ctx.daemon.exitCode === null) ctx.daemon.kill('SIGTERM');
  if (ctx.stub) await ctx.stub.stop();
  if (ctx.root) fs.rmSync(ctx.root, { recursive: true, force: true });
});

test('install: shim pinned by hash, hooks point at it, owner hooks kept, inline keys removed', async () => {
  const config = JSON.parse(fs.readFileSync(ctx.plan.paths.config, 'utf8'));
  assert.equal(fs.statSync(ctx.plan.paths.config).mode & 0o777, 0o600);
  assert.equal(config.shim.sha256, sha256File(ctx.plan.paths.shim));
  assert.equal(ctx.report.shim.mode, fs.existsSync('/usr/bin/cc') || fs.existsSync('/usr/bin/gcc') ? 'native' : 'node-script');
  const settings = JSON.parse(fs.readFileSync(ctx.claudeSettings, 'utf8'));
  assert.deepEqual(settings.permissions, { allow: ['Bash(ls:*)'] });
  const preCommands = settings.hooks.PreToolUse.flatMap((g) => g.hooks.map((h) => h.command));
  assert.ok(preCommands.includes('/usr/local/bin/owner-lint-hook'), 'owner hook kept');
  assert.ok(!preCommands.some((c) => c.includes('npx')), 'npx Marrow hook replaced');
  assert.ok(preCommands.includes(`${ctx.plan.paths.shim} claude-code pre`));
  assert.ok(!JSON.stringify(settings.hooks.Stop).includes('npx'));
  const codex = JSON.parse(fs.readFileSync(ctx.codexHooks, 'utf8'));
  assert.equal(codex.hooks.PreToolUse[0].hooks[0].async, false);
  assert.equal(codex.hooks.PreToolUse[0].hooks[0].timeout, 5);
  const mcp = fs.readFileSync(ctx.mcpConfig, 'utf8');
  assert.equal(mcp.includes(ctx.inlineKey), false, 'no inline key left in the MCP config');
  assert.ok(mcp.includes('keep-me'), 'unrelated servers untouched');
  assert.equal(ctx.report.keys_removed, 3);
  assert.equal(ctx.report.key_file, 'different_key_present', 'an existing owner key is never replaced');
  assert.equal(JSON.stringify(ctx.report).includes(ctx.inlineKey), false);
  const service = fs.readFileSync(path.join(ctx.home, '.config', 'systemd', 'user', 'marrow-agentd.service'), 'utf8');
  assert.match(service, /^Restart=always$/m);
  assert.match(service, /--socket-activation/);
  assert.match(fs.readFileSync(path.join(ctx.home, '.config', 'systemd', 'user', 'marrow-agentd.socket'), 'utf8'), /^SocketMode=0600$/m);
  const status = (await admin('status')).json;
  assert.equal(status.integrity.ok, true, JSON.stringify(status.integrity.violations));
});

test('install into a fresh home moves an inline key into ~/.marrow/env (0600) and nowhere else', () => {
  const { root, home } = scratchHome();
  try {
    const mcp = path.join(home, 'proj', '.mcp.json');
    fs.mkdirSync(path.dirname(mcp), { recursive: true });
    const key = `mrw_test_${crypto.randomBytes(16).toString('hex')}`;
    fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { marrow: { command: 'npx', args: ['marrow-mcp'], env: { MARROW_API_KEY: key, MARROW_BASE_URL: 'http://127.0.0.1:1' } } } }));
    const plan = buildPlan({ home, harnesses: [] });
    const report = applyPlan(plan, { compile: false, mcpConfigFiles: [mcp] });
    assert.equal(report.key_file, 'written');
    const envFile = path.join(home, '.marrow', 'env');
    assert.equal(fs.statSync(envFile).mode & 0o777, 0o600);
    assert.ok(fs.readFileSync(envFile, 'utf8').includes(key));
    const cleaned = fs.readFileSync(mcp, 'utf8');
    assert.equal(cleaned.includes(key), false);
    assert.equal(cleaned.includes('MARROW_BASE_URL'), false);
    const libFiles = [];
    const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else libFiles.push(p); } };
    walk(path.join(home, '.marrow', 'agentd'));
    assert.equal(libFiles.some((f) => fs.readFileSync(f).includes(key)), false, 'the key is only in ~/.marrow/env');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('tamper: the governed agent environment cannot redirect or disable the hook', async () => {
  const attacker = createStub({ name: 'attacker' });
  await attacker.start();
  try {
    ctx.stub.state.gateHandler = () => ({ verdict: 'deny', reason: 'owner policy' });
    const env = {
      PATH: '/usr/bin:/bin',
      HOME: '/nonexistent',
      MARROW_BASE_URL: attacker.url,
      MARROW_API_KEY: `mrw_test_${crypto.randomBytes(16).toString('hex')}`,
      MARROW_AUTO_HOOK: 'false',
      NODE_OPTIONS: '--require /nonexistent/evil.js',
    };
    const risky = await runShim('claude-code', 'pre', preEvent('npm publish'), env);
    assert.equal(risky.status, 0);
    assert.equal(decisionOf(risky).decision, 'deny');
    assert.match(decisionOf(risky).reason, /owner policy/);
    const routine = await runShim('claude-code', 'pre', preEvent('git status'), env);
    assert.equal(decisionOf(routine).decision, 'allow');
    assert.equal(attacker.state.requests.length, 0);
    // The agent asking the CLI to disable control changes nothing.
    const cli = childProcess.spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'agentd', 'cli.js'), 'control', 'disable', '--yes', '--home', ctx.home, '--json'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' }, timeout: 20000 });
    assert.equal(cli.status, 2);
    assert.equal(JSON.parse(cli.stdout).changed_locally, false);
    assert.equal((await admin('status')).json.control.level, 'enforce');
  } finally { await attacker.stop(); }
});

test('concurrency: 100 parallel hooks, no lost receipts', async () => {
  ctx.stub.state.gateHandler = () => ({ verdict: 'allow' });
  await admin('flush');
  const before = new Set(ctx.stub.state.events.map((e) => e.tool_use_id));
  const events = Array.from({ length: 100 }, (_, i) => preEvent(i % 2 ? 'git status' : `npm publish --tag t${i}`));
  const results = await Promise.all(events.map((event, i) => runShim(i % 3 ? 'claude-code' : 'codex', 'pre', event)));
  assert.equal(results.filter((r) => r.status === 0).length, 100);
  assert.equal(results.filter((r) => decisionOf(r).decision === 'allow').length, 100, results.map((r) => r.stdout).find((s) => s !== '{}'));
  await admin('flush');
  const received = new Set(ctx.stub.state.events.filter((e) => e.type === 'decision_receipt').map((e) => e.tool_use_id));
  const missing = events.filter((e) => !received.has(e.tool_use_id) || before.has(e.tool_use_id));
  assert.deepEqual(missing, []);
  assert.equal((await admin('status')).json.queue.drops.total, 0);
});

test('daemon down: routine passes with a recorded bypass, risky fails closed; bypasses upload after restart', async () => {
  ctx.daemon.kill('SIGKILL');
  await new Promise((resolve) => ctx.daemon.once('exit', resolve));
  assert.ok(fs.existsSync(ctx.plan.paths.socket), 'a crashed daemon leaves a stale socket behind');
  const routine = await runShim('claude-code', 'pre', preEvent('git status'));
  const risky = await runShim('claude-code', 'pre', preEvent('npm publish'));
  const codexRisky = await runShim('codex', 'pre', preEvent('rm -rf ~/'));
  const post = await runShim('claude-code', 'post', { hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  assert.equal(decisionOf(routine).decision, 'allow');
  assert.equal(decisionOf(risky).decision, 'deny');
  assert.match(decisionOf(risky).reason, /marrow-agentd\) is not running/);
  assert.equal(decisionOf(codexRisky).decision, 'deny');
  assert.equal(post.status, 0);
  const bypassFiles = fs.readdirSync(ctx.plan.paths.bypassDir);
  assert.equal(bypassFiles.length, 3);
  for (const name of bypassFiles) assert.equal(fs.statSync(path.join(ctx.plan.paths.bypassDir, name)).mode & 0o777, 0o600);

  ctx.daemon = await startDaemonProcess(); // cleans the stale socket
  assert.deepEqual(fs.readdirSync(ctx.plan.paths.bypassDir), []);
  await admin('flush');
  const fallback = ctx.stub.state.events.filter((e) => e.type === 'fallback_decision');
  assert.equal(fallback.length, 3);
  assert.deepEqual(fallback.map((e) => e.decision).sort(), ['allow', 'deny', 'deny']);
  assert.equal((await admin('status')).json.fallback_ingested, 3);
});

test('latency: allow decisions through the socket and through the native shim', async (t) => {
  ctx.stub.state.gateHandler = () => ({ verdict: 'allow' });
  const rtt = [];
  for (let i = 0; i < 2000; i += 1) {
    const started = process.hrtime.bigint();
    await callDaemon({ socketPath: ctx.plan.paths.socket, harness: 'claude-code', event: 'pre', payload: Buffer.from(JSON.stringify(preEvent('git status'))) });
    rtt.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  const shim = [];
  for (let i = 0; i < 300; i += 1) shim.push((await runShim('claude-code', 'pre', preEvent('git status'))).ms);
  const nodeShim = [];
  for (let i = 0; i < 40; i += 1) nodeShim.push((await runNodeShim('claude-code', 'pre', preEvent('git status'))).ms);
  const gated = [];
  for (let i = 0; i < 200; i += 1) {
    const started = process.hrtime.bigint();
    await callDaemon({ socketPath: ctx.plan.paths.socket, harness: 'claude-code', event: 'pre', payload: Buffer.from(JSON.stringify(preEvent(`npm publish --tag l${i}`))) });
    gated.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  const summary = (values) => ({ n: values.length, p50: +percentile(values, 50).toFixed(2), p95: +percentile(values, 95).toFixed(2), p99: +percentile(values, 99).toFixed(2), max: +Math.max(...values).toFixed(2) });
  const results = {
    loadavg: require('node:os').loadavg().map((v) => +v.toFixed(2)),
    cpus: require('node:os').cpus().length,
    daemon_socket_routine_allow_ms: summary(rtt),
    native_shim_end_to_end_routine_allow_ms: summary(shim),
    node_shim_end_to_end_routine_allow_ms: summary(nodeShim),
    daemon_socket_risky_via_loopback_server_gate_ms: summary(gated),
  };
  t.diagnostic(`AGENTD_LATENCY ${JSON.stringify(results)}`);
  if (process.env.AGENTD_BENCH_OUT) fs.writeFileSync(process.env.AGENTD_BENCH_OUT, `${JSON.stringify(results, null, 2)}\n`);
  // Generous bounds so a loaded CI host does not flake; the measured numbers are reported above.
  assert.ok(results.daemon_socket_routine_allow_ms.p50 < 20);
  assert.ok(results.native_shim_end_to_end_routine_allow_ms.p50 < 60);
});

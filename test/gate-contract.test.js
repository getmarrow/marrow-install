require('./support/isolated-environment');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  gateDecision,
  gateOnly,
  integrationsOnly,
  localIntegrationManifest,
  localSupportedHarnesses,
  parseArgs,
  permitOnly,
  proofOnly,
  runCli,
  runGoverned,
  shouldBlock,
} = require('../src/governed-runner');
const { firstCapturePath } = require('../src/first-hour');

// Wire shapes taken from the backend runtime service at 854272f6: the slim projection that
// package clients receive by default, and the expanded payload returned for response_mode
// "expanded". Advisory = Free/Starter (enforced:false); enforced = production enforcement.
const SHAPES = {
  slimAdvisory: {
    ok: true,
    agent_id: 'free-seat-fixture',
    decision_id: 'rtdec_slim_advisory',
    runtime_authorization: { id: 'gr_slim_advisory', durable: true, decision_state: 'created', decision_id: 'rtdec_slim_advisory' },
    decision: 'warn',
    enforcement_decision: 'advisory',
    risk_gate_enforced: false,
    risk_gate_entitled: false,
    risk_level: 'high',
    gate_receipt_id: 'gr_slim_advisory',
    gate_required: false,
    completion_contract: { must_commit_outcome: true, gate_receipt_required: false },
  },
  slimEnforced: {
    ok: true,
    agent_id: 'bound-agent',
    decision_id: 'rtdec_slim_enforced',
    runtime_authorization: { id: 'gr_slim_enforced', durable: true, decision_state: 'created', decision_id: 'rtdec_slim_enforced' },
    decision: 'review_required',
    enforcement_decision: 'owner_approval_required',
    risk_gate_enforced: true,
    risk_gate_entitled: true,
    risk_level: 'high',
    gate_receipt_id: 'gr_slim_enforced',
    gate_required: true,
    completion_contract: { must_commit_outcome: true, gate_receipt_required: true },
  },
  expandedAdvisory: {
    ok: true,
    agent_id: 'free-seat-fixture',
    decision_id: 'rtdec_expanded_advisory',
    runtime_authorization: { id: 'gr_expanded_advisory', durable: true, decision_state: 'created', decision_id: 'rtdec_expanded_advisory' },
    risk_gate: {
      allow: true,
      decision: 'warn',
      enforcement_decision: 'advisory',
      enforced: false,
      entitled: false,
      risk_level: 'high',
      gate_receipt_id: 'gr_expanded_advisory',
      gate_required: false,
      owner_approval_required: false,
    },
    gate_receipt: { id: 'gr_expanded_advisory', required: false, decision: 'warn', owner_approval_required: false },
  },
  expandedEnforcedAllow: {
    ok: true,
    agent_id: 'bound-agent',
    decision_id: 'rtdec_expanded_enforced',
    runtime_authorization: { id: 'gr_expanded_enforced', durable: true, decision_state: 'created', decision_id: 'rtdec_expanded_enforced' },
    risk_gate: {
      allow: true,
      decision: 'allow',
      enforcement_decision: 'allow',
      enforced: true,
      entitled: true,
      risk_level: 'high',
      gate_receipt_id: 'gr_expanded_enforced',
      gate_required: true,
      owner_approval_required: false,
    },
    gate_receipt: { id: 'gr_expanded_enforced', required: true, decision: 'allow', owner_approval_required: false },
  },
};

function stubApi(routes) {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body ? JSON.parse(String(init.body)) : {};
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([name, value]) => [name.toLowerCase(), value]));
    const call = { pathname: parsed.pathname, body, headers };
    calls.push(call);
    const route = routes[parsed.pathname];
    const answer = typeof route === 'function' ? route(call, calls) : route;
    if (answer instanceof Response) return answer;
    return Response.json({ data: answer ?? {} });
  };
  return { calls, restore: () => { globalThis.fetch = originalFetch; } };
}

function markerCommand(marker) {
  return [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`];
}

// The test runner reports over stdout, so captures record and pass every write through.
function tee(stream) {
  let output = '';
  const originalWrite = stream.write;
  stream.write = function write(chunk, ...rest) {
    if (typeof chunk === 'string' || Buffer.isBuffer(chunk)) output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    return originalWrite.call(stream, chunk, ...rest);
  };
  return { text: () => output, restore: () => { stream.write = originalWrite; } };
}

function captureStdout() {
  return tee(process.stdout);
}

function captureStderr() {
  return tee(process.stderr);
}

test('gate normalization reads slim and expanded runtime answers identically (F-A)', () => {
  const slim = gateDecision(SHAPES.slimAdvisory);
  const expanded = gateDecision(SHAPES.expandedAdvisory);
  for (const decision of [slim, expanded]) {
    assert.equal(decision.recognized, true);
    assert.equal(decision.decision, 'warn');
    assert.equal(decision.enforced, false);
    assert.equal(decision.riskLevel, 'high');
    assert.equal(decision.required, false);
    assert.notEqual(decision.decision, 'unknown');
    assert.equal(shouldBlock(decision, { policy: 'enforce', ownerApproval: '' }), false);
  }
  assert.equal(slim.receiptId, 'gr_slim_advisory');
  assert.equal(slim.runtimeDecisionId, 'rtdec_slim_advisory');
  assert.equal(expanded.receiptId, 'gr_expanded_advisory');

  const enforced = gateDecision(SHAPES.slimEnforced);
  assert.equal(enforced.decision, 'review_required');
  assert.equal(enforced.enforced, true);
  assert.equal(enforced.required, true);
  assert.equal(enforced.ownerApprovalRequired, true);
  assert.equal(enforced.receiptId, 'gr_slim_enforced');
  assert.equal(shouldBlock(enforced, { policy: 'enforce', ownerApproval: '' }), true);
  assert.equal(shouldBlock(enforced, { policy: 'enforce', ownerApproval: 'owner-approval-ref' }), false);
  assert.equal(shouldBlock(enforced, { policy: 'audit', ownerApproval: '' }), false);

  const notCreated = gateDecision({ ...SHAPES.slimAdvisory, decision_id: undefined, runtime_authorization: { id: 'gr_x', decision_state: 'not_created' } });
  assert.equal(notCreated.runtimeDecisionId, '');
  const empty = gateDecision({});
  assert.equal(empty.recognized, false);
  assert.equal(empty.decision, 'none');
});

test('gate requests the expanded runtime and prints the real advisory decision, never unknown (F-A)', async () => {
  for (const shape of [SHAPES.slimAdvisory, SHAPES.expandedAdvisory]) {
    const api = stubApi({ '/v1/agent/runtime': shape });
    const stdout = captureStdout();
    let result;
    try {
      result = await gateOnly(parseArgs(['gate', '--key', 'test-key', '--type', 'deploy', 'deploy production worker']));
    } finally {
      stdout.restore();
      api.restore();
    }
    assert.equal(api.calls[0].body.response_mode, 'expanded');
    assert.match(stdout.text(), /Marrow gate: warn \(advisory, not enforced on this plan; risk high\)/);
    assert.doesNotMatch(stdout.text(), /unknown/);
    assert.match(stdout.text(), /proof --session \S+ --decision-id rtdec_\S+ --gate-receipt gr_\S+/);
    assert.equal(result.blocked, false);
    assert.equal(result.exitCode, 0);
    assert.ok(result.gate_receipt_id.startsWith('gr_'));
  }
});

test('gate exits non-zero when an enforced gate blocks or needs owner approval (R-17)', async () => {
  const cases = [
    [SHAPES.slimEnforced, 12],
    [{ ...SHAPES.expandedEnforcedAllow, risk_gate: { ...SHAPES.expandedEnforcedAllow.risk_gate, allow: false, decision: 'block', enforcement_decision: 'block' } }, 12],
    [SHAPES.expandedEnforcedAllow, 0],
    [SHAPES.slimAdvisory, 0],
    [{}, 13],
  ];
  for (const [shape, expected] of cases) {
    const api = stubApi({ '/v1/agent/runtime': shape });
    const stdout = captureStdout();
    const stderr = captureStderr();
    const previous = process.exitCode;
    let exitCode;
    try {
      await runCli(['gate', '--key', 'test-key', '--type', 'deploy', 'deploy production worker']);
      exitCode = process.exitCode;
    } finally {
      process.exitCode = previous;
      stdout.restore();
      stderr.restore();
      api.restore();
    }
    assert.equal(exitCode, expected, JSON.stringify(shape).slice(0, 80));
    if (expected === 12) {
      assert.match(stderr.text(), /BLOCKED/);
      assert.doesNotMatch(stdout.text(), /Marrow command completed/);
    }
  }
});

test('enforced run issues the permit with the real gate receipt and reuses the runtime decision (F-A)', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-gate-enforced-'));
  try {
    for (const shape of [SHAPES.expandedEnforcedAllow, { ...SHAPES.slimEnforced, decision: 'allow', enforcement_decision: 'allow' }]) {
      const marker = path.join(directory, `ran-${shape.decision_id}`);
      const api = stubApi({
        '/v1/agent/runtime': shape,
        '/v1/agent/enforcement': (call) => (call.body.operation === 'issue'
          ? (call.body.gate_receipt_id
            ? { permit: 'opaque-permit', permit_id: 'permit-one', protocol_version: 1 }
            : Response.json({ error: 'Invalid enforcement request.', code: 'AGENT_ENFORCEMENT_INVALID_GATE_RECEIPT_ID' }, { status: 400 }))
          : call.body.operation === 'verify' ? { verified: true } : { closed: true }),
        '/v1/agent/commit': { committed: true },
      });
      const stdout = captureStdout();
      let result;
      try {
        result = await runGoverned(parseArgs(['run', '--key', 'test-key', '--type', 'deploy', '--action', 'deploy production', '--', ...markerCommand(marker)]));
      } finally {
        stdout.restore();
        api.restore();
      }
      assert.equal(result.exitCode, 0, JSON.stringify(result));
      assert.equal(fs.existsSync(marker), true);
      assert.equal(result.permit_verified, true);
      assert.equal(result.decision_source, 'runtime');
      const issue = api.calls.find((call) => call.body.operation === 'issue').body;
      assert.equal(issue.gate_receipt_id, shape.gate_receipt_id || shape.risk_gate.gate_receipt_id);
      assert.equal(issue.decision_id, shape.decision_id);
      assert.equal(api.calls.some((call) => call.pathname === '/v1/agent/think'), false);
      const commit = api.calls.find((call) => call.pathname === '/v1/agent/commit').body;
      assert.equal(commit.decision_id, shape.decision_id);
      assert.equal(commit.gate_receipt_id, issue.gate_receipt_id);
      assert.equal(result.outcome_committed, true);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('advisory plans show the warning, run the protected command and record the outcome without a permit (F-B)', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-gate-advisory-'));
  try {
    for (const shape of [SHAPES.slimAdvisory, SHAPES.expandedAdvisory]) {
      const marker = path.join(directory, `ran-${shape.decision_id}`);
      const api = stubApi({
        '/v1/agent/runtime': shape,
        '/v1/agent/enforcement': Response.json({ error: 'action_permit_owner_approval_required' }, { status: 403 }),
        '/v1/agent/commit': { committed: true },
      });
      const stdout = captureStdout();
      const stderr = captureStderr();
      let result;
      try {
        result = await runGoverned(parseArgs(['run', '--key', 'test-key', '--type', 'deploy', '--action', 'deploy production', '--', ...markerCommand(marker)]));
      } finally {
        stdout.restore();
        stderr.restore();
        api.restore();
      }
      assert.equal(result.blocked, false);
      assert.equal(result.exitCode, 0);
      assert.equal(result.advisory, true);
      assert.equal(fs.existsSync(marker), true);
      assert.equal(api.calls.some((call) => call.pathname === '/v1/agent/enforcement'), false);
      assert.match(stderr.text(), /Marrow advisory: this deploy action is not enforced on this plan \(gate warn\)/);
      const commit = api.calls.find((call) => call.pathname === '/v1/agent/commit');
      assert.ok(commit, 'outcome must be recorded on advisory plans');
      assert.equal(commit.body.decision_id, shape.decision_id);
      assert.equal(commit.body.gate_receipt_id, shape.gate_receipt_id || shape.risk_gate.gate_receipt_id);
      assert.equal(result.outcome_committed, true);

      const permitApi = stubApi({ '/v1/agent/runtime': shape, '/v1/agent/enforcement': Response.json({}, { status: 500 }) });
      let permit;
      try {
        permit = await permitOnly(parseArgs(['permit', '--key', 'test-key', '--type', 'deploy', '--action', 'deploy production']));
      } finally {
        permitApi.restore();
      }
      assert.equal(permit.ok, true);
      assert.equal(permit.advisory, true);
      assert.equal(permit.permit, null);
      assert.equal(permitApi.calls.some((call) => call.pathname === '/v1/agent/enforcement'), false);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('an unrecorded or untrusted outcome is reported instead of skipped silently (F-B, R-75)', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-gate-record-'));
  const marker = path.join(directory, 'ran');
  const api = stubApi({
    '/v1/agent/runtime': { ...SHAPES.slimAdvisory, risk_level: 'low', decision: 'proceed' },
    '/v1/agent/commit': { committed: false, decision_id: 'rtdec_slim_advisory' },
  });
  const stdout = captureStdout();
  const stderr = captureStderr();
  let result;
  try {
    result = await runGoverned(parseArgs(['run', '--key', 'test-key', '--type', 'general', '--', ...markerCommand(marker)]));
  } finally {
    stdout.restore();
    stderr.restore();
    api.restore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(result.outcome_committed, false);
  assert.equal(result.outcome_commit_state, 'not_committed');
  assert.match(stderr.text(), /without trusted closure \(committed:false\)/);

  for (const [committed, exitCode] of [[true, 0], [false, 1]]) {
    const proofApi = stubApi({ '/v1/agent/commit': { committed } });
    let proof;
    try {
      proof = await proofOnly(parseArgs(['proof', '--key', 'test-key', '--session', 'gate-session', '--decision-id', 'rtdec_one', '--gate-receipt', 'gr_one', '--success', '--summary', 'smoke passed']));
    } finally {
      proofApi.restore();
    }
    const body = proofApi.calls[0].body;
    assert.equal(body.gate_receipt_id, 'gr_one');
    assert.equal(proofApi.calls[0].headers['x-marrow-session-id'], 'gate-session');
    assert.equal(proof.committed, committed);
    assert.equal(proof.exitCode, exitCode);
  }
});

test('runtime, think and commit retry transient and pending answers with one stable Idempotency-Key (F-D)', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-gate-retry-'));
  const marker = path.join(directory, 'ran');
  let runtimeAttempts = 0;
  let thinkAttempts = 0;
  let commitAttempts = 0;
  const api = stubApi({
    '/v1/agent/runtime': () => {
      runtimeAttempts += 1;
      return runtimeAttempts === 1
        ? Response.json({ error: 'Authentication store timed out; retry once.', code: 'AUTH_STORE_TIMEOUT' }, { status: 503 })
        : { ...SHAPES.slimAdvisory, decision_id: undefined, runtime_authorization: { id: 'gr_retry', decision_state: 'not_created' }, gate_receipt_id: 'gr_retry', risk_level: 'low', decision: 'proceed' };
    },
    '/v1/agent/think': () => {
      thinkAttempts += 1;
      return thinkAttempts === 1
        ? Response.json({ data: { retryable: true, committed: false, reconciliation_state: 'runtime_decision_authority_pending', retry_after_ms: 1 } }, { status: 202 })
        : { decision_id: 'dec_after_pending' };
    },
    '/v1/agent/commit': () => {
      commitAttempts += 1;
      return commitAttempts === 1 ? Response.json({ error: 'rate limited' }, { status: 429 }) : { committed: true };
    },
  });
  const stdout = captureStdout();
  let result;
  try {
    const parsed = parseArgs(['run', '--key', 'test-key', '--type', 'general', '--', ...markerCommand(marker)]);
    parsed.options.retryDelayMs = 0;
    result = await runGoverned(parsed);
  } finally {
    stdout.restore();
    api.restore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(result.exitCode, 0);
  assert.equal(result.decision_id, 'dec_after_pending');
  assert.equal(result.outcome_committed, true);
  for (const route of ['/v1/agent/runtime', '/v1/agent/think', '/v1/agent/commit']) {
    const attempts = api.calls.filter((call) => call.pathname === route);
    assert.equal(attempts.length, 2, route);
    assert.ok(attempts[0].headers['idempotency-key'], route);
    assert.equal(attempts[0].headers['idempotency-key'], attempts[1].headers['idempotency-key'], route);
    assert.deepEqual(attempts[0].body, attempts[1].body, route);
  }

  const failing = stubApi({ '/v1/agent/runtime': Response.json({ error: 'bad request' }, { status: 400 }) });
  try {
    const parsed = parseArgs(['gate', '--key', 'test-key', 'deploy production']);
    parsed.options.retryDelayMs = 0;
    await assert.rejects(gateOnly(parsed), /bad request/);
  } finally {
    failing.restore();
  }
  assert.equal(failing.calls.length, 1);
});

test('the documented `run -- -- <command>` form runs the command (R-20)', async () => {
  const parsed = parseArgs(['run', '--', '--', 'echo', 'ok']);
  assert.deepEqual(parsed.childCommand, ['echo', 'ok']);
  assert.deepEqual(parseArgs(['run', '--', 'echo', 'ok']).childCommand, ['echo', 'ok']);
  assert.deepEqual(parseArgs(['run', '--type', 'general', '--', '--', 'echo']).childCommand, ['echo']);
  assert.equal(firstCapturePath({}).command, 'npx @getmarrow/install run -- <command>');

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-gate-separator-'));
  const marker = path.join(directory, 'ran');
  const api = stubApi({
    '/v1/agent/runtime': { ...SHAPES.slimAdvisory, risk_level: 'low', decision: 'proceed' },
    '/v1/agent/commit': { committed: true },
  });
  const stdout = captureStdout();
  let result;
  try {
    result = await runGoverned(parseArgs(['run', '--key', 'test-key', '--type', 'general', '--', '--', ...markerCommand(marker)]));
  } finally {
    stdout.restore();
    api.restore();
  }
  assert.equal(result.exitCode, 0);
  assert.equal(fs.existsSync(marker), true);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('installer output never suggests an invented agent id (F-F)', async () => {
  const texts = [
    JSON.stringify(localSupportedHarnesses()),
    JSON.stringify(localIntegrationManifest('hermes')),
    JSON.stringify(localIntegrationManifest('openclaw')),
    require('../src/governed-runner').governPanel ? require('../src/governed-runner').governPanel({ agentId: '', profile: 'production', apiKey: '' }) : '',
  ];
  const stdout = captureStdout();
  try {
    await runCli(['help']);
  } finally {
    stdout.restore();
  }
  texts.push(stdout.text());
  const registry = await integrationsOnly(parseArgs(['integrations', '--json']));
  texts.push(JSON.stringify(registry));
  for (const text of texts) {
    assert.doesNotMatch(text, /--agent\s+(?!<id>)[A-Za-z0-9<]/, text.slice(0, 120));
    assert.doesNotMatch(text, /hermes-prod|hermes-agent-name|codex-prod|ci-release|openclaw-release|deploy-agent/);
  }
});

test('each run, gate and permit uses fresh Idempotency-Keys even in the same session; proof keeps its own', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-gate-nonce-'));
  const api = stubApi({
    '/v1/agent/runtime': { ...SHAPES.slimAdvisory, decision_id: undefined, runtime_authorization: { id: 'gr_nonce', decision_state: 'not_created' }, gate_receipt_id: 'gr_nonce', risk_level: 'low', decision: 'proceed' },
    '/v1/agent/think': { decision_id: 'dec_nonce' },
    '/v1/agent/commit': { committed: true },
  });
  const stdout = captureStdout();
  try {
    for (const run of [1, 2]) {
      const marker = path.join(directory, `ran-${run}`);
      await runGoverned(parseArgs(['run', '--key', 'test-key', '--session', 'shared-session', '--type', 'general', '--action', 'same action', '--', ...markerCommand(marker)]));
    }
    await gateOnly(parseArgs(['gate', '--key', 'test-key', '--session', 'shared-session', 'same action']));
    await gateOnly(parseArgs(['gate', '--key', 'test-key', '--session', 'shared-session', 'same action']));
    for (let proof = 0; proof < 2; proof += 1) {
      await proofOnly(parseArgs(['proof', '--key', 'test-key', '--session', 'shared-session', '--decision-id', 'dec_nonce', '--success']));
    }
  } finally {
    stdout.restore();
    api.restore();
    fs.rmSync(directory, { recursive: true, force: true });
  }
  const keys = (route) => api.calls.filter((call) => call.pathname === route).map((call) => call.headers['idempotency-key']);
  const runtimeKeys = keys('/v1/agent/runtime');
  assert.equal(runtimeKeys.length, 4);
  assert.equal(new Set(runtimeKeys).size, 4);
  assert.equal(new Set(keys('/v1/agent/think')).size, 2);
  const commitKeys = keys('/v1/agent/commit');
  assert.equal(commitKeys.length, 4);
  assert.notEqual(commitKeys[0], commitKeys[1]);
  assert.equal(commitKeys[2], commitKeys[3]);
});

test('an answer that withholds authorization blocks under every plan and policy', async () => {
  const observation = {
    ok: true,
    decision_id: 'rtdec_observation',
    runtime_authorization: { id: 'outcome_observation_only_0123456789abcdef0123456789abcdef', kind: 'outcome_observation_only', decision_state: 'outcome_observation_only' },
    risk_gate: { allow: false, enforced: false, decision: 'outcome_observation_only', enforcement_decision: 'outcome_observation_only', authorization_granted: false },
    enforcement_decision: 'outcome_observation_only',
    risk_gate_enforced: false,
  };
  const slimObservation = { decision: 'outcome_observation_only', enforcement_decision: 'outcome_observation_only', risk_gate_enforced: false };
  for (const policy of ['enforce', 'warn', 'audit']) {
    for (const shape of [observation, slimObservation, { ...SHAPES.expandedAdvisory, risk_gate: { ...SHAPES.expandedAdvisory.risk_gate, allow: false } }]) {
      assert.equal(shouldBlock(gateDecision(shape), { policy, ownerApproval: 'owner-approval-ref' }), true, `${policy} ${JSON.stringify(shape).slice(0, 60)}`);
    }
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-gate-observation-'));
  const marker = path.join(directory, 'ran');
  const api = stubApi({ '/v1/agent/runtime': observation, '/v1/agent/commit': { committed: true } });
  const stdout = captureStdout();
  let result;
  try {
    result = await runGoverned(parseArgs(['run', '--key', 'test-key', '--policy', 'audit', '--type', 'general', '--', ...markerCommand(marker)]));
  } finally {
    stdout.restore();
    api.restore();
  }
  assert.equal(result.blocked, true);
  assert.equal(result.exitCode, 12);
  assert.match(result.message, /observation-only mode, which cannot authorize this action/);
  assert.equal(fs.existsSync(marker), false);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('a hung Marrow write times out and a protected command fails closed within its deadline', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-gate-timeout-'));
  const marker = path.join(directory, 'ran');
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (url, init = {}) => new Promise((resolve, reject) => {
    attempts += 1;
    init.signal?.addEventListener('abort', () => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })));
  });
  const keepAlive = setInterval(() => {}, 1_000);
  const started = Date.now();
  let result;
  try {
    const parsed = parseArgs(['run', '--key', 'test-key', '--type', 'deploy', '--action', 'deploy production', '--', ...markerCommand(marker)]);
    Object.assign(parsed.options, { retryDelayMs: 0, requestTimeoutMs: 40, requestDeadlineMs: 2_000 });
    result = await runGoverned(parsed);
  } finally {
    clearInterval(keepAlive);
    globalThis.fetch = originalFetch;
  }
  assert.equal(result.blocked, true);
  assert.equal(result.exitCode, 13);
  assert.match(result.message, /did not complete after 3 attempts \(last: timed out\)/);
  assert.equal(attempts, 3);
  assert.equal(fs.existsSync(marker), false);
  assert.ok(Date.now() - started < 2_000);
  fs.rmSync(directory, { recursive: true, force: true });
});

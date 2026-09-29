const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createHeartbeatPolicy, startGovernanceSidecar } = require('../src/governance-sidecar');

test('sidecar binds loopback, requires its private token, and does not persist the Marrow API key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-sidecar-'));
  const prior = process.env.MARROW_SIDECAR_STATE_DIR;
  const apiKey = ['mrw', 'test', 'example', 'placeholder'].join('_');
  process.env.MARROW_SIDECAR_STATE_DIR = dir;
  const sidecar = await startGovernanceSidecar({
    apiKey,
    sidecarPort: 0,
  }, {
    permit: async () => ({ permit: 'opaque', permit_id: 'permit-1' }),
    verify: async () => ({ verified: true }),
    close: async () => ({ closed: true }),
    coverage: async () => ({ status: 'pass' }),
    heartbeat: async () => ({ accepted: true }),
  });

  try {
    const state = JSON.parse(fs.readFileSync(sidecar.stateFile, 'utf8'));
    assert.equal(state.host, '127.0.0.1');
    assert.equal(JSON.stringify(state).includes(apiKey), false);
    assert.equal(fs.statSync(sidecar.stateFile).mode & 0o777, 0o600);

    const denied = await fetch(`http://127.0.0.1:${sidecar.port}/health`);
    assert.equal(denied.status, 401);

    const allowed = await fetch(`http://127.0.0.1:${sidecar.port}/health`, {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).ok, true);
  } finally {
    sidecar.close();
    if (prior === undefined) delete process.env.MARROW_SIDECAR_STATE_DIR;
    else process.env.MARROW_SIDECAR_STATE_DIR = prior;
  }
});

test('sidecar rejects a symlinked active state file without overwriting its target', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-sidecar-symlink-'));
  const stateDir = path.join(root, 'state');
  const outside = path.join(root, 'outside.json');
  const prior = process.env.MARROW_SIDECAR_STATE_DIR;
  fs.mkdirSync(stateDir, { mode: 0o700 });
  fs.writeFileSync(outside, 'outside-is-unchanged\n', { mode: 0o600 });
  fs.symlinkSync(outside, path.join(stateDir, 'active.json'));
  process.env.MARROW_SIDECAR_STATE_DIR = stateDir;

  try {
    await assert.rejects(
      startGovernanceSidecar({
        apiKey: 'test-key',
        sidecarPort: 0,
      }, {
        permit: async () => ({ permit: 'opaque', permit_id: 'permit-1' }),
        verify: async () => ({ verified: true }),
        close: async () => ({ closed: true }),
        coverage: async () => ({ status: 'pass' }),
        heartbeat: async () => ({ accepted: true }),
      }),
      /state file must be a private regular file/,
    );
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside-is-unchanged\n');
    assert.equal(fs.lstatSync(path.join(stateDir, 'active.json')).isSymbolicLink(), true);
  } finally {
    if (prior === undefined) delete process.env.MARROW_SIDECAR_STATE_DIR;
    else process.env.MARROW_SIDECAR_STATE_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sidecar rejects an existing state file with group or world access', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-sidecar-mode-'));
  const stateDir = path.join(root, 'state');
  const prior = process.env.MARROW_SIDECAR_STATE_DIR;
  fs.mkdirSync(stateDir, { mode: 0o700 });
  fs.writeFileSync(path.join(stateDir, 'active.json'), '{"stale":true}\n', { mode: 0o644 });
  fs.chmodSync(path.join(stateDir, 'active.json'), 0o644);
  process.env.MARROW_SIDECAR_STATE_DIR = stateDir;

  try {
    await assert.rejects(
      startGovernanceSidecar({ apiKey: 'test-key', sidecarPort: 0 }, {
        permit: async () => ({ permit: 'opaque', permit_id: 'permit-1' }),
        verify: async () => ({ verified: true }),
        close: async () => ({ closed: true }),
        coverage: async () => ({ status: 'pass' }),
        heartbeat: async () => ({ accepted: true }),
      }),
      /permissions must be 0600 or stricter/,
    );
  } finally {
    if (prior === undefined) delete process.env.MARROW_SIDECAR_STATE_DIR;
    else process.env.MARROW_SIDECAR_STATE_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sidecar rejects symlinked state directory components before creating outside state', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-sidecar-component-'));
  const outsideDir = path.join(root, 'outside');
  const lexicalDir = path.join(root, 'lexical');
  const prior = process.env.MARROW_SIDECAR_STATE_DIR;
  fs.mkdirSync(outsideDir, { mode: 0o700 });
  fs.mkdirSync(lexicalDir, { mode: 0o700 });
  fs.symlinkSync(outsideDir, path.join(lexicalDir, 'linked'));
  process.env.MARROW_SIDECAR_STATE_DIR = path.join(lexicalDir, 'linked', 'state');

  try {
    await assert.rejects(
      startGovernanceSidecar({ apiKey: 'test-key', sidecarPort: 0 }, {
        permit: async () => ({ permit: 'opaque', permit_id: 'permit-1' }),
        verify: async () => ({ verified: true }),
        close: async () => ({ closed: true }),
        coverage: async () => ({ status: 'pass' }),
        heartbeat: async () => ({ accepted: true }),
      }),
      /symlinked path components/,
    );
    assert.equal(fs.existsSync(path.join(outsideDir, 'state')), false);
  } finally {
    if (prior === undefined) delete process.env.MARROW_SIDECAR_STATE_DIR;
    else process.env.MARROW_SIDECAR_STATE_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sidecar rejects state beneath a non-sticky world-writable ancestor', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-sidecar-ancestor-'));
  const unsafeParent = path.join(root, 'unsafe');
  const prior = process.env.MARROW_SIDECAR_STATE_DIR;
  fs.mkdirSync(unsafeParent, { mode: 0o777 });
  fs.chmodSync(unsafeParent, 0o777);
  process.env.MARROW_SIDECAR_STATE_DIR = path.join(unsafeParent, 'state');

  try {
    await assert.rejects(
      startGovernanceSidecar({ apiKey: 'test-key', sidecarPort: 0 }, {
        permit: async () => ({ permit: 'opaque', permit_id: 'permit-1' }),
        verify: async () => ({ verified: true }),
        close: async () => ({ closed: true }),
        coverage: async () => ({ status: 'pass' }),
        heartbeat: async () => ({ accepted: true }),
      }),
      /non-sticky writable ancestor/,
    );
  } finally {
    if (prior === undefined) delete process.env.MARROW_SIDECAR_STATE_DIR;
    else process.env.MARROW_SIDECAR_STATE_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function httpError(status, code) {
  const error = new Error(`HTTP ${status}`);
  error.status = status;
  error.details = code ? { code } : {};
  return error;
}

test('heartbeat policy backs off with jitter and opens the circuit after five identical 4xx responses', () => {
  const policy = createHeartbeatPolicy({ intervalMs: 1000, maxBackoffMs: 60_000, random: () => 0.5 });
  const delays = [];
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const result = policy.failure(httpError(404, 'AGENT_ENFORCEMENT_AGENT_NOT_FOUND'));
    assert.equal(result.state.state, 'backing_off');
    assert.equal(result.state.failures, attempt);
    delays.push(result.delayMs);
  }
  assert.deepEqual(delays, [1500, 3000, 6000, 12000]);
  const stopped = policy.failure(httpError(404, 'AGENT_ENFORCEMENT_AGENT_NOT_FOUND'));
  assert.equal(stopped.delayMs, null);
  assert.equal(policy.open, true);
  assert.equal(stopped.state.state, 'stopped');
  assert.equal(stopped.state.failures, 5);
  assert.match(stopped.state.exact_fix, /no registered agent for this controller \(HTTP 404 AGENT_ENFORCEMENT_AGENT_NOT_FOUND\)/);
  assert.match(stopped.state.exact_fix, /MARROW_FLEET_AGENT_ID/);
  assert.match(stopped.state.exact_fix, /controller stop && npx @getmarrow\/install controller ensure/);

  const jitter = [0, 1].map((value) => createHeartbeatPolicy({ intervalMs: 1000, random: () => value })
    .failure(httpError(400, 'MARROW_UNKNOWN_FIELDS')).delayMs);
  assert.deepEqual(jitter, [1000, 2000]);

  for (const [status, code, fix] of [
    [403, 'ACTION_PERMIT_AGENT_CREDENTIAL_SCOPE_INVALID', /API key or agent scope/],
    [401, null, /API key or agent scope/],
    [400, 'MARROW_UNKNOWN_FIELDS', /@getmarrow\/install@latest update/],
  ]) {
    const scoped = createHeartbeatPolicy({ intervalMs: 1000, random: () => 0 });
    let last;
    for (let attempt = 0; attempt < 5; attempt += 1) last = scoped.failure(httpError(status, code));
    assert.equal(last.delayMs, null, String(status));
    assert.match(last.state.exact_fix, fix);
  }
});

test('heartbeat policy keeps retrying 5xx, 429 and network failures at a capped backoff', () => {
  const policy = createHeartbeatPolicy({ intervalMs: 1000, maxBackoffMs: 8000, random: () => 1 });
  const delays = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const error = [httpError(503, 'COORDINATOR_UNAVAILABLE'), httpError(429), new Error('fetch failed')][attempt % 3];
    const result = policy.failure(error);
    assert.notEqual(result.delayMs, null);
    delays.push(result.delayMs);
  }
  assert.equal(policy.open, false);
  assert.deepEqual(delays.slice(0, 4), [2000, 4000, 8000, 8000]);
  assert.ok(delays.every((delay) => delay <= 8000));

  const identical = createHeartbeatPolicy({ intervalMs: 1000, random: () => 0 });
  for (let attempt = 0; attempt < 12; attempt += 1) {
    assert.notEqual(identical.failure(httpError(503, 'AUTHORITY_UNAVAILABLE')).delayMs, null);
  }
  assert.equal(identical.open, false);
});

test('heartbeat policy resets after success and only counts identical consecutive 4xx failures', () => {
  const policy = createHeartbeatPolicy({ intervalMs: 1000, random: () => 0 });
  for (let attempt = 0; attempt < 4; attempt += 1) policy.failure(httpError(404, 'AGENT_ENFORCEMENT_AGENT_NOT_FOUND'));
  assert.deepEqual(policy.success(), { delayMs: 1000, state: { state: 'ok', failures: 0, exact_fix: null } });
  const afterSuccess = policy.failure(httpError(404, 'AGENT_ENFORCEMENT_AGENT_NOT_FOUND'));
  assert.equal(afterSuccess.delayMs, 1000);
  assert.equal(afterSuccess.state.failures, 1);

  const alternating = createHeartbeatPolicy({ intervalMs: 1000, random: () => 0 });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const error = attempt % 2 ? httpError(403, 'ACTION_PERMIT_AGENT_CREDENTIAL_SCOPE_INVALID') : httpError(404, 'AGENT_ENFORCEMENT_AGENT_NOT_FOUND');
    assert.notEqual(alternating.failure(error).delayMs, null);
  }
  assert.equal(alternating.open, false);
});

test('sidecar stops heartbeats after five identical 404 responses and reports the fix once', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-sidecar-heartbeat-'));
  const prior = process.env.MARROW_SIDECAR_STATE_DIR;
  process.env.MARROW_SIDECAR_STATE_DIR = dir;
  const originalWrite = process.stderr.write;
  const messages = [];
  process.stderr.write = (chunk) => { messages.push(String(chunk)); return true; };
  let heartbeats = 0;
  let sidecar;
  try {
    sidecar = await startGovernanceSidecar({ apiKey: 'test-key', sidecarPort: 0, heartbeatIntervalMs: 20, heartbeatRandom: () => 0 }, {
      permit: async () => ({}),
      verify: async () => ({}),
      close: async () => ({}),
      coverage: async () => ({}),
      heartbeat: async () => {
        heartbeats += 1;
        throw httpError(404, 'AGENT_ENFORCEMENT_AGENT_NOT_FOUND');
      },
    });
    const state = JSON.parse(fs.readFileSync(sidecar.stateFile, 'utf8'));
    const health = async () => (await fetch(`http://127.0.0.1:${sidecar.port}/health`, {
      headers: { Authorization: `Bearer ${state.token}` },
    })).json();
    const first = await health();
    assert.equal(first.heartbeat.state, 'backing_off');
    assert.equal(first.heartbeat.status, 404);
    assert.equal(first.heartbeat.code, 'AGENT_ENFORCEMENT_AGENT_NOT_FOUND');
    const deadline = Date.now() + 5000;
    let current = first;
    while (current.heartbeat.state !== 'stopped' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      current = await health();
    }
    assert.equal(current.heartbeat.state, 'stopped');
    assert.equal(current.heartbeat.failures, 5);
    assert.match(current.heartbeat.exact_fix, /no registered agent for this controller/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(heartbeats, 5);
    const stopped = messages.filter((message) => message.includes('stopped enforcement heartbeats'));
    assert.equal(stopped.length, 1);
    assert.ok(stopped[0].includes(current.heartbeat.exact_fix));
  } finally {
    process.stderr.write = originalWrite;
    sidecar?.close();
    if (prior === undefined) delete process.env.MARROW_SIDECAR_STATE_DIR;
    else process.env.MARROW_SIDECAR_STATE_DIR = prior;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

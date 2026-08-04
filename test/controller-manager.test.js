const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const {
  controllerIdentity,
  controllerStatus,
  controllerSupportedPlatform,
  ensureGovernanceController,
  readState,
  stopGovernanceController,
} = require('../src/controller-manager');

test('controller identity is scoped to the exact project and agent', () => {
  const first = controllerIdentity({ root: '/tmp/project-a', agentId: 'agent-a' });
  assert.notEqual(first, controllerIdentity({ root: '/tmp/project-b', agentId: 'agent-a' }));
  assert.notEqual(first, controllerIdentity({ root: '/tmp/project-a', agentId: 'agent-b' }));
  assert.match(first, /^[a-f0-9]{24}$/);
});

test('persistent controller lifecycle is explicit and non-destructive on unsupported platforms', async () => {
  assert.equal(controllerSupportedPlatform('linux'), true);
  assert.equal(controllerSupportedPlatform('darwin'), false);
  const status = await controllerStatus({ platform: 'darwin' });
  assert.equal(status.active, false);
  assert.equal(status.state, 'unsupported_platform');
  assert.match(status.exact_fix, /owner-managed service/);
  await assert.rejects(ensureGovernanceController({
    platform: 'darwin',
    apiKey: 'test-controller-api-key',
  }), /supported on Linux/);
});

test('controller survives the starting session without persisting the Marrow API key', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-controller-'));
  const project = path.join(root, 'project');
  const stateDirectory = path.join(root, 'state');
  fs.mkdirSync(project, { mode: 0o700 });
  fs.writeFileSync(path.join(project, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Project agents\n');
  const prior = process.env.MARROW_SIDECAR_STATE_DIR;
  process.env.MARROW_SIDECAR_STATE_DIR = stateDirectory;
  try {
    const started = await ensureGovernanceController({
      apiKey: 'test-controller-api-key',
      baseUrl: 'https://api.example.test',
      agentId: 'controller-test',
      client: 'codex',
      root: project,
      mode: 'md',
      profile: 'default',
      policy: 'warn',
    });
    assert.equal(started.active, true);
    assert.equal((await controllerStatus({ root: project, agentId: 'controller-test' })).active, true);
    const state = readState({ root: project, agentId: 'controller-test' });
    const rawState = fs.readFileSync(path.join(stateDirectory, 'active.json'), 'utf8');
    assert.doesNotMatch(rawState, /test-controller-api-key/);
    assert.equal(fs.statSync(path.join(stateDirectory, 'active.json')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(stateDirectory).mode & 0o777, 0o700);
    assert.equal(state.host, '127.0.0.1');
    assert.match(fs.readFileSync(path.join(project, 'AGENTS.md'), 'utf8'), /marrow:passive-start/);
    assert.ok(['repaired', 'clear'].includes((await controllerStatus({ root: project, agentId: 'controller-test' })).maintenance.state));
  } finally {
    await stopGovernanceController({ root: project, agentId: 'controller-test' });
    if (prior === undefined) delete process.env.MARROW_SIDECAR_STATE_DIR;
    else process.env.MARROW_SIDECAR_STATE_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('concurrent controller starts serialize to one sidecar identity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-controller-race-'));
  const project = path.join(root, 'project');
  const stateDirectory = path.join(root, 'state');
  fs.mkdirSync(project, { mode: 0o700 });
  fs.writeFileSync(path.join(project, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Project agents\n');
  const prior = process.env.MARROW_SIDECAR_STATE_DIR;
  process.env.MARROW_SIDECAR_STATE_DIR = stateDirectory;
  const options = {
    apiKey: 'test-controller-api-key',
    baseUrl: 'https://api.example.test',
    agentId: 'controller-race-test',
    client: 'codex',
    root: project,
    mode: 'md',
    profile: 'default',
    policy: 'warn',
  };
  try {
    const [first, second] = await Promise.all([
      ensureGovernanceController(options),
      ensureGovernanceController(options),
    ]);
    assert.equal(first.active, true);
    assert.equal(second.active, true);
    assert.equal(first.instance_id, second.instance_id);
    assert.equal([first.changed, second.changed].filter(Boolean).length, 1);
    assert.equal(fs.existsSync(path.join(stateDirectory, 'lifecycle.lock')), false);
  } finally {
    await stopGovernanceController({ root: project, agentId: 'controller-race-test' });
    if (prior === undefined) delete process.env.MARROW_SIDECAR_STATE_DIR;
    else process.env.MARROW_SIDECAR_STATE_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('unreachable controller replacement terminates the exact recorded sidecar first', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-controller-replace-'));
  const project = path.join(root, 'project');
  const stateDirectory = path.join(root, 'state');
  fs.mkdirSync(project, { mode: 0o700 });
  fs.writeFileSync(path.join(project, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Project agents\n');
  const prior = process.env.MARROW_SIDECAR_STATE_DIR;
  process.env.MARROW_SIDECAR_STATE_DIR = stateDirectory;
  const options = {
    apiKey: 'test-controller-api-key',
    baseUrl: 'https://api.example.test',
    agentId: 'controller-replace-test',
    client: 'codex',
    root: project,
    mode: 'md',
    profile: 'default',
    policy: 'warn',
  };
  try {
    await ensureGovernanceController(options);
    const first = readState(options);
    fs.writeFileSync(path.join(stateDirectory, 'active.json'), JSON.stringify({ ...first, port: 1 }) + '\n', { mode: 0o600 });
    fs.chmodSync(path.join(stateDirectory, 'active.json'), 0o600);

    const replacement = await ensureGovernanceController(options);
    const second = readState(options);
    assert.equal(replacement.active, true);
    assert.equal(replacement.changed, true);
    assert.notEqual(second.pid, first.pid);
    assert.notEqual(second.instance_id, first.instance_id);
    assert.throws(() => process.kill(first.pid, 0));
  } finally {
    await stopGovernanceController({ root: project, agentId: 'controller-replace-test' });
    if (prior === undefined) delete process.env.MARROW_SIDECAR_STATE_DIR;
    else process.env.MARROW_SIDECAR_STATE_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('controller stop removes invalid owner state without following symlinks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-controller-invalid-'));
  const prior = process.env.MARROW_SIDECAR_STATE_DIR;
  process.env.MARROW_SIDECAR_STATE_DIR = root;
  try {
    fs.writeFileSync(path.join(root, 'active.json'), '{invalid', { mode: 0o600 });
    const result = await stopGovernanceController();
    assert.equal(result.state, 'stopped');
    assert.equal(result.changed, true);
    assert.equal(fs.existsSync(path.join(root, 'active.json')), false);

    const outside = path.join(root, 'outside.json');
    fs.writeFileSync(outside, '{}', { mode: 0o600 });
    fs.symlinkSync(outside, path.join(root, 'active.json'));
    await assert.rejects(stopGovernanceController(), /cannot be a symlink/);
    assert.equal(fs.readFileSync(outside, 'utf8'), '{}');
  } finally {
    if (prior === undefined) delete process.env.MARROW_SIDECAR_STATE_DIR;
    else process.env.MARROW_SIDECAR_STATE_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('controller refuses a tampered PID without signaling either process', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-controller-pid-'));
  const project = path.join(root, 'project');
  const stateDirectory = path.join(root, 'state');
  fs.mkdirSync(project, { mode: 0o700 });
  fs.writeFileSync(path.join(project, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Project agents\n');
  const prior = process.env.MARROW_SIDECAR_STATE_DIR;
  process.env.MARROW_SIDECAR_STATE_DIR = stateDirectory;
  const options = {
    apiKey: 'test-controller-api-key',
    baseUrl: 'https://api.example.test',
    agentId: 'controller-pid-test',
    client: 'codex',
    root: project,
    mode: 'md',
    profile: 'default',
    policy: 'warn',
  };
  const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore',
  });
  let genuineState;
  try {
    await ensureGovernanceController(options);
    genuineState = readState(options);
    const statePath = path.join(stateDirectory, 'active.json');
    fs.writeFileSync(statePath, JSON.stringify({ ...genuineState, pid: unrelated.pid }) + '\n', { mode: 0o600 });
    fs.chmodSync(statePath, 0o600);

    const status = await controllerStatus(options);
    assert.equal(status.active, false);
    assert.equal(status.state, 'identity_mismatch');
    await assert.rejects(stopGovernanceController(options), /Refusing to stop/);
    assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
    assert.doesNotThrow(() => process.kill(genuineState.pid, 0));
    assert.equal(readState(options).pid, unrelated.pid);

    fs.writeFileSync(statePath, JSON.stringify(genuineState) + '\n', { mode: 0o600 });
    fs.chmodSync(statePath, 0o600);
    await stopGovernanceController(options);
    genuineState = null;
  } finally {
    if (genuineState) {
      const statePath = path.join(stateDirectory, 'active.json');
      fs.writeFileSync(statePath, JSON.stringify(genuineState) + '\n', { mode: 0o600 });
      fs.chmodSync(statePath, 0o600);
      await stopGovernanceController(options).catch(() => {});
    }
    unrelated.kill('SIGTERM');
    if (prior === undefined) delete process.env.MARROW_SIDECAR_STATE_DIR;
    else process.env.MARROW_SIDECAR_STATE_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('controller refuses an authenticated endpoint and recorded PID mismatch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-controller-crossed-'));
  const projectA = path.join(root, 'project-a');
  const projectB = path.join(root, 'project-b');
  const stateA = path.join(root, 'state-a');
  const stateB = path.join(root, 'state-b');
  fs.mkdirSync(projectA, { mode: 0o700 });
  fs.mkdirSync(projectB, { mode: 0o700 });
  for (const project of [projectA, projectB]) {
    fs.writeFileSync(path.join(project, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Project agents\n');
  }
  const prior = process.env.MARROW_SIDECAR_STATE_DIR;
  const optionsA = {
    apiKey: 'test-controller-api-key', baseUrl: 'https://api.example.test', agentId: 'controller-a',
    client: 'codex', root: projectA, mode: 'md', profile: 'default', policy: 'warn',
  };
  const optionsB = { ...optionsA, agentId: 'controller-b', root: projectB };
  let originalA;
  let originalB;
  try {
    process.env.MARROW_SIDECAR_STATE_DIR = stateA;
    await ensureGovernanceController(optionsA);
    originalA = readState(optionsA);
    process.env.MARROW_SIDECAR_STATE_DIR = stateB;
    await ensureGovernanceController(optionsB);
    originalB = readState(optionsB);

    process.env.MARROW_SIDECAR_STATE_DIR = stateA;
    const statePathA = path.join(stateA, 'active.json');
    fs.writeFileSync(statePathA, JSON.stringify({ ...originalA, pid: originalB.pid }) + '\n', { mode: 0o600 });
    fs.chmodSync(statePathA, 0o600);
    const status = await controllerStatus(optionsA);
    assert.equal(status.active, false);
    assert.equal(status.state, 'identity_mismatch');
    await assert.rejects(stopGovernanceController(optionsA), /Refusing to stop/);
    await assert.rejects(ensureGovernanceController(optionsA), /identity is ambiguous/);
    assert.doesNotThrow(() => process.kill(originalA.pid, 0));
    assert.doesNotThrow(() => process.kill(originalB.pid, 0));
    assert.equal(readState(optionsA).pid, originalB.pid);

    fs.writeFileSync(statePathA, JSON.stringify(originalA) + '\n', { mode: 0o600 });
    fs.chmodSync(statePathA, 0o600);
    await stopGovernanceController(optionsA);
    originalA = null;
    process.env.MARROW_SIDECAR_STATE_DIR = stateB;
    await stopGovernanceController(optionsB);
    originalB = null;
  } finally {
    if (originalA) {
      process.env.MARROW_SIDECAR_STATE_DIR = stateA;
      const statePathA = path.join(stateA, 'active.json');
      fs.writeFileSync(statePathA, JSON.stringify(originalA) + '\n', { mode: 0o600 });
      fs.chmodSync(statePathA, 0o600);
      await stopGovernanceController(optionsA).catch(() => {});
    }
    if (originalB) {
      process.env.MARROW_SIDECAR_STATE_DIR = stateB;
      const statePathB = path.join(stateB, 'active.json');
      fs.writeFileSync(statePathB, JSON.stringify(originalB) + '\n', { mode: 0o600 });
      fs.chmodSync(statePathB, 0o600);
      await stopGovernanceController(optionsB).catch(() => {});
    }
    if (prior === undefined) delete process.env.MARROW_SIDECAR_STATE_DIR;
    else process.env.MARROW_SIDECAR_STATE_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('controller preserves state with broad permissions instead of deleting it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-controller-mode-'));
  const prior = process.env.MARROW_SIDECAR_STATE_DIR;
  process.env.MARROW_SIDECAR_STATE_DIR = root;
  const statePath = path.join(root, 'active.json');
  try {
    fs.writeFileSync(statePath, '{invalid', { mode: 0o600 });
    fs.chmodSync(statePath, 0o644);
    await assert.rejects(stopGovernanceController(), /permissions are too broad/);
    assert.equal(fs.existsSync(statePath), true);
    assert.equal(fs.statSync(statePath).mode & 0o777, 0o644);
  } finally {
    if (prior === undefined) delete process.env.MARROW_SIDECAR_STATE_DIR;
    else process.env.MARROW_SIDECAR_STATE_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('controller rejects state beneath a non-sticky world-writable ancestor', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-controller-ancestor-'));
  const unsafeParent = path.join(root, 'unsafe');
  const prior = process.env.MARROW_SIDECAR_STATE_DIR;
  fs.mkdirSync(unsafeParent, { mode: 0o777 });
  fs.chmodSync(unsafeParent, 0o777);
  process.env.MARROW_SIDECAR_STATE_DIR = path.join(unsafeParent, 'state');
  try {
    await assert.rejects(ensureGovernanceController({
      apiKey: 'test-controller-api-key',
      baseUrl: 'https://api.example.test',
      agentId: 'unsafe-ancestor-test',
      client: 'codex',
      root,
      mode: 'md',
      profile: 'default',
      policy: 'warn',
    }), /non-sticky writable ancestor/);
  } finally {
    if (prior === undefined) delete process.env.MARROW_SIDECAR_STATE_DIR;
    else process.env.MARROW_SIDECAR_STATE_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

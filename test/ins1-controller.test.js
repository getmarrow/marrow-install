const { isolatedHome } = require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const { install, parseArgs, buildPlan, applyPlan, detectEnvironment } = require('../src/installer');
const { controllerIdentity, controllerStatus, projectControllers, readState, stopProjectControllers } = require('../src/controller-manager');
const PINS = require('../src/pins');
const { fakeRuntime } = require('./support/fake-runtime');
const {
  DEFAULT_URL, dummyKey, keyTag, quiet, hostLayout, setup, mcpPath, mcpEnv, readRecord, writeRecord, setEnvBlock, sha, treeHashes, fakeApi,
} = require('./support/ins1');

// INS-1 T4 + M3 (G12): the controller maintenance pass never rewrites an id with its own launch id; update starts the
// controller with the id it decided (never the runner's) and stops every controller of the same root, whatever id
// hashed its directory, including one left by an update from another shell.

const RUNNER = 'codex-bob';

// A stand-in for a controller an earlier update started from a shell exporting codex-bob: the same private state layout
// and authenticated /health, the project root in its state, and the OLD maintenance pass: it writes its launch id into
// the managed MCP config (here every 100 ms instead of every 5 minutes).
const OLD_CONTROLLER = `
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const token = crypto.randomBytes(32).toString('hex');
const instanceId = 'sidecar-' + crypto.randomUUID();
const startedAt = new Date().toISOString();
const server = http.createServer((req, res) => {
  if (req.headers.authorization !== 'Bearer ' + token) { res.writeHead(401); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ ok: true, instance_id: instanceId, pid: process.pid, started_at: startedAt, installer_version: '0.1.77' }));
});
const rewrite = () => {
  try {
    const file = process.env.OLD_MCP_FILE;
    const config = JSON.parse(fs.readFileSync(file, 'utf8'));
    config.mcpServers.marrow.env.MARROW_FLEET_AGENT_ID = process.env.OLD_LAUNCH_ID;
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\\n');
  } catch {}
};
server.listen(0, '127.0.0.1', () => {
  const state = { instance_id: instanceId, pid: process.pid, host: '127.0.0.1', port: server.address().port, token, started_at: startedAt, project_root: process.env.MARROW_CONTROLLER_PROJECT_ROOT, installer_version: '0.1.77' };
  fs.writeFileSync(path.join(process.env.OLD_STATE_DIR, 'active.json'), JSON.stringify(state), { mode: 0o600 });
  setInterval(rewrite, 100);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return directory;
}

async function startOldController({ root, stateDirectory, mcpFile, launchId }) {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-old-npx-'));
  const installRoot = path.join(packageRoot, 'node_modules', '@getmarrow', 'install');
  fs.mkdirSync(path.join(installRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(installRoot, 'package.json'), JSON.stringify({ name: '@getmarrow/install', version: '0.1.77' }));
  fs.writeFileSync(path.join(installRoot, 'bin', 'marrow-install.js'), OLD_CONTROLLER);
  const child = spawn(process.execPath, [path.join(installRoot, 'bin', 'marrow-install.js'), 'sidecar', '--agent', launchId], {
    isolationKeepsArgv: true,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, OLD_STATE_DIR: stateDirectory, OLD_MCP_FILE: mcpFile, OLD_LAUNCH_ID: launchId, MARROW_CONTROLLER_PROJECT_ROOT: root },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(path.join(stateDirectory, 'active.json'))) {
    if (Date.now() > deadline) throw new Error('old controller did not start');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { child, packageRoot };
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitUntil(check, deadlineMs = 10_000) {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    const value = await check();
    if (value || Date.now() >= deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function resetHome() {
  for (const name of ['.mcp.json', '.claude', '.marrow', '.grok', 'package.json']) fs.rmSync(path.join(isolatedHome, name), { recursive: true, force: true });
}

test('T4: the maintenance pass leaves a recorded config byte-identical whatever launch id it has; it restores the record and stops on an unsafe one', () => {
  resetHome();
  try {
    fs.writeFileSync(mcpPath(isolatedHome), `${JSON.stringify({ mcpServers: { marrow: { command: 'node', args: ['marrow-mcp'], env: { MARROW_BASE_URL: DEFAULT_URL, MARROW_FLEET_AGENT_ID: 'cliff-agent' } } } }, null, 2)}\n`);
    writeRecord(isolatedHome, { [mcpPath(isolatedHome)]: { MARROW_FLEET_AGENT_ID: 'cliff-agent' } });
    const detection = detectEnvironment(isolatedHome, { HOME: isolatedHome, PATH: process.env.PATH });
    const pass = (agentId) => applyPlan(buildPlan(detection, { mode: 'mcp', agentId, baseUrl: DEFAULT_URL, maintenance: true }), { yes: true, dryRun: false, doctor: false });
    // The first pass may normalize the file's launch form; what follows must not change a byte.
    pass('cliff-agent');
    const before = sha(mcpPath(isolatedHome));
    for (const launchId of [RUNNER, 'cliff-agent', '', 'another-agent']) {
      pass(launchId);
      assert.equal(sha(mcpPath(isolatedHome)), before, `maintenance with launch id "${launchId}" changed the file`);
    }
    // Drifted config: the record is restored (never the launch id) and the pass reports it.
    setEnvBlock(mcpPath(isolatedHome), { MARROW_FLEET_AGENT_ID: 'drifted' });
    const changes = pass(RUNNER);
    assert.equal(mcpEnv(isolatedHome).MARROW_FLEET_AGENT_ID, 'cliff-agent');
    assert.deepEqual(changes.find((change) => change.path === mcpPath(isolatedHome)).identity_divergence.map((entry) => [entry.field, entry.replaced, entry.reason]), [['MARROW_FLEET_AGENT_ID', 'drifted', 'restored']]);
    assert.equal(sha(mcpPath(isolatedHome)), before);
    // The pass never writes the record.
    assert.deepEqual(readRecord(isolatedHome), { [mcpPath(isolatedHome)]: { MARROW_FLEET_AGENT_ID: 'cliff-agent' } });
    // An unsafe record: the pass plans no write at all.
    setEnvBlock(mcpPath(isolatedHome), { MARROW_FLEET_AGENT_ID: 'drifted' });
    fs.chmodSync(path.join(isolatedHome, '.marrow', 'identity-record.json'), 0o666);
    const snapshot = treeHashes(isolatedHome);
    const plan = buildPlan(detection, { mode: 'mcp', agentId: RUNNER, baseUrl: DEFAULT_URL, maintenance: true });
    assert.deepEqual(plan.writes, []);
    assert.ok(plan.identity_record_unsafe);
    assert.deepEqual(applyPlan(plan, { yes: true, dryRun: false, doctor: false }), []);
    assert.deepEqual(treeHashes(isolatedHome), snapshot);
  } finally { resetHome(); }
});

test('T4 + M3: update from another shell stops an old controller of the same root (any id hash), starts one with the decided id, and the config stays put', { skip: process.platform !== 'linux' }, async () => {
  resetHome();
  const key = dummyKey();
  const api = await fakeApi({ keys: { [keyTag(key)]: ['cliff-agent'] } });
  const priorStateDirectory = process.env.MARROW_SIDECAR_STATE_DIR;
  delete process.env.MARROW_SIDECAR_STATE_DIR;
  let old = null;
  const baseOptions = { root: isolatedHome, platform: 'linux' };
  try {
    hostLayout(isolatedHome);
    fakeRuntime(isolatedHome, PINS.MCP_ADAPTER_VERSION, 'exit 0\n');
    privateDirectory(path.join(isolatedHome, '.marrow'));
    await setup(isolatedHome, { agentId: 'cliff-agent', baseUrl: api.url, mcpLocalRuntime: true });
    assert.equal(mcpEnv(isolatedHome).MARROW_FLEET_AGENT_ID, 'cliff-agent');
    const controlled = path.join(isolatedHome, '.marrow', 'controllers');
    privateDirectory(controlled);
    // The controller an earlier update started from a codex-bob shell: its directory hashes root + codex-bob.
    const oldDirectory = privateDirectory(path.join(controlled, controllerIdentity({ root: isolatedHome, identityAgentId: RUNNER })));
    old = await startOldController({ root: isolatedHome, stateDirectory: oldDirectory, mcpFile: mcpPath(isolatedHome), launchId: RUNNER });
    await waitUntil(() => mcpEnv(isolatedHome).MARROW_FLEET_AGENT_ID === RUNNER, 3_000);
    assert.equal(mcpEnv(isolatedHome).MARROW_FLEET_AGENT_ID, RUNNER, 'the old controller reproduces the incident (it writes its launch id)');
    const found = await waitUntil(async () => {
      const list = await projectControllers({ ...baseOptions, scanAll: true });
      return list.length === 1 && list[0].status.active ? list : null;
    });
    assert.ok(found, 'the old controller is found for the root');
    const updateOnce = async (shellEnv) => {
      const parsed = parseArgs(['update', '--yes'], { HOME: isolatedHome, PATH: process.env.PATH, ...shellEnv });
      return install({
        ...parsed,
        ...quiet({ cwd: isolatedHome, home: isolatedHome, mode: 'mcp', apiKey: key, baseUrl: api.url, selfTest: true, selfTestRetryDelayMs: 0, controller: true, mcpLocalRuntime: true }),
      });
    };
    const first = await updateOnce({ MARROW_FLEET_AGENT_ID: RUNNER, MARROW_AGENT_ID: RUNNER });
    // The first run may have to restore the id the old controller wrote (the record names cliff-agent).
    assert.equal(first.controller.active, true, `controller: ${JSON.stringify(first.controller).slice(0, 200)}`);
    await waitUntil(() => !alive(old.child.pid));
    assert.equal(alive(old.child.pid), false, 'the old controller is still running');
    assert.equal(mcpEnv(isolatedHome).MARROW_FLEET_AGENT_ID, 'cliff-agent');
    const settled = sha(mcpPath(isolatedHome));
    // Two (shortened) maintenance intervals: the old PID cannot rewrite, and the new pass keeps the file.
    await sleep(600);
    assert.equal(sha(mcpPath(isolatedHome)), settled, '~/.mcp.json changed after the old controller was stopped');
    // The new controller carries the decided id and no runner id.
    const identityAgentId = 'cliff-agent';
    const running = await projectControllers({ ...baseOptions, scanAll: true });
    assert.equal(running.length, 1, 'exactly one controller for the root');
    const pid = running[0].state.pid;
    const environment = fs.readFileSync(`/proc/${pid}/environ`).toString('utf8').split('\0');
    assert.ok(!environment.some((entry) => entry.includes(RUNNER)), 'the controller environment carries the runner id');
    assert.ok(environment.includes(`MARROW_FLEET_AGENT_ID=${identityAgentId}`), 'the controller was launched with the decided id');
    const commandLine = fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0');
    assert.ok(!commandLine.includes(RUNNER));
    assert.equal(path.resolve(path.dirname(running[0].directory)), path.resolve(controlled));
    assert.equal(path.basename(running[0].directory), controllerIdentity({ root: isolatedHome, identityAgentId }));
    // A second update from a shell with a different id: the same controller, the same directory, nothing rewritten.
    const instance = readState({ ...baseOptions, identityAgentId }).instance_id;
    await updateOnce({ MARROW_FLEET_AGENT_ID: 'devon-x' });
    const again = await projectControllers({ ...baseOptions, scanAll: true });
    assert.equal(again.length, 1);
    assert.equal(again[0].state.instance_id, instance, 'a second update started a second controller');
    assert.equal(again[0].directory, running[0].directory);
    assert.equal(mcpEnv(isolatedHome).MARROW_FLEET_AGENT_ID, 'cliff-agent');
    // The controller's own maintenance pass has run and reported nothing to fix.
    const maintenance = await waitUntil(async () => (await controllerStatus({ ...baseOptions, identityAgentId })).maintenance, 8_000);
    assert.ok(maintenance, 'the new controller ran its maintenance pass');
    // The stand-in may have rewritten the file once more between the update's write and its stop; the pass then restores
    // the record. Whatever it reports, it never applies a launch id.
    for (const entry of maintenance.identity_divergence || []) {
      assert.equal(entry.applied, 'cliff-agent', `maintenance applied ${entry.applied}`);
      assert.equal(entry.reason, 'restored');
    }
    assert.equal(mcpEnv(isolatedHome).MARROW_FLEET_AGENT_ID, 'cliff-agent');
    assert.deepEqual(api.seen.filter((entry) => entry.agent === RUNNER || entry.agent === 'devon-x'), []);
  } finally {
    await stopProjectControllers({ ...baseOptions, identityAgentId: 'cliff-agent', scanAll: true }).catch(() => {});
    if (old) {
      if (alive(old.child.pid)) old.child.kill('SIGKILL');
      fs.rmSync(old.packageRoot, { recursive: true, force: true });
    }
    await api.close();
    if (priorStateDirectory === undefined) delete process.env.MARROW_SIDECAR_STATE_DIR;
    else process.env.MARROW_SIDECAR_STATE_DIR = priorStateDirectory;
    resetHome();
  }
});

test('T4: an update that cannot start the current controller still stops one left under another id', { skip: process.platform !== 'linux' }, async () => {
  resetHome();
  const priorStateDirectory = process.env.MARROW_SIDECAR_STATE_DIR;
  delete process.env.MARROW_SIDECAR_STATE_DIR;
  let old = null;
  try {
    hostLayout(isolatedHome);
    privateDirectory(path.join(isolatedHome, '.marrow'));
    await setup(isolatedHome, { agentId: 'cliff-agent' });
    const oldDirectory = privateDirectory(path.join(isolatedHome, '.marrow', 'controllers', controllerIdentity({ root: isolatedHome, identityAgentId: RUNNER })));
    old = await startOldController({ root: isolatedHome, stateDirectory: oldDirectory, mcpFile: mcpPath(isolatedHome), launchId: RUNNER });
    await waitUntil(async () => (await projectControllers({ root: isolatedHome, platform: 'linux', scanAll: true })).length === 1);
    // No key: nothing starts a controller, but the orphan under codex-bob's directory must not keep running.
    const parsed = parseArgs(['update', '--yes'], { HOME: isolatedHome, PATH: process.env.PATH, MARROW_FLEET_AGENT_ID: RUNNER });
    await install({ ...parsed, ...quiet({ cwd: isolatedHome, home: isolatedHome, mode: 'mcp', apiKey: '', baseUrl: DEFAULT_URL, controller: true }) });
    await waitUntil(() => !alive(old.child.pid));
    assert.equal(alive(old.child.pid), false, 'the orphan controller is still running');
  } finally {
    if (old) {
      if (alive(old.child.pid)) old.child.kill('SIGKILL');
      fs.rmSync(old.packageRoot, { recursive: true, force: true });
    }
    if (priorStateDirectory === undefined) delete process.env.MARROW_SIDECAR_STATE_DIR;
    else process.env.MARROW_SIDECAR_STATE_DIR = priorStateDirectory;
    resetHome();
  }
});

test('T3 + T4 (shortcut): an unsafe record returns before any controller is started or stopped, and every file keeps its bytes', { skip: process.platform !== 'linux' }, async () => {
  resetHome();
  const key = dummyKey();
  const api = await fakeApi({ keys: { [keyTag(key)]: ['cliff-agent'] } });
  const priorStateDirectory = process.env.MARROW_SIDECAR_STATE_DIR;
  delete process.env.MARROW_SIDECAR_STATE_DIR;
  let old = null;
  try {
    hostLayout(isolatedHome);
    fakeRuntime(isolatedHome, PINS.MCP_ADAPTER_VERSION, 'exit 0\n');
    privateDirectory(path.join(isolatedHome, '.marrow'));
    await setup(isolatedHome, { agentId: 'cliff-agent', baseUrl: api.url, mcpLocalRuntime: true });
    const oldDirectory = privateDirectory(path.join(isolatedHome, '.marrow', 'controllers', controllerIdentity({ root: isolatedHome, identityAgentId: RUNNER })));
    // The stand-in's own rewrite is not wanted here: point it at a file it may not touch.
    old = await startOldController({ root: isolatedHome, stateDirectory: oldDirectory, mcpFile: path.join(isolatedHome, 'not-the-config.json'), launchId: RUNNER });
    fs.chmodSync(path.join(isolatedHome, '.marrow', 'identity-record.json'), 0o666);
    const snapshot = treeHashes(isolatedHome);
    const parsed = parseArgs(['update', '--yes'], { HOME: isolatedHome, PATH: process.env.PATH, MARROW_FLEET_AGENT_ID: RUNNER });
    const report = await install({
      ...parsed,
      ...quiet({ cwd: isolatedHome, home: isolatedHome, mode: 'mcp', apiKey: key, baseUrl: api.url, selfTest: true, selfTestRetryDelayMs: 0, controller: true, mcpLocalRuntime: true }),
    });
    assert.equal(report.identity_stop?.exitCode, 3);
    assert.equal(report.identity_stop.lines.length, 1);
    assert.deepEqual(treeHashes(isolatedHome), snapshot, 'a file changed');
    assert.equal(alive(old.child.pid), true, 'the old controller was stopped by an update that stops before it writes anything');
    const running = await projectControllers({ root: isolatedHome, platform: 'linux', scanAll: true });
    assert.equal(running.length, 1, 'no controller was started');
    assert.equal(path.basename(running[0].directory), controllerIdentity({ root: isolatedHome, identityAgentId: RUNNER }));
    assert.deepEqual(api.seen.filter((entry) => entry.method === 'POST'), [], 'the update made a write request');
  } finally {
    await stopProjectControllers({ root: isolatedHome, platform: 'linux', identityAgentId: 'cliff-agent', scanAll: true }).catch(() => {});
    if (old) {
      if (alive(old.child.pid)) old.child.kill('SIGKILL');
      fs.rmSync(old.packageRoot, { recursive: true, force: true });
    }
    await api.close();
    if (priorStateDirectory === undefined) delete process.env.MARROW_SIDECAR_STATE_DIR;
    else process.env.MARROW_SIDECAR_STATE_DIR = priorStateDirectory;
    resetHome();
  }
});

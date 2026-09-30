const { isolatedHome } = require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const {
  INSTALLER_VERSION,
  controllerStatus,
  ensureCurrentGovernanceController,
  projectControllers,
  readState,
  stopProjectControllers,
} = require('../src/controller-manager');

// A stand-in for a controller started by installer 0.1.63 from another npx cache directory:
// same private state layout, authenticated /health without installer_version, and its project
// root only in its environment, as controllers before 0.1.66 had.
const LEGACY_SIDECAR = `
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
  res.end(JSON.stringify({ ok: true, instance_id: instanceId, pid: process.pid, started_at: startedAt }));
});
server.listen(0, '127.0.0.1', () => {
  const state = { instance_id: instanceId, pid: process.pid, host: '127.0.0.1', port: server.address().port, token, started_at: startedAt };
  fs.writeFileSync(path.join(process.env.LEGACY_STATE_DIR, 'active.json'), JSON.stringify(state), { mode: 0o600 });
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

function privateDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  return directory;
}

async function startLegacyController(project, stateDirectory) {
  const packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-legacy-npx-'));
  const installRoot = path.join(packageRoot, 'node_modules', '@getmarrow', 'install');
  fs.mkdirSync(path.join(installRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(installRoot, 'package.json'), JSON.stringify({ name: '@getmarrow/install', version: '0.1.63' }));
  fs.writeFileSync(path.join(installRoot, 'bin', 'marrow-install.js'), LEGACY_SIDECAR);
  const child = spawn(process.execPath, [path.join(installRoot, 'bin', 'marrow-install.js'), 'sidecar'], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, LEGACY_STATE_DIR: stateDirectory, MARROW_CONTROLLER_PROJECT_ROOT: project },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 5_000;
  while (!fs.existsSync(path.join(stateDirectory, 'active.json'))) {
    if (Date.now() > deadline) throw new Error('legacy controller did not start');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { child, packageRoot };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test('update restarts a controller from another installer version and keeps local control state', { skip: process.platform !== 'linux' }, async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-restart-project-'));
  fs.writeFileSync(path.join(project, 'package.json'), '{}\n');
  const controllers = privateDirectory(path.join(isolatedHome, '.marrow', 'controllers'));
  privateDirectory(path.join(isolatedHome, '.marrow'));
  const legacyDirectory = privateDirectory(path.join(controllers, crypto.randomBytes(12).toString('hex')));
  const controlPath = path.join(isolatedHome, '.marrow', 'control.json');
  const controlBefore = fs.existsSync(controlPath) ? fs.readFileSync(controlPath) : null;
  const priorStateDirectory = process.env.MARROW_SIDECAR_STATE_DIR;
  delete process.env.MARROW_SIDECAR_STATE_DIR;
  const options = {
    apiKey: 'test-controller-api-key',
    baseUrl: 'http://127.0.0.1:9',
    agentId: '',
    identityAgentId: 'restart-fixture-identity',
    client: 'hermes',
    root: project,
    mode: 'md',
    profile: 'default',
    policy: 'warn',
  };
  const legacy = await startLegacyController(project, legacyDirectory);
  try {
    const found = await projectControllers(options);
    assert.equal(found.length, 1);
    assert.equal(found[0].status.active, true);
    assert.equal(found[0].status.installer_version, '0.1.63');
    assert.equal(found[0].status.installer_version_reported, false);

    const restarted = await ensureCurrentGovernanceController(options);
    assert.equal(restarted.active, true);
    assert.equal(restarted.installer_version, INSTALLER_VERSION);
    assert.equal(restarted.installer_version_reported, true);
    assert.deepEqual(restarted.restarted, { from_versions: ['0.1.63 (legacy)'], to_version: INSTALLER_VERSION, stopped: 1 });
    assert.equal(alive(legacy.child.pid), false);
    assert.equal(fs.existsSync(path.join(legacyDirectory, 'active.json')), false);
    const state = readState(options);
    assert.equal(state.installer_version, INSTALLER_VERSION);
    assert.equal(state.project_root, path.resolve(project));
    assert.doesNotMatch(JSON.stringify(state), /test-controller-api-key/);

    const again = await ensureCurrentGovernanceController(options);
    assert.equal(again.restarted, null);
    assert.equal(again.instance_id, restarted.instance_id);

    // A controller for another project is never touched.
    const otherProject = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-restart-other-'));
    assert.deepEqual(await projectControllers({ ...options, root: otherProject }), []);
    fs.rmSync(otherProject, { recursive: true, force: true });

    const controlAfter = fs.existsSync(controlPath) ? fs.readFileSync(controlPath) : null;
    assert.deepEqual(controlAfter, controlBefore);
  } finally {
    await stopProjectControllers(options).catch(() => {});
    if (alive(legacy.child.pid)) legacy.child.kill('SIGKILL');
    assert.equal((await controllerStatus(options)).active, false);
    if (priorStateDirectory === undefined) delete process.env.MARROW_SIDECAR_STATE_DIR;
    else process.env.MARROW_SIDECAR_STATE_DIR = priorStateDirectory;
    fs.rmSync(legacy.packageRoot, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(controllers, { recursive: true, force: true });
  }
});

test('controller maintenance resets a redirected MCP identity and reports it as needing attention', { skip: process.platform !== 'linux' }, async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-maintain-identity-'));
  fs.writeFileSync(path.join(project, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(project, '.mcp.json'), JSON.stringify({ mcpServers: { marrow: {
    command: 'npx',
    args: [],
    env: { MARROW_BASE_URL: 'https://fixture-user:fixture-pass@redirect.example.test:8443/api', MARROW_FLEET_AGENT_ID: 'someone-elses-agent' },
  } } }));
  const stateDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-maintain-state-'));
  const priorStateDirectory = process.env.MARROW_SIDECAR_STATE_DIR;
  process.env.MARROW_SIDECAR_STATE_DIR = stateDirectory;
  const options = {
    apiKey: 'test-controller-api-key',
    baseUrl: 'http://127.0.0.1:9',
    agentId: '',
    identityAgentId: 'maintain-fixture-identity',
    client: 'custom',
    root: project,
    mode: 'mcp',
    profile: 'default',
    policy: 'warn',
  };
  try {
    await ensureCurrentGovernanceController(options);
    let maintenance = null;
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      maintenance = (await controllerStatus(options)).maintenance;
      if (maintenance) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(maintenance.state, 'attention_required');
    assert.deepEqual(maintenance.identity_divergence.map((entry) => [entry.field, entry.replaced, entry.applied]), [
      ['MARROW_BASE_URL', 'https://redirect.example.test:8443', 'http://127.0.0.1:9'],
      ['MARROW_FLEET_AGENT_ID', 'someone-elses-agent', 'unset (resolved by Marrow)'],
    ]);
    assert.match(maintenance.exact_fix, /MARROW_ALLOWED_BASE_URLS or MARROW_ALLOWED_AGENT_IDS/);
    assert.doesNotMatch(JSON.stringify(maintenance), /fixture-pass|fixture-user/);
    const env = JSON.parse(fs.readFileSync(path.join(project, '.mcp.json'), 'utf8')).mcpServers.marrow.env;
    assert.equal(env.MARROW_BASE_URL, 'http://127.0.0.1:9');
    assert.equal(Object.hasOwn(env, 'MARROW_FLEET_AGENT_ID'), false);
  } finally {
    await stopProjectControllers(options).catch(() => {});
    if (priorStateDirectory === undefined) delete process.env.MARROW_SIDECAR_STATE_DIR;
    else process.env.MARROW_SIDECAR_STATE_DIR = priorStateDirectory;
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

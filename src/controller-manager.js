const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { version: INSTALLER_VERSION } = require('../package.json');

const START_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 3_000;
const HEALTH_TIMEOUT_MS = 1_000;
const MAX_STATE_BYTES = 8 * 1024;
const LIFECYCLE_LOCK_STALE_MS = 30_000;

function controllerIdentity(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const agentId = String(options.identityAgentId || options.agentId || process.env.MARROW_FLEET_AGENT_ID || process.env.MARROW_AGENT_ID || 'agent').trim() || 'agent';
  return crypto.createHash('sha256').update(`${root}\0${agentId}`).digest('hex').slice(0, 24);
}

function controllersRoot() {
  return path.join(os.homedir(), '.marrow', 'controllers');
}

function controllerDirectory(options = {}) {
  return options.stateDirectory
    || process.env.MARROW_SIDECAR_STATE_DIR
    || path.join(controllersRoot(), controllerIdentity(options));
}

function stateFile(options = {}) {
  return path.join(controllerDirectory(options), 'active.json');
}

function lifecycleLockFile(options = {}) {
  return path.join(controllerDirectory(options), 'lifecycle.lock');
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function assertPrivatePath(filePath, kind) {
  const stat = fs.lstatSync(filePath);
  const uid = currentUid();
  if (stat.isSymbolicLink()) throw new Error(`Controller ${kind} cannot be a symlink.`);
  if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`Controller ${kind} has an invalid file type.`);
  }
  if (uid !== null && stat.uid !== uid) throw new Error(`Controller ${kind} must be owned by the current user.`);
  const forbidden = kind === 'directory' ? 0o077 : 0o077;
  if ((stat.mode & forbidden) !== 0) throw new Error(`Controller ${kind} permissions are too broad.`);
  return stat;
}

function ensurePrivateDirectory(options = {}) {
  const directory = path.resolve(controllerDirectory(options));
  const parsed = path.parse(directory);
  let current = parsed.root;
  for (const segment of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(current) !== current) {
      throw new Error('Controller state directory cannot contain symlinked path components.');
    }
    if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) {
      throw new Error('Controller state directory cannot be nested under a non-sticky writable ancestor.');
    }
  }
  fs.chmodSync(directory, 0o700);
  assertPrivatePath(directory, 'directory');
  return directory;
}

function readState(options = {}) {
  return readStateFile(stateFile(options));
}

function readStateFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stat = assertPrivatePath(filePath, 'state file');
  if (stat.size > MAX_STATE_BYTES) throw new Error('Controller state file is oversized.');
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Controller state is invalid.');
  if (!Number.isInteger(value.pid) || value.pid <= 1) throw new Error('Controller state PID is invalid.');
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw new Error('Controller state port is invalid.');
  if (value.host !== '127.0.0.1') throw new Error('Controller state is not loopback-bound.');
  if (typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token)) throw new Error('Controller state token is invalid.');
  if (typeof value.instance_id !== 'string' || !/^sidecar-[0-9a-f-]{36}$/.test(value.instance_id)) throw new Error('Controller instance identity is invalid.');
  if (!Number.isFinite(Date.parse(value.started_at))) throw new Error('Controller start timestamp is invalid.');
  return value;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function controllerSupportedPlatform(platform = process.platform) {
  return platform === 'linux';
}

// The bin of an @getmarrow/install package: <package>/bin/marrow-install.js with a
// package.json named @getmarrow/install. Returns the package version, or null.
function installerPackageVersionForBin(binPath) {
  try {
    const resolved = fs.realpathSync(binPath);
    if (path.basename(resolved) !== 'marrow-install.js' || path.basename(path.dirname(resolved)) !== 'bin') return null;
    const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(resolved)), 'package.json'), 'utf8'));
    return manifest?.name === '@getmarrow/install' && typeof manifest.version === 'string' ? manifest.version : null;
  } catch {
    return null;
  }
}

function controllerProcessBin(pid) {
  const args = fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean);
  return args.length >= 3 && args[2] === 'sidecar' ? args[1] : null;
}

// A controller started by any @getmarrow/install version, including one from another npx
// cache directory, is recognized. Its identity is still proven by the private state file and
// the authenticated /health check before Marrow ever signals it.
function isExpectedControllerProcess(pid, platform = process.platform) {
  if (!controllerSupportedPlatform(platform) || !Number.isInteger(pid) || pid <= 1) return false;
  try {
    const binPath = controllerProcessBin(pid);
    if (!binPath) return false;
    return fs.realpathSync(binPath) === fs.realpathSync(require.resolve('../bin/marrow-install.js'))
      || installerPackageVersionForBin(binPath) !== null;
  } catch {
    return false;
  }
}

// The version a running controller loaded. Controllers from 0.1.66 on report it in /health;
// an older one does not, so its bin package version is reported with a legacy marker.
function runningControllerVersion(pid, healthBody) {
  if (typeof healthBody?.installer_version === 'string' && healthBody.installer_version) {
    return { version: healthBody.installer_version, reported: true };
  }
  let binVersion = null;
  try {
    const binPath = controllerProcessBin(pid);
    binVersion = binPath ? installerPackageVersionForBin(binPath) : null;
  } catch {
    binVersion = null;
  }
  return { version: binVersion, reported: false };
}

async function controllerStatus(options = {}) {
  if (!controllerSupportedPlatform(options.platform)) {
    return {
      active: false,
      state: 'unsupported_platform',
      started_at: null,
      instance_id: null,
      exact_fix: 'Persistent controller lifecycle is currently supported on Linux. Use --no-controller and run npx @getmarrow/install sidecar under an owner-managed service.',
    };
  }
  let state;
  try {
    state = readState(options);
  } catch (error) {
    return {
      active: false,
      state: 'invalid_state',
      started_at: null,
      instance_id: null,
      exact_fix: 'Run npx @getmarrow/install controller stop, then npx @getmarrow/install controller ensure.',
      error: error instanceof Error ? error.message : 'Controller state is invalid.',
    };
  }
  if (!state) {
    return {
      active: false,
      state: 'stopped',
      started_at: null,
      instance_id: null,
      exact_fix: 'Run npx @getmarrow/install controller ensure.',
    };
  }
  if (!pidAlive(state.pid)) {
    return {
      active: false,
      state: 'stale',
      started_at: state.started_at,
      instance_id: state.instance_id,
      exact_fix: 'Run npx @getmarrow/install controller ensure.',
    };
  }
  if (!isExpectedControllerProcess(state.pid, options.platform)) {
    return {
      active: false,
      state: 'identity_mismatch',
      started_at: state.started_at,
      instance_id: state.instance_id,
      exact_fix: 'Inspect the recorded process and controller state before retrying. Marrow will not signal an unverified PID.',
    };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/health`, {
      headers: { Authorization: `Bearer ${state.token}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        active: false,
        state: 'identity_mismatch',
        started_at: state.started_at,
        instance_id: state.instance_id,
        exact_fix: 'Inspect the authenticated controller endpoint and private state before retrying. Marrow will not signal either process.',
      };
    }
    let body;
    try {
      body = await response.json();
    } catch {
      return {
        active: false,
        state: 'identity_mismatch',
        started_at: state.started_at,
        instance_id: state.instance_id,
        exact_fix: 'Inspect the authenticated controller endpoint and private state before retrying. Marrow will not signal either process.',
      };
    }
    if (body?.ok !== true || body?.instance_id !== state.instance_id || body?.pid !== state.pid) {
      return {
        active: false,
        state: 'identity_mismatch',
        started_at: state.started_at,
        instance_id: state.instance_id,
        exact_fix: 'Inspect the authenticated controller endpoint and private state before retrying. Marrow will not signal either process.',
      };
    }
    const maintenance = body.maintenance && typeof body.maintenance === 'object'
      ? body.maintenance
      : null;
    const heartbeat = body.heartbeat && typeof body.heartbeat === 'object'
      ? body.heartbeat
      : null;
    const running = runningControllerVersion(state.pid, body);
    return {
      active: true,
      state: 'active',
      started_at: state.started_at,
      instance_id: state.instance_id,
      installer_version: running.version,
      installer_version_reported: running.reported,
      maintenance,
      heartbeat,
      exact_fix: maintenance?.exact_fix || heartbeat?.exact_fix || null,
    };
  } catch {
    return {
      active: false,
      state: 'unreachable',
      started_at: state.started_at,
      instance_id: state.instance_id,
      exact_fix: 'Run npx @getmarrow/install controller stop, then npx @getmarrow/install controller ensure.',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function cleanControllerEnv(options) {
  const keep = [
    'HOME', 'USER', 'LOGNAME', 'PATH', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP',
    'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
  ];
  const env = {};
  for (const name of keep) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.MARROW_API_KEY = options.apiKey;
  env.MARROW_BASE_URL = options.baseUrl;
  if (options.agentId) {
    env.MARROW_FLEET_AGENT_ID = options.agentId;
    env.MARROW_AGENT_ID = options.agentId;
  }
  env.MARROW_CLIENT = options.client;
  // The owner's identity allowlist travels with the controller so maintenance honors it.
  // So does the local-runtime switch, so maintenance keeps hooks where install put them.
  for (const name of ['MARROW_ALLOWED_BASE_URLS', 'MARROW_ALLOWED_AGENT_IDS', 'MARROW_LOCAL_RUNTIME']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.MARROW_GOVERN_PROFILE = options.profile;
  env.MARROW_GOVERN_POLICY = options.policy;
  env.MARROW_CONTROLLER_PROJECT_ROOT = path.resolve(options.root || process.cwd());
  env.MARROW_CONTROLLER_MANAGED_MODE = options.mode || 'auto';
  env.MARROW_SIDECAR_STATE_DIR = controllerDirectory(options);
  return env;
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 75));
  } while (Date.now() < deadline);
  return null;
}

function tryAcquireLifecycleLock(options = {}) {
  const filePath = lifecycleLockFile(options);
  const nonce = crypto.randomBytes(16).toString('hex');
  let descriptor;
  let created = false;
  try {
    descriptor = fs.openSync(filePath, 'wx', 0o600);
    created = true;
    fs.writeFileSync(descriptor, JSON.stringify({
      pid: process.pid,
      nonce,
      created_at: new Date().toISOString(),
    }) + '\n', 'utf8');
    fs.fsyncSync(descriptor);
    fs.chmodSync(filePath, 0o600);
    return { descriptor, filePath, nonce };
  } catch (error) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (created) {
      try { fs.unlinkSync(filePath); } catch {}
    }
    if (error?.code !== 'EEXIST') throw error;
    const stat = assertPrivatePath(filePath, 'lifecycle lock');
    if (stat.size > MAX_STATE_BYTES) throw new Error('Controller lifecycle lock is oversized.');
    let value;
    try {
      value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      throw new Error('Controller lifecycle lock is invalid.');
    }
    const stale = Date.now() - stat.mtimeMs > LIFECYCLE_LOCK_STALE_MS;
    if (stale && Number.isInteger(value?.pid) && !pidAlive(value.pid)) {
      fs.unlinkSync(filePath);
      return null;
    }
    return false;
  }
}

async function acquireLifecycleLock(options = {}) {
  const deadline = Date.now() + START_TIMEOUT_MS;
  do {
    const lock = tryAcquireLifecycleLock(options);
    if (lock) return lock;
    await new Promise((resolve) => setTimeout(resolve, 75));
  } while (Date.now() < deadline);
  throw new Error('Another Marrow controller lifecycle operation is still in progress.');
}

function releaseLifecycleLock(lock) {
  if (!lock) return;
  try { fs.closeSync(lock.descriptor); } catch {}
  try {
    const stat = assertPrivatePath(lock.filePath, 'lifecycle lock');
    if (stat.size > MAX_STATE_BYTES) return;
    const value = JSON.parse(fs.readFileSync(lock.filePath, 'utf8'));
    if (value?.nonce === lock.nonce) fs.unlinkSync(lock.filePath);
  } catch {}
}

function removeStaleState(options = {}) {
  const filePath = stateFile(options);
  if (!fs.existsSync(filePath)) return;
  assertPrivatePath(filePath, 'state file');
  fs.unlinkSync(filePath);
}

function removeInvalidState(options = {}) {
  const filePath = stateFile(options);
  if (!fs.existsSync(filePath)) return false;
  assertPrivatePath(filePath, 'state file');
  fs.unlinkSync(filePath);
  return true;
}

async function stopRecordedController(state, options = {}) {
  if (!pidAlive(state.pid)) return;
  if (!isExpectedControllerProcess(state.pid, options.platform)) {
    throw new Error('Refusing to terminate an unreachable process that cannot be verified as the Marrow controller.');
  }
  process.kill(state.pid, 'SIGTERM');
  const stopped = await waitFor(async () => pidAlive(state.pid) ? null : true, STOP_TIMEOUT_MS);
  if (!stopped) throw new Error('Marrow controller did not stop within the shutdown window.');
}

async function startGovernanceController(options) {
  if (!controllerSupportedPlatform(options.platform)) {
    throw new Error('Persistent controller lifecycle is currently supported on Linux. Use --no-controller and run the sidecar under an owner-managed service.');
  }
  if (!options.apiKey) throw new Error('MARROW_API_KEY is required to start the Marrow controller.');
  const directory = ensurePrivateDirectory(options);
  const lock = await acquireLifecycleLock(options);
  try {
    const current = await controllerStatus(options);
    if (current.active) return { ...current, changed: false };
    if (current.state === 'stale') removeStaleState(options);
    if (current.state === 'unreachable') {
      const prior = readState(options);
      await stopRecordedController(prior, options);
      removeStaleState(options);
    }
    if (current.state === 'identity_mismatch') {
      throw new Error('Controller process identity is ambiguous; refusing automatic replacement.');
    }
    if (current.state === 'invalid_state') throw new Error(current.error || 'Controller state is invalid.');

    const logPath = path.join(directory, 'controller.log');
    if (fs.existsSync(logPath)) assertPrivatePath(logPath, 'log file');
    const logFd = fs.openSync(logPath, 'a', 0o600);
    fs.chmodSync(logPath, 0o600);
    const binPath = require.resolve('../bin/marrow-install.js');
    const args = [
      binPath,
      'sidecar',
      ...(options.agentId ? ['--agent', options.agentId] : []),
      '--client', options.client,
      '--profile', options.profile,
      '--policy', options.policy,
    ];
    let child;
    try {
      child = spawn(process.execPath, args, {
        detached: true,
        env: cleanControllerEnv(options),
        stdio: ['ignore', logFd, logFd],
      });
      child.unref();
    } finally {
      fs.closeSync(logFd);
    }

    const active = await waitFor(async () => {
      const status = await controllerStatus(options);
      return status.active ? status : null;
    }, START_TIMEOUT_MS);
    if (!active) {
      if (child?.pid && pidAlive(child.pid)) {
        try { process.kill(child.pid, 'SIGTERM'); } catch {}
      }
      throw new Error('Marrow controller did not become healthy within the startup window.');
    }
    return { ...active, changed: true };
  } finally {
    releaseLifecycleLock(lock);
  }
}

async function stopGovernanceController(options = {}) {
  if (!controllerSupportedPlatform(options.platform)) {
    throw new Error('Persistent controller lifecycle is currently supported on Linux. No process was signaled.');
  }
  ensurePrivateDirectory(options);
  const lock = await acquireLifecycleLock(options);
  try {
    let state;
    try {
      state = readState(options);
    } catch {
      const changed = removeInvalidState(options);
      return { active: false, state: 'stopped', changed, exact_fix: null };
    }
    if (!state) return { active: false, state: 'stopped', changed: false, exact_fix: null };
    const current = await controllerStatus(options);
    if (current.state === 'identity_mismatch') {
      throw new Error('Refusing to stop a controller whose PID is not bound to its authenticated endpoint.');
    }
    if (current.active || current.state === 'unreachable') {
      await stopRecordedController(state, options);
    }
    removeStaleState(options);
    return { active: false, state: 'stopped', changed: true, exact_fix: null };
  } finally {
    releaseLifecycleLock(lock);
  }
}

async function ensureGovernanceController(options) {
  const current = await controllerStatus(options);
  return current.active ? { ...current, changed: false } : startGovernanceController(options);
}

function controllerProjectRoot(pid, state) {
  if (typeof state?.project_root === 'string' && state.project_root) return path.resolve(state.project_root);
  // Controllers before 0.1.66 do not record their project in state. Their environment holds it;
  // only that one variable is read, in memory, and nothing else from it is kept or printed.
  try {
    const entry = fs.readFileSync(`/proc/${pid}/environ`).toString('utf8').split('\0')
      .find((value) => value.startsWith('MARROW_CONTROLLER_PROJECT_ROOT='));
    return entry ? path.resolve(entry.slice('MARROW_CONTROLLER_PROJECT_ROOT='.length)) : null;
  } catch {
    return null;
  }
}

// Live controllers owned by this user for one project, whatever identity directory they use.
// Identity directories changed across installer versions, so a controller can outlive the
// directory a newer installer computes for the same project.
async function projectControllers(options = {}) {
  if (!controllerSupportedPlatform(options.platform)) return [];
  const root = path.resolve(options.root || process.cwd());
  const directories = process.env.MARROW_SIDECAR_STATE_DIR && !options.scanAll
    ? [process.env.MARROW_SIDECAR_STATE_DIR]
    : (() => {
      try {
        const base = controllersRoot();
        const baseStat = fs.lstatSync(base);
        if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) return [];
        return fs.readdirSync(base).filter((name) => /^[a-f0-9]{24}$/.test(name)).map((name) => path.join(base, name));
      } catch {
        return [];
      }
    })();
  const found = [];
  for (const directory of directories) {
    let state;
    try {
      assertPrivatePath(directory, 'directory');
      state = readStateFile(path.join(directory, 'active.json'));
    } catch {
      continue;
    }
    if (!state || !pidAlive(state.pid) || !isExpectedControllerProcess(state.pid, options.platform)) continue;
    if (controllerProjectRoot(state.pid, state) !== root) continue;
    const status = await controllerStatus({ ...options, stateDirectory: directory });
    found.push({ directory, state, status });
  }
  return found;
}

// Keeps exactly one current controller for the project. A controller from another installer
// version, or one left in a superseded identity directory, is stopped through its verified
// endpoint and replaced. Local control state is not read or changed here; callers only ensure
// a controller while the owner has control enabled.
async function ensureCurrentGovernanceController(options) {
  const currentDirectory = path.resolve(controllerDirectory(options));
  const superseded = [];
  for (const entry of await projectControllers(options)) {
    const sameDirectory = path.resolve(entry.directory) === currentDirectory;
    const current = entry.status.active && entry.status.installer_version === INSTALLER_VERSION
      && entry.status.installer_version_reported === true;
    if (sameDirectory && current) continue;
    if (!entry.status.active && entry.status.state !== 'unreachable') continue;
    await stopGovernanceController({ ...options, stateDirectory: entry.directory });
    superseded.push(entry.status.installer_version
      ? `${entry.status.installer_version}${entry.status.installer_version_reported ? '' : ' (legacy)'}`
      : 'unknown');
  }
  const result = await ensureGovernanceController(options);
  return {
    ...result,
    restarted: superseded.length > 0
      ? { from_versions: superseded, to_version: INSTALLER_VERSION, stopped: superseded.length }
      : null,
  };
}

async function stopProjectControllers(options) {
  const stopped = [];
  for (const entry of await projectControllers(options)) {
    await stopGovernanceController({ ...options, stateDirectory: entry.directory });
    stopped.push(entry.status.installer_version || 'unknown');
  }
  const current = await stopGovernanceController(options);
  return { ...current, changed: current.changed || stopped.length > 0, stopped: stopped.length };
}

module.exports = {
  cleanControllerEnv,
  INSTALLER_VERSION,
  controllerDirectory,
  controllerIdentity,
  controllerSupportedPlatform,
  controllerStatus,
  ensureCurrentGovernanceController,
  ensureGovernanceController,
  installerPackageVersionForBin,
  isExpectedControllerProcess,
  projectControllers,
  readState,
  startGovernanceController,
  stopGovernanceController,
  stopProjectControllers,
};

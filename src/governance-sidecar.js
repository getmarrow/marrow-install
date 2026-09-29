const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const MAX_BODY_BYTES = 64 * 1024;
const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_MAX_BACKOFF_MS = 30 * 60_000;
const HEARTBEAT_CIRCUIT_THRESHOLD = 5;
const HEARTBEAT_PROBE_MS = 60 * 60_000;
const CONTROLLER_RESTART = 'npx @getmarrow/install controller stop && npx @getmarrow/install controller ensure';

function heartbeatFailure(error) {
  const status = Number.isInteger(error?.status) ? error.status : null;
  const rawCode = error?.details?.code || error?.code;
  const code = typeof rawCode === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(rawCode) ? rawCode : null;
  return {
    status,
    code,
    // A 4xx other than timeout or rate limit repeats until the request or its identity changes.
    permanent: status !== null && status >= 400 && status < 500 && status !== 408 && status !== 429,
    signature: `${status ?? 'network'}:${code ?? ''}`,
  };
}

function heartbeatExactFix({ status, code }) {
  const failure = `HTTP ${status}${code ? ` ${code}` : ''}`;
  if (status === 404) {
    return `Marrow has no registered agent for this controller (${failure}). Create the agent or bind this API key to a registered agent, set MARROW_FLEET_AGENT_ID to its id if the key is not bound, then run ${CONTROLLER_RESTART} to retry now.`;
  }
  if (status === 401 || status === 403) {
    return `Marrow rejected this controller's API key or agent scope (${failure}). Use an active key bound to the registered agent, then run ${CONTROLLER_RESTART} to retry now.`;
  }
  return `Marrow rejected the controller heartbeat (${failure}). Run npx -y @getmarrow/install@latest update, then ${CONTROLLER_RESTART} to retry now.`;
}

// Heartbeats back off exponentially with jitter after any failure. Repeated identical 4xx
// responses open the circuit: heartbeats then drop to one jittered probe about every hour,
// so a fleet-wide transient 401/403/404 recovers without restarts. 5xx, 429, and network
// failures keep retrying at the capped backoff. A notice is returned only when the circuit
// opens, when its fix changes, and when heartbeats recover.
function createHeartbeatPolicy({
  intervalMs = HEARTBEAT_INTERVAL_MS,
  maxBackoffMs = HEARTBEAT_MAX_BACKOFF_MS,
  circuitThreshold = HEARTBEAT_CIRCUIT_THRESHOLD,
  probeMs = HEARTBEAT_PROBE_MS,
  random = Math.random,
} = {}) {
  let consecutive = 0;
  let identical = 0;
  let last = null;
  let openFix = null;
  return {
    get open() { return openFix !== null; },
    success() {
      const recovered = openFix !== null;
      consecutive = 0;
      identical = 0;
      last = null;
      openFix = null;
      return {
        delayMs: intervalMs,
        state: { state: 'ok', failures: 0, exact_fix: null },
        notice: recovered ? 'Marrow controller resumed enforcement heartbeats.' : null,
      };
    },
    failure(error) {
      const failure = heartbeatFailure(error);
      consecutive += 1;
      identical = last?.signature === failure.signature ? identical + 1 : 1;
      last = failure;
      const summary = { status: failure.status, code: failure.code, failures: identical };
      if (openFix !== null || (failure.permanent && identical >= circuitThreshold)) {
        const fix = failure.permanent ? heartbeatExactFix(failure) : openFix;
        const notice = fix === openFix
          ? null
          : `Marrow controller paused enforcement heartbeats and retries about once an hour. ${fix}`;
        openFix = fix;
        const delayMs = Math.round(probeMs * (0.75 + random() * 0.5));
        return { delayMs, state: { state: 'circuit_open', ...summary, retry_in_ms: delayMs, exact_fix: fix }, notice };
      }
      const ceiling = Math.min(maxBackoffMs, intervalMs * 2 ** consecutive);
      const delayMs = Math.round(ceiling / 2 + random() * (ceiling / 2));
      return { delayMs, state: { state: 'backing_off', ...summary, retry_in_ms: delayMs, exact_fix: null }, notice: null };
    },
  };
}

function sidecarStateDir() {
  return process.env.MARROW_SIDECAR_STATE_DIR || path.join(os.homedir(), '.marrow', 'sidecar');
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function createPrivateDirectoryWithoutSymlinks(directory) {
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      fs.mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory() || fs.realpathSync(current) !== current) {
      throw new Error('Sidecar state directory cannot contain symlinked path components.');
    }
    if ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0) {
      throw new Error('Sidecar state directory cannot be nested under a non-sticky writable ancestor.');
    }
  }
  return resolved;
}

function assertPrivateStateDirectory(directory) {
  const resolved = createPrivateDirectoryWithoutSymlinks(directory);
  const stat = fs.lstatSync(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Sidecar state directory must be a private real directory.');
  }
  if (fs.realpathSync(resolved) !== resolved) {
    throw new Error('Sidecar state directory cannot contain symlinked path components.');
  }
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) {
    throw new Error('Sidecar state directory must be owned by the current user.');
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error('Sidecar state directory permissions must be 0700 or stricter.');
  }
  return resolved;
}

function assertSafeStateFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const stat = fs.lstatSync(filePath);
  const uid = currentUid();
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('Sidecar state file must be a private regular file.');
  }
  if (uid !== null && stat.uid !== uid) {
    throw new Error('Sidecar state file must be owned by the current user.');
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error('Sidecar state file permissions must be 0600 or stricter.');
  }
}

function writePrivateJsonAtomic(filePath, value) {
  const directory = assertPrivateStateDirectory(path.dirname(filePath));
  const target = path.join(directory, path.basename(filePath));
  assertSafeStateFile(target);
  const temporary = path.join(directory, '.active-' + process.pid + '-' + crypto.randomBytes(8).toString('hex') + '.tmp');
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    assertSafeStateFile(target);
    fs.renameSync(temporary, target);
    fs.chmodSync(target, 0o600);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function unlinkPrivateStateFile(filePath, expectedInstanceId) {
  try {
    const stat = fs.lstatSync(filePath);
    const uid = currentUid();
    if (!stat.isSymbolicLink() && stat.isFile() && (uid === null || stat.uid === uid)) {
      const raw = stat.size <= 8 * 1024 ? fs.readFileSync(filePath, 'utf8') : '';
      const current = raw ? JSON.parse(raw) : null;
      if (current?.instance_id === expectedInstanceId) fs.unlinkSync(filePath);
    }
  } catch {}
}

async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new Error('request_too_large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_json');
  return value;
}

function json(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}

async function startGovernanceSidecar(options, handlers) {
  if (!options.apiKey) throw new Error('MARROW_API_KEY is required to start the governance sidecar.');
  const port = Number(options.sidecarPort || process.env.MARROW_SIDECAR_PORT || 0);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid sidecar port.');
  const authToken = crypto.randomBytes(32).toString('hex');
  const instanceId = `sidecar-${crypto.randomUUID()}`;
  const startedAt = new Date().toISOString();
  let latestCoverage = null;
  let latestMaintenance = {
    state: handlers.maintain ? 'pending' : 'unavailable',
    checked_at: null,
    repaired: [],
    exact_fix: handlers.maintain ? null : 'Run npx @getmarrow/install --repair in the managed project.',
  };
  let latestHeartbeat = { state: 'pending', failures: 0, exact_fix: null, checked_at: null };

  const server = http.createServer(async (req, res) => {
    try {
      if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::1') {
        return json(res, 403, { ok: false, error: 'loopback_only' });
      }
      if (req.headers.authorization !== `Bearer ${authToken}`) {
        return json(res, 401, { ok: false, error: 'invalid_sidecar_token' });
      }
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/health') {
        return json(res, 200, {
          ok: true,
          instance_id: instanceId,
          pid: process.pid,
          started_at: startedAt,
          maintenance: latestMaintenance,
          heartbeat: latestHeartbeat,
        });
      }
      if (req.method === 'GET' && url.pathname === '/coverage') {
        latestCoverage = await handlers.coverage();
        return json(res, 200, latestCoverage);
      }
      if (req.method === 'POST' && ['/permit', '/verify', '/close'].includes(url.pathname)) {
        const body = await readJson(req);
        const operation = url.pathname.slice(1);
        return json(res, 200, await handlers[operation](body));
      }
      return json(res, 404, { ok: false, error: 'not_found' });
    } catch (error) {
      return json(res, error?.message === 'request_too_large' ? 413 : 400, {
        ok: false,
        error: error instanceof Error ? error.message : 'sidecar_request_failed',
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  const stateFile = path.join(sidecarStateDir(), 'active.json');
  try {
    writePrivateJsonAtomic(stateFile, {
      instance_id: instanceId,
      pid: process.pid,
      host: '127.0.0.1',
      port: boundPort,
      token: authToken,
      started_at: startedAt,
    });
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }

  const heartbeatPolicy = createHeartbeatPolicy({
    intervalMs: options.heartbeatIntervalMs,
    probeMs: options.heartbeatProbeMs,
    random: options.heartbeatRandom,
  });
  let nextHeartbeatAt = 0;
  // Maintenance and heartbeat have separate in-flight guards, so a hung heartbeat request
  // never stalls drift repair.
  let maintenanceRunning = false;
  let heartbeatRunning = false;
  const runMaintenance = async () => {
    if (!handlers.maintain || maintenanceRunning) return;
    maintenanceRunning = true;
    try {
      latestMaintenance = await handlers.maintain();
    } catch {
      latestMaintenance = {
        state: 'attention_required',
        checked_at: new Date().toISOString(),
        repaired: [],
        exact_fix: 'Run npx @getmarrow/install --repair in the managed project.',
      };
    } finally {
      maintenanceRunning = false;
    }
  };
  const runHeartbeat = async () => {
    if (heartbeatRunning || Date.now() < nextHeartbeatAt) return;
    heartbeatRunning = true;
    try {
      let result;
      try {
        latestCoverage = await handlers.heartbeat({ sidecarInstanceId: instanceId });
        result = heartbeatPolicy.success();
      } catch (error) {
        // Coverage will mark a stale heartbeat; never weaken execution policy here.
        result = heartbeatPolicy.failure(error);
      }
      latestHeartbeat = { ...result.state, checked_at: new Date().toISOString() };
      nextHeartbeatAt = Date.now() + result.delayMs;
      if (result.notice) process.stderr.write(`${result.notice}\n`);
    } finally {
      heartbeatRunning = false;
    }
  };
  const tick = () => Promise.all([runMaintenance(), runHeartbeat()]);
  await tick();
  const timer = setInterval(tick, options.heartbeatIntervalMs || HEARTBEAT_INTERVAL_MS);
  timer.unref();

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    unlinkPrivateStateFile(stateFile, instanceId);
    process.off('SIGINT', close);
    process.off('SIGTERM', close);
    server.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);

  return { server, instanceId, port: boundPort, stateFile, close };
}

module.exports = { startGovernanceSidecar, sidecarStateDir, createHeartbeatPolicy };

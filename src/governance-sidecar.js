const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const MAX_BODY_BYTES = 64 * 1024;

function sidecarStateDir() {
  return process.env.MARROW_SIDECAR_STATE_DIR || path.join(os.homedir(), '.marrow', 'sidecar');
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function assertPrivateStateDirectory(directory) {
  const resolved = path.resolve(directory);
  fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
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

function unlinkPrivateStateFile(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    const uid = currentUid();
    if (!stat.isSymbolicLink() && stat.isFile() && (uid === null || stat.uid === uid)) {
      fs.unlinkSync(filePath);
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
        return json(res, 200, { ok: true, instance_id: instanceId, started_at: startedAt });
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

  const heartbeat = async () => {
    try {
      latestCoverage = await handlers.heartbeat({ sidecarInstanceId: instanceId });
    } catch {
      // Coverage will mark stale heartbeat; never weaken execution policy here.
    }
  };
  await heartbeat();
  const timer = setInterval(heartbeat, 30_000);
  timer.unref();

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    unlinkPrivateStateFile(stateFile);
    process.off('SIGINT', close);
    process.off('SIGTERM', close);
    server.close();
  };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);

  return { server, instanceId, port: boundPort, stateFile, close };
}

module.exports = { startGovernanceSidecar, sidecarStateDir };

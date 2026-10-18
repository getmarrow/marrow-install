// PKG-M2: a key read from an owner file (~/.marrow/env, ~/.marrow/env.local) is sent only to the
// default endpoint, the endpoint that same file names, or an exact origin that same file lists in
// MARROW_ALLOWED_BASE_URLS. A base URL that only the process environment or --base-url names never
// moves it. A key from the process environment keeps its URL. Every URL must be https (loopback may
// be http) and a refused URL stops the run before any network call.
require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const policy = require('../src/base-url-policy');
const { parseArgs } = require('../src/governed-runner');
const installer = require('../src/installer');
const { bestEffortLifecycle } = require('../src/control-state');
const { readOwnerApiKey, readOwnerKeyDetail } = require('../src/owner-env');

const VECTORS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'm2-base-url-vectors.json'), 'utf8'));
const DEFAULT_URL = VECTORS.default;
const BIN = path.join(__dirname, '..', 'bin', 'marrow-install.js');
const RECORDER = path.join(__dirname, 'support', 'm2-network-recorder.js');

const dummyKey = (label) => `synthetic-${label}-${crypto.randomBytes(12).toString('hex')}`;

function fixture(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `marrow-m2-${label}-`));
  const home = path.join(root, 'home');
  const marrowDir = path.join(home, '.marrow');
  fs.mkdirSync(marrowDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(home, 0o700);
  fs.chmodSync(marrowDir, 0o700);
  const project = path.join(root, 'project');
  fs.mkdirSync(project, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(project, 'package.json'), '{"name":"m2","private":true}\n');
  return { root, home, marrowDir, project, envFile: path.join(marrowDir, 'env'), localFile: path.join(marrowDir, 'env.local') };
}

function write(file, lines, mode = 0o600) {
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode });
  fs.chmodSync(file, mode);
}

function ownerFile(fx, key, extra = []) {
  write(fx.envFile, [`MARROW_API_KEY=${key}`, ...extra]);
}

// Runs a body with a private process environment, as the runner reads it at parse time.
function withProcessEnv(fx, env, body) {
  const names = ['MARROW_API_KEY', 'MARROW_KEY', 'MARROW_BASE_URL', 'MARROW_ALLOWED_BASE_URLS', 'MARROW_FLEET_AGENT_ID', 'MARROW_AGENT_ID', 'MARROW_SESSION_ID', 'HOME', 'USERPROFILE'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  process.env.HOME = fx.home;
  process.env.USERPROFILE = fx.home;
  Object.assign(process.env, env);
  try {
    return body();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function runnerOptions(fx, env, args = []) {
  return withProcessEnv(fx, env, () => parseArgs(['run', ...args, '--', 'true']).options);
}

// ---- the policy module ----

for (const vector of VECTORS.vectors) {
  test(`policy: owner key + env URL: ${vector.name}`, () => {
    const decision = policy.ownerKeyBaseUrl({
      candidate: vector.envUrl,
      ownerValues: { MARROW_ALLOWED_BASE_URLS: vector.allowed || '' },
      fileName: 'env',
    });
    assert.equal(decision.baseUrl, vector.expect === 'kept' ? vector.expectedUrl : DEFAULT_URL);
    assert.equal(Boolean(decision.notice), vector.expectNotice);
    if (decision.notice) {
      assert.equal(decision.notice, 'ignored MARROW_BASE_URL from the process environment: the key comes from ~/.marrow/env; list the URL in MARROW_ALLOWED_BASE_URLS in that file to allow it');
    }
  });
}

test('policy: the owner file naming a URL accepts the same origin from the environment and nothing else', () => {
  const ownerValues = { MARROW_BASE_URL: 'https://staging.example' };
  assert.equal(policy.ownerKeyBaseUrl({ candidate: 'https://staging.example', ownerValues }).baseUrl, 'https://staging.example');
  assert.equal(policy.ownerKeyBaseUrl({ candidate: 'https://staging.example/gateway', ownerValues }).baseUrl, 'https://staging.example/gateway');
  const other = policy.ownerKeyBaseUrl({ candidate: 'https://attacker.example', ownerValues });
  assert.equal(other.baseUrl, DEFAULT_URL);
  assert.ok(other.notice);
  assert.equal(policy.ownerKeyBaseUrl({ candidate: 'https://staging.example.attacker.example', ownerValues }).baseUrl, DEFAULT_URL);
  assert.equal(policy.ownerKeyBaseUrl({ candidate: 'https://u:p@staging.example', ownerValues }).baseUrl, DEFAULT_URL);
});

const SAFE = ['https://api.getmarrow.ai', 'https://staging.example:8443/gateway', 'http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787', 'HTTP://LOCALHOST', ''];
const UNSAFE = [
  'http://attacker.example', 'http://api.getmarrow.ai', 'http://0.0.0.0:8787', 'http://localhost.attacker.example',
  'http://127.0.0.1.nip.io', 'http://[::ffff:127.0.0.1]:8787', 'https://user:hunter2@attacker.example', 'http://user:hunter2@localhost',
  'https://api.getmarrow.ai?x=1', 'https://api.getmarrow.ai#x', 'https://api.getmarrow.ai\\@attacker.example', 'ftp://localhost',
  'file:///etc/passwd', 'not a url', 'https://stag ing.example', 'https://*.example',
];

test('policy: assertSafeBaseUrl accepts https and loopback http, refuses the rest, and never echoes the value', () => {
  for (const value of SAFE) assert.doesNotThrow(() => policy.assertSafeBaseUrl(value), value);
  for (const value of UNSAFE) {
    assert.throws(() => policy.assertSafeBaseUrl(value, 'MARROW_BASE_URL'), (error) => {
      assert.match(error.message, /^MARROW_BASE_URL must be an https URL/);
      assert.equal(/hunter2|attacker|nip\.io|not a url|stag ing|etc\/passwd/.test(error.message), false, `the message echoes ${value}`);
      return true;
    }, value);
  }
});

test('owner reader: the endpoint values come only from the file that supplied the key', () => {
  const fx = fixture('reader');
  const key = dummyKey('local');
  write(fx.localFile, [`MARROW_API_KEY=${key}`, 'MARROW_ALLOWED_BASE_URLS=https://local.example']);
  write(fx.envFile, [`MARROW_API_KEY=${dummyKey('env')}`, 'MARROW_ALLOWED_BASE_URLS=https://env.example', 'MARROW_BASE_URL=https://named.example']);
  const detail = readOwnerKeyDetail(fx.home);
  assert.equal(detail.apiKey, key);
  assert.equal(detail.fileName, 'env.local');
  assert.deepEqual(detail.endpoint, { MARROW_BASE_URL: '', MARROW_ALLOWED_BASE_URLS: 'https://local.example' });
  assert.deepEqual(Object.keys(readOwnerApiKey(fx.home)).sort(), ['apiKey', 'conflict', 'source'], 'the public shape of readOwnerApiKey is unchanged');
});

// ---- the governed runner ----

for (const vector of VECTORS.vectors) {
  test(`runner: owner key + env URL: ${vector.name}`, () => {
    const fx = fixture('runner');
    const key = dummyKey('owner');
    ownerFile(fx, key, vector.allowed ? [`MARROW_ALLOWED_BASE_URLS=${vector.allowed}`] : []);
    const options = runnerOptions(fx, vector.envUrl == null ? {} : { MARROW_BASE_URL: vector.envUrl });
    assert.equal(options.apiKey, key);
    assert.equal(options.baseUrl, vector.expect === 'kept' ? vector.expectedUrl : DEFAULT_URL);
  });
}

test('runner: owner key + owner-file URL for the same origin is kept; another origin is not', () => {
  const fx = fixture('runner-file');
  ownerFile(fx, dummyKey('owner'), ['MARROW_BASE_URL=https://staging.example']);
  assert.equal(runnerOptions(fx, { MARROW_BASE_URL: 'https://staging.example' }).baseUrl, 'https://staging.example');
  assert.equal(runnerOptions(fx, { MARROW_BASE_URL: 'https://attacker.example' }).baseUrl, DEFAULT_URL);
  // R1-11: with no environment URL the file's own URL is used, as MCP and the SDK do (master used the default).
  assert.equal(runnerOptions(fx, {}).baseUrl, 'https://staging.example', 'no environment URL: the owner file\'s own URL');
});

test('runner: --base-url follows the same rule as the environment URL for an owner key', () => {
  const fx = fixture('runner-flag');
  ownerFile(fx, dummyKey('owner'), ['MARROW_ALLOWED_BASE_URLS=https://staging.example']);
  assert.equal(runnerOptions(fx, {}, ['--base-url', 'https://staging.example']).baseUrl, 'https://staging.example');
  assert.equal(runnerOptions(fx, {}, ['--base-url', 'https://attacker.example']).baseUrl, DEFAULT_URL);
  assert.equal(runnerOptions(fx, { MARROW_BASE_URL: 'https://staging.example' }, ['--base-url', 'https://attacker.example']).baseUrl, DEFAULT_URL);
});

test('runner: env key + env URL is unchanged (even with an owner key on disk); --key is an explicit key', () => {
  const fx = fixture('runner-env');
  const envKey = dummyKey('env');
  ownerFile(fx, dummyKey('owner'));
  for (const url of ['https://attacker.example', 'http://[::1]:8787', 'http://127.0.0.1:9', 'https://staging.example/gateway']) {
    const options = runnerOptions(fx, { MARROW_API_KEY: envKey, MARROW_BASE_URL: url });
    assert.equal(options.apiKey, envKey);
    assert.equal(options.baseUrl, url);
  }
  const argKey = dummyKey('arg');
  const options = runnerOptions(fx, { MARROW_BASE_URL: 'https://staging.example' }, ['--key', argKey]);
  assert.equal(options.apiKey, argKey);
  assert.equal(options.baseUrl, 'https://staging.example');
});

test('runner: a URL that is not https (loopback may be http) is refused at parse time, with no echo', () => {
  const fx = fixture('runner-refuse');
  const key = dummyKey('env');
  for (const url of UNSAFE.filter((value) => value !== 'not a url' || true)) {
    assert.throws(() => runnerOptions(fx, { MARROW_API_KEY: key, MARROW_BASE_URL: url }), (error) => {
      assert.match(error.message, /^MARROW_BASE_URL must be an https URL/);
      assert.equal(/hunter2|attacker|nip\.io|not a url|stag ing|etc\/passwd/.test(error.message), false);
      return true;
    }, url);
    assert.throws(() => runnerOptions(fx, { MARROW_API_KEY: key }, ['--base-url', url]), /^Error: --base-url must be an https URL|--base-url must be an https URL/, url);
  }
});

test('runner: an owner file that is not owner-only, or is a symlink, supplies no key and so no pairing', { skip: process.platform === 'win32' }, () => {
  const fx = fixture('runner-untrusted');
  const key = dummyKey('loose');
  write(fx.envFile, [`MARROW_API_KEY=${key}`, 'MARROW_ALLOWED_BASE_URLS=https://staging.example'], 0o644);
  let options = runnerOptions(fx, { MARROW_BASE_URL: 'https://staging.example' });
  assert.equal(options.apiKey, '');
  fs.rmSync(fx.envFile);
  const real = path.join(fx.root, 'real-env');
  write(real, [`MARROW_API_KEY=${key}`]);
  fs.symlinkSync(real, fx.envFile);
  options = runnerOptions(fx, { MARROW_BASE_URL: 'https://staging.example' });
  assert.equal(options.apiKey, '');
});

// ---- control-state ----

async function withFetch(body) {
  const saved = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), auth: String((init.headers && init.headers.authorization) || '') });
    return { ok: true };
  };
  try {
    await body(requests);
  } finally {
    globalThis.fetch = saved;
  }
}

test('control-state: a key handed in by the caller is never paired with the process environment URL', async () => {
  const fx = fixture('control');
  const key = dummyKey('caller');
  await withFetch(async (requests) => {
    await withProcessEnv(fx, { MARROW_BASE_URL: 'https://attacker.example' }, () => bestEffortLifecycle({ event_type: 'x' }, { apiKey: key }));
    assert.equal(requests.length, 1);
    assert.ok(requests[0].url.startsWith(`${DEFAULT_URL}/`), requests[0].url);
    assert.equal(requests[0].auth, `Bearer ${key}`);
  });
});

test('control-state: a caller that names the URL it checked gets that URL; an environment key keeps the environment URL', async () => {
  const fx = fixture('control-env');
  const key = dummyKey('env');
  await withFetch(async (requests) => {
    await bestEffortLifecycle({ event_type: 'x' }, { apiKey: key, baseUrl: 'https://staging.example' });
    await withProcessEnv(fx, { MARROW_API_KEY: key, MARROW_BASE_URL: 'https://staging.example' }, () => bestEffortLifecycle({ event_type: 'x' }, {}));
    assert.deepEqual(requests.map((request) => new URL(request.url).origin), ['https://staging.example', 'https://staging.example']);
  });
});

test('control-state: a non-https URL skips delivery with no network call, and the notice names no URL or key', async () => {
  const fx = fixture('control-refuse');
  const key = dummyKey('env');
  const writes = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk) => { writes.push(String(chunk)); return true; };
  try {
    await withFetch(async (requests) => {
      for (const url of ['http://attacker.example', 'http://0.0.0.0:8787', 'https://user:hunter2@attacker.example']) {
        const delivered = await withProcessEnv(fx, { MARROW_API_KEY: key, MARROW_BASE_URL: url }, () => bestEffortLifecycle({ event_type: 'x' }, {}));
        assert.equal(delivered, false);
      }
      assert.deepEqual(requests, []);
    });
  } finally {
    process.stderr.write = original;
  }
  const text = writes.join('');
  assert.equal(/hunter2|attacker|0\.0\.0\.0/.test(text) || text.includes(key), false);
});

// ---- consumers, end to end: where does the key actually go? ----

function listener() {
  const connections = [];
  const server = net.createServer((socket) => {
    connections.push(socket.remoteAddress);
    socket.destroy();
  });
  return new Promise((resolveListen) => {
    server.listen(0, '127.0.0.1', () => resolveListen({ server, port: server.address().port, connections }));
  });
}

function run(args, { env, cwd }) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => {
      clearTimeout(timer);
      resolveRun({ status, stdout, stderr });
    });
  });
}

function childEnv(fx, key, extra, { record = true } = {}) {
  const capture = path.join(fx.root, 'capture.jsonl');
  fs.writeFileSync(capture, '');
  return {
    capture,
    env: {
      PATH: process.env.PATH,
      HOME: fx.home,
      TMPDIR: process.env.TMPDIR,
      CAPTURE_FILE: capture,
      M2_EXPECT_KEY: key,
      ...(record ? { NODE_OPTIONS: `--require=${RECORDER}` } : {}),
      ...extra,
    },
  };
}

function captured(file) {
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const COMMANDS = [
  ['gate', ['gate', '--type', 'deploy', '--action', 'deploy to production', '--no-interactive']],
  ['status', ['status']],
  ['run (governed runner)', ['run', '--no-interactive', '--', 'node', '-e', '0']],
];

test('every governed-runner command with an owner key and an attacker URL sends no request to the attacker', async () => {
  for (const attackerUrl of ['https://attacker.example', 'https://api.getmarrow.ai.attacker.example']) {
    for (const [label, args] of COMMANDS) {
      const fx = fixture('e2e');
      const key = dummyKey('owner');
      ownerFile(fx, key);
      const { env, capture } = childEnv(fx, key, { MARROW_BASE_URL: attackerUrl });
      const result = await run(args, { env, cwd: fx.project });
      for (const record of captured(capture)) {
        if (record.kind === 'fetch') assert.ok(record.url.startsWith(`${DEFAULT_URL}/`) || record.url === DEFAULT_URL, `${label}: request went to ${new URL(record.url).origin}`);
      }
      assert.equal(`${result.stdout}\n${result.stderr}`.includes(key), false, `${label}: the key never appears in output`);
    }
  }
});

test('the controls: gate and status do reach the network layer with the owner key (the check above is not vacuous)', async () => {
  for (const [label, args] of COMMANDS.filter(([name]) => name !== 'run (governed runner)')) {
    const fx = fixture('control');
    const key = dummyKey('owner');
    ownerFile(fx, key);
    const { env, capture } = childEnv(fx, key, { MARROW_BASE_URL: 'https://attacker.example' });
    const result = await run(args, { env, cwd: fx.project });
    const fetches = captured(capture).filter((record) => record.kind === 'fetch');
    assert.ok(fetches.length > 0, `${label}: made no request`);
    assert.ok(fetches.every((record) => new URL(record.url).origin === DEFAULT_URL), `${label}: all to the default endpoint`);
    assert.ok(fetches.some((record) => record.carries_key), `${label}: the owner key went to the default endpoint`);
    const notices = result.stderr.split('\n').filter((line) => line.includes('ignored MARROW_BASE_URL'));
    assert.equal(notices.length, 1, `${label}: exactly one notice`);
    assert.equal(/attacker/.test(result.stderr), false);
  }
});

test('an owner-allowlisted origin receives the runner key, and nothing else does', async () => {
  const fx = fixture('allowed');
  const key = dummyKey('owner');
  ownerFile(fx, key, ['MARROW_ALLOWED_BASE_URLS=https://staging.example']);
  const { env, capture } = childEnv(fx, key, { MARROW_BASE_URL: 'https://staging.example' });
  const result = await run(['status'], { env, cwd: fx.project });
  const fetches = captured(capture).filter((record) => record.kind === 'fetch');
  assert.ok(fetches.length > 0);
  assert.ok(fetches.every((record) => new URL(record.url).origin === 'https://staging.example'));
  assert.ok(fetches.some((record) => record.carries_key));
  assert.equal(result.stderr.includes('ignored MARROW_BASE_URL'), false);
});

// ---- the installer: install, activate, update and doctor all go through runCli -> enforceKeyEndpoint ----

async function selfTestRequests(fx, key, env, extraArgs = []) {
  const requests = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), auth: String((init.headers && init.headers.authorization) || '') });
    throw new TypeError('fetch failed');
  };
  try {
    const options = installer.parseArgs(['--cwd', fx.project, ...extraArgs, 'doctor', '--self-test', '--json'], { HOME: fx.home, PATH: process.env.PATH, ...env });
    options.apiKey = String(options.apiKey || '').trim();
    const stored = readOwnerKeyDetail(options.home);
    const fromOwner = !options.apiKey && Boolean(stored.apiKey);
    if (fromOwner) options.apiKey = stored.apiKey;
    installer.enforceKeyEndpoint(options, fromOwner ? stored : null);
    await installer.runSelfTest(options).catch(() => undefined);
  } finally {
    globalThis.fetch = saved;
  }
  return requests;
}

test('installer self-test: owner key + attacker env URL posts only to the default endpoint', async () => {
  const fx = fixture('inst-self');
  const key = dummyKey('owner');
  ownerFile(fx, key);
  const requests = await selfTestRequests(fx, key, { MARROW_BASE_URL: 'https://attacker.example' });
  assert.ok(requests.length > 0, 'the self-test reached the network layer');
  assert.ok(requests.every((request) => request.url.startsWith(`${DEFAULT_URL}/`)), requests.map((r) => new URL(r.url).origin).join());
  assert.ok(requests.some((request) => request.auth === `Bearer ${key}`));
});

test('installer self-test: --base-url cannot move an owner key either', async () => {
  const fx = fixture('inst-flag');
  const key = dummyKey('owner');
  ownerFile(fx, key);
  const requests = await selfTestRequests(fx, key, {}, ['--base-url', 'https://attacker.example']);
  assert.ok(requests.length > 0);
  assert.ok(requests.every((request) => request.url.startsWith(`${DEFAULT_URL}/`)));
});

test('installer self-test: owner key + owner-allowlisted URL posts to that origin; env key + env URL keeps the env URL', async () => {
  const fx = fixture('inst-allow');
  const key = dummyKey('owner');
  ownerFile(fx, key, ['MARROW_ALLOWED_BASE_URLS=https://staging.example']);
  let requests = await selfTestRequests(fx, key, { MARROW_BASE_URL: 'https://staging.example' });
  assert.ok(requests.length > 0 && requests.every((request) => request.url.startsWith('https://staging.example/')));
  const envKey = dummyKey('env');
  requests = await selfTestRequests(fx, envKey, { MARROW_API_KEY: envKey, MARROW_BASE_URL: 'https://fleet.example' });
  assert.ok(requests.length > 0 && requests.every((request) => request.url.startsWith('https://fleet.example/')));
  assert.ok(requests.some((request) => request.auth === `Bearer ${envKey}`));
});

test('installer self-test: a non-https options.baseUrl is refused at the sink before any request, whoever built the options', async () => {
  const fx = fixture('inst-sink');
  const requests = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url) => { requests.push(String(url)); throw new TypeError('fetch failed'); };
  try {
    for (const url of UNSAFE) {
      const options = installer.parseArgs(['--cwd', fx.project, '--key', dummyKey('arg'), 'doctor', '--self-test', '--json'], { HOME: fx.home, PATH: process.env.PATH });
      options.baseUrl = url;
      await assert.rejects(() => installer.runSelfTest(options), (error) => {
        assert.match(error.message, /must be an https URL/);
        assert.equal(/hunter2|attacker|nip\.io|not a url|stag ing|etc\/passwd/.test(error.message), false);
        return true;
      }, url);
    }
  } finally {
    globalThis.fetch = saved;
  }
  assert.deepEqual(requests, []);
});

test('installer CLI wiring: runCli reports one source-only notice for an owner key + attacker env URL, and refuses non-https before anything runs', async () => {
  const fx = fixture('inst-cli');
  const key = dummyKey('owner');
  ownerFile(fx, key);
  const { env } = childEnv(fx, key, { MARROW_BASE_URL: 'https://attacker.example' });
  const result = await run(['--cwd', fx.project, '--dry-run', '--json'], { env, cwd: fx.project });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr.split('\n').filter((line) => line.includes('ignored MARROW_BASE_URL')).length, 1);
  assert.equal(`${result.stdout}\n${result.stderr}`.includes(key) || /attacker/.test(result.stderr), false);

  const refused = childEnv(fx, key, { MARROW_API_KEY: key, MARROW_BASE_URL: 'http://attacker.example' });
  const second = await run(['--cwd', fx.project, '--dry-run', '--json'], { env: refused.env, cwd: fx.project });
  assert.notEqual(second.status, 0);
  assert.match(second.stderr, /MARROW_BASE_URL must be an https URL/);
  assert.equal(/attacker/.test(second.stderr) || second.stderr.includes(key), false);
  assert.deepEqual(captured(refused.capture), []);
});

test('a non-https URL exits non-zero before any network call; the listener sees no connection and no output holds the key', async () => {
  const wrong = await listener();
  try {
    const commands = [['--dry-run', '--json'], ['gate', '--type', 'deploy', '--action', 'deploy to production', '--no-interactive'], ['status'], ['run', '--no-interactive', '--', 'node', '-e', '0']];
    for (const template of commands) {
      const fx = fixture('refuse');
      const key = dummyKey('key');
      // 0.0.0.0 reaches the 127.0.0.1 listener if anything connects; it is not a named loopback host.
      const url = `http://0.0.0.0:${wrong.port}`;
      const { env } = childEnv(fx, key, { MARROW_API_KEY: key, MARROW_BASE_URL: url }, { record: false });
      const args = template[0] === '--dry-run' ? ['--cwd', fx.project, ...template] : template;
      const result = await run(args, { env, cwd: fx.project });
      assert.notEqual(result.status, 0, `${template[0]}: exits non-zero`);
      assert.match(result.stderr, /MARROW_BASE_URL must be an https URL/);
      assert.equal(`${result.stdout}\n${result.stderr}`.includes(key), false);
      assert.equal(`${result.stdout}\n${result.stderr}`.includes(`0.0.0.0:${wrong.port}`), false, 'the URL is not echoed');
    }
    assert.equal(wrong.connections.length, 0, 'the listener saw no connection');
    await new Promise((resolveConnect, rejectConnect) => {
      const socket = net.connect(wrong.port, '0.0.0.0', () => { socket.destroy(); resolveConnect(); });
      socket.on('error', rejectConnect);
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    assert.equal(wrong.connections.length, 1, 'positive control: the listener is reachable at that address');
  } finally {
    wrong.server.close();
  }
});

// ---- R1-2: an empty, blank or missing --key value is no key ----
// The key that is then sent is the owner-file key, so the owner rule applies: an environment or
// --base-url URL never gets it. A real (non-blank) --key value keeps its URL, as before.

const runnerModule = require('../src/governed-runner');

const ATTACKER = 'https://attacker.example';
const ATTACKER_ORIGIN = new URL(ATTACKER).origin;
// Empty, ASCII and Unicode white space: String.prototype.trim removes every one of them.
const BLANK_VALUES = ['', ' ', '   ', '\t', '\n', '\r\n', ' ', ' ', '　', '﻿', '   '];
const NOTICE_FLAG = 'ignored the --base-url option: the key comes from ~/.marrow/env; list the URL in MARROW_ALLOWED_BASE_URLS in that file to allow it';
const NOTICE_ENV = 'ignored MARROW_BASE_URL from the process environment: the key comes from ~/.marrow/env; list the URL in MARROW_ALLOWED_BASE_URLS in that file to allow it';

function runnerParse(fx, env, argv) {
  return withProcessEnv(fx, env, () => parseArgs(argv));
}

// Every runner form where --key names no key: [label, process env, argv].
function runnerNoKeyForms() {
  const forms = [];
  for (const blank of BLANK_VALUES) {
    const label = JSON.stringify(blank);
    forms.push([`status --key ${label} (env URL)`, { MARROW_BASE_URL: ATTACKER }, ['status', '--key', blank]]);
    forms.push([`status --key ${label} --base-url X`, {}, ['status', '--key', blank, '--base-url', ATTACKER]]);
    forms.push([`status --base-url X --key ${label}`, {}, ['status', '--base-url', ATTACKER, '--key', blank]]);
  }
  forms.push(['status --base-url X --key (last)', {}, ['status', '--base-url', ATTACKER, '--key']]);
  forms.push(['status --key (last, env URL)', { MARROW_BASE_URL: ATTACKER }, ['status', '--key']]);
  forms.push(['status --key --base-url X', {}, ['status', '--key', '--base-url', ATTACKER]]);
  forms.push(['status --key --json --base-url X', {}, ['status', '--key', '--json', '--base-url', ATTACKER]]);
  forms.push(['status --key --base-url X (env URL too)', { MARROW_BASE_URL: 'https://other.example' }, ['status', '--key', '--base-url', ATTACKER]]);
  forms.push(['status -k "" --base-url X (no -k alias: parsing stops there; env URL)', { MARROW_BASE_URL: ATTACKER }, ['status', '-k', '', '--base-url', ATTACKER]]);
  forms.push(['gate --key --type deploy <action> (env URL)', { MARROW_BASE_URL: ATTACKER }, ['gate', '--key', '--type', 'deploy', 'deploy to production']]);
  forms.push(['run --key -- node -e 0 (env URL)', { MARROW_BASE_URL: ATTACKER }, ['run', '--key', '--', 'node', '-e', '0']]);
  forms.push(['run --key "" --base-url X -- node -e 0', {}, ['run', '--key', '', '--base-url', ATTACKER, '--', 'node', '-e', '0']]);
  forms.push(['permit --key --base-url X --action deploy', {}, ['permit', '--key', '--base-url', ATTACKER, '--action', 'deploy']]);
  forms.push(['proof --key --base-url X --decision-id d', {}, ['proof', '--key', '--base-url', ATTACKER, '--decision-id', 'dec_1']]);
  forms.push(['controller status --key --base-url X', {}, ['controller', 'status', '--key', '--base-url', ATTACKER]]);
  return forms;
}

test('R1-2 runner: --key with an empty, blank or missing value is no key; the owner key keeps the owner rule', () => {
  const fx = fixture('r12-runner');
  const key = dummyKey('owner');
  ownerFile(fx, key);
  for (const [label, env, argv] of runnerNoKeyForms()) {
    const parsed = runnerParse(fx, env, argv);
    assert.equal(parsed.options.apiKey === key, true, `${label}: the owner key is the key`);
    assert.equal(parsed.options.baseUrl, DEFAULT_URL, `${label}: the default endpoint`);
    assert.equal(Boolean(parsed.options.keyFromArg), false, `${label}: no key from the command line`);
  }
  // `--key` never takes the `--` separator: the child command is unchanged.
  assert.deepEqual(runnerParse(fx, {}, ['run', '--key', '--', 'node', '-e', '0']).childCommand, ['node', '-e', '0']);
  assert.equal(runnerParse(fx, {}, ['gate', '--key', '--type', 'deploy', 'deploy to production']).options.action, 'deploy to production');
});

test('R1-2 runner: a real --key value keeps its URL as before, whatever comes before or after it', () => {
  const fx = fixture('r12-runner-arg');
  const key = dummyKey('owner');
  const argKey = dummyKey('arg');
  ownerFile(fx, key);
  const forms = [
    ['status --key K --base-url X', {}, ['status', '--key', argKey, '--base-url', ATTACKER]],
    ['status --base-url X --key K', {}, ['status', '--base-url', ATTACKER, '--key', argKey]],
    ['status --key K (env URL)', { MARROW_BASE_URL: ATTACKER }, ['status', '--key', argKey]],
    ['status --key K --key "" --base-url X (a blank later --key drops nothing)', {}, ['status', '--key', argKey, '--key', '', '--base-url', ATTACKER]],
    ['status --key "" --key K --base-url X', {}, ['status', '--key', '', '--key', argKey, '--base-url', ATTACKER]],
    ['status --key K --base-url X --key (last)', {}, ['status', '--key', argKey, '--base-url', ATTACKER, '--key']],
    ['status --key " K " --base-url X (value kept as typed)', {}, ['status', '--key', ` ${argKey} `, '--base-url', ATTACKER]],
  ];
  for (const [label, env, argv] of forms) {
    const { options } = runnerParse(fx, env, argv);
    assert.equal(options.apiKey.trim() === argKey, true, `${label}: the --key value is the key`);
    assert.equal(options.keyFromArg, true, label);
    assert.equal(options.baseUrl, ATTACKER, `${label}: an explicit key keeps its URL (unchanged)`);
  }
  // A value no trim removes (zero-width space) or a word after --key is a key the caller typed, as
  // before; it is never the owner key, so the URL it goes to never gets the owner key.
  for (const value of ['​', 'deploy']) {
    const { options } = runnerParse(fx, {}, ['status', '--key', value, '--base-url', ATTACKER]);
    assert.equal(options.apiKey, value);
    assert.equal(options.apiKey === key, false);
  }
  // The control the others stand on: with no --key at all, the owner rule moves the URL.
  assert.equal(runnerParse(fx, {}, ['status', '--base-url', ATTACKER]).options.baseUrl, DEFAULT_URL);
});

test('R1-2 runner: the `=` forms are refused before any network call and never echo the value', () => {
  const fx = fixture('r12-runner-eq');
  const key = dummyKey('owner');
  const argKey = dummyKey('arg');
  ownerFile(fx, key);
  for (const argv of [['status', '--key='], ['status', '--key=--base-url', ATTACKER], ['status', `--key=${argKey}`, '--base-url', ATTACKER], ['status', '--key', '', `--base-url=${ATTACKER}`]]) {
    assert.throws(() => runnerParse(fx, {}, argv), (error) => {
      assert.match(error.message, /^Unknown option: --(key|base-url)$/);
      assert.equal(error.message.includes(argKey) || /attacker/.test(error.message), false);
      return true;
    }, argv.join(' '));
  }
});

test('R1-2 runner: whenever the owner key is the key, the URL is the default (invariant over every form)', () => {
  const fx = fixture('r12-runner-inv');
  const key = dummyKey('owner');
  const argKey = dummyKey('arg');
  ownerFile(fx, key);
  const values = ['', ' ', ' ', '--base-url', '--', '-k', argKey, undefined];
  let checked = 0;
  for (const first of values) {
    for (const second of values) {
      for (const env of [{}, { MARROW_BASE_URL: ATTACKER }]) {
        const argv = ['status', '--key', ...(first === undefined ? [] : [first]), '--base-url', ATTACKER, '--key', ...(second === undefined ? [] : [second])];
        let options;
        try {
          options = runnerParse(fx, env, argv).options;
        } catch {
          continue;
        }
        checked += 1;
        if (options.apiKey === key) assert.equal(options.baseUrl, DEFAULT_URL, argv.map((part) => JSON.stringify(part === argKey ? 'K' : part)).join(' '));
      }
    }
  }
  assert.ok(checked > 50, `checked ${checked} forms`);
});

test('R1-2 runner: session and hold keys: a blank --key changes nothing, a different key or endpoint changes the key', () => {
  const fx = fixture('r12-hold');
  const key = dummyKey('owner');
  const argKey = dummyKey('arg');
  ownerFile(fx, key);
  const salt = crypto.randomBytes(32);
  const material = { argv: ['node', '-e', '0'], action: 'deploy to production', target: '', type: 'deploy' };
  const env = { MARROW_BASE_URL: ATTACKER, MARROW_SESSION_ID: '' };
  const optionsFor = (argv) => runnerParse(fx, env, ['run', ...argv, '--', 'node', '-e', '0']).options;
  const hold = (options) => runnerModule.runnerHoldKey(options, material, salt);
  const session = (options) => runnerModule.defaultRunnerSession(options);
  const none = optionsFor([]);
  const blank = optionsFor(['--key', '']);
  const trailing = optionsFor(['--base-url', ATTACKER, '--key']);
  const explicit = optionsFor(['--key', argKey]);
  assert.equal(hold(blank), hold(none), 'a blank --key is the same as no --key');
  assert.equal(hold(trailing), hold(none));
  assert.equal(session(blank), session(none));
  assert.notEqual(hold(explicit), hold(none), 'another key, another endpoint: another hold key');
  assert.notEqual(session(explicit), session(none), 'another endpoint: another session');
  const sameUrlOtherKey = runnerParse(fx, {}, ['run', '--key', argKey, '--', 'node', '-e', '0']).options;
  assert.equal(sameUrlOtherKey.baseUrl, none.baseUrl);
  assert.notEqual(hold(sameUrlOtherKey), hold(none), 'same endpoint, different key: different hold key');
  for (const value of [hold(none), hold(explicit), session(none), session(explicit)]) {
    assert.equal(value.includes(key) || value.includes(argKey), false, 'no key in a hold key or session');
  }
});

test('R1-2 installer: --key with an empty, blank or missing value is no key and sets no command-line key', () => {
  const fx = fixture('r12-inst-parse');
  const envKey = dummyKey('env');
  const forms = [
    ...BLANK_VALUES.map((blank) => ['--key', blank]),
    ['--key'],
    ['--key', '--base-url', ATTACKER],
    ['--key', '', '--yes'],
    ['doctor', '--key', '', '--base-url', ATTACKER],
    ['--key', 'doctor'],
  ];
  for (const argv of forms) {
    const none = installer.parseArgs(argv, { HOME: fx.home, PATH: process.env.PATH });
    assert.equal(none.apiKey, '', argv.join(' '));
    assert.equal(Boolean(none.keyFromArg), false, argv.join(' '));
    const withEnv = installer.parseArgs(argv, { HOME: fx.home, PATH: process.env.PATH, MARROW_API_KEY: envKey });
    assert.equal(withEnv.apiKey === envKey, true, `${argv.join(' ')}: the environment key stays the key`);
    assert.equal(Boolean(withEnv.keyFromArg), false);
  }
  const argKey = dummyKey('arg');
  for (const argv of [['--key', argKey, '--base-url', ATTACKER], ['--key', argKey, '--key', '', '--base-url', ATTACKER], ['--key', '', '--key', argKey, '--base-url', ATTACKER]]) {
    const options = installer.parseArgs(argv, { HOME: fx.home, PATH: process.env.PATH });
    assert.equal(options.apiKey === argKey, true);
    assert.equal(options.keyFromArg, true);
    assert.equal(options.baseUrl, ATTACKER);
  }
  for (const argv of [['--key='], [`--key=${argKey}`], ['--key=--base-url', ATTACKER]]) {
    assert.throws(() => installer.parseArgs(argv, { HOME: fx.home }), (error) => {
      assert.match(error.message, /^Unknown argument: --key$/);
      assert.equal(error.message.includes(argKey) || /attacker/.test(error.message), false);
      return true;
    });
  }
});

test('R1-2 installer: enforceKeyEndpoint follows the key that is sent, not --key', () => {
  const fx = fixture('r12-inst-enforce');
  const key = dummyKey('owner');
  ownerFile(fx, key);
  const stored = readOwnerKeyDetail(fx.home);
  // Options as a caller that set keyFromArg would build them: the owner key still keeps the owner rule.
  const options = installer.enforceKeyEndpoint({ apiKey: key, keyFromArg: true, baseUrl: ATTACKER, baseUrlSource: 'the --base-url option' }, stored);
  assert.equal(options.baseUrl, DEFAULT_URL);
  // A key that is not the owner-file key (no ownerKey given) keeps its URL, as before.
  assert.equal(installer.enforceKeyEndpoint({ apiKey: dummyKey('arg'), keyFromArg: true, baseUrl: ATTACKER, baseUrlSource: 'the --base-url option' }, null).baseUrl, ATTACKER);
});

for (const [label, env, extraArgs] of [
  ['--key "" + env URL', { MARROW_BASE_URL: ATTACKER }, ['--key', '']],
  ['--key --base-url X', {}, ['--key', '--base-url', ATTACKER]],
  ['--key "   " --base-url X', {}, ['--key', '   ', '--base-url', ATTACKER]],
  ['--key "\\u3000" --base-url X', {}, ['--key', '　', '--base-url', ATTACKER]],
  ['--base-url X --key', {}, ['--base-url', ATTACKER, '--key']],
  ['--key (before doctor) + env URL', { MARROW_BASE_URL: ATTACKER }, ['--key']],
]) {
  test(`R1-2 installer self-test: ${label}: the owner key posts only to the default endpoint`, async () => {
    const fx = fixture('r12-inst-self');
    const key = dummyKey('owner');
    ownerFile(fx, key);
    const requests = await selfTestRequests(fx, key, env, extraArgs);
    assert.ok(requests.length > 0, 'the self-test reached the network layer');
    assert.ok(requests.every((request) => request.url.startsWith(`${DEFAULT_URL}/`)), requests.map((r) => new URL(r.url).origin).join());
    assert.ok(requests.some((request) => request.auth === `Bearer ${key}`));
  });
}

// ---- R1-2 end to end: the real CLI, a recorder for every fetch and connect, this run's net guard ----

function guardedChildEnv(fx, key, extra = {}, { record = true, stubNpm = false } = {}) {
  const capture = path.join(fx.root, `capture-${crypto.randomBytes(4).toString('hex')}.jsonl`);
  fs.writeFileSync(capture, '');
  const nodeOptions = [process.env.NODE_OPTIONS, record ? `--require=${RECORDER}` : ''].filter(Boolean).join(' ');
  return {
    capture,
    env: {
      PATH: process.env.PATH,
      HOME: fx.home,
      TMPDIR: process.env.TMPDIR,
      CAPTURE_FILE: capture,
      M2_EXPECT_KEY: key,
      ...(process.env.GUARD_LOG ? { GUARD_LOG: process.env.GUARD_LOG } : {}),
      ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
      ...(stubNpm ? { M2_STUB_NPM: '1' } : {}),
      ...extra,
    },
  };
}

function noticeLines(stderr) {
  return stderr.split('\n').filter((line) => line.startsWith('[marrow] ignored '));
}

// No request or connect to the attacker; every request that carries the owner key goes to the
// default endpoint; and (unless the run stops first) at least one does, so the check is not vacuous.
function assertOwnerKeyStaysHome(label, records, { keyed = true } = {}) {
  const fetches = records.filter((record) => record.kind === 'fetch');
  assert.equal(fetches.some((record) => /attacker/.test(new URL(record.url).hostname)), false, `${label}: a request went to the attacker`);
  assert.equal(records.some((record) => record.kind === 'connect' && /attacker/.test(record.target)), false, `${label}: a connect to the attacker`);
  assert.ok(fetches.filter((record) => record.carries_key).every((record) => new URL(record.url).origin === DEFAULT_URL), `${label}: the owner key went elsewhere`);
  if (keyed) assert.ok(fetches.some((record) => record.carries_key), `${label}: the owner key reached the default endpoint`);
}

function walkFiles(root, out = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const RUNNER_NO_KEY_CLI = [
  ['runner status --key "" (env URL)', { MARROW_BASE_URL: ATTACKER }, ['status', '--key', ''], NOTICE_ENV],
  ['runner status --base-url X --key', {}, ['status', '--base-url', ATTACKER, '--key'], NOTICE_FLAG],
  ['runner status --key --base-url X', {}, ['status', '--key', '--base-url', ATTACKER], NOTICE_FLAG],
  ['runner status --key "   " --base-url X', {}, ['status', '--key', '   ', '--base-url', ATTACKER], NOTICE_FLAG],
  ['runner gate --key "" --base-url X', {}, ['gate', '--key', '', '--base-url', ATTACKER, '--type', 'deploy', '--action', 'deploy to production', '--no-interactive'], NOTICE_FLAG],
];

test('R1-2 CLI: runner forms with no --key value send the owner key only to the default, with one source-only notice', async () => {
  for (const [label, extra, args, notice] of RUNNER_NO_KEY_CLI) {
    const fx = fixture('r12-cli-runner');
    const key = dummyKey('owner');
    ownerFile(fx, key);
    const { env, capture } = guardedChildEnv(fx, key, extra);
    const result = await run(args, { env, cwd: fx.project });
    assertOwnerKeyStaysHome(label, captured(capture));
    assert.deepEqual(noticeLines(result.stderr), [`[marrow] ${notice}`], `${label}: one notice`);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(output.includes(key) || /attacker/.test(output), false, `${label}: no key and no URL in the output`);
  }
});

test('R1-2 CLI: the controls: a real --key value goes to its URL; env key + env URL is unchanged', async () => {
  const fx = fixture('r12-cli-control');
  ownerFile(fx, dummyKey('owner'));
  const argKey = dummyKey('arg');
  let child = guardedChildEnv(fx, argKey);
  let result = await run(['status', '--key', argKey, '--base-url', ATTACKER], { env: child.env, cwd: fx.project });
  let fetches = captured(child.capture).filter((record) => record.kind === 'fetch');
  assert.ok(fetches.some((record) => new URL(record.url).origin === ATTACKER_ORIGIN && record.carries_key), 'the explicit key went to its URL: the recorder sees the attacker origin');
  assert.deepEqual(noticeLines(result.stderr), []);
  const installerChild = guardedChildEnv(fx, argKey, {}, { stubNpm: true });
  result = await run(['doctor', '--cwd', fx.project, '--key', argKey, '--base-url', ATTACKER, '--json'], { env: installerChild.env, cwd: fx.project });
  fetches = captured(installerChild.capture).filter((record) => record.kind === 'fetch');
  assert.ok(fetches.some((record) => new URL(record.url).origin === ATTACKER_ORIGIN && record.carries_key), 'installer: the explicit key went to its URL');
  assert.deepEqual(noticeLines(result.stderr), []);
  const envKey = dummyKey('env');
  child = guardedChildEnv(fx, envKey, { MARROW_API_KEY: envKey, MARROW_BASE_URL: ATTACKER });
  result = await run(['status'], { env: child.env, cwd: fx.project });
  fetches = captured(child.capture).filter((record) => record.kind === 'fetch');
  assert.ok(fetches.some((record) => new URL(record.url).origin === ATTACKER_ORIGIN && record.carries_key), 'env key + env URL: unchanged');
  assert.deepEqual(noticeLines(result.stderr), []);
});

const INSTALLER_NO_KEY_CLI = [
  ['installer --key --base-url X (install and activate)', {}, ['--key', '--base-url', ATTACKER, '--no-controller'], NOTICE_FLAG, true],
  ['installer --key "" --yes (env URL)', { MARROW_BASE_URL: ATTACKER }, ['--key', '', '--yes', '--no-controller'], NOTICE_ENV, true],
  ['installer doctor --key "" --base-url X', {}, ['doctor', '--key', '', '--base-url', ATTACKER, '--json'], NOTICE_FLAG, false],
  ['installer doctor --key "   " --base-url X', {}, ['doctor', '--key', '   ', '--base-url', ATTACKER, '--json'], NOTICE_FLAG, false],
];

test('R1-2 CLI: installer forms with no --key value send the owner key only to the default and write no attacker URL', async () => {
  for (const [label, extra, args, notice, writeRun] of INSTALLER_NO_KEY_CLI) {
    const fx = fixture('r12-cli-inst');
    const key = dummyKey('owner');
    ownerFile(fx, key);
    const { env, capture } = guardedChildEnv(fx, key, extra, { stubNpm: true });
    const result = await run(['--cwd', fx.project, ...args], { env, cwd: fx.project });
    assertOwnerKeyStaysHome(label, captured(capture));
    assert.deepEqual(noticeLines(result.stderr), [`[marrow] ${notice}`], `${label}: one notice`);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(output.includes(key) || /attacker/.test(output), false, `${label}: no key and no URL in the output`);
    if (writeRun) {
      // Consumers: the configs and hooks this run wrote never name the attacker URL.
      const written = [...walkFiles(fx.home), ...walkFiles(fx.project)].filter((file) => !file.startsWith(path.join(fx.home, '.marrow', 'env')));
      assert.ok(written.length > 2, `${label}: the run wrote its files`);
      for (const file of written) assert.equal(/attacker/.test(fs.readFileSync(file, 'utf8')), false, `${label}: ${path.relative(fx.root, file)} names the attacker`);
    }
  }
});

test('R1-2 CLI: installer --key= is refused before any network call', async () => {
  const fx = fixture('r12-cli-eq');
  const key = dummyKey('owner');
  ownerFile(fx, key);
  const { env, capture } = guardedChildEnv(fx, key, {}, { stubNpm: true });
  const result = await run(['doctor', '--cwd', fx.project, '--key=', '--base-url', ATTACKER], { env, cwd: fx.project });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown argument: --key/);
  assert.deepEqual(captured(capture).filter((record) => record.kind === 'fetch' || record.kind === 'connect'), []);
});

// ---- R1-11: with no URL from the environment or an option, the owner file's own URL is used ----
// The file that supplied the key may name its endpoint (MCP and the SDK already use it). Only a URL a
// key may be sent to is used; anything else is ignored with a source-only notice (the default is used,
// as before). Nothing else changes: an environment or option URL, another key, a loose or symlinked
// file and project files keep their answers.

const http = require('node:http');

const STAGING = 'https://staging.example';
const NOTICE_FILE_URL = 'ignored MARROW_BASE_URL in ~/.marrow/env: it must be an https URL (http is allowed only for localhost, 127.0.0.1 and [::1]) with no user name, password, query or fragment';

test('R1-11 policy: no candidate: the owner file\'s own valid URL; an invalid one is ignored with a source-only notice', () => {
  const kept = [
    ['https://staging.example', 'https://staging.example'],
    ['https://staging.example/', 'https://staging.example'],
    ['https://staging.example/gateway/', 'https://staging.example/gateway'],
    ['HTTPS://STAGING.EXAMPLE:8443/v2', 'https://staging.example:8443/v2'],
    ['http://localhost:8787', 'http://localhost:8787'],
    ['http://127.0.0.1:9', 'http://127.0.0.1:9'],
    ['http://[::1]:8787/', 'http://[::1]:8787'],
    [' https://staging.example ', 'https://staging.example'],
  ];
  for (const candidate of ['', null, undefined, '   ']) {
    for (const [value, expected] of kept) {
      const decision = policy.ownerKeyBaseUrl({ candidate, ownerValues: { MARROW_BASE_URL: value } });
      assert.deepEqual(decision, { baseUrl: expected }, `${value} (candidate ${JSON.stringify(candidate)})`);
    }
    assert.deepEqual(policy.ownerKeyBaseUrl({ candidate, ownerValues: {} }), { baseUrl: DEFAULT_URL });
    assert.deepEqual(policy.ownerKeyBaseUrl({ candidate, ownerValues: { MARROW_BASE_URL: '' } }), { baseUrl: DEFAULT_URL });
  }
  for (const value of UNSAFE) {
    const decision = policy.ownerKeyBaseUrl({ candidate: '', ownerValues: { MARROW_BASE_URL: value } });
    assert.equal(decision.baseUrl, DEFAULT_URL, value);
    assert.equal(decision.notice, NOTICE_FILE_URL, value);
    assert.equal(/hunter2|attacker|nip\.io|not a url|stag ing|etc\/passwd|0\.0\.0\.0/.test(decision.notice), false);
  }
  assert.match(policy.ownerKeyBaseUrl({ candidate: '', ownerValues: { MARROW_BASE_URL: 'http://attacker.example' }, fileName: 'env.local' }).notice, /in ~\/\.marrow\/env\.local:/);
  // A candidate keeps today's answers: the file's URL never replaces it, another origin is refused.
  const ownerValues = { MARROW_BASE_URL: STAGING };
  assert.equal(policy.ownerKeyBaseUrl({ candidate: ATTACKER, ownerValues }).baseUrl, DEFAULT_URL);
  assert.ok(policy.ownerKeyBaseUrl({ candidate: ATTACKER, ownerValues }).notice);
  assert.deepEqual(policy.ownerKeyBaseUrl({ candidate: DEFAULT_URL, ownerValues }), { baseUrl: DEFAULT_URL });
  assert.deepEqual(policy.ownerKeyBaseUrl({ candidate: `${STAGING}/gateway`, ownerValues }), { baseUrl: `${STAGING}/gateway` });
});

test('R1-11 runner: the owner file\'s own URL is used with no environment or option URL; every other answer is unchanged', { skip: process.platform === 'win32' }, () => {
  const fx = fixture('r111-runner');
  const key = dummyKey('owner');
  ownerFile(fx, key, [`MARROW_BASE_URL=${STAGING}/gateway/`]);
  let options = runnerOptions(fx, {});
  assert.equal(options.apiKey === key, true);
  assert.equal(options.baseUrl, `${STAGING}/gateway`, 'the file names its endpoint');
  assert.equal(runnerOptions(fx, { MARROW_BASE_URL: '' }).baseUrl, `${STAGING}/gateway`, 'an empty environment URL is no URL');
  assert.equal(runnerParse(fx, {}, ['status', '--key', '']).options.baseUrl, `${STAGING}/gateway`, 'a blank --key is no key: still the owner key and its file URL');
  assert.equal(runnerOptions(fx, { MARROW_BASE_URL: ATTACKER }).baseUrl, DEFAULT_URL, 'an environment URL of another origin: default, as before');
  assert.equal(runnerOptions(fx, {}, ['--base-url', ATTACKER]).baseUrl, DEFAULT_URL, '--base-url of another origin: default, as before');
  assert.equal(runnerOptions(fx, { MARROW_BASE_URL: DEFAULT_URL }).baseUrl, DEFAULT_URL, 'an environment URL naming the default keeps the default');
  // The file's URL is for the file's key only.
  const argKey = dummyKey('arg');
  options = runnerOptions(fx, {}, ['--key', argKey]);
  assert.equal(options.apiKey === argKey, true);
  assert.equal(options.baseUrl, DEFAULT_URL, 'an explicit key with no URL: default, as before');
  const envKey = dummyKey('env');
  options = runnerOptions(fx, { MARROW_API_KEY: envKey });
  assert.equal(options.apiKey === envKey, true);
  assert.equal(options.baseUrl, DEFAULT_URL, 'an environment key with no URL: default, as before');
  // A file URL a key may not be sent to is ignored: the default, as before.
  for (const value of ['http://attacker.example', 'http://0.0.0.0:8787', 'https://user:hunter2@staging.example', 'https://staging.example?x=1', 'not a url']) {
    ownerFile(fx, key, [`MARROW_BASE_URL=${value}`]);
    assert.equal(runnerOptions(fx, {}).baseUrl, DEFAULT_URL, value);
  }
});

test('R1-11 runner: the URL comes only from the file that supplied the key; loose and symlinked files supply neither', { skip: process.platform === 'win32' }, () => {
  const fx = fixture('r111-sources');
  const localKey = dummyKey('local');
  write(fx.localFile, [`MARROW_API_KEY=${localKey}`]);
  write(fx.envFile, [`MARROW_API_KEY=${dummyKey('env')}`, `MARROW_BASE_URL=${STAGING}`]);
  let options = runnerOptions(fx, {});
  assert.equal(options.apiKey === localKey, true);
  assert.equal(options.baseUrl, DEFAULT_URL, 'env.local supplied the key and names no URL; env\'s URL is not used');
  write(fx.localFile, [`MARROW_API_KEY=${localKey}`, 'MARROW_BASE_URL=https://local.example']);
  assert.equal(runnerOptions(fx, {}).baseUrl, 'https://local.example');
  fs.rmSync(fx.localFile);
  fs.rmSync(fx.envFile);
  write(fx.envFile, [`MARROW_API_KEY=${localKey}`, `MARROW_BASE_URL=${STAGING}`], 0o644);
  options = runnerOptions(fx, {});
  assert.equal(options.apiKey, '', 'a loose file supplies no key');
  assert.equal(options.baseUrl, DEFAULT_URL, 'and no URL, as before');
  fs.rmSync(fx.envFile);
  const real = path.join(fx.root, 'real-env');
  write(real, [`MARROW_API_KEY=${localKey}`, `MARROW_BASE_URL=${STAGING}`]);
  fs.symlinkSync(real, fx.envFile);
  options = runnerOptions(fx, {});
  assert.equal(options.apiKey, '');
  assert.equal(options.baseUrl, DEFAULT_URL, 'a symlinked file: no key, no URL, as before');
});

test('R1-11 runner: session and hold keys follow the endpoint; no key in either', { skip: process.platform === 'win32' }, () => {
  const fx = fixture('r111-hold');
  const key = dummyKey('owner');
  const salt = crypto.randomBytes(32);
  const material = { argv: ['node', '-e', '0'], action: 'deploy to production', target: '', type: 'deploy' };
  const optionsNow = () => withProcessEnv(fx, { MARROW_SESSION_ID: '' }, () => parseArgs(['run', '--', 'node', '-e', '0']).options);
  ownerFile(fx, key);
  const plain = optionsNow();
  ownerFile(fx, key, [`MARROW_BASE_URL=${STAGING}`]);
  const staged = optionsNow();
  const stagedAgain = optionsNow();
  assert.equal(plain.baseUrl, DEFAULT_URL);
  assert.equal(staged.baseUrl, STAGING);
  assert.notEqual(runnerModule.runnerHoldKey(plain, material, salt), runnerModule.runnerHoldKey(staged, material, salt), 'another endpoint: another hold key');
  assert.notEqual(runnerModule.defaultRunnerSession(plain), runnerModule.defaultRunnerSession(staged));
  assert.equal(runnerModule.runnerHoldKey(staged, material, salt), runnerModule.runnerHoldKey(stagedAgain, material, salt), 'same inputs: same hold key');
  for (const value of [runnerModule.runnerHoldKey(staged, material, salt), runnerModule.defaultRunnerSession(staged)]) {
    assert.equal(value.includes(key), false);
  }
});

test('R1-11 installer self-test: the owner file\'s own URL with no environment or option URL; every other answer is unchanged', async () => {
  const fx = fixture('r111-inst');
  const key = dummyKey('owner');
  ownerFile(fx, key, [`MARROW_BASE_URL=${STAGING}/`]);
  let requests = await selfTestRequests(fx, key, {});
  assert.ok(requests.length > 0 && requests.every((request) => request.url.startsWith(`${STAGING}/v1/`)), requests.map((r) => new URL(r.url).origin).join());
  assert.ok(requests.some((request) => request.auth === `Bearer ${key}`));
  requests = await selfTestRequests(fx, key, { MARROW_BASE_URL: ATTACKER });
  assert.ok(requests.length > 0 && requests.every((request) => request.url.startsWith(`${DEFAULT_URL}/`)), 'an environment URL of another origin: default, as before');
  requests = await selfTestRequests(fx, key, {}, ['--base-url', ATTACKER]);
  assert.ok(requests.length > 0 && requests.every((request) => request.url.startsWith(`${DEFAULT_URL}/`)), '--base-url of another origin: default, as before');
  const argKey = dummyKey('arg');
  requests = await selfTestRequests(fx, argKey, {}, ['--key', argKey]);
  assert.ok(requests.length > 0 && requests.every((request) => request.url.startsWith(`${DEFAULT_URL}/`)), 'an explicit key with no URL: default, as before');
  const envKey = dummyKey('env');
  requests = await selfTestRequests(fx, envKey, { MARROW_API_KEY: envKey });
  assert.ok(requests.length > 0 && requests.every((request) => request.url.startsWith(`${DEFAULT_URL}/`)), 'an environment key with no URL: default, as before');
  ownerFile(fx, key, ['MARROW_BASE_URL=http://attacker.example']);
  requests = await selfTestRequests(fx, key, {});
  assert.ok(requests.length > 0 && requests.every((request) => request.url.startsWith(`${DEFAULT_URL}/`)), 'a non-loopback http file URL is never used');
});

async function recordedRun(fx, key, args, extra = {}, { stubNpm = false } = {}) {
  const { env, capture } = guardedChildEnv(fx, key, extra, { stubNpm });
  const result = await run(args, { env, cwd: fx.project });
  const records = captured(capture);
  return { result, records, fetches: records.filter((record) => record.kind === 'fetch') };
}

test('R1-11 CLI: status, gate, doctor and install use the owner file\'s own URL with an empty environment', async () => {
  const forms = [
    ['runner status', ['status'], false],
    ['runner gate', ['gate', '--type', 'deploy', '--action', 'deploy to production', '--no-interactive'], false],
    ['installer doctor --self-test', ['doctor', '--self-test', '--json'], true],
    ['installer --yes (install)', ['--yes', '--no-controller'], true],
  ];
  for (const [label, args, isInstaller] of forms) {
    const fx = fixture('r111-cli');
    const key = dummyKey('owner');
    ownerFile(fx, key, [`MARROW_BASE_URL=${STAGING}`]);
    const { result, fetches } = await recordedRun(fx, key, isInstaller ? ['--cwd', fx.project, ...args] : args, {}, { stubNpm: isInstaller });
    const keyed = fetches.filter((record) => record.carries_key);
    assert.ok(keyed.length > 0, `${label}: the owner key was sent`);
    assert.ok(keyed.every((record) => new URL(record.url).origin === STAGING), `${label}: only to the file's URL`);
    assert.deepEqual(noticeLines(result.stderr), [], `${label}: no notice`);
    assert.equal(`${result.stdout}\n${result.stderr}`.includes(key), false);
    if (label.startsWith('installer --yes')) {
      // Configs outside ~/.marrow (harness and MCP settings, the project's files) name the file's URL.
      const written = [...walkFiles(fx.home), ...walkFiles(fx.project)].filter((file) => !file.startsWith(`${path.join(fx.home, '.marrow')}${path.sep}`));
      assert.ok(written.some((file) => fs.readFileSync(file, 'utf8').includes(STAGING)), 'the install targets the file\'s URL');
      assert.equal(written.some((file) => fs.readFileSync(file, 'utf8').includes(DEFAULT_URL)), false, 'and not the default');
    }
  }
});

test('R1-11 CLI: an env-only URL, a loose file, a project file and a non-loopback http file URL keep today\'s answers', { skip: process.platform === 'win32' }, async () => {
  // Owner key + environment-only URL: default plus one notice (unchanged).
  let fx = fixture('r111-cli-env');
  let key = dummyKey('owner');
  ownerFile(fx, key);
  let out = await recordedRun(fx, key, ['status'], { MARROW_BASE_URL: STAGING });
  assert.ok(out.fetches.some((record) => record.carries_key));
  assert.ok(out.fetches.every((record) => new URL(record.url).origin === DEFAULT_URL));
  assert.deepEqual(noticeLines(out.result.stderr), [`[marrow] ${NOTICE_ENV}`]);

  // A project .env and .marrow/env naming a URL (and a key): never read; the owner key goes to the default.
  fx = fixture('r111-cli-project');
  key = dummyKey('owner');
  ownerFile(fx, key);
  fs.writeFileSync(path.join(fx.project, '.env'), `MARROW_API_KEY=${dummyKey('project')}\nMARROW_BASE_URL=${ATTACKER}\n`);
  fs.mkdirSync(path.join(fx.project, '.marrow'));
  fs.writeFileSync(path.join(fx.project, '.marrow', 'env'), `MARROW_BASE_URL=${ATTACKER}\n`, { mode: 0o600 });
  for (const [args, stubNpm] of [[['status'], false], [['--cwd', fx.project, 'doctor', '--self-test', '--json'], true]]) {
    out = await recordedRun(fx, key, args, {}, { stubNpm });
    assertOwnerKeyStaysHome(`project files: ${args[0]}`, out.records);
    assert.deepEqual(noticeLines(out.result.stderr), []);
  }

  // A loose owner file with a key and a URL: no key, so nothing keyed; its URL is not used.
  fx = fixture('r111-cli-loose');
  key = dummyKey('loose');
  write(fx.envFile, [`MARROW_API_KEY=${key}`, `MARROW_BASE_URL=${ATTACKER}`], 0o644);
  out = await recordedRun(fx, key, ['status']);
  assert.equal(out.fetches.some((record) => record.carries_key || /attacker/.test(new URL(record.url).hostname)), false);

  // Non-loopback http in the owner file: refused before any connect; the default gets the key, one notice, no URL text.
  for (const value of ['http://attacker.example', 'http://attacker.example:8080/v1']) {
    for (const [label, args, stubNpm] of [['status', ['status'], false], ['doctor', null, true]]) {
      fx = fixture('r111-cli-http');
      key = dummyKey('owner');
      ownerFile(fx, key, [`MARROW_BASE_URL=${value}`]);
      out = await recordedRun(fx, key, args || ['--cwd', fx.project, 'doctor', '--self-test', '--json'], {}, { stubNpm });
      assertOwnerKeyStaysHome(`${label} with ${value}`, out.records);
      assert.deepEqual(noticeLines(out.result.stderr), [`[marrow] ${NOTICE_FILE_URL}`], label);
      assert.equal(/attacker/.test(`${out.result.stdout}\n${out.result.stderr}`) || `${out.result.stdout}\n${out.result.stderr}`.includes(key), false);
    }
  }
});

test('R1-11 live: an allowlisted loopback URL in the owner file gets the runner\'s requests, with the key', async () => {
  const seen = [];
  let key = '';
  const server = http.createServer((request, response) => {
    seen.push({ path: request.url.split('?')[0], keyed: request.headers.authorization === `Bearer ${key}` });
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end('{"error":"unauthorized"}');
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    for (const args of [['status'], ['gate', '--type', 'deploy', '--action', 'deploy to production', '--no-interactive']]) {
      const fx = fixture('r111-live');
      key = dummyKey('owner');
      ownerFile(fx, key, [`MARROW_BASE_URL=${url}`]);
      const before = seen.length;
      const { env } = guardedChildEnv(fx, key, {}, { record: false });
      const result = await run(args, { env, cwd: fx.project });
      const mine = seen.slice(before);
      assert.ok(mine.length > 0, `${args[0]}: the owner file's loopback URL got the requests`);
      assert.ok(mine.some((entry) => entry.keyed), `${args[0]}: with the owner key`);
      assert.deepEqual(noticeLines(result.stderr), []);
      assert.equal(`${result.stdout}\n${result.stderr}`.includes(key), false);
    }
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
});

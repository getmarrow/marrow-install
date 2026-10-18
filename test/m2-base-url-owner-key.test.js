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
  assert.equal(runnerOptions(fx, {}).baseUrl, DEFAULT_URL, 'no environment URL: unchanged from master (the default)');
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

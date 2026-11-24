// C1b: `marrow-install verify` (SPEC-C1b-installer.md rows CLI-1 to CLI-11), run as child processes of the installer bin
// with a fake HOME under a private temp folder. A runtime preload records fs opens, reads, the module cache and every
// network attempt (each refused). Vectors come from test/c1b-verify-port.test.js (throwaway keys made in memory).
require('./support/isolated-environment');

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { buildVectors, answerArg } = require('./c1b-verify-port.test.js');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'bin', 'marrow-install.js');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'c1b-verify-cli-'));
const HOME = path.join(work, 'home');
fs.mkdirSync(HOME);
const built = buildVectors();
const ok1 = built.vectors.find((v) => v.id === 'X-OK1');
let counter = 0;

test.after(() => fs.rmSync(work, { recursive: true, force: true }));

function file(name, content) {
  const target = path.join(work, `${++counter}-${name}`);
  fs.writeFileSync(target, content);
  return target;
}

// The preload: records opens, bytes read, the module cache and network attempts (each refused), then writes them at exit.
function preload() {
  const trace = path.join(work, `${++counter}-trace.json`);
  const source = `'use strict';
const fs = require('fs'); const net = require('net'); const tls = require('tls'); const dns = require('dns'); const http = require('http'); const https = require('https'); const dgram = require('dgram');
const log = { open: [], readFile: [], read: 0, net: 0 };
const write = fs.writeFileSync;
const wrap = (obj, name, record) => { const original = obj[name]; if (typeof original !== 'function') return; obj[name] = function (...args) { record(args); return original.apply(this, args); }; };
wrap(fs, 'openSync', (a) => log.open.push(String(a[0])));
wrap(fs, 'open', (a) => log.open.push(String(a[0])));
wrap(fs.promises, 'open', (a) => log.open.push(String(a[0])));
wrap(fs, 'createReadStream', (a) => log.open.push(String(a[0])));
wrap(fs, 'readFileSync', (a) => log.readFile.push(String(a[0])));
const readSync = fs.readSync; fs.readSync = function (...args) { const n = readSync.apply(this, args); log.read += n; return n; };
const refuse = () => { log.net += 1; throw new Error('network refused in this test'); };
for (const [obj, names] of [[net, ['connect', 'createConnection']], [net.Socket.prototype, ['connect']], [tls, ['connect']], [dns, ['lookup', 'resolve', 'resolve4', 'resolve6']], [dns.promises, ['lookup', 'resolve']], [http, ['request', 'get']], [https, ['request', 'get']], [dgram, ['createSocket']]]) for (const name of names) if (typeof obj[name] === 'function') obj[name] = refuse;
globalThis.fetch = async () => refuse();
process.on('exit', () => write(${JSON.stringify(trace)}, JSON.stringify({ ...log, modules: Object.keys(require.cache) })));
`;
  return { path: file('preload.cjs', source), trace };
}

function run(args, { env = {}, bin = BIN, traced = true } = {}) {
  const pre = traced ? preload() : null;
  const result = spawnSync(process.execPath, [...(pre ? ['--require', pre.path] : []), bin, ...args], {
    encoding: 'utf8', cwd: work, env: { PATH: process.env.PATH, HOME, ...env }, timeout: 30000,
  });
  const trace = pre && fs.existsSync(pre.trace) ? JSON.parse(fs.readFileSync(pre.trace, 'utf8')) : null;
  return { code: result.status, stdout: result.stdout, stderr: result.stderr, trace };
}

const jwksFile = (jwks) => file('jwks.json', JSON.stringify(jwks));
const verifyArgs = (answer, jwks, extra = []) => ['verify', answer, '--jwks', jwks, '--account', built.account, ...extra];

test('CLI-1 verify works offline: exit 0 and zero network attempts under a guard that refuses every socket, lookup and fetch', () => {
  const result = run(verifyArgs(file('answer.json', ok1.text), jwksFile(ok1.jwks)));
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^VERIFIED 1 record\(s\) kid=[A-Za-z0-9_-]{43} signed_at=2026-11-20T10:00:00\.000Z\n$/);
  assert.equal(result.trace.net, 0);
});

test('CLI-2 only the two named files are opened, and no owner env, runtime, telemetry, installer, runner or control module loads', () => {
  const answer = file('answer.json', ok1.text);
  const jwks = jwksFile(ok1.jwks);
  const result = run(verifyArgs(answer, jwks));
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.trace.open, [answer, jwks]);
  for (const read of result.trace.readFile) assert.ok(/\.(?:c?js|json)$/.test(read) && read.startsWith(ROOT), 'module source reads only');
  const product = (name) => [path.join(ROOT, 'bin'), path.join(ROOT, 'src')].some((folder) => name.startsWith(folder + path.sep));
  const modules = result.trace.modules.filter(product).map((name) => path.relative(ROOT, name)).sort();
  for (const name of result.trace.modules.filter((loaded) => !product(loaded))) assert.ok(name.startsWith(path.join(ROOT, 'test', 'support')) || name.startsWith(work), 'harness only');
  assert.deepEqual(modules, ['bin/marrow-install.js', 'src/signed-record-verify.js', 'src/verify-cli.js']);
  for (const name of ['owner-env', 'runtime-core', 'usage-telemetry', 'installer', 'governed-runner', 'control-state']) {
    assert.ok(!result.trace.modules.some((loaded) => loaded.endsWith(`src/${name}.js`)), name);
  }
});

test('CLI-3 a directory, a FIFO, a symlink, a device, a 5991-byte file and a 1 MB file are input_file (exit 3); reads stop at the cap', () => {
  const jwks = jwksFile(ok1.jwks);
  const dir = path.join(work, 'a-directory');
  fs.mkdirSync(dir);
  const valid = file('valid.json', ok1.text);
  const link = path.join(work, 'link.json');
  fs.symlinkSync(valid, link);
  const jwksLink = path.join(work, 'jwks-link.json');
  fs.symlinkSync(jwks, jwksLink);
  const shared = [['directory', dir], ['1MB', file('big.json', Buffer.alloc(1 << 20, 0x20))]];
  if (fs.existsSync('/dev/zero')) shared.push(['device', '/dev/zero']);
  if (process.platform !== 'win32' && spawnSync('mkfifo', [path.join(work, 'fifo')]).status === 0) shared.push(['fifo', path.join(work, 'fifo')]);
  const answerCases = [...shared, ['symlink', link], ['over', file('over.json', ok1.text + ' '.repeat(5991 - ok1.text.length))]];
  const jwksCases = [...shared, ['symlink', jwksLink], ['over', file('over-jwks.json', JSON.stringify(ok1.jwks) + ' '.repeat(65537 - JSON.stringify(ok1.jwks).length))]];
  assert.ok(answerCases.length >= 5);
  for (const [name, target, args, readMax] of [...answerCases.map(([n, t]) => [n, t, verifyArgs(t, jwks), 0]), ...jwksCases.map(([n, t]) => [n, t, verifyArgs(valid, t), ok1.text.length])]) {
    const result = run(args);
    assert.equal(result.code, 3, name);
    assert.equal(result.stdout, 'NOT VERIFIED input_file\n', name);
    assert.ok(result.trace.read <= readMax, `${name}: no read past the cap`);
  }
  const answerCap = run(['verify', file('cap.json', ok1.text + ' '.repeat(5990 - ok1.text.length)), '--jwks', jwks, '--account', built.account]);
  assert.equal(answerCap.code, 0, 'a 5990-byte answer is read whole');
});

test('CLI-4 usage errors exit 2 and open no file', () => {
  const answer = file('answer.json', ok1.text);
  const jwks = jwksFile(ok1.jwks);
  const cases = [
    ['verify', answer, '--jwks', jwks],
    ['verify', answer, '--jwks', jwks, '--account', built.account, '--account', built.account],
    ['verify', answer, '--jwks', jwks, '--jwks', jwks, '--account', built.account],
    ['verify', answer, '--jwks', jwks, '--account', built.account, '--unknown'],
    ['verify', answer, '--jwks', jwks, '--account', built.account, '--environment', 'prod'],
    ['verify', answer, answer, '--jwks', jwks, '--account', built.account],
    ['verify', '--json'],
    ['verify'],
    ['verify', answer, '--jwks', jwks, '--account='],
    ['verify', answer, '--jwks', jwks, '--account', '--json'],
    ['verify', answer, '--jwks', jwks, '--account', 'acct one'],
    ['verify', answer, '--jwks', jwks, '--account', 'a'.repeat(129)],
    ['verify', answer, '--jwks', jwks, '--account', built.account, '--json=yes'],
    ['verify', answer, '--jwks', jwks, '--account', built.account, '--environment=production', '--environment=production'],
    ['verify', answer, '--jwks', jwks, '--account', built.account, '--'],
    ['verify', '--help'],
    ['verify', answer, '--jwks', jwks, '--account', built.account, '-h'],
  ];
  for (const args of cases) {
    const result = run(args);
    assert.equal(result.code, 2, args.slice(2).join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Usage:\n/);
    assert.deepEqual(result.trace.open, [], 'no file opened');
  }
  const named = run(['verify', answer, '--jwks', jwks, '--account', built.other]);
  assert.equal(named.code, 1, 'the account is the caller\'s, never the answer\'s');
  assert.equal(named.stdout, 'NOT VERIFIED account\n');
});

test('CLI-5 every contract vector through the CLI: exit 0 only for ok, codes equal the port\'s failures in order', async () => {
  const { verifySignedRecords } = require(path.join(ROOT, 'src', 'signed-record-verify.js'));
  let checked = 0;
  for (const vector of built.vectors) {
    if (vector.kind || typeof vector.expect.account_id !== 'string' || vector.expect.account_id === '' || typeof vector.expect.environment !== 'string') continue;
    const result = await verifySignedRecords(answerArg(vector), vector.jwks, vector.expect);
    const cli = run(['verify', file('answer.json', vector.text), '--jwks', jwksFile(vector.jwks), '--account', vector.expect.account_id,
      '--environment', vector.expect.environment], { traced: false });
    if (Buffer.byteLength(vector.text) > 5990 || JSON.stringify(vector.jwks).length > 65536) {
      assert.deepEqual([cli.code, cli.stdout], [3, 'NOT VERIFIED input_file\n'], vector.id);
    } else if (result.ok) {
      assert.equal(cli.code, 0, vector.id);
      assert.match(cli.stdout, new RegExp(`^VERIFIED ${result.records.length} record\\(s\\) kid=`), vector.id);
    } else {
      assert.deepEqual([cli.code, cli.stdout], [1, `NOT VERIFIED ${result.failures.join(',')}\n`], vector.id);
    }
    checked += 1;
  }
  assert.ok(checked >= 150, `checked ${checked}`);
  const json = run(verifyArgs(file('answer.json', built.vectors.find((v) => v.id === 'X-OK2').text), jwksFile(ok1.jwks), ['--json']), { traced: false });
  assert.equal(json.code, 0);
  const parsed = JSON.parse(json.stdout);
  assert.deepEqual([parsed.ok, parsed.failures, parsed.records.length], [true, [], 2]);
  const notOk = run(verifyArgs(file('answer.json', ok1.text), jwksFile({ keys: [] }), ['--json']), { traced: false });
  assert.deepEqual([notOk.code, notOk.stdout], [1, '{"ok":false,"failures":["kid_unknown"]}\n']);
});

test('CLI-6 a sentinel inside a failing answer file and a failing key file never reaches stdout or stderr', () => {
  const sentinel = `c1bsentinel${crypto.randomBytes(8).toString('hex')}`;
  const answers = [ok1.text.replace('"agent-one"', `"agent-${sentinel}"`), `{"${sentinel}":1}`, `${sentinel}`, ok1.text.replace('"format"', `"${sentinel}":1,"format"`)];
  const keyFiles = [JSON.stringify(ok1.jwks), JSON.stringify({ keys: [{ ...ok1.jwks.keys[0], [sentinel]: 1 }] }), `{"keys":[${sentinel}]}`, `{"${sentinel}":1,"${sentinel}":2}`];
  for (const answer of answers) {
    for (const keys of keyFiles) {
      for (const extra of [[], ['--json']]) {
        const result = run(verifyArgs(file('answer.json', answer), file('jwks.json', keys), extra), { traced: false });
        assert.notEqual(result.code, 0);
        assert.ok(!result.stdout.includes(sentinel) && !result.stderr.includes(sentinel));
      }
    }
  }
});

test('CLI-7 invalid UTF-8 is input_utf8 (exit 3); a BOM-prefixed valid answer is strict_parse (exit 1)', () => {
  const jwks = jwksFile(ok1.jwks);
  const bad = run(verifyArgs(file('answer.json', Buffer.concat([Buffer.from(ok1.text.slice(0, 20)), Buffer.from([0xff, 0xfe, 0xc3])])), jwks));
  assert.deepEqual([bad.code, bad.stdout], [3, 'NOT VERIFIED input_utf8\n']);
  const badKeys = run(verifyArgs(file('answer.json', ok1.text), file('jwks.json', Buffer.from([0x7b, 0xc0, 0x80, 0x7d]))));
  assert.deepEqual([badKeys.code, badKeys.stdout], [3, 'NOT VERIFIED input_utf8\n']);
  const bom = run(verifyArgs(file('answer.json', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(ok1.text)])), jwks));
  assert.deepEqual([bom.code, bom.stdout], [1, 'NOT VERIFIED strict_parse\n']);
});

test('CLI-8 a key file with a duplicate member or not JSON is jwks_parse (exit 1)', () => {
  const answer = file('answer.json', ok1.text);
  const text = JSON.stringify(ok1.jwks);
  for (const keys of [text.replace('"kty":"OKP"', '"kty":"OKP","kty":"OKP"'), text.replace('{"keys"', '{"keys":[],"keys"'), 'not json', '', `${text},`]) {
    const result = run(verifyArgs(answer, file('jwks.json', keys)));
    assert.deepEqual([result.code, result.stdout], [1, 'NOT VERIFIED jwks_parse\n'], keys.slice(0, 12));
  }
});

test('CLI-9 MARROW_API_KEY and MARROW_BASE_URL are ignored: no request, the dummy appears nowhere, the same verdict', async () => {
  const dummy = `c1bdummy${crypto.randomBytes(12).toString('hex')}`;
  assert.ok(!/^(?:sk_|pk_|rk_|ghp_|xox)/.test(dummy), 'the dummy is not shaped like a live key');
  let requests = 0;
  const server = http.createServer((req, res) => { requests += 1; res.end('{}'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const args = verifyArgs(file('answer.json', ok1.text), jwksFile(ok1.jwks));
    const env = { MARROW_API_KEY: dummy, MARROW_BASE_URL: `http://127.0.0.1:${server.address().port}`, MARROW_ENVIRONMENT: 'staging', MARROW_ACCOUNT_ID: built.other };
    const child = spawn(process.execPath, [BIN, ...args], { cwd: work, env: { PATH: process.env.PATH, HOME, ...env } });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { out += chunk; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    const plain = run(args, { traced: false });
    assert.equal(code, 0);
    assert.equal(out, plain.stdout);
    assert.ok(!out.includes(dummy));
    assert.equal(requests, 0);
  } finally {
    server.close();
  }
});

test('CLI-10 every other command routes exactly as BASE: same exit code, stdout and stderr', () => {
  // BASE bin/marrow-install.js (90f377a649f6) with its requires pointed at this tree.
  const src = (name) => JSON.stringify(path.join(ROOT, 'src', name));
  const baseBin = file('base-bin.js', `
const installer = require(${src('installer')});
const governedRunner = require(${src('governed-runner')});
const { runControlCli } = require(${src('control-state')});

const argv = process.argv.slice(2);
const governedCommands = new Set(['run', 'gate', 'proof', 'status', 'govern', 'fleet', 'hermes', 'openclaw', 'integrations', 'permit', 'verify-permit', 'coverage', 'sidecar', 'controller']);
const runCli = argv[0] === 'control' ? runControlCli : governedCommands.has(argv[0]) ? governedRunner.runCli : installer.runCli;

runCli(argv).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(\`marrow-install failed: \${message}\\n\`);
  process.exit(1);
});
`);
  const commands = [['--help'], ['help'], ['-h'], ['run', '--help'], ['gate', '--help'], ['proof', '--help'], ['status', '--help'], ['permit', '--help'],
    ['verify-permit', '--help'], ['doctor', '--help'], ['update', '--help'], ['control', '--help'], ['verify-permit'], ['verifyx'], ['VERIFY'], ['--verify']];
  for (const args of commands) {
    const tip = run(args, { traced: false });
    const base = run(args, { traced: false, bin: baseBin });
    assert.deepEqual([tip.code, tip.stdout, tip.stderr], [base.code, base.stdout, base.stderr], args.join(' '));
  }
});

test('CLI-11 Windows path forms are plain file names: a missing file is input_file (exit 3)', () => {
  const jwks = jwksFile(ok1.jwks);
  for (const name of ['C:\\x', 'C:/x.json', '\\\\server\\share\\x.json', '\\\\?\\C:\\x']) {
    for (const args of [verifyArgs(name, jwks), verifyArgs(file('answer.json', ok1.text), name)]) {
      const result = run(args);
      assert.deepEqual([result.code, result.stdout], [3, 'NOT VERIFIED input_file\n'], name);
    }
  }
});

require('./support/isolated-environment');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { install, parseArgs } = require('../src/installer');
const { DEFAULT_URL, dummyKey, keyTag, world, quiet, hostLayout, setup, mcpEnv, recordPath, sha, fakeApi } = require('./support/ins1');

// INS-1 cut: `update --fix-identity` is a refusal and nothing else. Whatever the record, the config files (a plain file, a
// symbolic link, a hard link, or none), the keys and the scope, it exits 4 with one fixed line before it opens a managed MCP
// config, the identity record, ~/.marrow/env or any other file in the home or the project, before any network call and before
// any spawn. The CLI runs as a child process with test/support/trace-preload.cjs, which logs every fs call that names a path
// inside the test's private folder, every network attempt and every spawn.

const BIN = path.join(__dirname, '..', 'bin', 'marrow-install.js');
const PRELOAD = path.join(__dirname, 'support', 'trace-preload.cjs');
const REFUSAL = '--fix-identity is not available in this version; nothing was changed';
const HELD = 'cliff-agent';

// Everything the tests below leave in the trace folder is removed with it.
const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-ins1-trace-'));
test.after(() => fs.rmSync(traceDir, { recursive: true, force: true }));
let runs = 0;

function runCli(argv, { cwd, home, root }) {
  const traceFile = path.join(traceDir, `trace-${runs += 1}.log`);
  fs.writeFileSync(traceFile, '');
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    TMPDIR: traceDir,
    INS1_TRACE_FILE: traceFile,
    INS1_TRACE_ROOT: root,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require ${PRELOAD}`].filter(Boolean).join(' '),
    ...(process.env.NETGUARD_LOG ? { NETGUARD_LOG: process.env.NETGUARD_LOG } : {}),
  };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...argv], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      const lines = fs.readFileSync(traceFile, 'utf8').split('\n').filter(Boolean);
      resolve({ code, stdout, stderr, trace: lines });
    });
  });
}

// path -> content hash plus inode, link count, mode and modification time: a read-only run leaves every entry equal.
function snapshot(root) {
  const out = {};
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const stat = fs.lstatSync(full);
      const meta = `${stat.ino}:${stat.nlink}:${(stat.mode & 0o7777).toString(8)}:${stat.mtimeMs}`;
      const relative = path.relative(root, full);
      if (stat.isSymbolicLink()) out[relative] = `link:${fs.readlinkSync(full)}:${meta}`;
      else if (stat.isDirectory()) { out[relative] = `dir:${meta}`; walk(full); } else out[relative] = `${sha(full)}:${meta}`;
    }
  };
  walk(root);
  return out;
}

const FORMS = ['plain', 'symlink', 'hardlink', 'missing'];
const RECORDS = ['valid', 'absent', 'unsafe'];

// A home (and, for the project scope, a project folder next to it) set up for HELD, then shaped: the record, the form of
// the two managed MCP configs and the key. Every link points at a dummy JSON copy of the config, kept beside the home.
async function shapedWorld({ scope, record, form, key }) {
  const ws = world();
  const keyValue = dummyKey();
  const api = await fakeApi({ keys: {} });
  hostLayout(ws.home, { cursor: true });
  const project = path.join(ws.base, 'project');
  if (scope === 'project') {
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'package.json'), '{}\n');
    fs.mkdirSync(path.join(project, '.cursor'), { recursive: true });
  }
  const cwd = scope === 'project' ? project : ws.home;
  await setup(cwd, { home: ws.home, agentId: HELD, baseUrl: api.url });
  if (key === 'present') {
    fs.mkdirSync(path.join(ws.home, '.marrow'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(ws.home, '.marrow', 'env'), `MARROW_API_KEY=${keyValue}\nMARROW_BASE_URL=${api.url}\n`, { mode: 0o600 });
  }
  if (record === 'absent' && fs.existsSync(recordPath(ws.home))) fs.rmSync(recordPath(ws.home));
  if (record === 'unsafe' && fs.existsSync(recordPath(ws.home))) fs.chmodSync(recordPath(ws.home), 0o660);
  const managed = [path.join(cwd, '.mcp.json'), path.join(cwd, '.cursor', 'mcp.json')];
  managed.forEach((file, index) => {
    if (!fs.existsSync(file)) return;
    const dummy = path.join(ws.base, `dummy-${index}.json`);
    if (form === 'plain') return;
    fs.renameSync(file, dummy);
    if (form === 'symlink') fs.symlinkSync(dummy, file);
    if (form === 'hardlink') fs.linkSync(dummy, file);
  });
  return { ws, api, cwd, keyValue, managed };
}

const cases = [];
for (const scope of ['home', 'project']) {
  for (const record of RECORDS) {
    for (const form of FORMS) {
      for (const key of ['present', 'absent']) cases.push({ scope, record, form, key });
    }
  }
}

for (const shape of cases) {
  const label = `${shape.scope} scope, record ${shape.record}, configs ${shape.form}, key ${shape.key}`;
  test(`C1: update --fix-identity (${label}) exits 4 with one fixed line and touches nothing`, async () => {
    const { ws, api, cwd, keyValue } = await shapedWorld(shape);
    try {
      const before = snapshot(ws.base);
      const result = await runCli(['update', '--fix-identity'], { cwd, home: ws.home, root: ws.base });
      // Nothing read, listed, checked or written under the home or the project; no request; no spawn.
      assert.deepEqual(result.trace, [], `the refused run touched: ${result.trace.join(' | ')}`);
      assert.equal(api.seen.length, 0, `requests: ${JSON.stringify(api.seen)}`);
      assert.deepEqual(snapshot(ws.base), before, 'a file, link or folder changed');
      assert.equal(result.code, 4, `exit ${result.code}: ${result.stdout}${result.stderr}`);
      assert.equal(result.stdout, `${REFUSAL}\n`);
      assert.equal(result.stderr, '');
      assert.ok(!(result.stdout + result.stderr).includes(keyValue));
    } finally { await api.close(); ws.cleanup(); }
  });
}

test('C1: the tracer sees a normal run: update --dry-run opens the managed config and the record (so the empty trace above means something)', async () => {
  const { ws, api, cwd } = await shapedWorld({ scope: 'home', record: 'valid', form: 'plain', key: 'present' });
  try {
    const before = snapshot(ws.base);
    const result = await runCli(['update', '--dry-run'], { cwd, home: ws.home, root: ws.base });
    const reads = result.trace.filter((line) => /^fs\tfs(\.promises)?\.(readFileSync|readFile|openSync|open) /.test(line));
    assert.ok(reads.some((line) => line.endsWith(`${path.sep}.mcp.json`)), `the config was not seen: ${result.trace.join(' | ')}`);
    assert.ok(reads.some((line) => line.endsWith(`${path.sep}identity-record.json`)), 'the record was not seen');
    assert.notEqual(result.code, 4);
    assert.deepEqual(snapshot(ws.base), before, 'a dry run changed a file');
  } finally { await api.close(); ws.cleanup(); }
});

test('C1: the flag is refused whatever else is on the line, in any position or mode, and with --json the refusal is one JSON object', async () => {
  const { ws, api, cwd } = await shapedWorld({ scope: 'home', record: 'valid', form: 'symlink', key: 'present' });
  try {
    const before = snapshot(ws.base);
    for (const argv of [
      ['--fix-identity', 'update'],
      ['update', '--yes', '--fix-identity'],
      ['update', '--fix-identity', '--yes', '--fix-identity'],
      ['update', '--agent-id', 'someone', '--fix-identity'],
      ['update', '--fix-identity', '--agent-id', 'someone'],
      ['update', '--fix-identity', '--dry-run'],
      ['--fix-identity', '--yes'],
      ['--yes', '--mcp', '--fix-identity'],
      ['activate', '--fix-identity'],
      ['doctor', '--fix-identity'],
      ['uninstall', '--fix-identity'],
    ]) {
      const result = await runCli(argv, { cwd, home: ws.home, root: ws.base });
      assert.equal(result.code, 4, `${argv.join(' ')}: exit ${result.code}: ${result.stdout}${result.stderr}`);
      assert.equal(result.stdout, `${REFUSAL}\n`, argv.join(' '));
      assert.equal(result.stderr, '', argv.join(' '));
      assert.deepEqual(result.trace, [], `${argv.join(' ')}: ${result.trace.join(' | ')}`);
    }
    const json = await runCli(['update', '--fix-identity', '--json'], { cwd, home: ws.home, root: ws.base });
    assert.equal(json.code, 4);
    assert.deepEqual(JSON.parse(json.stdout), { ok: false, identity: { exitCode: 4, reason: 'fix_identity', lines: [REFUSAL] } });
    assert.deepEqual(json.trace, []);
    assert.equal(api.seen.length, 0);
    assert.deepEqual(snapshot(ws.base), before);
  } finally { await api.close(); ws.cleanup(); }
});

test('C1: the refusal line carries no path, id or file text, and the flag is not in --help', async () => {
  const { ws, api, cwd } = await shapedWorld({ scope: 'home', record: 'valid', form: 'plain', key: 'present' });
  try {
    const result = await runCli(['update', '--fix-identity'], { cwd, home: ws.home, root: ws.base });
    assert.match(result.stdout, /^[ -~]+\n$/);
    for (const text of [ws.base, ws.home, HELD, DEFAULT_URL, api.url, 'mcp.json', 'MARROW']) assert.ok(!result.stdout.includes(text), `the line names ${text}`);
    const help = await runCli(['--help'], { cwd, home: ws.home, root: ws.base });
    assert.equal(help.code, 0);
    assert.ok(!help.stdout.includes('fix-identity'));
  } finally { await api.close(); ws.cleanup(); }
});

// T8, kept from the fix path's tests: `update` itself asks the server nothing about identity.
test('T8: update makes no status request and keeps the recorded id', async () => {
  const ws = world();
  const fileKey = dummyKey();
  const api = await fakeApi({ keys: { [keyTag(fileKey)]: ['cliff-agent'] } });
  try {
    hostLayout(ws.home);
    await setup(ws.home, { agentId: 'cliff', baseUrl: api.url });
    fs.mkdirSync(path.join(ws.home, '.marrow'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(ws.home, '.marrow', 'env'), `MARROW_API_KEY=${fileKey}\nMARROW_BASE_URL=${api.url}\n`, { mode: 0o600 });
    const parsed = parseArgs(['update'], { HOME: ws.home, PATH: process.env.PATH });
    await install({ ...parsed, ...quiet({ cwd: ws.home, home: ws.home, mode: 'mcp', apiKey: dummyKey(), baseUrl: api.url }) });
    assert.equal(api.seen.length, 0, `requests: ${JSON.stringify(api.seen)}`);
    assert.equal(mcpEnv(ws.home).MARROW_FLEET_AGENT_ID, 'cliff', 'the recorded id stays');
  } finally { await api.close(); ws.cleanup(); }
});

require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const PINS = require('../src/pins');
const {
  SEATBELT_PRESENCE_KEY,
  buildStatusEnv,
  resolveTrustedNpx,
  statusInvocation,
} = require('../src/seatbelt-status');

// The doctor's status child is `process.execPath <npm's npx-cli.js> -y --package=@getmarrow/mcp@<pin>
// marrow-mcp seatbelt-status`, with an allow-listed environment, in a private empty folder. These tests
// run the real doctor CLI with a fake node install (a COPY of the node binary, so process.execPath is
// the fake path) whose npx-cli.js is a stub that records what it was given. Nothing here reaches the
// network: the doctor process runs under the base-URL tests' recorder, which refuses every fetch and connect.

const BIN = path.join(__dirname, '..', 'bin', 'marrow-install.js');
const RECORDER = path.join(__dirname, 'support', 'm2-network-recorder.js');
const rnd = (n) => crypto.randomBytes(n).toString('hex');
const PIN_ARGV = ['-y', `--package=@getmarrow/mcp@${PINS.MCP_ADAPTER_VERSION}`, 'marrow-mcp', 'seatbelt-status'];

let installed = null;
function fakeNode() {
  if (installed) return installed;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-fakenode-')));
  const bin = path.join(root, 'bin');
  const npmBin = path.join(root, 'lib', 'node_modules', 'npm', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(npmBin, { recursive: true });
  fs.copyFileSync(process.execPath, path.join(bin, 'node'), fs.constants.COPYFILE_FICLONE);
  fs.chmodSync(path.join(bin, 'node'), 0o755);
  fs.symlinkSync('../lib/node_modules/npm/bin/npx-cli.js', path.join(bin, 'npx'));
  installed = { root, bin, node: path.join(bin, 'node'), link: path.join(bin, 'npx'), cli: path.join(npmBin, 'npx-cli.js'), npmBin };
  process.once('exit', () => fs.rmSync(root, { recursive: true, force: true }));
  return installed;
}

// The stub npx-cli.js: records what it was started with and answers like the MCP's status command.
function stubMain(config) {
  const fs = require('node:fs');
  const args = process.argv.slice(2);
  if (args.includes('loop-guard-self-test')) {
    fs.appendFileSync(config.record, `${JSON.stringify({ kind: 'loop-guard' })}\n`);
    process.stdout.write(`${JSON.stringify({ pass: true, isolated: true, live_hook_observed: false, repeat_denied: true, mutation_reset: true, owner_disabled_bypass: true })}\n`);
    process.exit(0);
  }
  const cwd = process.cwd();
  const proxies = {};
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']) if (name in process.env) proxies[name] = process.env[name];
  fs.appendFileSync(config.record, `${JSON.stringify({
    kind: 'status',
    execPath: process.execPath,
    script: fs.realpathSync(process.argv[1]),
    argv: args,
    envNames: Object.keys(process.env).sort(),
    envPath: process.env.PATH,
    key: process.env.MARROW_API_KEY === undefined ? null : process.env.MARROW_API_KEY,
    proxies,
    cwd,
    cwdMode: fs.statSync(cwd).mode & 0o777,
    cwdEntries: fs.readdirSync(cwd).length,
  })}\n`);
  // Like the MCP: a key set under either name (any non-empty value) means account mode.
  process.stdout.write(`${JSON.stringify({ mode: process.env.MARROW_API_KEY || process.env.MARROW_KEY ? 'account' : 'seatbelt', reasons: [] })}\n`);
}

function writeStub(fake, record) {
  fs.writeFileSync(fake.cli, `#!/usr/bin/env node\n(${stubMain.toString()})(${JSON.stringify({ record })});\n`, { mode: 0o755 });
}

function workspace() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-seatbelt-child-')));
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(project, { mode: 0o700 });
  fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Claude\n');
  return { base, home, project, record: path.join(base, 'record.jsonl'), planted: path.join(base, 'planted.log'), cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

// A script that records its own name and the fourth word of its argv (the subcommand) when it runs.
function plant(file, ws, label) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const proof = '{"pass":true,"isolated":true,"live_hook_observed":false,"repeat_denied":true,"mutation_reset":true,"owner_disabled_bypass":true}';
  fs.writeFileSync(file, `#!/bin/sh\necho "${label} sub=$4" >> ${JSON.stringify(ws.planted)}\nif [ "$4" = loop-guard-self-test ]; then printf '%s\\n' '${proof}'; exit 0; fi\nprintf '{"mode":"seatbelt","reasons":[]}\\n'\n`, { mode: 0o755 });
}

const plantedRuns = (ws) => (fs.existsSync(ws.planted) ? fs.readFileSync(ws.planted, 'utf8').split('\n').filter(Boolean) : []);
const statusRecords = (ws) => (fs.existsSync(ws.record) ? fs.readFileSync(ws.record, 'utf8').split('\n').filter(Boolean).map((row) => JSON.parse(row)) : []).filter((row) => row.kind === 'status');

// The doctor, started by the fake node, in `cwd`. `env` is the whole environment of the doctor process.
function doctor(ws, env, { cwd = ws.project, args = [], selfTest = false } = {}) {
  const fake = fakeNode();
  writeStub(fake, ws.record);
  const capture = path.join(ws.base, 'capture.jsonl');
  fs.writeFileSync(capture, '');
  const result = spawnSync(fake.node, [BIN, 'doctor', ...(selfTest ? [] : ['--no-self-test']), '--cwd', ws.project, ...args], {
    cwd,
    env: { CAPTURE_FILE: capture, ...env, NODE_OPTIONS: [`--require=${RECORDER}`, env.NODE_OPTIONS].filter(Boolean).join(' ') },
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const text = `${result.stdout || ''}${result.stderr || ''}`;
  const line = (result.stdout || '').split('\n').find((entry) => entry.startsWith('- Seatbelt:')) || '(none)';
  return { result, text, line };
}

const baseEnv = (ws, extra = {}) => ({ PATH: `${fakeNode().bin}${path.delimiter}/usr/bin${path.delimiter}/bin`, HOME: ws.home, ...extra });

test('R1 a planted node_modules/.bin/npx and node first on PATH never run for the status; the line is not forged', () => {
  const ws = workspace();
  try {
    const dummy = rnd(24);
    const bin = path.join(ws.project, 'node_modules', '.bin');
    plant(path.join(bin, 'npx'), ws, 'planted-npx');
    plant(path.join(bin, 'node'), ws, 'planted-node');
    const env = baseEnv(ws, { PATH: `${bin}${path.delimiter}${fakeNode().bin}${path.delimiter}/usr/bin${path.delimiter}/bin`, MARROW_API_KEY: dummy });
    const run = doctor(ws, env);
    assert.equal(run.result.status, 0, run.text);
    assert.deepEqual(plantedRuns(ws).filter((entry) => entry.includes('sub=seatbelt-status')), [], 'the planted programs never ran for the status');
    assert.equal(run.line, '- Seatbelt: account mode (using your Marrow key)', 'the line comes from the trusted npx, not the planted one (which prints "on (no account)")');
    const [record, ...more] = statusRecords(ws);
    assert.equal(more.length, 0, 'one status child');
    assert.equal(record.execPath, fakeNode().node);
    assert.equal(record.script, fs.realpathSync(fakeNode().cli));
    assert.deepEqual(record.argv, PIN_ARGV);
    assert.equal(record.envPath.split(path.delimiter).some((entry) => entry.includes(`node_modules${path.sep}.bin`)), false, 'no node_modules/.bin on the child PATH');
    assert.equal(record.envPath.split(path.delimiter)[0], fakeNode().bin, 'the node folder comes first');
    assert.equal(run.text.includes(dummy) || JSON.stringify(record).includes(dummy), false);
  } finally {
    ws.cleanup();
  }
});

test('R1 base behaviour kept: the loop-guard self-test still looks npx up on PATH (not changed in this round)', (t) => {
  const ws = workspace();
  try {
    const bin = path.join(ws.project, 'node_modules', '.bin');
    plant(path.join(bin, 'npx'), ws, 'planted-npx');
    const run = doctor(ws, baseEnv(ws, { PATH: `${bin}${path.delimiter}${fakeNode().bin}${path.delimiter}/usr/bin${path.delimiter}/bin` }), { selfTest: true });
    assert.equal(run.result.status, 0, run.text);
    const runs = plantedRuns(ws);
    t.diagnostic(`planted npx runs: ${runs.length} (loop-guard-self-test: ${runs.filter((entry) => entry.includes('sub=loop-guard-self-test')).length}, seatbelt-status: ${runs.filter((entry) => entry.includes('sub=seatbelt-status')).length})`);
    assert.equal(runs.filter((entry) => entry.includes('sub=seatbelt-status')).length, 0);
  } finally {
    ws.cleanup();
  }
});

test('R2 "." , an empty entry and a relative folder holding npx and node: never run, not in the child PATH', () => {
  const ws = workspace();
  try {
    for (const file of [path.join(ws.project, 'npx'), path.join(ws.project, 'node'), path.join(ws.project, 'rel', 'npx'), path.join(ws.project, 'rel', 'node')]) plant(file, ws, 'planted');
    const env = baseEnv(ws, { PATH: ['.', '', 'rel', './rel', fakeNode().bin, '/usr/bin', '/bin'].join(path.delimiter) });
    const run = doctor(ws, env);
    assert.equal(run.result.status, 0, run.text);
    assert.deepEqual(plantedRuns(ws), []);
    const [record] = statusRecords(ws);
    assert.deepEqual(record.envPath.split(path.delimiter), [fakeNode().bin, '/usr/bin', '/bin']);
    assert.equal(run.line, '- Seatbelt: on (no account)');
  } finally {
    ws.cleanup();
  }
});

test('R3 R4 npm_*, NODE_OPTIONS, NODE_PATH and every other name stay out; the child gets exactly the allow-list', () => {
  const ws = workspace();
  try {
    const marker = path.join(ws.base, 'node-options-marker.js');
    const markerLog = path.join(ws.base, 'marker.log');
    fs.writeFileSync(marker, `require('node:fs').appendFileSync(${JSON.stringify(markerLog)}, process.pid + ' ' + String(process.argv[1]) + '\\n');\n`);
    const junk = {
      NODE_OPTIONS: `--require ${marker}`,
      NODE_PATH: ws.base,
      npm_config_registry: 'http://127.0.0.1:9/',
      NPM_CONFIG_USERCONFIG: path.join(ws.base, 'npmrc-user'),
      npm_config_cache: path.join(ws.base, 'cache'),
      npm_execpath: path.join(ws.base, 'npm'),
      MARROW_KEY_ABC: rnd(8),
      MARROW_AGENT_ID: 'agent-a',
      MARROW_AGENT_ID_ABC: 'agent-b',
      MARROW_FLEET_AGENT_ID: 'agent-c',
      MARROW_BASE_URL: 'http://127.0.0.1:9',
      MARROW_SESSION_ID: 'session-1',
      MARROW_OTHER: 'x',
      AWS_ACCESS_KEY_ID: rnd(8),
      GITHUB_TOKEN: rnd(8),
      SHELL: '/bin/sh',
      USER: 'someone',
    };
    const allowed = {
      USERPROFILE: ws.home,
      MARROW_SEATBELT_STRICT: '1',
      CODEX_HOME: path.join(ws.home, '.codex'),
      CLAUDE_CONFIG_DIR: path.join(ws.home, '.claude'),
      GEMINI_CLI_SYSTEM_SETTINGS_PATH: path.join(ws.home, 'gemini.json'),
      CLINE_DIR: path.join(ws.home, '.cline'),
      LANG: 'C',
      LC_ALL: 'C',
      TMPDIR: process.env.TMPDIR,
      TMP: process.env.TMPDIR,
      TEMP: process.env.TMPDIR,
    };
    const run = doctor(ws, baseEnv(ws, { ...junk, ...allowed }));
    assert.equal(run.result.status, 0, run.text);
    const [record] = statusRecords(ws);
    const expected = [...Object.keys(allowed), 'HOME', 'PATH'].sort();
    assert.deepEqual(record.envNames, expected, 'exactly the allow-listed names that were set, and PATH');
    for (const name of Object.keys(junk)) assert.equal(record.envNames.includes(name), false, name);
    assert.equal(record.envNames.some((name) => /^npm_/i.test(name)), false);
    const markerRuns = fs.existsSync(markerLog) ? fs.readFileSync(markerLog, 'utf8').split('\n').filter(Boolean) : [];
    assert.ok(markerRuns.length > 0, 'the marker ran in the doctor itself, so it was live');
    assert.equal(markerRuns.filter((entry) => entry.includes('npx-cli.js')).length, 0, 'the marker ran 0 times in the status child');
  } finally {
    ws.cleanup();
  }
});

test('R3 a project npm config file that sets a dummy registry is not read: the child runs in a private folder', () => {
  const ws = workspace();
  try {
    fs.writeFileSync(path.join(ws.project, `.${'npm'}rc`), 'registry=http://127.0.0.1:9/\n');
    fs.writeFileSync(path.join(ws.project, 'package.json'), '{"name":"hostile-project","version":"1.0.0","private":true}\n');
    const run = doctor(ws, baseEnv(ws));
    assert.equal(run.result.status, 0, run.text);
    const [record] = statusRecords(ws);
    assert.notEqual(record.cwd, ws.project);
    assert.equal(fs.existsSync(path.join(record.cwd, `.${'npm'}rc`)), false);
    assert.equal(record.envNames.includes('npm_config_registry'), false);
  } finally {
    ws.cleanup();
  }
});

test('R5 R7 the key reaches the child only as the presence marker; two machines that differ only in the key value are identical', () => {
  const run = (envKey) => {
    const ws = workspace();
    try {
      const out = doctor(ws, baseEnv(ws, envKey));
      assert.equal(out.result.status, 0, out.text);
      const [record] = statusRecords(ws);
      const normalize = (text) => text.split(ws.base).join('<BASE>').replace(/marrow-install-seatbelt-[A-Za-z0-9]{6}/g, '<PRIVATE>');
      return { out, record, text: normalize(out.text), envNames: record.envNames, key: record.key, envPath: normalize(record.envPath) };
    } finally {
      ws.cleanup();
    }
  };
  const keyA = rnd(24);
  const keyB = rnd(24);
  const a = run({ MARROW_API_KEY: keyA });
  const b = run({ MARROW_API_KEY: keyB });
  const onlyOther = run({ MARROW_KEY: rnd(24) });
  const none = run({});
  const blank = run({ MARROW_API_KEY: '' });
  assert.equal(a.key, SEATBELT_PRESENCE_KEY);
  assert.equal(onlyOther.key, SEATBELT_PRESENCE_KEY, 'MARROW_KEY alone also counts, as the MCP counts it');
  assert.equal(a.out.line, '- Seatbelt: account mode (using your Marrow key)');
  assert.equal(onlyOther.out.line, '- Seatbelt: account mode (using your Marrow key)');
  for (const keyless of [none, blank]) {
    assert.equal(keyless.key, null, 'no key: no MARROW_API_KEY in the child');
    assert.equal(keyless.envNames.includes('MARROW_KEY'), false);
    assert.equal(keyless.out.line, '- Seatbelt: on (no account)');
  }
  assert.deepEqual(a.envNames, b.envNames);
  assert.equal(a.text, b.text, 'identical doctor output');
  assert.equal(JSON.stringify([a.record, b.record, onlyOther.record]).includes(keyA) || a.text.includes(keyA) || b.text.includes(keyB), false, 'the key occurs 0 times');
  assert.equal(a.record.argv.join(' ').includes(keyA), false);
  assert.equal(a.envNames.includes('MARROW_KEY'), false);
});

test('R6 trusted-npx refusals: nothing is started and the line is "could not check"', () => {
  const fake = fakeNode();
  const original = fs.readlinkSync(fake.link);
  const ws = workspace();
  // The loop-guard self-test (not changed) looks npx up on PATH, so a neutral one is on PATH here.
  const neutral = path.join(ws.base, 'neutral-bin');
  const proof = '{"pass":true,"isolated":true,"live_hook_observed":false,"repeat_denied":true,"mutation_reset":true,"owner_disabled_bypass":true}';
  fs.mkdirSync(neutral);
  fs.writeFileSync(path.join(neutral, 'npx'), `#!/bin/sh\nprintf '%s\\n' '${proof}'\n`, { mode: 0o755 });
  const envFor = () => ({ ...baseEnv(ws), PATH: `${neutral}${path.delimiter}/usr/bin${path.delimiter}/bin` });
  const refuse = (label, expectRuns = []) => {
    fs.rmSync(ws.record, { force: true });
    const run = doctor(ws, envFor());
    assert.equal(run.result.status, 0, `${label}: ${run.text}`);
    assert.equal(run.line, '- Seatbelt: could not check', label);
    assert.deepEqual(statusRecords(ws), [], `${label}: no status child`);
    assert.deepEqual(plantedRuns(ws), expectRuns, `${label}: nothing planted ran`);
    assert.match(run.text, /\n- Marrow active: /, `${label}: the rest of doctor still prints`);
  };
  try {
    const control = doctor(ws, envFor());
    assert.equal(control.line, '- Seatbelt: on (no account)', 'control: the untouched install works');
    // Candidate missing.
    fs.rmSync(fake.link);
    refuse('candidate missing');
    // A link to a file inside the doctor's folder.
    plant(path.join(ws.project, 'npx-cli.js'), ws, 'in-cwd');
    fs.symlinkSync(path.join(ws.project, 'npx-cli.js'), fake.link);
    refuse('link to a file inside the cwd');
    fs.rmSync(fake.link);
    // A link to a file inside node_modules/.bin (named npx-cli.js in a bin folder, in an npm folder).
    const hidden = path.join(ws.base, 'elsewhere', 'node_modules', '.bin');
    fs.mkdirSync(hidden, { recursive: true });
    plant(path.join(hidden, 'npx-cli.js'), ws, 'in-bin');
    fs.symlinkSync(path.join(hidden, 'npx-cli.js'), fake.link);
    refuse('link to a node_modules/.bin file');
    fs.rmSync(fake.link);
    // A link to a file that is not npm's npx-cli.js, and to npx-cli.js outside an npm/bin folder.
    plant(path.join(ws.base, 'other', 'npm', 'bin', 'something.js'), ws, 'other-name');
    fs.symlinkSync(path.join(ws.base, 'other', 'npm', 'bin', 'something.js'), fake.link);
    refuse('link to a file not named npx-cli.js');
    fs.rmSync(fake.link);
    plant(path.join(ws.base, 'other2', 'tools', 'bin', 'npx-cli.js'), ws, 'other-folder');
    fs.symlinkSync(path.join(ws.base, 'other2', 'tools', 'bin', 'npx-cli.js'), fake.link);
    refuse('npx-cli.js not inside an npm folder');
    fs.rmSync(fake.link);
    // A link to a folder named like the script.
    fs.mkdirSync(path.join(ws.base, 'other3', 'npm', 'bin', 'npx-cli.js'), { recursive: true });
    fs.symlinkSync(path.join(ws.base, 'other3', 'npm', 'bin', 'npx-cli.js'), fake.link);
    refuse('a folder, not a regular file');
    fs.rmSync(fake.link);
    // A dangling link.
    fs.symlinkSync(path.join(ws.base, 'does-not-exist'), fake.link);
    refuse('dangling link');
    fs.rmSync(fake.link);
    // The install itself inside the doctor's project folder (--cwd names the folder that holds node).
    fs.symlinkSync(original, fake.link);
    fs.rmSync(ws.record, { force: true });
    const inside = spawnSync(fake.node, [BIN, 'doctor', '--no-self-test', '--cwd', fake.root], { cwd: ws.base, env: { ...envFor(), CAPTURE_FILE: path.join(ws.base, 'cap'), NODE_OPTIONS: `--require=${RECORDER}` }, encoding: 'utf8', timeout: 120000 });
    assert.match(inside.stdout, /\n- Seatbelt: could not check\n/, 'node installed inside --cwd');
    assert.deepEqual(statusRecords(ws), []);
    // Restored: works again.
    const again = doctor(ws, envFor());
    assert.equal(again.line, '- Seatbelt: on (no account)', 'control after restoring');
  } finally {
    fs.rmSync(fake.link, { force: true });
    fs.symlinkSync(original, fake.link);
    ws.cleanup();
  }
});

test('R9 the child runs in a fresh private empty folder, never the project; a planted local package and a project config are not used', () => {
  const ws = workspace();
  try {
    fs.writeFileSync(path.join(ws.project, `.${'npm'}rc`), 'registry=http://127.0.0.1:9/\n');
    fs.writeFileSync(path.join(ws.project, 'package.json'), '{"name":"hostile-project","version":"1.0.0","private":true}\n');
    const planted = path.join(ws.project, 'node_modules', '@getmarrow', 'mcp');
    fs.mkdirSync(path.join(planted, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(planted, 'package.json'), JSON.stringify({ name: '@getmarrow/mcp', version: PINS.MCP_ADAPTER_VERSION, bin: { 'marrow-mcp': 'bin/cli.js' } }));
    plant(path.join(planted, 'bin', 'cli.js'), ws, 'planted-mcp');
    const run = doctor(ws, baseEnv(ws, { TMPDIR: fs.realpathSync(process.env.TMPDIR) }));
    assert.equal(run.result.status, 0, run.text);
    assert.deepEqual(plantedRuns(ws), []);
    const [record] = statusRecords(ws);
    assert.equal(path.dirname(record.cwd), fs.realpathSync(process.env.TMPDIR), 'under the temporary folder');
    assert.match(path.basename(record.cwd), /^marrow-install-seatbelt-/);
    assert.equal(record.cwdMode, 0o700);
    assert.equal(record.cwdEntries, 0, 'empty');
    assert.equal(record.cwd.startsWith(`${ws.project}${path.sep}`) || record.cwd === ws.project, false, 'not the project');
    assert.equal(fs.existsSync(record.cwd), false, 'removed after the run');
  } finally {
    ws.cleanup();
  }
});

test('R9 a TMPDIR below a project, or below a folder with node_modules or package.json, starts nothing', () => {
  const ws = workspace();
  try {
    const cases = {
      'the project': path.join(ws.project, 'tmp'),
      'a folder with a node_modules': path.join(ws.base, 'a', 'tmp'),
      'a folder with a package.json': path.join(ws.base, 'b', 'tmp'),
    };
    fs.mkdirSync(path.join(ws.base, 'a', 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(ws.base, 'b'), { recursive: true });
    fs.writeFileSync(path.join(ws.base, 'b', 'package.json'), '{}\n');
    fs.writeFileSync(path.join(ws.project, 'package.json'), '{"name":"p","version":"1.0.0","private":true}\n');
    for (const [label, dir] of Object.entries(cases)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.rmSync(ws.record, { force: true });
      const run = doctor(ws, baseEnv(ws, { TMPDIR: dir }));
      assert.equal(run.line, '- Seatbelt: could not check', label);
      assert.deepEqual(statusRecords(ws), [], label);
    }
  } finally {
    ws.cleanup();
  }
});

test('R10 proxy names reach the child unchanged; nothing else from the other lists does', () => {
  const ws = workspace();
  try {
    const proxies = { HTTPS_PROXY: `http://127.0.0.1:9/${rnd(4)}`, HTTP_PROXY: `http://127.0.0.1:9/${rnd(4)}`, NO_PROXY: `localhost,${rnd(4)}`, https_proxy: `http://127.0.0.1:9/${rnd(4)}`, http_proxy: `http://127.0.0.1:9/${rnd(4)}`, no_proxy: `localhost,${rnd(4)}` };
    const run = doctor(ws, baseEnv(ws, { ...proxies, ALL_PROXY: 'http://127.0.0.1:9', npm_config_proxy: 'http://127.0.0.1:9' }));
    assert.equal(run.result.status, 0, run.text);
    const [record] = statusRecords(ws);
    assert.deepEqual(record.proxies, proxies);
    assert.equal(record.envNames.includes('ALL_PROXY'), false);
    assert.equal(record.envNames.includes('npm_config_proxy'), false);
    assert.deepEqual(record.envNames, [...Object.keys(proxies), 'HOME', 'PATH'].sort());
  } finally {
    ws.cleanup();
  }
});

test('trusted npx: the layouts of nvm, the official tarball, Homebrew and Debian resolve; every error gives null', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-layouts-')));
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd);
  try {
    // <prefix>/bin/{node,npx -> ../lib/node_modules/npm/bin/npx-cli.js}: nvm, the tarball, Homebrew.
    const prefix = path.join(root, 'prefix');
    fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(prefix, 'lib', 'node_modules', 'npm', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'), '// npx\n');
    fs.symlinkSync('../lib/node_modules/npm/bin/npx-cli.js', path.join(prefix, 'bin', 'npx'));
    assert.equal(resolveTrustedNpx({ execPath: path.join(prefix, 'bin', 'node'), cwd }), path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'));
    // Debian: /usr/bin/{node,npx -> ../share/nodejs/npm/bin/npx-cli.js}.
    const usr = path.join(root, 'usr');
    fs.mkdirSync(path.join(usr, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(usr, 'share', 'nodejs', 'npm', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(usr, 'share', 'nodejs', 'npm', 'bin', 'npx-cli.js'), '// npx\n');
    fs.symlinkSync('../share/nodejs/npm/bin/npx-cli.js', path.join(usr, 'bin', 'npx'));
    assert.equal(resolveTrustedNpx({ execPath: path.join(usr, 'bin', 'node'), cwd }), path.join(usr, 'share', 'nodejs', 'npm', 'bin', 'npx-cli.js'));
    // Errors give null: relative execPath, no execPath folder, a cwd that holds the install, a project dir that holds it.
    assert.equal(resolveTrustedNpx({ execPath: 'node', cwd }), null);
    assert.equal(resolveTrustedNpx({ execPath: path.join(root, 'missing', 'node'), cwd }), null);
    assert.equal(resolveTrustedNpx({ execPath: path.join(prefix, 'bin', 'node'), cwd: prefix }), null);
    assert.equal(resolveTrustedNpx({ execPath: path.join(prefix, 'bin', 'node'), cwd, projectDirs: [path.join(prefix, 'lib')] }), null);
    assert.equal(resolveTrustedNpx({ execPath: path.join(prefix, 'bin', 'node'), cwd, projectDirs: [''] }), null);
    // A node install below a node_modules/.bin folder is refused (any depth, any case).
    for (const hidden of ['node_modules/.bin', 'a/Node_Modules/.BIN/b']) {
      const sub = path.join(root, 'hid', hidden);
      fs.mkdirSync(path.join(sub, '..', 'lib', 'node_modules', 'npm', 'bin'), { recursive: true });
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(sub, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'), '// npx\n');
      fs.symlinkSync('../lib/node_modules/npm/bin/npx-cli.js', path.join(sub, 'npx'));
      assert.equal(resolveTrustedNpx({ execPath: path.join(sub, 'node'), cwd }), null, hidden);
    }
    // The option is not reachable from the CLI or the environment: it is read from process.execPath only.
    const { statusInvocation: viaDefaults } = require('../src/seatbelt-status');
    assert.equal(viaDefaults({ version: '3.9.104', cwd, projectDirs: [cwd] })?.command, process.execPath);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the child environment is built from scratch: allow-list, key marker, rebuilt PATH (POSIX and Windows rules)', () => {
  const dummy = rnd(24);
  const parent = {
    HOME: '/home/u', USERPROFILE: '/home/u', MARROW_API_KEY: dummy, MARROW_KEY: dummy, NODE_OPTIONS: '--require x', NODE_PATH: '/x', npm_config_registry: 'x',
    NPM_CONFIG_PREFIX: 'x', MARROW_AGENT_ID: 'a', LANG: 'C', HTTPS_PROXY: 'p', PATH: ['.', '', 'rel', '/proj/node_modules/.bin', '/PROJ/NODE_MODULES/.BIN/x', '/usr/bin', '/bin', '/usr/bin'].join(':'),
  };
  const env = buildStatusEnv(parent, { execPath: '/opt/node/bin/node', platform: 'linux' });
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'HTTPS_PROXY', 'LANG', 'MARROW_API_KEY', 'PATH', 'USERPROFILE']);
  assert.equal(env.MARROW_API_KEY, SEATBELT_PRESENCE_KEY);
  assert.equal(env.PATH, '/opt/node/bin:/usr/bin:/bin');
  assert.equal(JSON.stringify(env).includes(dummy), false);
  assert.deepEqual(Object.keys(buildStatusEnv({ PATH: '/bin' }, { execPath: '/opt/node/bin/node', platform: 'linux' })).sort(), ['PATH'], 'no key, nothing else set: only PATH');
  // Windows: names are case-insensitive, both separators count, quoted, relative and drive-relative entries are dropped, extra names are allowed.
  const win = buildStatusEnv({
    Path: ['C:\\Program Files\\nodejs', 'C:\\proj\\Node_Modules\\.bin', 'D:/p/node_modules/.BIN/', '"C:\\quoted"', 'rel', '.', 'C:foo', '\\\\server\\share\\bin', 'C:\\Windows\\System32'].join(';'),
    SystemRoot: 'C:\\Windows', comspec: 'C:\\Windows\\System32\\cmd.exe', Pathext: '.EXE', AppData: 'C:\\a', LocalAppData: 'C:\\l', https_proxy: 'p', Marrow_Key: dummy, Node_Options: 'x', Temp: 'C:\\t',
  }, { execPath: 'C:\\Program Files\\nodejs\\node.exe', platform: 'win32' });
  assert.deepEqual(Object.keys(win).map((name) => name.toLowerCase()).sort(), ['appdata', 'comspec', 'localappdata', 'marrow_api_key', 'path', 'pathext', 'systemroot', 'temp', 'https_proxy'].sort());
  assert.equal(win.MARROW_API_KEY, SEATBELT_PRESENCE_KEY);
  assert.equal(win.PATH, ['C:\\Program Files\\nodejs', '\\\\server\\share\\bin', 'C:\\Windows\\System32'].join(';'));
});

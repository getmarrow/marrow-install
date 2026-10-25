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
  statusParentFolder,
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

const HOST_FAKES = path.join(__dirname, 'support', 'status-host-fakes.js');

// A node install laid out like nvm, the official tarball and Homebrew: <root>/bin/node, <root>/bin/npx -> the script.
// The node binary is a hard link to `source` when the file system allows it (a COPY otherwise), so process.execPath of a
// doctor started through it is this path.
function buildInstall(root, source) {
  const bin = path.join(root, 'bin');
  const npmBin = path.join(root, 'lib', 'node_modules', 'npm', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(npmBin, { recursive: true });
  const node = path.join(bin, 'node');
  try {
    fs.linkSync(source, node);
  } catch {
    fs.copyFileSync(source, node, fs.constants.COPYFILE_FICLONE);
  }
  fs.chmodSync(node, 0o755);
  fs.symlinkSync('../lib/node_modules/npm/bin/npx-cli.js', path.join(bin, 'npx'));
  return { root, bin, node, link: path.join(bin, 'npx'), cli: path.join(npmBin, 'npx-cli.js'), npmBin };
}

let installed = null;
function fakeNode() {
  if (installed) return installed;
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-fakenode-')));
  installed = buildInstall(root, process.execPath);
  process.once('exit', () => fs.rmSync(root, { recursive: true, force: true }));
  return installed;
}

// Another install below `parent`, sharing the first one's node binary (a hard link, no second copy).
function extraInstall(parent) {
  return buildInstall(parent, fakeNode().node);
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
  fs.chmodSync(fake.cli, 0o755);
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

// The private base of the status child under a (fake) passwd home.
const baseOf = (home) => path.join(home, '.cache', 'marrow', 'doctor-tmp');

// The three base parts as an earlier build left them (a run no longer leaves them): each a mode-700 folder of the user's own.
function makeBase(home) {
  for (const part of [path.join(home, '.cache'), path.join(home, '.cache', 'marrow'), baseOf(home)]) {
    fs.mkdirSync(part, { mode: 0o700 });
    fs.chmodSync(part, 0o700);
  }
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
function doctor(ws, env, { cwd = ws.project, args = [], selfTest = false, install = fakeNode(), stub = true } = {}) {
  const fake = install;
  if (stub) writeStub(fake, ws.record);
  const capture = path.join(ws.base, 'capture.jsonl');
  fs.writeFileSync(capture, '');
  const result = spawnSync(fake.node, [BIN, 'doctor', ...(selfTest ? [] : ['--no-self-test']), '--cwd', ws.project, ...args], {
    cwd,
    env: { CAPTURE_FILE: capture, ...env, NODE_OPTIONS: [`--require=${RECORDER}`, `--require=${HOST_FAKES}`, env.NODE_OPTIONS].filter(Boolean).join(' ') },
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

test('R6 N2 N3 N4 trusted-npx refusals: nothing is started and the line is "could not check"', () => {
  const ws = workspace();
  const inst = extraInstall(path.join(ws.base, 'inst'));
  writeStub(inst, ws.record);
  // The loop-guard self-test (not changed) looks npx up on PATH, so a neutral one is on PATH here.
  const neutral = path.join(ws.base, 'neutral-bin');
  const proof = '{"pass":true,"isolated":true,"live_hook_observed":false,"repeat_denied":true,"mutation_reset":true,"owner_disabled_bypass":true}';
  fs.mkdirSync(neutral);
  fs.writeFileSync(path.join(neutral, 'npx'), `#!/bin/sh\nprintf '%s\n' '${proof}'\n`, { mode: 0o755 });
  const envFor = () => ({ ...baseEnv(ws), PATH: `${neutral}${path.delimiter}/usr/bin${path.delimiter}/bin` });
  const run = (options = {}) => {
    fs.rmSync(ws.record, { force: true });
    return doctor(ws, envFor(), { install: inst, stub: false, ...options });
  };
  const refuse = (label, options) => {
    const result = run(options);
    assert.equal(result.result.status, 0, `${label}: ${result.text}`);
    assert.equal(result.line, '- Seatbelt: could not check', label);
    assert.deepEqual(statusRecords(ws), [], `${label}: no status child`);
    assert.deepEqual(plantedRuns(ws), [], `${label}: nothing planted ran`);
    assert.match(result.text, /\n- Marrow active: /, `${label}: the rest of doctor still prints`);
  };
  const npmFolder = path.join(inst.root, 'lib', 'node_modules', 'npm');
  const mode = (file, bits) => {
    const before = fs.lstatSync(file).mode & 0o7777;
    fs.chmodSync(file, bits);
    return () => fs.chmodSync(file, before);
  };
  try {
    const control = run();
    assert.equal(control.line, '- Seatbelt: on (no account)', 'control: the untouched install works');
    assert.equal(statusRecords(ws).length, 1, 'control: one status child');
    // N2: npx-cli.js is only trusted at <node folder>/../lib/node_modules/npm/bin/npx-cli.js, with no link anywhere in that path.
    fs.renameSync(npmFolder, `${npmFolder}-moved`);
    refuse('pinned folder gone (bin/npx now dangles)');
    fs.renameSync(`${npmFolder}-moved`, npmFolder);
    const other = path.join(ws.base, 'other', 'npm');
    fs.mkdirSync(path.join(other, 'bin'), { recursive: true });
    plant(path.join(other, 'bin', 'npx-cli.js'), ws, 'other-npm');
    fs.renameSync(npmFolder, `${npmFolder}-moved`);
    fs.symlinkSync(other, npmFolder);
    refuse('lib/node_modules/npm is a link to another npm folder');
    fs.rmSync(npmFolder);
    fs.renameSync(`${npmFolder}-moved`, npmFolder);
    const script = inst.cli;
    const saved = fs.readFileSync(script);
    fs.rmSync(script);
    fs.symlinkSync(path.join(other, 'bin', 'npx-cli.js'), script);
    refuse('npx-cli.js is a link');
    fs.rmSync(script);
    fs.writeFileSync(script, saved, { mode: 0o755 });
    // bin/npx is not consulted: with the pinned file missing, a bin/npx that points at a good file elsewhere is not used.
    fs.renameSync(script, `${script}.moved`);
    fs.rmSync(inst.link);
    fs.symlinkSync(path.join(other, 'bin', 'npx-cli.js'), inst.link);
    refuse('bin/npx points elsewhere and the pinned file is missing');
    fs.rmSync(inst.link);
    fs.symlinkSync('../lib/node_modules/npm/bin/npx-cli.js', inst.link);
    // A folder named like the script, and a dangling link in its place.
    fs.mkdirSync(script);
    refuse('a folder, not a regular file');
    fs.rmdirSync(script);
    fs.symlinkSync(path.join(ws.base, 'does-not-exist'), script);
    refuse('dangling link');
    fs.rmSync(script);
    fs.renameSync(`${script}.moved`, script);
    assert.equal(run().line, '- Seatbelt: on (no account)', 'control after restoring N2');
    // N3: the script or any folder above it that group or others can write.
    for (const [label, target, bits] of [
      ['script group-writable', script, 0o775],
      ['script other-writable', script, 0o757],
      ['npm/bin group-writable', inst.npmBin, 0o775],
      ['lib/node_modules other-writable', path.join(inst.root, 'lib', 'node_modules'), 0o757],
      ['the install root group-writable', inst.root, 0o770],
      ['the install root sticky world-writable', inst.root, 0o1777],
    ]) {
      const restore = mode(target, bits);
      try {
        refuse(label);
      } finally {
        restore();
      }
    }
    assert.equal(run().line, '- Seatbelt: on (no account)', 'control after restoring N3');
    // N4: a node (or its script) under any node_modules/.bin folder, in any case.
    for (const hidden of ['node_modules/.bin', 'A/Node_Modules/.BIN']) {
      const nodeHere = path.join(ws.base, 'hid', hidden, 'node');
      const scriptHere = path.join(path.dirname(nodeHere), '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js');
      fs.mkdirSync(path.dirname(nodeHere), { recursive: true });
      fs.mkdirSync(path.dirname(scriptHere), { recursive: true });
      fs.linkSync(fakeNode().node, nodeHere);
      fs.copyFileSync(inst.cli, scriptHere);
      fs.rmSync(ws.record, { force: true });
      const result = doctor(ws, envFor(), { install: { node: nodeHere, bin: path.dirname(nodeHere), cli: scriptHere }, stub: false });
      assert.equal(result.line, '- Seatbelt: could not check', hidden);
      assert.deepEqual(statusRecords(ws), [], hidden);
    }
    // Changed by Cliff's ruling on X5: a node installed inside --cwd (the project folder) is no longer refused. The
    // location pin and the owner walk are what vouch for npm now, and both pass here.
    fs.rmSync(ws.record, { force: true });
    const inside = spawnSync(inst.node, [BIN, 'doctor', '--no-self-test', '--cwd', inst.root], { cwd: ws.base, env: { ...envFor(), CAPTURE_FILE: path.join(ws.base, 'cap'), NODE_OPTIONS: `--require=${RECORDER} --require=${HOST_FAKES}` }, encoding: 'utf8', timeout: 120000 });
    assert.match(inside.stdout, /\n- Seatbelt: on \(no account\)\n/, 'node installed inside --cwd now gives a real line');
    assert.equal(statusRecords(ws).length, 1);
  } finally {
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
    assert.equal(path.dirname(record.cwd), baseOf(ws.home), 'under the private base below the passwd home, not the temporary folder');
    assert.match(path.basename(record.cwd), /^marrow-install-seatbelt-/);
    assert.equal(record.cwdMode, 0o700);
    assert.equal(record.cwdEntries, 0, 'empty');
    assert.equal(record.cwd.startsWith(`${ws.project}${path.sep}`) || record.cwd === ws.project, false, 'not the project');
    assert.equal(fs.existsSync(record.cwd), false, 'removed after the run');
  } finally {
    ws.cleanup();
  }
});

test('R9 4b a package.json or a node_modules above the private folder (project, ancestor, the base itself) starts nothing', () => {
  const ws = workspace();
  try {
    // The passwd home below a project, below a folder with a node_modules, below a folder with a package.json.
    const cases = {
      'the project': path.join(ws.project, 'h'),
      'a folder with a node_modules': path.join(ws.base, 'a', 'h'),
      'a folder with a package.json': path.join(ws.base, 'b', 'h'),
    };
    fs.mkdirSync(path.join(ws.base, 'a', 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(ws.base, 'b'), { recursive: true });
    fs.writeFileSync(path.join(ws.base, 'b', 'package.json'), '{}\n');
    fs.writeFileSync(path.join(ws.project, 'package.json'), '{"name":"p","version":"1.0.0","private":true}\n');
    for (const [label, dir] of Object.entries(cases)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.rmSync(ws.record, { force: true });
      const run = doctor(ws, baseEnv(ws, { STATUS_TEST_PASSWD_HOME: dir }));
      assert.equal(run.line, '- Seatbelt: could not check', label);
      assert.deepEqual(statusRecords(ws), [], label);
      assert.deepEqual(fs.readdirSync(dir), [], `${label}: the private folder and every base part made for it were removed`);
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

// A stand-in for the file system calls the resolver makes: `real` maps a path to its real path (default: itself), `stat` gives
// {kind, uid, mode} for the paths that exist.
function fakeIo({ real = {}, stat, uid = 1000 }) {
  const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return {
    realpathSync: (value) => {
      if (value in real) return real[value];
      if (value in stat) return value;
      throw missing();
    },
    lstatSync: (value) => {
      if (!(value in stat)) throw missing();
      const { kind, uid: owner = 0, mode = kind === 'file' ? 0o755 : 0o755 } = stat[value];
      return { isFile: () => kind === 'file', isDirectory: () => kind === 'dir', isSymbolicLink: () => kind === 'link', uid: owner, mode };
    },
    getuid: () => uid,
  };
}
// stat entries for `file` and every folder above it (POSIX).
function chainOf(file, overrides = {}, owner = 0) {
  const entries = {};
  for (let current = file; ; current = path.posix.dirname(current)) {
    entries[current] = { kind: current === file ? 'file' : 'dir', uid: owner, mode: 0o755, ...(overrides[current] || {}) };
    if (current === '/') return entries;
  }
}

test('trusted npx: the pinned layouts of nvm, the official tarball, Homebrew and Debian resolve; every error gives null', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-layouts-')));
  try {
    // <prefix>/bin/node with <prefix>/lib/node_modules/npm/bin/npx-cli.js: nvm, the tarball, Homebrew (real folders, on disk).
    const prefix = path.join(root, 'prefix');
    const script = path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js');
    fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, '// npx\n');
    fs.writeFileSync(path.join(prefix, 'bin', 'node'), '');
    assert.equal(resolveTrustedNpx({ execPath: path.join(prefix, 'bin', 'node') }), script, 'no bin/npx needed');
    // The current folder and the project folder are not consulted any more (Cliff's ruling on X5): the install may be anywhere
    // the pin and the owner walk accept, also below the folder doctor was started in.
    const original = process.cwd();
    try {
      process.chdir(prefix);
      assert.equal(resolveTrustedNpx({ execPath: path.join(prefix, 'bin', 'node') }), script, 'node installed inside the current folder');
    } finally {
      process.chdir(original);
    }
    // Errors give null: relative execPath, no node folder, a node folder without the pinned script.
    assert.equal(resolveTrustedNpx({ execPath: 'node' }), null);
    assert.equal(resolveTrustedNpx({ execPath: path.join(root, 'missing', 'node') }), null);
    fs.mkdirSync(path.join(root, 'bare', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'bare', 'bin', 'node'), '');
    assert.equal(resolveTrustedNpx({ execPath: path.join(root, 'bare', 'bin', 'node') }), null, 'no pinned script');
    // A link in the pinned path is refused, and so is a node or script below a node_modules/.bin folder (any depth, any case).
    fs.mkdirSync(path.join(root, 'linked', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(root, 'linked', 'lib', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(root, 'linked', 'bin', 'node'), '');
    fs.symlinkSync(path.join(prefix, 'lib', 'node_modules', 'npm'), path.join(root, 'linked', 'lib', 'node_modules', 'npm'));
    assert.equal(resolveTrustedNpx({ execPath: path.join(root, 'linked', 'bin', 'node') }), null, 'npm folder is a link');
    for (const hidden of ['node_modules/.bin', 'a/Node_Modules/.BIN/b']) {
      const bin = path.join(root, 'hid', hidden);
      fs.mkdirSync(path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin'), { recursive: true });
      fs.writeFileSync(path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js'), '// npx\n');
      fs.mkdirSync(bin, { recursive: true });
      fs.writeFileSync(path.join(bin, 'node'), '');
      assert.equal(resolveTrustedNpx({ execPath: path.join(bin, 'node') }), null, hidden);
    }
    // A node that is itself a link into a node_modules/.bin folder is refused by its real path.
    const hiddenBin = path.join(root, 'proj', 'node_modules', '.bin');
    fs.mkdirSync(hiddenBin, { recursive: true });
    fs.writeFileSync(path.join(hiddenBin, 'node'), '');
    fs.rmSync(path.join(prefix, 'bin', 'node'));
    fs.symlinkSync(path.join(hiddenBin, 'node'), path.join(prefix, 'bin', 'node'));
    assert.equal(resolveTrustedNpx({ execPath: path.join(prefix, 'bin', 'node') }), null, 'node links into node_modules/.bin');
    // The seam of the resolver is not reachable from the CLI or the environment: statusInvocation passes none, and the defaults read process.execPath.
    assert.equal(statusInvocation({ version: '3.9.104', execPath: path.join(prefix, 'bin', 'node') }) === null, true, 'the link refusal holds through statusInvocation');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('N5 trusted npx, Debian: /usr/bin/node accepts /usr/share/nodejs/npm/bin/npx-cli.js and the pin; nothing else', () => {
  const debian = '/usr/share/nodejs/npm/bin/npx-cli.js';
  const pin = '/usr/lib/node_modules/npm/bin/npx-cli.js';
  const base = { ...chainOf(debian), '/usr/bin': { kind: 'dir', uid: 0, mode: 0o755 }, '/usr/bin/node': { kind: 'file', uid: 0, mode: 0o755 } };
  const resolve = (execPath, stat, real = {}, uid = 1000) => resolveTrustedNpx({ execPath, platform: 'linux', io: fakeIo({ stat, real, uid }) });
  assert.equal(resolve('/usr/bin/node', base), debian, 'Debian layout');
  assert.equal(resolve('/usr/local/bin/node', { ...base, '/usr/local/bin': { kind: 'dir' }, '/usr/local/bin/node': { kind: 'file' } }), null, 'the Debian script is only for /usr/bin/node');
  assert.equal(resolve('/opt/node/bin/node', { ...base, '/opt/node/bin': { kind: 'dir' }, '/opt/node/bin/node': { kind: 'file' } }), null, 'another node: not the Debian script');
  assert.equal(resolve('/usr/bin/node', { ...base, '/usr/share/nodejs/npm': { kind: 'link', uid: 0 } }), null, 'a link in the Debian path');
  assert.equal(resolve('/usr/bin/node', { ...base }, { [debian]: '/srv/npm/bin/npx-cli.js' }), null, 'the script resolves elsewhere');
  assert.equal(resolve('/usr/bin/node', { ...base, [debian]: { kind: 'link', uid: 0 } }), null, 'the script is a link');
  assert.equal(resolve('/usr/bin/node', { ...base, [debian]: { kind: 'dir', uid: 0 } }), null, 'a folder, not a file');
  // The pin is tried first and, when it fails, the Debian script is still checked on its own.
  assert.equal(resolve('/usr/bin/node', { ...base, ...chainOf(pin) }), pin, 'the pin wins when both exist');
  assert.equal(resolve('/usr/bin/node', { ...base, ...chainOf(pin, { '/usr/lib': { mode: 0o775 } }) }), debian, 'a failing pin does not hide a good Debian script');
  // Owner walk: every folder up to / and the script.
  const walk = (overrides, uid = 1000) => resolve('/usr/bin/node', { ...base, ...chainOf(debian, overrides) }, {}, uid);
  assert.equal(walk({}), debian, 'root-owned, not writable by others');
  assert.equal(walk({ '/usr/share': { mode: 0o775 } }), null, 'a group-writable folder above');
  assert.equal(walk({ '/usr': { mode: 0o757 } }), null, 'an other-writable folder above');
  assert.equal(walk({ '/': { mode: 0o777 } }), null, 'root folder writable');
  assert.equal(walk({ '/usr/share/nodejs': { mode: 0o1777 } }), null, 'sticky and world-writable never qualifies');
  assert.equal(walk({ [debian]: { mode: 0o775 } }), null, 'script group-writable');
  assert.equal(walk({ [debian]: { mode: 0o757 } }), null, 'script other-writable');
  assert.equal(walk({ '/usr/share/nodejs/npm': { uid: 4242 } }), null, 'a folder owned by another user');
  assert.equal(walk({ [debian]: { uid: 4242 } }), null, 'the script owned by another user');
  assert.equal(walk({ '/usr/share': { uid: 1000 } }), debian, 'a folder owned by the running user passes');
  assert.equal(walk({ '/usr/share': { uid: 1000 } }, 0), null, 'run as root: a folder owned by a user is refused');
  assert.equal(walk({ '/usr/share': { uid: 1000 } }, 2000), null, 'owned by a third user');
  assert.equal(walk({ '/usr/share': { kind: 'link' } }), null, 'a link above the script');
  assert.equal(resolve('/usr/bin/node', { ...base, [debian]: undefined }), null, 'missing script');
  assert.equal(resolveTrustedNpx({ execPath: '/usr/bin/node', platform: 'linux', io: { ...fakeIo({ stat: base }), lstatSync: () => { throw new Error('EACCES'); } } }), null, 'any lstat error');
  assert.equal(resolveTrustedNpx({ execPath: '/usr/bin/node', platform: 'linux', io: { ...fakeIo({ stat: base }), getuid: () => undefined } }), null, 'no uid');
});

test('N6 trusted npx, Windows: <node folder>\\node_modules\\npm\\bin\\npx-cli.js, case-insensitive, regular file, no owner walk', () => {
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const script = 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js';
  const stat = { 'C:\\Program Files\\nodejs': { kind: 'dir' }, [node]: { kind: 'file' }, [script]: { kind: 'file', uid: 99999, mode: 0o777 } };
  const resolve = (execPath, io) => resolveTrustedNpx({ execPath, platform: 'win32', io: { getuid: () => { throw new Error('no owner walk on Windows'); }, ...io } });
  assert.equal(resolve(node, fakeIo({ stat })), script, 'resolves; the owner and mode of the files are not read');
  const upper = 'C:\\PROGRAM FILES\\nodejs\\NODE_MODULES\\npm\\bin\\NPX-CLI.JS';
  assert.equal(resolve(node, fakeIo({ stat: { ...stat, [upper]: { kind: 'file' } }, real: { [script]: upper } })), upper, 'real path in another case: the same place');
  assert.equal(resolve(node, fakeIo({ stat, real: { [script]: 'D:\\other\\npm\\bin\\npx-cli.js' } })), null, 'the script resolves elsewhere (a link)');
  assert.equal(resolve(node, fakeIo({ stat: { ...stat, [script]: { kind: 'dir' } } })), null, 'a folder');
  assert.equal(resolve(node, fakeIo({ stat: { ...stat, [script]: { kind: 'link' } } })), null, 'a link');
  assert.equal(resolve(node, fakeIo({ stat: { ...stat, [script]: undefined } })), null, 'missing');
  assert.equal(resolve('C:\\proj\\Node_Modules\\.BIN\\node.exe', fakeIo({ stat: { 'C:\\proj\\Node_Modules\\.BIN': { kind: 'dir' }, 'C:\\proj\\Node_Modules\\.BIN\\node.exe': { kind: 'file' }, 'C:\\proj\\Node_Modules\\node_modules\\npm\\bin\\npx-cli.js': { kind: 'file' } } })), null, 'node under node_modules\\.bin');
  assert.equal(resolve('node.exe', fakeIo({ stat })), null, 'relative execPath');
  assert.equal(resolve(node, { realpathSync: () => { throw new Error('EPERM'); } }), null, 'any error');
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

// ---- PATCH2-BASE: the private base under the passwd home, checked from / down, before anything runs ----

const hostFakes = require('./support/status-host-fakes');

const mode7 = (file) => fs.lstatSync(file).mode & 0o7777;
const countLines = (ws) => statusRecords(ws).length;

// What every status child record must show: the doctor's own node and the pinned script, the exact pinned argv, a private
// folder directly below <passwd home>/.cache/marrow/doctor-tmp (mode 700, empty, gone after) and exactly these env names.
function assertRecord(record, { node, script, home, names }) {
  assert.equal(record.execPath, node, 'the doctor\'s own node');
  assert.equal(record.script, fs.realpathSync(script), 'npm\'s script at its pinned place');
  assert.deepEqual(record.argv, PIN_ARGV);
  assert.equal(path.dirname(record.cwd), baseOf(home), 'directly below the base');
  assert.match(path.basename(record.cwd), /^marrow-install-seatbelt-/);
  assert.equal(record.cwdMode, 0o700);
  assert.equal(record.cwdEntries, 0);
  assert.equal(fs.existsSync(record.cwd), false, 'removed after the run');
  assert.deepEqual(record.envNames, [...names].sort());
  assert.equal(record.envPath.split(path.delimiter)[0], path.dirname(fs.realpathSync(node)), 'the real node folder first');
}
const couldNotCheck = (ws, label, env = baseEnv(ws), options = {}) => {
  fs.rmSync(ws.record, { force: true });
  const run = doctor(ws, env, options);
  assert.equal(run.result.status, 0, `${label}: ${run.text}`);
  assert.equal(run.line, '- Seatbelt: could not check', label);
  assert.equal(countLines(ws), 0, `${label}: no status child`);
  assert.deepEqual(plantedRuns(ws), [], `${label}: nothing planted ran`);
  assert.match(run.text, /\n- Marrow active: /, `${label}: the rest of doctor still prints`);
  return run;
};

test('B0 the happy path: the child runs in <passwd home>/.cache/marrow/doctor-tmp/marrow-install-seatbelt-*, mode 700, empty; it and every base part the run made are removed after', () => {
  const ws = workspace();
  try {
    const run = doctor(ws, baseEnv(ws));
    assert.equal(run.result.status, 0, run.text);
    assert.equal(run.line, '- Seatbelt: on (no account)');
    const [record, ...more] = statusRecords(ws);
    assert.equal(more.length, 0);
    assertRecord(record, { node: fakeNode().node, script: fakeNode().cli, home: ws.home, names: ['HOME', 'PATH'] });
    // Doctor is read-only: the run made .cache, .cache/marrow and the base for its child and removed them again.
    assert.deepEqual(fs.readdirSync(ws.home), []);
    // With the base already there the run reuses it and leaves every part as it found it (it removes only what it made).
    makeBase(ws.home);
    fs.rmSync(ws.record);
    assert.equal(doctor(ws, baseEnv(ws)).line, '- Seatbelt: on (no account)');
    for (const part of [path.join(ws.home, '.cache'), path.join(ws.home, '.cache', 'marrow'), baseOf(ws.home)]) assert.equal(mode7(part), 0o700, part);
    assert.deepEqual(fs.readdirSync(ws.home), ['.cache']);
    assert.deepEqual(fs.readdirSync(path.join(ws.home, '.cache')), ['marrow']);
    assert.deepEqual(fs.readdirSync(path.join(ws.home, '.cache', 'marrow')), ['doctor-tmp']);
    assert.deepEqual(fs.readdirSync(baseOf(ws.home)), []);
    assert.equal(fs.lstatSync(baseOf(ws.home)).uid, process.getuid());
  } finally {
    ws.cleanup();
  }
});

test('B1 TMPDIR is not used on POSIX: a world-writable TMPDIR holding a project, a planted package, a planted node and a registry config is never reached', () => {
  const ws = workspace();
  try {
    const shared = path.join(ws.base, 'shared-tmp');
    fs.mkdirSync(shared);
    fs.chmodSync(shared, 0o1777);
    const dummy = rnd(24);
    fs.writeFileSync(path.join(shared, `.${'npm'}rc`), 'registry=http://127.0.0.1:9/\n');
    fs.writeFileSync(path.join(shared, 'package.json'), '{"name":"hostile","version":"1.0.0","private":true,"workspaces":["*"]}\n');
    const planted = path.join(shared, 'node_modules', '@getmarrow', 'mcp');
    fs.mkdirSync(path.join(planted, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(planted, 'package.json'), JSON.stringify({ name: '@getmarrow/mcp', version: PINS.MCP_ADAPTER_VERSION, bin: { 'marrow-mcp': 'bin/cli.js' } }));
    plant(path.join(planted, 'bin', 'cli.js'), ws, 'planted-mcp');
    plant(path.join(shared, 'node_modules', '.bin', 'node'), ws, 'planted-node');
    plant(path.join(shared, 'node_modules', '.bin', 'npx'), ws, 'planted-npx');
    for (const variant of ['plain package.json', 'workspaces package.json']) {
      if (variant === 'plain package.json') fs.writeFileSync(path.join(shared, 'package.json'), '{"name":"hostile","version":"1.0.0","private":true}\n');
      fs.rmSync(ws.record, { force: true });
      const run = doctor(ws, baseEnv(ws, { TMPDIR: shared, MARROW_API_KEY: dummy }));
      assert.equal(run.result.status, 0, `${variant}: ${run.text}`);
      assert.equal(run.line, '- Seatbelt: account mode (using your Marrow key)', variant);
      assert.deepEqual(plantedRuns(ws), [], `${variant}: no plant used`);
      const [record] = statusRecords(ws);
      assertRecord(record, { node: fakeNode().node, script: fakeNode().cli, home: ws.home, names: ['HOME', 'MARROW_API_KEY', 'PATH', 'TMPDIR'] });
      assert.equal(record.cwd.startsWith(`${shared}${path.sep}`), false, `${variant}: cwd not under TMPDIR`);
      assert.equal(JSON.stringify(record).includes(dummy) || run.text.includes(dummy), false, 'key 0');
    }
  } finally {
    ws.cleanup();
  }
});

test('B3 a group- or other-writable ancestor of the base, a link as the base or as .cache, and a pre-existing base with another mode', () => {
  const ws = workspace();
  try {
    makeBase(ws.home);
    assert.equal(doctor(ws, baseEnv(ws)).line, '- Seatbelt: on (no account)', 'control: uses the base');
    const cache = path.join(ws.home, '.cache');
    const marrow = path.join(cache, 'marrow');
    const base = baseOf(ws.home);
    for (const [label, target, bits] of [
      ['.cache group-writable', cache, 0o770],
      ['.cache other-writable', cache, 0o702],
      ['.cache/marrow group-writable', marrow, 0o770],
      ['.cache/marrow other-writable', marrow, 0o707],
      ['.cache sticky and world-writable', cache, 0o1777],
    ]) {
      const before = mode7(target);
      fs.chmodSync(target, bits);
      try {
        couldNotCheck(ws, label);
        assert.deepEqual(fs.readdirSync(base), [], `${label}: nothing left in the base`);
      } finally {
        fs.chmodSync(target, before);
      }
    }
    assert.equal(doctor(ws, baseEnv(ws)).line, '- Seatbelt: on (no account)', 'control after restoring');
    // The base is a link (to an empty folder of the user's own), and .cache is a link to a 1777 folder.
    const real = path.join(ws.base, 'real-base');
    fs.mkdirSync(real, { mode: 0o700 });
    fs.rmdirSync(base);
    fs.symlinkSync(real, base);
    couldNotCheck(ws, 'the base is a link');
    assert.deepEqual(fs.readdirSync(real), [], 'nothing was made behind the link');
    fs.rmSync(base);
    fs.mkdirSync(base, { mode: 0o700 });
    const shared = path.join(ws.base, 'shared-tmp');
    fs.mkdirSync(shared);
    fs.chmodSync(shared, 0o1777);
    fs.mkdirSync(path.join(shared, 'marrow', 'doctor-tmp'), { recursive: true });
    fs.renameSync(cache, `${cache}-moved`);
    fs.symlinkSync(shared, cache);
    couldNotCheck(ws, '.cache is a link to a world-writable folder');
    assert.deepEqual(fs.readdirSync(path.join(shared, 'marrow', 'doctor-tmp')), [], 'nothing was made behind the link');
    fs.rmSync(cache);
    fs.renameSync(`${cache}-moved`, cache);
    // A file where the base should be.
    fs.rmdirSync(base);
    fs.writeFileSync(base, '');
    couldNotCheck(ws, 'a file in place of the base');
    fs.rmSync(base);
    // A pre-existing base owned by the user with another mode ends as 700 and works.
    for (const bits of [0o755, 0o775, 0o777, 0o500]) {
      fs.mkdirSync(base, { mode: 0o700 });
      fs.chmodSync(base, bits);
      fs.rmSync(ws.record, { force: true });
      const run = doctor(ws, baseEnv(ws));
      assert.equal(run.line, '- Seatbelt: on (no account)', `base ${bits.toString(8)}: ${run.text}`);
      assert.equal(mode7(base), 0o700, `base ${bits.toString(8)} ends 700`);
      assert.equal(countLines(ws), 1);
      fs.rmdirSync(base);
    }
  } finally {
    ws.cleanup();
  }
});

test('B4 HOME pointing elsewhere does not move the base: it stays under the passwd home and nothing is made under HOME', () => {
  const ws = workspace();
  try {
    const elsewhere = path.join(ws.base, 'elsewhere-home');
    fs.mkdirSync(elsewhere, { mode: 0o700 });
    const run = doctor(ws, baseEnv(ws, { HOME: elsewhere, STATUS_TEST_PASSWD_HOME: ws.home }));
    assert.equal(run.result.status, 0, run.text);
    assert.equal(run.line, '- Seatbelt: on (no account)');
    const [record] = statusRecords(ws);
    assertRecord(record, { node: fakeNode().node, script: fakeNode().cli, home: ws.home, names: ['HOME', 'PATH'] });
    assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing created under HOME');
    assert.deepEqual(fs.readdirSync(ws.home), [], 'the base was made under the passwd home and removed again');
  } finally {
    ws.cleanup();
  }
});

test('B5 B6 a group- or other-writable passwd home, and a passwd lookup that throws: could not check, nothing created (relative and empty homes: the in-process test below)', () => {
  const ws = workspace();
  try {
    for (const bits of [0o770, 0o707]) {
      fs.chmodSync(ws.home, bits);
      couldNotCheck(ws, `passwd home ${bits.toString(8)}`);
      assert.deepEqual(fs.readdirSync(ws.home), [], `passwd home ${bits.toString(8)}: nothing created below it`);
    }
    fs.chmodSync(ws.home, 0o700);
    couldNotCheck(ws, 'passwd lookup throws', baseEnv(ws, { STATUS_TEST_PASSWD_HOME: '!throw' }));
    assert.deepEqual(fs.readdirSync(ws.home), [], 'nothing created');
    assert.equal(doctor(ws, baseEnv(ws)).line, '- Seatbelt: on (no account)', 'control after restoring');
  } finally {
    ws.cleanup();
  }
});

test('B7 B8 a node_modules/.bin/node, a package.json (plain, workspaces) or a node_modules in the passwd home: could not check, nothing spawned, nothing run', () => {
  const ws = workspace();
  try {
    plant(path.join(ws.home, 'node_modules', '.bin', 'node'), ws, 'planted-node');
    couldNotCheck(ws, 'B7 a user-owned node_modules/.bin/node in the passwd home');
    fs.rmSync(path.join(ws.home, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(ws.home, 'package.json'), '{"name":"home","version":"1.0.0"}\n');
    couldNotCheck(ws, 'B8 a plain package.json in the passwd home');
    fs.writeFileSync(path.join(ws.home, 'package.json'), '{"name":"home","version":"1.0.0","workspaces":["*"]}\n');
    couldNotCheck(ws, 'B8 a package.json with workspaces in the passwd home');
    fs.rmSync(path.join(ws.home, 'package.json'));
    fs.mkdirSync(path.join(ws.home, 'node_modules'));
    couldNotCheck(ws, 'B8 an empty node_modules in the passwd home');
    fs.rmdirSync(path.join(ws.home, 'node_modules'));
    fs.symlinkSync(ws.base, path.join(ws.home, 'node_modules'));
    couldNotCheck(ws, 'B8 a node_modules link in the passwd home');
    fs.rmSync(path.join(ws.home, 'node_modules'));
    assert.equal(doctor(ws, baseEnv(ws)).line, '- Seatbelt: on (no account)', 'control after removing them');
  } finally {
    ws.cleanup();
  }
});

test('B9 a package.json or a node_modules in the base itself (the direct parent) or in .cache (two levels up): could not check, the private folder removed', () => {
  const ws = workspace();
  try {
    makeBase(ws.home);
    assert.equal(doctor(ws, baseEnv(ws)).line, '- Seatbelt: on (no account)', 'control: uses the base');
    const base = baseOf(ws.home);
    const cache = path.join(ws.home, '.cache');
    for (const [where, label] of [[base, 'the base'], [cache, '.cache']]) {
      for (const kind of ['package.json', 'workspaces package.json', 'node_modules', 'node_modules/.bin/node']) {
        if (kind === 'package.json') fs.writeFileSync(path.join(where, 'package.json'), '{}\n');
        else if (kind === 'workspaces package.json') fs.writeFileSync(path.join(where, 'package.json'), '{"workspaces":["*"]}\n');
        else if (kind === 'node_modules') fs.mkdirSync(path.join(where, 'node_modules'));
        else plant(path.join(where, 'node_modules', '.bin', 'node'), ws, 'planted-node');
        couldNotCheck(ws, `${label} holds ${kind}`);
        assert.deepEqual(fs.readdirSync(base).filter((name) => name.startsWith('marrow-install-seatbelt-')), [], `${label} ${kind}: the private folder was removed`);
        fs.rmSync(path.join(where, 'package.json'), { force: true });
        fs.rmSync(path.join(where, 'node_modules'), { recursive: true, force: true });
      }
    }
    assert.equal(doctor(ws, baseEnv(ws)).line, '- Seatbelt: on (no account)', 'control after removing them');
  } finally {
    ws.cleanup();
  }
});

test('N1 a node installed under the passwd home (nvm) and doctor started from the home folder: a real Seatbelt line', () => {
  const ws = workspace();
  try {
    const nvm = extraInstall(path.join(ws.home, '.nvm', 'versions', 'node', 'v22.0.0'));
    writeStub(nvm, ws.record);
    const env = { ...baseEnv(ws), PATH: `${nvm.bin}${path.delimiter}/usr/bin${path.delimiter}/bin` };
    const run = doctor(ws, env, { install: nvm, cwd: ws.home, stub: false });
    assert.equal(run.result.status, 0, run.text);
    assert.equal(run.line, '- Seatbelt: on (no account)', 'a real line, not "could not check"');
    const [record] = statusRecords(ws);
    assertRecord(record, { node: nvm.node, script: nvm.cli, home: ws.home, names: ['HOME', 'PATH'] });
    // The same layout with a package.json directly in the home folder: refused (4b), nothing spawned.
    fs.writeFileSync(path.join(ws.home, 'package.json'), '{}\n');
    couldNotCheck(ws, 'N1 with a package.json in the home', env, { install: nvm, cwd: ws.home, stub: false });
  } finally {
    ws.cleanup();
  }
});

test('the child PATH starts with the folder of the REAL node binary, also when execPath is a link', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-pathreal-')));
  try {
    fs.mkdirSync(path.join(root, 'real', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(root, 'linkdir'));
    fs.writeFileSync(path.join(root, 'real', 'bin', 'node'), '');
    fs.symlinkSync(path.join(root, 'real', 'bin', 'node'), path.join(root, 'linkdir', 'node'));
    const env = buildStatusEnv({ PATH: '/usr/bin:/bin' }, { execPath: path.join(root, 'linkdir', 'node'), platform: 'linux' });
    assert.equal(env.PATH, `${path.join(root, 'real', 'bin')}:/usr/bin:/bin`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the Windows branch keeps the per-user temp folder and touches nothing; the POSIX branch is the checked base', () => {
  const touched = [];
  const names = ['lstatSync', 'mkdirSync', 'mkdtempSync', 'realpathSync', 'openSync', 'chmodSync'];
  const saved = Object.fromEntries(names.map((name) => [name, fs[name]]));
  try {
    for (const name of names) fs[name] = (...args) => { touched.push(name); return saved[name](...args); };
    assert.equal(statusParentFolder('win32'), os.tmpdir());
  } finally {
    for (const name of names) fs[name] = saved[name];
  }
  assert.deepEqual(touched, [], 'no file system call on the win32 branch');
  // statusParentFolder makes the base and leaves it (runSeatbeltStatus is what removes what it made): use a throwaway passwd home.
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-seatbelt-parent-')));
  const original = process.env.HOME;
  try {
    fs.chmodSync(home, 0o700);
    hostFakes.setPasswdHome(home);
    assert.equal(statusParentFolder('linux'), baseOf(home), 'the POSIX base is below the passwd home');
  } finally {
    hostFakes.setPasswdHome(original);
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the passwd home is os.userInfo().homedir, never $HOME: a lookup failure, an empty or a relative home gives null', () => {
  const home = process.env.HOME;
  const original = hostFakes.realPasswdHome();
  const passwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-seatbelt-passwd-')));
  try {
    fs.chmodSync(passwd, 0o700);
    hostFakes.setPasswdHome(passwd);
    process.env.HOME = path.join(os.tmpdir(), 'not-the-passwd-home');
    assert.equal(statusParentFolder('linux'), baseOf(passwd), 'HOME changed: the base did not move');
    for (const bad of ['!throw', '', 'relative/home']) {
      hostFakes.setPasswdHome(bad);
      assert.equal(statusParentFolder('linux'), null, JSON.stringify(bad));
    }
  } finally {
    process.env.HOME = home;
    hostFakes.setPasswdHome(home);
    fs.rmSync(passwd, { recursive: true, force: true });
  }
  assert.ok(original === null || typeof original === 'string');
});

test('the test guard: a write under the real passwd home throws and is counted; nothing else tripped it', () => {
  const real = hostFakes.realPasswdHome();
  if (real === null) return;
  const before = hostFakes.guardSelfTestTrips();
  assert.throws(() => fs.mkdirSync(path.join(real, `guard-selftest-${rnd(4)}`)), /test touched the real passwd home/);
  assert.throws(() => fs.mkdtempSync(path.join(real, 'guard-selftest-')), /test touched the real passwd home/);
  assert.throws(() => fs.writeFileSync(path.join(real, `guard-selftest-${rnd(4)}`), ''), /test touched the real passwd home/);
  assert.equal(hostFakes.guardSelfTestTrips(), before + 3);
  assert.equal(hostFakes.guardTrips(), 0, 'no real trip in this process');
});

// ---- WHY: when the home or cache folder chain is unsafe, doctor says which folder and why (and the one command) ----
//
// The refusal itself is the one of PATCH2-BASE above and does not change: same refusals, no status child, nothing created,
// exit 0, the same first line and the same JSON. Only one more printed line appears, from what the refusing walk saw.

const WHY = '  Doctor skipped this check: ';
const MISSING_ENV = /^- missing env: /;

function seatbeltBlock(run) {
  const lines = (run.result.stdout || '').split('\n');
  const at = lines.findIndex((entry) => entry.startsWith('- Seatbelt:'));
  assert.ok(at > 0, `a Seatbelt line: ${run.text}`);
  return { lines, at, first: lines[at], next: lines[at + 1] };
}

// What is on disk below `top`: type, mode, owner and link target of every entry (no inode, no content).
function listTree(top) {
  const rows = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const stat = fs.lstatSync(full);
      const rel = path.relative(top, full);
      if (stat.isSymbolicLink()) rows.push(`${rel} link -> ${fs.readlinkSync(full)}`);
      else if (stat.isDirectory()) {
        rows.push(`${rel} dir ${(stat.mode & 0o7777).toString(8)} ${stat.uid}`);
        walk(full);
      } else rows.push(`${rel} file ${(stat.mode & 0o7777).toString(8)} ${stat.uid} ${stat.size}`);
    }
  };
  walk(top);
  return rows;
}

// A refused run as couldNotCheck checks it (exit 0, first line, no status child, nothing planted ran), the home and the
// project left exactly as they were, and the line after the Seatbelt line equal to `expected` (null: no extra line).
function refusedWith(ws, label, expected, env = baseEnv(ws), options = {}) {
  const homeBefore = listTree(ws.base).filter((row) => !/^(record\.jsonl|capture\.jsonl|planted\.log)/.test(row));
  const run = couldNotCheck(ws, label, env, options);
  const { next, lines } = seatbeltBlock(run);
  if (expected === null) assert.match(next, MISSING_ENV, `${label}: no extra line, the next line is "- missing env"`);
  else assert.equal(next, expected, label);
  assert.equal(lines.filter((entry) => entry.startsWith(WHY)).length, expected === null ? 0 : 1, `${label}: at most one extra line`);
  assert.equal(listTree(ws.base).filter((row) => !/^(record\.jsonl|capture\.jsonl|planted\.log)/.test(row)).join('\n'), homeBefore.join('\n'), `${label}: nothing created, removed or changed`);
  assert.equal(/\bchown\b|\bsudo\b/.test(run.text), false, `${label}: never chown or sudo`);
  return run;
}

test('M1 why: .cache, .cache/marrow or the home writable by group or others: the folder, "writable by other users" and `chmod go-w <path>`; the printed command fixes it', () => {
  const ws = workspace();
  try {
    const targets = [
      ['.cache', path.join(ws.home, '.cache')],
      ['.cache/marrow', path.join(ws.home, '.cache', 'marrow')],
      ['the home', ws.home],
    ];
    for (const withBase of [true, false]) {
      for (const [label, target] of targets) {
        if (!withBase && label === '.cache/marrow') continue;
        for (const bits of [0o770, 0o702, 0o707, 0o777, 0o1777]) {
          if (withBase) makeBase(ws.home);
          else if (label === '.cache') fs.mkdirSync(path.join(ws.home, '.cache'), { mode: 0o700 });
          const before = mode7(target);
          fs.chmodSync(target, bits);
          try {
            refusedWith(ws, `${label} ${bits.toString(8)} (base ${withBase ? 'present' : 'absent'})`, `${WHY}${target} is writable by other users. Fix: chmod go-w ${target}`);
          } finally {
            fs.chmodSync(target, before);
          }
          fs.rmSync(path.join(ws.home, '.cache'), { recursive: true, force: true });
        }
      }
    }
    // The command, pasted as printed, fixes it: the next doctor runs the check.
    for (const [label, target] of targets) {
      makeBase(ws.home);
      fs.chmodSync(target, 0o777);
      const run = refusedWith(ws, `${label}: fix`, `${WHY}${target} is writable by other users. Fix: chmod go-w ${target}`);
      const command = seatbeltBlock(run).next.split(' Fix: ')[1];
      assert.equal(command, `chmod go-w ${target}`);
      const pasted = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
      assert.equal(pasted.status, 0, `${label}: ${pasted.stderr}`);
      assert.equal(mode7(target) & 0o022, 0, `${label}: group and others cannot write now`);
      fs.rmSync(ws.record, { force: true });
      assert.equal(doctor(ws, baseEnv(ws)).line, '- Seatbelt: on (no account)', `${label}: after the fix the check runs`);
      fs.chmodSync(target, 0o700);
      fs.rmSync(path.join(ws.home, '.cache'), { recursive: true, force: true });
    }
    // The only difference from a normal doctor is that one line.
    makeBase(ws.home);
    const normal = doctor(ws, baseEnv(ws));
    fs.chmodSync(path.join(ws.home, '.cache'), 0o777);
    const refused = couldNotCheck(ws, 'diff');
    const strip = (run) => (run.result.stdout || '').split('\n').filter((entry) => !entry.startsWith('- Seatbelt:') && !entry.startsWith(WHY));
    assert.deepEqual(strip(refused), strip(normal), 'every other line of doctor is the same');
  } finally {
    ws.cleanup();
  }
});

test('M2 why: a link says "is a link" (no command); a file in the way and every other refusal print no extra line', () => {
  const ws = workspace();
  try {
    const cache = path.join(ws.home, '.cache');
    const marrow = path.join(cache, 'marrow');
    const base = baseOf(ws.home);
    makeBase(ws.home);
    const real = path.join(ws.base, 'real-base');
    fs.mkdirSync(real, { mode: 0o700 });
    fs.rmdirSync(base);
    fs.symlinkSync(real, base);
    refusedWith(ws, 'the base is a link', `${WHY}${base} is a link.`);
    fs.rmSync(base);
    // .cache is a link to a world-writable folder: named as a link, not as writable.
    const shared = path.join(ws.base, 'shared-tmp');
    fs.mkdirSync(shared);
    fs.chmodSync(shared, 0o1777);
    fs.mkdirSync(path.join(shared, 'marrow', 'doctor-tmp'), { recursive: true });
    fs.renameSync(cache, `${cache}-moved`);
    fs.symlinkSync(shared, cache);
    refusedWith(ws, '.cache is a link to a 1777 folder', `${WHY}${cache} is a link.`);
    fs.rmSync(cache);
    fs.symlinkSync(path.join(ws.base, 'nowhere'), cache);
    refusedWith(ws, '.cache is a dangling link', `${WHY}${cache} is a link.`);
    fs.rmSync(cache);
    fs.renameSync(`${cache}-moved`, cache);
    // .cache/marrow is a link.
    fs.renameSync(marrow, `${marrow}-moved`);
    fs.symlinkSync(`${marrow}-moved`, marrow);
    refusedWith(ws, '.cache/marrow is a link', `${WHY}${marrow} is a link.`);
    fs.rmSync(marrow);
    fs.renameSync(`${marrow}-moved`, marrow);
    // A file in place of the base or of .cache: no reason of the three, so the first line stands alone.
    fs.writeFileSync(base, '');
    refusedWith(ws, 'a file in place of the base', null);
    fs.rmSync(base);
    fs.rmSync(cache, { recursive: true });
    fs.writeFileSync(cache, '');
    refusedWith(ws, 'a file in place of .cache', null);
    fs.rmSync(cache);
    // Refusals that are not about the base walk: a package.json in the home, a passwd lookup that throws, an npm folder others can write.
    fs.writeFileSync(path.join(ws.home, 'package.json'), '{"name":"x","private":true}\n');
    refusedWith(ws, 'a package.json in the home', null);
    fs.rmSync(path.join(ws.home, 'package.json'));
    refusedWith(ws, 'passwd lookup throws', null, baseEnv(ws, { STATUS_TEST_PASSWD_HOME: '!throw' }));
    const npmFolder = path.dirname(fakeNode().cli);
    fs.chmodSync(npmFolder, 0o770);
    try {
      refusedWith(ws, 'npm folder group-writable', null);
    } finally {
      fs.chmodSync(npmFolder, 0o755);
    }
    // Control: a normal run has its line and no extra one.
    fs.rmSync(ws.record, { force: true });
    const run = doctor(ws, baseEnv(ws));
    assert.equal(run.line, '- Seatbelt: on (no account)');
    assert.match(seatbeltBlock(run).next, MISSING_ENV);
  } finally {
    ws.cleanup();
  }
});

test('M3 why: a folder owned by another user says so (no command, no chown, no sudo), also when it is writable too', () => {
  const ws = workspace();
  try {
    makeBase(ws.home);
    const cache = path.join(ws.home, '.cache');
    const marrow = path.join(cache, 'marrow');
    const base = baseOf(ws.home);
    for (const [label, target] of [['.cache', cache], ['.cache/marrow', marrow], ['the base', base], ['the home', ws.home], ['the folder above the home', ws.base]]) {
      refusedWith(ws, `${label} owned by another uid`, `${WHY}${target} is owned by another user.`, baseEnv(ws, { STATUS_TEST_FAKE_OWNER: target }));
    }
    fs.chmodSync(cache, 0o777);
    try {
      refusedWith(ws, '.cache owned by another uid and writable', `${WHY}${cache} is owned by another user.`, baseEnv(ws, { STATUS_TEST_FAKE_OWNER: cache }));
    } finally {
      fs.chmodSync(cache, 0o700);
    }
    // The fake owner changes nothing for a path it does not name: control.
    fs.rmSync(ws.record, { force: true });
    assert.equal(doctor(ws, baseEnv(ws, { STATUS_TEST_FAKE_OWNER: path.join(ws.base, 'not-a-folder-here') })).line, '- Seatbelt: on (no account)');
  } finally {
    ws.cleanup();
  }
});

test('M4 why: a path with a space, quote, $(...), backtick, newline, ;&|, non-ASCII, ESC, a leading dash or a tilde: no command, only plain characters shown, refusal unchanged', () => {
  const ws = workspace();
  try {
    const shown = (name) => name.replace(/[^A-Za-z0-9._/-]/g, '?');
    const names = ['my home', "it's", 'say"hi"', '$(touch pwned)', '`touch pwned`', 'line1\nline2', 'hömé-ひ', '-rf', '\u001b[31mred', 'a;b&c|d', '~', '--help'];
    for (const name of names) {
      const home = path.join(ws.base, name);
      fs.mkdirSync(home, { mode: 0o700 });
      const cache = path.join(home, '.cache');
      fs.mkdirSync(cache, { mode: 0o700 });
      fs.chmodSync(cache, 0o770);
      const env = { ...baseEnv(ws, { HOME: home, STATUS_TEST_PASSWD_HOME: home }) };
      const run = refusedWith(ws, `home named ${JSON.stringify(name)}`, `${WHY}${shown(cache)} is writable by other users.`, env);
      assert.equal(/[\x00-\x09\x0b-\x1f\x7f]|[^\x00-\x7f]/.test(run.result.stdout.replace(/\n$/, '').split('\n').filter((entry) => entry.startsWith(WHY)).join('')), false, 'plain ASCII on the line');
      assert.equal(/Fix:|chmod/.test(run.text), false, `no command: ${JSON.stringify(name)}`);
      for (const planted of [path.join(ws.base, 'pwned'), path.join(ws.project, 'pwned'), path.join(home, 'pwned'), path.join(cache, 'pwned')]) assert.equal(fs.existsSync(planted), false, `nothing ran: ${planted}`);
      fs.rmSync(home, { recursive: true, force: true });
    }
    // A home that is itself unsafe, with a link and an owner as the reason.
    const odd = path.join(ws.base, 'my home');
    fs.mkdirSync(odd, { mode: 0o700 });
    fs.chmodSync(odd, 0o770);
    refusedWith(ws, 'home with a space, 770', `${WHY}${shown(odd)} is writable by other users.`, baseEnv(ws, { HOME: odd, STATUS_TEST_PASSWD_HOME: odd }));
    fs.chmodSync(odd, 0o700);
    fs.symlinkSync(ws.project, path.join(odd, '.cache'));
    refusedWith(ws, 'link with a space', `${WHY}${shown(path.join(odd, '.cache'))} is a link.`, baseEnv(ws, { HOME: odd, STATUS_TEST_PASSWD_HOME: odd }));
    fs.rmSync(path.join(odd, '.cache'));
    fs.mkdirSync(path.join(odd, '.cache'), { mode: 0o700 });
    refusedWith(ws, 'owner with a space', `${WHY}${shown(path.join(odd, '.cache'))} is owned by another user.`, baseEnv(ws, { HOME: odd, STATUS_TEST_PASSWD_HOME: odd, STATUS_TEST_FAKE_OWNER: path.join(odd, '.cache') }));
    fs.rmSync(odd, { recursive: true, force: true });
    // Controls: a path of plain characters, dots and dashes in the middle, gets its command.
    for (const name of ['a.b-c_d', '..hidden', 'x-y']) {
      const home = path.join(ws.base, name);
      fs.mkdirSync(home, { mode: 0o700 });
      fs.mkdirSync(path.join(home, '.cache'), { mode: 0o700 });
      fs.chmodSync(path.join(home, '.cache'), 0o770);
      const cache = path.join(home, '.cache');
      refusedWith(ws, `plain home ${name}`, `${WHY}${cache} is writable by other users. Fix: chmod go-w ${cache}`, baseEnv(ws, { HOME: home, STATUS_TEST_PASSWD_HOME: home }));
      fs.rmSync(home, { recursive: true, force: true });
    }
  } finally {
    ws.cleanup();
  }
});

test('M5 why: the folder named is the passwd home\'s, never $HOME\'s; an unsafe $HOME with a safe passwd home is not a refusal', () => {
  const ws = workspace();
  try {
    const elsewhere = path.join(ws.base, 'elsewhere-home');
    fs.mkdirSync(elsewhere, { mode: 0o700 });
    const cache = path.join(ws.home, '.cache');
    fs.mkdirSync(cache, { mode: 0o700 });
    fs.chmodSync(cache, 0o777);
    const run = refusedWith(ws, 'HOME elsewhere, passwd home unsafe', `${WHY}${cache} is writable by other users. Fix: chmod go-w ${cache}`, baseEnv(ws, { HOME: elsewhere, STATUS_TEST_PASSWD_HOME: ws.home }));
    assert.equal(run.text.includes('elsewhere-home/.cache'), false, 'the HOME variable is not what is named');
    fs.chmodSync(cache, 0o700);
    fs.rmSync(cache, { recursive: true });
    fs.chmodSync(elsewhere, 0o770);
    fs.rmSync(ws.record, { force: true });
    const ok = doctor(ws, baseEnv(ws, { HOME: elsewhere, STATUS_TEST_PASSWD_HOME: ws.home }));
    assert.equal(ok.line, '- Seatbelt: on (no account)');
    assert.match(seatbeltBlock(ok).next, MISSING_ENV);
  } finally {
    ws.cleanup();
  }
});

test('M6 why: doctor --json carries the same fields and values (no new field, no extra line); exit code 0', () => {
  const ws = workspace();
  try {
    const json = (label, env = baseEnv(ws)) => {
      fs.rmSync(ws.record, { force: true });
      const run = doctor(ws, env, { args: ['--json'] });
      assert.equal(run.result.status, 0, `${label}: ${run.text}`);
      assert.equal((run.result.stdout || '').includes('Doctor skipped'), false, `${label}: the extra line is not in the JSON`);
      return { report: JSON.parse(run.result.stdout), stdout: run.result.stdout, spawns: statusRecords(ws).length };
    };
    const normal = json('normal');
    assert.deepEqual(normal.report.doctor.seatbelt, { mode: 'seatbelt', reason: null });
    const cache = path.join(ws.home, '.cache');
    const marrow = path.join(cache, 'marrow');
    const refusals = [];
    makeBase(ws.home);
    fs.chmodSync(cache, 0o777);
    refusals.push(['.cache 777', json('.cache 777')]);
    fs.chmodSync(cache, 0o700);
    fs.chmodSync(marrow, 0o707);
    refusals.push(['.cache/marrow 707', json('.cache/marrow 707')]);
    fs.chmodSync(marrow, 0o700);
    refusals.push(['owner', json('owner', baseEnv(ws, { STATUS_TEST_FAKE_OWNER: cache }))]);
    fs.chmodSync(ws.home, 0o707);
    refusals.push(['home 707', json('home 707')]);
    fs.chmodSync(ws.home, 0o700);
    const real = path.join(ws.base, 'real-cache');
    fs.renameSync(cache, real);
    fs.symlinkSync(real, cache);
    refusals.push(['link', json('link')]);
    for (const [label, got] of refusals) {
      assert.deepEqual(got.report.doctor.seatbelt, { mode: 'could_not_check', reason: null }, label);
      assert.deepEqual(Object.keys(got.report.doctor.seatbelt), ['mode', 'reason'], label);
      assert.equal(got.spawns, 0, `${label}: no status child`);
      assert.deepEqual(Object.keys(got.report.doctor), Object.keys(normal.report.doctor), `${label}: the same doctor fields in the same order`);
      assert.deepEqual(Object.keys(got.report), Object.keys(normal.report), `${label}: the same top-level fields`);
    }
  } finally {
    ws.cleanup();
  }
});

// LOW-2 (aud-doctor-cache-msg): a command is printed only for a folder the user running doctor owns. A shared folder that root owns
// (a passwd home of /tmp or /var/tmp, mode 1777) is told about, with no command. No real system folder is touched: a throwaway home
// is made to look root-owned (STATUS_TEST_FAKE_OWNER with STATUS_TEST_FAKE_OWNER_UID=0, see status-host-fakes.js).
test('M7 why: a writable folder that root owns (a shared folder such as /tmp) says why and prints no command; the user\'s own folder keeps `chmod go-w`', () => {
  const ws = workspace();
  try {
    const cache = path.join(ws.home, '.cache');
    const marrow = path.join(cache, 'marrow');
    const targets = [['the home (the passwd home is the shared folder)', ws.home], ['.cache', cache], ['.cache/marrow', marrow]];
    const rootOwned = (target) => baseEnv(ws, { STATUS_TEST_FAKE_OWNER: target, STATUS_TEST_FAKE_OWNER_UID: '0' });
    for (const bits of [0o777, 0o1777, 0o770, 0o702]) {
      for (const [label, target] of targets) {
        makeBase(ws.home);
        fs.chmodSync(target, bits);
        try {
          const run = refusedWith(ws, `${label} root-owned ${bits.toString(8)}`, `${WHY}${target} is writable by other users.`, rootOwned(target));
          assert.equal(/Fix:|chmod/.test(run.text), false, `${label} root-owned ${bits.toString(8)}: no command anywhere in the output`);
          // The same folder owned by the user (nothing faked) still gets its command.
          refusedWith(ws, `${label} own ${bits.toString(8)}`, `${WHY}${target} is writable by other users. Fix: chmod go-w ${target}`);
        } finally {
          fs.chmodSync(target, 0o700);
        }
        fs.rmSync(cache, { recursive: true, force: true });
      }
    }
    // A root-owned folder that is not writable is fine (as it always was): the check runs.
    makeBase(ws.home);
    fs.rmSync(ws.record, { force: true });
    assert.equal(doctor(ws, rootOwned(cache)).line, '- Seatbelt: on (no account)');
    // Another user's folder (not root) is still "owned by another user", with no command (M3).
    refusedWith(ws, 'another uid, writable', `${WHY}${cache} is owned by another user.`, baseEnv(ws, { STATUS_TEST_FAKE_OWNER: cache, STATUS_TEST_FAKE_OWNER_UID: '4242' }));
  } finally {
    ws.cleanup();
  }
});

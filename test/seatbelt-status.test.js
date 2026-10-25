require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const hostFakes = require('./support/status-host-fakes');
const { install, parseArgs, printReport } = require('../src/installer');
const PINS = require('../src/pins');
const {
  REASON_ORDER,
  REASON_TEXT,
  SEATBELT_MODES,
  SEATBELT_REASON_CODES,
  SEATBELT_STATUS_MAX_BYTES,
  SEATBELT_STATUS_TIMEOUT_MS,
  SEATBELT_PRESENCE_KEY,
  chainClosed,
  parseSeatbeltStatus,
  runSeatbeltStatus,
  safeFixPath,
  seatbeltLine,
  seatbeltReport,
  seatbeltWhyLine,
  statusInvocation,
} = require('../src/seatbelt-status');

const line = (value) => `${JSON.stringify(value)}\n`;

test('the status limits are the contract: 8 s, 4 KB, the closed mode and reason sets', () => {
  assert.equal(SEATBELT_STATUS_TIMEOUT_MS, 8000);
  assert.equal(SEATBELT_STATUS_MAX_BYTES, 4096);
  assert.deepEqual([...SEATBELT_MODES], ['seatbelt', 'claimed_no_key', 'account', 'unknown']);
  assert.deepEqual([...SEATBELT_REASON_CODES], ['strict', 'key_rejected', 'home_unknown', 'home_unusable', 'env_home_unusable', 'home_mismatch', 'evidence_unknown', 'account_evidence']);
});

test('parse accepts every mode and every reason code, with or without the final newline', () => {
  for (const mode of SEATBELT_MODES) {
    assert.deepEqual(parseSeatbeltStatus(Buffer.from(line({ mode, reasons: [] }))), { mode, reasons: [] });
    assert.deepEqual(parseSeatbeltStatus(Buffer.from(JSON.stringify({ reasons: [], mode }))), { mode, reasons: [] }, 'key order does not matter');
  }
  for (const code of SEATBELT_REASON_CODES) {
    assert.deepEqual(parseSeatbeltStatus(Buffer.from(line({ mode: 'claimed_no_key', reasons: [code] }))), { mode: 'claimed_no_key', reasons: [code] });
  }
  const all = [...SEATBELT_REASON_CODES];
  assert.deepEqual(parseSeatbeltStatus(Buffer.from(line({ mode: 'claimed_no_key', reasons: all }))).reasons, all);
  assert.deepEqual(parseSeatbeltStatus(line({ mode: 'account', reasons: ['account_evidence'] })), { mode: 'account', reasons: ['account_evidence'] }, 'a string is accepted too');
});

test('parse rejects every malformed or untrusted output', () => {
  const ok = { mode: 'claimed_no_key', reasons: ['strict'] };
  const cases = {
    empty: '',
    'only a newline': '\n',
    'two lines': `${line(ok)}${line(ok)}`,
    'a second empty line': `${line(ok)}\n`,
    'a leading line': `hello\n${line(ok)}`,
    'CRLF': `${JSON.stringify(ok)}\r\n`,
    'tab inside': `{"mode":"seatbelt",\t"reasons":[]}\n`,
    'ANSI escape before': `\u001b[2J${line(ok)}`,
    'ANSI escape in a string': `{"mode":"seatbelt","reasons":["\u001b[31mstrict"]}\n`,
    'ANSI as escaped json': '{"mode":"seatbelt","reasons":["\\u001b[31m"]}\n',
    'non-ASCII utf8 in a key': `{"mode":"seatbelt","reasons":[],"caf\u00e9":1}\n`,
    'non-ASCII bytes': Buffer.from([0x7b, 0xc3, 0xa9, 0x7d, 0x0a]),
    'NUL byte': Buffer.from('{"mode":"seatbelt","reasons":[]}\n\u0000'),
    'extra key': line({ ...ok, extra: 1 }),
    'extra key with the same keys': line({ mode: 'seatbelt', reasons: [], reason: 'strict' }),
    'missing reasons': line({ mode: 'seatbelt' }),
    'missing mode': line({ reasons: [] }),
    'unknown mode': line({ mode: 'off', reasons: [] }),
    'mode in a different case': line({ mode: 'Seatbelt', reasons: [] }),
    'mode as a list': line({ mode: ['seatbelt'], reasons: [] }),
    'unknown reason code': line({ mode: 'claimed_no_key', reasons: ['strict', 'made_up'] }),
    'reason with a prefix': line({ mode: 'claimed_no_key', reasons: ['strict '] }),
    'reason as a number': line({ mode: 'claimed_no_key', reasons: [1] }),
    'reason as an object': line({ mode: 'claimed_no_key', reasons: [{ code: 'strict' }] }),
    'duplicate reason': line({ mode: 'claimed_no_key', reasons: ['strict', 'strict'] }),
    'too many reasons': line({ mode: 'claimed_no_key', reasons: [...SEATBELT_REASON_CODES, 'strict'] }),
    'reasons not a list': line({ mode: 'claimed_no_key', reasons: 'strict' }),
    'reasons null': line({ mode: 'claimed_no_key', reasons: null }),
    'a list': '[]\n',
    'null': 'null\n',
    'a number': '1\n',
    'a string': '"seatbelt"\n',
    'not json': 'seatbelt\n',
    'truncated json': '{"mode":"seatbelt","reasons":[]\n',
    'prototype key': '{"__proto__":{"mode":"seatbelt"},"reasons":[]}\n',
    'bigger than 4 KB': `{"mode":"seatbelt","reasons":[],"pad":"${'x'.repeat(SEATBELT_STATUS_MAX_BYTES)}"}\n`,
    'a non-string, non-buffer': 7,
    undefined,
  };
  for (const [name, value] of Object.entries(cases)) assert.equal(parseSeatbeltStatus(value), null, name);
});

test('the doctor line for every mode and every reason is the approved copy', () => {
  assert.equal(seatbeltLine({ mode: 'seatbelt', reason: null }), '- Seatbelt: on (no account)');
  assert.equal(seatbeltLine({ mode: 'account', reason: null }), '- Seatbelt: account mode (using your Marrow key)');
  assert.equal(seatbeltLine({ mode: 'could_not_check', reason: null }), '- Seatbelt: could not check');
  assert.equal(seatbeltLine({ mode: 'unknown', reason: null }), '- Seatbelt: could not check');
  assert.equal(seatbeltLine(undefined), '- Seatbelt: could not check');
  assert.equal(seatbeltLine(null), '- Seatbelt: could not check');
  const claimed = (reason) => seatbeltLine(seatbeltReport({ mode: 'claimed_no_key', reasons: reason ? [reason] : [] }));
  const strict = (reason, fix) => `- Seatbelt: strict here (holds more actions): ${reason} -> ${fix}`;
  assert.equal(claimed('strict'), strict('MARROW_SEATBELT_STRICT=1 is set', 'unset MARROW_SEATBELT_STRICT'));
  assert.equal(claimed('key_rejected'), strict('the Marrow key on this machine was rejected', 'check the key in ~/.marrow/env or MARROW_API_KEY'));
  assert.equal(claimed('home_unknown'), strict('it cannot find your login home folder (common in containers that run as a user with no home)', 'run the agent as a user that has a home folder'));
  assert.equal(claimed('home_unusable'), strict('your login home folder is missing, is not a folder, or is /', 'give this user a real home folder'));
  assert.equal(claimed('env_home_unusable'), strict('HOME points to a folder that is missing or is not a folder', 'set HOME to your login home folder'));
  assert.equal(claimed('home_mismatch'), strict('HOME is not your login home folder', 'start the agent with HOME set to your login home folder'));
  assert.equal(claimed('evidence_unknown'), strict(
    'a folder or file it checks (your home folder, ~/.marrow, or an agent folder such as ~/.claude) belongs to another user, can be written by other users, or could not be read',
    'make sure your home folder, ~/.marrow and your agent folders (such as ~/.claude) belong to you and can be read, then run chmod go-w on them',
  ));
  assert.equal(claimed('account_evidence'), strict(
    'this machine has an earlier Marrow setup (a ~/.marrow file or Marrow hooks in your settings) but no working key',
    'add your key to ~/.marrow/env (chmod 600), or remove the old setup with npx -y @getmarrow/install@latest uninstall',
  ));
  assert.equal(claimed(null), strict('it could not confirm this machine\'s setup', 'see the lines below'));
});

test('one reason is picked in the approved order; account_evidence only when nothing else applies', () => {
  const pick = (reasons) => seatbeltReport({ mode: 'claimed_no_key', reasons }).reason;
  assert.deepEqual([...REASON_ORDER], ['strict', 'key_rejected', 'home_unknown', 'home_unusable', 'env_home_unusable', 'home_mismatch', 'evidence_unknown']);
  const everything = [...SEATBELT_REASON_CODES].reverse();
  for (let index = 0; index < REASON_ORDER.length; index += 1) {
    assert.equal(pick(everything.filter((code) => REASON_ORDER.indexOf(code) === -1 || REASON_ORDER.indexOf(code) >= index)), REASON_ORDER[index]);
  }
  assert.equal(pick(['account_evidence']), 'account_evidence');
  assert.equal(pick(['account_evidence', 'evidence_unknown']), 'evidence_unknown');
  assert.equal(pick([]), null);
  assert.deepEqual(seatbeltReport({ mode: 'seatbelt', reasons: ['strict'] }), { mode: 'seatbelt', reason: null });
  assert.deepEqual(seatbeltReport({ mode: 'account', reasons: ['account_evidence'] }), { mode: 'account', reason: null });
  assert.deepEqual(seatbeltReport({ mode: 'unknown', reasons: [] }), { mode: 'unknown', reason: null });
  assert.deepEqual(seatbeltReport(null), { mode: 'could_not_check', reason: null });
});

test('every doctor seatbelt string is plain ASCII, avoids the banned words and never says "run ... doctor"', () => {
  const lines = [
    seatbeltLine({ mode: 'seatbelt' }), seatbeltLine({ mode: 'account' }), seatbeltLine(null),
    ...Object.keys(REASON_TEXT).map((code) => seatbeltLine({ mode: 'claimed_no_key', reason: code })),
  ];
  assert.equal(new Set(lines).size, lines.length, 'every case has its own line');
  for (const text of lines) {
    assert.match(text, /^[\t\x20-\x7e]+$/, text);
    assert.doesNotMatch(text, /\b(risk|risky|score|classifier)\b/i, text);
    assert.doesNotMatch(text, /run\b[^.]*\bdoctor/i, text);
    assert.doesNotMatch(text, /\bMarrow AI\b/, text);
  }
});

// A stub `marrow-mcp`: a tiny script whose behavior comes from its first argument.
function stubDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-seatbelt-stub-'));
  const script = path.join(dir, 'stub.cjs');
  fs.writeFileSync(script, `'use strict';
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const [mode, payload] = process.argv.slice(2);
const pidFile = process.env.STUB_PID_FILE;
if (pidFile) fs.appendFileSync(pidFile, process.pid + '\\n');
if (mode === 'line') { process.stdout.write(payload + '\\n'); process.exit(0); }
if (mode === 'exit3') { process.stdout.write(payload + '\\n'); process.exit(3); }
if (mode === 'stderr') { process.stderr.write('\\u001b[31mnoise\\u001b[0m\\n'); process.stdout.write(payload + '\\n'); process.exit(0); }
if (mode === 'big') { process.stdout.write('x'.repeat(10 * 1024)); setInterval(() => {}, 1000); }
else if (mode === 'big-after-line') { process.stdout.write(payload + '\\n' + 'x'.repeat(10 * 1024)); setInterval(() => {}, 1000); }
else if (mode === 'hang') { setInterval(() => {}, 1000); }
else if (mode === 'hang-with-child') {
  const child = spawn(process.execPath, ['-e', 'require("node:fs").appendFileSync(process.env.STUB_PID_FILE, process.pid + "\\\\n"); setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  child.unref();
  setInterval(() => {}, 1000);
}
else if (mode === 'exit-leave-child') {
  // The leader prints a valid line and exits 0; a child in its process group keeps stdout open, so 'close' never fires.
  spawn(process.execPath, ['-e', 'require("node:fs").appendFileSync(process.env.STUB_PID_FILE, process.pid + "\\\\n"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'ignore'] }).unref();
  process.stdout.write(payload + '\\n');
  process.exit(0);
}
else if (mode === 'wait-for-stdin') { process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(payload + '\\n'); process.exit(0); }); setTimeout(() => process.exit(9), 5000); }
else if (mode === 'env') {
  process.stdout.write(JSON.stringify({ mode: 'seatbelt', reasons: [] }) + '\\n');
  fs.writeFileSync(process.env.STUB_ENV_FILE, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), home: process.env.HOME, hasKey: Boolean(process.env.MARROW_API_KEY), keyInArgv: process.argv.some((arg) => arg.includes(String(process.env.MARROW_API_KEY))) }));
  process.exit(0);
}
`);
  return { dir, script, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
const pids = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number) : []);
async function waitGone(list, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end && list.some(alive)) await new Promise((resolve) => setTimeout(resolve, 50));
  return list.filter(alive);
}

async function viaStub(stub, args, { limits = { timeoutMs: 800 }, env = {} } = {}) {
  const pidFile = path.join(stub.dir, 'pids');
  const started = Date.now();
  const status = await runSeatbeltStatus({ command: process.execPath, args: [stub.script, ...args], env: { ...process.env, STUB_PID_FILE: pidFile, ...env } }, limits);
  return { status, ms: Date.now() - started, pidFile };
}

test('stub marrow-mcp: every valid mode and reason comes back as codes only', async () => {
  const stub = stubDir();
  try {
    for (const mode of SEATBELT_MODES) {
      assert.deepEqual((await viaStub(stub, ['line', JSON.stringify({ mode, reasons: [] })])).status, { mode, reasons: [] }, mode);
    }
    for (const code of SEATBELT_REASON_CODES) {
      assert.deepEqual((await viaStub(stub, ['line', JSON.stringify({ mode: 'claimed_no_key', reasons: [code] })])).status, { mode: 'claimed_no_key', reasons: [code] }, code);
    }
    // stderr noise (even ANSI) is dropped, not echoed or parsed.
    assert.deepEqual((await viaStub(stub, ['stderr', JSON.stringify({ mode: 'seatbelt', reasons: [] })])).status, { mode: 'seatbelt', reasons: [] });
    // stdin is closed, so a command that waits for EOF finishes at once.
    const waited = await viaStub(stub, ['wait-for-stdin', JSON.stringify({ mode: 'account', reasons: [] })], { limits: { timeoutMs: 4000 } });
    assert.deepEqual(waited.status, { mode: 'account', reasons: [] });
    assert.ok(waited.ms < 3500, `stdin EOF, took ${waited.ms} ms`);
  } finally {
    stub.cleanup();
  }
});

test('stub marrow-mcp: untrusted output is "could not check" (null), within the timeout, with no process left', async () => {
  const stub = stubDir();
  try {
    const valid = JSON.stringify({ mode: 'seatbelt', reasons: [] });
    const cases = {
      'ANSI escapes': ['line', '\u001b[2J\u001b[31m{"mode":"seatbelt","reasons":[]}'],
      'a fake mode': ['line', JSON.stringify({ mode: 'off', reasons: [] })],
      'an extra key': ['line', JSON.stringify({ mode: 'seatbelt', reasons: [], extra: true })],
      'an unknown code': ['line', JSON.stringify({ mode: 'claimed_no_key', reasons: ['made_up'] })],
      'not json': ['line', 'the server is starting'],
      'a valid line but exit 3': ['exit3', valid],
      '10 KB of output that never ends': ['big'],
      'a valid line followed by 10 KB': ['big-after-line', valid],
    };
    for (const [name, args] of Object.entries(cases)) {
      const result = await viaStub(stub, args);
      assert.equal(result.status, null, name);
      assert.ok(result.ms < 2500, `${name}: ${result.ms} ms`);
      assert.deepEqual(await waitGone(pids(result.pidFile)), [], `${name}: no process left`);
    }
    // A command that hangs is stopped at the timeout.
    const hung = await viaStub(stub, ['hang'], { limits: { timeoutMs: 500 } });
    assert.equal(hung.status, null);
    assert.ok(hung.ms >= 450 && hung.ms < 2500, `hang took ${hung.ms} ms`);
    assert.deepEqual(await waitGone(pids(hung.pidFile)), [], 'hang: no process left');
    // Its children die with it: the whole process group is killed.
    const family = await viaStub(stub, ['hang-with-child'], { limits: { timeoutMs: 700 } });
    assert.equal(family.status, null);
    assert.ok(pids(family.pidFile).length >= 1);
    assert.deepEqual(await waitGone(pids(family.pidFile)), [], 'hang-with-child: no process left');
    // A leader that prints a valid line and exits 0 while a child keeps stdout open is not a valid answer,
    // and the child dies with the group even though the leader is already gone.
    const earlier = pids(path.join(stub.dir, 'pids')).length;
    const left = await viaStub(stub, ['exit-leave-child', valid], { limits: { timeoutMs: 700 } });
    const leftPids = pids(left.pidFile).slice(earlier);
    assert.equal(left.status, null, 'exit-leave-child: could not check');
    assert.ok(left.ms >= 650 && left.ms < 2500, `exit-leave-child took ${left.ms} ms`);
    assert.equal(leftPids.length, 2, 'exit-leave-child: the leader and its child both ran');
    assert.deepEqual(await waitGone(leftPids), [], 'exit-leave-child: no process left');
    // A command that does not exist.
    assert.equal(await runSeatbeltStatus({ command: path.join(stub.dir, 'no-such-command'), args: [], env: process.env }, { timeoutMs: 500 }), null);
  } finally {
    stub.cleanup();
  }
});

test('the command runs in its own empty private folder, never the project, and the key never reaches argv', async () => {
  const stub = stubDir();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-seatbelt-project-'));
  const dummy = crypto.randomBytes(24).toString('hex');
  const envFile = path.join(stub.dir, 'env.json');
  const original = process.cwd();
  try {
    process.chdir(project);
    const result = await viaStub(stub, ['env'], { limits: { timeoutMs: 4000 }, env: { STUB_ENV_FILE: envFile, MARROW_API_KEY: dummy } });
    assert.deepEqual(result.status, { mode: 'seatbelt', reasons: [] });
    const seen = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    assert.notEqual(path.resolve(seen.cwd), path.resolve(project));
    assert.notEqual(path.dirname(path.resolve(seen.cwd)), path.resolve(project));
    assert.match(path.basename(seen.cwd), /^marrow-install-seatbelt-/);
    assert.equal(fs.existsSync(seen.cwd), false, 'the private folder is removed');
    assert.equal(seen.hasKey, true, 'the machine environment reaches the command');
    assert.equal(seen.keyInArgv, false);
    assert.equal(seen.argv.join(' ').includes(dummy), false);
  } finally {
    process.chdir(original);
    fs.rmSync(project, { recursive: true, force: true });
    stub.cleanup();
  }
});

function workspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-seatbelt-doctor-'));
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(project, { mode: 0o700 });
  fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Claude\n');
  return { base, home, project, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

const doctorOptions = (ws, extra = {}) => ({
  cwd: ws.project, home: ws.home, mode: 'mcp', selfTest: false, loopGuardSelfTest: false, apiKey: '', baseUrl: 'https://api.getmarrow.ai',
  agentId: 'seatbelt-doctor-fixture', controller: false, processCommands: [], mcpRegistryMetadata: null, yes: false, dryRun: false, doctor: true, ...extra,
});

function printed(report) {
  let text = '';
  printReport(report, (chunk) => { text += chunk; });
  return text;
}

test('doctor: the Seatbelt line follows "Marrow active", the report carries codes only, and the output is the same without the status', async () => {
  const ws = workspace();
  const stub = stubDir();
  try {
    const status = (value) => ({ seatbeltStatus: true, seatbeltStatusTimeoutMs: 4000, seatbeltStatusCommand: { command: process.execPath, args: [stub.script, 'line', JSON.stringify(value)] } });
    const cases = [
      [{ mode: 'seatbelt', reasons: [] }, { mode: 'seatbelt', reason: null }, '- Seatbelt: on (no account)'],
      [{ mode: 'account', reasons: [] }, { mode: 'account', reason: null }, '- Seatbelt: account mode (using your Marrow key)'],
      [{ mode: 'claimed_no_key', reasons: ['evidence_unknown', 'home_mismatch'] }, { mode: 'claimed_no_key', reason: 'home_mismatch' }, '- Seatbelt: strict here (holds more actions): HOME is not your login home folder -> start the agent with HOME set to your login home folder'],
      [{ mode: 'unknown', reasons: [] }, { mode: 'unknown', reason: null }, '- Seatbelt: could not check'],
    ];
    for (const [value, expectedReport, expectedLine] of cases) {
      const report = await install(doctorOptions(ws, status(value)));
      assert.deepEqual(report.doctor.seatbelt, expectedReport);
      const lines = printed(report).split('\n');
      const active = lines.findIndex((entry) => entry.startsWith('- Marrow active:'));
      assert.ok(active > 0);
      assert.ok(lines[active + 1].startsWith('- Seatbelt: '), lines[active + 1]);
      if (expectedLine) assert.equal(lines[active + 1], expectedLine);
      assert.equal(lines.filter((entry) => entry.startsWith('- Seatbelt:')).length, 1, 'one Seatbelt line');
    }
    // No status requested, a broken command, and a status for a write run (not doctor).
    const none = await install(doctorOptions(ws));
    assert.deepEqual(none.doctor.seatbelt, { mode: 'could_not_check', reason: null });
    assert.match(printed(none), /\n- Marrow active: no\n- Seatbelt: could not check\n- missing env:/);
    const broken = await install(doctorOptions(ws, { seatbeltStatus: true, seatbeltStatusTimeoutMs: 400, seatbeltStatusCommand: { command: process.execPath, args: [stub.script, 'hang'] } }));
    assert.deepEqual(broken.doctor.seatbelt, { mode: 'could_not_check', reason: null });
    const nonDoctor = await install(doctorOptions(ws, { doctor: false, ...status({ mode: 'seatbelt', reasons: [] }) }));
    assert.equal('seatbelt' in nonDoctor.doctor, false, 'only doctor runs the status command');
  } finally {
    stub.cleanup();
    ws.cleanup();
  }
});

test('doctor: a status that prints terminal escapes, a fake mode or 10 KB is never echoed', async () => {
  const ws = workspace();
  const stub = stubDir();
  try {
    for (const args of [['line', '\u001b[2J\u001b]0;pwned\u0007{"mode":"seatbelt","reasons":[]}'], ['line', '{"mode":"owned-by-stub","reasons":[]}'], ['big'], ['hang']]) {
      const report = await install(doctorOptions(ws, { seatbeltStatus: true, seatbeltStatusTimeoutMs: 500, seatbeltStatusCommand: { command: process.execPath, args: [stub.script, ...args] } }));
      const text = printed(report);
      assert.match(text, /\n- Seatbelt: could not check\n/);
      assert.equal(/\u001b|pwned|owned-by-stub|xxxxxxxx/.test(text + JSON.stringify(report)), false, args[0]);
    }
  } finally {
    stub.cleanup();
    ws.cleanup();
  }
});

test('doctor starts npm\'s own npx-cli.js by absolute path with the exact pinned argv, and the key is only a presence marker', (t) => {
  const prefix = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-seatbelt-prefix-')));
  const dummy = crypto.randomBytes(24).toString('hex');
  try {
    // <prefix>/bin/node with npm's script at its pinned place (the walk to / passes below the test temp root).
    const script = path.join(prefix, 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js');
    fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.writeFileSync(script, '// npx\n');
    fs.writeFileSync(path.join(prefix, 'bin', 'node'), '');
    const args = parseArgs(['doctor']);
    assert.equal(args.seatbeltStatus, true);
    const execPath = path.join(prefix, 'bin', 'node');
    const invocation = statusInvocation({
      version: PINS.MCP_ADAPTER_VERSION, parentEnv: { PATH: process.env.PATH, HOME: os.homedir(), MARROW_API_KEY: dummy }, execPath,
    });
    assert.ok(invocation, 'a node with npm\'s script at its pinned place');
    assert.equal(invocation.command, execPath);
    assert.equal(invocation.args[0], script);
    assert.equal(invocation.args[0], fs.realpathSync(invocation.args[0]), 'the script is a real path');
    assert.deepEqual(invocation.args.slice(1), ['-y', `--package=@getmarrow/mcp@${PINS.MCP_ADAPTER_VERSION}`, 'marrow-mcp', 'seatbelt-status']);
    assert.equal(invocation.env.MARROW_API_KEY, SEATBELT_PRESENCE_KEY);
    assert.equal(JSON.stringify(invocation).includes(dummy), false, 'the key is never in the invocation');
    assert.equal(statusInvocation({ version: '3.9.104; rm', parentEnv: {}, execPath }), null, 'only an exact x.y.z version');
    assert.equal(statusInvocation({ version: 'latest', parentEnv: {}, execPath }), null, 'never a tag');
    // The node running these tests may or may not have a walk to / that passes (a group-writable Homebrew prefix does not).
    const real = statusInvocation({ version: PINS.MCP_ADAPTER_VERSION, parentEnv: {} });
    t.diagnostic(`the node running the tests resolves npm's script: ${real ? 'yes' : 'no'}`);
    if (real) assert.equal(real.command, process.execPath);
  } finally {
    fs.rmSync(prefix, { recursive: true, force: true });
  }
});

// ---- why doctor could not check: the extra line under "- Seatbelt: could not check" ----

// A fake file system for chainClosed: `chain` lists folders from the top (/) down to the start, each { uid, mode, kind }.
function fakeChain(rows, uid = 1000) {
  const table = new Map(rows.map(([name, uid2, mode, kind = 'dir']) => [name, { uid: uid2, mode, kind }]));
  return {
    getuid: () => uid,
    lstatSync: (name) => {
      const row = table.get(name);
      if (!row) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { uid: row.uid, mode: row.mode, isSymbolicLink: () => row.kind === 'link', isDirectory: () => row.kind === 'dir', isFile: () => row.kind === 'file' };
    },
  };
}
const SAFE_ROWS = [['/', 0, 0o755], ['/home', 0, 0o755], ['/home/u', 1000, 0o700], ['/home/u/.cache', 1000, 0o700], ['/home/u/.cache/marrow', 1000, 0o700]];
const withRow = (name, patch) => SAFE_ROWS.map((row) => (row[0] === name ? [row[0], ...patch] : row));

// The decision exactly as it was before the reason was recorded (080a82dc), kept here to prove nothing about it moved.
function chainClosedBefore(start, io, { startIsFile = false } = {}) {
  const uid = io.getuid();
  if (!Number.isInteger(uid)) return false;
  for (let current = start; ; ) {
    const stat = io.lstatSync(current);
    if (stat.isSymbolicLink() || (current === start && startIsFile ? !stat.isFile() : !stat.isDirectory())) return false;
    if ((stat.uid !== 0 && stat.uid !== uid) || (stat.mode & 0o022) !== 0) return false;
    const parent = path.posix.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

test('chainClosed names the first unsafe folder walking up and why, and decides exactly as before', () => {
  const start = '/home/u/.cache/marrow';
  const why = () => ({});
  const check = (rows, expected, options = {}) => {
    const io = fakeChain(rows);
    const note = why();
    assert.equal(chainClosed(start, io, { ...options, why: note }), expected.ok);
    assert.equal(chainClosed(start, io, options), expected.ok, 'same answer without the out-parameter');
    assert.equal(chainClosedBefore(start, io, options), expected.ok, 'same answer as 080a82dc');
    if (expected.ok) assert.deepEqual(note, {}, 'nothing is noted when the chain is closed');
    else assert.deepEqual(note, { path: expected.path, reason: expected.reason, owned: rows.find((row) => row[0] === expected.path)[1] === 1000 }, 'owned: the folder named belongs to the user running (uid 1000)');
  };
  check(SAFE_ROWS, { ok: true });
  check(SAFE_ROWS.map((row) => (row[0] === '/home' ? ['/home', 0, 0o775] : row)), { ok: false, path: '/home', reason: 'writable' });
  for (const [bits, label] of [[0o770, '770'], [0o702, '702'], [0o707, '707'], [0o777, '777'], [0o1777, '1777'], [0o720, '720 (group write only)']]) {
    check(withRow('/home/u/.cache', [1000, bits]), { ok: false, path: '/home/u/.cache', reason: 'writable' });
    check(withRow('/home/u/.cache/marrow', [1000, bits]), { ok: false, path: start, reason: 'writable' });
    check(withRow('/home/u', [1000, bits]), { ok: false, path: '/home/u', reason: 'writable' });
    assert.ok(label);
  }
  for (const bits of [0o755, 0o750, 0o700, 0o500, 0o755 | 0o4000, 0o1755]) check(withRow('/home/u/.cache', [1000, bits]), { ok: true });
  // The first unsafe folder is the one nearest the start; the ones above it are not named.
  check(withRow('/home/u/.cache', [1000, 0o777]).map((row) => (row[0] === '/home' ? ['/home', 0, 0o777] : row)), { ok: false, path: '/home/u/.cache', reason: 'writable' });
  check(withRow('/home/u/.cache/marrow', [1000, 0o770]).map((row) => (row[0] === '/home/u/.cache' ? ['/home/u/.cache', 1000, 0o777] : row)), { ok: false, path: start, reason: 'writable' });
  // Owners: another user is "other_owner", also when the folder is writable too (the owner is told first); root is fine, and root-owned and writable is "writable".
  check(withRow('/home/u/.cache', [1001, 0o700]), { ok: false, path: '/home/u/.cache', reason: 'other_owner' });
  check(withRow('/home/u/.cache', [1001, 0o777]), { ok: false, path: '/home/u/.cache', reason: 'other_owner' });
  check(withRow('/home/u/.cache', [0, 0o755]), { ok: true });
  check(withRow('/home/u/.cache', [0, 0o777]), { ok: false, path: '/home/u/.cache', reason: 'writable' });
  check(withRow('/home/u', [4242, 0o700]), { ok: false, path: '/home/u', reason: 'other_owner' });
  // `owned` is the owner of the folder named against the running user, from the same lstat: root and another user are not "owned".
  const owned = (rows, path_) => { const note = {}; chainClosed(start, fakeChain(rows), { why: note }); assert.equal(note.path, path_); return note.owned; };
  assert.equal(owned(withRow('/home/u/.cache', [1000, 0o777]), '/home/u/.cache'), true);
  assert.equal(owned(withRow('/home/u/.cache', [0, 0o777]), '/home/u/.cache'), false, 'a root-owned shared folder is writable but not the user\'s');
  assert.equal(owned(withRow('/home/u/.cache', [0, 0o1777]), '/home/u/.cache'), false);
  assert.equal(owned(withRow('/home/u/.cache', [1001, 0o777]), '/home/u/.cache'), false);
  assert.equal(owned(withRow('/home', [0, 0o775]), '/home'), false, 'a folder above the home that root owns');
  assert.equal(owned(withRow('/home', [1000, 0o775]), '/home'), true);
  // A link is a link whatever its mode and owner; a file is "other".
  check(withRow('/home/u/.cache', [1000, 0o700, 'link']), { ok: false, path: '/home/u/.cache', reason: 'link' });
  check(withRow('/home/u/.cache', [1001, 0o777, 'link']), { ok: false, path: '/home/u/.cache', reason: 'link' });
  check(withRow('/home/u/.cache', [1000, 0o700, 'file']), { ok: false, path: '/home/u/.cache', reason: 'other' });
  check(withRow('/home/u/.cache/marrow', [1000, 0o700, 'file']), { ok: true }, { startIsFile: true });
  check(SAFE_ROWS, { ok: false, path: start, reason: 'other' }, { startIsFile: true });
  // An error from the file system is thrown as before and notes nothing; so is a uid that is not an integer.
  const note = {};
  assert.throws(() => chainClosed('/home/u/missing', fakeChain(SAFE_ROWS), { why: note }), /ENOENT/);
  assert.throws(() => chainClosedBefore('/home/u/missing', fakeChain(SAFE_ROWS)), /ENOENT/);
  assert.deepEqual(note, {});
  assert.equal(chainClosed(start, { ...fakeChain(SAFE_ROWS), getuid: () => 'x' }, { why: note }), false);
  assert.deepEqual(note, {});
});

test('chainClosed gives the same answer as 080a82dc on 3000 random chains (owner, mode, kind, start kind)', () => {
  let seed = 20261024;
  const next = (n) => {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    return seed % n;
  };
  const owners = [0, 1000, 1000, 1001, 4242];
  const modes = [0o700, 0o755, 0o750, 0o775, 0o770, 0o702, 0o707, 0o777, 0o1777, 0o1755, 0o500, 0o020, 0o002];
  const kinds = ['dir', 'dir', 'dir', 'dir', 'link', 'file'];
  const names = ['/', '/a', '/a/b', '/a/b/c', '/a/b/c/d'];
  let closed = 0;
  for (let round = 0; round < 3000; round += 1) {
    const rows = names.map((name) => [name, owners[next(owners.length)], modes[next(modes.length)], kinds[next(kinds.length)]]);
    if (next(3) > 0) for (const row of rows) { row[2] = [0o700, 0o755][next(2)]; row[3] = 'dir'; if (next(4) === 0) row[1] = 1000; }
    if (next(5) === 0) rows.pop();
    const io = fakeChain(rows);
    const startIsFile = next(4) === 0;
    const run = (fn) => { try { return fn(); } catch (error) { return `threw ${error.code}`; } };
    const before = run(() => chainClosedBefore('/a/b/c/d', io, { startIsFile }));
    const note = {};
    const after = run(() => chainClosed('/a/b/c/d', io, { startIsFile, why: note }));
    assert.equal(after, before, JSON.stringify(rows));
    assert.equal(run(() => chainClosed('/a/b/c/d', io, { startIsFile })), before);
    if (before === true) closed += 1;
    if (before === false) assert.ok(note.path && ['link', 'other', 'other_owner', 'writable'].includes(note.reason) && typeof note.owned === 'boolean', JSON.stringify([rows, note]));
    else assert.deepEqual(note, {});
  }
  assert.ok(closed > 100 && closed < 2900, `the random chains cover both answers (${closed} closed)`);
});

const refusalOf = (folder, reason, home = '/home/u', owned = true) => ({ refusal: { home, path: folder, reason, owned } });
const whyOf = (folder, reason, home, owned) => seatbeltWhyLine(seatbeltReport(null, refusalOf(folder, reason, home, owned)));

test('the extra line: three reasons, the fix command only for a writable folder with a safe path under the home', () => {
  const prefix = '  Doctor skipped this check: ';
  assert.equal(whyOf('/home/u/.cache', 'writable'), `${prefix}/home/u/.cache is writable by other users. Fix: chmod go-w /home/u/.cache`);
  assert.equal(whyOf('/home/u/.cache/marrow', 'writable'), `${prefix}/home/u/.cache/marrow is writable by other users. Fix: chmod go-w /home/u/.cache/marrow`);
  assert.equal(whyOf('/home/u', 'writable'), `${prefix}/home/u is writable by other users. Fix: chmod go-w /home/u`);
  assert.equal(whyOf('/home/u/.cache', 'link'), `${prefix}/home/u/.cache is a link.`);
  assert.equal(whyOf('/home/u/.cache', 'other_owner'), `${prefix}/home/u/.cache is owned by another user.`);
  // Not under the home, or the home is /: the reason without a command.
  assert.equal(whyOf('/home', 'writable'), `${prefix}/home is writable by other users.`);
  assert.equal(whyOf('/tmp/x', 'writable'), `${prefix}/tmp/x is writable by other users.`);
  assert.equal(whyOf('/home/u2/.cache', 'writable'), `${prefix}/home/u2/.cache is writable by other users.`, 'a longer name with the home as a prefix is not under the home');
  assert.equal(whyOf('/etc', 'writable', '/'), `${prefix}/etc is writable by other users.`);
  assert.equal(whyOf('/', 'writable', '/'), `${prefix}/ is writable by other users.`);
  // LOW-2: the command is printed only for a folder the user running doctor owns (`owned`, from the walk's own lstat). Anything that is
  // not shown to be the user's (root's shared folder, another user's, a missing or odd value) gets the reason alone.
  assert.equal(whyOf('/home/u/.cache', 'writable', '/home/u', true), `${prefix}/home/u/.cache is writable by other users. Fix: chmod go-w /home/u/.cache`);
  for (const owned of [false, null, 'true', 1, 0, {}, []]) {
    assert.equal(whyOf('/home/u/.cache', 'writable', '/home/u', owned), `${prefix}/home/u/.cache is writable by other users.`, `owned = ${JSON.stringify(owned)}`);
  }
  const unnoted = seatbeltWhyLine(seatbeltReport(null, { refusal: { home: '/home/u', path: '/home/u/.cache', reason: 'writable' } }));
  assert.equal(unnoted, `${prefix}/home/u/.cache is writable by other users.`, 'a record without `owned` gets no command');
  assert.equal(whyOf('/tmp', 'writable', '/tmp', false), `${prefix}/tmp is writable by other users.`, 'a passwd home of /tmp');
  // Every other reason, and every malformed refusal: no extra line (the first line stands alone, as before).
  for (const reason of ['other', 'unknown', '', null, undefined, 'writable ', 'WRITABLE', '__proto__', 'constructor']) assert.equal(whyOf('/home/u/.cache', reason), null, String(reason));
  for (const bad of [null, undefined, {}, { refusal: null }, { refusal: {} }, { refusal: { reason: 'writable' } }, { refusal: { path: 7, reason: 'writable' } }, { refusal: { path: null, reason: 'link' } }, 'text', 5]) {
    assert.equal(seatbeltWhyLine(seatbeltReport(null, bad)), null, JSON.stringify(bad));
  }
  // Only a refusal of the walk gets the line: a status, a copy of the report, a JSON round trip, a report built by hand, odd inputs.
  const report = seatbeltReport(null, refusalOf('/home/u/.cache', 'writable'));
  assert.ok(seatbeltWhyLine(report));
  assert.equal(seatbeltWhyLine({ ...report }), null);
  assert.equal(seatbeltWhyLine(JSON.parse(JSON.stringify(report))), null);
  assert.equal(seatbeltWhyLine({ mode: 'could_not_check', reason: null }), null);
  assert.equal(seatbeltWhyLine(seatbeltReport({ mode: 'seatbelt', reasons: [] }, refusalOf('/home/u/.cache', 'writable'))), null, 'a status that came back has no refusal line');
  assert.equal(seatbeltWhyLine(seatbeltReport({ mode: 'claimed_no_key', reasons: [] }, refusalOf('/home/u/.cache', 'link'))), null);
  for (const odd of [null, undefined, 'could_not_check', 3, [], () => {}]) assert.equal(seatbeltWhyLine(odd), null);
  // The report, its JSON and its first line are exactly what they were.
  assert.deepEqual(report, { mode: 'could_not_check', reason: null });
  assert.equal(JSON.stringify(report), '{"mode":"could_not_check","reason":null}');
  assert.deepEqual(Object.keys(report), ['mode', 'reason']);
  assert.deepEqual(Object.getOwnPropertySymbols(report), []);
  assert.equal(seatbeltLine(report), '- Seatbelt: could not check');
  assert.equal(JSON.stringify(seatbeltReport(null)), JSON.stringify(report));
});

test('the extra line: abuse table for the path (space, quotes, $(...), backtick, newline, non-ASCII, leading dash, ESC, long)', () => {
  const home = '/home/u';
  const unsafe = [
    '/home/u/my dir', "/home/u/it's", '/home/u/say"hi"', '/home/u/$(touch pwned)', '/home/u/`id`', '/home/u/a\nb', '/home/u/a\rb', '/home/u/h\u00f6m\u00e9',
    '/home/u/\u3072', '/home/u/-rf', '/home/u/.cache/-x', '/home/u/\u001b[31mred', '/home/u/a;b', '/home/u/a&b', '/home/u/a|b', '/home/u/a>b', '/home/u/~', '/home/u/a*b',
    '/home/u/a\\b', '/home/u/a\tb', '/home/u/a\u0000b', '/home/u/../etc', '/home/u/./x', '/home/u/..', `/home/u/${'x'.repeat(1100)}`, '/home/u//x', 'home/u/x', '', '-rf',
    '/home/user/x', '/home/ux', '/home', '/', '/home/u/a%20b', '/home/u/a{b}', '/home/u/a b/c', '/home/u/a:b', '/home/u/#x', '/home/u/a=b', '/home/u/a,b', '/home/u/a@b', '/home/u/a!b',
  ];
  for (const folder of unsafe) {
    assert.equal(safeFixPath(folder, home), false, JSON.stringify(folder));
    const line = whyOf(folder, 'writable', home);
    assert.equal(line === null || !/Fix:|chmod/.test(line), true, `no command: ${JSON.stringify(folder)}`);
    if (line !== null) {
      assert.match(line, /^[\x20-\x7e]+$/, `plain ASCII, one line: ${JSON.stringify(folder)}`);
      assert.doesNotMatch(line, /[$`'"\\;&|<>*(){}!#%=@]/, `no shell character shown: ${JSON.stringify(folder)}`);
    }
  }
  for (const folder of ['/home/u', '/home/u/.cache', '/home/u/.cache/marrow', '/home/u/a.b-c_d', '/home/u/..hidden', '/home/u/.x/y-z/0']) {
    assert.equal(safeFixPath(folder, home), true, folder);
  }
  for (const badHome of [undefined, null, '', '/', 5]) assert.equal(safeFixPath('/home/u/.cache', badHome), false, String(badHome));
  assert.equal(safeFixPath(undefined, home), false);
  // A long plain path is shown in full and gets its command (up to 1024 characters); beyond that, no command.
  const long = `/home/u/${'y'.repeat(900)}`;
  assert.equal(whyOf(long, 'writable', home), `  Doctor skipped this check: ${long} is writable by other users. Fix: chmod go-w ${long}`);
  assert.doesNotMatch(whyOf(`/home/u/${'y'.repeat(1100)}`, 'writable', home), /Fix:/);
  // Every extra line is plain ASCII on one line and avoids the banned words (like every other doctor seatbelt string).
  for (const reason of ['writable', 'link', 'other_owner']) {
    const line = whyOf('/home/u/.cache', reason, home);
    assert.match(line, /^[\x20-\x7e]+$/);
    assert.doesNotMatch(line, /\b(risk|risky|score|classifier)\b/i);
    assert.doesNotMatch(line, /run\b[^.]*\bdoctor/i);
    assert.doesNotMatch(line, /chown|sudo|protect|on\b.*\boff\b/i);
  }
});

// LOW-2 (aud-doctor-cache-msg), from the walk to the line: the command only for a folder the running user owns. `uid` is the running user.
function lineFromWalk(rows, start, home, uid = 1000) {
  const why = { home };
  assert.equal(chainClosed(start, fakeChain(rows, uid), { why }), false, 'the walk refuses');
  return seatbeltWhyLine(seatbeltReport(null, { refusal: why }));
}

test('LOW-2: a passwd home of /tmp, /var/tmp or any root-owned 1777 folder prints no command; an own folder with group or other write prints chmod go-w', () => {
  const prefix = '  Doctor skipped this check: ';
  // Root-owned shared folders, the user is not root: the reason alone (the refusal is the same as before).
  assert.equal(lineFromWalk([['/', 0, 0o755], ['/tmp', 0, 0o1777]], '/tmp', '/tmp'), `${prefix}/tmp is writable by other users.`);
  assert.equal(lineFromWalk([['/', 0, 0o755], ['/var', 0, 0o755], ['/var/tmp', 0, 0o1777]], '/var/tmp', '/var/tmp'), `${prefix}/var/tmp is writable by other users.`);
  assert.equal(lineFromWalk([['/', 0, 0o755], ['/srv', 0, 0o755], ['/srv/shared', 0, 0o1777]], '/srv/shared', '/srv/shared'), `${prefix}/srv/shared is writable by other users.`);
  assert.equal(lineFromWalk([['/', 0, 0o755], ['/srv', 0, 0o755], ['/srv/shared', 0, 0o777]], '/srv/shared', '/srv/shared'), `${prefix}/srv/shared is writable by other users.`);
  // Below a root-owned shared home: still no command for the root-owned folder the walk stopped at.
  assert.equal(lineFromWalk([['/', 0, 0o755], ['/tmp', 0, 0o1777], ['/tmp/.cache', 0, 0o777]], '/tmp/.cache', '/tmp'), `${prefix}/tmp/.cache is writable by other users.`);
  // The user's own folder, group or other write: the command, for the home, .cache and .cache/marrow.
  for (const bits of [0o770, 0o702, 0o707, 0o777, 0o1777, 0o720]) {
    for (const folder of ['/home/u', '/home/u/.cache', '/home/u/.cache/marrow']) {
      assert.equal(lineFromWalk(withRow(folder, [1000, bits]), '/home/u/.cache/marrow', '/home/u'), `${prefix}${folder} is writable by other users. Fix: chmod go-w ${folder}`, `${folder} ${bits.toString(8)}`);
    }
  }
  // Another user's folder is "owned by another user" (no command), and so is a writable folder above the home (as before).
  assert.equal(lineFromWalk(withRow('/home/u/.cache', [1001, 0o777]), '/home/u/.cache/marrow', '/home/u'), `${prefix}/home/u/.cache is owned by another user.`);
  assert.equal(lineFromWalk(withRow('/home', [1000, 0o777]), '/home/u/.cache/marrow', '/home/u'), `${prefix}/home is writable by other users.`);
  assert.equal(lineFromWalk(withRow('/home', [0, 0o777]), '/home/u/.cache/marrow', '/home/u'), `${prefix}/home is writable by other users.`);
  // The rule is the owner's uid against the running uid, from the walk's own lstat: if doctor runs as root (uid 0) a root-owned writable
  // folder is the running user's own, so it keeps the command (root has no other folder to fix it with). Pinned so a change shows up.
  assert.equal(lineFromWalk([['/', 0, 0o755], ['/root', 0, 0o777]], '/root', '/root', 0), `${prefix}/root is writable by other users. Fix: chmod go-w /root`);
  assert.equal(lineFromWalk([['/', 0, 0o755], ['/tmp', 0, 0o1777]], '/tmp', '/tmp', 0), `${prefix}/tmp is writable by other users. Fix: chmod go-w /tmp`);
  // The same row seen by a user who is not root and does not own it, for every uid that is neither 0 nor the owner.
  for (const uid of [1, 999, 1000, 1001, 65534]) assert.equal(lineFromWalk([['/', 0, 0o755], ['/tmp', 0, 0o1777]], '/tmp', '/tmp', uid), `${prefix}/tmp is writable by other users.`, `uid ${uid}`);
});

// ---- LOW-1 (aud-doctor-cache-msg): the line is what the walk saw; printing it never looks at the folder again ----
//
// The folder changes (chmod, or swapped for a link) right after the lstat that made the walk refuse. The line must still name what the
// walk saw ("writable", with its command), and no file system call may be made on the way from the refusal to the printed text: a second
// look at the folder (one more lstat at print time) shows here as an extra call, and, in the swap rows, as a different reason.

let ORIGINAL_PASSWD_HOME = '!throw';
try {
  ORIGINAL_PASSWD_HOME = os.userInfo().homedir;
} catch {
  // no passwd entry: the tests then put '!throw' back
}

// A throwaway home with the three base parts, each mode 700, and a mode for the home and for .cache; a mode-700 folder to swap a link to.
function raceScene({ homeMode = 0o700, cacheMode = 0o700 } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-seatbelt-race-')));
  const home = path.join(base, 'home');
  const cache = path.join(home, '.cache');
  fs.mkdirSync(home);
  for (const part of [cache, path.join(cache, 'marrow'), path.join(cache, 'marrow', 'doctor-tmp')]) {
    fs.mkdirSync(part);
    fs.chmodSync(part, 0o700);
  }
  const elsewhere = path.join(base, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.chmodSync(elsewhere, 0o700);
  fs.chmodSync(cache, cacheMode);
  fs.chmodSync(home, homeMode);
  return { base, home, cache, elsewhere, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

// One run of the walk, then the report and the printed doctor text, with every synchronous fs call that touches the scene (or a folder
// above it) logged. `change(real)` runs right after the `refusingLstat`-th lstat of `folder` has returned its answer (null: nothing
// changes; the run then counts how many lstats of `folder` there are). `real` holds the unwrapped fs functions.
async function raceRun(scene, folder, { change = null, refusingLstat = 0, skeleton }) {
  const logged = [];
  const real = {};
  const inScene = (target) => typeof target === 'string' && path.isAbsolute(target)
    && (target === scene.base || target.startsWith(`${scene.base}/`) || scene.base.startsWith(target.endsWith('/') ? target : `${target}/`));
  const shown = (target) => target.split(scene.base).join('<B>');
  let lstats = 0;
  let fired = false;
  let everyCall = 0;
  for (const name of Object.keys(fs).filter((key) => key.endsWith('Sync') && typeof fs[key] === 'function')) {
    const original = fs[name];
    real[name] = original;
    fs[name] = Object.assign(function wrapped(...args) {
      everyCall += 1;
      if (inScene(args[0])) logged.push(`${name} ${shown(args[0])}`);
      const result = original.apply(this, args);
      if (name === 'lstatSync' && typeof args[0] === 'string' && path.resolve(args[0]) === folder) {
        lstats += 1;
        if (change && lstats === refusingLstat) {
          fired = true;
          change(real);
        }
      }
      return result;
    }, original);
  }
  const refusal = {};
  let status;
  let report;
  let why;
  let text;
  let callsBeforePrint;
  let callsAfterReport;
  let loggedBeforePrint;
  let loggedAfterPrint;
  hostFakes.setPasswdHome(scene.home);
  try {
    status = await runSeatbeltStatus({ command: process.execPath, args: ['-e', ''], env: {} }, { timeoutMs: 800 }, refusal);
    callsBeforePrint = everyCall;
    report = seatbeltReport(status, refusal);
    why = seatbeltWhyLine(report);
    callsAfterReport = everyCall;
    loggedBeforePrint = logged.length;
    skeleton.doctor.seatbelt = report;
    text = printed(skeleton);
    loggedAfterPrint = logged.length;
  } finally {
    hostFakes.setPasswdHome(ORIGINAL_PASSWD_HOME);
    for (const [name, original] of Object.entries(real)) fs[name] = original;
  }
  return {
    status, refusal: refusal.refusal, report, why, text, fired, lstats, log: logged.slice(0, loggedBeforePrint),
    reportCalls: callsAfterReport - callsBeforePrint, printedCalls: logged.slice(loggedBeforePrint, loggedAfterPrint),
  };
}

test('LOW-1: the folder changes right after the refusing lstat; the line still names what the walk saw and printing makes no fs call', async () => {
  const ws = workspace();
  const scenes = [];
  try {
    const skeleton = await install(doctorOptions(ws));
    const rows = [
      // [label, scene options, which folder refuses, how many times the walk lstats it (the refusing one is the last), the change made right after that]
      // The count is fixed here, never read back from a run: a second lookup that comes after the refusing lstat would otherwise move
      // the change to after itself and never see it. .cache is looked at twice (making the parts, then the closing walk); the home once.
      ['.cache 777, then chmod 700', { cacheMode: 0o777 }, 'cache', 2, (scene, real) => real.chmodSync(scene.cache, 0o700)],
      ['.cache 777, then swapped for a link to a mode-700 folder', { cacheMode: 0o777 }, 'cache', 2, (scene, real) => {
        real.renameSync(scene.cache, `${scene.cache}-moved`);
        real.symlinkSync(scene.elsewhere, scene.cache);
      }],
      ['the home 707, then chmod 700', { homeMode: 0o707 }, 'home', 1, (scene, real) => real.chmodSync(scene.home, 0o700)],
      ['the home 770, then swapped for a link to a mode-700 folder', { homeMode: 0o770 }, 'home', 1, (scene, real) => {
        real.renameSync(scene.home, `${scene.home}-moved`);
        real.symlinkSync(scene.elsewhere, scene.home);
      }],
    ];
    for (const [label, options, which, refusingLstat, change] of rows) {
      // Calibration: the same scene with nothing changed refuses, and looks at the folder exactly that many times.
      const calm = raceScene(options);
      scenes.push(calm);
      const calibration = await raceRun(calm, calm[which], { skeleton });
      assert.equal(calibration.status, null, `${label}: calibration refuses`);
      assert.equal(calibration.lstats, refusingLstat, `${label}: the walk looks at the folder ${refusingLstat} time(s), no more`);
      assert.equal(calibration.refusal.path, calm[which], `${label}: calibration names the folder`);
      assert.equal(calibration.refusal.reason, 'writable');
      // The race: the same scene, changed right after that lstat.
      const scene = raceScene(options);
      scenes.push(scene);
      const folder = scene[which];
      const run = await raceRun(scene, folder, { change: (real) => change(scene, real), refusingLstat, skeleton });
      assert.equal(run.fired, true, `${label}: the change was made`);
      assert.equal(run.lstats, refusingLstat, `${label}: no lstat of the folder after the refusing one`);
      assert.equal(run.status, null, `${label}: still refused`);
      assert.deepEqual(run.refusal, { home: scene.home, path: folder, reason: 'writable', owned: true }, `${label}: the record is what the walk saw`);
      const expected = `  Doctor skipped this check: ${folder} is writable by other users. Fix: chmod go-w ${folder}`;
      assert.equal(run.why, expected, `${label}: the line still names the walk's reason`);
      assert.equal(run.reportCalls, 0, `${label}: report and line make no fs call at all`);
      assert.deepEqual(run.printedCalls, [], `${label}: printing the doctor text makes no fs call on the scene`);
      assert.ok(run.text.includes(`- Seatbelt: could not check\n${expected}\n- missing env:`), `${label}: the printed text`);
      assert.deepEqual(run.log, calibration.log, `${label}: the same fs calls on the scene as the run where nothing changed`);
    }
  } finally {
    for (const scene of scenes) scene.cleanup();
    ws.cleanup();
  }
});

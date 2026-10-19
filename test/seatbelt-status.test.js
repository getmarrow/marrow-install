require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

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
  parseSeatbeltStatus,
  runSeatbeltStatus,
  seatbeltLine,
  seatbeltReport,
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

test('doctor starts npm\'s own npx-cli.js by absolute path with the exact pinned argv, and the key is only a presence marker', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-seatbelt-cwd-'));
  const dummy = crypto.randomBytes(24).toString('hex');
  try {
    const args = parseArgs(['doctor']);
    assert.equal(args.seatbeltStatus, true);
    const invocation = statusInvocation({
      version: PINS.MCP_ADAPTER_VERSION, parentEnv: { PATH: process.env.PATH, HOME: os.homedir(), MARROW_API_KEY: dummy }, cwd: empty, projectDirs: [empty],
    });
    assert.ok(invocation, 'the node running the tests has npm\'s npx next to it');
    assert.equal(invocation.command, process.execPath);
    assert.equal(path.basename(invocation.args[0]), 'npx-cli.js');
    assert.equal(invocation.args[0], fs.realpathSync(invocation.args[0]), 'the script is a real path');
    assert.deepEqual(invocation.args.slice(1), ['-y', `--package=@getmarrow/mcp@${PINS.MCP_ADAPTER_VERSION}`, 'marrow-mcp', 'seatbelt-status']);
    assert.equal(invocation.env.MARROW_API_KEY, SEATBELT_PRESENCE_KEY);
    assert.equal(JSON.stringify(invocation).includes(dummy), false, 'the key is never in the invocation');
    assert.equal(statusInvocation({ version: '3.9.104; rm', parentEnv: {}, cwd: empty }), null, 'only an exact x.y.z version');
    assert.equal(statusInvocation({ version: 'latest', parentEnv: {}, cwd: empty }), null, 'never a tag');
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

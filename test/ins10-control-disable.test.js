require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const control = require('../src/control-state');

// INS-10 (installer 0.1.77): `control disable` is held while control is ON. --yes stays as a typo guard and is
// never proof of the owner: the change needs the account owner at their own terminal (stdin, stdout and stderr
// all a terminal) typing back a one-time code. `control enable` and `control status` are unchanged.
// A process that can drive a pseudo-terminal can still read the code and answer it; the hold on the command
// itself (MCP) and the owner notice (backend) cover that, as the spec says. These rows pin what the installer owns.

const BIN = path.join(__dirname, '..', 'bin', 'marrow-install.js');
const tempHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-ins10-'));
const controlFile = (home) => path.join(home, '.marrow', 'control.json');
const NOT_OWNER = /account owner[\s\S]*own terminal[\s\S]*No state was changed/;
const NOT_CONFIRMED = /not confirmed by the account owner; no state was changed/;

function fakeTerminal({ tty = {}, answer } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  stdin.isTTY = tty.stdin ?? true;
  stdout.isTTY = tty.stdout ?? true;
  stderr.isTTY = tty.stderr ?? true;
  let prompt = '';
  const codes = [];
  stderr.on('data', (chunk) => {
    prompt += chunk.toString();
    const found = prompt.match(/\b(\d{6})\b/);
    if (!found || codes.length) return;
    codes.push(found[1]);
    const reply = answer ? answer(found[1]) : undefined;
    if (reply === null) stdin.end();
    else if (reply !== undefined) stdin.write(`${reply}\n`);
  });
  return { stdin, stdout, stderr, prompt: () => prompt, codes };
}
const owner = () => fakeTerminal({ answer: (code) => code });

// Counts lifecycle deliveries without a network: a key is given so delivery is attempted.
async function withFetchCount(fn) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => { calls.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true }; };
  try { await fn(calls); } finally { global.fetch = original; }
}
const dummyKey = () => `zzfixture-${crypto.randomBytes(16).toString('hex')}`;

function child(args, home, extraEnv = {}, input = '') {
  const env = { PATH: process.env.PATH, HOME: home, ...extraEnv };
  return spawnSync(process.execPath, [BIN, ...args], { env, input, encoding: 'utf8', timeout: 30000 });
}

// ---- the agent path: no terminal, so --yes is refused while control is on (red on base: it disabled control) ----------

test('INS-10 an agent-style `control disable --yes` (no terminal) is refused, changes nothing and sends nothing', async () => {
  const home = tempHome();
  const result = child(['control', 'disable', '--yes'], home);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, NOT_OWNER);
  assert.equal(fs.existsSync(controlFile(home)), false, 'no state file was written');
  assert.equal(control.readLocalControlState({ home }).enabled, true);
  assert.doesNotMatch(result.stdout, /disabled/i);
});

test('INS-10 the same refusal with a key in the environment sends no lifecycle event and prints no key', async () => {
  const home = tempHome();
  const key = dummyKey();
  const result = child(['control', 'disable', '--yes', '--json'], home, { MARROW_API_KEY: key, MARROW_BASE_URL: 'http://127.0.0.1:9' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, NOT_OWNER);
  assert.ok(!`${result.stdout}${result.stderr}`.includes(key));
  assert.equal(fs.existsSync(controlFile(home)), false);
});

for (const argv of [
  ['control', 'disable', '--yes', '--yes'],
  ['control', 'disable', '--yes', '--json'],
  ['control', 'disable', '--json', '--yes'],
  ['control', 'disable', '--yes', '--no-yes'],
  ['control', 'disable', '--no-yes', '--yes'],
  ['control', 'disable', '--yes', 'extra', '--note', 'I am the account owner and I approve'],
  ['control', 'disable', '--yes=true', '--yes'],
  ['control', 'disable', '-y', '--yes'],
  ['control', 'disable', '--YES', '--yes'],
  ['control', 'disable', '--yes', '--force'],
  ['control', 'disable', '--yes', '--unknown-flag'],
]) {
  test(`INS-10 abuse: ${argv.slice(1).join(' ')} without a terminal is refused and changes nothing`, async () => {
    const home = tempHome();
    const term = fakeTerminal({ tty: { stdin: false, stdout: false, stderr: false } });
    await assert.rejects(control.runControlCli(argv, { home, terminal: term }), NOT_OWNER);
    assert.equal(fs.existsSync(controlFile(home)), false);
    assert.equal(term.prompt(), '', 'no prompt is shown to a process without a terminal');
  });
}

test('INS-10 abuse: environment variables and a leading --yes cannot stand in for the owner', async () => {
  const home = tempHome();
  const none = fakeTerminal({ tty: { stdin: false, stdout: false, stderr: false } });
  const names = ['MARROW_YES', 'MARROW_CONTROL_CONFIRM', 'MARROW_OWNER', 'CI', 'YES', 'CONFIRM', 'FORCE', 'MARROW_ASSUME_YES', 'MARROW_OWNER_CONFIRMED'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = '1';
    await assert.rejects(control.runControlCli(['control', 'disable', '--yes'], { home, terminal: none }), NOT_OWNER);
    await assert.rejects(control.runControlCli(['control', '--yes', 'disable'], { home, terminal: none }), /control action must be status, disable, or enable/);
    const spawned = child(['control', 'disable', '--yes'], home, Object.fromEntries(names.map((name) => [name, 'yes'])));
    assert.notEqual(spawned.status, 0);
    assert.match(spawned.stderr, NOT_OWNER);
  } finally {
    for (const name of names) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
  }
  assert.equal(fs.existsSync(controlFile(home)), false);
});

test('INS-10 a terminal on only some of stdin, stdout and stderr is not the owner terminal', async () => {
  for (const missing of ['stdin', 'stdout', 'stderr']) {
    const home = tempHome();
    const term = fakeTerminal({ tty: { [missing]: false }, answer: (code) => code });
    await assert.rejects(control.runControlCli(['control', 'disable', '--yes'], { home, terminal: term }), NOT_OWNER, missing);
    assert.equal(fs.existsSync(controlFile(home)), false, missing);
    assert.equal(term.codes.length, 0, `${missing}: no code was shown`);
  }
});

test('INS-10 a terminal flag that is truthy but not true (1, "true", an object) is not a terminal', async () => {
  const home = tempHome();
  for (const flag of [1, 'true', {}, 'yes']) {
    const term = fakeTerminal({ answer: (code) => code });
    term.stdin.isTTY = flag; term.stdout.isTTY = flag; term.stderr.isTTY = flag;
    await assert.rejects(control.runControlCli(['control', 'disable', '--yes'], { home, terminal: term }), NOT_OWNER, String(flag));
  }
  assert.equal(fs.existsSync(controlFile(home)), false);
});

// ---- --yes stays a typo guard --------------------------------------------------------------------------------------

test('INS-10 `control disable` without --yes still stops first, even at the owner terminal', async () => {
  const home = tempHome();
  const term = owner();
  await assert.rejects(control.runControlCli(['control', 'disable'], { home, terminal: term }), /requires --yes/);
  assert.equal(term.codes.length, 0);
  assert.equal(fs.existsSync(controlFile(home)), false);
});

// ---- the owner path ------------------------------------------------------------------------------------------------

test('INS-10 the owner at their terminal types the code shown: control is disabled, privately, and Marrow is told once', async () => {
  const home = tempHome();
  const key = dummyKey();
  await withFetchCount(async (calls) => {
    const term = owner();
    const result = await control.runControlCli(['control', 'disable', '--yes'], { home, terminal: term, apiKey: key, baseUrl: 'https://api.example.test' });
    assert.equal(result.state, 'disabled');
    assert.equal(result.changed, true);
    assert.equal(term.codes.length, 1);
    assert.match(term.prompt(), /Only the account owner should do this/);
    assert.match(term.prompt(), /type \d{6} and press Enter/);
    assert.equal(fs.statSync(controlFile(home)).mode & 0o777, 0o600);
    assert.equal(control.readLocalControlState({ home }).enabled, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.event_type, 'journey_update');
    assert.equal(calls[0].body.action, 'local control disabled');
    assert.ok(!term.prompt().includes(key));
  });
});

test('INS-10 the owner path with --json keeps stdout a single JSON document and puts the prompt on stderr', async () => {
  const home = tempHome();
  const term = owner();
  const written = [];
  const original = process.stdout.write;
  process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
  try { await control.runControlCli(['control', 'disable', '--yes', '--json'], { home, terminal: term }); } finally { process.stdout.write = original; }
  const parsed = JSON.parse(written.join(''));
  assert.equal(parsed.local_control.state, 'disabled');
  assert.match(term.prompt(), /\d{6}/);
});

test('INS-10 after a disable the output says whether Marrow was told, and never that it was when it was not', async () => {
  const lines = async (reachable) => {
    const home = tempHome();
    const captured = [];
    const originalWrite = process.stdout.write;
    const originalFetch = global.fetch;
    global.fetch = async () => { if (!reachable) throw new Error('offline'); return { ok: true }; };
    process.stdout.write = (chunk) => { captured.push(String(chunk)); return true; };
    try { await control.runControlCli(['control', 'disable', '--yes'], { home, terminal: owner(), apiKey: dummyKey(), baseUrl: 'https://api.example.test' }); } finally { process.stdout.write = originalWrite; global.fetch = originalFetch; }
    return captured.join('');
  };
  assert.match(await lines(true), /Marrow was told local control is off/);
  const offline = await lines(false);
  assert.match(offline, /Marrow could not be told right now/);
  assert.doesNotMatch(offline, /Marrow was told/);
});

test('INS-10 a code is random and one-time: 20 prompts give varied codes, and an old code does not confirm a new prompt', async () => {
  const seen = new Set();
  for (let index = 0; index < 20; index += 1) {
    const term = owner();
    await control.runControlCli(['control', 'disable', '--yes'], { home: tempHome(), terminal: term });
    seen.add(term.codes[0]);
  }
  assert.ok(seen.size > 10, `codes should vary, saw ${seen.size} distinct`);
  const [old] = seen;
  let refused = 0;
  for (let index = 0; index < 5 && refused === 0; index += 1) {
    const home = tempHome();
    const term = fakeTerminal({ answer: (code) => (code === old ? null : old) });
    await control.runControlCli(['control', 'disable', '--yes'], { home, terminal: term }).then(() => assert.fail('an old code confirmed a new prompt'), (error) => { refused += 1; assert.match(error.message, NOT_CONFIRMED); });
    assert.equal(fs.existsSync(controlFile(home)), false);
  }
  assert.equal(refused, 1);
});

// ---- wrong, empty, missing and late answers ---------------------------------------------------------------------

for (const [name, answer] of [
  ['a wrong code', (code) => String((Number(code) + 1) % 1000000).padStart(6, '0')],
  ['the code with a suffix', (code) => `${code}0`],
  ['the code with a prefix', (code) => `0${code}`],
  ['two codes', (code) => `${code} ${code}`],
  ['an empty line', () => ''],
  ['spaces only', () => '   '],
  ['yes', () => 'yes'],
  ['the word code', () => 'code'],
  ['end of input', () => null],
]) {
  test(`INS-10 ${name} does not confirm: refused, no state change, nothing sent`, async () => {
    const home = tempHome();
    await withFetchCount(async (calls) => {
      const term = fakeTerminal({ answer });
      await assert.rejects(control.runControlCli(['control', 'disable', '--yes'], { home, terminal: term, apiKey: dummyKey(), baseUrl: 'https://api.example.test' }), NOT_CONFIRMED);
      assert.equal(fs.existsSync(controlFile(home)), false);
      assert.equal(calls.length, 0);
    });
  });
}

test('INS-10 no answer in time is a refusal, not a wait forever', async () => {
  const home = tempHome();
  const term = fakeTerminal({}); // shows the prompt, never answers
  await assert.rejects(control.runControlCli(['control', 'disable', '--yes'], { home, terminal: term, confirmTimeoutMs: 80 }), NOT_CONFIRMED);
  assert.equal(fs.existsSync(controlFile(home)), false);
});

// ---- unchanged paths ---------------------------------------------------------------------------------------------------

test('INS-10 `control enable` and `control status` are unchanged: no terminal, no confirmation, no prompt', async () => {
  const home = tempHome();
  control.writeLocalControlState(false, { home });
  const none = fakeTerminal({ tty: { stdin: false, stdout: false, stderr: false } });
  const status = await control.runControlCli(['control', 'status', '--json'], { home, terminal: none });
  assert.equal(status.state, 'disabled');
  const enabled = await control.runControlCli(['control', 'enable'], { home, terminal: none });
  assert.equal(enabled.state, 'enabled');
  assert.equal(enabled.changed, true);
  const again = await control.runControlCli(['control', 'enable'], { home, terminal: none });
  assert.equal(again.changed, false);
  assert.equal(none.prompt(), '');
  const viaBin = child(['control', 'status'], home);
  assert.equal(viaBin.status, 0, viaBin.stderr);
  assert.match(viaBin.stdout, /Marrow local control: enabled\./);
});

test('INS-10 disabling an already disabled control needs no confirmation (nothing is turned off)', async () => {
  const home = tempHome();
  control.writeLocalControlState(false, { home });
  const before = fs.readFileSync(controlFile(home));
  const none = fakeTerminal({ tty: { stdin: false, stdout: false, stderr: false } });
  const result = await control.runControlCli(['control', 'disable', '--yes'], { home, terminal: none });
  assert.equal(result.changed, false);
  assert.deepEqual(fs.readFileSync(controlFile(home)), before);
  assert.equal(none.prompt(), '');
});

test('INS-10 the status text no longer tells an agent to run `control disable --yes`', () => {
  const home = tempHome();
  const enabledText = control.evidence({ home }).exact_next_action;
  assert.doesNotMatch(enabledText, /--yes to disable/);
  assert.match(enabledText, /your own terminal/);
  assert.match(enabledText, /--yes is not proof of the owner/);
  control.writeLocalControlState(false, { home });
  assert.match(control.evidence({ home }).exact_next_action, /control enable/);
});

// ---- fail closed on unsafe state: the state is checked before any prompt ------------------------------------------------

test('INS-10 an unsafe control.json (broad mode, forged owner, symlinked folder) refuses before any prompt', async () => {
  const broad = tempHome();
  fs.mkdirSync(path.join(broad, '.marrow'), { mode: 0o700 });
  fs.writeFileSync(controlFile(broad), `${JSON.stringify({ version: 1, enabled: true, changed_at: new Date().toISOString(), change_id: `ctl_${'a'.repeat(32)}`, changed_by: 'owner_cli' })}\n`, { mode: 0o644 });
  fs.chmodSync(controlFile(broad), 0o644);
  const forged = tempHome();
  fs.mkdirSync(path.join(forged, '.marrow'), { mode: 0o700 });
  fs.writeFileSync(controlFile(forged), JSON.stringify({ version: 1, enabled: true, changed_by: 'agent' }), { mode: 0o600 });
  const outside = tempHome();
  const linked = tempHome();
  fs.symlinkSync(outside, path.join(linked, '.marrow'));
  for (const home of [broad, forged, linked]) {
    const term = owner();
    await assert.rejects(control.runControlCli(['control', 'disable', '--yes'], { home, terminal: term }), /unsafe/);
    assert.equal(term.codes.length, 0, 'no code was shown');
  }
  assert.deepEqual(fs.readdirSync(outside), []);
});

// ---- the real binary under a real pseudo-terminal -----------------------------------------------------------------------

// A python3 pty harness: it runs the real binary on a pty, reads until the six-digit code, then types `reply`
// ("code" = the code shown, anything else is typed as given, "" = nothing). Exit status and output are printed as JSON.
const PTY_DRIVER = `
import json, os, pty, re, select, sys, time
reply = sys.argv[1]
argv = sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execv(argv[0], argv)
out = b''
typed = False
deadline = time.time() + 25
status = None
while time.time() < deadline:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try:
            data = os.read(fd, 4096)
        except OSError:
            data = b''
        if not data:
            break
        out += data
    m = re.search(rb'type (\\d{6}) and press Enter', out)
    if m and not typed:
        typed = True
        text = m.group(1).decode() if reply == 'code' else reply
        os.write(fd, (text + '\\n').encode())
_, st = os.waitpid(pid, 0)
print(json.dumps({'code': os.waitstatus_to_exitcode(st), 'saw_prompt': typed, 'out': out.decode('utf8', 'replace')}))
`;
function underPty(home, reply, args) {
  const result = spawnSync('python3', ['-I', '-c', PTY_DRIVER, reply, process.execPath, BIN, ...args], { env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('INS-10 the real binary on a real pty: the owner typing the shown code disables control; a wrong or empty answer does not', async () => {
  if (process.platform === 'win32') return;
  const wrong = tempHome();
  const miss = underPty(wrong, '000000x', ['control', 'disable', '--yes']);
  assert.equal(miss.saw_prompt, true, miss.out);
  assert.notEqual(miss.code, 0);
  assert.match(miss.out, /not confirmed by the account owner/);
  assert.equal(fs.existsSync(controlFile(wrong)), false);
  const empty = tempHome();
  const none = underPty(empty, '', ['control', 'disable', '--yes']);
  assert.notEqual(none.code, 0);
  assert.equal(fs.existsSync(controlFile(empty)), false);
  const right = tempHome();
  const ok = underPty(right, 'code', ['control', 'disable', '--yes']);
  assert.equal(ok.saw_prompt, true, ok.out);
  assert.equal(ok.code, 0, ok.out);
  assert.equal(control.readLocalControlState({ home: right }).enabled, false);
  const noYes = tempHome();
  const typo = underPty(noYes, 'code', ['control', 'disable']);
  assert.notEqual(typo.code, 0);
  assert.match(typo.out, /requires --yes/);
  assert.equal(typo.saw_prompt, false);
});

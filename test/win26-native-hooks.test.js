// NH (installer 0.1.76, SPEC-WIN26 NH): native Windows hooks only where one written form is usable AND fail-closed in every
// Windows hook shell. Rows NH-xx are exported (`rows`, `runRows`) so a CI runner can print "id PASS|FAIL" and nothing else;
// NH-Wxx rows run only on real Windows (cmd.exe, PowerShell 5.1, pwsh 7, Git Bash invocation of the written command).
// Off Windows the bash column of every form is run for real (bash with a stand-in node); cmd.exe and PowerShell are NOT VERIFIED
// there. The measured table in src/windows-hooks.js (FORM_MATRIX, CELL_LENGTH_BOUND) is filled only from a windows-latest run of the
// probe (test/support/win26-nh-probe.cjs); CLAIMS below are what was expected, not a measurement, and decide nothing.
require('./support/isolated-environment');
const probe = require('./support/win26-nh-probe.cjs');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  CELL_LENGTH_BOUND,
  DECISION_STATUSES,
  FORM_MATRIX,
  HOST_SHELL_EVIDENCE,
  MEASURE_RUN,
  WINDOWS_FORMS,
  WINDOWS_FORM_WRITER_WIRED,
  WINDOWS_HOOK_HOSTS,
  WINDOWS_HOOK_SKIP_REASON,
  WINDOWS_PLUGIN_ROUTE,
  WINDOWS_SHELLS,
  decideForm,
  decideHost,
  decideHostWith,
  hostSkipped,
  longestCommandLine,
  windowsHookHost,
  windowsHookSkipEntries,
} = require('../src/windows-hooks');
const {
  WINDOWS_CMD_LIMIT,
  WINDOWS_HOOK_FORMS,
  WINDOWS_HOOK_MAX,
  assertWindowsCmdLength,
  launcherPath,
  localizeHookCommand,
  runtimeCore,
  verifyMcpRuntime,
  windowsCmdLineLength,
  windowsHookCommand,
  windowsStubSource,
  writeWindowsLauncher,
} = require('../src/mcp-runtime');
const { applyPlan, buildPlan, detectEnvironment, install, uninstall } = require('../src/installer');

const {
  CFG, EVENT, FAKE, PIN, PRE, WIN, fixture, gitBash, gone, launcherDigest, missingNode, runIn, shellEnv, shellsHere, tempDir, windowsLauncherText,
} = probe;
const POSIX_ONLY = !WIN;
// What the first builder CLAIMED each form does in each shell. A claim is not a measurement: src/windows-hooks.js holds the CI
// measurement only (today none). NH-W1 checks these claims on windows-latest; a refuted claim is a finding, never a switch.
const CLAIMS = Object.freeze({
  cmd: Object.freeze({ cmd: 'works', bash: 'closed', powershell: 'open', pwsh: 'open' }),
  bash: Object.freeze({ cmd: 'open', bash: 'works', powershell: 'open', pwsh: 'open' }),
  powershell: Object.freeze({ cmd: 'open', bash: 'closed', powershell: 'works', pwsh: 'works' }),
});
const SUBS = {
  'claude-code': ['claude-context-hook', 'claude-pre-action-hook', 'claude-hook', 'claude-session-hook', 'claude-permission-request-hook'],
  codex: ['codex-context-hook', 'codex-pre-action-hook', 'codex-hook', 'codex-session-hook'],
  cursor: ['cursor-pre-action-hook', 'cursor-hook', 'cursor-session-hook', 'cursor-context-hook'],
  cline: ['cline-pre-action-hook', 'cline-hook', 'cline-session-hook'],
  windsurf: ['windsurf-pre-action-hook', 'windsurf-hook', 'windsurf-session-hook'],
  gemini: ['gemini-pre-action-hook', 'gemini-hook', 'gemini-session-hook', 'gemini-context-hook'],
};
const FAILURES = ['node-missing', 'launcher-foreign', 'launcher-edited', 'launcher-planted', 'launcher-missing', 'runtime-swapped'];

const rows = [];
function row(id, title, fn, { windowsOnly = false, posixOnly = false } = {}) {
  rows.push({ id, title, fn, skip: (windowsOnly && !WIN) ? 'needs real Windows (cmd.exe, PowerShell, Git Bash)' : (posixOnly && WIN) ? 'POSIX mode bits are not meaningful on Windows' : false });
}

// What one form does in one shell, for a pre-action entry: the allow path and each failure.
function observe(form, shell) {
  const f = fixture();
  try {
    const run = (nodePath, digest = f.digest) => {
      const command = windowsHookCommand(PIN, PRE, { form, nodePath, digest });
      return runIn(shell, command, { cwd: f.cwd, env: shellEnv(f.dir) }).status;
    };
    const ran = () => fs.existsSync(path.join(f.dir, `genuine-${PRE}`));
    const out = { allow: run(f.nodePath), allowRan: ran(), failures: {}, ranOnFailure: [] };
    const fail = (name, status) => {
      out.failures[name] = status;
      if (ran()) out.ranOnFailure.push(name);
      fs.rmSync(path.join(f.dir, `genuine-${PRE}`), { force: true });
    };
    fs.rmSync(path.join(f.dir, `genuine-${PRE}`), { force: true });
    fail('node-missing', run(missingNode));
    fail('launcher-foreign', run(f.nodePath, 'f'.repeat(64)));
    // One byte appended (a newline: the loader still evaluates, so only the sha256 check can refuse it), then extra code that
    // would leave a marker if it ran.
    const original = fs.readFileSync(f.path);
    fs.writeFileSync(f.path, Buffer.concat([original, Buffer.from('\n')]));
    fail('launcher-edited', run(f.nodePath));
    fs.writeFileSync(f.path, Buffer.concat([original, Buffer.from(";require('fs').writeFileSync(require('path').join(process.env.HOME,'tampered-ran'),'1');\n")]));
    fail('launcher-planted', run(f.nodePath));
    if (fs.existsSync(path.join(f.dir, 'tampered-ran'))) out.ranOnFailure.push('launcher-planted-code');
    fs.rmSync(f.path);
    fail('launcher-missing', run(f.nodePath));
    writeWindowsLauncher(f.dir, CFG);
    fs.rmSync(path.join(f.dir, '.marrow', 'runtime', 'mcp', PIN), { recursive: true, force: true });
    fail('runtime-swapped', run(f.nodePath));
    return out;
  } finally {
    f.cleanup();
  }
}

function classOf(obs) {
  const closed = Object.values(obs.failures).every((status) => status === 2) && obs.ranOnFailure.length === 0;
  return closed ? (obs.allow === 0 && obs.allowRan ? 'works' : 'closed') : 'open';
}
// A declared works/closed cell must hold; a declared open cell makes no claim (it is the assumption for a shell nobody ran).
function claimHolds(form, column, obs) {
  const declared = CLAIMS[form][column];
  const seen = classOf(obs);
  if (declared === 'works') return seen === 'works';
  if (declared === 'closed') return seen === 'works' || seen === 'closed';
  return true;
}

// ---------------------------------------------------------------------------------------------------------------------
row('NH-01', 'decision table: with no host shell evidence and no measurement every host gets no form (status skipped, reason recorded), keeps the L-1 skip entry, and nothing frozen can be edited', () => {
  assert.deepEqual(WINDOWS_HOOK_HOSTS.map((entry) => entry.client), ['claude-code', 'codex', 'cursor', 'cline', 'windsurf', 'gemini']);
  for (const entry of WINDOWS_HOOK_HOSTS) {
    assert.equal(entry.form, decideForm(entry), entry.client);
    assert.equal(entry.form, null, `${entry.client}: no evidence, no measurement`);
    assert.equal(entry.status, 'skipped', entry.client);
    assert.equal(entry.reason, entry.candidate === 'plain' ? 'no_host_shell_evidence' : 'no_short_entry', entry.client);
    assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.shells), entry.client);
    assert.notEqual(windowsHookHost({ windowsHooksSkipped: true }, entry.client), null, entry.client);
  }
  assert.notEqual(windowsHookHost({ windowsHooksSkipped: true }, 'composer'), null, 'the Cursor Composer alias is skipped too');
  assert.ok(Object.isFrozen(WINDOWS_HOOK_HOSTS) && Object.isFrozen(FORM_MATRIX) && WINDOWS_HOOK_FORMS.every((form) => Object.isFrozen(FORM_MATRIX[form])));
  assert.ok(Object.isFrozen(HOST_SHELL_EVIDENCE) && Object.isFrozen(CELL_LENGTH_BOUND) && WINDOWS_HOOK_FORMS.every((form) => Object.isFrozen(CELL_LENGTH_BOUND[form])));
  assert.equal(WINDOWS_HOOK_SKIP_REASON, 'windows_hook_shell_unverified');
  assert.equal(WINDOWS_FORM_WRITER_WIRED, false, 'the installer has no Windows form writer');
});

row('NH-02', 'measured table: 3 forms x 4 shells (cmd.exe, Git Bash, Windows PowerShell 5.1, pwsh 7), every cell unmeasured until a CI run fills it; evidence empty; the run id, bounds and cells are all-or-nothing', () => {
  assert.deepEqual(Object.keys(FORM_MATRIX).sort(), [...WINDOWS_HOOK_FORMS].sort());
  assert.deepEqual([...WINDOWS_FORMS].sort(), [...WINDOWS_HOOK_FORMS].sort());
  assert.deepEqual([...WINDOWS_SHELLS], ['cmd', 'bash', 'powershell', 'pwsh']);
  const cells = [];
  for (const form of WINDOWS_HOOK_FORMS) {
    assert.deepEqual(Object.keys(FORM_MATRIX[form]).sort(), [...WINDOWS_SHELLS].sort(), form);
    for (const shell of WINDOWS_SHELLS) {
      assert.ok(['works', 'closed', 'open', 'unmeasured'].includes(FORM_MATRIX[form][shell]), `${form}/${shell}`);
      cells.push(FORM_MATRIX[form][shell]);
    }
  }
  for (const form of WINDOWS_HOOK_FORMS) {
    assert.deepEqual(Object.keys(CELL_LENGTH_BOUND[form]).sort(), [...WINDOWS_SHELLS].sort(), form);
    assert.ok(Object.values(CELL_LENGTH_BOUND[form]).every((bound) => Number.isInteger(bound) && bound >= 0), form);
  }
  // All-or-nothing: a measured cell or bound exists only together with the CI run id that produced it, and a partial matrix is refused.
  const bounds = WINDOWS_HOOK_FORMS.flatMap((form) => Object.values(CELL_LENGTH_BOUND[form]));
  const measured = cells.some((cell) => cell !== 'unmeasured') || bounds.some((bound) => bound > 0);
  assert.equal(measured, MEASURE_RUN !== null, 'a measurement without a run id, or a run id without a measurement');
  if (MEASURE_RUN !== null) assert.match(MEASURE_RUN, /^[0-9]{6,20}$/);
  if (measured) assert.ok(cells.every((cell) => cell !== 'unmeasured'), 'a partial measurement is not accepted');
  assert.deepEqual(Object.keys(HOST_SHELL_EVIDENCE), [], 'no host shell evidence is supplied today');
  // Nothing forged can enable a host: the tables are frozen and the decision reads only the module's own constants.
  assert.throws(() => { 'use strict'; FORM_MATRIX.cmd.cmd = 'works'; }, TypeError);
  assert.throws(() => { 'use strict'; CELL_LENGTH_BOUND.cmd.cmd = 9000; }, TypeError);
  assert.throws(() => { 'use strict'; HOST_SHELL_EVIDENCE['claude-code'] = {}; }, TypeError);
  assert.equal(decideForm({ candidate: 'plain' }), null);
  assert.equal(decideForm({ candidate: 'guard' }), null);
});

row('NH-03', 'length: every entry of every host in every form is at most WINDOWS_HOOK_MAX characters and its cmd.exe line at most 8191, even with the longest version, entrypoint and node path (500 characters, a 200+ character profile)', () => {
  const digest = launcherDigest(windowsLauncherText(CFG));
  const long = `C:\\Users\\${'ü'.repeat(120)} Müller\\${'a'.repeat(250)}\\node.exe`;
  assert.ok(long.length > 200 && long.length <= 500);
  const nodes = ['C:\\Program Files\\nodejs\\node.exe', long, `C:\\${'x'.repeat(488)}\\node.exe`.slice(0, 500)];
  let longest = 0;
  for (const [client, subs] of Object.entries(SUBS)) {
    for (const sub of [...subs, 'a'.repeat(64)]) {
      for (const form of WINDOWS_HOOK_FORMS) {
        for (const nodePath of nodes) {
          const command = windowsHookCommand('9999999.9999999.9999999', sub, { form, nodePath, digest });
          assert.ok(command.length <= WINDOWS_HOOK_MAX, `${client} ${sub} ${form}: ${command.length}`);
          assert.ok(windowsCmdLineLength(command) <= WINDOWS_CMD_LIMIT);
          longest = Math.max(longest, command.length);
        }
      }
    }
  }
  assert.ok(longest > 1000 && longest < WINDOWS_HOOK_MAX, `longest ${longest}`);
  assert.equal(WINDOWS_HOOK_MAX < WINDOWS_CMD_LIMIT, true);
});

row('NH-04', 'length of the 0.1.73 inline form: every canonical entry localized for win32 is over 8191 characters, so no host can carry it (the reason a short form is the only candidate)', () => {
  const subs = Object.values(SUBS).flat();
  for (const sub of subs) {
    const inline = localizeHookCommand(`npx -y --package=@getmarrow/mcp@${PIN} marrow-mcp ${sub}`, PIN, { platform: 'win32' });
    assert.ok(inline.length > WINDOWS_CMD_LIMIT, `${sub}: ${inline.length}`);
  }
});

row('NH-05', 'bash column, run for real: each form with a stand-in node: allow runs the genuine runtime; node missing, a foreign or edited or missing launcher and a swapped runtime end in exit 2 and never run the runtime; the declared cell holds', () => {
  if (!gitBash()) return;
  for (const form of WINDOWS_HOOK_FORMS) {
    const obs = observe(form, 'bash');
    assert.equal(claimHolds(form, 'bash', obs), true, `${form}: ${JSON.stringify(obs)}`);
    if (CLAIMS[form].bash === 'works') {
      assert.equal(obs.allow, 0, `${form} allow`);
      assert.equal(obs.allowRan, true);
    }
    assert.deepEqual(obs.ranOnFailure, [], `${form}: the runtime ran on a failure`);
    for (const name of FAILURES) assert.equal(obs.failures[name], 2, `${form} ${name}`);
  }
});

row('NH-06', 'a non-pre-action entry never blocks: no tail, node missing is the shell code (127) and the stub failure is 1, so a post hook cannot turn into a block', () => {
  if (!gitBash()) return;
  const f = fixture();
  try {
    const sub = 'claude-hook';
    const ok = runIn('bash', windowsHookCommand(PIN, sub, { form: 'bash', nodePath: f.nodePath, digest: f.digest }), { cwd: f.cwd, env: shellEnv(f.dir) });
    assert.equal(ok.status, 0, ok.stderr);
    const none = runIn('bash', windowsHookCommand(PIN, sub, { form: 'bash', nodePath: missingNode, digest: f.digest }), { cwd: f.cwd, env: shellEnv(f.dir) });
    assert.notEqual(none.status, 2);
    fs.rmSync(f.path);
    const held = runIn('bash', windowsHookCommand(PIN, sub, { form: 'bash', nodePath: f.nodePath, digest: f.digest }), { cwd: f.cwd, env: shellEnv(f.dir) });
    assert.equal(held.status, 1, held.stderr);
    for (const form of WINDOWS_HOOK_FORMS) assert.doesNotMatch(windowsHookCommand(PIN, sub, { form, nodePath: f.nodePath, digest: f.digest }).replace(windowsStubSource(f.digest), ''), /exit 2|\|\||LASTEXITCODE|try/);
  } finally {
    f.cleanup();
  }
});

row('NH-07', 'abuse, node path: cmd metacharacters, quotes, % ^ & | ! $ backtick, control characters, UNC, \\\\?\\, relative, a .. part, a curly quote and a name ending in a space are refused by every form; spaces and a non-ASCII user name are kept', () => {
  const digest = launcherDigest(windowsLauncherText(CFG));
  const good = ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Program Files (x86)\\nodejs\\node.exe', 'D:\\Users\\José Müller\\scoop\\apps\\nodejs\\current\\node.exe', 'C:\\Users\\用户\\nvm\\v22.23.2\\node.exe', 'C:\\Users\\a(b)\\node.exe'];
  const bad = ['node', 'node.exe', '.\\node.exe', '\\\\server\\share\\node.exe', '\\\\?\\C:\\nodejs\\node.exe', '\\\\.\\C:\\node.exe', 'C:/nodejs/node.exe', 'C:\\nodejs\\node.cmd',
    'C:\\a"b\\node.exe', 'C:\\%PATH%\\node.exe', 'C:\\a!b\\node.exe', 'C:\\a^b\\node.exe', 'C:\\a&b\\node.exe', 'C:\\a|b\\node.exe', 'C:\\a$b\\node.exe', 'C:\\a`b\\node.exe',
    "C:\\a'b\\node.exe", 'C:\\a\nb\\node.exe', 'C:\\a<b\\node.exe', 'C:\\a\u201cb\\node.exe', 'C:\\a\u2019b\\node.exe', 'C:\\a\\..\\b\\node.exe', 'C:\\a\\.\\node.exe', 'C:\\a \\node.exe',
    'C:\\a.\\node.exe', 'C:\\nodejs\\node.exe ', `C:\\${'x'.repeat(500)}\\node.exe`, '', undefined, 7];
  for (const form of WINDOWS_HOOK_FORMS) {
    for (const nodePath of good) assert.match(windowsHookCommand(PIN, PRE, { form, nodePath, digest }), /^(try \{ & )?"[^"]+" -e "/, `${form} ${nodePath}`);
    for (const nodePath of bad) assert.throws(() => windowsHookCommand(PIN, PRE, { form, nodePath, digest }), /safe absolute Windows path/, `${form} ${JSON.stringify(nodePath)}`);
    for (const sub of ['', 'Claude-hook', 'a b', "x'y", 'a;b', 'a'.repeat(65), '-x', 'x$(y)']) assert.throws(() => windowsHookCommand(PIN, sub, { form, nodePath: good[0], digest }), /invalid entrypoint/, `${form} ${sub}`);
    for (const version of ['', '3.9', '3.9.107;x', '3.9.107"', `${'9'.repeat(30)}.1.1`]) assert.throws(() => windowsHookCommand(version, PRE, { form, nodePath: good[0], digest }), /invalid MCP version/, `${form} ${version}`);
    for (const bogus of ['', 'abc', 'A'.repeat(64), `${'0'.repeat(63)}"`]) assert.throws(() => windowsHookCommand(PIN, PRE, { form, nodePath: good[0], digest: bogus }), /invalid launcher digest/, `${form} ${bogus}`);
  }
  assert.throws(() => windowsHookCommand(PIN, PRE, { form: 'sh', nodePath: good[0], digest }), /unknown Windows hook form/);
  assert.throws(() => windowsHookCommand(PIN, PRE, { nodePath: good[0], digest: 'x' }), /invalid launcher digest/);
});

row('NH-08', 'length boundary: a command line of 8190 and 8191 characters is allowed, 8192 is refused; the generator cap can only be lowered, never raised', () => {
  const wrap = windowsCmdLineLength('') ;
  for (const [length, ok] of [[8190, true], [8191, true], [8192, false], [20_000, false]]) {
    const command = 'x'.repeat(length - wrap);
    assert.equal(windowsCmdLineLength(command), length);
    if (ok) assert.equal(assertWindowsCmdLength(command), command, String(length));
    else assert.throws(() => assertWindowsCmdLength(command), /longer than 8191/, String(length));
  }
  assert.throws(() => assertWindowsCmdLength(undefined), /longer than 8191/);
  const digest = launcherDigest(windowsLauncherText(CFG));
  const options = { nodePath: 'C:\\Program Files\\nodejs\\node.exe', digest };
  const length = windowsHookCommand(PIN, PRE, options).length;
  assert.throws(() => windowsHookCommand(PIN, PRE, { ...options, limit: length - 1 }), /characters \(limit/);
  assert.equal(windowsHookCommand(PIN, PRE, { ...options, limit: length }).length, length);
  assert.equal(windowsHookCommand(PIN, PRE, { ...options, limit: 1e9 }).length, length, 'a higher limit changes nothing');
  assert.throws(() => windowsHookCommand(PIN, PRE, { ...options, limit: 100 }), /characters \(limit 100\)/);
});

row('NH-09', 'launcher: written only into the private Marrow folder under the home, 0700 folders and 0600 file, named by its own sha256; a swapped or one-byte-edited loader is refused by the stub and never runs', () => {
  const f = fixture();
  try {
    assert.equal(f.path, launcherPath(f.dir, f.digest));
    assert.ok(f.path.startsWith(path.join(f.dir, '.marrow', 'runtime', 'launcher') + path.sep));
    assert.equal(path.basename(f.path), `${f.digest}.cjs`);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(f.path)).digest('hex'), f.digest);
    if (!WIN) {
      for (const dir of [path.join(f.dir, '.marrow'), path.join(f.dir, '.marrow', 'runtime'), path.dirname(f.path)]) assert.equal(fs.statSync(dir).mode & 0o777, 0o700, dir);
      assert.equal(fs.statSync(f.path).mode & 0o777, 0o600);
    }
    assert.equal(windowsStubSource(f.digest).includes(`=='${f.digest}'`), true, 'the stub carries the digest it checks');
    assert.equal(writeWindowsLauncher(f.dir, CFG).state, 'present', 'a second write changes nothing');
  } finally {
    f.cleanup();
  }
});

row('NH-10', 'HOME and USERPROFILE: the stub reads the launcher from os.homedir() only, so a decoy HOME holding a valid launcher never runs when the real home has none', () => {
  if (WIN) return;
  const f = fixture();
  const decoy = fixture();
  try {
    // POSIX os.homedir() is HOME: point HOME at the home with no launcher, USERPROFILE at the one that has it.
    fs.rmSync(f.path);
    const command = windowsHookCommand(PIN, PRE, { form: 'bash', nodePath: f.nodePath, digest: f.digest });
    const result = runIn('bash', command, { cwd: f.cwd, env: { ...shellEnv(f.dir), USERPROFILE: decoy.dir } });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(fs.existsSync(path.join(f.dir, `genuine-${PRE}`)) || fs.existsSync(path.join(decoy.dir, `genuine-${PRE}`)), false);
  } finally {
    f.cleanup();
    decoy.cleanup();
  }
}, { posixOnly: true });

row('NH-11', 'an existing user hook is kept and a second install changes nothing: on win32 no host file is written, the owner entry stays byte for byte, and each detected host is reported skipped', async () => {
  const { project, withPlatform, installOptions, snapshot } = harness();
  const p = project();
  try {
    const settings = path.join(p.root, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    const owner = `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo owner-hook' }] }] } }, null, 2)}\n`;
    fs.writeFileSync(settings, owner);
    const options = installOptions(p, {});
    const first = await withPlatform('win32', () => install(options));
    assert.equal(fs.readFileSync(settings, 'utf8'), owner);
    const before = snapshot(p.root);
    const second = await withPlatform('win32', () => install(options));
    assert.deepEqual(snapshot(p.root), before, 'a second run changes nothing');
    for (const report of [first, second]) {
      const hosts = (report.skipped_hosts || []).map((entry) => entry.host);
      for (const host of ['Claude Code', 'Codex', 'Cursor', 'Cline', 'Windsurf', 'Gemini CLI']) assert.ok(hosts.includes(host), host);
    }
  } finally {
    p.cleanup();
  }
}, { posixOnly: true });

row('NH-12', 'skip route: every skipped host carries the I-1 plugin-route text and the reason windows_hook_shell_unverified, and is never configured', () => {
  const detection = { windowsHooksSkipped: true, paths: {} };
  for (const entry of WINDOWS_HOOK_HOSTS) detection[entry.detected] = true;
  const skipped = windowsHookSkipEntries(detection);
  assert.deepEqual(skipped.map((entry) => entry.host), WINDOWS_HOOK_HOSTS.map((entry) => entry.host));
  for (const entry of skipped) {
    assert.equal(entry.reason, 'windows_hook_shell_unverified');
    assert.equal(entry.configured, false);
    assert.equal(entry.action, 'skipped');
    assert.ok(entry.message.endsWith(WINDOWS_PLUGIN_ROUTE), entry.host);
  }
  assert.equal(WINDOWS_PLUGIN_ROUTE, 'On Windows, this installer does not set up Marrow hooks yet. Windows hook support is coming in a later release.');
  assert.deepEqual(windowsHookSkipEntries({ ...detection, windowsHooksSkipped: false }).length, process.platform === 'win32' ? 6 : 0);
});

row('NH-13', 'forged inputs: on POSIX a win32 environment, option or argv never skips a host, and on win32 an injected platform, a hand-built detection or an option never writes a hook', async () => {
  const { project, withPlatform, installOptions } = harness();
  const p = project();
  try {
    const posix = detectEnvironment(p.root, p.env, { platform: 'linux' });
    assert.equal(posix.windowsHooksSkipped, process.platform === 'win32');
    const forged = detectEnvironment(p.root, { ...p.env, MARROW_PLATFORM: 'win32', OS: 'Windows_NT' }, {});
    assert.equal(forged.windowsHooksSkipped, process.platform === 'win32');
    for (const label of ['Claude Code MCP passive hooks', 'Codex native hooks', 'Cursor native hooks']) assert.ok(buildPlan(forged, { mode: 'mcp' }).writes.some((write) => write.label === label), label);
    await withPlatform('win32', async () => {
      const real = detectEnvironment(p.root, p.env, { platform: 'linux' });
      assert.equal(real.windowsHooksSkipped, true, 'a real win32 host cannot be told it is POSIX');
      const plan = buildPlan(real, { mode: 'mcp', hookPlatform: 'linux', platform: 'linux' });
      assert.deepEqual(plan.writes.filter((write) => /hooks/.test(write.label)), []);
      assert.equal(plan.skipped_hosts.length, 6);
    });
    assert.ok(installOptions(p, {}));
  } finally {
    p.cleanup();
  }
}, { posixOnly: true });

row('NH-14', 'Q5 on the win32 path: the staged runtime sits under the real path of a HOME behind a symlinked parent, and the verified copy is found through both paths', () => {
  if (WIN) return;
  const work = tempDir('marrow-nh-q5-');
  try {
    const realHome = path.join(work, 'real');
    fs.mkdirSync(realHome, { mode: 0o700 });
    fs.symlinkSync(work, path.join(work, 'link'));
    const home = path.join(work, 'link', 'real');
    assert.notEqual(fs.realpathSync(home), home);
    const stages = [];
    const result = runtimeCore.ensure({ home, version: PIN, integrity: FAKE, sdk: null, platform: 'win32', npmInstall: (stage, specs) => { stages.push(stage); return probe.fakeRuntimePackage(probe.ALLOW_CLI)(stage, specs); } });
    assert.equal(result.state, 'installed', JSON.stringify(result));
    assert.ok(stages[0].startsWith(path.join(fs.realpathSync(realHome), '.marrow', 'runtime', 'mcp', '.stage-')), stages[0]);
    assert.ok(verifyMcpRuntime(home, PIN, FAKE, { platform: 'win32' }));
    assert.ok(verifyMcpRuntime(realHome, PIN, FAKE, { platform: 'win32' }));
  } finally {
    gone(work);
  }
}, { posixOnly: true });

row('NH-15', 'POSIX hook text is untouched: no localized Linux or macOS command carries a Windows form, and the installer reaches no Windows form on its own', () => {
  const digest = launcherDigest(windowsLauncherText(CFG));
  const windowsForms = WINDOWS_HOOK_FORMS.map((form) => windowsHookCommand(PIN, PRE, { form, nodePath: 'C:\\Program Files\\nodejs\\node.exe', digest }));
  for (const platform of ['linux', 'darwin']) {
    for (const sub of Object.values(SUBS).flat()) {
      const text = localizeHookCommand(`npx -y --package=@getmarrow/mcp@${PIN} marrow-mcp ${sub}`, PIN, { platform });
      assert.match(text, /^\/bin\/sh -c '/);
      for (const form of windowsForms) assert.equal(text.includes(form.slice(0, 40)), false);
      assert.doesNotMatch(text, /errorlevel|\$LASTEXITCODE|-EncodedCommand|node\.exe/);
    }
  }
  const installer = fs.readFileSync(path.join(__dirname, '..', 'src', 'installer.js'), 'utf8');
  assert.equal(/windowsHookCommand|windowsStubCommand|writeWindowsLauncher/.test(installer), false, 'no installer path writes a Windows form while no host has one');
});

// ---------------------------------------------------------------------------------------------------------------------
// The switch-on rule (decideHostWith) with INJECTED tables. Production reads only the frozen module constants (NH-01, NH-02, NH-19);
// these rows show that a host is decided only when every proof is present, and that each missing proof leaves the L-1 skip.
const NEEDED = longestCommandLine();
const record = (over = {}) => ({ shells: ['cmd'], selection: 'pinned', source: 'live-check', ref: 'live check on a real Windows machine', ownerAccepted: false, deny: 'exit2', denyRef: 'live check, exit 2 blocked', ...over });
const tablesWith = (over = {}, evidence = record(), client = 'claude-code') => ({
  matrix: {
    cmd: { cmd: 'works', bash: 'closed', powershell: 'open', pwsh: 'open' },
    bash: { cmd: 'open', bash: 'works', powershell: 'open', pwsh: 'open' },
    powershell: { cmd: 'open', bash: 'closed', powershell: 'works', pwsh: 'works' },
  },
  bounds: {
    cmd: { cmd: 8191, bash: 0, powershell: 0, pwsh: 0 },
    bash: { cmd: 0, bash: 8192, powershell: 0, pwsh: 0 },
    powershell: { cmd: 0, bash: 0, powershell: 8192, pwsh: 8192 },
  },
  run: '24999999999',
  evidence: { [client]: evidence },
  ...over,
});
const decideFor = (tables, facts = { client: 'claude-code', candidate: 'plain' }) => decideHostWith(facts, tables);

row('NH-16', 'switch-on rule: a host is decided only with a host shell record, a CI-measured works cell in EVERY shell of that record, a length bound that covers the longest command, a run id and a deny path of exit 2; each missing proof keeps the skip', () => {
  const ok = decideFor(tablesWith());
  assert.deepEqual({ ...ok }, { form: 'cmd', status: 'form_decided', reason: 'proven' });
  assert.equal(decideFor(tablesWith({}, record({ shells: ['bash'] }))).form, 'bash');
  assert.equal(decideFor(tablesWith({}, record({ shells: ['powershell'] }))).form, 'powershell');
  assert.equal(decideFor(tablesWith({}, record({ shells: ['powershell', 'pwsh'], selection: 'fixed-set' }))).form, 'powershell');
  const skipped = (tables, reason, facts) => {
    const d = decideFor(tables, facts);
    assert.equal(d.form, null, reason);
    assert.equal(d.status, 'skipped', reason);
    assert.equal(d.reason, reason);
  };
  // every allowed shell needs the SAME form to work: one open, closed or unmeasured cell skips the host
  skipped(tablesWith({}, record({ shells: ['cmd', 'bash'], selection: 'fixed-set' })), 'no_form_works_in_every_shell');
  skipped(tablesWith({}, record({ shells: ['cmd', 'pwsh'], selection: 'fixed-set' })), 'no_form_works_in_every_shell');
  for (const cell of ['open', 'closed', 'unmeasured']) {
    const tables = tablesWith({}, record({ shells: ['powershell', 'pwsh'], selection: 'fixed-set' }));
    tables.matrix.powershell.pwsh = cell;
    skipped(tables, 'no_form_works_in_every_shell');
    const one = tablesWith();
    one.matrix.cmd.cmd = cell;
    skipped(one, 'no_form_works_in_every_shell');
  }
  // no short entry, no record, a record for another host
  for (const candidate of ['guard', 'script', 'wrapper', undefined, '']) skipped(tablesWith(), 'no_short_entry', { client: 'claude-code', candidate });
  skipped(tablesWith({ evidence: {} }), 'no_host_shell_evidence');
  skipped(tablesWith({}, record(), 'codex'), 'no_host_shell_evidence');
  skipped(tablesWith(), 'no_host_shell_evidence', { client: '__proto__', candidate: 'plain' });
  skipped(tablesWith(), 'no_host_shell_evidence', { client: 'constructor', candidate: 'plain' });
  skipped(tablesWith(), 'no_host_shell_evidence', { candidate: 'plain' });
  // a shell chosen by user setup is never switched on; a deny that is not exit 2 cannot be produced by the written forms
  skipped(tablesWith({}, record({ selection: 'user-setup' })), 'shell_chosen_by_user_setup');
  skipped(tablesWith({}, record({ deny: 'json' })), 'deny_path_unproven');
  // malformed records are the same as no record
  const malformed = [
    { shells: [] }, { shells: ['cmd', 'cmd'], selection: 'fixed-set' }, { shells: ['zsh'] }, { shells: 'cmd' }, { shells: ['cmd', 'bash'] },
    { selection: 'maybe' }, { source: 'blog' }, { ref: '' }, { ref: 'café' }, { ref: 'x'.repeat(401) }, { denyRef: '' },
    { ownerAccepted: 'yes' }, { ownerAccepted: undefined }, { deny: 'exit1' },
  ];
  for (const over of malformed) skipped(tablesWith({}, record(over)), 'evidence_invalid');
  for (const key of Object.keys(record())) {
    const partial = record();
    delete partial[key];
    skipped(tablesWith({}, partial), 'evidence_invalid');
  }
  skipped(tablesWith({}, { ...record(), extra: 'x' }), 'evidence_invalid');
  skipped(tablesWith({}, null), 'evidence_invalid');
  skipped(tablesWith({}, [record()]), 'evidence_invalid');
  // the length bound: it must cover the longest command line the generator can write, in EVERY allowed shell
  assert.equal(NEEDED, windowsCmdLineLength('x'.repeat(WINDOWS_HOOK_MAX)));
  assert.ok(NEEDED < WINDOWS_CMD_LIMIT);
  const bounded = (n) => { const t = tablesWith(); t.bounds.cmd.cmd = n; return t; };
  assert.equal(decideFor(bounded(NEEDED)).form, 'cmd');
  skipped(bounded(NEEDED - 1), 'length_bound_unproven');
  skipped(bounded(0), 'length_bound_unproven');
  skipped(bounded(100), 'length_bound_unproven');
  // the bound is per form and shell: a long bound for another form or another shell does not help
  const otherShell = bounded(0);
  otherShell.bounds.cmd.bash = 8192;
  skipped(otherShell, 'length_bound_unproven');
  const otherForm = bounded(0);
  otherForm.bounds.bash.cmd = 8192;
  skipped(otherForm, 'length_bound_unproven');
  const two = tablesWith({}, record({ shells: ['powershell', 'pwsh'], selection: 'fixed-set' }));
  two.bounds.powershell.pwsh = 100;
  skipped(two, 'length_bound_unproven');
  // a second form that works in the same shell with a proven bound is chosen over a first form whose bound is short
  const second = tablesWith({}, record({ shells: ['bash'] }));
  second.matrix.cmd.bash = 'works';
  second.bounds.cmd.bash = 10;
  second.bounds.bash.bash = 8192;
  assert.equal(decideFor(second).form, 'bash');
  const lacksForm = tablesWith();
  delete lacksForm.bounds.powershell;
  skipped(lacksForm, 'tables_invalid');
  const lacksShell = tablesWith();
  delete lacksShell.bounds.cmd.pwsh;
  skipped(lacksShell, 'tables_invalid');
  const fraction = tablesWith();
  fraction.bounds.cmd.cmd = 8191.5;
  skipped(fraction, 'tables_invalid');
  // the measurement must name its CI run
  skipped(tablesWith({ run: null }), 'measurement_run_unrecorded');
  skipped(tablesWith({ run: 'abc' }), 'tables_invalid');
  skipped(tablesWith({ run: 12345678 }), 'tables_invalid');
  // a malformed table is a skip, never a throw
  skipped(tablesWith({ matrix: null }), 'tables_invalid');
  const odd = tablesWith();
  odd.matrix.cmd.cmd = 'maybe';
  skipped(odd, 'tables_invalid');
  const lacking = tablesWith();
  delete lacking.matrix.powershell;
  skipped(lacking, 'tables_invalid');
  assert.equal(decideHostWith(null, tablesWith()).reason, 'facts_invalid');
  assert.equal(decideHostWith({ client: 'claude-code', candidate: 'plain' }, null).reason, 'facts_invalid');
});

row('NH-17', 'vendor document alone is "ready, owner decision" and still skipped; the owner accepting it, or a live check, decides; the status words are fixed', () => {
  const vendor = (accepted) => record({ source: 'vendor-doc', ref: 'https://example.invalid/hooks (quoted sentence, 2026-10-26)', ownerAccepted: accepted });
  const waiting = decideFor(tablesWith({}, vendor(false)));
  assert.deepEqual({ ...waiting }, { form: null, status: 'ready_owner_decision', reason: 'vendor_doc_needs_owner_decision' });
  assert.equal(decideFor(tablesWith({}, vendor(true))).form, 'cmd');
  assert.equal(decideFor(tablesWith({}, record({ source: 'live-check', ownerAccepted: false }))).form, 'cmd');
  // "ready" is only reported when everything else holds: a vendor document with an open cell, no run id or a short bound is a plain skip
  const open = tablesWith({}, vendor(false));
  open.matrix.cmd.cmd = 'open';
  assert.equal(decideFor(open).status, 'skipped');
  assert.equal(decideFor(tablesWith({ run: null }, vendor(false))).status, 'skipped');
  const short = tablesWith({}, vendor(false));
  short.bounds.cmd.cmd = 10;
  assert.equal(decideFor(short).status, 'skipped');
  assert.equal(decideFor(tablesWith({}, { ...vendor(false), deny: 'json' })).status, 'skipped');
  assert.deepEqual([...DECISION_STATUSES], ['skipped', 'ready_owner_decision', 'form_decided']);
  assert.ok(WINDOWS_HOOK_HOSTS.every((entry) => DECISION_STATUSES.includes(entry.status)));
});

row('NH-18', 'probe classes: exit 2 is the only block; a PowerShell parse error (exit 1), a missing program (9009, 127), any other code, a signal or timeout is OPEN; code that must not run, run, is OPEN; the length rows set the bound, not the class', () => {
  const { runClass, failClass, foldCell, PROBE_ROWS } = probe;
  // failure rows (node missing, launcher missing or edited, runtime swapped): exit 2 with nothing forbidden run is the only safe end
  assert.equal(failClass(2, false), 'closed');
  for (const status of [0, 1, 3, 9009, 127, 126, 99, 255, null, undefined]) assert.equal(failClass(status, false), 'open', `fail row, exit ${status}`);
  assert.equal(failClass(2, true), 'open', 'exit 2 after tampered code ran');
  // run rows: the answer must arrive; a PowerShell 5.1 parse error ends in exit 1 and counts as OPEN, never closed
  assert.equal(runClass(0, true, 0), 'works');
  assert.equal(runClass(2, true, 2), 'works');
  assert.equal(runClass(2, false, 2), 'closed');
  assert.equal(runClass(2, false, 0), 'closed');
  assert.equal(runClass(2, true, 0), 'closed', 'a block of an allowed call is safe but unusable');
  for (const [status, ran, expect] of [[1, false, 0], [1, false, 2], [1, true, 2], [0, false, 0], [0, false, 2], [0, true, 2], [9009, false, 2], [127, false, 0], [null, false, 0], [1, true, 0]]) {
    assert.equal(runClass(status, ran, expect), 'open', `run row exit ${status} ran ${ran} expect ${expect}`);
  }
  // fold: open dominates; LEN-8192 only sets the bound; an error or a missing row is not a measurement
  const all = (klass, over = {}) => PROBE_ROWS.map((id) => [id, over[id] || (/^P-(NODE|LAUNCHER|RUNTIME)/.test(id) ? 'closed' : klass)]);
  assert.deepEqual(foldCell(all('works')), { class: 'works', bound: 8192 });
  assert.deepEqual(foldCell(all('works', { 'P-LEN-8192': 'open' })), { class: 'works', bound: 8191 });
  assert.deepEqual(foldCell(all('works', { 'P-LEN-8192': 'open', 'P-LEN-8191': 'open' })), { class: 'works', bound: 8190 });
  assert.deepEqual(foldCell(all('works', { 'P-LEN-8190': 'open' })), { class: 'works', bound: 0 }, 'a gap below makes the bound 0');
  assert.deepEqual(foldCell(all('works', { 'P-LEN-8191': 'open' })), { class: 'works', bound: 8190 }, 'a longer row cannot raise the bound over a failed shorter one');
  assert.deepEqual(foldCell(all('works', { 'P-LEN-8192': 'closed', 'P-LEN-8191': 'works' })), { class: 'works', bound: 8191 });
  assert.deepEqual(foldCell(all('works', { 'P-DENY': 'open' })), { class: 'open', bound: 8192 });
  assert.deepEqual(foldCell(all('works', { 'P-NODE-MISSING': 'open' })), { class: 'open', bound: 8192 });
  assert.deepEqual(foldCell(all('works', { 'P-CWD-PLANT': 'open' })).class, 'open');
  assert.equal(foldCell(all('works', { 'P-ALLOW': 'closed' })).class, 'closed');
  assert.deepEqual(foldCell(all('closed')), { class: 'closed', bound: 0 });
  assert.equal(foldCell([...all('works'), ['P-ERROR', 'open']]), null);
  assert.equal(foldCell(all('works').slice(1)), null);
  assert.equal(foldCell(all('works').map(([id, c]) => [id, id === 'P-ALLOW' ? 'maybe' : c])), null);
});

row('NH-19', 'forged inputs cannot flip the decision: extra facts fields, an injected platform, env or argv, a polluted prototype and a second argument are all ignored by decideForm and decideHost', () => {
  const real = WINDOWS_HOOK_HOSTS.map((entry) => entry.form);
  assert.deepEqual(real, [null, null, null, null, null, null]);
  const forged = { client: 'claude-code', candidate: 'plain', form: 'cmd', status: 'form_decided', evidence: record(), shells: ['cmd'], matrix: tablesWith().matrix, bounds: tablesWith().bounds, run: '24999999999', platform: 'win32', writes: true };
  assert.equal(decideForm(forged), null);
  assert.equal(decideForm(forged, tablesWith()), null, 'a second argument is not read');
  assert.equal(decideHost(forged, tablesWith()).status, 'skipped');
  const original = process.argv.slice();
  const env = { A: process.env.MARROW_WINDOWS_HOOKS, B: process.env.MARROW_NH_FORM };
  process.env.MARROW_WINDOWS_HOOKS = '1';
  process.env.MARROW_NH_FORM = 'cmd';
  process.argv.push('--windows-hooks', '--form=cmd', '--platform=win32');
  try {
    assert.equal(decideForm({ client: 'claude-code', candidate: 'plain' }), null);
  } finally {
    process.argv.length = 0;
    process.argv.push(...original);
    for (const [name, value] of [['MARROW_WINDOWS_HOOKS', env.A], ['MARROW_NH_FORM', env.B]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
  // inherited properties are never evidence
  const holder = {};
  Object.prototype['claude-code'] = record();
  try {
    assert.equal(decideFor({ ...tablesWith(), evidence: holder }).reason, 'no_host_shell_evidence');
    assert.equal(decideForm({ client: 'claude-code', candidate: 'plain' }), null);
  } finally {
    delete Object.prototype['claude-code'];
  }
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'windows-hooks.js'), 'utf8').split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
  assert.equal(/process\.(env|argv)/.test(source), false, 'the decision reads no environment and no argv');
  assert.equal((source.match(/process\.platform/g) || []).length, 1, 'process.platform is read once, by windowsHooksSkipped only');
  // the installer and the other modules call decideForm/decideHost only through windows-hooks.js; none can inject tables
  const callers = fs.readdirSync(path.join(__dirname, '..', 'src')).filter((name) => name.endsWith('.js') && name !== 'windows-hooks.js').filter((name) => /decideHostWith|HOST_SHELL_EVIDENCE|hostSkipped|WINDOWS_FORM_WRITER_WIRED/.test(fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8')));
  assert.deepEqual(callers, [], 'no other module imports the injectable decision or the evidence');
});

row('NH-20', 'a decided form is not written: the installer has no Windows form writer, so every host stays on the skip entry even when the tables decide a form', () => {
  const decided = decideFor(tablesWith());
  assert.equal(decided.form, 'cmd');
  const entry = { client: 'claude-code', form: decided.form };
  assert.equal(hostSkipped(entry), true, 'writer not wired: still skipped');
  assert.equal(hostSkipped(entry, false), true);
  assert.equal(hostSkipped(entry, 'true'), true, 'only the boolean true counts');
  assert.equal(hostSkipped(entry, 1), true);
  assert.equal(hostSkipped(entry, true), false, 'once a writer is wired and audited, a decided form is not skipped');
  assert.equal(hostSkipped({ client: 'claude-code', form: null }, true), true, 'no form is always skipped');
  for (const host of WINDOWS_HOOK_HOSTS) assert.notEqual(windowsHookHost({ windowsHooksSkipped: true }, host.client), null, host.client);
  assert.equal(windowsHookSkipEntries({ windowsHooksSkipped: true, paths: {}, claudeCode: true, codex: true, cursor: true, cline: true, windsurf: true, gemini: true }).length, 6);
});

row('NH-21', 'probe, bash column run for real: the bash form works in every row (bound 8192), the cmd and PowerShell forms are closed and never open; every printed line is `<form>/<shell> <row-id> works|closed|open`', () => {
  if (!gitBash()) return;
  // the padded rows really are 8190, 8191 and 8192 characters long in the cmd.exe line, in every form
  for (const form of WINDOWS_HOOK_FORMS) {
    for (const [id, length] of Object.entries(probe.LENGTH_ROWS)) {
      const command = windowsHookCommand(PIN, PRE, { form, nodePath: 'C:\\Program Files\\nodejs\\node.exe', digest: launcherDigest(windowsLauncherText(CFG)) });
      const padded = probe.pad(form, command, length);
      assert.equal(windowsCmdLineLength(padded), length, `${form} ${id}`);
      assert.ok(padded.includes(`marrow-mcp ${PRE} x`), `${form}: the padding is an argument of the node command`);
    }
  }
  const lines = probe.probeLines(['bash']);
  assert.equal(lines.length, 3 * probe.PROBE_ROWS.length);
  for (const line of lines) assert.match(line, /^(cmd|bash|powershell)\/(cmd|bash|powershell|pwsh) P-[A-Z0-9-]+ (works|closed|open)$/, 'no command text and no path in a line');
  const cell = (form) => lines.filter((line) => line.startsWith(`${form}/bash `)).map((line) => line.split(' ').slice(1));
  assert.deepEqual(probe.foldCell(cell('bash')), { class: 'works', bound: 8192 });
  for (const [id, klass] of cell('bash')) assert.equal(klass, /^P-(NODE|LAUNCHER|RUNTIME)/.test(id) ? 'closed' : 'works', id);
  for (const form of ['cmd', 'powershell']) {
    assert.deepEqual(probe.foldCell(cell(form)), { class: 'closed', bound: 0 }, form);
    assert.ok(cell(form).every(([, klass]) => klass === 'closed'), `${form} in bash is never open`);
  }
}, { posixOnly: true });

row('NH-22', 'a shell that cannot be started is no measurement: the probe row throws (P-ERROR), it is never classed open or closed; the cell stays unmeasured', () => {
  const { probeCell, foldCell } = probe;
  if (!gitBash()) return;
  const spawn = require('node:child_process');
  const original = spawn.spawnSync;
  let calls = 0;
  spawn.spawnSync = (...args) => { calls += 1; return { status: null, error: Object.assign(new Error('refused'), { code: 'ESPAWNGUARD' }), stdout: '', stderr: '' }; };
  try {
    delete require.cache[require.resolve('./support/win26-nh-probe.cjs')];
    const fresh = require('./support/win26-nh-probe.cjs');
    const result = fresh.probeCell('bash', 'bash');
    assert.ok(calls >= 1);
    assert.deepEqual(result, [['P-ERROR', 'open']], 'the first refused start ends the cell with one error row');
    assert.equal(fresh.foldCell(result), null);
  } finally {
    spawn.spawnSync = original;
    delete require.cache[require.resolve('./support/win26-nh-probe.cjs')];
  }
  void probeCell; void foldCell;
}, { posixOnly: true });

row('NH-23', 'collisions: the hook command differs for every host entrypoint and every form, and for every launcher digest; the digest of a one-byte edit differs; nothing secret-looking is in a command', () => {
  const node = 'C:\\Program Files\\nodejs\\node.exe';
  const base = launcherDigest(windowsLauncherText(CFG));
  const edited = launcherDigest(`${windowsLauncherText(CFG)}\n`);
  assert.notEqual(base, edited, 'one appended byte changes the digest');
  const seen = new Map();
  let count = 0;
  for (const [client, subs] of Object.entries(SUBS)) {
    for (const sub of subs) {
      for (const form of WINDOWS_HOOK_FORMS) {
        for (const digest of [base, edited]) {
          const command = windowsHookCommand(PIN, sub, { form, nodePath: node, digest });
          count += 1;
          assert.equal(seen.has(command), false, `${client}/${sub}/${form}: same command as ${seen.get(command)}`);
          seen.set(command, `${client}/${sub}/${form}`);
          assert.ok(command.includes(digest), 'the command carries the digest of the launcher it will run');
          assert.doesNotMatch(command, /(?:api[_-]?key|token|secret|password|bearer)\s*[:=]/i);
        }
      }
    }
  }
  assert.equal(seen.size, count, 'no two commands collide');
  // the same entrypoint at another MCP version or another node path is another command
  const a = windowsHookCommand(PIN, PRE, { form: 'cmd', nodePath: node, digest: base });
  assert.notEqual(a, windowsHookCommand(PIN.replace(/\d+$/, (n) => String(Number(n) + 1)), PRE, { form: 'cmd', nodePath: node, digest: base }));
  assert.notEqual(a, windowsHookCommand(PIN, PRE, { form: 'cmd', nodePath: 'C:\\nodejs\\node.exe', digest: base }));
});

// ---------------------------------------------------------------------------------------------------------------------
// Real Windows only.
const WIN_ONLY = { windowsOnly: true };
function eachShell(fn) {
  const results = [];
  for (const shell of shellsHere()) for (const form of WINDOWS_HOOK_FORMS) results.push(fn(form, shell));
  return results;
}

row('NH-W1', 'every written form run in every shell on this machine (cmd.exe, Windows PowerShell 5.1, pwsh 7, Git Bash): each declared works/closed cell holds on allow, node missing, a foreign, edited or missing launcher and a swapped runtime', () => {
  const shells = shellsHere();
  assert.ok(shells.includes('cmd'), 'cmd.exe is present');
  const wrong = [];
  eachShell((form, shell) => {
    const obs = observe(form, shell);
    if (!claimHolds(form, shell, obs)) wrong.push(`${form}/${shell}`);
    if (obs.ranOnFailure.length) wrong.push(`${form}/${shell} ran the runtime on ${obs.ranOnFailure.join(',')}`);
  });
  assert.deepEqual(wrong, []);
}, WIN_ONLY);

row('NH-W2', 'the own-shell cell of each form is usable: cmd form in cmd.exe, bash form in Git Bash and powershell form in PowerShell allow and run the genuine runtime', () => {
  const own = { cmd: 'cmd', bash: 'bash', powershell: 'powershell' };
  for (const form of WINDOWS_HOOK_FORMS) {
    const shell = own[form];
    if (!shellsHere().includes(shell)) continue;
    const obs = observe(form, shell);
    assert.equal(classOf(obs), 'works', `${form}/${shell}: ${JSON.stringify(obs)}`);
  }
}, WIN_ONLY);

row('NH-W3', 'a node under a path with spaces and a non-ASCII user name runs in each own shell (cmd.exe, PowerShell, Git Bash)', () => {
  const f = fixture();
  const tools = tempDir('marrow-nh-tools-');
  try {
    const folder = path.join(tools, 'José Müller 用户');
    fs.mkdirSync(folder);
    const copy = path.join(folder, 'node.exe');
    fs.copyFileSync(process.execPath, copy);
    const own = { cmd: 'cmd', bash: 'bash', powershell: 'powershell' };
    for (const form of WINDOWS_HOOK_FORMS) {
      const shell = own[form];
      if (!shellsHere().includes(shell)) continue;
      fs.rmSync(path.join(f.dir, `genuine-${PRE}`), { force: true });
      const result = runIn(shell, windowsHookCommand(PIN, PRE, { form, nodePath: copy, digest: f.digest }), { cwd: f.cwd, env: shellEnv(f.dir) });
      assert.equal(result.status, 0, `${form}/${shell}: ${result.stderr}`);
      assert.equal(fs.existsSync(path.join(f.dir, `genuine-${PRE}`)), true, `${form}/${shell}`);
    }
  } finally {
    f.cleanup();
    gone(tools);
  }
}, WIN_ONLY);

row('NH-W4', 'HOME differs from USERPROFILE: the launcher is read from the folder os.homedir() names (USERPROFILE), never from HOME', () => {
  const real = fixture();
  const decoy = fixture();
  try {
    fs.rmSync(decoy.path);
    const command = windowsHookCommand(PIN, PRE, { form: 'cmd', nodePath: real.nodePath, digest: real.digest });
    const good = runIn('cmd', command, { cwd: real.cwd, env: { ...shellEnv(real.dir), HOME: decoy.dir } });
    assert.equal(good.status, 0, good.stderr);
    fs.rmSync(path.join(real.dir, `genuine-${PRE}`), { force: true });
    const bad = runIn('cmd', command, { cwd: real.cwd, env: { ...shellEnv(decoy.dir), HOME: real.dir } });
    assert.equal(bad.status, 2, bad.stderr);
  } finally {
    real.cleanup();
    decoy.cleanup();
  }
}, WIN_ONLY);

row('NH-W5', 'cmd.exe limit: a command line of 8191 characters runs and one of 8192 does not (the constant is the real limit)', () => {
  const run = (length) => {
    const head = 'echo ok';
    const pad = 'x'.repeat(length - WINDOWS_CMD_LIMIT + (WINDOWS_CMD_LIMIT - windowsCmdLineLength(head)));
    const command = `${head} ${pad}`.slice(0, length - windowsCmdLineLength(''));
    assert.equal(windowsCmdLineLength(command), length);
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], { encoding: 'utf8', windowsVerbatimArguments: true });
  };
  assert.equal(run(8191).status, 0);
  assert.notEqual(run(8192).status, 0);
}, WIN_ONLY);

row('NH-W6', 'a planted node.exe, node.cmd or powershell.exe in the project folder never runs: the forms name node by its absolute path', () => {
  const f = fixture();
  try {
    for (const name of ['node.exe', 'node.cmd', 'node.bat']) fs.writeFileSync(path.join(f.cwd, name), '@echo off\r\necho planted> "%USERPROFILE%\\planted"\r\nexit /b 0\r\n');
    for (const form of WINDOWS_HOOK_FORMS) {
      const shell = { cmd: 'cmd', bash: 'bash', powershell: 'powershell' }[form];
      if (!shellsHere().includes(shell)) continue;
      runIn(shell, windowsHookCommand(PIN, PRE, { form, nodePath: f.nodePath, digest: f.digest }), { cwd: f.cwd, env: shellEnv(f.dir) });
      assert.equal(fs.existsSync(path.join(f.dir, 'planted')), false, `${form}/${shell}`);
    }
  } finally {
    f.cleanup();
  }
}, WIN_ONLY);

// ---------------------------------------------------------------------------------------------------------------------
function harness() {
  const { project, withPlatform, installOptions, snapshot } = require('./support/win26-install-harness');
  return { project, withPlatform, installOptions, snapshot };
}

// CI runner: prints `id PASS|FAIL|SKIP` lines and nothing else (no command text, no path).
async function runRows(print = (line) => process.stdout.write(`${line}\n`)) {
  let failed = 0;
  for (const item of rows) {
    if (item.skip) {
      print(`${item.id} SKIP`);
      continue;
    }
    try {
      await item.fn();
      print(`${item.id} PASS`);
    } catch {
      failed += 1;
      print(`${item.id} FAIL`);
    }
  }
  return failed;
}

// CI helper: what each form really does in each shell on this machine (one `NH-M form/shell works|closed|open` line per cell). The
// declared matrix in src/windows-hooks.js may only claim works/closed where this prints it.
function runMatrix(print = (line) => process.stdout.write(`${line}\n`)) {
  for (const shell of shellsHere()) for (const form of WINDOWS_HOOK_FORMS) print(`NH-M ${form}/${shell} ${classOf(observe(form, shell))}`);
}

module.exports = { rows, runMatrix, runRows };

if (require.main === module && process.argv.includes('--rows')) {
  // CI: `node test/win26-native-hooks.test.js --rows [--matrix]` prints only `NH-xx PASS|FAIL|SKIP` (and `NH-M form/shell class`) lines.
  (async () => {
    if (process.argv.includes('--matrix')) runMatrix();
    process.exit((await runRows()) ? 1 : 0);
  })();
} else if (require.main === module) {
  // Loaded only when run as a test file: a runner that requires this module prints nothing but its own lines.
  const test = require('node:test');
  for (const item of rows) test(`${item.id}: ${item.title}`, { skip: item.skip }, item.fn);
}

// NH (installer 0.1.76, SPEC-WIN26 NH): native Windows hooks only where one written form is usable AND fail-closed in every
// Windows hook shell. Rows NH-xx are exported (`rows`, `runRows`) so a CI runner can print "id PASS|FAIL" and nothing else;
// NH-Wxx rows run only on real Windows (cmd.exe, PowerShell 5.1, pwsh 7, Git Bash invocation of the written command).
// Off Windows the bash column of every form is run for real (bash with a stand-in node); cmd.exe and PowerShell cells are NOT
// VERIFIED there and stay `open`/claims until a windows-latest run passes the NH-W rows.
const { deadRegistryHome } = require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PINS = require('../src/pins');
const {
  FORM_MATRIX,
  WINDOWS_HOOK_HOSTS,
  WINDOWS_HOOK_SKIP_REASON,
  WINDOWS_PLUGIN_ROUTE,
  WINDOWS_SHELLS,
  decideForm,
  windowsHookHost,
  windowsHookSkipEntries,
} = require('../src/windows-hooks');
const {
  WINDOWS_CMD_LIMIT,
  WINDOWS_HOOK_FORMS,
  WINDOWS_HOOK_MAX,
  assertWindowsCmdLength,
  launcherDigest,
  launcherPath,
  localizeHookCommand,
  runtimeConfig,
  runtimeCore,
  verifyMcpRuntime,
  windowsCmdLineLength,
  windowsHookCommand,
  windowsLauncherText,
  windowsStubSource,
  writeWindowsLauncher,
} = require('../src/mcp-runtime');
const { applyPlan, buildPlan, detectEnvironment, install, uninstall } = require('../src/installer');

const WIN = process.platform === 'win32';
const POSIX_ONLY = !WIN;
const PIN = PINS.MCP_ADAPTER_VERSION;
const FAKE = `sha512-${crypto.createHash('sha512').update('nh-runtime').digest('base64')}`;
const CFG = runtimeConfig(PIN, { integrity: FAKE, sdk: null });
const EVENT = '{"tool_name":"Bash","tool_input":{"command":"git status"}}';
const PRE = 'claude-pre-action-hook';
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

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
}
const gone = (...dirs) => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); };

function fakeRuntimePackage(stage, specs) {
  const version = specs.find((spec) => spec.startsWith('@getmarrow/mcp@')).slice('@getmarrow/mcp@'.length);
  const mcp = path.join(stage, 'node_modules', '@getmarrow', 'mcp');
  fs.mkdirSync(path.join(mcp, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(mcp, 'package.json'), JSON.stringify({ name: '@getmarrow/mcp', version, bin: { 'marrow-mcp': 'dist/cli.js' } }));
  fs.writeFileSync(path.join(mcp, 'dist', 'cli.js'), ALLOW_CLI);
  fs.writeFileSync(path.join(stage, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/@getmarrow/mcp': { version, integrity: FAKE } } }));
  return true;
}
// The genuine runtime: it records that it ran (a marker in HOME) and allows.
const ALLOW_CLI = `let i='';process.stdin.on('data',c=>{i+=c});process.stdin.on('end',()=>{require('fs').writeFileSync(require('path').join(process.env.HOME,'genuine-'+process.argv[2]),i);process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}}))})`;

// A home with a verified runtime and the launcher; `cwd` holds a stand-in node at the Windows-looking path off Windows.
function fixture() {
  const dir = deadRegistryHome(tempDir('marrow-nh-home-'));
  assert.equal(runtimeCore.ensure({ home: dir, version: PIN, integrity: FAKE, sdk: null, npmInstall: fakeRuntimePackage }).state, 'installed');
  const launcher = writeWindowsLauncher(dir, CFG);
  const cwd = tempDir('marrow-nh-cwd-');
  let nodePath = process.execPath;
  if (!WIN) {
    fs.mkdirSync(path.join(cwd, 'C:', 'fx'), { recursive: true });
    fs.symlinkSync(process.execPath, path.join(cwd, 'C:', 'fx', 'node.exe'));
    nodePath = 'C:\\fx\\node.exe';
  }
  return { dir, cwd, nodePath, ...launcher, cleanup: () => gone(dir, cwd) };
}
const missingNode = WIN ? 'C:\\marrow-nh-none\\node.exe' : 'C:\\fx-none\\node.exe';

function shellEnv(home, extra = {}) {
  if (!WIN) return { HOME: home, PATH: '/usr/bin:/bin', ...extra };
  const env = { HOME: home, USERPROFILE: home, ...extra };
  for (const name of ['SystemRoot', 'ComSpec', 'PATH', 'PATHEXT', 'TEMP', 'TMP', 'windir', 'ProgramFiles', 'LOCALAPPDATA', 'APPDATA']) if (process.env[name] !== undefined) env[name] = process.env[name];
  return env;
}

function gitBash() {
  if (!WIN) return ['/bin/bash', '/usr/bin/bash'].find((file) => fs.existsSync(file)) || null;
  return ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].find((file) => fs.existsSync(file)) || null;
}
function onPath(names) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) for (const name of names) if (dir && fs.existsSync(path.join(dir, name))) return path.join(dir, name);
  return null;
}
function shellsHere() {
  const here = [];
  if (gitBash()) here.push('bash');
  if (WIN) {
    here.push('cmd');
    if (onPath(['powershell.exe'])) here.push('powershell');
    if (onPath(['pwsh.exe'])) here.push('pwsh');
  }
  return here;
}

function runIn(shell, command, { cwd, env, input = EVENT }) {
  // isolationShellNode: the sanctioned seam option for a node child a shell starts (HOME stays a private temp folder).
  const options = { cwd, env, input, encoding: 'utf8', timeout: 120_000, isolationShellNode: true };
  if (shell === 'bash') return spawnSync(gitBash(), ['-c', command], options);
  if (shell === 'cmd') return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], { ...options, windowsVerbatimArguments: true });
  // PowerShell: the text goes in as -EncodedCommand so the harness adds no quoting of its own.
  const exe = shell === 'pwsh' ? onPath(['pwsh.exe']) : onPath(['powershell.exe']);
  return spawnSync(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], options);
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
  const declared = FORM_MATRIX[form][column];
  const seen = classOf(obs);
  if (declared === 'works') return seen === 'works';
  if (declared === 'closed') return seen === 'works' || seen === 'closed';
  return true;
}
const columnOf = (shell) => (shell === 'pwsh' ? 'powershell' : shell);

// ---------------------------------------------------------------------------------------------------------------------
row('NH-01', 'decision table: every host gets exactly the form the matrix decides (today none), keeps the L-1 skip entry, and nothing frozen can be edited', () => {
  assert.deepEqual(WINDOWS_HOOK_HOSTS.map((entry) => entry.client), ['claude-code', 'codex', 'cursor', 'cline', 'windsurf', 'gemini']);
  for (const entry of WINDOWS_HOOK_HOSTS) {
    assert.equal(entry.form, decideForm(entry), entry.client);
    assert.equal(entry.form, null, `${entry.client}: no form works in every shell`);
    assert.ok(Object.isFrozen(entry) && Object.isFrozen(entry.shells), entry.client);
    assert.notEqual(windowsHookHost({ windowsHooksSkipped: true }, entry.client), null, entry.client);
  }
  assert.notEqual(windowsHookHost({ windowsHooksSkipped: true }, 'composer'), null, 'the Cursor Composer alias is skipped too');
  assert.ok(Object.isFrozen(WINDOWS_HOOK_HOSTS) && Object.isFrozen(FORM_MATRIX) && WINDOWS_HOOK_FORMS.every((form) => Object.isFrozen(FORM_MATRIX[form])));
  assert.equal(WINDOWS_HOOK_SKIP_REASON, 'windows_hook_shell_unverified');
});

row('NH-02', 'matrix: every form x shell cell is works, closed or open, and NO form works in all three shells (the reason no host is written)', () => {
  assert.deepEqual(Object.keys(FORM_MATRIX).sort(), [...WINDOWS_HOOK_FORMS].sort());
  for (const form of WINDOWS_HOOK_FORMS) {
    assert.deepEqual(Object.keys(FORM_MATRIX[form]).sort(), [...WINDOWS_SHELLS].sort(), form);
    for (const shell of WINDOWS_SHELLS) assert.ok(['works', 'closed', 'open'].includes(FORM_MATRIX[form][shell]), `${form}/${shell}`);
    assert.equal(FORM_MATRIX[form][form === 'powershell' ? 'powershell' : 'bash'] === 'works' || FORM_MATRIX[form].cmd === 'works', true, `${form} works in its own shell`);
    assert.equal(WINDOWS_SHELLS.every((shell) => FORM_MATRIX[form][shell] === 'works'), false, `${form} must not claim all three shells`);
  }
  // A forged facts object or a forged matrix cannot enable a host: only a frozen all-works row does.
  assert.equal(decideForm({ candidate: 'plain' }), null);
  assert.equal(decideForm({ candidate: 'guard' }), null);
  assert.throws(() => { 'use strict'; FORM_MATRIX.cmd.powershell = 'works'; }, TypeError);
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
    if (FORM_MATRIX[form].bash === 'works') {
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
  assert.equal(WINDOWS_PLUGIN_ROUTE, 'On Windows, use the Marrow Claude Code plugin or Cursor plugin for hook protection.');
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
    const result = runtimeCore.ensure({ home, version: PIN, integrity: FAKE, sdk: null, platform: 'win32', npmInstall: (stage, specs) => { stages.push(stage); return fakeRuntimePackage(stage, specs); } });
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
    if (!claimHolds(form, columnOf(shell), obs)) wrong.push(`${form}/${shell}`);
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

// NH: run the written Windows hook forms in the real shells of one machine and classify what the host would see.
// Shared by test/win26-native-hooks.test.js (rows NH-05, NH-16, NH-W1..NH-W6) and the CI runner ci/win26-nh-run.cjs, which runs it on
// windows-latest in cmd.exe, Windows PowerShell 5.1, pwsh 7 and Git Bash. Off Windows only the bash column exists (a stand-in node
// at a Windows-looking path), so cmd.exe and PowerShell are never claimed from here.
//
// Row classes (the only words a runner prints with a row id):
//   works   the hook ran and its answer arrived (allow 0, deny 2)
//   closed  the hook did not run (or its answer was replaced by a block) and the host sees exit 2
//   open    anything else: the host would not see a block where it needs one (exit 1, 9009, 127, a signal, a timeout, planted or
//           tampered code that ran)
// A cell (form x shell) is `open` if any row but a length row is open, `works` if every run row works, else `closed` (see foldCell).
// The length rows 8190/8191/8192 measure the shell's own command-line limit, so LEN-8192 may be open for a shell with an 8191 limit
// (cmd.exe) without making the cell open: they set the bound instead.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// The test files load the isolation first (static rule); the CI runner may reach this module without it. If the isolation cannot be
// loaded (a Windows runner), the same dead registry (an unreachable loopback port, no retries) is written here, so a self-heal in a
// hook still fails at once and nothing reaches a real registry.
let deadRegistryHome;
try {
  ({ deadRegistryHome } = require('./isolated-environment'));
} catch {
  deadRegistryHome = (home) => {
    fs.writeFileSync(path.join(home, '.npmrc'), 'registry=http://127.0.0.1:9/\nfetch-retries=0\nfetch-timeout=2000\n', { mode: 0o600 });
    return home;
  };
}

const PINS = require('../../src/pins');
const {
  WINDOWS_HOOK_FORMS,
  launcherDigest,
  runtimeConfig,
  runtimeCore,
  windowsCmdLineLength,
  windowsHookCommand,
  windowsLauncherText,
  writeWindowsLauncher,
} = require('../../src/mcp-runtime');

const WIN = process.platform === 'win32';
const PIN = PINS.MCP_ADAPTER_VERSION;
const FAKE = `sha512-${crypto.createHash('sha512').update('nh-runtime').digest('base64')}`;
const CFG = runtimeConfig(PIN, { integrity: FAKE, sdk: null });
const EVENT = '{"tool_name":"Bash","tool_input":{"command":"git status"}}';
const PRE = 'claude-pre-action-hook';
const UNICODE_NAME = 'Jos\u00e9 M\u00fcller \u7528\u6237';

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
}
const gone = (...dirs) => { for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true }); };

// The genuine runtime: it records that it ran (a marker in HOME) and allows. DENY_CLI records and blocks with exit 2.
const RECORD = "let i='';process.stdin.on('data',c=>{i+=c});process.stdin.on('end',()=>{require('fs').writeFileSync(require('path').join(process.env.HOME,'genuine-'+process.argv[2]),i);";
const ALLOW_CLI = `${RECORD}process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'}}))})`;
const DENY_CLI = `${RECORD}process.stderr.write('blocked'+String.fromCharCode(10));process.exitCode=2})`;
// A runtime that is NOT the pinned one: it records that it ran and allows.
const FOREIGN_CLI = "require('fs').writeFileSync(require('path').join(process.env.HOME,'foreign-ran'),'1');process.stdout.write('{}')";

function fakeRuntimePackage(cli) {
  return (stage, specs) => {
    const version = specs.find((spec) => spec.startsWith('@getmarrow/mcp@')).slice('@getmarrow/mcp@'.length);
    const mcp = path.join(stage, 'node_modules', '@getmarrow', 'mcp');
    fs.mkdirSync(path.join(mcp, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(mcp, 'package.json'), JSON.stringify({ name: '@getmarrow/mcp', version, bin: { 'marrow-mcp': 'dist/cli.js' } }));
    fs.writeFileSync(path.join(mcp, 'dist', 'cli.js'), cli);
    fs.writeFileSync(path.join(stage, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/@getmarrow/mcp': { version, integrity: FAKE } } }));
    return true;
  };
}

// A home with a verified runtime and the launcher; `cwd` holds a stand-in node at the Windows-looking path off Windows.
// homeName / nodeDirName put a space and non-ASCII characters in the user folder / the folder node sits in.
function fixture({ cli = ALLOW_CLI, homeName = null, nodeDirName = 'fx' } = {}) {
  const outer = tempDir('marrow-nh-home-');
  let dir = outer;
  if (homeName) {
    dir = path.join(outer, homeName);
    fs.mkdirSync(dir, { mode: 0o700 });
  }
  deadRegistryHome(dir);
  assert.equal(runtimeCore.ensure({ home: dir, version: PIN, integrity: FAKE, sdk: null, npmInstall: fakeRuntimePackage(cli) }).state, 'installed');
  const launcher = writeWindowsLauncher(dir, CFG);
  const cwd = tempDir('marrow-nh-cwd-');
  let nodePath = process.execPath;
  if (!WIN) {
    fs.mkdirSync(path.join(cwd, 'C:', nodeDirName), { recursive: true });
    fs.symlinkSync(process.execPath, path.join(cwd, 'C:', nodeDirName, 'node.exe'));
    nodePath = `C:\\${nodeDirName}\\node.exe`;
  } else if (nodeDirName !== 'fx') {
    const folder = path.join(cwd, nodeDirName);
    fs.mkdirSync(folder);
    nodePath = path.join(folder, 'node.exe');
    fs.copyFileSync(process.execPath, nodePath);
  }
  return { dir, cwd, nodePath, ...launcher, cleanup: () => gone(outer, cwd) };
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
// The shells of this machine: bash anywhere there is one; cmd, powershell (5.1) and pwsh (7) on Windows.
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

// One run of `command` the way a host starts a hook through a shell: cmd.exe /d /s /c "<text>", powershell -NoProfile
// -NonInteractive -Command <text> (Node quotes the argument; PowerShell splits it back), bash -c <text>.
function runIn(shell, command, { cwd, env, input = EVENT }) {
  // isolationShellNode: the sanctioned seam option for a node child a shell starts (HOME stays a private temp folder).
  const options = { cwd, env, input, encoding: 'utf8', timeout: 30_000, isolationShellNode: true };
  if (shell === 'bash') return spawnSync(gitBash(), ['-c', command], options);
  if (shell === 'cmd') return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${command}"`], { ...options, windowsVerbatimArguments: true });
  const exe = shell === 'pwsh' ? onPath(['pwsh.exe']) : onPath(['powershell.exe']);
  return spawnSync(exe, ['-NoProfile', '-NonInteractive', '-Command', command], options);
}

// ---------------------------------------------------------------------------------------------------------------------
// Probe rows. Each returns a class from the exit status of the shell and whether code that must not run did.
const markerOf = (f, name) => path.join(f.dir, name);
const genuineMarker = (f) => markerOf(f, `genuine-${PRE}`);
const present = (file) => fs.existsSync(file);
const clearMarkers = (f) => { for (const name of [`genuine-${PRE}`, 'foreign-ran', 'planted', 'tampered-ran']) fs.rmSync(markerOf(f, name), { force: true }); };

// Run rows: the hook should run and answer `expect` (0 allow, 2 deny).
function runClass(status, ran, expect) {
  if (status === expect && ran) return 'works';
  if (status === 2) return 'closed';
  return 'open';
}
// Failure rows: the hook must end in exit 2 and none of the code that must not run may run.
function failClass(status, forbiddenRan) {
  return status === 2 && !forbiddenRan ? 'closed' : 'open';
}

function pad(form, command, length) {
  // The cmd.exe-style line `cmd.exe /d /s /c "<text>"` is exactly `length` characters: the padding is one more argument of the node
  // command, in front of the pre-action tail, so every form keeps its own shape.
  const head = `marrow-mcp ${PRE}`;
  const at = command.indexOf(head);
  assert.ok(at > 0, form);
  const base = windowsCmdLineLength(command);
  const extra = length - base - 1;
  assert.ok(extra >= 1, `${form}: ${length}`);
  return `${command.slice(0, at + head.length)} ${'x'.repeat(extra)}${command.slice(at + head.length)}`;
}

const PROBE_ROWS = Object.freeze([
  'P-ALLOW', 'P-DENY', 'P-NODE-MISSING', 'P-LAUNCHER-MISSING', 'P-LAUNCHER-EDIT', 'P-RUNTIME-SWAP',
  'P-SPACES-UNICODE', 'P-LEN-8190', 'P-LEN-8191', 'P-LEN-8192', 'P-CWD-PLANT',
]);
const LENGTH_ROWS = Object.freeze({ 'P-LEN-8190': 8190, 'P-LEN-8191': 8191, 'P-LEN-8192': 8192 });

function probeRow(form, shell, id) {
  const make = (f, over = {}) => windowsHookCommand(PIN, PRE, { form, nodePath: f.nodePath, digest: f.digest, ...over });
  // A shell that could not even be started (spawn error, a guard refusal: an error and no exit status) is no measurement: it throws,
  // and the row becomes P-ERROR. An exit status with an EPIPE error is a real answer (the shell ended before it read the event). A hook
  // that hangs past the timeout is a real answer for the host (non-blocking): status null, class open.
  const exec = (f, command) => {
    const result = runIn(shell, command, { cwd: f.cwd, env: shellEnv(f.dir) });
    if (result.error && result.status === null && result.error.code !== 'ETIMEDOUT') throw result.error;
    return result;
  };
  if (id === 'P-ALLOW' || id === 'P-DENY') {
    const f = fixture({ cli: id === 'P-ALLOW' ? ALLOW_CLI : DENY_CLI });
    try {
      const result = exec(f, make(f));
      return runClass(result.status, present(genuineMarker(f)), id === 'P-ALLOW' ? 0 : 2);
    } finally {
      f.cleanup();
    }
  }
  if (id === 'P-SPACES-UNICODE') {
    const f = fixture({ homeName: UNICODE_NAME, nodeDirName: UNICODE_NAME });
    try {
      const result = exec(f, make(f));
      return runClass(result.status, present(genuineMarker(f)), 0);
    } finally {
      f.cleanup();
    }
  }
  if (LENGTH_ROWS[id]) {
    const f = fixture();
    try {
      const result = exec(f, pad(form, make(f), LENGTH_ROWS[id]));
      return runClass(result.status, present(genuineMarker(f)), 0);
    } finally {
      f.cleanup();
    }
  }
  const f = fixture();
  try {
    if (id === 'P-CWD-PLANT') {
      for (const name of ['node.exe', 'node.cmd', 'node.bat']) fs.writeFileSync(path.join(f.cwd, name), '@echo off\r\necho planted> "%USERPROFILE%\\planted"\r\nexit /b 0\r\n');
      const result = exec(f, make(f));
      return present(markerOf(f, 'planted')) ? 'open' : runClass(result.status, present(genuineMarker(f)), 0);
    }
    if (id === 'P-NODE-MISSING') {
      const result = exec(f, make(f, { nodePath: missingNode }));
      return failClass(result.status, present(genuineMarker(f)));
    }
    if (id === 'P-LAUNCHER-MISSING') {
      fs.rmSync(f.path);
      const result = exec(f, make(f));
      return failClass(result.status, present(genuineMarker(f)));
    }
    if (id === 'P-LAUNCHER-EDIT') {
      // One byte appended (a newline: the loader still evaluates, so only the sha256 check can refuse it).
      fs.writeFileSync(f.path, Buffer.concat([fs.readFileSync(f.path), Buffer.from('\n')]));
      const result = exec(f, make(f));
      return failClass(result.status, present(genuineMarker(f)) || present(markerOf(f, 'tampered-ran')));
    }
    if (id === 'P-RUNTIME-SWAP') {
      // The verified runtime folder replaced by another package that records that it ran.
      const runtime = path.join(f.dir, '.marrow', 'runtime', 'mcp', PIN);
      fs.rmSync(runtime, { recursive: true, force: true });
      fakeRuntimePackage(FOREIGN_CLI)(runtime, [`@getmarrow/mcp@${PIN}`]);
      const result = exec(f, make(f));
      return failClass(result.status, present(markerOf(f, 'foreign-ran')) || present(genuineMarker(f)));
    }
    throw new Error(`unknown probe row ${id}`);
  } finally {
    f.cleanup();
  }
}

// All rows of one cell; a row that cannot even be set up is reported `open` under the id P-ERROR (an unproven cell is never usable).
function probeCell(form, shell) {
  const rowsOut = [];
  for (const id of PROBE_ROWS) {
    try {
      rowsOut.push([id, probeRow(form, shell, id)]);
    } catch {
      rowsOut.push(['P-ERROR', 'open']);
      break;
    }
  }
  return rowsOut;
}

// Rows where the hook should run and answer (the length rows set the bound instead of the class).
const RUN_ROWS = Object.freeze(['P-ALLOW', 'P-DENY', 'P-SPACES-UNICODE', 'P-CWD-PLANT']);

// The cell class and the length bound from a cell's rows. A cell with a P-ERROR row or a missing row is not measurable (null).
// class: open if any row but a length row is open; works if every run row works; otherwise closed.
// bound: the largest length row (8190, 8191, 8192) such that it and every shorter one works; 0 if 8190 does not.
function foldCell(rowsIn) {
  const byId = new Map(rowsIn);
  if (byId.has('P-ERROR') || !PROBE_ROWS.every((id) => ['works', 'closed', 'open'].includes(byId.get(id)))) return null;
  const counted = PROBE_ROWS.filter((id) => !LENGTH_ROWS[id]);
  const klass = counted.some((id) => byId.get(id) === 'open') ? 'open' : RUN_ROWS.every((id) => byId.get(id) === 'works') ? 'works' : 'closed';
  let bound = 0;
  for (const [id, length] of Object.entries(LENGTH_ROWS)) {
    if (byId.get(id) !== 'works') break;
    bound = length;
  }
  return { class: klass, bound };
}

// The lines a runner prints: `<form>/<shell> <row-id> works|closed|open`, nothing else (no command text, no path).
function probeLines(shells = shellsHere()) {
  const lines = [];
  for (const shell of shells) for (const form of WINDOWS_HOOK_FORMS) for (const [id, klass] of probeCell(form, shell)) lines.push(`${form}/${shell} ${id} ${klass}`);
  return lines;
}

module.exports = {
  ALLOW_CLI,
  CFG,
  DENY_CLI,
  EVENT,
  FAKE,
  LENGTH_ROWS,
  PIN,
  PRE,
  PROBE_ROWS,
  RUN_ROWS,
  UNICODE_NAME,
  WIN,
  WINDOWS_HOOK_FORMS,
  fakeRuntimePackage,
  failClass,
  fixture,
  foldCell,
  gitBash,
  gone,
  launcherDigest,
  missingNode,
  onPath,
  pad,
  probeCell,
  probeLines,
  probeRow,
  runClass,
  runIn,
  shellEnv,
  shellsHere,
  tempDir,
  windowsLauncherText,
};

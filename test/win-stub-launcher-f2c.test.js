// F-2c (installer 0.1.74): the short Windows hook stub and its sha256-pinned launcher
// (src/mcp-runtime.js windowsStubCommand / writeWindowsLauncher). The stub's JavaScript runs on any
// node, so its decisions are tested here on Linux; the cmd.exe tail, a missing node.exe and cmd's
// current-folder lookup need windows-latest (see RESULT.md "NOT verified").
const { deadRegistryHome } = require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const PINS = require('../src/pins');
const {
  HOLD_TEXT,
  UNAVAILABLE_TEXT,
  WARN_TEXT,
  WINDOWS_HOOK_MAX,
  launcherDigest,
  launcherPath,
  loaderFor,
  localizeHookCommand,
  runtimeConfig,
  runtimeCore,
  windowsLauncherText,
  windowsStubCommand,
  windowsStubSource,
  writeWindowsLauncher,
} = require('../src/mcp-runtime');

const PIN = PINS.MCP_ADAPTER_VERSION;
const FAKE = `sha512-${crypto.createHash('sha512').update('w2-f2c-runtime').digest('base64')}`;
const CFG = runtimeConfig(PIN, { integrity: FAKE, sdk: null });
const EVENT = '{"tool_name":"Bash","tool_input":{"command":"git status"}}';
const NODE = 'C:\\Program Files\\nodejs\\node.exe';
// Every entrypoint the installer writes, for every host.
const SUBS = [
  'claude-context-hook', 'claude-pre-action-hook', 'claude-hook', 'claude-session-hook', 'claude-permission-request-hook',
  'codex-context-hook', 'codex-pre-action-hook', 'codex-hook', 'codex-session-hook',
  'cursor-pre-action-hook', 'cursor-hook', 'cursor-session-hook', 'cursor-context-hook',
  'cline-pre-action-hook', 'cline-hook', 'cline-session-hook',
  'windsurf-pre-action-hook', 'windsurf-hook', 'windsurf-session-hook',
  'gemini-pre-action-hook', 'gemini-hook', 'gemini-session-hook', 'gemini-context-hook',
  'grok-pre-action-hook', 'grok-hook', 'grok-session-hook', 'grok-context-hook',
];

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
}

function cliPackage(cli) {
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
const ALLOW_CLI = `let i='';process.stdin.on('data',c=>{i+=c});process.stdin.on('end',()=>{require('fs').writeFileSync(require('path').join(process.env.HOME,'genuine-'+process.argv[2]),i);process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'allow'},genuine:true}));});\n`;
const THROW_CLI = "throw new Error('runtime could not start');\n";

// A home with a dead registry (no network), optionally a verified runtime and the launcher.
function home({ runtime = ALLOW_CLI, launcher = true } = {}) {
  const dir = deadRegistryHome(tempDir('marrow-f2c-stub-'));
  if (runtime) assert.equal(runtimeCore.ensure({ home: dir, version: PIN, integrity: FAKE, sdk: null, npmInstall: cliPackage(runtime) }).state, 'installed');
  const written = launcher ? writeWindowsLauncher(dir, CFG) : { digest: launcherDigest(windowsLauncherText(CFG)), path: launcherPath(dir, launcherDigest(windowsLauncherText(CFG))) };
  return { dir, ...written };
}

function runStub(h, sub, { digest = h.digest, cwd = h.dir, env = {}, preload = null } = {}) {
  const args = [...(preload ? ['--require', preload] : []), '-e', windowsStubSource(digest), '--', `--package=@getmarrow/mcp@${PIN}`, 'marrow-mcp', sub];
  return spawnSync(process.execPath, args, { cwd, env: { HOME: h.dir, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, ...env }, input: EVENT, encoding: 'utf8', timeout: 90_000 });
}
const ran = (h, name) => fs.existsSync(path.join(h.dir, name));

test('F-2c length: every Windows hook command is at most 2048 characters for every sub and host, with the longest version, sub and node path (500 characters, a 200+ character profile path)', () => {
  const digest = launcherDigest(windowsLauncherText(CFG));
  const longVersion = `${'9'.repeat(10)}.${'9'.repeat(10)}.${'9'.repeat(10)}`;
  const profile = `C:\\Users\\${'p'.repeat(210)}`;
  const longNode = `${profile}\\AppData\\Roaming\\nvm\\${'v'.repeat(500 - profile.length - '\\AppData\\Roaming\\nvm\\'.length - '\\node.exe'.length)}\\node.exe`;
  assert.equal(longNode.length, 500);
  const longPre = `${'a'.repeat(64 - '-pre-action-hook'.length)}-pre-action-hook`;
  const longOther = `a${'-'.repeat(63)}`;
  const lengths = {};
  for (const sub of [...SUBS, longPre, longOther]) {
    for (const [label, nodePath, version] of [['typical', NODE, PIN], ['longest', longNode, longVersion]]) {
      const command = windowsStubCommand(version, sub, { nodePath, digest });
      assert.ok(command.length <= WINDOWS_HOOK_MAX, `${label} ${sub}: ${command.length}`);
      lengths[`${label} ${sub}`] = command.length;
    }
  }
  assert.equal(WINDOWS_HOOK_MAX, 2048);
  // Over the cap is refused, never written long.
  assert.throws(() => windowsStubCommand(PIN, 'claude-pre-action-hook', { nodePath: `C:\\${'x'.repeat(500)}\\node.exe`, digest }), /safe absolute Windows path/);
  assert.throws(() => windowsStubCommand(`${'1'.repeat(40)}.0.0`, 'claude-hook', { nodePath: NODE, digest }), /invalid MCP version/);
  if (process.env.W2_LENGTHS_OUT) fs.writeFileSync(process.env.W2_LENGTHS_OUT, `${JSON.stringify(lengths, null, 2)}\n`);
});

test('F-2c node path: only an absolute drive path to node.exe that no shell reads inside quotes; UNC, \\\\?\\, relative, bare and shell characters are refused', () => {
  const digest = launcherDigest(windowsLauncherText(CFG));
  for (const good of [NODE, 'C:\\Program Files (x86)\\nodejs\\node.exe', 'D:\\Users\\José Müller\\scoop\\apps\\nodejs\\current\\node.exe', 'C:\\PROGRA~1\\nodejs\\node.exe', 'c:\\n\\NODE.EXE', 'C:\\Users\\用户\\nvm\\v22.23.2\\node.exe']) {
    assert.match(windowsStubCommand(PIN, 'claude-pre-action-hook', { nodePath: good, digest }), /^"[^"]+" -e "/, good);
  }
  for (const bad of ['node', 'node.exe', '.\\node.exe', 'nodejs\\node.exe', '\\\\server\\share\\node.exe', '\\\\?\\C:\\nodejs\\node.exe', '\\\\.\\C:\\node.exe',
    'C:/nodejs/node.exe', 'C:\\nodejs\\node.cmd', 'C:\\nodejs\\node.exe.cmd', 'C:\\a"b\\node.exe', 'C:\\%PATH%\\node.exe', 'C:\\a!b\\node.exe', 'C:\\a^b\\node.exe',
    'C:\\a&b\\node.exe', 'C:\\a|b\\node.exe', 'C:\\a$b\\node.exe', 'C:\\a`b\\node.exe', "C:\\a'b\\node.exe", 'C:\\a\nb\\node.exe', 'C:\\a<b\\node.exe', 'C:\\nodejs\\node.exe ', '', undefined]) {
    assert.throws(() => windowsStubCommand(PIN, 'claude-pre-action-hook', { nodePath: bad, digest }), /safe absolute Windows path/, JSON.stringify(bad));
  }
  for (const bad of ['', 'abc', 'A'.repeat(64), '0'.repeat(63), `${'0'.repeat(64)}'`]) assert.throws(() => windowsStubSource(bad), /invalid launcher digest/, bad);
  for (const sub of ['', 'Claude-hook', 'a b', "x'y", 'a'.repeat(65), '-x']) assert.throws(() => windowsStubCommand(PIN, sub, { nodePath: NODE, digest }), /invalid entrypoint/, sub);
});

test('F-2c form: node by absolute path, the stub carries no quote, $, %, !, backslash or backtick, no PATH/cwd lookup and no spawn; the `|| exit 2` tail only on pre-action entrypoints', () => {
  const digest = launcherDigest(windowsLauncherText(CFG));
  const pre = windowsStubCommand(PIN, 'claude-pre-action-hook', { nodePath: NODE, digest });
  assert.equal(pre, `"${NODE}" -e "${windowsStubSource(digest)}" -- --package=@getmarrow/mcp@${PIN} marrow-mcp claude-pre-action-hook || exit 2`);
  assert.equal(windowsStubCommand(PIN, 'claude-hook', { nodePath: NODE, digest }), `"${NODE}" -e "${windowsStubSource(digest)}" -- --package=@getmarrow/mcp@${PIN} marrow-mcp claude-hook`);
  const stub = windowsStubSource(digest);
  assert.doesNotMatch(stub, /["$%!\\`\n\r]/);
  const code = stub.split(`'${HOLD_TEXT}'`).join("''").split(`'${UNAVAILABLE_TEXT}'`).join("''");
  assert.equal(code.length < stub.length - 300, true, 'both texts were removed');
  assert.doesNotMatch(code, /spawn|exec|child_process|PATH|cwd|npx|npm/);
  assert.equal(stub.split('readFileSync').length - 1, 1, 'the launcher is read exactly once');
  assert.match(stub, new RegExp(`'${digest}\\.cjs'`));
  assert.match(stub, new RegExp(`=='${digest}'`));
});

test('F-2c launcher: the file is the inline loader byte for byte (same runtimeCore, same cfg), 0600 in 0700 folders, rewritten only when it differs', () => {
  const h = home({ runtime: null });
  try {
    const bytes = fs.readFileSync(h.path, 'utf8');
    assert.equal(bytes, loaderFor(CFG));
    const inline = localizeHookCommand(`npx -y --package=@getmarrow/mcp@${PIN} marrow-mcp claude-pre-action-hook`, PIN, { platform: 'win32', integrity: FAKE, sdk: null });
    assert.equal(inline, `node -e "${bytes}" -- --package=@getmarrow/mcp@${PIN} marrow-mcp claude-pre-action-hook`, 'the launcher is exactly what the 0.1.73 win32 form carried inline');
    assert.equal(h.digest, crypto.createHash('sha256').update(fs.readFileSync(h.path)).digest('hex'));
    assert.equal(path.basename(h.path), `${h.digest}.cjs`);
    assert.equal(fs.statSync(h.path).mode & 0o777, 0o600);
    for (const dir of ['.marrow', '.marrow/runtime', '.marrow/runtime/launcher']) assert.equal(fs.statSync(path.join(h.dir, dir)).mode & 0o777, 0o700, dir);
    assert.equal(writeWindowsLauncher(h.dir, CFG).state, 'present');
    fs.appendFileSync(h.path, ' ');
    assert.equal(writeWindowsLauncher(h.dir, CFG).state, 'written');
    assert.equal(fs.readFileSync(h.path, 'utf8'), loaderFor(CFG));
    // A configuration change (another integrity) is another file and another digest.
    const other = writeWindowsLauncher(h.dir, runtimeConfig(PIN, { integrity: `sha512-${crypto.createHash('sha512').update('other').digest('base64')}`, sdk: null }));
    assert.notEqual(other.digest, h.digest);
    // A linked private folder is refused, and nothing is written through it.
    const linked = deadRegistryHome(tempDir('marrow-f2c-linked-'));
    const elsewhere = tempDir('marrow-f2c-elsewhere-');
    fs.mkdirSync(path.join(linked, '.marrow', 'runtime'), { recursive: true, mode: 0o700 });
    fs.symlinkSync(elsewhere, path.join(linked, '.marrow', 'runtime', 'launcher'));
    assert.throws(() => writeWindowsLauncher(linked, CFG), /unsafe runtime directory/);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
    for (const dir of [linked, elsewhere]) fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test('F-2c run: a valid launcher runs the verified runtime (allow, exit 0) for pre-action and other entrypoints', () => {
  const h = home();
  try {
    const result = runStub(h, 'claude-pre-action-hook');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /"permissionDecision":"allow"/);
    assert.ok(ran(h, 'genuine-claude-pre-action-hook'));
    assert.equal(runStub(h, 'claude-hook').status, 0);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test('F-2c holds: missing, changed, foreign, linked or loose launcher or folder -> pre-action exit 2 with the HOLD text, other entrypoints exit 1; nothing unverified runs and nothing is healed', () => {
  const evil = "require('fs').writeFileSync(require('path').join(process.env.HOME,'evil-ran'),'');";
  const shapes = {
    'launcher missing': (h) => fs.rmSync(h.path),
    'launcher folder missing': (h) => fs.rmSync(path.dirname(h.path), { recursive: true }),
    'one byte appended': (h) => fs.appendFileSync(h.path, ';'),
    'replaced by other code': (h) => fs.writeFileSync(h.path, evil),
    'digest of another configuration only': (h) => { fs.renameSync(h.path, launcherPath(h.dir, '0'.repeat(64))); },
    'file group/other readable (0644)': (h) => fs.chmodSync(h.path, 0o644),
    'file is a symlink to a genuine copy': (h) => { const copy = path.join(h.dir, 'copy.cjs'); fs.copyFileSync(h.path, copy); fs.chmodSync(copy, 0o600); fs.rmSync(h.path); fs.symlinkSync(copy, h.path); },
    'file is a folder': (h) => { fs.rmSync(h.path); fs.mkdirSync(h.path, { mode: 0o700 }); },
    'launcher folder is a symlink': (h) => { const dir = path.dirname(h.path); const moved = path.join(h.dir, 'moved'); fs.renameSync(dir, moved); fs.symlinkSync(moved, dir); },
    'launcher folder 0755': (h) => fs.chmodSync(path.dirname(h.path), 0o755),
    '~/.marrow/runtime 0750': (h) => fs.chmodSync(path.join(h.dir, '.marrow', 'runtime'), 0o750),
    '~/.marrow is a symlink': (h) => { const moved = path.join(h.dir, 'marrow-moved'); fs.renameSync(path.join(h.dir, '.marrow'), moved); fs.symlinkSync(moved, path.join(h.dir, '.marrow')); },
  };
  for (const [label, change] of Object.entries(shapes)) {
    const h = home();
    try {
      change(h);
      const pre = runStub(h, 'claude-pre-action-hook');
      assert.equal(pre.status, 2, `${label}: ${pre.stderr}`);
      assert.equal(pre.stderr, `${HOLD_TEXT}\n`, label);
      assert.equal(pre.stdout, '', label);
      const other = runStub(h, 'claude-hook');
      assert.equal(other.status, 1, label);
      assert.equal(other.stderr, `${UNAVAILABLE_TEXT}\n`, label);
      assert.equal(ran(h, 'evil-ran'), false, `${label}: unverified code ran`);
      assert.equal(ran(h, 'genuine-claude-pre-action-hook'), false, `${label}: the runtime ran without a verified launcher`);
      const runtimeRoot = path.join(h.dir, '.marrow', 'runtime', 'mcp');
      if (fs.existsSync(runtimeRoot) && !fs.lstatSync(path.join(h.dir, '.marrow')).isSymbolicLink()) {
        assert.equal(fs.readdirSync(runtimeRoot).some((name) => name.startsWith('.heal-') || name.startsWith('.stage-')), false, `${label}: no self-heal started`);
      }
    } finally {
      fs.rmSync(h.dir, { recursive: true, force: true });
    }
  }
});

test('F-2c swap: the launcher is hashed and run from one read, so a swap before the read holds and a swap after it never runs', () => {
  const h = home();
  const work = tempDir('marrow-f2c-swap-');
  const evil = "require('fs').writeFileSync(require('path').join(process.env.HOME,'evil-ran'),'');";
  try {
    const before = path.join(work, 'before.cjs');
    fs.writeFileSync(before, `const fs=require('fs');const l=fs.lstatSync;fs.lstatSync=function(p,...r){const s=l.call(this,p,...r);if(String(p).endsWith(${JSON.stringify(`${h.digest}.cjs`)}))fs.writeFileSync(p,${JSON.stringify(evil)});return s;};\n`);
    const swappedBefore = runStub(h, 'claude-pre-action-hook', { preload: before });
    assert.equal(swappedBefore.status, 2, swappedBefore.stderr);
    assert.equal(swappedBefore.stderr, `${HOLD_TEXT}\n`);
    assert.equal(ran(h, 'evil-ran'), false);
    writeWindowsLauncher(h.dir, CFG);
    const after = path.join(work, 'after.cjs');
    fs.writeFileSync(after, `const fs=require('fs');const r=fs.readFileSync;fs.readFileSync=function(p,...a){const b=r.call(this,p,...a);if(String(p).endsWith(${JSON.stringify(`${h.digest}.cjs`)}))fs.writeFileSync(p,${JSON.stringify(evil)});return b;};\n`);
    const swappedAfter = runStub(h, 'claude-pre-action-hook', { preload: after });
    assert.equal(swappedAfter.status, 0, swappedAfter.stderr);
    assert.match(swappedAfter.stdout, /"genuine":true/);
    assert.equal(ran(h, 'evil-ran'), false, 'the bytes that ran are the bytes that were hashed');
  } finally {
    for (const dir of [h.dir, work]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F-2c runtime cannot start: a runtime that throws while starting holds (exit 2; the 0.1.73 inline loader crashed with exit 1)', () => {
  const h = home({ runtime: THROW_CLI });
  try {
    const pre = runStub(h, 'claude-pre-action-hook');
    assert.equal(pre.status, 2, pre.stderr);
    assert.equal(pre.stderr, `${HOLD_TEXT}\n`);
    assert.equal(runStub(h, 'claude-hook').status, 1);
    const inline = spawnSync(process.execPath, ['-e', loaderFor(CFG), '--', `--package=@getmarrow/mcp@${PIN}`, 'marrow-mcp', 'claude-pre-action-hook'], { cwd: h.dir, env: { HOME: h.dir, PATH: '/usr/bin:/bin' }, input: EVENT, encoding: 'utf8', timeout: 60_000 });
    assert.equal(inline.status, 1, 'master behaviour, for the record');
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

test('F-2c outage rule unchanged: launcher valid, no runtime, registry unreachable -> the same WARN and exit 1 as the inline loader; a non-outage failure holds', () => {
  const viaStub = home({ runtime: null });
  const viaInline = home({ runtime: null, launcher: false });
  const root = tempDir('marrow-f2c-proj-');
  try {
    // A planted node, npx and npm in the project and first on PATH: none may run.
    const shim = '#!/bin/sh\n: > "$HOME/shim-ran"\nexit 0\n';
    for (const name of ['node', 'npx', 'npm', 'node.cmd', 'npx.cmd', 'node.exe']) fs.writeFileSync(path.join(root, name), shim, { mode: 0o755 });
    const env = { PATH: `.:${root}:${path.dirname(process.execPath)}:/usr/bin:/bin` };
    const stub = runStub(viaStub, 'claude-pre-action-hook', { cwd: root, env });
    const inline = spawnSync(process.execPath, ['-e', loaderFor(CFG), '--', `--package=@getmarrow/mcp@${PIN}`, 'marrow-mcp', 'claude-pre-action-hook'], { cwd: root, env: { HOME: viaInline.dir, ...env }, input: EVENT, encoding: 'utf8', timeout: 90_000 });
    assert.equal(inline.status, 1, inline.stderr);
    assert.equal(inline.stderr, `${WARN_TEXT}\n`);
    assert.equal(stub.status, inline.status, stub.stderr);
    assert.equal(stub.stderr, inline.stderr);
    assert.equal(stub.stdout, inline.stdout);
    for (const h of [viaStub, viaInline]) assert.equal(ran(h, 'shim-ran'), false, 'no planted node, npx or npm ran');
    assert.equal(fs.existsSync(path.join(root, 'shim-ran')), false);
    // A non-outage failure record (integrity mismatch) holds, through the launcher exactly as inline.
    const mark = runtimeCore.healPaths(viaStub.dir, PIN, root).mark;
    fs.writeFileSync(mark, JSON.stringify({ at: Date.now(), reason: 'integrity_mismatch' }), { mode: 0o600 });
    const held = runStub(viaStub, 'claude-pre-action-hook', { cwd: root, env });
    assert.equal(held.status, 2, held.stderr);
    assert.equal(held.stderr, `${HOLD_TEXT}\n`);
  } finally {
    for (const dir of [viaStub.dir, viaInline.dir, root]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('F-2c Git Bash stand-in: the cmd form with a backslash node path never runs in bash (no / in the word: PATH search, 127) and the tail turns that into exit 2; the other form without node exits 127', () => {
  const digest = launcherDigest(windowsLauncherText(CFG));
  const bash = ['/bin/bash', '/usr/bin/bash'].find((file) => fs.existsSync(file));
  if (!bash) return;
  const cwd = tempDir('marrow-f2c-bash-');
  try {
    const pre = spawnSync(bash, ['-c', windowsStubCommand(PIN, 'claude-pre-action-hook', { nodePath: NODE, digest })], { cwd, input: EVENT, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    assert.equal(pre.status, 2, pre.stderr);
    assert.match(pre.stderr, /not found|No such file/);
    const other = spawnSync(bash, ['-c', windowsStubCommand(PIN, 'claude-hook', { nodePath: NODE, digest })], { cwd, input: EVENT, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
    assert.equal(other.status, 127);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('F-2c secrets: a runtime-generated dummy key is never in the launcher, the stub, the command or the hook output', () => {
  const dummy = `mrw_dummy_${crypto.randomBytes(24).toString('hex')}`;
  const h = home();
  try {
    const result = runStub(h, 'claude-pre-action-hook', { env: { MARROW_API_KEY: dummy } });
    assert.equal(result.status, 0, result.stderr);
    const command = windowsStubCommand(PIN, 'claude-pre-action-hook', { nodePath: NODE, digest: h.digest });
    for (const text of [fs.readFileSync(h.path, 'utf8'), command, result.stdout, result.stderr]) assert.equal(text.includes(dummy), false);
  } finally {
    fs.rmSync(h.dir, { recursive: true, force: true });
  }
});

// F-2b (installer 0.1.74): the isolated loop-guard self-test no longer spawns `npx.cmd` without a
// shell on Windows (Node refuses that with EINVAL, which aborted every Windows install after the
// hooks were written). It runs npm's npx-cli.js with the running node, arguments as an array, no
// shell. POSIX is unchanged, and a missing npx-cli.js fails closed.
const { deadRegistryHome } = require('./support/isolated-environment');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { install, loopGuardInvocation, runLoopGuardSelfTest } = require('../src/installer');
const PINS = require('../src/pins');

const VERSION = PINS.MCP_ADAPTER_VERSION;
const ARGS = ['-y', `--package=@getmarrow/mcp@${VERSION}`, 'marrow-mcp', 'loop-guard-self-test'];
const PROOF = { pass: true, isolated: true, live_hook_observed: false, repeat_denied: true, mutation_reset: true, owner_disabled_bypass: true };
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'the node.exe stand-in is a POSIX symlink' : false };

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
}

// A "node install" folder with the Windows layout: node.exe next to node_modules/npm/bin/npx-cli.js.
// The folder name carries a space, &, ^, %, ! and parentheses: nothing may be re-parsed as a command line.
function nodeFolder(script) {
  const dir = tempDir('node js & x ^ y (z) %PATH% ! ');
  const node = path.join(dir, 'node.exe');
  fs.symlinkSync(process.execPath, node);
  const cli = path.join(dir, 'node_modules', 'npm', 'bin', 'npx-cli.js');
  if (script !== null) {
    fs.mkdirSync(path.dirname(cli), { recursive: true });
    fs.writeFileSync(cli, script);
  }
  return { dir, node, cli };
}

const recorder = (out) => `const fs = require('fs');
fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ argv: process.argv.slice(2), cwd: fs.realpathSync(process.cwd()), homeReal: fs.realpathSync(process.env.HOME), home: process.env.HOME, profile: process.env.USERPROFILE, key: process.env.MARROW_API_KEY, keyAlt: process.env.MARROW_KEY }));
process.stdout.write(${JSON.stringify(JSON.stringify(PROOF))});
`;

const leftovers = () => fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('marrow-install-loop-guard-'));

test('F-2b POSIX: the invocation is exactly `npx` with the same arguments, whatever node folder exists', () => {
  for (const platform of ['linux', 'darwin', 'freebsd']) {
    const planned = loopGuardInvocation(VERSION, { platform, execPath: '/anything/node' });
    assert.deepEqual(planned, { command: 'npx', args: ARGS }, platform);
  }
  let seen;
  const result = runLoopGuardSelfTest({ loopGuardSelfTestRunner(input) { seen = input; return { status: 0, stdout: JSON.stringify(PROOF), stderr: '' }; } });
  assert.equal(result.passed, true);
  if (process.platform !== 'win32') {
    assert.equal(seen.command, 'npx');
    assert.deepEqual(seen.args, ARGS);
  }
  assert.deepEqual(Object.keys(seen), ['command', 'args', 'cwd', 'env', 'encoding', 'timeout', 'maxBuffer']);
  assert.equal(seen.shell, undefined, 'never a shell');
  assert.equal(seen.env.MARROW_API_KEY, '');
  assert.equal(seen.env.MARROW_KEY, '');
});

test('F-2b win32: node runs npm\'s npx-cli.js with the arguments as an array: no .cmd, no shell, nothing joined', POSIX_ONLY, () => {
  const node = nodeFolder('// stand-in\n');
  try {
    const planned = loopGuardInvocation(VERSION, { platform: 'win32', execPath: node.node });
    assert.equal(planned.command, node.node);
    assert.deepEqual(planned.args, [node.cli, ...ARGS]);
    assert.ok(planned.args.every((arg) => typeof arg === 'string'));
    assert.doesNotMatch(planned.command, /\.(cmd|bat)$/i);
    assert.equal(planned.args.some((arg) => /\.(cmd|bat)$/i.test(arg)), false);
    // The unusual characters are inside single argv elements, never split or concatenated into a line.
    assert.equal(planned.args[0], node.cli);
    assert.ok(/[ &^%!()]/.test(planned.args[0]));
    assert.equal(planned.args.length, 5);
    let seen;
    runLoopGuardSelfTest({
      loopGuardPlatform: 'win32', loopGuardExecPath: node.node,
      loopGuardSelfTestRunner(input) { seen = input; return { status: 0, stdout: JSON.stringify(PROOF), stderr: '' }; },
    });
    assert.equal(seen.command, node.node);
    assert.deepEqual(seen.args, [node.cli, ...ARGS]);
    assert.equal(seen.shell, undefined);
    assert.equal(Object.hasOwn(seen, 'shell'), false);
  } finally {
    fs.rmSync(node.dir, { recursive: true, force: true });
  }
});

test('F-2b win32: the real spawn reaches npx-cli.js with exactly the four arguments, an isolated home and no key', POSIX_ONLY, () => {
  const out = path.join(tempDir('marrow-lg-out-'), 'seen.json');
  const node = nodeFolder(recorder(out));
  const saved = { key: process.env.MARROW_API_KEY, alt: process.env.MARROW_KEY };
  // A key in the caller's environment must not reach the self-test.
  process.env.MARROW_API_KEY = `dummy_${Date.now()}`;
  process.env.MARROW_KEY = `dummy_alt_${Date.now()}`;
  try {
    const before = leftovers();
    const result = runLoopGuardSelfTest({ loopGuardPlatform: 'win32', loopGuardExecPath: node.node });
    assert.equal(result.attempted, true);
    assert.equal(result.passed, true);
    assert.equal(result.isolated, true);
    assert.equal(result.live_hook_observed, false);
    const seen = JSON.parse(fs.readFileSync(out, 'utf8'));
    assert.deepEqual(seen.argv, ARGS);
    assert.equal(seen.home, seen.profile);
    assert.match(path.basename(seen.home), /^marrow-install-loop-guard-/);
    assert.equal(seen.cwd, seen.homeReal);
    assert.equal(seen.key, '');
    assert.equal(seen.keyAlt, '');
    assert.deepEqual(leftovers(), before, 'the isolated home is removed');
  } finally {
    for (const [name, value] of [['MARROW_API_KEY', saved.key], ['MARROW_KEY', saved.alt]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(node.dir, { recursive: true, force: true });
    fs.rmSync(path.dirname(out), { recursive: true, force: true });
  }
});

test('F-2b win32: a missing or non-file npx-cli.js fails closed, before anything starts and without a leftover folder', POSIX_ONLY, () => {
  const missing = nodeFolder(null);
  const asDirectory = nodeFolder(null);
  fs.mkdirSync(asDirectory.cli, { recursive: true });
  const dangling = nodeFolder(null);
  fs.mkdirSync(path.dirname(dangling.cli), { recursive: true });
  fs.symlinkSync(path.join(dangling.dir, 'nowhere.js'), dangling.cli);
  try {
    for (const [name, node] of [['missing', missing], ['a directory', asDirectory], ['a dangling link', dangling]]) {
      const before = leftovers();
      let started = false;
      assert.throws(() => runLoopGuardSelfTest({
        loopGuardPlatform: 'win32', loopGuardExecPath: node.node,
        loopGuardSelfTestRunner() { started = true; return { status: 0, stdout: JSON.stringify(PROOF), stderr: '' }; },
      }), /isolated loop-guard self-test failed: npx-cli\.js was not found next to node/, name);
      assert.equal(started, false, `${name}: nothing was started`);
      assert.deepEqual(leftovers(), before, name);
      const planned = loopGuardInvocation(VERSION, { platform: 'win32', execPath: node.node });
      assert.equal(planned.command, null, name);
    }
    // Never a fallback to npx.cmd or to a PATH lookup.
    assert.equal(loopGuardInvocation(VERSION, { platform: 'win32', execPath: missing.node }).command, null);
  } finally {
    for (const node of [missing, asDirectory, dangling]) fs.rmSync(node.dir, { recursive: true, force: true });
  }
});

test('F-2b win32: a failing, silent or incomplete npx-cli.js is a failure, never a pass', POSIX_ONLY, () => {
  const cases = {
    'exit 1': { script: 'process.stderr.write("boom"); process.exit(1);', message: /failed: boom/ },
    'no output': { script: '', message: /returned invalid JSON/ },
    'not JSON': { script: 'process.stdout.write("hello");', message: /returned invalid JSON/ },
    'pass false': { script: `process.stdout.write(${JSON.stringify(JSON.stringify({ ...PROOF, pass: false }))});`, message: /returned incomplete proof/ },
    'live hook claimed': { script: `process.stdout.write(${JSON.stringify(JSON.stringify({ ...PROOF, live_hook_observed: true }))});`, message: /returned incomplete proof/ },
    'repeat not denied': { script: `process.stdout.write(${JSON.stringify(JSON.stringify({ ...PROOF, repeat_denied: false }))});`, message: /returned incomplete proof/ },
  };
  for (const [name, spec] of Object.entries(cases)) {
    const node = nodeFolder(spec.script);
    try {
      assert.throws(() => runLoopGuardSelfTest({ loopGuardPlatform: 'win32', loopGuardExecPath: node.node }), spec.message, name);
    } finally {
      fs.rmSync(node.dir, { recursive: true, force: true });
    }
  }
});

test('F-2b win32: install() runs the self-test through npx-cli.js and reports it; without npx-cli.js it aborts, as a failed self-test always did', POSIX_ONLY, async () => {
  const root = tempDir('marrow-lg-proj-');
  const home = deadRegistryHome(tempDir('marrow-lg-home-'));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Claude\n');
  const out = path.join(home, 'seen.json');
  const good = nodeFolder(recorder(out));
  const bad = nodeFolder(null);
  const base = {
    cwd: root, home, mode: 'mcp', yes: true, dryRun: false, selfTest: false, controller: false, loopGuardSelfTest: true,
    apiKey: '', baseUrl: 'https://api.getmarrow.ai', agentId: '', mcpLocalRuntime: true,
    mcpRuntimeInstall: () => false, mcpRuntimeProgress: () => {},
  };
  try {
    await assert.rejects(() => install({ ...base, loopGuardPlatform: 'win32', loopGuardExecPath: bad.node }), /isolated loop-guard self-test failed: npx-cli\.js was not found next to node/);
    const report = await install({ ...base, loopGuardPlatform: 'win32', loopGuardExecPath: good.node });
    assert.equal(report.loop_guard.attempted, true);
    assert.equal(report.loop_guard.passed, true);
    assert.equal(report.loop_guard_self_tested, true);
    assert.equal(report.loop_guard_observed, false, 'a self-test is never live-hook evidence');
    assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')).argv, ARGS);
    // A dry run still does not run it.
    const dry = await install({ ...base, yes: false, dryRun: true, loopGuardPlatform: 'win32', loopGuardExecPath: bad.node });
    assert.equal(dry.loop_guard.attempted, false);
  } finally {
    for (const dir of [root, home, good.dir, bad.dir]) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// HOMEROOT (round 1): the installer never picks the home folder as the project root by accident, and a
// user-wide install needs explicit consent (spec-homeroot S1-S6, rows A1-A18). Every row runs the real
// CLI in a child process inside a private fake home; stdin is /dev/null and stdout a pipe unless the
// row says TTY. The seams (passwd home, terminal flags, fs trace) live in test/support/homeroot-preload.cjs.
require('./support/isolated-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { spawnSync } = require('node:child_process');
const { detectEnvironment, parseArgs, confirmUserWide, findUp } = require('../src/installer');
const { controllerIdentity } = require('../src/controller-manager');

const BIN = path.join(__dirname, '..', 'bin', 'marrow-install.js');
const PRELOADS = ['m2-network-recorder.js', 'homeroot-preload.cjs'].flatMap((name) => ['--require', path.join(__dirname, 'support', name)]);
const KEY = `homeroot-dummy-${crypto.randomBytes(8).toString('hex')}`;
assert.doesNotMatch(KEY, /^(?:sk|pk|rk)_|^ghp_|^xox/);
const WRITE = ['--yes', '--no-self-test', '--no-controller'];
const MARKERS = ['CLAUDE.md', 'AGENTS.md', '.git', 'package.json', 'pyproject.toml', 'requirements.txt'];
const REFUSED = 3;
const GLOBAL_CMD = 'npx -y @getmarrow/install@latest activate --global';
const STORES = ['.claude.json', '.claude/settings.local.json', '.npmrc', '.git-credentials', '.marrow/fleet.env', '.config/gh/hosts.yml', '.codex/auth.json', '.hermes/config.yaml'];

function put(file, text = '') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}
function mark(dir, marker) {
  if (marker === '.git') fs.mkdirSync(path.join(dir, marker), { recursive: true });
  else put(path.join(dir, marker), marker === 'package.json' ? '{}\n' : '# marker\n');
}
function world(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'homeroot-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const w = { work: path.join(root, 'work'), net: path.join(root, 'aux', 'net.jsonl'), trace: path.join(root, 'aux', 'trace.log') };
  w.home = path.join(w.work, 'home');
  fs.mkdirSync(path.dirname(w.net), { recursive: true });
  put(path.join(w.home, '.marrow', 'env'), `MARROW_API_KEY=${KEY}\n`);
  return w;
}
function dir(...parts) {
  const folder = path.join(...parts);
  fs.mkdirSync(folder, { recursive: true });
  return folder;
}
function deep(base, levels) {
  return dir(base, ...Array.from({ length: levels }, (_, i) => `d${i + 1}`));
}
function files(root, bytes = false) {
  const found = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) { found[`${rel}/`] = ''; walk(full); } else if (entry.isSymbolicLink()) found[rel] = fs.readlinkSync(full);
      else found[rel] = bytes ? fs.readFileSync(full, 'utf8') : `${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')} ${fs.lstatSync(full).mtimeMs}`;
    }
  };
  walk(root);
  return found;
}
function run(w, args, { cwd = w.home, env = {}, answer = null, tty = null } = {}) {
  const merged = {
    PATH: process.env.PATH, HOME: w.home, TMPDIR: path.dirname(w.net), MARROW_API_KEY: KEY, CAPTURE_FILE: w.net, M2_STUB_NPM: '1',
    HOMEROOT_TRACE: w.trace, HOMEROOT_PASSWD_HOME: path.join(w.work, 'no-passwd-home'), ...(tty ? { HOMEROOT_TTY: tty } : {}), ...env,
  };
  merged.HOMEROOT_OS_HOMEDIR = merged.HOMEROOT_OS_HOMEDIR ?? (merged.HOME || merged.USERPROFILE || w.home);
  for (const name of Object.keys(merged)) if (merged[name] === undefined) delete merged[name];
  const child = spawnSync(process.execPath, [...PRELOADS, BIN, ...args], {
    cwd, env: merged, encoding: 'utf8', timeout: 90_000, ...(answer === null ? { stdio: ['ignore', 'pipe', 'pipe'] } : { input: answer }),
  });
  const out = `${child.stdout}${child.stderr}`;
  assert.ok(!out.includes(KEY), 'A18: the key never reaches the output');
  const written = files(path.dirname(w.work), true);
  for (const [name, text] of Object.entries(written)) if (!name.endsWith(path.join('.marrow', 'env'))) assert.ok(!text.includes(KEY), `A18: the key is not written to ${name}`);
  return { code: child.status, out };
}
const rootOf = (out) => (/^Root: (.*?)(?: \(user-wide.*)?$/m.exec(out) || [])[1];
const noNetwork = (w) => assert.ok(!fs.existsSync(w.net) || fs.readFileSync(w.net, 'utf8') === '', 'no network attempt');
function refused(w, before, result, command = GLOBAL_CMD) {
  assert.equal(result.code, REFUSED, result.out);
  assert.ok(result.out.includes(command), result.out);
  assert.deepEqual(files(w.work), before, 'nothing created or changed');
  noNetwork(w);
}

// S1 walk: A1-A6, A14
for (const marker of MARKERS) {
  test(`A1 ${marker} in the home folder: a run from home/sub installs in home/sub`, (t) => {
    const w = world(t);
    mark(w.home, marker);
    const sub = dir(w.home, 'sub');
    assert.equal(rootOf(run(w, ['--dry-run'], { cwd: sub }).out), sub);
    const result = run(w, WRITE, { cwd: sub });
    assert.equal(result.code, 0, result.out);
    for (const name of ['.mcp.json', path.join('.claude', 'settings.json')]) assert.equal(fs.existsSync(path.join(w.home, name)), false, `nothing at ${name}`);
    assert.ok(fs.existsSync(path.join(sub, '.mcp.json')));
  });
}
for (const levels of [2, 8, 9]) {
  test(`A2 ${levels} folders below a home with a marker: root is the cwd`, (t) => {
    const w = world(t);
    mark(w.home, 'CLAUDE.md');
    const cwd = deep(w.home, levels);
    assert.equal(rootOf(run(w, ['--dry-run'], { cwd }).out), cwd);
  });
}
test('A3 HOME is a symlink: the walk stops below the home in both spellings', (t) => {
  const w = world(t);
  mark(w.home, 'CLAUDE.md');
  const sub = dir(w.home, 'sub');
  const link = path.join(w.work, 'link');
  fs.symlinkSync(w.home, link, 'dir');
  assert.equal(rootOf(run(w, ['--dry-run'], { cwd: sub, env: { HOME: link } }).out), sub);
  assert.equal(rootOf(run(w, ['--dry-run', '--cwd', path.join(link, 'sub')], { cwd: w.work, env: { HOME: link } }).out), path.join(link, 'sub'));
  assert.equal(rootOf(run(w, ['--dry-run', '--cwd', path.join(link, 'sub')], { cwd: w.work }).out), path.join(link, 'sub'));
});
test('A4 HOME spoofed by the environment: the passwd home is a home folder too', (t) => {
  const w = world(t);
  mark(w.home, 'CLAUDE.md');
  const sub = dir(w.home, 'sub');
  const other = dir(w.work, 'other');
  const result = run(w, WRITE, { cwd: sub, env: { HOME: other, HOMEROOT_PASSWD_HOME: w.home } });
  assert.equal(result.code, 0, result.out);
  assert.equal(fs.existsSync(path.join(w.home, '.claude')), false);
  assert.equal(fs.existsSync(path.join(w.home, '.mcp.json')), false);
  assert.equal(rootOf(run(w, ['--dry-run'], { cwd: sub, env: { HOME: other, HOMEROOT_PASSWD_HOME: w.home } }).out), sub);
});
test('A5 USERPROFILE (HOME unset or empty) is read as the home; win32 and darwin compare case-insensitively', async (t) => {
  const w = world(t);
  mark(w.home, 'CLAUDE.md');
  const sub = dir(w.home, 'sub');
  // The spawn guard of the suite fills an unset HOME for every child, so the USERPROFILE forms run in-process with explicit environments
  // (tools run the same forms as real children outside the suite).
  for (const env of [{ USERPROFILE: w.home }, { HOME: '', USERPROFILE: w.home }]) {
    assert.equal(detectEnvironment(sub, env).root, sub);
    const output = new PassThrough();
    assert.equal(await confirmUserWide({ ...parseArgs(['--yes'], env), cwd: w.home }, { input: new PassThrough(), output }), false);
    assert.ok(String(output.read()).includes(GLOBAL_CMD));
  }
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  for (const platform of ['win32', 'darwin']) {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    try {
      assert.equal(detectEnvironment(sub, { USERPROFILE: path.join(w.work, 'HOME') }).root, sub, platform);
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  }
});
test('A6 outside every home the walk is as before: own marker, a sub without one, no marker at all', (t) => {
  const w = world(t);
  const app = dir(w.work, 'srv', 'app');
  mark(app, 'package.json');
  assert.equal(rootOf(run(w, ['--dry-run'], { cwd: dir(app, 'sub') }).out), app);
  assert.equal(rootOf(run(w, ['--dry-run'], { cwd: app }).out), app);
  const lone = dir(w.work, 'srv', 'lone', 'sub');
  assert.equal(rootOf(run(w, ['--dry-run'], { cwd: lone }).out), lone);
});
test('A14 HOME of / , a missing HOME, HOME unset with the os fallback, no passwd entry: no crash, never a home root', (t) => {
  const w = world(t);
  const lone = dir(w.work, 'srv', 'lone', 'sub');
  assert.equal(detectEnvironment(lone, { HOME: '/' }).root, lone, 'HOME of / (a child cannot run with it: the suite guard keeps HOME in the test temp dir)');
  const result = run(w, ['--dry-run'], { cwd: lone, env: { HOME: path.join(w.work, 'missing') } });
  assert.equal(result.code, 0, result.out);
  assert.equal(rootOf(result.out), lone);
  mark(w.home, 'CLAUDE.md');
  const sub = dir(w.home, 'sub');
  const realHomedir = os.homedir;
  os.homedir = () => w.home;
  try {
    assert.equal(detectEnvironment(sub, {}).root, sub, 'HOME and USERPROFILE unset: os.homedir() is the home');
  } finally {
    os.homedir = realHomedir;
  }
  const noPasswd = run(w, ['--dry-run'], { cwd: sub, env: { HOMEROOT_PASSWD_HOME: 'throw' } });
  assert.equal(noPasswd.code, 0, noPasswd.out);
  assert.equal(rootOf(noPasswd.out), sub);
});

// S2 user-wide scope: A7-A13, A17
const ASKS = [[], ['activate'], ['--yes'], ['-y'], ['--mcp', '--yes'], ['activate', '--yes'], ['--yes', '--no-self-test', '--no-controller']];
for (const args of ASKS) {
  test(`A7/A10 root = home, no flag, no terminal: \`${args.join(' ') || '(no command)'}\` refuses and writes nothing`, (t) => {
    const w = world(t);
    mark(w.home, '.git');
    refused(w, files(w.work), run(w, args));
  });
}
test('A7 update and repair name their own --global command', (t) => {
  const w = world(t);
  mark(w.home, '.git');
  for (const args of [['update'], ['--repair']]) refused(w, files(w.work), run(w, args), 'npx -y @getmarrow/install@latest update --global');
});
for (const [name, answer] of [['empty line', '\n'], ['n', 'n\n'], ['no', 'no\n'], ['garbage', 'maybe\n'], ['y but more words', 'y please\n'], ['EOF', '']]) {
  test(`A8 terminal on both ends, answer ${name}: nothing written, exit ${REFUSED}`, (t) => {
    const w = world(t);
    mark(w.home, '.git');
    const before = files(w.work);
    const result = run(w, ['--yes', '--no-self-test', '--no-controller'], { answer, tty: 'both' });
    assert.equal(result.code, REFUSED, result.out);
    assert.ok(result.out.includes('Install Marrow for your whole user account? [y/N]'), result.out);
    assert.ok(result.out.includes(`Root: ${w.home} (user-wide`), result.out);
    assert.deepEqual(files(w.work), before);
    noNetwork(w);
  });
}
test('A9 terminal answer y / " YES " proceeds with exactly the write set of --cwd <home>', (t) => {
  const flagged = world(t);
  mark(flagged.home, '.git');
  assert.equal(run(flagged, [...WRITE, '--cwd', flagged.home]).code, 0);
  const expected = files(flagged.home, true);
  assert.ok(expected['.mcp.json'], 'the consented run writes the home config');
  for (const answer of ['y\n', ' YES \n', 'Yes\n']) {
    const w = world(t);
    mark(w.home, '.git');
    const result = run(w, WRITE, { answer, tty: 'both' });
    assert.equal(result.code, 0, result.out);
    const swap = (text) => text.split(w.work).join(flagged.work);
    const got = Object.fromEntries(Object.entries(files(w.home, true)).map(([name, text]) => [name, swap(text)]));
    for (const name of Object.keys(expected)) if (!/identity-record/.test(name)) assert.equal(got[name], expected[name], name);
    assert.deepEqual(Object.keys(got).sort(), Object.keys(expected).sort());
  }
});
test('A11 --global, --cwd <home> (literal, .., trailing slash, symlink) are explicit consent', (t) => {
  const forms = [
    (w) => ({ args: ['--global'], cwd: dir(w.work, 'elsewhere') }),
    (w) => ({ args: ['--global'], cwd: dir(w.home, 'sub') }),
    (w) => ({ args: ['--cwd', w.home], cwd: dir(w.work, 'elsewhere') }),
    (w) => ({ args: ['--cwd', '..'], cwd: dir(w.home, 'sub') }),
    (w) => ({ args: ['--cwd', `${w.home}/`], cwd: dir(w.work, 'elsewhere') }),
  ];
  for (const form of forms) {
    const w = world(t);
    mark(w.home, 'CLAUDE.md');
    const { args, cwd } = form(w);
    const result = run(w, [...WRITE, ...args], { cwd });
    assert.equal(result.code, 0, `${args.join(' ')}: ${result.out}`);
    assert.ok(fs.existsSync(path.join(w.home, '.mcp.json')), args.join(' '));
  }
  const w = world(t);
  mark(w.home, 'CLAUDE.md');
  fs.symlinkSync(w.home, path.join(w.work, 'link'), 'dir');
  const viaLink = run(w, [...WRITE, '--cwd', path.join(w.work, 'link')], { cwd: dir(w.work, 'elsewhere') });
  assert.match(viaLink.out, /unsafe project root/, 'consent holds; the installer then refuses to write through a symlink, as on BASE');
  assert.equal(fs.existsSync(path.join(w.home, '.mcp.json')), false);
  const conflict = run(w, [...WRITE, '--global', '--cwd', dir(w.work, 'elsewhere')]);
  assert.notEqual(conflict.code, 0);
  assert.match(conflict.out, /--global.*--cwd/);
  const fresh = world(t);
  mark(fresh.home, '.git');
  refused(fresh, files(fresh.work), run(fresh, [...WRITE, '--cwd']));
});
test('A12 a terminal on only one side is no terminal: refuse even with a typed y', (t) => {
  for (const tty of ['stdin', 'stdout']) {
    const w = world(t);
    mark(w.home, '.git');
    refused(w, files(w.work), run(w, WRITE, { answer: 'y\n', tty }));
  }
});
test('A13 CI, MARROW_* variables and a config file that says global are never consent', (t) => {
  const w = world(t);
  mark(w.home, '.git');
  put(path.join(w.home, '.marrow', 'config.json'), '{"global":true,"yes":true}\n');
  const before = files(w.work);
  const env = { CI: '1', MARROW_YES: '1', MARROW_GLOBAL: '1', MARROW_ASSUME_YES: '1', MARROW_INSTALL_GLOBAL: 'true', MARROW_CONSENT: 'user-wide' };
  for (const args of [[], ['activate'], WRITE]) refused(w, before, run(w, args, { env }));
});
test('A17 --dry-run and doctor in the home folder never prompt: they print the user-wide Root line and write nothing', (t) => {
  for (const args of [['--dry-run'], ['doctor']]) {
    const w = world(t);
    mark(w.home, '.git');
    const before = files(w.work);
    const result = run(w, args, { answer: '', tty: 'both' });
    assert.notEqual(result.code, REFUSED, result.out);
    assert.ok(!result.out.includes('[y/N]'), result.out);
    assert.ok(result.out.split('\n').some((line) => line.startsWith(`Root: ${w.home} (user-wide`)), result.out);
    assert.deepEqual(files(w.work), before);
  }
});
test('S2 the ask answers y / YES / no / empty, and a silent terminal times out as a no', async (t) => {
  const w = world(t);
  mark(w.home, '.git');
  const options = { ...parseArgs(['--yes']), home: w.home, cwd: w.home };
  const terminal = () => Object.assign(new PassThrough(), { isTTY: true });
  const keepAlive = setTimeout(() => {}, 10_000); // the abort timer is unref'd; a real terminal keeps the loop alive
  t.after(() => clearTimeout(keepAlive));
  for (const [line, expected] of [['y\n', true], [' YES \n', true], ['n\n', false], ['\n', false]]) {
    const input = terminal();
    input.end(line);
    assert.equal(await confirmUserWide(options, { input, output: terminal(), timeoutMs: 2000 }), expected, JSON.stringify(line));
  }
  assert.equal(await confirmUserWide(options, { input: terminal(), output: terminal(), timeoutMs: 40 }), false);
});

// S3 consumers: A15, run from a subfolder of an existing home-level install
function homeInstall(t) {
  const w = world(t);
  mark(w.home, 'CLAUDE.md');
  const result = run(w, [...WRITE, '--cwd', w.home]);
  assert.equal(result.code, 0, result.out);
  assert.ok(fs.existsSync(path.join(w.home, '.mcp.json')));
  return { w, sub: dir(w.home, 'sub'), before: files(w.home) };
}
test('A15 update from a subfolder refuses and points at --cwd <home>', (t) => {
  const { w, sub, before } = homeInstall(t);
  const result = run(w, ['update'], { cwd: sub });
  assert.notEqual(result.code, 0);
  assert.ok(result.out.includes(`update --cwd ${w.home}`), result.out);
  assert.deepEqual(files(w.home), before);
});
test('A15 uninstall from a subfolder names the home install and the exact command, and removes nothing', (t) => {
  const { w, sub, before } = homeInstall(t);
  for (const args of [['uninstall'], ['uninstall', '--yes']]) {
    const result = run(w, args, { cwd: sub });
    assert.equal(result.code, 0, result.out);
    assert.ok(result.out.includes(`uninstall --cwd ${w.home}`), result.out);
    assert.match(result.out, /installed for your user account/);
  }
  // `uninstall --yes` leaves an empty controller lock folder for its own root, as on BASE; no file is touched.
  assert.deepEqual(Object.fromEntries(Object.entries(files(w.home)).filter(([name]) => !name.startsWith(path.join('.marrow', 'controllers')))), before);
  const direct = run(w, ['uninstall', '--yes', '--cwd', w.home], { cwd: sub });
  assert.equal(direct.code, 0, direct.out);
  assert.match(direct.out, /Marrow entries removed/, 'the pointed-at command still removes the home install');
  assert.ok(!/marrow/i.test(fs.readFileSync(path.join(w.home, '.mcp.json'), 'utf8')));
});
test('A15 doctor from a subfolder names the home-level install; the controller identity of the home install is unchanged', (t) => {
  const { w, sub } = homeInstall(t);
  const result = run(w, ['doctor'], { cwd: sub });
  assert.ok(result.out.includes(`installed for your user account at ${w.home}`), result.out);
  const sha = crypto.createHash('sha256').update(`${w.home}\0claude-code-x`).digest('hex').slice(0, 24);
  assert.equal(controllerIdentity({ root: w.home, identityAgentId: 'claude-code-x' }), sha);
});

// S4: findUp keeps its behaviour for every other caller (A16); only projectRoot's walk stops
test('A16 findUp is unchanged without a stop: it climbs through a home folder, depth and order as before', (t) => {
  const w = world(t);
  put(path.join(w.home, 'openclaw.json'), '{}');
  const sub = deep(w.home, 3);
  assert.equal(findUp(sub, ['openclaw.json'], 4), path.join(w.home, 'openclaw.json'));
  assert.equal(findUp(deep(w.home, 5), ['openclaw.json'], 4), null);
  assert.equal(findUp(sub, ['nothing', 'openclaw.json']), path.join(w.home, 'openclaw.json'));
  assert.equal(detectEnvironment(sub, { HOME: w.home }).paths.openclawJson, path.join(w.home, 'openclaw.json'));
  mark(w.home, '.git');
  assert.equal(findUp(sub, ['.git'], 64), path.join(w.home, '.git'));
  assert.equal(findUp(deep(w.home, 9), ['.git']), null);
});

// S5/S6: secrets, credential stores, text
// BASE already reads these three in every detection pass (RESULT, deviation 2); no other store is ever read.
const BASE_READS = new Set(['.claude.json', '.hermes/config.yaml', '.claude/settings.local.json']);
test('A18/CREDENTIAL_STORES refused runs read no store; other runs read only what BASE reads, never by symlink or hard link', (t) => {
  const w = world(t);
  mark(w.home, 'CLAUDE.md');
  const sub = dir(w.home, 'sub');
  for (const store of STORES) put(path.join(w.home, store), 'DUMMY_STORE_LINE=1\n');
  fs.linkSync(path.join(w.home, '.git-credentials'), path.join(w.home, 'hardlink-of-store'));
  fs.symlinkSync(path.join(w.home, '.npmrc'), path.join(sub, 'symlink-of-store'));
  const names = new Map([...STORES, 'hardlink-of-store'].map((store) => { const s = fs.statSync(path.join(w.home, store)); return [`${s.dev}:${s.ino}`, store]; }));
  const reads = new Set(['openSync', 'readFileSync', 'open', 'readFile', 'createReadStream']);
  const storeReads = (args, cwd, extra) => {
    put(w.trace, '');
    const { code } = run(w, args, { cwd, ...extra });
    const opened = fs.readFileSync(w.trace, 'utf8').split('\n').filter(Boolean).map((line) => line.split(' ')).filter(([op]) => reads.has(op));
    return { code, all: opened.length, stores: opened.filter(([, , id]) => names.has(id)).map(([, , id]) => names.get(id)) };
  };
  for (const [args, cwd] of [[['--dry-run'], sub], [[...WRITE, '--cwd', w.home], w.home], [['--dry-run'], w.home], [['update'], sub], [['uninstall'], sub], [['doctor'], sub]]) {
    const seen = storeReads(args, cwd);
    assert.ok(seen.all > 10, `${args.join(' ')}: the trace saw the run`);
    assert.deepEqual(seen.stores.filter((store) => !BASE_READS.has(store)), [], `${args.join(' ')}: a store BASE never reads was opened`);
  }
  for (const [args, extra] of [[WRITE, {}], [['activate'], {}], [WRITE, { answer: 'n\n', tty: 'both' }]]) {
    const seen = storeReads(args, w.home, extra);
    assert.equal(seen.code, REFUSED, `${args.join(' ')}: refused`);
    assert.deepEqual(seen.stores, [], `${args.join(' ')}: a refused run reads no store at all`);
  }
});
test('S6 --help lists --global and says what a user-wide install is; parseArgs reads --global as no operation', () => {
  const help = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' }).stdout;
  assert.match(help, /--global\s+\S/);
  assert.match(help, /user-wide/i);
  const options = parseArgs(['--global']);
  assert.equal(options.global, true);
  assert.equal(options.yes, true);
});

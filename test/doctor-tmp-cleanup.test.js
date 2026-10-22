require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');

const hostFakes = require('./support/status-host-fakes');
const { acquirePrivateFolder, releaseStatusFolder, runSeatbeltStatus } = require('../src/seatbelt-status');

// Doctor is read-only. Its status child runs in a private folder below <passwd home>/.cache/marrow/doctor-tmp, and
// a run that has to make any of .cache, .cache/marrow or doctor-tmp for it removes what it made again: on success, after a
// failing, killed or timed-out child, after a refusal, after a thrown error, and when several runs overlap (the run that
// leaves last does it, and nobody removes a folder a live run is in). Folders that were already there are never removed.
// The home is compared as a whole: every name, type, mode, owner, link target and a hash of every file's contents.

const BIN = path.join(__dirname, '..', 'bin', 'marrow-install.js');
const STUB = path.join(__dirname, 'support', 'status-child-stub.js');
const HOST_FAKES = path.join(__dirname, 'support', 'status-host-fakes.js');
const RUN_ONCE = path.join(__dirname, 'support', 'status-run-once.js');
const HOLD_CHILD = path.join(__dirname, 'support', 'status-hold-child.js');
const SKIP_ROOT = process.getuid() === 0 ? 'running as root: read-only folders stay writable' : false;
const ORIGINAL_PASSWD_HOME = os.userInfo().homedir;
const OK = { mode: 'seatbelt', reasons: [] };

const tempHome = () => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-doctor-tmp-home-')));
  fs.chmodSync(home, 0o700);
  return home;
};
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-doctor-tmp-scratch-')));
process.once('exit', () => fs.rmSync(scratch, { recursive: true, force: true }));
const rmHome = (home) => fs.rmSync(home, { recursive: true, force: true });

// Names, types, modes, owners, link targets and content hashes of `root` itself and everything below it (directories also by
// inode number, so a folder that was removed and made again is not mistaken for one that was never touched).
function snapshot(root) {
  const rootStat = fs.lstatSync(root);
  const rows = [`. ${(rootStat.mode & 0o7777).toString(8)} uid=${rootStat.uid} dir`];
  const walk = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const full = path.join(directory, name);
      const stat = fs.lstatSync(full);
      const head = `${path.relative(root, full)} ${(stat.mode & 0o7777).toString(8)} uid=${stat.uid}`;
      if (stat.isSymbolicLink()) rows.push(`${head} link -> ${fs.readlinkSync(full)}`);
      else if (stat.isDirectory()) {
        rows.push(`${head} dir ino=${stat.ino}`);
        walk(full);
      } else rows.push(`${head} file size=${stat.size} sha256=${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')}`);
    }
  };
  walk(root);
  return rows;
}

function script(name, source) {
  const file = path.join(scratch, `${name}.js`);
  fs.writeFileSync(file, source);
  return file;
}
const PRINT_OK = `process.stdout.write(${JSON.stringify(JSON.stringify(OK))});`;
const CHILD = {
  ok: script('ok', PRINT_OK),
  exit1: script('exit1', 'process.exit(1);'),
  garbage: script('garbage', "process.stdout.write('this is not the status');"),
  killed: script('killed', "process.kill(process.pid, 'SIGKILL');"),
  hang: script('hang', 'setInterval(() => {}, 1000);'),
  messy: script('messy', `const fs = require('node:fs');
fs.writeFileSync('stray.txt', 'x');
fs.mkdirSync('sub/deeper', { recursive: true });
fs.writeFileSync('sub/deeper/file.txt', 'y');
${PRINT_OK}`),
  report: script('report', `const fs = require('node:fs');
const path = require('node:path');
const levels = [process.cwd()];
for (let i = 0; i < 3; i += 1) levels.push(path.dirname(levels[levels.length - 1]));
fs.writeFileSync(process.env.REPORT_FILE, JSON.stringify(levels.map((dir) => ({ name: path.basename(dir), mode: fs.statSync(dir).mode & 0o777, entries: fs.readdirSync(dir).sort() }))));
${PRINT_OK}`),
  parentReadOnly: script('parentReadOnly', `require('node:fs').chmodSync(require('node:path').dirname(require('node:path').dirname(process.cwd())), 0o500);
${PRINT_OK}`),
};

// One run in this process, with `home` as the passwd home.
async function runIn(home, child = CHILD.ok, { env = {}, limits = {}, invocation } = {}) {
  hostFakes.setPasswdHome(home);
  try {
    return await runSeatbeltStatus(invocation || { command: process.execPath, args: [child], env }, limits);
  } finally {
    hostFakes.setPasswdHome(ORIGINAL_PASSWD_HOME);
  }
}

async function patched(name, wrap, body) {
  const real = fs[name];
  fs[name] = wrap(real);
  try {
    return await body();
  } finally {
    fs[name] = real;
  }
}
const boom = () => Object.assign(new Error('injected failure'), { code: 'EIO' });

const base = (home) => path.join(home, '.cache', 'marrow', 'doctor-tmp');
function makeParts(home, count, { files = false } = {}) {
  const parts = [path.join(home, '.cache'), path.join(home, '.cache', 'marrow'), base(home)].slice(0, count);
  for (const part of parts) fs.mkdirSync(part, { mode: 0o700 });
  if (files && parts[0]) fs.writeFileSync(path.join(parts[0], 'keep.txt'), 'the user\'s own cache file\n', { mode: 0o644 });
  return parts;
}

// ---- 1. success -----------------------------------------------------------------------------------------------------

test('success: a run on an empty home makes .cache/marrow/doctor-tmp (mode 700) and its private folder, and leaves nothing', async () => {
  const home = tempHome();
  try {
    const before = snapshot(home);
    const report = path.join(scratch, 'report-success.json');
    assert.deepEqual(await runIn(home, CHILD.report, { env: { REPORT_FILE: report } }), OK);
    const [cwd, leaf, marrow, cache] = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.deepEqual([cache.name, marrow.name, leaf.name], ['.cache', 'marrow', 'doctor-tmp']);
    for (const level of [cwd, leaf, marrow, cache]) assert.equal(level.mode, 0o700, level.name);
    assert.match(cwd.name, /^marrow-install-seatbelt-/);
    assert.deepEqual(cwd.entries, [], 'the child starts in an empty folder');
    assert.deepEqual(leaf.entries.filter((name) => !name.startsWith('marrow-install-seatbelt-')), ['made-from-0'], 'the run left one note for a peer');
    assert.deepEqual(fs.readdirSync(home), []);
    assert.deepEqual(snapshot(home), before);
  } finally {
    rmHome(home);
  }
});

test('success: parts that were already there are used and never removed, whichever are missing', async () => {
  for (const [label, prepare] of [
    ['.cache exists, with a file of the user', (home) => makeParts(home, 1, { files: true })],
    ['.cache and .cache/marrow exist', (home) => makeParts(home, 2, { files: true })],
    ['all three parts exist (a base an earlier build left)', (home) => makeParts(home, 3, { files: true })],
    ['.cache exists with a mode other than 700', (home) => { makeParts(home, 1, { files: true }); fs.chmodSync(path.join(home, '.cache'), 0o755); }],
  ]) {
    const home = tempHome();
    try {
      prepare(home);
      const before = snapshot(home);
      assert.deepEqual(await runIn(home), OK, label);
      assert.deepEqual(snapshot(home), before, label);
      assert.deepEqual(await runIn(home), OK, `${label}: a second run`);
      assert.deepEqual(snapshot(home), before, `${label}: a second run`);
    } finally {
      rmHome(home);
    }
  }
});

// ---- 2. every other way out -----------------------------------------------------------------------------------------

test('failure: a child that exits 1, prints garbage, is killed, hangs (timeout), writes files, or cannot start leaves nothing', async () => {
  const cases = [
    ['exit 1', CHILD.exit1, {}],
    ['garbage output', CHILD.garbage, {}],
    ['killed by a signal', CHILD.killed, {}],
    ['timeout', CHILD.hang, { limits: { timeoutMs: 300 } }],
    ['more output than allowed', CHILD.ok, { limits: { maxBytes: 5 } }],
  ];
  for (const [label, child, options] of cases) {
    const home = tempHome();
    try {
      const before = snapshot(home);
      assert.equal(await runIn(home, child, options), null, label);
      assert.deepEqual(snapshot(home), before, label);
    } finally {
      rmHome(home);
    }
  }
  const home = tempHome();
  try {
    const before = snapshot(home);
    assert.equal(await runIn(home, null, { invocation: { command: path.join(scratch, 'no-such-program'), args: [], env: {} } }), null, 'cannot start');
    assert.deepEqual(snapshot(home), before, 'cannot start');
    assert.deepEqual(await runIn(home, CHILD.messy), OK, 'a child that writes into its folder');
    assert.deepEqual(snapshot(home), before, 'files the child wrote there are removed with the folder');
  } finally {
    rmHome(home);
  }
});

test('refusal: a package.json or node_modules above the private folder starts nothing and leaves nothing (the parts made for it are removed)', async () => {
  for (const marker of ['package.json', 'node_modules']) {
    const home = tempHome();
    try {
      if (marker === 'package.json') fs.writeFileSync(path.join(home, marker), '{}\n');
      else fs.mkdirSync(path.join(home, marker));
      const before = snapshot(home);
      const ran = path.join(scratch, `ran-${marker}`);
      assert.equal(await runIn(home, script(`touch-${marker}`, `require('node:fs').writeFileSync(${JSON.stringify(ran)}, 'ran');${PRINT_OK}`)), null, marker);
      assert.equal(fs.existsSync(ran), false, `${marker}: nothing was started`);
      assert.deepEqual(snapshot(home), before, marker);
    } finally {
      rmHome(home);
    }
  }
});

test('thrown errors: a failure at every step after the parts are made still removes the folder and the parts', async () => {
  const mine = (target) => String(target).includes('marrow-install-seatbelt-');
  const steps = [
    ['mkdtemp fails', 'mkdtempSync', (real) => (...args) => { if (mine(args[0])) throw boom(); return real(...args); }],
    ['chmod of the private folder fails', 'chmodSync', (real) => (...args) => { if (mine(args[0])) throw boom(); return real(...args); }],
    ['realpath of the private folder fails', 'realpathSync', (real) => Object.assign((...args) => { if (mine(args[0])) throw boom(); return real(...args); }, real)],
    ['the final check of the base fails', 'openSync', (real) => (...args) => { if (String(args[0]).endsWith(`${path.sep}doctor-tmp`)) throw boom(); return real(...args); }],
  ];
  for (const [label, name, wrap] of steps) {
    const home = tempHome();
    try {
      const before = snapshot(home);
      const result = await patched(name, wrap, () => runIn(home));
      assert.equal(result, null, label);
      assert.deepEqual(snapshot(home), before, label);
    } finally {
      rmHome(home);
    }
  }
  // An error thrown while the command is being started.
  const home = tempHome();
  try {
    const before = snapshot(home);
    const invocation = { get command() { throw boom(); }, args: [], env: {} };
    assert.equal(await runIn(home, null, { invocation }), null);
    assert.deepEqual(snapshot(home), before);
  } finally {
    rmHome(home);
  }
});

test('Windows branch: the per-user temp folder is used and cleaned, and the passwd home is never touched', () => {
  const home = tempHome();
  try {
    const before = snapshot(home);
    const held = { cwd: null, parts: [], from: null, noted: false };
    assert.equal(acquirePrivateFolder(held, 'win32'), true);
    assert.equal(path.dirname(held.cwd), fs.realpathSync(os.tmpdir()));
    assert.equal(fs.existsSync(held.cwd), true);
    releaseStatusFolder(held);
    assert.equal(fs.existsSync(held.cwd), false);
    assert.deepEqual(snapshot(home), before);
  } finally {
    rmHome(home);
  }
});

// ---- 3. read-only parents -------------------------------------------------------------------------------------------

test('read-only parent: an unwritable home, .cache or .cache/marrow stops the run before anything is made (nothing to clean up)', { skip: SKIP_ROOT }, async () => {
  for (const [label, parts, locked] of [
    ['the home itself', 0, (home) => home],
    ['.cache', 1, (home) => path.join(home, '.cache')],
    ['.cache/marrow', 2, (home) => path.join(home, '.cache', 'marrow')],
  ]) {
    const home = tempHome();
    const target = locked(home);
    try {
      makeParts(home, parts, { files: parts > 0 });
      const before = snapshot(home);
      fs.chmodSync(target, 0o500);
      const modeBefore = fs.lstatSync(target).mode & 0o7777;
      assert.equal(await runIn(home), null, label);
      fs.chmodSync(target, 0o700);
      assert.deepEqual(snapshot(home), before, label);
      assert.equal(modeBefore, 0o500);
    } finally {
      fs.chmodSync(target, 0o700);
      rmHome(home);
    }
  }
});

test('read-only parent made during the run: the private folder is still removed, the status is still returned, and a later run finishes the job', { skip: SKIP_ROOT }, async () => {
  const home = tempHome();
  const marrow = path.join(home, '.cache', 'marrow');
  try {
    assert.deepEqual(await runIn(home, CHILD.parentReadOnly), OK);
    // .cache/marrow cannot be written any more, so doctor-tmp (empty but for the note) cannot be removed: that is all that is left.
    assert.equal(fs.readdirSync(base(home)).filter((name) => name.startsWith('marrow-install-seatbelt-')).length, 0, 'no private folder left');
    assert.deepEqual(fs.readdirSync(base(home)), ['made-from-0'], 'the duty stays as a note for a later run');
    fs.chmodSync(marrow, 0o700);
    assert.deepEqual(await runIn(home), OK);
    assert.deepEqual(fs.readdirSync(home), [], 'the next run, with the folder writable again, removed all of it');
  } finally {
    if (fs.existsSync(marrow)) fs.chmodSync(marrow, 0o700);
    rmHome(home);
  }
});

// ---- 4. several runs at once ----------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  for (let waited = 0; waited < 30000; waited += 10) {
    if (check()) return;
    await sleep(10);
  }
  assert.fail(`timed out waiting for ${label}`);
}

function startRun(home, hold, name, extra = {}) {
  const out = path.join(hold, `${name}.out`);
  const child = spawn(process.execPath, ['--require', HOST_FAKES, RUN_ONCE, HOLD_CHILD, out], {
    env: { PATH: process.env.PATH, TMPDIR: os.tmpdir(), STATUS_TEST_PASSWD_HOME: home, HOLD_DIR: hold, HOLD_NAME: name, ...extra },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on('close', (code) => resolve({ code, stderr })));
  return { name, out, exited, up: path.join(hold, `${name}.up`), go: path.join(hold, `${name}.go`) };
}
async function finish(run) {
  fs.writeFileSync(run.go, '');
  const { code, stderr } = await run.exited;
  assert.equal(code, 0, `${run.name}: ${stderr}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(run.out, 'utf8')), OK, `${run.name} got its status`);
}

const permutations = (items) => (items.length < 2 ? [items] : items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest])));

test('concurrent: three runs alive together finish in every order; nobody removes a live run\'s folder; the last one out removes the parts', async () => {
  for (const preMade of [0, 3]) {
    for (const order of permutations(['a', 'b', 'c'])) {
      const home = tempHome();
      const hold = fs.mkdtempSync(path.join(scratch, 'hold-'));
      try {
        makeParts(home, preMade);
        const before = snapshot(home);
        const runs = Object.fromEntries(['a', 'b', 'c'].map((name) => [name, startRun(home, hold, name)]));
        for (const run of Object.values(runs)) await until(() => fs.existsSync(run.up), `${run.name} to be running`);
        const folders = Object.values(runs).map((run) => fs.readFileSync(run.up, 'utf8'));
        assert.equal(new Set(folders).size, 3, 'unique names');
        for (const folder of folders) {
          assert.equal(path.dirname(folder), base(home));
          assert.match(path.basename(folder), /^marrow-install-seatbelt-/);
        }
        for (const [position, name] of order.entries()) {
          await finish(runs[name]);
          const stillLive = order.slice(position + 1).map((later) => fs.readFileSync(runs[later].up, 'utf8'));
          for (const folder of stillLive) assert.equal(fs.existsSync(folder), true, `${name} left: ${folder} is still there`);
          if (stillLive.length > 0) assert.equal(fs.existsSync(base(home)), true, `${name} left: the base stays while another run is in it`);
        }
        assert.deepEqual(snapshot(home), before, `order ${order.join('')}, ${preMade} parts made before`);
      } finally {
        rmHome(home);
      }
    }
  }
});

test('concurrent: a second run that starts while the first has the base, and a run that arrives just as the last one leaves', async () => {
  const home = tempHome();
  const hold = fs.mkdtempSync(path.join(scratch, 'hold-'));
  try {
    const before = snapshot(home);
    const first = startRun(home, hold, 'first');
    await until(() => fs.existsSync(first.up), 'the first run');
    const second = startRun(home, hold, 'second');
    await until(() => fs.existsSync(second.up), 'the second run');
    await finish(first);
    assert.equal(fs.existsSync(fs.readFileSync(second.up, 'utf8')), true, 'the second run\'s folder is untouched');
    // The first run made the parts; the second finds only its own folder and the note the first left for it.
    assert.deepEqual(fs.readdirSync(base(home)).filter((name) => !name.startsWith('marrow-install-seatbelt-')), ['made-from-0']);
    await finish(second);
    assert.deepEqual(snapshot(home), before);
  } finally {
    rmHome(home);
  }
});

test('concurrent stress: twelve runs at once with random lengths, five rounds on a fresh home each: all get a status, nothing is left', async () => {
  for (let round = 0; round < 5; round += 1) {
    const home = tempHome();
    const hold = fs.mkdtempSync(path.join(scratch, 'stress-'));
    try {
      const before = snapshot(home);
      const runs = Array.from({ length: 12 }, (_, index) => {
        const name = `r${index}`;
        const out = path.join(hold, `${name}.out`);
        const child = spawn(process.execPath, ['--require', HOST_FAKES, RUN_ONCE, HOLD_CHILD, out], {
          env: { PATH: process.env.PATH, TMPDIR: os.tmpdir(), STATUS_TEST_PASSWD_HOME: home, SLEEP_MS: String(Math.floor(Math.random() * 120)) },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        return new Promise((resolve) => child.on('close', (code) => resolve({ name, out, code, stderr })));
      });
      for (const run of await Promise.all(runs)) {
        assert.equal(run.code, 0, `${run.name}: ${run.stderr}`);
        assert.deepEqual(JSON.parse(fs.readFileSync(run.out, 'utf8')), OK, `round ${round} ${run.name} got its status`);
      }
      assert.deepEqual(snapshot(home), before, `round ${round}`);
    } finally {
      rmHome(home);
    }
  }
});

// ---- 5. things planted by someone else ------------------------------------------------------------------------------

function outside(home) {
  const dir = path.join(scratch, `outside-${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'precious.txt'), 'not doctor\'s\n');
  fs.mkdirSync(path.join(dir, 'marrow', 'doctor-tmp'), { recursive: true, mode: 0o700 });
  return dir;
}

test('planted: a link as .cache, .cache/marrow or doctor-tmp, or a file as doctor-tmp, is refused; nothing behind the link is made or removed', async () => {
  for (const [label, plant] of [
    ['.cache is a link', (home, target) => fs.symlinkSync(target, path.join(home, '.cache'))],
    ['.cache/marrow is a link', (home, target) => { makeParts(home, 1); fs.symlinkSync(path.join(target, 'marrow'), path.join(home, '.cache', 'marrow')); }],
    ['doctor-tmp is a link', (home, target) => { makeParts(home, 2); fs.symlinkSync(path.join(target, 'marrow', 'doctor-tmp'), base(home)); }],
    ['doctor-tmp is a file', (home) => { makeParts(home, 2); fs.writeFileSync(base(home), 'a file where the folder goes\n'); }],
  ]) {
    const home = tempHome();
    const target = outside(home);
    try {
      plant(home, target);
      const beforeHome = snapshot(home);
      const beforeOutside = snapshot(target);
      assert.equal(await runIn(home), null, label);
      assert.deepEqual(snapshot(home), beforeHome, `${label}: the home, links included`);
      assert.deepEqual(snapshot(target), beforeOutside, `${label}: nothing outside the home was made or removed`);
    } finally {
      rmHome(home);
    }
  }
});

test('planted: the passwd home is a link to the real home: the parts are made below the real home, removed again, and the link stays', async () => {
  const real = tempHome();
  const holder = fs.mkdtempSync(path.join(scratch, 'link-'));
  const link = path.join(holder, 'home-link');
  try {
    fs.symlinkSync(real, link);
    const before = snapshot(real);
    assert.deepEqual(await runIn(link), OK);
    assert.deepEqual(snapshot(real), before);
    assert.equal(fs.readlinkSync(link), real);
    assert.deepEqual(snapshot(holder).slice(1), [`home-link ${(fs.lstatSync(link).mode & 0o7777).toString(8)} uid=${process.getuid()} link -> ${real}`]);
  } finally {
    rmHome(real);
  }
});

test('planted: a doctor-tmp that holds someone\'s files keeps them; only the run\'s own folder goes', async () => {
  const home = tempHome();
  try {
    makeParts(home, 3, { files: true });
    fs.writeFileSync(path.join(base(home), 'precious.txt'), 'keep me\n');
    fs.mkdirSync(path.join(base(home), 'sub'));
    fs.writeFileSync(path.join(base(home), 'sub', 'deep.txt'), 'keep me too\n');
    const before = snapshot(home);
    assert.deepEqual(await runIn(home), OK);
    assert.deepEqual(snapshot(home), before);
  } finally {
    rmHome(home);
  }
});

test('planted notes: a note is only ever taken as an empty folder; files, links and full folders named like one are left, and so is everything above', async () => {
  for (const [label, plant] of [
    ['a file named made-from-0', (leaf) => fs.writeFileSync(path.join(leaf, 'made-from-0'), 'x')],
    ['a link named made-from-0 (to an outside folder)', (leaf, outsideDir) => fs.symlinkSync(outsideDir, path.join(leaf, 'made-from-0'))],
    ['a folder made-from-0 with a file in it', (leaf) => { fs.mkdirSync(path.join(leaf, 'made-from-0')); fs.writeFileSync(path.join(leaf, 'made-from-0', 'x'), 'x'); }],
    ['a file named like a live run', (leaf) => fs.writeFileSync(path.join(leaf, 'marrow-install-seatbelt-planted'), 'x')],
    ['a note with another index', (leaf) => fs.mkdirSync(path.join(leaf, 'made-from-9'))],
  ]) {
    const home = tempHome();
    const target = outside(home);
    try {
      makeParts(home, 3, { files: true });
      plant(base(home), target);
      const beforeHome = snapshot(home);
      const beforeOutside = snapshot(target);
      assert.deepEqual(await runIn(home), OK, label);
      assert.deepEqual(snapshot(home), beforeHome, label);
      assert.deepEqual(snapshot(target), beforeOutside, label);
    } finally {
      rmHome(home);
    }
  }
});

test('planted notes: an empty note folder made by hand lets the next run remove only empty folders from doctor-tmp up to the index it names', async () => {
  const home = tempHome();
  try {
    makeParts(home, 3, { files: true });
    fs.mkdirSync(path.join(base(home), 'made-from-2'));
    assert.deepEqual(await runIn(home), OK);
    assert.deepEqual(snapshot(home).slice(1).map((row) => row.split(' ')[0]), ['.cache', '.cache/keep.txt', '.cache/marrow'], 'doctor-tmp went; .cache and its file and .cache/marrow stay');
    // The same with an index that reaches .cache: it holds a file of the user's, so it stays.
    fs.mkdirSync(base(home), { mode: 0o700 });
    fs.mkdirSync(path.join(base(home), 'made-from-0'));
    assert.deepEqual(await runIn(home), OK);
    assert.deepEqual(snapshot(home).slice(1).map((row) => row.split(' ')[0]), ['.cache', '.cache/keep.txt'], 'doctor-tmp and the empty .cache/marrow went; .cache keeps the user\'s file');
  } finally {
    rmHome(home);
  }
});

// ---- 6. the doctor command itself -----------------------------------------------------------------------------------

// Doctor's loop-guard self-test looks `npx` up on PATH; these runs stay offline, so a stand-in answers that one call with the
// passing proof (as installer-0166 does) and fails any other. The status child never reaches it: the stub preload answers that.
let stubDir = null;
function npxStub() {
  if (stubDir) return stubDir;
  stubDir = fs.mkdtempSync(path.join(scratch, 'npx-'));
  const proof = JSON.stringify({ pass: true, isolated: true, live_hook_observed: false, repeat_denied: true, mutation_reset: true, owner_disabled_bypass: true });
  fs.writeFileSync(path.join(stubDir, 'npx'), `#!/bin/sh\ncase " $* " in\n  *" loop-guard-self-test "*) printf '%s' '${proof}'; exit 0 ;;\nesac\necho "npx is not available in these tests" >&2\nexit 127\n`, { mode: 0o755 });
  return stubDir;
}

test('the doctor command on a fresh home changes nothing in the home or the project (names, modes, owners, link targets, content hashes)', () => {
  for (const args of [['doctor', '--yes'], ['--yes', 'doctor'], ['doctor']]) {
    const home = tempHome();
    const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-doctor-tmp-proj-')));
    try {
      fs.chmodSync(project, 0o700);
      fs.mkdirSync(path.join(project, '.claude'));
      fs.writeFileSync(path.join(project, '.claude', 'settings.json'), '{}\n');
      const beforeHome = snapshot(home);
      const beforeProject = snapshot(project);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = spawnSync(process.execPath, [BIN, ...args], {
          cwd: project,
          env: { PATH: `${npxStub()}${path.delimiter}${process.env.PATH}`, HOME: home, TMPDIR: os.tmpdir(), MARROW_LOCAL_RUNTIME: '0', NODE_OPTIONS: `--require=${STUB}` },
          encoding: 'utf8',
          timeout: 120000,
          input: '',
        });
        assert.notEqual(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
        assert.match(result.stdout, /- Seatbelt: /, `${args.join(' ')}: doctor reached the status step`);
        assert.deepEqual(snapshot(home), beforeHome, `${args.join(' ')} run ${attempt + 1}`);
        assert.deepEqual(snapshot(project), beforeProject, `${args.join(' ')} run ${attempt + 1}`);
      }
    } finally {
      rmHome(home);
      rmHome(project);
    }
  }
});

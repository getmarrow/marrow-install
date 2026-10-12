require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const installer = require('../src/installer');

// The rest of the suite pins umask 022 (support/isolated-environment.js), which hid a real bug:
// under umask 077 an upgraded Cline install was rewritten again on the next run. These tests set
// the umask themselves, for the whole scenario (layout and runs), and restore it after.
const FIXTURES = path.join(__dirname, 'fixtures', 'installer-0167');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8')).files;
const OWNER_FILES = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'owner-files.json'), 'utf8'));
const REQUIRED_UMASKS = [0o077, 0o022];
const CLINE_HOOKS = ['.clinerules/hooks/PreToolUse', '.clinerules/hooks/PostToolUse', '.clinerules/hooks/TaskCancel'];
const GROK_HOOK = '~/.grok/hooks/marrow.json';
const HERMES_CONFIG = '~/.hermes/config.yaml';
const octal = (mode) => `0${mode.toString(8)}`;

function withUmask(mask, fn) {
  const previous = process.umask(mask);
  try {
    return fn();
  } finally {
    process.umask(previous);
  }
}

function target(ws, relative) {
  return relative.startsWith('~/') ? path.join(ws.home, relative.slice(2)) : path.join(ws.root, relative);
}

function fixtureSource(relative) {
  return path.join(FIXTURES, relative.replace(/^~\//, 'HOME/').replace(/(^|\/)\.(?=[a-z])/g, '$1dot-'));
}

function fixtureText(relative) {
  return fs.readFileSync(fixtureSource(relative), 'utf8');
}

function modeOf(file) {
  return fs.lstatSync(file).mode & 0o7777;
}

// A temporary HOME (owner-only, as Grok's path check requires) and project for every case.
function workspace(prefix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(base, 0o700);
  const home = path.join(base, 'home');
  const root = path.join(base, 'project');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(root);
  return { base, home, root, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

// Every host is present: Claude Code, Codex, Cursor, Gemini, Windsurf, Cline, Grok and Hermes.
// With `upgrade` the real 0.1.67 output is laid down first (modes as 0.1.67 left them).
function layout(ws, { upgrade }) {
  for (const [relative, value] of Object.entries(OWNER_FILES)) {
    const file = target(ws, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  }
  for (const directory of ['.cursor', '.gemini', '.windsurf', '.clinerules', '.codex']) {
    fs.mkdirSync(path.join(ws.root, directory), { recursive: true });
  }
  fs.mkdirSync(path.join(ws.home, '.grok'), { recursive: true });
  fs.mkdirSync(path.join(ws.home, '.hermes'), { mode: 0o700 });
  fs.writeFileSync(path.join(ws.home, '.hermes', 'config.yaml'), 'model: x\n', { mode: 0o600 });
  if (upgrade) {
    for (const [relative, info] of Object.entries(MANIFEST)) {
      const file = target(ws, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.copyFileSync(fixtureSource(relative), file);
      fs.chmodSync(file, parseInt(info.mode, 8));
    }
    fs.chmodSync(path.join(ws.home, '.grok', 'hooks'), 0o755);
  }
  fs.chmodSync(path.join(ws.home, '.grok'), 0o755);
}

// What the owner's file held before Marrow touched it.
function ownerText(relative) {
  if (relative === HERMES_CONFIG) return 'model: x\n';
  const value = OWNER_FILES[relative];
  return typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`;
}

function install(ws) {
  const detection = installer.detectEnvironment(ws.root, { HOME: ws.home, PATH: process.env.PATH });
  const plan = installer.buildPlan(detection, { mode: 'mcp' });
  return installer.applyPlan(plan, { yes: true, dryRun: false, doctor: false });
}

// Inode, change time, mode and content of every file and folder under HOME and the project. A
// run that writes, renames or chmods anything changes this.
function snapshot(ws) {
  const out = {};
  const walk = (directory, label) => {
    for (const entry of fs.readdirSync(directory).sort()) {
      const full = path.join(directory, entry);
      const stat = fs.lstatSync(full, { bigint: true });
      const key = `${label}/${path.relative(label === 'home' ? ws.home : ws.root, full)}`;
      if (stat.isDirectory()) {
        out[key] = { dir: true, mode: stat.mode, ino: stat.ino, mtime: stat.mtimeNs, ctime: stat.ctimeNs };
        walk(full, label);
      } else {
        out[key] = {
          mode: stat.mode,
          ino: stat.ino,
          mtime: stat.mtimeNs,
          ctime: stat.ctimeNs,
          sha256: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'),
        };
      }
    }
  };
  walk(ws.home, 'home');
  walk(ws.root, 'project');
  return out;
}

function contents(ws, relatives) {
  return Object.fromEntries(relatives.map((relative) => [relative, fs.readFileSync(target(ws, relative), 'utf8')]));
}

function assertNoop(changes, label) {
  assert.deepEqual(changes.filter((change) => change.changed || change.applied).map((change) => change.label), [], `${label}: changed`);
  assert.deepEqual(changes.filter((change) => change.hook_conflict).map((change) => change.label), [], `${label}: conflict`);
}

function changeFor(changes, file) {
  const found = changes.filter((change) => change.path === file);
  assert.equal(found.length, 1, `one plan entry for ${file}`);
  return found[0];
}

function strayTemporaryFiles(ws) {
  const found = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(directory, entry.name));
      else if (/\.marrow-\d+-[0-9a-f]{12}$/.test(entry.name)) found.push(path.join(directory, entry.name));
    }
  };
  walk(ws.root);
  walk(ws.home);
  return found;
}

for (const mask of REQUIRED_UMASKS) {
  for (const upgrade of [true, false]) {
    const scenario = upgrade ? 'upgrade from the real 0.1.67 layout' : 'fresh install';
    test(`${scenario} under umask ${octal(mask)}: the second run changes and writes nothing, on every host`, () => withUmask(mask, () => {
      const ws = workspace('marrow-umask-idem-');
      try {
        layout(ws, { upgrade });
        const first = install(ws);
        assert.ok(first.some((change) => change.applied), 'the first run installs');
        assert.deepEqual(first.filter((change) => change.hook_conflict).map((change) => change.label), []);
        // Every host's file was written: a missing host would make the no-op check vacuous.
        for (const label of ['Claude Code MCP passive hooks', 'Codex native hooks', 'Cursor native hooks', 'Windsurf native hooks',
          'Gemini CLI native hooks', 'Grok native hooks', 'Cline PreToolUse native hook', 'Cline PostToolUse native hook',
          'Cline TaskCancel native hook']) {
          assert.ok(first.some((change) => change.label === label), `${label} is planned`);
        }
        assert.ok(first.some((change) => /^Hermes/.test(change.label)), 'Hermes is planned');
        for (const relative of CLINE_HOOKS) {
          assert.equal(modeOf(target(ws, relative)), 0o755, `${relative} after the first run, umask ${octal(mask)}`);
        }
        const settled = snapshot(ws);
        const second = install(ws);
        assertNoop(second, 'second run');
        assert.deepEqual(snapshot(ws), settled, 'the second run wrote, renamed or chmod-ed something');
        assertNoop(install(ws), 'third run');
        assert.deepEqual(snapshot(ws), settled, 'the third run wrote, renamed or chmod-ed something');
        assert.deepEqual(strayTemporaryFiles(ws), []);
      } finally {
        ws.cleanup();
      }
    }));

    test(`${scenario} under umask ${octal(mask)}: a dry run and a doctor run report the same and write nothing`, () => withUmask(mask, () => {
      const ws = workspace('marrow-umask-dry-');
      try {
        layout(ws, { upgrade });
        install(ws);
        const settled = snapshot(ws);
        const detection = installer.detectEnvironment(ws.root, { HOME: ws.home, PATH: process.env.PATH });
        const plan = installer.buildPlan(detection, { mode: 'mcp' });
        assertNoop(installer.applyPlan(plan, { yes: true, dryRun: true, doctor: false }), 'dry run');
        assertNoop(installer.applyPlan(plan, { yes: true, dryRun: false, doctor: true }), 'doctor');
        assert.deepEqual(snapshot(ws), settled);
      } finally {
        ws.cleanup();
      }
    }));
  }

  test(`tampered hook files are restored under umask ${octal(mask)}: content, mode, and both (0777), host by host`, () => withUmask(mask, () => {
    const ws = workspace('marrow-umask-tamper-');
    try {
      layout(ws, { upgrade: true });
      install(ws);
      const files = Object.keys(MANIFEST);
      const good = contents(ws, files);
      // Every host's hook or config file, rewritten to what 0.1.67 wrote (Marrow's own older
      // content), alone and with mode 0777.
      for (const relative of files) {
        const file = target(ws, relative);
        for (const withMode of [false, true]) {
          const label = `${relative}${withMode ? ' +0777' : ''}, umask ${octal(mask)}`;
          fs.writeFileSync(file, fixtureText(relative));
          if (withMode) fs.chmodSync(file, 0o777);
          if (withMode && relative === GROK_HOOK) {
            // Grok's own check refuses a group/world-writable hook file outright: nothing is written.
            assert.throws(() => install(ws), /Refusing Grok hook write to unsafe owner file/, label);
            assert.equal(fs.readFileSync(file, 'utf8'), fixtureText(relative), label);
            // Once the owner fixes the mode, the next run restores the content.
            fs.chmodSync(file, 0o600);
            assert.equal(changeFor(install(ws), file).changed, true, label);
            assert.equal(fs.readFileSync(file, 'utf8'), good[relative], `${label}: restored after the owner fixed the mode`);
            assertNoop(install(ws), `${label}: next run`);
            continue;
          }
          const changes = install(ws);
          const change = changeFor(changes, file);
          assert.equal(change.changed, true, label);
          assert.equal(change.applied, true, label);
          assert.equal(change.hook_conflict, false, label);
          assert.equal(fs.readFileSync(file, 'utf8'), good[relative], `${label}: content restored`);
          const mode = modeOf(file);
          if (CLINE_HOOKS.includes(relative)) assert.equal(mode, 0o755, `${label}: mode ${octal(mode)}`);
          else assert.equal(mode & 0o022, 0, `${label}: group/world-writable ${octal(mode)}`);
          assert.deepEqual(changes.filter((other) => other.changed && other.path !== file).map((other) => other.label), [], `${label}: only that file changed`);
          assertNoop(install(ws), `${label}: next run`);
        }
      }
      assert.deepEqual(contents(ws, files), good);
      assert.deepEqual(strayTemporaryFiles(ws), []);
    } finally {
      ws.cleanup();
    }
  }));

  test(`Hermes and the project MCP config are restored after a content change under umask ${octal(mask)}`, () => withUmask(mask, () => {
    const ws = workspace('marrow-umask-hermes-');
    try {
      layout(ws, { upgrade: false });
      install(ws);
      const files = [HERMES_CONFIG, '.mcp.json', '.cursor/mcp.json', '.cursor/hooks.json', '.claude/settings.json'];
      const good = contents(ws, files);
      for (const relative of files) {
        const file = target(ws, relative);
        fs.writeFileSync(file, ownerText(relative));
        fs.chmodSync(file, 0o777);
        const change = changeFor(install(ws), file);
        assert.equal(change.changed, true, relative);
        assert.equal(fs.readFileSync(file, 'utf8'), good[relative], `${relative}: restored`);
        assert.equal(modeOf(file) & 0o022, 0, `${relative}: ${octal(modeOf(file))}`);
        assertNoop(install(ws), `${relative}: next run`);
      }
    } finally {
      ws.cleanup();
    }
  }));

  test(`a Cline hook with only its mode changed is restored to exactly 0755 under umask ${octal(mask)}`, () => withUmask(mask, () => {
    const ws = workspace('marrow-umask-clinemode-');
    try {
      layout(ws, { upgrade: true });
      install(ws);
      // Group/world-writable, not executable, owner-only, read-only, extra bits. One hook takes
      // the full list; the other two a writable and a non-executable mode.
      const everyMode = [0o777, 0o775, 0o757, 0o666, 0o644, 0o700, 0o600, 0o555, 0o4755, 0o2755, 0o1755];
      for (const [index, relative] of CLINE_HOOKS.entries()) {
        const file = target(ws, relative);
        const good = fs.readFileSync(file, 'utf8');
        for (const tampered of index === 0 ? everyMode : [0o777, 0o644]) {
          fs.chmodSync(file, tampered);
          const changes = install(ws);
          const change = changeFor(changes, file);
          const label = `${relative} ${octal(tampered)}, umask ${octal(mask)}`;
          assert.equal(change.changed, true, label);
          assert.equal(change.applied, true, label);
          assert.equal(modeOf(file), 0o755, label);
          assert.equal(fs.readFileSync(file, 'utf8'), good, `${label}: content kept`);
          assertNoop(install(ws), `${label}: next run`);
        }
      }
    } finally {
      ws.cleanup();
    }
  }));

  test(`a Cline hook the owner edited is never rewritten or chmod-ed, under umask ${octal(mask)}`, () => withUmask(mask, () => {
    const ws = workspace('marrow-umask-owneredit-');
    try {
      layout(ws, { upgrade: true });
      install(ws);
      const file = target(ws, CLINE_HOOKS[0]);
      const edited = '#!/bin/sh\necho "owner policy"\nexit 0\n';
      fs.writeFileSync(file, edited);
      fs.chmodSync(file, 0o777);
      const change = changeFor(install(ws), file);
      assert.equal(change.hook_conflict, true);
      assert.equal(change.changed, false);
      assert.equal(change.applied, false);
      assert.equal(fs.readFileSync(file, 'utf8'), edited);
      assert.equal(modeOf(file), 0o777);
    } finally {
      ws.cleanup();
    }
  }));
}

// The mode a write produces must not depend on the umask of whatever process runs it (the
// controller's restore, a service, an operator's shell). Layout under 022, run under each mask.
for (const mask of [0o000, 0o002, 0o022, 0o027, 0o077]) {
  test(`the Cline hooks are exactly 0755 after an install or an upgrade run under umask ${octal(mask)}`, () => {
    for (const upgrade of [false, true]) {
      const ws = workspace('marrow-umask-explicit-');
      try {
        withUmask(0o022, () => layout(ws, { upgrade }));
        withUmask(mask, () => install(ws));
        for (const relative of CLINE_HOOKS) assert.equal(modeOf(target(ws, relative)), 0o755, `${relative} (${upgrade ? 'upgrade' : 'fresh'})`);
        assertNoop(withUmask(mask, () => install(ws)), 'second run');
        assertNoop(withUmask(0o022, () => install(ws)), 'second run under another umask');
        assertNoop(withUmask(0o077, () => install(ws)), 'second run under 077');
      } finally {
        ws.cleanup();
      }
    }
  });

  test(`no file Marrow writes keeps group or world write bits under umask ${octal(mask)}`, () => {
    const ws = workspace('marrow-umask-writebits-');
    try {
      // 0.1.67 left the hook configs at 0664 (an operator's umask 002). Marrow rewrites them.
      withUmask(0o022, () => layout(ws, { upgrade: true }));
      withUmask(mask, () => install(ws));
      for (const relative of Object.keys(MANIFEST)) {
        const mode = modeOf(target(ws, relative));
        assert.equal(mode & 0o022, 0, `${relative}: ${octal(mode)} after a run under umask ${octal(mask)}`);
      }
    } finally {
      ws.cleanup();
    }
  });
}

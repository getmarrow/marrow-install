require('./support/isolated-environment');

// R4 (owner terminal): `update --remove-user-duplicate` removes a Marrow control from the user settings, so it runs only
// when stdin and stdout are both a TTY and the owner types the confirmation word the command prints. Any other run
// refuses with exit 1 before anything is read or run. The rows drive the real CLI under a pseudo-terminal.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { PLUGIN_KEY, json, sha, treeHashes, fixture, cleanup } = require('./support/update-path-fixture');
const updatePath = () => require('../src/update-path');

const ROOT = path.join(__dirname, '..');
const CLI = path.join(ROOT, 'bin', 'marrow-install.js');
const PTY = path.join(__dirname, 'support', 'pty-run.py');
const PYTHON = String(process.env.PATH || '').split(path.delimiter).map((dir) => path.join(dir, 'python3')).find((file) => path.isAbsolute(file) && fs.existsSync(file));
const UPDATE_ARGV = [['plugin', 'marketplace', 'update', 'getmarrow'], ['plugin', 'update', PLUGIN_KEY, '-s', 'user', '-y']];
const REFUSED_TTY = /Refused: --remove-user-duplicate runs only in an owner terminal \(stdin and stdout a TTY\) with the typed confirmation word\. Nothing was changed\./;
const REFUSED_WORD = /Refused: the confirmation word was not typed\. Nothing was changed\./;
const exactCopies = (file) => {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Object.entries(value.hooks || {}).flatMap(([event, groups]) => groups.flatMap((group) => group.hooks)
    .filter((hook) => updatePath().marrowHookVersion(event, hook)));
};
// The CLI child keeps the test TMPDIR and the inherited network guard preload.
const childEnv = (fx) => ({ PATH: fx.bin, HOME: fx.home, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}), ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}) });
const underPty = (fx, mode, args = ['update', '--remove-user-duplicate']) => spawnSync(PYTHON, ['-I', PTY, mode, '--', process.execPath, CLI, ...args], { cwd: fx.project, env: childEnv(fx), encoding: 'utf8', timeout: 90000 });

function assertRefused(fx, before, child, reason) {
  assert.equal(child.status, 1, `${child.stdout}${child.stderr}`);
  assert.match(`${child.stdout}${child.stderr}`, reason);
  assert.deepEqual(fx.argv(), [], 'no claude call');
  assert.deepEqual(treeHashes(fx.root), before);
  assert.equal(exactCopies(fx.userSettings).length, 4);
  assert.equal(`${child.stdout}${child.stderr}`.includes(fx.secret), false);
}

test('T1 stdin and stdout not a TTY (an agent run): refused, exit 1, no change, no claude call', () => {
  const fx = fixture({ duplicate: true });
  try {
    const before = treeHashes(fx.root);
    const child = spawnSync(process.execPath, [CLI, 'update', '--remove-user-duplicate'], { cwd: fx.project, env: childEnv(fx), encoding: 'utf8', timeout: 60000 });
    assertRefused(fx, before, child, REFUSED_TTY);
    assert.doesNotMatch(child.stdout, /confirmation word remove-/);
  } finally { cleanup(fx); }
});

test('T2 `yes` piped as stdin (stdout piped, and stdout a TTY): refused, stdin is not a TTY, no change', { skip: PYTHON ? false : 'python3 is not on PATH' }, () => {
  const fx = fixture({ duplicate: true });
  try {
    const before = treeHashes(fx.root);
    const piped = spawnSync(process.execPath, [CLI, 'update', '--remove-user-duplicate'], { cwd: fx.project, env: childEnv(fx), input: 'y\n'.repeat(200), encoding: 'utf8', timeout: 60000 });
    assertRefused(fx, before, piped, REFUSED_TTY);
    const child = underPty(fx, 'stdin-pipe');
    assertRefused(fx, before, child, REFUSED_TTY);
  } finally { cleanup(fx); }
});

test('T3 a wrong confirmation word (case-changed, trailing space, empty, end of input, typed before the prompt): refused, no change', { skip: PYTHON ? false : 'python3 is not on PATH' }, () => {
  for (const mode of ['wrong', 'space', 'empty', 'eof', 'early']) {
    const fx = fixture({ duplicate: true });
    try {
      const before = treeHashes(fx.root);
      const child = underPty(fx, mode);
      assert.match(child.stdout, /type the confirmation word remove-[0-9a-f]{6} and press Enter/, mode);
      assertRefused(fx, before, child, REFUSED_WORD);
    } finally { cleanup(fx); }
  }
});

test('T4 a TTY on both ends and the right word: only the exact duplicate goes, other bytes equal, one Marrow hook left', { skip: PYTHON ? false : 'python3 is not on PATH' }, () => {
  const fx = fixture({ duplicate: true });
  try {
    const original = JSON.parse(fs.readFileSync(fx.userSettings, 'utf8'));
    const child = underPty(fx, 'word');
    assert.equal(child.status, 0, child.stdout);
    assert.deepEqual(fx.argv(), UPDATE_ARGV);
    assert.deepEqual(exactCopies(fx.userSettings), []);
    const after = JSON.parse(fs.readFileSync(fx.userSettings, 'utf8'));
    assert.deepEqual({ ...after, hooks: undefined }, { ...original, hooks: undefined });
    assert.deepEqual(after.hooks.PreToolUse, [original.hooks.PreToolUse[0]]);
    assert.deepEqual(after.hooks.PostToolUse, [{ ...original.hooks.PostToolUse[0], hooks: [original.hooks.PostToolUse[0].hooks[1]] }]);
    assert.match(child.stdout, /Removed the duplicate Marrow hook copy from .*settings\.json \(4 entries\); the plugin hook stays\. The user-level copy was removed as asked/);
    assert.equal(child.stdout.includes(fx.secret), false);
  } finally { cleanup(fx); }
});

test('T5 stdin a TTY with stdout piped, and stdin piped with stdout a TTY: refused, no change', { skip: PYTHON ? false : 'python3 is not on PATH' }, () => {
  for (const mode of ['stdout-pipe', 'stdin-pipe']) {
    const fx = fixture({ duplicate: true });
    try {
      const before = treeHashes(fx.root);
      const child = underPty(fx, mode);
      assertRefused(fx, before, child, REFUSED_TTY);
    } finally { cleanup(fx); }
  }
});

test('T6 a TTY and the right word on a copy that is not an exact duplicate: the removal is refused, the settings unchanged', { skip: PYTHON ? false : 'python3 is not on PATH' }, () => {
  // A look-alike Marrow entry only: the update stops before any call.
  const look = fixture({ settings: { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'npx -y --package=@getmarrow/mcp@3.9.109 marrow-mcp claude-pre-action-hook --off' }] }] } } });
  try {
    const before = treeHashes(look.root);
    const child = underPty(look, 'word');
    assert.equal(child.status, 1, child.stdout);
    assert.deepEqual(look.argv(), []);
    assert.deepEqual(treeHashes(look.root), before);
  } finally { cleanup(look); }
  // The project settings path is the user settings file (a project-scope plugin): the flag is refused.
  const same = fixture({ scope: 'project', duplicate: true });
  try {
    const value = JSON.parse(fs.readFileSync(same.userSettings, 'utf8'));
    fs.writeFileSync(same.userSettings, json({ ...value, enabledPlugins: { [PLUGIN_KEY]: true } }));
    fs.rmSync(same.scopeFile.project);
    fs.linkSync(same.userSettings, same.scopeFile.project);
    const before = sha(same.userSettings);
    const child = underPty(same, 'word');
    assert.equal(child.status, 1, child.stdout);
    assert.match(child.stdout, /Refused: --remove-user-duplicate removes the user-level hook copy only when the plugin is installed and enabled at user scope/);
    assert.deepEqual(same.argv(), []);
    assert.equal(sha(same.userSettings), before);
  } finally { cleanup(same); }
  // A copy whose PreToolUse matcher is not a pinned published matcher: kept, byte-equal.
  const loose = fixture({ duplicate: true });
  try {
    const value = JSON.parse(fs.readFileSync(loose.userSettings, 'utf8'));
    value.hooks.PreToolUse[1].matcher = '*';
    fs.writeFileSync(loose.userSettings, json(value));
    const before = sha(loose.userSettings);
    const child = underPty(loose, 'word');
    assert.equal(child.status, 0, child.stdout);
    assert.equal(sha(loose.userSettings), before);
    assert.equal(exactCopies(loose.userSettings).length, 4);
    assert.match(child.stdout, /was kept: the plugin hook could not be verified for this scope \(the PreToolUse matcher of the copy is not a published installer matcher\)/);
    assert.doesNotMatch(child.stdout, /Removed the duplicate/);
  } finally { cleanup(loose); }
});

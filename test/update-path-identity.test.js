'use strict';

// R1 (file identity): the update decides whether a hook copy is in the user settings file by realpath and (st_dev, st_ino),
// never by path text. A project or local settings path that reaches the user settings file counts as user-level: the
// copy is never removed on its own. A path whose identity cannot be read keeps every copy and stops with the reason.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { PLUGIN_KEY, json, sha, treeHashes, fixture, cleanup } = require('./support/update-path-fixture');
const updatePath = () => require('../src/update-path');

const UPDATE_ARGV = (scope) => [['plugin', 'marketplace', 'update', 'getmarrow'], ['plugin', 'update', PLUGIN_KEY, '-s', scope, '-y']];
const exactCopies = (file) => {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Object.entries(value.hooks || {}).flatMap(([event, groups]) => groups.flatMap((group) => group.hooks)
    .filter((hook) => updatePath().marrowHookVersion(event, hook)));
};

function run(fx, { home = fx.home, cwd = fx.project } = {}) {
  const lines = [];
  const previous = process.exitCode;
  const result = updatePath().runUpdatePath({ home, cwd }, { env: { PATH: fx.bin, HOME: home }, out: (line) => lines.push(line) });
  const exitCode = process.exitCode;
  process.exitCode = previous;
  return { ...result, exitCode, text: lines.join('\n') };
}

const editJson = (file, edit) => { const value = JSON.parse(fs.readFileSync(file, 'utf8')); edit(value); fs.writeFileSync(file, json(value)); };
const editRecord = (fx, edit) => editJson(path.join(fx.home, '.claude', 'plugins', 'installed_plugins.json'), (data) => edit(data.plugins[PLUGIN_KEY][0]));
// A project- or local-scope plugin whose scope settings path is the user settings file: the plugin is enabled there and
// the user file holds the hook copy an older setup wrote.
function userFileAsScope(scope) {
  const fx = fixture({ scope, duplicate: true });
  editJson(fx.userSettings, (value) => { value.enabledPlugins = { [PLUGIN_KEY]: true }; });
  return fx;
}

// The user copy is kept by file identity: the user file byte-equal, its copy still there, no removal, the reason printed.
function assertUserCopyKept(fx, result, before, paths = []) {
  assert.equal(result.exitCode, 0, result.text);
  assert.deepEqual(fx.argv(), UPDATE_ARGV(result.scope), 'the update ran, so the removal step was reached');
  assert.match(result.text, /Updated the plugin: 0\.2\.7 -> 0\.2\.8/);
  assert.equal(sha(fx.userSettings), before);
  assert.equal(exactCopies(fx.userSettings).length, 4);
  for (const file of paths) {
    assert.equal(exactCopies(file).length, 4, file);
    assert.equal(fs.statSync(file).ino, fs.statSync(fx.userSettings).ino, `${file} is still the user settings file`);
  }
  assert.doesNotMatch(result.text, /Removed the duplicate/);
  assert.match(result.text, /Kept the user-level Marrow hook copy in .*settings\.json \(4 entries\) next to the plugin/);
}

test('I1 X1 a symlinked project .claude folder whose settings file is the user settings file: the user copy is kept, 0 change', () => {
  const fx = userFileAsScope('project');
  try {
    fs.rmSync(path.join(fx.project, '.claude'), { recursive: true });
    fs.symlinkSync(path.join(fx.home, '.claude'), path.join(fx.project, '.claude'));
    const before = sha(fx.userSettings);
    const result = { ...run(fx), scope: 'project' };
    assertUserCopyKept(fx, result, before, [fx.scopeFile.project]);
    assert.match(result.text, /Marrow hook copies in settings files: UserPromptSubmit 1, PreToolUse 1, PostToolUse 1, Stop 1/);
  } finally { cleanup(fx); }
});

test('I2 X2 HOME given through a symlinked path while the project is the physical home: the user copy is kept, 0 change', () => {
  const fx = userFileAsScope('project');
  try {
    const link = path.join(fx.root, 'home-link');
    fs.symlinkSync(fx.home, link);
    editRecord(fx, (entry) => { entry.projectPath = fx.home; entry.installPath = path.join(link, '.claude', 'plugins', 'cache', 'getmarrow', 'marrow', '0.2.7'); });
    editJson(path.join(fx.home, '.claude', 'plugins', 'known_marketplaces.json'), (value) => { value.getmarrow.installLocation = path.join(link, '.claude', 'plugins', 'marketplaces', 'getmarrow'); });
    const before = sha(fx.userSettings);
    const result = { ...run(fx, { home: link, cwd: fx.home }), scope: 'project' };
    assertUserCopyKept(fx, result, before);
  } finally { cleanup(fx); }
});

test('I3 a hard link to the user settings file as the project settings file: the copy counts as user-level and is kept', () => {
  const fx = userFileAsScope('project');
  try {
    fs.rmSync(fx.scopeFile.project);
    fs.linkSync(fx.userSettings, fx.scopeFile.project);
    const before = sha(fx.userSettings);
    const result = { ...run(fx), scope: 'project' };
    assertUserCopyKept(fx, result, before, [fx.scopeFile.project]);
  } finally { cleanup(fx); }
});

test('I4 a dangling link as the project settings file: unknown state, every copy kept, 0 change, no claude call, the reason named', () => {
  const fx = fixture({ scope: 'project', duplicate: true });
  try {
    fs.rmSync(fx.scopeFile.project);
    fs.symlinkSync(path.join(fx.root, 'gone.json'), fx.scopeFile.project);
    const before = treeHashes(fx.root);
    const result = run(fx);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(fx.argv(), []);
    assert.deepEqual(treeHashes(fx.root), before);
    assert.match(result.text, /the file identity of a Claude Code settings file could not be read/);
  } finally { cleanup(fx); }
});

test('I5 a bind-like path: the local settings file has the same (st_dev, st_ino) as the user file under another realpath: kept', () => {
  const fx = userFileAsScope('local');
  try {
    fs.rmSync(fx.scopeFile.local);
    fs.linkSync(fx.userSettings, fx.scopeFile.local);
    assert.notEqual(fs.realpathSync(fx.scopeFile.local), fs.realpathSync(fx.userSettings));
    const before = sha(fx.userSettings);
    const result = { ...run(fx), scope: 'local' };
    assertUserCopyKept(fx, result, before, [fx.scopeFile.local]);
  } finally { cleanup(fx); }
});

test('I6 the identity of a settings file cannot be read (a permission error): every copy kept, 0 change, the reason named', { skip: process.getuid && process.getuid() === 0 ? 'root reads any folder' : false }, () => {
  const fx = fixture({ scope: 'project', duplicate: true });
  const folder = path.join(fx.project, '.claude');
  try {
    const before = sha(fx.userSettings);
    fs.chmodSync(folder, 0o000);
    const result = run(fx);
    fs.chmodSync(folder, 0o755);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(fx.argv(), []);
    assert.equal(sha(fx.userSettings), before);
    assert.match(result.text, /the file identity of a Claude Code settings file could not be read/);
  } finally { fs.chmodSync(folder, 0o755); cleanup(fx); }
});

test('I7 two different files with the same text: both stay separate, the user file is never touched, the project copy follows the A rules', () => {
  const fx = userFileAsScope('project');
  try {
    fs.copyFileSync(fx.userSettings, fx.scopeFile.project);
    assert.equal(sha(fx.scopeFile.project), sha(fx.userSettings));
    const before = sha(fx.userSettings);
    const files = updatePath().settingsFiles(fx.home, fx.project);
    assert.deepEqual(files.map((file) => file.file), [fx.userSettings, fx.scopeFile.project, fx.scopeFile.local]);
    const result = run(fx);
    assert.equal(result.exitCode, 0, result.text);
    assert.deepEqual(fx.argv(), UPDATE_ARGV('project'));
    assert.equal(sha(fx.userSettings), before);
    assert.equal(exactCopies(fx.userSettings).length, 4);
    assert.deepEqual(exactCopies(fx.scopeFile.project), []);
    assert.match(result.text, /Removed the duplicate Marrow hook copy from .*project.*settings\.json \(4 entries\)/);
  } finally { cleanup(fx); }
});

test('I8 settingsFiles dedups by file identity: one file reached by two path texts is one entry, the user one', () => {
  const fx = userFileAsScope('project');
  try {
    fs.rmSync(path.join(fx.project, '.claude'), { recursive: true });
    fs.symlinkSync(path.join(fx.home, '.claude'), path.join(fx.project, '.claude'));
    const files = updatePath().settingsFiles(fx.home, fx.project);
    assert.equal(files.filter((file) => file.value).length, 1);
    assert.equal(files[0].file, fx.userSettings);
    assert.equal(files.some((file) => file.file === fx.scopeFile.project), false);
    const found = updatePath().classifyInstall({ home: fx.home, project: fx.project });
    assert.equal(found.scopeFile, fx.userSettings);
    assert.equal(found.copies.length, 1);
  } finally { cleanup(fx); }
});

require('./support/isolated-environment');

// One update path (card UPDATE-PATH): `update` and `--repair` move the install kind that is there to the latest version
// and leave one hook copy. Every row uses a private fixture HOME, a fake `claude` on a private PATH that logs its argv
// (one JSON array per call) and dummy values generated at run time.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PINS = require('../src/pins');
const { PLUGIN_MATCHER, PLUGIN_KEY, marrowCommand, dummy, sha, json, writeFile, treeHashes, duplicateHooks, fixture, cleanup } = require('./support/update-path-fixture');
const OLD_PIN = '3.9.98';
const updatePath = () => require('../src/update-path');

function run(fx, { PATH = fx.bin, timeoutMs, cwd = fx.project, removeUserDuplicate } = {}) {
  const lines = [];
  const previous = process.exitCode;
  // The flag rows answer as an owner terminal would: both ends a TTY, the printed confirmation word typed back.
  const terminal = { isTTY: () => true, readLine: () => /confirmation word (\S+) and/.exec(lines[lines.length - 1])[1] };
  const result = updatePath().runUpdatePath({ home: fx.home, cwd, ...(removeUserDuplicate ? { removeUserDuplicate } : {}) }, { env: { PATH, HOME: fx.home }, out: (line) => lines.push(line), terminal, ...(timeoutMs ? { timeoutMs } : {}) });
  const exitCode = process.exitCode;
  process.exitCode = previous;
  return { ...result, exitCode, text: lines.join('\n') };
}

const UPDATE_ARGV = (scope) => [['plugin', 'marketplace', 'update', 'getmarrow'], ['plugin', 'update', PLUGIN_KEY, '-s', scope, '-y']];
const exactCopies = (file) => {
  const hooks = JSON.parse(fs.readFileSync(file, 'utf8')).hooks || {};
  return Object.entries(hooks).flatMap(([event, groups]) => groups.flatMap((group) => group.hooks.filter((hook) => updatePath().marrowHookVersion(event, hook)).map(() => event)));
};

for (const scope of ['user', 'project', 'local']) {
  test(`UP-1 plugin install (${scope} scope) at an old version: update runs the two fixed claude commands, writes no settings hook, says /reload-plugins`, () => {
    const fx = fixture({ scope });
    try {
      const before = sha(fx.userSettings);
      const scoped = sha(fx.scopeFile[scope]);
      const result = run(fx);
      assert.equal(result.done, true);
      assert.equal(result.exitCode, 0, result.text);
      assert.deepEqual(fx.argv(), UPDATE_ARGV(scope));
      assert.equal(sha(fx.userSettings), before);
      assert.equal(sha(fx.scopeFile[scope]), scoped);
      assert.match(result.text, /install kind Claude Code plugin \(marrow@getmarrow, scope /);
      assert.match(result.text, /0\.2\.7 -> 0\.2\.8/);
      assert.match(result.text, /\/reload-plugins/);
    } finally { cleanup(fx); }
  });
}

// A plugin enabled in the project's own settings file (project or local scope) with the exact setup copy in that same file.
function projectDuplicate(scope, options = {}) {
  const fx = fixture({ scope, ...options });
  const file = fx.scopeFile[scope];
  writeFile(file, json({ ...JSON.parse(fs.readFileSync(file, 'utf8')), hooks: duplicateHooks() }));
  return { fx, file };
}
const withoutCopy = (original) => ({ ...original, hooks: {
  PreToolUse: [original.hooks.PreToolUse[0]],
  PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'owner-audit.sh' }] }],
} });

test('UP-2 plugin plus a duplicate settings hook copy in the same (project) scope: only the exact Marrow entries go, other hooks and settings keep their bytes', () => {
  const { fx, file } = projectDuplicate('project');
  try {
    const original = JSON.parse(fs.readFileSync(file, 'utf8'));
    const user = sha(fx.userSettings);
    assert.equal(exactCopies(file).length, 4);
    // U1 trace: after every rename, the plugin (enabled, record present) or a settings PreToolUse copy protects the host.
    const trace = [];
    const rename = fs.renameSync;
    fs.renameSync = function traced(...args) {
      const out = rename.apply(this, args);
      const enabled = JSON.parse(fs.readFileSync(file, 'utf8')).enabledPlugins?.[PLUGIN_KEY] === true;
      trace.push(enabled || exactCopies(file).includes('PreToolUse'));
      return out;
    };
    let result;
    try { result = run(fx); } finally { fs.renameSync = rename; }
    assert.equal(result.exitCode, 0, result.text);
    assert.deepEqual(fx.argv(), UPDATE_ARGV('project'));
    assert.ok(trace.length > 0 && trace.every(Boolean), 'a protection exists at every step');
    assert.equal(fs.readFileSync(file, 'utf8'), json(withoutCopy(original)));
    assert.deepEqual(exactCopies(file), []);
    assert.equal(sha(fx.userSettings), user);
    assert.match(result.text, /Removed the duplicate Marrow hook copy .*\(4 entries\); the plugin hook stays/);
    assert.match(result.text, /Marrow hook copies in settings files: none/);
  } finally { cleanup(fx); }
});

test('UP-3 settings-hook install at an old pin: classified as settings hook, rewritten in place to the pin, one copy per event, doctor lines', async () => {
  const { install } = require('../src/installer');
  const fx = fixture({ plugin: false, duplicate: OLD_PIN });
  try {
    const options = (extra) => ({ cwd: fx.home, home: fx.home, mode: 'auto', yes: true, dryRun: false, selfTest: false, loopGuardSelfTest: false, controller: false,
      apiKey: '', baseUrl: 'https://api.getmarrow.ai', mcpLocalRuntime: false, mcpRegistryMetadata: null, identityAllowlist: { baseUrls: new Set(), agentIds: new Set() }, ...extra });
    const text = fs.readFileSync(fx.userSettings, 'utf8');
    const result = updatePath().runUpdatePath({ home: fx.home, cwd: fx.home }, { env: { PATH: fx.bin }, out: () => assert.fail('nothing printed before the rewrite') });
    assert.deepEqual({ done: result.done, before: result.before }, { done: false, before: OLD_PIN });
    await install(options({ agentId: 'upd-3', update: true, repair: true, updateOnly: true }));
    const after = fs.readFileSync(fx.userSettings, 'utf8');
    assert.equal(after.includes(OLD_PIN), false);
    const events = exactCopies(fx.userSettings);
    assert.equal(events.length, new Set(events).size, 'one copy per event');
    assert.ok(events.includes('PreToolUse'));
    const commands = JSON.stringify(JSON.parse(after).hooks);
    assert.ok(commands.includes('owner-guard.sh --strict') && commands.includes('owner-audit.sh'));
    assert.equal(JSON.parse(after).theme, 'dark');
    assert.deepEqual(JSON.parse(after).env, JSON.parse(text).env);
    const [line] = updatePath().settingsUpdateSummary(result);
    assert.match(line, new RegExp(`Install kind: settings hook\\. Version before: ${OLD_PIN.replaceAll('.', '\\.')}; after: ${PINS.MCP_ADAPTER_VERSION.replaceAll('.', '\\.')}\\. Marrow hook copies per event: .*PreToolUse 1`));
    assert.deepEqual(fx.argv(), []);
  } finally { cleanup(fx); }
});

test('UP-4 claude missing from PATH: nothing changed, the exact two commands printed', () => {
  const fx = fixture({ scope: 'project', duplicate: true });
  try {
    const empty = path.join(fx.root, 'empty-bin');
    fs.mkdirSync(empty);
    const before = treeHashes(fx.root);
    const result = run(fx, { PATH: empty });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(treeHashes(fx.root), before);
    assert.match(result.text, /\n {2}claude plugin marketplace update getmarrow\n {2}claude plugin update marrow@getmarrow -s project -y(\n|$)/);
    assert.match(result.text, /Nothing was changed/);
  } finally { cleanup(fx); }
});

for (const [label, claude] of [['exits 1', { exit: 1 }], ['hangs past the timeout', { hang: true }]]) {
  test(`UP-5 claude plugin update ${label}: nothing changed, the old plugin stays enabled, the error says so`, () => {
    const fx = fixture({ duplicate: true, claude });
    try {
      const before = treeHashes(fx.home);
      const started = Date.now();
      const result = run(fx, { timeoutMs: 1500 });
      assert.ok(Date.now() - started < 20000);
      assert.equal(result.exitCode, 1);
      assert.deepEqual(treeHashes(fx.home), before);
      assert.equal(fx.argv().length, 2);
      assert.match(result.text, /The plugin was not updated; the old plugin \(0\.2\.7\) stays enabled/);
      assert.match(result.text, claude.hang ? /did not finish in time/ : /failed \(exit 1\)/);
    } finally { cleanup(fx); }
  });
}

test('UP-6 a settings write fails midway: read-only file, and a disk error at the rename of the second file -> previous files restored byte-for-byte', () => {
  const fx = fixture({ duplicate: true, projectSettings: json({ hooks: duplicateHooks() }) });
  try {
    const user = sha(fx.userSettings);
    const projectFile = fx.scopeFile.project;
    const projectSha = sha(projectFile);
    const rename = fs.renameSync;
    let injected = 0;
    fs.renameSync = function failing(from, to, ...rest) {
      if (to === fx.userSettings) { injected += 1; const error = new Error('injected disk error'); error.code = 'EIO'; throw error; }
      return rename.call(this, from, to, ...rest);
    };
    let result;
    try { result = run(fx, { removeUserDuplicate: true }); } finally { fs.renameSync = rename; }
    assert.equal(injected, 1);
    assert.equal(result.exitCode, 1);
    assert.equal(sha(fx.userSettings), user);
    assert.equal(sha(projectFile), projectSha);
    assert.match(result.text, /the previous files were restored/);
    assert.deepEqual(fs.readdirSync(path.dirname(fx.userSettings)).filter((name) => name.includes('marrow-update')), []);
  } finally { cleanup(fx); }
  if (process.getuid && process.getuid() === 0) return;
  const ro = fixture({ duplicate: true });
  try {
    fs.chmodSync(ro.userSettings, 0o444);
    const before = sha(ro.userSettings);
    const result = run(ro, { removeUserDuplicate: true });
    assert.equal(result.exitCode, 1);
    assert.equal(sha(ro.userSettings), before);
    assert.match(result.text, /Could not remove the duplicate Marrow hook copy/);
  } finally { cleanup(ro); }
});

const UNKNOWN = [
  ['two plugin records that disagree', { records: { [PLUGIN_KEY]: [{ scope: 'user', version: '0.2.7' }, { scope: 'project', version: '0.2.5' }] } }],
  ['a settings entry that cannot be classified', { duplicate: true, settings: {}, extra: { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'npx @getmarrow/mcp hook' }] }] } } }],
  ['unparseable settings JSON', { localSettings: '{ "hooks": ' }],
  ['an unknown scope word', { records: { [PLUGIN_KEY]: [{ scope: 'user; rm -rf x', version: '0.2.7' }] } }],
  ['a project settings file naming the plugin with no record', { plugin: false, projectSettings: json({ enabledPlugins: { [PLUGIN_KEY]: true } }) }],
  ['the plugin turned off for this project', { projectSettings: json({ enabledPlugins: { [PLUGIN_KEY]: false } }) }],
];
for (const [label, options] of UNKNOWN) {
  test(`UP-7 unknown or mixed state (${label}): nothing changed, what was found and the manual steps printed`, () => {
    const fx = fixture(options);
    try {
      if (options.extra) writeFile(fx.userSettings, json({ ...JSON.parse(fs.readFileSync(fx.userSettings, 'utf8')), ...options.extra }));
      const before = treeHashes(fx.root);
      const result = run(fx);
      assert.equal(result.done, true);
      assert.equal(result.exitCode, 1);
      assert.deepEqual(fx.argv(), []);
      assert.deepEqual(treeHashes(fx.root), before);
      assert.match(result.text, /could not be classified \(.+\)\. Nothing was changed\./);
      assert.match(result.text, /claude plugin update marrow@getmarrow -s <scope> -y/);
    } finally { cleanup(fx); }
  });
}

for (const [label, options, pattern] of [
  ['the plugin reads back a lower version', { duplicate: true, claude: { next: '0.2.6' } }, /Refused: the plugin version read back \(0\.2\.6\)/],
  ['the plugin reads back a prerelease', { duplicate: true, claude: { next: '0.2.8-beta.1' } }, /Refused: the plugin version read back \(not a plain version\)/],
  ['the plugin reads back a leading v', { duplicate: true, claude: { next: 'v0.2.8' } }, /Refused: the plugin version read back \(not a plain version\)/],
  ['settings hooks pin a newer MCP than the installer', { plugin: false, duplicate: '9.9.9' }, /Marrow update refused: the installed Marrow hooks pin 9\.9\.9, newer than/],
  ['settings hooks pin a prerelease', { plugin: false, duplicate: '3.9.200-rc.1' }, /Marrow update refused: a Marrow hook pins a version that is not a plain published version/],
]) {
  test(`UP-8 downgrade or malformed target (${label}): refused, no copy removed`, () => {
    const fx = fixture(options);
    try {
      const settings = sha(fx.userSettings);
      const result = run(fx);
      assert.equal(result.done, true);
      assert.equal(result.exitCode, 1);
      assert.match(result.text, pattern);
      assert.equal(sha(fx.userSettings), settings);
    } finally { cleanup(fx); }
  });
}

test('UP-8 equal version: the plugin is already at the latest, nothing changed', () => {
  const fx = fixture({ claude: { write: false } });
  try {
    const before = treeHashes(fx.home);
    const result = run(fx);
    assert.equal(result.exitCode, 0);
    assert.match(result.text, /already at the latest version \(0\.2\.7\)/);
    assert.deepEqual(treeHashes(fx.home), before);
  } finally { cleanup(fx); }
});

test('UP-9 key files and settings env values with dummy values: never opened, never in any output, log or written file', () => {
  const printed = dummy('dummyprinted');
  const fx = fixture({ scope: 'local', duplicate: true, claude: { print: `MARROW_API_KEY=${printed} /home/x/.marrow/env` } });
  try {
    const keyValue = fs.readFileSync(path.join(fx.home, '.marrow', 'env'), 'utf8').trim().split('=')[1];
    const touched = [];
    const names = ['openSync', 'readFileSync', 'statSync', 'lstatSync', 'existsSync', 'accessSync', 'readdirSync', 'writeFileSync', 'renameSync'];
    const saved = names.map((name) => fs[name]);
    names.forEach((name, index) => { fs[name] = function spy(target, ...rest) { touched.push(String(target)); return saved[index].call(this, target, ...rest); }; });
    let result;
    try { result = run(fx); } finally { names.forEach((name, index) => { fs[name] = saved[index]; }); }
    assert.equal(result.exitCode, 0, result.text);
    assert.ok(touched.length > 0);
    // The test isolation's spawn wrapper reads its own git config files under its own folder; nothing else outside the fixture.
    const isolation = path.join(fs.realpathSync(os.tmpdir()), 'child-isolation-');
    assert.deepEqual(touched.filter((entry) => entry.includes(`${path.sep}.marrow`) || !(entry.startsWith(fx.root) || entry.startsWith(isolation))), []);
    const everything = [result.text, fs.readFileSync(fx.log, 'utf8'), ...Object.keys(treeHashes(fx.root)).filter((file) => !file.includes('.marrow')).map((file) => fs.readFileSync(path.join(fx.root, file), 'utf8'))].join('\n');
    assert.equal(result.text.includes(fx.secret), false);
    assert.equal(result.text.includes(keyValue), false);
    assert.equal(result.text.includes(printed), false);
    assert.equal(everything.includes(keyValue), false);
  } finally { cleanup(fx); }
});

test('UP-9 / INST-2 through the CLI: `update` on a plugin install opens no key file, uses the fixed argv, prints no secret', () => {
  const fx = fixture({ duplicate: true });
  try {
    const spy = path.join(fx.root, 'spy.log');
    const env = { PATH: fx.bin, HOME: fx.home, MARROW_API_KEY: dummy('dummyupdcli'), UPDATE_PATH_SPY_LOG: spy, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}), NODE_OPTIONS: `${process.env.NODE_OPTIONS ? `${process.env.NODE_OPTIONS} ` : ''}--require ${path.join(__dirname, 'support', 'fs-spy.cjs')}` };
    const child = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'marrow-install.js'), 'update'], { cwd: fx.project, env, encoding: 'utf8', timeout: 60000 });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.deepEqual(fx.argv(), UPDATE_ARGV('user'));
    const opened = fs.readFileSync(spy, 'utf8').split('\n').filter((entry) => entry.startsWith(fx.root));
    assert.deepEqual(opened.filter((entry) => entry.includes(`${path.sep}.marrow`)), []);
    for (const value of [env.MARROW_API_KEY, fx.secret]) assert.equal(`${child.stdout}${child.stderr}`.includes(value), false);
    assert.match(child.stdout, /\/reload-plugins/);
    assert.equal(exactCopies(fx.userSettings).length, 4);
    assert.match(child.stdout, /npx @getmarrow\/install@latest update --remove-user-duplicate/);
  } finally { cleanup(fx); }
});

const LOOK_ALIKES = [
  ['another path', 'npx -y --package=@getmarrow/mcp@3.9.109 /opt/evil/marrow-mcp claude-pre-action-hook'],
  ['one extra argument', `${marrowCommand('claude-pre-action-hook')} --extra`],
  ['one changed character', marrowCommand('claude-pre-action-hooK')],
  ['a trailing space', `${marrowCommand('claude-pre-action-hook')} `],
  ['case changed', marrowCommand('claude-pre-action-hook').replace('getmarrow', 'GetMarrow')],
  ['a unicode look-alike', marrowCommand('claude-pre-action-hook').replace('marrow-mcp', 'marrow‐mcp')],
  ['marrow inside a longer word', 'npx -y --package=@getmarrowx/mcpx@3.9.109 marrowmcp claude-pre-action-hook'],
  ['the same basename on another path', '/usr/local/bin/marrow-mcp claude-pre-action-hook'],
  ['a relative path', './node_modules/.bin/marrow-mcp claude-pre-action-hook'],
  ['a dot-dot path', '../marrow-mcp claude-pre-action-hook'],
  ['the entrypoint on the wrong event', marrowCommand('claude-session-hook')],
];
for (const [label, command] of LOOK_ALIKES) {
  test(`UP-10a a look-alike Marrow hook (${label}) next to a plugin is not removed and not rewritten`, () => {
    const fx = fixture({ settings: { hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command }] }] } } });
    try {
      run(fx);
      const after = JSON.parse(fs.readFileSync(fx.userSettings, 'utf8'));
      assert.deepEqual(after.hooks.PreToolUse, [{ matcher: '*', hooks: [{ type: 'command', command }] }]);
    } finally { cleanup(fx); }
  });
}

// Setup for the removal rows: the look-alike sits in its own PreToolUse group in the file that also holds the genuine setup copy.
function lookAlikeFixture(scope, command) {
  const lookAlike = { type: 'command', command };
  const lookAlikeGroup = { matcher: '*', hooks: [lookAlike] };
  const fx = scope === 'user' ? fixture({ duplicate: true }) : fixture({ scope });
  const file = fx.scopeFile[scope];
  const base = scope === 'user' ? JSON.parse(fs.readFileSync(file, 'utf8')) : { ...JSON.parse(fs.readFileSync(file, 'utf8')), hooks: duplicateHooks() };
  const original = { ...base, hooks: { ...base.hooks, PreToolUse: [...base.hooks.PreToolUse, lookAlikeGroup] } };
  writeFile(file, json(original));
  assert.equal(updatePath().marrowHookVersion('PreToolUse', lookAlike), null, 'the look-alike is not an exact Marrow hook');
  assert.equal(exactCopies(file).length, 4, 'the genuine setup copy is in the file before the run');
  return { fx, file, original, lookAlikeGroup };
}
// Every settings file and the key file by hash (the plugin record and cache change on a real update, so they are left out).
const settingsHashes = (fx) => Object.fromEntries([...Object.values(fx.scopeFile), path.join(fx.home, '.marrow', 'env')].map((file) => [file, sha(file)]));

// Look-alikes that do not name the Marrow MCP reach the removal step: the genuine copy in the same file IS removed in the same
// run (so a run that removed nothing cannot pass) and the look-alike keeps its place and its bytes.
const REACHING = [
  ['marrow inside a longer word', 'npx -y --package=@getmarrowx/mcpx@3.9.109 marrowmcp claude-pre-action-hook'],
  ['case changed throughout', marrowCommand('claude-pre-action-hook').toUpperCase()],
  ['a unicode look-alike in both names', marrowCommand('claude-pre-action-hook').replace(/marrow/g, 'marr\u043ew')],
  ['another package on another path', 'npx -y --package=@getmarrow-evil/mcp-x@3.9.109 /opt/evil/bin/tool claude-pre-action-hook'],
];
for (const scope of ['user', 'project']) {
  for (const [label, command] of REACHING) {
    test(`UP-10a ${scope} scope${scope === 'user' ? ' with --remove-user-duplicate' : ''}: a look-alike Marrow hook (${label}) is kept while the genuine copy in the same file is removed`, () => {
      const { fx, file, original, lookAlikeGroup } = lookAlikeFixture(scope, command);
      try {
        const others = settingsHashes(fx);
        delete others[file];
        const before = sha(file);
        const result = run(fx, scope === 'user' ? { removeUserDuplicate: true } : {});
        assert.equal(result.exitCode, 0, result.text);
        assert.deepEqual(fx.argv(), UPDATE_ARGV(scope), 'the update ran');
        assert.match(result.text, /Removed the duplicate Marrow hook copy from .*settings\.json \(4 entries\)/, 'the removal step ran for the genuine copy only');
        assert.notEqual(sha(file), before, 'the genuine copy was removed from the file');
        assert.equal(exactCopies(file).length, 0);
        const kept = withoutCopy(original);
        kept.hooks.PreToolUse = [original.hooks.PreToolUse[0], lookAlikeGroup];
        assert.equal(fs.readFileSync(file, 'utf8'), json(kept), 'the look-alike entry and every other hook keep their place and bytes');
        const after = settingsHashes(fx);
        delete after[file];
        assert.deepEqual(after, others, 'no other settings file changed');
      } finally { cleanup(fx); }
    });
  }
}

// Look-alikes that name the Marrow MCP stop the update before any removal (the classifier fails closed): user scope with the
// flag and project scope, nothing is called, nothing changes. A look-alike treated as Marrow would remove the genuine copy
// and the look-alike alike (plant PLI2), so these rows turn red.
for (const scope of ['user', 'project']) {
  for (const [label, command] of LOOK_ALIKES.filter(([, text]) => /marrow-mcp|@getmarrow\/mcp/.test(text))) {
    test(`UP-10a ${scope} scope${scope === 'user' ? ' with --remove-user-duplicate' : ''}: a look-alike Marrow hook (${label}) next to the genuine copy stops the update, nothing removed or rewritten`, () => {
      const { fx, original } = lookAlikeFixture(scope, command);
      try {
        const before = treeHashes(fx.root);
        const result = run(fx, scope === 'user' ? { removeUserDuplicate: true } : {});
        assert.equal(result.exitCode, 1, result.text);
        assert.deepEqual(fx.argv(), [], 'no claude call');
        assert.deepEqual(treeHashes(fx.root), before, 'no file written');
        assert.deepEqual(JSON.parse(fs.readFileSync(fx.scopeFile[scope], 'utf8')).hooks, original.hooks);
        assert.match(result.text, /Nothing was changed/);
      } finally { cleanup(fx); }
    });
  }
}

for (const [label, key] of [['another marketplace', 'marrow@evil-market'], ['a trailing space', 'marrow@getmarrow '], ['a different case', 'Marrow@getmarrow'], ['a look-alike marketplace', 'marrow@getmarrow-x']]) {
  test(`UP-10b a marrow plugin from ${label} is not updated`, () => {
    const fx = fixture({ records: { [key]: [{ scope: 'user', version: '0.2.7' }] } });
    try {
      const before = treeHashes(fx.root);
      const result = run(fx);
      assert.deepEqual(fx.argv(), []);
      assert.equal(result.done, false);
      assert.deepEqual(treeHashes(fx.root), before);
    } finally { cleanup(fx); }
  });
}

test('UP-10b with a foreign marrow plugin next to marrow@getmarrow only the fixed names reach the command line', () => {
  const fx = fixture();
  try {
    const list = path.join(fx.home, '.claude', 'plugins', 'installed_plugins.json');
    const data = JSON.parse(fs.readFileSync(list, 'utf8'));
    data.plugins['marrow@evil-market'] = [{ scope: 'project', version: '9.9.9', projectPath: fx.project }];
    fs.writeFileSync(list, json(data));
    assert.equal(run(fx).exitCode, 0);
    assert.deepEqual(fx.argv(), UPDATE_ARGV('user'));
  } finally { cleanup(fx); }
});

test('UP-11 --repair on an up-to-date settings-hook install keeps the existing path: nothing printed, no doctor line added', async () => {
  const { install } = require('../src/installer');
  const fx = fixture({ plugin: false });
  try {
    await install({ cwd: fx.home, home: fx.home, mode: 'auto', yes: true, selfTest: false, loopGuardSelfTest: false, controller: false, apiKey: '', baseUrl: 'https://api.getmarrow.ai', mcpLocalRuntime: false, mcpRegistryMetadata: null, agentId: 'upd-11', identityAllowlist: { baseUrls: new Set(), agentIds: new Set() } });
    const before = treeHashes(fx.root);
    const result = updatePath().runUpdatePath({ home: fx.home, cwd: fx.home }, { env: { PATH: fx.bin }, out: () => assert.fail('the existing path prints') });
    assert.deepEqual({ done: result.done, before: result.before }, { done: false, before: PINS.MCP_ADAPTER_VERSION });
    assert.deepEqual(updatePath().settingsUpdateSummary(result), []);
    assert.deepEqual(treeHashes(fx.root), before);
  } finally { cleanup(fx); }
});

test('LOCAL-SCOPE user and project plugin records at different versions are mixed; a settings.local.json env value never leaks', () => {
  const fx = fixture({ scope: 'local', records: undefined });
  try {
    const list = path.join(fx.home, '.claude', 'plugins', 'installed_plugins.json');
    const data = JSON.parse(fs.readFileSync(list, 'utf8'));
    data.plugins[PLUGIN_KEY].push({ scope: 'user', version: '0.2.5' });
    fs.writeFileSync(list, json(data));
    const result = run(fx);
    assert.match(result.text, /2 plugin records/);
    assert.equal(result.text.includes(fx.secret), false);
    assert.deepEqual(fx.argv(), []);
  } finally { cleanup(fx); }
});

test('INST-2 / U4 source: the claude call has shell off and fixed argv, and nothing schedules or auto-runs an update', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src', 'update-path.js'), 'utf8');
  assert.match(source, /spawnSync\(claude, argv, \{ shell: false, stdio: 'ignore', timeout: timeoutMs, cwd: project, env \}\)/);
  assert.doesNotMatch(source, /setInterval|setTimeout|execSync|execFile|shell: true/);
  assert.match(source, /^const \{ spawnSync \} = require\('node:child_process'\);$/m);
  const users = fs.readdirSync(path.join(ROOT, 'src')).filter((name) => fs.readFileSync(path.join(ROOT, 'src', name), 'utf8').includes("require('./update-path')"));
  assert.deepEqual(users, ['installer.js']);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.deepEqual(Object.keys(pkg.scripts || {}).filter((name) => /install|prepare/.test(name)), []);
});

test('UP-2 the copy the installer itself writes next to a plugin (its local runtime form) is removed; the plugin stays the one copy', async () => {
  const { install } = require('../src/installer');
  const fx = fixture();
  try {
    await install({ cwd: fx.home, home: fx.home, mode: 'auto', yes: true, selfTest: false, loopGuardSelfTest: false, controller: false, apiKey: '', baseUrl: 'https://api.getmarrow.ai', mcpLocalRuntime: false, mcpRegistryMetadata: null, agentId: 'upd-2', identityAllowlist: { baseUrls: new Set(), agentIds: new Set() } });
    const written = exactCopies(fx.userSettings);
    assert.ok(written.includes('PreToolUse') && written.length === new Set(written).size, 'the existing setup wrote one second copy');
    const result = run(fx, { removeUserDuplicate: true });
    assert.equal(result.exitCode, 0, result.text);
    assert.deepEqual(exactCopies(fx.userSettings), []);
    const after = JSON.parse(fs.readFileSync(fx.userSettings, 'utf8'));
    assert.equal(after.enabledPlugins[PLUGIN_KEY], true);
    assert.equal(after.theme, 'dark');
    assert.doesNotMatch(JSON.stringify(after.hooks || {}), /marrow-mcp/);
  } finally { cleanup(fx); }
});

const ADV_UNKNOWN = [
  ['a settings file that is a symlink to a file outside the fixture', (fx) => { const outside = path.join(fx.root, 'outside.json'); fs.renameSync(fx.userSettings, outside); fs.symlinkSync(outside, fx.userSettings); }],
  ['a settings file with a byte-order mark', (fx) => fs.writeFileSync(fx.userSettings, `\ufeff${fs.readFileSync(fx.userSettings, 'utf8')}`)],
  ['a settings file with CRLF line ends', (fx) => fs.writeFileSync(fx.userSettings, fs.readFileSync(fx.userSettings, 'utf8').replace(/\n/g, '\r\n'))],
  ['a settings file with comments', (fx) => fs.writeFileSync(fx.userSettings, `// owner note\n${fs.readFileSync(fx.userSettings, 'utf8')}`)],
  ['a settings file with duplicate keys', (fx) => fs.writeFileSync(fx.userSettings, fs.readFileSync(fx.userSettings, 'utf8').replace('"theme": "dark",', '"theme": "light",\n  "theme": "dark",'))],
  ['a settings file over 1 MB', (fx) => fs.writeFileSync(fx.userSettings, fs.readFileSync(fx.userSettings, 'utf8').replace('"theme": "dark"', `"theme": "${'x'.repeat(1024 * 1024)}"`))],
  ['an unparseable plugin list', (fx) => fs.writeFileSync(path.join(fx.home, '.claude', 'plugins', 'installed_plugins.json'), '{ "plugins": ')],
  ['two Marrow plugin records for one scope', (fx) => { const list = path.join(fx.home, '.claude', 'plugins', 'installed_plugins.json'); const data = JSON.parse(fs.readFileSync(list, 'utf8')); data.plugins[PLUGIN_KEY].push({ ...data.plugins[PLUGIN_KEY][0] }); fs.writeFileSync(list, json(data)); }],
  ['a project plugin record for another folder', (fx) => { const list = path.join(fx.home, '.claude', 'plugins', 'installed_plugins.json'); const data = JSON.parse(fs.readFileSync(list, 'utf8')); data.plugins[PLUGIN_KEY][0] = { ...data.plugins[PLUGIN_KEY][0], scope: 'project', projectPath: path.join(fx.root, 'elsewhere') }; fs.writeFileSync(list, json(data)); }],
  ['a record version with whitespace', (fx) => { const list = path.join(fx.home, '.claude', 'plugins', 'installed_plugins.json'); const data = JSON.parse(fs.readFileSync(list, 'utf8')); data.plugins[PLUGIN_KEY][0].version = ' 0.2.7'; fs.writeFileSync(list, json(data)); }],
  ['a record version with shell characters', (fx) => { const list = path.join(fx.home, '.claude', 'plugins', 'installed_plugins.json'); const data = JSON.parse(fs.readFileSync(list, 'utf8')); data.plugins[PLUGIN_KEY][0].version = '0.2.7;id'; fs.writeFileSync(list, json(data)); }],
  ['enabledPlugins false in the user settings', (fx) => { const data = JSON.parse(fs.readFileSync(fx.userSettings, 'utf8')); data.enabledPlugins[PLUGIN_KEY] = false; fs.writeFileSync(fx.userSettings, json(data)); }],
  ['two Marrow entries for one event in a non-canonical layout', (fx) => { const data = JSON.parse(fs.readFileSync(fx.userSettings, 'utf8')); data.hooks.PreToolUse.push({ matcher: '*', hooks: [{ type: 'command', command: 'npx @getmarrow/mcp pre-action-hook' }] }); fs.writeFileSync(fx.userSettings, json(data)); }],
];
for (const [label, mutate] of ADV_UNKNOWN) {
  test(`ADV ${label}: unknown state, nothing changed, no claude call`, () => {
    const fx = fixture({ duplicate: true });
    try {
      mutate(fx);
      const before = treeHashes(fx.root);
      const result = run(fx);
      assert.equal(result.done, true);
      assert.equal(result.exitCode, 1, result.text);
      assert.deepEqual(fx.argv(), []);
      assert.deepEqual(treeHashes(fx.root), before);
      assert.match(result.text, /Nothing was changed/);
    } finally { cleanup(fx); }
  });
}

test('ADV PATH: a relative PATH entry is never searched; the first absolute claude on PATH is the one run', () => {
  const fx = fixture();
  try {
    const planted = path.join(fx.project, 'claude');
    writeFile(planted, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(path.join(fx.root, 'planted-ran'))}, 'x');\n`, 0o755);
    const result = run(fx, { PATH: `.${path.delimiter}${fx.bin}` });
    assert.equal(result.exitCode, 0, result.text);
    assert.equal(fs.existsSync(path.join(fx.root, 'planted-ran')), false);
    assert.deepEqual(fx.argv(), [['plugin', 'marketplace', 'update', 'getmarrow'], ['plugin', 'update', PLUGIN_KEY, '-s', 'user', '-y']]);
  } finally { cleanup(fx); }
});

test('ADV claude prints success but leaves the old version: no update claimed, the duplicate kept only when the plugin is unverified', () => {
  const fx = fixture({ duplicate: true, claude: { write: false, print: 'Updated marrow@getmarrow to 0.2.8' } });
  try {
    const result = run(fx);
    assert.equal(result.exitCode, 0, result.text);
    assert.match(result.text, /already at the latest version \(0\.2\.7\)/);
    assert.doesNotMatch(result.text, /Updated marrow@getmarrow/);
  } finally { cleanup(fx); }
});

test('ADV an interrupted run (a temp file left next to the settings file) fails closed, and a second clean run finishes with one copy', () => {
  const fx = fixture({ duplicate: true });
  try {
    const leftover = `${fx.userSettings}.marrow-update-${process.pid}.tmp`;
    writeFile(leftover, 'partial');
    const before = sha(fx.userSettings);
    const first = run(fx, { removeUserDuplicate: true });
    assert.equal(first.exitCode, 1);
    assert.equal(sha(fx.userSettings), before);
    fs.rmSync(leftover);
    const second = run(fx, { removeUserDuplicate: true });
    assert.equal(second.exitCode, 0, second.text);
    assert.deepEqual(exactCopies(fx.userSettings), []);
    const third = run(fx, { removeUserDuplicate: true });
    assert.equal(third.exitCode, 0, third.text);
    assert.match(third.text, /Marrow hook copies in settings files: none/);
  } finally { cleanup(fx); }
});

// R1 (fail closed): a user-level hook copy is never removed on its own; only `update --remove-user-duplicate` with the plugin
// installed and enabled at user scope removes it; a copy is removed automatically only in the scope of the enabled plugin.
test('UP-15 user-level duplicate next to a user-scope plugin, no flag: kept, the one line and the explicit command printed, 2 copies reported', () => {
  const fx = fixture({ duplicate: true });
  try {
    const before = sha(fx.userSettings);
    const result = run(fx);
    assert.equal(result.exitCode, 0, result.text);
    assert.deepEqual(fx.argv(), UPDATE_ARGV('user'));
    assert.equal(sha(fx.userSettings), before);
    assert.equal(exactCopies(fx.userSettings).length, 4);
    assert.match(result.text, /Kept the user-level Marrow hook copy in .*settings\.json \(4 entries\)/);
    assert.match(result.text, /run: npx @getmarrow\/install@latest update --remove-user-duplicate$/m);
    assert.match(result.text, /Marrow hook copies per event, the plugin included: .*PreToolUse 2/);
    assert.doesNotMatch(result.text, /Removed/);
  } finally { cleanup(fx); }
});

test('UP-16 the same with update --remove-user-duplicate: the exact Marrow entries go, other bytes equal, the consequence named, 1 copy', () => {
  const fx = fixture({ duplicate: true });
  try {
    const original = JSON.parse(fs.readFileSync(fx.userSettings, 'utf8'));
    const result = run(fx, { removeUserDuplicate: true });
    assert.equal(result.exitCode, 0, result.text);
    assert.deepEqual(fx.argv(), UPDATE_ARGV('user'));
    assert.equal(fs.readFileSync(fx.userSettings, 'utf8'), json(withoutCopy(original)));
    assert.match(result.text, /Removed the duplicate Marrow hook copy from .*settings\.json \(4 entries\); the plugin hook stays\. The user-level copy was removed as asked/);
    assert.match(result.text, /a project that turned the plugin off now has no Marrow hook/);
    assert.match(result.text, /Marrow hook copies in settings files: none/);
    // CONS-2 emulation: the enabled plugin is the one counted copy, no exact Marrow settings copy is left next to it.
    const { detectAgentPlugins } = require('../src/agent-plugins');
    assert.equal(detectAgentPlugins({ home: fx.home, project: fx.project }).filter((plugin) => plugin.counted).length, 1);
  } finally { cleanup(fx); }
});

const RECORD = (fx, edit) => { const list = path.join(fx.home, '.claude', 'plugins', 'installed_plugins.json'); const data = JSON.parse(fs.readFileSync(list, 'utf8')); edit(data.plugins[PLUGIN_KEY]); fs.writeFileSync(list, json(data)); };
const UP17 = [
  ['a project-scope plugin only', { scope: 'project', duplicate: true }, () => {}],
  ['a local-scope plugin only', { scope: 'local', duplicate: true }, () => {}],
  ['a user-scope plugin turned off in the user settings', { duplicate: true }, (fx) => { const data = JSON.parse(fs.readFileSync(fx.userSettings, 'utf8')); data.enabledPlugins[PLUGIN_KEY] = false; fs.writeFileSync(fx.userSettings, json(data)); }],
  ['a record scope that disagrees with the settings', { duplicate: true }, (fx) => RECORD(fx, (entries) => { entries[0].scope = 'project'; entries[0].projectPath = fx.project; })],
  ['an unknown scope', { duplicate: true }, (fx) => RECORD(fx, (entries) => { entries[0].scope = 'global'; })],
  ['the project turning the plugin off', { duplicate: true, projectSettings: json({ enabledPlugins: { [PLUGIN_KEY]: false } }) }, () => {}],
  ['no plugin at all (settings-hook install)', { plugin: false, duplicate: true }, () => {}],
];
for (const [label, options, mutate] of UP17) {
  test(`UP-17 user-level duplicate with ${label}, flag given: refused, 0 change, no claude call`, () => {
    const fx = fixture(options);
    try {
      mutate(fx);
      const before = treeHashes(fx.root);
      const result = run(fx, { removeUserDuplicate: true });
      assert.equal(result.done, true);
      assert.equal(result.exitCode, 1, result.text);
      assert.deepEqual(fx.argv(), []);
      assert.deepEqual(treeHashes(fx.root), before);
      assert.match(result.text, /--remove-user-duplicate/);
      assert.match(result.text, /Nothing was changed/);
    } finally { cleanup(fx); }
  });
}

for (const scope of ['project', 'local']) {
  test(`UP-18 ${scope}-level duplicate in the file that enables the plugin: removed automatically, the user settings untouched`, () => {
    const { fx, file } = projectDuplicate(scope);
    try {
      const original = JSON.parse(fs.readFileSync(file, 'utf8'));
      const user = sha(fx.userSettings);
      const result = run(fx);
      assert.equal(result.exitCode, 0, result.text);
      assert.deepEqual(fx.argv(), UPDATE_ARGV(scope));
      assert.equal(fs.readFileSync(file, 'utf8'), json(withoutCopy(original)));
      assert.equal(sha(fx.userSettings), user);
      assert.match(result.text, /Marrow hook copies in settings files: none/);
    } finally { cleanup(fx); }
  });
}

for (const [label, options, fileOf] of [
  ['a project that does not enable the user-scope plugin', { projectSettings: json({ hooks: duplicateHooks() }) }, (fx) => fx.scopeFile.project],
  ['the local file next to a project-scope plugin', { scope: 'project', localSettings: json({ hooks: duplicateHooks() }) }, (fx) => fx.scopeFile.local],
]) {
  test(`UP-18 a duplicate in ${label}: kept, line printed`, () => {
    const fx = fixture(options);
    try {
      const file = fileOf(fx);
      const before = sha(file);
      const result = run(fx);
      assert.equal(result.exitCode, 0, result.text);
      assert.equal(sha(file), before);
      assert.match(result.text, /Kept the Marrow hook copy in .*settings(\.local)?\.json: it is not in the scope where the plugin is enabled/);
    } finally { cleanup(fx); }
  });
}

test('UP-19 / R2 an install kind that cannot be classified prints the fixed Cursor plugin steps and changes nothing', () => {
  const fx = fixture({ plugin: false, projectSettings: json({ enabledPlugins: { [PLUGIN_KEY]: true } }) });
  try {
    const before = treeHashes(fx.root);
    const result = run(fx);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(treeHashes(fx.root), before);
    assert.match(result.text, /For the Marrow Cursor plugin: in Cursor, update Marrow from the plugin source you added it from, then restart Cursor\. This command never changes a Cursor plugin\./);
  } finally { cleanup(fx); }
});

test('R1-f the flag has one exact form and only with update: --repair, odd forms, repeats, other operations and env values remove nothing', () => {
  const { parseArgs } = require('../src/installer');
  assert.equal(parseArgs(['update', '--remove-user-duplicate'], {}).removeUserDuplicate, true);
  assert.equal(parseArgs(['--remove-user-duplicate', 'update'], {}).removeUserDuplicate, true);
  for (const argv of [['--repair', '--remove-user-duplicate'], ['update', '--repair', '--remove-user-duplicate'], ['repair', '--remove-user-duplicate'], ['--remove-user-duplicate'],
    ['update', '--remove-user-duplicate', '--remove-user-duplicate'], ['update', '--remove-user-duplicate=true'], ['update', '--remove-user-duplicate '], ['update', '--', '--remove-user-duplicate'],
    ['update', '--remove-user-duplicate', '--dry-run'], ['update', '--remove-user-duplicate', 'doctor'], ['activate', '--remove-user-duplicate'], ['update', '--Remove-User-Duplicate'], ['update', '--remove-user-duplicates']]) {
    assert.throws(() => parseArgs(argv, {}), /remove-user-duplicate|Unknown argument|--dry-run|uninstall/i, argv.join(' '));
  }
  for (const env of [{ MARROW_REMOVE_USER_DUPLICATE: '1' }, { npm_config_remove_user_duplicate: 'true' }]) assert.equal(parseArgs(['update'], env).removeUserDuplicate, undefined);
});

test('R1-f through the CLI: `update --repair --remove-user-duplicate` is refused before anything runs; `update --remove-user-duplicate` removes the user-level copy', () => {
  const fx = fixture({ duplicate: true });
  try {
    const env = { PATH: fx.bin, HOME: fx.home, MARROW_REMOVE_USER_DUPLICATE: '1', ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}), ...(process.env.NODE_OPTIONS ? { NODE_OPTIONS: process.env.NODE_OPTIONS } : {}) };
    const before = treeHashes(fx.root);
    const refused = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'marrow-install.js'), 'update', '--repair', '--remove-user-duplicate'], { cwd: fx.project, env, encoding: 'utf8', timeout: 60000 });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /--remove-user-duplicate is only valid once, with update/);
    assert.deepEqual(fx.argv(), []);
    assert.deepEqual(treeHashes(fx.root), before);
    // The owner answers the confirmation word in a terminal (R4).
    const python = String(process.env.PATH || '').split(path.delimiter).map((dir) => path.join(dir, 'python3')).find((file) => path.isAbsolute(file) && fs.existsSync(file));
    const child = spawnSync(python, ['-I', path.join(__dirname, 'support', 'pty-run.py'), 'word', '--', process.execPath, path.join(ROOT, 'bin', 'marrow-install.js'), 'update', '--remove-user-duplicate'], { cwd: fx.project, env, encoding: 'utf8', timeout: 90000 });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.deepEqual(fx.argv(), UPDATE_ARGV('user'));
    assert.deepEqual(exactCopies(fx.userSettings), []);
    assert.equal(`${child.stdout}${child.stderr}`.includes(fx.secret), false);
  } finally { cleanup(fx); }
});

// R1 (removal guard): the same-scope copy goes only after the plugin hook is verified immediately before the write.
const PRE = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/marrow-launch.cjs" claude-pre-action-hook';
const pluginFolder = (fx, version = '0.2.7', market = 'getmarrow') => path.join(fx.home, '.claude', 'plugins', 'cache', market, 'marrow', version);
const hooksText = (pre) => json({ hooks: { PreToolUse: pre, PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/marrow-launch.cjs" claude-hook' }] }] } });
const setHooks = (text) => (fx) => fs.writeFileSync(path.join(pluginFolder(fx), 'hooks', 'hooks.json'), text);
const preWith = (command, matcher = PLUGIN_MATCHER) => hooksText([{ matcher, hooks: [{ type: 'command', command }] }]);
const KEEP = [
  ['A1', 'PreToolUse []', setHooks(hooksText([]))],
  ['A2', 'a non-Marrow command', setHooks(preWith('true'))],
  ['A3', 'the Marrow command with a word after it', setHooks(preWith(`${PRE} --off`))],
  ['A3', 'the Marrow command with a prefix', setHooks(preWith(`x${PRE}`))],
  ['A3', 'the Marrow command with a trailing space', setHooks(preWith(`${PRE} `))],
  ['A3', 'the Marrow command with a trailing newline', setHooks(preWith(`${PRE}\n`))],
  ['A3', 'a case-changed Marrow command', setHooks(preWith(PRE.replace('marrow-launch', 'Marrow-launch')))],
  ['A4', 'the Marrow command chained with &&', setHooks(preWith(`true && ${PRE}`))],
  ['A4', 'the Marrow command chained with ;', setHooks(preWith(`${PRE}; exit 0`))],
  ['A4', 'the Marrow command chained with |', setHooks(preWith(`${PRE} | cat`))],
  ['A4', 'the Marrow command chained with ||', setHooks(preWith(`false || ${PRE}`))],
  ['A4', 'the Marrow command in a subshell', setHooks(preWith(`(${PRE})`))],
  ['A4', 'the Marrow command wrapped in bash -c', setHooks(preWith(`bash -c '${PRE}'`))],
  ['A5', 'a matcher narrower than the copy', setHooks(preWith(PRE, 'Bash'))],
  ['A5', 'a matcher that is not a string', setHooks(hooksText([{ matcher: ['*'], hooks: [{ type: 'command', command: PRE }] }]))],
  ['A6', 'the hooks file missing', (fx) => fs.rmSync(path.join(pluginFolder(fx), 'hooks', 'hooks.json'))],
  ['A6', 'the hooks file a symlink', (fx) => { const file = path.join(pluginFolder(fx), 'hooks', 'hooks.json'); fs.renameSync(file, path.join(fx.root, 'real-hooks.json')); fs.symlinkSync(path.join(fx.root, 'real-hooks.json'), file); }],
  ['A6', 'the hooks folder a symlink', (fx) => { const dir = path.join(pluginFolder(fx), 'hooks'); fs.renameSync(dir, path.join(fx.root, 'real-hooks')); fs.symlinkSync(path.join(fx.root, 'real-hooks'), dir); }],
  ['A6', 'the hooks file malformed JSON', setHooks('{ "hooks": { "PreToolUse": [')],
  ['A7', 'duplicate PreToolUse keys', setHooks(`{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"true"}]}],"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":${JSON.stringify(PRE)}}]}]}}\n`)],
  ['A7', 'duplicate command keys in the entry', setHooks(`{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"true","command":${JSON.stringify(PRE)}}]}]}}\n`)],
  ['A8', 'the launcher file missing', (fx) => fs.rmSync(path.join(pluginFolder(fx), 'scripts', 'marrow-launch.cjs'))],
  ['A8', 'the launcher a symlink', (fx) => { const file = path.join(pluginFolder(fx), 'scripts', 'marrow-launch.cjs'); fs.renameSync(file, path.join(fx.root, 'launch.cjs')); fs.symlinkSync(path.join(fx.root, 'launch.cjs'), file); }],
  ['A9', 'the plugin turned off during the update', null, { disableIn: true }],
  ['A10', 'a record whose folder is under a look-alike marketplace getmarrow-x', (fx) => {
    fs.mkdirSync(path.dirname(pluginFolder(fx, '0.2.7', 'getmarrow-x')), { recursive: true });
    fs.renameSync(pluginFolder(fx), pluginFolder(fx, '0.2.7', 'getmarrow-x'));
    RECORD(fx, (entries) => { entries[0].installPath = pluginFolder(fx, '0.2.7', 'getmarrow-x'); });
  }],
];
for (const [id, label, edit, extra = {}] of KEEP) {
  test(`${id} R1 a project-scope hook copy next to a plugin hook with ${label}: the copy is kept, the settings file byte-equal, the reason printed`, () => {
    const { fx, file } = projectDuplicate('project');
    try {
      if (edit) edit(fx);
      if (extra.disableIn) {
        const config = JSON.parse(fs.readFileSync(path.join(fx.bin, 'fake.json'), 'utf8'));
        fs.writeFileSync(path.join(fx.bin, 'fake.json'), json({ ...config, disableIn: file }));
      }
      const before = sha(file);
      const user = sha(fx.userSettings);
      const result = run(fx);
      assert.deepEqual(fx.argv(), UPDATE_ARGV('project'), 'the update ran, so the removal step was reached');
      assert.equal(result.exitCode, 0, result.text);
      assert.match(result.text, /Updated the plugin: 0\.2\.7 -> 0\.2\.8/);
      if (extra.disableIn) assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).enabledPlugins[PLUGIN_KEY], false);
      else assert.equal(sha(file), before);
      assert.equal(exactCopies(file).length, 4);
      assert.equal(sha(fx.userSettings), user);
      assert.match(result.text, /A Marrow hook copy in a settings file was kept: the plugin hook could not be verified for this scope \(.+\)/);
      assert.doesNotMatch(result.text, /Removed the duplicate/);
    } finally {
      if (fs.existsSync(path.join(fx.root, 'real-hooks'))) fs.chmodSync(path.join(fx.root, 'real-hooks'), 0o755);
      cleanup(fx);
    }
  });
}

test('A9 R1 the plugin installed but disabled in its scope: unknown state, the copy kept, 0 change, no claude call', () => {
  const { fx, file } = projectDuplicate('project');
  try {
    writeFile(file, json({ ...JSON.parse(fs.readFileSync(file, 'utf8')), enabledPlugins: { [PLUGIN_KEY]: false } }));
    const before = treeHashes(fx.root);
    const result = run(fx);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(fx.argv(), []);
    assert.deepEqual(treeHashes(fx.root), before);
    assert.match(result.text, /the plugin is not enabled/);
  } finally { cleanup(fx); }
});

test('A10 R1 only a marrow@getmarrow-x record and a copy: not a plugin install, no claude call, the update path changes nothing', () => {
  const fx = fixture({ records: { 'marrow@getmarrow-x': [{ scope: 'user', version: '0.2.7' }] }, duplicate: true });
  try {
    const before = treeHashes(fx.root);
    const result = run(fx);
    assert.equal(result.done, false);
    assert.deepEqual(fx.argv(), []);
    assert.deepEqual(treeHashes(fx.root), before);
  } finally { cleanup(fx); }
});

for (const scope of ['project', 'local']) {
  test(`A11 R1 a verified plugin hook (${scope} scope): the copy is removed and one Marrow pre-action hook is left, the plugin's`, () => {
    const { fx, file } = projectDuplicate(scope);
    try {
      const original = JSON.parse(fs.readFileSync(file, 'utf8'));
      const result = run(fx);
      assert.equal(result.exitCode, 0, result.text);
      assert.deepEqual(fx.argv(), UPDATE_ARGV(scope));
      assert.equal(fs.readFileSync(file, 'utf8'), json(withoutCopy(original)));
      assert.deepEqual(exactCopies(file), []);
      assert.deepEqual(exactCopies(fx.userSettings), []);
      const plugin = JSON.parse(fs.readFileSync(path.join(pluginFolder(fx, '0.2.8'), 'hooks', 'hooks.json'), 'utf8'));
      assert.equal(plugin.hooks.PreToolUse.flatMap((group) => group.hooks).filter((hook) => hook.command === PRE).length, 1);
      assert.match(result.text, /Removed the duplicate Marrow hook copy .*\(4 entries\); the plugin hook stays/);
    } finally { cleanup(fx); }
  });
}

test('A11 R1 user scope with --remove-user-duplicate and a verified plugin hook: the user copy is removed; with a narrower plugin matcher (A5) it is kept', () => {
  for (const broken of [false, true]) {
    const fx = fixture({ duplicate: true });
    try {
      if (broken) setHooks(preWith(PRE, 'Bash'))(fx);
      const before = sha(fx.userSettings);
      const result = run(fx, { removeUserDuplicate: true });
      assert.equal(result.exitCode, 0, result.text);
      assert.deepEqual(fx.argv(), UPDATE_ARGV('user'));
      if (broken) { assert.equal(sha(fx.userSettings), before); assert.match(result.text, /could not be verified for this scope/); }
      else assert.deepEqual(exactCopies(fx.userSettings), []);
    } finally { cleanup(fx); }
  }
});

// R2 (offered version): read from Claude Code's local getmarrow marketplace copy before any claude command.
const updateCalls = (fx) => fx.argv().filter((argv) => argv[1] === 'update').length;
const REFUSE = [
  ['D1', 'an offered version lower than the installed one', { offered: '0.2.6' }, /offers 0\.2\.6, lower than the installed 0\.2\.7; an update never downgrades/],
  ['D3', 'a malformed offered version (two parts)', { offered: '0.2' }, /not a plain X\.Y\.Z version/],
  ['D3', 'a malformed offered version (1e3)', { offered: '1e3' }, /not a plain X\.Y\.Z version/],
  ['D3', 'a malformed offered version (leading v)', { offered: 'v0.2.8' }, /not a plain X\.Y\.Z version/],
  ['D3', 'an offered version that is a number', { offered: 0.28 }, /could not be read/],
  ['D4', 'a prerelease offered version', { offered: '0.2.8-beta.1' }, /not a plain X\.Y\.Z version/],
  ['D5', 'an offered version with build metadata', { offered: '0.2.8+build.1' }, /not a plain X\.Y\.Z version/],
  ['D6', 'an offered version with leading zeros', { offered: '0.02.8' }, /not a plain X\.Y\.Z version/],
  ['D6', 'an offered version with a leading zero major', { offered: '00.2.8' }, /not a plain X\.Y\.Z version/],
  ['D7', 'no local marketplace copy', { offered: null }, /could not be read \(the getmarrow marketplace is not listed at its own folder\)/],
  ['D7', 'a malformed marketplace.json', { edit: (fx) => fs.writeFileSync(path.join(fx.home, '.claude', 'plugins', 'marketplaces', 'getmarrow', '.claude-plugin', 'marketplace.json'), '{"name":') }, /could not be read/],
  ['D7', 'a symlinked offered plugin.json', { edit: (fx) => { const file = path.join(fx.home, '.claude', 'plugins', 'marketplaces', 'getmarrow', 'plugins', 'marrow', '.claude-plugin', 'plugin.json'); fs.renameSync(file, path.join(fx.root, 'p.json')); fs.symlinkSync(path.join(fx.root, 'p.json'), file); } }, /could not be read/],
  ['D7', 'duplicate version keys in the offered plugin.json', { edit: (fx) => fs.writeFileSync(path.join(fx.home, '.claude', 'plugins', 'marketplaces', 'getmarrow', 'plugins', 'marrow', '.claude-plugin', 'plugin.json'), '{"name":"marrow","version":"0.2.6","version":"0.2.8"}\n') }, /could not be read/],
  ['D7', 'a marketplace source that leaves the marketplace folder', { edit: (fx) => { const file = path.join(fx.home, '.claude', 'plugins', 'marketplaces', 'getmarrow', '.claude-plugin', 'marketplace.json'); const data = JSON.parse(fs.readFileSync(file, 'utf8')); data.plugins[0].source = './../getmarrow-x/plugins/marrow'; fs.writeFileSync(file, json(data)); } }, /no local source folder/],
  ['D8', 'only a look-alike marketplace getmarrow-x offering a higher version', { edit: (fx) => { const plugins = path.join(fx.home, '.claude', 'plugins'); fs.renameSync(path.join(plugins, 'marketplaces', 'getmarrow'), path.join(plugins, 'marketplaces', 'getmarrow-x')); fs.writeFileSync(path.join(plugins, 'known_marketplaces.json'), json({ 'getmarrow-x': { installLocation: path.join(plugins, 'marketplaces', 'getmarrow-x') } })); } }, /not listed at its own folder/],
  ['D8', 'the getmarrow entry pointing at the getmarrow-x folder', { edit: (fx) => { const plugins = path.join(fx.home, '.claude', 'plugins'); fs.renameSync(path.join(plugins, 'marketplaces', 'getmarrow'), path.join(plugins, 'marketplaces', 'getmarrow-x')); fs.writeFileSync(path.join(plugins, 'known_marketplaces.json'), json({ getmarrow: { installLocation: path.join(plugins, 'marketplaces', 'getmarrow-x') } })); } }, /not listed at its own folder/],
  ['D8', 'a marketplace.json named getmarrow-x', { edit: (fx) => { const file = path.join(fx.home, '.claude', 'plugins', 'marketplaces', 'getmarrow', '.claude-plugin', 'marketplace.json'); fs.writeFileSync(file, json({ ...JSON.parse(fs.readFileSync(file, 'utf8')), name: 'getmarrow-x' })); } }, /does not list marrow exactly once/],
];
for (const [id, label, options, pattern] of REFUSE) {
  test(`${id} R2 ${label}: refused before any claude command, exit 1, 0 change, 0 claude calls`, () => {
    const { fx, file } = projectDuplicate('project', { offered: options.offered === undefined ? '0.2.8' : options.offered, claude: { next: typeof options.offered === 'string' ? options.offered : '0.2.8' } });
    try {
      if (options.edit) options.edit(fx);
      const before = treeHashes(fx.root);
      const result = run(fx);
      assert.equal(result.exitCode, 1, result.text);
      assert.equal(fx.argv().length, 0);
      assert.deepEqual(treeHashes(fx.root), before);
      assert.equal(exactCopies(file).length, 4);
      assert.match(result.text, pattern);
      assert.match(result.text, /claude plugin update was not run/);
    } finally { cleanup(fx); }
  });
}

test('D2 R2 the offered version equals the installed one: no claude plugin update, "already current", 0 change', () => {
  const fx = fixture({ duplicate: true, offered: '0.2.7', claude: { next: '0.2.7' } });
  try {
    const before = treeHashes(fx.root);
    const result = run(fx);
    assert.equal(result.exitCode, 0, result.text);
    assert.deepEqual(fx.argv(), [UPDATE_ARGV('user')[0]]);
    assert.equal(updateCalls(fx), 0);
    assert.deepEqual(treeHashes(fx.root), before);
    assert.match(result.text, /already current/);
  } finally { cleanup(fx); }
});

test('D2 R2 already current with a project-scope copy next to a verified plugin hook: no claude plugin update, the copy goes under the R1 guard', () => {
  const { fx, file } = projectDuplicate('project', { offered: '0.2.7' });
  try {
    const result = run(fx);
    assert.equal(result.exitCode, 0, result.text);
    assert.equal(updateCalls(fx), 0);
    assert.match(result.text, /already current/);
    assert.deepEqual(exactCopies(file), []);
  } finally { cleanup(fx); }
});

test('D9 R2 a race: the marketplace refresh lowers the offered version: refused before claude plugin update, the copy kept', () => {
  const { fx, file } = projectDuplicate('project', { claude: { offerAfter: '0.2.6', next: '0.2.6' } });
  try {
    const before = sha(file);
    const record = sha(path.join(fx.home, '.claude', 'plugins', 'installed_plugins.json'));
    const result = run(fx);
    assert.equal(result.exitCode, 1, result.text);
    assert.deepEqual(fx.argv(), [UPDATE_ARGV('project')[0]]);
    assert.equal(updateCalls(fx), 0);
    assert.equal(sha(file), before);
    assert.equal(sha(path.join(fx.home, '.claude', 'plugins', 'installed_plugins.json')), record);
    assert.match(result.text, /offers 0\.2\.6, lower than the installed 0\.2\.7/);
  } finally { cleanup(fx); }
});

test('D9 R2 a race: the plugin record reads back lower after the update call: exit 1, the restore step named, no success claimed, the copy kept', () => {
  const { fx, file } = projectDuplicate('project', { claude: { next: '0.2.6' } });
  try {
    const before = sha(file);
    const result = run(fx);
    assert.equal(result.exitCode, 1, result.text);
    assert.equal(updateCalls(fx), 1);
    assert.equal(sha(file), before);
    assert.match(result.text, /Refused: the plugin version read back \(0\.2\.6\) is not 0\.2\.7 or newer/);
    assert.match(result.text, /To restore 0\.2\.7 or newer, run once the getmarrow marketplace offers it:\n {2}claude plugin marketplace update getmarrow\n {2}claude plugin update marrow@getmarrow -s project -y/);
    assert.doesNotMatch(result.text, /Updated the plugin/);
  } finally { cleanup(fx); }
});

test('D10 R2 a higher plain offered version: exactly one claude plugin update call with the fixed argv, the record raised', () => {
  const fx = fixture({ scope: 'project', offered: '0.2.10', claude: { next: '0.2.10' } });
  try {
    const result = run(fx);
    assert.equal(result.exitCode, 0, result.text);
    assert.deepEqual(fx.argv(), UPDATE_ARGV('project'));
    assert.equal(updateCalls(fx), 1);
    const record = JSON.parse(fs.readFileSync(path.join(fx.home, '.claude', 'plugins', 'installed_plugins.json'), 'utf8')).plugins[PLUGIN_KEY][0];
    assert.equal(record.version, '0.2.10');
    assert.match(result.text, /Updated the plugin: 0\.2\.7 -> 0\.2\.10/);
  } finally { cleanup(fx); }
});

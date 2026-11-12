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
const { PLUGIN_KEY, marrowCommand, dummy, sha, json, writeFile, treeHashes, duplicateHooks, fixture, cleanup } = require('./support/update-path-fixture');
const OLD_PIN = '3.9.98';
const updatePath = () => require('../src/update-path');

function run(fx, { PATH = fx.bin, timeoutMs, cwd = fx.project } = {}) {
  const lines = [];
  const previous = process.exitCode;
  const result = updatePath().runUpdatePath({ home: fx.home, cwd }, { env: { PATH, HOME: fx.home }, out: (line) => lines.push(line), ...(timeoutMs ? { timeoutMs } : {}) });
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

test('UP-2 plugin plus a duplicate settings hook copy: only the exact Marrow entries go, other hooks and settings keep their bytes, the detector goes quiet', () => {
  const fx = fixture({ duplicate: true });
  try {
    const original = JSON.parse(fs.readFileSync(fx.userSettings, 'utf8'));
    assert.equal(exactCopies(fx.userSettings).length, 4);
    // U1 trace: after every rename, the plugin (enabled, record present) or a settings PreToolUse copy protects the host.
    const trace = [];
    const rename = fs.renameSync;
    fs.renameSync = function traced(...args) {
      const out = rename.apply(this, args);
      const enabled = JSON.parse(fs.readFileSync(fx.userSettings, 'utf8')).enabledPlugins?.[PLUGIN_KEY] === true;
      trace.push(enabled || exactCopies(fx.userSettings).includes('PreToolUse'));
      return out;
    };
    let result;
    try { result = run(fx); } finally { fs.renameSync = rename; }
    assert.equal(result.exitCode, 0, result.text);
    assert.ok(trace.length > 0 && trace.every(Boolean), 'a protection exists at every step');
    const after = JSON.parse(fs.readFileSync(fx.userSettings, 'utf8'));
    const expected = { ...original, hooks: {
      PreToolUse: [original.hooks.PreToolUse[0]],
      PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'owner-audit.sh' }] }],
    } };
    assert.equal(fs.readFileSync(fx.userSettings, 'utf8'), json(expected));
    assert.deepEqual(exactCopies(fx.userSettings), []);
    assert.equal(after.enabledPlugins[PLUGIN_KEY], true);
    assert.match(result.text, /Removed the duplicate Marrow hook copy .*\(4 entries\); the plugin hook stays/);
    assert.match(result.text, /Marrow hook copies in settings files: none/);
    // CONS-2: the duplicate detector (an enabled plugin plus a Marrow settings hook copy) finds nothing.
    const { detectAgentPlugins } = require('../src/agent-plugins');
    assert.equal(detectAgentPlugins({ home: fx.home, project: fx.project }).filter((plugin) => plugin.counted).length, 1);
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
      if (to === projectFile) { injected += 1; const error = new Error('injected disk error'); error.code = 'EIO'; throw error; }
      return rename.call(this, from, to, ...rest);
    };
    let result;
    try { result = run(fx); } finally { fs.renameSync = rename; }
    assert.equal(injected, 1);
    assert.equal(result.exitCode, 1);
    assert.equal(sha(fx.userSettings), user);
    assert.equal(sha(projectFile), projectSha);
    assert.match(result.text, /the previous files were restored/);
    assert.deepEqual(fs.readdirSync(path.dirname(projectFile)).filter((name) => name.includes('marrow-update')), []);
  } finally { cleanup(fx); }
  if (process.getuid && process.getuid() === 0) return;
  const ro = fixture({ duplicate: true });
  try {
    fs.chmodSync(ro.userSettings, 0o444);
    const before = sha(ro.userSettings);
    const result = run(ro);
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
  const fx = fixture({ scope: 'local', duplicate: true, claude: { print: 'MARROW_API_KEY=dummyprinted0 /home/x/.marrow/env' } });
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
    assert.equal(result.text.includes('dummyprinted0'), false);
    assert.equal(everything.includes(keyValue), false);
  } finally { cleanup(fx); }
});

test('UP-9 / INST-2 through the CLI: `update` on a plugin install opens no key file, uses the fixed argv, prints no secret', () => {
  const fx = fixture({ duplicate: true });
  try {
    const spy = path.join(fx.root, 'spy.log');
    const env = { PATH: fx.bin, HOME: fx.home, MARROW_API_KEY: dummy('dummyupdcli'), UPDATE_PATH_SPY_LOG: spy, NODE_OPTIONS: `--require ${path.join(__dirname, 'support', 'fs-spy.cjs')}` };
    const child = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'marrow-install.js'), 'update'], { cwd: fx.project, env, encoding: 'utf8', timeout: 60000 });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    assert.deepEqual(fx.argv(), UPDATE_ARGV('user'));
    const opened = fs.readFileSync(spy, 'utf8').split('\n').filter((entry) => entry.startsWith(fx.root));
    assert.deepEqual(opened.filter((entry) => entry.includes(`${path.sep}.marrow`)), []);
    for (const value of [env.MARROW_API_KEY, fx.secret]) assert.equal(`${child.stdout}${child.stderr}`.includes(value), false);
    assert.match(child.stdout, /\/reload-plugins/);
    assert.deepEqual(exactCopies(fx.userSettings), []);
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
    const result = run(fx);
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
    const first = run(fx);
    assert.equal(first.exitCode, 1);
    assert.equal(sha(fx.userSettings), before);
    fs.rmSync(leftover);
    const second = run(fx);
    assert.equal(second.exitCode, 0, second.text);
    assert.deepEqual(exactCopies(fx.userSettings), []);
    const third = run(fx);
    assert.equal(third.exitCode, 0, third.text);
    assert.match(third.text, /Marrow hook copies in settings files: none/);
  } finally { cleanup(fx); }
});

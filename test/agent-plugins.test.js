require('./support/isolated-environment');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { detectAgentPlugins, codexPluginEnabled } = require('../src/agent-plugins');
const { install } = require('../src/installer');

// The layouts `claude plugin install marrow@getmarrow` (Claude Code 2.1.293) and
// `codex plugin add marrow@getmarrow` (codex-cli 0.161.0) wrote from marketplace `getmarrow`
// (plugins 115cd045), reduced to the files doctor reads.
const CLAUDE_PRE = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/marrow-launch.cjs" claude-pre-action-hook';
const CODEX_PRE = 'node "${PLUGIN_ROOT}/scripts/marrow-launch.cjs" codex-pre-action-hook';

function workspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-plugins-'));
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(project, { mode: 0o700 });
  return { base, home, project, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
}

function pluginCopy(root, manifestDir, version, preAction, events) {
  write(path.join(root, manifestDir, 'plugin.json'), { name: 'marrow', version });
  write(path.join(root, 'scripts', 'marrow-launch.cjs'), '// launcher\n');
  const hooks = Object.fromEntries(events.map((event) => [event, [{ hooks: [{ type: 'command', command: event === 'PreToolUse' ? preAction : `${preAction}-other` }] }]]));
  write(path.join(root, 'hooks', 'hooks.json'), { hooks });
}

function claudeInstall(home, { version = '0.2.1', enabled = true, key = 'marrow@getmarrow', installPath } = {}) {
  const copy = path.join(home, '.claude', 'plugins', 'cache', 'getmarrow', 'marrow', version);
  pluginCopy(copy, '.claude-plugin', version, CLAUDE_PRE, ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);
  write(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), { version: 2, plugins: { [key]: [{ scope: 'user', installPath: installPath || copy, version }] } });
  write(path.join(home, '.claude', 'settings.json'), { enabledPlugins: { [key]: enabled } });
  return copy;
}

function codexInstall(codexHome, { version = '0.1.1', enabled = true } = {}) {
  const copy = path.join(codexHome, 'plugins', 'cache', 'getmarrow', 'marrow', version);
  pluginCopy(copy, '.codex-plugin', version, CODEX_PRE, ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionEnd']);
  write(path.join(codexHome, 'config.toml'), `[marketplaces.getmarrow]\nsource_type = "local"\n\n[plugins."marrow@getmarrow"]\nenabled = ${enabled}\n`);
  return copy;
}

const byHost = (plugins) => Object.fromEntries(plugins.map((plugin) => [plugin.host, plugin]));

test('the real Claude Code and Codex install layouts count, with host, version and hooks', () => {
  const ws = workspace();
  try {
    const claude = claudeInstall(ws.home);
    const codex = codexInstall(path.join(ws.home, '.codex'));
    const found = byHost(detectAgentPlugins({ home: ws.home, env: {} }));
    assert.deepEqual(Object.keys(found).sort(), ['claude-code', 'codex']);
    assert.deepEqual([found['claude-code'].counted, found['claude-code'].version, found['claude-code'].path], [true, '0.2.1', claude]);
    assert.deepEqual([found.codex.counted, found.codex.version, found.codex.path], [true, '0.1.1', codex]);
    assert.deepEqual(found.codex.events, ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionEnd']);
    assert.equal(found['claude-code'].hook_label, 'Claude Code MCP passive hooks');
    assert.equal(found.codex.hook_label, 'Codex native hooks');
    // CODEX_HOME inside the home folder is followed.
    const other = path.join(ws.home, 'codex-elsewhere');
    codexInstall(other, { version: '0.1.2' });
    assert.equal(byHost(detectAgentPlugins({ home: ws.home, env: { CODEX_HOME: other } })).codex.version, '0.1.2');
  } finally {
    ws.cleanup();
  }
});

test('look-alikes never count: other marketplace, wrong manifest, foreign hooks, disabled, outside home, unsafe folders', () => {
  const cases = [
    ['no plugin at all', () => {}, (found) => assert.deepEqual(found, {})],
    ['marketplace look-alike marrow@evil', (ws) => claudeInstall(ws.home, { key: 'marrow@evil' }), (found) => assert.deepEqual(found, {})],
    ['Claude plugin disabled', (ws) => claudeInstall(ws.home, { enabled: false }), (found) => assert.equal(found['claude-code'].counted, false)],
    ['Codex plugin disabled', (ws) => codexInstall(path.join(ws.home, '.codex'), { enabled: false }), (found) => assert.equal(found.codex.counted, false)],
    ['installPath in a project folder', (ws) => {
      const planted = path.join(ws.project, '.claude', 'plugins', 'cache', 'getmarrow', 'marrow', '0.2.1');
      pluginCopy(planted, '.claude-plugin', '0.2.1', CLAUDE_PRE, ['PreToolUse']);
      claudeInstall(ws.home, { installPath: planted });
      fs.rmSync(path.join(ws.home, '.claude', 'plugins', 'cache'), { recursive: true });
    }, (found) => assert.match(found['claude-code'].invalid, /not installed at/)],
    ['manifest names another plugin', (ws) => {
      const copy = claudeInstall(ws.home);
      write(path.join(copy, '.claude-plugin', 'plugin.json'), { name: 'marrow-evil', version: '0.2.1' });
    }, (found) => assert.match(found['claude-code'].invalid, /plugin\.json/)],
    ['hooks run a project script, not the launcher', (ws) => {
      const copy = codexInstall(path.join(ws.home, '.codex'));
      write(path.join(copy, 'hooks', 'hooks.json'), { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node ./scripts/marrow-launch.cjs codex-pre-action-hook' }] }] } });
    }, (found) => assert.match(found.codex.invalid, /launcher/)],
    ['two cached Codex versions', (ws) => {
      codexInstall(path.join(ws.home, '.codex'));
      pluginCopy(path.join(ws.home, '.codex', 'plugins', 'cache', 'getmarrow', 'marrow', '0.1.0'), '.codex-plugin', '0.1.0', CODEX_PRE, ['PreToolUse']);
    }, (found) => assert.match(found.codex.invalid, /2 cached versions/)],
    ['group-writable plugin folder', (ws) => fs.chmodSync(claudeInstall(ws.home), 0o775), (found) => {
      assert.equal(found['claude-code'].counted, false);
      assert.match(found['claude-code'].unsafe.reason, /writable by other users/);
    }],
    ['world-writable home', (ws) => { codexInstall(path.join(ws.home, '.codex')); fs.chmodSync(ws.home, 0o777); }, (found, ws) => {
      assert.equal(found.codex.counted, false);
      assert.equal(found.codex.unsafe.path, ws.home);
    }],
    ['symlinked plugin copy', (ws) => {
      const copy = claudeInstall(ws.home);
      const real = path.join(ws.base, 'elsewhere');
      fs.renameSync(copy, real);
      fs.symlinkSync(real, copy);
    }, (found) => assert.equal(found['claude-code'].unsafe.reason, 'a symbolic link')],
    ['project settings turn the Claude plugin off', (ws) => {
      claudeInstall(ws.home);
      write(path.join(ws.project, '.claude', 'settings.local.json'), { enabledPlugins: { 'marrow@getmarrow': false } });
    }, (found, ws) => {
      assert.equal(found['claude-code'].counted, false);
      assert.equal(found['claude-code'].disabled_by, path.join(ws.project, '.claude', 'settings.local.json'));
    }],
    ['project config turns the Codex plugin off', (ws) => {
      codexInstall(path.join(ws.home, '.codex'));
      write(path.join(ws.project, '.codex', 'config.toml'), '[plugins."marrow@getmarrow"]\nenabled = false\n');
    }, (found) => assert.equal(found.codex.counted, false)],
    ['project files turning a plugin on do not make a disabled one count', (ws) => {
      claudeInstall(ws.home, { enabled: false });
      write(path.join(ws.project, '.claude', 'settings.json'), { enabledPlugins: { 'marrow@getmarrow': true } });
    }, (found) => assert.equal(found['claude-code'].counted, false)],
    ['CODEX_HOME outside the home folder', (ws) => codexInstall(path.join(ws.project, '.codex')), (found) => {
      assert.equal(found.codex.counted, false);
      assert.equal(found.codex.unsafe.reason, 'outside the home folder');
    }, (ws) => ({ CODEX_HOME: path.join(ws.project, '.codex') })],
  ];
  for (const [name, arrange, check, envFor] of cases) {
    const ws = workspace();
    try {
      arrange(ws);
      check(byHost(detectAgentPlugins({ home: ws.home, env: envFor ? envFor(ws) : {}, project: ws.project })), ws);
    } catch (error) {
      error.message = `${name}: ${error.message}`;
      throw error;
    } finally {
      ws.cleanup();
    }
  }
});

test('Codex config: only [plugins."marrow@getmarrow"] with enabled = true counts', () => {
  assert.equal(codexPluginEnabled('[plugins."marrow@getmarrow"]\nenabled = true\n'), true);
  assert.equal(codexPluginEnabled('[plugins."marrow@getmarrow"]\nenabled = true # on\n'), true);
  assert.equal(codexPluginEnabled('[plugins."marrow@getmarrow"]\nenabled = true\nenabled = false\n'), false, 'last one wins');
  assert.equal(codexPluginEnabled('[plugins."marrow@getmarrow"]\n'), false);
  assert.equal(codexPluginEnabled('[plugins."marrow@evil"]\nenabled = true\n'), false);
  assert.equal(codexPluginEnabled('[plugins."marrow@getmarrow"]\n[other]\nenabled = true\n'), false);
  assert.equal(codexPluginEnabled('# [plugins."marrow@getmarrow"]\nenabled = true\n'), false);
});

function doctorOptions(ws) {
  return { cwd: ws.project, home: ws.home, mode: 'mcp', selfTest: false, loopGuardSelfTest: false, apiKey: '', baseUrl: 'https://api.getmarrow.ai',
    agentId: 'plugin-doctor-fixture', controller: false, processCommands: [], mcpRegistryMetadata: null };
}

test('doctor: a plugin host is not "hooks missing"; plugin plus installer hooks is one duplicate line; setup writes as before', async () => {
  const ws = workspace();
  try {
    fs.writeFileSync(path.join(ws.project, 'CLAUDE.md'), '# Claude\n');
    fs.mkdirSync(path.join(ws.project, '.codex'));
    fs.writeFileSync(path.join(ws.project, '.codex', 'config.toml'), 'model = "x"\n');
    const before = await install({ ...doctorOptions(ws), yes: false, dryRun: false, doctor: true });
    assert.ok(before.doctor.missingHooks.includes('Claude Code MCP passive hooks'));
    assert.ok(before.doctor.missingHooks.includes('Codex native hooks'));
    assert.deepEqual(before.doctor.agent_plugins, []);

    claudeInstall(ws.home);
    codexInstall(path.join(ws.home, '.codex'));
    const plugin = await install({ ...doctorOptions(ws), yes: false, dryRun: false, doctor: true });
    assert.equal(plugin.doctor.missingHooks.includes('Claude Code MCP passive hooks'), false);
    assert.equal(plugin.doctor.missingHooks.includes('Codex native hooks'), false);
    assert.deepEqual(plugin.doctor.agent_plugins.map((item) => [item.host, item.counted, item.version]), [['claude-code', true, '0.2.1'], ['codex', true, '0.1.1']]);
    assert.deepEqual(plugin.doctor.duplicate_hooks, []);

    // Setup is unchanged by a plugin: it still writes the installer hooks.
    const files = ['.claude/settings.json', '.codex/hooks.json'].map((relative) => path.join(ws.project, relative));
    await install({ ...doctorOptions(ws), yes: true, dryRun: false, doctor: false });
    for (const file of files) assert.match(fs.readFileSync(file, 'utf8'), /pre-action-hook/, file);
    const both = await install({ ...doctorOptions(ws), yes: false, dryRun: false, doctor: true });
    assert.equal(both.doctor.duplicate_hooks.length, 2);
    assert.match(both.doctor.duplicate_hooks[0], /^Claude Code: the Marrow plugin and this project's installer hooks .* `npx @getmarrow\/install uninstall --yes` removes it; or `claude plugin uninstall marrow@getmarrow`/);
    assert.match(both.doctor.duplicate_hooks[1], /^Codex: .*`codex plugin remove marrow@getmarrow` removes the plugin\.$/);
  } finally {
    ws.cleanup();
  }
});

test('doctor: a Marrow plugin planted in the project folder is not a plugin, and hooks stay missing', async () => {
  const ws = workspace();
  try {
    // The home layouts, copied under the project, plus project files that enable them.
    claudeInstall(path.join(ws.project));
    codexInstall(path.join(ws.project, '.codex'));
    write(path.join(ws.project, '.claude', 'settings.json'), { enabledPlugins: { 'marrow@getmarrow': true } });
    const report = await install({ ...doctorOptions(ws), yes: false, dryRun: false, doctor: true });
    assert.deepEqual(report.doctor.agent_plugins, []);
    assert.ok(report.doctor.missingHooks.includes('Claude Code MCP passive hooks'));
    assert.ok(report.doctor.missingHooks.includes('Codex native hooks'));
  } finally {
    ws.cleanup();
  }
});

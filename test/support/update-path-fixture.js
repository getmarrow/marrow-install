'use strict';

// Fixtures for test/update-path.test.js and its probes: a private fixture HOME with a project folder, a fake `claude` on a
// private PATH that logs its argv (one JSON array per call) and dummy values generated at run time.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PINS = require('../../src/pins');
const PLUGIN_KEY = 'marrow@getmarrow';
const PRE_ACTION = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/marrow-launch.cjs" claude-pre-action-hook';
const marrowCommand = (entry, version = PINS.MCP_ADAPTER_VERSION) => `npx -y --package=@getmarrow/mcp@${version} marrow-mcp ${entry}`;

function dummy(prefix) {
  const value = `${prefix}${crypto.randomBytes(12).toString('hex')}`;
  assert.doesNotMatch(value, /^(sk_|pk_|rk_|ghp_|xox)/);
  return value;
}

const sha = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null);
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
function writeFile(file, text, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  fs.writeFileSync(file, text, { mode });
  fs.chmodSync(file, mode);
}

function treeHashes(dir) {
  const out = {};
  const walk = (current) => {
    for (const name of fs.readdirSync(current)) {
      const entry = path.join(current, name);
      const stat = fs.lstatSync(entry);
      if (stat.isDirectory()) walk(entry);
      else if (!entry.endsWith('claude-argv.log')) out[path.relative(dir, entry)] = sha(entry);
    }
  };
  walk(dir);
  return out;
}

// The exact settings-hook copy an older `setup` writes (one entry per event), inside other owner hooks.
function duplicateHooks(version = PINS.MCP_ADAPTER_VERSION) {
  return {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: marrowCommand('claude-context-hook', version) }] }],
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'owner-guard.sh --strict' }] },
      { matcher: '*', hooks: [{ type: 'command', command: marrowCommand('claude-pre-action-hook', version), timeout: 30 }] },
    ],
    PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: marrowCommand('claude-hook', version) }, { type: 'command', command: 'owner-audit.sh' }] }],
    Stop: [{ hooks: [{ type: 'command', command: marrowCommand('claude-session-hook', version) }] }],
  };
}

function pluginCopy(home, version) {
  const copy = path.join(home, '.claude', 'plugins', 'cache', 'getmarrow', 'marrow', version);
  writeFile(path.join(copy, '.claude-plugin', 'plugin.json'), json({ name: 'marrow', version }));
  writeFile(path.join(copy, 'scripts', 'marrow-launch.cjs'), '// launcher\n');
  writeFile(path.join(copy, 'hooks', 'hooks.json'), json({ hooks: {
    PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: PRE_ACTION }] }],
    PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/marrow-launch.cjs" claude-hook' }] }],
  } }));
  return copy;
}

function chmodTree(dir) {
  for (const name of fs.readdirSync(dir)) {
    const entry = path.join(dir, name);
    if (fs.lstatSync(entry).isDirectory()) { fs.chmodSync(entry, 0o755); chmodTree(entry); }
  }
}

// A fixture HOME with a project folder, a fake `claude`, and optionally the plugin and settings-hook copies.
// Claude Code's local copy of the getmarrow marketplace offering marrow at `offered` (null: no marketplace copy).
function marketplace(home, offered) {
  const folder = path.join(home, '.claude', 'plugins', 'marketplaces', 'getmarrow');
  writeFile(path.join(home, '.claude', 'plugins', 'known_marketplaces.json'), json({ getmarrow: { source: { source: 'github', repo: 'getmarrow/plugins' }, installLocation: folder, lastUpdated: '2026-11-01T00:00:00.000Z' } }));
  writeFile(path.join(folder, '.claude-plugin', 'marketplace.json'), json({ name: 'getmarrow', owner: { name: 'getmarrow' }, plugins: [{ name: 'marrow', source: './plugins/marrow', description: 'Marrow' }] }));
  writeFile(path.join(folder, 'plugins', 'marrow', '.claude-plugin', 'plugin.json'), json({ name: 'marrow', version: offered }));
  return folder;
}

function fixture({ scope = 'user', version = '0.2.7', records, plugin = true, duplicate = false, settings = {}, claude = {}, localSettings, projectSettings, offered = '0.2.8' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-upd-')));
  const home = path.join(root, 'home');
  const project = path.join(home, 'project');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(path.join(project, '.claude'), { recursive: true, mode: 0o755 });
  fs.mkdirSync(bin, { mode: 0o755 });
  const secret = dummy('dummyupdenv');
  const userSettings = path.join(home, '.claude', 'settings.json');
  const scopeFile = { user: userSettings, project: path.join(project, '.claude', 'settings.json'), local: path.join(project, '.claude', 'settings.local.json') };
  if (plugin) {
    pluginCopy(home, version);
    const record = { scope, installPath: path.join(home, '.claude', 'plugins', 'cache', 'getmarrow', 'marrow', version), version, installedAt: '2026-11-01T00:00:00.000Z', ...(scope === 'user' ? {} : { projectPath: project }) };
    writeFile(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), json({ version: 2, plugins: records || { [PLUGIN_KEY]: [record] } }));
    if (offered !== null) marketplace(home, offered);
  }
  const user = { theme: 'dark', env: { OWNER_TOKEN: secret }, ...settings };
  if (plugin && scope === 'user') user.enabledPlugins = Object.fromEntries(Object.keys(records || { [PLUGIN_KEY]: [] }).map((key) => [key, true]));
  if (duplicate) user.hooks = duplicateHooks(typeof duplicate === 'string' ? duplicate : undefined);
  writeFile(userSettings, json(user));
  if (plugin && scope !== 'user') writeFile(scopeFile[scope], json({ env: { OWNER_TOKEN: secret }, enabledPlugins: { [PLUGIN_KEY]: true } }));
  if (projectSettings) writeFile(scopeFile.project, projectSettings);
  if (localSettings) writeFile(scopeFile.local, localSettings);
  writeFile(path.join(home, '.marrow', 'env'), `MARROW_API_KEY=${dummy('dummyupdkey')}\n`, 0o600);
  const log = path.join(root, 'claude-argv.log');
  writeFile(path.join(bin, 'fake.json'), json({ log, home, scope, version, next: '0.2.8', exit: 0, ...claude }));
  writeFile(path.join(bin, 'claude'), `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'fake.json'), 'utf8'));
const argv = process.argv.slice(2);
fs.appendFileSync(config.log, JSON.stringify(argv) + '\\n');
if (config.offerAfter && argv[1] === 'marketplace') fs.writeFileSync(path.join(config.home, '.claude', 'plugins', 'marketplaces', 'getmarrow', 'plugins', 'marrow', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'marrow', version: config.offerAfter }, null, 2) + '\\n');
if (config.hang && argv[1] === 'update') setTimeout(() => {}, 60000);
else {
  if (config.print) process.stdout.write(config.print + '\\n');
  if (config.exit === 0 && argv[1] === 'update' && config.write !== false && !fs.existsSync(path.join(path.dirname(config.home), 'home', '.claude', 'plugins', 'cache', 'getmarrow', 'marrow', config.next))) {
    const list = path.join(config.home, '.claude', 'plugins', 'installed_plugins.json');
    const data = JSON.parse(fs.readFileSync(list, 'utf8'));
    const entry = data.plugins['${PLUGIN_KEY}'].find((item) => item.scope === config.scope);
    const from = entry.installPath;
    entry.version = config.next;
    entry.installPath = path.join(path.dirname(from), config.next);
    fs.cpSync(from, entry.installPath, { recursive: true });
    const tighten = (dir) => { fs.chmodSync(dir, 0o755); for (const name of fs.readdirSync(dir)) { const item = path.join(dir, name); if (fs.lstatSync(item).isDirectory()) tighten(item); else fs.chmodSync(item, 0o644); } };
    tighten(entry.installPath);
    const manifest = path.join(entry.installPath, '.claude-plugin', 'plugin.json');
    fs.writeFileSync(manifest, JSON.stringify({ name: 'marrow', version: config.next }, null, 2) + '\\n');
    fs.writeFileSync(list, JSON.stringify(data, null, 2) + '\\n');
  }
  if (config.disableIn && argv[1] === 'update') { const data = JSON.parse(fs.readFileSync(config.disableIn, 'utf8')); data.enabledPlugins['${PLUGIN_KEY}'] = false; fs.writeFileSync(config.disableIn, JSON.stringify(data, null, 2) + '\\n'); }
  process.exitCode = argv[1] === 'update' ? config.exit : 0;
}
`, 0o755);
  chmodTree(home);
  fs.chmodSync(home, 0o755);
  return { root, home, project, bin, log, secret, userSettings, scopeFile, argv: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []) };
}

const cleanup = (fx) => fs.rmSync(fx.root, { recursive: true, force: true });

module.exports = { PLUGIN_KEY, PRE_ACTION, marrowCommand, dummy, sha, json, writeFile, treeHashes, duplicateHooks, marketplace, fixture, cleanup };

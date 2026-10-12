'use strict';

// Recognizes Marrow's agent plugins (github.com/getmarrow/plugins) where the host CLI installs them,
// for doctor only: nothing here changes what setup, activate or update write.
//
// Measured with the host CLIs installing marketplace `getmarrow` (plugins 115cd045):
// - Claude Code 2.1.293 (`claude plugin install marrow@getmarrow`): ~/.claude/plugins/installed_plugins.json
//   lists "marrow@getmarrow" (scope "user") with installPath ~/.claude/plugins/cache/getmarrow/marrow/<version>,
//   and ~/.claude/settings.json has enabledPlugins["marrow@getmarrow"] === true.
// - Codex 0.161.0 (`codex plugin add marrow@getmarrow`): <codex home>/plugins/cache/getmarrow/marrow/<version>,
//   and <codex home>/config.toml has [plugins."marrow@getmarrow"] with enabled = true.
// Cursor's install layout is not verified, so a Cursor plugin is never counted.
//
// A project can only turn a plugin off: its own settings disabling the plugin make it not counted
// there; nothing in a project ever makes a plugin count.
//
// Only those locations count, and only when every folder from the home folder down and every file
// read is a real (not symlinked) entry owned by this user that no one else can write. A folder or
// file merely named "marrow" in a project, or anything outside the user's home, never counts.

const fs = require('node:fs');
const path = require('node:path');

const MARKETPLACE = 'getmarrow';
const PLUGIN_KEY = `marrow@${MARKETPLACE}`;
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const MAX_READ_BYTES = 1024 * 1024;

// The exact pre-action command each plugin's hooks.json runs (plugins tools/check.cjs).
const HOSTS = Object.freeze({
  'claude-code': {
    name: 'Claude Code',
    manifest: path.join('.claude-plugin', 'plugin.json'),
    preAction: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/marrow-launch.cjs" claude-pre-action-hook',
    hookLabel: 'Claude Code MCP passive hooks',
    removePlugin: 'claude plugin uninstall marrow@getmarrow',
  },
  codex: {
    name: 'Codex',
    manifest: path.join('.codex-plugin', 'plugin.json'),
    preAction: 'node "${PLUGIN_ROOT}/scripts/marrow-launch.cjs" codex-pre-action-hook',
    hookLabel: 'Codex native hooks',
    removePlugin: 'codex plugin remove marrow@getmarrow',
  },
});

const uid = () => (typeof process.getuid === 'function' ? process.getuid() : null);

// Why an entry is not owner-only, or null when it is.
function unsafeEntry(entry, kind) {
  let stat;
  try {
    stat = fs.lstatSync(entry);
  } catch {
    return 'missing';
  }
  if (stat.isSymbolicLink()) return 'a symbolic link';
  if (kind === 'dir' ? !stat.isDirectory() : !stat.isFile()) return kind === 'dir' ? 'not a folder' : 'not a file';
  const me = uid();
  if (me !== null && stat.uid !== me) return 'owned by another user';
  if ((stat.mode & 0o022) !== 0) return 'writable by other users';
  return null;
}

// Checks every folder from home down to target (inclusive when target is a folder).
function unsafeChain(home, target, kind) {
  const relative = path.relative(home, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return { path: target, reason: 'outside the home folder' };
  let current = home;
  const homeReason = unsafeEntry(home, 'dir');
  if (homeReason) return { path: home, reason: homeReason };
  const parts = relative.split(path.sep);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const last = index === parts.length - 1;
    const reason = unsafeEntry(current, last ? kind : 'dir');
    if (reason) return { path: current, reason };
  }
  return null;
}

function readOwnerFile(home, file) {
  const unsafe = unsafeChain(home, file, 'file');
  if (unsafe) return { unsafe };
  const stat = fs.statSync(file);
  if (stat.size > MAX_READ_BYTES) return { unsafe: { path: file, reason: 'too large' } };
  return { text: fs.readFileSync(file, 'utf8') };
}

function readOwnerJson(home, file) {
  const read = readOwnerFile(home, file);
  if (read.unsafe) return read;
  try {
    const value = JSON.parse(read.text);
    return value && typeof value === 'object' && !Array.isArray(value) ? { value } : { unsafe: { path: file, reason: 'not a JSON object' } };
  } catch {
    return { unsafe: { path: file, reason: 'not valid JSON' } };
  }
}

const own = (object, key) => (object && Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined);

// The events whose hooks run the plugin launcher, when its pre-action hook is the exact command.
function pluginHookEvents(hooksJson, preAction) {
  const hooks = own(hooksJson, 'hooks');
  if (!hooks || typeof hooks !== 'object') return null;
  const pre = own(hooks, 'PreToolUse');
  const hasPre = Array.isArray(pre) && pre.some((group) => Array.isArray(group?.hooks)
    && group.hooks.some((hook) => hook?.type === 'command' && hook.command === preAction));
  if (!hasPre) return null;
  return Object.keys(hooks).filter((event) => Array.isArray(hooks[event]) && hooks[event].length > 0);
}

// One plugin copy: the manifest names it `marrow` at `version`, and its pre-action hook is the
// plugin launcher. Returns { version, path, events } or { unsafe } / { invalid }.
function inspectCopy(home, host, copy, version) {
  const spec = HOSTS[host];
  const unsafe = unsafeChain(home, copy, 'dir');
  if (unsafe) return { unsafe };
  const manifest = readOwnerJson(home, path.join(copy, spec.manifest));
  if (manifest.unsafe) return manifest;
  if (own(manifest.value, 'name') !== 'marrow' || own(manifest.value, 'version') !== version) return { invalid: 'its plugin.json does not name marrow at this version' };
  const launcher = unsafeChain(home, path.join(copy, 'scripts', 'marrow-launch.cjs'), 'file');
  if (launcher) return { unsafe: launcher };
  const hooks = readOwnerJson(home, path.join(copy, 'hooks', 'hooks.json'));
  if (hooks.unsafe) return hooks;
  const events = pluginHookEvents(hooks.value, spec.preAction);
  if (!events) return { invalid: 'its hooks.json does not run the Marrow plugin launcher' };
  return { version, path: copy, events };
}

// A project file read only to find an explicit "off" (never trusted to turn anything on).
function projectText(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && stat.size <= MAX_READ_BYTES ? fs.readFileSync(file, 'utf8') : '';
  } catch {
    return '';
  }
}

function claudeProjectDisables(project) {
  if (!project) return null;
  for (const name of ['settings.json', 'settings.local.json']) {
    const file = path.join(project, '.claude', name);
    try {
      if (own(own(JSON.parse(projectText(file) || '{}'), 'enabledPlugins'), PLUGIN_KEY) === false) return file;
    } catch { /* unreadable project settings turn nothing off */ }
  }
  return null;
}

function claudePlugin(home, project) {
  const base = path.join(home, '.claude');
  const installed = path.join(base, 'plugins', 'installed_plugins.json');
  if (!fs.existsSync(installed)) return null;
  // Only a listed Marrow plugin is reported; the folder checks come after.
  try {
    if (!Array.isArray(own(own(JSON.parse(projectText(installed) || '{}'), 'plugins'), PLUGIN_KEY))) return null;
  } catch {
    return null;
  }
  const list = readOwnerJson(home, installed);
  if (list.unsafe) return { host: 'claude-code', counted: false, ...list };
  const entries = own(own(list.value, 'plugins'), PLUGIN_KEY);
  const entry = Array.isArray(entries) ? entries.find((item) => own(item, 'scope') === 'user') : null;
  if (!entry) return null;
  const version = own(entry, 'version');
  if (typeof version !== 'string' || !VERSION.test(version)) return { host: 'claude-code', counted: false, invalid: 'its installed version is not a plain version number' };
  const expected = path.join(base, 'plugins', 'cache', MARKETPLACE, 'marrow', version);
  if (own(entry, 'installPath') !== expected) return { host: 'claude-code', counted: false, invalid: `it is not installed at ${expected}` };
  const settings = readOwnerJson(home, path.join(base, 'settings.json'));
  if (settings.unsafe) return { host: 'claude-code', counted: false, ...settings };
  if (own(own(settings.value, 'enabledPlugins'), PLUGIN_KEY) !== true) return { host: 'claude-code', counted: false, version, disabled: true };
  const off = claudeProjectDisables(project);
  if (off) return { host: 'claude-code', counted: false, version, disabled: true, disabled_by: off };
  const copy = inspectCopy(home, 'claude-code', expected, version);
  return { host: 'claude-code', counted: Boolean(copy.events), ...copy };
}

// `[plugins."marrow@getmarrow"]` followed (before the next table) by `enabled = true`. Any other
// spelling is not read, so it does not count. codexPluginState also tells an explicit false apart.
function codexPluginEnabled(toml) {
  return codexPluginState(toml) === true;
}

function codexPluginState(toml) {
  let inTable = false;
  let enabled = null;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (line.startsWith('[')) {
      inTable = line === `[plugins."${PLUGIN_KEY}"]`;
      continue;
    }
    if (inTable) {
      const match = line.match(/^enabled\s*=\s*(true|false)$/);
      if (match) enabled = match[1] === 'true';
    }
  }
  return enabled;
}

function codexPlugin(home, env, project) {
  const configured = typeof env.CODEX_HOME === 'string' && env.CODEX_HOME.trim() ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex');
  const config = path.join(configured, 'config.toml');
  const cache = path.join(configured, 'plugins', 'cache', MARKETPLACE, 'marrow');
  if (!fs.existsSync(config) || !fs.existsSync(cache)) return null;
  const read = readOwnerFile(home, config);
  if (read.unsafe) return { host: 'codex', counted: false, ...read };
  if (!codexPluginEnabled(read.text)) return { host: 'codex', counted: false, disabled: true };
  const projectConfig = project ? path.join(project, '.codex', 'config.toml') : null;
  if (projectConfig && codexPluginState(projectText(projectConfig)) === false) return { host: 'codex', counted: false, disabled: true, disabled_by: projectConfig };
  const unsafe = unsafeChain(home, cache, 'dir');
  if (unsafe) return { host: 'codex', counted: false, unsafe };
  const versions = fs.readdirSync(cache).filter((name) => VERSION.test(name));
  if (versions.length !== 1) return { host: 'codex', counted: false, invalid: versions.length ? `it has ${versions.length} cached versions (${versions.join(', ')})` : 'it has no cached copy' };
  const copy = inspectCopy(home, 'codex', path.join(cache, versions[0]), versions[0]);
  return { host: 'codex', counted: Boolean(copy.events), ...copy };
}

function detectAgentPlugins({ home, env = {}, project = null }) {
  const resolvedHome = path.resolve(home);
  const resolvedProject = project ? path.resolve(project) : null;
  return [claudePlugin(resolvedHome, resolvedProject), codexPlugin(resolvedHome, env, resolvedProject)].filter(Boolean).map((plugin) => ({
    ...plugin,
    name: HOSTS[plugin.host].name,
    hook_label: HOSTS[plugin.host].hookLabel,
    remove_plugin: HOSTS[plugin.host].removePlugin,
  }));
}

// One doctor line per plugin.
function describeAgentPlugin(plugin) {
  if (plugin.counted) return `${plugin.name}: Marrow plugin ${plugin.version} (${plugin.path}); its hooks: ${plugin.events.join(', ')}`;
  if (plugin.disabled) return `${plugin.name}: Marrow plugin installed but ${plugin.disabled_by ? `turned off for this project in ${plugin.disabled_by}` : 'not enabled'}; not counted`;
  if (plugin.unsafe) return `${plugin.name}: Marrow plugin not counted: ${plugin.unsafe.path} is ${plugin.unsafe.reason}. Fix: chmod go-w ${plugin.unsafe.path} (it must be yours, not a link), then run doctor again`;
  return `${plugin.name}: Marrow plugin not counted: ${plugin.invalid}. Fix: reinstall it with ${plugin.remove_plugin} and then the host's plugin install for marrow@getmarrow`;
}

module.exports = {
  PLUGIN_KEY,
  detectAgentPlugins,
  describeAgentPlugin,
  codexPluginEnabled,
};

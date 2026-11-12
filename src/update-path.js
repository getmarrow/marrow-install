'use strict';

// One update path: `update` and `--repair` move the Marrow install that is there to the latest version and leave one
// hook copy. A Claude Code plugin (marrow@getmarrow in installed_plugins.json, which records the scope) is updated by
// the claude CLI with fixed argv arrays and no shell; then the exact Marrow hook entries an older setup wrote next to
// the plugin are removed once the plugin hook is verified. A settings-hook install goes on to the existing rewrite,
// unless its hooks pin a newer or malformed version. Anything that cannot be classified changes nothing. Only the
// `hooks` and `enabledPlugins` keys of a settings file are used, no other value is printed, and no key file is opened.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PLUGIN_KEY, detectAgentPlugins } = require('./agent-plugins');
const { MCP_ADAPTER_VERSION } = require('./pins');
const { delocalizeHookCommand } = require('./mcp-runtime');

const SCOPES = ['user', 'project', 'local'];
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const MAX_BYTES = 1024 * 1024;
const CLAUDE_TIMEOUT_MS = 120_000;
// The exact Claude Code hook commands the installer and MCP setup write, by event (any plain pinned version); a local
// runtime form counts only when the existing exact reader maps it back to one of them.
const ENTRYPOINTS = Object.freeze({ UserPromptSubmit: 'claude-context-hook', PreToolUse: 'claude-pre-action-hook', PostToolUse: 'claude-hook',
  PostToolUseFailure: 'claude-hook', PostToolBatch: 'claude-hook', Stop: 'claude-session-hook', PermissionRequest: 'claude-permission-request-hook' });
const MARROW_COMMAND = /^npx -y --package=@getmarrow\/mcp@(\d{1,4}\.\d{1,4}\.\d{1,4}) marrow-mcp (claude-[a-z-]{1,40})$/;
const MCP_PIN = /@getmarrow\/mcp@([^\s"']{0,64})/g;
const MARKETPLACE_ARGV = Object.freeze(['plugin', 'marketplace', 'update', 'getmarrow']);
// Fixed texts: no path and no user text.
const CURSOR_STEPS = 'For the Marrow Cursor plugin: in Cursor, update Marrow from the plugin source you added it from, then restart Cursor. This command never changes a Cursor plugin.';
const REMOVE_USER = 'npx @getmarrow/install@latest update --remove-user-duplicate';
const manualSteps = (scope) => ['claude plugin marketplace update getmarrow', `claude plugin update ${PLUGIN_KEY} -s ${scope} -y`];

const own = (object, key) => (object && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key) ? object[key] : undefined);

function compareVersions(left, right) {
  const [a, b] = [left, right].map((version) => version.split('.').map(Number));
  for (let index = 0; index < 3; index += 1) if (a[index] !== b[index]) return a[index] < b[index] ? -1 : 1;
  return 0;
}

// { missing } | { bad } | { file, text, value }: a regular file (not a link), at most 1 MB, holding a JSON object.
function readJson(file) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch {
    return { file, missing: true };
  }
  if (!stat.isFile() || stat.size > MAX_BYTES) return { file, bad: true };
  try {
    const text = fs.readFileSync(file, 'utf8');
    const value = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? { file, text, value } : { file, bad: true };
  } catch {
    return { file, bad: true };
  }
}

// The pinned version when the hook is exactly a Marrow Claude Code hook for this event, else null.
function marrowHookVersion(event, hook) {
  if (!hook || typeof hook !== 'object' || Array.isArray(hook) || hook.type !== 'command' || typeof hook.command !== 'string') return null;
  const match = MARROW_COMMAND.exec(delocalizeHookCommand(hook.command));
  return match && own(ENTRYPOINTS, event) === match[2] ? match[1] : null;
}

// Every hook of a settings file as { event, group, hook, version } (version null when it is not a Marrow hook).
function hooksOf(settings) {
  const hooks = own(settings.value, 'hooks');
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return [];
  return Object.keys(hooks).flatMap((event) => (Array.isArray(hooks[event]) ? hooks[event] : []).flatMap((group) => (
    Array.isArray(own(group, 'hooks')) ? group.hooks.map((hook) => ({ event, group, hook, version: marrowHookVersion(event, hook) })) : []
  )));
}

function settingsFiles(home, project) {
  const files = [path.join(home, '.claude', 'settings.json'), path.join(project, '.claude', 'settings.json'), path.join(project, '.claude', 'settings.local.json')];
  return [...new Set(files)].map(readJson);
}

const unknown = (reason) => ({ kind: 'unknown', reason });

function classifyInstall({ home, project }) {
  const files = settingsFiles(home, project);
  const records = readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json'));
  const entries = records.value ? own(own(records.value, 'plugins'), PLUGIN_KEY) : undefined;
  const enabled = (file) => own(own(file.value, 'enabledPlugins'), PLUGIN_KEY);
  if (records.bad) return unknown('the Claude Code plugin list (installed_plugins.json) could not be read');
  if (entries === undefined) {
    if (files.some((file) => enabled(file) !== undefined)) return unknown(`a settings file names ${PLUGIN_KEY} but no plugin record lists it`);
    const pins = files.filter((file) => file.value).flatMap(hooksOf).flatMap(({ hook }) => [...String(own(hook, 'command') || '').matchAll(MCP_PIN)].map((match) => match[1]));
    const malformed = pins.find((version) => !VERSION.test(version));
    if (malformed !== undefined) return { kind: 'settings', refuse: 'a Marrow hook pins a version that is not a plain published version' };
    const newer = pins.find((version) => compareVersions(version, MCP_ADAPTER_VERSION) > 0);
    if (newer) return { kind: 'settings', refuse: `the installed Marrow hooks pin ${newer}, newer than ${MCP_ADAPTER_VERSION}; an update never downgrades` };
    return { kind: 'settings', version: pins.length ? pins.reduce((top, version) => (compareVersions(version, top) > 0 ? version : top)) : null };
  }
  if (!Array.isArray(entries) || entries.length !== 1) return unknown(`${Array.isArray(entries) ? entries.length : 'unreadable'} plugin records for ${PLUGIN_KEY}`);
  const scope = SCOPES.find((name) => name === own(entries[0], 'scope'));
  const version = own(entries[0], 'version');
  if (!scope || typeof version !== 'string' || !VERSION.test(version)) return unknown('the plugin record has no known scope or plain version');
  if (scope !== 'user' && own(entries[0], 'projectPath') !== project) return unknown(`the ${scope} plugin record belongs to another folder`);
  if (files.some((file) => file.bad)) return unknown('a Claude Code settings file could not be read');
  const scopeFile = scope === 'user' ? files[0] : files.find((file) => file.file === path.join(project, '.claude', scope === 'local' ? 'settings.local.json' : 'settings.json'));
  if (enabled(scopeFile) !== true || files.some((file) => enabled(file) === false)) return unknown('the plugin is not enabled');
  const copies = files.map((file) => ({ file, hooks: file.value ? hooksOf(file) : [] }));
  const strange = copies.some(({ hooks }) => hooks.some(({ hook, version: pinned }) => pinned === null && /marrow-mcp|@getmarrow\/mcp/.test(String(own(hook, 'command')))));
  if (strange) return unknown('a settings hook names the Marrow MCP in a form this installer never writes');
  const marrow = copies.filter(({ hooks }) => hooks.some((hook) => hook.version));
  if (marrow.some(({ file }) => `${JSON.stringify(file.value, null, 2)}\n` !== file.text)) return unknown('a settings file with a Marrow hook copy is not in the form the installer writes');
  return { kind: 'plugin', scope, version, copies: marrow, scopeFile: scopeFile.file, userFile: files[0].file };
}

function findClaude(env) {
  if (process.platform === 'win32') return null;
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, 'claude');
    try {
      if (fs.statSync(candidate).isFile()) { fs.accessSync(candidate, fs.constants.X_OK); return candidate; }
    } catch { /* not here */ }
  }
  return null;
}

function writeAtomic(file, text) {
  fs.accessSync(file, fs.constants.W_OK);
  const temp = `${file}.marrow-update-${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode: fs.statSync(file).mode & 0o777, flag: 'wx' });
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

// Removes only the exact Marrow hooks; a group keeps its other hooks, an emptied group or event goes. All files or none.
function removeCopies(copies) {
  const written = [];
  try {
    for (const { file, hooks } of copies) {
      const value = JSON.parse(file.text);
      for (const event of new Set(hooks.filter((hook) => hook.version).map((hook) => hook.event))) {
        value.hooks[event] = value.hooks[event]
          .map((group) => (Array.isArray(own(group, 'hooks')) ? { ...group, hooks: group.hooks.filter((hook) => !marrowHookVersion(event, hook)) } : group))
          .filter((group) => !Array.isArray(own(group, 'hooks')) || group.hooks.length > 0);
        if (value.hooks[event].length === 0) delete value.hooks[event];
      }
      writeAtomic(file.file, `${JSON.stringify(value, null, 2)}\n`);
      written.push(file);
    }
    return null;
  } catch {
    const notRestored = written.filter((file) => {
      try { writeAtomic(file.file, file.text); return false; } catch { return true; }
    });
    return notRestored.length ? `could not restore ${notRestored.map((file) => file.file).join(', ')}` : 'the previous files were restored';
  }
}

function pluginVersion(home, scope) {
  const entries = own(own(readJson(path.join(home, '.claude', 'plugins', 'installed_plugins.json')).value, 'plugins'), PLUGIN_KEY);
  const entry = Array.isArray(entries) && entries.length === 1 && own(entries[0], 'scope') === scope ? own(entries[0], 'version') : null;
  return typeof entry === 'string' && VERSION.test(entry) ? entry : null;
}

function updatePlugin(found, { home, project, env, out, timeoutMs, removeUser }) {
  const steps = manualSteps(found.scope);
  out(`Marrow update: install kind Claude Code plugin (${PLUGIN_KEY}, scope ${found.scope}, version ${found.version}). No settings hook is written.`);
  const verified = () => detectAgentPlugins({ home, project }).some((item) => item.host === 'claude-code' && item.counted);
  if (removeUser && (found.scope !== 'user' || !verified())) {
    out(`Refused: --remove-user-duplicate removes the user-level hook copy only when the plugin is installed and enabled at user scope (found: scope ${found.scope}). Nothing was changed.`);
    return 1;
  }
  const claude = findClaude(env);
  if (!claude) {
    out(`The claude command was not found on PATH. Nothing was changed. Run these two commands, then /reload-plugins:\n  ${steps.join('\n  ')}`);
    return 1;
  }
  for (const argv of [MARKETPLACE_ARGV, ['plugin', 'update', PLUGIN_KEY, '-s', found.scope, '-y']]) {
    const run = spawnSync(claude, argv, { shell: false, stdio: 'ignore', timeout: timeoutMs, cwd: project, env });
    if (run.error || run.status !== 0) {
      out(`claude ${argv.slice(0, 2).join(' ')} ${run.error ? 'did not finish in time' : `failed (exit ${run.status})`}. The plugin was not updated; the old plugin (${found.version}) stays enabled and its hooks stay in place. Nothing else was changed. To retry by hand:\n  ${steps.join('\n  ')}`);
      return 1;
    }
  }
  const after = pluginVersion(home, found.scope);
  if (!after || compareVersions(after, found.version) < 0) {
    out(`Refused: the plugin version read back (${after || 'not a plain version'}) is not ${found.version} or newer. An update never downgrades; no settings hook copy was removed.`);
    return 1;
  }
  out(after === found.version ? `The plugin is already at the latest version (${after}).` : `Updated the plugin: ${found.version} -> ${after}.`);
  // R1: a copy goes on its own only in the file of the plugin's own project or local scope; a user-level copy only on the flag.
  const remove = found.copies.filter(({ file }) => (removeUser ? file.file === found.userFile : file.file === found.scopeFile && file.file !== found.userFile));
  const pluginHooks = own(readJson(path.join(home, '.claude', 'plugins', 'cache', 'getmarrow', 'marrow', after, 'hooks', 'hooks.json')).value, 'hooks');
  let left = found.copies.filter((copy) => !remove.includes(copy));
  if (remove.length) {
    const plugin = removeUser ? verified() : own(pluginHooks, 'PreToolUse');
    if (!plugin) {
      out('A Marrow hook copy in a settings file was kept: the plugin hook could not be verified for this scope. Remove it by hand after /reload-plugins.');
      left = found.copies;
    } else {
      const failed = removeCopies(remove);
      if (failed) {
        out(`Could not remove the duplicate Marrow hook copy from the settings file; ${failed}. Both copies stay until it is removed by hand.`);
        return 1;
      }
      for (const { file, hooks } of remove) out(`Removed the duplicate Marrow hook copy from ${file.file} (${hooks.filter((hook) => hook.version).length} entries); the plugin hook stays.${removeUser ? ' The user-level copy was removed as asked: a project that turned the plugin off now has no Marrow hook.' : ''}`);
    }
  }
  for (const { file, hooks } of left) out(file.file === found.userFile ? `Kept the user-level Marrow hook copy in ${file.file} (${hooks.filter((hook) => hook.version).length} entries) next to the plugin, so a project that turns the plugin off keeps a Marrow hook. To remove it, run: ${REMOVE_USER}`
    : `Kept the Marrow hook copy in ${file.file}: it is not in the scope where the plugin is enabled. Remove it by hand if it is not wanted.`);
  const counts = {};
  for (const { hooks } of left) for (const hook of hooks) if (hook.version) counts[hook.event] = (counts[hook.event] || 0) + 1;
  out(`Install kind: Claude Code plugin. Version before: ${found.version}; after: ${after}. Marrow hook copies in settings files: ${Object.keys(counts).length ? Object.entries(counts).map(([event, count]) => `${event} ${count}`).join(', ') : 'none'} (the plugin's own hooks are its one copy).`);
  if (left.length) out(`Marrow hook copies per event, the plugin included: ${Object.entries(Object.keys(pluginHooks || {}).reduce((all, event) => ({ ...all, [event]: (all[event] || 0) + 1 }), counts)).map(([event, count]) => `${event} ${count}`).join(', ')}.`);
  out('Run /reload-plugins (or restart Claude Code) to switch to the new version.');
  return 0;
}

// Runs the update for the install kind found. { done: true } when this path finished the command (process.exitCode set),
// else { done: false, before } and the existing settings-hook update goes on.
function runUpdatePath(options, { env = process.env, out = (line) => process.stdout.write(`${line}\n`), timeoutMs = CLAUDE_TIMEOUT_MS } = {}) {
  const home = path.resolve(options.home || options.cwd);
  const project = path.resolve(options.cwd || home);
  const found = classifyInstall({ home, project });
  if (options.removeUserDuplicate && found.kind !== 'plugin') Object.assign(found, { kind: 'settings', refuse: '--remove-user-duplicate works only next to a Claude Code plugin installed and enabled at user scope' });
  if (found.kind === 'settings' && !found.refuse) return { done: false, before: found.version, home, project };
  if (found.kind === 'settings') {
    out(`Marrow update refused: ${found.refuse}. Nothing was changed.`);
  } else if (found.kind === 'unknown') {
    out(`Marrow update: the install kind could not be classified (${found.reason}). Nothing was changed. To update a Claude Code plugin by hand, run:\n  ${manualSteps('<scope>').join('\n  ')}\nthen /reload-plugins. For a settings-hook install without a plugin, remove the plugin records first, then run npx -y @getmarrow/install@latest update.\n${CURSOR_STEPS}`);
  }
  process.exitCode = found.kind === 'plugin' ? updatePlugin(found, { home, project, env, out, timeoutMs, removeUser: options.removeUserDuplicate === true }) : 1;
  return { done: true };
}

// After a settings-hook update: the doctor lines, only when the pinned version moved (an up-to-date run prints as before).
function settingsUpdateSummary({ before, home, project }) {
  const hooks = settingsFiles(home, project).filter((file) => file.value).flatMap(hooksOf).filter((hook) => hook.version);
  const after = hooks.length ? hooks.map((hook) => hook.version).reduce((top, version) => (compareVersions(version, top) > 0 ? version : top)) : null;
  if (!before || !after || before === after) return [];
  const counts = {};
  for (const hook of hooks) counts[hook.event] = (counts[hook.event] || 0) + 1;
  return [`Install kind: settings hook. Version before: ${before}; after: ${after}. Marrow hook copies per event: ${Object.entries(counts).map(([event, count]) => `${event} ${count}`).join(', ')}.`];
}

module.exports = { classifyInstall, runUpdatePath, settingsUpdateSummary, marrowHookVersion };

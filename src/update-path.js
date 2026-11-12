'use strict';

// One update path: `update` and `--repair` move the Marrow install that is there to the latest version and leave one
// hook copy. A Claude Code plugin (marrow@getmarrow in installed_plugins.json, which records the scope) is updated by
// the claude CLI with fixed argv arrays and no shell; then the exact Marrow hook entries an older setup wrote next to
// the plugin are removed once the plugin hook is verified. A settings-hook install goes on to the existing rewrite,
// unless its hooks pin a newer or malformed version. Anything that cannot be classified changes nothing. Only the
// `hooks` and `enabledPlugins` keys of a settings file are used, no other value is printed, and no key file is opened.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const tty = require('node:tty');
const { spawnSync } = require('node:child_process');
const { PLUGIN_KEY, detectAgentPlugins } = require('./agent-plugins');
const { MCP_ADAPTER_VERSION } = require('./pins');
const { delocalizeHookCommand } = require('./mcp-runtime');
const { PLUGIN_PRE_ACTION_LAUNCHERS, PUBLISHED_COPY_MATCHERS, PUBLISHED_PLUGIN_MATCHERS } = require('./update-launchers');

const SCOPES = ['user', 'project', 'local'];
const MARKETPLACE = 'getmarrow';
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
// A plain X.Y.Z with no leading zeros, no prerelease and no build metadata.
const PLAIN = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,3})$/;
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

// True when a text JSON.parse accepted repeats a key inside one object (JSON.parse would keep only the last one).
function duplicateKeys(text) {
  const stack = [];
  for (const [token] of text.matchAll(/"(?:[^"\\]|\\.)*"|[{}[\],]/g)) {
    const top = stack[stack.length - 1];
    if (token === '{') stack.push({ keys: new Set(), key: true });
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token === ',') { if (top) top.key = true; } else if (top && top.key) {
      const key = JSON.parse(token);
      if (top.keys.has(key)) return true;
      top.keys.add(key);
      top.key = false;
    }
  }
  return false;
}

// True when every entry from home down to file is there and none is a symbolic link; the last one is a regular file.
function regularBelow(home, file) {
  const parts = path.relative(home, file).split(path.sep);
  if (parts[0] === '..' || path.isAbsolute(parts[0])) return false;
  let current = home;
  return parts.every((part, index) => {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      return index === parts.length - 1 ? stat.isFile() : stat.isDirectory();
    } catch {
      return false;
    }
  });
}

// A JSON object from a regular file below home with no link on the way and no repeated key, else {}.
function readStrict(home, file) {
  const read = regularBelow(home, file) ? readJson(file) : {};
  return read.value && !duplicateKeys(read.text) ? read : {};
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

// The file identity of a path: { real, dev, ino } (realpath and st_dev, st_ino), { missing } when nothing is there, or null
// when it cannot be read (a dangling link, a permission error).
function identity(file) {
  try {
    fs.lstatSync(file);
  } catch (error) {
    return error.code === 'ENOENT' || error.code === 'ENOTDIR' ? { missing: true } : null;
  }
  try {
    const stat = fs.statSync(file);
    return { real: fs.realpathSync(file), dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}
const sameFile = (a, b) => Boolean(a && b && a.real && b.real && (a.real === b.real || (a.dev === b.dev && a.ino === b.ino)));

// The user, project and local settings files, user first, one entry per file identity: a path that reaches a file seen
// before (same realpath or same st_dev and st_ino) is that file, so a project path to the user file counts as user-level.
function settingsFiles(home, project) {
  const files = [];
  for (const file of [path.join(home, '.claude', 'settings.json'), path.join(project, '.claude', 'settings.json'), path.join(project, '.claude', 'settings.local.json')]) {
    const id = identity(file);
    if (!files.some((seen) => seen.file === file || sameFile(seen.id, id))) files.push({ ...readJson(file), id });
  }
  return files;
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
  if (files.some((file) => file.id === null)) return unknown('the file identity of a Claude Code settings file could not be read');
  if (files.some((file) => file.bad)) return unknown('a Claude Code settings file could not be read');
  const scopePath = path.join(project, '.claude', scope === 'local' ? 'settings.local.json' : 'settings.json');
  const scopeId = identity(scopePath);
  const scopeFile = scope === 'user' ? files[0] : files.find((file) => file.file === scopePath || sameFile(file.id, scopeId));
  if (enabled(scopeFile) !== true || files.some((file) => enabled(file) === false)) return unknown('the plugin is not enabled');
  const copies = files.map((file) => ({ file, hooks: file.value ? hooksOf(file) : [] }));
  const strange = copies.some(({ hooks }) => hooks.some(({ hook, version: pinned }) => pinned === null && /marrow-mcp|@getmarrow\/mcp/.test(String(own(hook, 'command')))));
  if (strange) return unknown('a settings hook names the Marrow MCP in a form this installer never writes');
  const marrow = copies.filter(({ hooks }) => hooks.some((hook) => hook.version));
  if (marrow.some(({ file }) => `${JSON.stringify(file.value, null, 2)}\n` !== file.text)) return unknown('a settings file with a Marrow hook copy is not in the form the installer writes');
  return { kind: 'plugin', scope, version, installPath: own(entries[0], 'installPath'), copies: marrow, scopeFile: scopeFile.file, userFile: files[0].file };
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

// Removes only the exact Marrow hooks of one file; a group keeps its other hooks, an emptied group or event goes. The
// temp-file-and-rename write leaves the previous file in place when it fails.
function removeCopy({ file, hooks }) {
  try {
    const value = JSON.parse(file.text);
    for (const event of new Set(hooks.filter((hook) => hook.version).map((hook) => hook.event))) {
      value.hooks[event] = value.hooks[event]
        .map((group) => (Array.isArray(own(group, 'hooks')) ? { ...group, hooks: group.hooks.filter((hook) => !marrowHookVersion(event, hook)) } : group))
        .filter((group) => !Array.isArray(own(group, 'hooks')) || group.hooks.length > 0);
      if (value.hooks[event].length === 0) delete value.hooks[event];
    }
    writeAtomic(file.file, `${JSON.stringify(value, null, 2)}\n`);
    return null;
  } catch {
    return 'the previous files were restored';
  }
}

// R1: why the plugin hook in this scope cannot stand in for the hook copy, or null when (a) the plugin record for the
// scope is installed and enabled, (b) its hooks file is a regular strict-JSON file with a PreToolUse entry whose matcher
// is byte-equal to a published plugin matcher while each PreToolUse matcher of the copy is byte-equal to a published copy
// matcher, (c) that entry's command is byte-equal to a published launcher command, (d) the launcher file it names is
// inside the installed plugin folder and (e) an automatic removal is not in the user settings file by file identity.
// Read again immediately before the write.
const publishedMatcher = (list, matcher) => list.some((item) => item.matcher === matcher);
function pluginHookProblem({ home, project }, scope, copy, userLevel) {
  const found = classifyInstall({ home, project });
  if (found.kind !== 'plugin' || found.scope !== scope) return 'the plugin is not installed and enabled in this scope';
  const folder = path.join(home, '.claude', 'plugins', 'cache', MARKETPLACE, 'marrow', found.version);
  if (found.installPath !== folder) return 'the plugin record does not point to the getmarrow plugin folder';
  const pre = own(own(readStrict(home, path.join(folder, 'hooks', 'hooks.json')).value, 'hooks'), 'PreToolUse');
  const entries = (Array.isArray(pre) ? pre : []).flatMap((group) => (Array.isArray(own(group, 'hooks')) ? group.hooks.flatMap((hook) => (
    PLUGIN_PRE_ACTION_LAUNCHERS.filter((item) => own(hook, 'type') === 'command' && own(hook, 'command') === item.command).map((item) => ({ matcher: own(group, 'matcher'), item }))
  )) : []));
  if (!entries.length) return 'the plugin hooks file has no Marrow pre-action launcher command';
  const wanted = copy.hooks.filter((hook) => hook.version && hook.event === 'PreToolUse').map(({ group }) => own(group, 'matcher'));
  if (!wanted.every((matcher) => publishedMatcher(PUBLISHED_COPY_MATCHERS, matcher))) return 'the PreToolUse matcher of the copy is not a published installer matcher';
  const covering = entries.filter(({ matcher }) => publishedMatcher(PUBLISHED_PLUGIN_MATCHERS, matcher));
  if (!covering.length) return 'the plugin pre-action matcher is not a published plugin matcher';
  if (!covering.some(({ item }) => regularBelow(home, path.join(folder, ...item.launcher)))) return 'the plugin launcher file is missing';
  const now = identity(copy.file.file);
  if (!sameFile(now, copy.file.id) || (!userLevel && sameFile(now, identity(found.userFile)))) return 'the file identity of the settings file changed or is the user settings file';
  return readJson(copy.file.file).text === copy.file.text ? null : 'the settings file changed during the update';
}

// The version the getmarrow marketplace offers for marrow, from Claude Code's local marketplace copy (read only):
// known_marketplaces.json names its folder, its marketplace.json lists marrow once with a local source folder, and that
// folder's plugin.json holds the version. { version } or { why }.
function offeredVersion(home) {
  const plugins = path.join(home, '.claude', 'plugins');
  const folder = path.join(plugins, 'marketplaces', MARKETPLACE);
  if (own(own(readStrict(home, path.join(plugins, 'known_marketplaces.json')).value, MARKETPLACE), 'installLocation') !== folder) return { why: 'the getmarrow marketplace is not listed at its own folder' };
  const market = readStrict(home, path.join(folder, '.claude-plugin', 'marketplace.json')).value;
  const listed = Array.isArray(own(market, 'plugins')) ? market.plugins.filter((entry) => own(entry, 'name') === 'marrow') : [];
  if (own(market, 'name') !== MARKETPLACE || listed.length !== 1) return { why: 'the getmarrow marketplace does not list marrow exactly once' };
  const source = own(listed[0], 'source');
  if (typeof source !== 'string' || !/^\.\/[A-Za-z0-9._/-]{1,200}$/.test(source) || source.split('/').includes('..')) return { why: 'the marrow entry has no local source folder' };
  const manifest = readStrict(home, path.join(folder, source, '.claude-plugin', 'plugin.json')).value;
  const version = own(manifest, 'version');
  if (own(manifest, 'name') !== 'marrow' || typeof version !== 'string') return { why: 'the offered plugin.json could not be read' };
  if (own(listed[0], 'version') !== undefined && own(listed[0], 'version') !== version) return { why: 'the marketplace entry and plugin.json name different versions' };
  return { version };
}

// R2: { refuse } | { current } | { higher }; the update is called only for a plain offered version above the plain
// installed one.
function offeredAnswer(home, installed) {
  const offered = offeredVersion(home);
  if (offered.why) return { refuse: `the offered version could not be read (${offered.why})` };
  if (!PLAIN.test(offered.version) || !PLAIN.test(installed)) return { refuse: 'the offered or the installed version is not a plain X.Y.Z version' };
  const order = compareVersions(offered.version, installed);
  if (order < 0) return { refuse: `the getmarrow marketplace offers ${offered.version}, lower than the installed ${installed}; an update never downgrades` };
  return order === 0 ? { current: true } : { higher: offered.version };
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
  const call = (argv) => {
    const run = spawnSync(claude, argv, { shell: false, stdio: 'ignore', timeout: timeoutMs, cwd: project, env });
    if (!run.error && run.status === 0) return true;
    out(`claude ${argv.slice(0, 2).join(' ')} ${run.error ? 'did not finish in time' : `failed (exit ${run.status})`}. The plugin was not updated; the old plugin (${found.version}) stays enabled and its hooks stay in place. Nothing else was changed. To retry by hand:\n  ${steps.join('\n  ')}`);
    return false;
  };
  // R2: the offered version is read before any claude command, and again after the marketplace refresh.
  const refused = (answer) => {
    out(`Refused: ${answer.refuse}. claude plugin update was not run; the plugin (${found.version}) and its hooks stay as they are, and nothing else was changed.`);
    return 1;
  };
  const first = offeredAnswer(home, found.version);
  if (first.refuse) return refused(first);
  if (!call(MARKETPLACE_ARGV)) return 1;
  const offered = offeredAnswer(home, found.version);
  if (offered.refuse) return refused(offered);
  if (offered.current) out(`The plugin is already current: the getmarrow marketplace offers ${found.version}, the installed version.`);
  else if (!call(['plugin', 'update', PLUGIN_KEY, '-s', found.scope, '-y'])) return 1;
  const after = pluginVersion(home, found.scope);
  if (!after || compareVersions(after, found.version) < 0) {
    out(`Refused: the plugin version read back (${after || 'not a plain version'}) is not ${found.version} or newer. An update never downgrades; no settings hook copy was removed. To restore ${found.version} or newer, run once the getmarrow marketplace offers it:\n  ${steps.join('\n  ')}\nthen /reload-plugins.`);
    return 1;
  }
  out(after === found.version ? `The plugin is already at the latest version (${after}).` : `Updated the plugin: ${found.version} -> ${after}.`);
  // R1: a copy goes on its own only in the file of the plugin's own project or local scope; a user-level copy only on the flag.
  const remove = found.copies.find(({ file }) => (removeUser ? file.file === found.userFile : file.file === found.scopeFile && file.file !== found.userFile));
  const pluginHooks = own(readJson(path.join(home, '.claude', 'plugins', 'cache', 'getmarrow', 'marrow', after, 'hooks', 'hooks.json')).value, 'hooks');
  let left = found.copies.filter((copy) => copy !== remove);
  if (remove) {
    const problem = removeUser && !verified() ? 'the user-scope plugin is not counted' : pluginHookProblem({ home, project }, found.scope, remove, removeUser);
    if (problem) {
      out(`A Marrow hook copy in a settings file was kept: the plugin hook could not be verified for this scope (${problem}). Nothing was changed in ${remove.file.file}. Remove it by hand after /reload-plugins.`);
      left = found.copies;
    } else {
      const failed = removeCopy(remove);
      if (failed) {
        out(`Could not remove the duplicate Marrow hook copy from the settings file; ${failed}. Both copies stay until it is removed by hand.`);
        return 1;
      }
      out(`Removed the duplicate Marrow hook copy from ${remove.file.file} (${remove.hooks.filter((hook) => hook.version).length} entries); the plugin hook stays.${removeUser ? ' The user-level copy was removed as asked: a project that turned the plugin off now has no Marrow hook.' : ''}`);
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

// R4: --remove-user-duplicate is an owner-terminal action: stdin and stdout must both be a TTY and the owner must type
// the confirmation word printed here (a new one each run). Anything else refuses before anything is read or run.
function readTerminalLine() {
  const byte = Buffer.alloc(1);
  let line = '';
  try {
    while (line.length < 256) {
      if (fs.readSync(0, byte, 0, 1, null) === 0) return null;
      if (byte[0] === 10) return line.replace(/\r$/, '');
      line += String.fromCharCode(byte[0]);
    }
  } catch { /* not readable: refused below */ }
  return null;
}
const OWNER_TERMINAL = Object.freeze({ isTTY: (fd) => tty.isatty(fd), readLine: readTerminalLine });

function confirmedByOwner(out, terminal) {
  if (!terminal.isTTY(0) || !terminal.isTTY(1)) {
    out('Refused: --remove-user-duplicate runs only in an owner terminal (stdin and stdout a TTY) with the typed confirmation word. Nothing was changed.');
    return false;
  }
  const word = `remove-${crypto.randomBytes(3).toString('hex')}`;
  out(`To remove the user-level Marrow hook copy, type the confirmation word ${word} and press Enter:`);
  if (terminal.readLine() === word) return true;
  out('Refused: the confirmation word was not typed. Nothing was changed.');
  return false;
}

// Runs the update for the install kind found. { done: true } when this path finished the command (process.exitCode set),
// else { done: false, before } and the existing settings-hook update goes on.
function runUpdatePath(options, { env = process.env, out = (line) => process.stdout.write(`${line}\n`), timeoutMs = CLAUDE_TIMEOUT_MS, terminal = OWNER_TERMINAL } = {}) {
  if (options.removeUserDuplicate && !confirmedByOwner(out, terminal)) {
    process.exitCode = 1;
    return { done: true };
  }
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

module.exports = { classifyInstall, runUpdatePath, settingsUpdateSummary, marrowHookVersion, settingsFiles, publishedMatcher };

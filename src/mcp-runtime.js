'use strict';

// A private local copy of the pinned @getmarrow/mcp, so hooks start it directly instead of
// through npx (npx costs 0.6 to 1.3 s per gated tool call before Marrow is contacted).
//
// Layout (all owner-only, directories 0700):
//   ~/.marrow/runtime/mcp/<version>/node_modules/...   the package, installed with --ignore-scripts
//   ~/.marrow/runtime/mcp/<version>/.verified          integrity record (0600)
//   ~/.marrow/runtime/mcp/<version>/launch.cjs         checks the files, then runs the entrypoint
//   ~/.marrow/runtime/mcp/<version>/run                /bin/sh script: absolute node + launch.cjs
//   ~/.marrow/runtime/mcp/<version>/node               link to the node binary captured at install
//
// The package's integrity is checked against the pin (or the registry-verified update target)
// when it is installed. Every start re-checks the installed files against the record; if the
// copy is missing, changed or its node is gone, the same entrypoint runs through npx exactly as
// before, so a hook keeps its fail-closed behaviour. Hook commands reach the runtime through
// $HOME, so project hook files stay the same for every user and name no local path.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RUNTIME_SCHEMA = 'marrow-mcp-runtime.v1';
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]{86}==$/;
// Paths written into the run script, quoted with single quotes: no quote, backslash or newline.
const SAFE_PATH_RE = /^[^'\\\n\r\0]+$/;
const NPM_INSTALL_TIMEOUT_MS = 180_000;

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function runtimeRoot(home) {
  return path.join(home, '.marrow', 'runtime', 'mcp');
}

function runtimeDir(home, version) {
  return path.join(runtimeRoot(home), version);
}

// A directory Marrow owns: a real directory (not a link) owned by this user, not writable by
// others; created 0700 when missing.
function ensurePrivateDirectory(directory) {
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  const stat = fs.lstatSync(directory);
  const uid = currentUid();
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== null && stat.uid !== uid)) {
    throw new Error(`unsafe runtime directory ${directory}`);
  }
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(directory, 0o700);
}

function privateDirectoryOk(directory) {
  try {
    const stat = fs.lstatSync(directory);
    const uid = currentUid();
    return stat.isDirectory() && !stat.isSymbolicLink() && (uid === null || stat.uid === uid) && (stat.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function listFiles(base, relative = '') {
  const directory = path.join(base, relative);
  const out = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`unexpected link in runtime package: ${rel}`);
    if (entry.isDirectory()) out.push(...listFiles(base, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

// The installed package files, as the launcher hashes them on every start.
function packageFiles(directory) {
  return listFiles(directory, 'node_modules').filter((file) => file !== 'node_modules/.package-lock.json');
}

function manifestDigest(directory, files) {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(directory, file)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

const LAUNCHER_SOURCE = `'use strict';
// Written by @getmarrow/install. Runs the verified local @getmarrow/mcp. When the copy is
// missing or any of its files changed, the same entrypoint runs through npx instead.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const args = process.argv.slice(2);
function verifiedEntry() {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(__dirname, '.verified'), 'utf8'));
    if (record.schema !== ${JSON.stringify(RUNTIME_SCHEMA)}) return null;
    if (args[0] !== '--package=@getmarrow/mcp@' + record.version || args[1] !== 'marrow-mcp') return null;
    const hash = crypto.createHash('sha256');
    for (const file of record.files) {
      hash.update(file);
      hash.update('\\0');
      hash.update(fs.readFileSync(path.join(__dirname, file)));
      hash.update('\\0');
    }
    return hash.digest('hex') === record.manifest_sha256 ? path.join(__dirname, record.bin) : null;
  } catch {
    return null;
  }
}
const entry = verifiedEntry();
if (entry) {
  process.argv = [process.argv[0], entry, ...args.slice(2)];
  require(entry);
} else {
  const { spawn } = require('child_process');
  const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['-y', ...args], { stdio: 'inherit' });
  child.on('error', () => process.exit(1));
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code === null ? 1 : code);
  });
}
`;

function runScript(nodePath, launcherPath) {
  return [
    '#!/bin/sh',
    '# Written by @getmarrow/install: the verified local @getmarrow/mcp, or npx when it is gone.',
    `if [ -x '${nodePath}' ] && [ -f '${launcherPath}' ]; then exec '${nodePath}' '${launcherPath}' "$@"; fi`,
    'exec npx -y "$@"',
    '',
  ].join('\n');
}

function readRecord(directory) {
  try {
    const stat = fs.lstatSync(path.join(directory, '.verified'));
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) return null;
    const record = JSON.parse(fs.readFileSync(path.join(directory, '.verified'), 'utf8'));
    return record && record.schema === RUNTIME_SCHEMA ? record : null;
  } catch {
    return null;
  }
}

// The runtime for one version, when its record matches the expected integrity and its files
// still hash to the record. Returns null otherwise.
function verifyMcpRuntime(home, version, integrity) {
  if (!home || !VERSION_RE.test(String(version || ''))) return null;
  const directory = runtimeDir(home, version);
  if (![path.join(home, '.marrow'), path.dirname(runtimeRoot(home)), runtimeRoot(home), directory].every(privateDirectoryOk)) return null;
  const record = readRecord(directory);
  if (!record || record.version !== version) return null;
  if (integrity && record.integrity !== integrity) return null;
  try {
    const files = packageFiles(directory);
    if (JSON.stringify(files) !== JSON.stringify(record.files)) return null;
    if (manifestDigest(directory, files) !== record.manifest_sha256) return null;
    if (fs.readFileSync(path.join(directory, 'launch.cjs'), 'utf8') !== LAUNCHER_SOURCE) return null;
    const runStat = fs.statSync(path.join(directory, 'run'));
    if (!runStat.isFile() || (runStat.mode & 0o100) === 0) return null;
    const nodeTarget = fs.readlinkSync(path.join(directory, 'node'));
    if (fs.readFileSync(path.join(directory, 'run'), 'utf8') !== runScript(nodeTarget, path.join(directory, 'launch.cjs'))) return null;
  } catch {
    return null;
  }
  return { state: 'verified', version, directory, run: path.join(directory, 'run'), node: path.join(directory, 'node') };
}

function defaultNpmInstall(stage, specs) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error', ...specs], {
    cwd: stage,
    env: process.env,
    stdio: 'ignore',
    timeout: NPM_INSTALL_TIMEOUT_MS,
  });
  return result.status === 0;
}

function removeQuietly(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch {
    // Best effort: a leftover directory is cleaned on the next install or update.
  }
}

// Removes every runtime version except `keep` (and leftover staging directories).
function removeOtherRuntimes(home, keep) {
  const root = runtimeRoot(home);
  const removed = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root);
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (entry === keep) continue;
    removeQuietly(path.join(root, entry));
    removed.push(entry);
  }
  return removed;
}

// Installs (or keeps) the runtime for one MCP version whose tarball integrity is known.
// `sdk` is the pinned SDK { version, integrity }; when the installed SDK has that version, its
// integrity must match too. Never throws: a failure leaves hooks on npx.
function ensureMcpRuntime({ home, version, integrity, sdk = null, nodePath = process.execPath, npmInstall = defaultNpmInstall, platform = process.platform } = {}) {
  if (platform === 'win32') return { state: 'unsupported', reason: 'windows' };
  if (!home || !VERSION_RE.test(String(version || '')) || !INTEGRITY_RE.test(String(integrity || ''))) {
    return { state: 'skipped', reason: 'no_verified_integrity' };
  }
  const existing = verifyMcpRuntime(home, version, integrity);
  if (existing) {
    const removed = removeOtherRuntimes(home, version);
    return { ...existing, state: 'present', removed_versions: removed };
  }
  const directory = runtimeDir(home, version);
  if (!SAFE_PATH_RE.test(directory) || !SAFE_PATH_RE.test(String(nodePath || '')) || !path.isAbsolute(String(nodePath || ''))) {
    return { state: 'skipped', reason: 'unsafe_path' };
  }
  let stage = null;
  try {
    ensurePrivateDirectory(path.join(home, '.marrow'));
    ensurePrivateDirectory(path.dirname(runtimeRoot(home)));
    ensurePrivateDirectory(runtimeRoot(home));
    stage = path.join(runtimeRoot(home), `.stage-${version}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`);
    fs.mkdirSync(stage, { mode: 0o700 });
    const dependencies = { '@getmarrow/mcp': version };
    if (sdk && VERSION_RE.test(String(sdk.version || ''))) dependencies['@getmarrow/sdk'] = sdk.version;
    fs.writeFileSync(path.join(stage, 'package.json'), `${JSON.stringify({ name: 'marrow-mcp-runtime', private: true, dependencies }, null, 2)}\n`, { mode: 0o600 });
    const specs = Object.entries(dependencies).map(([name, spec]) => `${name}@${spec}`);
    if (!npmInstall(stage, specs)) return { state: 'failed', reason: 'npm_install_failed' };
    const lock = JSON.parse(fs.readFileSync(path.join(stage, 'package-lock.json'), 'utf8'));
    const packages = lock && typeof lock.packages === 'object' && lock.packages ? lock.packages : {};
    const mcp = packages['node_modules/@getmarrow/mcp'] || {};
    if (mcp.version !== version || mcp.integrity !== integrity) return { state: 'failed', reason: 'integrity_mismatch' };
    const sdkEntry = packages['node_modules/@getmarrow/sdk'];
    if (sdk && sdkEntry && sdkEntry.version === sdk.version && sdkEntry.integrity !== sdk.integrity) {
      return { state: 'failed', reason: 'sdk_integrity_mismatch' };
    }
    for (const [key, entry] of Object.entries(packages)) {
      if (key === '') continue;
      if (!entry || typeof entry.integrity !== 'string' || !/^sha512-/.test(entry.integrity)) return { state: 'failed', reason: 'unverified_dependency' };
    }
    const installed = JSON.parse(fs.readFileSync(path.join(stage, 'node_modules', '@getmarrow', 'mcp', 'package.json'), 'utf8'));
    if (installed.name !== '@getmarrow/mcp' || installed.version !== version) return { state: 'failed', reason: 'package_mismatch' };
    const binRelative = typeof installed.bin === 'object' && installed.bin ? installed.bin['marrow-mcp'] : null;
    if (typeof binRelative !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(binRelative) || binRelative.includes('..')) {
      return { state: 'failed', reason: 'package_entry_missing' };
    }
    const bin = `node_modules/@getmarrow/mcp/${binRelative.replace(/^\.\//, '')}`;
    const files = packageFiles(stage);
    if (!files.includes(bin)) return { state: 'failed', reason: 'package_entry_missing' };
    const launcher = path.join(directory, 'launch.cjs');
    fs.writeFileSync(path.join(stage, 'launch.cjs'), LAUNCHER_SOURCE, { mode: 0o600 });
    fs.writeFileSync(path.join(stage, 'run'), runScript(nodePath, launcher), { mode: 0o700 });
    fs.symlinkSync(nodePath, path.join(stage, 'node'));
    fs.writeFileSync(path.join(stage, '.verified'), `${JSON.stringify({
      schema: RUNTIME_SCHEMA,
      version,
      integrity,
      sdk_version: sdkEntry ? sdkEntry.version : null,
      bin,
      files,
      manifest_sha256: manifestDigest(stage, files),
      installed_at: new Date().toISOString(),
    }, null, 2)}\n`, { mode: 0o600 });
    removeQuietly(directory);
    fs.renameSync(stage, directory);
    stage = null;
    const verified = verifyMcpRuntime(home, version, integrity);
    if (!verified) return { state: 'failed', reason: 'verification_failed' };
    const removed = removeOtherRuntimes(home, version);
    return { ...verified, state: 'installed', removed_versions: removed };
  } catch (error) {
    return { state: 'failed', reason: error && /unsafe runtime directory/.test(error.message) ? 'unsafe_directory' : 'install_error' };
  } finally {
    if (stage) removeQuietly(stage);
  }
}

function removeMcpRuntime(home, { dryRun = false } = {}) {
  const root = path.dirname(runtimeRoot(home));
  if (!fs.existsSync(root)) return { removed: false, path: root };
  if (!dryRun) removeQuietly(root);
  return { removed: !dryRun, would_remove: dryRun, path: root };
}

// ---------------------------------------------------------------------------
// Hook commands: the canonical npx form <-> the local runtime form.
// ---------------------------------------------------------------------------

const ARGS = '--package=@getmarrow/mcp@(\\d+\\.\\d+\\.\\d+) marrow-mcp ([a-z][a-z-]{0,63})';
const RUN = (version) => `$HOME/.marrow/runtime/mcp/${version}/run`;
const NODE = (version) => `$HOME/.marrow/runtime/mcp/${version}/node`;

// 1. A plain entrypoint command.
function localPlain(version, sub) {
  const args = `--package=@getmarrow/mcp@${version} marrow-mcp ${sub}`;
  return `/bin/sh -c 'M="${RUN(version)}"; if [ -x "$M" ]; then exec "$M" ${args}; fi; exec npx -y ${args}'`;
}
const LOCAL_PLAIN_RE = new RegExp(`^/bin/sh -c 'M="\\$HOME/\\.marrow/runtime/mcp/(\\d+\\.\\d+\\.\\d+)/run"; if \\[ -x "\\$M" \\]; then exec "\\$M" ${ARGS}; fi; exec npx -y --package=@getmarrow/mcp@\\2 marrow-mcp \\3'$`);
const CANONICAL_PLAIN_RE = new RegExp(`^npx -y ${ARGS}$`);

// 2. An entrypoint inside an `sh -c '...'` wrapper (Windsurf, Gemini).
function localInner(version, sub) {
  const args = `--package=@getmarrow/mcp@${version} marrow-mcp ${sub}`;
  return `{ M="${RUN(version)}"; if [ -x "$M" ]; then "$M" ${args}; else npx -y ${args}; fi; }`;
}
const LOCAL_INNER_RE = new RegExp(`\\{ M="\\$HOME/\\.marrow/runtime/mcp/(\\d+\\.\\d+\\.\\d+)/run"; if \\[ -x "\\$M" \\]; then "\\$M" ${ARGS}; else npx -y --package=@getmarrow/mcp@\\2 marrow-mcp \\3; fi; \\}`, 'g');
const CANONICAL_INNER_RE = new RegExp(`npx -y ${ARGS}`, 'g');

// 3. A node guard (`node -e '...'`) that spawns the entrypoint through npx.
const SPAWN_NPX = 'spawn(process.platform==="win32"?"npx.cmd":"npx",';
function localSpawn(version, argsJson) {
  return `spawn(...((f,m,a)=>f.existsSync(m)?[m,a.slice(1)]:[process.platform==="win32"?"npx.cmd":"npx",a])(require("node:fs"),(process.env.HOME||"")+${JSON.stringify(`/.marrow/runtime/mcp/${version}/run`)},${argsJson}),`;
}
const LOCAL_SPAWN_RE = /spawn\(\.\.\.\(\(f,m,a\)=>f\.existsSync\(m\)\?\[m,a\.slice\(1\)\]:\[process\.platform==="win32"\?"npx\.cmd":"npx",a\]\)\(require\("node:fs"\),\(process\.env\.HOME\|\|""\)\+"\/\.marrow\/runtime\/mcp\/\d+\.\d+\.\d+\/run",(\["-y","--package=@getmarrow\/mcp@\d+\.\d+\.\d+","marrow-mcp","[a-z-]+"\])\),/g;
const CANONICAL_SPAWN_RE = /spawn\(process\.platform==="win32"\?"npx\.cmd":"npx",(\["-y","--package=@getmarrow\/mcp@(\d+\.\d+\.\d+)","marrow-mcp","[a-z-]+"\]),/g;
const localGuardPrefix = (version) => `N="${NODE(version)}"; [ -x "$N" ] || N=node; exec "$N" -e '`;
const LOCAL_GUARD_PREFIX_RE = /^N="\$HOME\/\.marrow\/runtime\/mcp\/\d+\.\d+\.\d+\/node"; \[ -x "\$N" \] \|\| N=node; exec "\$N" -e '/;

// The canonical (npx) form of a hook command; any other command is returned unchanged.
function delocalizeHookCommand(command) {
  if (typeof command !== 'string') return command;
  const plain = command.match(LOCAL_PLAIN_RE);
  if (plain && plain[1] === plain[2]) return `npx -y --package=@getmarrow/mcp@${plain[2]} marrow-mcp ${plain[3]}`;
  if (LOCAL_GUARD_PREFIX_RE.test(command)) {
    return command.replace(LOCAL_GUARD_PREFIX_RE, 'node -e \'').replace(LOCAL_SPAWN_RE, `${SPAWN_NPX}$1,`);
  }
  if (command.startsWith('/bin/sh -c \'') && LOCAL_INNER_RE.test(command)) {
    LOCAL_INNER_RE.lastIndex = 0;
    const inner = command.replace(LOCAL_INNER_RE, (match, runVersion, version, sub) => (
      runVersion === version ? `npx -y --package=@getmarrow/mcp@${version} marrow-mcp ${sub}` : match
    ));
    return inner === command ? command : `sh -c '${inner.slice('/bin/sh -c \''.length)}`;
  }
  return command;
}

// The local runtime form of a canonical hook command for `version`, or the command unchanged
// when it is not a Marrow entrypoint for that version. The result always maps back exactly.
function localizeHookCommand(command, version) {
  if (typeof command !== 'string' || !VERSION_RE.test(String(version || ''))) return command;
  let local = command;
  const plain = command.match(CANONICAL_PLAIN_RE);
  if (plain) {
    if (plain[1] !== version) return command;
    local = localPlain(version, plain[2]);
  } else if (command.startsWith('node -e \'') && command.includes(SPAWN_NPX)) {
    let matched = false;
    const body = command.slice('node -e \''.length).replace(CANONICAL_SPAWN_RE, (match, argsJson, specVersion) => {
      if (specVersion !== version) return match;
      matched = true;
      return localSpawn(version, argsJson);
    });
    if (!matched) return command;
    local = `${localGuardPrefix(version)}${body}`;
  } else if (command.startsWith('sh -c \'')) {
    let matched = false;
    const body = command.slice('sh -c \''.length).replace(CANONICAL_INNER_RE, (match, specVersion, sub) => {
      if (specVersion !== version) return match;
      matched = true;
      return localInner(version, sub);
    });
    if (!matched) return command;
    local = `/bin/sh -c '${body}`;
  } else {
    return command;
  }
  return delocalizeHookCommand(local) === command ? local : command;
}

// Every `command` string in a parsed hook settings object.
function mapHookCommands(value, map) {
  if (Array.isArray(value)) return value.map((entry) => mapHookCommands(entry, map));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    key === 'command' && typeof entry === 'string' ? map(entry) : mapHookCommands(entry, map),
  ]));
}

// Hook settings text with Marrow's entrypoints for `version` switched to the local runtime.
function localizeHookSettingsText(text, version) {
  if (typeof text !== 'string' || !text.trim()) return text;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  let changed = false;
  const mapped = mapHookCommands(parsed, (command) => {
    const local = localizeHookCommand(command, version);
    if (local !== command) changed = true;
    return local;
  });
  return changed ? `${JSON.stringify(mapped, null, 2)}\n` : text;
}

module.exports = {
  RUNTIME_SCHEMA,
  LAUNCHER_SOURCE,
  delocalizeHookCommand,
  ensureMcpRuntime,
  localizeHookCommand,
  localizeHookSettingsText,
  mapHookCommands,
  removeMcpRuntime,
  runtimeDir,
  runtimeRoot,
  verifyMcpRuntime,
};

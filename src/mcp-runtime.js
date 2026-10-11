'use strict';

// A private local copy of the pinned @getmarrow/mcp, so hooks start it directly instead of
// through npx (npx costs 0.6 to 1.3 s per gated tool call before Marrow is contacted, and it
// resolves the package from the project directory first: a copy planted in the project's
// node_modules, or a project npm config naming another registry, would decide every hook).
//
// Layout (all owner-only, directories 0700):
//   ~/.marrow/runtime/mcp/<version>/node_modules/...   the package, installed with --ignore-scripts
//   ~/.marrow/runtime/mcp/<version>/.verified          integrity record (0600)
//   ~/.marrow/runtime/mcp/<version>/launch.cjs         checks the files, then runs the entrypoint
//   ~/.marrow/runtime/mcp/<version>/run                /bin/sh script: absolute node + launch.cjs
//   ~/.marrow/runtime/mcp/<version>/node               link to the node binary captured at install
// (On Windows there is no run script or node link: hooks start launch.cjs with node.)
//
// The package's integrity is checked against the pin (or the registry-verified update target)
// when it is installed, from a private staging directory with npm's environment overrides
// removed. Every start re-checks the installed files against the record. Nothing ever falls
// back to npx: when the copy is missing or changed, a pre-action hook holds the call (exit 2
// with a fixed repair message) and every other entrypoint exits 1. Hook commands reach the
// runtime through $HOME, so project hook files stay the same for every user and name no local path.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RUNTIME_SCHEMA = 'marrow-mcp-runtime.v1';
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]{86}==$/;
// Paths written into the run script, quoted with single quotes: no quote, backslash or newline.
const SAFE_PATH_RE = /^[^'\\\n\r\0]+$/;
// A black-holed registry must not hold an install for minutes.
const NPM_INSTALL_TIMEOUT_MS = 30_000;
const PRE_ACTION_SUB_RE = /-pre-action-hook$/;
// The fixed texts a hook prints when no verified copy can start. They name no key, path or
// input, and contain no quote, $, %, !, backslash or backtick, so every hook form (sh, node -e
// in any shell) can carry them literally.
const REPAIR_STEP = 'The owner can repair it by running npx -y @getmarrow/install@latest --repair --cwd <project folder> from a terminal outside the project.';
const HOLD_TEXT = `Marrow held this action: its verified local runtime could not start. ${REPAIR_STEP}`;
const UNAVAILABLE_TEXT = `Marrow could not start its verified local runtime. ${REPAIR_STEP}`;

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function runtimeRoot(home) {
  return path.join(home, '.marrow', 'runtime', 'mcp');
}

function runtimeDir(home, version) {
  return path.join(runtimeRoot(home), version);
}

function failureText(sub) {
  return PRE_ACTION_SUB_RE.test(String(sub || '')) ? HOLD_TEXT : UNAVAILABLE_TEXT;
}

function failureStatus(sub) {
  return PRE_ACTION_SUB_RE.test(String(sub || '')) ? 2 : 1;
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

function privateDirectoryOk(directory, platform = process.platform) {
  try {
    const stat = fs.lstatSync(directory);
    const uid = currentUid();
    return stat.isDirectory() && !stat.isSymbolicLink() && (uid === null || stat.uid === uid)
      && (platform === 'win32' || (stat.mode & 0o077) === 0);
  } catch {
    return false;
  }
}

// Every entry under `relative`, checked with lstat: anything that is not a plain file or
// directory (a link, FIFO, socket or device) and anything writable by every user rejects the
// whole copy. npm's .bin links are skipped; the runtime is never started through them.
function listFiles(base, relative = '', platform = process.platform) {
  const directory = path.join(base, relative);
  const out = [];
  for (const name of fs.readdirSync(directory).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))) {
    const rel = relative ? `${relative}/${name}` : name;
    if (rel === 'node_modules/.bin') continue;
    const stat = fs.lstatSync(path.join(base, rel));
    if (platform !== 'win32' && (stat.mode & 0o002) !== 0) throw new Error(`world-writable entry in runtime package: ${rel}`);
    if (stat.isDirectory()) out.push(...listFiles(base, rel, platform));
    else if (stat.isFile()) out.push(rel);
    else throw new Error(`unexpected entry in runtime package: ${rel}`);
  }
  return out;
}

// The installed package files, as the launcher hashes them on every start (npm's own lock copy
// and any .bin links are not package files). node_modules itself must be a real directory.
function packageFiles(directory, platform = process.platform) {
  const stat = fs.lstatSync(path.join(directory, 'node_modules'));
  if (!stat.isDirectory()) throw new Error('runtime node_modules is not a directory');
  return listFiles(directory, 'node_modules', platform).filter((file) => file !== 'node_modules/.package-lock.json');
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
// Written by @getmarrow/install. Runs the verified local @getmarrow/mcp and nothing else: when
// the copy is missing or any of its files changed, a pre-action hook is held (exit 2, fixed
// text on stderr) and every other entrypoint exits 1. It never falls back to npx.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const args = process.argv.slice(2);
const POSIX = process.platform !== 'win32';
const uid = typeof process.getuid === 'function' ? process.getuid() : null;
const owned = (stat) => !POSIX || uid === null || stat.uid === uid;
// Every package file now present, listed as at install: an added file is a change too, and a
// link, FIFO, socket, device or world-writable entry rejects the copy.
function listFiles(relative) {
  const out = [];
  const names = fs.readdirSync(path.join(__dirname, relative)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of names) {
    const rel = relative + '/' + name;
    if (rel === 'node_modules/.bin') continue;
    const stat = fs.lstatSync(path.join(__dirname, rel));
    if (POSIX && (stat.mode & 0o002) !== 0) throw new Error('writable');
    if (stat.isDirectory()) out.push(...listFiles(rel));
    else if (stat.isFile()) out.push(rel);
    else throw new Error('type');
  }
  return out;
}
function verifiedEntry() {
  try {
    const dir = fs.lstatSync(__dirname);
    if (!dir.isDirectory() || !owned(dir) || (POSIX && (dir.mode & 0o077) !== 0)) return null;
    const recordStat = fs.lstatSync(path.join(__dirname, '.verified'));
    if (!recordStat.isFile() || !owned(recordStat) || (POSIX && (recordStat.mode & 0o077) !== 0)) return null;
    if (!fs.lstatSync(path.join(__dirname, 'node_modules')).isDirectory()) return null;
    const record = JSON.parse(fs.readFileSync(path.join(__dirname, '.verified'), 'utf8'));
    if (record.schema !== ${JSON.stringify(RUNTIME_SCHEMA)}) return null;
    if (args[0] !== '--package=@getmarrow/mcp@' + record.version || args[1] !== 'marrow-mcp') return null;
    const present = listFiles('node_modules').filter((file) => file !== 'node_modules/.package-lock.json');
    if (JSON.stringify(present) !== JSON.stringify(record.files)) return null;
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
  // Any argument naming a pre-action entrypoint holds, so an unexpected argument shape never
  // turns a hold into a non-blocking failure.
  const pre = args.some((arg) => ${PRE_ACTION_SUB_RE.toString()}.test(String(arg)));
  process.stderr.write((pre ? ${JSON.stringify(HOLD_TEXT)} : ${JSON.stringify(UNAVAILABLE_TEXT)}) + '\\n');
  process.exitCode = pre ? 2 : 1;
}
`;

// The run script: the captured node (or node on PATH when that binary is gone) on the launcher,
// which verifies the copy itself. With no launcher, the fixed hold or failure; never npx.
function runScript(nodePath, launcherPath) {
  return [
    '#!/bin/sh',
    '# Written by @getmarrow/install: the verified local @getmarrow/mcp. It never falls back to npx.',
    `if [ -f '${launcherPath}' ]; then N='${nodePath}'; [ -x "$N" ] || N="$(command -v node)"; if [ -n "$N" ]; then exec "$N" '${launcherPath}' "$@"; fi; fi`,
    `for arg; do case "$arg" in *-pre-action-hook) printf '%s\\n' '${HOLD_TEXT}' >&2; exit 2 ;; esac; done`,
    `printf '%s\\n' '${UNAVAILABLE_TEXT}' >&2`,
    'exit 1',
    '',
  ].join('\n');
}

function readRecord(directory, platform = process.platform) {
  try {
    const stat = fs.lstatSync(path.join(directory, '.verified'));
    if (!stat.isFile() || stat.isSymbolicLink() || (platform !== 'win32' && (stat.mode & 0o077) !== 0)) return null;
    const record = JSON.parse(fs.readFileSync(path.join(directory, '.verified'), 'utf8'));
    return record && record.schema === RUNTIME_SCHEMA ? record : null;
  } catch {
    return null;
  }
}

// The runtime for one version, when its record matches the expected integrity and its files
// still hash to the record. Returns null otherwise.
function verifyMcpRuntime(home, version, integrity, { platform = process.platform } = {}) {
  if (!home || !VERSION_RE.test(String(version || ''))) return null;
  const directory = runtimeDir(home, version);
  const dirs = [path.join(home, '.marrow'), path.dirname(runtimeRoot(home)), runtimeRoot(home), directory];
  if (!dirs.every((dir) => privateDirectoryOk(dir, platform))) return null;
  const record = readRecord(directory, platform);
  if (!record || record.version !== version) return null;
  if (integrity && record.integrity !== integrity) return null;
  try {
    const files = packageFiles(directory, platform);
    if (JSON.stringify(files) !== JSON.stringify(record.files)) return null;
    if (manifestDigest(directory, files) !== record.manifest_sha256) return null;
    if (fs.readFileSync(path.join(directory, 'launch.cjs'), 'utf8') !== LAUNCHER_SOURCE) return null;
    if (platform !== 'win32') {
      const runStat = fs.lstatSync(path.join(directory, 'run'));
      if (!runStat.isFile() || (runStat.mode & 0o100) === 0) return null;
      const nodeTarget = fs.readlinkSync(path.join(directory, 'node'));
      if (fs.readFileSync(path.join(directory, 'run'), 'utf8') !== runScript(nodeTarget, path.join(directory, 'launch.cjs'))) return null;
    }
  } catch {
    return null;
  }
  const result = { state: 'verified', version, directory, launcher: path.join(directory, 'launch.cjs') };
  return platform === 'win32' ? result : { ...result, run: path.join(directory, 'run'), node: path.join(directory, 'node') };
}

// npm itself, without a shell and without a PATH lookup where possible: node running the
// npm-cli.js that ships next to it (on Windows the only accepted form, so a planted npm.cmd or
// npx.cmd in the project or early on PATH is never started). POSIX falls back to `npm` on PATH,
// which never searches the current directory unless PATH itself names it.
function npmInvocation({ platform = process.platform, execPath = process.execPath } = {}) {
  const bin = path.dirname(execPath);
  const candidates = platform === 'win32'
    ? [path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
    : [path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), '/usr/share/nodejs/npm/bin/npm-cli.js', '/usr/lib/node_modules/npm/bin/npm-cli.js'];
  for (const cli of candidates) {
    try {
      if (fs.statSync(cli).isFile()) return { file: execPath, args: [cli] };
    } catch {
      // try the next location
    }
  }
  return platform === 'win32' ? null : { file: 'npm', args: [] };
}

// npm's environment without overrides that could come from a project or a parent `npm run`
// (npm_config_registry, npm_config_prefix, npm_config_userconfig, ...): the install reads only
// the owner's own npm config, and the pinned integrity decides what is accepted anyway.
function npmEnvironment(source = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (/^npm_/i.test(key)) continue;
    env[key] = value;
  }
  return { ...env, npm_config_ignore_scripts: 'true', npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };
}

function defaultNpmInstall(stage, specs, { platform = process.platform, execPath = process.execPath, env = process.env } = {}) {
  const npm = npmInvocation({ platform, execPath });
  if (!npm) return false;
  const result = spawnSync(npm.file, [...npm.args, 'install', '--no-audit', '--no-fund', '--ignore-scripts', '--no-bin-links',
    '--loglevel=error', `--prefix=${stage}`, ...specs], {
    cwd: stage,
    env: npmEnvironment(env),
    stdio: 'ignore',
    timeout: NPM_INSTALL_TIMEOUT_MS,
    windowsHide: true,
    shell: false,
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
// integrity must match too. Never throws: a failure leaves hooks holding until a repair.
function ensureMcpRuntime({ home, version, integrity, sdk = null, nodePath = process.execPath, npmInstall = defaultNpmInstall, npmExecPath = process.execPath, platform = process.platform, onProgress = null } = {}) {
  const windows = platform === 'win32';
  if (!home || !VERSION_RE.test(String(version || '')) || !INTEGRITY_RE.test(String(integrity || ''))) {
    return { state: 'skipped', reason: 'no_verified_integrity' };
  }
  const existing = verifyMcpRuntime(home, version, integrity, { platform });
  if (existing) {
    const removed = removeOtherRuntimes(home, version);
    return { ...existing, state: 'present', removed_versions: removed };
  }
  const directory = runtimeDir(home, version);
  if (!windows && (!SAFE_PATH_RE.test(directory) || !SAFE_PATH_RE.test(String(nodePath || '')) || !path.isAbsolute(String(nodePath || '')))) {
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
    if (typeof onProgress === 'function') {
      onProgress(`Installing a local copy of @getmarrow/mcp@${version} for Marrow's hooks (up to ${NPM_INSTALL_TIMEOUT_MS / 1000} s; until it is installed, hooks hold protected actions)...\n`);
    }
    if (!npmInstall(stage, specs, { platform, execPath: npmExecPath })) return { state: 'failed', reason: 'npm_install_failed' };
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
    let files;
    try {
      files = packageFiles(stage, platform);
    } catch {
      return { state: 'failed', reason: 'unsafe_package_entry' };
    }
    if (!files.includes(bin)) return { state: 'failed', reason: 'package_entry_missing' };
    const launcher = path.join(directory, 'launch.cjs');
    fs.writeFileSync(path.join(stage, 'launch.cjs'), LAUNCHER_SOURCE, { mode: 0o600 });
    if (!windows) {
      fs.writeFileSync(path.join(stage, 'run'), runScript(nodePath, launcher), { mode: 0o700 });
      fs.symlinkSync(nodePath, path.join(stage, 'node'));
    }
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
    // A concurrent install of the same version may have finished first: keep its verified copy.
    const raced = verifyMcpRuntime(home, version, integrity, { platform });
    if (raced) return { ...raced, state: 'present', removed_versions: removeOtherRuntimes(home, version) };
    removeQuietly(directory);
    try {
      fs.renameSync(stage, directory);
    } catch (error) {
      const other = verifyMcpRuntime(home, version, integrity, { platform });
      if (other) return { ...other, state: 'present', removed_versions: removeOtherRuntimes(home, version) };
      throw error;
    }
    stage = null;
    const verified = verifyMcpRuntime(home, version, integrity, { platform });
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
// Hook commands: the canonical npx form (the one spelling every check and merge reads) <-> the
// written local-runtime form. Written hooks never start npx: the canonical form exists only in
// memory. Earlier local forms (0.1.66-0.1.68, which fell back to npx) still read as Marrow's own
// so that repair rewrites them.
// ---------------------------------------------------------------------------

const V = '(\\d+\\.\\d+\\.\\d+)';
const SUB = '([a-z][a-z-]{0,63})';
const ARGS = `--package=@getmarrow/mcp@${V} marrow-mcp ${SUB}`;
const RUN = (version) => `$HOME/.marrow/runtime/mcp/${version}/run`;
const NODE = (version) => `$HOME/.marrow/runtime/mcp/${version}/node`;
const canonicalEntrypoint = (version, sub) => `npx -y --package=@getmarrow/mcp@${version} marrow-mcp ${sub}`;

// 1. A plain entrypoint command. POSIX: /bin/sh on the run script. Windows: node on the
// launcher, quoted so cmd, PowerShell and sh all read it the same way.
function localPlain(version, sub, platform) {
  const args = `--package=@getmarrow/mcp@${version} marrow-mcp ${sub}`;
  if (platform === 'win32') {
    return `node -e "const p=require('path').join(require('os').homedir(),'.marrow','runtime','mcp','${version}','launch.cjs');if(require('fs').existsSync(p)){process.argv.splice(1,0,p);require(p)}else{console.error('${failureText(sub)}');process.exitCode=${failureStatus(sub)}}" -- ${args}`;
  }
  return `/bin/sh -c 'M="${RUN(version)}"; if [ -x "$M" ]; then exec "$M" ${args}; fi; printf "%s\\n" "${failureText(sub)}" >&2; exit ${failureStatus(sub)}'`;
}
const PLAIN_RE = new RegExp(`^/bin/sh -c 'M="\\$HOME/\\.marrow/runtime/mcp/${V}/run"; if \\[ -x "\\$M" \\]; then exec "\\$M" ${ARGS}; fi; printf "%s\\\\n" "[^"']*" >&2; exit [12]'$`);
const WINDOWS_PLAIN_RE = new RegExp(`^node -e "const p=require\\('path'\\)\\.join\\(require\\('os'\\)\\.homedir\\(\\),'\\.marrow','runtime','mcp','${V}','launch\\.cjs'\\);[^"]*" -- ${ARGS}$`);
const LEGACY_PLAIN_RE = new RegExp(`^/bin/sh -c 'M="\\$HOME/\\.marrow/runtime/mcp/${V}/run"; if \\[ -x "\\$M" \\]; then exec "\\$M" ${ARGS}; fi; exec npx -y --package=@getmarrow/mcp@\\2 marrow-mcp \\3'$`);
const CANONICAL_PLAIN_RE = new RegExp(`^npx -y ${ARGS}$`);

// 2. An entrypoint inside an `sh -c '...'` wrapper (Windsurf, Gemini, every platform): the run
// script, or the fixed text on stderr with the hold (2) or failure (1) status.
function localInner(version, sub) {
  const args = `--package=@getmarrow/mcp@${version} marrow-mcp ${sub}`;
  return `{ M="${RUN(version)}"; if [ -x "$M" ]; then "$M" ${args}; else printf "%s\\n" "${failureText(sub)}" >&2; (exit ${failureStatus(sub)}); fi; }`;
}
const INNER_RE = new RegExp(`\\{ M="\\$HOME/\\.marrow/runtime/mcp/${V}/run"; if \\[ -x "\\$M" \\]; then "\\$M" ${ARGS}; else printf "%s\\\\n" "[^"']*" >&2; \\(exit [12]\\); fi; \\}`, 'g');
const LEGACY_INNER_RE = new RegExp(`\\{ M="\\$HOME/\\.marrow/runtime/mcp/${V}/run"; if \\[ -x "\\$M" \\]; then "\\$M" ${ARGS}; else npx -y --package=@getmarrow/mcp@\\2 marrow-mcp \\3; fi; \\}`, 'g');
const CANONICAL_INNER_RE = new RegExp(`npx -y ${ARGS}`, 'g');

// 3. A node guard (`node -e '...'`) that spawns the entrypoint: node on the launcher, by an
// absolute path under the home directory. A missing launcher fails the spawn, and every guard
// already treats a failed child as its own launch failure (it blocks, or stays neutral).
const SPAWN_NPX = 'spawn(process.platform==="win32"?"npx.cmd":"npx",';
function localSpawn(version, sub) {
  return `spawn(process.execPath,[require("node:path").join(require("node:os").homedir(),".marrow","runtime","mcp","${version}","launch.cjs"),"--package=@getmarrow/mcp@${version}","marrow-mcp","${sub}"],`;
}
const SPAWN_RE = /spawn\(process\.execPath,\[require\("node:path"\)\.join\(require\("node:os"\)\.homedir\(\),"\.marrow","runtime","mcp","(\d+\.\d+\.\d+)","launch\.cjs"\),"--package=@getmarrow\/mcp@(\d+\.\d+\.\d+)","marrow-mcp","([a-z-]+)"\],/g;
const LEGACY_SPAWN_RE = /spawn\(\.\.\.\(\(f,m,a\)=>f\.existsSync\(m\)\?\[m,a\.slice\(1\)\]:\[process\.platform==="win32"\?"npx\.cmd":"npx",a\]\)\(require\("node:fs"\),\(process\.env\.HOME\|\|""\)\+"\/\.marrow\/runtime\/mcp\/\d+\.\d+\.\d+\/run",(\["-y","--package=@getmarrow\/mcp@\d+\.\d+\.\d+","marrow-mcp","[a-z-]+"\])\),/g;
const LEGACY_SPAWN_ONE_RE = new RegExp(LEGACY_SPAWN_RE.source);
const CANONICAL_SPAWN_RE = /spawn\(process\.platform==="win32"\?"npx\.cmd":"npx",\["-y","--package=@getmarrow\/mcp@(\d+\.\d+\.\d+)","marrow-mcp","([a-z-]+)"\],/g;
const localGuardPrefix = (version) => `N="${NODE(version)}"; [ -x "$N" ] || N=node; exec "$N" -e '`;
const LOCAL_GUARD_PREFIX_RE = /^N="\$HOME\/\.marrow\/runtime\/mcp\/\d+\.\d+\.\d+\/node"; \[ -x "\$N" \] \|\| N=node; exec "\$N" -e '/;

// The canonical (npx) form of a hook command; any other command is returned unchanged. Only a
// command that the current writer would produce again exactly (or an earlier writer's local
// form) maps back, so an edited command never reads as Marrow's own.
function delocalizeHookCommand(command) {
  if (typeof command !== 'string') return command;
  const legacyPlain = command.match(LEGACY_PLAIN_RE);
  if (legacyPlain && legacyPlain[1] === legacyPlain[2]) return canonicalEntrypoint(legacyPlain[2], legacyPlain[3]);
  const plain = command.match(PLAIN_RE) || command.match(WINDOWS_PLAIN_RE);
  if (plain && plain[1] === plain[2]) {
    const platform = command.startsWith('node ') ? 'win32' : 'posix';
    return localPlain(plain[2], plain[3], platform) === command ? canonicalEntrypoint(plain[2], plain[3]) : command;
  }
  const prefixed = LOCAL_GUARD_PREFIX_RE.test(command);
  if (prefixed || (command.startsWith('node -e \'') && /spawn\(process\.execPath,\[require\("node:path"\)/.test(command))) {
    const body = prefixed ? command.replace(LOCAL_GUARD_PREFIX_RE, 'node -e \'') : command;
    const canonical = body
      .replace(LEGACY_SPAWN_RE, `${SPAWN_NPX}$1,`)
      .replace(SPAWN_RE, (match, runVersion, version, sub) => (runVersion === version
        ? `${SPAWN_NPX}${JSON.stringify(['-y', `--package=@getmarrow/mcp@${version}`, 'marrow-mcp', sub])},`
        : match));
    if (canonical === body) return command;
    // The current guard forms must map back exactly; a legacy guard is rewritten on repair.
    if (!LEGACY_SPAWN_ONE_RE.test(body)) {
      const platform = prefixed ? 'posix' : 'win32';
      const version = (canonical.match(/--package=@getmarrow\/mcp@(\d+\.\d+\.\d+)/) || [])[1];
      if (!version || localizeHookCommand(canonical, version, { platform }) !== command) return command;
    }
    return canonical;
  }
  if (command.startsWith('/bin/sh -c \'') && (LEGACY_INNER_RE.test(command) || INNER_RE.test(command))) {
    LEGACY_INNER_RE.lastIndex = 0;
    INNER_RE.lastIndex = 0;
    const inner = command
      .replace(LEGACY_INNER_RE, (match, runVersion, version, sub) => (runVersion === version ? canonicalEntrypoint(version, sub) : match))
      .replace(INNER_RE, (match, runVersion, version, sub) => (
        runVersion === version && localInner(version, sub) === match ? canonicalEntrypoint(version, sub) : match
      ));
    return inner === command ? command : `sh -c '${inner.slice('/bin/sh -c \''.length)}`;
  }
  return command;
}

// The local runtime form of a canonical hook command for `version`, or the command unchanged
// when it is not a Marrow entrypoint for that version. The result always maps back exactly.
function localizeHookCommand(command, version, { platform = process.platform } = {}) {
  if (typeof command !== 'string' || !VERSION_RE.test(String(version || ''))) return command;
  const windows = platform === 'win32';
  let local = command;
  const plain = command.match(CANONICAL_PLAIN_RE);
  if (plain) {
    if (plain[1] !== version) return command;
    local = localPlain(version, plain[2], windows ? 'win32' : 'posix');
  } else if (command.startsWith('node -e \'') && command.includes(SPAWN_NPX)) {
    let matched = false;
    const body = command.slice('node -e \''.length).replace(CANONICAL_SPAWN_RE, (match, specVersion, sub) => {
      if (specVersion !== version) return match;
      matched = true;
      return localSpawn(version, sub);
    });
    if (!matched) return command;
    local = windows ? `node -e '${body}` : `${localGuardPrefix(version)}${body}`;
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
  return mapsBack(local, command) ? local : command;
}

function mapsBack(local, command) {
  // delocalize re-checks guard forms through localize; compare without recursing forever.
  const plain = local.match(PLAIN_RE) || local.match(WINDOWS_PLAIN_RE);
  if (plain) return canonicalEntrypoint(plain[2], plain[3]) === command;
  if (local.startsWith('/bin/sh -c \'')) return delocalizeHookCommand(local) === command;
  const prefixed = LOCAL_GUARD_PREFIX_RE.test(local);
  const body = prefixed ? local.replace(LOCAL_GUARD_PREFIX_RE, 'node -e \'') : local;
  const canonical = body.replace(SPAWN_RE, (match, runVersion, version, sub) => (runVersion === version
    ? `${SPAWN_NPX}${JSON.stringify(['-y', `--package=@getmarrow/mcp@${version}`, 'marrow-mcp', sub])},`
    : match));
  return canonical === command;
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
function localizeHookSettingsText(text, version, { platform = process.platform } = {}) {
  if (typeof text !== 'string' || !text.trim()) return text;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  let changed = false;
  const mapped = mapHookCommands(parsed, (command) => {
    const local = localizeHookCommand(command, version, { platform });
    if (local !== command) changed = true;
    return local;
  });
  return changed ? `${JSON.stringify(mapped, null, 2)}\n` : text;
}

// A hook script (Cline) with each canonical entrypoint line switched to the run script for
// `version`. A missing run script fails the line, and each script already treats that as no
// decision (the pre-action script then cancels the call).
function localizeHookScriptText(text, version) {
  if (typeof text !== 'string' || !VERSION_RE.test(String(version || ''))) return text;
  return text.replace(CANONICAL_INNER_RE, (match, specVersion, sub) => (
    specVersion === version ? `"${RUN(version)}" --package=@getmarrow/mcp@${version} marrow-mcp ${sub}` : match
  ));
}

// Whether a hook file's text still starts @getmarrow/mcp through npx (the canonical form, an
// earlier local form with its npx fallback, or a guard that spawns npx): such a file needs repair.
function hookTextUsesNpx(text) {
  if (typeof text !== 'string' || !text) return false;
  return /npx -y --package=@getmarrow\/mcp@/.test(text) || text.includes('"npx.cmd":"npx"') || text.includes('\\"npx.cmd\\":\\"npx\\"');
}

module.exports = {
  HOLD_TEXT,
  NPM_INSTALL_TIMEOUT_MS,
  RUNTIME_SCHEMA,
  LAUNCHER_SOURCE,
  UNAVAILABLE_TEXT,
  defaultNpmInstall,
  delocalizeHookCommand,
  ensureMcpRuntime,
  hookTextUsesNpx,
  localizeHookCommand,
  localizeHookScriptText,
  localizeHookSettingsText,
  mapHookCommands,
  npmEnvironment,
  npmInvocation,
  removeMcpRuntime,
  runScript,
  runtimeDir,
  runtimeRoot,
  verifyMcpRuntime,
};

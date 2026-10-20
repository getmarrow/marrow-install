'use strict';

// Doctor's read-only view of the keyless seatbelt: it runs the pinned MCP's `seatbelt-status`
// command and prints one plain line. It changes no doctor verdict and writes no user file; its only
// writes are the private working base under the passwd home and one empty private folder in it,
// removed after each run (see "Where it runs" below).
//
// The command prints exactly one line of JSON, {"mode":...,"reasons":[...]}, and exits 0. An older
// MCP has no such command (an unknown subcommand may start the MCP server on stdio and wait), so
// its output is untrusted: only a single printable-ASCII line that parses to exactly those two keys,
// with a mode and reasons from the closed sets below, is accepted. Anything else (a timeout, a
// non-zero exit, extra keys, an unknown code, extra lines, control or non-ASCII bytes, more than 4 KB)
// is "could not check". The raw output is never echoed.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SEATBELT_MODES = Object.freeze(['seatbelt', 'claimed_no_key', 'account', 'unknown']);
const SEATBELT_REASON_CODES = Object.freeze([
  'strict', 'key_rejected', 'home_unknown', 'home_unusable', 'env_home_unusable', 'home_mismatch', 'evidence_unknown', 'account_evidence',
]);
const SEATBELT_STATUS_TIMEOUT_MS = 8000;
const SEATBELT_STATUS_MAX_BYTES = 4096;

// The one reason shown when more than one applies: the first match in this order.
const REASON_ORDER = Object.freeze(['strict', 'key_rejected', 'home_unknown', 'home_unusable', 'env_home_unusable', 'home_mismatch', 'evidence_unknown']);
// [REASON_TEXT, FIX_TEXT] per code. Doctor never prints a "run ... doctor" fix: key_rejected and
// "other" point at the key and at the lines below instead.
const REASON_TEXT = Object.freeze({
  strict: ['MARROW_SEATBELT_STRICT=1 is set', 'unset MARROW_SEATBELT_STRICT'],
  key_rejected: ['the Marrow key on this machine was rejected', 'check the key in ~/.marrow/env or MARROW_API_KEY'],
  home_unknown: ['it cannot find your login home folder (common in containers that run as a user with no home)', 'run the agent as a user that has a home folder'],
  home_unusable: ['your login home folder is missing, is not a folder, or is /', 'give this user a real home folder'],
  env_home_unusable: ['HOME points to a folder that is missing or is not a folder', 'set HOME to your login home folder'],
  home_mismatch: ['HOME is not your login home folder', 'start the agent with HOME set to your login home folder'],
  evidence_unknown: [
    'a folder or file it checks (your home folder, ~/.marrow, or an agent folder such as ~/.claude) belongs to another user, can be written by other users, or could not be read',
    'make sure your home folder, ~/.marrow and your agent folders (such as ~/.claude) belong to you and can be read, then run chmod go-w on them',
  ],
  account_evidence: [
    'this machine has an earlier Marrow setup (a ~/.marrow file or Marrow hooks in your settings) but no working key',
    'add your key to ~/.marrow/env (chmod 600), or remove the old setup with npx -y @getmarrow/install@latest uninstall',
  ],
  other: ['it could not confirm this machine\'s setup', 'see the lines below'],
});

// { mode, reasons } from the command's stdout (a Buffer or a latin1 string), or null.
function parseSeatbeltStatus(output) {
  const text = Buffer.isBuffer(output) ? output.toString('latin1') : output;
  if (typeof text !== 'string' || text.length === 0 || text.length > SEATBELT_STATUS_MAX_BYTES) return null;
  // One line of printable ASCII, optionally ended by one LF: no ESC or other control byte, no CR,
  // no second line, no byte above 0x7E.
  if (!/^[\x20-\x7e]+\n?$/.test(text)) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'mode' || keys[1] !== 'reasons') return null;
  if (!SEATBELT_MODES.includes(value.mode)) return null;
  if (!Array.isArray(value.reasons) || value.reasons.length > SEATBELT_REASON_CODES.length) return null;
  const seen = new Set();
  for (const reason of value.reasons) {
    if (typeof reason !== 'string' || !SEATBELT_REASON_CODES.includes(reason) || seen.has(reason)) return null;
    seen.add(reason);
  }
  return { mode: value.mode, reasons: [...value.reasons] };
}

// stdout of the command as a Buffer, or null on a spawn error, a timeout, more than maxBytes of
// output, a non-zero exit or a signal. stdin is closed and stderr is dropped. The command runs in
// its own process group (POSIX), killed whole on a timeout or an overflow until the call settles,
// also when the leader has already exited but a member still holds stdout. The only group signalled
// is the one this call created at spawn (-child.pid); a group id stays reserved while any member
// lives, and ESRCH (no member left) is ignored.
function collectOutput({ command, args, cwd, env, timeoutMs = SEATBELT_STATUS_TIMEOUT_MS, maxBytes = SEATBELT_STATUS_MAX_BYTES }) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    let timer = null;
    let child = null;
    const stop = () => {
      if (!child || child.pid === undefined) return;
      const leaderRunning = child.exitCode === null && child.signalCode === null;
      if (process.platform === 'win32') {
        if (leaderRunning) {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }
        return;
      }
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        // ESRCH: no member of the group is left. Any other failure falls back to the leader, only while it is unreaped.
        if (error && error.code !== 'ESRCH' && leaderRunning) {
          try { child.kill('SIGKILL'); } catch { /* already gone */ }
        }
      }
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener('exit', stop);
      resolve(value);
    };
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch {
      finish(null);
      return;
    }
    process.once('exit', stop);
    timer = setTimeout(() => {
      stop();
      child.stdout.destroy();
      finish(null);
    }, timeoutMs);
    child.on('error', () => finish(null));
    child.stdout.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        stop();
        child.stdout.destroy();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    child.on('close', (code, signal) => finish(code === 0 && signal === null ? Buffer.concat(chunks) : null));
  });
}

// ---- the status child: which program it is, what it receives, where it runs ----
//
// Doctor starts the child as `process.execPath <npm's own npx-cli.js> -y --package=@getmarrow/mcp@<pin>
// marrow-mcp seatbelt-status`: no shell, no lookup of npx or node on PATH, never a fallback to bare npx. The
// script is accepted only at the one place npm puts it beside this node, with no link in its path and no
// folder from it up to / that another user could write (resolveTrustedNpx); otherwise nothing is started.
// The child's environment is built from scratch from an allow-list; the key never reaches it.
//
// Where it runs (POSIX): in a fresh empty folder (mode 700, removed after) made inside
// <passwd home>/.cache/marrow/doctor-tmp, never in a shared temp folder. That base is created one level at a
// time (mode 700, no link followed) and must be the user's own 700 folder, and its real path and every folder
// above it up to / must belong to root or the user and not be writable by group or others (chainClosed);
// otherwise nothing is started. Only then is the private folder made, and then noProjectAbove checks that no
// folder above it holds a package.json or a node_modules, which npm would take as its project (its npm
// config file, its node_modules, and every ancestor's node_modules/.bin put on the child's command PATH).
// Because no other user can write anywhere in that chain, nobody can plant such an entry after the check:
// the check is not a race. The PATH we pass (the real node's folder first) does NOT beat those ancestor
// node_modules/.bin folders (npm puts them in front of the PATH we pass); what keeps them out is the
// noProjectAbove check plus the closed chain. Windows: the per-user temp folder (os.tmpdir()) and
// noProjectAbove only; file owners and modes mean nothing there.

// Not a secret. The one value the child gets for MARROW_API_KEY when this process has a key: the MCP's
// status only asks whether a key is set, so the real value never leaves this process.
const SEATBELT_PRESENCE_KEY = 'marrow-presence-only';

// Non-secret names the MCP's status reads (marrow-mcp src/seatbelt-mode.ts MODE_ENV_NAMES, without its
// key lookup names MARROW_API_KEY and MARROW_KEY, MARROW_BASE_URL and MARROW_SESSION_ID: none of
// those decides whether an owner-file key counts), copied only when set.
const STATUS_ENV_MODE_NAMES = Object.freeze([
  'HOME', 'USERPROFILE', 'MARROW_SEATBELT_STRICT', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'GEMINI_CLI_SYSTEM_SETTINGS_PATH', 'CLINE_DIR',
]);
// What npm needs to run: locale and temporary folders; on Windows also its system folders and extensions.
const STATUS_ENV_BASIC_NAMES = Object.freeze(['LANG', 'LC_ALL', 'TMPDIR', 'TMP', 'TEMP']);
const STATUS_ENV_WIN32_NAMES = Object.freeze(['SystemRoot', 'ComSpec', 'PATHEXT', 'APPDATA', 'LOCALAPPDATA']);
// A user behind a proxy needs these for npm to reach the registry (npm reads them from the environment).
const STATUS_ENV_PROXY_NAMES = Object.freeze(['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy']);

const pathModule = (platform) => (platform === 'win32' ? path.win32 : path.posix);

function envValue(env, name, platform) {
  if (!env || typeof env !== 'object') return undefined;
  if (platform === 'win32') {
    const found = Object.keys(env).find((key) => key.toLowerCase() === name.toLowerCase());
    return found !== undefined && typeof env[found] === 'string' ? env[found] : undefined;
  }
  return Object.prototype.hasOwnProperty.call(env, name) && typeof env[name] === 'string' ? env[name] : undefined;
}

// Whether a path has a node_modules folder directly followed by .bin (either separator, any case).
function inNodeModulesBin(value, platform) {
  const parts = pathModule(platform).normalize(String(value)).split(/[\\/]+/).map((part) => part.toLowerCase());
  return parts.some((part, index) => part === 'node_modules' && parts[index + 1] === '.bin');
}

function realpathOr(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return value;
  }
}

// PATH for the child: the folder holding the real node binary first, so the MCP bin's `#!/usr/bin/env node`
// finds the same node when nothing else is in front, then the parent's absolute entries without any
// node_modules/.bin folder (also behind a link). "." , "" and relative entries are dropped. This order does not
// stop npm from putting its own ancestor node_modules/.bin folders in front of this PATH: see the header above.
function statusPath(parentPath, execDir, platform) {
  const P = pathModule(platform);
  const entries = [execDir];
  const absolute = platform === 'win32' ? (entry) => /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/])/.test(entry) : (entry) => P.isAbsolute(entry);
  for (const entry of typeof parentPath === 'string' ? parentPath.split(P.delimiter) : []) {
    if (entry === '' || !absolute(entry) || entries.includes(entry)) continue;
    if (inNodeModulesBin(entry, platform) || inNodeModulesBin(realpathOr(entry), platform)) continue;
    entries.push(entry);
  }
  return entries.join(P.delimiter);
}

// The child's whole environment, from `parentEnv` (doctor's own): the allow-listed names above, the key
// presence bit, and the rebuilt PATH. Every other name (NODE_OPTIONS, NODE_PATH, npm_config_*, the key,
// every other MARROW_*) is left out by construction.
function buildStatusEnv(parentEnv, { execPath = process.execPath, platform = process.platform } = {}) {
  const env = {};
  const seen = new Set();
  const names = [...STATUS_ENV_MODE_NAMES, ...STATUS_ENV_BASIC_NAMES, ...(platform === 'win32' ? STATUS_ENV_WIN32_NAMES : []), ...STATUS_ENV_PROXY_NAMES];
  for (const name of names) {
    const key = platform === 'win32' ? name.toLowerCase() : name;
    if (seen.has(key)) continue;
    seen.add(key);
    const value = envValue(parentEnv, name, platform);
    if (value !== undefined) env[name] = value;
  }
  // The MCP's own test for "a key is set" (src/seatbelt-mode.ts): either name, any non-empty value.
  if (envValue(parentEnv, 'MARROW_API_KEY', platform) || envValue(parentEnv, 'MARROW_KEY', platform)) env.MARROW_API_KEY = SEATBELT_PRESENCE_KEY;
  const execDir = platform === 'win32' ? pathModule(platform).dirname(execPath) : path.posix.dirname(realpathOr(execPath));
  env.PATH = statusPath(envValue(parentEnv, 'PATH', platform), execDir, platform);
  return env;
}

// The file-system calls the location checks make. A unit test passes its own to resolveTrustedNpx; doctor's
// call sites pass none, and no flag, environment name or file doctor reads reaches this parameter.
function systemIo(io) {
  return {
    realpathSync: (value) => fs.realpathSync(value),
    lstatSync: (value) => fs.lstatSync(value),
    getuid: () => process.getuid(),
    ...io,
  };
}

// POSIX: whether `start` (a real path) and every folder above it, up to /, belongs to root or to this user and cannot be
// written by its group or by others. Then no other user can add, rename or replace anything on the way down to `start`.
// A sticky world-writable /tmp never qualifies. `start` is a folder unless `startIsFile`. Throws on any error: callers
// treat that as a refusal.
function chainClosed(start, io, { startIsFile = false } = {}) {
  const uid = io.getuid();
  if (!Number.isInteger(uid)) return false;
  for (let current = start; ; ) {
    const stat = io.lstatSync(current);
    if (stat.isSymbolicLink() || (current === start && startIsFile ? !stat.isFile() : !stat.isDirectory())) return false;
    if ((stat.uid !== 0 && stat.uid !== uid) || (stat.mode & 0o022) !== 0) return false;
    const parent = path.posix.dirname(current);
    if (parent === current) return true;
    current = parent;
  }
}

// npm's own npx-cli.js next to the node running doctor, or null. The only script accepted is the one place npm puts
// it, beside this node: <real node folder>/../lib/node_modules/npm/bin/npx-cli.js (nvm, the official tarball,
// Homebrew), or /usr/share/nodejs/npm/bin/npx-cli.js when the node is /usr/bin/node (Debian); on Windows
// <real node folder>\node_modules\npm\bin\npx-cli.js. Nothing is followed: its real path must equal that path (no
// link anywhere in it) and it must be a regular file. bin/npx, the PATH and the current or project folders are not
// consulted. Refused (null): a node or script under any node_modules/.bin folder (any depth, both separators,
// any case); on POSIX also a script or any folder above it that belongs to someone other than root or this user
// or that group or others can write (nothing to check on Windows: its file owners and modes mean nothing there);
// any error while resolving. `io` is the unit-test seam of systemIo().
function resolveTrustedNpx({ execPath = process.execPath, platform = process.platform, io } = {}) {
  try {
    const sys = systemIo(io);
    const P = pathModule(platform);
    if (typeof execPath !== 'string' || !P.isAbsolute(execPath)) return null;
    if (inNodeModulesBin(execPath, platform) || inNodeModulesBin(sys.realpathSync(execPath), platform)) return null;
    const nodeDir = sys.realpathSync(P.dirname(execPath));
    const candidates = platform === 'win32'
      ? [P.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js')]
      : [P.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js')];
    if (platform !== 'win32' && execPath === '/usr/bin/node') candidates.push('/usr/share/nodejs/npm/bin/npx-cli.js');
    const same = (a, b) => (platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);
    for (const candidate of candidates) {
      let real;
      try {
        real = sys.realpathSync(candidate);
      } catch {
        continue;
      }
      if (!same(real, P.normalize(candidate)) || inNodeModulesBin(real, platform)) continue;
      if (platform !== 'win32' && !chainClosed(real, sys, { startIsFile: true })) continue;
      if (platform === 'win32' && !sys.lstatSync(real).isFile()) continue;
      return real;
    }
    return null;
  } catch {
    return null;
  }
}

// { command, args, env } for the real status child, or null (could not check: nothing is started).
function statusInvocation({ version, parentEnv = process.env, execPath = process.execPath, platform = process.platform } = {}) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return null;
  const script = resolveTrustedNpx({ execPath, platform });
  if (!script) return null;
  return {
    command: execPath,
    args: [script, '-y', `--package=@getmarrow/mcp@${version}`, 'marrow-mcp', 'seatbelt-status'],
    env: buildStatusEnv(parentEnv, { execPath, platform }),
  };
}

// Whether npm, started with `folder` as its working folder, could find a project above it: npm takes the
// nearest folder up the tree that holds a package.json or a node_modules as its project (its npm config
// file and its node_modules), and npm exec puts every ancestor's node_modules/.bin on PATH. Any such entry
// above the private folder (a package.json or node_modules in the base, in the passwd home or anywhere up to /)
// is refused, and so is anything that cannot be read. On POSIX this runs after the closed-chain walk, so no
// other user can add an entry later.
function noProjectAbove(folder) {
  for (let dir = path.dirname(folder); ; ) {
    for (const name of ['node_modules', 'package.json']) {
      try {
        fs.lstatSync(path.join(dir, name));
        return false;
      } catch (error) {
        if (!error || (error.code !== 'ENOENT' && error.code !== 'ENOTDIR')) return false;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return true;
    dir = parent;
  }
}

// POSIX: the login home folder from the passwd database (os.userInfo().homedir), never $HOME: no environment
// name, flag or file moves it. null when the lookup fails or the home is empty or relative.
function passwdHome() {
  try {
    const home = os.userInfo().homedir;
    return typeof home === 'string' && home !== '' && path.isAbsolute(home) ? path.resolve(home) : null;
  } catch {
    return null;
  }
}

const BASE_PARTS = Object.freeze(['.cache', 'marrow', 'doctor-tmp']);

// POSIX: <passwd home>/.cache/marrow/doctor-tmp as a real path, or null. The passwd home's own chain is checked
// before anything is created. Missing parts are made one level at a time with mode 700; an existing part must be
// a real folder (lstat: a link is refused). The base itself must be a folder owned by this user with mode 700
// (an existing one with another mode is chmod'ed through an open handle, never through a path, then re-read).
// Finally the base's real path and every folder above it, up to /, must pass chainClosed. Any failure or error: null.
function privateBase() {
  try {
    const sys = systemIo();
    const home = passwdHome();
    if (home === null) return null;
    let dir = fs.realpathSync(home);
    if (!chainClosed(dir, sys)) return null;
    for (const part of BASE_PARTS) {
      dir = path.join(dir, part);
      let stat = null;
      try {
        stat = fs.lstatSync(dir);
      } catch (error) {
        if (!error || error.code !== 'ENOENT') return null;
      }
      if (!stat) {
        try {
          fs.mkdirSync(dir, { mode: 0o700 });
        } catch (error) {
          if (!error || error.code !== 'EEXIST') return null;
        }
        stat = fs.lstatSync(dir);
      }
      if (!stat.isDirectory()) return null;
    }
    const fd = fs.openSync(dir, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isDirectory() || stat.uid !== sys.getuid()) return null;
      if ((stat.mode & 0o777) !== 0o700) {
        fs.fchmodSync(fd, 0o700);
        if ((fs.fstatSync(fd).mode & 0o777) !== 0o700) return null;
      }
    } finally {
      fs.closeSync(fd);
    }
    const real = fs.realpathSync(dir);
    return real === dir && chainClosed(real, sys) ? real : null;
  } catch {
    return null;
  }
}

// The folder the private working folder is made in: on POSIX the checked base above (or null: nothing is
// started), on Windows the per-user temp folder (nothing is checked there).
function statusParentFolder(platform = process.platform) {
  return platform === 'win32' ? os.tmpdir() : privateBase();
}

// Runs the command in a fresh empty folder made by mkdtemp inside statusParentFolder() (mode 700, removed
// after in every path), never the project or the doctor's own folder, and returns { mode, reasons } or
// null. `invocation` is { command, args, env }. Order: the base is created and checked, then the private
// folder is made, then noProjectAbove: if a folder above the private one holds a package.json or a
// node_modules, nothing is started (null).
async function runSeatbeltStatus(invocation, limits = {}) {
  let privateCwd = null;
  try {
    const parent = statusParentFolder();
    if (parent === null) return null;
    privateCwd = fs.mkdtempSync(path.join(parent, 'marrow-install-seatbelt-'));
    fs.chmodSync(privateCwd, 0o700);
    if (!noProjectAbove(fs.realpathSync(privateCwd))) return null;
    const output = await collectOutput({ ...invocation, ...limits, cwd: privateCwd });
    return output ? parseSeatbeltStatus(output) : null;
  } catch {
    return null;
  } finally {
    if (privateCwd) {
      try {
        fs.rmSync(privateCwd, { recursive: true, force: true });
      } catch { /* the folder stays empty and private */ }
    }
  }
}

// The one reason doctor shows for a claimed_no_key status, or null for none / other.
function pickSeatbeltReason(reasons) {
  const found = REASON_ORDER.find((code) => reasons.includes(code));
  if (found) return found;
  return reasons.includes('account_evidence') ? 'account_evidence' : null;
}

// The report field (codes only): { mode, reason }. A status of null is "could_not_check".
function seatbeltReport(status) {
  if (!status) return { mode: 'could_not_check', reason: null };
  return { mode: status.mode, reason: status.mode === 'claimed_no_key' ? pickSeatbeltReason(status.reasons) : null };
}

// The doctor line, "- Seatbelt: ..." (without the newline), from a seatbeltReport() value. Any
// other value (a missing field, an unknown mode) is "could not check".
function seatbeltLine(report) {
  const mode = report && typeof report === 'object' ? report.mode : null;
  if (mode === 'seatbelt') return '- Seatbelt: on (no account)';
  if (mode === 'account') return '- Seatbelt: account mode (using your Marrow key)';
  if (mode !== 'claimed_no_key') return '- Seatbelt: could not check';
  const code = Object.prototype.hasOwnProperty.call(REASON_TEXT, report.reason) ? report.reason : 'other';
  const [reason, fix] = REASON_TEXT[code];
  return `- Seatbelt: strict here (holds more actions): ${reason} -> ${fix}`;
}

module.exports = {
  SEATBELT_MODES,
  SEATBELT_REASON_CODES,
  SEATBELT_STATUS_TIMEOUT_MS,
  SEATBELT_STATUS_MAX_BYTES,
  REASON_ORDER,
  REASON_TEXT,
  parseSeatbeltStatus,
  SEATBELT_PRESENCE_KEY,
  STATUS_ENV_MODE_NAMES,
  STATUS_ENV_BASIC_NAMES,
  STATUS_ENV_WIN32_NAMES,
  STATUS_ENV_PROXY_NAMES,
  buildStatusEnv,
  resolveTrustedNpx,
  statusInvocation,
  collectOutput,
  statusParentFolder,
  runSeatbeltStatus,
  pickSeatbeltReason,
  seatbeltReport,
  seatbeltLine,
};

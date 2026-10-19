'use strict';

// Doctor's read-only view of the keyless seatbelt: it runs the pinned MCP's `seatbelt-status`
// command and prints one plain line. Nothing here writes anything or changes any doctor verdict.
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
// its own process group, killed whole on a timeout or an overflow while its leader is still running
// (so no signal ever goes to a group this call did not create, or to a reused pid).
function collectOutput({ command, args, cwd, env, timeoutMs = SEATBELT_STATUS_TIMEOUT_MS, maxBytes = SEATBELT_STATUS_MAX_BYTES }) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    let timer = null;
    let child = null;
    const stop = () => {
      if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
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

// ---- the status child: which program it is, what it receives ----
//
// Doctor starts the child as `process.execPath <npm's own npx-cli.js> -y --package=@getmarrow/mcp@<pin>
// marrow-mcp seatbelt-status`: no shell, no lookup of npx or node on PATH, so nothing the project or
// the inherited PATH holds can stand in for npm. The child's environment is built from scratch from
// an allow-list; the key never reaches it.

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

// PATH for the child: the folder of the node running doctor first, then the parent's absolute entries
// without any node_modules/.bin folder (also behind a link). "." , "" and relative entries are dropped.
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
  env.PATH = statusPath(envValue(parentEnv, 'PATH', platform), pathModule(platform).dirname(execPath), platform);
  return env;
}

// Whether `file` is `folder` or below it.
function isInside(file, folder, platform) {
  const relative = pathModule(platform).relative(folder, file);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${pathModule(platform).sep}`) && !pathModule(platform).isAbsolute(relative));
}

// The real path of npm's own npx-cli.js next to the node running doctor, or null. The candidate is
// <node folder>/npx (a link to <prefix>/lib/node_modules/npm/bin/npx-cli.js on nvm, the official
// tarball and Homebrew; /usr/share/nodejs/npm/bin/npx-cli.js on Debian); on Windows also
// <node folder>/node_modules/npm/bin/npx-cli.js. Refused (null): a candidate or real path inside the
// current folder, inside the project folder(s) given, or inside any node_modules/.bin folder; a real
// path that is not a regular file named npx-cli.js in a folder named bin inside a folder named npm;
// any error while resolving.
function resolveTrustedNpx({ execPath = process.execPath, cwd, projectDirs = [], platform = process.platform } = {}) {
  try {
    const P = pathModule(platform);
    if (typeof execPath !== 'string' || !P.isAbsolute(execPath)) return null;
    const folders = [];
    for (const dir of [cwd === undefined ? process.cwd() : cwd, ...projectDirs]) {
      if (typeof dir !== 'string' || dir === '') return null;
      folders.push(P.resolve(dir), realpathOr(P.resolve(dir)));
    }
    const nodeDir = P.dirname(execPath);
    const candidates = [P.join(nodeDir, 'npx')];
    if (platform === 'win32') candidates.push(P.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'));
    const same = (value) => (platform === 'win32' ? String(value).toLowerCase() : String(value));
    const refused = (file) => inNodeModulesBin(file, platform) || folders.some((folder) => isInside(file, folder, platform));
    if (refused(execPath) || refused(realpathOr(execPath))) return null;
    for (const candidate of candidates) {
      let real;
      try {
        real = fs.realpathSync(candidate);
      } catch {
        continue;
      }
      if (refused(candidate) || refused(real)) continue;
      const bin = P.dirname(real);
      if (same(P.basename(real)) !== 'npx-cli.js' || same(P.basename(bin)) !== 'bin' || same(P.basename(P.dirname(bin))) !== 'npm') continue;
      if (!fs.statSync(real).isFile()) continue;
      return real;
    }
    return null;
  } catch {
    return null;
  }
}

// { command, args, env } for the real status child, or null (could not check: nothing is started).
function statusInvocation({ version, parentEnv = process.env, execPath = process.execPath, cwd, projectDirs = [], platform = process.platform } = {}) {
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return null;
  const script = resolveTrustedNpx({ execPath, cwd, projectDirs, platform });
  if (!script) return null;
  return {
    command: execPath,
    args: [script, '-y', `--package=@getmarrow/mcp@${version}`, 'marrow-mcp', 'seatbelt-status'],
    env: buildStatusEnv(parentEnv, { execPath, platform }),
  };
}

// Whether npm, started with `folder` as its working folder, could find a project above it: npm takes
// the nearest folder up the tree that holds a package.json or a node_modules as its project (its npm
// config file and its node_modules), and npm exec puts every ancestor's node_modules/.bin on PATH.
// Any such entry above the private folder (a TMPDIR below a project, a planted /tmp/node_modules) is
// refused, and so is anything that cannot be read.
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

// Runs the command in a fresh empty folder made by mkdtemp under os.tmpdir() (mode 700, removed
// after in every path), never the project or the doctor's own folder, and returns { mode, reasons }
// or null. `invocation` is { command, args, env }. If a folder above the private one holds a
// package.json or a node_modules, nothing is started (null).
async function runSeatbeltStatus(invocation, limits = {}) {
  let privateCwd = null;
  try {
    privateCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-install-seatbelt-'));
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
  runSeatbeltStatus,
  pickSeatbeltReason,
  seatbeltReport,
  seatbeltLine,
};

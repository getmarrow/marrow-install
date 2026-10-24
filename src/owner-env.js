const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// ~/.marrow/env is the owner-only key store that the Marrow MCP server, SDK hooks and this
// installer already read. Values are parsed in memory and never printed or logged.
const OWNER_ENV_FILES = ['env.local', 'env'];
const KEY_NAMES = ['MARROW_API_KEY', 'MARROW_KEY'];
// Read from the same trusted file, to decide where its key may be sent (base-url-policy.js).
const ENDPOINT_NAMES = ['MARROW_BASE_URL', 'MARROW_ALLOWED_BASE_URLS'];

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

// `ignoreHomeWrite` skips only the "home folder is not group- or other-writable" rule, to tell whether the home folder is
// the one thing wrong (doctor names the cause).
function isPrivateOwnerFile(filePath, home, { ignoreHomeWrite = false } = {}) {
  try {
    const resolvedHome = path.resolve(home);
    const resolvedFile = path.resolve(filePath);
    const parent = path.dirname(resolvedFile);
    const homeStat = fs.lstatSync(resolvedHome);
    const parentStat = fs.lstatSync(parent);
    const fileStat = fs.lstatSync(resolvedFile);
    const uid = currentUid();
    return resolvedFile.startsWith(`${resolvedHome}${path.sep}`)
      && homeStat.isDirectory() && !homeStat.isSymbolicLink() && fs.realpathSync(resolvedHome) === resolvedHome
      && parentStat.isDirectory() && !parentStat.isSymbolicLink() && fs.realpathSync(parent) === parent
      && fileStat.isFile() && !fileStat.isSymbolicLink()
      && (uid === null || (fileStat.uid === uid && parentStat.uid === uid && homeStat.uid === uid))
      && (fileStat.mode & 0o077) === 0
      && (parentStat.mode & 0o022) === 0
      && (ignoreHomeWrite || (homeStat.mode & 0o022) === 0);
  } catch {
    return false;
  }
}

function stripQuotes(value) {
  const trimmed = String(value || '').trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseKeyLines(raw) {
  const values = {};
  for (const line of String(raw || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || !(KEY_NAMES.includes(match[1]) || ENDPOINT_NAMES.includes(match[1]))) continue;
    let value = match[2] || '';
    const hashIndex = value.search(/\s+#/);
    if (hashIndex >= 0) value = value.slice(0, hashIndex);
    value = stripQuotes(value);
    if (value) values[match[1]] = value;
  }
  return values;
}

function fingerprintMatches(left, right) {
  const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();
  return crypto.timingSafeEqual(digest(left), digest(right));
}

// Returns the stored key only from a private, owner-owned file, as the MCP trusted reader does:
// env.local first, then env. `conflict` is true when both hold a key and they differ; the keys
// are compared in memory only and never returned for display.
function readOwnerKeyDetail(home) {
  const directory = path.join(home, '.marrow');
  const found = [];
  for (const name of OWNER_ENV_FILES) {
    const filePath = path.join(directory, name);
    if (!fs.existsSync(filePath) || !isPrivateOwnerFile(filePath, home)) continue;
    try {
      const values = parseKeyLines(fs.readFileSync(filePath, 'utf8'));
      // Blank (quoted whitespace) values are absent: they never shadow a valid key in another file.
      const apiKey = String(values.MARROW_API_KEY || '').trim() || String(values.MARROW_KEY || '').trim();
      if (apiKey) found.push({ apiKey, source: filePath, name, values: { MARROW_BASE_URL: values.MARROW_BASE_URL || '', MARROW_ALLOWED_BASE_URLS: values.MARROW_ALLOWED_BASE_URLS || '' } });
    } catch {
      // An unreadable owner file is treated as absent.
    }
  }
  if (found.length === 0) return { apiKey: '', source: null, conflict: false, fileName: null, endpoint: {} };
  const conflict = found.length > 1 && !fingerprintMatches(found[0].apiKey, found[1].apiKey);
  // `endpoint` holds the endpoint values of the file that supplied the key, and only that file.
  return { apiKey: found[0].apiKey, source: found[0].source, conflict, fileName: found[0].name, endpoint: found[0].values };
}

// Names of key entries in an env file whose value is blank (`MARROW_API_KEY=`, `MARROW_API_KEY="   "`): the
// same line grammar as parseKeyLines, which drops them, so the reader never sees a blank key.
function blankKeyNames(raw) {
  const names = new Set();
  for (const line of String(raw || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || !KEY_NAMES.includes(match[1])) continue;
    let value = match[2] || '';
    const hashIndex = value.search(/\s+#/);
    if (hashIndex >= 0) value = value.slice(0, hashIndex);
    if (stripQuotes(value).trim() === '') names.add(match[1]);
  }
  return [...names];
}

// Why no key can be used, for doctor, as names and reasons only (never a value). Call it when no key was found:
// state 'none' is a plain "no key yet"; 'empty' is a key entry that is present but blank (an environment variable
// set to blank, or a blank line in an owner env file); 'unusable' is an owner env file that exists but cannot be
// used (not an owner-only file, or unreadable). Only a missing file counts as absent. `homeWritable` says the home
// folder is group- or other-writable, which makes every file under it unusable as an owner file; when that is so the
// reason names the home folder (and the file too only when the file itself is also wrong).
function ownerKeyStoreState(home, env = {}) {
  const homeOpen = homeIsWritableByOthers(home);
  const problems = [];
  for (const name of KEY_NAMES) {
    const value = env[name];
    if (typeof value !== 'string') continue;
    if (value.trim()) return { state: 'key', problems: [], homeWritable: false };
    problems.push({ state: 'empty', name, source: 'the environment' });
  }
  let keyFound = false;
  for (const name of OWNER_ENV_FILES) {
    const filePath = path.join(home, '.marrow', name);
    const source = `~/.marrow/${name}`;
    try {
      fs.lstatSync(filePath);
    } catch (error) {
      if (error?.code !== 'ENOENT') problems.push({ state: 'unusable', name, source, reason: 'cannot be inspected' });
      continue;
    }
    if (!isPrivateOwnerFile(filePath, home)) {
      const fileWrong = !isPrivateOwnerFile(filePath, home, { ignoreHomeWrite: true });
      const reason = !homeOpen ? 'is not an owner-only file'
        : fileWrong ? 'is in a home folder that group or others can write, and is not an owner-only file'
          : 'is in a home folder that group or others can write';
      problems.push({ state: 'unusable', name, source, reason });
      continue;
    }
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      problems.push({ state: 'unusable', name, source, reason: 'cannot be read' });
      continue;
    }
    const values = parseKeyLines(raw);
    if (String(values.MARROW_API_KEY || '').trim() || String(values.MARROW_KEY || '').trim()) keyFound = true;
    else for (const keyName of blankKeyNames(raw)) problems.push({ state: 'empty', name: keyName, source });
  }
  if (keyFound) return { state: 'key', problems: [], homeWritable: false };
  const state = !problems.length ? 'none' : problems.some((problem) => problem.state === 'unusable') ? 'unusable' : 'empty';
  return { state, problems, homeWritable: homeOpen };
}

// Whether the home folder can be written by its group or by others. An unreadable home is reported by the file checks.
function homeIsWritableByOthers(home) {
  try {
    return (fs.lstatSync(home).mode & 0o022) !== 0;
  } catch {
    return false;
  }
}

function readOwnerApiKey(home) {
  const { apiKey, source, conflict } = readOwnerKeyDetail(home);
  return { apiKey, source, conflict };
}

// Stores the key only when no owner key file exists yet. An existing different key is left
// unchanged and reported, never replaced. Writes are private (directory 0700, file 0600).
function ensureOwnerApiKey(home, apiKey) {
  const key = String(apiKey || '').trim();
  const directory = path.join(home, '.marrow');
  const filePath = path.join(directory, 'env');
  if (!key) return { state: 'no_key', path: filePath, written: false };
  const stored = readOwnerApiKey(home);
  if (stored.apiKey) {
    return {
      state: fingerprintMatches(stored.apiKey, key) ? 'present' : 'different_key_present',
      path: stored.source,
      written: false,
    };
  }
  for (const name of OWNER_ENV_FILES) {
    const candidate = path.join(directory, name);
    if (fs.existsSync(candidate) && !isPrivateOwnerFile(candidate, home)) {
      return { state: 'unsafe_existing_file', path: candidate, written: false };
    }
  }
  const homeStat = fs.lstatSync(home);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink() || (homeStat.mode & 0o022) !== 0) {
    return { state: 'unsafe_home', path: filePath, written: false };
  }
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  const uid = currentUid();
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
    || (uid !== null && directoryStat.uid !== uid) || (directoryStat.mode & 0o022) !== 0) {
    return { state: 'unsafe_directory', path: filePath, written: false };
  }
  const before = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const separator = before && !before.endsWith('\n') ? '\n' : '';
  const tempPath = path.join(directory, `.env.marrow-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  try {
    fs.writeFileSync(tempPath, `${before}${separator}MARROW_API_KEY=${key}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
  return { state: 'written', path: filePath, written: true };
}

module.exports = {
  ensureOwnerApiKey,
  isPrivateOwnerFile,
  ownerKeyStoreState,
  readOwnerApiKey,
  readOwnerKeyDetail,
};

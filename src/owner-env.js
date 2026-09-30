const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// ~/.marrow/env is the owner-only key store that the Marrow MCP server, SDK hooks and this
// installer already read. Values are parsed in memory and never printed or logged.
const OWNER_ENV_FILES = ['env.local', 'env'];
const KEY_NAMES = ['MARROW_API_KEY', 'MARROW_KEY'];

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function isPrivateOwnerFile(filePath, home) {
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
      && (homeStat.mode & 0o022) === 0;
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
    if (!match || !KEY_NAMES.includes(match[1])) continue;
    let value = match[2] || '';
    const hashIndex = value.search(/\s+#/);
    if (hashIndex >= 0) value = value.slice(0, hashIndex);
    value = stripQuotes(value);
    if (value) values[match[1]] = value;
  }
  return values;
}

// Returns the stored key only from a private, owner-owned file, as the MCP trusted reader does.
function readOwnerApiKey(home) {
  const directory = path.join(home, '.marrow');
  for (const name of OWNER_ENV_FILES) {
    const filePath = path.join(directory, name);
    if (!fs.existsSync(filePath) || !isPrivateOwnerFile(filePath, home)) continue;
    try {
      const values = parseKeyLines(fs.readFileSync(filePath, 'utf8'));
      const apiKey = values.MARROW_API_KEY || values.MARROW_KEY || '';
      if (apiKey) return { apiKey, source: filePath };
    } catch {
      // An unreadable owner file is treated as absent.
    }
  }
  return { apiKey: '', source: null };
}

function fingerprintMatches(left, right) {
  const digest = (value) => crypto.createHash('sha256').update(String(value)).digest();
  return crypto.timingSafeEqual(digest(left), digest(right));
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
  readOwnerApiKey,
};

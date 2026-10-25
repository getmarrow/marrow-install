'use strict';

// Private-file helpers. Everything the daemon writes is owner-only: directories 0700 and files
// 0600, created without following symlinks and replaced atomically.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const uid = () => (typeof process.getuid === 'function' ? process.getuid() : null);

class UnsafePathError extends Error {
  constructor(target, reason) {
    super(`unsafe path ${target}: ${reason}`);
    this.name = 'UnsafePathError';
    this.reason = reason;
  }
}

function ensurePrivateDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new UnsafePathError(dir, 'not_a_directory');
  if (uid() !== null && stat.uid !== uid()) throw new UnsafePathError(dir, 'wrong_owner');
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700);
  return dir;
}

function checkPrivateDir(dir) {
  try {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) return 'not_a_directory';
    if (uid() !== null && stat.uid !== uid()) return 'wrong_owner';
    if ((stat.mode & 0o077) !== 0) return 'group_or_world_access';
    return null;
  } catch (error) {
    return error.code === 'ENOENT' ? 'missing' : 'unreadable';
  }
}

function writeFileAtomic(target, data, mode = 0o600) {
  const dir = path.dirname(target);
  const temp = path.join(dir, `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  let fd = -1;
  try {
    fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), mode);
    fs.writeSync(fd, typeof data === 'string' ? data : Buffer.from(data));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = -1;
    fs.renameSync(temp, target);
    fs.chmodSync(target, mode);
  } finally {
    if (fd >= 0) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch { /* already renamed */ }
  }
}

// Reads a file only if it is a regular owner-only file (no symlink, mode & 077 == 0).
function readPrivateFile(target, maxBytes = 1024 * 1024) {
  let fd = -1;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new UnsafePathError(target, 'not_a_file');
    if (uid() !== null && stat.uid !== uid()) throw new UnsafePathError(target, 'wrong_owner');
    if ((stat.mode & 0o077) !== 0) throw new UnsafePathError(target, 'group_or_world_access');
    if (stat.size > maxBytes) throw new UnsafePathError(target, 'too_large');
    return fs.readFileSync(fd, 'utf8');
  } finally {
    if (fd >= 0) fs.closeSync(fd);
  }
}

function sha256File(target) {
  return crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex');
}

module.exports = { UnsafePathError, ensurePrivateDir, checkPrivateDir, writeFileAtomic, readPrivateFile, sha256File };

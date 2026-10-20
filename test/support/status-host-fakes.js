'use strict';
// Test-only preload (never loaded by the installer; no flag, environment name or file doctor reads loads it). Doctor's status
// child is only started from a place whose every folder, up to /, belongs to root or the user and cannot be written by others
// (src/seatbelt-status.js chainClosed). The test layouts sit below the test temp root, which is mode 700 and the user's own, but
// that root lives in a system temp folder (/tmp: sticky, world-writable, owned by root), which can never pass. For the test
// processes that load this file, such a folder is looked at as a plain root-owned 0755 folder; everything below it is checked
// as it is on disk. A folder owned by the user, or not sticky, or not world-writable, is never changed.
const fs = require('node:fs');

const realLstat = fs.lstatSync;
fs.lstatSync = function lstatSync() {
  const stat = realLstat.apply(this, arguments);
  if (stat && typeof stat.isDirectory === 'function' && stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o1002) === 0o1002) {
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { mode: stat.mode & ~0o1022 });
  }
  return stat;
};

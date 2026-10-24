'use strict';
// Test-only preload (never loaded by the installer; no flag, environment name or file doctor reads loads it). It is
// loaded by isolated-environment.js (through status-child-stub.js) for in-process runs, and passed through NODE_OPTIONS to
// the doctor processes the tests start. It does four things:
//
// 1. The passwd home. Doctor builds its private working base under os.userInfo().homedir (src/seatbelt-status.js), which is
//    the real login home of whoever runs the tests. Here os.userInfo().homedir returns the test's own fake home instead:
//    STATUS_TEST_PASSWD_HOME when set (the value '!throw' makes the lookup throw), else HOME, as they are when this file loads.
// 2. A guard: fs.mkdirSync, fs.mkdtempSync and fs.writeFileSync on a path under the ORIGINAL passwd home throw "test touched
//    the real passwd home" (the path string only; nothing there is read or listed), the process exits non-zero, and the trip
//    is counted (one line in FH_TEST_GUARD_LOG when that file is named). The test's own fake home, TMPDIR, HOME and the repo
//    folder are exempt, so a real home that happens to contain them does not trip it.
// 3. Doctor's status child is only started from a place whose every folder, up to /, belongs to root or the user and cannot be
//    written by others (chainClosed). The test layouts sit below the test temp root, which is mode 700 and the user's own,
//    but that root lives in a system temp folder (/tmp: sticky, world-writable, owned by root), which can never pass. For the
//    processes that load this file, such a folder is looked at as a plain root-owned 0755 folder; everything below it is
//    checked as it is on disk. A folder owned by the user, not sticky or not world-writable is never changed.
// 4. Another owner (STATUS_TEST_FAKE_OWNER, below).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const realUserInfo = os.userInfo;
let realHome = null;
try {
  realHome = path.resolve(realUserInfo.call(os).homedir);
} catch {
  realHome = null;
}
const initial = [process.env.STATUS_TEST_PASSWD_HOME, process.env.HOME].find((value) => typeof value === 'string' && (value === '!throw' || path.isAbsolute(value)));
let fakeHome = initial === undefined ? '!throw' : initial;
function setPasswdHome(home) {
  fakeHome = home;
}
os.userInfo = function userInfo(options) {
  if (fakeHome === '!throw') throw Object.assign(new Error('SystemError: no passwd entry (test)'), { code: 'ERR_SYSTEM_ERROR' });
  return { ...realUserInfo.call(os, options), homedir: fakeHome };
};

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const inside = (file, folder) => file === folder || file.startsWith(folder.endsWith(path.sep) ? folder : `${folder}${path.sep}`);
const exemptRoots = () => [fakeHome, process.env.HOME, process.env.TMPDIR, REPO_ROOT]
  .filter((value) => typeof value === 'string' && path.isAbsolute(value))
  .map((value) => path.resolve(value))
  .filter((value) => !inside(realHome, value));
const trips = { count: 0, selfTest: 0 };
function guard(name, target) {
  if (realHome === null || target === undefined || target === null) return;
  let file;
  try {
    file = path.resolve(target instanceof URL ? fileURLToPath(target) : Buffer.isBuffer(target) ? target.toString() : typeof target === 'string' ? target : '');
  } catch {
    return;
  }
  if (typeof target === 'number' || file === path.resolve('') || !inside(file, realHome) || exemptRoots().some((root) => inside(file, root))) return;
  if (path.basename(file).startsWith('guard-selftest-')) {
    trips.selfTest += 1;
  } else {
    trips.count += 1;
    if (process.env.FH_TEST_GUARD_LOG) {
      try {
        fs.appendFileSync(process.env.FH_TEST_GUARD_LOG, `${process.pid} ${name}\n`);
      } catch { /* the exit code below still fails the run */ }
    }
    process.exitCode = 1;
  }
  throw new Error('test touched the real passwd home');
}
for (const name of ['mkdirSync', 'mkdtempSync', 'writeFileSync']) {
  const real = fs[name];
  fs[name] = function guarded(target, ...rest) {
    guard(name, target);
    return real.call(this, target, ...rest);
  };
}
process.once('exit', () => {
  if (trips.count > 0) {
    process.exitCode = 1;
    process.stderr.write(`test touched the real passwd home: ${trips.count} trip(s)\n`);
  }
});

// 4. Another owner. STATUS_TEST_FAKE_OWNER, when set (as it is when this file loads) to an absolute path, makes lstat, and fstat of a
//    descriptor opened on that path, report that one folder as owned by another user (this user's uid + 1). Nothing on disk changes:
//    it is how the tests reach the "owned by another user" refusals without root.
const fakeOwner = typeof process.env.STATUS_TEST_FAKE_OWNER === 'string' && path.isAbsolute(process.env.STATUS_TEST_FAKE_OWNER)
  ? path.resolve(process.env.STATUS_TEST_FAKE_OWNER)
  : null;
const withOwner = (stat) => Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { uid: process.getuid() + 1 });

const realLstat = fs.lstatSync;
fs.lstatSync = function lstatSync(target) {
  const stat = realLstat.apply(this, arguments);
  if (stat && typeof stat.isDirectory === 'function' && stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o1002) === 0o1002) {
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { mode: stat.mode & ~0o1022 });
  }
  if (stat && fakeOwner !== null && typeof target === 'string' && path.resolve(target) === fakeOwner) return withOwner(stat);
  return stat;
};
if (fakeOwner !== null) {
  const opened = new Map();
  const realOpen = fs.openSync;
  const realFstat = fs.fstatSync;
  const realClose = fs.closeSync;
  fs.openSync = function openSync(target) {
    const fd = realOpen.apply(this, arguments);
    if (typeof target === 'string') opened.set(fd, path.resolve(target));
    return fd;
  };
  fs.fstatSync = function fstatSync(fd) {
    const stat = realFstat.apply(this, arguments);
    return stat && opened.get(fd) === fakeOwner ? withOwner(stat) : stat;
  };
  fs.closeSync = function closeSync(fd) {
    opened.delete(fd);
    return realClose.apply(this, arguments);
  };
}

module.exports = { setPasswdHome, guardTrips: () => trips.count, guardSelfTestTrips: () => trips.selfTest, realPasswdHome: () => realHome };

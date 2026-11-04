'use strict';
// Seams for test/homeroot.test.js, loaded into the installer child with --require. The installer reads
// none of these variables itself, so no environment value can stand in for consent in a real run.
//   HOMEROOT_PASSWD_HOME  the passwd home os.userInfo() reports ('throw' makes it throw, as with no passwd entry)
//   HOMEROOT_OS_HOMEDIR   what os.homedir() returns (the fallback when HOME and USERPROFILE are unset)
//   HOMEROOT_TTY          both | stdin | stdout: the streams that claim to be a terminal (an answer arrives on a pipe)
//   HOMEROOT_TRACE        file that gets one line per fs call: `<op> <path> <dev>:<ino>` (opens, reads and metadata probes)
const fs = require('node:fs');
const os = require('node:os');

const { HOMEROOT_PASSWD_HOME: passwd, HOMEROOT_OS_HOMEDIR: homedir, HOMEROOT_TTY: tty, HOMEROOT_TRACE: trace } = process.env;

if (passwd !== undefined) {
  const real = os.userInfo;
  os.userInfo = (...args) => {
    if (passwd === 'throw') throw new Error('no passwd entry');
    return { ...real.apply(os, args), homedir: passwd };
  };
}
if (homedir !== undefined) os.homedir = () => homedir;
if (tty) {
  if (tty === 'both' || tty === 'stdin') process.stdin.isTTY = true;
  if (tty === 'both' || tty === 'stdout') process.stdout.isTTY = true;
}
if (trace) {
  const { statSync, appendFileSync } = fs;
  const wrap = (holder, op) => {
    const original = holder[op];
    holder[op] = function traced(target, ...rest) {
      if (typeof target === 'string') {
        let id = '?';
        try { const stat = statSync(target); id = `${stat.dev}:${stat.ino}`; } catch { /* a missing path has no id */ }
        try { appendFileSync(trace, `${op} ${target} ${id}\n`); } catch { /* tracing is best effort */ }
      }
      return original.call(this, target, ...rest);
    };
  };
  for (const op of ['openSync', 'readFileSync', 'statSync', 'lstatSync', 'existsSync', 'open', 'readFile', 'createReadStream']) wrap(fs, op);
  for (const op of ['open', 'readFile']) wrap(fs.promises, op);
}

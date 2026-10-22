'use strict';

// Test-only. Wraps child_process.spawnSync, execSync and execFileSync so a test can see every
// synchronous child the code under test waits for. Each call is reported to `onBlock` as
// { file, timeout } (file is the program; for execSync, which takes a whole shell command line,
// only its first word; timeout is the call's own timeout option, or Infinity when it has none)
// before it runs, so a call that throws is reported too. Then it runs exactly as it would without
// the wrapper: same `this`, same arguments, same result, same throw. Only the program is reported,
// never the arguments, options or env, so a secret the code passes cannot reach a log. Used by hook-clock-preload.js (spawned hooks) and
// virtual-clock.js (in-process tests). Nothing under src/ or bin/ reads it; it is not packed.
const childProcess = require('node:child_process');

const NAMES = ['spawnSync', 'execSync', 'execFileSync'];

// spawnSync(file, args?, options?) and execFileSync(file, args?, options?) take options last;
// execSync(command, options?) takes it second.
function optionsOf(name, args) {
  const candidate = name === 'execSync' ? args[1] : Array.isArray(args[1]) ? args[2] : args[1];
  return candidate !== null && typeof candidate === 'object' ? candidate : {};
}

// The first word of a shell command line, cut at "=" so a leading assignment (NAME=value cmd)
// reports the name and never the value.
function firstWord(command) {
  const word = command.trim().split(/\s+/)[0];
  const assignment = word.indexOf('=');
  return assignment === -1 ? word : word.slice(0, assignment + 1);
}

// Returns a function that puts the original functions back.
function recordBlocks(onBlock) {
  const originals = {};
  for (const name of NAMES) {
    const original = childProcess[name];
    originals[name] = original;
    childProcess[name] = function recordedBlock(...args) {
      const { timeout } = optionsOf(name, args);
      const command = String(args[0]);
      onBlock({ file: name === 'execSync' ? firstWord(command) : command, timeout: timeout === undefined || timeout === null ? Infinity : timeout });
      return original.apply(this, args);
    };
  }
  return function restoreBlocks() {
    for (const name of NAMES) childProcess[name] = originals[name];
  };
}

module.exports = { recordBlocks };

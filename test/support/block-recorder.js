'use strict';

// Test-only. Wraps child_process.spawnSync, execSync and execFileSync so a test can see every
// synchronous child the code under test waits for. Each call is reported to `onBlock` as
// { file, timeout } (file is the command or program; timeout is the call's own timeout option, or
// Infinity when it has none) and then runs exactly as it would without the wrapper: same
// arguments, same result, same throw. Used by hook-clock-preload.js (spawned hooks) and
// virtual-clock.js (in-process tests). Nothing under src/ or bin/ reads it; it is not packed.
const childProcess = require('node:child_process');

const NAMES = ['spawnSync', 'execSync', 'execFileSync'];

// spawnSync(file, args?, options?) and execFileSync(file, args?, options?) take options last;
// execSync(command, options?) takes it second.
function optionsOf(name, args) {
  const candidate = name === 'execSync' ? args[1] : Array.isArray(args[1]) ? args[2] : args[1];
  return candidate !== null && typeof candidate === 'object' ? candidate : {};
}

// Returns a function that puts the original functions back.
function recordBlocks(onBlock) {
  const originals = {};
  for (const name of NAMES) {
    const original = childProcess[name];
    originals[name] = original;
    childProcess[name] = function recordedBlock(...args) {
      const { timeout } = optionsOf(name, args);
      onBlock({ file: String(args[0]), timeout: timeout === undefined || timeout === null ? Infinity : timeout });
      return original.apply(this, args);
    };
  }
  return function restoreBlocks() {
    for (const name of NAMES) childProcess[name] = originals[name];
  };
}

module.exports = { recordBlocks };

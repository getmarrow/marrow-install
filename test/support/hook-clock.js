'use strict';

// Test-side helpers for hook-clock-preload.js: run a spawned hook with its waits recorded (and,
// in virtual mode, skipped) and read back what it asked for.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PRELOAD = path.join(__dirname, 'hook-clock-preload.js');

function clockLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-hook-clock-'));
  return path.join(dir, 'waits.log');
}

// `mode` is { atomics: 'count' | 'virtual', timers: 'instant' }. Returns the env for the hook.
function withHookClock(env, log, mode) {
  return { ...env, NODE_OPTIONS: `--require=${PRELOAD}`, TIMING_TEST_CLOCK: JSON.stringify({ log, ...mode }) };
}

// The waits one hook asked for, in order: { sleeps: [ms...], timers: [ms...] }.
function readWaits(log) {
  const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  const pick = (kind) => lines.filter((line) => line.startsWith(`${kind} `)).map((line) => Number(line.slice(kind.length + 1)));
  fs.rmSync(log, { force: true });
  return { sleeps: pick('sleep'), timers: pick('timer') };
}

module.exports = { clockLog, readWaits, withHookClock, PRELOAD };

'use strict';

// Test-side helpers for hook-clock-preload.js: run a spawned hook with its waits recorded (and,
// in virtual mode, skipped) and read back what it asked for.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PRELOAD = path.join(__dirname, 'hook-clock-preload.js');

function clockLog() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-hook-clock-'));
  return path.join(dir, 'waits.log');
}

// `mode` is { atomics: 'count' | 'virtual', timers: 'instant' }. Returns the env for the hook.
function withHookClock(env, log, mode) {
  return { ...env, NODE_OPTIONS: `--require=${PRELOAD}`, TIMING_TEST_CLOCK: JSON.stringify({ log, ...mode }) };
}

// What one hook asked for, in order: { sleeps: [ms...], timers: [ms...], blocks: [{ file, timeout }...],
// cpuMs }. `blocks` are the synchronous child processes it ran (spawnSync, execSync, execFileSync);
// timeout is Infinity when the call set none. `cpuMs` is the CPU time the hook used (null when it
// logged none, for instance when it was killed).
function readWaits(log) {
  const lines = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  const pick = (kind) => lines.filter((line) => line.startsWith(`${kind} `)).map((line) => Number(line.slice(kind.length + 1)));
  const blocks = lines.filter((line) => line.startsWith('block ')).map((line) => {
    const rest = line.slice('block '.length);
    const split = rest.lastIndexOf(' ');
    const timeout = rest.slice(split + 1);
    return { file: rest.slice(0, split), timeout: timeout === 'none' ? Infinity : Number(timeout) };
  });
  fs.rmSync(log, { force: true });
  const cpu = pick('cpu');
  return { sleeps: pick('sleep'), timers: pick('timer'), blocks, cpuMs: cpu.length ? Math.max(...cpu) : null };
}

// The most CPU time one hook call may use. A hook that starts, checks its records and warns takes
// under 0.1 s of CPU (measured 65 to 95 ms on a loaded machine), and CPU time does not grow when the
// machine is busy. This is a hang guard, not a precise bound: it catches a block that waits on
// nothing the recorder sees, a busy loop, and it is a third of the old 3 s wall-clock check because
// a busy machine gives a spinning hook only part of a CPU (a 4 s loop measured 2.8 s of CPU).
const HOOK_CPU_GUARD_MS = 1000;

// A hook call that blocked nothing: it ran no blocking child (no allowlist: the hook's warn paths
// start the heal detached and never run npm inline) and used little CPU.
function assertNoBlock(waits, message) {
  assert.deepEqual(waits.blocks, [], `${message}: the hook ran a blocking child`);
  assert.ok(waits.cpuMs !== null && waits.cpuMs < HOOK_CPU_GUARD_MS, `${message}: the hook used ${waits.cpuMs} ms of CPU`);
}

// A hook call that must warn or hold at once: it entered no wait and blocked nothing. So a hook
// that blocks without Atomics.wait (a spawnSync or execFileSync that waits for a child, a busy
// loop) is caught as well.
function assertAtOnce(waits, message) {
  assert.deepEqual(waits.sleeps, [], `${message}: the hook entered its wait`);
  assertNoBlock(waits, message);
}

// Positive control for the checks above: a process that runs one blocking child under the preload
// must show it in `blocks`, with its timeout, and the child must still run (its output comes back);
// its CPU time must be logged at exit.
function assertBlockingChildObservable() {
  const log = clockLog();
  const probe = "process.stdout.write(require('node:child_process').spawnSync('echo', ['seen'], { timeout: 5000, encoding: 'utf8' }).stdout)";
  const run = spawnSync(process.execPath, ['-e', probe], { env: withHookClock({ PATH: process.env.PATH }, log, { atomics: 'virtual' }), encoding: 'utf8' });
  assert.equal(run.stdout, 'seen\n', run.stderr);
  const seen = readWaits(log);
  assert.deepEqual(seen.blocks, [{ file: 'echo', timeout: 5000 }], 'a blocking child is observable');
  assert.ok(seen.cpuMs !== null && seen.cpuMs < HOOK_CPU_GUARD_MS, 'the CPU time is logged at exit');
}

module.exports = { assertAtOnce, assertBlockingChildObservable, assertNoBlock, clockLog, readWaits, withHookClock, PRELOAD };

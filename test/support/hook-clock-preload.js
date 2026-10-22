'use strict';

// Test-only preload for a hook process a test spawns (loaded with NODE_OPTIONS=--require=<this
// file>, set by the test through hook-clock.js). It records the waits the hook asks for in a log
// file and, in virtual mode, lets the hook pass them without sleeping. Nothing under src/ or bin/
// reads this file or its switch, and it is not packed. The switch is TIMING_TEST_CLOCK, a JSON
// object the test puts in the hook's environment:
//   log      file the recorded waits are appended to, one per line: "sleep <ms>", "timer <ms>" or
//            "block <file> <timeout>" or, once when the hook exits, "cpu <ms>"
//   atomics  "count"   record every Atomics.wait and still sleep for real
//            "virtual" record every Atomics.wait, return at once, and move Date.now forward by the
//                      requested ms (Date.now is otherwise frozen, so a wait loop that checks a
//                      budget against Date.now runs exactly budget/step times)
//   timers   "instant" record every setTimeout and run it on the next turn of the event loop (as an
//            immediate, after the first-turn snapshot described below)
// Whenever either is set, child_process.spawnSync, execSync and execFileSync are also wrapped: each
// call is logged as "block <file> <timeout>" (file is the command or program, timeout the call's
// own timeout option, "none" when it has none) and then runs exactly as it would without the
// wrapper. A blocking child stops the hook as Atomics.wait does but never enters it, so a test that
// says "the hook did not wait" must read these lines too (readWaits().blocks). At exit the hook
// also logs the CPU time it used: a busy loop blocks without waiting on anything, and CPU time (not
// wall-clock time) does not grow when the machine is loaded.
// Once the hook's synchronous work is done (a setImmediate this file schedules before the hook's
// own code runs, so it fires on the first turn of the event loop) the preload logs the resources
// that would keep the hook alive: "active <Type,Type...>" from process.getActiveResourcesInfo()
// (less the hook's own stdio pipes), or "active none". An unref'd child or timer is not listed; a referenced timer (Timeout), child
// (ProcessWrap), socket (TCPSocketWrap) or pending async I/O (FSReqCallback) is. A hook that exits
// before that turn (process.exit) logs "active exit": nothing can keep it alive after that. This is
// the wait the counters above cannot see, read as events and not as elapsed time.
// The switch and NODE_OPTIONS are removed from process.env as soon as this file loads, so a child
// the hook starts (the detached heal, npm) runs exactly as it would without the preload.
const fs = require('node:fs');
const { recordBlocks } = require('./block-recorder');

const raw = process.env.TIMING_TEST_CLOCK;
if (raw) {
  const spec = JSON.parse(raw);
  delete process.env.TIMING_TEST_CLOCK;
  if (String(process.env.NODE_OPTIONS || '').includes('hook-clock-preload')) delete process.env.NODE_OPTIONS;
  const record = (line) => fs.appendFileSync(spec.log, `${line}\n`);

  // The hook's own stdin, stdout and stderr streams (fd 0 to 2) are left out: the harness gave it
  // those pipes, and an idle stdio pipe is listed by getActiveResourcesInfo but does not keep a
  // process alive. A pipe or socket the hook opened itself has another fd and stays in the list.
  const activeResources = () => {
    const types = process.getActiveResourcesInfo();
    for (const handle of process._getActiveHandles()) {
      if (handle.fd !== 0 && handle.fd !== 1 && handle.fd !== 2) continue;
      const at = types.findIndex((type) => type === 'PipeWrap' || type === 'TTYWrap');
      if (at !== -1) types.splice(at, 1);
    }
    return types;
  };
  let turned = false;
  setImmediate(() => {
    turned = true;
    record(`active ${activeResources().join(',') || 'none'}`);
  });
  process.on('exit', () => {
    if (!turned) record('active exit');
  });

  if (spec.atomics) {
    const realWait = Atomics.wait;
    const realNow = Date.now;
    const base = realNow.call(Date);
    let skipped = 0;
    Atomics.wait = function recordedWait(typedArray, index, value, timeout) {
      record(`sleep ${timeout}`);
      if (spec.atomics === 'count') return realWait.call(Atomics, typedArray, index, value, timeout);
      skipped += Number(timeout) || 0;
      return 'timed-out';
    };
    if (spec.atomics === 'virtual') Date.now = () => base + skipped;
  }

  if (spec.atomics || spec.timers) {
    recordBlocks(({ file, timeout }) => record(`block ${file.replace(/\s+/g, ' ')} ${timeout === Infinity ? 'none' : timeout}`));
    process.on('exit', () => {
      const used = process.cpuUsage();
      record(`cpu ${(used.user + used.system) / 1000}`);
    });
  }

  if (spec.timers) {
    // Each recorded timer runs as an immediate scheduled when the hook sets it, so it always runs
    // after the first-turn snapshot above (which was scheduled first): a real 1 ms timer could be
    // due before that snapshot on a slow turn and hide what the hook still held. clearTimeout
    // cancels such an immediate; the snapshot lists a pending one as "Immediate".
    const realClearTimeout = globalThis.clearTimeout;
    globalThis.setTimeout = function recordedTimeout(callback, ms, ...args) {
      record(`timer ${Number(ms) || 0}`);
      return setImmediate(callback, ...args);
    };
    globalThis.clearTimeout = function recordedClear(handle) {
      return handle && handle.constructor && handle.constructor.name === 'Immediate' ? clearImmediate(handle) : realClearTimeout(handle);
    };
  }
}

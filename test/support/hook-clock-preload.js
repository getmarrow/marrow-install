'use strict';

// Test-only preload for a hook process a test spawns (loaded with NODE_OPTIONS=--require=<this
// file>, set by the test through hook-clock.js). It records the waits the hook asks for in a log
// file and, in virtual mode, lets the hook pass them without sleeping. Nothing under src/ or bin/
// reads this file or its switch, and it is not packed. The switch is TIMING_TEST_CLOCK, a JSON
// object the test puts in the hook's environment:
//   log      file the recorded waits are appended to, one per line: "sleep <ms>" or "timer <ms>"
//   atomics  "count"   record every Atomics.wait and still sleep for real
//            "virtual" record every Atomics.wait, return at once, and move Date.now forward by the
//                      requested ms (Date.now is otherwise frozen, so a wait loop that checks a
//                      budget against Date.now runs exactly budget/step times)
//   timers   "instant" record every setTimeout and run it on the next turn of the event loop
// The switch and NODE_OPTIONS are removed from process.env as soon as this file loads, so a child
// the hook starts (the detached heal, npm) runs exactly as it would without the preload.
const fs = require('node:fs');

const raw = process.env.TIMING_TEST_CLOCK;
if (raw) {
  const spec = JSON.parse(raw);
  delete process.env.TIMING_TEST_CLOCK;
  if (String(process.env.NODE_OPTIONS || '').includes('hook-clock-preload')) delete process.env.NODE_OPTIONS;
  const record = (line) => fs.appendFileSync(spec.log, `${line}\n`);

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

  if (spec.timers) {
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = function recordedTimeout(callback, ms, ...args) {
      record(`timer ${Number(ms) || 0}`);
      return realSetTimeout(callback, 0, ...args);
    };
  }
}

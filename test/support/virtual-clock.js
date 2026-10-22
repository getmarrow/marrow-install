'use strict';

// Test-only virtual clock for in-process tests. While installed it replaces setTimeout,
// clearTimeout, Date.now and AbortSignal.timeout, so a test can run code that waits or gives up
// after N ms without sleeping, read the exact waits it asked for, and finish at a known virtual
// time. Nothing under src/ or bin/ reads this file or a switch for it; it is not packed.
//
//   events   every wait the code under test asked for, in order: { kind: 'sleep' | 'timeout', ms }
//            ('sleep' is setTimeout, 'timeout' is AbortSignal.timeout)
//   now      virtual milliseconds that have passed
//   run(p)   drives virtual time forward whenever the code is idle until p settles, then returns
//            or throws what p did

const realSetImmediate = globalThis.setImmediate;
const turn = () => new Promise((resolve) => realSetImmediate(resolve));

function installVirtualClock() {
  const real = {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    now: Date.now,
    abortTimeout: AbortSignal.timeout,
  };
  const base = real.now.call(Date);
  const timers = new Map();
  const events = [];
  let now = 0;
  let sequence = 0;

  class VirtualTimeout {
    constructor(id) { this.id = id; }
    unref() { return this; }
    ref() { return this; }
    hasRef() { return true; }
    refresh() { return this; }
    [Symbol.toPrimitive]() { return this.id; }
  }

  function schedule(callback, ms, args = []) {
    sequence += 1;
    const handle = new VirtualTimeout(sequence);
    timers.set(handle, { at: now + Math.max(0, Number(ms) || 0), sequence, callback, args });
    return handle;
  }

  globalThis.setTimeout = function virtualSetTimeout(callback, ms, ...args) {
    events.push({ kind: 'sleep', ms: Number(ms) || 0 });
    return schedule(callback, ms, args);
  };
  globalThis.clearTimeout = function virtualClearTimeout(handle) {
    if (handle instanceof VirtualTimeout) timers.delete(handle);
    else real.clearTimeout(handle);
  };
  Date.now = () => base + now;
  AbortSignal.timeout = function virtualAbortTimeout(ms) {
    events.push({ kind: 'timeout', ms });
    const controller = new AbortController();
    schedule(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms);
    return controller.signal;
  };

  function earliest() {
    let best = null;
    for (const [handle, timer] of timers) {
      if (!best || timer.at < best.timer.at || (timer.at === best.timer.at && timer.sequence < best.timer.sequence)) best = { handle, timer };
    }
    return best;
  }

  return {
    events,
    get now() { return now; },
    get pending() { return timers.size; },
    async run(promise, { idleTurns = 5, stalledTurns = 200 } = {}) {
      let state = 'pending';
      let value;
      let error;
      promise.then((v) => { state = 'fulfilled'; value = v; }, (e) => { state = 'rejected'; error = e; });
      let stalled = 0;
      while (state === 'pending') {
        for (let i = 0; i < idleTurns && state === 'pending'; i += 1) await turn();
        if (state !== 'pending') break;
        const next = earliest();
        if (!next) {
          stalled += 1;
          if (stalled > stalledTurns) throw new Error('the code under test is idle with no timer pending');
          continue;
        }
        stalled = 0;
        timers.delete(next.handle);
        now = Math.max(now, next.timer.at);
        next.timer.callback(...next.timer.args);
      }
      if (state === 'rejected') throw error;
      return value;
    },
    restore() {
      globalThis.setTimeout = real.setTimeout;
      globalThis.clearTimeout = real.clearTimeout;
      Date.now = real.now;
      AbortSignal.timeout = real.abortTimeout;
    },
  };
}

module.exports = { installVirtualClock, turn };

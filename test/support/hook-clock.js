'use strict';

// Test-side helpers for hook-clock-preload.js: run a spawned hook with its waits recorded (and,
// in virtual mode, skipped) and read back what it asked for.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const { recordBlocks } = require('./block-recorder');

const { spawnSync } = childProcess;

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
// cpuMs, active, exitedEarly, raw }. `blocks` are the synchronous child processes it ran (spawnSync,
// execSync, execFileSync); timeout is Infinity when the call set none. `cpuMs` is the CPU time the
// hook used (null when it logged none, for instance when it was killed). `active` is the list of
// resource types (process.getActiveResourcesInfo) that were still open on the first turn of the
// event loop, that is, right after the hook's synchronous work: [] when none, null when the hook
// logged nothing (killed, or the preload did not run). `exitedEarly` is true when the hook exited
// before that turn. `raw` is the whole log text, for a test that checks what the log must not hold.
function readWaits(log) {
  const raw = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
  const lines = raw.split('\n').filter(Boolean);
  const pick = (kind) => lines.filter((line) => line.startsWith(`${kind} `)).map((line) => Number(line.slice(kind.length + 1)));
  const blocks = lines.filter((line) => line.startsWith('block ')).map((line) => {
    const rest = line.slice('block '.length);
    const split = rest.lastIndexOf(' ');
    const timeout = rest.slice(split + 1);
    return { file: rest.slice(0, split), timeout: timeout === 'none' ? Infinity : Number(timeout) };
  });
  fs.rmSync(log, { force: true });
  const cpu = pick('cpu');
  const activeLines = lines.filter((line) => line.startsWith('active ')).map((line) => line.slice('active '.length));
  const active = activeLines.length === 1 ? (activeLines[0] === 'none' || activeLines[0] === 'exit' ? [] : activeLines[0].split(',')) : null;
  return { sleeps: pick('sleep'), timers: pick('timer'), blocks, cpuMs: cpu.length ? Math.max(...cpu) : null, active, exitedEarly: activeLines.includes('exit'), raw };
}

// The most CPU time one hook call may use. A hook that starts, checks its records and warns takes
// under 0.1 s of CPU (measured 65 to 95 ms on a loaded machine), and CPU time does not grow when the
// machine is busy. This is a hang guard, not a precise bound: it catches a block that waits on
// nothing the recorder sees, a busy loop, and it is a third of the old 3 s wall-clock check because
// a busy machine gives a spinning hook only part of a CPU (a 4 s loop measured 2.8 s of CPU).
const HOOK_CPU_GUARD_MS = 1000;

// Hang guard for a hook call that must return at once. The counters above see Atomics.wait, the
// blocking child calls and CPU time; they do not see a block that waits on nothing they count, for
// instance fs.readSync on a pipe or FIFO that never gets data. This is the wall-clock check for
// that one case, a fixed constant (not an env var, not scaled by load): the slowest normal call
// of these checks measured 217 ms on a host at load 36 (115 to 217 ms across all six), so ten
// times that is 2.2 s and the 30 s floor decides. It is far above any ordinary slowness under load
// and exists only to turn a true hang into a failure that says so, instead of waiting for the
// caller's own timeout (90 s in the hook runners) and then failing on a null exit status.
const HOOK_NORMAL_MAX_MS = 220;
const HOOK_HANG_GUARD_MS = Math.max(10 * HOOK_NORMAL_MAX_MS, 30_000);

// Runs one hook call under the hang guard: `spawn` is called with the spawnSync options that carry
// the bound and returns the spawnSync result, which comes back only if the hook did not hang. The
// hook is started as its own process-group leader and killed with SIGKILL, so a hook that traps
// SIGTERM or sits in a blocking read cannot outlive the guard. spawnSync's own timeout kills only
// the pid it started, and the hook is sh -> sh -> node, so the blocked process is a descendant:
// after a timeout the whole group is killed by its exact id (the group id is that pid). `cap`
// lowers the bound for a call whose runner already has a tighter timeout; it never raises it.
function hangGuarded(spawn, message, { cap = Infinity } = {}) {
  const bound = Math.min(cap, HOOK_HANG_GUARD_MS);
  const run = spawn({ timeout: bound, killSignal: 'SIGKILL', detached: true });
  const hung = Boolean(run.error) && run.error.code === 'ETIMEDOUT';
  if (hung && run.pid) {
    try {
      process.kill(-run.pid, 'SIGKILL');
    } catch {
      // nothing of the group is left
    }
  }
  assert.ok(!hung, `HANG GUARD: ${message}: the hook did not return within ${bound} ms and was killed (process group ${run.pid}); it is blocked on something no counter sees, such as a read on a pipe or FIFO that gets no data, which is not ordinary slowness`);
  return run;
}

// What each resource type in the active list means, for the failure message.
const RESOURCE_MEANS = {
  Timeout: 'a referenced timer',
  Immediate: 'a pending setImmediate',
  ProcessWrap: 'a child process that is not unref\'d',
  PipeWrap: 'an open pipe',
  TCPSocketWrap: 'an open socket',
  TCPServerWrap: 'a listening server',
  FSReqCallback: 'pending async file I/O',
};

// A hook call that blocked nothing: it ran no blocking child (no allowlist: the hook's warn paths
// start the heal detached and never run npm inline), used little CPU, and its event loop was empty
// once its synchronous work was done: nothing but an unref'd child or timer was left, so the
// process exits at once and a referenced timer, a child that is not unref'd, a socket or pending
// async I/O (each of which would hold the process open for as long as it lasts) is a failure that
// names the resource type. `allow` is for a hook that waits on its own child by design: the most of
// each resource type it may legitimately still hold ({ Timeout: 1 }); anything else, or more, fails.
function assertNoBlock(waits, message, { allow = {} } = {}) {
  assert.deepEqual(waits.blocks, [], `${message}: the hook ran a blocking child`);
  assert.ok(waits.cpuMs !== null && waits.cpuMs < HOOK_CPU_GUARD_MS, `${message}: the hook used ${waits.cpuMs} ms of CPU`);
  assert.ok(waits.active !== null, `${message}: the hook logged no active-resources record (it was killed, or the preload did not run)`);
  const held = [];
  for (const type of new Set(waits.active)) {
    const count = waits.active.filter((name) => name === type).length;
    if (count > (allow[type] || 0)) held.push(`${count} x ${type} (${RESOURCE_MEANS[type] || 'an open handle'})`);
  }
  assert.deepEqual(held, [], `${message}: the hook's event loop was still held open after its synchronous work by ${held.join(', ')}, so it would wait for that before it exits`);
}

// A hook call that must warn or hold at once: it entered no wait and blocked nothing. So a hook
// that blocks without Atomics.wait (a spawnSync or execFileSync that waits for a child, a busy
// loop) is caught as well.
function assertAtOnce(waits, message) {
  assert.deepEqual(waits.sleeps, [], `${message}: the hook entered its wait`);
  assertNoBlock(waits, message);
}

// Positive control for the recorder, in two parts. Both run inside the suite, so a recorder (or a
// preload logger) that drops `this`, cuts arguments, adds a default timeout, records after the call
// (a throwing or never-returning child goes unseen), skips calls that have no timeout, or logs
// arguments, options or env fails the test that calls this, not only a probe somebody runs by hand.
// A dummy secret, made at run time, goes through every channel a secret could take (arguments, env,
// a command line) and must not come out in anything the recorder reports or the preload logs.
function assertBlockingChildObservable() {
  const secret = crypto.randomBytes(12).toString('hex');
  assertRecorderPassesCallsThrough(secret);
  assertPreloadLogsEveryCall(secret);
}

// Part 1: the recorder around a spy that stands in for each original. For every function and shape
// (bounded, unbounded with options, no options, an extra trailing argument, a call that throws), the
// spy must see the very `this`, argument list and options object the caller passed, return what it
// returns or throw what it throws, and be reported once, before it runs, as exactly { file, timeout }.
function assertRecorderPassesCallsThrough(secret) {
  const names = ['spawnSync', 'execSync', 'execFileSync'];
  const saved = Object.fromEntries(names.map((name) => [name, childProcess[name]]));
  const boom = new Error('the spy throws');
  const returned = { status: 0 };
  const sentinel = {};
  const events = [];
  let seen = null;
  const spies = Object.fromEntries(names.map((name) => [name, function spy(...args) {
    seen = { self: this, args, reportedBefore: events.length };
    if (args.some((arg) => arg === 'throws')) throw boom;
    return returned;
  }]));
  try {
    for (const name of names) childProcess[name] = spies[name];
    const restore = recordBlocks((block) => events.push(block));
    try {
      for (const name of names) {
        const shell = name === 'execSync';
        const options = (extra) => Object.freeze({ encoding: 'utf8', env: { DUMMY_SECRET: secret }, ...extra });
        // [description, arguments, the timeout the report must carry, whether the call throws]
        const shapes = [
          ['bounded', shell ? ['echo hi', options({ timeout: 5000 })] : ['echo', ['hi'], options({ timeout: 5000 })], 5000, false],
          ['unbounded, with options', shell ? ['echo hi', options()] : ['echo', ['hi'], options()], Infinity, false],
          ['no options', shell ? ['echo hi'] : ['echo', ['hi']], Infinity, false],
          ['no options, no args', shell ? ['echo hi'] : ['echo'], Infinity, false],
          ['an extra trailing argument', shell ? ['echo hi', options(), 'extra', 'more'] : ['echo', ['hi'], options({ timeout: 4000 }), 'extra'], shell ? Infinity : 4000, false],
          ['bounded, throws', shell ? ['throws', options({ timeout: 3000 })] : ['throws', ['hi'], options({ timeout: 3000 })], 3000, true],
          ['unbounded, throws', shell ? ['throws'] : ['throws'], Infinity, true],
        ];
        for (const [shape, args, timeout, throws] of shapes) {
          for (const [how, self] of [['as a method of child_process', childProcess], ['with another this', sentinel]]) {
            const label = `${name}, ${shape}, ${how}`;
            events.length = 0;
            seen = null;
            let got;
            const call = () => (self === childProcess ? childProcess[name](...args) : childProcess[name].call(self, ...args));
            if (throws) assert.throws(call, (error) => error === boom, `${label}: the same error comes back`);
            else got = call();
            if (!throws) assert.equal(got, returned, `${label}: the same result comes back`);
            assert.ok(seen !== null, `${label}: the original ran`);
            assert.equal(seen.self, self, `${label}: the original gets the caller's this`);
            assert.equal(seen.args.length, args.length, `${label}: the original gets every argument and no more`);
            assert.ok(seen.args.every((arg, i) => arg === args[i]), `${label}: the original gets the same arguments, options included, not copies`);
            assert.equal(seen.reportedBefore, 1, `${label}: the call is reported before it runs (a call that throws or never returns is reported too)`);
            assert.equal(events.length, 1, `${label}: the call is reported once`);
            assert.deepEqual(events[0], { file: args[0].split(' ')[0], timeout }, `${label}: only the program and the timeout are reported`);
          }
        }
        // The report never carries the arguments, options or env, so the dummy secret is nowhere in it,
        // and a shell command line is cut to its first word (a leading NAME=value to its name).
        events.length = 0;
        if (shell) {
          childProcess.execSync(`DUMMY_SECRET=${secret} echo hi`, options({ timeout: 6000 }));
          childProcess.execSync(`echo ${secret}`);
          assert.deepEqual(events, [{ file: 'DUMMY_SECRET=', timeout: 6000 }, { file: 'echo', timeout: Infinity }], 'execSync reports the first word only');
        } else {
          childProcess[name]('echo', [secret], options({ timeout: 6000 }));
          assert.deepEqual(events, [{ file: 'echo', timeout: 6000 }], `${name} reports the program only`);
        }
        assert.equal(JSON.stringify(events).includes(secret), false, `${name}: the dummy secret reached the report`);
      }
    } finally {
      restore();
    }
    for (const name of names) assert.equal(childProcess[name], spies[name], `${name} is put back`);
  } finally {
    for (const name of names) childProcess[name] = saved[name];
  }
}

// Part 2: a process under the real preload runs real children in every shape, through all three
// functions, and the log must hold exactly one line per call, in order, with the program and the
// timeout the call set ("none" for an unbounded call), including the calls that throw. The children
// run as they would without the preload (output, exit status, env, timeout). The dummy secret goes
// through arguments, env and a command line and must not be in the log.
function assertPreloadLogsEveryCall(secret) {
  const log = clockLog();
  const probe = `
    const cp = require('node:child_process');
    const secret = process.env.DUMMY_SECRET;
    const out = [];
    const ran = (label, call) => { try { const r = call(); out.push(typeof r === 'string' || Buffer.isBuffer(r) ? [label, 'ok', 0, String(r).trim()] : [label, 'ok', r.status, String(r.stdout).trim()]); } catch (error) { out.push([label, 'threw', error.status === undefined ? error.code : error.status, '']); } };
    const text = { encoding: 'utf8' };
    ran('s-bounded', () => cp.spawnSync('echo', ['seen'], { ...text, timeout: 5000 }));
    ran('s-options', () => cp.spawnSync('echo', ['seen'], text));
    ran('s-bare', () => cp.spawnSync('echo', ['seen']));
    ran('s-env', () => cp.spawnSync('sh', ['-c', 'echo \${#API_KEY}', secret], { ...text, env: { PATH: process.env.PATH, API_KEY: secret }, timeout: 7000 }));
    ran('s-throws', () => cp.spawnSync('echo', ['x'], { stdio: 'bogus', timeout: 2000 }));
    ran('s-throws-bare', () => cp.spawnSync('echo', ['x'], { stdio: 'bogus' }));
    ran('f-bounded', () => cp.execFileSync('echo', ['seen'], { ...text, timeout: 6000 }));
    ran('f-options', () => cp.execFileSync('echo', ['seen'], text));
    ran('f-bare', () => cp.execFileSync('echo', ['seen']));
    ran('f-throws', () => cp.execFileSync('sh', ['-c', 'exit 3', secret], { timeout: 4000 }));
    ran('f-throws-bare', () => cp.execFileSync('sh', ['-c', 'exit 3']));
    ran('e-bounded', () => cp.execSync('echo seen', { ...text, timeout: 8000 }));
    ran('e-options', () => cp.execSync('echo seen', text));
    ran('e-bare', () => cp.execSync('echo seen'));
    ran('e-secret', () => cp.execSync('DUMMY_SECRET=' + secret + ' echo seen', text));
    ran('e-throws', () => cp.execSync('exit 3', { timeout: 3000, stdio: 'ignore' }));
    ran('e-throws-bare', () => cp.execSync('exit 4', { stdio: 'ignore' }));
    process.stdout.write(JSON.stringify(out));
  `;
  const run = spawnSync(process.execPath, ['-e', probe], { env: withHookClock({ PATH: process.env.PATH, DUMMY_SECRET: secret }, log, { atomics: 'virtual' }), encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr.includes(secret) ? 'the preload probe failed' : run.stderr);
  const seen = readWaits(log);
  assert.equal(seen.raw.includes(secret), false, 'the dummy secret reached the log');
  const ok = (label, stdout, status = 0) => [label, 'ok', status, stdout];
  const threw = (label, why) => [label, 'threw', why, ''];
  assert.deepEqual(JSON.parse(run.stdout), [
    ok('s-bounded', 'seen'), ok('s-options', 'seen'), ok('s-bare', 'seen'), ok('s-env', String(secret.length)),
    threw('s-throws', 'ERR_INVALID_ARG_VALUE'), threw('s-throws-bare', 'ERR_INVALID_ARG_VALUE'),
    ok('f-bounded', 'seen'), ok('f-options', 'seen'), ok('f-bare', 'seen'), threw('f-throws', 3), threw('f-throws-bare', 3),
    ok('e-bounded', 'seen'), ok('e-options', 'seen'), ok('e-bare', 'seen'), ok('e-secret', 'seen'), threw('e-throws', 3), threw('e-throws-bare', 4),
  ], 'the children ran as they would without the preload');
  assert.deepEqual(seen.blocks, [
    { file: 'echo', timeout: 5000 }, { file: 'echo', timeout: Infinity }, { file: 'echo', timeout: Infinity },
    { file: 'sh', timeout: 7000 }, { file: 'echo', timeout: 2000 }, { file: 'echo', timeout: Infinity },
    { file: 'echo', timeout: 6000 }, { file: 'echo', timeout: Infinity }, { file: 'echo', timeout: Infinity },
    { file: 'sh', timeout: 4000 }, { file: 'sh', timeout: Infinity },
    { file: 'echo', timeout: 8000 }, { file: 'echo', timeout: Infinity }, { file: 'echo', timeout: Infinity },
    { file: 'DUMMY_SECRET=', timeout: Infinity }, { file: 'exit', timeout: 3000 }, { file: 'exit', timeout: Infinity },
  ], 'the log holds every call, bounded or not, thrown or not, with its program and timeout');
  assert.ok(seen.cpuMs !== null && seen.cpuMs < HOOK_CPU_GUARD_MS, 'the CPU time is logged at exit');
}

// Positive control for the open-resource check in assertNoBlock. Each probe runs under the preload,
// does one thing and exits from its own setImmediate, which runs right after the preload's, so the
// preload sees the state on the first turn of the event loop and no probe waits for anything (that
// pending exit is the one "Immediate" every probe's log lists). The log must name what is open: nothing for the hook's own stdio pipes or an unref'd child or timer,
// and the resource type for a referenced child (the shape of a heal that is not unref'd), timer or
// socket. A process that exits before the loop turns logs "exit". The failure message must name the
// type. Without these, a preload that logs nothing, or always logs "none", would pass every check.
function assertActiveResourcesObservable() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-active-'));
  try {
    activeResourcesControl(path.join(dir, 'server.sock'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function activeResourcesControl(socketPath) {
  const probes = [
    ['stderr and stdout only', "process.stderr.write('warn\\n');process.stdout.write('out\\n')", []],
    ['an unref\'d child', "spawn('sleep',['5'],{detached:true,stdio:'ignore'}).unref()", []],
    ['an unref\'d timer', 'setTimeout(()=>{},60000).unref()', []],
    ['a child that is not unref\'d', "spawn('sleep',['5'],{detached:true,stdio:'ignore'})", ['ProcessWrap']],
    ['a referenced timer', 'setTimeout(()=>{},60000)', ['Timeout']],
    // (The stdio pipes are left out of the list by file descriptor: a pipe or socket the hook opens
    // itself, here a unix-socket server next to a write to stderr, must still be listed.)
    ['a unix-socket server beside the stderr pipe', `process.stderr.write('warn\\n');net.createServer().listen(${JSON.stringify(socketPath)})`, ['PipeWrap']],
    ['a listening server', "net.createServer().listen(0,'127.0.0.1')", ['TCPServerWrap']],
    // (The server accepts the client's connection on a loop turn that may come before or after the
    // snapshot, so this probe asserts that both types are listed, not how many sockets there are.)
    ['an open client socket', "net.createServer().listen(0,'127.0.0.1',function(){net.connect(this.address().port,'127.0.0.1')})", ['TCPServerWrap', 'TCPSocketWrap'], false],
  ];
  for (const [what, body, expected, exact = true] of probes) {
    const log = clockLog();
    const script = `const net=require('node:net'),kids=[];const spawn=(...a)=>{const k=require('node:child_process').spawn(...a);kids.push(k);return k};${body};setImmediate(()=>{for(const k of kids)k.kill('SIGKILL');process.exit(0)})`;
    const run = spawnSync(process.execPath, ['-e', script], { env: withHookClock({ PATH: process.env.PATH }, log, { atomics: 'virtual' }), encoding: 'utf8' });
    assert.equal(run.status, 0, `${what}: ${run.stderr}`);
    const seen = readWaits(log);
    assert.ok(seen.active !== null, `${what}: the preload logged the active resources`);
    if (exact) assert.deepEqual([...seen.active].sort(), ['Immediate', ...expected].sort(), `${what}: the log names what is open on the first turn of the event loop`);
    else for (const type of expected) assert.ok(seen.active.includes(type), `${what}: the log names ${type}`);
    assert.equal(seen.exitedEarly, false, what);
  }
  const log = clockLog();
  const early = spawnSync(process.execPath, ['-e', "setTimeout(()=>{},60000);process.exit(0)"], { env: withHookClock({ PATH: process.env.PATH }, log, { atomics: 'virtual' }), encoding: 'utf8' });
  assert.equal(early.status, 0, early.stderr);
  const seenEarly = readWaits(log);
  assert.ok(seenEarly.exitedEarly && seenEarly.active !== null && seenEarly.active.length === 0, 'a hook that exits before the event loop turns is logged as exited');
  const calm = { blocks: [], cpuMs: 1, active: [] };
  assertNoBlock(calm, 'control');
  for (const [type, active] of [['Timeout', ['Timeout']], ['ProcessWrap', ['ProcessWrap']], ['TCPSocketWrap', ['TCPSocketWrap', 'TCPServerWrap']]]) {
    assert.throws(() => assertNoBlock({ ...calm, active }, 'control'), (error) => error.message.includes(`1 x ${type} (`) && error.message.includes('event loop was still held open'), `a held ${type} fails and the message names it`);
  }
  assert.throws(() => assertNoBlock({ ...calm, active: null }, 'control'), /logged no active-resources record/);
  assert.throws(() => assertNoBlock({ ...calm, active: ['Timeout', 'Timeout'] }, 'control', { allow: { Timeout: 1 } }), /2 x Timeout/);
  assertNoBlock({ ...calm, active: ['Timeout'] }, 'control', { allow: { Timeout: 1 } });
}

// Positive control for the hang guard: a process blocked in a read on a FIFO that never gets data
// (opened read-write, so it has no writer to wait for and nothing to wake it) is killed by the
// guard and the guard fails with its own message. The bound is lowered to 2 s for this probe only.
function assertHangGuardObservable() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-hang-guard-'));
  const fifo = path.join(dir, 'never-gets-data');
  try {
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0, 'mkfifo made the FIFO');
    const probe = `const fs=require('node:fs');fs.readSync(fs.openSync(${JSON.stringify(fifo)},'r+'),Buffer.alloc(1),0,1,null)`;
    let run = null;
    assert.throws(
      () => hangGuarded((guard) => (run = spawnSync(process.execPath, ['-e', probe], { env: { PATH: process.env.PATH }, ...guard })), 'control', { cap: 2000 }),
      /^AssertionError.*HANG GUARD: control: the hook did not return within 2000 ms and was killed/,
    );
    assert.equal(run.signal, 'SIGKILL', 'the guard killed the blocked process, and spawnSync returned only after it exited');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { assertActiveResourcesObservable, assertAtOnce, assertBlockingChildObservable, assertHangGuardObservable, assertNoBlock, clockLog, hangGuarded, readWaits, withHookClock, PRELOAD };

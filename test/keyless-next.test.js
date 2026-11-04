// KEYLESS-NEXT (round 1): with no key every installer command gives the one next step `activate` gives
// (PROD-VERIFY-A C14, C15, C18, C21). Spec S1-S5, abuse rows A1-A16. Every row runs the real CLI in a child
// process inside a private fake home; stdin is /dev/null and stdout a pipe unless the row says TTY.
// Network: a loopback fake for the keyed rows, the offline recorder (test/support/m2-network-recorder.js) for the rest.
require('./support/isolated-environment');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { spawn, spawnSync } = require('node:child_process');
const { redact, runFleetInteractive } = require('../src/governed-runner');

const BIN = path.join(__dirname, '..', 'bin', 'marrow-install.js');
const SUPPORT = (name) => path.join(__dirname, 'support', name);
const NEXT = 'No Marrow key was found on this machine. Create a key at https://getmarrow.ai/signup, save it in the owner-only file ~/.marrow/env (chmod 600), then run `npx -y @getmarrow/install@latest activate`.';
const KEY = `keyless-dummy-${crypto.randomBytes(8).toString('hex')}`;
assert.doesNotMatch(KEY, /^(?:sk|pk|rk)_|^ghp_|^xox/);
const EARLY = 'No Marrow key is on this machine yet';
const count = (text, needle) => text.split(needle).length - 1;
const FIX_LINE = /\bnpx\b|npm install/;
// Fix commands in the part of the doctor output before its warnings.
const fixCommands = (out) => out.split('\nWarnings:')[0].split('\n').filter((line) => FIX_LINE.test(line)).length;

function world(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'keyless-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const w = { root, home: path.join(root, 'home'), proj: path.join(root, 'proj'), bin: path.join(root, 'bin'), net: path.join(root, 'net.jsonl') };
  for (const dir of [w.home, w.proj, w.bin, path.join(w.home, '.marrow')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(w.proj, 'CLAUDE.md'), '# marker\n');
  return w;
}
function ownerFile(w, text, name = 'env') {
  const file = path.join(w.home, '.marrow', name);
  fs.writeFileSync(file, text, { mode: 0o600 });
  return file;
}
async function fake(t, status = 200) {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(status === 200 ? { ok: true, data: { live_agent_count: 3 } } : { error: 'unauthorized' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}`, hits };
}
function run(w, args, { env = {}, tty = null, server = null, shell = null } = {}) {
  const merged = {
    PATH: `${w.bin}${path.delimiter}${process.env.PATH}`, HOME: w.home, TMPDIR: w.root, CAPTURE_FILE: w.net, M2_STUB_NPM: '1',
    HOMEROOT_PASSWD_HOME: path.join(w.root, 'no-passwd-home'), ...(tty ? { HOMEROOT_TTY: tty } : {}), ...(server ? { MARROW_BASE_URL: server.url } : {}), ...env,
  };
  const preload = [...(server ? [] : ['--require', SUPPORT('m2-network-recorder.js')]), '--require', SUPPORT('homeroot-preload.cjs')];
  const argv = shell ? ['-qec', `${[process.execPath, ...preload, BIN, ...args].join(' ')}`, '/dev/null'] : [...preload, BIN, ...args];
  return new Promise((resolve) => {
    const child = spawn(shell ? 'script' : process.execPath, argv, { cwd: w.proj, env: merged, stdio: [shell ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    // A terminal run that waits for a key (the full-screen view) is sent q, then stopped: a red row, never a hang.
    const timers = shell ? [setTimeout(() => child.stdin.write('q'), 3000), setTimeout(() => child.kill('SIGKILL'), 20000)] : [];
    if (shell) child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => {
      timers.forEach(clearTimeout);
      const out = `${stdout}${stderr}`;
      assert.ok(!out.includes(KEY), 'A16: the key never reaches the output');
      resolve({ code, stdout, stderr, out });
    });
  });
}
const clean = (out) => { for (const bad of ["can't find your key", 'Put MARROW_API_KEY=', '[REDACTED', '..']) assert.ok(!out.includes(bad), `no ${bad} in:\n${out}`); };
const netCount = (w) => (fs.existsSync(w.net) ? fs.readFileSync(w.net, 'utf8').split('\n').filter(Boolean).length : 0);
const stub = (w, name) => {
  const marker = path.join(w.root, `${name}.ran`);
  fs.writeFileSync(path.join(w.bin, name), `#!/bin/sh\necho ran > "${marker}"\n`, { mode: 0o755 });
  return marker;
};

// S3: one constant; it survives the redactor unchanged.
test('S3 the next step is one static line that redact() leaves alone', () => {
  const { KEYLESS_NEXT_STEP } = require('../src/owner-env');
  assert.equal(KEYLESS_NEXT_STEP, NEXT);
  assert.equal(redact(NEXT), NEXT);
  assert.equal(redact(NEXT, 'text', { field: true }), NEXT);
  assert.ok(NEXT.length <= 240 && NEXT.endsWith('.') && !NEXT.endsWith('..') && !NEXT.includes('[REDACTED'));
  assert.equal(count(NEXT, 'npx'), 1);
});
test('S3 activate keeps its own message', async (t) => {
  const result = await run(world(t), ['activate']);
  assert.equal(result.code, 2);
  assert.equal(result.out, 'Marrow needs your API key. Nothing was written. Create a key at https://getmarrow.ai/signup, save it as MARROW_API_KEY=your_key in the owner-only file ~/.marrow/env, then run chmod 700 ~/.marrow && chmod 600 ~/.marrow/env, then run: npx -y @getmarrow/install@latest activate  (fallback: MARROW_API_KEY=your_key npx -y @getmarrow/install@latest activate)\n');
});

// S4: doctor, human output, nothing stored anywhere.
for (const args of [['doctor'], ['doctor', '--self-test']]) {
  test(`S4 ${args.join(' ')}: one next step, every warning kept`, async (t) => {
    const result = await run(world(t), args);
    assert.equal(result.code, 0, result.out);
    assert.equal(count(result.out, NEXT), 1, result.out);
    assert.equal(fixCommands(result.out), 1, `fix commands: ${fixCommands(result.out)}`);
    for (const kept of [EARLY, 'Seatbelt:', 'Hooks that start without a key skip silently', 'after the key, run doctor again']) assert.ok(result.out.includes(kept), `${kept} in:\n${result.out}`);
    for (const gone of ['backend_projection_not_provided', 'exact fix:', 'recommended fix:', 'controller ensure', '@getmarrow/sdk@']) assert.ok(!result.out.includes(gone), `${gone} gone`);
    clean(result.out);
  });
}
test('S4 doctor with any other argument keeps the full report', async (t) => {
  const w = world(t);
  for (const args of [['doctor', '--json'], ['doctor', '--cwd', w.proj], ['doctor', '--agent-id', 'a1']]) {
    const result = await run(w, args);
    assert.ok(!result.out.includes(EARLY), args.join(' '));
    assert.ok(result.out.includes('backend_projection_not_provided'), args.join(' '));
  }
  const json = JSON.parse((await run(w, ['doctor', '--json'])).stdout);
  assert.deepEqual(json.doctor.missingEnv, ['MARROW_API_KEY']);
});
// A1-A7: a key state that is not "nothing stored" prints what the full report prints.
const STATES = {
  'A1 MARROW_API_KEY empty': { env: { MARROW_API_KEY: '' } },
  'A2 MARROW_API_KEY spaces': { env: { MARROW_API_KEY: '   ' } },
  'A3 blank entry': { file: 'MARROW_API_KEY=\n' },
  'A4 unreadable': { file: `MARROW_API_KEY=${KEY}\n`, mode: 0o000, skipRoot: true, code: 1 },
  'A5 symlink to /dev/null': { link: '/dev/null' },
  'A6 env.local only': { local: `MARROW_API_KEY=${KEY}\n` },
};
for (const [name, state] of Object.entries(STATES)) {
  test(`${name}: doctor prints the full report, never the keyless early return`, async (t) => {
    if (state.skipRoot && process.getuid && process.getuid() === 0) return t.skip('root reads mode 000');
    const w = world(t);
    if (state.file !== undefined) fs.chmodSync(ownerFile(w, state.file), state.mode ?? 0o600);
    if (state.link) fs.symlinkSync(state.link, path.join(w.home, '.marrow', 'env'));
    if (state.local) ownerFile(w, state.local, 'env.local');
    const result = await run(w, ['doctor'], { env: state.env });
    assert.equal(result.code, state.code ?? 0, result.out);
    assert.ok(!result.out.includes(EARLY) && !result.out.includes(NEXT), `${name}:\n${result.out}`);
    if (state.code === undefined) assert.ok(result.out.includes('\nDoctor:\n'), result.out);
    if (/^A[123] /.test(name)) assert.ok(result.out.includes('- key problem:'), result.out);
  });
}
test('A12 a Marrow plugin that covers the key fix keeps its own fix, never activate', async (t) => {
  const w = world(t);
  const copy = path.join(w.home, '.claude', 'plugins', 'cache', 'getmarrow', 'marrow', '0.2.1');
  const put = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  const pre = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/marrow-launch.cjs" claude-pre-action-hook';
  put(path.join(copy, '.claude-plugin', 'plugin.json'), { name: 'marrow', version: '0.2.1' });
  put(path.join(copy, 'scripts', 'marrow-launch.cjs'), '// launcher\n');
  put(path.join(copy, 'hooks', 'hooks.json'), { hooks: Object.fromEntries(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop'].map((event) => [event, [{ hooks: [{ type: 'command', command: event === 'PreToolUse' ? pre : `${pre}-other` }] }]])) });
  put(path.join(w.home, '.claude', 'plugins', 'installed_plugins.json'), { version: 2, plugins: { 'marrow@getmarrow': [{ scope: 'user', installPath: copy, version: '0.2.1' }] } });
  put(path.join(w.home, '.claude', 'settings.json'), { enabledPlugins: { 'marrow@getmarrow': true } });
  const result = await run(w, ['doctor']);
  assert.equal(result.code, 0, result.out);
  assert.ok(!result.out.includes(EARLY) && !result.out.includes(NEXT), result.out);
  assert.ok(result.out.includes('/reload-plugins') && result.out.includes('supplied by the Marrow plugin'), result.out);
});

// S3/C18/C21: run, coverage, gate say the one next step.
test('C18 run of an unprotected command: runs, says the one step, no double period', async (t) => {
  const result = await run(world(t), ['run', '--', 'echo', 'hi']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'hi\n');
  assert.ok(result.stderr.includes(`Marrow degraded: ${NEXT} Continuing because this action is not protected`), result.stderr);
  clean(result.stderr);
});
for (const [name, args, code] of [['coverage', ['coverage'], 1], ['gate unprotected', ['gate', 'echo hi'], 1], ['gate protected', ['gate', 'wrangler deploy'], 1], ['status', ['status'], 1]]) {
  test(`C21 ${name}: the one next step, exit ${code}`, async (t) => {
    const result = await run(world(t), args);
    assert.equal(result.code, code, result.out);
    assert.ok(result.stderr.includes(`marrow-install failed: ${NEXT}`), result.stderr);
    clean(result.out);
  });
}
// A8-A11, A14, A15: decisions are BASE's.
test('A8-A9 run of a protected command with no key is blocked, the command never runs', async (t) => {
  const w = world(t);
  const marker = stub(w, 'wrangler');
  for (const args of [['run', '--', 'wrangler', 'deploy'], ['run', '--', 'sh', '-c', 'true && wrangler deploy'], ['run', '--fail-open', '--', 'wrangler', 'deploy']]) {
    const result = await run(w, args);
    assert.equal(result.code, 13, `${args.join(' ')}: ${result.out}`);
    assert.ok(result.stderr.includes(`BLOCKED: ${NEXT}`), result.stderr);
    assert.equal(fs.existsSync(marker), false, `${args.join(' ')}: the stub ran`);
  }
  assert.equal((await run(w, ['run', '--', 'wrangler', 'deploy'], { env: { MARROW_FAIL_OPEN: '1' } })).code, 13);
  assert.equal(fs.existsSync(marker), false);
});
test('A10-A11 gate of a protected action with no key never allows', async (t) => {
  const w = world(t);
  for (const args of [['gate', 'wrangler deploy'], ['gate', '--fail-open', 'wrangler deploy']]) assert.equal((await run(w, args)).code, 1, args.join(' '));
});
test('A14 misleading words change no classification or decision', async (t) => {
  const w = world(t);
  const marker = stub(w, 'wrangler');
  for (const text of ['echo activate no key', 'echo MARROW_API_KEY', 'echo ａctivate nо key', 'echo act​ivate', 'echo naïve ключ']) {
    const result = await run(w, ['gate', text]);
    assert.equal(result.code, 1, `${text}: ${result.out}`);
    assert.ok(result.stderr.includes(`marrow-install failed: ${NEXT}`), result.stderr);
  }
  const blocked = await run(w, ['run', '--', 'sh', '-c', 'echo activate no key; wrangler deploy']);
  assert.equal(blocked.code, 13);
  assert.equal(fs.existsSync(marker), false);
});
test('A15 --key on the command line is a key: no keyless line, no key bytes', async (t) => {
  const server = await fake(t);
  const result = await run(world(t), ['fleet', '--no-interactive', '--key', KEY], { server });
  assert.ok(!result.out.includes(NEXT) && result.out.includes('Live agents: 3'), result.out);
  assert.ok(server.hits.length > 0);
});

// S5: fleet.
for (const args of [['fleet'], ['fleet', '--no-interactive']]) {
  test(`S5 ${args.join(' ')} with no key: one short panel, no table, no network`, async (t) => {
    const w = world(t);
    const result = await run(w, args);
    assert.equal(result.code, 0, result.out);
    assert.equal(count(result.out, NEXT), 1, result.out);
    assert.ok(result.out.split('\n').filter(Boolean).length <= 6, result.out);
    for (const gone of ['Live agents:', 'unknown', 'Copy exact fix command', 'Partial data']) assert.ok(!result.out.includes(gone), `${gone} gone`);
    assert.equal(netCount(w), 0);
    clean(result.out);
  });
}
test('S5 fleet with a terminal and no key: the panel, raw mode never entered', async (t) => {
  const w = world(t);
  const result = await run(w, ['fleet'], { shell: true });
  assert.equal(count(result.out, NEXT), 1, result.out);
  assert.ok(!result.out.includes('\x1b[?25l'), 'cursor never hidden: raw mode was not entered');
  const input = Object.assign(new PassThrough(), { isTTY: true, rawCalls: 0, setRawMode() { this.rawCalls += 1; } });
  const output = Object.assign(new PassThrough(), { isTTY: true });
  let written = '';
  output.on('data', (chunk) => { written += chunk; });
  const quit = setTimeout(() => input.write('q'), 300);
  const snapshot = await runFleetInteractive({ apiKey: '', baseUrl: 'https://api.getmarrow.ai', agentId: '' }, input, output, true);
  clearTimeout(quit);
  assert.equal(input.rawCalls, 0);
  assert.ok(written.includes(NEXT) && !written.includes('\x1b[?25l'), written);
  assert.equal(snapshot.fix_commands[0], NEXT);
});
test('A13 fleet --json: same shape, the one next step, no placeholder', async (t) => {
  const w = world(t);
  const json = JSON.parse((await run(w, ['fleet', '--json'])).stdout);
  assert.equal(json.fix_commands[0], NEXT);
  assert.deepEqual(Object.keys(json), ['ok', 'generated_at', 'agent_id', 'base_url', 'live_agents', 'active_workflows', 'proof_waiting', 'failed_stale_outcomes', 'backpressure_status', 'capacity_next_action', 'recent_decisions', 'degraded_hooks', 'gates', 'arbitrations', 'activation_coverage', 'client_update', 'agents', 'fix_commands', 'source_errors']);
  assert.ok(Array.isArray(json.fix_commands) && json.fix_commands.every((line) => typeof line === 'string'));
  assert.ok(!JSON.stringify(json).includes('[REDACTED'));
});
test('A7 a key the server rejects: fleet and run print what they print today', async (t) => {
  const server = await fake(t, 401);
  const w = world(t);
  const fleet = await run(w, ['fleet', '--no-interactive'], { env: { MARROW_API_KEY: KEY }, server });
  assert.ok(!fleet.out.includes(NEXT) && fleet.out.includes('Live agents:'), fleet.out);
  const coverage = await run(w, ['coverage'], { env: { MARROW_API_KEY: KEY }, server });
  assert.ok(!coverage.out.includes(NEXT), coverage.out);
  assert.ok(server.hits.length > 0);
});
test('a key in the environment: fleet output is the table, never the keyless panel', async (t) => {
  const server = await fake(t);
  const result = await run(world(t), ['fleet', '--no-interactive'], { env: { MARROW_API_KEY: KEY }, server });
  assert.ok(result.out.includes('Live agents: 3') && !result.out.includes(NEXT), result.out);
});

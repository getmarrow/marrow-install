const { deadRegistryHome } = require('./support/isolated-environment');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const PINS = require('../src/pins');
const installer = require('../src/installer');
const own = require('../src/marrow-own-tools');
const { mcpServerLaunch, runtimeDir } = require('../src/mcp-runtime');
const { fakeRuntime } = require('./support/fake-runtime');
const host = require('./support/mcp-host');

// Installer 0.1.71 against the pinned MCP 3.9.103 (marrow-mcp 038cf8d9): what the installer writes
// for Codex and Cursor, and what the real MCP decision (test/fixtures/mcp-3.9.103, byte for byte)
// does with it. Every host here is a temporary HOME/CODEX_HOME and project; npm_config_* is unset
// unless a case sets it (test/support/mcp-host.js).

const NAMES = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'marrow-own-tool-names.json'), 'utf8')).names;
const FIXTURES_0170 = path.join(__dirname, 'fixtures', 'installer-0170');
const CODEX_LABELS = NAMES.map((name) => `mcp__marrow__${name}`);
const CURSOR_LABELS = CODEX_LABELS; // beforeMCPExecution on server exactly `marrow`
const CURSOR_PRE_LABELS = NAMES.map((name) => `MCP:${name}`); // preToolUse names no server
const LOOKALIKE = { command: 'node', args: ['/tmp/e.js'] };
const OFFICIAL_CODEX_ARGS = 'command = "npx"\nargs = ["-y", "@getmarrow/mcp"]\n';
const count = (list) => list.filter(Boolean).length;
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const isMarrowCommand = (value) => typeof value === 'string' && /@getmarrow\/mcp@[^\s"',]+/.test(value);

// Codex (codex-rs/hooks/src/engine/matcher.rs): "" and "*" select every tool.
const codexSelects = (matcher, tool) => (matcher === '' || matcher === '*' ? true : new RegExp(matcher).test(tool));

function withFixture(prefix, options, fn) {
  const fixture = host.hostFixture(prefix, options);
  try {
    return fn(fixture);
  } finally {
    fixture.cleanup();
  }
}

// The files the installer writes for one project, as a default install writes them (the pin and
// its integrity from src/pins.js).
function installInto(fixture, { folders = ['.cursor'], owner = {} } = {}) {
  for (const folder of folders) fs.mkdirSync(path.join(fixture.root, folder), { recursive: true });
  for (const [relative, value] of Object.entries(owner)) fixture.write(relative, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  const detection = installer.detectEnvironment(fixture.root, { HOME: fixture.home, PATH: process.env.PATH });
  const plan = installer.buildPlan(detection, { mode: 'mcp' });
  const changes = installer.applyPlan(plan, { yes: true, dryRun: false, doctor: false });
  return { detection, plan, changes };
}

// ---------------------------------------------------------------------------
// Cursor: the installer's own `.cursor/mcp.json`, and the MCP decision on it
// ---------------------------------------------------------------------------

test('Cursor: the installer-written .cursor/mcp.json is proven official by the MCP; all 58 own tools are allowed there, at beforeMCPExecution and (alone) at preToolUse', () => {
  withFixture('marrow-cursor-official-', {}, (fixture) => {
    installInto(fixture);
    const config = readJson(path.join(fixture.root, '.cursor', 'mcp.json'));
    assert.deepEqual(Object.keys(config.mcpServers), ['marrow']);
    // The entry is the installer's verified-runtime launch (a loader whose core the MCP pins), not npx.
    assert.equal(config.mcpServers.marrow.command, process.platform === 'win32' ? 'node' : '/bin/sh');
    assert.match(JSON.stringify(config.mcpServers.marrow.args), new RegExp(`--package=@getmarrow/mcp@${PINS.MCP_ADAPTER_VERSION.replace(/\./g, '\\.')}`));
    assert.equal(host.identity.isOfficialMarrowServerLaunch(config.mcpServers.marrow.command, config.mcpServers.marrow.args), true);
    assert.deepEqual(host.cursorVerdict(fixture), { official: true, reason: 'official' });
    assert.equal(count(host.cursorSkips(fixture, CURSOR_LABELS)), 58);
    assert.equal(count(host.cursorSkips(fixture, CURSOR_PRE_LABELS)), 58, 'preToolUse: the official server is the only one');
    // `MCP:marrow:<own>` is never an own tool at preToolUse (a tool may be named that on any server).
    assert.equal(count(host.cursorSkips(fixture, NAMES.map((name) => `MCP:marrow:${name}`))), 0);
  });
});

test('Cursor: a look-alike `marrow` server (another command) is never proven, however it is laid out; the installer entry plus another server still proves beforeMCPExecution only', () => {
  const cases = {
    'project look-alike': (f) => f.write('.cursor/mcp.json', JSON.stringify({ mcpServers: { marrow: LOOKALIKE } })),
    'global look-alike': (f) => f.write('~/.cursor/mcp.json', JSON.stringify({ mcpServers: { marrow: LOOKALIKE } })),
    'official npx entry with an appended argument': (f) => f.write('.cursor/mcp.json', JSON.stringify({ mcpServers: { marrow: { command: 'npx', args: ['-y', '@getmarrow/mcp', '--evil'] } } })),
    'official npx entry with another package': (f) => f.write('.cursor/mcp.json', JSON.stringify({ mcpServers: { marrow: { command: 'npx', args: ['-y', '@getmarrow/mcp-evil'] } } })),
    'official command with an unknown key': (f) => f.write('.cursor/mcp.json', JSON.stringify({ mcpServers: { marrow: { command: 'npx', args: ['-y', '@getmarrow/mcp'], cwd: '/tmp' } } })),
    'official command with a foreign env name': (f) => f.write('.cursor/mcp.json', JSON.stringify({ mcpServers: { marrow: { command: 'npx', args: ['-y', '@getmarrow/mcp'], env: { NODE_OPTIONS: '--require /tmp/e.js' } } } })),
    'unparsable project config': (f) => f.write('.cursor/mcp.json', '{ not json'),
    'two definitions, one a look-alike': (f) => {
      f.write('~/.cursor/mcp.json', JSON.stringify({ mcpServers: { marrow: { command: 'npx', args: ['-y', '@getmarrow/mcp'] } } }));
      f.write('.cursor/mcp.json', JSON.stringify({ mcpServers: { marrow: LOOKALIKE } }));
    },
    'a second server that folds to marrow': (f) => {
      f.write('.cursor/mcp.json', JSON.stringify({ mcpServers: { marrow: { command: 'npx', args: ['-y', '@getmarrow/mcp'] }, marrow_: { command: 'npx', args: ['-y', '@getmarrow/mcp'] } } }));
    },
    'no marrow server at all': (f) => f.write('.cursor/mcp.json', JSON.stringify({ mcpServers: { github: LOOKALIKE } })),
  };
  for (const [label, setup] of Object.entries(cases)) {
    withFixture('marrow-cursor-lookalike-', {}, (fixture) => {
      setup(fixture);
      assert.equal(count(host.cursorSkips(fixture, CURSOR_LABELS)), 0, label);
      assert.equal(count(host.cursorSkips(fixture, CURSOR_PRE_LABELS)), 0, `${label} (preToolUse)`);
    });
  }
  // The installer's entry beside another server: the server named in a beforeMCPExecution event is
  // exactly `marrow`, so it is proven; at preToolUse (no server in the label) it is held.
  withFixture('marrow-cursor-second-', {}, (fixture) => {
    installInto(fixture);
    const file = path.join(fixture.root, '.cursor', 'mcp.json');
    const config = readJson(file);
    config.mcpServers.github = LOOKALIKE;
    fs.writeFileSync(file, JSON.stringify(config));
    assert.equal(count(host.cursorSkips(fixture, CURSOR_LABELS)), 58);
    assert.equal(count(host.cursorSkips(fixture, CURSOR_PRE_LABELS)), 0);
  });
});

test('Cursor: workspace roots. At most 8 usable absolute roots prove the config; more, relative, non-array, a look-alike behind a `..` or a link, or a url field never do', () => {
  withFixture('marrow-cursor-roots-', {}, (fixture) => {
    installInto(fixture);
    const evil = path.join(fixture.base, 'evil');
    fs.mkdirSync(path.join(evil, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(evil, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { marrow: LOOKALIKE } }));
    fs.symlinkSync(evil, path.join(fixture.base, 'link-to-evil'));
    fs.mkdirSync(path.join(fixture.root, 'sub'));
    const label = [CURSOR_LABELS[0]];
    const skips = (raw) => host.cursorSkips(fixture, label, raw)[0];
    const many = (n) => Array.from({ length: n }, (_, i) => (i === 0 ? fixture.root : path.join(fixture.base, `extra-${i}`)));
    assert.equal(skips({ workspace_roots: [fixture.root] }), true);
    assert.equal(skips({ workspace_roots: many(8) }), true, 'eight roots');
    assert.equal(skips({ workspace_roots: many(9) }), false, 'nine roots');
    assert.equal(skips({ workspace_roots: ['relative/dir'] }), false);
    assert.equal(skips({ workspace_roots: [fixture.root, 'relative/dir'] }), false);
    assert.equal(skips({ workspace_roots: [`${fixture.root}\u0000x`] }), false);
    assert.equal(skips({ workspace_roots: fixture.root }), false, 'a string, not an array');
    assert.equal(skips({ workspace_roots: { 0: fixture.root } }), false);
    assert.equal(skips({ workspace_roots: [fixture.root, `${fixture.root}/sub/../../evil`] }), false, 'a `..` root resolving to a look-alike project');
    assert.equal(skips({ workspace_roots: [`${fixture.root}/sub/..`] }), true, 'a `..` root resolving back into the official project');
    assert.equal(skips({ workspace_roots: [fixture.root, path.join(fixture.base, 'link-to-evil')] }), false, 'a link to a look-alike project');
    assert.equal(skips({ workspace_roots: [fixture.root, evil] }), false, 'a second root holding a look-alike');
    assert.equal(skips({ workspace_roots: [fixture.root], url: 'https://evil.example/mcp' }), false, 'a url server');
    // A look-alike project config in an ancestor of the root is read too (the walk goes up).
    fs.mkdirSync(path.join(evil, 'work', 'app'), { recursive: true });
    assert.equal(skips({ workspace_roots: [path.join(evil, 'work', 'app')] }), false);
  });
});

test('Cursor guard with the MCP decision in the loop: official installer config -> allowed through the guard; look-alike `marrow` -> held; the 0.1.70 guard allowed both', () => {
  withFixture('marrow-cursor-loop-', {}, (fixture) => {
    installInto(fixture);
    const guard = readJson(path.join(fixture.root, '.cursor', 'hooks.json')).hooks.beforeMCPExecution.find((entry) => isMarrowCommand(entry.command)).command;
    // The stand-in runtime runs the vendored 3.9.103 decision (test/support/cursor-hook-decision.js).
    const driver = path.join(__dirname, 'support', 'cursor-hook-decision.js');
    fakeRuntime(fixture.home, PINS.MCP_ADAPTER_VERSION, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(driver)}\n`);
    const run = (event) => {
      const out = spawnSync(guard, {
        shell: true, cwd: fixture.root, env: { ...process.env, HOME: fixture.home },
        input: JSON.stringify({ hook_event_name: 'beforeMCPExecution', tool_input: '{}', workspace_roots: [fixture.root], ...event }), encoding: 'utf8', timeout: 30_000,
      });
      assert.equal(out.status, 0, out.stderr);
      return JSON.parse(out.stdout).permission;
    };
    // A spread of the 58 names through the real guard process (the MCP itself decides all 58 above).
    const sample = [NAMES[0], NAMES[1], 'marrow_commit', 'marrow_think', 'marrow_workflow_gate', NAMES[NAMES.length - 1]];
    for (const name of sample) assert.equal(run({ mcp_server_name: 'marrow', tool_name: name }), 'allow', `official: ${name}`);
    assert.equal(run({ mcp_server_name: 'marrow', tool_name: 'marrow_delete_all' }), 'ask', 'an unregistered name');
    assert.equal(run({ mcp_server_name: 'marrow-tools', tool_name: 'marrow_commit' }), 'ask', 'another server');
    assert.equal(run({ mcp_server_name: 'Marrow', tool_name: 'marrow_commit' }), 'ask', 'a case variant');
    // The same guard, the look-alike entry in place of the official one: held by the MCP.
    fs.writeFileSync(path.join(fixture.root, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: { marrow: LOOKALIKE } }));
    for (const name of sample) assert.equal(run({ mcp_server_name: 'marrow', tool_name: name }), 'ask', `look-alike: ${name}`);
    // And the published 0.1.70 guard (fixture, the exact bytes it wrote) allowed the same event at once.
    const oldHooks = readJson(path.join(FIXTURES_0170, 'all-hosts-cursor-hooks.json'));
    const oldGuard = oldHooks.hooks.beforeMCPExecution.find((entry) => isMarrowCommand(entry.command)).command;
    assert.equal(oldGuard.includes('mcp_server_name==="marrow"'), true, 'the 0.1.70 guard holds the by-name allow');
    assert.equal(guard.includes('mcp_server_name'), false, 'the candidate guard does not');
  });
});

// ---------------------------------------------------------------------------
// An install written by the published 0.1.70 is repaired
// ---------------------------------------------------------------------------

const ALL_HOSTS_0170 = {
  '.claude/settings.json': 'all-hosts-claude-settings.json',
  '.codex/hooks.json': 'all-hosts-codex-hooks.json',
  '.cursor/hooks.json': 'all-hosts-cursor-hooks.json',
  '.cursor/mcp.json': 'all-hosts-cursor-mcp.json',
  '.mcp.json': 'all-hosts-mcp.json',
  'AGENTS.md': 'all-hosts-AGENTS.md',
};

function load0170(fixture, { ownerGuard = false } = {}) {
  for (const [relative, name] of Object.entries(ALL_HOSTS_0170)) {
    fixture.write(relative, fs.readFileSync(path.join(FIXTURES_0170, name), 'utf8'));
  }
  if (ownerGuard) {
    const file = path.join(fixture.root, '.cursor', 'hooks.json');
    const hooks = readJson(file);
    hooks.hooks.beforeMCPExecution.unshift({ command: './owner-mcp-guard.sh' });
    fs.writeFileSync(file, `${JSON.stringify(hooks, null, 2)}\n`);
  }
}

test('an install written by the published 0.1.70: the old Cursor guard (allows server marrow + an own name at once) and the Codex look-ahead matcher are repaired, once, keeping owner entries', () => {
  withFixture('marrow-upgrade-0170-', {}, (fixture) => {
    load0170(fixture, { ownerGuard: true });
    const before = (relative) => fs.readFileSync(path.join(fixture.root, relative), 'utf8');
    const oldCursor = before('.cursor/hooks.json');
    assert.equal(oldCursor.includes('mcp_server_name'), true, 'the fixture is the 0.1.70 guard');
    assert.equal(before('.codex/hooks.json').includes('(?!'), true, 'the fixture is the 0.1.70 Codex matcher');
    assert.equal(before('.codex/hooks.json').includes('3.9.102'), true);

    const detection = installer.detectEnvironment(fixture.root, { HOME: fixture.home, PATH: process.env.PATH });
    assert.equal(detection.cursor, true);
    assert.equal(detection.codex, true);
    const plan = installer.buildPlan(detection, { mode: 'mcp' });
    // Doctor's view: neither host is complete, and a dry run would rewrite both files.
    const dry = installer.applyPlan(plan, { yes: false, dryRun: true, doctor: false });
    for (const [client, label] of [['cursor', 'Cursor native hooks'], ['codex', 'Codex native hooks']]) {
      assert.equal(installer.activationProfile(detection, plan, dry, client).observed_hooks.includes('pre_action'), false, client);
      assert.equal(dry.find((change) => change.label === label).changed, true, label);
    }
    assert.equal(before('.cursor/hooks.json'), oldCursor, 'a dry run writes nothing');

    installer.applyPlan(plan, { yes: true, dryRun: false, doctor: false });
    const cursor = readJson(path.join(fixture.root, '.cursor', 'hooks.json'));
    const guards = cursor.hooks.beforeMCPExecution.filter((entry) => isMarrowCommand(entry.command));
    assert.equal(guards.length, 1, 'one Marrow guard');
    assert.equal(guards[0].command.includes('mcp_server_name'), false, 'the repaired guard allows nothing by name');
    assert.equal(guards[0].command.includes(`--package=@getmarrow/mcp@${PINS.MCP_ADAPTER_VERSION}`), true);
    assert.equal(guards[0].command.includes('3.9.102'), false);
    assert.deepEqual(cursor.hooks.beforeMCPExecution.filter((entry) => !isMarrowCommand(entry.command)), [{ command: './owner-mcp-guard.sh' }], 'the owner guard is kept');
    const codex = readJson(path.join(fixture.root, '.codex', 'hooks.json'));
    for (const event of ['PreToolUse', 'PostToolUse']) {
      const groups = codex.hooks[event].filter((group) => group.hooks.some((hook) => isMarrowCommand(hook.command)));
      assert.deepEqual(groups.map((group) => group.matcher), ['*'], event);
    }
    assert.equal(JSON.stringify(codex).includes('(?!'), false);
    // The MCP entry moves to the pin and is proven by the pinned MCP.
    const mcp = readJson(path.join(fixture.root, '.cursor', 'mcp.json'));
    assert.match(JSON.stringify(mcp.mcpServers.marrow.args), new RegExp(`--package=@getmarrow/mcp@${PINS.MCP_ADAPTER_VERSION.replace(/\./g, '\\.')}`));
    assert.deepEqual(host.cursorVerdict(fixture), { official: true, reason: 'official' });

    // Repaired: doctor sees both hosts complete, and a second run writes nothing.
    const again = installer.applyPlan(plan, { yes: true, dryRun: false, doctor: false });
    assert.deepEqual(again.filter((change) => change.changed).map((change) => change.label), []);
    for (const client of ['cursor', 'codex']) assert.equal(installer.activationProfile(detection, plan, again, client).observed_hooks.includes('pre_action'), true, client);
  });
});

test('the .cursor/mcp.json the published 0.1.70 wrote is proven by the 3.9.103 MCP too (same pinned runtime core), so the repair never locks own tools out', () => {
  withFixture('marrow-upgrade-0170-mcp-', {}, (fixture) => {
    load0170(fixture);
    const config = readJson(path.join(fixture.root, '.cursor', 'mcp.json'));
    assert.match(JSON.stringify(config.mcpServers.marrow.args), /--package=@getmarrow\/mcp@3\.9\.102/);
    assert.deepEqual(host.cursorVerdict(fixture), { official: true, reason: 'official' });
    assert.equal(count(host.cursorSkips(fixture, CURSOR_LABELS)), 58);
  });
});

// ---------------------------------------------------------------------------
// Codex: `*` reaches the hook; the hook proves the server
// ---------------------------------------------------------------------------


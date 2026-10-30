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

// Installer 0.1.77 against the pinned MCP 3.9.109 (marrow-mcp 990aaaa6): what the installer writes
// for Codex and Cursor, and what the real MCP decision (test/fixtures/mcp-3.9.109, byte for byte)
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
    assert.equal(host.identity.isOfficialMarrowServerLaunch(config.mcpServers.marrow.command, config.mcpServers.marrow.args, host.PINNED_LAUNCHER), true);
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
    // The stand-in runtime runs the vendored 3.9.109 decision (test/support/cursor-hook-decision.js).
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

test('the .cursor/mcp.json the published 0.1.70 wrote is not proven by the 3.9.109 MCP (only the exact launch of the loader that started the hook is), so its own tools are checked, not skipped, until the repair rewrites the entry', () => {
  withFixture('marrow-upgrade-0170-mcp-', {}, (fixture) => {
    load0170(fixture);
    const config = readJson(path.join(fixture.root, '.cursor', 'mcp.json'));
    assert.match(JSON.stringify(config.mcpServers.marrow.args), /--package=@getmarrow\/mcp@3\.9\.102/);
    assert.deepEqual(host.cursorVerdict(fixture), { official: false, reason: 'the marrow server is not the official Marrow MCP launch' });
    assert.equal(count(host.cursorSkips(fixture, CURSOR_LABELS)), 0);
  });
});

// ---------------------------------------------------------------------------
// Codex: `*` reaches the hook; the hook proves the server
// ---------------------------------------------------------------------------

test('Codex hooks written by the installer: PreToolUse and PostToolUse match `*`, so mcp__marrow__<own> reaches the hook; no own name or look-around is in any Marrow matcher', () => {
  withFixture('marrow-codex-matcher-', {}, (fixture) => {
    installInto(fixture, { folders: ['.codex'] });
    const settings = readJson(path.join(fixture.root, '.codex', 'hooks.json'));
    let marrowGroups = 0;
    for (const event of ['PreToolUse', 'PostToolUse']) {
      for (const group of settings.hooks[event]) {
        if (!group.hooks.some((hook) => isMarrowCommand(hook.command))) continue;
        marrowGroups += 1;
        assert.equal(group.matcher, '*', event);
        for (const label of [...CODEX_LABELS, ...NAMES.map((name) => `functions.mcp__marrow__${name}`), 'mcp__evil__marrow_commit', 'Bash', 'apply_patch', 'mcp__marrow__marrow_unregistered']) {
          assert.equal(codexSelects(group.matcher, label), true, `${event}: ${label} reaches the hook`);
        }
        // No exemption in any form: no own name, no negative look-around, no complement, no anchor.
        assert.equal(NAMES.some((name) => group.matcher.includes(name)), false);
        assert.equal(/\(\?[=!<]/.test(group.matcher) || group.matcher.includes('mcp__') || group.matcher.includes('^') || group.matcher.includes('['), false);
      }
    }
    assert.equal(marrowGroups, 2, 'one Marrow group per event');
    assert.equal(installer.CODEX_NATIVE_HOOK_MATCHER, '*');
    assert.equal(own.buildOwnToolMatchers().codex, '*');
    // The written hook is the verified runtime's pre-action entrypoint, started from HOME (never npx).
    const pre = settings.hooks.PreToolUse.flatMap((group) => group.hooks).find((hook) => isMarrowCommand(hook.command));
    assert.equal(pre.command.includes(`.marrow/runtime/mcp/${PINS.MCP_ADAPTER_VERSION}/`), true);
    assert.equal(pre.command.includes('codex-pre-action-hook'), true);
    assert.equal(pre.command.startsWith("/bin/sh -c '") || pre.command.startsWith('node -e '), true, 'the verified-runtime launcher form');
    assert.equal(/exec npx|spawn\(.*npx/.test(pre.command), false, 'the written hook never starts npx');
  });
});

test('Codex hooks: own tools reach the runtime, and with no runtime they get the loader\'s own answer like every tool (no by-name or label exemption)', () => {
  withFixture('marrow-codex-runtime-', {}, (fixture) => {
    installInto(fixture, { folders: ['.codex'] });
    const settings = readJson(path.join(fixture.root, '.codex', 'hooks.json'));
    const pre = settings.hooks.PreToolUse.flatMap((group) => group.hooks).find((hook) => isMarrowCommand(hook.command)).command;
    const ran = path.join(fixture.base, 'runtime-ran');
    // A stand-in for the pinned MCP's hook: it records that it was started and answers `{}` (no objection).
    fakeRuntime(fixture.home, PINS.MCP_ADAPTER_VERSION, `#!/bin/sh\ncat >/dev/null\nprintf x >> ${JSON.stringify(ran)}\nprintf '{}'\n`);
    const run = (tool_name, env) => {
      if (fs.existsSync(ran)) fs.rmSync(ran);
      const out = spawnSync(pre, {
        shell: true, cwd: fixture.root, env: { ...process.env, ...env },
        input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name, tool_input: {}, cwd: fixture.root, session_id: 's', turn_id: 't', tool_use_id: 'u' }), encoding: 'utf8', timeout: 30_000,
      });
      return { status: out.status, stdout: out.stdout, stderr: out.stderr, ran: fs.existsSync(ran) };
    };
    for (const tool of ['mcp__marrow__marrow_commit', 'mcp__marrow__marrow_think', 'mcp__marrow__marrow_workflow_gate', 'mcp__evil__marrow_commit', 'exec_command']) {
      const result = run(tool, { HOME: fixture.home });
      assert.equal(result.status, 0, `${tool}: ${result.stderr}`);
      assert.equal(result.ran, true, `${tool} reaches the runtime`);
    }
    // No verified runtime and a dead registry: the hook never reaches the MCP, for Marrow's own tools
    // exactly as for any other tool (no label or name is answered locally): the loader's outage
    // answer (a warning on stderr and exit 1, which Codex runs through) or its hold (exit 2).
    const bare = path.join(fixture.base, 'bare-home');
    fs.mkdirSync(bare, { mode: 0o700 });
    deadRegistryHome(bare);
    const foreign = run('mcp__evil__deploy', { HOME: bare });
    assert.notEqual(foreign.status, 0);
    assert.equal(foreign.ran, false);
    assert.equal(foreign.stdout, '', 'the loader answers no allow of its own');
    assert.notEqual(foreign.stderr.trim(), '', 'it says why');
    for (const tool of ['mcp__marrow__marrow_commit', 'mcp__marrow__marrow_think', 'mcp__marrow__marrow_workflow_gate']) {
      const result = run(tool, { HOME: bare });
      assert.equal(result.status, foreign.status, `${tool}: the same answer as a foreign tool`);
      assert.equal(result.ran, false, tool);
      assert.equal(result.stdout, '', tool);
      assert.equal(result.stderr, foreign.stderr, tool);
    }
    assert.equal(fs.existsSync(runtimeDir(bare, PINS.MCP_ADAPTER_VERSION)), false, 'a failed heal leaves no runtime behind');
  });
});

// ---------------------------------------------------------------------------
// Codex: what proves the `marrow` server (the real MCP decision)
// ---------------------------------------------------------------------------

test('Codex: README npx form and the installer launch are proven; a missing, look-alike or altered entry is not; the installer itself writes no Codex server entry', () => {
  const launch = mcpServerLaunch(PINS.MCP_ADAPTER_VERSION, { platform: 'linux' });
  const installerToml = `[mcp_servers.marrow]\ncommand = ${JSON.stringify(launch.command)}\nargs = ${JSON.stringify(launch.args)}\n`;
  const proven = {
    'README npx form': host.README_CODEX_TOML,
    'npx with --package and marrow-mcp': '[mcp_servers.marrow]\ncommand = "npx"\nargs = ["-y", "--package=@getmarrow/mcp@3.9.103", "marrow-mcp"]\n',
    'the installed marrow-mcp bin': '[mcp_servers.marrow]\ncommand = "marrow-mcp"\n',
    'the installer verified-runtime launch (as its .mcp.json entry)': installerToml,
    'README form with the Marrow env names': `${host.README_CODEX_TOML}[mcp_servers.marrow.env]\nMARROW_BASE_URL = "https://api.getmarrow.ai"\n`,
  };
  for (const [label, toml] of Object.entries(proven)) {
    withFixture('marrow-codex-proven-', {}, (fixture) => {
      fixture.codexToml(toml);
      assert.equal(count(host.codexSkips(fixture, CODEX_LABELS)), 58, label);
    });
  }
  const unproven = {
    'no config.toml': null,
    'an empty config.toml': '',
    'a look-alike command': '[mcp_servers.marrow]\ncommand = "node"\nargs = ["/tmp/e.js"]\n',
    'npx with another package': '[mcp_servers.marrow]\ncommand = "npx"\nargs = ["-y", "@getmarrow/mcp-evil"]\n',
    'npx with an appended argument': '[mcp_servers.marrow]\ncommand = "npx"\nargs = ["-y", "@getmarrow/mcp", "--evil"]\n',
    'a wrapper': '[mcp_servers.marrow]\ncommand = "env"\nargs = ["FOO=1", "npx", "-y", "@getmarrow/mcp"]\n',
    'a foreign env name': `${host.README_CODEX_TOML}[mcp_servers.marrow.env]\nNODE_OPTIONS = "--require /tmp/e.js"\n`,
    'a second server that folds to marrow': `${host.README_CODEX_TOML}[mcp_servers.marrow_]\ncommand = "npx"\nargs = ["-y", "@getmarrow/mcp"]\n`,
    'a second server named mcp__marrow': `${host.README_CODEX_TOML}[mcp_servers.mcp__marrow]\ncommand = "node"\nargs = ["/tmp/e.js"]\n`,
    'a boundary name (_) beside it': `${host.README_CODEX_TOML}[mcp_servers._]\ncommand = "node"\nargs = ["/tmp/e.js"]\n`,
    'config that does not parse': '[mcp_servers.marrow\ncommand = "npx"\n',
  };
  for (const [label, toml] of Object.entries(unproven)) {
    withFixture('marrow-codex-unproven-', {}, (fixture) => {
      if (toml !== null) fixture.codexToml(toml);
      assert.equal(count(host.codexSkips(fixture, CODEX_LABELS)), 0, label);
    });
  }
  // The installer writes no Codex MCP server entry (README says to add it); a Codex project it sets up
  // has none, so on a pure installer setup there is no `marrow` server for the hook to prove.
  withFixture('marrow-codex-noentry-', {}, (fixture) => {
    installInto(fixture, { folders: ['.codex'] });
    assert.equal(fs.existsSync(path.join(fixture.codexHome, 'config.toml')), false);
    assert.equal(fs.existsSync(path.join(fixture.root, '.codex', 'config.toml')), false);
    assert.equal(count(host.codexSkips(fixture, CODEX_LABELS)), 0);
  });
});

test('Codex: a codex command line that touches MCP servers or plugins, a project or profile server, or a managed look-alike is never proven', () => {
  withFixture('marrow-codex-config-sources-', {}, (fixture) => {
    fixture.codexToml(host.README_CODEX_TOML);
    const label = [CODEX_LABELS[0]];
    const skips = (options) => host.codexSkips(fixture, label, options)[0];
    assert.equal(skips({}), true);
    assert.equal(skips({ codex: { args: ['codex', '-c', 'model="x"'] } }), true, 'an unrelated -c override');
    assert.equal(skips({ codex: { args: ['codex', '-c', 'mcp_servers.marrow.command="node"'] } }), false);
    assert.equal(skips({ codex: { args: ['codex', '--config', 'plugins."x@y".enabled=true'] } }), false);
    assert.equal(skips({ codex: { args: ['codex', '-p', 'evil'] } }), true, 'a named profile with no file adds no server');
    fs.writeFileSync(path.join(fixture.codexHome, 'evil.config.toml'), '[mcp_servers.marrow]\ncommand = "node"\nargs = ["/tmp/e.js"]\n');
    assert.equal(skips({ codex: { args: ['codex', '-p', 'evil'] } }), false, 'the profile file defines a look-alike marrow');
    assert.equal(skips({ codex: { args: ['codex', '--profile=evil'] } }), false);
    fs.rmSync(path.join(fixture.codexHome, 'evil.config.toml'));
    assert.equal(skips({ codex: null }), true, 'no codex ancestor: the README form is still proven');
    // A project .codex/config.toml defining a look-alike `marrow` next to the official global one.
    fixture.write('.codex/config.toml', '[mcp_servers.marrow]\ncommand = "node"\nargs = ["/tmp/e.js"]\n');
    assert.equal(skips({}), false);
    fs.rmSync(path.join(fixture.root, '.codex', 'config.toml'));
    assert.equal(skips({}), true);
    // A profile file or an inline profile table with a server.
    fixture.codexToml(`${host.README_CODEX_TOML}[profiles.dev.mcp_servers.marrow]\ncommand = "node"\nargs = ["/tmp/e.js"]\n`);
    assert.equal(skips({}), false);
  });
});

// ---------------------------------------------------------------------------
// Codex: the project npm config rule (r3), npm_config_* and the home npm config
// ---------------------------------------------------------------------------

test('Codex README npx form: a project npm config proves nothing unless every key is on the MCP list or is the default-registry credential field; npm_config_* never; the home config is fine', () => {
  const file = '.npmrc';
  const harmless = [
    'save-exact=true\n',
    'save-exact = true\nfund=false\naudit=false\n',
    '; a comment\n# another\n\nloglevel=warn\n',
    'package-lock=false\r\nlegacy-peer-deps=true\r\n',
    '//registry.npmjs.org/:_authToken=${NPM_TOKEN}\nsave-prefix=~\n',
    'engine-strict=true\n',
  ];
  const redirecting = [
    'registry=http://127.0.0.1:9/\n',
    '@x:registry=http://127.0.0.1:9/\n',
    '@getmarrow:registry=http://127.0.0.1:9/\n',
    'Registry=http://127.0.0.1:9/\n',
    'save-exact=true\nregistry=http://127.0.0.1:9/\n',
    'proxy=http://127.0.0.1:9\n',
    'https-proxy=http://127.0.0.1:9\n',
    'cache=/tmp/x\n',
    'prefix=/tmp/x\n',
    'userconfig=/tmp/x\n',
    'node-options=--require /tmp/e.js\n',
    '//npm.company.com/:_authToken=${NPM_TOKEN}\n',
    '//registry.npmjs.org/:registry=http://127.0.0.1:9/\n',
    'save-exact=true\nsomething-unknown=1\n',
    '[section]\nsave-exact=true\n',
    'registry\n',
    'save-exact=true\\\nregistry=http://127.0.0.1:9/\n',
  ];
  for (const text of harmless) {
    withFixture('marrow-npmrc-ok-', {}, (fixture) => {
      fixture.codexToml(host.README_CODEX_TOML);
      fixture.write(file, text);
      assert.equal(count(host.codexSkips(fixture, CODEX_LABELS)), 58, JSON.stringify(text));
    });
  }
  for (const text of redirecting) {
    withFixture('marrow-npmrc-held-', {}, (fixture) => {
      fixture.codexToml(host.README_CODEX_TOML);
      fixture.write(file, text);
      assert.equal(count(host.codexSkips(fixture, CODEX_LABELS)), 0, JSON.stringify(text));
    });
  }
  // A config in a parent folder of the project counts too (npm walks up), a nested one does not.
  withFixture('marrow-npmrc-parent-', {}, (fixture) => {
    fixture.codexToml(host.README_CODEX_TOML);
    fs.writeFileSync(path.join(fixture.base, file), 'registry=http://127.0.0.1:9/\n');
    assert.equal(count(host.codexSkips(fixture, CODEX_LABELS)), 0);
  });
  // npm_config_* in the hook environment, any case, any name: checked.
  for (const name of ['npm_config_registry', 'NPM_CONFIG_PREFIX', 'Npm_Config_Cache', 'npm_config_userconfig', 'npm_config_foo']) {
    withFixture('marrow-npmenv-', {}, (fixture) => {
      fixture.codexToml(host.README_CODEX_TOML);
      assert.equal(count(host.codexSkips(fixture, CODEX_LABELS, { env: { [name]: '/tmp/x' } })), 0, name);
      assert.equal(count(host.codexSkips(fixture, CODEX_LABELS)), 58, `${name} unset again`);
    });
  }
  // The user's own npm config in $HOME is fine, also when the project sits under it; a config between
  // the project and HOME, or in the project, is not.
  withFixture('marrow-npmrc-home-', {}, (fixture) => {
    fixture.codexToml(host.README_CODEX_TOML);
    fixture.write(`~/${file}`, 'registry=http://127.0.0.1:9/\n');
    assert.equal(count(host.codexSkips(fixture, CODEX_LABELS)), 58, '$HOME config, project outside HOME');
  });
  withFixture('marrow-npmrc-home-under-', { underHome: true }, (fixture) => {
    fixture.codexToml(host.README_CODEX_TOML);
    fixture.write(`~/${file}`, 'registry=http://127.0.0.1:9/\n');
    assert.equal(count(host.codexSkips(fixture, CODEX_LABELS)), 58, '$HOME config, project under HOME');
    fixture.write(file, 'registry=http://127.0.0.1:9/\n');
    assert.equal(count(host.codexSkips(fixture, CODEX_LABELS)), 0, 'the project config counts');
  });
  // The installed bin and the installer launch never go through npx, so npm config does not matter.
  withFixture('marrow-npmrc-bin-', {}, (fixture) => {
    fixture.codexToml('[mcp_servers.marrow]\ncommand = "marrow-mcp"\n');
    fixture.write(file, 'registry=http://127.0.0.1:9/\n');
    assert.equal(count(host.codexSkips(fixture, CODEX_LABELS, { env: { npm_config_registry: 'http://127.0.0.1:9/' } })), 58);
  });
});

// ---------------------------------------------------------------------------
// Codex plugins
// ---------------------------------------------------------------------------

test('Codex plugin: the official plugin alone, enabled in $CODEX_HOME/config.toml, is proven; plus a README marrow entry, enabled elsewhere, or altered by a byte it is checked', () => {
  withFixture('marrow-plugin-alone-', {}, (fixture) => {
    fixture.codexToml(host.installOfficialPlugin(fixture));
    assert.equal(count(host.codexSkips(fixture, CODEX_LABELS)), 58);
    assert.deepEqual(host.codexVerdict(fixture), { official: true, reason: 'official plugin' });
  });
  withFixture('marrow-plugin-readme-', {}, (fixture) => {
    fixture.codexToml(`${host.installOfficialPlugin(fixture)}${host.README_CODEX_TOML}`);
    assert.equal(count(host.codexSkips(fixture, CODEX_LABELS)), 0, 'plugin + README marrow');
  });
  withFixture('marrow-plugin-project-', {}, (fixture) => {
    const enable = host.installOfficialPlugin(fixture);
    fixture.write('.codex/config.toml', enable);
    assert.equal(count(host.codexSkips(fixture, CODEX_LABELS)), 0, 'enabled in the project config');
  });
  withFixture('marrow-plugin-profile-', {}, (fixture) => {
    host.installOfficialPlugin(fixture);
    fixture.codexToml('[profiles.dev.plugins."marrow@getmarrow"]\nenabled = true\n');
    assert.equal(count(host.codexSkips(fixture, CODEX_LABELS)), 0, 'enabled in a profile');
  });
  withFixture('marrow-plugin-byte-', {}, (fixture) => {
    fixture.codexToml(host.installOfficialPlugin(fixture));
    const launcher = path.join(fixture.codexHome, 'plugins', 'cache', 'getmarrow', 'marrow', '0.1.1', 'scripts', 'marrow-launch.cjs');
    const old = fs.statSync(launcher);
    fs.appendFileSync(launcher, '\n');
    fs.utimesSync(launcher, old.atime, old.mtime);
    assert.equal(count(host.codexSkips(fixture, CODEX_LABELS)), 0, 'one byte changed');
  });
  withFixture('marrow-plugin-lookalike-', {}, (fixture) => {
    // A look-alike plugin declaring a server `marrow_` beside nothing else: not proven.
    const dir = path.join(fixture.codexHome, 'plugins', 'cache', 'evil', 'marrow', '1.0.0');
    fs.mkdirSync(path.join(dir, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'marrow', version: '1.0.0', mcpServers: { marrow_: { command: 'node', args: ['/tmp/e.js'] } } }));
    fixture.codexToml('[plugins."marrow@evil"]\nenabled = true\n');
    assert.equal(count(host.codexSkips(fixture, CODEX_LABELS)), 0);
  });
});

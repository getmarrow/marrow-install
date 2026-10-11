require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const PINS = require('../src/pins');
const installer = require('../src/installer');
const own = require('../src/marrow-own-tools');

// The registered names, as @getmarrow/mcp fix/own-tool-exact (4311df21) lists them.
const NAMES_JSON = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'marrow-own-tool-names.json'), 'utf8'));
const NAMES = NAMES_JSON.names;
const FIXTURES = path.join(__dirname, 'fixtures', 'installer-0168');
const OWNER_FILES = path.join(__dirname, 'fixtures', 'installer-0167', 'owner-files.json');

// The 0.1.68 strings, for the "never looser than master" checks.
const OLD = {
  claude: 'Bash|Edit|Write|MultiEdit|Read|Glob|Grep|Search|WebSearch|Task|functions\\.(?!mcp__marrow__marrow_).*|mcp__(?!marrow__marrow_).*',
  codex: 'Bash|apply_patch|Edit|Write|MultiEdit|mcp__(?!marrow__marrow_).*|functions\\.(?!marrow_).*',
  cursor: 'Shell|Write|Delete|Task|Read|Glob|Grep|Search|WebSearch|List|MCP:(?!marrow(?:_.*|:marrow_.*)$).*',
  cursorPreToolUseHostApproval: 'Write|Delete|Task|Read|Glob|Grep|Search|WebSearch|List|MCP:(?!marrow(?:_.*|:marrow_.*)$).*',
  gemini: '^(?:run_shell_command|write_file|replace|edit_file|delete_file|read_file|read_many_files|glob|grep_search|list_directory|get_file_info|web_search|google_web_search|mcp_(?!marrow_marrow_)[A-Za-z0-9_]{1,192})$',
};

// The exact strings of the shared rule, assembled here from the JSON (not from the module).
function expectedStrings() {
  const OWN = NAMES.join('|');
  const tail = `functions\\.(?!mcp__marrow__(?:${OWN})$).*|mcp__(?!marrow__(?:${OWN})$).*`;
  const cursorMcp = `MCP:(?!(?:marrow:)?(?:${OWN})$).*`;
  return {
    claude: `Bash|Edit|Write|MultiEdit|Read|Glob|Grep|Search|WebSearch|Task|${tail}`,
    codex: `Bash|apply_patch|Edit|Write|MultiEdit|${tail}`,
    cursor: `Shell|Write|Delete|Task|Read|Glob|Grep|Search|WebSearch|List|${cursorMcp}`,
    cursorPreToolUseHostApproval: `Write|Delete|Task|Read|Glob|Grep|Search|WebSearch|List|${cursorMcp}`,
    gemini: `^(?:run_shell_command|write_file|replace|edit_file|delete_file|read_file|read_many_files|glob|grep_search|list_directory|get_file_info|web_search|google_web_search|mcp_(?!marrow_(?:${OWN})$).*)$`,
  };
}

// How a host applies a matcher. The repo's tests (and @getmarrow/mcp test/hook-install.test.js)
// treat Claude Code, Codex and Cursor matchers as a full match; Claude Code's own rule is a
// regex test (a search). Gemini's matcher carries its own anchors. Each case must hold both ways.
const SEMANTICS = {
  full: (matcher) => new RegExp(`^(?:${matcher})$`),
  search: (matcher) => new RegExp(matcher),
};
const reaches = (matcher, tool, mode) => SEMANTICS[mode](matcher).test(tool);

// Host forms of an MCP tool, per matcher.
const FORMS = {
  claude: (server, tool) => [`mcp__${server}__${tool}`, `functions.mcp__${server}__${tool}`],
  codex: (server, tool) => [`mcp__${server}__${tool}`, `functions.mcp__${server}__${tool}`],
  cursor: (server, tool) => [`MCP:${server}:${tool}`, ...(server === 'marrow' ? [`MCP:${tool}`] : [])],
  cursorPreToolUseHostApproval: (server, tool) => [`MCP:${server}:${tool}`, ...(server === 'marrow' ? [`MCP:${tool}`] : [])],
  gemini: (server, tool) => [`mcp_${server}_${tool}`],
};

const SERVER_VARIANTS = ['MARROW', 'Marrow', 'mARROW', 'marroW', 'marrow2', 'marrow_', '_marrow', 'xmarrow', 'marrowx', 'marrow-evil', 'evil', 'plugin_marrow_marrow',
  'mаrrow', 'ｍarrow', 'marrow​', 'marrow ', ' marrow'];
const TOOL_VARIANTS = ['MARROW_COMMIT', 'Marrow_commit', 'marrow_Commit', 'marrow_delete_all', 'marrow_exec', 'marrow_x', 'marrow_', 'marrow', 'marrow_commitx',
  'marrow_commit ', ' marrow_commit', 'marrow_commit\t', 'marrow_workflow_', 'marrow_workflow_gatex', 'marrow_workflowgate', 'marrow_commit|marrow_ask',
  'marrow_x__deploy_prod', 'marrow_commit__mcp__github__push', 'constructor', '__proto__', 'delete_all', 'x'];

// Every probe that must still reach the hook, per matcher.
function abuseProbes(key) {
  const probes = [];
  for (const server of SERVER_VARIANTS) for (const tool of ['marrow_commit', 'marrow_delete_all']) probes.push(...FORMS[key](server, tool));
  for (const tool of TOOL_VARIANTS) probes.push(...FORMS[key]('marrow', tool));
  if (key === 'claude' || key === 'codex') {
    probes.push('mcp__evil__x', 'mcp__marrow__marrow_delete_all', 'mcp__MARROW__marrow_commit', 'mcp__marrow__marrow_commit ',
      'functions.mcp__MARROW__marrow_commit', 'functions.marrow_commit', 'functions.marrow_delete_all', 'functions.mcp__marrow__marrow_x',
      'functions.functions.mcp__marrow__marrow_commit', 'functions.mcp__evil__mcp__marrow__marrow_commit', 'mcp__evil__mcp__marrow__marrow_commit',
      'functions.exec', 'functions.apply_patch', 'Bash', 'Write', 'Edit', 'MultiEdit');
  }
  if (key === 'claude') probes.push('Read', 'Glob', 'Grep', 'Search', 'WebSearch', 'Task');
  if (key === 'codex') probes.push('apply_patch');
  if (key.startsWith('cursor')) {
    probes.push('MCP:marrow_delete_all', 'MCP:MARROW:marrow_commit', 'MCP:Marrow:marrow_commit', 'MCP:evil:marrow_commit', 'MCP:marrow:marrow_commit ',
      'MCP:marrow_commit ', 'MCP::marrow_commit', 'MCP:marrow:marrow:marrow_commit', 'MCP:', 'MCP:toString', 'Write', 'Delete', 'Read', 'List');
    if (key === 'cursor') probes.push('Shell');
  }
  if (key === 'gemini') {
    probes.push('mcp_marrow_marrow_delete_all', 'mcp_MARROW_marrow_commit', 'mcp_marrow_marrow_commit ', 'mcp_evil_x', 'mcp_marrow_x',
      'mcp_evil-server_deploy', `mcp_evil_${'x'.repeat(200)}`, 'run_shell_command', 'write_file', 'replace', 'read_file', 'web_search');
  }
  return [...new Set(probes)];
}

test('src/marrow-own-tools.js holds exactly the 58 registered names, in file order', () => {
  assert.equal(NAMES_JSON.count, 58);
  assert.equal(NAMES.length, 58);
  assert.deepEqual([...own.MARROW_OWN_TOOL_NAMES], NAMES);
  assert.equal(new Set(NAMES).size, 58);
  assert.equal(Object.isFrozen(own.MARROW_OWN_TOOL_NAMES), true);
  assert.equal(own.MARROW_OWN_SERVER, 'marrow');
});

test('every matcher is the exact string of the shared rule, built from the names, and the installer writes it', () => {
  const expected = expectedStrings();
  assert.deepEqual(own.buildOwnToolMatchers(), expected);
  assert.equal(installer.NATIVE_HOOK_MATCHER, expected.claude);
  assert.equal(installer.CURSOR_NATIVE_HOOK_MATCHER, expected.cursor);
  assert.equal(installer.CURSOR_PRE_TOOL_USE_HOST_APPROVAL_MATCHER, expected.cursorPreToolUseHostApproval);
  assert.equal(installer.GEMINI_NATIVE_HOOK_MATCHER, expected.gemini);
  // Byte-identical with the rule @getmarrow/mcp's NATIVE_HOOK_MATCHER follows.
  const OWN = NAMES.join('|');
  assert.equal(installer.NATIVE_HOOK_MATCHER,
    `Bash|Edit|Write|MultiEdit|Read|Glob|Grep|Search|WebSearch|Task|functions\\.(?!mcp__marrow__(?:${OWN})$).*|mcp__(?!marrow__(?:${OWN})$).*`);
  // A name that is not a plain identifier never reaches a regex source or the guard.
  for (const bad of ['marrow_.*', 'marrow_x|evil', 'marrow_x)$|(?=', 'MARROW_X', 'marrow_x"', '', 'evil']) {
    assert.throws(() => own.buildOwnToolMatchers([bad]), /invalid Marrow tool name/, bad);
    assert.throws(() => own.cursorOwnToolGuardCondition([bad]), /invalid Marrow tool name/, bad);
  }
  assert.throws(() => own.buildOwnToolMatchers([]), /invalid Marrow tool name list/);
});

test('each matcher skips exactly the 58 own names in each host form, under full-match and search semantics', () => {
  for (const [key, matcher] of Object.entries(own.buildOwnToolMatchers())) {
    const modes = key === 'gemini' ? ['search'] : ['full', 'search'];
    for (const mode of modes) {
      for (const name of NAMES) {
        for (const form of FORMS[key]('marrow', name)) assert.equal(reaches(matcher, form, mode), false, `${key}/${mode}: own ${JSON.stringify(form)} must be skipped`);
      }
      for (const probe of abuseProbes(key)) assert.equal(reaches(matcher, probe, mode), true, `${key}/${mode}: ${JSON.stringify(probe)} must reach the hook`);
    }
  }
});

test('no matcher is looser than 0.1.68: whatever reached the hook before still does', () => {
  const now = own.buildOwnToolMatchers();
  for (const key of Object.keys(OLD)) {
    // The 58 own forms are skipped by design (0.1.68 Codex still sent `functions.mcp__marrow__<own>`
    // to the hook, which allowed it); every other name keeps reaching the hook.
    const probes = [...abuseProbes(key), 'mcp__marrow__marrow_commit\n', 'MCP:marrow_commit\n', 'mcp_marrow_marrow_commit\n', 'mcp__evil__x\n'];
    for (const mode of key === 'gemini' ? ['search'] : ['full', 'search']) {
      for (const probe of probes) {
        if (reaches(OLD[key], probe, mode)) assert.equal(reaches(now[key], probe, mode), true, `${key}/${mode}: ${JSON.stringify(probe)}`);
      }
    }
    // And the unregistered names on server marrow that 0.1.68 skipped now reach the hook.
    const opened = abuseProbes(key).filter((probe) => !reaches(OLD[key], probe, 'search') && reaches(now[key], probe, 'search'));
    assert.ok(opened.length >= 5, `${key}: ${opened.length}`);
  }
});

test('the brief\'s named cases for the Claude Code / Codex matcher', () => {
  for (const key of ['claude', 'codex']) {
    const matcher = own.buildOwnToolMatchers()[key];
    for (const mode of ['full', 'search']) {
      for (const tool of ['mcp__marrow__marrow_delete_all', 'mcp__MARROW__marrow_commit', 'mcp__marrow__marrow_commit ', 'mcp__evil__x']) {
        assert.equal(reaches(matcher, tool, mode), true, `${key}/${mode}: ${tool}`);
      }
      assert.equal(reaches(matcher, 'mcp__marrow__marrow_commit', mode), false);
      assert.equal(reaches(matcher, 'functions.mcp__marrow__marrow_workflow_gate', mode), false);
      assert.equal(reaches(matcher, 'mcp__marrow__marrow_workflow', mode), false);
    }
  }
});

function workspace(prefix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(base, 0o700);
  const home = path.join(base, 'home');
  const root = path.join(base, 'project');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(root);
  return { base, home, root, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const fixturePath = (relative) => path.join(FIXTURES, relative.replace(/^~\//, 'HOME/').replace(/(^|\/)\.(?=[a-z])/g, '$1dot-'));
const wsPath = (ws, relative) => (relative.startsWith('~/') ? path.join(ws.home, relative.slice(2)) : path.join(ws.root, relative));

function writeOwnerFiles(ws) {
  for (const [relative, value] of Object.entries(readJson(OWNER_FILES))) {
    const target = wsPath(ws, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  }
}

// The real 0.1.68 output (fixtures generated from 12872ee over the 0.1.67 owner files).
function load0168(ws) {
  const manifest = readJson(path.join(FIXTURES, 'manifest.json'));
  writeOwnerFiles(ws);
  for (const [relative, info] of Object.entries(manifest.files)) {
    const target = wsPath(ws, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(fixturePath(relative), target);
    fs.chmodSync(target, parseInt(info.mode, 8));
  }
  fs.chmodSync(path.join(ws.home, '.grok'), 0o755);
  fs.chmodSync(path.join(ws.home, '.grok', 'hooks'), 0o755);
  if (!fs.existsSync(path.join(ws.root, '.windsurf'))) fs.mkdirSync(path.join(ws.root, '.windsurf'));
  return manifest;
}

function hostApprovalTarget() {
  const version = installer.hostApprovalHooksSupported(PINS.MCP_ADAPTER_VERSION) ? PINS.MCP_ADAPTER_VERSION : PINS.MCP_HOST_APPROVAL_HOOKS_SINCE;
  return installer.resolveMcpTargetVersion({ registryMetadata: { name: '@getmarrow/mcp', version, dist: {
    integrity: `sha512-${crypto.createHash('sha512').update(`registry-${version}`).digest('base64')}`,
    tarball: `https://registry.npmjs.org/@getmarrow/mcp/-/mcp-${version}.tgz`,
  } } });
}

function plan(ws) {
  const detection = installer.detectEnvironment(ws.root, { HOME: ws.home, PATH: process.env.PATH });
  return { detection, plan: installer.buildPlan(detection, { mode: 'mcp', mcpTarget: hostApprovalTarget() }) };
}

const isMarrowCommand = (value) => typeof value === 'string' && /@getmarrow\/mcp@[^\s"',]+/.test(value);
function ownerGroupedHooks(settings) {
  const out = {};
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    const kept = groups.map((group) => ({ ...group, hooks: (group.hooks || []).filter((hook) => !isMarrowCommand(hook.command) && !String(hook.name || '').startsWith('marrow-')) }))
      .filter((group) => group.hooks.length > 0);
    if (kept.length) out[event] = kept;
  }
  return out;
}
function ownerFlatHooks(settings) {
  const out = {};
  for (const [event, entries] of Object.entries(settings.hooks || {})) {
    const kept = entries.filter((entry) => !isMarrowCommand(entry.command));
    if (kept.length) out[event] = kept;
  }
  return out;
}
const OLD_MATCHER_STRINGS = Object.values(OLD);
const OLD_GUARD = '/^marrow_[a-z0-9_]{1,64}$/';

const HOSTS = [
  { client: 'claude-code', label: 'Claude Code MCP passive hooks', file: '.claude/settings.json', stale: true },
  { client: 'codex', label: 'Codex native hooks', file: '.codex/hooks.json', stale: true },
  { client: 'cursor', label: 'Cursor native hooks', file: '.cursor/hooks.json', stale: true },
  { client: 'gemini', label: 'Gemini CLI native hooks', file: '.gemini/settings.json', stale: true },
  { client: 'grok', label: 'Grok native hooks', file: '~/.grok/hooks/marrow.json', stale: false },
  { client: 'windsurf', label: 'Windsurf native hooks', file: '.windsurf/hooks.json', stale: false },
];

test('0.1.68 install: doctor reports the old matchers as needing repair; repair rewrites only Marrow entries; uninstall removes the new ones', async () => {
  const ws = workspace('marrow-own-matchers-');
  try {
    const manifest = load0168(ws);
    const before = Object.fromEntries(Object.keys(manifest.files).map((relative) => [relative, fs.readFileSync(wsPath(ws, relative), 'utf8')]));
    // The fixtures really hold the 0.1.68 strings.
    for (const host of HOSTS.filter((item) => item.stale)) {
      assert.ok(OLD_MATCHER_STRINGS.some((value) => before[host.file].includes(JSON.stringify(value).slice(1, -1))), host.file);
    }
    assert.ok(before['.cursor/hooks.json'].includes(OLD_GUARD.replace(/\\/g, '\\\\')), 'the 0.1.68 Cursor guard');

    // Doctor on the 0.1.68 layout: the four hosts with an own-tool matcher are incomplete, and a
    // dry run would rewrite exactly their files.
    let { detection, plan: current } = plan(ws);
    const dry = installer.applyPlan(current, { yes: false, dryRun: true, doctor: false });
    for (const host of HOSTS) {
      const profile = installer.activationProfile(detection, current, dry, host.client);
      assert.equal(profile.observed_hooks.includes('pre_action'), !host.stale, `${host.client}: ${profile.observed_hooks}`);
      const change = dry.find((item) => item.label === host.label);
      assert.ok(change, host.label);
      assert.equal(change.changed, host.stale, `${host.label} changed`);
    }
    for (const relative of Object.keys(before)) assert.equal(fs.readFileSync(wsPath(ws, relative), 'utf8'), before[relative], `dry run wrote ${relative}`);

    // Repair (update re-applies the plan).
    const applied = installer.applyPlan(current, { yes: true, dryRun: false, doctor: false });
    const after = (relative) => fs.readFileSync(wsPath(ws, relative), 'utf8');
    for (const relative of ['.claude/settings.json', '.codex/hooks.json', '.gemini/settings.json', '~/.grok/hooks/marrow.json']) {
      assert.deepEqual(ownerGroupedHooks(JSON.parse(after(relative))), ownerGroupedHooks(JSON.parse(before[relative])), relative);
    }
    for (const relative of ['.cursor/hooks.json', '.windsurf/hooks.json']) {
      assert.deepEqual(ownerFlatHooks(JSON.parse(after(relative))), ownerFlatHooks(JSON.parse(before[relative])), relative);
    }
    for (const relative of Object.keys(before)) {
      const text = after(relative);
      for (const old of OLD_MATCHER_STRINGS) assert.equal(text.includes(JSON.stringify(old).slice(1, -1)), false, `${relative} still has ${old.slice(-40)}`);
      assert.equal(text.includes(OLD_GUARD.replace(/\\/g, '\\\\')), false, `${relative} still has the old guard`);
    }
    for (const host of HOSTS.filter((item) => !item.stale)) assert.equal(after(host.file), before[host.file], `${host.file} must not change`);
    const expected = expectedStrings();
    const claude = JSON.parse(after('.claude/settings.json'));
    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']) {
      const marrowGroups = claude.hooks[event].filter((group) => group.hooks.some((hook) => isMarrowCommand(hook.command)));
      assert.equal(marrowGroups.length, 1, event);
      assert.equal(marrowGroups[0].matcher, expected.claude, event);
    }
    const codex = JSON.parse(after('.codex/hooks.json'));
    for (const event of ['PreToolUse', 'PostToolUse']) {
      const marrowGroups = codex.hooks[event].filter((group) => group.hooks.some((hook) => isMarrowCommand(hook.command)));
      assert.deepEqual(marrowGroups.map((group) => group.matcher), [expected.codex], event);
    }
    const cursor = JSON.parse(after('.cursor/hooks.json'));
    assert.deepEqual(cursor.hooks.preToolUse.filter((entry) => isMarrowCommand(entry.command)).map((entry) => entry.matcher), [expected.cursorPreToolUseHostApproval]);
    for (const event of ['postToolUse', 'postToolUseFailure']) {
      assert.deepEqual(cursor.hooks[event].filter((entry) => isMarrowCommand(entry.command)).map((entry) => entry.matcher), [expected.cursor], event);
    }
    const guards = cursor.hooks.beforeMCPExecution.filter((entry) => isMarrowCommand(entry.command));
    assert.equal(guards.length, 1);
    assert.equal(guards[0].command.includes(own.cursorOwnToolGuardCondition()), true);
    const gemini = JSON.parse(after('.gemini/settings.json'));
    for (const event of ['BeforeTool', 'AfterTool']) {
      const marrowGroups = gemini.hooks[event].filter((group) => group.hooks.some((hook) => String(hook.name || '').startsWith('marrow-')));
      assert.deepEqual(marrowGroups.map((group) => group.matcher), [expected.gemini], event);
    }

    // Doctor after repair: complete for every host; a second run changes nothing.
    ({ detection, plan: current } = plan(ws));
    const again = installer.applyPlan(current, { yes: true, dryRun: false, doctor: false });
    assert.deepEqual(again.filter((change) => change.changed).map((change) => change.label), []);
    for (const host of HOSTS) {
      assert.equal(installer.activationProfile(detection, current, again, host.client).observed_hooks.includes('pre_action'), true, host.client);
    }
    assert.ok(applied.some((change) => change.applied));

    // Uninstall removes the new entries and leaves the owner's files as they were.
    const owner = readJson(OWNER_FILES);
    const result = await installer.uninstall({ cwd: ws.root, home: ws.home, yes: true, controller: false });
    assert.equal(result.uninstall.applied, true);
    for (const relative of ['.claude/settings.json', '.codex/hooks.json', '.cursor/hooks.json', '.gemini/settings.json', '.windsurf/hooks.json']) {
      assert.deepEqual(readJson(wsPath(ws, relative)), owner[relative], relative);
    }
    assert.equal(fs.existsSync(path.join(ws.home, '.grok', 'hooks', 'marrow.json')), false);
  } finally {
    ws.cleanup();
  }
});

test('Cursor beforeMCPExecution guard: allows at once only server "marrow" with one of the 58 names; everything else reaches the hook', () => {
  const ws = workspace('marrow-own-guard-');
  try {
    fs.mkdirSync(path.join(ws.root, '.cursor'));
    const { plan: current } = plan(ws);
    installer.applyPlan(current, { yes: true, dryRun: false, doctor: false });
    const guard = readJson(path.join(ws.root, '.cursor', 'hooks.json')).hooks.beforeMCPExecution.find((entry) => isMarrowCommand(entry.command)).command;
    const bin = path.join(ws.base, 'fake-bin');
    fs.mkdirSync(bin);
    const spawned = path.join(ws.base, 'npx-ran');
    fs.writeFileSync(path.join(bin, 'npx'), `#!/bin/sh\ncat >/dev/null\nprintf x >> ${JSON.stringify(spawned)}\nprintf '%s\\n' '{"permission":"ask","user_message":"Approve?","agent_message":"asked"}'\n`);
    fs.chmodSync(path.join(bin, 'npx'), 0o755);
    const run = (event) => {
      if (fs.existsSync(spawned)) fs.rmSync(spawned);
      const out = spawnSync(guard, { shell: true, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, input: JSON.stringify({ hook_event_name: 'beforeMCPExecution', tool_input: '{}', ...event }), encoding: 'utf8', timeout: 20_000 });
      return { status: out.status, stdout: out.stdout, hook: fs.existsSync(spawned) };
    };
    for (const name of NAMES) {
      assert.deepEqual(run({ mcp_server_name: 'marrow', tool_name: name }), { status: 0, stdout: '{"permission":"allow"}\n', hook: false }, name);
    }
    const asked = { status: 0, stdout: '{"permission":"ask","user_message":"Approve?","agent_message":"asked"}\n', hook: true };
    const cases = [
      ...SERVER_VARIANTS.map((server) => ({ mcp_server_name: server, tool_name: 'marrow_commit' })),
      ...TOOL_VARIANTS.map((tool) => ({ mcp_server_name: 'marrow', tool_name: tool })),
      { mcp_server_name: 'marrow', tool_name: 'MCP:marrow_commit' },
      { mcp_server_name: 'marrow', tool_name: 'mcp__marrow__marrow_commit' },
      { mcp_server_name: 'marrow', tool_name: ['marrow_commit'] },
      { mcp_server_name: ['marrow'], tool_name: 'marrow_commit' },
      { mcp_server_name: 'marrow' },
      { tool_name: 'marrow_commit' },
      { mcp_server_name: 'marrow', tool_name: 'hasOwnProperty' },
      { mcp_server_name: 'marrow', tool_name: 'marrow_delete_all', server: 'marrow' },
    ];
    for (const event of cases) assert.deepEqual(run(event), asked, JSON.stringify(event));
  } finally {
    ws.cleanup();
  }
});

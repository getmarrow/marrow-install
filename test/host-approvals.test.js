require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const PINS = require('../src/pins');
const installer = require('../src/installer');
const runner = require('../src/governed-runner');

const BIN = path.join(__dirname, '..', 'bin', 'marrow-install.js');
const FIXTURES = path.join(__dirname, 'fixtures', 'installer-0167');
const CLAUDE_MATCHER = 'Bash|Edit|Write|MultiEdit|Read|Glob|Grep|Search|WebSearch|Task|functions\\.(?!mcp__marrow__marrow_).*|mcp__(?!marrow__marrow_).*';
const CURSOR_FULL_MATCHER = 'Shell|Write|Delete|Task|Read|Glob|Grep|Search|WebSearch|List|MCP:(?!marrow(?:_.*|:marrow_.*)$).*';
const GEMINI_MATCHER = installer.GEMINI_NATIVE_HOOK_MATCHER;
const LAUNCH_FAILURE = 'Marrow governance adapter was unavailable; this action is blocked.\n';

// The MCP version that answers the host-approval hooks: the sealed pin once the release re-pins,
// until then the first version that ships them, as `update` would resolve it from the registry.
function hostApprovalVersion() {
  return installer.hostApprovalHooksSupported(PINS.MCP_ADAPTER_VERSION)
    ? PINS.MCP_ADAPTER_VERSION
    : PINS.MCP_HOST_APPROVAL_HOOKS_SINCE;
}

function hostApprovalTarget() {
  const version = hostApprovalVersion();
  return installer.resolveMcpTargetVersion({
    registryMetadata: {
      name: '@getmarrow/mcp',
      version,
      dist: {
        integrity: `sha512-${crypto.createHash('sha512').update(`registry-${version}`).digest('base64')}`,
        tarball: `https://registry.npmjs.org/@getmarrow/mcp/-/mcp-${version}.tgz`,
      },
    },
  });
}

const spec = (version = hostApprovalVersion()) => `@getmarrow/mcp@${version}`;
const cmd = (entrypoint, version) => `npx -y --package=${spec(version)} marrow-mcp ${entrypoint}`;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// A temporary HOME (owner-only, as Grok's path check requires) and project for every case.
function workspace(prefix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(base, 0o700);
  const home = path.join(base, 'home');
  const root = path.join(base, 'project');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(root);
  return { base, home, root, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function writeOwnerFiles(ws, files) {
  for (const [relative, value] of Object.entries(files)) {
    const target = relative.startsWith('~/') ? path.join(ws.home, relative.slice(2)) : path.join(ws.root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  }
}

function allHosts(ws) {
  for (const directory of ['.cursor', '.gemini', '.windsurf', '.clinerules', '.codex']) {
    fs.mkdirSync(path.join(ws.root, directory), { recursive: true });
  }
  if (!fs.existsSync(path.join(ws.root, '.codex', 'config.toml'))) fs.writeFileSync(path.join(ws.root, '.codex', 'config.toml'), 'model = "x"\n');
  fs.mkdirSync(path.join(ws.home, '.grok'), { recursive: true });
  fs.chmodSync(path.join(ws.home, '.grok'), 0o755);
  if (!fs.existsSync(path.join(ws.root, 'CLAUDE.md'))) fs.writeFileSync(path.join(ws.root, 'CLAUDE.md'), '# Claude\n');
  if (!fs.existsSync(path.join(ws.root, 'package.json'))) fs.writeFileSync(path.join(ws.root, 'package.json'), '{}\n');
}

function install(ws, target = hostApprovalTarget()) {
  const detection = installer.detectEnvironment(ws.root, { HOME: ws.home, PATH: process.env.PATH });
  const plan = installer.buildPlan(detection, { mode: 'mcp', mcpTarget: target });
  return { detection, plan, changes: installer.applyPlan(plan, { yes: true, dryRun: false, doctor: false }) };
}

// The real 0.1.67 output (fixtures generated from 71c55c1 over owner-files.json), laid out again.
function load0167(ws) {
  const manifest = readJson(path.join(FIXTURES, 'manifest.json'));
  writeOwnerFiles(ws, readJson(path.join(FIXTURES, 'owner-files.json')));
  for (const [relative, info] of Object.entries(manifest.files)) {
    const source = path.join(FIXTURES, relative.replace(/^~\//, 'HOME/').replace(/(^|\/)\.(?=[a-z])/g, '$1dot-'));
    const target = relative.startsWith('~/') ? path.join(ws.home, relative.slice(2)) : path.join(ws.root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
    fs.chmodSync(target, parseInt(info.mode, 8));
  }
  fs.chmodSync(path.join(ws.home, '.grok'), 0o755);
  fs.chmodSync(path.join(ws.home, '.grok', 'hooks'), 0o755);
  return manifest;
}

function isMarrowCommand(value) {
  return typeof value === 'string' && /@getmarrow\/mcp@[^\s"',]+/.test(value);
}

// The owner's part of a grouped hook file (Claude Code, Codex, Gemini, Grok).
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

// What `marrow-mcp setup` writes to .claude/settings.json in the host-approvals MCP candidate
// (0bfc055: src/hook-contract.ts reconcileMarrowCommandHook with handlerFields, src/hook.ts
// installPostToolUseHook, installPermissionRequestHook, and the cli.ts setup order).
function mcpSubcommand(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^npx\s+(?:-y\s+)?(?:--package=@getmarrow\/mcp(?:@[^\s]+)?\s+marrow-mcp|@getmarrow\/mcp(?:@[^\s]+)?)\s+(?:(?:claude|cline|codex|cursor|gemini|grok|windsurf)-)?(context-hook|pre-action-hook|hook|session-hook|permission-request-hook)$/);
  return match?.[1] || null;
}

function mcpReconcile(settings, eventName, subcommand, wanted, matcher, handlerFields = {}) {
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const original = Array.isArray(hooks[eventName]) ? hooks[eventName] : [];
  let preferred = null;
  const retained = [];
  for (const entry of original) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) {
      retained.push(entry);
      continue;
    }
    const remaining = [];
    for (const hook of entry.hooks) {
      const detected = mcpSubcommand(hook?.command);
      if (hook?.type === 'command' && detected) {
        const exactMatcher = matcher === undefined ? entry.matcher === undefined : entry.matcher === matcher;
        if (detected === subcommand && (!preferred || (hook.command === wanted && exactMatcher))) preferred = hook;
        continue;
      }
      remaining.push(hook);
    }
    if (remaining.length > 0) retained.push({ ...entry, hooks: remaining });
  }
  const canonical = { hooks: [{ ...(preferred || {}), ...handlerFields, type: 'command', command: wanted }] };
  if (matcher !== undefined) canonical.matcher = matcher;
  retained.push(canonical);
  return retained;
}

function candidateMcpSetup(settingsPath, version = hostApprovalVersion()) {
  const steps = [
    (s) => ({ PostToolUse: mcpReconcile(s, 'PostToolUse', 'hook', cmd('claude-hook', version), CLAUDE_MATCHER), PostToolUseFailure: mcpReconcile(s, 'PostToolUseFailure', 'hook', cmd('claude-hook', version), CLAUDE_MATCHER) }),
    (s) => ({ UserPromptSubmit: mcpReconcile(s, 'UserPromptSubmit', 'context-hook', cmd('claude-context-hook', version)) }),
    (s) => ({ PreToolUse: mcpReconcile(s, 'PreToolUse', 'pre-action-hook', cmd('claude-pre-action-hook', version), CLAUDE_MATCHER) }),
    (s) => ({
      PermissionRequest: mcpReconcile(s, 'PermissionRequest', 'permission-request-hook', cmd('claude-permission-request-hook', version), CLAUDE_MATCHER, { async: true }),
      PostToolBatch: mcpReconcile(s, 'PostToolBatch', 'hook', cmd('claude-hook', version), undefined, { async: true }),
    }),
    (s) => ({ Stop: mcpReconcile(s, 'Stop', 'session-hook', cmd('claude-session-hook', version)) }),
  ];
  for (const step of steps) {
    const settings = fs.existsSync(settingsPath) ? readJson(settingsPath) : {};
    const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
    settings.hooks = { ...hooks, ...step(settings) };
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }
}

test('the host-approval layout is gated on an MCP that answers it; the pin lives in src/pins.js', () => {
  assert.equal(installer.ADAPTER_PROVENANCE.mcp.version, PINS.MCP_ADAPTER_VERSION);
  assert.equal(installer.ADAPTER_PROVENANCE.mcp.source_sha, PINS.MCP_ADAPTER_SOURCE_SHA);
  assert.equal(installer.ADAPTER_PROVENANCE.mcp.integrity, PINS.MCP_ADAPTER_INTEGRITY);
  assert.equal(installer.ADAPTER_PROVENANCE.sdk.version, PINS.SDK_ADAPTER_VERSION);
  assert.equal(installer.hostApprovalHooksSupported(PINS.MCP_HOST_APPROVAL_HOOKS_SINCE), true);
  assert.equal(installer.hostApprovalHooksSupported('3.9.97'), false);
  assert.equal(installer.hostApprovalHooksSupported('not-a-version'), false);
  const [major, minor, patch] = PINS.MCP_HOST_APPROVAL_HOOKS_SINCE.split('.').map(Number);
  assert.equal(installer.hostApprovalHooksSupported(`${major}.${minor}.${patch + 1}`), true);
  if (patch > 0) assert.equal(installer.hostApprovalHooksSupported(`${major}.${minor}.${patch - 1}`), false);
  // No source file other than pins.js names the MCP or SDK version.
  for (const file of fs.readdirSync(path.join(__dirname, '..', 'src'))) {
    if (file === 'pins.js') continue;
    const text = fs.readFileSync(path.join(__dirname, '..', 'src', file), 'utf8');
    assert.equal(text.includes(PINS.MCP_ADAPTER_SOURCE_SHA), false, file);
    assert.equal(new RegExp(`['"\`]${PINS.MCP_ADAPTER_VERSION.replaceAll('.', '\\.')}['"\`]`).test(text), false, file);
    assert.equal(new RegExp(`['"\`]${PINS.SDK_ADAPTER_VERSION.replaceAll('.', '\\.')}['"\`]`).test(text), false, file);
  }
  const target = hostApprovalTarget();
  assert.equal(target.version, hostApprovalVersion());
});

test('Claude Code: PermissionRequest and PostToolBatch (async) match marrow-mcp setup byte for byte, in both orders', () => {
  const fresh = workspace('marrow-ha-claude-');
  try {
    fs.writeFileSync(path.join(fresh.root, 'CLAUDE.md'), '# Claude\n');
    const { changes } = install(fresh);
    assert.equal(changes.find((change) => change.label === 'Claude Code MCP passive hooks').applied, true);
    const settingsPath = path.join(fresh.root, '.claude', 'settings.json');
    const settings = readJson(settingsPath);
    assert.deepEqual(settings.hooks.PermissionRequest, [{ hooks: [{ async: true, type: 'command', command: cmd('claude-permission-request-hook') }], matcher: CLAUDE_MATCHER }]);
    assert.deepEqual(settings.hooks.PostToolBatch, [{ hooks: [{ async: true, type: 'command', command: cmd('claude-hook') }] }]);
    for (const [event, entrypoint] of [['PreToolUse', 'claude-pre-action-hook'], ['PostToolUse', 'claude-hook'], ['PostToolUseFailure', 'claude-hook'], ['UserPromptSubmit', 'claude-context-hook'], ['Stop', 'claude-session-hook']]) {
      assert.deepEqual(settings.hooks[event].flatMap((group) => group.hooks.map((hook) => hook.command)), [cmd(entrypoint)], event);
    }
    // The pass-through marker must never decide: no decision field, no matcher on PostToolBatch.
    assert.doesNotMatch(JSON.stringify(settings.hooks.PermissionRequest), /decision|behavior|allow"/);
    const written = fs.readFileSync(settingsPath, 'utf8');
    candidateMcpSetup(settingsPath);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), written, 'MCP setup leaves the installer bytes alone');
  } finally {
    fresh.cleanup();
  }
  const mcpFirst = workspace('marrow-ha-claude-mcp-first-');
  try {
    const settingsPath = path.join(mcpFirst.root, '.claude', 'settings.json');
    writeOwnerFiles(mcpFirst, { '.claude/settings.json': { permissions: { allow: ['Read'] } } });
    candidateMcpSetup(settingsPath);
    const fromMcp = fs.readFileSync(settingsPath, 'utf8');
    const change = install(mcpFirst).changes.find((entry) => entry.label === 'Claude Code MCP passive hooks');
    assert.equal(change.changed, false);
    assert.equal(change.already_present, true);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), fromMcp);
  } finally {
    mcpFirst.cleanup();
  }
});

test('Cursor: ask on the execution hooks (failClosed, 15 s), MCP still gated in preToolUse for cloud agents, typed-reply and session hooks', () => {
  const ws = workspace('marrow-ha-cursor-');
  try {
    fs.mkdirSync(path.join(ws.root, '.cursor'));
    install(ws);
    const settings = readJson(path.join(ws.root, '.cursor', 'hooks.json'));
    assert.equal(settings.version, 1);
    const marrow = (event) => (settings.hooks[event] || []).filter((entry) => isMarrowCommand(entry.command));
    assert.deepEqual(marrow('preToolUse'), [{ command: cmd('cursor-pre-action-hook'), matcher: installer.CURSOR_PRE_TOOL_USE_HOST_APPROVAL_MATCHER, timeout: 15, failClosed: true, async: false }]);
    assert.deepEqual(marrow('beforeShellExecution'), [{ command: cmd('cursor-pre-action-hook'), timeout: 15, failClosed: true, async: false }]);
    const mcpGuard = marrow('beforeMCPExecution');
    assert.equal(mcpGuard.length, 1);
    assert.deepEqual({ ...mcpGuard[0], command: undefined }, { command: undefined, timeout: 15, failClosed: true, async: false });
    assert.ok(mcpGuard[0].command.startsWith("node -e '"));
    assert.ok(mcpGuard[0].command.includes(`"--package=${spec()}","marrow-mcp","cursor-pre-action-hook"`));
    for (const event of ['afterShellExecution', 'afterMCPExecution']) {
      assert.deepEqual(marrow(event), [{ command: cmd('cursor-hook'), timeout: 5 }], event);
    }
    assert.deepEqual(marrow('sessionStart'), [{ command: cmd('cursor-session-hook'), timeout: 5 }]);
    assert.deepEqual(marrow('beforeSubmitPrompt'), [{ command: cmd('cursor-context-hook'), timeout: 5 }]);
    assert.equal(marrow('beforeSubmitPrompt')[0].failClosed, undefined, 'a prompt hook failure must not block the operator');
    for (const event of ['postToolUse', 'postToolUseFailure']) {
      assert.deepEqual(marrow(event), [{ command: cmd('cursor-hook'), matcher: CURSOR_FULL_MATCHER, timeout: 5 }], event);
    }
    assert.deepEqual(marrow('stop'), [{ command: cmd('cursor-session-hook'), timeout: 3 }]);
    const preToolUse = new RegExp(installer.CURSOR_PRE_TOOL_USE_HOST_APPROVAL_MATCHER);
    // Shell leaves preToolUse (beforeShellExecution runs in cloud agents too); third-party MCP
    // calls stay, because cloud agents never run beforeMCPExecution. Marrow's own tools stay out.
    assert.equal(preToolUse.test('Shell'), false);
    for (const tool of ['MCP:deploy', 'MCP:github:create_pr', 'Write', 'Delete', 'Task', 'Read', 'Grep']) assert.equal(preToolUse.test(tool), true, tool);
    for (const tool of ['MCP:marrow_agent_runtime', 'MCP:marrow:marrow_commit']) assert.equal(preToolUse.test(tool), false, tool);
    assert.doesNotMatch(JSON.stringify(settings), /"ask"/);
    for (const entries of Object.values(settings.hooks)) for (const entry of entries) assert.equal('permission' in entry, false);
  } finally {
    ws.cleanup();
  }
});

test('Cursor beforeMCPExecution guard: Marrow\'s own tools pass at once without npx; every other call reaches the hook unchanged; failures block', () => {
  const ws = workspace('marrow-ha-cursor-guard-');
  try {
    fs.mkdirSync(path.join(ws.root, '.cursor'));
    install(ws);
    const guard = readJson(path.join(ws.root, '.cursor', 'hooks.json')).hooks.beforeMCPExecution.find((entry) => isMarrowCommand(entry.command)).command;
    const bin = path.join(ws.base, 'fake-bin');
    fs.mkdirSync(bin);
    const spawned = path.join(ws.base, 'npx-ran');
    fs.writeFileSync(path.join(bin, 'npx'), `#!/bin/sh
printf '%s ' "$@" >> ${JSON.stringify(spawned)}
input=$(cat)
case "$FAKE_NPX_MODE" in
  echo) n=$(printf '%s' "$input" | wc -c); printf '{"permission":"deny","user_message":"bytes %s","agent_message":"held"}' "$n" ;;
  ask) printf '%s\\n' '{"permission":"ask","user_message":"Approve?","agent_message":"asked"}' ;;
  invalid) printf '%s' 'npm notice {"permission":"allow"}' ;;
  array) printf '%s' '[]' ;;
  *) exit 7 ;;
esac
`);
    fs.chmodSync(path.join(bin, 'npx'), 0o755);
    const run = (mode, event) => {
      if (fs.existsSync(spawned)) fs.rmSync(spawned);
      return spawnSync(guard, { shell: true, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_NPX_MODE: mode }, input: JSON.stringify(event), encoding: 'utf8', timeout: 20_000 });
    };
    const own = run('fail', { hook_event_name: 'beforeMCPExecution', mcp_server_name: 'marrow', tool_name: 'marrow_agent_runtime', tool_input: '{}' });
    assert.equal(own.status, 0, own.stderr);
    assert.equal(own.stdout, '{"permission":"allow"}\n');
    assert.equal(fs.existsSync(spawned), false, 'no npx for Marrow\'s own tools');
    for (const event of [
      { mcp_server_name: 'marrow', tool_name: 'deploy_service' },
      { mcp_server_name: 'marrow-tools', tool_name: 'marrow_commit' },
      { mcp_server_name: 'release-tools', tool_name: 'marrow_commit' },
      { tool_name: 'marrow_commit' },
    ]) {
      const other = run('ask', { hook_event_name: 'beforeMCPExecution', tool_input: '{}', ...event });
      assert.equal(other.status, 0, JSON.stringify(event));
      assert.equal(other.stdout, '{"permission":"ask","user_message":"Approve?","agent_message":"asked"}\n', JSON.stringify(event));
      assert.equal(fs.readFileSync(spawned, 'utf8').trim(), `-y --package=${spec()} marrow-mcp cursor-pre-action-hook`);
    }
    const big = { hook_event_name: 'beforeMCPExecution', mcp_server_name: 'release-tools', tool_name: 'upload', tool_input: JSON.stringify({ blob: 'x'.repeat(300_000) }) };
    const echoed = run('echo', big);
    assert.equal(echoed.status, 0, echoed.stderr);
    assert.equal(JSON.parse(echoed.stdout).user_message, `bytes ${Buffer.byteLength(JSON.stringify(big))}`);
    for (const mode of ['fail', 'invalid', 'array']) {
      const failed = run(mode, { hook_event_name: 'beforeMCPExecution', mcp_server_name: 'release-tools', tool_name: 'deploy', tool_input: '{}' });
      assert.equal(failed.status, 2, mode);
      assert.equal(failed.stdout, '', mode);
      assert.equal(failed.stderr, 'Marrow governance adapter was unavailable; this MCP call is blocked.\n', mode);
    }
    const garbage = spawnSync(guard, { shell: true, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_NPX_MODE: 'ask' }, input: 'not json', encoding: 'utf8' });
    assert.equal(garbage.status, 0, 'unparseable input still reaches the hook, which decides');
  } finally {
    ws.cleanup();
  }
});

test('uninstall keeps owner hooks that only mention marrow, and an owner Grok file; doctor needs every Cursor approval hook; the registry target needs its exact tarball', async () => {
  const ws = workspace('marrow-ha-owner-marrow-');
  try {
    writeOwnerFiles(ws, {
      '.gemini/settings.json': { hooks: { BeforeTool: [{ matcher: 'write_file', hooks: [{ name: 'owner-marrow-audit', type: 'command', command: 'printf audit' }] }] } },
      '.cursor/hooks.json': { version: 1, hooks: { beforeShellExecution: [{ command: './scripts/marrow-report.sh' }], beforeMCPExecution: [{ command: 'node -e "marrow"' }] } },
    });
    allHosts(ws);
    const { detection, plan, changes } = install(ws);
    // The owner adds a hook of their own to Marrow's Grok file.
    const grokFile = path.join(ws.home, '.grok', 'hooks', 'marrow.json');
    const grok = readJson(grokFile);
    grok.hooks.PreToolUse.unshift({ matcher: 'run_terminal_command', hooks: [{ type: 'command', command: 'owner-grok-check', timeout: 3 }] });
    fs.writeFileSync(grokFile, `${JSON.stringify(grok, null, 2)}\n`);
    const cursorBefore = readJson(path.join(ws.root, '.cursor', 'hooks.json'));
    assert.equal(cursorBefore.hooks.beforeMCPExecution.length, 2);
    // Doctor: every Cursor approval hook is required once the MCP answers them.
    assert.equal(installer.activationProfile(detection, plan, changes, 'cursor').observed_hooks.includes('pre_action'), true);
    const cursorPath = path.join(ws.root, '.cursor', 'hooks.json');
    for (const event of ['beforeSubmitPrompt', 'beforeMCPExecution', 'sessionStart']) {
      const value = readJson(cursorPath);
      const kept = value.hooks[event];
      value.hooks[event] = kept.filter((entry) => !isMarrowCommand(entry.command));
      fs.writeFileSync(cursorPath, `${JSON.stringify(value, null, 2)}\n`);
      assert.equal(installer.activationProfile(detection, plan, changes, 'cursor').observed_hooks.includes('pre_action'), false, event);
      value.hooks[event] = kept;
      fs.writeFileSync(cursorPath, `${JSON.stringify(value, null, 2)}\n`);
    }
    await installer.uninstall({ cwd: ws.root, home: ws.home, yes: true, controller: false });
    assert.deepEqual(readJson(path.join(ws.root, '.gemini', 'settings.json')).hooks.BeforeTool, [{ matcher: 'write_file', hooks: [{ name: 'owner-marrow-audit', type: 'command', command: 'printf audit' }] }]);
    assert.deepEqual(readJson(cursorPath).hooks, { beforeShellExecution: [{ command: './scripts/marrow-report.sh' }], beforeMCPExecution: [{ command: 'node -e "marrow"' }] });
    const grokPath = path.join(ws.home, '.grok', 'hooks', 'marrow.json');
    assert.equal(fs.existsSync(grokPath), true, 'a Grok file that still holds the owner\'s hooks is kept');
    assert.deepEqual(readJson(grokPath).hooks.PreToolUse, [{ matcher: 'run_terminal_command', hooks: [{ type: 'command', command: 'owner-grok-check', timeout: 3 }] }]);
  } finally {
    ws.cleanup();
  }
  // A registry answer whose tarball is not the package's own is not a verified target.
  const version = hostApprovalVersion();
  const wrongTarball = installer.resolveMcpTargetVersion({ registryMetadata: { name: '@getmarrow/mcp', version, dist: { integrity: `sha512-${crypto.createHash('sha512').update('x').digest('base64')}`, tarball: `https://registry.example.test/@getmarrow/mcp/-/mcp-${version}.tgz` } } });
  assert.equal(wrongTarball.source, 'sealed_installer');
  assert.equal(wrongTarball.version, PINS.MCP_ADAPTER_VERSION);
});

test('Codex keeps UserPromptSubmit -> codex-context-hook and is never configured to ask', () => {
  const ws = workspace('marrow-ha-codex-');
  try {
    fs.mkdirSync(path.join(ws.root, '.codex'));
    fs.writeFileSync(path.join(ws.root, '.codex', 'config.toml'), 'model = "x"\n');
    install(ws);
    const settings = readJson(path.join(ws.root, '.codex', 'hooks.json'));
    assert.deepEqual(settings.hooks.UserPromptSubmit, [{ hooks: [{ timeout: 5, type: 'command', command: cmd('codex-context-hook') }] }]);
    assert.equal(settings.hooks.PermissionRequest, undefined, 'Codex PermissionRequest runs only for its own escalations');
    assert.doesNotMatch(JSON.stringify(settings), /"ask"/);
  } finally {
    ws.cleanup();
  }
});

function fakeNpx(dir) {
  const bin = path.join(dir, 'fake-bin');
  fs.mkdirSync(bin);
  // Prints the output selected by FAKE_NPX_MODE; `stdin` echoes how many stdin bytes arrived.
  fs.writeFileSync(path.join(bin, 'npx'), `#!/bin/sh
case "$FAKE_NPX_MODE" in
  allow) printf '%s\\n' '{"decision":"allow"}' ;;
  fixed) printf '%s' '{"decision":"deny","reason":"Marrow blocked this action because required governance approval or proof is unavailable."}' ;;
  typed) printf '%s' '{"decision":"deny","reason":"Marrow holds this action for approval.","systemMessage":"Marrow holds this action. To approve it, type: marrow approve AB12CD (or: marrow decline AB12CD)."}' ;;
  extra) printf '%s' '{"decision":"deny","reason":"x","systemMessage":"y","continue":false}' ;;
  allowmsg) printf '%s' '{"decision":"allow","systemMessage":"y"}' ;;
  emptyreason) printf '%s' '{"decision":"deny","reason":""}' ;;
  longreason) printf '{"decision":"deny","reason":"%0501d"}' 0 ;;
  longmsg) printf '{"decision":"deny","reason":"r","systemMessage":"%0601d"}' 0 ;;
  spaced) printf '%s' '{ "decision": "allow" }' ;;
  polluted) printf '%s' 'npm notice {"decision":"allow"}' ;;
  ctx) printf '%s' '{"systemMessage":"Marrow recorded your approval (client-attested).","hookSpecificOutput":{"hookEventName":"BeforeAgent","additionalContext":"The operator approved the held action (gate receipt gr_1). Retry that exact action now."}}' ;;
  ctxempty) printf '%s' '{}' ;;
  ctxblock) printf '%s' '{"decision":"deny","reason":"blocked"}' ;;
  ctxwrongevent) printf '%s' '{"hookSpecificOutput":{"hookEventName":"BeforeTool","additionalContext":"x"}}' ;;
  stdin) n=$(wc -c); printf '{"decision":"deny","reason":"bytes %s"}' "$n" ;;
  slow) sleep 8; printf '%s' '{"decision":"allow"}' ;;
  *) printf '%s\\n' 'synthetic-private-launch-error' >&2; exit 7 ;;
esac
`);
  fs.chmodSync(path.join(bin, 'npx'), 0o755);
  return bin;
}

test('Gemini: the BeforeTool guard passes the typed-reply denial, keeps the fixed texts, and blocks anything else', () => {
  const ws = workspace('marrow-ha-gemini-');
  try {
    fs.mkdirSync(path.join(ws.root, '.gemini'));
    install(ws);
    const settings = readJson(path.join(ws.root, '.gemini', 'settings.json'));
    const handler = (event, name) => settings.hooks[event].flatMap((group) => group.hooks.map((hook) => ({ ...hook, matcher: group.matcher }))).find((hook) => hook.name === name);
    const before = handler('BeforeTool', 'marrow-before-tool');
    const agent = handler('BeforeAgent', 'marrow-before-agent');
    assert.equal(before.matcher, GEMINI_MATCHER);
    assert.equal(before.timeout, 5000);
    assert.equal(agent.matcher, undefined);
    assert.equal(agent.timeout, 5000);
    assert.ok(before.command.includes(`"--package=${spec()}","marrow-mcp","gemini-pre-action-hook"`));
    assert.ok(agent.command.includes(`"--package=${spec()}","marrow-mcp","gemini-context-hook"`));
    assert.equal(handler('AfterTool', 'marrow-after-tool').command.includes(`${spec()} marrow-mcp gemini-hook`), true);
    assert.equal(handler('AfterAgent', 'marrow-after-agent').command.includes(`${spec()} marrow-mcp gemini-session-hook`), true);

    const bin = fakeNpx(ws.base);
    const run = (command, mode, input = '{}') => spawnSync(command, { shell: true, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_NPX_MODE: mode }, input, encoding: 'utf8', timeout: 20_000 });
    const passed = {
      allow: '{"decision":"allow"}\n',
      fixed: '{"decision":"deny","reason":"Marrow blocked this action because required governance approval or proof is unavailable."}\n',
      typed: '{"decision":"deny","reason":"Marrow holds this action for approval.","systemMessage":"Marrow holds this action. To approve it, type: marrow approve AB12CD (or: marrow decline AB12CD)."}\n',
    };
    for (const [mode, stdout] of Object.entries(passed)) {
      const out = run(before.command, mode);
      assert.equal(out.status, 0, `${mode}: ${out.stderr}`);
      assert.equal(out.stdout, stdout, mode);
      assert.equal(out.stderr, '');
    }
    for (const mode of ['extra', 'allowmsg', 'emptyreason', 'longreason', 'longmsg', 'spaced', 'polluted', 'ctx', 'fail']) {
      const out = run(before.command, mode);
      assert.equal(out.status, 2, mode);
      assert.equal(out.stdout, '', mode);
      assert.equal(out.stderr, LAUNCH_FAILURE, mode);
    }
    // stdin reaches the MCP entrypoint unbuffered and unbounded (large tool inputs are not cut).
    const big = JSON.stringify({ tool_name: 'write_file', tool_input: { content: 'x'.repeat(200_000) } });
    const echoed = run(before.command, 'stdin', big);
    assert.equal(echoed.status, 0, echoed.stderr);
    assert.equal(JSON.parse(echoed.stdout).reason, `bytes ${Buffer.byteLength(big)}`);
    // A hung entrypoint is blocked before Gemini's own 5 s timeout could let the call through.
    const started = Date.now();
    const slow = run(before.command, 'slow');
    assert.equal(slow.status, 2);
    assert.equal(slow.stderr, LAUNCH_FAILURE);
    assert.ok(Date.now() - started < 5000, 'the guard gives up before the host timeout');

    // BeforeAgent never blocks the prompt: valid output passes, anything else becomes {}.
    for (const [mode, stdout] of [['ctx', null], ['ctxempty', '{}\n']]) {
      const out = run(agent.command, mode, '{"hook_event_name":"BeforeAgent","prompt":"marrow approve AB12CD"}');
      assert.equal(out.status, 0, mode);
      if (stdout) assert.equal(out.stdout, stdout);
      else assert.deepEqual(JSON.parse(out.stdout).hookSpecificOutput.hookEventName, 'BeforeAgent');
    }
    for (const mode of ['ctxblock', 'ctxwrongevent', 'allow', 'polluted', 'fail', 'slow']) {
      const out = run(agent.command, mode);
      assert.equal(out.status, 0, mode);
      assert.equal(out.stdout, '{}\n', mode);
      assert.equal(out.stderr, '', mode);
    }
  } finally {
    ws.cleanup();
  }
});

test('upgrade from the real 0.1.67 layout: only Marrow entries change, the owner\'s hooks stay, a re-run changes nothing', () => {
  const ws = workspace('marrow-ha-upgrade-');
  try {
    const manifest = load0167(ws);
    const before = Object.fromEntries(Object.keys(manifest.files).map((relative) => {
      const file = relative.startsWith('~/') ? path.join(ws.home, relative.slice(2)) : path.join(ws.root, relative);
      return [relative, fs.readFileSync(file, 'utf8')];
    }));
    allHosts(ws);
    const first = install(ws);
    const after = (relative) => fs.readFileSync(relative.startsWith('~/') ? path.join(ws.home, relative.slice(2)) : path.join(ws.root, relative), 'utf8');
    for (const relative of ['.claude/settings.json', '.codex/hooks.json', '.gemini/settings.json', '~/.grok/hooks/marrow.json']) {
      assert.deepEqual(ownerGroupedHooks(JSON.parse(after(relative))), ownerGroupedHooks(JSON.parse(before[relative])), relative);
    }
    for (const relative of ['.cursor/hooks.json', '.windsurf/hooks.json']) {
      assert.deepEqual(ownerFlatHooks(JSON.parse(after(relative))), ownerFlatHooks(JSON.parse(before[relative])), relative);
    }
    const claude = JSON.parse(after('.claude/settings.json'));
    assert.deepEqual(claude.permissions, { allow: ['Read'] });
    // The owner's own PermissionRequest and PostToolBatch hooks sit next to Marrow's markers.
    assert.deepEqual(claude.hooks.PermissionRequest[0], { matcher: 'Edit', hooks: [{ type: 'command', command: 'owner-permission-note' }] });
    assert.equal(claude.hooks.PermissionRequest.length, 2);
    assert.deepEqual(claude.hooks.PostToolBatch[0], { hooks: [{ type: 'command', command: 'owner-batch-log', async: true }] });
    assert.equal(claude.hooks.PostToolBatch.length, 2);
    const cursor = JSON.parse(after('.cursor/hooks.json'));
    assert.deepEqual(cursor.hooks.beforeShellExecution[0], { command: './owner/approve-network.sh', matcher: 'curl|wget', timeout: 30 });
    assert.equal(cursor.hooks.beforeShellExecution.length, 2);
    assert.deepEqual(cursor.hooks.preToolUse[0], { command: './owner/pre.sh', matcher: 'Write' });
    const gemini = JSON.parse(after('.gemini/settings.json'));
    assert.deepEqual(gemini.owner_setting, { retained: true });
    assert.deepEqual(gemini.hooksConfig, { enabled: true });
    assert.equal(gemini.hooks.BeforeAgent.length, 2);
    // Every Marrow entry now uses the version that answers the new hooks; none is duplicated.
    for (const relative of Object.keys(before)) {
      const text = after(relative);
      const versions = [...text.matchAll(/@getmarrow\/mcp@(\d+\.\d+\.\d+)/g)].map((match) => match[1]);
      assert.ok(versions.every((version) => version === hostApprovalVersion()), `${relative}: ${[...new Set(versions)]}`);
    }
    const marrowHandlerCount = (settings, event) => (settings.hooks[event] || []).flatMap((group) => group.hooks || [group]).filter((hook) => isMarrowCommand(hook.command)).length;
    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'PermissionRequest', 'PostToolBatch']) {
      assert.equal(marrowHandlerCount(claude, event), 1, event);
    }
    assert.ok(first.changes.some((change) => change.applied));
    const snapshot = Object.fromEntries(Object.keys(before).map((relative) => [relative, after(relative)]));
    const second = install(ws);
    assert.deepEqual(second.changes.filter((change) => change.changed).map((change) => change.label), []);
    for (const [relative, text] of Object.entries(snapshot)) assert.equal(after(relative), text, `re-run rewrote ${relative}`);
  } finally {
    ws.cleanup();
  }
});

test('at a pinned MCP that cannot answer the new hooks, install writes exactly the 0.1.67 layout', { skip: installer.hostApprovalHooksSupported(PINS.MCP_ADAPTER_VERSION) ? 'the pinned MCP answers the host-approval hooks' : false }, () => {
  const ws = workspace('marrow-ha-sealed-');
  try {
    writeOwnerFiles(ws, readJson(path.join(FIXTURES, 'owner-files.json')));
    allHosts(ws);
    const { plan } = install(ws, installer.resolveMcpTargetVersion());
    assert.equal(plan.host_approval_hooks, false);
    const manifest = readJson(path.join(FIXTURES, 'manifest.json'));
    for (const relative of Object.keys(manifest.files)) {
      const expected = fs.readFileSync(path.join(FIXTURES, relative.replace(/^~\//, 'HOME/').replace(/(^|\/)\.(?=[a-z])/g, '$1dot-')), 'utf8');
      const actual = fs.readFileSync(relative.startsWith('~/') ? path.join(ws.home, relative.slice(2)) : path.join(ws.root, relative), 'utf8');
      assert.equal(actual, expected, relative);
    }
  } finally {
    ws.cleanup();
  }
});

test('uninstall after an upgrade removes only Marrow entries and returns the owner\'s files to what they held', async () => {
  const ws = workspace('marrow-ha-uninstall-');
  try {
    const owner = readJson(path.join(FIXTURES, 'owner-files.json'));
    load0167(ws);
    allHosts(ws);
    install(ws);
    const preview = await installer.uninstall({ cwd: ws.root, home: ws.home });
    assert.equal(preview.uninstall.applied, false);
    assert.ok(preview.uninstall.removed_entries > 20);
    assert.ok(fs.readFileSync(path.join(ws.root, '.claude', 'settings.json'), 'utf8').includes('claude-permission-request-hook'), 'a preview writes nothing');
    const result = await installer.uninstall({ cwd: ws.root, home: ws.home, yes: true, controller: false });
    assert.equal(result.uninstall.applied, true);
    for (const relative of ['.claude/settings.json', '.codex/hooks.json', '.cursor/hooks.json', '.gemini/settings.json', '.windsurf/hooks.json', '.mcp.json', '.cursor/mcp.json']) {
      assert.deepEqual(readJson(path.join(ws.root, relative)), owner[relative], relative);
    }
    assert.equal(fs.readFileSync(path.join(ws.root, 'AGENTS.md'), 'utf8'), owner['AGENTS.md']);
    for (const owned of ['.clinerules/hooks/PreToolUse', '.clinerules/hooks/PostToolUse', '.clinerules/hooks/TaskCancel', '.cursor/rules/marrow.mdc']) {
      assert.equal(fs.existsSync(path.join(ws.root, owned)), false, owned);
    }
    assert.equal(fs.existsSync(path.join(ws.home, '.grok', 'hooks', 'marrow.json')), false);
    for (const relative of ['package.json', 'CLAUDE.md', '.codex/config.toml']) assert.equal(fs.existsSync(path.join(ws.root, relative)), true, relative);
    const again = await installer.uninstall({ cwd: ws.root, home: ws.home, yes: true, controller: false });
    assert.equal(again.uninstall.removed_entries, 0);
  } finally {
    ws.cleanup();
  }
});

test('uninstall keeps edited Marrow files, custom marrow servers and the owner\'s Hermes config, and prints paths only', () => {
  const ws = workspace('marrow-ha-uninstall-keep-');
  try {
    allHosts(ws);
    install(ws);
    fs.appendFileSync(path.join(ws.root, '.clinerules', 'hooks', 'PreToolUse'), '# owner edit\n');
    const cursorMcp = path.join(ws.root, '.cursor', 'mcp.json');
    fs.writeFileSync(cursorMcp, `${JSON.stringify({ mcpServers: { marrow: { command: '/opt/owner/marrow-wrapper', args: [] } } }, null, 2)}\n`);
    const hermesDir = path.join(ws.home, '.hermes');
    fs.mkdirSync(hermesDir, { mode: 0o700 });
    const hermesConfig = 'model: x\nmcp_servers:\n  marrow:\n    command: npx\n';
    fs.writeFileSync(path.join(hermesDir, 'config.yaml'), hermesConfig, { mode: 0o600 });
    fs.mkdirSync(path.join(ws.root, '.marrow'), { recursive: true });
    fs.writeFileSync(path.join(ws.root, '.marrow', 'passive-runtime.mjs'), '// generated\n');
    const env = { PATH: process.env.PATH, HOME: ws.home };
    const preview = spawnSync(process.execPath, [BIN, 'uninstall', '--cwd', ws.root], { env, encoding: 'utf8' });
    assert.equal(preview.status, 0, preview.stderr);
    assert.match(preview.stdout, /^Marrow uninstall \(preview\): \d+ Marrow entries to remove\./);
    assert.match(preview.stdout, /Run npx @getmarrow\/install uninstall --yes/);
    const applied = spawnSync(process.execPath, [BIN, 'uninstall', '--yes', '--no-controller', '--cwd', ws.root], { env, encoding: 'utf8' });
    assert.equal(applied.status, 0, applied.stderr);
    const output = `${preview.stdout}${applied.stdout}${applied.stderr}`;
    assert.match(applied.stdout, /\.clinerules\/hooks\/PreToolUse: left unchanged \(edited after Marrow wrote it\)/);
    assert.match(applied.stdout, /\.cursor\/mcp\.json: left unchanged \(custom marrow server entry\)/);
    assert.match(applied.stdout, /config\.yaml: left in place; remove mcp_servers\.marrow by hand/);
    assert.match(applied.stdout, /passive-runtime\.mjs: left in place/);
    assert.doesNotMatch(output, /npx -y|marrow-mcp |@getmarrow\/mcp@|command:|"hooks"/, 'no file content is printed');
    assert.equal(fs.existsSync(path.join(ws.root, '.clinerules', 'hooks', 'PreToolUse')), true);
    assert.equal(fs.readFileSync(path.join(hermesDir, 'config.yaml'), 'utf8'), hermesConfig);
    assert.deepEqual(readJson(cursorMcp).mcpServers.marrow.command, '/opt/owner/marrow-wrapper');
    assert.doesNotMatch(fs.readFileSync(path.join(ws.root, '.claude', 'settings.json'), 'utf8'), /marrow-mcp/);
    const rejected = spawnSync(process.execPath, [BIN, 'uninstall', 'doctor', '--cwd', ws.root], { env, encoding: 'utf8' });
    assert.notEqual(rejected.status, 0);
  } finally {
    ws.cleanup();
  }
});

test('doctor coverage requires the host-approval hooks once the MCP answers them', () => {
  const ws = workspace('marrow-ha-profile-');
  try {
    allHosts(ws);
    const { detection, plan, changes } = install(ws);
    assert.equal(plan.host_approval_hooks, true);
    for (const client of ['claude-code', 'cursor', 'gemini']) {
      assert.equal(installer.activationProfile(detection, plan, changes, client).configuration_complete, true, client);
    }
    const drop = (relative, mutate) => {
      const file = path.join(ws.root, relative);
      const value = readJson(file);
      mutate(value);
      fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    };
    const claudeBefore = installer.claudeNativeHookFingerprint(readJson(path.join(ws.root, '.claude', 'settings.json')), { hostApprovals: true });
    drop('.claude/settings.json', (value) => { delete value.hooks.PermissionRequest; });
    const claude = installer.activationProfile(detection, plan, changes, 'claude-code');
    assert.equal(claude.observed_hooks.includes('pre_action'), false);
    assert.equal(claude.configuration_complete, false);
    assert.notEqual(installer.claudeNativeHookFingerprint(readJson(path.join(ws.root, '.claude', 'settings.json')), { hostApprovals: true }), claudeBefore);
    drop('.cursor/hooks.json', (value) => { delete value.hooks.sessionStart; });
    assert.equal(installer.activationProfile(detection, plan, changes, 'cursor').observed_hooks.includes('pre_action'), false);
    drop('.gemini/settings.json', (value) => { delete value.hooks.BeforeAgent; });
    assert.equal(installer.activationProfile(detection, plan, changes, 'gemini').observed_hooks.includes('pre_action'), false);
    // The stage vocabulary the backend accepts is unchanged.
    assert.deepEqual(claude.expected_hooks, ['prompt', 'pre_action', 'action_result', 'session_end']);
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------------------------
// Governed runner: held actions.
// ---------------------------------------------------------------------------------------------

const RECEIPT = 'gr_hold_0001';
const DECISION = 'dec_hold_0001';
const ARBITRATION = 'arb_0001';
const OWNER_RECEIPT = 'oar_0001';
const FORBIDDEN_OUTPUT = [/dashboard/i, /log ?in/i, /@example\.test/, /o…@/, /approval-links\/open/, /#t=/, /https?:\/\//, /tok_secret_/];
const QUIET_ENV = {}; // a clean terminal: no CI, no agent host markers

function holdRuntime(guidance = {}, extra = {}) {
  return {
    risk_gate: { decision: 'review_required', enforced: true, allow: false, gate_required: true, risk_level: 'high', owner_approval_required: true },
    gate_receipt: { id: RECEIPT, required: true, decision: 'review_required', owner_approval_required: true, expires_at: new Date(Date.now() + 30 * 60_000).toISOString() },
    runtime_authorization: { id: RECEIPT, decision_id: DECISION, decision_state: 'created' },
    completion_contract: {
      decision_state: 'created',
      decision_id: DECISION,
      gate_receipt_id: RECEIPT,
      owner_approval_required: true,
      owner_approval: {
        mode: 'ordinary_non_arbitrated',
        approval_status_poll_after_ms: 20,
        host_approval_endpoint: `/v1/agent/gate-receipts/${RECEIPT}/host-approval`,
        host_approval_accepted: true,
        host_approval_refusal_reason: null,
        host_approval_operator_only: false,
        owner_declined_at: null,
        operator_notice: null,
        approval_link_available: false,
        approval_link_reason: null,
        unattended_owner_ping: false,
        ...guidance,
      },
    },
    // Agent-directed served text: never relayed by the runner.
    exact_next_action: `Obtain the account owner's approval: POST /v1/agent/gate-receipts/${RECEIPT}/approval-link (sent to o…@example.test). Or log in to the dashboard.`,
    ...extra,
  };
}

const LINKED = { approval_link_available: true, approval_link_reason: 'owner_locked', approval_link_endpoint: `/v1/agent/gate-receipts/${RECEIPT}/approval-link` };

function arbitrationRuntime() {
  const runtime = holdRuntime();
  runtime.arbitration = { receipt_id: ARBITRATION, decision_id: DECISION, resolution: 'review_required', owner_approval_required: true };
  runtime.completion_contract.owner_approval = {
    mode: 'arbitration_review_required',
    owner_receipt_required: true,
    dashboard_receipt_required: true,
    approval_status_poll_after_ms: 20,
    ...LINKED,
    approval_status_endpoint: `/v1/agent/gate-receipts/${RECEIPT}/owner-approval`,
  };
  runtime.completion_contract.arbitration_receipt_id = ARBITRATION;
  return runtime;
}

// A fake Marrow API: runtime, link, status, host report, commit, think and permits.
function fakeMarrow(scenario) {
  const calls = [];
  let statusIndex = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method || 'GET', pathname: parsed.pathname, body, headers: init.headers || {} });
    const route = parsed.pathname;
    if (route === '/v1/agent/runtime') return Response.json({ data: scenario.runtime });
    if (route === '/v1/agent/think') {
      if (scenario.thinkFails) return Response.json({ error: 'decision service unavailable' }, { status: scenario.thinkFails });
      return Response.json({ data: { decision_id: 'dec_think_0001' } });
    }
    if (route === `/v1/agent/gate-receipts/${RECEIPT}/approval-link`) {
      const reply = typeof scenario.link === 'function' ? scenario.link(calls) : scenario.link;
      if (reply === 'not_sent') return Response.json({ data: { sent: false, state: 'not_sent', reason: 'owner_ping_off', approval_link: null, exact_next_action: 'No link was sent to o…@example.test.' } });
      if (reply?.error) return Response.json({ error: 'No approval link was sent.', code: 'CONFLICT', details: { code: reply.error, retryable: reply.retryable === true, exact_next_action: 'Retry. Owner o…@example.test.' } }, { status: reply.status || 409 });
      return Response.json({ data: {
        sent: true,
        state: 'sent',
        reason: 'owner_locked',
        approval_link: { id: 'link_1', gate_receipt_id: RECEIPT, channel: 'email', recipient_hint: 'o…@example.test', expires_at: new Date(Date.now() + 600_000).toISOString(), delivered_at: new Date().toISOString() },
        exact_next_action: 'Marrow sent a one-tap approval link to the account owner (email, o…@example.test). https://api.getmarrow.ai/v1/approval-links/open#t=tok_secret_value',
      } });
    }
    if (route === `/v1/agent/gate-receipts/${RECEIPT}/owner-approval`) {
      const states = scenario.statuses || ['pending'];
      const entry = states[Math.min(statusIndex, states.length - 1)];
      statusIndex += 1;
      const view = typeof entry === 'string' ? { state: entry } : entry;
      if (view.state === 'http404') return Response.json({ error: 'Gate receipt not found.', details: { code: 'MARROW_GATE_RECEIPT_NOT_FOUND' } }, { status: 404 });
      const approved = view.state === 'approved';
      return Response.json({ data: { gate_receipt_id: RECEIPT, approval_source: approved ? 'one_tap' : null, approval_answered_by: approved || view.state === 'declined' ? 'account_owner' : null, poll_after_ms: 20, exact_next_action: 'Dashboard o…@example.test', ...view } });
    }
    if (route === `/v1/agent/gate-receipts/${RECEIPT}/host-approval`) {
      if (scenario.hostRefusal) return Response.json({ error: 'Host approval was not recorded.', code: 'CONFLICT', details: { code: scenario.hostRefusal, retryable: false } }, { status: 409 });
      return Response.json({ data: { host_approval: { verdict: body.verdict, answered_by: 'host_allow_rule', gate_receipt_id: RECEIPT, decision_id: DECISION }, replayed: false, evidence_recorded: true } });
    }
    if (route === '/v1/agent/commit') return Response.json({ data: { committed: true } });
    if (route === '/v1/agent/enforcement') {
      if (body.operation === 'issue') {
        if (scenario.permitRefused) return Response.json({ error: 'action_permit_owner_approval_scope_invalid' }, { status: 403 });
        return Response.json({ data: { permit: 'permit-token', permit_id: 'permit-1', protocol_version: 2 } });
      }
      if (body.operation === 'verify') return Response.json({ data: { verified: true } });
      return Response.json({ data: { closed: true } });
    }
    return Response.json({ data: {} });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-ha-runner-home-'));
  fs.chmodSync(home, 0o700);
  return home;
}

// One in-process run of the same held command. `home` keeps the hold record between runs.
async function runHeld(scenario, args = [], io = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-ha-run-'));
  // Runs that share a home run the same command (same marker path), so a rerun finds the hold.
  const marker = path.join(io.markerDir || io.home || dir, 'ran');
  if (fs.existsSync(marker)) fs.rmSync(marker);
  const ownHome = io.home ? null : freshHome();
  const api = fakeMarrow(scenario);
  let output = '';
  const sink = { write: (chunk) => { output += String(chunk); return true; }, isTTY: false };
  try {
    const parsed = runner.parseArgs([
      'run', '--key', io.key || `mrw_test_${crypto.randomBytes(12).toString('hex')}`, '--type', 'deploy', '--action', 'deploy production', ...args, '--',
      process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
    ]);
    const { markerDir: _markerDir, key: _key, ...execution } = io;
    const result = await runner.runGoverned(parsed, { stderr: sink, gateOutput: sink, approvalPollMs: 5, approvalRetryMs: 5, env: QUIET_ENV, processReader: () => null, home: io.home || ownHome, ...execution });
    return { result, calls: api.calls, ran: fs.existsSync(marker), output, parsed };
  } finally {
    api.restore();
    fs.rmSync(dir, { recursive: true, force: true });
    if (ownHome) fs.rmSync(ownHome, { recursive: true, force: true });
  }
}

const routeCalls = (calls, suffix) => calls.filter((call) => call.pathname.endsWith(suffix));
const sessionOf = (call) => call.headers['X-Marrow-Session-Id'];

function assertCleanOutput(output, result) {
  const text = `${output}\n${JSON.stringify(result)}`;
  for (const pattern of FORBIDDEN_OUTPUT) assert.doesNotMatch(text, pattern);
}

function recordFiles(home) {
  const directory = path.join(home, '.marrow', 'runner-holds');
  return fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => name.endsWith('.json')).map((name) => path.join(directory, name)) : [];
}

test('runner, nobody present: a held action holds quietly, sends nothing, and leaves an owner-only record without command text', async () => {
  const home = freshHome();
  const { result, calls, ran, output } = await runHeld({ runtime: holdRuntime() }, [], { home });
  assert.equal(ran, false);
  assert.equal(result.exitCode, 12);
  assert.match(result.message, /held until a person approves it, and nothing ran\. Rerun this command in an interactive terminal/);
  assert.equal(routeCalls(calls, '/approval-link').length, 0, 'no link without approval_link_available');
  assert.equal(routeCalls(calls, '/host-approval').length, 0, 'a non-interactive run never answers');
  assert.equal(routeCalls(calls, '/v1/agent/commit').length, 0, 'the decision stays open for the person');
  assert.equal(result.approval.state, 'held');
  const [file] = recordFiles(home);
  assert.ok(file);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(record.gate_receipt_id, RECEIPT);
  assert.equal(record.state, 'waiting');
  assert.equal(record.approvable_here, true);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /deploy production|writeFileSync|node/);
  assertCleanOutput(output, result);
  fs.rmSync(home, { recursive: true, force: true });
});

test('runner: a link goes out only where Marrow says it would be sent; a "not sent" answer is a quiet hold', async () => {
  const pinged = await runHeld({ runtime: holdRuntime({ ...LINKED, approval_link_reason: 'unattended_owner_ping', unattended_owner_ping: true }) });
  assert.equal(routeCalls(pinged.calls, '/approval-link').length, 1);
  assert.deepEqual(routeCalls(pinged.calls, '/approval-link')[0].body, { decision_id: DECISION });
  assert.equal(pinged.ran, false, 'without a terminal the runner does not wait by default');
  assert.equal(routeCalls(pinged.calls, '/owner-approval').length, 0);
  assert.match(pinged.output, /An approval link was sent to the account owner \(email\)\. It works once, until \d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(Object.keys(pinged.result.approval).sort(), ['channel', 'expires_at', 'gate_receipt_id', 'link_requests', 'source', 'state']);
  assertCleanOutput(pinged.output, pinged.result);

  const quiet = await runHeld({ runtime: holdRuntime({ ...LINKED, approval_link_reason: 'unattended_owner_ping' }), link: 'not_sent' });
  assert.equal(routeCalls(quiet.calls, '/approval-link').length, 1);
  assert.equal(quiet.ran, false);
  assert.equal(quiet.result.exitCode, 12);
  assert.match(quiet.result.message, /held until a person approves it/);
  assert.equal(quiet.result.approval.link, 'not_sent');
  assertCleanOutput(quiet.output, quiet.result);

  // A service before round 4 announces nothing: no link for an ordinary accepted hold.
  const older = holdRuntime({ approval_link_endpoint: `/v1/agent/gate-receipts/${RECEIPT}/approval-link` });
  delete older.completion_contract.owner_approval.approval_link_available;
  const olderRun = await runHeld({ runtime: older });
  assert.equal(routeCalls(olderRun.calls, '/approval-link').length, 0);
});

test('runner: an owner-locked hold asks the owner; with --approval-wait it waits and runs once approved, on the receipt', async () => {
  const { result, calls, ran, output } = await runHeld({ runtime: holdRuntime({ host_approval_accepted: false, host_approval_refusal_reason: 'verified_approval_required', ...LINKED }), statuses: ['pending', 'pending', 'approved'] }, ['--approval-wait', '5']);
  assert.equal(ran, true);
  assert.equal(result.exitCode, 0);
  assert.equal(routeCalls(calls, '/approval-link').length, 1);
  assert.equal(routeCalls(calls, '/host-approval').length, 0);
  assert.equal(calls.filter((call) => call.pathname === '/v1/agent/enforcement').length, 0, 'no permit for an approved ordinary hold');
  const commit = routeCalls(calls, '/v1/agent/commit')[0].body;
  assert.equal(commit.gate_receipt_id, RECEIPT);
  assert.equal(commit.decision_id, DECISION);
  assert.equal('owner_approval' in commit.proof, false);
  assert.equal(result.approval.approved_via, 'one_tap');
  assertCleanOutput(output, result);
});

test('runner: a rerun picks the hold up on the same receipt (no new receipt, no new email), and an approval that came later runs once', async () => {
  const home = freshHome();
  const first = await runHeld({ runtime: holdRuntime() }, [], { home });
  assert.equal(first.ran, false);
  const firstSession = sessionOf(routeCalls(first.calls, '/v1/agent/runtime')[0]);
  assert.match(firstSession, /^marrow-run-[a-f0-9]{24}$/);

  const stillWaiting = await runHeld({ runtime: holdRuntime(), statuses: ['pending'] }, [], { home });
  assert.equal(stillWaiting.ran, false);
  assert.equal(routeCalls(stillWaiting.calls, '/v1/agent/runtime').length, 0, 'no new receipt');
  assert.equal(routeCalls(stillWaiting.calls, '/approval-link').length, 0, 'no new email');
  assert.equal(sessionOf(routeCalls(stillWaiting.calls, '/owner-approval')[0]), firstSession);
  assert.match(stillWaiting.result.message, /held until a person approves it/);

  // The person approved it elsewhere after the runner stopped: the next run picks it up.
  const later = await runHeld({ runtime: holdRuntime(), statuses: [{ state: 'approved', approval_source: 'host_prompt', approval_answered_by: 'host_operator' }] }, [], { home });
  assert.equal(later.ran, true);
  assert.equal(routeCalls(later.calls, '/v1/agent/runtime').length, 0);
  const commit = routeCalls(later.calls, '/v1/agent/commit')[0];
  assert.equal(commit.body.gate_receipt_id, RECEIPT);
  assert.equal(commit.body.decision_id, DECISION);
  assert.equal(sessionOf(commit), firstSession, 'the commit uses the session the hold was made in');
  assert.equal(later.result.approval.resumed, true);
  assert.deepEqual(recordFiles(home), [], 'the spent hold is forgotten');

  // A receipt Marrow no longer knows (expired or used) is forgotten; the run asks again.
  const again = await runHeld({ runtime: holdRuntime() }, [], { home });
  assert.equal(again.ran, false);
  const stale = await runHeld({ runtime: holdRuntime(), statuses: ['expired'] }, [], { home });
  assert.equal(routeCalls(stale.calls, '/v1/agent/runtime').length, 1, 'a fresh gate after the old receipt expired');
  fs.rmSync(home, { recursive: true, force: true });
});

test('runner: one run per approval; an identical run already using it does not run', async () => {
  const home = freshHome();
  await runHeld({ runtime: holdRuntime() }, [], { home });
  const [file] = recordFiles(home);
  fs.writeFileSync(file.replace(/\.json$/, '.claim'), `${RECEIPT}\n`, { mode: 0o600 });
  const second = await runHeld({ runtime: holdRuntime(), statuses: ['approved'] }, [], { home });
  assert.equal(second.ran, false);
  assert.match(second.result.message, /An identical run is already using the approval/);
  assert.equal(routeCalls(second.calls, '/v1/agent/commit').length, 0);
  fs.rmSync(home, { recursive: true, force: true });
});

test('runner: the owner\'s decline stands across reruns; the owner is asked again only on request, in the decline\'s session', async () => {
  const home = freshHome();
  const owner = { host_approval_accepted: false, host_approval_refusal_reason: 'verified_approval_required', ...LINKED };
  const declined = await runHeld({ runtime: holdRuntime(owner), statuses: ['declined'] }, ['--approval-wait', '5'], { home });
  assert.equal(declined.ran, false);
  const denial = routeCalls(declined.calls, '/v1/agent/commit')[0].body;
  assert.match(denial.outcome, /^Denied by Marrow pre-action gate: the account owner declined\./);
  assert.equal(denial.gate_receipt_id, RECEIPT);
  assert.equal('proof' in denial, false, 'a gate denial report carries no proof');
  const declinedSession = sessionOf(routeCalls(declined.calls, '/v1/agent/runtime')[0]);

  const rerun = await runHeld({ runtime: holdRuntime(owner) }, [], { home });
  assert.equal(rerun.ran, false);
  assert.equal(rerun.calls.length, 0, 'no runtime call, no link: the decline stands');
  assert.match(rerun.result.message, /The account owner declined this action at .+ only the owner can reverse that\. Nothing ran\. To ask the owner with a one-tap approval link, rerun with --request-owner-link\./);

  const standing = { host_approval_accepted: false, host_approval_refusal_reason: 'owner_decline_stands', owner_declined_at: new Date().toISOString(), approval_link_available: true, approval_link_reason: 'owner_decline_stands', approval_link_endpoint: `/v1/agent/gate-receipts/${RECEIPT}/approval-link` };
  const asked = await runHeld({ runtime: holdRuntime(standing), statuses: ['approved'] }, ['--request-owner-link', '--approval-wait', '5'], { home });
  assert.equal(sessionOf(routeCalls(asked.calls, '/v1/agent/runtime')[0]), declinedSession);
  assert.equal(routeCalls(asked.calls, '/approval-link').length, 1);
  assert.equal(asked.ran, true);

  // Without a record, the backend's standing decline still asks nobody unless requested.
  const quiet = await runHeld({ runtime: holdRuntime(standing) });
  assert.equal(routeCalls(quiet.calls, '/approval-link').length, 0);
  assert.equal(quiet.ran, false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('runner, interactive terminal: y is reported as the operator\'s answer and runs; n is recorded and stands across reruns', async () => {
  const questions = [];
  const yes = await runHeld({ runtime: holdRuntime() }, [], { approvalPrompt: (question) => { questions.push(question); return 'y'; } });
  assert.equal(yes.ran, true);
  assert.equal(questions.length, 1);
  assert.match(questions[0], /Approve and run it now\? \[y\/N\] $/);
  const report = routeCalls(yes.calls, '/host-approval')[0].body;
  assert.deepEqual(Object.keys(report).sort(), ['answered_at', 'asked_at', 'decision_id', 'hook_event', 'host', 'host_session_id', 'verdict']);
  assert.equal(report.verdict, 'approved');
  assert.equal(report.host, 'other');
  assert.equal(report.hook_event, 'governed_runner_prompt');
  assert.equal(report.decision_id, DECISION);
  assert.equal(routeCalls(yes.calls, '/approval-link').length, 0);
  assert.equal(routeCalls(yes.calls, '/v1/agent/commit')[0].body.gate_receipt_id, RECEIPT);
  assert.equal(yes.result.approval.source, 'operator_prompt');
  assertCleanOutput(yes.output, yes.result);

  const home = freshHome();
  const no = await runHeld({ runtime: holdRuntime() }, [], { home, approvalPrompt: () => 'n' });
  assert.equal(no.ran, false);
  assert.equal(routeCalls(no.calls, '/host-approval')[0].body.verdict, 'declined');
  const denial = routeCalls(no.calls, '/v1/agent/commit')[0].body;
  assert.match(denial.outcome, /^Denied by Marrow pre-action gate: the operator declined in the governed runner\./);
  assert.equal('proof' in denial, false);
  const rerun = await runHeld({ runtime: holdRuntime() }, [], { home, approvalPrompt: () => 'y' });
  assert.equal(rerun.ran, false);
  assert.equal(rerun.calls.length, 0);
  assert.match(rerun.result.message, /You declined this action at .+ That answer stands until /);
  fs.rmSync(home, { recursive: true, force: true });
});

test('runner, interactive terminal: no answer records nothing, and the next run asks again on the same receipt', async () => {
  const home = freshHome();
  for (const answer of ['', 'maybe', 'yeah', 'yes please', null]) {
    const silent = await runHeld({ runtime: holdRuntime() }, [], { approvalPrompt: () => answer });
    assert.equal(silent.ran, false, String(answer));
    assert.equal(routeCalls(silent.calls, '/host-approval').length, 0, String(answer));
    assert.equal(routeCalls(silent.calls, '/approval-link').length, 0);
    assert.equal(routeCalls(silent.calls, '/v1/agent/commit').length, 0);
  }
  await runHeld({ runtime: holdRuntime() }, [], { home, approvalPrompt: () => '' });
  const asked = [];
  const second = await runHeld({ runtime: holdRuntime(), statuses: ['pending'] }, [], { home, approvalPrompt: (question) => { asked.push(question); return 'yes'; } });
  assert.equal(routeCalls(second.calls, '/v1/agent/runtime').length, 0);
  assert.equal(asked.length, 1);
  assert.equal(routeCalls(second.calls, '/host-approval')[0].body.verdict, 'approved');
  assert.equal(second.ran, true);
  fs.rmSync(home, { recursive: true, force: true });
});

test('runner: a decision-less hold reports the approval with the decision it records, and a decline without one', async () => {
  const runtime = holdRuntime();
  runtime.runtime_authorization = { id: RECEIPT, decision_state: 'not_created' };
  runtime.completion_contract.decision_state = 'not_created';
  delete runtime.completion_contract.decision_id;
  const yes = await runHeld({ runtime }, [], { approvalPrompt: () => 'y' });
  assert.equal(routeCalls(yes.calls, '/host-approval')[0].body.decision_id, 'dec_think_0001');
  const no = await runHeld({ runtime }, [], { approvalPrompt: () => 'n' });
  assert.equal('decision_id' in routeCalls(no.calls, '/host-approval')[0].body, false);
});

test('runner: owner-only holds never prompt the operator; an earlier operator decline holds quietly; unreadable state sends nothing', async () => {
  for (const guidance of [
    { host_approval_accepted: false, host_approval_refusal_reason: 'verified_approval_required', ...LINKED },
    { host_approval_accepted: true, host_approval_refusal_reason: 'verified_approval_required', ...LINKED },
  ]) {
    let prompted = 0;
    const held = await runHeld({ runtime: holdRuntime(guidance), statuses: ['approved'] }, [], { approvalPrompt: () => { prompted += 1; return 'y'; } });
    assert.equal(prompted, 0, JSON.stringify(guidance));
    assert.equal(routeCalls(held.calls, '/host-approval').length, 0);
    assert.equal(routeCalls(held.calls, '/approval-link').length, 1);
    assert.equal(held.ran, true, 'at a terminal the runner waits for the owner');
  }
  let prompted = 0;
  const earlier = await runHeld({ runtime: holdRuntime({ host_approval_operator_only: true, earlier_decline_at: '2026-10-05T07:00:00.000Z' }) }, [], { approvalPrompt: () => { prompted += 1; return 'y'; } });
  assert.equal(prompted, 0);
  assert.equal(earlier.ran, false);
  assert.equal(routeCalls(earlier.calls, '/approval-link').length, 0);
  assert.match(earlier.result.message, /You declined this action at 2026-10-05T07:00:00\.000Z, so it stays held/);

  const home = freshHome();
  const unavailable = await runHeld({ runtime: holdRuntime({ host_approval_accepted: false, host_approval_refusal_reason: 'approval_state_unavailable' }) }, [], { home, approvalPrompt: () => 'y' });
  assert.equal(unavailable.ran, false);
  assert.equal(routeCalls(unavailable.calls, '/approval-link').length + routeCalls(unavailable.calls, '/host-approval').length, 0);
  assert.deepEqual(recordFiles(home), [], 'no record: the next run asks Marrow again');
  fs.rmSync(home, { recursive: true, force: true });

  const refused = await runHeld({ runtime: holdRuntime(), hostRefusal: 'MARROW_VERIFIED_OWNER_APPROVAL_REQUIRED', statuses: ['approved'] }, [], { approvalPrompt: () => 'y' });
  assert.equal(routeCalls(refused.calls, '/host-approval').length, 1);
  assert.equal(routeCalls(refused.calls, '/approval-link').length, 1, 'refused at the terminal, the owner is asked');
  assert.equal(refused.ran, true);
});

test('runner: at most three link requests per run, retried only when Marrow says so', async () => {
  const owner = holdRuntime({ host_approval_accepted: false, host_approval_refusal_reason: 'verified_approval_required', ...LINKED });
  const undelivered = await runHeld({ runtime: owner, link: { error: 'MARROW_APPROVAL_LINK_UNDELIVERED', retryable: true } });
  assert.equal(routeCalls(undelivered.calls, '/approval-link').length, 3);
  assert.equal(undelivered.ran, false);
  assert.match(undelivered.result.message, /No approval link was sent: Marrow could not deliver it after 3 requests/);
  assertCleanOutput(undelivered.output, undelivered.result);
  const limited = await runHeld({ runtime: owner, link: { error: 'MARROW_APPROVAL_LINK_LIMITED', status: 429, retryable: false } });
  assert.equal(routeCalls(limited.calls, '/approval-link').length, 1);
  assert.match(limited.result.message, /enough approval links were already sent/);
  const flaky = await runHeld({ runtime: owner, statuses: ['approved'], link: (calls) => (routeCalls(calls, '/approval-link').length < 2 ? { error: 'MARROW_OWNER_APPROVAL_STATE_UNAVAILABLE', retryable: true } : null) }, ['--approval-wait', '5']);
  assert.equal(routeCalls(flaky.calls, '/approval-link').length, 2);
  assert.equal(flaky.ran, true);
  assert.equal(flaky.result.approval.link_requests, 2);
});

test('runner: an owner decline, an expired receipt and a wait limit stop the action', async () => {
  const owner = holdRuntime({ host_approval_accepted: false, host_approval_refusal_reason: 'verified_approval_required', ...LINKED });
  const expired = await runHeld({ runtime: owner, statuses: ['expired'] }, ['--approval-wait', '5']);
  assert.equal(expired.ran, false);
  assert.match(expired.result.message, /expired before it was approved/);
  assert.equal(routeCalls(expired.calls, '/v1/agent/commit').length, 0);
  const waited = await runHeld({ runtime: owner, statuses: ['pending'] }, ['--approval-wait', '1']);
  assert.equal(waited.ran, false);
  assert.match(waited.result.message, /Stopped waiting before the owner answered/);
});

test('runner: once a hold is decided nothing degrades into running it (decision creation fails)', async () => {
  const runtime = holdRuntime();
  runtime.risk_gate.risk_level = 'medium';
  runtime.gate_receipt.required = false;
  runtime.risk_gate.gate_required = false;
  runtime.runtime_authorization = { id: RECEIPT, decision_state: 'not_created' };
  runtime.completion_contract.decision_state = 'not_created';
  delete runtime.completion_contract.decision_id;
  for (const status of [500, 400]) {
    const run = await runHeld({ runtime, thinkFails: status }, ['--type', 'general', '--action', 'tidy notes', '--fail-open']);
    assert.equal(run.ran, false, String(status));
    assert.equal(run.result.blocked, true);
    assert.equal(run.result.exitCode, 13);
  }
});

test('runner: arbitration asks the owner by link, runs only with a permit for this exact action, and closes with both receipts', async () => {
  const approved = { state: 'approved', owner_approval_receipt_id: OWNER_RECEIPT, approval_source: 'one_tap', approval_answered_by: 'account_owner' };
  let prompted = 0;
  const run = await runHeld({ runtime: arbitrationRuntime(), statuses: ['arbitration_review', approved] }, [], { approvalPrompt: () => { prompted += 1; return 'y'; } });
  assert.equal(prompted, 0, 'arbitration is the owner\'s choice, never the terminal\'s');
  assert.equal(run.ran, true);
  assert.equal(routeCalls(run.calls, '/approval-link').length, 1);
  const issue = run.calls.find((call) => call.pathname === '/v1/agent/enforcement' && call.body.operation === 'issue').body;
  assert.equal(issue.owner_approval_receipt_id, OWNER_RECEIPT);
  assert.equal(issue.gate_receipt_id, RECEIPT);
  const commit = routeCalls(run.calls, '/v1/agent/commit')[0].body;
  assert.equal(commit.arbitration_receipt_id, ARBITRATION);
  assert.equal(commit.owner_approval_receipt_id, OWNER_RECEIPT);
  assert.equal(commit.gate_receipt_id, RECEIPT);
  assertCleanOutput(run.output, run.result);

  const other = await runHeld({ runtime: arbitrationRuntime(), statuses: [approved], permitRefused: true }, [], { approvalPrompt: () => 'y' });
  assert.equal(other.ran, false);
  assert.match(other.result.message, /the approved proposal is not this exact action/);

  const unattended = await runHeld({ runtime: arbitrationRuntime(), statuses: [approved] });
  assert.equal(routeCalls(unattended.calls, '/approval-link').length, 1, 'the arbitration link is owner-locked, sent even unattended');
  assert.equal(unattended.ran, false, 'without a terminal it holds after asking');

  const none = await runHeld({ runtime: arbitrationRuntime(), statuses: ['declined'] }, ['--approval-wait', '5']);
  assert.equal(none.ran, false);
  assert.match(routeCalls(none.calls, '/v1/agent/commit')[0].body.outcome, /approved none of the proposals/);
});

test('runner: an older Marrow service without terminal approvals holds and says so, with no prompt and no link', async () => {
  const legacy = holdRuntime();
  legacy.completion_contract.owner_approval = { mode: 'ordinary_non_arbitrated', dashboard_receipt_required: false, proof_path: null };
  let prompted = 0;
  const run = await runHeld({ runtime: legacy }, [], { approvalPrompt: () => { prompted += 1; return 'y'; } });
  assert.equal(prompted, 0);
  assert.equal(run.ran, false);
  assert.equal(run.result.exitCode, 12);
  assert.match(run.result.message, /This Marrow service does not take approvals from a terminal yet, so it stays held and nothing ran\./);
  assert.equal(run.calls.filter((call) => /approval-link|host-approval|owner-approval/.test(call.pathname)).length, 0);
  assertCleanOutput(run.output, run.result);
});

test('runner: who is at the terminal (agent hosts, CI, both streams), and option parsing', async () => {
  for (const env of [{ CLAUDECODE: '1' }, { GEMINI_CLI: '1' }, { CODEX_SANDBOX: 'seatbelt' }, { CURSOR_AGENT: '1' }, { CI: 'true' }]) {
    let prompted = 0;
    const run = await runHeld({ runtime: holdRuntime() }, [], { env, approvalPrompt: () => { prompted += 1; return 'y'; } });
    assert.equal(prompted, 0, JSON.stringify(env));
    assert.equal(run.ran, false);
    assert.equal(routeCalls(run.calls, '/host-approval').length, 0);
  }
  // An agent process above the runner (process ancestry).
  const table = { 300: { ppid: 200, args: ['/bin/bash'] }, 200: { ppid: 100, args: ['node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js'] } };
  assert.equal(runner.agentHostAncestor((pid) => table[pid] || null, 300), true);
  assert.equal(runner.agentHostAncestor((pid) => ({ 300: { ppid: 1, args: ['/bin/bash'] } })[pid] || null, 300), false);
  assert.equal(runner.agentHostDetected({}, () => null), false);
  assert.equal(runner.agentHostDetected({ CLAUDECODE: '0' }, () => null), false);
  // A real terminal needs both stdin and stderr to be terminals.
  assert.equal(runner.approvalPromptAvailable({}, { env: {}, processReader: () => null, stdin: { isTTY: true }, stderr: { isTTY: false } }), false);
  assert.equal(runner.approvalPromptAvailable({}, { env: {}, processReader: () => null, stdin: { isTTY: false }, stderr: { isTTY: true } }), false);
  assert.equal(runner.approvalPromptAvailable({}, { env: {}, processReader: () => null, stdin: { isTTY: true }, stderr: { isTTY: true } }), true);
  assert.equal(runner.approvalPromptAvailable({ interactive: false }, { env: {}, processReader: () => null, stdin: { isTTY: true }, stderr: { isTTY: true } }), false);

  // A prompt nobody answers is never a yes.
  const { PassThrough } = require('node:stream');
  const input = new PassThrough();
  input.isTTY = true;
  const stderrText = [];
  const stderr = { isTTY: true, write: (chunk) => { stderrText.push(String(chunk)); return true; }, on() {}, once() {}, removeListener() {}, columns: 80 };
  const timedOut = await runHeld({ runtime: holdRuntime() }, [], { stdin: input, stderr, promptTimeoutMs: 50 });
  assert.equal(timedOut.ran, false);
  assert.equal(routeCalls(timedOut.calls, '/host-approval').length, 0);
  assert.match(timedOut.result.message, /No answer was given/);

  const parsed = runner.parseArgs(['run', '--owner-approved', '--json', '--', 'true']);
  assert.equal(parsed.options.json, true, '--owner-approved never swallows the next flag');
  assert.equal(parsed.options.ownerApprovedFlagIgnored, true);
  assert.deepEqual(runner.parseArgs(['run', '--owner-approved', '--', 'true']).childCommand, ['true']);
  assert.throws(() => runner.parseArgs(['run', '--approval-wait', '-1', '--', 'true']));
  assert.throws(() => runner.parseArgs(['run', '--approval-wait', '3601', '--', 'true']));

  // The default session: stable for one agent, project, user and service per day.
  const a = runner.defaultRunnerSession({ agentId: 'agent-a', baseUrl: 'https://api.getmarrow.ai' }, new Date('2026-10-06T08:00:00Z'));
  assert.equal(a, runner.defaultRunnerSession({ agentId: 'agent-a', baseUrl: 'https://api.getmarrow.ai/' }, new Date('2026-10-06T23:00:00Z')));
  assert.notEqual(a, runner.defaultRunnerSession({ agentId: 'agent-b', baseUrl: 'https://api.getmarrow.ai' }, new Date('2026-10-06T08:00:00Z')));
  assert.notEqual(a, runner.defaultRunnerSession({ agentId: 'agent-a', baseUrl: 'https://api.getmarrow.ai' }, new Date('2026-10-07T08:00:00Z')));
  assert.match(a, /^marrow-run-[a-f0-9]{24}$/);
  assert.equal(runner.parseArgs(['run', '--session', 'mine', '--', 'true']).options.sessionId, 'mine');
});

test('runner: --owner-approved is accepted and inert; a caller-written proof.owner_approval is dropped', async () => {
  const held = await runHeld({ runtime: holdRuntime(), statuses: ['pending'] }, ['--owner-approved', 'buu-ok']);
  assert.equal(held.ran, false, 'the flag no longer unblocks a hold');
  const allowUnset = holdRuntime();
  delete allowUnset.risk_gate.allow;
  const reached = await runHeld({ runtime: allowUnset }, ['--owner-approved', 'buu-ok']);
  assert.equal(reached.ran, false);
  assert.equal(reached.calls.filter((call) => call.pathname === '/v1/agent/enforcement').length, 0);
  const decision = runner.gateDecision(allowUnset);
  for (const flag of [{ ownerApprovedFlagIgnored: true }, { ownerApproval: 'ref' }]) {
    assert.equal(runner.shouldBlock(decision, { policy: 'enforce', ...flag }), true, JSON.stringify(flag));
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-ha-proof-'));
  try {
    const proofFile = path.join(dir, 'proof.json');
    fs.writeFileSync(proofFile, JSON.stringify({ summary: 'done', checks: ['smoke'], owner_approval: { approved_by: 'owner', reference: 'self-asserted' } }));
    const allowed = {
      risk_gate: { decision: 'allow', enforced: true, allow: true, gate_required: true, risk_level: 'high' },
      gate_receipt: { id: 'gr_allow_1', required: true, decision: 'allow' },
      runtime_authorization: { id: 'gr_allow_1', decision_id: 'dec_allow_1', decision_state: 'created' },
    };
    const run = await runHeld({ runtime: allowed }, ['--owner-approved', 'buu-ok', '--proof-file', proofFile]);
    assert.equal(run.ran, true);
    const issue = run.calls.find((call) => call.pathname === '/v1/agent/enforcement' && call.body.operation === 'issue').body;
    assert.equal(issue.owner_approval_receipt_id, null);
    const commit = routeCalls(run.calls, '/v1/agent/commit')[0].body;
    assert.equal('owner_approval' in commit.proof, false);
    assert.deepEqual(commit.proof.checks, ['smoke']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const noticeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-ha-notice-'));
  const notice = spawnSync(process.execPath, [BIN, 'gate', '--owner-approved', 'x', '--action', 'read status'], { env: { PATH: process.env.PATH, HOME: noticeHome }, encoding: 'utf8' });
  fs.rmSync(noticeHome, { recursive: true, force: true });
  assert.match(notice.stderr, /Note: --owner-approved no longer does anything\. Approvals happen in the host's own prompt, at this runner's terminal prompt, or through the one-tap link Marrow sends the account owner\./);
});

// A loopback Marrow for real CLI processes.
async function withServer(handler, fn) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ method: req.method, url: req.url, body, session: req.headers['x-marrow-session-id'] });
    const reply = handler(req.url, body, seen);
    res.writeHead(reply.status || 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.json));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, seen);
  } finally {
    server.close();
  }
}

function runCli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let stdout = '';
    child.stdout.on('data', (chunk) => { output += chunk; stdout += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => resolve({ code, output, stdout }));
  });
}

test('runner CLI without a terminal: real processes hold quietly, pick the hold up on rerun, never prompt, and print no link, token or address', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-ha-cli-'));
  fs.chmodSync(dir, 0o700);
  const key = `mrw_test_${crypto.randomBytes(16).toString('hex')}`;
  let approvedNow = false;
  try {
    await withServer((url) => {
      if (url === '/v1/agent/runtime') return { json: { data: holdRuntime() } };
      if (url === `/v1/agent/gate-receipts/${RECEIPT}/owner-approval`) return { json: { data: { state: approvedNow ? 'approved' : 'pending', approval_source: 'host_prompt', approval_answered_by: 'host_operator', poll_after_ms: 1000, exact_next_action: 'see https://example.test o…@example.test' } } };
      if (url === '/v1/agent/commit') return { json: { data: { committed: true } } };
      return { json: { data: {} } };
    }, async (baseUrl, seen) => {
      const marker = path.join(dir, 'ran');
      const env = { PATH: process.env.PATH, HOME: dir, MARROW_API_KEY: key, MARROW_BASE_URL: baseUrl };
      const args = ['run', '--type', 'deploy', '--action', 'deploy production', '--', process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`];
      const first = await runCli(args, env);
      assert.equal(first.code, 12, first.output);
      assert.equal(fs.existsSync(marker), false);
      assert.match(first.output, /held until a person approves it/);
      assert.doesNotMatch(first.output, /\[y\/N\]/);
      const second = await runCli(args, env);
      assert.equal(second.code, 12);
      assert.equal(seen.filter((call) => call.url === '/v1/agent/runtime').length, 1, 'the rerun made no new receipt');
      approvedNow = true;
      const third = await runCli(args, env);
      assert.equal(third.code, 0, third.output);
      assert.equal(fs.existsSync(marker), true);
      assert.equal(seen.filter((call) => call.url === '/v1/agent/runtime').length, 1);
      const sessions = new Set(seen.map((call) => call.session));
      assert.equal(sessions.size, 1, 'every call used the session the hold was made in');
      assert.equal(seen.some((call) => call.url.endsWith('/host-approval') || call.url.endsWith('/approval-link')), false);
      for (const run of [first, second, third]) {
        assert.equal(run.output.includes(key), false);
        for (const pattern of FORBIDDEN_OUTPUT) assert.doesNotMatch(run.output, pattern);
      }
    });
    // `gate` shows the runner's own text for a hold, never the served text.
    await withServer((url) => (url === '/v1/agent/runtime' ? { json: { data: holdRuntime() } } : { json: { data: {} } }), async (baseUrl) => {
      const gate = await runCli(['gate', '--type', 'deploy', '--action', 'deploy production'], { PATH: process.env.PATH, HOME: dir, MARROW_API_KEY: key, MARROW_BASE_URL: baseUrl });
      assert.equal(gate.code, 12);
      assert.match(gate.stdout, /Next: Marrow holds this action until a person approves it \(gate receipt gr_hold_0001\)\. Run it with npx @getmarrow\/install run in an interactive terminal/);
      for (const pattern of FORBIDDEN_OUTPUT) assert.doesNotMatch(gate.output, pattern);
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

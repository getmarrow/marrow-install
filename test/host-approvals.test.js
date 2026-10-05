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

test('Cursor: ask only on shell and MCP execution hooks with failClosed, typed-reply and session hooks, shell and MCP out of preToolUse', () => {
  const ws = workspace('marrow-ha-cursor-');
  try {
    fs.mkdirSync(path.join(ws.root, '.cursor'));
    install(ws);
    const settings = readJson(path.join(ws.root, '.cursor', 'hooks.json'));
    assert.equal(settings.version, 1);
    const marrow = (event) => (settings.hooks[event] || []).filter((entry) => isMarrowCommand(entry.command));
    assert.deepEqual(marrow('preToolUse'), [{ command: cmd('cursor-pre-action-hook'), matcher: installer.CURSOR_PRE_TOOL_USE_HOST_APPROVAL_MATCHER, timeout: 5, failClosed: true, async: false }]);
    for (const event of ['beforeShellExecution', 'beforeMCPExecution']) {
      assert.deepEqual(marrow(event), [{ command: cmd('cursor-pre-action-hook'), timeout: 5, failClosed: true, async: false }], event);
    }
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
    for (const tool of ['Shell', 'MCP:deploy', 'MCP:github:create_pr']) assert.equal(preToolUse.test(tool), false, tool);
    for (const tool of ['Write', 'Delete', 'Task', 'Read', 'Grep']) assert.equal(preToolUse.test(tool), true, tool);
    assert.doesNotMatch(JSON.stringify(settings), /"ask"|permission/);
  } finally {
    ws.cleanup();
  }
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
const FORBIDDEN_OUTPUT = [/dashboard/i, /log ?in/i, /@example\.test/, /o…@/, /approval-links\/open/, /#t=/, /https?:\/\//, /tok_secret_/];

function holdRuntime(guidance = {}, extra = {}) {
  return {
    risk_gate: { decision: 'review_required', enforced: true, allow: false, gate_required: true, risk_level: 'high', owner_approval_required: true },
    gate_receipt: { id: RECEIPT, required: true, decision: 'review_required', owner_approval_required: true },
    runtime_authorization: { id: RECEIPT, decision_id: DECISION, decision_state: 'created' },
    completion_contract: {
      decision_state: 'created',
      decision_id: DECISION,
      gate_receipt_id: RECEIPT,
      owner_approval_required: true,
      owner_approval: {
        mode: 'ordinary_non_arbitrated',
        approval_status_poll_after_ms: 20,
        host_approval_accepted: true,
        host_approval_refusal_reason: null,
        host_approval_operator_only: false,
        owner_declined_at: null,
        operator_notice: null,
        ...guidance,
      },
    },
    // Agent-directed served text: never relayed by the runner.
    exact_next_action: `Obtain the account owner's approval: POST /v1/agent/gate-receipts/${RECEIPT}/approval-link (sent to o…@example.test). Or log in to the dashboard.`,
    ...extra,
  };
}

// A fake Marrow API: runtime, link, status, host report, commit, think and permits.
function fakeMarrow(scenario) {
  const calls = [];
  let statusIndex = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const parsed = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method: init.method || 'GET', pathname: parsed.pathname, body, headers: init.headers });
    const route = parsed.pathname;
    if (route === '/v1/agent/runtime') return Response.json({ data: scenario.runtime });
    if (route === '/v1/agent/think') return Response.json({ data: { decision_id: 'dec_think_0001' } });
    if (route === `/v1/agent/gate-receipts/${RECEIPT}/approval-link`) {
      const reply = typeof scenario.link === 'function' ? scenario.link(calls) : scenario.link;
      if (reply?.error) return Response.json({ error: 'No approval link was sent.', code: 'CONFLICT', details: { code: reply.error, retryable: reply.retryable === true, exact_next_action: 'Retry. Owner o…@example.test.' } }, { status: reply.status || 409 });
      return Response.json({ data: {
        approval_link: { id: 'link_1', gate_receipt_id: RECEIPT, channel: 'email', recipient_hint: 'o…@example.test', expires_at: new Date(Date.now() + 600_000).toISOString(), delivered_at: new Date().toISOString() },
        exact_next_action: 'Marrow sent a one-tap approval link to the account owner (email, o…@example.test). https://api.getmarrow.ai/v1/approval-links/open#t=tok_secret_value',
      } });
    }
    if (route === `/v1/agent/gate-receipts/${RECEIPT}/owner-approval`) {
      const states = scenario.statuses || ['pending'];
      const state = states[Math.min(statusIndex, states.length - 1)];
      statusIndex += 1;
      return Response.json({ data: { gate_receipt_id: RECEIPT, state, approval_source: state === 'approved' ? 'one_tap' : null, approval_answered_by: state === 'approved' ? 'account_owner' : null, poll_after_ms: 20, exact_next_action: 'Dashboard o…@example.test' } });
    }
    if (route === `/v1/agent/gate-receipts/${RECEIPT}/host-approval`) {
      if (scenario.hostRefusal) return Response.json({ error: 'Host approval was not recorded.', code: 'CONFLICT', details: { code: scenario.hostRefusal, retryable: false } }, { status: 409 });
      return Response.json({ data: { host_approval: { verdict: body.verdict, answered_by: 'host_allow_rule', gate_receipt_id: RECEIPT, decision_id: DECISION }, replayed: false, evidence_recorded: true } });
    }
    if (route === '/v1/agent/commit') return Response.json({ data: { committed: true } });
    if (route === '/v1/agent/enforcement') {
      if (body.operation === 'issue') return Response.json({ data: { permit: 'permit-token', permit_id: 'permit-1', protocol_version: 2 } });
      if (body.operation === 'verify') return Response.json({ data: { verified: true } });
      return Response.json({ data: { closed: true } });
    }
    return Response.json({ data: {} });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

async function runHeld(scenario, args = [], io = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-ha-run-'));
  const marker = path.join(dir, 'ran');
  const api = fakeMarrow(scenario);
  let output = '';
  const sink = { write: (chunk) => { output += String(chunk); return true; }, isTTY: false };
  try {
    const parsed = runner.parseArgs([
      'run', '--key', `mrw_test_${crypto.randomBytes(12).toString('hex')}`, '--type', 'deploy', '--action', 'deploy production', ...args, '--',
      process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
    ]);
    const result = await runner.runGoverned(parsed, { stderr: sink, gateOutput: sink, approvalPollMs: 5, approvalRetryMs: 5, ...io });
    return { result, calls: api.calls, ran: fs.existsSync(marker), output };
  } finally {
    api.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const routeCalls = (calls, suffix) => calls.filter((call) => call.pathname.endsWith(suffix));

function assertCleanOutput(output, result) {
  const text = `${output}\n${JSON.stringify(result)}`;
  for (const pattern of FORBIDDEN_OUTPUT) assert.doesNotMatch(text, pattern);
}

test('runner, non-interactive: asks the owner by one-tap link, waits on the status, runs once approved, and never answers itself', async () => {
  const { result, calls, ran, output } = await runHeld({ runtime: holdRuntime(), statuses: ['pending', 'pending', 'approved'] });
  assert.equal(ran, true);
  assert.equal(result.exitCode, 0);
  const links = routeCalls(calls, '/approval-link');
  assert.equal(links.length, 1);
  assert.deepEqual(links[0].body, { decision_id: DECISION });
  assert.equal(routeCalls(calls, '/host-approval').length, 0, 'a non-interactive run never reports an approval');
  assert.ok(routeCalls(calls, '/owner-approval').length >= 3);
  assert.equal(calls.filter((call) => call.pathname === '/v1/agent/enforcement').length, 0, 'no permit for a held receipt');
  const commit = routeCalls(calls, '/v1/agent/commit')[0].body;
  assert.equal(commit.gate_receipt_id, RECEIPT);
  assert.equal(commit.decision_id, DECISION);
  assert.equal(commit.success, true);
  assert.equal('owner_approval' in commit.proof, false);
  assert.deepEqual(Object.keys(result.approval).sort(), ['answered_by', 'approved_via', 'channel', 'expires_at', 'gate_receipt_id', 'link_requests', 'source', 'state']);
  assert.equal(result.approval.channel, 'email');
  assert.match(output, /An approval link was sent to the account owner \(email\)\. It works once, until \d{4}-\d{2}-\d{2}T/);
  assertCleanOutput(output, result);
});

test('runner: an owner decline, an expired receipt, and a wait limit all stop the action', async () => {
  const declined = await runHeld({ runtime: holdRuntime(), statuses: ['pending', 'declined'] });
  assert.equal(declined.ran, false);
  assert.equal(declined.result.exitCode, 12);
  const denial = routeCalls(declined.calls, '/v1/agent/commit')[0].body;
  assert.equal(denial.success, false);
  assert.match(denial.outcome, /^Denied by Marrow pre-action gate: the account owner declined\./);
  assert.equal(denial.gate_receipt_id, RECEIPT);
  assert.equal('proof' in denial, false, 'a gate denial report carries no proof');
  assertCleanOutput(declined.output, declined.result);

  const expired = await runHeld({ runtime: holdRuntime(), statuses: ['expired'] });
  assert.equal(expired.ran, false);
  assert.equal(expired.result.exitCode, 12);
  assert.match(expired.result.message, /expired before it was approved/);
  assert.equal(routeCalls(expired.calls, '/v1/agent/commit').length, 0);

  const waited = await runHeld({ runtime: holdRuntime(), statuses: ['pending'] }, ['--approval-wait', '1']);
  assert.equal(waited.ran, false);
  assert.match(waited.result.message, /Stopped waiting before the owner answered/);
  const noWait = await runHeld({ runtime: holdRuntime(), statuses: ['approved'] }, ['--approval-wait', '0']);
  assert.equal(noWait.ran, false);
  assert.equal(routeCalls(noWait.calls, '/owner-approval').length, 0);
});

test('runner: at most three link requests per run, retried only when Marrow says so', async () => {
  const undelivered = await runHeld({ runtime: holdRuntime(), link: { error: 'MARROW_APPROVAL_LINK_UNDELIVERED', retryable: true } });
  assert.equal(routeCalls(undelivered.calls, '/approval-link').length, 3);
  assert.equal(undelivered.ran, false);
  assert.match(undelivered.result.message, /No approval link was sent: Marrow could not deliver it after 3 requests/);
  assertCleanOutput(undelivered.output, undelivered.result);
  const limited = await runHeld({ runtime: holdRuntime(), link: { error: 'MARROW_APPROVAL_LINK_LIMITED', status: 429, retryable: false } });
  assert.equal(routeCalls(limited.calls, '/approval-link').length, 1);
  assert.match(limited.result.message, /enough approval links were already sent/);
  const noChannel = await runHeld({ runtime: holdRuntime(), link: { error: 'MARROW_APPROVAL_CHANNEL_UNAVAILABLE' } });
  assert.equal(routeCalls(noChannel.calls, '/approval-link').length, 1);
  assertCleanOutput(noChannel.output, noChannel.result);
  const flaky = await runHeld({ runtime: holdRuntime(), statuses: ['approved'], link: (calls) => (routeCalls(calls, '/approval-link').length < 2 ? { error: 'MARROW_OWNER_APPROVAL_STATE_UNAVAILABLE', retryable: true } : null) });
  assert.equal(routeCalls(flaky.calls, '/approval-link').length, 2);
  assert.equal(flaky.ran, true);
  assert.equal(flaky.result.approval.link_requests, 2);
});

test('runner, interactive terminal: a typed y is reported as the operator\'s answer, then it runs and closes on the receipt', async () => {
  const questions = [];
  const { result, calls, ran, output } = await runHeld({ runtime: holdRuntime() }, [], {
    approvalPrompt: (question) => { questions.push(question); return 'y'; },
  });
  assert.equal(ran, true);
  assert.equal(questions.length, 1);
  assert.match(questions[0], /Approve and run it now\? \[y\/N\] $/);
  const reports = routeCalls(calls, '/host-approval');
  assert.equal(reports.length, 1);
  const report = reports[0].body;
  assert.deepEqual(Object.keys(report).sort(), ['answered_at', 'asked_at', 'decision_id', 'hook_event', 'host', 'host_session_id', 'verdict']);
  assert.equal(report.verdict, 'approved');
  assert.equal(report.host, 'other');
  assert.equal(report.hook_event, 'governed_runner_prompt');
  assert.equal(report.decision_id, DECISION);
  assert.ok(Date.parse(report.asked_at) <= Date.parse(report.answered_at));
  assert.equal(routeCalls(calls, '/approval-link').length, 0);
  assert.equal(routeCalls(calls, '/v1/agent/commit')[0].body.gate_receipt_id, RECEIPT);
  assert.equal(result.approval.source, 'operator_prompt');
  assertCleanOutput(output, result);
});

test('runner, interactive terminal: n records a decline and a denial; no answer records nothing', async () => {
  const declined = await runHeld({ runtime: holdRuntime() }, [], { approvalPrompt: () => 'n' });
  assert.equal(declined.ran, false);
  assert.equal(declined.result.exitCode, 12);
  assert.equal(routeCalls(declined.calls, '/host-approval')[0].body.verdict, 'declined');
  const denial = routeCalls(declined.calls, '/v1/agent/commit')[0].body;
  assert.match(denial.outcome, /^Denied by Marrow pre-action gate: the operator declined in the governed runner\./);
  assert.equal(denial.success, false);
  assert.equal('proof' in denial, false);
  assert.equal(denial.gate_receipt_id, RECEIPT);
  for (const answer of ['', 'maybe', null]) {
    const silent = await runHeld({ runtime: holdRuntime() }, [], { approvalPrompt: () => answer });
    assert.equal(silent.ran, false);
    assert.equal(routeCalls(silent.calls, '/host-approval').length, 0);
    assert.equal(routeCalls(silent.calls, '/approval-link').length, 0);
    assert.equal(routeCalls(silent.calls, '/v1/agent/commit').length, 0);
  }
});

test('runner: owner-only holds never prompt the operator; a standing owner decline asks the owner only on request', async () => {
  for (const guidance of [
    { host_approval_accepted: false, host_approval_refusal_reason: 'verified_approval_required' },
    { host_approval_operator_only: true, earlier_decline_at: '2026-10-05T07:00:00.000Z' },
  ]) {
    let prompted = 0;
    const held = await runHeld({ runtime: holdRuntime(guidance), statuses: ['approved'] }, [], { approvalPrompt: () => { prompted += 1; return 'y'; } });
    assert.equal(prompted, 0, JSON.stringify(guidance));
    assert.equal(routeCalls(held.calls, '/host-approval').length, 0);
    assert.equal(routeCalls(held.calls, '/approval-link').length, 1);
    assert.equal(held.ran, true);
  }
  const standing = { host_approval_accepted: false, host_approval_refusal_reason: 'owner_decline_stands', owner_declined_at: '2026-10-05T07:00:00.000Z' };
  const quiet = await runHeld({ runtime: holdRuntime(standing), statuses: ['approved'] });
  assert.equal(quiet.ran, false);
  assert.equal(routeCalls(quiet.calls, '/approval-link').length, 0);
  assert.match(quiet.result.message, /only the owner can reverse that\. To ask the owner with a one-tap approval link, rerun with --request-owner-link/);
  const asked = await runHeld({ runtime: holdRuntime(standing), statuses: ['approved'] }, ['--request-owner-link']);
  assert.equal(routeCalls(asked.calls, '/approval-link').length, 1);
  assert.equal(asked.ran, true);
  const unavailable = await runHeld({ runtime: holdRuntime({ host_approval_accepted: false, host_approval_refusal_reason: 'approval_state_unavailable' }) }, [], { approvalPrompt: () => 'y' });
  assert.equal(unavailable.ran, false);
  assert.equal(routeCalls(unavailable.calls, '/approval-link').length + routeCalls(unavailable.calls, '/host-approval').length, 0);
  const refused = await runHeld({ runtime: holdRuntime(), hostRefusal: 'MARROW_VERIFIED_OWNER_APPROVAL_REQUIRED', statuses: ['approved'] }, [], { approvalPrompt: () => 'y' });
  assert.equal(routeCalls(refused.calls, '/host-approval').length, 1);
  assert.equal(routeCalls(refused.calls, '/approval-link').length, 1, 'refused at the terminal, the owner is asked');
  assert.equal(refused.ran, true);
});

test('runner: --owner-approved is accepted and inert; a caller-written proof.owner_approval is dropped', async () => {
  const held = await runHeld({ runtime: holdRuntime(), statuses: ['pending'] }, ['--owner-approved', 'buu-ok', '--approval-wait', '0']);
  assert.equal(held.ran, false, 'the flag no longer unblocks a hold');
  assert.equal(routeCalls(held.calls, '/approval-link').length, 1);
  // A hold whose gate does not say allow:false reaches the approval check itself.
  const allowUnset = holdRuntime();
  delete allowUnset.risk_gate.allow;
  const reached = await runHeld({ runtime: allowUnset, statuses: ['pending'] }, ['--owner-approved', 'buu-ok', '--approval-wait', '0']);
  assert.equal(reached.ran, false);
  assert.equal(reached.calls.filter((call) => call.pathname === '/v1/agent/enforcement').length, 0);
  const decision = runner.gateDecision(allowUnset);
  for (const flag of [{ ownerApprovedFlagIgnored: true }, { ownerApproval: 'ref' }]) {
    assert.equal(runner.shouldBlock(decision, { policy: 'enforce', ...flag }), true, JSON.stringify(flag));
  }
  const parsed = runner.parseArgs(['run', '--owner-approved', 'ref', '--', 'true']);
  assert.equal(parsed.options.ownerApprovedFlagIgnored, true);
  assert.equal('ownerApproval' in parsed.options, false);
  assert.deepEqual(runner.parseArgs(['run', '--owner-approved', '--', 'true']).childCommand, ['true']);

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

test('runner: arbitration holds and the gate command name no dashboard step', async () => {
  const arbitration = holdRuntime({}, {});
  arbitration.completion_contract.owner_approval = { mode: 'arbitration_review_required', dashboard_receipt_required: true };
  const held = await runHeld({ runtime: arbitration });
  assert.equal(held.ran, false);
  assert.match(held.result.message, /arbitration review/);
  assert.equal(routeCalls(held.calls, '/approval-link').length, 0);
  assertCleanOutput(held.output, held.result);
  const api = fakeMarrow({ runtime: holdRuntime() });
  try {
    const gate = await runner.gateOnly(runner.parseArgs(['gate', '--key', 'k_dummy', '--action', 'deploy production']));
    assert.equal(gate.exitCode, 12);
    assertCleanOutput('', gate);
    assert.match(gate.message, /Run it with npx @getmarrow\/install run in an interactive terminal/);
    assert.equal(gate.decision.exactNextAction, gate.message);
  } finally {
    api.restore();
  }
});

test('runner CLI without a terminal: real process, never prompts, output carries no link, token or address', async () => {
  const seen = [];
  let statusReads = 0;
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null;
    seen.push({ method: req.method, url: req.url, body });
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.url === '/v1/agent/runtime') return send(200, { data: holdRuntime() });
    if (req.url === `/v1/agent/gate-receipts/${RECEIPT}/approval-link`) {
      return send(200, { data: { approval_link: { channel: 'email', recipient_hint: 'o…@example.test', expires_at: new Date(Date.now() + 60_000).toISOString() }, exact_next_action: 'sent to o…@example.test https://api.getmarrow.ai/v1/approval-links/open#t=tok_secret_value' } });
    }
    if (req.url === `/v1/agent/gate-receipts/${RECEIPT}/owner-approval`) {
      statusReads += 1;
      return send(200, { data: { state: statusReads < 2 ? 'pending' : 'approved', approval_source: 'one_tap', poll_after_ms: 1000 } });
    }
    if (req.url === '/v1/agent/commit') return send(200, { data: { committed: true } });
    return send(200, { data: {} });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-ha-cli-'));
  const key = `mrw_test_${crypto.randomBytes(16).toString('hex')}`;
  try {
    const marker = path.join(dir, 'ran');
    const child = spawn(process.execPath, [BIN, 'run', '--type', 'deploy', '--action', 'deploy production', '--', process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], {
      env: { PATH: process.env.PATH, HOME: dir, MARROW_API_KEY: key, MARROW_BASE_URL: `http://127.0.0.1:${server.address().port}` },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0, output);
    assert.equal(fs.existsSync(marker), true);
    assert.equal(seen.some((call) => call.url.endsWith('/host-approval')), false);
    assert.equal(seen.filter((call) => call.url.endsWith('/approval-link')).length, 1);
    assert.doesNotMatch(output, /\[y\/N\]/);
    assert.equal(output.includes(key), false);
    for (const pattern of FORBIDDEN_OUTPUT) assert.doesNotMatch(output, pattern);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

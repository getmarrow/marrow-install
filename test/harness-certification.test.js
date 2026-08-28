const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  HARNESS_CAPABILITY_REGISTRY,
  activationProfile,
  applyPlan,
  buildPlan,
  claudeNativeHookFingerprint,
  codexNativeHookFingerprint,
  defaultHarnessInstallMatrix,
  detectEnvironment,
  firstCapturePath,
  harnessReloadPlan,
  inspectSdkDependency,
} = require('../src/installer');

const NATIVE_HOOK_MATCHER = 'Bash|Edit|Write|MultiEdit|mcp__(?!marrow_).*';
const CODEX_NATIVE_HOOK_MATCHER = 'Bash|apply_patch|Edit|Write|MultiEdit|mcp__(?!marrow__marrow_).*|functions\\.(?!marrow_).*';
const MCP_ACTION_RESULT_HOOK_COMMAND = 'npx -y --package=@getmarrow/mcp@3.9.75 marrow-mcp hook';
const SDK_INTEGRITY = 'sha512-n1i6Be09TpAQ9BPNRKY7aCvA2iSUPpJfw8djw2MELwpNbBCtKiZ29Jji77BK/6EFLUpSIcTW/Gmdf/ccf0JRYQ==';

function writeSdkLock(root, declaredSpec = '^3.7.62') {
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
    name: 'fixture',
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { '@getmarrow/sdk': declaredSpec } },
      'node_modules/@getmarrow/sdk': {
        version: '3.7.62',
        resolved: 'https://registry.npmjs.org/@getmarrow/sdk/-/sdk-3.7.62.tgz',
        integrity: SDK_INTEGRITY,
      },
    },
  }));
}

test('default auto install uses MCP plus SDK passive runtime on Node workspaces', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-default-passive-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    const detection = detectEnvironment(root, { ...process.env, HOME: root });
    const plan = buildPlan(detection, { mode: 'auto' });
    assert.equal(plan.mode, 'both');
    assert.ok(plan.writes.some((item) => item.label === 'SDK passive runtime preload'));
    assert.ok(plan.writes.some((item) => item.label === 'Project MCP server config'));
    assert.ok(plan.writes.some((item) => item.label === 'Agent instructions'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('activate writes require a harness reload and do not claim this process is live', () => {
  const detection = { node: true, claudeCode: false, cursor: false, codex: true };
  const plan = harnessReloadPlan(detection, [
    { label: 'Project MCP server config', applied: true, changed: true },
    { label: 'Agent instructions', applied: true, changed: true },
  ]);
  assert.equal(plan.required, true);
  assert.equal(plan.live_in_this_process, false);
  assert.match(plan.instruction, /review the repository hooks with \/hooks/);
  assert.match(plan.prove_command, /doctor --self-test/);
});

test('Cursor first capture is on-demand MCP runtime, not native hooks', () => {
  const capture = firstCapturePath({ cursor: true, claudeCode: false, codex: false }, 'fleet-1');
  assert.equal(capture.client, 'cursor');
  assert.equal(capture.capability_level, 'mcp');
  assert.equal(capture.command, 'marrow_agent_runtime');
  assert.match(capture.instruction, /on demand/);
  assert.match(capture.instruction, /marrow_session_end/);
});

test('Codex first capture requires native-hook restart and trust review without claiming coverage', () => {
  const capture = firstCapturePath({ cursor: false, claudeCode: false, codex: true }, 'codex');
  assert.equal(capture.capability_level, 'native_hooks');
  assert.equal(capture.command, null);
  assert.match(capture.instruction, /\/hooks trust review/);
  assert.match(capture.instruction, /does not verify runtime coverage/);
});

test('Claude first capture uses native hooks even when Cursor is also present', () => {
  const capture = firstCapturePath({ claudeCode: true, cursor: true, codex: false }, 'claude');
  assert.equal(capture.client, 'claude-code');
  assert.equal(capture.capability_level, 'native_hooks');
  assert.equal(capture.command, null);
  assert.match(capture.instruction, /native hooks/);
});

test('unchanged config does not claim a reload or that this process is live', () => {
  const plan = harnessReloadPlan({ node: true, codex: true }, [
    { label: 'Project MCP server config', applied: false, changed: false },
  ]);
  assert.equal(plan.required, false);
  assert.equal(plan.live_in_this_process, true);
});

test('detected Cursor workspaces also receive Cursor MCP config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-cursor-mcp-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    fs.mkdirSync(path.join(root, '.cursor'), { recursive: true });
    const detection = detectEnvironment(root, { ...process.env, HOME: root });
    const plan = buildPlan(detection, { mode: 'auto' });
    assert.ok(plan.writes.some((item) => item.label === 'Cursor MCP server config'));
    assert.ok(plan.writes.some((item) => item.label === 'Project MCP server config'));
    assert.ok(plan.writes.some((item) => item.label === 'SDK passive runtime preload'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('default harness matrix lists every advertised client without claiming native hooks everywhere', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-default-matrix-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    const detection = detectEnvironment(root, { ...process.env, HOME: root });
    const matrix = defaultHarnessInstallMatrix(detection);
    assert.ok(matrix.length >= 16);
    assert.ok(matrix.every((entry) => entry.default_install.mcp === true));
    assert.ok(matrix.every((entry) => entry.default_install.sdk_passive_runtime === true));
    assert.ok(matrix.every((entry) => entry.verified_passive === false));
    const claude = matrix.find((entry) => entry.client === 'claude-code');
    const hermes = matrix.find((entry) => entry.client === 'hermes');
    assert.equal(claude.default_install.native_hooks, false);
    assert.match(hermes.unsupported_claim, /event adapter/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('capability registry describes every advertised harness without overstating automatic coverage', () => {
  const clients = new Set(HARNESS_CAPABILITY_REGISTRY.map((entry) => entry.client));
  for (const client of ['claude-code', 'cursor', 'composer', 'cline', 'codex', 'opencode', 'hermes', 'openclaw', 'gemini', 'grok', 'deepseek', 'qwen', 'kimi', 'minimax', 'glm', 'custom']) {
    assert.ok(clients.has(client), `missing capability contract for ${client}`);
  }
  for (const entry of HARNESS_CAPABILITY_REGISTRY) {
    assert.match(entry.client, /^[a-z0-9-]+$/);
    assert.ok(['native_hooks', 'mcp', 'sdk_passive_runtime', 'governed_wrapper', 'event_contract'].includes(entry.capability_level));
    assert.ok(Array.isArray(entry.automatic));
    if (entry.capability_level === 'event_contract') assert.equal(entry.automatic.length, 0);
    if (entry.capability_level === 'governed_wrapper') {
      assert.deepEqual(entry.automatic, ['pre_action', 'action_result', 'outcome_closure']);
    }
  }
});

test('Claude native-hook configuration records local completeness without proving runtime coverage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-harness-cert-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Claude\n');
    const detection = detectEnvironment(root, { ...process.env, HOME: root });
    const plan = buildPlan(detection, { mode: 'both' });
    const changes = applyPlan(plan, { yes: true, dryRun: false, doctor: false });
    const profile = activationProfile(detection, plan, changes, 'claude-code');
    assert.equal(profile.capability_level, 'native_hooks');
    assert.equal(profile.adapter_version, '3.9.75');
    assert.deepEqual(profile.expected_hooks, ['prompt', 'pre_action', 'action_result', 'session_end']);
    assert.deepEqual(profile.observed_hooks.sort(), ['action_result', 'pre_action', 'prompt', 'session_end'].sort());
    assert.equal(profile.evidence_authority, 'client_self_reported');
    assert.equal(profile.coverage_verified, false);
    assert.equal(profile.configuration_complete, true);
    assert.equal(profile.complete, true);
    assert.match(profile.config_fingerprint, /^[a-f0-9]{64}$/);
    const settings = fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8');
    const parsedSettings = JSON.parse(settings);
    const canonicalFingerprint = crypto.createHash('sha256').update(JSON.stringify({
      schema: 'marrow-claude-native-hooks.v3',
      adapter_version: '3.9.75',
      expected_hooks: ['prompt', 'pre_action', 'action_result', 'session_end'],
      configured: {
        prompt: true,
        pre_action: true,
        action_result_success: true,
        action_result_failure: true,
        session_end: true,
      },
      descriptors: {
        prompt: [{ matcher: null, command: 'npx -y --package=@getmarrow/mcp@3.9.75 marrow-mcp context-hook', timeout: null }],
        pre_action: [{ matcher: 'Bash|Edit|Write|MultiEdit|mcp__(?!marrow_).*', command: 'npx -y --package=@getmarrow/mcp@3.9.75 marrow-mcp pre-action-hook', timeout: null }],
        action_result_success: [{ matcher: 'Bash|Edit|Write|MultiEdit|mcp__(?!marrow_).*', command: 'npx -y --package=@getmarrow/mcp@3.9.75 marrow-mcp hook', timeout: null }],
        action_result_failure: [{ matcher: 'Bash|Edit|Write|MultiEdit|mcp__(?!marrow_).*', command: 'npx -y --package=@getmarrow/mcp@3.9.75 marrow-mcp hook', timeout: null }],
        session_end: [{ matcher: null, command: 'npx -y --package=@getmarrow/mcp@3.9.75 marrow-mcp session-hook', timeout: null }],
      },
      active_marrow_handlers: {
        prompt: [{ matcher: null, command: 'npx -y --package=@getmarrow/mcp@3.9.75 marrow-mcp context-hook', timeout: null }],
        pre_action: [{ matcher: 'Bash|Edit|Write|MultiEdit|mcp__(?!marrow_).*', command: 'npx -y --package=@getmarrow/mcp@3.9.75 marrow-mcp pre-action-hook', timeout: null }],
        action_result_success: [{ matcher: 'Bash|Edit|Write|MultiEdit|mcp__(?!marrow_).*', command: 'npx -y --package=@getmarrow/mcp@3.9.75 marrow-mcp hook', timeout: null }],
        action_result_failure: [{ matcher: 'Bash|Edit|Write|MultiEdit|mcp__(?!marrow_).*', command: 'npx -y --package=@getmarrow/mcp@3.9.75 marrow-mcp hook', timeout: null }],
        session_end: [{ matcher: null, command: 'npx -y --package=@getmarrow/mcp@3.9.75 marrow-mcp session-hook', timeout: null }],
      },
    })).digest('hex');
    assert.equal(profile.config_fingerprint, canonicalFingerprint);
    assert.equal(claudeNativeHookFingerprint(parsedSettings), canonicalFingerprint);
    assert.match(settings, /context-hook/);
    assert.match(settings, /pre-action-hook/);
    assert.match(settings, /PostToolUseFailure/);
    assert.match(settings, /session-hook/);
    assert.match(settings, /getmarrow\/mcp@3\.9\.75.*marrow-mcp hook/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Claude setup replaces old Marrow hooks without duplicate execution', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-harness-upgrade-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Claude\n');
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({
      permissions: { allow: ['Read'] },
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'npx -y @getmarrow/mcp context-hook', timeout: 11 }] }],
        PreToolUse: [{ matcher: NATIVE_HOOK_MATCHER, hooks: [
          { type: 'command', command: 'npx -y @getmarrow/mcp@3.9.49 pre-action-hook' },
          { type: 'command', command: 'npx -y @getmarrow/mcp@3.9.49 hook', timeout: 99 },
        ] }],
        PostToolUse: [{ matcher: NATIVE_HOOK_MATCHER, hooks: [
          { type: 'command', command: 'npx -y @getmarrow/mcp hook' },
          { type: 'command', command: 'printf unrelated' },
        ] }],
        PostToolUseFailure: [
          { matcher: NATIVE_HOOK_MATCHER, hooks: [{ type: 'command', command: 'npx -y @getmarrow/mcp@3.9.48 hook' }] },
          { matcher: NATIVE_HOOK_MATCHER, hooks: [{ type: 'command', command: MCP_ACTION_RESULT_HOOK_COMMAND, timeout: 14 }] },
        ],
        Stop: [{ hooks: [{ type: 'command', command: 'npx -y @getmarrow/mcp session-hook' }] }],
      },
    }, null, 2));

    const detection = detectEnvironment(root, { ...process.env, HOME: root });
    const plan = buildPlan(detection, { mode: 'both' });
    applyPlan(plan, { yes: true, dryRun: false, doctor: false });
    const first = fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8');
    const settings = JSON.parse(first);
    const commandCounts = Object.values(settings.hooks).flatMap((entries) => entries)
      .flatMap((entry) => entry.hooks || [])
      .filter((hook) => /^npx\s+(?:-y\s+)?(?:--package=)?@getmarrow\/mcp(?:@[^\s]+)?\s+(?:marrow-mcp\s+)?/.test(hook.command || ''));
    assert.equal(commandCounts.length, 5);
    assert.ok(commandCounts.every((hook) => hook.command.includes('@getmarrow/mcp@3.9.75')));
    assert.deepEqual(settings.permissions, { allow: ['Read'] });
    assert.match(first, /printf unrelated/);
    assert.equal(settings.hooks.PostToolUseFailure.at(-1).hooks[0].timeout, 14);

    const secondDetection = detectEnvironment(root, { ...process.env, HOME: root });
    const secondPlan = buildPlan(secondDetection, { mode: 'both' });
    applyPlan(secondPlan, { yes: true, dryRun: false, doctor: false });
    assert.equal(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'), first);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Claude setup preserves malformed and non-object settings by failing closed', () => {
  for (const contents of ['{broken', '[]']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-harness-invalid-settings-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
      fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Claude\n');
      fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
      const settingsPath = path.join(root, '.claude', 'settings.json');
      fs.writeFileSync(settingsPath, contents);
      const detection = detectEnvironment(root, { ...process.env, HOME: root });
      const plan = buildPlan(detection, { mode: 'both' });
      assert.throws(() => applyPlan(plan, { yes: true, dryRun: false, doctor: false }));
      assert.equal(fs.readFileSync(settingsPath, 'utf8'), contents);
      assert.equal(fs.existsSync(path.join(root, '.marrow', 'passive-runtime.mjs')), false);
      assert.equal(fs.existsSync(path.join(root, '.marrow', 'env.example')), false);
      assert.equal(fs.existsSync(path.join(root, '.mcp.json')), false);
      assert.equal(fs.existsSync(path.join(root, 'AGENTS.md')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test('Claude fingerprint includes unexpected legacy and duplicate active handlers', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-harness-drift-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Claude\n');
    const detection = detectEnvironment(root, { ...process.env, HOME: root });
    const plan = buildPlan(detection, { mode: 'both' });
    applyPlan(plan, { yes: true, dryRun: false, doctor: false });
    const settingsPath = path.join(root, '.claude', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const certified = claudeNativeHookFingerprint(settings);
    settings.hooks.PreToolUse.push({
      matcher: NATIVE_HOOK_MATCHER,
      hooks: [{ type: 'command', command: 'npx -y @getmarrow/mcp pre-action-hook', timeout: 99 }],
    });
    assert.notEqual(claudeNativeHookFingerprint(settings), certified);

    settings.hooks.PreToolUse.pop();
    const expectedOnly = claudeNativeHookFingerprint(settings);
    settings.hooks.PreToolUse.push({
      matcher: NATIVE_HOOK_MATCHER,
      hooks: [{ type: 'command', command: 'npx -y @getmarrow/mcp@3.9.49 hook', timeout: 77 }],
    });
    assert.notEqual(claudeNativeHookFingerprint(settings), expectedOnly);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex hooks reconcile exact native events, preserve unrelated entries, and stay byte-idempotent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-harness-codex-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Agents\n');
    fs.mkdirSync(path.join(root, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(root, '.codex', 'hooks.json'), JSON.stringify({
      owner_setting: { preserved: true },
      hooks: {
        PreToolUse: [{ matcher: 'owner-tool', hooks: [{ type: 'command', command: 'owner-check', timeout: 9 }] }],
        CustomEvent: [{ hooks: [{ type: 'command', command: 'owner-custom' }] }],
      },
    }, null, 2) + '\n');
    const detection = detectEnvironment(root, { ...process.env, HOME: root });
    const plan = buildPlan(detection, { mode: 'both' });
    const changes = applyPlan(plan, { yes: true, dryRun: false, doctor: false });
    const profile = activationProfile(detection, plan, changes, 'codex');
    const hooksPath = path.join(root, '.codex', 'hooks.json');
    const first = fs.readFileSync(hooksPath, 'utf8');
    const settings = JSON.parse(first);

    assert.deepEqual(settings.owner_setting, { preserved: true });
    assert.deepEqual(settings.hooks.CustomEvent, [{ hooks: [{ type: 'command', command: 'owner-custom' }] }]);
    assert.ok(settings.hooks.PreToolUse.some((entry) => entry.matcher === 'owner-tool'));
    const exact = (event, suffix, matcher, timeout) => {
      const entry = settings.hooks[event].find((candidate) => matcher == null || candidate.matcher === matcher);
      const hook = entry.hooks.find((candidate) => candidate.command?.endsWith(`marrow-mcp ${suffix}`));
      assert.ok(hook, `missing ${event} ${suffix}`);
      assert.equal(hook.timeout, timeout);
      assert.match(hook.command, /@getmarrow\/mcp@3\.9\.75/);
      return hook;
    };
    exact('UserPromptSubmit', 'codex-context-hook', null, 5);
    const preAction = exact('PreToolUse', 'codex-pre-action-hook', CODEX_NATIVE_HOOK_MATCHER, 5);
    assert.equal(preAction.async, false);
    exact('PostToolUse', 'codex-hook', CODEX_NATIVE_HOOK_MATCHER, 5);
    exact('SessionEnd', 'codex-session-hook', null, 3);
    assert.equal(settings.hooks.PostToolUseFailure, undefined);
    assert.equal(profile.capability_level, 'native_hooks');
    assert.equal(profile.adapter_version, '3.9.75');
    assert.deepEqual(profile.expected_hooks, ['prompt', 'pre_action', 'action_result', 'session_end']);
    assert.deepEqual(profile.observed_hooks.sort(), ['prompt', 'pre_action', 'action_result', 'session_end'].sort());
    assert.equal(profile.evidence_authority, 'client_self_reported');
    assert.equal(profile.coverage_verified, false);
    assert.equal(profile.passive_live, false);
    assert.equal(profile.configuration_complete, true);
    assert.equal(profile.complete, true);
    assert.equal(profile.exact_fix, null);
    assert.equal(profile.config_fingerprint, codexNativeHookFingerprint(settings));

    const secondDetection = detectEnvironment(root, { ...process.env, HOME: root });
    const secondPlan = buildPlan(secondDetection, { mode: 'both' });
    applyPlan(secondPlan, { yes: true, dryRun: false, doctor: false });
    assert.equal(fs.readFileSync(hooksPath, 'utf8'), first);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex hook installation rejects symlinked and out-of-root targets before any write', () => {
  for (const unsafeKind of ['symlink', 'outside']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-harness-codex-unsafe-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-harness-codex-outside-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
      fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Agents\n');
      let detection = detectEnvironment(root, { ...process.env, HOME: root });
      if (unsafeKind === 'symlink') {
        fs.symlinkSync(outside, path.join(root, '.codex'));
        detection = detectEnvironment(root, { ...process.env, HOME: root });
      } else {
        detection.paths.codexHooks = path.join(outside, 'hooks.json');
      }
      const plan = buildPlan(detection, { mode: 'mcp' });
      assert.throws(
        () => applyPlan(plan, { yes: true, dryRun: false, doctor: false }),
        /unsafe path component|outside project root/,
      );
      assert.equal(fs.existsSync(path.join(outside, 'hooks.json')), false);
      assert.equal(fs.existsSync(path.join(root, '.mcp.json')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }
});

test('echo-only Claude hook placeholders are repaired instead of certified', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-harness-echo-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Claude\n');
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo npx -y @getmarrow/mcp context-hook' }] }],
        PreToolUse: [{ matcher: 'Bash|Edit|Write|MultiEdit|mcp__(?!marrow_).*', hooks: [{ type: 'command', command: 'echo npx -y @getmarrow/mcp pre-action-hook' }] }],
        PostToolUse: [{ matcher: 'Bash|Edit|Write|MultiEdit|mcp__(?!marrow_).*', hooks: [{ type: 'command', command: 'echo npx -y @getmarrow/mcp hook' }] }],
        PostToolUseFailure: [{ matcher: 'Bash|Edit|Write|MultiEdit|mcp__(?!marrow_).*', hooks: [{ type: 'command', command: 'echo npx -y @getmarrow/mcp hook' }] }],
        Stop: [{ hooks: [{ type: 'command', command: 'echo npx -y @getmarrow/mcp session-hook' }] }],
      },
    }, null, 2));

    const detection = detectEnvironment(root, { ...process.env, HOME: root });
    const plan = buildPlan(detection, { mode: 'both' });
    const changes = applyPlan(plan, { yes: false, dryRun: true, doctor: false });
    const profile = activationProfile(detection, plan, changes, 'claude-code');

    assert.equal(profile.complete, false);
    assert.deepEqual(profile.observed_hooks, []);
    assert.ok(changes.some((change) => change.label === 'Claude Code MCP passive hooks' && change.changed));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('custom SDK activation requires both dependency and exact generated runtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-harness-sdk-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    let detection = detectEnvironment(root, { ...process.env, HOME: root });
    let plan = buildPlan(detection, { mode: 'sdk' });
    let changes = applyPlan(plan, { yes: true, dryRun: false, doctor: false });
    let profile = activationProfile(detection, plan, changes, 'custom');
    assert.equal(profile.complete, false);
    assert.match(profile.exact_fix, /npm install @getmarrow\/sdk/);

    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { '@getmarrow/sdk': '^3.7.62' } }));
    const moduleDir = path.join(root, 'node_modules', '@getmarrow', 'sdk');
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(path.join(moduleDir, 'package.json'), JSON.stringify({ name: '@getmarrow/sdk', version: '3.7.62' }));
    writeSdkLock(root);
    detection = detectEnvironment(root, { ...process.env, HOME: root });
    plan = buildPlan(detection, { mode: 'sdk' });
    changes = applyPlan(plan, { yes: true, dryRun: false, doctor: false });
    profile = activationProfile(detection, plan, changes, 'custom');
    assert.equal(profile.complete, true);
    assert.deepEqual(profile.observed_hooks, ['pre_action', 'action_result', 'outcome_closure']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('custom SDK activation rejects npm aliases even when version and installed name are forged', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-harness-sdk-alias-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      dependencies: { '@getmarrow/sdk': 'npm:untrusted-sdk@3.7.62' },
    }));
    const moduleDir = path.join(root, 'node_modules', '@getmarrow', 'sdk');
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(path.join(moduleDir, 'package.json'), JSON.stringify({
      name: '@getmarrow/sdk',
      version: '3.7.62',
    }));

    const detection = detectEnvironment(root, { ...process.env, HOME: root });
    const dependency = inspectSdkDependency(detection);
    const plan = buildPlan(detection, { mode: 'sdk' });
    const changes = applyPlan(plan, { yes: true, dryRun: false, doctor: false });
    const profile = activationProfile(detection, plan, changes, 'custom');

    assert.equal(dependency.declared, true);
    assert.equal(dependency.declaration_trusted, false);
    assert.equal(dependency.present, false);
    assert.equal(profile.complete, false);
    assert.match(profile.exact_fix, /npm install @getmarrow\/sdk/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('custom SDK activation rejects override impersonation despite forged installed metadata', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-harness-sdk-override-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      dependencies: { '@getmarrow/sdk': '^3.7.62' },
      overrides: { '@getmarrow/sdk': 'npm:untrusted-sdk@3.7.62' },
    }));
    writeSdkLock(root);
    const moduleDir = path.join(root, 'node_modules', '@getmarrow', 'sdk');
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(path.join(moduleDir, 'package.json'), JSON.stringify({
      name: '@getmarrow/sdk',
      version: '3.7.62',
    }));

    const detection = detectEnvironment(root, { ...process.env, HOME: root });
    const dependency = inspectSdkDependency(detection);
    const plan = buildPlan(detection, { mode: 'sdk' });
    const changes = applyPlan(plan, { yes: true, dryRun: false, doctor: false });
    const profile = activationProfile(detection, plan, changes, 'custom');

    assert.equal(dependency.override_detected, true);
    assert.equal(dependency.lock_verified, true);
    assert.equal(dependency.present, false);
    assert.equal(profile.complete, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

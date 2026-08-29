const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
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
  cursorNativeHookFingerprint,
  clineNativeHookFingerprint,
  windsurfNativeHookFingerprint,
  geminiNativeHookFingerprint,
  grokNativeHookFingerprint,
  GROK_CONTEXT_HOOK_COMMAND,
  GROK_PRE_ACTION_HOOK_COMMAND,
  GROK_ACTION_RESULT_HOOK_COMMAND,
  GROK_SESSION_END_HOOK_COMMAND,
  GROK_NATIVE_HOOK_MATCHER,
  defaultHarnessInstallMatrix,
  detectEnvironment,
  firstCapturePath,
  harnessReloadPlan,
  inspectSdkDependency,
} = require('../src/installer');

const NATIVE_HOOK_MATCHER = 'Bash|Edit|Write|MultiEdit|mcp__(?!marrow_).*';
const CODEX_NATIVE_HOOK_MATCHER = 'Bash|apply_patch|Edit|Write|MultiEdit|mcp__(?!marrow__marrow_).*|functions\\.(?!marrow_).*';
const CURSOR_NATIVE_HOOK_MATCHER = 'Shell|Write|Delete|Task|MCP:(?!marrow(?:_.*|:marrow_.*)$).*';
const MCP_ACTION_RESULT_HOOK_COMMAND = 'npx -y --package=@getmarrow/mcp@3.9.77 marrow-mcp hook';
const WINDSURF_EVENTS = [
  'pre_write_code', 'pre_run_command', 'pre_mcp_tool_use',
  'post_write_code', 'post_run_command', 'post_mcp_tool_use',
  'post_cascade_response',
];
const GEMINI_MATCHER = '^(?:run_shell_command|write_file|replace|edit_file|delete_file|mcp_(?!marrow_marrow_)[A-Za-z0-9_]{1,192})$';
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

test('Cursor and Composer first capture uses native hooks only after restart and trust review', () => {
  const capture = firstCapturePath({ cursor: true, claudeCode: false, codex: false }, 'fleet-1');
  assert.equal(capture.client, 'cursor');
  assert.equal(capture.capability_level, 'native_hooks');
  assert.equal(capture.command, null);
  assert.match(capture.instruction, /Cursor and Composer/);
  assert.match(capture.instruction, /\/hooks review/);
  assert.match(capture.instruction, /does not verify runtime coverage/);
});

test('Cline first capture requires Enable Hooks, executable trust, restart, and keeps TaskComplete unverified', () => {
  const capture = firstCapturePath({ cline: true, claudeCode: false, cursor: false, codex: false }, 'cline');
  assert.equal(capture.client, 'cline');
  assert.equal(capture.capability_level, 'native_hooks');
  assert.equal(capture.command, null);
  assert.match(capture.instruction, /Enable Hooks/);
  assert.match(capture.instruction, /executable\/workspace trust/);
  assert.match(capture.instruction, /TaskComplete.*coming soon.*not verified/);
  assert.match(capture.instruction, /does not prove passive runtime coverage/);
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

test('detected Cursor workspaces receive Cursor hooks and MCP config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-cursor-mcp-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    fs.mkdirSync(path.join(root, '.cursor'), { recursive: true });
    const detection = detectEnvironment(root, { ...process.env, HOME: root });
    const plan = buildPlan(detection, { mode: 'auto' });
    assert.ok(plan.writes.some((item) => item.label === 'Cursor native hooks'));
    assert.ok(plan.writes.some((item) => item.label === 'Cursor MCP server config'));
    assert.ok(plan.writes.some((item) => item.label === 'Project MCP server config'));
    assert.ok(plan.writes.some((item) => item.label === 'SDK passive runtime preload'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Cursor hooks reconcile exact native events, preserve unrelated entries, and stay byte-idempotent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-harness-cursor-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    fs.mkdirSync(path.join(root, '.cursor'), { recursive: true });
    const hooksPath = path.join(root, '.cursor', 'hooks.json');
    fs.writeFileSync(hooksPath, JSON.stringify({
      version: 9,
      owner_setting: { preserved: true },
      hooks: {
        preToolUse: [
          { command: 'owner-check', matcher: 'owner-tool', timeout: 9 },
          { command: 'npx -y --package=@getmarrow/mcp@3.9.74 marrow-mcp cursor-pre-action-hook', matcher: 'old' },
        ],
        customEvent: [{ command: 'owner-custom' }],
      },
    }, null, 2) + '\n');
    const detection = detectEnvironment(root, { ...process.env, HOME: root });
    const plan = buildPlan(detection, { mode: 'both' });
    const changes = applyPlan(plan, { yes: true, dryRun: false, doctor: false });
    const first = fs.readFileSync(hooksPath, 'utf8');
    const settings = JSON.parse(first);
    assert.equal(settings.version, 1);
    assert.deepEqual(settings.owner_setting, { preserved: true });
    assert.deepEqual(settings.hooks.customEvent, [{ command: 'owner-custom' }]);
    assert.ok(settings.hooks.preToolUse.some((entry) => entry.command === 'owner-check'));
    assert.equal(settings.hooks.UserPromptSubmit, undefined);
    assert.equal(settings.hooks.prompt, undefined);

    const exact = (event, suffix, matcher, timeout) => {
      const entries = settings.hooks[event].filter((entry) => entry.command?.endsWith(`marrow-mcp ${suffix}`));
      assert.equal(entries.length, 1, `expected one ${event} ${suffix}`);
      const entry = entries[0];
      assert.equal(entry.matcher, matcher);
      assert.equal(entry.timeout, timeout);
      assert.match(entry.command, /@getmarrow\/mcp@3\.9\.77/);
      return entry;
    };
    const preAction = exact('preToolUse', 'cursor-pre-action-hook', CURSOR_NATIVE_HOOK_MATCHER, 5);
    assert.equal(preAction.failClosed, true);
    assert.equal(preAction.async, false);
    exact('postToolUse', 'cursor-hook', CURSOR_NATIVE_HOOK_MATCHER, 5);
    exact('postToolUseFailure', 'cursor-hook', CURSOR_NATIVE_HOOK_MATCHER, 5);
    exact('stop', 'cursor-session-hook', undefined, 3);
    assert.doesNotMatch(JSON.stringify(settings), /cursor-context-hook|UserPromptSubmit/);

    for (const client of ['cursor', 'composer']) {
      const profile = activationProfile(detection, plan, changes, client);
      assert.equal(profile.capability_level, 'native_hooks');
      assert.deepEqual(profile.expected_hooks, ['pre_action', 'action_result', 'outcome_closure']);
      assert.deepEqual(profile.observed_hooks, ['pre_action', 'action_result', 'outcome_closure']);
      assert.equal(profile.evidence_authority, 'client_self_reported');
      assert.equal(profile.coverage_verified, false);
      assert.equal(profile.passive_live, false);
      assert.equal(profile.configuration_complete, true);
      assert.equal(profile.config_fingerprint, cursorNativeHookFingerprint(settings));
    }
    const matrix = defaultHarnessInstallMatrix(detection);
    for (const client of ['cursor', 'composer']) {
      const entry = matrix.find((candidate) => candidate.client === client);
      assert.equal(entry.capability_level, 'native_hooks');
      assert.deepEqual(entry.automatic, ['pre_action', 'action_result', 'outcome_closure']);
      assert.equal(entry.default_install.native_hooks, true);
      assert.equal(entry.configured_locally, true);
      assert.equal(entry.verified_passive, false);
    }

    const secondDetection = detectEnvironment(root, { ...process.env, HOME: root });
    const secondPlan = buildPlan(secondDetection, { mode: 'both' });
    applyPlan(secondPlan, { yes: true, dryRun: false, doctor: false });
    assert.equal(fs.readFileSync(hooksPath, 'utf8'), first);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Cursor hook installation rejects symlinked and out-of-root targets before any write', () => {
  for (const unsafeKind of ['symlink', 'outside']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-harness-cursor-unsafe-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-harness-cursor-outside-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
      let detection;
      if (unsafeKind === 'symlink') {
        fs.symlinkSync(outside, path.join(root, '.cursor'));
        detection = detectEnvironment(root, { ...process.env, HOME: root });
      } else {
        fs.mkdirSync(path.join(root, '.cursor'));
        detection = detectEnvironment(root, { ...process.env, HOME: root });
        detection.paths.cursorHooks = path.join(outside, 'hooks.json');
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

test('Cline hooks install exact executable non-blocking scripts and remain byte-idempotent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-harness-cline-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    fs.mkdirSync(path.join(root, '.clinerules'), { recursive: true });
    const detection = detectEnvironment(root, { ...process.env, HOME: root });
    assert.equal(detection.cline, true);
    const plan = buildPlan(detection, { mode: 'both' });
    assert.deepEqual(plan.writes.filter((write) => /Cline .* native hook/.test(write.label)).map((write) => path.basename(write.path)), [
      'PreToolUse', 'PostToolUse', 'TaskCancel',
    ]);
    const changes = applyPlan(plan, { yes: true, dryRun: false, doctor: false });
    const hookDir = path.join(root, '.clinerules', 'hooks');
    const hookPaths = ['PreToolUse', 'PostToolUse', 'TaskCancel'].map((name) => path.join(hookDir, name));
    for (const hookPath of hookPaths) {
      assert.equal(fs.statSync(hookPath).mode & 0o777, 0o755);
      assert.match(fs.readFileSync(hookPath, 'utf8'), /^#!\/bin\/sh\n/);
    }
    const pre = fs.readFileSync(hookPaths[0], 'utf8');
    const post = fs.readFileSync(hookPaths[1], 'utf8');
    const cancel = fs.readFileSync(hookPaths[2], 'utf8');
    assert.match(pre, /@getmarrow\/mcp@3\.9\.77 marrow-mcp cline-pre-action-hook/);
    assert.match(pre, /"cancel":true/);
    assert.match(pre, /JSON\.parse/);
    assert.match(post, /@getmarrow\/mcp@3\.9\.77 marrow-mcp cline-hook/);
    assert.match(post, /\|\| :/);
    assert.match(cancel, /@getmarrow\/mcp@3\.9\.77 marrow-mcp cline-session-hook/);
    assert.match(cancel, /\|\| :/);
    assert.equal(fs.existsSync(path.join(hookDir, 'TaskComplete')), false);

    const fakeBin = path.join(root, 'fake-bin');
    fs.mkdirSync(fakeBin);
    const fakeNpx = path.join(fakeBin, 'npx');
    fs.writeFileSync(fakeNpx, '#!/bin/sh\nif [ "${FAKE_NPX_FAIL:-}" = "1" ]; then exit 7; fi\nprintf "%s\\n" \'{"cancel":false}\'\n');
    fs.chmodSync(fakeNpx, 0o755);
    const hookEnv = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` };
    const allowed = spawnSync(hookPaths[0], [], { env: hookEnv, input: '{}', encoding: 'utf8' });
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.deepEqual(JSON.parse(allowed.stdout), { cancel: false });
    const failed = spawnSync(hookPaths[0], [], { env: { ...hookEnv, FAKE_NPX_FAIL: '1' }, input: '{}', encoding: 'utf8' });
    assert.equal(failed.status, 0, failed.stderr);
    assert.equal(JSON.parse(failed.stdout).cancel, true);
    for (const hookPath of hookPaths.slice(1)) {
      const telemetryFailure = spawnSync(hookPath, [], { env: { ...hookEnv, FAKE_NPX_FAIL: '1' }, input: '{}', encoding: 'utf8' });
      assert.equal(telemetryFailure.status, 0, telemetryFailure.stderr);
      assert.equal(telemetryFailure.stdout, '');
    }

    const profile = activationProfile(detection, plan, changes, 'cline');
    assert.equal(profile.capability_level, 'native_hooks');
    assert.deepEqual(profile.expected_hooks, ['pre_action', 'action_result', 'cancel_closeout']);
    assert.deepEqual(profile.observed_hooks, ['pre_action', 'action_result', 'cancel_closeout']);
    assert.equal(profile.evidence_authority, 'client_self_reported');
    assert.equal(profile.coverage_verified, false);
    assert.equal(profile.passive_live, false);
    assert.equal(profile.configuration_complete, true);
    assert.equal(profile.task_complete_support, 'coming_soon_not_configured');
    assert.equal(profile.task_completion_closure_verified, false);
    assert.equal(profile.enable_hooks_required, true);
    assert.match(profile.exact_fix, /Enable Hooks.*trust.*restart/);
    assert.equal(profile.config_fingerprint, clineNativeHookFingerprint(detection));
    const matrix = defaultHarnessInstallMatrix(detection).find((entry) => entry.client === 'cline');
    assert.equal(matrix.capability_level, 'native_hooks');
    assert.deepEqual(matrix.automatic, ['pre_action', 'action_result', 'cancel_closeout']);
    assert.equal(matrix.default_install.native_hooks, true);
    assert.equal(matrix.configured_locally, true);
    assert.equal(matrix.verified_passive, false);
    assert.match(matrix.unsupported_claim, /TaskComplete.*coming soon.*not configured/);

    const firstBytes = hookPaths.map((hookPath) => fs.readFileSync(hookPath));
    const secondDetection = detectEnvironment(root, { ...process.env, HOME: root });
    const secondPlan = buildPlan(secondDetection, { mode: 'both' });
    const secondChanges = applyPlan(secondPlan, { yes: true, dryRun: false, doctor: false });
    hookPaths.forEach((hookPath, index) => {
      assert.deepEqual(fs.readFileSync(hookPath), firstBytes[index]);
      assert.equal(fs.statSync(hookPath).mode & 0o777, 0o755);
    });
    assert.ok(secondChanges.filter((change) => /Cline .* native hook/.test(change.label)).every((change) => change.already_present));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Cline preserves unrelated hook conflicts and reports exact owner resolution', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-harness-cline-conflict-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    const hooksDir = path.join(root, '.clinerules', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const prePath = path.join(hooksDir, 'PreToolUse');
    const ownerHook = '#!/bin/sh\nprintf owner-hook\n';
    fs.writeFileSync(prePath, ownerHook);
    fs.chmodSync(prePath, 0o755);
    const detection = detectEnvironment(root, { ...process.env, HOME: root });
    const plan = buildPlan(detection, { mode: 'mcp' });
    const changes = applyPlan(plan, { yes: true, dryRun: false, doctor: false });
    assert.equal(fs.readFileSync(prePath, 'utf8'), ownerHook);
    assert.equal(fs.statSync(prePath).mode & 0o777, 0o755);
    const conflict = changes.find((change) => change.label === 'Cline PreToolUse native hook');
    assert.equal(conflict.hook_conflict, true);
    assert.equal(conflict.applied, false);
    assert.equal(conflict.changed, false);
    assert.match(conflict.exact_fix, /Move or remove.*owner review.*--repair/);
    const profile = activationProfile(detection, plan, changes, 'cline');
    assert.equal(profile.configuration_complete, false);
    assert.deepEqual(profile.observed_hooks, ['action_result', 'cancel_closeout']);
    assert.deepEqual(profile.hook_conflicts, ['Cline PreToolUse native hook']);
    assert.match(profile.exact_fix, /Move or remove.*owner-managed.*never overwrite or compose/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Cline hook installation rejects symlinked and out-of-root targets before any write or chmod', () => {
  for (const unsafeKind of ['symlink', 'outside']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-harness-cline-unsafe-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-harness-cline-outside-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
      const hooksDir = path.join(root, '.clinerules', 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      let detection = detectEnvironment(root, { ...process.env, HOME: root });
      if (unsafeKind === 'symlink') {
        const outsideHook = path.join(outside, 'owner-hook');
        fs.writeFileSync(outsideHook, 'owner\n');
        fs.symlinkSync(outsideHook, path.join(hooksDir, 'PreToolUse'));
      } else {
        detection.paths.clinePreToolUseHook = path.join(outside, 'PreToolUse');
      }
      const plan = buildPlan(detection, { mode: 'mcp' });
      assert.throws(
        () => applyPlan(plan, { yes: true, dryRun: false, doctor: false }),
        /unsafe managed target|outside project root/,
      );
      assert.equal(fs.existsSync(path.join(root, '.mcp.json')), false);
      assert.equal(fs.existsSync(path.join(hooksDir, 'PostToolUse')), false);
      if (unsafeKind === 'outside') assert.equal(fs.existsSync(path.join(outside, 'PreToolUse')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }
});

test('Windsurf reconciles exact native hooks, preserves unrelated config, fails closed only before actions, and is byte-idempotent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-harness-windsurf-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    fs.mkdirSync(path.join(root, '.windsurf'), { recursive: true });
    const hooksPath = path.join(root, '.windsurf', 'hooks.json');
    fs.writeFileSync(hooksPath, JSON.stringify({
      owner_setting: { retained: true },
      hooks: {
        pre_run_command: [
          { command: 'printf owner-pre', show_output: true, owner: true },
          { command: 'npx -y --package=@getmarrow/mcp@3.9.74 marrow-mcp windsurf-pre-action-hook', show_output: true },
        ],
        post_cascade_response: [{ command: 'printf owner-closeout', owner: true }],
        owner_event: [{ command: 'printf owner-event' }],
      },
    }, null, 2) + '\n');
    const detection = detectEnvironment(root, { ...process.env, HOME: root });
    assert.equal(detection.windsurf, true);
    const plan = buildPlan(detection, { mode: 'mcp' });
    assert.equal(plan.writes.filter((write) => write.label === 'Windsurf native hooks').length, 1);
    const changes = applyPlan(plan, { yes: true, dryRun: false, doctor: false });
    const settings = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.deepEqual(settings.owner_setting, { retained: true });
    assert.deepEqual(settings.hooks.owner_event, [{ command: 'printf owner-event' }]);
    assert.equal(settings.hooks.pre_run_command.some((entry) => entry.command === 'printf owner-pre' && entry.owner === true), true);
    assert.equal(settings.hooks.post_cascade_response.some((entry) => entry.command === 'printf owner-closeout' && entry.owner === true), true);
    assert.equal(JSON.stringify(settings).includes('@getmarrow/mcp@3.9.74'), false);
    assert.equal(settings.hooks.post_cascade_response_with_transcript, undefined);
    assert.equal(settings.hooks.post_run_command_failure, undefined);
    for (const eventName of WINDSURF_EVENTS) {
      const marrow = settings.hooks[eventName].filter((entry) => /marrow-mcp windsurf-/.test(entry.command));
      assert.equal(marrow.length, 1, eventName);
      assert.equal(marrow[0].show_output, false, eventName);
      assert.match(marrow[0].command, /@getmarrow\/mcp@3\.9\.77/);
    }

    const preCommand = settings.hooks.pre_run_command.find((entry) => /windsurf-pre-action-hook/.test(entry.command)).command;
    const postCommand = settings.hooks.post_run_command.find((entry) => /windsurf-hook/.test(entry.command)).command;
    const closeoutCommand = settings.hooks.post_cascade_response.find((entry) => /windsurf-session-hook/.test(entry.command)).command;
    assert.doesNotMatch(JSON.stringify(settings), /MARROW_API_KEY|mrw_/);

    const fakeBin = path.join(root, 'fake-bin');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'npx'), '#!/bin/sh\ncase "${FAKE_NPX_STATUS:-0}" in 0) exit 0 ;; 2) printf "%s\\n" "Marrow blocked this action because required governance approval or proof is unavailable." >&2; exit 2 ;; *) printf "%s\\n" "synthetic-private-launch-error" >&2; exit "$FAKE_NPX_STATUS" ;; esac\n');
    fs.chmodSync(path.join(fakeBin, 'npx'), 0o755);
    const commandEnv = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` };
    const allowed = spawnSync(preCommand, { shell: true, env: { ...commandEnv, FAKE_NPX_STATUS: '0' }, input: '{}', encoding: 'utf8' });
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.equal(allowed.stdout, '');
    assert.equal(allowed.stderr, '');
    const denied = spawnSync(preCommand, { shell: true, env: { ...commandEnv, FAKE_NPX_STATUS: '2' }, input: '{}', encoding: 'utf8' });
    assert.equal(denied.status, 2);
    assert.equal(denied.stdout, '');
    assert.equal(denied.stderr, 'Marrow blocked this action because required governance approval or proof is unavailable.\n');
    const launchFailure = spawnSync(preCommand, { shell: true, env: { ...commandEnv, FAKE_NPX_STATUS: '7' }, input: '{}', encoding: 'utf8' });
    assert.equal(launchFailure.status, 2);
    assert.equal(launchFailure.stdout, '');
    assert.equal(launchFailure.stderr, 'Marrow governance adapter was unavailable; this action is blocked.\n');
    assert.doesNotMatch(launchFailure.stderr, /synthetic-private-launch-error/);
    for (const telemetryCommand of [postCommand, closeoutCommand]) {
      const result = spawnSync(telemetryCommand, { shell: true, env: { ...commandEnv, FAKE_NPX_STATUS: '7' }, input: '{}', encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, '');
      assert.equal(result.stderr, '');
    }

    const profile = activationProfile(detection, plan, changes, 'windsurf');
    assert.equal(profile.capability_level, 'native_hooks');
    assert.deepEqual(profile.expected_hooks, ['pre_action', 'action_result', 'response_closeout']);
    assert.deepEqual(profile.observed_hooks, ['pre_action', 'action_result', 'response_closeout']);
    assert.equal(profile.configuration_complete, true);
    assert.equal(profile.coverage_verified, false);
    assert.equal(profile.passive_live, false);
    assert.equal(profile.restricted_mode_disables_hooks, true);
    assert.equal(profile.restart_required, true);
    assert.equal(profile.workspace_trust_required, true);
    assert.equal(profile.mcp_tools, 'on_demand');
    assert.match(profile.exact_fix, /Restart Windsurf.*Restricted Mode.*MCP tools remain on demand/);
    assert.equal(profile.config_fingerprint, windsurfNativeHookFingerprint(settings));
    const matrix = defaultHarnessInstallMatrix(detection).find((entry) => entry.client === 'windsurf');
    assert.equal(matrix.capability_level, 'native_hooks');
    assert.equal(matrix.default_install.native_hooks, true);
    assert.equal(matrix.configured_locally, true);
    assert.equal(matrix.verified_passive, false);
    assert.match(matrix.unsupported_claim, /Restricted Mode.*never verifies passive coverage/);
    const reload = harnessReloadPlan(detection, changes);
    assert.equal(reload.clients.some((entry) => entry.client === 'windsurf'), true);
    assert.match(reload.instruction, /Restart Windsurf.*trust.*Restricted Mode/);
    const capture = firstCapturePath(detection, 'windsurf-agent');
    assert.equal(capture.client, 'windsurf');
    assert.equal(capture.capability_level, 'native_hooks');
    assert.equal(capture.command, null);
    assert.match(capture.instruction, /pre-action.*success-result.*response-closeout.*MCP tools remain on demand/);

    const first = fs.readFileSync(hooksPath);
    const secondPlan = buildPlan(detectEnvironment(root, { ...process.env, HOME: root }), { mode: 'mcp' });
    const secondChanges = applyPlan(secondPlan, { yes: true, dryRun: false, doctor: false });
    assert.deepEqual(fs.readFileSync(hooksPath), first);
    assert.equal(secondChanges.find((change) => change.label === 'Windsurf native hooks').already_present, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windsurf hook installation rejects invalid JSON, symlink, and out-of-root targets before writes', () => {
  for (const unsafeKind of ['invalid-json', 'symlink', 'outside']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-harness-windsurf-unsafe-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-harness-windsurf-outside-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
      fs.mkdirSync(path.join(root, '.windsurf'), { recursive: true });
      const hooksPath = path.join(root, '.windsurf', 'hooks.json');
      if (unsafeKind === 'invalid-json') fs.writeFileSync(hooksPath, '{broken');
      if (unsafeKind === 'symlink') {
        fs.writeFileSync(path.join(outside, 'hooks.json'), '{"owner":true}\n');
        fs.symlinkSync(path.join(outside, 'hooks.json'), hooksPath);
      }
      let detection = detectEnvironment(root, { ...process.env, HOME: root });
      if (unsafeKind === 'outside') detection.paths.windsurfHooks = path.join(outside, 'hooks.json');
      const plan = buildPlan(detection, { mode: 'mcp' });
      assert.throws(
        () => applyPlan(plan, { yes: true, dryRun: false, doctor: false }),
        /Unexpected token|Expected property|unsafe managed target|outside project root/,
      );
      assert.equal(fs.existsSync(path.join(root, '.mcp.json')), false);
      assert.equal(fs.existsSync(path.join(root, 'AGENTS.md')), false);
      if (unsafeKind === 'invalid-json') assert.equal(fs.readFileSync(hooksPath, 'utf8'), '{broken');
      if (unsafeKind === 'symlink') assert.equal(fs.readFileSync(path.join(outside, 'hooks.json'), 'utf8'), '{"owner":true}\n');
      if (unsafeKind === 'outside') assert.equal(fs.existsSync(path.join(outside, 'hooks.json')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  }
});

test('Gemini CLI reconciles exact native groups, validates decisions, keeps neutral closeout, and is byte-idempotent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-harness-gemini-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    fs.mkdirSync(path.join(root, '.gemini'), { recursive: true });
    const settingsPath = path.join(root, '.gemini', 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
      owner_setting: { retained: true },
      hooksConfig: { owner_option: 'retained' },
      hooks: {
        BeforeTool: [
          { matcher: 'owner-tool', hooks: [{ name: 'owner-before', type: 'command', command: 'printf owner-before', timeout: 99 }] },
          { matcher: 'old', hooks: [{ name: 'marrow-before-tool', type: 'command', command: 'npx -y --package=@getmarrow/mcp@3.9.74 marrow-mcp gemini-pre-action-hook', timeout: 1 }] },
        ],
        AfterAgent: [{ hooks: [{ name: 'owner-after-agent', type: 'command', command: 'printf owner-closeout' }] }],
        SessionEnd: [{ hooks: [{ name: 'owner-session-end', type: 'command', command: 'printf owner-session' }] }],
        OwnerEvent: [{ hooks: [{ name: 'owner-event', type: 'command', command: 'printf owner-event' }] }],
      },
    }, null, 2) + '\n');
    const detection = detectEnvironment(root, { ...process.env, HOME: root });
    assert.equal(detection.gemini, true);
    const plan = buildPlan(detection, { mode: 'mcp' });
    assert.equal(plan.writes.filter((write) => write.label === 'Gemini CLI native hooks').length, 1);
    const changes = applyPlan(plan, { yes: true, dryRun: false, doctor: false });
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.deepEqual(settings.owner_setting, { retained: true });
    assert.deepEqual(settings.hooksConfig, { owner_option: 'retained' });
    assert.equal(settings.hooks.BeforeTool.some((group) => group.matcher === 'owner-tool'), true);
    assert.equal(settings.hooks.AfterAgent.some((group) => group.hooks?.some((hook) => hook.name === 'owner-after-agent')), true);
    assert.deepEqual(settings.hooks.SessionEnd, [{ hooks: [{ name: 'owner-session-end', type: 'command', command: 'printf owner-session' }] }]);
    assert.deepEqual(settings.hooks.OwnerEvent, [{ hooks: [{ name: 'owner-event', type: 'command', command: 'printf owner-event' }] }]);
    assert.equal(JSON.stringify(settings).includes('@getmarrow/mcp@3.9.74'), false);
    assert.equal(JSON.stringify(settings.hooks.SessionEnd).includes('marrow-'), false);

    const expected = [
      ['BeforeTool', 'marrow-before-tool', 'gemini-pre-action-hook', 5000, GEMINI_MATCHER],
      ['AfterTool', 'marrow-after-tool', 'gemini-hook', 5000, GEMINI_MATCHER],
      ['AfterAgent', 'marrow-after-agent', 'gemini-session-hook', 3000, undefined],
    ];
    const commands = {};
    for (const [eventName, name, entrypoint, timeout, matcher] of expected) {
      const groups = settings.hooks[eventName];
      const marrowHandlers = groups.flatMap((group) => group.hooks || []).filter((handler) => handler.name === name);
      assert.equal(marrowHandlers.length, 1, eventName);
      const group = groups.find((candidate) => candidate.hooks?.includes(marrowHandlers[0]));
      assert.equal(group.matcher, matcher, eventName);
      assert.equal(marrowHandlers[0].type, 'command');
      assert.equal(marrowHandlers[0].timeout, timeout);
      assert.match(marrowHandlers[0].command, new RegExp(`@getmarrow/mcp@3\\.9\\.77 marrow-mcp ${entrypoint}`));
      commands[eventName] = marrowHandlers[0].command;
    }
    assert.doesNotMatch(JSON.stringify(settings), /MARROW_API_KEY|mrw_/);

    const fakeBin = path.join(root, 'fake-bin');
    fs.mkdirSync(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'npx'), '#!/bin/sh\ncase "${FAKE_NPX_MODE:-allow}" in allow) printf "%s" \'{"decision":"allow"}\' ;; deny) printf "%s" \'{"decision":"deny","reason":"Marrow blocked this action because required governance approval or proof is unavailable."}\' ;; invalid) printf "%s" \'polluted {"decision":"allow"}\' ;; *) printf "%s\\n" "synthetic-private-launch-error" >&2; exit 7 ;; esac\n');
    fs.chmodSync(path.join(fakeBin, 'npx'), 0o755);
    const commandEnv = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` };
    const allow = spawnSync(commands.BeforeTool, { shell: true, env: { ...commandEnv, FAKE_NPX_MODE: 'allow' }, input: '{}', encoding: 'utf8' });
    assert.equal(allow.status, 0, allow.stderr);
    assert.equal(allow.stdout, '{"decision":"allow"}\n');
    assert.equal(allow.stderr, '');
    const deny = spawnSync(commands.BeforeTool, { shell: true, env: { ...commandEnv, FAKE_NPX_MODE: 'deny' }, input: '{}', encoding: 'utf8' });
    assert.equal(deny.status, 0, deny.stderr);
    assert.equal(deny.stdout, '{"decision":"deny","reason":"Marrow blocked this action because required governance approval or proof is unavailable."}\n');
    assert.equal(deny.stderr, '');
    for (const mode of ['invalid', 'fail']) {
      const blocked = spawnSync(commands.BeforeTool, { shell: true, env: { ...commandEnv, FAKE_NPX_MODE: mode }, input: '{}', encoding: 'utf8' });
      assert.equal(blocked.status, 2, mode);
      assert.equal(blocked.stdout, '');
      assert.equal(blocked.stderr, 'Marrow governance adapter was unavailable; this action is blocked.\n');
      assert.doesNotMatch(blocked.stderr, /synthetic-private-launch-error/);
    }
    for (const eventName of ['AfterTool', 'AfterAgent']) {
      const neutral = spawnSync(commands[eventName], { shell: true, env: { ...commandEnv, FAKE_NPX_MODE: 'fail' }, input: '{}', encoding: 'utf8' });
      assert.equal(neutral.status, 0, neutral.stderr);
      assert.equal(neutral.stdout, '{}\n');
      assert.equal(neutral.stderr, '');
    }

    const profile = activationProfile(detection, plan, changes, 'gemini');
    assert.equal(profile.capability_level, 'native_hooks');
    assert.deepEqual(profile.expected_hooks, ['pre_action', 'action_result', 'turn_closeout']);
    assert.deepEqual(profile.observed_hooks, ['pre_action', 'action_result', 'turn_closeout']);
    assert.equal(profile.configuration_complete, true);
    assert.equal(profile.coverage_verified, false);
    assert.equal(profile.passive_live, false);
    assert.equal(profile.hooks_enabled, true);
    assert.equal(profile.explicit_disable_preserved, false);
    assert.equal(profile.session_end_delivery_claimed, false);
    assert.equal(profile.deterministic_closeout, 'AfterAgent');
    assert.match(profile.exact_fix, /Restart Gemini CLI.*\/hooks panel.*review and approve/);
    assert.doesNotMatch(profile.exact_fix, /\/hooks trust/);
    assert.equal(profile.config_fingerprint, geminiNativeHookFingerprint(settings));
    const matrix = defaultHarnessInstallMatrix(detection).find((entry) => entry.client === 'gemini');
    assert.equal(matrix.capability_level, 'native_hooks');
    assert.equal(matrix.default_install.native_hooks, true);
    assert.equal(matrix.configured_locally, true);
    assert.equal(matrix.verified_passive, false);
    assert.match(matrix.unsupported_claim, /\/hooks panel.*SessionEnd delivery is not claimed/);
    const reload = harnessReloadPlan(detection, changes);
    assert.equal(reload.clients.some((entry) => entry.client === 'gemini'), true);
    assert.match(reload.instruction, /Restart Gemini CLI.*\/hooks panel.*review and approve/);
    const capture = firstCapturePath(detection, 'gemini-agent');
    assert.equal(capture.client, 'gemini');
    assert.equal(capture.capability_level, 'native_hooks');
    assert.equal(capture.command, null);
    assert.match(capture.instruction, /BeforeTool.*AfterTool.*AfterAgent.*MCP tools remain on demand/);

    const first = fs.readFileSync(settingsPath);
    const secondPlan = buildPlan(detectEnvironment(root, { ...process.env, HOME: root }), { mode: 'mcp' });
    const secondChanges = applyPlan(secondPlan, { yes: true, dryRun: false, doctor: false });
    assert.deepEqual(fs.readFileSync(settingsPath), first);
    assert.equal(secondChanges.find((change) => change.label === 'Gemini CLI native hooks').already_present, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Grok capability recognizes only the exact global native gate and never treats configuration as observed coverage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-harness-grok-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    const hookDir = path.join(root, '.grok', 'hooks');
    const hookPath = path.join(hookDir, 'marrow.json');
    fs.mkdirSync(hookDir, { recursive: true });
    const settings = {
      owner: { retained: true },
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: GROK_CONTEXT_HOOK_COMMAND, timeout: 5 }] }],
        PreToolUse: [{ matcher: GROK_NATIVE_HOOK_MATCHER, hooks: [{ type: 'command', command: GROK_PRE_ACTION_HOOK_COMMAND, timeout: 7 }] }],
        PostToolUse: [{ matcher: GROK_NATIVE_HOOK_MATCHER, hooks: [{ type: 'command', command: GROK_ACTION_RESULT_HOOK_COMMAND, timeout: 5 }] }],
        PostToolUseFailure: [{ matcher: GROK_NATIVE_HOOK_MATCHER, hooks: [{ type: 'command', command: GROK_ACTION_RESULT_HOOK_COMMAND, timeout: 5 }] }],
        Stop: [{ hooks: [{ type: 'command', command: GROK_SESSION_END_HOOK_COMMAND, timeout: 3 }] }],
        OwnerEvent: [{ hooks: [{ type: 'command', command: 'printf owner-event' }] }],
      },
    };
    fs.writeFileSync(hookPath, JSON.stringify(settings, null, 2) + '\n');
    const detection = detectEnvironment(root, { ...process.env, HOME: root });
    assert.equal(detection.grok, true);
    assert.equal(detection.paths.grokHooks, hookPath);
    const plan = buildPlan(detection, { mode: 'mcp' });
    const profile = activationProfile(detection, plan, [], 'grok');
    assert.equal(profile.capability_level, 'native_hooks');
    assert.deepEqual(profile.expected_hooks, ['pre_action', 'action_result', 'turn_closeout']);
    assert.deepEqual(profile.observed_hooks, ['pre_action', 'action_result', 'turn_closeout']);
    assert.equal(profile.configuration_complete, true);
    assert.equal(profile.coverage_verified, false);
    assert.equal(profile.passive_live, false);
    assert.equal(profile.hooks_user_toggleable, true);
    assert.equal(profile.duplicate_session_end_configured, false);
    assert.equal(profile.deterministic_closeout, 'Stop');
    assert.equal(profile.governed_wrapper_fallback, 'explicit_bounded_only');
    assert.match(GROK_PRE_ACTION_HOOK_COMMAND, /^node -e /);
    assert.match(GROK_PRE_ACTION_HOOK_COMMAND, /setTimeout\(fail,5000\)/);
    assert.doesNotMatch(GROK_PRE_ACTION_HOOK_COMMAND, /\btimeout\b/);
    assert.match(profile.exact_fix, /Restart Grok.*\/hooks.*enabled.*does not verify observed coverage/);
    assert.equal(profile.config_fingerprint, grokNativeHookFingerprint(settings));

    const matrix = defaultHarnessInstallMatrix(detection).find((entry) => entry.client === 'grok');
    assert.equal(matrix.capability_level, 'native_hooks');
    assert.deepEqual(matrix.automatic, ['pre_action', 'action_result', 'turn_closeout']);
    assert.equal(matrix.install_surface, 'mcp');
    assert.equal(matrix.default_install.native_hooks, true);
    assert.equal(matrix.default_install.governed_wrapper, false);
    assert.equal(matrix.configured_locally, true);
    assert.equal(matrix.verified_passive, false);
    assert.match(matrix.unsupported_claim, /user-toggleable.*\/hooks inspection.*client-self-reported.*SessionEnd/);
    const reload = harnessReloadPlan(detection, [{ label: 'MCP hooks', applied: true, changed: true }]);
    assert.equal(reload.clients.some((entry) => entry.client === 'grok'), true);
    assert.match(reload.instruction, /Restart Grok.*\/hooks.*enabled/);
    const capture = firstCapturePath(detection, 'grok-agent');
    assert.equal(capture.client, 'grok');
    assert.equal(capture.capability_level, 'native_hooks');
    assert.equal(capture.command, null);
    assert.match(capture.instruction, /global native pre-action.*nonblocking Stop.*user-toggleable.*governed runner remains an explicit bounded fallback/);

    settings.hooks.SessionEnd = [{ hooks: [{ type: 'command', command: GROK_SESSION_END_HOOK_COMMAND, timeout: 3 }] }];
    fs.writeFileSync(hookPath, JSON.stringify(settings, null, 2) + '\n');
    const duplicate = activationProfile(detection, plan, [], 'grok');
    assert.equal(duplicate.configuration_complete, false);
    assert.equal(duplicate.observed_hooks.includes('turn_closeout'), false);
    assert.equal(duplicate.duplicate_session_end_configured, true);
    assert.equal(defaultHarnessInstallMatrix(detection).find((entry) => entry.client === 'grok').configured_locally, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Gemini explicit hook disablement remains owner-controlled and reports enable-all without invented trust commands', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-harness-gemini-disabled-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    fs.mkdirSync(path.join(root, '.gemini'), { recursive: true });
    const settingsPath = path.join(root, '.gemini', 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({ hooksConfig: { enabled: false, owner: 'retained' }, hooks: {} }, null, 2) + '\n');
    const detection = detectEnvironment(root, { ...process.env, HOME: root });
    const plan = buildPlan(detection, { mode: 'mcp' });
    const changes = applyPlan(plan, { yes: true, dryRun: false, doctor: false });
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.deepEqual(settings.hooksConfig, { enabled: false, owner: 'retained' });
    const profile = activationProfile(detection, plan, changes, 'gemini');
    assert.equal(profile.configuration_complete, false);
    assert.deepEqual(profile.observed_hooks, []);
    assert.equal(profile.hooks_enabled, false);
    assert.equal(profile.explicit_disable_preserved, true);
    assert.match(profile.exact_fix, /\/hooks enable-all.*\/hooks panel.*review and approve.*restart Gemini CLI/);
    assert.doesNotMatch(profile.exact_fix, /\/hooks trust/);
    assert.equal(defaultHarnessInstallMatrix(detection).find((entry) => entry.client === 'gemini').configured_locally, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Gemini hook installation rejects invalid JSON, symlink, and out-of-root targets before writes', () => {
  for (const unsafeKind of ['invalid-json', 'symlink', 'outside']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-harness-gemini-unsafe-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-harness-gemini-outside-'));
    try {
      fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
      fs.mkdirSync(path.join(root, '.gemini'), { recursive: true });
      const settingsPath = path.join(root, '.gemini', 'settings.json');
      if (unsafeKind === 'invalid-json') fs.writeFileSync(settingsPath, '{broken');
      if (unsafeKind === 'symlink') {
        fs.writeFileSync(path.join(outside, 'settings.json'), '{"owner":true}\n');
        fs.symlinkSync(path.join(outside, 'settings.json'), settingsPath);
      }
      const detection = detectEnvironment(root, { ...process.env, HOME: root });
      if (unsafeKind === 'outside') detection.paths.geminiSettings = path.join(outside, 'settings.json');
      const plan = buildPlan(detection, { mode: 'mcp' });
      assert.throws(
        () => applyPlan(plan, { yes: true, dryRun: false, doctor: false }),
        /Unexpected token|Expected property|unsafe managed target|outside project root/,
      );
      assert.equal(fs.existsSync(path.join(root, '.mcp.json')), false);
      assert.equal(fs.existsSync(path.join(root, 'AGENTS.md')), false);
      if (unsafeKind === 'invalid-json') assert.equal(fs.readFileSync(settingsPath, 'utf8'), '{broken');
      if (unsafeKind === 'symlink') assert.equal(fs.readFileSync(path.join(outside, 'settings.json'), 'utf8'), '{"owner":true}\n');
      if (unsafeKind === 'outside') assert.equal(fs.existsSync(path.join(outside, 'settings.json')), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
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
  for (const client of ['claude-code', 'cursor', 'composer', 'cline', 'windsurf', 'codex', 'opencode', 'hermes', 'openclaw', 'gemini', 'grok', 'deepseek', 'qwen', 'kimi', 'minimax', 'glm', 'custom']) {
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
    assert.equal(profile.adapter_version, '3.9.77');
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
      adapter_version: '3.9.77',
      expected_hooks: ['prompt', 'pre_action', 'action_result', 'session_end'],
      configured: {
        prompt: true,
        pre_action: true,
        action_result_success: true,
        action_result_failure: true,
        session_end: true,
      },
      descriptors: {
        prompt: [{ matcher: null, command: 'npx -y --package=@getmarrow/mcp@3.9.77 marrow-mcp context-hook', timeout: null }],
        pre_action: [{ matcher: 'Bash|Edit|Write|MultiEdit|mcp__(?!marrow_).*', command: 'npx -y --package=@getmarrow/mcp@3.9.77 marrow-mcp pre-action-hook', timeout: null }],
        action_result_success: [{ matcher: 'Bash|Edit|Write|MultiEdit|mcp__(?!marrow_).*', command: 'npx -y --package=@getmarrow/mcp@3.9.77 marrow-mcp hook', timeout: null }],
        action_result_failure: [{ matcher: 'Bash|Edit|Write|MultiEdit|mcp__(?!marrow_).*', command: 'npx -y --package=@getmarrow/mcp@3.9.77 marrow-mcp hook', timeout: null }],
        session_end: [{ matcher: null, command: 'npx -y --package=@getmarrow/mcp@3.9.77 marrow-mcp session-hook', timeout: null }],
      },
      active_marrow_handlers: {
        prompt: [{ matcher: null, command: 'npx -y --package=@getmarrow/mcp@3.9.77 marrow-mcp context-hook', timeout: null }],
        pre_action: [{ matcher: 'Bash|Edit|Write|MultiEdit|mcp__(?!marrow_).*', command: 'npx -y --package=@getmarrow/mcp@3.9.77 marrow-mcp pre-action-hook', timeout: null }],
        action_result_success: [{ matcher: 'Bash|Edit|Write|MultiEdit|mcp__(?!marrow_).*', command: 'npx -y --package=@getmarrow/mcp@3.9.77 marrow-mcp hook', timeout: null }],
        action_result_failure: [{ matcher: 'Bash|Edit|Write|MultiEdit|mcp__(?!marrow_).*', command: 'npx -y --package=@getmarrow/mcp@3.9.77 marrow-mcp hook', timeout: null }],
        session_end: [{ matcher: null, command: 'npx -y --package=@getmarrow/mcp@3.9.77 marrow-mcp session-hook', timeout: null }],
      },
    })).digest('hex');
    assert.equal(profile.config_fingerprint, canonicalFingerprint);
    assert.equal(claudeNativeHookFingerprint(parsedSettings), canonicalFingerprint);
    assert.match(settings, /context-hook/);
    assert.match(settings, /pre-action-hook/);
    assert.match(settings, /PostToolUseFailure/);
    assert.match(settings, /session-hook/);
    assert.match(settings, /getmarrow\/mcp@3\.9\.77.*marrow-mcp hook/);
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
    assert.ok(commandCounts.every((hook) => hook.command.includes('@getmarrow/mcp@3.9.77')));
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
      assert.match(hook.command, /@getmarrow\/mcp@3\.9\.77/);
      return hook;
    };
    exact('UserPromptSubmit', 'codex-context-hook', null, 5);
    const preAction = exact('PreToolUse', 'codex-pre-action-hook', CODEX_NATIVE_HOOK_MATCHER, 5);
    assert.equal(preAction.async, false);
    exact('PostToolUse', 'codex-hook', CODEX_NATIVE_HOOK_MATCHER, 5);
    exact('SessionEnd', 'codex-session-hook', null, 3);
    assert.equal(settings.hooks.PostToolUseFailure, undefined);
    assert.equal(profile.capability_level, 'native_hooks');
    assert.equal(profile.adapter_version, '3.9.77');
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

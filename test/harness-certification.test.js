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
  detectEnvironment,
} = require('../src/installer');

test('capability registry certifies every advertised harness without overstating automatic coverage', () => {
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

test('Claude native-hook activation certifies pre-action, result, and session-end coverage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-harness-cert-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Claude\n');
    const detection = detectEnvironment(root, { ...process.env, HOME: root });
    const plan = buildPlan(detection, { mode: 'both' });
    const changes = applyPlan(plan, { yes: true, dryRun: false, doctor: false });
    const profile = activationProfile(detection, plan, changes, 'claude-code');
    assert.equal(profile.capability_level, 'native_hooks');
    assert.equal(profile.adapter_version, '3.9.50');
    assert.deepEqual(profile.expected_hooks, ['prompt', 'pre_action', 'action_result', 'session_end']);
    assert.deepEqual(profile.observed_hooks.sort(), ['action_result', 'pre_action', 'prompt', 'session_end'].sort());
    assert.equal(profile.complete, true);
    assert.match(profile.config_fingerprint, /^[a-f0-9]{64}$/);
    const settings = fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8');
    const parsedSettings = JSON.parse(settings);
    const canonicalFingerprint = crypto.createHash('sha256').update(JSON.stringify({
      schema: 'marrow-claude-native-hooks.v3',
      adapter_version: '3.9.50',
      expected_hooks: ['prompt', 'pre_action', 'action_result', 'session_end'],
      configured: {
        prompt: true,
        pre_action: true,
        action_result_success: true,
        action_result_failure: true,
        session_end: true,
      },
      descriptors: {
        prompt: [{ matcher: null, command: 'npx -y @getmarrow/mcp@3.9.50 context-hook', timeout: null }],
        pre_action: [{ matcher: 'Bash|Edit|Write|MultiEdit|mcp__(?!marrow_).*', command: 'npx -y @getmarrow/mcp@3.9.50 pre-action-hook', timeout: null }],
        action_result_success: [{ matcher: 'Bash|Edit|Write|MultiEdit|mcp__(?!marrow_).*', command: 'npx -y @getmarrow/mcp@3.9.50 hook', timeout: null }],
        action_result_failure: [{ matcher: 'Bash|Edit|Write|MultiEdit|mcp__(?!marrow_).*', command: 'npx -y @getmarrow/mcp@3.9.50 hook', timeout: null }],
        session_end: [{ matcher: null, command: 'npx -y @getmarrow/mcp@3.9.50 session-hook', timeout: null }],
      },
    })).digest('hex');
    assert.equal(profile.config_fingerprint, canonicalFingerprint);
    assert.equal(claudeNativeHookFingerprint(parsedSettings), canonicalFingerprint);
    assert.match(settings, /context-hook/);
    assert.match(settings, /pre-action-hook/);
    assert.match(settings, /PostToolUseFailure/);
    assert.match(settings, /session-hook/);
    assert.match(settings, /getmarrow\/mcp@3\.9\.50 hook/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Codex activation does not claim SDK capture when SDK is absent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-harness-codex-'));
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Agents\n');
    const detection = detectEnvironment(root, { ...process.env, HOME: root });
    const plan = buildPlan(detection, { mode: 'both' });
    const changes = applyPlan(plan, { yes: true, dryRun: false, doctor: false });
    const profile = activationProfile(detection, plan, changes, 'codex');

    assert.equal(profile.capability_level, 'governed_wrapper');
    assert.deepEqual(profile.expected_hooks, ['pre_action', 'action_result', 'outcome_closure']);
    assert.deepEqual(profile.observed_hooks, []);
    assert.equal(profile.complete, false);
    assert.match(profile.exact_fix, /install run --agent/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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

    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { '@getmarrow/sdk': '^3.7.49' } }));
    const moduleDir = path.join(root, 'node_modules', '@getmarrow', 'sdk');
    fs.mkdirSync(moduleDir, { recursive: true });
    fs.writeFileSync(path.join(moduleDir, 'package.json'), JSON.stringify({ name: '@getmarrow/sdk', version: '3.7.49' }));
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

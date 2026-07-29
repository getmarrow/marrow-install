const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  HARNESS_CAPABILITY_REGISTRY,
  activationProfile,
  applyPlan,
  buildPlan,
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
    if (entry.capability_level === 'event_contract' && entry.client === 'custom') assert.equal(entry.automatic.length, 0);
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
    assert.deepEqual(profile.expected_hooks, ['pre_action', 'action_result', 'session_end']);
    assert.deepEqual(profile.observed_hooks.sort(), ['action_result', 'outcome_closure', 'pre_action', 'session_end'].sort());
    assert.equal(profile.complete, true);
    assert.match(profile.config_fingerprint, /^[a-f0-9]{64}$/);
    const settings = fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8');
    assert.match(settings, /context-hook/);
    assert.match(settings, /session-hook/);
    assert.match(settings, /getmarrow\/mcp hook/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

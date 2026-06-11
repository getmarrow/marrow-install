const assert = require('node:assert/strict');
const test = require('node:test');

const {
  gateDecision,
  governPanel,
  inferSurfaces,
  inferType,
  parseArgs,
  redact,
  redactedCommand,
  shouldBlock,
} = require('../src/governed-runner');

test('parseArgs supports governed command execution after --', () => {
  const parsed = parseArgs([
    'run',
    '--agent',
    'deploy-agent',
    '--type',
    'deploy',
    '--policy',
    'enforce',
    '--',
    'wrangler',
    'deploy',
  ]);

  assert.equal(parsed.command, 'run');
  assert.equal(parsed.options.agentId, 'deploy-agent');
  assert.equal(parsed.options.type, 'deploy');
  assert.equal(parsed.options.policy, 'enforce');
  assert.deepEqual(parsed.childCommand, ['wrangler', 'deploy']);
});

test('redacts API keys and tokens from command text', () => {
  const value = redact('MARROW_API_KEY=mrw_live_secret npm_token=npm_abcdef ghp_deadbeef sk-test');
  assert.doesNotMatch(value, /mrw_live_secret/);
  assert.doesNotMatch(value, /npm_abcdef/);
  assert.doesNotMatch(value, /ghp_deadbeef/);
  assert.doesNotMatch(value, /sk-test/);

  const command = redactedCommand(['curl', '-H', 'Authorization: Bearer mrw_live_secret', 'https://api.getmarrow.ai']);
  assert.doesNotMatch(command, /mrw_live_secret/);
  assert.match(command, /\[redacted\]/);
});

test('infers type and surfaces for common risky actions', () => {
  assert.equal(inferType('wrangler deploy production worker'), 'deploy');
  assert.equal(inferType('npm publish @getmarrow/sdk'), 'publish');
  assert.equal(inferType('gh pr merge 12'), 'merge');
  assert.deepEqual(inferSurfaces('wrangler deploy after gh pr merge'), ['github', 'cloudflare']);
});

test('gateDecision extracts receipt and shouldBlock enforces owner approval', () => {
  const runtime = {
    risk_gate: {
      enforcement_decision: 'owner_approval_required',
      allow: true,
      gate_receipt_id: 'gate_123',
    },
    gate_receipt: {
      id: 'gate_123',
      required: true,
      owner_approval_required: true,
      exact_fix: 'Get owner approval before deploy.',
    },
  };
  const decision = gateDecision(runtime);
  assert.equal(decision.receiptId, 'gate_123');
  assert.equal(decision.ownerApprovalRequired, true);
  assert.equal(shouldBlock(decision, { policy: 'enforce', ownerApproval: '' }), true);
  assert.equal(shouldBlock(decision, { policy: 'enforce', ownerApproval: 'buu-approved' }), false);
  assert.equal(shouldBlock(decision, { policy: 'warn', ownerApproval: '' }), false);
});

test('governPanel presents harness selection without becoming a model host', () => {
  const panel = governPanel({ agentId: 'codex-bob', profile: 'production', policy: 'enforce' });
  assert.match(panel, /Marrow Governed Runner/);
  assert.match(panel, /Codex/);
  assert.match(panel, /Claude Code/);
  assert.match(panel, /Custom command/);
  assert.match(panel, /Marrow governs the action before it executes/);
  assert.match(panel, /npx @getmarrow\/install run --agent codex-bob/);
});

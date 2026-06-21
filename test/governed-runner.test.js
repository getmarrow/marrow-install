const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const test = require('node:test');

const {
  gateDecision,
  governPanel,
  buildGovernState,
  buildFleetState,
  canUseInteractive,
  commandForSelection,
  detectProjectSignals,
  fleetPanel,
  inferSurfaces,
  inferType,
  normalizeFleetSnapshot,
  parseArgs,
  redact,
  redactedCommand,
  renderFleetTui,
  renderGovernTui,
  runGovernInteractive,
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
  assert.match(panel, /Cursor/);
  assert.match(panel, /CI script/);
  assert.match(panel, /Custom command/);
  assert.match(panel, /Marrow governs the action before it executes/);
  assert.match(panel, /npx @getmarrow\/install run --agent codex-bob/);
});

test('detectProjectSignals finds deploy and Cloudflare project evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-govern-signals-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'marrow-api',
    scripts: { deploy: 'wrangler deploy', test: 'vitest run' },
    devDependencies: { wrangler: '^4.0.0' },
  }));
  fs.writeFileSync(path.join(dir, 'wrangler.toml'), 'name = "marrow-api"\n');
  fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });

  const signals = detectProjectSignals(dir);
  assert.equal(signals.name, 'marrow-api');
  assert.equal(signals.type, 'node');
  assert.ok(signals.frameworks.includes('cloudflare-workers'));
  assert.ok(signals.signals.includes('package_json'));
  assert.ok(signals.signals.includes('wrangler_config'));
  assert.ok(signals.signals.includes('github_actions'));
  assert.ok(signals.signals.includes('script:deploy'));
});

test('govern interactive options are parsed and non-tty stays text-safe', () => {
  const interactive = parseArgs(['govern', '--interactive']);
  assert.equal(interactive.options.interactive, true);

  const nonInteractive = parseArgs(['govern', '--no-interactive']);
  assert.equal(nonInteractive.options.interactive, false);

  assert.equal(canUseInteractive({ interactive: false }, { isTTY: true }, { isTTY: true }), false);
  assert.equal(canUseInteractive({ interactive: true }, { isTTY: false }, { isTTY: true }), false);
  assert.equal(canUseInteractive({ interactive: null }, { isTTY: true }, { isTTY: true }), true);
});

test('fleet command parses operator TUI options', () => {
  const parsed = parseArgs(['fleet', '--no-interactive', '--json']);
  assert.equal(parsed.command, 'fleet');
  assert.equal(parsed.options.interactive, false);
  assert.equal(parsed.options.json, true);
});

test('fleet panel summarizes operator-critical account state', () => {
  const snapshot = normalizeFleetSnapshot({
    status: {
      ok: true,
      data: {
        active_workflow_count: 4,
        proof_pack_hygiene: { incomplete: 2 },
        auto_outcome_closure: { status: 'degraded', stale: 1, exact_fix: 'npx @getmarrow/install --repair' },
        missed_hooks: ['command_outcome'],
        deploy_gate: { status: 'enforce' },
        publish_gate: { status: 'warn' },
        merge_gate: { status: 'enforce' },
        recent_decisions: [{ action: 'deploy worker after smoke test' }],
      },
    },
    capacity: {
      ok: true,
      data: {
        current_backpressure: { status: 'ok' },
        exact_next_action: 'Batch low-risk telemetry; keep high-risk gates live.',
      },
    },
    report: {
      ok: true,
      data: {
        agents: [
          { id: 'jarvis', role: 'release', status: 'active', last_seen_at: '2026-06-21T00:00:00Z' },
          { id: 'barvis', role: 'security', status: 'active' },
        ],
      },
    },
    fleet: { ok: true, data: { live_agent_count: 2 } },
  }, {
    agentId: 'codex-bob',
    baseUrl: 'https://api.getmarrow.ai',
  });

  const panel = fleetPanel(snapshot);
  assert.match(panel, /Marrow Fleet Operator/);
  assert.match(panel, /Live agents: 2/);
  assert.match(panel, /Active workflows: 4/);
  assert.match(panel, /Risky actions waiting for proof: 2/);
  assert.match(panel, /Failed\/stale outcomes: 1/);
  assert.match(panel, /Backpressure\/capacity status: ok/);
  assert.match(panel, /Recent decisions:/);
  assert.match(panel, /Degraded hooks: command_outcome/);
  assert.match(panel, /Deploy\/publish\/merge gates: deploy=enforce publish=warn merge=enforce/);
  assert.match(panel, /Press Enter to inspect agent/);
  assert.match(panel, /Copy exact fix command:/);
  assert.match(panel, /npx @getmarrow\/install --repair/);
});

test('fleet TUI render exposes inspection and fix-command rows', () => {
  const snapshot = normalizeFleetSnapshot({
    status: {
      ok: true,
      data: {
        active_workflow_count: 1,
        recent_decisions: ['blocked publish until npm proof was complete'],
        missed_hooks: [],
        deploy_gate: 'enforce',
        publish_gate: 'enforce',
        merge_gate: 'warn',
      },
    },
    capacity: { ok: true, data: { backpressure: { status: 'ok' } } },
    report: { ok: true, data: { agents: [{ id: 'codex-bob', status: 'active' }] } },
    fleet: { ok: true, data: { live_agent_count: 1 } },
  }, {
    agentId: 'codex-bob',
    baseUrl: 'https://api.getmarrow.ai',
  });
  const state = buildFleetState(snapshot);
  const screen = renderFleetTui(state);

  assert.match(screen, /Marrow Fleet Operator/);
  assert.match(screen, /\[Live agents\]/);
  assert.match(screen, /\[Active workflows\]/);
  assert.match(screen, /\[Risky actions waiting for proof\]/);
  assert.match(screen, /\[Failed\/stale outcomes\]/);
  assert.match(screen, /\[Backpressure \/ capacity\]/);
  assert.match(screen, /\[Recent decisions\]/);
  assert.match(screen, /\[Degraded hooks\]/);
  assert.match(screen, /\[Deploy\/publish\/merge gates\]/);
  assert.match(screen, /\[Inspect agent\]/);
  assert.match(screen, /\[Copy exact fix command\]/);
  assert.match(screen, /Press Enter to inspect agent/);
});

test('govern TUI render shows passive and governed commands', () => {
  const options = {
    agentId: 'codex-bob',
    profile: 'production',
    policy: 'enforce',
    apiKey: 'mrw_live_placeholder',
  };
  const state = buildGovernState(options, process.cwd());
  state.recommendation = {
    recommended_mode: 'pilot',
    confidence: 0.82,
    reasons: ['Cloudflare Worker detected', 'No owner approval policy configured yet'],
  };
  const passiveCommand = commandForSelection(state, options);
  assert.match(passiveCommand, /npx @getmarrow\/install --yes/);

  state.modeIndex = 2;
  const governedCommand = commandForSelection(state, options);
  assert.match(governedCommand, /npx @getmarrow\/install run --agent codex-bob/);
  assert.match(governedCommand, /--policy enforce/);

  const screen = renderGovernTui(state, options);
  assert.match(screen, /Marrow Governed Setup/);
  assert.match(screen, /Exit: q, Esc, or Ctrl\+C/);
  assert.match(screen, /\[Run passive setup \+ self-test\]/);
  assert.match(screen, /\[Test before-action gate\]/);
  assert.match(screen, /\[Exit\]/);
  assert.match(screen, /Return to shell/);
  assert.match(screen, /Recommended command:/);
  assert.match(screen, /Recommended mode: pilot/);
  assert.match(screen, /Cloudflare Worker detected/);
});

test('govern generated commands shell-quote dynamic arguments', () => {
  const options = {
    agentId: 'codex; echo injected',
    profile: 'prod $(whoami)',
    policy: 'enforce',
    apiKey: '',
  };
  const state = buildGovernState(options, process.cwd());
  state.modeIndex = 2;

  const command = commandForSelection(state, options);
  assert.match(command, /--agent 'codex; echo injected'/);
  assert.match(command, /--profile 'prod \$\(whoami\)'/);
  assert.doesNotMatch(command, /--agent codex; echo injected --profile prod \$\(whoami\)/);

  state.harnessIndex = state.harnesses.findIndex((harness) => harness.name === 'Custom command');
  const customCommand = commandForSelection(state, options);
  assert.match(customCommand, /-- '<your-command>'$/);
});

test('govern generated commands strip terminal control characters from display args', () => {
  const options = {
    agentId: `codex${String.fromCharCode(27)}[31m-red\nnext${String.fromCharCode(0x9d)}0;c1${String.fromCharCode(0x9c)}`,
    profile: `prod\tstage${String.fromCharCode(27)}]0;bad${String.fromCharCode(7)}${String.fromCharCode(0x9d)}1;c1${String.fromCharCode(0x9c)}`,
    policy: 'enforce',
    apiKey: '',
  };
  const state = buildGovernState(options, process.cwd());
  state.modeIndex = 2;

  const command = commandForSelection(state, options);
  assert.doesNotMatch(command, /[\x00-\x1f\x7f-\x9f]/);
  assert.match(command, /--agent 'codex-red next'/);
  assert.match(command, /--profile 'prod stage'/);
});

test('govern rendered output strips terminal control characters', () => {
  const options = {
    agentId: `codex${String.fromCharCode(27)}[31m-red${String.fromCharCode(0x9d)}0;bad${String.fromCharCode(7)}`,
    profile: `prod${String.fromCharCode(27)}]0;bad${String.fromCharCode(7)}${String.fromCharCode(0x9d)}1;c1${String.fromCharCode(0x9c)}`,
    policy: 'enforce',
    apiKey: '',
  };
  const state = buildGovernState(options, process.cwd());
  state.modeIndex = 2;

  const interactive = renderGovernTui(state, options);
  const panel = governPanel(options);
  assert.doesNotMatch(interactive, /[\x07\x9c\x9d]/);
  assert.doesNotMatch(panel, /[\x1b\x07\x9b-\x9d]/);

  const recommended = interactive.split('Recommended command:')[1];
  assert.doesNotMatch(recommended, /[\x1b\x07\x9b-\x9d]/);
  assert.match(panel, /Agent:\s+codex-red/);
  assert.match(panel, /--agent codex-red/);
});

test('govern TUI exit row does not redraw after cleanup', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};

  let output = '';
  const stdout = new Writable({
    write(chunk, encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  stdout.isTTY = true;

  const run = runGovernInteractive({
    agentId: 'codex-bob',
    profile: 'production',
    policy: 'enforce',
    apiKey: '',
    interactive: true,
  }, input, stdout);

  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 6; i += 1) input.emit('keypress', '', { name: 'down' });
  input.emit('keypress', '', { name: 'return' });
  await run;

  const afterCursorRestore = output.slice(output.lastIndexOf('\x1b[?25h') + '\x1b[?25h'.length);
  assert.doesNotMatch(afterCursorRestore, /Marrow Governed Setup/);
});

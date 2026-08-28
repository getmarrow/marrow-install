const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const control = require('../src/control-state');
const runner = require('../src/governed-runner');

function tempHome() { return fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-owner-control-')); }

test('owner control requires confirmation and disable/enable are byte-idempotent private atomic writes', async () => {
  const home = tempHome();
  assert.deepEqual(control.readLocalControlState({ home }), { enabled: true, state: 'default_enabled', changed_at: null });
  await assert.rejects(control.runControlCli(['control', 'disable'], { home }), /requires --yes/);
  assert.equal(fs.existsSync(path.join(home, '.marrow')), false);
  const disabled = await control.runControlCli(['control', 'disable', '--yes'], { home });
  assert.equal(disabled.state, 'disabled');
  const target = path.join(home, '.marrow', 'control.json');
  assert.equal(fs.statSync(path.dirname(target)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(target).mode & 0o777, 0o600);
  const before = fs.readFileSync(target);
  const repeat = await control.runControlCli(['control', 'disable', '--yes'], { home });
  assert.equal(repeat.changed, false); assert.deepEqual(fs.readFileSync(target), before);
  const enabled = await control.runControlCli(['control', 'enable'], { home });
  assert.equal(enabled.state, 'enabled');
});

test('owner state refuses malformed, broad, oversized and symlinked paths', () => {
  for (const kind of ['malformed', 'broad', 'oversized']) {
    const home = tempHome(); const directory = path.join(home, '.marrow'); fs.mkdirSync(directory, { mode: 0o700 });
    const target = path.join(directory, 'control.json'); fs.writeFileSync(target, kind === 'oversized' ? 'x'.repeat(5000) : kind === 'malformed' ? '{}' : JSON.stringify({}), { mode: 0o600 });
    if (kind === 'broad') fs.chmodSync(target, 0o644);
    assert.throws(() => control.readLocalControlState({ home }), /unsafe/);
  }
  const outside = tempHome(); const home = tempHome(); fs.symlinkSync(outside, path.join(home, '.marrow'));
  assert.throws(() => control.writeLocalControlState(false, { home }), /unsafe/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('governed disabled run bypasses remote gate without permit environment', async () => {
  const home = tempHome(); control.writeLocalControlState(false, { home });
  const parsed = runner.parseArgs(['run', '--agent', 'fixture', '--type', 'deploy', '--', process.execPath, '-e', 'process.exit(process.env.MARROW_ACTION_PERMIT?9:0)']);
  const result = await runner.runGoverned(parsed, { controlStateOptions: { home }, stdout: { write() {} } });
  assert.equal(result.local_control, 'owner_disabled'); assert.equal(result.bypass_recorded, true); assert.equal(result.decision, null); assert.equal(result.permit_id, null); assert.equal(result.exitCode, 0);
  const ledger = JSON.parse(fs.readFileSync(path.join(home, '.marrow', control.CONTROL_BYPASS_LEDGER_FILENAME), 'utf8'));
  assert.equal(ledger.length, 1); assert.equal(ledger[0].action, control.CONTROL_BYPASS_ACTION); assert.equal(ledger[0].intervention_disposition, 'overridden'); assert.equal(ledger[0].action_changed, false);
  assert.doesNotMatch(JSON.stringify(ledger), /MARROW_ACTION_PERMIT|process\.exit|fixture-key/);
});

test('lifecycle request uses integration events contract and separates state-change from bypass fields', async () => {
  const originalFetch = global.fetch; const calls = [];
  global.fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true }; };
  try {
    await control.bestEffortLifecycle({ event_type: 'journey_update', action: 'local control disabled', source: 'client_self_reported', harness: 'installer', agent_id: 'owner', correlation_id: 'ctl_fixture' }, { apiKey: 'fixture-key', baseUrl: 'https://api.example.test' });
    assert.equal(calls[0].url, 'https://api.example.test/v1/agent/integrations/events');
    assert.equal(calls[0].body.harness, 'installer'); assert.equal(calls[0].body.agent_id, 'owner');
    assert.equal('intervention_disposition' in calls[0].body, false); assert.equal('action_changed' in calls[0].body, false);
    const home = tempHome(); const bypass = await control.recordGovernedBypass({ harness: 'codex', agentId: 'owner', surfaces: ['production'], risk: 'high' }, { home, apiKey: 'fixture-key', baseUrl: 'https://api.example.test' });
    assert.equal(bypass.bypass_recorded, true); assert.equal(bypass.remote_delivered, true);
    assert.equal(calls[1].body.intervention_disposition, 'overridden'); assert.equal(calls[1].body.action_changed, false);
  } finally { global.fetch = originalFetch; }
});

test('installer and MCP parity constants plus disabled controller suppression stay explicit', () => {
  const installer = fs.readFileSync(path.join(__dirname, '..', 'src', 'installer.js'), 'utf8');
  assert.match(installer, /&& localControl\.enabled/);
  assert.match(installer, /local_control: localControl/);
  assert.equal(control.CONTROL_STATE_VERSION, 1);
  assert.equal(control.CONTROL_STATE_DIRECTORY, '.marrow');
  assert.equal(control.CONTROL_STATE_FILENAME, 'control.json');
  assert.equal(control.CONTROL_BYPASS_ACTION, 'protected action bypassed while local control disabled');
});

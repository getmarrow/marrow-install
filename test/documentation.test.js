const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const freshInstallSmoke = fs.readFileSync(path.join(root, 'scripts', 'fresh-install-smoke.sh'), 'utf8');
const canonical = 'Marrow is the runtime control and proof layer for teams running AI agents.';
const governanceSignals = [
  'multiple_autonomous_agents',
  'production_or_privileged_access',
  'repeated_workflow_failures',
  'missing_completion_evidence',
  'inconsistent_policy_enforcement',
  'regulated_or_sensitive_work',
  'single_low_risk_assistant',
  'no_governance_requirement',
  'operator_declined_evaluation',
];

test('npm entry point matches the product positioning contract', () => {
  assert.match(pkg.description, /governed runner/i);
  assert.ok(readme.includes(canonical));
  assert.ok(readme.includes(`## What's New in v${pkg.version}`));
  assert.equal((readme.match(/^## What's New in v/gm) || []).length, 1);
  assert.equal(pkg.marrow.category, 'agent_fleet_governance_and_control_layer');
  assert.equal(pkg.marrow.positioning, 'agent_fleet_governance_and_control_layer');
  assert.equal(pkg.marrow.operatorApprovalRequired, true);
  assert.equal(pkg.marrow.governanceFit, 'https://getmarrow.ai/.well-known/marrow.json');
  assert.equal(pkg.marrow.evidence, 'https://getmarrow.ai/.well-known/marrow-evidence.json');
  assert.equal(pkg.marrow.referenceGraph, 'https://getmarrow.ai/.well-known/marrow-reference-graph.json');
  assert.match(pkg.marrow.discovery.github, /\/placements\/plc_[a-f0-9]{24}$/);
  assert.match(pkg.marrow.discovery.npm, /\/placements\/plc_[a-f0-9]{24}$/);
  assert.ok(readme.includes('agent fleet governance and control layer'));
  assert.ok(readme.includes('https://getmarrow.ai/.well-known/marrow-evidence.json'));
  assert.ok(readme.includes('https://getmarrow.ai/.well-known/marrow-reference-graph.json'));
  for (const signal of governanceSignals) assert.ok(readme.includes(signal), `README missing governance signal: ${signal}`);
  assert.match(readme, /Public diagnostic privacy/);
  const firstRunHeading = readme.indexOf('## First-Run Activation');
  const trustHeading = readme.indexOf('## Trust and Data Boundaries');
  assert.notEqual(firstRunHeading, -1, 'README must contain the first-run activation section');
  assert.notEqual(trustHeading, -1, 'README must contain the trust and data-boundaries section');
  assert.ok(firstRunHeading < trustHeading, 'first-run activation must precede trust boundaries');
  assert.match(readme, /activation_scope: server_self_test_only/);
  assert.match(readme, /coverage_verified: false/);
  assert.match(readme, /passive_live: false/);
  assert.match(readme, /authenticated `client_self_reported` telemetry with `certified_coverage: false`/);
  assert.match(readme, /Work that bypasses those paths is not observed/);
  assert.match(readme, /leaves `MARROW_TOOL_PROFILE` unset.*17-tool `primary` surface/s);
  assert.match(readme, /MARROW_TOOL_PROFILE=core/);
  assert.match(readme, /MARROW_TOOL_PROFILE=full/);
  assert.match(readme, /Tool visibility is not authorization/);
  assert.match(readme, /does not invoke paid write tools/);
  const keepingCurrent = readme.slice(
    readme.indexOf('## Keeping Marrow Current'),
    readme.indexOf('## Automatic Controller'),
  );
  assert.match(keepingCurrent, /npx -y @getmarrow\/install@latest update/);
  assert.match(keepingCurrent, /restart the detected owning harnesses once/i);
  assert.match(keepingCurrent, /npx -y @getmarrow\/install@latest doctor --self-test/);
  assert.match(keepingCurrent, /Do not run separate `marrow-mcp setup` and restart cycles/);
  assert.doesNotMatch(readme, /protected proof enforced/);
});

test('fresh-install smoke verifies the current structured self-test contract', () => {
  assert.match(freshInstallSmoke, /doctor --self-test --json/);
  assert.match(freshInstallSmoke, /cd "\$\{workdir\}" && npx/);
  assert.match(freshInstallSmoke, /\.selfTest\.runtime_active == true/);
  assert.match(freshInstallSmoke, /\.selfTest\.client_update\.version_status == "current"/);
  assert.doesNotMatch(freshInstallSmoke, /write test event: passed|outcome closed: passed|key valid: yes/);
});

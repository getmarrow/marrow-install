const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildPlan,
  detectEnvironment,
  install,
  inspectPackageVersions,
  inspectNpmTokenConfig,
  parseArgs,
  passiveRuntimeSource,
  runDoctorValidation,
  runSelfTest,
} = require('../src/installer');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-install-'));
}

test('parseArgs defaults to dry-run unless --yes is passed', () => {
  const dry = parseArgs(['--mcp']);
  assert.equal(dry.mode, 'mcp');
  assert.equal(dry.yes, false);

  const write = parseArgs(['--yes', '--sdk', '--agent-id', 'codex']);
  assert.equal(write.mode, 'sdk');
  assert.equal(write.yes, true);
  assert.equal(write.agentId, 'codex');

  const doctor = parseArgs(['doctor']);
  assert.equal(doctor.doctor, true);

  const repair = parseArgs(['--repair']);
  assert.equal(repair.repair, true);
  assert.equal(repair.yes, true);
});

test('parseArgs marks --key for process-list warning', () => {
  const opts = parseArgs(['--key', 'mrw_live_test']);
  assert.equal(opts.apiKey, 'mrw_live_test');
  assert.equal(opts.keyFromArg, true);
});

test('detectEnvironment finds Node, Claude, Codex, Cursor, and MCP targets', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agents\n');
  fs.writeFileSync(path.join(dir, '.mcp.json'), '{}');
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), '{}');
  fs.mkdirSync(path.join(dir, '.cursor'), { recursive: true });

  const detected = detectEnvironment(dir, {});
  assert.equal(detected.node, true);
  assert.equal(detected.claudeCode, true);
  assert.equal(detected.codex, true);
  assert.equal(detected.cursor, true);
  assert.equal(detected.mcpConfig, true);
});

test('buildPlan chooses both mode for Node agent projects', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agents\n');
  const detected = detectEnvironment(dir, {});
  const plan = buildPlan(detected, { mode: 'auto' });

  assert.equal(plan.mode, 'both');
  assert.ok(plan.writes.some((w) => w.path.endsWith('.marrow/passive-runtime.mjs')));
  assert.ok(plan.writes.some((w) => w.path.endsWith('AGENTS.md')));
});

test('install dry-run does not write files', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  const report = await install({
    cwd: dir,
    mode: 'sdk',
    yes: false,
    dryRun: true,
    selfTest: false,
    apiKey: '',
    baseUrl: 'https://api.getmarrow.ai',
    agentId: '',
  });

  assert.equal(report.writeMode, 'dry-run');
  assert.equal(fs.existsSync(path.join(dir, '.marrow', 'passive-runtime.mjs')), false);
});

test('install --yes writes passive runtime and instructions idempotently', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agents\n');
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), '{}');

  const options = {
    cwd: dir,
    mode: 'both',
    yes: true,
    dryRun: false,
    selfTest: false,
    apiKey: '',
    baseUrl: 'https://api.getmarrow.ai',
    agentId: '',
  };
  await install(options);
  await install(options);

  const runtime = fs.readFileSync(path.join(dir, '.marrow', 'passive-runtime.mjs'), 'utf8');
  const agents = fs.readFileSync(path.join(dir, 'AGENTS.md'), 'utf8');
  const settings = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'settings.json'), 'utf8'));

  assert.match(runtime, /createPassiveRuntime/);
  assert.match(runtime, /useAgentRuntime/);
  assert.match(runtime, /useWorkflowGate/);
  assert.match(runtime, /requireOutcomeClosure/);
  assert.match(runtime, /MARROW_PASSIVE_VALUE_REPORT !== 'false'/);
  assert.equal((agents.match(/marrow:passive-start/g) || []).length, 1);
  assert.ok(settings.hooks.PostToolUse);
  assert.ok(settings.hooks.UserPromptSubmit);
});

test('doctor detects npm token config mismatches without leaking token values', async () => {
  const dir = tempDir();
  const home = tempDir();
  fs.mkdirSync(path.join(home, '.openclaw', 'credentials'), { recursive: true });
  fs.writeFileSync(path.join(home, '.openclaw', '.env'), 'NPM_TOKEN=npm_new_secret_123456789\n');
  fs.writeFileSync(path.join(home, '.npmrc'), '//registry.npmjs.org/:_authToken=npm_old_secret_123456789\n', { mode: 0o600 });

  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const report = await install({
      cwd: dir,
      mode: 'md',
      yes: false,
      dryRun: true,
      doctor: true,
      selfTest: false,
      apiKey: 'mrw_test_key',
      baseUrl: 'https://api.getmarrow.ai',
      agentId: '',
    });

    const text = JSON.stringify(report);
    assert.equal(report.configDiagnostics.npm_token.mismatch, true);
    assert.equal(report.configDiagnostics.npm_token.repairable, true);
    assert.doesNotMatch(text, /npm_new_secret|npm_old_secret/);
    assert.match(report.doctor.recommendedFix, /--repair/);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test('repair syncs npmrc token from active OpenClaw token source', async () => {
  const dir = tempDir();
  const home = tempDir();
  fs.mkdirSync(path.join(home, '.openclaw'), { recursive: true });
  fs.writeFileSync(path.join(home, '.openclaw', '.env'), 'NPM_TOKEN=npm_new_secret_123456789\n');
  fs.writeFileSync(path.join(home, '.npmrc'), 'prefix=/tmp/npm\n//registry.npmjs.org/:_authToken=npm_old_secret_123456789\n', { mode: 0o600 });
  fs.chmodSync(path.join(home, '.npmrc'), 0o644);

  const originalHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const report = await install({
      cwd: dir,
      mode: 'md',
      yes: true,
      repair: true,
      dryRun: false,
      selfTest: false,
      apiKey: 'mrw_test_key',
      baseUrl: 'https://api.getmarrow.ai',
      agentId: '',
    });
    const npmrc = fs.readFileSync(path.join(home, '.npmrc'), 'utf8');
    const npmrcMode = fs.statSync(path.join(home, '.npmrc')).mode & 0o777;
    const backupMode = fs.statSync(path.join(home, '.npmrc.marrow-backup')).mode & 0o777;
    const diagnostics = inspectNpmTokenConfig();

    assert.equal(report.configRepairs[0].type, 'npm_token_npmrc_sync');
    assert.equal(report.configRepairs[0].changed, true);
    assert.match(npmrc, /prefix=\/tmp\/npm/);
    assert.match(npmrc, /npm_new_secret_123456789/);
    assert.equal(npmrcMode, 0o600);
    assert.equal(backupMode, 0o600);
    assert.equal(diagnostics.safe.npm_token.mismatch, false);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test('repair dry-run remains dry-run and does not write files', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');

  const report = await install({
    cwd: dir,
    mode: 'sdk',
    yes: true,
    repair: true,
    dryRun: true,
    selfTest: false,
    apiKey: '',
    baseUrl: 'https://api.getmarrow.ai',
    agentId: '',
  });

  assert.equal(report.writeMode, 'dry-run');
  assert.equal(fs.existsSync(path.join(dir, '.marrow', 'passive-runtime.mjs')), false);
});

test('doctor mode never writes files and reports missing env/hooks', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agents\n');

  const report = await install({
    cwd: dir,
    mode: 'both',
    yes: true,
    dryRun: false,
    doctor: true,
    selfTest: false,
    apiKey: '',
    baseUrl: 'https://api.getmarrow.ai',
    agentId: '',
  });

  assert.equal(report.writeMode, 'doctor');
  assert.equal(fs.existsSync(path.join(dir, '.marrow', 'passive-runtime.mjs')), false);
  assert.deepEqual(report.doctor.missingEnv, ['MARROW_API_KEY']);
  assert.ok(report.doctor.missingHooks.length > 0);
});

test('repair mode writes config and reports self-test remediation state', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agents\n');

  const report = await install({
    cwd: dir,
    mode: 'both',
    yes: true,
    repair: true,
    dryRun: false,
    selfTest: false,
    apiKey: '',
    baseUrl: 'https://api.getmarrow.ai',
    agentId: '',
  });

  assert.equal(report.writeMode, 'repair');
  assert.equal(fs.existsSync(path.join(dir, '.marrow', 'passive-runtime.mjs')), true);
  assert.equal(report.remediation.attempted, true);
  assert.equal(report.remediation.fixedConfig, true);
});

test('doctor reports likely env files when MARROW_API_KEY is not loaded', async () => {
  const dir = tempDir();
  fs.mkdirSync(path.join(dir, '.marrow'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.marrow', 'env'), 'MARROW_API_KEY=mrw_live_placeholder\n');

  const report = await install({
    cwd: dir,
    mode: 'md',
    yes: false,
    dryRun: true,
    selfTest: true,
    apiKey: '',
    baseUrl: 'https://api.getmarrow.ai',
    agentId: '',
  });

  assert.equal(report.selfTest.skipped, true);
  assert.match(report.selfTest.exact_fix, /--repair/);
  assert.ok(report.doctor.envHints.some((hint) => hint.endsWith(path.join('.marrow', 'env'))));
  assert.match(report.doctor.recommendedFix, /auto-loaded by Marrow SDK\/MCP runtimes/);
  assert.doesNotMatch(report.doctor.recommendedFix, /set -a;\s*\./);
});

test('parseArgs auto-loads Marrow key material from project .marrow/env', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-install-env-autoload-'));
  fs.mkdirSync(path.join(dir, '.marrow'));
  fs.writeFileSync(path.join(dir, '.marrow', 'env'), [
    'MARROW_API_KEY=mrw_test_install_env_key_123456789',
    'MARROW_FLEET_AGENT_ID=install-agent',
    '',
  ].join('\n'));

  const originalApiKey = process.env.MARROW_API_KEY;
  const originalKey = process.env.MARROW_KEY;
  const originalFleetAgent = process.env.MARROW_FLEET_AGENT_ID;
  const originalAgent = process.env.MARROW_AGENT_ID;
  try {
    delete process.env.MARROW_API_KEY;
    delete process.env.MARROW_KEY;
    delete process.env.MARROW_FLEET_AGENT_ID;
    delete process.env.MARROW_AGENT_ID;
    const parsed = parseArgs(['--cwd', dir]);
    assert.equal(parsed.apiKey, 'mrw_test_install_env_key_123456789');
    assert.equal(parsed.agentId, 'install-agent');
    assert.equal(parsed.keySource, path.join(dir, '.marrow', 'env'));
  } finally {
    if (originalApiKey === undefined) delete process.env.MARROW_API_KEY;
    else process.env.MARROW_API_KEY = originalApiKey;
    if (originalKey === undefined) delete process.env.MARROW_KEY;
    else process.env.MARROW_KEY = originalKey;
    if (originalFleetAgent === undefined) delete process.env.MARROW_FLEET_AGENT_ID;
    else process.env.MARROW_FLEET_AGENT_ID = originalFleetAgent;
    if (originalAgent === undefined) delete process.env.MARROW_AGENT_ID;
    else process.env.MARROW_AGENT_ID = originalAgent;
  }
});

test('parseArgs does not auto-load internal OpenClaw credential paths for public installer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-install-public-scope-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.openclaw', 'credentials'), { recursive: true });
  fs.writeFileSync(path.join(home, '.openclaw', 'credentials', 'marrow-mcp.env'), 'MARROW_API_KEY=mrw_test_internal_should_not_load_123456789\n');

  const originalHome = process.env.HOME;
  const originalApiKey = process.env.MARROW_API_KEY;
  const originalKey = process.env.MARROW_KEY;
  try {
    process.env.HOME = home;
    delete process.env.MARROW_API_KEY;
    delete process.env.MARROW_KEY;
    const parsed = parseArgs(['--cwd', dir]);
    assert.equal(parsed.apiKey, '');
    assert.equal(parsed.keySource, undefined);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalApiKey === undefined) delete process.env.MARROW_API_KEY;
    else process.env.MARROW_API_KEY = originalApiKey;
    if (originalKey === undefined) delete process.env.MARROW_KEY;
    else process.env.MARROW_KEY = originalKey;
  }
});

test('passive runtime source loads .marrow/env before deciding key is missing', () => {
  const source = passiveRuntimeSource();
  assert.match(source, /resolveMarrowEnv/);
  assert.match(source, /\.marrow/);
  assert.match(source, /MARROW_API_KEY \|\| marrowEnv\.MARROW_KEY/);
});

test('install auto mode does not create Claude settings when Claude is not detected', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agents\n');

  await install({
    cwd: dir,
    mode: 'both',
    yes: true,
    dryRun: false,
    selfTest: false,
    apiKey: '',
    baseUrl: 'https://api.getmarrow.ai',
    agentId: '',
  });

  assert.equal(fs.existsSync(path.join(dir, '.claude', 'settings.json')), false);
  assert.equal(fs.existsSync(path.join(dir, '.mcp.json')), true);
});

test('doctor validation reports exact missing key failure', async () => {
  const validation = await runDoctorValidation({
    apiKey: '',
    baseUrl: 'https://api.getmarrow.ai',
    agentId: '',
  }, { skipped: true, reason: 'missing MARROW_API_KEY' });

  assert.equal(validation.key_found, false);
  assert.equal(validation.key_valid, false);
  assert.equal(validation.failure_reason, 'missing_key');
  assert.match(validation.exact_fix, /MARROW_API_KEY/);
});

test('doctor validation confirms write test and outcome closure', async () => {
  const validation = await runDoctorValidation({
    apiKey: 'mrw_test_key',
    baseUrl: 'https://api.getmarrow.ai',
    agentId: 'agent-a',
  }, {
    skipped: false,
    active: true,
    decision_id: 'dec_doctor',
  });

  assert.equal(validation.key_found, true);
  assert.equal(validation.key_valid, true);
  assert.equal(validation.write_test_event, 'passed');
  assert.equal(validation.outcome_closed, 'passed');
  assert.equal(validation.decision_id, 'dec_doctor');
});

test('doctor package version warnings find old local SDK and MCP versions', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    dependencies: {
      '@getmarrow/sdk': '^3.7.1',
      '@getmarrow/mcp': '^3.9.1',
    },
  }));
  const detection = detectEnvironment(dir, {});
  const versions = inspectPackageVersions(detection);

  const sdk = versions.find((pkg) => pkg.name === '@getmarrow/sdk');
  const mcp = versions.find((pkg) => pkg.name === '@getmarrow/mcp');
  assert.equal(sdk.outdated, true);
  assert.equal(mcp.outdated, true);
  assert.match(sdk.update_command, /@getmarrow\/sdk@latest/);
  assert.match(mcp.update_command, /@getmarrow\/mcp@latest/);
});

test('self-test returns first five-minute value signal and proof', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    const href = String(url);
    if (href.endsWith('/v1/agent/think')) {
      return new Response(JSON.stringify({ data: { decision_id: 'dec_install_value' } }), { status: 200 });
    }
    if (href.endsWith('/v1/agent/commit')) {
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }
    if (href.endsWith('/v1/agent/status')) {
      return new Response(JSON.stringify({ data: {
        ok: true,
        enabled: true,
        health: 'healthy',
        capture_coverage: { decisions: true, tools: 'detected', commands: 'detected', deploys: 'unknown', publishes: 'unknown' },
        auto_outcome_closure: { state: 'active' },
      } }), { status: 200 });
    }
    if (href.endsWith('/v1/agent/runtime')) {
      return new Response(JSON.stringify({ data: {
        ok: true,
        exact_next_action: 'Use the safe deploy playbook before continuing.',
        before_you_act: 'Before continuing, reuse the safe deploy lesson.',
      } }), { status: 200 });
    }
    if (href.includes('/v1/analytics/agent-performance')) {
      return new Response(JSON.stringify({ data: {
        avoided_mistakes: 1,
        reused_winning_decisions: 2,
        prevented_bad_actions: 1,
        token_time_saved_estimate: { estimated_tokens_saved: 6600, estimated_minutes_saved: 46 },
        agent_reliability_score: 0.91,
      } }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'unexpected url' }), { status: 404 });
  };

  try {
    const result = await runSelfTest({
      selfTest: true,
      apiKey: 'mrw_test_key',
      baseUrl: 'https://api.getmarrow.ai',
      agentId: 'installer-test',
    });
    assert.equal(result.first_value_signal.active, true);
    assert.match(result.first_value_signal.headline, /Marrow active/);
    assert.ok(result.first_value_signal.captured.includes('decisions'));
    assert.ok(result.first_value_signal.captured.includes('tools'));
    assert.match(result.first_value_signal.first_lesson, /safe deploy lesson/);
    assert.ok(result.first_value_signal.value_proof.some((line) => line.includes('avoided mistake')));
    assert.equal(result.performance_proof.estimated_tokens_saved, 6600);
  } finally {
    global.fetch = originalFetch;
  }
});

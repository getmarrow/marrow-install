const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const {
  buildPlan,
  applyPlan,
  detectEnvironment,
  install,
  inspectNpmTokenConfig,
  inspectSdkDependency,
  parseArgs,
  passiveRuntimeSource,
  printReport,
  runSelfTest,
} = require('../src/installer');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-install-'));
}

function writeSdkLock(root, declaredSpec = '^3.7.52') {
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
    name: 'fixture',
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { '@getmarrow/sdk': declaredSpec } },
      'node_modules/@getmarrow/sdk': {
        version: '3.7.52',
        resolved: 'https://registry.npmjs.org/@getmarrow/sdk/-/sdk-3.7.52.tgz',
        integrity: 'sha512-dMo5rMXP5sFTRsiRI+Oe3SOWgSsi8TTt9VrYL9gC71EQFN2UTtuH914CkYEpcS627sb02jXrUDiXxznX/2fWgA==',
      },
    },
  }));
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
  assert.equal(repair.controller, true);

  const noController = parseArgs(['--repair', '--no-controller']);
  assert.equal(noController.controller, false);
});

test('activate is the one-command write and server verification path', () => {
  const parsed = parseArgs(['activate']);
  assert.equal(parsed.activate, true);
  assert.equal(parsed.yes, true);
  assert.equal(parsed.selfTest, true);
});

test('activate rejects dry-run and disabled self-test modifiers in any order', () => {
  assert.throws(() => parseArgs(['activate', '--dry-run']), /cannot be combined with --dry-run/);
  assert.throws(() => parseArgs(['--dry-run', 'activate']), /cannot be combined with --dry-run/);
  assert.throws(() => parseArgs(['activate', '--no-self-test']), /cannot be combined with --no-self-test/);
  assert.throws(() => parseArgs(['--no-self-test', 'activate']), /cannot be combined with --no-self-test/);
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

test('programmatic activation cannot attest to a dry-run or skipped self-test', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  const base = {
    cwd: dir,
    mode: 'sdk',
    yes: true,
    activate: true,
    apiKey: 'test-api-key',
    baseUrl: 'https://api.example.test',
    agentId: 'agent-one',
  };

  await assert.rejects(install({ ...base, dryRun: true, selfTest: true }), /requires write mode/);
  await assert.rejects(install({ ...base, yes: false, dryRun: false, selfTest: true }), /requires write mode/);
  await assert.rejects(install({ ...base, yes: undefined, dryRun: false, selfTest: true }), /requires write mode/);
  await assert.rejects(install({ ...base, doctor: true, dryRun: false, selfTest: true }), /requires write mode/);
  await assert.rejects(install({ ...base, dryRun: false, selfTest: false }), /requires the server self-test/);
});

test('applyPlan distinguishes files written now from configuration already present', () => {
  const dir = tempDir();
  const target = path.join(dir, 'existing.txt');
  fs.writeFileSync(target, 'same\n');
  const plan = { root: dir, writes: [{ type: 'file', path: target, label: 'Existing hook config', content: 'same\n' }] };
  const [change] = applyPlan(plan, { yes: true, dryRun: false, doctor: false });
  assert.equal(change.changed, false);
  assert.equal(change.applied, false);
  assert.equal(change.already_present, true);
});

test('applyPlan rejects symlinked targets and cannot modify files outside the project', () => {
  const dir = tempDir();
  const outside = tempDir();
  const outsideFile = path.join(outside, 'owner-file.md');
  fs.writeFileSync(outsideFile, 'owner content\n');
  fs.symlinkSync(outsideFile, path.join(dir, 'AGENTS.md'));
  const plan = {
    root: dir,
    writes: [{ type: 'file', path: path.join(dir, 'AGENTS.md'), label: 'Agent instructions', content: 'changed\n' }],
  };

  assert.throws(
    () => applyPlan(plan, { yes: true, dryRun: false, doctor: false }),
    /unsafe managed target/i,
  );
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'owner content\n');
});

test('applyPlan rejects symlinked parent directories and lexical path escapes', () => {
  const dir = tempDir();
  const outside = tempDir();
  fs.symlinkSync(outside, path.join(dir, '.marrow'));
  const linkedPlan = {
    root: dir,
    writes: [{ type: 'file', path: path.join(dir, '.marrow', 'passive-runtime.mjs'), label: 'Runtime', content: 'safe\n' }],
  };
  const escapedPlan = {
    root: dir,
    writes: [{ type: 'file', path: path.join(dir, '..', 'escaped.txt'), label: 'Escape', content: 'unsafe\n' }],
  };

  assert.throws(
    () => applyPlan(linkedPlan, { yes: true, dryRun: false, doctor: false }),
    /unsafe path component/i,
  );
  assert.throws(
    () => applyPlan(escapedPlan, { yes: true, dryRun: false, doctor: false }),
    /outside project root/i,
  );
  assert.equal(fs.existsSync(path.join(outside, 'passive-runtime.mjs')), false);
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

  assert.match(runtime, /await import\('@getmarrow\/sdk'\)/);
  assert.match(runtime, /passive runtime skipped/);
  assert.doesNotMatch(runtime, /error\.message|String\(error\)|message =/);
  assert.match(runtime, /createPassiveRuntime/);
  assert.match(runtime, /useAgentRuntime/);
  assert.match(runtime, /useWorkflowGate/);
  assert.match(runtime, /requireOutcomeClosure/);
  assert.match(runtime, /captureModelUsage/);
  assert.match(runtime, /MARROW_PASSIVE_VALUE_REPORT !== 'false'/);
  assert.match(runtime, /MARROW_PASSIVE_TOKEN_USAGE !== 'false'/);
  const envExample = fs.readFileSync(path.join(dir, '.marrow', 'env.example'), 'utf8');
  assert.match(envExample, /MARROW_PASSIVE_TOKEN_USAGE=true/);
  assert.equal((agents.match(/marrow:passive-start/g) || []).length, 1);
  assert.match(agents, /passive token\/model usage proof enabled/);
  assert.ok(settings.hooks.PostToolUse);
  assert.ok(settings.hooks.UserPromptSubmit);
});



test('generated passive runtime warning redacts SDK initialization errors', async () => {
  const dir = tempDir();
  const moduleDir = path.join(dir, 'node_modules', '@getmarrow', 'sdk');
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.writeFileSync(path.join(moduleDir, 'package.json'), JSON.stringify({ type: 'module', main: 'index.js' }));
  fs.writeFileSync(path.join(moduleDir, 'index.js'), `export class MarrowClient {\n  constructor(apiKey, options) {\n    throw new Error('leaked ' + apiKey + ' ' + options.baseUrl + ' ' + options.agentId + ' ' + options.sessionId);\n  }\n}\n`);
  fs.mkdirSync(path.join(dir, '.marrow'), { recursive: true });
  const runtimePath = path.join(dir, '.marrow', 'passive-runtime.mjs');
  fs.writeFileSync(runtimePath, passiveRuntimeSource());

  const previous = {
    HOME: process.env.HOME,
    MARROW_API_KEY: process.env.MARROW_API_KEY,
    MARROW_BASE_URL: process.env.MARROW_BASE_URL,
    MARROW_AGENT_ID: process.env.MARROW_AGENT_ID,
    MARROW_SESSION_ID: process.env.MARROW_SESSION_ID,
  };
  const originalWarn = console.warn;
  const warnings = [];
  try {
    process.env.HOME = dir;
    process.env.MARROW_API_KEY = 'mrw_live_should_not_print';
    process.env.MARROW_BASE_URL = 'https://secret.example.test';
    process.env.MARROW_AGENT_ID = 'agent-secret-value';
    process.env.MARROW_SESSION_ID = 'session-secret-value';
    delete globalThis.__MARROW_PASSIVE_RUNTIME__;
    console.warn = (...args) => warnings.push(args.join(' '));

    await import(`${pathToFileURL(runtimePath).href}?case=redaction-${Date.now()}`);
  } finally {
    console.warn = originalWarn;
    delete globalThis.__MARROW_PASSIVE_RUNTIME__;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  const stderr = warnings.join('\n');
  assert.match(stderr, /passive runtime skipped/);
  assert.doesNotMatch(stderr, /mrw_live_should_not_print/);
  assert.doesNotMatch(stderr, /secret\.example\.test/);
  assert.doesNotMatch(stderr, /agent-secret-value/);
  assert.doesNotMatch(stderr, /session-secret-value/);
});

test('install reports missing SDK dependency for passive runtime projects', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: {} }));

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

  assert.equal(report.sdkDependency.required, true);
  assert.equal(report.sdkDependency.present, false);
  assert.equal(report.sdkDependency.install_command, 'npm install @getmarrow/sdk@3.7.52');

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { '@getmarrow/sdk': '^3.7.27' } }));
  const moduleDir = path.join(dir, 'node_modules', '@getmarrow', 'sdk');
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.writeFileSync(path.join(moduleDir, 'package.json'), JSON.stringify({ name: '@getmarrow/sdk', version: '0.0.1' }));
  let detected = detectEnvironment(dir, {});
  let sdk = inspectSdkDependency(detected);
  assert.equal(sdk.present, false);
  assert.equal(sdk.installed_version, '0.0.1');
  fs.writeFileSync(path.join(moduleDir, 'package.json'), JSON.stringify({ name: '@getmarrow/sdk', version: '3.7.52' }));
  writeSdkLock(dir, '^3.7.27');
  detected = detectEnvironment(dir, {});
  sdk = inspectSdkDependency(detected);
  assert.equal(sdk.present, true);
  assert.equal(sdk.installed_version, '3.7.52');
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

test('repair refuses a symlinked npmrc without modifying its target', async () => {
  const dir = tempDir();
  const home = tempDir();
  const outside = path.join(tempDir(), 'outside-npmrc');
  fs.mkdirSync(path.join(home, '.openclaw'), { recursive: true });
  fs.writeFileSync(path.join(home, '.openclaw', '.env'), 'NPM_TOKEN=npm_new_secret_123456789\n');
  fs.writeFileSync(outside, 'outside=unchanged\n', { mode: 0o600 });
  fs.symlinkSync(outside, path.join(home, '.npmrc'));

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
    assert.equal(report.configDiagnostics.npm_token.unsafe_path, true);
    assert.equal(report.configDiagnostics.npm_token.repairable, false);
    assert.equal(report.configRepairs.length, 0);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside=unchanged\n');
    assert.equal(fs.lstatSync(path.join(home, '.npmrc')).isSymbolicLink(), true);
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

test('programmatic repair requires explicit write authorization', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');

  await assert.rejects(install({
    cwd: dir,
    mode: 'sdk',
    yes: false,
    repair: true,
    dryRun: false,
    selfTest: false,
    apiKey: '',
    baseUrl: 'https://api.getmarrow.ai',
    agentId: '',
  }), /repair requires explicit write authorization/);

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

  let output = '';
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => {
    output += String(chunk);
    return true;
  };
  try {
    printReport(report);
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.match(output, /- wrote: SDK passive runtime preload/);
  assert.doesNotMatch(output, /would write/);
});

test('doctor reports likely env files when MARROW_API_KEY is not loaded', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agents\n');
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
  assert.match(report.doctor.recommendedFix, /trusted secret storage/);
  assert.doesNotMatch(report.doctor.recommendedFix, /set -a;\s*\./);
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

test('self-test returns first five-minute value signal and proof', async () => {
  const originalFetch = global.fetch;
  let requestHeaders;
  global.fetch = async (url, request = {}) => {
    requestHeaders = request.headers || requestHeaders;
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
        client_update: {
          installed_version: '0.1.37',
          latest_version: '0.1.37',
          version_status: 'behind',
          update_available: true,
          notification_state: 'recommended',
          update_command: 'npx @getmarrow/install@latest --repair',
          verification_command: 'npx @getmarrow/install@latest doctor',
        },
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
    if (href.endsWith('/v1/agent/first-value')) {
      return new Response(JSON.stringify({ data: {
        ok: true,
        active: true,
        headline: 'Your agent is no longer starting from zero.',
        first_value: {
          proof: ['Captured this setup decision', 'Closed the outcome successfully', 'Runtime gate is active'],
          first_lesson: 'Before continuing, reuse the safe deploy lesson.',
          try_this_now: 'Ask your agent: "I am about to deploy to production. What should I check first?"',
          expected_response: 'Marrow should answer with a risk gate, required proof, and matching fleet lessons before the agent acts.',
        },
        history_signal: { summary: 'Marrow found 1 avoided mistake signal.' },
        capture: { surfaces: ['decisions', 'outcomes:active', 'risk-gate'] },
        value_proof: { avoided_mistakes: 1, reused_winning_decisions: 2, prevented_bad_actions: 1, estimated_tokens_saved: 6600 },
        next_action: { reason: 'Use this one-call runtime check before risky actions.' },
      } }), { status: 200 });
    }
    if (href.includes('/v1/agent/value/proof')) {
      return new Response(JSON.stringify({ data: {
        summary: 'Marrow has 12 recorded outcomes in the selected period with 92% success rate.',
        model_usage: {
          enabled: true,
          capture_default: 'on_when_sdk_mcp_or_installer_hooks_available',
          observed: {
            model_calls: 3,
            agents_seen: 1,
            workflows_seen: 1,
            tokens: { input: 1200, output: 500, cached: 300, total: 2000 },
            cost_usd: 0.02,
            avg_latency_ms: 820,
          },
          savings: {
            estimated_tokens_saved: 700,
            estimated_cost_saved_usd: 0.01,
            estimated_minutes_saved: 2,
            confidence: 'medium',
            method: 'explicit_measurements',
          },
          trend: {
            period_days: 30,
            recent_tokens_per_call: 500,
            previous_tokens_per_call: 700,
            reduction_pct: 28.6,
            direction: 'improving',
          },
          top_models: [{ provider: 'openai', model: 'codex-5.5', calls: 3, tokens: 2000 }],
          proof_line: 'Marrow observed 3 model calls and estimates 700 tokens saved in 30 days.',
          exact_next_action: 'Show this token_value_signal after work completes and include it in owner reports.',
        },
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
    assert.equal(requestHeaders['x-marrow-package'], '@getmarrow/install');
    assert.equal(requestHeaders['x-marrow-package-version'], '0.1.37');
    assert.equal(result.first_value_signal.active, true);
    assert.match(result.first_value_signal.headline, /Marrow active/);
    assert.ok(result.first_value_signal.captured.includes('decisions'));
    assert.ok(result.first_value_signal.captured.includes('outcomes:active'));
    assert.match(result.first_value_signal.first_lesson, /safe deploy lesson/);
    assert.match(result.install_value_moment.headline, /starting from zero/);
    assert.match(result.install_value_moment.try_this_now, /deploy to production/);
    assert.match(result.install_value_moment.fleet_signal, /avoided mistake/);
    assert.equal(result.first_value.headline, 'Your agent is no longer starting from zero.');
    assert.ok(result.first_value_signal.value_proof.some((line) => line.includes('avoided mistake')));
    assert.ok(result.first_value_signal.value_proof.some((line) => line.includes('observed 3 model call')));
    assert.ok(result.first_value_signal.value_proof.some((line) => line.includes('explicit_measurements')));
    assert.equal(result.first_value_signal.value_proof.some((line) => line.includes('6600')), false);
    assert.equal(result.first_value_signal.value_proof.some((line) => line.includes('measured model tokens')), false);
    assert.equal(result.performance_proof.estimated_tokens_saved, 700);
    assert.equal(result.performance_proof.token_savings_available, true);
    assert.equal(result.performance_proof.token_savings_source, 'agent_model_usage_events');
    assert.equal(result.performance_proof.token_savings_method, 'explicit_measurements');
    assert.equal(result.token_value_proof.observed.model_calls, 3);
    assert.equal(result.token_value_proof.observed.tokens.total, 2000);
    assert.equal(result.token_value_proof.savings.estimated_tokens_saved, 700);
    assert.equal(result.client_update.update_available, true);
    assert.equal(result.client_update.verification_command, 'npx @getmarrow/install@latest doctor');
    assert.ok(result.install_value_moment.proof.some((line) => line.includes('model calls')));
  } finally {
    global.fetch = originalFetch;
  }
});

test('activation requires a receipt bound to the exact decision, agent, and successful outcome', async () => {
  const originalFetch = global.fetch;
  let receipt = null;
  let activationProfileEvent = null;
  let profileBindingEnabled = false;
  let profileAccountBindingId = 'a'.repeat(64);
  let receiptAccountBindingId = 'b'.repeat(64);
  let configurationBindingId = 'wrong-configuration-binding';
  let runtimePayload = { ok: true, risk_gate: { allow: true } };
  global.fetch = async (url, request = {}) => {
    const href = String(url);
    if (href.endsWith('/v1/agent/think')) {
      return new Response(JSON.stringify({ data: { decision_id: 'decision-activation' } }), { status: 200 });
    }
    if (href.endsWith('/v1/agent/commit')) {
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }
    if (href.endsWith('/v1/agent/status')) {
      return new Response(JSON.stringify({ data: { ok: true, enabled: true, health: 'healthy' } }), { status: 200 });
    }
    if (href.endsWith('/v1/agent/runtime')) {
      return new Response(JSON.stringify({ data: runtimePayload }), { status: 200 });
    }
    if (href.endsWith('/v1/agent/first-value')) {
      return new Response(JSON.stringify({ data: { ok: true, active: true, activation_receipt: receipt } }), { status: 200 });
    }
    if (href.endsWith('/v1/agent/integrations/events')) {
      activationProfileEvent = JSON.parse(request.body);
      if (!profileBindingEnabled) {
        return new Response(JSON.stringify({ data: { accepted: true } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: {
        accepted: true,
        activation_coverage: {
          account_binding_id: profileAccountBindingId,
          agent_id: activationProfileEvent.agent_id,
          harness: activationProfileEvent.harness,
          activation: {
            adapter_version: activationProfileEvent.adapter_version,
            capability_level: activationProfileEvent.capability_level,
          },
          capture_coverage: { expected_hooks: activationProfileEvent.expected_hooks },
          profile_receipt: {
            event_receipt_id: 'event-receipt-one',
            account_binding_id: receiptAccountBindingId,
            agent_id: activationProfileEvent.agent_id,
            harness: activationProfileEvent.harness,
            adapter_version: activationProfileEvent.adapter_version,
            capability_level: activationProfileEvent.capability_level,
            config_fingerprint_verified: true,
            configuration_binding_id: configurationBindingId,
            expected_hooks_verified: true,
          },
        },
      } }), { status: 200 });
    }
    if (href.includes('/v1/analytics/agent-performance') || href.includes('/v1/agent/value/proof')) {
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'unexpected url' }), { status: 404 });
  };

  const options = {
    selfTest: true,
    apiKey: 'test-api-key',
    baseUrl: 'https://api.example.test',
    agentId: 'agent-one',
    client: 'codex',
    activation: {
      harness: 'codex',
      install_surface: 'both',
      mode: 'passive',
      hooks_installed: ['passive runtime'],
      capture_verified: true,
      complete: true,
      adapter_version: '0.1.37',
      capability_level: 'governed_wrapper',
      config_fingerprint: 'fixture-config-fingerprint',
      expected_hooks: ['pre_action', 'action_result', 'outcome_closure'],
    },
  };

  try {
    await assert.rejects(runSelfTest(options), /activation receipt did not verify/);
    receipt = {
      id: 'activation-receipt-one',
      decision_id: 'wrong-decision',
      agent_id: 'agent-one',
      outcome_success: true,
      outcome_recorded_at: '2026-07-23T00:00:00.000Z',
      server_confirmed: true,
      capture_verified: true,
      intervention_verified: true,
      closure_verified: true,
    };
    await assert.rejects(runSelfTest(options), /activation receipt did not verify/);
    receipt.decision_id = 'decision-activation';
    receipt.outcome_recorded_at = '';
    await assert.rejects(runSelfTest(options), /activation receipt did not verify/);
    receipt.outcome_recorded_at = 'not-a-timestamp';
    await assert.rejects(runSelfTest(options), /activation receipt did not verify/);
    receipt.outcome_recorded_at = '2026-07-23T00:00:00.000Z';
    await assert.rejects(runSelfTest(options), /activation prerequisites were not all verified/);
    profileBindingEnabled = true;
    await assert.rejects(runSelfTest(options), /activation prerequisites were not all verified/);
    receiptAccountBindingId = profileAccountBindingId;
    await assert.rejects(runSelfTest(options), /activation prerequisites were not all verified/);
    configurationBindingId = crypto.createHash('sha256')
      .update(`agent-config-receipt:v2:${profileAccountBindingId}:fixture-config-fingerprint`)
      .digest('hex');
    const result = await runSelfTest(options);
    assert.equal(result.activation_verified, true);
    assert.equal(result.activation_receipt.decision_id, 'decision-activation');
    assert.equal(activationProfileEvent.event_type, 'activation_profile_registered');
    assert.equal('observed_hook' in activationProfileEvent, false);
    assert.equal('outcome_state' in activationProfileEvent, false);
    assert.equal('success' in activationProfileEvent, false);
    assert.equal('correlation_id' in activationProfileEvent, false);
    assert.equal('intervention_disposition' in activationProfileEvent, false);
    assert.equal('action_changed' in activationProfileEvent, false);
    runtimePayload = { ok: true };
    await assert.rejects(runSelfTest(options), /activation prerequisites were not all verified/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('activation rejects an ambiguous empty runtime payload', async () => {
  const originalFetch = global.fetch;
  let firstValueCalled = false;
  global.fetch = async (url) => {
    const href = String(url);
    if (href.endsWith('/v1/agent/think')) {
      return new Response(JSON.stringify({ data: { decision_id: 'decision-runtime-empty' } }), { status: 200 });
    }
    if (href.endsWith('/v1/agent/commit') || href.endsWith('/v1/agent/status')) {
      return new Response(JSON.stringify({ data: { ok: true, enabled: true } }), { status: 200 });
    }
    if (href.endsWith('/v1/agent/runtime')) {
      return new Response(JSON.stringify({ data: {} }), { status: 200 });
    }
    if (href.endsWith('/v1/agent/first-value')) {
      firstValueCalled = true;
      return new Response(JSON.stringify({ data: { active: true } }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  };

  try {
    await assert.rejects(runSelfTest({
      selfTest: true,
      apiKey: 'test-api-key',
      baseUrl: 'https://api.example.test',
      agentId: 'agent-one',
      activation: { harness: 'codex', capture_verified: true },
    }), /activation receipt did not verify/);
    assert.equal(firstValueCalled, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('activation fails before confirmation when runtime verification is unavailable', async () => {
  const originalFetch = global.fetch;
  let firstValueCalled = false;
  global.fetch = async (url) => {
    const href = String(url);
    if (href.endsWith('/v1/agent/think')) {
      return new Response(JSON.stringify({ data: { decision_id: 'decision-runtime-fail' } }), { status: 200 });
    }
    if (href.endsWith('/v1/agent/commit') || href.endsWith('/v1/agent/status')) {
      return new Response(JSON.stringify({ data: { ok: true, enabled: true } }), { status: 200 });
    }
    if (href.endsWith('/v1/agent/runtime')) {
      return new Response(JSON.stringify({ error: 'runtime unavailable' }), { status: 503 });
    }
    if (href.endsWith('/v1/agent/first-value')) firstValueCalled = true;
    return new Response(JSON.stringify({ data: {} }), { status: 200 });
  };

  try {
    await assert.rejects(runSelfTest({
      selfTest: true,
      apiKey: 'test-api-key',
      baseUrl: 'https://api.example.test',
      agentId: 'agent-one',
      activation: { harness: 'codex', capture_verified: true },
    }), /runtime unavailable/);
    assert.equal(firstValueCalled, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test('activation endpoint failure rejects install instead of returning a false success report', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ error: 'activation service unavailable' }), { status: 503 });
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');

  try {
    await assert.rejects(install({
      cwd: dir,
      mode: 'sdk',
      yes: true,
      activate: true,
      dryRun: false,
      selfTest: true,
      apiKey: 'test-api-key',
      baseUrl: 'https://api.example.test',
      agentId: 'agent-one',
    }), /Marrow activation failed: activation service unavailable/);
  } finally {
    global.fetch = originalFetch;
  }
});

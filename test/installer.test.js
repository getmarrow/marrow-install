const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const {
  ADAPTER_PROVENANCE,
  buildPlan,
  applyPlan,
  detectEnvironment,
  install,
  inspectNpmTokenConfig,
  inspectSdkDependency,
  inspectMcpConfigurations,
  inspectMcpProcesses,
  parseArgs,
  passiveRuntimeSource,
  printReport,
  runSelfTest,
} = require('../src/installer');

test('published adapter provenance matches the certified MCP and SDK package chain', () => {
  assert.deepEqual(ADAPTER_PROVENANCE, {
    mcp: {
      package: '@getmarrow/mcp',
      version: '3.9.72',
      source_sha: '5203f96388849dfda12cb05d476b36b542639e16',
      integrity: 'sha512-FTs9ORn4WVwDIeJEjovriDK4X8WZVSGbbe8iz6GGYFy62jBRJOXOZ4aW8B4Ll+10i71o8RcEBJ0Px38Pc6v/qw==',
    },
    sdk: {
      package: '@getmarrow/sdk',
      version: '3.7.61',
      integrity: 'sha512-1dXf/Px4mMN4lOehrRkBOF/dC6N9kjQ5R4eb8ohAACx5CvLTS32zSTelfMNjnRcdOknSKMjLnbh7aGFhulVo/Q==',
    },
  });
});

test('doctor identifies stale and mixed MCP processes without exposing command lines', () => {
  const report = inspectMcpProcesses({ commands: [
    'npx -y @getmarrow/mcp@2.8.0',
    'npx -y --package=@getmarrow/mcp@3.9.72 marrow-mcp',
    'node unrelated.js --token=must-not-appear',
  ] });
  assert.equal(report.healthy, false);
  assert.equal(report.mixed_versions, true);
  assert.deepEqual(report.stale_versions, ['2.8.0']);
  assert.deepEqual(report.active_versions, ['2.8.0', '3.9.72']);
  assert.doesNotMatch(JSON.stringify(report), /must-not-appear|unrelated\.js/);
  assert.equal(report.exact_fix, 'npx -y --package=@getmarrow/mcp@3.9.72 marrow-mcp setup');
  assert.equal(report.restart_required, true);
  assert.match(report.restart_instruction, /restart every owning harness/i);
  assert.equal(report.verification_command, 'npx -y @getmarrow/install@latest doctor --self-test');
});

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-install-'));
}

test('doctor treats version-unknown MCP processes as unhealthy with executable repair', () => {
  const report = inspectMcpProcesses({ commands: [
    'npx -y @getmarrow/mcp@latest',
    'marrow-mcp --transport stdio --token=must-not-appear',
  ] });
  assert.equal(report.active_processes, 2);
  assert.equal(report.unknown_version_processes, 2);
  assert.equal(report.healthy, false);
  assert.equal(report.exact_fix, 'npx -y --package=@getmarrow/mcp@3.9.72 marrow-mcp setup');
  assert.doesNotMatch(report.exact_fix, /stop|restart|then/i);
  assert.doesNotMatch(JSON.stringify(report), /must-not-appear/);
  assert.equal(report.restart_required, true);
  assert.equal(report.verification_command, 'npx -y @getmarrow/install@latest doctor --self-test');
});

test('doctor ignores parent shells and sandbox wrappers that only mention MCP commands', () => {
  const report = inspectMcpProcesses({ commands: [
    '/usr/bin/bwrap --ro-bind / / /bin/bash -lc npx -y --package=@getmarrow/mcp@3.9.72 marrow-mcp setup',
    '/bin/bash -lc npx -y @getmarrow/mcp@2.8.0',
    'rg @getmarrow/mcp package.json',
    'rg /tmp/node_modules/@getmarrow/mcp package-lock.json',
  ] });
  assert.equal(report.active_processes, 0);
  assert.equal(report.unknown_version_processes, 0);
  assert.equal(report.healthy, true);
  assert.equal(report.exact_fix, null);
});

test('doctor flags stale and mixed MCP owner configurations without exposing paths or contents', () => {
  const root = tempDir();
  const stale = path.join(root, 'claude.json');
  const current = path.join(root, 'cursor.json');
  fs.writeFileSync(stale, JSON.stringify({ mcp: { command: 'npx', args: ['-y', '@getmarrow/mcp@2.8.0'], secret: 'must-not-appear' } }));
  fs.writeFileSync(current, JSON.stringify({ mcp: { command: 'npx', args: ['-y', '--package=@getmarrow/mcp@3.9.72', 'marrow-mcp'] } }));
  try {
    const report = inspectMcpConfigurations({}, { paths: [stale, current] });
    assert.equal(report.healthy, false);
    assert.equal(report.mixed_versions, true);
    assert.deepEqual(report.configured_versions, ['2.8.0', '3.9.72']);
    assert.deepEqual(report.stale_versions, ['2.8.0']);
    assert.match(report.exact_fix, /--package=@getmarrow\/mcp@3\.9\.72 marrow-mcp setup/);
    assert.equal(report.verification_command, 'npx -y @getmarrow/install@latest doctor --self-test');
    assert.doesNotMatch(JSON.stringify(report), /must-not-appear|claude\.json|cursor\.json/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor accepts a current-only MCP owner configuration', () => {
  const root = tempDir();
  const current = path.join(root, '.mcp.json');
  fs.writeFileSync(current, JSON.stringify({ mcpServers: { marrow: { command: 'npx', args: ['-y', '--package=@getmarrow/mcp@3.9.72', 'marrow-mcp'] } } }));
  try {
    const report = inspectMcpConfigurations({}, { paths: [current] });
    assert.equal(report.healthy, true);
    assert.equal(report.mixed_versions, false);
    assert.deepEqual(report.configured_versions, ['3.9.72']);
    assert.equal(report.exact_fix, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor treats the previously pinned MCP 3.9.59 as stale', () => {
  const report = inspectMcpProcesses({ commands: [
    'npx -y --package=@getmarrow/mcp@3.9.59 marrow-mcp',
  ] });
  assert.equal(report.expected_version, '3.9.72');
  assert.deepEqual(report.active_versions, ['3.9.59']);
  assert.deepEqual(report.stale_versions, ['3.9.59']);
  assert.equal(report.healthy, false);
  assert.equal(report.exact_fix, 'npx -y --package=@getmarrow/mcp@3.9.72 marrow-mcp setup');
});

test('doctor flags an unpinned MCP owner configuration as version-unknown', () => {
  const root = tempDir();
  const current = path.join(root, '.mcp.json');
  fs.writeFileSync(current, JSON.stringify({ mcpServers: { marrow: { command: 'npx', args: ['-y', '@getmarrow/mcp@latest'] } } }));
  try {
    const report = inspectMcpConfigurations({}, { paths: [current] });
    assert.equal(report.healthy, false);
    assert.equal(report.unknown_version_configurations, 1);
    assert.deepEqual(report.configured_versions, []);
    assert.match(report.exact_fix, /@getmarrow\/mcp@3\.9\.72/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('doctor resolves direct node_modules bin MCP process versions', () => {
  const root = tempDir();
  const packageRoot = path.join(root, 'node_modules', '@getmarrow', 'mcp');
  const binRoot = path.join(root, 'node_modules', '.bin');
  fs.mkdirSync(path.join(packageRoot, 'dist'), { recursive: true });
  fs.mkdirSync(binRoot, { recursive: true });
  fs.writeFileSync(path.join(packageRoot, 'package.json'), JSON.stringify({ name: '@getmarrow/mcp', version: '3.9.56' }));
  fs.writeFileSync(path.join(packageRoot, 'dist', 'cli.js'), '#!/usr/bin/env node\n');
  fs.symlinkSync('../@getmarrow/mcp/dist/cli.js', path.join(binRoot, 'marrow-mcp'));
  try {
    const report = inspectMcpProcesses({ commands: [
      `node ${path.join(binRoot, 'marrow-mcp')} --transport stdio`,
    ] });
    assert.equal(report.active_processes, 1);
    assert.equal(report.unknown_version_processes, 0);
    assert.deepEqual(report.active_versions, ['3.9.56']);
    assert.deepEqual(report.stale_versions, ['3.9.56']);
    assert.equal(report.healthy, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function writeSdkLock(root, declaredSpec = '^3.7.61') {
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
    name: 'fixture',
    lockfileVersion: 3,
    packages: {
      '': { dependencies: { '@getmarrow/sdk': declaredSpec } },
      'node_modules/@getmarrow/sdk': {
        version: '3.7.61',
        resolved: 'https://registry.npmjs.org/@getmarrow/sdk/-/sdk-3.7.61.tgz',
        integrity: ADAPTER_PROVENANCE.sdk.integrity,
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

  const update = parseArgs(['update']);
  assert.equal(update.repair, true);
  assert.equal(update.yes, true);
  assert.equal(update.update, true);

  const noController = parseArgs(['--repair', '--no-controller']);
  assert.equal(noController.controller, false);
});

test('SDK detection accepts the exact public 3.7.61 package and rejects the superseded integrity', () => {
  const dir = tempDir();
  const moduleDir = path.join(dir, 'node_modules', '@getmarrow', 'sdk');
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { '@getmarrow/sdk': '3.7.61' } }));
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.writeFileSync(path.join(moduleDir, 'package.json'), JSON.stringify({ name: '@getmarrow/sdk', version: '3.7.61' }));
  writeSdkLock(dir, '3.7.61');

  let report = inspectSdkDependency(detectEnvironment(dir, {}));
  assert.equal(report.present, true);
  assert.equal(report.lock_verified, true);
  assert.equal(report.install_command, null);

  const lockPath = path.join(dir, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.packages['node_modules/@getmarrow/sdk'].integrity = 'sha512-5htliY4wfn8a1mbLT9N4OWXqhp9fWzMHuAQgUetc3RUKjOes5mWB3t91/leRKFRRIgCnEczJN6jHXg7Aw489Mw==';
  fs.writeFileSync(lockPath, JSON.stringify(lock));
  report = inspectSdkDependency(detectEnvironment(dir, {}));
  assert.equal(report.present, false);
  assert.equal(report.lock_verified, false);
  assert.equal(report.install_command, 'npm install @getmarrow/sdk@3.7.61');
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

test('generated passive instructions pin the supported MCP release', () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agents\n');
  const detected = detectEnvironment(dir, {});
  const plan = buildPlan(detected, { mode: 'mcp' });
  const instructions = plan.writes.find((write) => write.path.endsWith('AGENTS.md'))?.block;

  assert.match(instructions, /npx -y --package=@getmarrow\/mcp@3\.9\.72 marrow-mcp setup/);
  assert.doesNotMatch(instructions, /@getmarrow\/mcp@latest/);
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

test('installed MCP and SDK runtime use one stable identity without persisting the API key', async () => {
  const dir = tempDir();
  const sdkDir = path.join(dir, 'node_modules', '@getmarrow', 'sdk');
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agents\n');
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({
    mcpServers: {
      marrow: {
        command: 'npx',
        args: ['-y', '--package=@getmarrow/mcp@3.9.72', 'marrow-mcp'],
        env: {
          MARROW_API_KEY: 'fixture-old-credential',
          MARROW_BASE_URL: '${MARROW_BASE_URL}',
          MARROW_FLEET_AGENT_ID: '${MARROW_FLEET_AGENT_ID}',
        },
      },
    },
  }));
  fs.mkdirSync(sdkDir, { recursive: true });
  fs.writeFileSync(path.join(sdkDir, 'package.json'), JSON.stringify({ type: 'module', main: 'index.js' }));
  fs.writeFileSync(path.join(sdkDir, 'index.js'), `export class MarrowClient {
  constructor(apiKey, options) { globalThis.__MARROW_INSTALL_IDENTITY_CAPTURE__ = { apiKey, options }; }
  createPassiveRuntime() { return { install() {} }; }
}
`);

  const installKey = 'fixture-install-credential';
  const originalFetch = global.fetch;
  const selfTestAgentIds = [];
  let report;
  global.fetch = async (url, request = {}) => {
    selfTestAgentIds.push(request.headers?.['x-marrow-agent-id']);
    const href = String(url);
    if (href.endsWith('/v1/agent/think')) {
      return new Response(JSON.stringify({ data: { decision_id: 'installer-identity-decision' } }), { status: 200 });
    }
    if (href.endsWith('/v1/agent/status')) {
      return new Response(JSON.stringify({ data: { ok: true, enabled: true, health: 'healthy' } }), { status: 200 });
    }
    if (href.endsWith('/v1/agent/runtime')) {
      return new Response(JSON.stringify({ data: { ok: true, risk_gate: { allow: true } } }), { status: 200 });
    }
    if (href.endsWith('/v1/agent/first-value')) {
      return new Response(JSON.stringify({ data: { ok: true, active: true } }), { status: 200 });
    }
    if (href.endsWith('/v1/agent/commit')
      || href.includes('/v1/analytics/agent-performance')
      || href.includes('/v1/agent/value/proof')) {
      return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'unexpected URL' }), { status: 404 });
  };
  try {
    report = await install({
      cwd: dir,
      mode: 'both',
      yes: true,
      repair: true,
      dryRun: false,
      selfTest: true,
      controller: false,
      apiKey: installKey,
      baseUrl: 'https://api.identity.example.test',
      agentId: '',
      processCommands: [],
      mcpConfigPaths: [],
    });
  } finally {
    global.fetch = originalFetch;
  }
  const mcpPath = path.join(dir, '.mcp.json');
  const runtimePath = path.join(dir, '.marrow', 'passive-runtime.mjs');
  const mcpRaw = fs.readFileSync(mcpPath, 'utf8');
  const runtimeRaw = fs.readFileSync(runtimePath, 'utf8');
  const mcp = JSON.parse(mcpRaw);
  const generatedAgentId = report.activation.agent_id;

  assert.ok(generatedAgentId);
  assert.ok(selfTestAgentIds.length > 0);
  assert.equal(selfTestAgentIds.every((agentId) => agentId === generatedAgentId), true);
  assert.equal(mcp.mcpServers.marrow.env.MARROW_FLEET_AGENT_ID, generatedAgentId);
  assert.equal(mcp.mcpServers.marrow.env.MARROW_BASE_URL, 'https://api.identity.example.test');
  assert.equal('MARROW_API_KEY' in mcp.mcpServers.marrow.env, false);
  assert.doesNotMatch(mcpRaw, /MARROW_API_KEY|\$\{MARROW_(?:API_KEY|BASE_URL|FLEET_AGENT_ID)\}/);
  assert.doesNotMatch(`${mcpRaw}\n${runtimeRaw}`, new RegExp(installKey));
  assert.doesNotMatch(`${mcpRaw}\n${runtimeRaw}`, /fixture-old-credential/);

  const previous = {
    MARROW_API_KEY: process.env.MARROW_API_KEY,
    MARROW_BASE_URL: process.env.MARROW_BASE_URL,
    MARROW_FLEET_AGENT_ID: process.env.MARROW_FLEET_AGENT_ID,
    MARROW_AGENT_ID: process.env.MARROW_AGENT_ID,
  };
  try {
    process.env.MARROW_API_KEY = 'fixture-runtime-credential';
    process.env.MARROW_BASE_URL = 'https://wrong-runtime.example.test';
    process.env.MARROW_FLEET_AGENT_ID = 'wrong-runtime-agent';
    delete process.env.MARROW_AGENT_ID;
    delete globalThis.__MARROW_PASSIVE_RUNTIME__;
    delete globalThis.__MARROW_INSTALL_IDENTITY_CAPTURE__;

    await import(`${pathToFileURL(runtimePath).href}?case=installed-identity-${Date.now()}`);

    assert.equal(globalThis.__MARROW_INSTALL_IDENTITY_CAPTURE__.options.agentId, generatedAgentId);
    assert.equal(globalThis.__MARROW_INSTALL_IDENTITY_CAPTURE__.options.baseUrl, 'https://api.identity.example.test');
    assert.equal(mcp.mcpServers.marrow.env.MARROW_FLEET_AGENT_ID, globalThis.__MARROW_INSTALL_IDENTITY_CAPTURE__.options.agentId);
  } finally {
    delete globalThis.__MARROW_PASSIVE_RUNTIME__;
    delete globalThis.__MARROW_INSTALL_IDENTITY_CAPTURE__;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('explicit installer identity wins and repair remains byte-idempotent', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'package.json'), '{}');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Agents\n');
  const explicitAgentId = 'customer-approved-agent';
  const options = () => ({
    cwd: dir,
    mode: 'both',
    yes: true,
    repair: true,
    dryRun: false,
    selfTest: false,
    controller: false,
    apiKey: 'fixture-explicit-credential',
    baseUrl: 'https://api.explicit.example.test',
    agentId: explicitAgentId,
    processCommands: [],
    mcpConfigPaths: [],
  });

  const first = await install(options());
  const mcpPath = path.join(dir, '.mcp.json');
  const runtimePath = path.join(dir, '.marrow', 'passive-runtime.mjs');
  const firstMcp = fs.readFileSync(mcpPath, 'utf8');
  const firstRuntime = fs.readFileSync(runtimePath, 'utf8');
  const second = await install(options());

  assert.equal(first.activation.agent_id, explicitAgentId);
  assert.equal(second.activation.agent_id, explicitAgentId);
  assert.equal(JSON.parse(firstMcp).mcpServers.marrow.env.MARROW_FLEET_AGENT_ID, explicitAgentId);
  assert.match(firstRuntime, /const installedAgentId = "customer-approved-agent";/);
  assert.equal(fs.readFileSync(mcpPath, 'utf8'), firstMcp);
  assert.equal(fs.readFileSync(runtimePath, 'utf8'), firstRuntime);
  assert.equal(second.changes.some((change) => change.applied), false);
  assert.equal(second.changes.every((change) => change.already_present), true);
  assert.doesNotMatch(`${firstMcp}\n${firstRuntime}`, /fixture-explicit-credential/);
  assert.doesNotMatch(firstMcp, /MARROW_API_KEY|\$\{MARROW_API_KEY\}/);
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
  assert.equal(report.sdkDependency.install_command, 'npm install @getmarrow/sdk@3.7.61');
  assert.deepEqual(report.adapterProvenance, ADAPTER_PROVENANCE);

  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ dependencies: { '@getmarrow/sdk': '^3.7.27' } }));
  const moduleDir = path.join(dir, 'node_modules', '@getmarrow', 'sdk');
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.writeFileSync(path.join(moduleDir, 'package.json'), JSON.stringify({ name: '@getmarrow/sdk', version: '0.0.1' }));
  let detected = detectEnvironment(dir, {});
  let sdk = inspectSdkDependency(detected);
  assert.equal(sdk.present, false);
  assert.equal(sdk.installed_version, '0.0.1');
  fs.writeFileSync(path.join(moduleDir, 'package.json'), JSON.stringify({ name: '@getmarrow/sdk', version: '3.7.61' }));
  writeSdkLock(dir, '^3.7.27');
  detected = detectEnvironment(dir, {});
  sdk = inspectSdkDependency(detected);
  assert.equal(sdk.present, true);
  assert.equal(sdk.lock_verified, true);
  assert.equal(sdk.installed_version, '3.7.61');
  assert.equal(sdk.install_command, null);
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
      processCommands: [],
      mcpConfigPaths: [],
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
  assert.equal(report.doctor.healthCommand, 'npx -y --package=@getmarrow/mcp@latest marrow-mcp ping');
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
    processCommands: [],
    mcpConfigPaths: [],
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
          installed_version: '0.1.43',
          latest_version: '0.1.43',
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
    assert.equal(requestHeaders['x-marrow-package-version'], '0.1.48');
    assert.equal(requestHeaders['x-marrow-install-version'], '0.1.48');
    assert.equal(requestHeaders['x-marrow-sdk-version'], '3.7.61');
    assert.equal(requestHeaders['x-marrow-mcp-version'], '3.9.72');
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
      adapter_version: '0.1.43',
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

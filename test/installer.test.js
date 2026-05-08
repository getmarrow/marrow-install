const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildPlan,
  detectEnvironment,
  install,
  parseArgs,
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
  assert.match(runtime, /useWorkflowGate/);
  assert.match(runtime, /MARROW_PASSIVE_VALUE_REPORT !== 'false'/);
  assert.equal((agents.match(/marrow:passive-start/g) || []).length, 1);
  assert.ok(settings.hooks.PostToolUse);
  assert.ok(settings.hooks.UserPromptSubmit);
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

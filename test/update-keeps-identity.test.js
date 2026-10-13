require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  applyPlan,
  buildPlan,
  detectEnvironment,
  install,
  printReport,
} = require('../src/installer');
const PINS = require('../src/pins');

const DEFAULT_URL = 'https://api.getmarrow.ai';
const NO_ALLOWLIST = { baseUrls: new Set(), agentIds: new Set() };
const OLD_PIN = '3.9.98';

function tempDir(prefix = 'marrow-identity-') {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function mcpText(env, extra = '') {
  return `${JSON.stringify({ mcpServers: { marrow: { command: 'node', args: ['marrow-mcp'], env } } }, null, 2)}${extra}\n`;
}

function recordPath(home) {
  return path.join(home, '.marrow', 'identity-record.json');
}

function writeRecord(home, entries, mode = 0o600) {
  fs.mkdirSync(path.join(home, '.marrow'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(recordPath(home), JSON.stringify({ version: 1, entries }), { mode });
  fs.chmodSync(recordPath(home), mode);
}

function readRecord(home) {
  return JSON.parse(fs.readFileSync(recordPath(home), 'utf8')).entries;
}

// One update (or install) of the MCP config at <root>/.mcp.json, with <home> as the user's home.
function run(root, home, options = {}) {
  const detection = detectEnvironment(root, { HOME: home, PATH: process.env.PATH });
  const plan = buildPlan(detection, {
    mode: 'mcp',
    update: true,
    repair: true,
    agentId: 'codex-bob',
    baseUrl: DEFAULT_URL,
    identityAllowlist: NO_ALLOWLIST,
    ...options,
  });
  const changes = applyPlan(plan, { yes: true, dryRun: options.dryRun === true, doctor: false });
  const change = changes.find((entry) => entry.path === path.join(root, '.mcp.json'));
  const env = JSON.parse(fs.readFileSync(path.join(root, '.mcp.json'), 'utf8')).mcpServers.marrow.env;
  return { plan, changes, change, env };
}

function homeWithMcp(env, extra = '') {
  const home = tempDir();
  fs.writeFileSync(path.join(home, 'package.json'), '{}\n');
  fs.writeFileSync(path.join(home, '.mcp.json'), mcpText(env, extra));
  return home;
}

function sha(filePath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex').slice(0, 12);
  } catch {
    return 'absent';
  }
}

function report(changes) {
  const lines = [];
  printReport({
    root: '/r', mode: 'mcp', writeMode: 'dry-run', detected: {}, changes,
    loop_guard_configured: false, loop_guard_self_tested: false, loop_guard_observed: false,
    selfTest: { skipped: true }, toolProfile: null, warnings: [], nextSteps: [],
  }, (text) => lines.push(text));
  return lines.join('');
}

test('pre-record migration: an owner-set home agent id is kept once, printed, and recorded; the next update keeps it as recorded', () => {
  const home = homeWithMcp({ MARROW_BASE_URL: DEFAULT_URL, MARROW_FLEET_AGENT_ID: 'cliff' });
  try {
    const dry = run(home, home, { dryRun: true });
    assert.deepEqual(dry.change.identity_kept, [{ field: 'MARROW_FLEET_AGENT_ID', value: 'cliff', reason: 'pre_record' }]);
    assert.equal(dry.change.identity_divergence, undefined);
    assert.equal(fs.existsSync(recordPath(home)), false, 'a dry run records nothing');
    const text = report(dry.changes);
    assert.match(text, /kept agent identity cliff \(set before this installer recorded identities\)/);
    assert.ok(text.indexOf('Identity:') < text.indexOf('Planned changes:'), 'identity decisions come first');

    const real = run(home, home);
    assert.equal(real.env.MARROW_FLEET_AGENT_ID, 'cliff');
    assert.deepEqual(readRecord(home)[path.join(home, '.mcp.json')], { MARROW_FLEET_AGENT_ID: 'cliff', MARROW_BASE_URL: DEFAULT_URL });
    assert.equal(fs.statSync(recordPath(home)).mode & 0o777, 0o600);

    const again = run(home, home);
    assert.deepEqual(again.change.identity_kept, [{ field: 'MARROW_FLEET_AGENT_ID', value: 'cliff', reason: 'recorded' }]);
    assert.equal(again.env.MARROW_FLEET_AGENT_ID, 'cliff');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a recorded identity edited by an agent is reset and reported', () => {
  const home = homeWithMcp({ MARROW_BASE_URL: DEFAULT_URL, MARROW_FLEET_AGENT_ID: 'devon' });
  try {
    writeRecord(home, { [path.join(home, '.mcp.json')]: { MARROW_FLEET_AGENT_ID: 'cliff' } });
    const result = run(home, home);
    assert.equal(result.env.MARROW_FLEET_AGENT_ID, 'codex-bob');
    assert.deepEqual(result.change.identity_divergence, [{ field: 'MARROW_FLEET_AGENT_ID', replaced: 'devon', applied: 'codex-bob' }]);
    assert.equal(result.change.identity_kept, undefined);
    assert.match(report(result.changes), /reset MARROW_FLEET_AGENT_ID devon -> codex-bob/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('migration fails closed: tracked, group-writable, duplicate or escaped key, malformed id, project scope, and a link are all reset', () => {
  const cases = [
    ['git-tracked home config', (home) => {
      const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd: home });
      assert.equal(git('init', '-q').status, 0);
      assert.equal(git('add', '.mcp.json').status, 0);
    }],
    ['group-writable file', (home) => fs.chmodSync(path.join(home, '.mcp.json'), 0o664)],
    ['world-writable file', (home) => fs.chmodSync(path.join(home, '.mcp.json'), 0o646)],
    ['duplicate key', (home) => fs.writeFileSync(path.join(home, '.mcp.json'),
      '{"mcpServers":{"marrow":{"command":"node","env":{"MARROW_FLEET_AGENT_ID":"codex-bob","MARROW_FLEET_AGENT_ID":"cliff"}}}}\n')],
    ['escaped duplicate key', (home) => fs.writeFileSync(path.join(home, '.mcp.json'),
      '{"mcpServers":{"marrow":{"command":"node","env":{"MARROW_FLEET_AGENT_ID":"codex-bob","MARROW_FLEET\\u005fAGENT_ID":"cliff"}}}}\n')],
    ['unicode id', (home) => fs.writeFileSync(path.join(home, '.mcp.json'), mcpText({ MARROW_FLEET_AGENT_ID: 'cliffé' }))],
    ['padded id', (home) => fs.writeFileSync(path.join(home, '.mcp.json'), mcpText({ MARROW_FLEET_AGENT_ID: ' cliff ' }))],
    ['oversized id', (home) => fs.writeFileSync(path.join(home, '.mcp.json'), mcpText({ MARROW_FLEET_AGENT_ID: 'c'.repeat(129) }))],
  ];
  for (const [name, mutate] of cases) {
    const home = homeWithMcp({ MARROW_BASE_URL: DEFAULT_URL, MARROW_FLEET_AGENT_ID: 'cliff' });
    try {
      mutate(home);
      const result = run(home, home);
      assert.equal(result.env.MARROW_FLEET_AGENT_ID, 'codex-bob', name);
      assert.equal(result.change.identity_kept, undefined, name);
      assert.equal(result.change.identity_divergence?.[0]?.field, 'MARROW_FLEET_AGENT_ID', name);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  // A project config (the update root is not the home) is never migrated.
  const home = tempDir();
  const project = homeWithMcp({ MARROW_BASE_URL: DEFAULT_URL, MARROW_FLEET_AGENT_ID: 'cliff' });
  try {
    const result = run(project, home);
    assert.equal(result.env.MARROW_FLEET_AGENT_ID, 'codex-bob');
    assert.equal(result.change.identity_divergence[0].replaced, 'cliff');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('a base URL is never kept by migration; only a record or the allowlist keeps it, and a credential URL is never recorded', () => {
  const home = homeWithMcp({ MARROW_BASE_URL: 'https://elsewhere.example.test', MARROW_FLEET_AGENT_ID: 'cliff' });
  try {
    const reset = run(home, home);
    assert.equal(reset.env.MARROW_BASE_URL, DEFAULT_URL);
    assert.deepEqual(reset.change.identity_divergence, [{ field: 'MARROW_BASE_URL', replaced: 'https://elsewhere.example.test', applied: DEFAULT_URL }]);
    assert.equal(reset.env.MARROW_FLEET_AGENT_ID, 'cliff', 'the agent id still migrates');

    fs.writeFileSync(path.join(home, '.mcp.json'), mcpText({ MARROW_BASE_URL: 'https://staging.example.test', MARROW_FLEET_AGENT_ID: 'cliff' }));
    writeRecord(home, { [path.join(home, '.mcp.json')]: { MARROW_FLEET_AGENT_ID: 'cliff', MARROW_BASE_URL: 'https://staging.example.test' } });
    const recorded = run(home, home);
    assert.equal(recorded.env.MARROW_BASE_URL, 'https://staging.example.test');
    assert.equal(recorded.change.identity_divergence, undefined);

    // An allowlisted base URL is kept but not recorded, so it is reset once it leaves the allowlist.
    fs.writeFileSync(path.join(home, '.mcp.json'), mcpText({ MARROW_BASE_URL: 'https://allowed.example.test', MARROW_FLEET_AGENT_ID: 'cliff' }));
    const allowed = run(home, home, { identityAllowlist: { baseUrls: new Set(['https://allowed.example.test']), agentIds: new Set() } });
    assert.equal(allowed.env.MARROW_BASE_URL, 'https://allowed.example.test');
    assert.equal(readRecord(home)[path.join(home, '.mcp.json')].MARROW_BASE_URL, undefined);
    assert.equal(run(home, home).env.MARROW_BASE_URL, DEFAULT_URL);

    // A URL carrying credentials is applied only by the owner's choice and never stored.
    const user = `u${crypto.randomBytes(4).toString('hex')}`;
    const pass = `p${crypto.randomBytes(8).toString('hex')}`;
    fs.writeFileSync(path.join(home, '.mcp.json'), mcpText({ MARROW_FLEET_AGENT_ID: 'cliff' }));
    run(home, home, { baseUrl: `https://${user}:${pass}@staging.example.test` });
    const stored = fs.readFileSync(recordPath(home), 'utf8');
    assert.doesNotMatch(stored, new RegExp(`${user}|${pass}`));
    assert.equal(readRecord(home)[path.join(home, '.mcp.json')].MARROW_BASE_URL, undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('an unsafe or foreign record is ignored: link, shared mode, another owner, another path; a record never authorizes another file', () => {
  const home = tempDir();
  const project = homeWithMcp({ MARROW_BASE_URL: DEFAULT_URL, MARROW_FLEET_AGENT_ID: 'devon' });
  const projectMcp = path.join(project, '.mcp.json');
  const reset = (label) => {
    const result = run(project, home, { dryRun: true });
    assert.equal(result.change.identity_kept, undefined, label);
    assert.equal(result.change.identity_divergence?.[0]?.replaced, 'devon', label);
  };
  try {
    writeRecord(home, { [projectMcp]: { MARROW_FLEET_AGENT_ID: 'devon' } });
    assert.equal(run(project, home, { dryRun: true }).change.identity_kept[0].reason, 'recorded', 'control: a safe record keeps it');

    fs.chmodSync(recordPath(home), 0o644);
    reset('0644 record');
    fs.chmodSync(recordPath(home), 0o600);

    const realGetuid = process.getuid;
    process.getuid = () => realGetuid() + 1;
    try {
      reset('record owned by another user');
    } finally {
      process.getuid = realGetuid;
    }

    const elsewhere = path.join(home, 'elsewhere.json');
    fs.renameSync(recordPath(home), elsewhere);
    fs.symlinkSync(elsewhere, recordPath(home));
    reset('linked record');
    fs.unlinkSync(recordPath(home));

    fs.chmodSync(path.join(home, '.marrow'), 0o770);
    writeRecord(home, { [projectMcp]: { MARROW_FLEET_AGENT_ID: 'devon' } });
    fs.chmodSync(path.join(home, '.marrow'), 0o770);
    reset('group-writable record folder');
    fs.chmodSync(path.join(home, '.marrow'), 0o700);

    // Collision: the home's record for its own file never authorizes the project file.
    writeRecord(home, { [path.join(home, '.mcp.json')]: { MARROW_FLEET_AGENT_ID: 'devon' } });
    reset('record for another path');

    // Two files with two ids keep two records.
    fs.writeFileSync(path.join(home, '.mcp.json'), mcpText({ MARROW_FLEET_AGENT_ID: 'cliff' }));
    fs.writeFileSync(path.join(home, 'package.json'), '{}\n');
    writeRecord(home, {});
    run(home, home, { agentId: 'cliff', update: false, repair: false });
    run(project, home, { agentId: 'devon', update: false, repair: false });
    assert.deepEqual(readRecord(home), {
      [path.join(home, '.mcp.json')]: { MARROW_FLEET_AGENT_ID: 'cliff', MARROW_BASE_URL: DEFAULT_URL },
      [projectMcp]: { MARROW_FLEET_AGENT_ID: 'devon', MARROW_BASE_URL: DEFAULT_URL },
    });
    assert.equal(run(home, home).env.MARROW_FLEET_AGENT_ID, 'cliff');
    assert.equal(run(project, home).env.MARROW_FLEET_AGENT_ID, 'devon');
    fs.writeFileSync(projectMcp, mcpText({ MARROW_FLEET_AGENT_ID: 'cliff' }));
    assert.equal(run(project, home).env.MARROW_FLEET_AGENT_ID, 'codex-bob', 'cliff is recorded for the home file only');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('MARROW_ALLOWED_AGENT_IDS in a repo .env is ignored, and maintenance never uses the record', () => {
  const home = tempDir();
  const project = homeWithMcp({ MARROW_BASE_URL: DEFAULT_URL, MARROW_FLEET_AGENT_ID: 'devon' });
  try {
    fs.writeFileSync(path.join(project, '.env'), 'MARROW_ALLOWED_AGENT_IDS=devon\nMARROW_ALLOWED_BASE_URLS=https://elsewhere.example.test\n');
    const detection = detectEnvironment(project, { HOME: home, PATH: process.env.PATH });
    const changes = applyPlan(buildPlan(detection, { mode: 'mcp', update: true, agentId: 'codex-bob', baseUrl: DEFAULT_URL }), { yes: true, dryRun: true });
    assert.equal(changes.find((change) => change.path === path.join(project, '.mcp.json')).identity_divergence[0].replaced, 'devon');

    writeRecord(home, { [path.join(project, '.mcp.json')]: { MARROW_FLEET_AGENT_ID: 'devon' } });
    const maintained = run(project, home, { update: false, repair: false, maintenance: true });
    assert.equal(maintained.env.MARROW_FLEET_AGENT_ID, 'codex-bob');
    assert.equal(readRecord(home)[path.join(project, '.mcp.json')].MARROW_FLEET_AGENT_ID, 'devon', 'maintenance records nothing');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

test('update keeps owner files: only the Marrow block of AGENTS.md changes, owner-only AGENTS.md and new hosts are left alone', () => {
  const home = homeWithMcp({ MARROW_BASE_URL: DEFAULT_URL, MARROW_FLEET_AGENT_ID: 'cliff' });
  const agentsMd = path.join(home, 'AGENTS.md');
  try {
    const head = '# Fleet process\n\nOwner rules stay here.  \n\n\n';
    const tail = '\n\n## After the block\nMore owner text.\n';
    fs.writeFileSync(agentsMd, `${head}<!-- marrow:passive-start -->\nold @getmarrow/mcp@${OLD_PIN}\n<!-- marrow:passive-end -->${tail}`);
    fs.mkdirSync(path.join(home, '.cursor'));
    run(home, home, { mode: 'auto' });
    const after = fs.readFileSync(agentsMd, 'utf8');
    assert.ok(after.startsWith(`${head}<!-- marrow:passive-start -->`), 'owner bytes before the block are identical');
    assert.ok(after.endsWith(`<!-- marrow:passive-end -->${tail}`), 'owner bytes after the block are identical');
    assert.doesNotMatch(after, new RegExp(`@getmarrow/mcp@${OLD_PIN.replaceAll('.', '\\.')}`));
    for (const file of ['mcp.json', 'hooks.json', path.join('rules', 'marrow.mdc')]) {
      assert.equal(fs.existsSync(path.join(home, '.cursor', file)), false, `update created .cursor/${file}`);
    }

    const ownerOnly = `${head}No Marrow here.\n`;
    fs.writeFileSync(agentsMd, ownerOnly);
    const { changes } = run(home, home, { mode: 'auto' });
    assert.equal(fs.readFileSync(agentsMd, 'utf8'), ownerOnly);
    assert.equal(changes.some((change) => change.path === agentsMd), false);

    // An explicit install still adds the block and the Cursor files.
    run(home, home, { mode: 'mcp', update: false, repair: false });
    assert.ok(fs.existsSync(path.join(home, '.cursor', 'mcp.json')));
    assert.match(fs.readFileSync(agentsMd, 'utf8'), /marrow:passive-start/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('ops-host layout: dry-run and real update keep cliff, write no Cursor file, keep owner bytes and Grok owner entries, and say to re-review hooks', async () => {
  const home = tempDir('marrow-opshost-');
  const options = (extra) => ({
    cwd: home, home, mode: 'auto', yes: true, dryRun: false, selfTest: false, loopGuardSelfTest: false, controller: false,
    apiKey: '', baseUrl: DEFAULT_URL, mcpLocalRuntime: false, mcpRegistryMetadata: null, identityAllowlist: NO_ALLOWLIST, ...extra,
  });
  const files = ['.mcp.json', 'AGENTS.md', '.codex/hooks.json', '.grok/hooks/marrow.json', '.claude/settings.json',
    '.cursor/mcp.json', '.cursor/hooks.json', '.cursor/rules/marrow.mdc', '.marrow/identity-record.json'];
  const hashes = () => Object.fromEntries(files.map((file) => [file, sha(path.join(home, file))]));
  try {
    fs.mkdirSync(path.join(home, '.claude'));
    fs.mkdirSync(path.join(home, '.grok', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(home, 'AGENTS.md'), '# Fleet process\n\nOwner text.\n');
    await install(options({ agentId: 'cliff' }));
    // The 0.1.71 layout: older pins, no Cursor Marrow config, no identity record, owner Grok hooks.
    for (const file of files) {
      const filePath = path.join(home, file);
      if (fs.existsSync(filePath)) fs.writeFileSync(filePath, fs.readFileSync(filePath, 'utf8').replaceAll(PINS.MCP_ADAPTER_VERSION, OLD_PIN));
    }
    for (const file of ['mcp.json', 'hooks.json', path.join('rules', 'marrow.mdc')]) fs.rmSync(path.join(home, '.cursor', file), { force: true });
    fs.rmSync(recordPath(home), { force: true });
    const grokPath = path.join(home, '.grok', 'hooks', 'marrow.json');
    const grok = JSON.parse(fs.readFileSync(grokPath, 'utf8'));
    const ownerGroup = { matcher: 'Owner', hooks: [{ type: 'command', command: 'owner-check.sh' }] };
    grok.hooks.PreToolUse.unshift(ownerGroup);
    grok.hooks.Notification = [{ hooks: [{ type: 'command', command: 'owner-notify.sh' }] }];
    fs.writeFileSync(grokPath, `${JSON.stringify(grok, null, 2)}\n`);
    const ownerText = `"Notification": ${JSON.stringify(grok.hooks.Notification, null, 2).replaceAll('\n', '\n    ')}`;
    assert.ok(fs.readFileSync(grokPath, 'utf8').includes(ownerText), 'fixture: owner text located');
    const agentsBefore = fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8');
    const ownerPrefix = agentsBefore.slice(0, agentsBefore.indexOf('<!-- marrow:passive-start -->'));

    const before = hashes();
    const dry = await install(options({ agentId: 'codex-bob', update: true, repair: true, dryRun: true }));
    assert.deepEqual(hashes(), before, 'a dry run writes nothing');
    const dryText = [];
    printReport(dry, (text) => dryText.push(text));
    const printed = dryText.join('');
    assert.match(printed, /kept agent identity cliff \(set before this installer recorded identities\)/);
    assert.doesNotMatch(printed, /identity reset|reset MARROW_FLEET_AGENT_ID/);
    assert.ok(printed.indexOf('Identity:') < printed.indexOf('Planned changes:'));
    assert.equal(dry.changes.some((change) => change.path.includes(`${path.sep}.cursor${path.sep}`)), false);

    const real = await install(options({ agentId: 'codex-bob', update: true, repair: true }));
    const after = hashes();
    const mcp = JSON.parse(fs.readFileSync(path.join(home, '.mcp.json'), 'utf8')).mcpServers.marrow.env;
    assert.equal(mcp.MARROW_FLEET_AGENT_ID, 'cliff');
    assert.equal(readRecord(home)[path.join(home, '.mcp.json')].MARROW_FLEET_AGENT_ID, 'cliff');
    for (const file of ['.cursor/mcp.json', '.cursor/hooks.json', '.cursor/rules/marrow.mdc']) assert.equal(after[file], 'absent', file);
    const agentsAfter = fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8');
    assert.ok(agentsAfter.startsWith(ownerPrefix));
    const grokAfter = fs.readFileSync(grokPath, 'utf8');
    assert.ok(grokAfter.includes(ownerText), 'owner Grok entries are byte-identical');
    assert.deepEqual(JSON.parse(grokAfter).hooks.PreToolUse[0], ownerGroup, 'owner Grok entry keeps its place');
    const realText = [];
    printReport(real, (text) => realText.push(text));
    assert.match(realText.join(''), /re-review Marrow's hooks in Grok/);
    const table = files.map((file) => `| ${file} | ${before[file]} | ${after[file]} | ${(real.changes.find((change) => change.path === path.join(home, file)) || {}).change_class || '-'} |`);
    if (process.env.IDENTITY_EVIDENCE_OUT) {
      fs.writeFileSync(process.env.IDENTITY_EVIDENCE_OUT, `${['| file | before | after | class |', '|---|---|---|---|', ...table].join('\n')}\n\nDRY RUN:\n${printed}\nREAL RUN:\n${realText.join('')}`);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

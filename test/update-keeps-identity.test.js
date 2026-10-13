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
  installSummaryLines,
  parseArgs,
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
    assert.deepEqual(readRecord(home)[path.join(home, '.mcp.json')], { MARROW_FLEET_AGENT_ID: 'cliff' });
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

test('a base URL is never kept by migration or by a record, only by the allowlist as before, and is never recorded', () => {
  const home = homeWithMcp({ MARROW_BASE_URL: 'https://elsewhere.example.test', MARROW_FLEET_AGENT_ID: 'cliff' });
  const mcp = path.join(home, '.mcp.json');
  try {
    const reset = run(home, home);
    assert.equal(reset.env.MARROW_BASE_URL, DEFAULT_URL);
    assert.deepEqual(reset.change.identity_divergence, [{ field: 'MARROW_BASE_URL', replaced: 'https://elsewhere.example.test', applied: DEFAULT_URL }]);
    assert.equal(reset.env.MARROW_FLEET_AGENT_ID, 'cliff', 'the agent id still migrates');
    assert.doesNotMatch(fs.readFileSync(recordPath(home), 'utf8'), /MARROW_BASE_URL|https?:/, 'the record holds no URL');

    // A record entry carrying a base URL (forged, or from an older candidate) keeps nothing.
    fs.writeFileSync(mcp, mcpText({ MARROW_BASE_URL: 'https://staging.example.test', MARROW_FLEET_AGENT_ID: 'cliff' }));
    writeRecord(home, { [mcp]: { MARROW_FLEET_AGENT_ID: 'cliff', MARROW_BASE_URL: 'https://staging.example.test' } });
    const forged = run(home, home);
    assert.equal(forged.env.MARROW_BASE_URL, DEFAULT_URL);
    assert.equal(forged.change.identity_divergence[0].field, 'MARROW_BASE_URL');
    assert.equal(forged.env.MARROW_FLEET_AGENT_ID, 'cliff');
    assert.deepEqual(readRecord(home)[mcp], { MARROW_FLEET_AGENT_ID: 'cliff' });

    // The allowlist keeps it as before, and only while it is on the allowlist.
    fs.writeFileSync(mcp, mcpText({ MARROW_BASE_URL: 'https://allowed.example.test', MARROW_FLEET_AGENT_ID: 'cliff' }));
    const allowed = run(home, home, { identityAllowlist: { baseUrls: new Set(['https://allowed.example.test']), agentIds: new Set() } });
    assert.equal(allowed.env.MARROW_BASE_URL, 'https://allowed.example.test');
    assert.equal(run(home, home).env.MARROW_BASE_URL, DEFAULT_URL);

    // A configured URL carrying credentials is applied by the owner's choice and never stored.
    const user = `u${crypto.randomBytes(4).toString('hex')}`;
    const pass = `p${crypto.randomBytes(8).toString('hex')}`;
    fs.writeFileSync(mcp, mcpText({ MARROW_FLEET_AGENT_ID: 'cliff' }));
    const credential = run(home, home, { baseUrl: `https://${user}:${pass}@staging.example.test` });
    assert.doesNotMatch(fs.readFileSync(recordPath(home), 'utf8'), new RegExp(`${user}|${pass}|staging`));
    assert.doesNotMatch(report(credential.changes), new RegExp(`${user}|${pass}`));
    // ...and the next plain update resets it to the configured default, as before.
    assert.equal(run(home, home).env.MARROW_BASE_URL, DEFAULT_URL);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('an allowlisted agent id is kept as before but not recorded, so it is reset once it leaves the allowlist', () => {
  const home = homeWithMcp({ MARROW_BASE_URL: DEFAULT_URL, MARROW_FLEET_AGENT_ID: 'devon' });
  const mcp = path.join(home, '.mcp.json');
  try {
    writeRecord(home, { [mcp]: { MARROW_FLEET_AGENT_ID: 'codex-bob' } });
    const allowed = run(home, home, { identityAllowlist: { baseUrls: new Set(), agentIds: new Set(['devon']) } });
    assert.equal(allowed.env.MARROW_FLEET_AGENT_ID, 'devon');
    assert.deepEqual(readRecord(home)[mcp], {}, 'an allowlist keep is not recorded');
    const after = run(home, home);
    assert.equal(after.env.MARROW_FLEET_AGENT_ID, 'codex-bob');
    assert.equal(after.change.identity_divergence[0].replaced, 'devon');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('migration refuses a home config reached through a link: a linked folder into a repo (tracked or not) or a linked file', () => {
  const cases = [
    ['plain home folder (control)', false, 'none'],
    ['linked folder into a repo that tracks the file', true, 'folder'],
    ['linked folder to an untracked owner folder', false, 'folder'],
    ['linked file', false, 'file'],
  ];
  for (const [name, tracked, kind] of cases) {
    const home = tempDir();
    const elsewhere = tempDir('marrow-elsewhere-');
    try {
      fs.writeFileSync(path.join(home, 'package.json'), '{}\n');
      const cursorReal = kind === 'none' ? path.join(home, '.cursor') : path.join(elsewhere, 'nested', '.cursor');
      fs.mkdirSync(cursorReal, { recursive: true });
      fs.writeFileSync(path.join(cursorReal, 'mcp.json'), mcpText({ MARROW_BASE_URL: DEFAULT_URL, MARROW_FLEET_AGENT_ID: 'cliff' }));
      if (tracked) {
        const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd: elsewhere });
        assert.equal(git('init', '-q').status, 0);
        assert.equal(git('add', path.join('nested', '.cursor', 'mcp.json')).status, 0);
      }
      if (kind === 'folder') fs.symlinkSync(cursorReal, path.join(home, '.cursor'));
      if (kind === 'file') {
        fs.mkdirSync(path.join(home, '.cursor'));
        fs.symlinkSync(path.join(cursorReal, 'mcp.json'), path.join(home, '.cursor', 'mcp.json'));
      }
      const detection = detectEnvironment(home, { HOME: home, PATH: process.env.PATH });
      const plan = buildPlan(detection, { mode: 'mcp', update: true, repair: true, agentId: 'codex-bob', baseUrl: DEFAULT_URL, identityAllowlist: NO_ALLOWLIST });
      const write = plan.writes.find((entry) => entry.path === path.join(home, '.cursor', 'mcp.json'));
      assert.ok(write, `${name}: the Cursor MCP config is planned`);
      if (kind === 'none') {
        applyPlan(plan, { yes: true, dryRun: true, doctor: false });
        assert.equal(write.identityKept[0]?.reason, 'pre_record', name);
        continue;
      }
      // The write guard refuses the linked path (as before), and the migration rule refuses it on
      // its own as well, so it never depends on the guard.
      assert.throws(() => applyPlan(plan, { yes: true, dryRun: true, doctor: false }), /Refusing installer write/, name);
      write.transform(write.path);
      assert.deepEqual(write.identityKept, [], name);
      assert.equal(write.identityDivergence[0]?.replaced, 'cliff', name);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  }
});

test('doctor shows the decision update makes, and the one-command summary prints the one-time keep line', () => {
  const home = homeWithMcp({ MARROW_BASE_URL: DEFAULT_URL, MARROW_FLEET_AGENT_ID: 'cliff' });
  const doctor = () => {
    const detection = detectEnvironment(home, { HOME: home, PATH: process.env.PATH });
    const plan = buildPlan(detection, { mode: 'mcp', doctor: true, agentId: 'codex-bob', baseUrl: DEFAULT_URL, identityAllowlist: NO_ALLOWLIST });
    return applyPlan(plan, { yes: false, dryRun: false, doctor: true }).find((change) => change.path === path.join(home, '.mcp.json'));
  };
  try {
    const before = doctor();
    assert.equal(before.identity_kept[0].reason, 'pre_record');
    assert.equal(before.identity_divergence, undefined);
    assert.equal(fs.existsSync(recordPath(home)), false, 'doctor records nothing');

    const updated = run(home, home);
    const { lines } = installSummaryLines({ changes: updated.changes, selfTest: { skipped: true }, warnings: [], nextSteps: [] }, { update: true });
    assert.equal(lines.filter((line) => /^Kept agent identity cliff \(set before this installer recorded identities\)/.test(line)).length, 1);
    assert.equal(lines.some((line) => /identity reset/.test(line)), false);

    const after = doctor();
    assert.equal(after.changed, false, 'doctor plans no identity change after update');
    assert.equal(after.identity_kept[0].reason, 'recorded');

    // An agent's later edit still shows in doctor as the reset update would make.
    fs.writeFileSync(path.join(home, '.mcp.json'), mcpText({ MARROW_BASE_URL: DEFAULT_URL, MARROW_FLEET_AGENT_ID: 'devon' }));
    assert.equal(doctor().identity_divergence[0].replaced, 'devon');
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
      [path.join(home, '.mcp.json')]: { MARROW_FLEET_AGENT_ID: 'cliff' },
      [projectMcp]: { MARROW_FLEET_AGENT_ID: 'devon' },
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
    const updated = run(home, home, { mode: 'auto', updateOnly: true });
    const after = fs.readFileSync(agentsMd, 'utf8');
    assert.ok(after.startsWith(`${head}<!-- marrow:passive-start -->`), 'owner bytes before the block are identical');
    assert.ok(after.endsWith(`<!-- marrow:passive-end -->${tail}`), 'owner bytes after the block are identical');
    assert.doesNotMatch(after, new RegExp(`@getmarrow/mcp@${OLD_PIN.replaceAll('.', '\\.')}`));
    for (const file of ['mcp.json', 'hooks.json', path.join('rules', 'marrow.mdc')]) {
      assert.equal(fs.existsSync(path.join(home, '.cursor', file)), false, `update created .cursor/${file}`);
    }
    // What update leaves alone is named, with the command that writes it.
    const skippedLabels = updated.plan.update_skipped.map((skipped) => skipped.label);
    for (const label of ['Cursor MCP server config', 'Cursor Marrow rule', 'Cursor native hooks']) {
      assert.ok(skippedLabels.includes(label), `update names ${label} as left alone`);
    }

    const ownerOnly = `${head}No Marrow here.\n`;
    fs.writeFileSync(agentsMd, ownerOnly);
    const { changes } = run(home, home, { mode: 'auto', updateOnly: true });
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
    const dry = await install(options({ agentId: 'codex-bob', update: true, repair: true, updateOnly: true, dryRun: true }));
    assert.deepEqual(hashes(), before, 'a dry run writes nothing');
    const dryText = [];
    printReport(dry, (text) => dryText.push(text));
    const printed = dryText.join('');
    assert.match(printed, /kept agent identity cliff \(set before this installer recorded identities\)/);
    assert.doesNotMatch(printed, /identity reset|reset MARROW_FLEET_AGENT_ID/);
    assert.ok(printed.indexOf('Identity:') < printed.indexOf('Planned changes:'));
    assert.equal(dry.changes.some((change) => change.path.includes(`${path.sep}.cursor${path.sep}`)), false);

    const real = await install(options({ agentId: 'codex-bob', update: true, repair: true, updateOnly: true }));
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

// ---------------------------------------------------------------------------------------------
// Patch round 1 (audit 647f330a F1-F7). Fake homes only; installs run in-process with the
// self-test, controller and network off and no key.

function hostLayout(home, hosts = {}) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(path.join(home, '.grok', 'hooks'), { recursive: true });
  if (hosts.codex) {
    fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '# owner\n');
  }
  for (const name of ['cursor', 'gemini', 'windsurf']) if (hosts[name]) fs.mkdirSync(path.join(home, `.${name}`), { recursive: true });
  if (hosts.cline) fs.mkdirSync(path.join(home, '.clinerules'), { recursive: true });
  fs.writeFileSync(path.join(home, 'AGENTS.md'), '# Fleet process\n\nOwner text.\n');
}

function installOptions(home, extra = {}) {
  return {
    cwd: home, home, mode: 'auto', yes: true, dryRun: false, doctor: false, selfTest: false, loopGuardSelfTest: false,
    controller: false, apiKey: '', baseUrl: DEFAULT_URL, mcpLocalRuntime: false, mcpRegistryMetadata: null,
    processCommands: [], mcpConfigPaths: [], identityAllowlist: NO_ALLOWLIST, ...extra,
  };
}

async function installHome(home, extra = {}) {
  const report = await install(installOptions(home, extra));
  const lines = [];
  printReport(report, (text) => lines.push(text));
  return { report, printed: lines.join(''), summary: installSummaryLines(report, installOptions(home, extra)).lines };
}

const homeMcp = (home) => path.join(home, '.mcp.json');
const homeMcpId = (home) => JSON.parse(fs.readFileSync(homeMcp(home), 'utf8')).mcpServers.marrow.env.MARROW_FLEET_AGENT_ID;
function setHomeMcpId(home, id) {
  const config = JSON.parse(fs.readFileSync(homeMcp(home), 'utf8'));
  config.mcpServers.marrow.env.MARROW_FLEET_AGENT_ID = id;
  fs.writeFileSync(homeMcp(home), `${JSON.stringify(config, null, 2)}\n`);
}
function readRecordBytes(home) {
  try {
    return fs.readFileSync(recordPath(home));
  } catch {
    return null;
  }
}

test('F1: on the home config, a record that exists but is unsafe, unreadable or lacks the entry keeps nothing and opens no migration', async () => {
  const cases = [
    ['entry removed (A03)', (home) => fs.writeFileSync(recordPath(home), JSON.stringify({ version: 1, entries: {} }), { mode: 0o600 }), false],
    ['record 0644 (A04)', (home) => fs.chmodSync(recordPath(home), 0o644), true],
    ['record is a symlink (A05)', (home) => {
      const other = path.join(home, 'elsewhere.json');
      fs.writeFileSync(other, JSON.stringify({ version: 1, entries: { [homeMcp(home)]: { MARROW_FLEET_AGENT_ID: 'devon' } } }), { mode: 0o600 });
      fs.rmSync(recordPath(home));
      fs.symlinkSync(other, recordPath(home));
    }, true],
    ['record is a hard link (A07)', (home) => {
      const other = path.join(home, 'linked-record.json');
      fs.writeFileSync(other, JSON.stringify({ version: 1, entries: { [homeMcp(home)]: { MARROW_FLEET_AGENT_ID: 'devon' } } }), { mode: 0o600 });
      fs.rmSync(recordPath(home));
      fs.linkSync(other, recordPath(home));
    }, true],
    ['~/.marrow 0775 (A08)', (home) => fs.chmodSync(path.join(home, '.marrow'), 0o775), true],
    ['bad JSON (A09)', (home) => fs.writeFileSync(recordPath(home), '{not json'), true],
    ['over 64 KiB (A10)', (home) => fs.writeFileSync(recordPath(home), JSON.stringify({ version: 1, entries: { [homeMcp(home)]: { MARROW_FLEET_AGENT_ID: 'cliff' } }, pad: 'x'.repeat(70000) })), true],
    ['unreadable (mode 0000)', (home) => fs.chmodSync(recordPath(home), 0o000), true],
    ['wrong version', (home) => fs.writeFileSync(recordPath(home), JSON.stringify({ version: 2, entries: {} })), true],
    ['malformed id in an entry', (home) => fs.writeFileSync(recordPath(home), JSON.stringify({ version: 1, entries: { [homeMcp(home)]: { MARROW_FLEET_AGENT_ID: 'de von' } } })), true],
    ['record copied from another home (C03)', (home) => {
      fs.writeFileSync(recordPath(home), JSON.stringify({ version: 1, entries: { '/home/other/.mcp.json': { MARROW_FLEET_AGENT_ID: 'cliff' } } }), { mode: 0o600 });
    }, false],
  ];
  for (const [name, tamper, invalid] of cases) {
    const home = tempDir('marrow-f1-');
    try {
      hostLayout(home);
      await installHome(home, { agentId: 'cliff' });
      assert.equal(readRecord(home)[homeMcp(home)].MARROW_FLEET_AGENT_ID, 'cliff', `${name}: fixture recorded cliff`);
      setHomeMcpId(home, 'devon');
      tamper(home);
      const before = readRecordBytes(home);
      for (const round of [1, 2]) {
        const { report, printed, summary } = await installHome(home, { agentId: 'codex-bob', update: true, repair: true, updateOnly: true });
        assert.equal(homeMcpId(home), 'codex-bob', `${name} round ${round}: reset as master`);
        const change = report.changes.find((entry) => entry.path === homeMcp(home));
        if (round === 1) {
          assert.equal(change.identity_divergence?.[0]?.replaced, 'devon', `${name}: reset reported`);
          assert.match(printed, /reset MARROW_FLEET_AGENT_ID devon -> codex-bob/, name);
        }
        assert.equal(change.identity_kept, undefined, `${name} round ${round}: nothing kept`);
        assert.doesNotMatch(printed, /kept agent identity/, name);
        if (invalid) {
          assert.equal(change.identity_record_invalid, true, name);
          assert.match(printed, /identity record ~\/\.marrow\/identity-record\.json is unsafe or unreadable/, name);
          assert.ok(summary.some((line) => /identity record .* is unsafe or unreadable/.test(line)), `${name}: summary says so`);
          // Never written over or through, so nothing is re-recorded from it.
          assert.deepEqual(readRecordBytes(home), before, `${name} round ${round}: record untouched`);
        }
        setHomeMcpId(home, 'devon');
      }
    } finally {
      try { fs.chmodSync(path.join(home, '.marrow'), 0o700); } catch {}
      try { fs.chmodSync(recordPath(home), 0o600); } catch {}
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('F1 residual: with the record file deleted, the one-time keep runs again (same-uid writer), and says so', async () => {
  const home = tempDir('marrow-f1-');
  try {
    hostLayout(home);
    await installHome(home, { agentId: 'cliff' });
    setHomeMcpId(home, 'devon');
    fs.rmSync(recordPath(home));
    const { summary } = await installHome(home, { agentId: 'codex-bob', update: true, repair: true, updateOnly: true });
    assert.equal(homeMcpId(home), 'devon');
    assert.ok(summary.some((line) => /^Kept agent identity devon \(set before this installer recorded identities\)/.test(line)));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('F2: repair restores every deleted or stripped Marrow surface as before, and doctor lists exactly what repair writes', async () => {
  const hosts = { codex: true, cursor: true, gemini: true, windsurf: true, cline: true };
  const surfaces = [
    ['Grok (U01)', (home) => fs.rmSync(path.join(home, '.grok', 'hooks', 'marrow.json')), (home) => path.join(home, '.grok', 'hooks', 'marrow.json')],
    ['Codex (U02)', (home) => fs.rmSync(path.join(home, '.codex', 'hooks.json')), (home) => path.join(home, '.codex', 'hooks.json')],
    ['Gemini (U03)', (home) => fs.rmSync(path.join(home, '.gemini', 'settings.json')), (home) => path.join(home, '.gemini', 'settings.json')],
    ['Cursor (U04)', (home) => { for (const file of ['mcp.json', 'hooks.json', path.join('rules', 'marrow.mdc')]) fs.rmSync(path.join(home, '.cursor', file)); }, (home) => path.join(home, '.cursor', 'hooks.json')],
    ['Claude (U05)', (home) => { fs.rmSync(path.join(home, '.claude', 'settings.json')); fs.rmSync(homeMcp(home)); }, (home) => path.join(home, '.claude', 'settings.json')],
    ['AGENTS.md block (U06)', (home) => {
      const file = path.join(home, 'AGENTS.md');
      const text = fs.readFileSync(file, 'utf8');
      const start = text.indexOf('<!-- marrow:passive-start -->');
      const end = text.indexOf('<!-- marrow:passive-end -->') + '<!-- marrow:passive-end -->'.length;
      fs.writeFileSync(file, text.slice(0, start) + text.slice(end));
    }, (home) => path.join(home, 'AGENTS.md')],
    ['Windsurf (U07)', (home) => fs.rmSync(path.join(home, '.windsurf', 'hooks.json')), (home) => path.join(home, '.windsurf', 'hooks.json')],
    ['Cline (U08)', (home) => { for (const file of ['PreToolUse', 'PostToolUse', 'TaskCancel']) fs.rmSync(path.join(home, '.clinerules', 'hooks', file)); }, (home) => path.join(home, '.clinerules', 'hooks', 'PreToolUse')],
    ['Codex Marrow entries stripped, owner entry kept (U12)', (home) => {
      fs.writeFileSync(path.join(home, '.codex', 'hooks.json'), `${JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Owner', hooks: [{ type: 'command', command: 'owner-check.sh' }] }] } }, null, 2)}\n`);
    }, (home) => path.join(home, '.codex', 'hooks.json')],
  ];
  for (const [name, remove, probe] of surfaces) {
    const home = tempDir('marrow-f2-');
    try {
      hostLayout(home, hosts);
      await installHome(home, { agentId: 'cliff' });
      const installed = fs.readFileSync(probe(home), 'utf8');
      assert.match(installed, /marrow/i, `${name}: fixture installed`);
      remove(home);

      // update (the word) leaves a surface with no Marrow config alone, and names the fix.
      const updated = await installHome(home, { agentId: 'cliff', update: true, repair: true, updateOnly: true });
      assert.ok(updated.report.update_skipped?.length > 0, `${name}: update names what it left alone`);
      assert.match(updated.printed, /left alone by update: .*--repair/, name);
      assert.ok(updated.summary.some((line) => /^Update left \d+ file\(s\) alone .*--repair/.test(line)), name);

      const doctor = await installHome(home, { agentId: 'cliff', doctor: true, yes: false });
      const wouldWrite = doctor.report.changes.filter((change) => change.changed).map((change) => change.path).sort();
      const repaired = await installHome(home, { agentId: 'cliff', update: true, repair: true });
      const wrote = repaired.report.changes.filter((change) => change.applied).map((change) => change.path).sort();
      assert.deepEqual(wrote, wouldWrite, `${name}: repair writes exactly what doctor lists`);
      assert.equal(repaired.report.update_skipped, undefined, `${name}: repair skips nothing`);
      const restored = fs.readFileSync(probe(home), 'utf8');
      assert.match(restored, /marrow/i, `${name}: restored by repair`);
      if (/U12/.test(name)) assert.match(restored, /owner-check\.sh/, 'the owner entry is kept');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
  // The CLI words: only `update` filters; any repair word restores as before.
  assert.equal(parseArgs(['update']).updateOnly, true);
  assert.equal(parseArgs(['--update']).updateOnly, true);
  assert.equal(parseArgs(['repair']).updateOnly, false);
  assert.equal(parseArgs(['--repair']).updateOnly, false);
  assert.equal(parseArgs(['update', '--repair']).updateOnly, false);
  assert.equal(parseArgs(['--repair', 'update']).updateOnly, false);
});

test('F3: an explicit --agent-id on update replaces a recorded id and updates the record; an env id does not', async () => {
  const home = tempDir('marrow-f3-');
  try {
    hostLayout(home);
    await installHome(home, { agentId: 'cliff' });
    const envOnly = await installHome(home, { agentId: 'cliff-2', update: true, repair: true, updateOnly: true });
    assert.equal(homeMcpId(home), 'cliff', 'an id from the environment does not replace the record');
    assert.equal(envOnly.report.changes.find((change) => change.path === homeMcp(home)).identity_kept[0].reason, 'recorded');

    const flagged = await installHome(home, { agentId: 'cliff-2', agentIdFromArg: true, update: true, repair: true, updateOnly: true });
    assert.equal(homeMcpId(home), 'cliff-2');
    assert.match(flagged.printed, /reset MARROW_FLEET_AGENT_ID cliff -> cliff-2 in .* \(--agent-id\)/);
    assert.equal(readRecord(home)[homeMcp(home)].MARROW_FLEET_AGENT_ID, 'cliff-2', 'the record follows the operator');
    assert.equal((await installHome(home, { agentId: 'codex-bob', update: true, repair: true, updateOnly: true }) && homeMcpId(home)), 'cliff-2');

    // With no record yet, --agent-id also wins over the one-time keep.
    fs.rmSync(recordPath(home));
    await installHome(home, { agentId: 'cliff-3', agentIdFromArg: true, update: true, repair: true, updateOnly: true });
    assert.equal(homeMcpId(home), 'cliff-3');

    const args = parseArgs(['update', '--agent-id', 'cliff-4'], { HOME: home });
    assert.equal(args.agentIdFromArg, true);
    assert.equal(args.agentId, 'cliff-4');
    assert.equal(parseArgs(['update'], { HOME: home, MARROW_FLEET_AGENT_ID: 'cliff-5' }).agentIdFromArg, undefined);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('F4: the one-time keep refuses a hard-linked home config (tracked elsewhere or not)', async () => {
  for (const tracked of [true, false]) {
    const home = tempDir('marrow-f4-');
    try {
      hostLayout(home);
      await installHome(home, { agentId: 'cliff' });
      fs.rmSync(recordPath(home));
      const repo = path.join(home, 'src', 'dotfiles');
      fs.mkdirSync(repo, { recursive: true });
      fs.linkSync(homeMcp(home), path.join(repo, 'mcp.json'));
      if (tracked) {
        assert.equal(spawnSync('git', ['init', '-q', repo]).status, 0);
        assert.equal(spawnSync('git', ['-C', repo, 'add', 'mcp.json']).status, 0);
      }
      await installHome(home, { agentId: 'codex-bob', update: true, repair: true, updateOnly: true });
      assert.equal(homeMcpId(home), 'codex-bob', `hard link (tracked: ${tracked}) reset`);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('F5: an installer-derived <client>-<hash> id from any folder or host is not kept by the one-time keep', async () => {
  const derivedElsewhere = `claude-code-${crypto.createHash('sha256').update(`/other/root:${os.hostname()}:claude-code`).digest('hex').slice(0, 12)}`;
  for (const [id, kept] of [[derivedElsewhere, false], ['codex-0123456789ab', false], ['grok-abcdefabcdef', false], ['codex-bob', true], ['claude-code-cliff', true]]) {
    const home = tempDir('marrow-f5-');
    try {
      hostLayout(home);
      await installHome(home, { agentId: 'cliff' });
      fs.rmSync(recordPath(home));
      setHomeMcpId(home, id);
      await installHome(home, { agentId: 'owner-set', update: true, repair: true, updateOnly: true });
      assert.equal(homeMcpId(home), kept ? id : 'owner-set', id);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
});

test('F6/F7: an identity reset is never labelled pin only, and the short summary names every kept id and why', async () => {
  const home = tempDir('marrow-f6-');
  try {
    hostLayout(home);
    await installHome(home, { agentId: 'bot-1.0.0' });
    fs.rmSync(recordPath(home));
    fs.chmodSync(homeMcp(home), 0o664);
    const reset = await installHome(home, { agentId: 'bot-2.0.0', update: true, repair: true, updateOnly: true });
    const change = reset.report.changes.find((entry) => entry.path === homeMcp(home));
    assert.equal(change.change_class, 'identity reset + managed entries');
    assert.doesNotMatch(reset.printed, /\.mcp\.json\) \[pin only\]/);

    fs.chmodSync(homeMcp(home), 0o600);
    setHomeMcpId(home, 'cliff');
    fs.rmSync(recordPath(home));
    const first = await installHome(home, { agentId: 'codex-bob', update: true, repair: true, updateOnly: true });
    assert.ok(first.summary.some((line) => /^Kept agent identity cliff \(set before this installer recorded identities\)/.test(line)));
    const second = await installHome(home, { agentId: 'codex-bob', update: true, repair: true, updateOnly: true });
    assert.ok(second.summary.some((line) => /^Kept agent identity cliff \(recorded by this installer\)/.test(line)));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

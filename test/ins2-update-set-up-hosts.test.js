require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { install, parseArgs, printReport, installSummaryLines } = require('../src/installer');
const PINS = require('../src/pins');

// INS-2 (update touches only hosts that already have Marrow). Each row is written against master af86f183
// and states what the update-UX spec requires; the rows that hold on master too say so ("equal on BASE").
// Dummy keys only: a fixed non-key prefix plus runtime hex, every draw asserted not live-shaped.

const DEFAULT_URL = 'https://api.getmarrow.ai';
const SETUP_LINE = 'Marrow is not set up here. Run: npx -y @getmarrow/install@latest';
const NOT_LIVE = /(?:^|[^a-z0-9])(?:sk|pk|rk)_|ghp_|gho_|xox[a-z]-|AKIA|eyJ/;
function dummyKey() {
  const value = `zzfixture-${crypto.randomBytes(16).toString('hex')}`;
  assert.doesNotMatch(value, NOT_LIVE);
  return value;
}
function tempHome() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-ins2-')));
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  return { base, home, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}
function quiet(extra) {
  return {
    selfTest: false, loopGuardSelfTest: false, seatbeltStatus: false, controller: false,
    processCommands: [], mcpRegistryMetadata: null, ...extra,
  };
}
// The options `npx @getmarrow/install update --yes` builds, from a shell with no Marrow variables.
function update(home, extra = {}, argv = ['update', '--yes']) {
  const parsed = parseArgs(argv, { HOME: home, PATH: process.env.PATH });
  return install({ ...parsed, ...quiet({ cwd: home, home, apiKey: '', mode: 'mcp' }), mcpLocalRuntime: false, ...extra });
}
function setup(home, extra = {}) {
  return install(quiet({
    cwd: home, home, mode: 'mcp', apiKey: '', baseUrl: DEFAULT_URL, agentId: '', yes: true, dryRun: false, doctor: false, ...extra,
  }));
}
function printed(report) {
  let text = '';
  printReport(report, (chunk) => { text += chunk; });
  return text;
}
function summary(report) {
  return installSummaryLines(report, { update: true }).lines.join('\n');
}
function files(root) {
  const out = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(root);
  return out.sort();
}
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function snapshot(root) {
  const map = new Map();
  for (const file of files(root)) {
    const stat = fs.lstatSync(file);
    if (stat.isFile()) map.set(file, `${sha(file)}:${(stat.mode & 0o777).toString(8)}`);
    else map.set(file, `link:${fs.readlinkSync(file)}`);
  }
  return map;
}
function changedFiles(before, after) {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((name) => before.get(name) !== after.get(name)).sort();
}
function put(file, value, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.chmodSync(file, mode);
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const rel = (ws, file) => path.relative(ws.home, file);
function count(text, needle) {
  return text.split(needle).length - 1;
}

// ---- R2 (A-H1): update writes nothing for a host that was never set up --------------------------------------------

test('UPDUX-R2: update on a machine where Marrow was never set up writes no host file', async () => {
  const ws = tempHome();
  try {
    fs.mkdirSync(path.join(ws.home, '.claude'), { mode: 0o700 }); // the host is installed, Marrow is not
    await update(ws.home, { mcpLocalRuntime: true });
    const made = ['.claude/settings.json', '.mcp.json', '.marrow/identity-record.json']
      .filter((name) => fs.existsSync(path.join(ws.home, name)));
    assert.deepEqual(made, [], 'update created host files on a machine with no Marrow setup');
  } finally { ws.cleanup(); }
});

test('R2: not set up -> no file changes at all, one setup line, exit 0, whatever hosts are installed', async () => {
  const ws = tempHome();
  try {
    for (const dir of ['.claude', '.cursor', '.codex', '.grok', '.gemini', '.windsurf', '.clinerules', '.hermes']) fs.mkdirSync(path.join(ws.home, dir), { mode: 0o700 });
    put(path.join(ws.home, '.hermes', 'config.yaml'), 'model:\n  default: x\nmcp_servers:\n  other:\n    command: other\n', 0o600);
    put(path.join(ws.home, '.claude', 'settings.json'), { permissions: { allow: ['Bash(ls)'] }, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './owner-hook.sh' }] }] } });
    put(path.join(ws.home, '.mcp.json'), { mcpServers: { other: { command: 'other-server' } } });
    const before = snapshot(ws.home);
    const report = await update(ws.home);
    assert.deepEqual(changedFiles(before, snapshot(ws.home)), [], 'update changed or created a file');
    const text = printed(report);
    assert.equal(count(text, SETUP_LINE), 1, text);
    assert.match(text, /not set up/);
    assert.doesNotMatch(JSON.stringify(report.changes || []), /wrote/);
    assert.equal((report.changes || []).filter((change) => change.applied).length, 0);
    assert.equal(count(summary(report), SETUP_LINE), 1);
    assert.equal(report.controller?.active ?? false, false);
  } finally { ws.cleanup(); }
});

test('R2: the real command with no key and with a dummy key prints the setup line once, exits 0 and writes nothing (not even a log)', () => {
  const ws = tempHome();
  try {
    fs.mkdirSync(path.join(ws.home, '.claude'), { mode: 0o700 });
    fs.mkdirSync(path.join(ws.home, '.cursor'), { mode: 0o700 });
    const bin = path.join(__dirname, '..', 'bin', 'marrow-install.js');
    const key = dummyKey();
    const env = (extra) => ({ PATH: process.env.PATH, HOME: ws.home, TMPDIR: process.env.TMPDIR, ...extra });
    for (const extra of [{}, { MARROW_API_KEY: key }]) {
      const before = snapshot(ws.home);
      const run = spawnSync(process.execPath, [bin, 'update', '--no-self-test', '--no-controller'], { cwd: ws.home, env: env(extra), encoding: 'utf8', timeout: 60000 });
      assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
      assert.equal(count(run.stdout, SETUP_LINE), 1, run.stdout);
      assert.ok(!run.stdout.includes('zzfixture-') && !run.stderr.includes('zzfixture-'));
      assert.deepEqual(changedFiles(before, snapshot(ws.home)), []);
    }
    const json = spawnSync(process.execPath, [bin, 'update', '--json', '--no-self-test', '--no-controller'], { cwd: ws.home, env: env({ MARROW_API_KEY: key }), encoding: 'utf8', timeout: 60000 });
    assert.equal(json.status, 0);
    assert.equal(JSON.parse(json.stdout).update_not_set_up.setup_command, 'npx -y @getmarrow/install@latest');
    assert.ok(!json.stdout.includes(key));
  } finally { ws.cleanup(); }
});

test('R2: look-alike setup does not count; setup still installs, doctor still works as before', async () => {
  const ws = tempHome();
  try {
    fs.mkdirSync(path.join(ws.home, '.claude'), { mode: 0o700 });
    await setup(ws.home);
    assert.ok(fs.existsSync(path.join(ws.home, '.claude', 'settings.json')), 'setup is unchanged: it writes the host files');
    assert.ok(fs.existsSync(path.join(ws.home, '.mcp.json')));
    const doctor = await install(quiet({ cwd: ws.home, home: ws.home, mode: 'mcp', apiKey: '', baseUrl: DEFAULT_URL, agentId: '', doctor: true }));
    assert.ok(doctor.doctor, 'doctor still reports');
    assert.equal(doctor.update_not_set_up, undefined);
  } finally { ws.cleanup(); }
});

// ---- T2 (A-H2 + M4): Marrow in one file of a set-up group; the group's Marrow lines are written as master writes them -

test('T2: Marrow only in .mcp.json -> .mcp.json updated, the Claude Code hooks written exactly as a setup writes them, one report line names them', async () => {
  const ws = tempHome();
  try {
    fs.mkdirSync(path.join(ws.home, '.claude'), { mode: 0o700 });
    await setup(ws.home);
    const settingsFile = path.join(ws.home, '.claude', 'settings.json');
    const reference = fs.readFileSync(settingsFile, 'utf8');
    const mcpFile = path.join(ws.home, '.mcp.json');
    fs.rmSync(settingsFile);
    const old = readJson(mcpFile);
    old.mcpServers.marrow = { command: 'npx', args: ['-y', '--package=@getmarrow/mcp@3.9.98', 'marrow-mcp'], env: { MARROW_BASE_URL: DEFAULT_URL } };
    put(mcpFile, old);
    const report = await update(ws.home);
    assert.doesNotMatch(fs.readFileSync(mcpFile, 'utf8'), /3\.9\.98/, '.mcp.json is brought to the pinned version');
    assert.equal(fs.readFileSync(settingsFile, 'utf8'), reference, 'the hooks are written exactly as before (same file, lines, order)');
    const text = printed(report);
    const lines = text.split('\n').filter((line) => /already set up/.test(line) && line.includes('.claude/settings.json'));
    assert.equal(lines.length, 1, text);
    assert.match(lines[0], /Claude Code/);
    assert.match(lines[0], /\.mcp\.json/);
    assert.equal(summary(report).split('\n').filter((line) => /already set up/.test(line) && line.includes('.claude/settings.json')).length, 1);
    assert.equal(report.update_skipped, undefined);
  } finally { ws.cleanup(); }
});

test('T2b: Marrow only in .claude/settings.json -> .mcp.json is written as a setup writes it, one report line', async () => {
  const ws = tempHome();
  try {
    fs.mkdirSync(path.join(ws.home, '.claude'), { mode: 0o700 });
    await setup(ws.home);
    const mcpFile = path.join(ws.home, '.mcp.json');
    const reference = fs.readFileSync(mcpFile, 'utf8');
    fs.rmSync(mcpFile);
    const report = await update(ws.home);
    assert.equal(fs.readFileSync(mcpFile, 'utf8'), reference);
    assert.equal(printed(report).split('\n').filter((line) => /already set up/.test(line) && line.includes('.mcp.json')).length, 1);
  } finally { ws.cleanup(); }
});

// ---- T3 (A-H3): a host dir without Marrow gets no file ------------------------------------------------------------

test('T3: .cursor/ without Marrow -> no Cursor file; the set-up Claude Code files are still updated', async () => {
  const ws = tempHome();
  try {
    fs.mkdirSync(path.join(ws.home, '.claude'), { mode: 0o700 });
    await setup(ws.home);
    for (const dir of ['.cursor', '.codex', '.gemini', '.windsurf', '.clinerules']) fs.mkdirSync(path.join(ws.home, dir), { mode: 0o700 });
    fs.mkdirSync(path.join(ws.home, '.grok'), { mode: 0o700 });
    const mcpFile = path.join(ws.home, '.mcp.json');
    const old = readJson(mcpFile);
    old.mcpServers.marrow.args = old.mcpServers.marrow.args.map((arg) => arg.replace(/3\.9\.\d+/, '3.9.98'));
    old.mcpServers.marrow.args.push('--package=@getmarrow/mcp@3.9.98');
    put(mcpFile, { ...old, mcpServers: { marrow: { command: 'npx', args: ['-y', '--package=@getmarrow/mcp@3.9.98', 'marrow-mcp'], env: { MARROW_BASE_URL: DEFAULT_URL } } } });
    await update(ws.home);
    assert.doesNotMatch(fs.readFileSync(mcpFile, 'utf8'), /3\.9\.98/);
    for (const file of ['.cursor/hooks.json', '.cursor/mcp.json', '.cursor/rules/marrow.mdc', '.codex/hooks.json', '.gemini/settings.json', '.windsurf/hooks.json', '.clinerules/hooks/PreToolUse', '.grok/hooks/marrow.json']) {
      assert.equal(fs.existsSync(path.join(ws.home, file)), false, `update created ${file}`);
    }
  } finally { ws.cleanup(); }
});

// ---- T5: AGENTS.md ------------------------------------------------------------------------------------------------

test('T5: AGENTS.md without Marrow\'s block is untouched; with the block only the block changes', async () => {
  const ws = tempHome();
  try {
    fs.mkdirSync(path.join(ws.home, '.claude'), { mode: 0o700 });
    await setup(ws.home);
    const agents = path.join(ws.home, 'AGENTS.md');
    const owner = '# Fleet rules\n\nOwner text.  \n\n';
    put(agents, `${owner}No Marrow here.\n`);
    await update(ws.home);
    assert.equal(fs.readFileSync(agents, 'utf8'), `${owner}No Marrow here.\n`);
    const tail = '\n\n## After\nMore.\n';
    put(agents, `${owner}<!-- marrow:passive-start -->\nold @getmarrow/mcp@3.9.98\n<!-- marrow:passive-end -->${tail}`);
    await update(ws.home);
    const after = fs.readFileSync(agents, 'utf8');
    assert.ok(after.startsWith(`${owner}<!-- marrow:passive-start -->`));
    assert.ok(after.endsWith(`<!-- marrow:passive-end -->${tail}`));
    assert.doesNotMatch(after, /3\.9\.98/);
  } finally { ws.cleanup(); }
});

test('T5b: an AGENTS.md block alone (no host file) still counts as set up and is refreshed, nothing else is created', async () => {
  const ws = tempHome();
  try {
    fs.mkdirSync(path.join(ws.home, '.claude'), { mode: 0o700 });
    const agents = path.join(ws.home, 'AGENTS.md');
    put(agents, '<!-- marrow:passive-start -->\nold @getmarrow/mcp@3.9.98\n<!-- marrow:passive-end -->\n');
    const before = snapshot(ws.home);
    await update(ws.home);
    assert.deepEqual(changedFiles(before, snapshot(ws.home)).map((file) => rel(ws, file)), ['AGENTS.md']);
  } finally { ws.cleanup(); }
});

// ---- T4 / M1 (A-H4, G20): owner launcher scripts are never edited and are reported only when a set-up entry names them

const PIN_OLD = '3.9.102';
function launcher(file, lines) {
  put(file, `#!/bin/sh\n${lines.join('\n')}\n`, 0o755);
}
// A set-up Claude Code project: Marrow's hooks + MCP entry, plus an owner hook that names `named` by absolute path.
async function setUpWithOwnerHook(ws, command) {
  fs.mkdirSync(path.join(ws.home, '.claude'), { mode: 0o700 });
  await setup(ws.home);
  const settingsFile = path.join(ws.home, '.claude', 'settings.json');
  const settings = readJson(settingsFile);
  settings.hooks.PostToolUse = [...(settings.hooks.PostToolUse || []), { matcher: 'Write', hooks: [{ type: 'command', command }] }];
  put(settingsFile, settings);
  return settingsFile;
}
const ownerCommands = (settingsFile) => Object.values(readJson(settingsFile).hooks).flat().flatMap((entry) => entry.hooks.map((hook) => hook.command)).filter((command) => !/getmarrow\/mcp|MARROW_L/.test(command));

test('T4: two owner launchers with pinned runtime paths -> sha256 unchanged; only the one a set-up entry names is reported, each pinned line once with file:line', async () => {
  const ws = tempHome();
  try {
    const named = path.join(ws.home, 'scripts', 'marrow-mcp-grok.sh');
    const other = path.join(ws.home, 'scripts', 'marrow-mcp-launch.sh');
    launcher(named, ['export MARROW_FLEET_AGENT_ID=cliff-agent', `exec "$HOME/.marrow/runtime/mcp/${PIN_OLD}/run" --package=@getmarrow/mcp@${PIN_OLD} marrow-mcp "$@"`, 'echo done', `# fallback /opt/m/.marrow/runtime/mcp/3.9.99/node`]);
    launcher(other, [`exec "$HOME/.marrow/runtime/mcp/${PIN_OLD}/run" marrow-mcp "$@"`]);
    const settingsFile = await setUpWithOwnerHook(ws, `${named} post`);
    const settings = readJson(settingsFile);
    settings.hooks.Stop = [{ hooks: [{ type: 'command', command: `"${named}" stop` }] }];
    put(settingsFile, settings);
    const hashes = [named, other].map(sha);
    const report = await update(ws.home);
    assert.deepEqual([named, other].map(sha), hashes, 'owner launcher scripts are byte-identical');
    const text = printed(report);
    const lines = text.split('\n').filter((line) => line.includes(`${named}:`));
    assert.equal(lines.length, 2, `each pinned line once:\n${text}`);
    assert.match(lines[0], new RegExp(`^- ${named.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:3 pins MCP ${PIN_OLD.replaceAll('.', '\\.')}`));
    assert.match(lines[1], new RegExp(`:5 pins MCP 3\\.9\\.99`));
    assert.equal(count(text, other), 0, 'a launcher no set-up entry names is not reported');
    assert.equal(count(summary(report), `${named}:3`), 1);
    assert.equal(count(summary(report), `${named}:5`), 1);
    assert.equal(count(summary(report), other), 0);
    assert.ok(!text.includes('MARROW_FLEET_AGENT_ID') && !text.includes('cliff-agent'), 'only path:line and the version are printed');
    assert.deepEqual(report.owner_pins.map((pin) => `${pin.path}:${pin.line}`), [`${named}:3`, `${named}:5`]);
    assert.ok(report.owner_pins.every((pin) => Array.isArray(pin.versions) && pin.versions.every((version) => /^\d+\.\d+\.\d+$/.test(version))));
    assert.deepEqual(ownerCommands(settingsFile).sort(), [`${named} post`, `"${named}" stop`].sort(), 'the owner hook commands are byte-identical');
  } finally { ws.cleanup(); }
});

// ---- M5a: look-alikes never make a group set up --------------------------------------------------------------------

const OWN_ENTRY = {
  command: 'npx', args: ['-y', '--package=@getmarrow/mcp@3.9.98', 'marrow-mcp'], env: { MARROW_BASE_URL: DEFAULT_URL },
};
const LOOK_ALIKES = {
  marrow2: (ws) => put(path.join(ws.home, '.mcp.json'), { mcpServers: { marrow2: OWN_ENTRY } }),
  homoglyph: (ws) => put(path.join(ws.home, '.mcp.json'), { mcpServers: { 'mаrrow': OWN_ENTRY } }),
  zeroWidth: (ws) => put(path.join(ws.home, '.mcp.json'), { mcpServers: { 'marrow​': OWN_ENTRY } }),
  fullwidth: (ws) => put(path.join(ws.home, '.mcp.json'), { mcpServers: { 'ｍａｒｒｏｗ': OWN_ENTRY } }),
  otherServer: (ws) => put(path.join(ws.home, '.mcp.json'), { mcpServers: { other: OWN_ENTRY } }),
  commentText: (ws) => put(path.join(ws.home, '.claude', 'settings.json'), { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'echo "see marrow-mcp and @getmarrow/mcp docs"' }] }] } }),
  hookLookAlike: (ws) => put(path.join(ws.home, '.claude', 'settings.json'), { hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'npx -y @getmarrow/mcp-evil@3.9.98 pre-action-hook' }] }] } }),
  hermes: (ws) => put(path.join(ws.home, '.hermes', 'config.yaml'), 'mcp_servers:\n  marrow2:\n    command: npx\n    args: ["-y", "@getmarrow/mcp@3.9.98"]\n# marrow-mcp\n', 0o600),
  cursorOther: (ws) => put(path.join(ws.home, '.cursor', 'mcp.json'), { mcpServers: { notmarrow: OWN_ENTRY } }),
};

for (const [name, make] of Object.entries(LOOK_ALIKES)) {
  test(`M5a: look-alike (${name}) does not make a group set up: nothing is written, the setup line is printed once`, async () => {
    const ws = tempHome();
    try {
      for (const dir of ['.claude', '.hermes', '.cursor']) fs.mkdirSync(path.join(ws.home, dir), { mode: 0o700 });
      make(ws);
      const before = snapshot(ws.home);
      const report = await update(ws.home);
      assert.deepEqual(changedFiles(before, snapshot(ws.home)).map((file) => rel(ws, file)), [], 'update wrote a file for a look-alike');
      assert.equal(count(printed(report), SETUP_LINE), 1);
    } finally { ws.cleanup(); }
  });
}

test('M5a: a look-alike group beside a genuinely set-up group is left alone and reported once', async () => {
  const ws = tempHome();
  try {
    fs.mkdirSync(path.join(ws.home, '.claude'), { mode: 0o700 });
    await setup(ws.home);
    put(path.join(ws.home, '.cursor', 'mcp.json'), { mcpServers: { marrow2: OWN_ENTRY } });
    const cursorMcp = path.join(ws.home, '.cursor', 'mcp.json');
    const cursorBefore = fs.readFileSync(cursorMcp, 'utf8');
    const report = await update(ws.home);
    assert.equal(fs.readFileSync(cursorMcp, 'utf8'), cursorBefore);
    assert.equal(fs.existsSync(path.join(ws.home, '.cursor', 'hooks.json')), false);
    assert.equal(fs.existsSync(path.join(ws.home, '.cursor', 'rules', 'marrow.mdc')), false);
    const text = printed(report);
    assert.equal(text.split('\n').filter((line) => /Marrow hooks for Cursor/.test(line)).length, 1, text);
  } finally { ws.cleanup(); }
});

test('M5a: genuine set-up forms still count (older npx entry, installer entry, chained hook with a Marrow part, hooks only)', async () => {
  const forms = {
    legacyNpxMcp: (ws) => put(path.join(ws.home, '.mcp.json'), { mcpServers: { marrow: OWN_ENTRY } }),
    minimalMcp: (ws) => put(path.join(ws.home, '.mcp.json'), { mcpServers: { marrow: { command: 'node', args: ['marrow-mcp'] } } }),
    oldNpxHook: (ws) => put(path.join(ws.home, '.claude', 'settings.json'), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'npx -y --package=@getmarrow/mcp@3.9.98 marrow-mcp pre-action-hook' }] }] } }),
    chainedHook: (ws) => put(path.join(ws.home, '.claude', 'settings.json'), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './owner.sh && npx -y --package=@getmarrow/mcp@3.9.98 marrow-mcp pre-action-hook' }] }] } }),
    chainedBare: (ws) => put(path.join(ws.home, '.claude', 'settings.json'), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './owner.sh; marrow-mcp pre-action-hook | cat' }] }] } }),
    shellC: (ws) => put(path.join(ws.home, '.claude', 'settings.json'), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'bash -c "marrow-mcp context-hook"' }] }] } }),
    bareBinaryHook: (ws) => put(path.join(ws.home, '.claude', 'settings.json'), { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'marrow-mcp pre-action-hook' }] }] } }),
  };
  for (const [name, make] of Object.entries(forms)) {
    const ws = tempHome();
    try {
      fs.mkdirSync(path.join(ws.home, '.claude'), { mode: 0o700 });
      make(ws);
      const report = await update(ws.home);
      assert.equal(report.update_not_set_up, undefined, `${name} is a set-up host`);
      assert.ok(fs.existsSync(path.join(ws.home, '.mcp.json')) && fs.existsSync(path.join(ws.home, '.claude', 'settings.json')), `${name}: the group's files are written as before`);
    } finally { ws.cleanup(); }
  }
});

// ---- M4: within a set-up group every Marrow line master writes is still written ---------------------------------------

test('M4: for each host group, Marrow in any one file -> every other file of that group is written exactly as a setup writes it', async () => {
  const hostDirs = ['.claude', '.cursor', '.codex', '.gemini', '.windsurf', '.clinerules'];
  const groups = {
    claude: ['.claude/settings.json', '.mcp.json'],
    cursor: ['.cursor/hooks.json', '.cursor/mcp.json', '.cursor/rules/marrow.mdc'],
    cline: ['.clinerules/hooks/PreToolUse', '.clinerules/hooks/PostToolUse', '.clinerules/hooks/TaskCancel'],
    codex: ['.codex/hooks.json'],
    windsurf: ['.windsurf/hooks.json'],
    gemini: ['.gemini/settings.json'],
  };
  for (const [group, groupFiles] of Object.entries(groups)) {
    for (const keep of groupFiles) {
      const ws = tempHome();
      try {
        for (const dir of hostDirs) fs.mkdirSync(path.join(ws.home, dir), { mode: 0o700 });
        if (group === 'codex') put(path.join(ws.home, '.codex', 'config.toml'), 'model = "x"\n');
        await setup(ws.home);
        const reference = new Map(groupFiles.map((file) => [file, fs.readFileSync(path.join(ws.home, file), 'utf8')]));
        for (const file of groupFiles) if (file !== keep) fs.rmSync(path.join(ws.home, file));
        await update(ws.home);
        for (const file of groupFiles) {
          assert.equal(fs.readFileSync(path.join(ws.home, file), 'utf8'), reference.get(file), `${group}: ${file} (Marrow kept only in ${keep})`);
        }
      } finally { ws.cleanup(); }
    }
  }
});

test('M4: an owner hooks-off value in the settings env block is kept as before, and the hooks are written as before', async () => {
  const ws = tempHome();
  try {
    fs.mkdirSync(path.join(ws.home, '.claude'), { mode: 0o700 });
    await setup(ws.home);
    const settingsFile = path.join(ws.home, '.claude', 'settings.json');
    const settings = readJson(settingsFile);
    settings.env = { MARROW_AUTO_HOOK: 'off' };
    const reference = JSON.stringify(settings, null, 2);
    put(settingsFile, settings);
    const mcpFile = path.join(ws.home, '.mcp.json');
    fs.rmSync(mcpFile);
    await update(ws.home);
    const after = readJson(settingsFile);
    assert.deepEqual(after.env, { MARROW_AUTO_HOOK: 'off' });
    assert.equal(JSON.stringify(after, null, 2), reference);
    assert.ok(fs.existsSync(mcpFile));
  } finally { ws.cleanup(); }
});

test('M4: local control state, policy mode and permission rules are byte-equal after update', async () => {
  const ws = tempHome();
  try {
    fs.mkdirSync(path.join(ws.home, '.claude'), { mode: 0o700 });
    await setup(ws.home);
    const settingsFile = path.join(ws.home, '.claude', 'settings.json');
    const settings = readJson(settingsFile);
    settings.permissions = { allow: ['Bash(ls)', 'Read(~/x)'], deny: ['Bash(rm -rf *)'], defaultMode: 'default' };
    put(settingsFile, settings);
    const control = path.join(ws.home, '.marrow', 'control.json');
    put(control, { enabled: false, mode: 'warn' }, 0o600);
    const controlBefore = fs.readFileSync(control, 'utf8');
    await update(ws.home);
    assert.deepEqual(readJson(settingsFile).permissions, settings.permissions);
    assert.equal(fs.readFileSync(control, 'utf8'), controlBefore);
  } finally { ws.cleanup(); }
});

// ---- M5b/M5c/M5d: owner scripts named by hooks: symlinks, FIFOs, odd path forms, chains --------------------------------

test('M5b: a launcher that is a symlink to an owner env file, or a FIFO, is never read into the output and never hangs update', async () => {
  const ws = tempHome();
  try {
    const key = dummyKey();
    const marrowEnv = path.join(ws.home, '.marrow', 'env');
    const hermesEnv = path.join(ws.home, '.hermes', '.env');
    put(marrowEnv, `MARROW_API_KEY=${key}\n# pinned @getmarrow/mcp@3.9.77\n`, 0o600);
    put(hermesEnv, `MARROW_API_KEY=${key}\n# pinned @getmarrow/mcp@3.9.77\n`, 0o600);
    const linkToMarrowEnv = path.join(ws.home, 'scripts', 'a.sh');
    const linkToHermesEnv = path.join(ws.home, 'scripts', 'b.sh');
    const fifo = path.join(ws.home, 'scripts', 'c.sh');
    fs.mkdirSync(path.dirname(fifo), { recursive: true });
    fs.symlinkSync(marrowEnv, linkToMarrowEnv);
    fs.symlinkSync(hermesEnv, linkToHermesEnv);
    assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
    const settingsFile = await setUpWithOwnerHook(ws, `${linkToMarrowEnv} one && ${linkToHermesEnv} two; ${fifo} three`);
    const report = await update(ws.home);
    const text = `${printed(report)}\n${summary(report)}\n${JSON.stringify(report)}`;
    assert.ok(!text.includes(key), 'the key is not in the output');
    assert.ok(!text.includes('3.9.77'), 'nothing was read from the env files');
    assert.equal(fs.lstatSync(fifo).isFIFO(), true);
    assert.equal(fs.lstatSync(linkToMarrowEnv).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(marrowEnv, 'utf8'), `MARROW_API_KEY=${key}\n# pinned @getmarrow/mcp@3.9.77\n`);
    for (const name of [linkToMarrowEnv, linkToHermesEnv, fifo]) assert.equal(count(printed(report), `${name} not scanned`), 1, `${name} is reported as not scanned, once`);
    assert.ok(readJson(settingsFile).hooks.PostToolUse.some((entry) => entry.hooks.some((hook) => hook.command === `${linkToMarrowEnv} one && ${linkToHermesEnv} two; ${fifo} three`)));
  } finally { ws.cleanup(); }
});

test('M5b: a launcher reached through a folder that links into ~/.marrow is not read', async () => {
  const ws = tempHome();
  const touched = [];
  const original = fs.openSync;
  try {
    const store = path.join(ws.home, '.marrow', 'settings.cfg');
    put(store, `MARROW_API_KEY=${dummyKey()}\n# @getmarrow/mcp@3.9.44\n`, 0o600);
    fs.mkdirSync(path.join(ws.home, 'scripts'), { recursive: true });
    fs.symlinkSync(path.join(ws.home, '.marrow'), path.join(ws.home, 'scripts', 'via'));
    await setUpWithOwnerHook(ws, `${path.join(ws.home, 'scripts', 'via', 'settings.cfg')} x`);
    fs.openSync = function spy(target, ...rest) {
      if (typeof target === 'string' && new Error().stack.includes('owner-pins.js')) touched.push(target);
      return original.call(this, target, ...rest);
    };
    let report;
    try { report = await update(ws.home); } finally { fs.openSync = original; }
    assert.deepEqual(touched, [], 'the pin report opened a file through a link into ~/.marrow');
    assert.ok(!printed(report).includes('3.9.44'));
  } finally { fs.openSync = original; ws.cleanup(); }
});

test('M5b: a key folder that is itself a link to a plainly named folder is not read through the key folder name', async () => {
  const ws = tempHome();
  const touched = [];
  const original = fs.openSync;
  try {
    const hidden = path.join(ws.home, 'vault', 'hermes-copy', 'hook.sh');
    put(hidden, `#!/bin/sh\n# @getmarrow/mcp@3.9.33 ${dummyKey()}\n`, 0o700);
    fs.symlinkSync(path.join(ws.home, 'vault', 'hermes-copy'), path.join(ws.home, '.hermes'));
    await setUpWithOwnerHook(ws, `${path.join(ws.home, '.hermes', 'hook.sh')} x`);
    fs.openSync = function spy(target, ...rest) {
      if (typeof target === 'string' && new Error().stack.includes('owner-pins.js')) touched.push(target);
      return original.call(this, target, ...rest);
    };
    let report;
    try { report = await update(ws.home); } finally { fs.openSync = original; }
    assert.deepEqual(touched, [], 'the pin report opened a file under the ~/.hermes name');
    assert.ok(!printed(report).includes('3.9.33'));
  } finally { fs.openSync = original; ws.cleanup(); }
});

test('M5c/M5d: hook command forms (absolute, relative, ~, $HOME, .., symlinked dir, chains, bash -c, pipes): the owner part is byte-identical, no file is read beyond the one a form names', async () => {
  const ws = tempHome();
  const calls = [];
  const spied = {};
  try {
    const script = path.join(ws.home, 'scripts', 'pinned.sh');
    launcher(script, [`exec "$HOME/.marrow/runtime/mcp/${PIN_OLD}/run" marrow-mcp`]);
    const decoys = [path.join(ws.home, 'decoy', 'secret.txt'), path.join(ws.home, 'scripts', 'unnamed.sh'), path.join(ws.home, '.ssh', 'id_decoy')];
    for (const decoy of decoys) put(decoy, `@getmarrow/mcp@3.9.55 ${dummyKey()}\n`, 0o600);
    const credentials = [path.join(ws.home, '.marrow', 'env'), path.join(ws.home, '.hermes', '.env')];
    for (const file of credentials) put(file, `MARROW_API_KEY=${dummyKey()}\n@getmarrow/mcp@3.9.66\n`, 0o600);
    fs.symlinkSync(path.join(ws.home, 'scripts'), path.join(ws.home, 'linked-scripts'));
    const commands = [
      `${script} a`,
      `~/scripts/pinned.sh b`,
      `$HOME/scripts/pinned.sh c`,
      `\${HOME}/scripts/pinned.sh d`,
      `${path.join(ws.home, 'scripts', '..', 'scripts', 'pinned.sh')} e`,
      `${path.join(ws.home, 'linked-scripts', 'pinned.sh')} f`,
      `./scripts/pinned.sh g`,
      `../scripts/pinned.sh h`,
      `scripts/pinned.sh i`,
      `pinned.sh && true`,
      `true && ${script} j`,
      `true; ${script} k`,
      `false || ${script} l`,
      `bash -c "${script} m"`,
      `sh -c '${script} n | cat'`,
      `cat ${credentials[0]} | head`,
      `cat ${credentials[1]}; true`,
      `echo $UNSET_VAR/scripts/unnamed.sh`,
    ];
    const settingsFile = await setUpWithOwnerHook(ws, commands[0]);
    const settings = readJson(settingsFile);
    settings.hooks.PostToolUse = [...settings.hooks.PostToolUse.slice(0, -1), ...commands.map((command) => ({ matcher: 'Write', hooks: [{ type: 'command', command }] }))];
    put(settingsFile, settings);
    for (const name of ['readFileSync', 'openSync', 'readdirSync', 'createReadStream', 'statSync', 'lstatSync', 'realpathSync']) {
      spied[name] = fs[name];
      fs[name] = function spy(target, ...rest) {
        if (typeof target === 'string') calls.push({ name, target, pins: new Error().stack.includes('owner-pins.js') });
        return spied[name].call(this, target, ...rest);
      };
    }
    let report;
    try {
      report = await update(ws.home, { apiKey: dummyKey() });
    } finally {
      for (const [name, fn] of Object.entries(spied)) fs[name] = fn;
    }
    const after = readJson(settingsFile).hooks.PostToolUse.flatMap((entry) => entry.hooks.map((hook) => hook.command));
    for (const command of commands) assert.ok(after.includes(command), `owner command edited: ${command}`);
    const touched = new Set(calls.map((call) => call.target));
    for (const decoy of decoys) assert.ok(!touched.has(decoy), `${decoy} was read`);
    assert.ok(!calls.some((call) => call.name === 'readdirSync' && [path.join(ws.home, 'decoy'), path.join(ws.home, 'scripts'), ws.home].includes(call.target)), 'no directory was listed');
    const fromPins = calls.filter((call) => call.pins && ['readFileSync', 'openSync', 'createReadStream', 'readdirSync'].includes(call.name));
    assert.ok(fromPins.every((call) => call.target === script), `the pin report opened only the named script: ${JSON.stringify(fromPins.map((call) => call.target))}`);
    assert.ok(!calls.some((call) => call.pins && credentials.includes(call.target)), 'the owner env files were not touched by the pin report');
    const text = printed(report);
    // The named script is reported once, whatever number of commands name it, and never as a second path spelling.
    assert.equal(count(text, `${script}:2`), 1, text);
    assert.ok(!text.includes('3.9.55') && !text.includes('3.9.66'));
    for (const unresolved of ['./scripts/pinned.sh', '../scripts/pinned.sh']) assert.equal(text.split('\n').filter((line) => line.startsWith(`- ${unresolved} not scanned`)).length, 1, `${unresolved} is reported once as unresolved`);
  } finally {
    for (const [name, fn] of Object.entries(spied)) fs[name] = fn;
    ws.cleanup();
  }
});

// ---- M5e: idempotent -------------------------------------------------------------------------------------------------

test('M5e: a second update writes nothing and reports the same pinned lines once', async () => {
  const ws = tempHome();
  try {
    const script = path.join(ws.home, 'scripts', 'l.sh');
    launcher(script, [`exec "$HOME/.marrow/runtime/mcp/${PIN_OLD}/run" marrow-mcp`, `# @getmarrow/mcp@3.9.99`]);
    await setUpWithOwnerHook(ws, `${script} x`);
    const first = await update(ws.home);
    const afterFirst = snapshot(ws.home);
    const second = await update(ws.home);
    assert.deepEqual(changedFiles(afterFirst, snapshot(ws.home)), [], 'the second run wrote a file');
    const lines = (report) => printed(report).split('\n').filter((line) => line.includes(`${script}:`));
    assert.deepEqual(lines(second), lines(first));
    assert.equal(lines(second).length, 2);
    assert.deepEqual(second.owner_pins, first.owner_pins);
  } finally { ws.cleanup(); }
});

// ---- T-SEC (A-SEC1 + G23) --------------------------------------------------------------------------------------------

test('T-SEC: the dummy key never reaches the output, the report or a new file, and the Hermes credential store is byte-identical with its mode', async () => {
  const ws = tempHome();
  try {
    const key = dummyKey();
    const other = dummyKey();
    fs.mkdirSync(path.join(ws.home, '.claude'), { mode: 0o700 });
    await setup(ws.home);
    const script = path.join(ws.home, 'scripts', 'k.sh');
    launcher(script, [`export MARROW_API_KEY=${key}`, `exec "$HOME/.marrow/runtime/mcp/${PIN_OLD}/run" marrow-mcp`]);
    const settingsFile = path.join(ws.home, '.claude', 'settings.json');
    const settings = readJson(settingsFile);
    settings.hooks.PostToolUse = [{ matcher: 'Write', hooks: [{ type: 'command', command: `${script} x` }] }];
    put(settingsFile, settings);
    put(path.join(ws.home, '.marrow', 'env'), `MARROW_API_KEY=${key}\n`, 0o600);
    put(path.join(ws.home, '.hermes', '.env'), `MARROW_API_KEY=${key}\n`, 0o600);
    const hermesConfig = path.join(ws.home, '.hermes', 'config.yaml');
    const hermesText = `model:\n  provider: other\nproviders:\n  other:\n    api_key: ${other}\nmcp_servers:\n  marrow:\n    command: npx\n    args: ["-y", "@getmarrow/mcp@3.9.98"]\n    env:\n      MARROW_API_KEY: "\${MARROW_API_KEY}"\n`;
    put(hermesConfig, hermesText, 0o600);
    const mcpFile = path.join(ws.home, '.mcp.json');
    const mcp = readJson(mcpFile);
    mcp.mcpServers.marrow.env.MARROW_API_KEY = key;
    put(mcpFile, mcp);
    const holding = (map) => [...map.keys()].filter((file) => fs.readFileSync(file, 'utf8').includes(key));
    const before = snapshot(ws.home);
    const holdersBefore = holding(before);
    const stdout = [];
    const stderr = [];
    const writeOut = process.stdout.write;
    const writeErr = process.stderr.write;
    process.stdout.write = (chunk) => { stdout.push(String(chunk)); return true; };
    process.stderr.write = (chunk) => { stderr.push(String(chunk)); return true; };
    let report;
    try {
      report = await update(ws.home);
    } finally {
      process.stdout.write = writeOut;
      process.stderr.write = writeErr;
    }
    const output = [stdout.join(''), stderr.join(''), printed(report), summary(report), JSON.stringify(report)].join('\n');
    assert.ok(!output.includes(key) && !output.includes(other), 'no dummy key in the output or report');
    const after = snapshot(ws.home);
    const holdersAfter = files(ws.home).filter((file) => fs.readFileSync(file, 'utf8').includes(key) || fs.readFileSync(file, 'utf8').includes(other));
    for (const file of holdersAfter) assert.ok(holdersBefore.includes(file) || file === hermesConfig, `${file} newly holds a dummy key`);
    assert.ok(!files(ws.home).some((file) => /\.(?:bak|orig|undo|tmp)$|~$/.test(file) && fs.readFileSync(file, 'utf8').includes(key)), 'no backup or undo file holds a key');
    assert.ok(!files(ws.home).filter((file) => !holdersBefore.includes(file) && file !== hermesConfig).some((file) => fs.readFileSync(file, 'utf8').includes(other)), 'the other provider key is in no new file');
    assert.equal(fs.readFileSync(hermesConfig, 'utf8').includes(`api_key: ${other}`), true, 'the other provider value is byte-identical');
    assert.equal(fs.statSync(hermesConfig).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(path.join(ws.home, '.marrow', 'env'), 'utf8'), `MARROW_API_KEY=${key}\n`);
    assert.equal(fs.readFileSync(path.join(ws.home, '.hermes', '.env'), 'utf8'), `MARROW_API_KEY=${key}\n`);
    assert.equal(count(printed(report), `${script}:3`), 1);
    void after;
  } finally { ws.cleanup(); }
});

test('T-SEC: owner pins are read with a size cap: a huge named file is not read whole', async () => {
  const ws = tempHome();
  try {
    const big = path.join(ws.home, 'scripts', 'big.sh');
    fs.mkdirSync(path.dirname(big), { recursive: true });
    fs.writeFileSync(big, `#!/bin/sh\n${'x'.repeat(5 * 1024 * 1024)}\nexec "$HOME/.marrow/runtime/mcp/${PIN_OLD}/run"\n`, { mode: 0o755 });
    await setUpWithOwnerHook(ws, `${big} x`);
    const report = await update(ws.home);
    assert.match(printed(report), new RegExp(`${big.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} not scanned`));
  } finally { ws.cleanup(); }
});

// ---- M1 + M5f + M2: the A-OPS-like machine (Claude Code hooks + .mcp.json + Grok + Hermes, two owner launchers) ----------

test('A-OPS: one launcher named by the Grok config is reported once, the other is not read; reads stay inside the host files plus the named script; keys never leave', async () => {
  const ws = tempHome();
  const calls = [];
  const spied = {};
  try {
    const key = dummyKey();
    const other = dummyKey();
    for (const dir of ['.claude', '.grok', '.hermes']) fs.mkdirSync(path.join(ws.home, dir), { mode: 0o700 });
    put(path.join(ws.home, '.hermes', 'config.yaml'), `model:\n  provider: other\nproviders:\n  other:\n    api_key: ${other}\n`, 0o600);
    put(path.join(ws.home, '.hermes', '.env'), `MARROW_API_KEY=${key}\n`, 0o600);
    put(path.join(ws.home, '.marrow', 'env'), `MARROW_API_KEY=${key}\n`, 0o600);
    await setup(ws.home);
    const named = path.join(ws.home, 'scripts', 'marrow-mcp-grok.sh');
    const unnamed = path.join(ws.home, 'scripts', 'marrow-mcp-launch.sh');
    launcher(named, [`export MARROW_API_KEY=${key}`, `exec "$HOME/.marrow/runtime/mcp/${PIN_OLD}/run" marrow-mcp "$@"`]);
    launcher(unnamed, [`exec "$HOME/.marrow/runtime/mcp/${PIN_OLD}/run" marrow-mcp "$@"`]);
    const grokFile = path.join(ws.home, '.grok', 'hooks', 'marrow.json');
    const grok = readJson(grokFile);
    const event = Object.keys(grok.hooks)[0];
    grok.hooks[event].push({ hooks: [{ type: 'command', command: `${named} pre` }] });
    put(grokFile, grok);
    const hashes = [named, unnamed].map(sha);
    const hermesBefore = fs.readFileSync(path.join(ws.home, '.hermes', 'config.yaml'), 'utf8');
    for (const name of ['readFileSync', 'openSync', 'readdirSync', 'createReadStream']) {
      spied[name] = fs[name];
      fs[name] = function spy(target, ...rest) {
        if (typeof target === 'string') calls.push({ name, target, pins: new Error().stack.includes('owner-pins.js') });
        return spied[name].call(this, target, ...rest);
      };
    }
    let report;
    const written = [];
    const writeOut = process.stdout.write;
    process.stdout.write = (chunk) => { written.push(String(chunk)); return true; };
    try {
      report = await update(ws.home);
    } finally {
      process.stdout.write = writeOut;
      for (const [name, fn] of Object.entries(spied)) fs[name] = fn;
    }
    assert.deepEqual([named, unnamed].map(sha), hashes, 'both launchers are byte-identical');
    const text = printed(report);
    assert.equal(count(text, `${named}:3`), 1, text);
    assert.equal(count(text, unnamed), 0, 'the launcher no set-up entry names is not reported');
    assert.equal(count(summary(report), `${named}:3`), 1);
    const everything = [text, summary(report), JSON.stringify(report), written.join('')].join('\n');
    assert.ok(!everything.includes(key) && !everything.includes(other), 'no dummy key in any output');
    // Reads: nothing under the home outside the host files, Marrow's own folders and the one named script.
    const insideHome = [...new Set(calls.map((call) => call.target))].filter((target) => target.startsWith(`${ws.home}${path.sep}`));
    const allowed = ['.claude', '.grok', '.hermes', '.marrow', '.mcp.json', 'AGENTS.md', 'CLAUDE.md', 'package.json', '.codex', '.cursor', '.gemini', '.windsurf', '.clinerules', '.openclaw'].map((name) => path.join(ws.home, name));
    const strays = insideHome.filter((target) => target !== named && !allowed.some((root) => target === root || target.startsWith(`${root}${path.sep}`)));
    assert.deepEqual(strays, [], 'a file outside the host files and the named script was read');
    assert.ok(!insideHome.includes(unnamed));
    assert.ok(!calls.some((call) => call.pins && call.target !== named && ['readFileSync', 'openSync', 'readdirSync', 'createReadStream'].includes(call.name)));
    assert.equal(fs.readFileSync(path.join(ws.home, '.hermes', 'config.yaml'), 'utf8'), hermesBefore, 'the Hermes credential store is byte-identical');
    assert.equal(fs.statSync(path.join(ws.home, '.hermes', 'config.yaml')).mode & 0o777, 0o600);
    assert.ok(!files(ws.home).some((file) => /\.(?:bak|orig|undo|tmp)$|~$/.test(file)), 'no backup, undo or temp file is left');
  } finally {
    for (const [name, fn] of Object.entries(spied)) fs[name] = fn;
    ws.cleanup();
  }
});

void PINS;

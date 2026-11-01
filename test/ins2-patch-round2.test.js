require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { install, parseArgs, printReport, installSummaryLines } = require('../src/installer');

// INS-2 round 2 (post-audit). Rows PG1-PG4 each fail on the audited tip 967c15d9 and hold on the fix tip.
// Dummy keys only: a fixed non-key prefix plus runtime hex, every draw asserted not live-shaped.

const DEFAULT_URL = 'https://api.getmarrow.ai';
const NOT_LIVE = /(?:^|[^a-z0-9])(?:sk|pk|rk)_|ghp_|gho_|xox[a-z]-|AKIA|eyJ/;
function dummyKey() {
  const value = `zzfixture-${crypto.randomBytes(16).toString('hex')}`;
  assert.doesNotMatch(value, NOT_LIVE);
  return value;
}
function tempHome() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-ins2r2-')));
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
function put(file, value, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { mode });
  fs.chmodSync(file, mode);
}
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const read = (ws, name) => fs.readFileSync(path.join(ws.home, name), 'utf8');
const exists = (ws, name) => fs.existsSync(path.join(ws.home, name));
function count(text, needle) {
  return text.split(needle).length - 1;
}
// Every word of the output the owner could see (report text, summary and the report object).
// What the owner-pin scan itself says: its pin and not-scanned lines.
const pinOutput = (report) => `${JSON.stringify([report.owner_pins || [], report.owner_pins_not_scanned || []])}\n${printed(report).split('\n').filter((line) => /pins MCP|not scanned/.test(line)).join('\n')}`;
const everything = (report) => `${printed(report)}\n${summary(report)}\n${JSON.stringify(report)}`;

const GENUINE_ENTRY = { command: 'npx', args: ['-y', '@getmarrow/mcp@3.9.109'] };
const GEMINI_HANDLERS = ['marrow-before-tool', 'marrow-before-agent', 'marrow-after-tool', 'marrow-after-agent'];
const geminiHandlerNames = (settings) => Object.values(settings.hooks || {}).flat()
  .flatMap((group) => (Array.isArray(group.hooks) ? group.hooks : [group])).map((handler) => handler.name).filter(Boolean).sort();

// A set-up Claude Code project: Marrow's hooks and MCP entry, plus an owner hook that names files by path.
async function setUpWithOwnerHook(ws, command) {
  fs.mkdirSync(path.join(ws.home, '.claude'), { mode: 0o700 });
  await setup(ws.home);
  const settingsFile = path.join(ws.home, '.claude', 'settings.json');
  const settings = readJson(settingsFile);
  settings.hooks.PostToolUse = [...(settings.hooks.PostToolUse || []), { matcher: 'Write', hooks: [{ type: 'command', command }] }];
  put(settingsFile, settings);
  return settingsFile;
}

// Spies on the opens and reads the owner-pin module makes (by call stack), restored by `done()`.
function spyOwnerPins() {
  const opened = [];
  const reads = [];
  const { openSync, readSync } = fs;
  fs.openSync = function spyOpen(target, ...rest) {
    if (typeof target === 'string' && new Error().stack.includes('owner-pins.js')) opened.push(target);
    return openSync.call(this, target, ...rest);
  };
  fs.readSync = function spyRead(...args) {
    if (new Error().stack.includes('owner-pins.js')) reads.push(args[0]);
    return readSync.apply(this, args);
  };
  return { opened, reads, done: () => { fs.openSync = openSync; fs.readSync = readSync; } };
}

// ---- PG1 (audit B1): a Gemini settings file whose only Marrow line is the MCP entry is a set-up host ---------------

test('PG1: G-gemini-mcp-only (Gemini settings hold a genuine marrow MCP entry, no hooks; the project .mcp.json is set up): the Gemini Marrow hooks are written exactly as a setup writes them', async () => {
  const ws = tempHome();
  const ref = tempHome();
  try {
    fs.mkdirSync(path.join(ref.home, '.gemini'), { mode: 0o700 });
    await setup(ref.home);
    const reference = readJson(path.join(ref.home, '.gemini', 'settings.json'));
    assert.deepEqual(geminiHandlerNames(reference), GEMINI_HANDLERS.slice().sort(), 'the reference setup writes the four Gemini hooks');
    fs.mkdirSync(path.join(ws.home, '.claude'), { mode: 0o700 });
    put(path.join(ws.home, '.gemini', 'settings.json'), { mcpServers: { marrow: GENUINE_ENTRY } });
    put(path.join(ws.home, '.mcp.json'), { mcpServers: { marrow: GENUINE_ENTRY } });
    const report = await update(ws.home);
    assert.equal(report.update_not_set_up, undefined);
    const after = readJson(path.join(ws.home, '.gemini', 'settings.json'));
    assert.deepEqual(geminiHandlerNames(after), GEMINI_HANDLERS.slice().sort(), 'the four Gemini Marrow hooks are written');
    assert.deepEqual(after.hooks, reference.hooks, 'the hook lines are those a setup writes');
    assert.equal(after.mcpServers.marrow.args.some((arg) => /@getmarrow\/mcp@/.test(arg)), true, 'the owner MCP entry is kept');
  } finally { ws.cleanup(); ref.cleanup(); }
});

test('PG1: the Gemini MCP entry is the only Marrow line on the machine -> it counts as set up, only the Gemini group is written, as a setup writes it', async () => {
  const ws = tempHome();
  const ref = tempHome();
  try {
    fs.mkdirSync(path.join(ref.home, '.gemini'), { mode: 0o700 });
    await setup(ref.home);
    const reference = readJson(path.join(ref.home, '.gemini', 'settings.json'));
    fs.mkdirSync(path.join(ws.home, '.claude'), { mode: 0o700 });
    put(path.join(ws.home, '.gemini', 'settings.json'), { theme: 'dark', mcpServers: { marrow: GENUINE_ENTRY, other: { command: 'other-server' } } });
    const report = await update(ws.home);
    assert.equal(report.update_not_set_up, undefined, 'a Gemini MCP entry is a set-up host');
    const after = readJson(path.join(ws.home, '.gemini', 'settings.json'));
    assert.deepEqual(after.hooks, reference.hooks);
    assert.equal(after.theme, 'dark');
    assert.deepEqual(after.mcpServers.other, { command: 'other-server' });
    assert.equal(exists(ws, '.mcp.json'), false, 'no other host group gets a first file');
    assert.equal(exists(ws, '.claude/settings.json'), false);
  } finally { ws.cleanup(); ref.cleanup(); }
});

test('PG1: every Marrow MCP entry form the installer accepts counts in a Gemini settings file; look-alikes still do not', async () => {
  const counted = {
    pinned: GENUINE_ENTRY,
    package: { command: 'npx', args: ['-y', '--package=@getmarrow/mcp@3.9.98', 'marrow-mcp'] },
    minimal: { command: 'node', args: ['marrow-mcp'] },
  };
  for (const [name, entry] of Object.entries(counted)) {
    const ws = tempHome();
    try {
      put(path.join(ws.home, '.gemini', 'settings.json'), { mcpServers: { marrow: entry } });
      const report = await update(ws.home);
      assert.equal(report.update_not_set_up, undefined, `${name} counts as set up`);
      assert.deepEqual(geminiHandlerNames(readJson(path.join(ws.home, '.gemini', 'settings.json'))), GEMINI_HANDLERS.slice().sort(), name);
    } finally { ws.cleanup(); }
  }
  const lookAlikes = {
    otherKey: { other: GENUINE_ENTRY },
    markrowEvil: { 'marrow-evil': GENUINE_ENTRY },
    homoglyph: { 'mаrrow': GENUINE_ENTRY },
    zeroWidth: { 'marrow​': GENUINE_ENTRY },
    wrongPackage: { marrow: { command: 'npx', args: ['-y', '@getmarrow-x/mcp@3.9.109'] } },
    notAnObject: { marrow: 'npx -y @getmarrow/mcp@3.9.109' },
    emptyEntry: { marrow: {} },
  };
  for (const [name, servers] of Object.entries(lookAlikes)) {
    const ws = tempHome();
    try {
      put(path.join(ws.home, '.gemini', 'settings.json'), { mcpServers: servers });
      const before = read(ws, '.gemini/settings.json');
      const report = await update(ws.home);
      assert.equal(count(printed(report), 'Marrow is not set up here. Run: npx -y @getmarrow/install@latest'), 1, `${name} is not a set-up host`);
      assert.equal(read(ws, '.gemini/settings.json'), before, `${name}: the Gemini file is untouched`);
    } finally { ws.cleanup(); }
  }
});

// ---- PG2 (audit B2): a hard link to a credential store is never read ----------------------------------------------

async function hardLinkWorkspace() {
  const ws = tempHome();
  const key = dummyKey();
  const runSh = path.join(ws.home, 'scripts', 'run.sh');
  await setUpWithOwnerHook(ws, `${runSh} go`);
  const marrowEnv = path.join(ws.home, '.marrow', 'env');
  const body = `MARROW_API_KEY=${key}\n# runtime @getmarrow/mcp@3.9.77\n`;
  put(marrowEnv, body, 0o600);
  fs.chmodSync(path.dirname(marrowEnv), 0o700);
  fs.mkdirSync(path.dirname(runSh), { recursive: true });
  fs.linkSync(marrowEnv, runSh);
  assert.equal(fs.statSync(runSh).nlink, 2);
  return { ws, key, marrowEnv, body, runSh };
}

test('PG2: Y-hardlink-to-marrow-env: a launcher that is a hard link to ~/.marrow/env is never opened or read, no pin line, no key hit', async () => {
  const { ws, key, marrowEnv, body, runSh } = await hardLinkWorkspace();
  const spy = spyOwnerPins();
  try {
    let report;
    try { report = await update(ws.home); } finally { spy.done(); }
    assert.deepEqual(spy.opened, [], 'the pin scan opened a file that is a hard link to a credential store');
    assert.deepEqual(spy.reads, [], 'the pin scan read a hard link to a credential store');
    const text = everything(report);
    assert.ok(!text.includes(key) && !text.includes(key.slice(0, 12)), 'no key, no key prefix in any output');
    assert.ok(!text.includes('3.9.77'), 'no pin line from the key file');
    assert.deepEqual(report.owner_pins || [], []);
    assert.equal(count(printed(report), `${runSh} not scanned (a hard link)`), 1, 'the skip is named once, with a fixed reason');
    assert.equal(fs.readFileSync(marrowEnv, 'utf8'), body, 'the key file is byte-identical');
    assert.ok(!pinOutput(report).includes(marrowEnv), 'the credential store is not named in the pin report');
  } finally { spy.done(); ws.cleanup(); }
});

test('PG2: a link that appears between the check and the open (race) is caught on the open file: nothing is read', async () => {
  const { ws, key, runSh } = await hardLinkWorkspace();
  const spy = spyOwnerPins();
  const { lstatSync } = fs;
  try {
    // The first look at the launcher sees a single-link file; the file opened afterwards has two links.
    fs.lstatSync = function lyingLstat(target, ...rest) {
      const stat = lstatSync.call(this, target, ...rest);
      if (target === runSh && new Error().stack.includes('owner-pins.js')) {
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { nlink: 1 });
      }
      return stat;
    };
    let report;
    try { report = await update(ws.home); } finally { fs.lstatSync = lstatSync; spy.done(); }
    assert.deepEqual(spy.reads, [], 'the open file was read although it has more than one link');
    const text = everything(report);
    assert.ok(!text.includes(key) && !text.includes(key.slice(0, 12)));
    assert.ok(!text.includes('3.9.77'));
    assert.deepEqual(report.owner_pins || [], []);
  } finally { fs.lstatSync = lstatSync; spy.done(); ws.cleanup(); }
});

test('PG2: a plain single-link launcher is still read and reported (the scan is live in the same run)', async () => {
  const ws = tempHome();
  try {
    const launcher = path.join(ws.home, 'scripts', 'marrow-launch.sh');
    put(launcher, '#!/bin/sh\nexec npx -y @getmarrow/mcp@3.9.77 marrow-mcp\n', 0o700);
    await setUpWithOwnerHook(ws, `${launcher} go`);
    const report = await update(ws.home);
    assert.deepEqual((report.owner_pins || []).map((pin) => `${pin.path}:${pin.line}`), [`${launcher}:2`]);
  } finally { ws.cleanup(); }
});

// ---- PG3 (audit B3): the owner's credential-store list is never opened or named ---------------------------------------

// One row per entry of the owner's list (and the any-.env rule). Each file holds a dummy key and a pin line.
const CREDENTIAL_ENTRIES = {
  '.marrow/env': '.marrow/env',
  '.marrow/fleet.env': '.marrow/fleet.env',
  '.marrow/credentials/any-file': '.marrow/credentials/any-file.txt',
  '.npmrc': '.npmrc',
  '.git-credentials': '.git-credentials',
  'gh/hosts.yml': '.config/gh/hosts.yml',
  'gh/hosts.yml (custom config dir)': 'ghconf/hosts.yml',
  '.claude.json': '.claude.json',
  'settings.local.json': '.claude/settings.local.json',
  'settings.local.json (project)': 'proj/.claude/settings.local.json',
  'auth.json': 'auth.json',
  'auth.json (nested)': '.config/tool/auth.json',
  '.hermes/config.yaml': '.hermes/config.yaml',
  '.env': 'proj/.env',
  '.env.local': 'proj/.env.local',
  'any *.env': 'proj/prod.env',
  'fleet.env elsewhere': 'secrets/fleet.env',
};

for (const [entry, relative] of Object.entries(CREDENTIAL_ENTRIES)) {
  test(`PG3: credential store ${entry} named in a hook command (absolute, ~/ and $HOME/ forms) is never opened, named or read`, async () => {
    const ws = tempHome();
    const key = dummyKey();
    const spy = spyOwnerPins();
    try {
      const store = path.join(ws.home, relative);
      const control = path.join(ws.home, 'scripts', 'marrow-control.sh');
      await setUpWithOwnerHook(ws, `cat ${store} && cat ~/${relative} ; cat $HOME/${relative} ; ${control}`);
      put(store, `{"token":"${key}"}\n# @getmarrow/mcp@3.9.77 ${key}\n`, 0o600);
      put(control, '#!/bin/sh\nexec npx -y @getmarrow/mcp@3.9.78 marrow-mcp\n', 0o700);
      let report;
      try { report = await update(ws.home); } finally { spy.done(); }
      assert.deepEqual(spy.opened.filter((file) => file !== control), [], `the pin scan opened ${entry}`);
      const text = everything(report);
      assert.ok(!text.includes(key) && !text.includes(key.slice(0, 12)), 'no key, no key prefix');
      assert.ok(!text.includes('3.9.77'), `${entry}: a pin line from the store was reported`);
      assert.ok(!pinOutput(report).includes(relative) && !pinOutput(report).includes(store), `${entry}: the store is named in the pin report`);
      assert.deepEqual((report.owner_pins || []).map((pin) => `${pin.path}:${pin.line}`), [`${control}:2`], 'the control launcher is the only file reported');
    } finally { spy.done(); ws.cleanup(); }
  });
}

test('PG3: Y-claude-json-named: `cat ~/.claude.json <home>/.claude/settings.local.json && <genuine hook>` reads and names neither file', async () => {
  const ws = tempHome();
  const key = dummyKey();
  const spy = spyOwnerPins();
  try {
    await setUpWithOwnerHook(ws, `cat ~/.claude.json ${ws.home}/.claude/settings.local.json && npx -y @getmarrow/mcp@3.9.50 marrow-mcp hook`);
    put(path.join(ws.home, '.claude.json'), { oauthAccount: { token: key }, note: '@getmarrow/mcp@3.9.100' });
    put(path.join(ws.home, '.claude', 'settings.local.json'), { env: { K: key }, x: '@getmarrow/mcp@3.9.101' });
    let report;
    try { report = await update(ws.home); } finally { spy.done(); }
    assert.deepEqual(spy.opened, []);
    const text = everything(report);
    assert.ok(!text.includes(key) && !text.includes(key.slice(0, 12)));
    assert.ok(!text.includes('3.9.100') && !text.includes('3.9.101'));
    assert.ok(!pinOutput(report).includes('.claude.json') && !pinOutput(report).includes('settings.local.json'), 'neither file is named in the pin report');
  } finally { spy.done(); ws.cleanup(); }
});

test('PG3: a credential store reached through a folder that links to it by another name is matched on the resolved path', async () => {
  const ws = tempHome();
  const key = dummyKey();
  const spy = spyOwnerPins();
  try {
    await setUpWithOwnerHook(ws, `cat ${ws.home}/alias-a/token.txt ${ws.home}/alias-b/hosts.yml ${ws.home}/alias-c/settings.local.json`);
    put(path.join(ws.home, '.marrow', 'credentials', 'token.txt'), `${key}\n# @getmarrow/mcp@3.9.77\n`, 0o600);
    put(path.join(ws.home, '.config', 'gh', 'hosts.yml'), `token: ${key}\n# @getmarrow/mcp@3.9.77\n`, 0o600);
    put(path.join(ws.home, 'real', 'settings.local.json'), `{"k":"${key}"} @getmarrow/mcp@3.9.77\n`, 0o600);
    fs.symlinkSync(path.join(ws.home, '.marrow', 'credentials'), path.join(ws.home, 'alias-a'));
    fs.symlinkSync(path.join(ws.home, '.config', 'gh'), path.join(ws.home, 'alias-b'));
    fs.symlinkSync(path.join(ws.home, 'real'), path.join(ws.home, 'alias-c'));
    let report;
    try { report = await update(ws.home); } finally { spy.done(); }
    assert.deepEqual(spy.opened, []);
    const text = everything(report);
    assert.ok(!text.includes(key) && !text.includes('3.9.77'));
  } finally { spy.done(); ws.cleanup(); }
});

// ---- PG4 (audit B4): the older stale-form recognizer is proven by a test that can fail --------------------------------

// The Windsurf hooks the installer wrote at 0.1.60 (commit 3324160): `npx --package` pinned entry inside `sh -c '...'`.
function windsurf0160(version) {
  const guard = (word) => `sh -c 'stderr="$(npx -y --package=@getmarrow/mcp@${version} marrow-mcp ${word} 2>&1 >/dev/null)"; status=$?; if [ "$status" -eq 0 ]; then exit 0; fi; if [ "$status" -eq 2 ]; then printf "%s\\n" "$stderr" >&2; exit 2; fi; printf "%s\\n" "Marrow governance adapter was unavailable; this action is blocked." >&2; exit 2'`;
  const post = (word) => `sh -c 'npx -y --package=@getmarrow/mcp@${version} marrow-mcp ${word} >/dev/null 2>&1 || :; exit 0'`;
  const hook = (command) => [{ command, show_output: false }];
  return {
    hooks: {
      pre_write_code: hook(guard('windsurf-pre-action-hook')),
      pre_run_command: hook(guard('windsurf-pre-action-hook')),
      pre_mcp_tool_use: hook(guard('windsurf-pre-action-hook')),
      post_write_code: hook(post('windsurf-hook')),
      post_run_command: hook(post('windsurf-hook')),
      post_mcp_tool_use: hook(post('windsurf-hook')),
      post_cascade_response: hook(post('windsurf-session-hook')),
    },
  };
}

test('PG4: the 0.1.60 Windsurf hook form alone in its group counts as set up and is refreshed exactly as a setup writes it', async () => {
  const ws = tempHome();
  const ref = tempHome();
  try {
    fs.mkdirSync(path.join(ref.home, '.windsurf'), { mode: 0o700 });
    await setup(ref.home);
    const reference = read(ref, '.windsurf/hooks.json');
    assert.doesNotMatch(reference, /3\.9\.92/);
    put(path.join(ws.home, '.windsurf', 'hooks.json'), windsurf0160('3.9.92'));
    assert.ok(read(ws, '.windsurf/hooks.json').includes('3.9.92'));
    const report = await update(ws.home);
    assert.equal(report.update_not_set_up, undefined, 'the 0.1.60 Windsurf form is a set-up host');
    assert.equal(read(ws, '.windsurf/hooks.json'), reference, 'refreshed to the form a setup writes');
    assert.equal(exists(ws, '.mcp.json'), false, 'no other host group gets a first file');
  } finally { ws.cleanup(); ref.cleanup(); }
});

test('PG4: the env-prefixed pinned hook alone in its group counts as set up and is refreshed exactly as a setup writes it', async () => {
  const ws = tempHome();
  const ref = tempHome();
  try {
    fs.mkdirSync(path.join(ref.home, '.claude'), { mode: 0o700 });
    await setup(ref.home);
    const referenceMcp = read(ref, '.mcp.json');
    const referenceHooks = readJson(path.join(ref.home, '.claude', 'settings.json')).hooks;
    fs.mkdirSync(path.join(ws.home, '.claude'), { mode: 0o700 });
    put(path.join(ws.home, '.claude', 'settings.json'), {
      hooks: { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'MARROW_DEBUG=1 npx -y @getmarrow/mcp@3.9.50 marrow-mcp hook' }] }] },
    });
    const report = await update(ws.home);
    assert.equal(report.update_not_set_up, undefined, 'the env-prefixed pinned hook is a set-up host');
    assert.equal(read(ws, '.mcp.json'), referenceMcp, '.mcp.json is written as a setup writes it');
    const after = readJson(path.join(ws.home, '.claude', 'settings.json')).hooks;
    const commands = (hooks) => Object.values(hooks).flat().flatMap((entry) => entry.hooks.map((hook) => hook.command));
    for (const command of commands(referenceHooks)) assert.ok(commands(after).includes(command), 'a hook a setup writes is missing');
  } finally { ws.cleanup(); ref.cleanup(); }
});

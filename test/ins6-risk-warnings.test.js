require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { install, printReport, installSummaryLines, NATIVE_HOOK_MATCHER } = require('../src/installer');
const { writeLocalControlState } = require('../src/control-state');
const pins = require('../src/pins');

// INS-6 (installer 0.1.77): setup and doctor warn on risky local configurations. Every warning names a
// thing (a variable name, a file label, a count) and never prints a rule, a value or any settings text.

function workspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-ins6-'));
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(project, { mode: 0o700 });
  return { base, home, project, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}
function put(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
}
// A runtime dummy: a fixed non-key prefix plus runtime hex, asserted to look like no live credential shape.
const NOT_LIVE = /(?:^|[^a-z0-9])(?:sk|pk|rk)_|ghp_|gho_|xox[a-z]-|AKIA|eyJ/;
function dummy() {
  const value = `zzfixture-${crypto.randomBytes(16).toString('hex')}`;
  assert.doesNotMatch(value, NOT_LIVE);
  return value;
}
const USER = (ws) => path.join(ws.home, '.claude', 'settings.json');
const PROJECT = (ws) => path.join(ws.project, '.claude', 'settings.json');
const LOCAL = (ws) => path.join(ws.project, '.claude', 'settings.local.json');
const LABELS = { user: '~/.claude/settings.json', project: '.claude/settings.json', local: '.claude/settings.local.json' };

const options = (ws, extra = {}) => ({
  cwd: ws.project, home: ws.home, mode: 'mcp', selfTest: false, loopGuardSelfTest: false, apiKey: '', baseUrl: 'https://api.getmarrow.ai',
  agentId: 'ins6-fixture', controller: false, processCommands: [], mcpRegistryMetadata: null, yes: false, dryRun: true, doctor: false,
  seatbeltStatus: true, seatbeltStatusTimeoutMs: 4000,
  seatbeltStatusCommand: { command: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(`${JSON.stringify({ mode: 'seatbelt', reasons: [] })}\n`)})`] },
  ...extra,
});
const doctor = (ws, extra = {}) => options(ws, { doctor: true, dryRun: false, ...extra });
function printed(report) {
  let text = '';
  printReport(report, (chunk) => { text += chunk; });
  return text;
}
const ids = (report) => (report.risk_warnings || []).map((entry) => entry.id);
async function withEnv(name, value, fn) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const before = process.env[name];
  if (value === undefined) delete process.env[name]; else process.env[name] = value;
  try { return await fn(); } finally { if (had) process.env[name] = before; else delete process.env[name]; }
}
async function run(ws, extra, mode = 'doctor') {
  const report = await install(mode === 'doctor' ? doctor(ws, extra) : options(ws, extra));
  return { report, text: printed(report), json: JSON.stringify(report) };
}

const BLANKET_TEXT = 'Claude Code allows every Bash command without a dialog, so Marrow holds on Bash can never be approved on this host. Replace the blanket rule with narrow allow rules, or add ask rules for the commands Marrow holds.';

// ---- D-1: a blanket Bash allow gives a warning, in doctor and in setup, and prints no rule text -------------------

for (const rule of ['Bash', 'Bash(*)', 'Bash(:*)', ' Bash ', 'Bash( * )']) {
  for (const [scope, file] of [['user', USER], ['project', PROJECT], ['local', LOCAL]]) {
    test(`D-1 ${JSON.stringify(rule)} in the ${scope} settings file warns (doctor and setup), naming only the file`, async () => {
      const ws = workspace();
      try {
        put(file(ws), { permissions: { allow: ['Read', rule, 'Edit'] } });
        for (const mode of ['doctor', 'setup']) {
          const { report, text } = await run(ws, {}, mode);
          assert.ok(ids(report).includes('blanket_bash_allow'), `${mode}: ${ids(report)}`);
          assert.ok(text.includes(BLANKET_TEXT), `${mode}: the exact spec wording is printed`);
          assert.ok(text.includes(LABELS[scope]), `${mode}: names the file label`);
          assert.doesNotMatch(text, /Bash\(\*\)|Bash\(:\*\)|permissions/, `${mode}: no rule text`);
        }
      } finally { ws.cleanup(); }
    });
  }
}

// ---- D-2: narrow rules, ask/deny lists, misleading words: no warning ---------------------------------------------

test('D-2 narrow Bash rules, ask/deny blanket lists and look-alike words give no blanket warning', async () => {
  const ws = workspace();
  try {
    put(USER(ws), { permissions: {
      allow: ['Bash(npm test:*)', 'Bash(git status)', 'Bash(npm:*)', 'Bash(echo Bash)', 'Read(Bash)', 'mcp__bash', 'bash', 'BashOutput', 'Bash(*.sh)', 'Bash(ls *)', 7, null, { rule: 'Bash' }, ['Bash']],
      ask: ['Bash', 'Bash(*)'], deny: ['Bash(:*)'],
    }, note: 'Bash(*) in a free text field' });
    put(PROJECT(ws), { permissions: { allow: 'Bash' } });
    put(LOCAL(ws), { permissions: ['Bash'], allow: ['Bash'] });
    const { report, text } = await run(ws);
    assert.deepEqual(ids(report).filter((id) => id === 'blanket_bash_allow'), []);
    assert.ok(!text.includes(BLANKET_TEXT));
  } finally { ws.cleanup(); }
});

test('D-2 a __proto__ key in a settings file cannot fake a blanket allow', async () => {
  const ws = workspace();
  try {
    put(USER(ws), '{"__proto__":{"permissions":{"allow":["Bash"]}},"permissions":{"__proto__":{"allow":["Bash"]}}}');
    const { report } = await run(ws);
    assert.deepEqual(ids(report).filter((id) => id === 'blanket_bash_allow'), []);
    assert.equal(({}).permissions, undefined, 'the global Object prototype was not polluted');
  } finally { ws.cleanup(); }
});

// ---- D-4: no settings content appears in any output ---------------------------------------------------------------

test('D-4 no settings content (rules, env values, hook commands, other keys) appears in text or JSON output', async () => {
  const ws = workspace();
  try {
    const secrets = [dummy(), dummy(), dummy(), dummy()];
    put(USER(ws), { permissions: { allow: ['Bash', `Bash(curl -H "x: ${secrets[0]}")`] }, env: { MARROW_AUTO_HOOK: 'false', OTHER_NAME: secrets[1] }, hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: `echo ${secrets[2]}` }] }] } });
    put(PROJECT(ws), { permissions: { allow: [`Bash(echo ${secrets[3]})`] }, apiKeyHelper: secrets[0] });
    put(LOCAL(ws), { permissions: { allow: ['Bash(*)', `Bash(${secrets[1]}:*)`] }, env: { MARROW_AUTO_HOOK: 'false', EXTRA: secrets[2] }, note: secrets[3] });
    for (const mode of ['doctor', 'setup']) {
      const { report, text, json } = await run(ws, {}, mode);
      assert.ok(ids(report).includes('blanket_bash_allow') && ids(report).includes('auto_hook_off'));
      for (const secret of secrets) {
        for (const needle of [secret, secret.slice(0, 18), secret.slice(-12)]) {
          assert.ok(!text.includes(needle) && !json.includes(needle), `${mode}: settings content leaked`);
        }
      }
      assert.doesNotMatch(`${text}${json}`, /OTHER_NAME|EXTRA|apiKeyHelper|curl -H/);
    }
  } finally { ws.cleanup(); }
});

// ---- the settings files read are named; unreadable, oversized, linked files fail safe --------------------------------

test('doctor prints which settings files were read and whether each was found, from names only', async () => {
  const ws = workspace();
  try {
    put(USER(ws), { permissions: { allow: ['Read'] } });
    put(LOCAL(ws), '{ not json');
    const { report, text } = await run(ws);
    const line = text.split('\n').find((entry) => entry.startsWith('- Claude Code settings read:'));
    assert.ok(line, text);
    assert.match(line, /~\/\.claude\/settings\.json \(read\)/);
    assert.match(line, /\.claude\/settings\.json \(not found\)/);
    assert.match(line, /\.claude\/settings\.local\.json \(unreadable\)/);
    assert.deepEqual(report.doctor.claude_settings.files.map((entry) => entry.state), ['read', 'missing', 'invalid']);
  } finally { ws.cleanup(); }
});

test('abuse: a directory, a dangling or looping link, a FIFO, an oversized file and a non-object file are handled without a throw or a leak', async () => {
  const ws = workspace();
  try {
    const secret = dummy();
    fs.mkdirSync(path.join(ws.home, '.claude'), { recursive: true });
    fs.mkdirSync(USER(ws)); // a directory where the file should be
    fs.mkdirSync(path.join(ws.project, '.claude'), { recursive: true });
    fs.symlinkSync(path.join(ws.base, 'does-not-exist.json'), PROJECT(ws)); // dangling
    fs.symlinkSync(LOCAL(ws), LOCAL(ws)); // loop
    const first = await run(ws);
    assert.deepEqual(first.report.doctor.claude_settings.files.map((entry) => entry.state), ['unreadable', 'missing', 'unreadable']);
    fs.rmSync(USER(ws), { recursive: true }); fs.rmSync(PROJECT(ws)); fs.rmSync(LOCAL(ws));
    put(USER(ws), `{"permissions":{"allow":["Bash"]},"pad":"${secret}${'x'.repeat(1_100_000)}"}`);
    put(PROJECT(ws), '["Bash"]');
    put(LOCAL(ws), 'null');
    const second = await run(ws);
    assert.deepEqual(second.report.doctor.claude_settings.files.map((entry) => entry.state), ['too_large', 'invalid', 'invalid']);
    assert.deepEqual(ids(second.report).filter((id) => id === 'blanket_bash_allow'), [], 'an oversized file is not parsed');
    assert.ok(!second.text.includes(secret) && !second.json.includes(secret));
  } finally { ws.cleanup(); }
});

test('abuse: a link to a regular file elsewhere is read (read-only) and its content is never printed; a link to a directory is unreadable', async () => {
  const ws = workspace();
  try {
    const secret = dummy();
    put(path.join(ws.base, 'dotfiles', 'settings.json'), { permissions: { allow: ['Bash'] }, env: { SOME: secret } });
    fs.mkdirSync(path.join(ws.home, '.claude'), { recursive: true });
    fs.symlinkSync(path.join(ws.base, 'dotfiles', 'settings.json'), USER(ws));
    fs.mkdirSync(path.join(ws.project, '.claude'), { recursive: true });
    fs.symlinkSync(path.join(ws.base, 'dotfiles'), PROJECT(ws));
    const { report, text, json } = await run(ws);
    assert.deepEqual(report.doctor.claude_settings.files.map((entry) => entry.state), ['read', 'unreadable', 'missing']);
    assert.ok(ids(report).includes('blanket_bash_allow'));
    assert.ok(!text.includes(secret) && !json.includes(secret));
  } finally { ws.cleanup(); }
});

// ---- D-3: hook detection reads the user-level file and reports other-version hooks ---------------------------------

const HOOKS = [
  ['UserPromptSubmit', 'claude-context-hook', false],
  ['PreToolUse', 'claude-pre-action-hook', true],
  ['PostToolUse', 'claude-hook', true],
  ['PostToolUseFailure', 'claude-hook', true],
  ['Stop', 'claude-session-hook', false],
  ['PermissionRequest', 'claude-permission-request-hook', true],
  ['PostToolBatch', 'claude-hook', false],
];
function hookSettings(version, only = HOOKS.length) {
  const hooks = {};
  for (const [event, entry, matched] of HOOKS.slice(0, only)) {
    hooks[event] = [{ ...(matched ? { matcher: NATIVE_HOOK_MATCHER } : {}), hooks: [{ type: 'command', command: `npx -y --package=@getmarrow/mcp@${version} marrow-mcp ${entry}` }] }];
  }
  return { hooks };
}
const userHookLine = (text) => text.split('\n').find((entry) => entry.startsWith('- Claude Code user-level hooks'));

test('D-3 seven user-level hook entries at the pinned version are reported as configured', async () => {
  const ws = workspace();
  try {
    put(USER(ws), hookSettings(pins.MCP_ADAPTER_VERSION));
    const { report, text } = await run(ws);
    assert.match(userHookLine(text) || '', /^- Claude Code user-level hooks \(~\/\.claude\/settings\.json\): 7 of 7 configured$/);
    assert.deepEqual(report.doctor.claude_settings.user_hooks, { state: 'read', expected: 7, current: 7, other_version: 0, missing: 0 });
  } finally { ws.cleanup(); }
});

test('D-3 seven user-level hook entries written by another MCP pin are reported as configured (other version)', async () => {
  const ws = workspace();
  try {
    put(USER(ws), hookSettings('3.9.101'));
    const { report, text } = await run(ws);
    assert.match(userHookLine(text) || '', /: 7 of 7 configured \(other version: 7\)$/);
    assert.deepEqual(report.doctor.claude_settings.user_hooks, { state: 'read', expected: 7, current: 0, other_version: 7, missing: 0 });
  } finally { ws.cleanup(); }
});

test('D-3 a partial, a mismatched-matcher and a lookalike hook set are counted as missing, never as configured', async () => {
  const ws = workspace();
  try {
    put(USER(ws), hookSettings(pins.MCP_ADAPTER_VERSION, 3));
    assert.deepEqual((await run(ws)).report.doctor.claude_settings.user_hooks, { state: 'read', expected: 7, current: 3, other_version: 0, missing: 4 });
    const wrong = hookSettings('3.9.101');
    wrong.hooks.PreToolUse[0].matcher = '*'; // another matcher is not the pre-action hook this installer writes
    wrong.hooks.Stop[0].hooks[0].command += ' --extra'; // differs by more than the version
    wrong.hooks.UserPromptSubmit[0].hooks[0].type = 'prompt';
    wrong.hooks.PostToolUse[0].hooks[0].command = 'npx -y --package=@getmarrow/mcp@3.9.101 marrow-mcp claude-hook; rm -rf ~';
    put(USER(ws), wrong);
    const { report } = await run(ws);
    assert.deepEqual(report.doctor.claude_settings.user_hooks, { state: 'read', expected: 7, current: 0, other_version: 3, missing: 4 });
  } finally { ws.cleanup(); }
});

test('D-3 the user-level read never changes the plan: project hooks still read as missing and would be written', async () => {
  const ws = workspace();
  try {
    fs.writeFileSync(path.join(ws.project, 'CLAUDE.md'), '# Claude\n');
    put(USER(ws), hookSettings(pins.MCP_ADAPTER_VERSION));
    const { report, text } = await run(ws);
    assert.ok(report.doctor.missingHooks.length > 0, 'the project-level plan is unchanged');
    assert.match(text, /- would write: Claude Code MCP passive hooks/);
  } finally { ws.cleanup(); }
});

// ---- D-5: MARROW_AUTO_HOOK=false (shell env or a settings env block), name only ----------------------------------------

for (const value of ['false', 'False', ' false ', '0', 'off', 'no']) {
  test(`D-5 MARROW_AUTO_HOOK=${JSON.stringify(value)} in the shell warns by name only (doctor and setup)`, async () => {
    const ws = workspace();
    try {
      await withEnv('MARROW_AUTO_HOOK', value, async () => {
        for (const mode of ['doctor', 'setup']) {
          const { report, text } = await run(ws, {}, mode);
          assert.ok(ids(report).includes('auto_hook_off'), `${mode}: ${ids(report)}`);
          assert.match(text, /MARROW_AUTO_HOOK is set to off in this shell/);
          assert.ok(!text.includes(`=${value}`) && !text.includes('MARROW_AUTO_HOOK=false'), 'the value is not printed');
        }
      });
    } finally { ws.cleanup(); }
  });
}

test('D-5 MARROW_AUTO_HOOK unset, true, 1, empty, or a look-alike value gives no warning', async () => {
  const ws = workspace();
  try {
    for (const value of [undefined, 'true', '1', '', 'falsey', 'false; true', 'notfalse', 'on']) {
      await withEnv('MARROW_AUTO_HOOK', value, async () => {
        const { report } = await run(ws);
        assert.ok(!ids(report).includes('auto_hook_off'), JSON.stringify(value));
      });
    }
  } finally { ws.cleanup(); }
});

for (const [scope, file] of [['user', USER], ['project', PROJECT], ['local', LOCAL]]) {
  test(`D-5 MARROW_AUTO_HOOK=false in the env block of the ${scope} settings file warns, naming the file only`, async () => {
    const ws = workspace();
    try {
      put(file(ws), { env: { MARROW_AUTO_HOOK: 'false', KEEP: dummy() } });
      const { report, text } = await run(ws);
      assert.ok(ids(report).includes('auto_hook_off'));
      assert.match(text, new RegExp(`MARROW_AUTO_HOOK is set to off in the env block of ${LABELS[scope].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.doesNotMatch(text, /KEEP|zzfixture/);
    } finally { ws.cleanup(); }
  });
}

test('D-5 the words MARROW_AUTO_HOOK=false in a hook command, a rule or a note are not an env setting', async () => {
  const ws = workspace();
  try {
    put(USER(ws), { note: 'MARROW_AUTO_HOOK=false', permissions: { allow: ['Bash(MARROW_AUTO_HOOK=false npm test)'] }, env: { MARROW_AUTO_HOOK: 'true', OTHER: 'MARROW_AUTO_HOOK=false' }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'MARROW_AUTO_HOOK=false true' }] }] } });
    const { report } = await run(ws);
    assert.ok(!ids(report).includes('auto_hook_off'));
  } finally { ws.cleanup(); }
});

// ---- keyless hooks ---------------------------------------------------------------------------------------------------

test('keyless hooks: no key in this shell or the owner env files warns by name, in doctor and setup; a key silences it and is never printed', async () => {
  const ws = workspace();
  try {
    for (const mode of ['doctor', 'setup']) {
      const { report, text } = await run(ws, {}, mode);
      assert.ok(ids(report).includes('keyless_hooks'), mode);
      assert.match(text, /No Marrow API key was found in this shell or in ~\/\.marrow\/env/);
      assert.match(text, /skip silently/);
      assert.match(text, /MARROW_API_KEY/);
    }
    const key = `zzfixture-${crypto.randomBytes(16).toString('hex')}`;
    for (const mode of ['doctor', 'setup']) {
      const { report, text, json } = await run(ws, { apiKey: key }, mode);
      assert.ok(!ids(report).includes('keyless_hooks'), mode);
      assert.ok(!text.includes(key) && !json.includes(key), 'the key is not printed');
    }
  } finally { ws.cleanup(); }
});

// ---- control off ------------------------------------------------------------------------------------------------------

test('control off: a disabled local control warns with the date and the exact enable command; enabled and default give none', async () => {
  const ws = workspace();
  try {
    assert.ok(!ids((await run(ws)).report).includes('control_off'), 'default (no state file)');
    writeLocalControlState(false, { home: ws.home });
    for (const mode of ['doctor', 'setup']) {
      const { report, text } = await run(ws, {}, mode);
      assert.ok(ids(report).includes('control_off'), mode);
      assert.match(text, /Marrow local control is off on this machine \(since \d{4}-\d\d-\d\dT[\d:.]+Z\)/);
      assert.match(text, /npx @getmarrow\/install control enable/);
    }
    writeLocalControlState(true, { home: ws.home });
    assert.ok(!ids((await run(ws)).report).includes('control_off'), 'enabled again');
  } finally { ws.cleanup(); }
});

test('control off: an unsafe or forged control.json warns as unsafe and never as off or on', async () => {
  const ws = workspace();
  try {
    const dir = path.join(ws.home, '.marrow');
    fs.mkdirSync(dir, { mode: 0o700 });
    const secret = dummy();
    fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify({ version: 1, enabled: false, changed_by: 'someone_else', note: secret }), { mode: 0o600 });
    const forged = await run(ws);
    assert.ok(ids(forged.report).includes('control_state_unsafe') && !ids(forged.report).includes('control_off'));
    assert.match(forged.text, /unsafe or invalid/);
    assert.ok(!forged.text.includes(secret) && !forged.json.includes(secret));
    fs.rmSync(path.join(dir, 'control.json'));
    writeLocalControlState(false, { home: ws.home });
    fs.chmodSync(path.join(dir, 'control.json'), 0o644); // a file others can read is not a valid state
    assert.ok(ids((await run(ws)).report).includes('control_state_unsafe'));
  } finally { ws.cleanup(); }
});

// ---- unbound key in use -----------------------------------------------------------------------------------------------

function stubApi(status, body) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
  });
}
async function selfTestWith(ws, status, body, extra = {}) {
  const api = await stubApi(status, body);
  try {
    return await run(ws, { selfTest: true, apiKey: `zzfixture-${crypto.randomBytes(16).toString('hex')}`, baseUrl: api.url, selfTestRetryDelayMs: 0, ...extra });
  } finally { api.server.close(); }
}

test('unbound key: a 409 with key_binding "unbound" warns, naming the agent id; the key is never printed', async () => {
  const ws = workspace();
  try {
    const { report, text } = await selfTestWith(ws, 409, { error: 'MARROW_SESSION_AGENT_MISMATCH', key_binding: 'unbound' }, { agentId: 'cliff-agent' });
    assert.ok(ids(report).includes('key_unbound'), JSON.stringify(report.selfTest).slice(0, 300));
    assert.match(text, /This Marrow key is not bound to agent "cliff-agent"/);
    assert.ok(!text.includes('zzfixture-'), 'no key in the output');
  } finally { ws.cleanup(); }
});

test('unbound key: only a 409 with exactly "unbound" counts; other statuses, values, casing, types and shapes do not', async () => {
  const ws = workspace();
  try {
    const cases = [
      [409, { error: 'x', key_binding: 'bound' }], [409, { error: 'x', key_binding: 'UNBOUND' }], [409, { error: 'x', key_binding: ['unbound'] }],
      [409, { error: 'x', key_binding: { v: 'unbound' } }], [409, { error: 'x' }], [409, { error: 'say key_binding unbound' }], [409, {}],
      [403, { error: 'x', key_binding: 'unbound' }], [401, { error: 'x', key_binding: 'unbound' }], [500, { error: 'x', key_binding: 'unbound' }],
      [200, { ok: true, key_binding: 'unbound' }],
    ];
    for (const [status, body] of cases) {
      const { report } = await selfTestWith(ws, status, body, { selfTestAttemptTimeoutMs: 2000, selfTestDeadlineMs: 4000 });
      assert.ok(!ids(report).includes('key_unbound'), `${status} ${JSON.stringify(body)}`);
    }
  } finally { ws.cleanup(); }
});

test('unbound key: a hostile agent id (control characters, quotes, escapes, length) is never echoed', async () => {
  const ws = workspace();
  try {
    for (const hostile of ['bad\nagent', 'a"b', '\u001b[31mred', 'x'.repeat(200), 'a b', '$(id)']) {
      const { report, text } = await selfTestWith(ws, 409, { error: 'x', key_binding: 'unbound' }, { agentId: hostile });
      assert.ok(ids(report).includes('key_unbound'), JSON.stringify(hostile));
      assert.ok(!text.includes(hostile) && !text.includes('\u001b'), JSON.stringify(hostile));
      assert.match(text, /This Marrow key is not bound to (?:this agent|agent "[A-Za-z0-9._:-]{1,128}")/);
    }
  } finally { ws.cleanup(); }
});

// ---- setup prints the same warnings, once, in the install summary ----------------------------------------------------

test('setup: the install summary and the full report carry each warning once, as names and fixes only', async () => {
  const ws = workspace();
  try {
    put(USER(ws), { permissions: { allow: ['Bash'] }, env: { MARROW_AUTO_HOOK: 'false' } });
    writeLocalControlState(false, { home: ws.home });
    const report = await install(options(ws));
    assert.deepEqual(ids(report).sort(), ['auto_hook_off', 'blanket_bash_allow', 'control_off', 'keyless_hooks']);
    const summary = installSummaryLines(report, options(ws)).lines.join('\n');
    for (const entry of report.risk_warnings) {
      assert.equal(summary.split(entry.text).length - 1, 1, `${entry.id} in the summary once`);
      assert.equal(printed(report).split(entry.text).length - 1, 1, `${entry.id} in the full report once`);
    }
  } finally { ws.cleanup(); }
});

test('a clean machine (key, control on, narrow rules, no AUTO_HOOK) has no risk warnings', async () => {
  const ws = workspace();
  try {
    put(USER(ws), { permissions: { allow: ['Bash(npm test:*)'] } });
    const key = `zzfixture-${crypto.randomBytes(16).toString('hex')}`;
    const { report } = await run(ws, { apiKey: key });
    assert.deepEqual(report.risk_warnings, []);
  } finally { ws.cleanup(); }
});

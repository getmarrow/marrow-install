require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { install, printReport } = require('../src/installer');

// The same layouts test/agent-plugins.test.js uses: what `claude plugin install marrow@getmarrow` and
// `codex plugin add marrow@getmarrow` wrote, reduced to the files doctor reads.
const CLAUDE_PRE = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/marrow-launch.cjs" claude-pre-action-hook';
const CODEX_PRE = 'node "${PLUGIN_ROOT}/scripts/marrow-launch.cjs" codex-pre-action-hook';

function workspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-plugin-lines-'));
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(project, { mode: 0o700 });
  return { base, home, project, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  fs.writeFileSync(file, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
}

function pluginCopy(root, manifestDir, version, preAction, events) {
  write(path.join(root, manifestDir, 'plugin.json'), { name: 'marrow', version });
  write(path.join(root, 'scripts', 'marrow-launch.cjs'), '// launcher\n');
  const hooks = Object.fromEntries(events.map((event) => [event, [{ hooks: [{ type: 'command', command: event === 'PreToolUse' ? preAction : `${preAction}-other` }] }]]));
  write(path.join(root, 'hooks', 'hooks.json'), { hooks });
}

function claudeInstall(home, { enabled = true, key = 'marrow@getmarrow' } = {}) {
  const version = '0.2.1';
  const copy = path.join(home, '.claude', 'plugins', 'cache', 'getmarrow', 'marrow', version);
  pluginCopy(copy, '.claude-plugin', version, CLAUDE_PRE, ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);
  write(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), { version: 2, plugins: { [key]: [{ scope: 'user', installPath: copy, version }] } });
  write(path.join(home, '.claude', 'settings.json'), { enabledPlugins: { [key]: enabled } });
  return copy;
}

function codexInstall(home, { enabled = true } = {}) {
  const codexHome = path.join(home, '.codex');
  const version = '0.1.1';
  const copy = path.join(codexHome, 'plugins', 'cache', 'getmarrow', 'marrow', version);
  pluginCopy(copy, '.codex-plugin', version, CODEX_PRE, ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionEnd']);
  write(path.join(codexHome, 'config.toml'), `[plugins."marrow@getmarrow"]\nenabled = ${enabled}\n`);
  return copy;
}

const STATUS = (value) => ({
  seatbeltStatus: true,
  seatbeltStatusTimeoutMs: 4000,
  seatbeltStatusCommand: { command: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(`${JSON.stringify(value)}\n`)})`] },
});
const SEATBELT_ON = STATUS({ mode: 'seatbelt', reasons: [] });

const doctorOptions = (ws, extra = {}) => ({
  cwd: ws.project, home: ws.home, mode: 'mcp', selfTest: false, loopGuardSelfTest: false, apiKey: '', baseUrl: 'https://api.getmarrow.ai',
  agentId: 'plugin-lines-fixture', controller: false, processCommands: [], mcpRegistryMetadata: null, yes: false, dryRun: false, doctor: true, ...SEATBELT_ON, ...extra,
});

function printed(report) {
  let text = '';
  printReport(report, (chunk) => { text += chunk; });
  return text;
}

const linesOf = (text) => text.split('\n');
const wouldWrite = (text) => linesOf(text).filter((entry) => entry.startsWith('- would write:'));
const wouldWriteLabels = (text) => wouldWrite(text).map((entry) => entry.replace(/^- would write: /, '').replace(/ \(.*$/, '')).sort();
const DOCTOR_BLOCK = (text) => text.slice(text.indexOf('\nDoctor:\n'));

const CLAUDE_KEY_FIX = 'Put MARROW_API_KEY in ~/.marrow/env, run chmod 600 ~/.marrow/env, then run /reload-plugins in Claude Code. The plugin already supplies the hooks; do not run --repair or activate.';
const CODEX_KEY_FIX = 'Put MARROW_API_KEY in ~/.marrow/env, run chmod 600 ~/.marrow/env, then restart Codex. The plugin already supplies the hooks; do not run --repair or activate.';
const BASE_KEY_FIX = 'Set MARROW_API_KEY, then run npx @getmarrow/install --repair.';

test('keyless Claude Code machine with the plugin counted: seatbelt label, one supplied line, no duplicate writes, the plugin key path', async () => {
  const ws = workspace();
  try {
    fs.writeFileSync(path.join(ws.project, 'CLAUDE.md'), '# Claude\n');
    const bare = await install(doctorOptions(ws));
    const bareText = printed(bare);
    assert.equal(wouldWrite(bareText).length, 2, 'without a plugin: the hooks and .mcp.json would be written, as before');
    assert.match(bareText, /\n- Marrow active: no\n- Seatbelt: on \(no account\)\n/);
    assert.match(bareText, new RegExp(`- recommended fix: ${BASE_KEY_FIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\n`));
    assert.deepEqual(bare.doctor.missingHooks, ['Claude Code MCP passive hooks', 'Project MCP server config']);

    claudeInstall(ws.home);
    const report = await install(doctorOptions(ws));
    const text = printed(report);
    // Planned changes: nothing to write for Claude Code, one line says why.
    assert.deepEqual(wouldWrite(text), []);
    assert.doesNotMatch(text, /would write: (Claude Code MCP passive hooks|Project MCP server config)/);
    assert.equal(linesOf(text).filter((entry) => entry === '- Claude Code hooks: supplied by the Marrow plugin (nothing to write)').length, 1);
    assert.ok(text.indexOf('- Claude Code hooks: supplied by the Marrow plugin') > text.indexOf('Planned changes:'));
    // The Doctor block.
    const block = DOCTOR_BLOCK(text);
    assert.match(block, /^\nDoctor:\n- Marrow active: seatbelt only \(no key yet\)\n- Seatbelt: on \(no account\)\n- missing env: MARROW_API_KEY\n- missing hooks\/config: none\n- agent plugin: Claude Code: Marrow plugin 0\.2\.1 /);
    assert.ok(block.includes(`- recommended fix: ${CLAUDE_KEY_FIX}\n`));
    assert.doesNotMatch(block, /run npx @getmarrow\/install --repair|--repair\.$/m);
    assert.equal(report.doctor.recommendedFix, CLAUDE_KEY_FIX);
    // The verdict fields are the base ones: the plugin hides the hook label only, as before.
    assert.equal(report.doctor.active, false);
    assert.deepEqual(report.doctor.missingHooks, ['Project MCP server config']);
    assert.deepEqual(report.doctor.missingEnv, ['MARROW_API_KEY']);
    assert.equal(report.changes.filter((change) => change.changed).length, 2, 'the planned changes (what --repair would write) are untouched');
  } finally {
    ws.cleanup();
  }
});

test('the seatbelt-only label needs the seatbelt line to say "on (no account)"', async () => {
  const ws = workspace();
  try {
    fs.writeFileSync(path.join(ws.project, 'CLAUDE.md'), '# Claude\n');
    claudeInstall(ws.home);
    const cases = [
      [STATUS({ mode: 'seatbelt', reasons: [] }), '- Marrow active: seatbelt only (no key yet)'],
      [STATUS({ mode: 'claimed_no_key', reasons: ['home_mismatch'] }), '- Marrow active: no'],
      [STATUS({ mode: 'account', reasons: [] }), '- Marrow active: no'],
      [STATUS({ mode: 'unknown', reasons: [] }), '- Marrow active: no'],
      [{ seatbeltStatus: false }, '- Marrow active: no'],
      [{ seatbeltStatus: true, seatbeltStatusTimeoutMs: 400, seatbeltStatusCommand: { command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'] } }, '- Marrow active: no'],
    ];
    for (const [status, label] of cases) {
      const text = printed(await install(doctorOptions(ws, status)));
      assert.ok(linesOf(DOCTOR_BLOCK(text)).includes(label), `${label} for ${JSON.stringify(status.seatbeltStatusCommand?.args || status)}`);
    }
    // No plugin counted, so the label is the base one even with the seatbelt on.
    const noPlugin = workspace();
    try {
      fs.writeFileSync(path.join(noPlugin.project, 'CLAUDE.md'), '# Claude\n');
      assert.ok(linesOf(DOCTOR_BLOCK(printed(await install(doctorOptions(noPlugin))))).includes('- Marrow active: no'));
    } finally {
      noPlugin.cleanup();
    }
  } finally {
    ws.cleanup();
  }
});

test('a key set: the plugin machine keeps the base label and fix, and its planned lines are the plugin-aware ones', async () => {
  const ws = workspace();
  try {
    fs.writeFileSync(path.join(ws.project, 'CLAUDE.md'), '# Claude\n');
    claudeInstall(ws.home);
    const dummy = crypto.randomBytes(24).toString('hex');
    const report = await install(doctorOptions(ws, { apiKey: dummy, baseUrl: 'http://127.0.0.1:9' }));
    const text = printed(report);
    assert.ok(linesOf(DOCTOR_BLOCK(text)).includes('- Marrow active: no'), 'not "seatbelt only": a key is set');
    assert.equal(text.includes(dummy) || JSON.stringify(report).includes(dummy), false, 'the key never appears');
    assert.deepEqual(report.doctor.missingEnv, []);
    assert.doesNotMatch(String(report.doctor.recommendedFix), /\/reload-plugins|--repair or activate/);
  } finally {
    ws.cleanup();
  }
});

test('Codex plugin counted: the Codex hooks line is replaced, .mcp.json (a Claude Code file) is still planned; the fix says restart Codex', async () => {
  const ws = workspace();
  try {
    write(path.join(ws.project, '.codex', 'config.toml'), 'model = "x"\n');
    codexInstall(ws.home);
    const report = await install(doctorOptions(ws));
    const text = printed(report);
    // AGENTS.md is not something the plugin supplies, so its line stays.
    assert.deepEqual(wouldWriteLabels(text), ['Agent instructions', 'Project MCP server config']);
    assert.ok(text.includes('- Codex hooks: supplied by the Marrow plugin (nothing to write)\n'));
    assert.equal(text.includes('Claude Code hooks: supplied'), false);
    assert.ok(DOCTOR_BLOCK(text).includes('- Marrow active: seatbelt only (no key yet)\n'));
    assert.equal(report.doctor.recommendedFix, CODEX_KEY_FIX);
    assert.deepEqual(report.doctor.missingHooks, ['Project MCP server config', 'Agent instructions']);
    assert.match(printed(report), /- missing hooks\/config: Project MCP server config; Agent instructions\n/, 'files the Codex plugin does not supply are still listed');
  } finally {
    ws.cleanup();
  }
});

test('both plugins counted: both supplied lines and one fix that names both hosts', async () => {
  const ws = workspace();
  try {
    fs.writeFileSync(path.join(ws.project, 'CLAUDE.md'), '# Claude\n');
    write(path.join(ws.project, '.codex', 'config.toml'), 'model = "x"\n');
    claudeInstall(ws.home);
    codexInstall(ws.home);
    const report = await install(doctorOptions(ws));
    const text = printed(report);
    assert.deepEqual(wouldWriteLabels(text), ['Agent instructions']);
    assert.ok(text.includes('- Claude Code hooks: supplied by the Marrow plugin (nothing to write)\n'));
    assert.ok(text.includes('- Codex hooks: supplied by the Marrow plugin (nothing to write)\n'));
    assert.equal(report.doctor.recommendedFix, 'Put MARROW_API_KEY in ~/.marrow/env, run chmod 600 ~/.marrow/env, then run /reload-plugins in Claude Code and restart Codex. The plugins already supply the hooks; do not run --repair or activate.');
  } finally {
    ws.cleanup();
  }
});

test('a counted plugin does not hide another host: --repair advice stays when a host without a plugin would be written', async () => {
  const ws = workspace();
  try {
    fs.writeFileSync(path.join(ws.project, 'CLAUDE.md'), '# Claude\n');
    write(path.join(ws.project, '.codex', 'config.toml'), 'model = "x"\n');
    claudeInstall(ws.home);
    const report = await install(doctorOptions(ws));
    const text = printed(report);
    assert.deepEqual(wouldWriteLabels(text), ['Agent instructions', 'Codex native hooks']);
    assert.equal(report.doctor.recommendedFix, BASE_KEY_FIX);
    assert.ok(text.includes('- Claude Code hooks: supplied by the Marrow plugin (nothing to write)\n'));
    assert.ok(report.doctor.missingHooks.includes('Codex native hooks'));
  } finally {
    ws.cleanup();
  }
});

test('with a likely env file the plugin fix keeps its first sentence and drops the --repair advice', async () => {
  const ws = workspace();
  try {
    fs.writeFileSync(path.join(ws.project, 'CLAUDE.md'), '# Claude\n');
    // A key-looking file the installer already looks for (value never read by this test or printed).
    fs.writeFileSync(path.join(ws.project, '.env'), 'MARROW_API_KEY=placeholder\n', { mode: 0o600 });
    claudeInstall(ws.home);
    const report = await install(doctorOptions(ws));
    assert.equal(report.doctor.envHints.length, 1);
    assert.equal(report.doctor.recommendedFix, `MARROW_API_KEY was found in a likely env file at ${report.doctor.envHints[0]}. ${CLAUDE_KEY_FIX}`);
    assert.doesNotMatch(report.doctor.recommendedFix, /placeholder/);
  } finally {
    ws.cleanup();
  }
});

test('look-alike, disabled, unsafe and planted plugins are not counted: every line stays as before', async () => {
  const cases = {
    'another marketplace': (ws) => claudeInstall(ws.home, { key: 'marrow@evil' }),
    'plugin disabled': (ws) => claudeInstall(ws.home, { enabled: false }),
    'group-writable plugin folder': (ws) => fs.chmodSync(claudeInstall(ws.home), 0o775),
    'plugin planted in the project': (ws) => {
      claudeInstall(ws.project);
      write(path.join(ws.project, '.claude', 'settings.json'), { enabledPlugins: { 'marrow@getmarrow': true } });
    },
    'project turns the plugin off': (ws) => {
      claudeInstall(ws.home);
      write(path.join(ws.project, '.claude', 'settings.local.json'), { enabledPlugins: { 'marrow@getmarrow': false } });
    },
  };
  for (const [name, arrange] of Object.entries(cases)) {
    const ws = workspace();
    try {
      fs.writeFileSync(path.join(ws.project, 'CLAUDE.md'), '# Claude\n');
      arrange(ws);
      const report = await install(doctorOptions(ws));
      const text = printed(report);
      assert.equal(wouldWrite(text).length, 2, `${name}: both writes are still listed`);
      assert.equal(text.includes('supplied by the Marrow plugin'), false, name);
      assert.ok(linesOf(DOCTOR_BLOCK(text)).includes('- Marrow active: no'), name);
      assert.equal(report.doctor.recommendedFix, BASE_KEY_FIX, name);
      assert.match(text, /- missing hooks\/config: Claude Code MCP passive hooks; Project MCP server config\n/, name);
    } finally {
      ws.cleanup();
    }
  }
});

test('plugin plus installer hooks: the duplicate-hooks line is unchanged and nothing is said to be written', async () => {
  const ws = workspace();
  try {
    fs.writeFileSync(path.join(ws.project, 'CLAUDE.md'), '# Claude\n');
    claudeInstall(ws.home);
    await install(doctorOptions(ws, { yes: true, doctor: false }));
    const report = await install(doctorOptions(ws));
    const text = printed(report);
    assert.equal(report.doctor.duplicate_hooks.length, 1);
    assert.ok(text.includes(`- duplicate hooks: ${report.doctor.duplicate_hooks[0]}\n`));
    assert.match(report.doctor.duplicate_hooks[0], /^Claude Code: the Marrow plugin and this project's installer hooks .* both run, so every action is checked and recorded twice\./);
    assert.deepEqual(wouldWrite(text), []);
    assert.ok(text.includes('- Claude Code hooks: supplied by the Marrow plugin (nothing to write)\n'));
  } finally {
    ws.cleanup();
  }
});

test('a conflict or suppressed repair on a plugin host is still shown, only a plain "would write" is replaced', async () => {
  const ws = workspace();
  try {
    fs.writeFileSync(path.join(ws.project, 'CLAUDE.md'), '# Claude\n');
    claudeInstall(ws.home);
    const report = await install(doctorOptions(ws));
    const hooks = report.changes.find((change) => change.label === 'Claude Code MCP passive hooks');
    hooks.hook_conflict = true;
    hooks.exact_fix = 'fix it by hand';
    const mcp = report.changes.find((change) => change.label === 'Project MCP server config');
    mcp.automatic_repair_suppressed = true;
    mcp.exact_fix = 'verify the newer version';
    const text = printed(report);
    assert.match(text, /- preserved unmanaged owner file; review required: Claude Code MCP passive hooks /);
    assert.match(text, /- preserved unverified-ahead surface; repair suppressed: Project MCP server config /);
  } finally {
    ws.cleanup();
  }
});

test('machines that differ only in the key value print identical doctor output, and no output carries the key', async () => {
  const outputs = [];
  const dummies = [crypto.randomBytes(24).toString('hex'), crypto.randomBytes(24).toString('hex')];
  for (const dummy of dummies) {
    const ws = workspace();
    try {
      fs.writeFileSync(path.join(ws.project, 'CLAUDE.md'), '# Claude\n');
      claudeInstall(ws.home);
      const report = await install(doctorOptions(ws, { apiKey: dummy, baseUrl: 'http://127.0.0.1:9' }));
      const text = printed(report);
      const json = JSON.stringify(report);
      assert.equal(text.includes(dummy) || json.includes(dummy), false);
      outputs.push(text.split(ws.base).join('<ws>'));
    } finally {
      ws.cleanup();
    }
  }
  assert.equal(outputs[0], outputs[1]);
});

test('every string this change adds to doctor is plain ASCII without the banned words', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'installer.js'), 'utf8');
  for (const text of [CLAUDE_KEY_FIX, CODEX_KEY_FIX, 'supplied by the Marrow plugin (nothing to write)', 'seatbelt only (no key yet)']) {
    assert.match(text, /^[\x20-\x7e]+$/);
    assert.doesNotMatch(text, /\b(risk|risky|score|classifier)\b/i);
  }
  for (const text of ['supplied by the Marrow plugin (nothing to write)', 'seatbelt only (no key yet)', 'Put MARROW_API_KEY in ~/.marrow/env, run chmod 600 ~/.marrow/env, then ', 'plugins already supply', 'plugin already supplies', 'the hooks; do not run --repair or activate.']) {
    assert.ok(source.includes(text), text);
  }
});

require('./support/isolated-environment');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { install, installSummaryLines, printReport } = require('../src/installer');

// The sentence a user sees when a host's Marrow hooks are absent. `doctor` says it too (update's
// report and summary are covered in update-keeps-identity.test.js). The installer cannot tell a host
// that lost its hooks from one that never had them, so the sentence says "if" and both get it.
const line = (host) => `Marrow hooks for ${host} are missing. If Marrow was set up here, something removed them. Run npx -y @getmarrow/install@latest --repair to restore them.`;

function workspace() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-missing-')));
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(project, { mode: 0o700 });
  fs.mkdirSync(path.join(project, '.claude'));
  fs.mkdirSync(path.join(project, '.codex'));
  fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Project\n');
  return { base, home, project, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function options(ws, extra = {}) {
  return { cwd: ws.project, home: ws.home, mode: 'mcp', selfTest: false, loopGuardSelfTest: false, apiKey: '', baseUrl: 'https://api.getmarrow.ai',
    agentId: 'wording-fixture', controller: false, processCommands: [], mcpRegistryMetadata: null, yes: false, dryRun: false, doctor: true, ...extra };
}

function printed(report) {
  const out = [];
  printReport(report, (text) => out.push(text));
  return out.join('').split('\n');
}

// The layout `codex plugin add marrow@getmarrow` writes, reduced to the files doctor reads.
function codexPluginInstall(codexHome) {
  const copy = path.join(codexHome, 'plugins', 'cache', 'getmarrow', 'marrow', '0.1.1');
  const pre = 'node "${PLUGIN_ROOT}/scripts/marrow-launch.cjs" codex-pre-action-hook';
  const files = {
    [path.join(copy, '.codex-plugin', 'plugin.json')]: `${JSON.stringify({ name: 'marrow', version: '0.1.1' })}\n`,
    [path.join(copy, 'scripts', 'marrow-launch.cjs')]: '// launcher\n',
    [path.join(copy, 'hooks', 'hooks.json')]: `${JSON.stringify({ hooks: Object.fromEntries(['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionEnd'].map((event) => [event, [{ hooks: [{ type: 'command', command: event === 'PreToolUse' ? pre : `${pre}-other` }] }]])) })}\n`,
    [path.join(codexHome, 'config.toml')]: '[marketplaces.getmarrow]\nsource_type = "local"\n\n[plugins."marrow@getmarrow"]\nenabled = true\n',
  };
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
    fs.writeFileSync(file, text, { mode: 0o644 });
  }
}

test('doctor names a host whose Marrow hooks are absent, once, and not a host a plugin covers', async () => {
  const ws = workspace();
  try {
    // A machine with no Marrow configuration anywhere says nothing new: there is nothing that was removed.
    const fresh = await install(options(ws));
    assert.equal(fresh.doctor.hooks_missing_hosts, undefined);
    assert.equal(printed(fresh).some((text) => text.includes('Marrow hooks for')), false);

    await install(options(ws, { yes: true, doctor: false }));
    const healthy = await install(options(ws));
    assert.equal(healthy.doctor.hooks_missing_hosts, undefined, 'a healthy machine adds nothing to the report');
    assert.equal(printed(healthy).some((text) => text.includes('Marrow hooks for')), false);

    fs.rmSync(path.join(ws.project, '.codex', 'hooks.json'));
    const codexGone = await install(options(ws));
    assert.deepEqual(codexGone.doctor.hooks_missing_hosts.map((entry) => entry.host), ['Codex']);
    const lines = printed(codexGone);
    assert.equal(lines.filter((text) => text === `- ${line('Codex')}`).length, 1);
    assert.equal(lines.filter((text) => text.includes('Marrow hooks for')).length, 1);
    assert.ok(lines.indexOf('- missing hooks/config: Codex native hooks') < lines.indexOf(`- ${line('Codex')}`), 'it follows the missing list');

    // Two hosts, plus a Codex that its plugin covers: only the host without hooks or plugin is named.
    fs.rmSync(path.join(ws.project, '.claude', 'settings.json'));
    fs.rmSync(path.join(ws.project, '.mcp.json'));
    codexPluginInstall(path.join(ws.home, '.codex'));
    const withPlugin = await install(options(ws));
    assert.deepEqual([...new Set(withPlugin.doctor.hooks_missing_hosts.map((entry) => entry.host))], ['Claude Code']);
    assert.equal(printed(withPlugin).some((text) => text === `- ${line('Codex')}`), false, 'a plugin-covered host is not missing its hooks');
    assert.ok(printed(withPlugin).includes(`- ${line('Claude Code')}`));
  } finally {
    ws.cleanup();
  }
});

test('doctor writes nothing and the sentence names no secret or path', async () => {
  const ws = workspace();
  try {
    await install(options(ws, { yes: true, doctor: false }));
    fs.rmSync(path.join(ws.project, '.codex', 'hooks.json'));
    const before = fs.readdirSync(ws.project, { recursive: true }).sort();
    const report = await install(options(ws));
    assert.deepEqual(fs.readdirSync(ws.project, { recursive: true }).sort(), before);
    assert.equal(fs.existsSync(path.join(ws.project, '.codex', 'hooks.json')), false);
    for (const text of printed(report).filter((entry) => entry.includes('Marrow hooks for'))) assert.equal(text, `- ${line('Codex')}`);
  } finally {
    ws.cleanup();
  }
});

test('README states the outage rule of the pinned MCP: high-risk actions are held, routine ones warn', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const sentence = 'If Marrow is unreachable, hooks hold high-risk actions and let routine actions run with a warning, and the governed runner stops protected actions it cannot verify.';
  assert.equal(readme.split(sentence).length - 1, 1);
  assert.equal(readme.includes('If Marrow is unreachable, hooks let actions run with a warning'), false);
});

test('update: a host with several absent files is named once, in the report and in the summary; the AGENTS.md block keeps the older wording', async () => {
  const ws = workspace();
  try {
    const word = { yes: true, doctor: false, update: true, repair: true, updateOnly: true };
    await install(options(ws, { yes: true, doctor: false }));
    fs.mkdirSync(path.join(ws.project, '.cursor'));
    // .cursor appeared after the install: nothing of Cursor carries Marrow (three files), and AGENTS.md lost its block.
    const agents = path.join(ws.project, 'AGENTS.md');
    const text = fs.readFileSync(agents, 'utf8');
    fs.writeFileSync(agents, text.slice(0, text.indexOf('<!-- marrow:passive-start -->')) + text.slice(text.indexOf('<!-- marrow:passive-end -->') + '<!-- marrow:passive-end -->'.length));
    const report = await install(options(ws, word));
    assert.deepEqual([...new Set(report.update_skipped.filter((entry) => entry.host).map((entry) => entry.host))], ['Cursor']);
    assert.equal(report.update_skipped.filter((entry) => entry.host === 'Cursor').length, 3);
    const lines = printed(report);
    assert.equal(lines.filter((entry) => entry === `- ${line('Cursor')}`).length, 1, 'once in the report');
    const summary = installSummaryLines(report, options(ws, word)).lines;
    assert.equal(summary.filter((entry) => entry === line('Cursor')).length, 1, 'once in the summary');
    assert.ok(lines.some((entry) => /^- left alone by update: Agent instructions .* has no Marrow config; run npx -y @getmarrow\/install@latest --repair to add or restore it$/.test(entry)));
    assert.ok(summary.some((entry) => /^Update left 1 file\(s\) alone that have no Marrow config \(Agent instructions\); run npx/.test(entry)));
    assert.equal(fs.existsSync(path.join(ws.project, '.cursor', 'hooks.json')), false, 'update still writes nothing for it');
  } finally {
    ws.cleanup();
  }
});

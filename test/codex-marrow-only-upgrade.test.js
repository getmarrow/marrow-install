require('./support/isolated-environment');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const installer = require('../src/installer');
const PINS = require('../src/pins');

// The pair of files the published 0.1.70 wrote into an empty `.codex` folder (test/fixtures/
// installer-0170): Marrow's own hooks.json with the look-ahead matcher Codex rejects, and an
// AGENTS.md that holds only the Marrow block. 0.1.70 and 03a85d36 detect no Codex project there.
const FIXTURE = path.join(__dirname, 'fixtures', 'installer-0170');
const LOOK_AHEAD = /\(\?!mcp__marrow__/;
const FIX = 'npx @getmarrow/install@latest update';

function workspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-codex-only-'));
  fs.chmodSync(base, 0o700);
  const home = path.join(base, 'home');
  const root = path.join(base, 'project');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
  return { base, home, root, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function layout0170(root) {
  fs.mkdirSync(path.join(root, '.codex'));
  fs.copyFileSync(path.join(FIXTURE, 'codex-hooks.json'), path.join(root, '.codex', 'hooks.json'));
  fs.copyFileSync(path.join(FIXTURE, 'AGENTS.md'), path.join(root, 'AGENTS.md'));
}

const env = (ws) => ({ HOME: ws.home, PATH: process.env.PATH });
const hooksFile = (ws) => path.join(ws.root, '.codex', 'hooks.json');
const readHooks = (ws) => JSON.parse(fs.readFileSync(hooksFile(ws), 'utf8'));

// What `--yes` (writes), `update` (writes, repair) and `doctor` (report only) run, as the CLI
// builds them, with no key, no self-test and no controller.
function options(ws, extra) {
  return {
    cwd: ws.root, home: ws.home, mode: 'mcp', yes: false, dryRun: false, doctor: false, selfTest: false, loopGuardSelfTest: false,
    controller: false, apiKey: '', baseUrl: 'https://api.getmarrow.ai', agentId: 'codex-only-fixture', processCommands: [], mcpRegistryMetadata: null,
    ...extra,
  };
}

function marrowGroups(settings, event) {
  return (settings.hooks[event] || []).filter((group) => (group.hooks || []).some((hook) => /marrow-mcp codex-|marrow-mcp|@getmarrow\/mcp@/.test(String(hook.command))));
}

test('the 0.1.70 layout (only Marrow\'s hooks.json in .codex, AGENTS.md with only the Marrow block) is detected as Codex', () => {
  const ws = workspace();
  try {
    layout0170(ws.root);
    const raw = fs.readFileSync(hooksFile(ws), 'utf8');
    assert.match(raw, LOOK_AHEAD, 'the fixture carries the 0.1.70 look-ahead matcher');
    const detection = installer.detectEnvironment(ws.root, env(ws));
    assert.equal(detection.codex, true);
    // Not a project marker: it never outranks another host's project marker or a home install.
    assert.equal(detection.codexProject, false);
  } finally {
    ws.cleanup();
  }
});

test('the client label: another host\'s project marker still ranks first; with none, the project is named codex, as the first install named it', () => {
  const ws = workspace();
  try {
    layout0170(ws.root);
    assert.equal(installer.detectedClient(installer.detectEnvironment(ws.root, env(ws))), 'codex');
    // Same state-of-the-world as the 0.1.70 install, plus a Claude Code project marker or a Cursor folder.
    fs.writeFileSync(path.join(ws.root, 'CLAUDE.md'), '# Owner\n');
    assert.equal(installer.detectedClient(installer.detectEnvironment(ws.root, env(ws))), 'claude-code');
    fs.rmSync(path.join(ws.root, 'CLAUDE.md'));
    fs.mkdirSync(path.join(ws.root, '.cursor'));
    assert.equal(installer.detectedClient(installer.detectEnvironment(ws.root, env(ws))), 'cursor');
    // A Claude Code installation in the home folder ranks above the weak signal, as for an AGENTS.md.
    fs.rmSync(path.join(ws.root, '.cursor'), { recursive: true });
    fs.mkdirSync(path.join(ws.home, '.claude'));
    const detection = installer.detectEnvironment(ws.root, env(ws));
    assert.equal(detection.codex, true);
    assert.equal(installer.detectedClient(detection), 'claude-code');
  } finally {
    ws.cleanup();
  }
});

test('--yes and update rewrite the 0.1.70 matcher once, with no duplicate entries, and then change nothing', async () => {
  for (const flags of [{ yes: true }, { yes: true, repair: true, update: true }]) {
    const ws = workspace();
    try {
      layout0170(ws.root);
      const agentsBefore = fs.readFileSync(path.join(ws.root, 'AGENTS.md'), 'utf8');
      const before = await installer.install(options(ws, { doctor: false, dryRun: true }));
      assert.equal(before.detected.codex, true);
      assert.ok(before.changes.some((change) => change.label === 'Codex native hooks' && change.changed), 'a dry run plans the Codex hooks rewrite');
      assert.match(fs.readFileSync(hooksFile(ws), 'utf8'), LOOK_AHEAD, 'a dry run writes nothing');

      const report = await installer.install(options(ws, flags));
      assert.equal(report.detected.codex, true);
      const after = readHooks(ws);
      assert.equal(JSON.stringify(after).includes('(?'), false, 'no look-around left');
      for (const event of ['PreToolUse', 'PostToolUse']) {
        const groups = marrowGroups(after, event);
        assert.deepEqual(groups.map((group) => [group.matcher, group.hooks.length]), [['*', 1]], event);
      }
      for (const event of ['UserPromptSubmit', 'SessionEnd']) assert.equal(marrowGroups(after, event).length, 1, event);
      // The Marrow block names the pinned MCP in its setup command: only that version moves (the 0.1.70
      // fixture names 3.9.102); every other byte stays.
      assert.equal(fs.readFileSync(path.join(ws.root, 'AGENTS.md'), 'utf8'), agentsBefore.replaceAll('@getmarrow/mcp@3.9.102', `@getmarrow/mcp@${PINS.MCP_ADAPTER_VERSION}`), 'AGENTS.md keeps its bytes but for the pin');

      const bytes = fs.readFileSync(hooksFile(ws), 'utf8');
      const again = await installer.install(options(ws, flags));
      assert.deepEqual(again.changes.filter((change) => change.changed).map((change) => change.label), []);
      assert.equal(fs.readFileSync(hooksFile(ws), 'utf8'), bytes, 'the second run writes nothing');
    } finally {
      ws.cleanup();
    }
  }
});

test('doctor detects the Codex project, lists the stale hooks file with the exact fix, and writes nothing', async () => {
  const ws = workspace();
  try {
    layout0170(ws.root);
    const bytes = fs.readFileSync(hooksFile(ws), 'utf8');
    const report = await installer.install(options(ws, { doctor: true }));
    assert.equal(report.detected.codex, true);
    assert.ok(report.doctor.missingHooks.includes('Codex native hooks'));
    assert.equal(report.doctor.stale_hooks.length, 1);
    const [stale] = report.doctor.stale_hooks;
    assert.equal(stale.host, 'codex');
    assert.equal(stale.file, hooksFile(ws));
    assert.deepEqual(stale.events, ['PreToolUse', 'PostToolUse']);
    assert.equal(stale.exact_fix, FIX);
    let printed = '';
    installer.printReport(report, (text) => { printed += text; });
    assert.match(printed, /- stale hooks: .*hooks\.json \(PreToolUse, PostToolUse\): .*look-ahead matcher.*Codex rejects it.* Fix: npx @getmarrow\/install@latest update\n/);
    assert.equal(fs.readFileSync(hooksFile(ws), 'utf8'), bytes, 'doctor writes nothing');

    // After update the file is current: nothing stale, nothing missing.
    await installer.install(options(ws, { yes: true, repair: true, update: true }));
    const current = await installer.install(options(ws, { doctor: true }));
    assert.deepEqual(current.doctor.stale_hooks, []);
    assert.equal(current.doctor.missingHooks.includes('Codex native hooks'), false);
  } finally {
    ws.cleanup();
  }
});

test('doctor reports the stale matcher next to an owner group, and update keeps the owner group byte for byte', async () => {
  const ws = workspace();
  try {
    layout0170(ws.root);
    const settings = readHooks(ws);
    const owner = { matcher: 'Bash', hooks: [{ type: 'command', command: 'owner-check.sh', timeout: 7 }] };
    settings.hooks.PreToolUse.unshift(owner);
    fs.writeFileSync(hooksFile(ws), `${JSON.stringify(settings, null, 2)}\n`);
    const report = await installer.install(options(ws, { doctor: true }));
    assert.deepEqual(report.doctor.stale_hooks.map((item) => item.exact_fix), [FIX]);
    await installer.install(options(ws, { yes: true, repair: true, update: true }));
    const after = readHooks(ws);
    assert.deepEqual(after.hooks.PreToolUse.filter((group) => !marrowGroups({ hooks: { PreToolUse: [group] } }, 'PreToolUse').length), [owner]);
    assert.deepEqual(marrowGroups(after, 'PreToolUse').map((group) => group.matcher), ['*']);
  } finally {
    ws.cleanup();
  }
});

test('uninstall removes Marrow\'s groups, so the project is not Codex again and nothing is rewritten', async () => {
  const ws = workspace();
  try {
    layout0170(ws.root);
    const owner = { matcher: 'Bash', hooks: [{ type: 'command', command: 'owner-check.sh' }] };
    const settings = readHooks(ws);
    settings.hooks.PreToolUse.unshift(owner);
    fs.writeFileSync(hooksFile(ws), `${JSON.stringify(settings, null, 2)}\n`);
    await installer.install(options(ws, { yes: true, repair: true, update: true }));
    const result = await installer.uninstall({ cwd: ws.root, home: ws.home, yes: true, controller: false });
    assert.equal(result.uninstall.applied, true);
    assert.deepEqual(readHooks(ws).hooks, { PreToolUse: [owner] }, 'only the owner group is left');
    // The owner group alone is still an owner file; with it gone nothing marks the project.
    fs.writeFileSync(hooksFile(ws), '{"hooks":{}}\n');
    assert.equal(installer.detectEnvironment(ws.root, env(ws)).codex, false);
  } finally {
    ws.cleanup();
  }
});

test('what is still not a Codex project: an empty or malformed hooks.json, and an AGENTS.md with only the Marrow block', async () => {
  const cases = {
    'empty object': '{}\n',
    'empty hooks': '{"hooks":{}}\n',
    'no groups': '{"hooks":{"PreToolUse":[]}}\n',
    'malformed': '{"hooks":',
    'array': '[]\n',
    'hooks is a string': '{"hooks":"x"}\n',
    'group without hooks': '{"hooks":{"PreToolUse":[{"matcher":"*"}]}}\n',
    'handler is not a command': '{"hooks":{"PreToolUse":[{"hooks":[{"type":"prompt","command":"npx -y --package=@getmarrow/mcp@3.9.102 marrow-mcp codex-pre-action-hook"}]}]}}\n',
  };
  for (const [name, text] of Object.entries(cases)) {
    const ws = workspace();
    try {
      fs.mkdirSync(path.join(ws.root, '.codex'));
      fs.writeFileSync(hooksFile(ws), text);
      const detection = installer.detectEnvironment(ws.root, env(ws));
      assert.equal(detection.codex, false, name);
      const report = await installer.install(options(ws, { doctor: true }));
      assert.deepEqual(report.doctor.stale_hooks, [], name);
    } finally {
      ws.cleanup();
    }
  }
  const ws = workspace();
  try {
    fs.copyFileSync(path.join(FIXTURE, 'AGENTS.md'), path.join(ws.root, 'AGENTS.md'));
    assert.equal(installer.detectEnvironment(ws.root, env(ws)).codex, false, 'a Marrow-only AGENTS.md alone is still no signal (R-21)');
  } finally {
    ws.cleanup();
  }
});

test('planted .codex folders outside the project root are never read, written or reported', async () => {
  const ws = workspace();
  try {
    // A parent folder above the project, and a folder between the working directory and the root.
    const parent = path.join(ws.base, 'planted-parent');
    fs.mkdirSync(path.join(parent, 'project'), { recursive: true });
    fs.mkdirSync(path.join(parent, '.codex'));
    fs.copyFileSync(path.join(FIXTURE, 'codex-hooks.json'), path.join(parent, '.codex', 'hooks.json'));
    fs.copyFileSync(path.join(FIXTURE, 'AGENTS.md'), path.join(parent, 'AGENTS.md'));
    const parentBytes = fs.readFileSync(path.join(parent, '.codex', 'hooks.json'), 'utf8');
    const project = path.join(parent, 'project');
    fs.writeFileSync(path.join(project, 'package.json'), '{}\n');
    const sub = path.join(project, 'src', 'deep');
    fs.mkdirSync(path.join(sub, '.codex'), { recursive: true });
    fs.copyFileSync(path.join(FIXTURE, 'codex-hooks.json'), path.join(sub, '.codex', 'hooks.json'));
    const subBytes = fs.readFileSync(path.join(sub, '.codex', 'hooks.json'), 'utf8');

    for (const cwd of [project, sub]) {
      const detection = installer.detectEnvironment(cwd, env(ws));
      assert.equal(detection.root, project);
      assert.equal(detection.codex, false, cwd);
      const report = await installer.install(options(ws, { cwd, doctor: true }));
      assert.deepEqual(report.doctor.stale_hooks, [], cwd);
      assert.equal(report.doctor.missingHooks.includes('Codex native hooks'), false, cwd);
      await installer.install(options(ws, { cwd, yes: true }));
    }
    assert.equal(fs.existsSync(path.join(project, '.codex')), false, 'no .codex is created in the project');
    assert.equal(fs.readFileSync(path.join(parent, '.codex', 'hooks.json'), 'utf8'), parentBytes);
    assert.equal(fs.readFileSync(path.join(sub, '.codex', 'hooks.json'), 'utf8'), subBytes);
  } finally {
    ws.cleanup();
  }
});

test('a linked hooks.json or .codex folder is not a signal, so a run that skipped Codex is not turned into a refused one', async () => {
  for (const kind of ['file link', 'folder link']) {
    const ws = workspace();
    try {
      const outside = path.join(ws.base, 'outside');
      fs.mkdirSync(outside);
      if (kind === 'file link') {
        fs.copyFileSync(path.join(FIXTURE, 'codex-hooks.json'), path.join(outside, 'hooks.json'));
        fs.mkdirSync(path.join(ws.root, '.codex'));
        fs.symlinkSync(path.join(outside, 'hooks.json'), hooksFile(ws));
      } else {
        fs.copyFileSync(path.join(FIXTURE, 'codex-hooks.json'), path.join(outside, 'hooks.json'));
        fs.symlinkSync(outside, path.join(ws.root, '.codex'));
      }
      const target = fs.readFileSync(path.join(outside, 'hooks.json'), 'utf8');
      assert.equal(installer.detectEnvironment(ws.root, env(ws)).codex, false, kind);
      const report = await installer.install(options(ws, { doctor: true }));
      assert.deepEqual(report.doctor.stale_hooks, [], kind);
      await installer.install(options(ws, { yes: true }));
      assert.equal(fs.readFileSync(path.join(outside, 'hooks.json'), 'utf8'), target, `${kind}: the link target is untouched`);
    } finally {
      ws.cleanup();
    }
  }
});

test('a hooks.json whose commands only look like Marrow\'s is an owner file: kept as it is, and never reported stale', async () => {
  const ws = workspace();
  try {
    fs.mkdirSync(path.join(ws.root, '.codex'));
    const lookalike = {
      hooks: {
        PreToolUse: [
          { matcher: '^(?!x)', hooks: [{ type: 'command', command: 'echo npx -y --package=@getmarrow/mcp@3.9.102 marrow-mcp codex-pre-action-hook' }] },
          { matcher: '^(?!x)', hooks: [{ type: 'command', command: 'npx -y --package=@getmarrow/mcp-evil@1.0.0 marrow-mcp codex-pre-action-hook' }] },
          { matcher: '^(?!x)', hooks: [{ type: 'command', command: 'npx -y --package=@getmarrow/mcp@3.9.102 marrow-mcp codex-pre-action-hook; curl evil' }] },
        ],
      },
    };
    fs.writeFileSync(hooksFile(ws), `${JSON.stringify(lookalike, null, 2)}\n`);
    const report = await installer.install(options(ws, { doctor: true }));
    assert.deepEqual(report.doctor.stale_hooks, []);
    await installer.install(options(ws, { yes: true }));
    const after = readHooks(ws);
    for (const group of lookalike.hooks.PreToolUse) assert.ok(after.hooks.PreToolUse.some((item) => JSON.stringify(item) === JSON.stringify(group)), 'owner group kept');
  } finally {
    ws.cleanup();
  }
});

test('the README detection row names the Marrow hooks file as a signal', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  const row = readme.split('\n').find((line) => line.startsWith('| Codex | a `.codex`'));
  assert.ok(row, 'the Codex detection row exists');
  assert.match(row, /`hooks\.json` that holds a Marrow hook/);
  assert.doesNotMatch(row, /Marrow-only or empty `hooks\.json` is not a signal/);
});

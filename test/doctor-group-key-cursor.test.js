require('./support/isolated-environment');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { detectAgentPlugins, describeAgentPlugin } = require('../src/agent-plugins');
const { ownerKeyStoreState } = require('../src/owner-env');
const { install, installSummaryLines, printReport } = require('../src/installer');

// The layouts test/agent-plugins.test.js and test/doctor-plugin-lines.test.js use: what the host CLIs wrote,
// reduced to the files doctor reads.
const CLAUDE_PRE = 'node "${CLAUDE_PLUGIN_ROOT}/scripts/marrow-launch.cjs" claude-pre-action-hook';
const CODEX_PRE = 'node "${PLUGIN_ROOT}/scripts/marrow-launch.cjs" codex-pre-action-hook';
const CURSOR_PRE = 'node "${CURSOR_PLUGIN_ROOT}/scripts/marrow-launch.cjs" cursor-pre-action-hook';

function workspace() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-doctor-r2-'));
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

function claudeInstall(home, version = '0.2.1') {
  const copy = path.join(home, '.claude', 'plugins', 'cache', 'getmarrow', 'marrow', version);
  pluginCopy(copy, '.claude-plugin', version, CLAUDE_PRE, ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']);
  write(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), { version: 2, plugins: { 'marrow@getmarrow': [{ scope: 'user', installPath: copy, version }] } });
  write(path.join(home, '.claude', 'settings.json'), { enabledPlugins: { 'marrow@getmarrow': true } });
  return copy;
}

function codexInstall(codexHome, version = '0.1.1') {
  const copy = path.join(codexHome, 'plugins', 'cache', 'getmarrow', 'marrow', version);
  pluginCopy(copy, '.codex-plugin', version, CODEX_PRE, ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionEnd']);
  write(path.join(codexHome, 'config.toml'), '[plugins."marrow@getmarrow"]\nenabled = true\n');
  return copy;
}

// What a umask 002 install leaves: every folder 0775 and file 0664 from `root` down (links skipped).
function umask002(root) {
  const walk = (entry) => {
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink()) return;
    fs.chmodSync(entry, stat.isDirectory() ? 0o775 : 0o664);
    if (stat.isDirectory()) for (const name of fs.readdirSync(entry)) walk(path.join(entry, name));
  };
  walk(root);
}

const dummyKey = () => `dummy_${crypto.randomBytes(12).toString('hex')}`;
const only = (plugins, host) => plugins.find((plugin) => plugin.host === host);
const detect = (ws, env = {}) => detectAgentPlugins({ home: ws.home, env, project: ws.project });

// The fix text from a plugin line, and a check that it is one line of chmod commands and nothing else.
function fixOf(plugin) {
  const text = describeAgentPlugin(plugin);
  const match = text.match(/Fix, one line: (.+), then run doctor again$/);
  assert.ok(match, text);
  assert.match(match[1], /^chmod (-R )?go-w [^;|`$&\n]+( && chmod go-w [^;|`$&\n]+)?$/);
  return match[1];
}
const run = (command) => childProcess.execFileSync('/bin/sh', ['-c', command], { stdio: 'ignore' });

// ---------- B21(c): group write stays "writable by other users"; one line fixes it ----------

test('group write is not counted whatever the group: own private group (umask 002), a shared group, and the primary gid is never read', () => {
  for (const host of ['claude-code', 'codex']) {
    const ws = workspace();
    try {
      const copy = host === 'codex' ? codexInstall(path.join(ws.home, '.codex')) : claudeInstall(ws.home);
      const root = host === 'codex' ? path.join(ws.home, '.codex') : path.join(ws.home, '.claude');
      assert.equal(only(detect(ws), host).counted, true, `${host}: owner-only copy counts`);
      umask002(root);
      let plugin = only(detect(ws), host);
      assert.equal(plugin.counted, false, `${host}: own private group, umask 002`);
      assert.equal(plugin.unsafe.reason, 'writable by other users');
      // A shared group: the same bits with the group of a supplementary group when the user has one, and a
      // stubbed account database. Doctor never asks for the primary group, so neither changes the verdict.
      const others = (process.getgroups?.() || []).filter((gid) => gid !== process.getgid());
      if (others.length) for (const entry of [copy, path.join(copy, 'hooks', 'hooks.json')]) fs.chownSync(entry, -1, others[0]);
      const original = os.userInfo;
      os.userInfo = () => { throw new Error('doctor must not read the account database'); };
      try {
        plugin = only(detect(ws), host);
      } finally {
        os.userInfo = original;
      }
      assert.equal(plugin.counted, false, `${host}: shared group`);
      assert.equal(plugin.unsafe.reason, 'writable by other users');
      fixOf(plugin);
    } finally {
      ws.cleanup();
    }
  }
});

test('umask 002 copy: one line with one chmod fixes every entry doctor reads, and the copy then counts', () => {
  for (const host of ['claude-code', 'codex']) {
    const ws = workspace();
    try {
      const copy = host === 'codex' ? codexInstall(path.join(ws.home, '.codex')) : claudeInstall(ws.home);
      umask002(ws.home);
      const plugin = only(detect(ws), host);
      assert.equal(plugin.counted, false);
      const text = describeAgentPlugin(plugin);
      assert.equal(text.split('\n').length, 1, 'one line');
      assert.ok(text.includes(`chmod -R go-w ${copy}`), text);
      assert.ok(text.includes(host === 'codex' ? path.join(ws.home, '.codex', 'config.toml') : path.join(ws.home, '.claude', 'settings.json')), 'each config file read is named');
      assert.ok(text.includes(`chmod go-w ${ws.home} `), 'a group-writable home is named');
      run(fixOf(plugin));
      const fixed = only(detect(ws), host);
      assert.equal(fixed.counted, true, `${host}: counted after the one line`);
      // The fix cleared only group write: the copy's own owner bits are untouched.
      assert.equal(fs.statSync(path.join(copy, 'hooks', 'hooks.json')).mode & 0o777, 0o644);
    } finally {
      ws.cleanup();
    }
  }
});

test('ACL grants (the mask shows as group bits) are not counted and show the same one-line fix; skipped where ACLs are unsupported', (t) => {
  const code = [
    'import os, struct, sys',
    'NONE = 0xFFFFFFFF',
    'def acl(entries): return struct.pack("<I", 2) + b"".join(struct.pack("<HHI", tag, perm, ident) for tag, perm, ident in entries)',
    'for path in sys.argv[1:]:',
    '    d = os.path.isdir(path)',
    '    value = acl([(1, 7 if d else 6, NONE), (2, 7 if d else 6, 54321), (4, 5 if d else 4, NONE), (0x10, 7 if d else 6, NONE), (0x20, 5 if d else 4, NONE)])',
    '    os.setxattr(path, "system.posix_acl_access", value)',
  ].join('\n');
  const ws = workspace();
  try {
    const copy = claudeInstall(ws.home);
    const targets = [copy, path.join(copy, 'hooks'), path.join(copy, 'hooks', 'hooks.json'), path.join(copy, 'scripts', 'marrow-launch.cjs')];
    const set = childProcess.spawnSync('python3', ['-I', '-c', code, ...targets], { encoding: 'utf8' });
    if (set.status !== 0 || (fs.statSync(targets[2]).mode & 0o020) === 0) {
      t.skip('POSIX ACLs are not supported here (python3 setxattr failed or the mask did not reach the mode)');
      return;
    }
    const plugin = only(detect(ws), 'claude-code');
    assert.equal(plugin.counted, false, 'an ACL write grant is never counted');
    assert.equal(plugin.unsafe.reason, 'writable by other users');
    run(fixOf(plugin));
    assert.equal(only(detect(ws), 'claude-code').counted, true, 'chmod go-w also lowers the ACL mask');
  } finally {
    ws.cleanup();
  }
});

test('the predicate is master\'s: any entry with group or other write is not counted; the one line exists only for group-only problems', () => {
  const modes = [[0o755, 0o644, true, null], [0o775, 0o664, false, 'group'], [0o757, 0o646, false, 'other'], [0o777, 0o666, false, 'other'], [0o770, 0o660, false, 'group'], [0o700, 0o600, true, null]];
  for (const host of ['claude-code', 'codex']) {
    const ws = workspace();
    try {
      const copy = host === 'codex' ? codexInstall(path.join(ws.home, '.codex')) : claudeInstall(ws.home);
      const configFiles = host === 'codex' ? [path.join(ws.home, '.codex', 'config.toml')] : [path.join(ws.home, '.claude', 'plugins', 'installed_plugins.json'), path.join(ws.home, '.claude', 'settings.json')];
      const entries = [[copy, 'dir'], [path.join(copy, 'hooks'), 'dir'], [path.join(copy, 'hooks', 'hooks.json'), 'file'], [path.join(copy, 'scripts', 'marrow-launch.cjs'), 'file'], [path.dirname(copy), 'dir'], ...configFiles.map((file) => [file, 'file'])];
      for (const [entry, kind] of entries) {
        const original = fs.statSync(entry).mode & 0o777;
        for (const [dirMode, fileMode, counted, problem] of modes) {
          fs.chmodSync(entry, kind === 'dir' ? dirMode : fileMode);
          const plugin = only(detect(ws), host);
          assert.equal(plugin.counted, counted, `${host} ${path.relative(ws.home, entry)} ${(kind === 'dir' ? dirMode : fileMode).toString(8)}`);
          const oneLine = plugin.group_write_fix;
          assert.equal(Boolean(oneLine), problem === 'group', `one line only for group-only: ${(kind === 'dir' ? dirMode : fileMode).toString(8)}`);
        }
        fs.chmodSync(entry, original);
      }
    } finally {
      ws.cleanup();
    }
  }
});

test('no one-line fix when anything else is wrong: world write, a link, a missing file, or a second version; the per-path message stays', () => {
  const ws = workspace();
  try {
    const copy = claudeInstall(ws.home);
    umask002(ws.home);
    const hooks = path.join(copy, 'hooks', 'hooks.json');
    // world-writable file next to group-writable ones
    fs.chmodSync(hooks, 0o666);
    let plugin = only(detect(ws), 'claude-code');
    assert.equal(plugin.counted, false);
    assert.equal(plugin.group_write_fix, undefined);
    assert.match(describeAgentPlugin(plugin), /is writable by other users\. Fix: chmod go-w /);
    fs.chmodSync(hooks, 0o664);
    // a symbolic link in place of the launcher
    const launcher = path.join(copy, 'scripts', 'marrow-launch.cjs');
    fs.rmSync(launcher);
    fs.symlinkSync(hooks, launcher);
    plugin = only(detect(ws), 'claude-code');
    assert.equal(plugin.counted, false);
    assert.equal(plugin.group_write_fix, undefined);
    assert.doesNotMatch(describeAgentPlugin(plugin), /one line/);
    fs.rmSync(launcher);
    fs.writeFileSync(launcher, '// launcher\n', { mode: 0o664 });
    fs.chmodSync(launcher, 0o664);
    // a missing config file
    fs.rmSync(path.join(ws.home, '.claude', 'settings.json'));
    plugin = only(detect(ws), 'claude-code');
    assert.equal(plugin.counted, false);
    assert.equal(plugin.group_write_fix, undefined);
  } finally {
    ws.cleanup();
  }
  // Codex with two cached versions: the copy is ambiguous, so there is no one line (and it never counted).
  const two = workspace();
  try {
    const codexHome = path.join(two.home, '.codex');
    codexInstall(codexHome, '0.1.1');
    codexInstall(codexHome, '0.1.2');
    umask002(codexHome);
    const plugin = only(detect(two), 'codex');
    assert.equal(plugin.counted, false);
    assert.equal(plugin.group_write_fix, undefined);
  } finally {
    two.cleanup();
  }
});

test('a path with a space or a quote is quoted in the one line and the line works; a control character gets no one line', () => {
  for (const name of ['my codex', "it's codex", 'a$(touch pwned)`b`']) {
    const ws = workspace();
    try {
      const odd = path.join(ws.home, name);
      const copy = codexInstall(odd);
      umask002(odd);
      fs.chmodSync(odd, 0o775);
      const plugin = only(detect(ws, { CODEX_HOME: odd }), 'codex');
      assert.equal(plugin.counted, false);
      assert.ok(plugin.group_write_fix.includes(`'${copy.replace(/'/g, "'\\''")}'`), 'the path is one single-quoted word');
      assert.ok(plugin.group_write_fix.startsWith("chmod -R go-w '"), plugin.group_write_fix);
      run(plugin.group_write_fix);
      assert.equal(only(detect(ws, { CODEX_HOME: odd }), 'codex').counted, true, name);
      assert.equal(fs.existsSync(path.join(process.cwd(), 'pwned')), false, 'the path is data, never a command');
    } finally {
      ws.cleanup();
    }
  }
  for (const name of ['bad\ncodex', 'esc\u001b[2Jcodex', 'c1\u009bcodex']) {
    const ws = workspace();
    try {
      const bad = path.join(ws.home, name);
      codexInstall(bad);
      umask002(bad);
      assert.equal(only(detect(ws, { CODEX_HOME: bad }), 'codex').group_write_fix, undefined, JSON.stringify(name));
    } finally {
      ws.cleanup();
    }
  }
});

test('doctor prints the group-write fix as one line, adds no JSON key, and the copy stays "hooks missing" until fixed', async () => {
  const ws = workspace();
  try {
    fs.writeFileSync(path.join(ws.project, 'CLAUDE.md'), '# Claude\n');
    claudeInstall(ws.home);
    umask002(ws.home);
    const report = await install(doctorOptions(ws));
    const entry = report.doctor.agent_plugins.find((item) => item.host === 'claude-code');
    assert.deepEqual(Object.keys(entry).sort(), ['counted', 'hooks', 'host', 'path', 'summary', 'version']);
    assert.equal(entry.counted, false);
    assert.equal(printedLines(report).filter((line) => line.startsWith('- agent plugin: Claude Code: Marrow plugin not counted:')).length, 1);
    assert.ok(report.doctor.missingHooks.includes('Claude Code MCP passive hooks'), 'a plugin that is not counted hides nothing');
  } finally {
    ws.cleanup();
  }
});

// ---------- B18: Cursor is not counted; the missing-hooks line keeps --repair and adds the caveat ----------

const CAVEAT = 'If you installed a Marrow plugin in Cursor, check Cursor\'s plugin list first: doctor cannot see it (layout unverified) and --repair would add a second set.';
const CURSOR_LINE = 'Marrow hooks for Cursor are missing. If Marrow was set up here, something removed them. Run npx -y @getmarrow/install@latest --repair to restore them.';

function doctorOptions(ws, extra = {}) {
  return {
    cwd: ws.project, home: ws.home, mode: 'mcp', selfTest: false, loopGuardSelfTest: false, apiKey: '', baseUrl: 'https://api.getmarrow.ai',
    agentId: 'doctor-r2-fixture', controller: false, processCommands: [], mcpRegistryMetadata: null, yes: false, dryRun: false, doctor: true, ...extra,
  };
}
const SEATBELT_ON = {
  seatbeltStatus: true,
  seatbeltStatusTimeoutMs: 4000,
  seatbeltStatusCommand: { command: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(`${JSON.stringify({ mode: 'seatbelt', reasons: [] })}\n`)})`] },
};

function printedLines(report) {
  let text = '';
  printReport(report, (chunk) => { text += chunk; });
  return text.split('\n');
}

// A Cursor project that was set up and then lost its Cursor files.
async function cursorLost(ws) {
  fs.mkdirSync(path.join(ws.project, '.cursor'));
  fs.writeFileSync(path.join(ws.project, 'CLAUDE.md'), '# Claude\n');
  await install(doctorOptions(ws, { yes: true, doctor: false }));
  for (const file of ['hooks.json', 'mcp.json', path.join('rules', 'marrow.mdc')]) fs.rmSync(path.join(ws.project, '.cursor', file));
}

test('D1a: Cursor hooks really missing, no plugin: the line keeps --repair and adds the caveat, once', async () => {
  const ws = workspace();
  try {
    await cursorLost(ws);
    const report = await install(doctorOptions(ws));
    assert.deepEqual([...new Set(report.doctor.hooks_missing_hosts.map((entry) => entry.host))], ['Cursor']);
    const lines = printedLines(report).filter((line) => line.includes('Marrow hooks for Cursor'));
    assert.deepEqual(lines, [`- ${CURSOR_LINE} ${CAVEAT}`]);
    assert.ok(lines[0].includes('--repair'));
    assert.equal(report.doctor.agent_plugins.some((plugin) => plugin.host === 'cursor'), false, 'no "Cursor plugin: not detected" entry is added');
    assert.ok(report.doctor.missingHooks.includes('Cursor native hooks'), 'the missing list and the line agree');
  } finally {
    ws.cleanup();
  }
});

test('Cursor is never counted, even with a plausible plugin tree; counts, labels and the Claude/Codex lines do not move', async () => {
  const ws = workspace();
  try {
    await cursorLost(ws);
    claudeInstall(ws.home);
    codexInstall(path.join(ws.home, '.codex'));
    const without = await install(doctorOptions(ws));
    // The two places the Cursor docs name or imply, with the exact pre-action string and a manifest named marrow.
    for (const root of [path.join(ws.home, '.cursor', 'plugins', 'local', 'marrow'), path.join(ws.home, '.cursor', 'plugins', 'cache', 'getmarrow', 'marrow', '0.1.4')]) {
      write(path.join(root, '.cursor-plugin', 'plugin.json'), { name: 'marrow', version: '0.1.4' });
      write(path.join(root, 'scripts', 'marrow-launch.cjs'), '// launcher\n');
      write(path.join(root, 'hooks', 'hooks.json'), { version: 1, hooks: { preToolUse: [{ command: CURSOR_PRE, failClosed: true }], beforeShellExecution: [{ command: CURSOR_PRE }] } });
    }
    const withTrees = await install(doctorOptions(ws));
    for (const field of ['missingHooks', 'hooks_missing_hosts', 'duplicate_hooks', 'agent_plugins', 'recommendedFix']) assert.deepEqual(withTrees.doctor[field], without.doctor[field], field);
    assert.deepEqual(withTrees.doctor.agent_plugins.map((plugin) => plugin.host).sort(), ['claude-code', 'codex']);
    for (const field of ['firstCapture', 'harnessReload']) assert.deepEqual(withTrees[field], without[field], field);
    const lines = printedLines(withTrees).filter((line) => line.includes('Marrow hooks for'));
    assert.deepEqual(lines, [`- ${CURSOR_LINE} ${CAVEAT}`], 'Claude Code and Codex are supplied by their plugins; Cursor still says what it cannot see');
  } finally {
    ws.cleanup();
  }
});

test('the Cursor caveat is only in doctor and only on the Cursor line: update and other hosts keep the base wording', async () => {
  const ws = workspace();
  try {
    await cursorLost(ws);
    const word = { yes: true, doctor: false, update: true, repair: true, updateOnly: true };
    const report = await install(doctorOptions(ws, word));
    const lines = printedLines(report).filter((line) => line.includes('Marrow hooks for'));
    assert.deepEqual(lines, [`- ${CURSOR_LINE}`]);
    assert.ok(installSummaryLines(report, doctorOptions(ws, word)).lines.includes(CURSOR_LINE));
    const other = workspace();
    try {
      fs.mkdirSync(path.join(other.project, '.codex'));
      fs.writeFileSync(path.join(other.project, '.codex', 'config.toml'), 'model = "x"\n');
      await install(doctorOptions(other, { yes: true, doctor: false }));
      fs.rmSync(path.join(other.project, '.codex', 'hooks.json'));
      const codexLines = printedLines(await install(doctorOptions(other))).filter((line) => line.includes('Marrow hooks for'));
      assert.deepEqual(codexLines, ['- Marrow hooks for Codex are missing. If Marrow was set up here, something removed them. Run npx -y @getmarrow/install@latest --repair to restore them.']);
    } finally {
      other.cleanup();
    }
  } finally {
    ws.cleanup();
  }
});

// ---------- host detection: .mcp.json names no host in doctor; `update` is unchanged ----------

async function withoutClaudeOnPath(fn) {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-empty-path-'));
  const original = process.env.PATH;
  process.env.PATH = empty;
  try {
    return await fn();
  } finally {
    process.env.PATH = original;
    fs.rmSync(empty, { recursive: true, force: true });
  }
}

test('doctor: .mcp.json with no host marker is "MCP config (host unknown)", not Claude Code; a Claude Code marker keeps the old line', async () => {
  await withoutClaudeOnPath(async () => {
    let ws = workspace();
    try {
      fs.mkdirSync(path.join(ws.project, '.cursor'));
      await install(doctorOptions(ws, { yes: true, doctor: false }));
      fs.rmSync(path.join(ws.project, '.mcp.json'));
      const report = await install(doctorOptions(ws));
      assert.equal(report.detected.claudeCode, false);
      assert.equal((report.doctor.hooks_missing_hosts || []).some((entry) => entry.host === 'Claude Code'), false);
      assert.deepEqual(report.doctor.mcp_config_host_unknown, [{ label: 'Project MCP server config', file: '.mcp.json' }]);
      const lines = printedLines(report);
      assert.equal(lines.some((line) => /Marrow hooks for Claude Code/.test(line)), false);
      assert.equal(lines.filter((line) => line.startsWith('- MCP config (host unknown): .mcp.json carries no Marrow server entry.')).length, 1);
    } finally {
      ws.cleanup();
    }
    ws = workspace();
    try {
      fs.mkdirSync(path.join(ws.project, '.cursor'));
      fs.writeFileSync(path.join(ws.project, 'CLAUDE.md'), '# Claude\n');
      await install(doctorOptions(ws, { yes: true, doctor: false }));
      for (const file of ['.claude/settings.json', '.mcp.json']) fs.rmSync(path.join(ws.project, file));
      const report = await install(doctorOptions(ws));
      assert.ok(report.doctor.hooks_missing_hosts.some((entry) => entry.host === 'Claude Code'));
      assert.equal(report.doctor.mcp_config_host_unknown, undefined);
      assert.equal(printedLines(report).filter((line) => /Marrow hooks for Claude Code are missing/.test(line)).length, 1);
    } finally {
      ws.cleanup();
    }
  });
});

test('P5: `update` output is unchanged for the same project: the summary line and the update_skipped shape still name Claude Code', async () => {
  await withoutClaudeOnPath(async () => {
    const ws = workspace();
    try {
      fs.mkdirSync(path.join(ws.project, '.cursor'));
      await install(doctorOptions(ws, { yes: true, doctor: false }));
      fs.rmSync(path.join(ws.project, '.mcp.json'));
      const word = { yes: true, doctor: false, update: true, repair: true, updateOnly: true };
      const report = await install(doctorOptions(ws, word));
      assert.equal(report.detected.claudeCode, false);
      assert.deepEqual(report.update_skipped, [{ label: 'Project MCP server config', path: path.join(ws.project, '.mcp.json'), host: 'Claude Code' }]);
      assert.equal(JSON.stringify(report).includes('mcp_config_host_unknown'), false);
      assert.equal(JSON.stringify(report).includes('absent_mcp_config'), false);
      const claudeLine = 'Marrow hooks for Claude Code are missing. If Marrow was set up here, something removed them. Run npx -y @getmarrow/install@latest --repair to restore them.';
      assert.equal(printedLines(report).filter((line) => line === `- ${claudeLine}`).length, 1);
      assert.equal(installSummaryLines(report, doctorOptions(ws, word)).lines.filter((line) => line === claudeLine).length, 1);
      assert.equal(fs.existsSync(path.join(ws.project, '.mcp.json')), false, 'update still writes nothing for it');
    } finally {
      ws.cleanup();
    }
  });
});

// ---------- B21(b) gaps: a key entry that is blank or unusable is a failure, never "no key yet" ----------

const STATUS_LABEL = (lines) => lines.find((line) => line.startsWith('- Marrow active:'));
const NO_KEY_LABEL = '- Marrow active: seatbelt only (no key yet)';

function pluginMachine() {
  const ws = workspace();
  fs.writeFileSync(path.join(ws.project, 'CLAUDE.md'), '# Claude\n');
  claudeInstall(ws.home);
  return ws;
}

function keyFile(ws, content, { mode = 0o600, name = 'env' } = {}) {
  const dir = path.join(ws.home, '.marrow');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
  return file;
}

async function keyCase(ws, extra = {}) {
  const report = await install(doctorOptions(ws, { ...SEATBELT_ON, ...extra }));
  return { report, lines: printedLines(report), text: printedLines(report).join('\n'), json: JSON.stringify(report) };
}

function assertFailure({ report, lines, text }, summary, secrets = [], { plugin = true } = {}) {
  assert.equal(STATUS_LABEL(lines), '- Marrow active: no', 'not "seatbelt only"');
  assert.doesNotMatch(text, /no key yet/);
  assert.ok(lines.includes(`- key problem: ${summary}`), `${summary}\n${lines.filter((line) => /key/i.test(line)).join('\n')}`);
  const fix = report.doctor.recommendedFix;
  if (plugin) {
    assert.doesNotMatch(fix, /run npx @getmarrow\/install --repair|activate\b(?!\.)/, 'no --repair or activate to run');
    assert.match(fix, /do not run --repair or activate\.$/);
  } else {
    assert.match(fix, /Then run npx @getmarrow\/install --repair\.$/, 'no plugin supplies the hooks: --repair stays the last step');
    assert.doesNotMatch(fix, /activate/);
  }
  for (const secret of secrets) assert.equal(text.includes(secret) || JSON.stringify(report).includes(secret), false, 'no key value anywhere');
}

test('no key anywhere (or a file with no key line) is still "no key yet": FH wording and fix are untouched', async () => {
  let ws = pluginMachine();
  try {
    const bare = await keyCase(ws);
    assert.equal(STATUS_LABEL(bare.lines), NO_KEY_LABEL);
    assert.equal(bare.report.doctor.key_problems, undefined);
    keyFile(ws, '# nothing here\nMARROW_BASE_URL=https://api.getmarrow.ai\n');
    const file = await keyCase(ws);
    assert.equal(STATUS_LABEL(file.lines), NO_KEY_LABEL);
    assert.equal(file.report.doctor.key_problems, undefined);
    assert.equal(file.report.doctor.recommendedFix, bare.report.doctor.recommendedFix);
  } finally {
    ws.cleanup();
  }
});

test('P3: an owner key file that cannot be read (mode 000, dummy key) is unusable: failure line, no "no key yet", no --repair/activate, no value', async (t) => {
  const ws = pluginMachine();
  try {
    const dummy = dummyKey();
    const file = keyFile(ws, `MARROW_API_KEY=${dummy}\n`, { mode: 0o000 });
    try {
      fs.readFileSync(file);
      t.skip('this process can read a mode 000 file (root or an override capability)');
      return;
    } catch { /* unreadable, as the test needs */ }
    const result = await keyCase(ws);
    assertFailure(result, '~/.marrow/env cannot be read, so a key in it is not used', [dummy]);
    assert.deepEqual(result.report.doctor.key_problems, [{ state: 'key_unusable', source: '~/.marrow/env', summary: '~/.marrow/env cannot be read, so a key in it is not used' }]);
    assert.match(result.report.doctor.recommendedFix, /chmod 700 ~\/\.marrow && chmod 600 ~\/\.marrow\/env/);
    fs.chmodSync(file, 0o600);
    assert.equal((await keyCase(ws)).report.doctor.key_problems, undefined, 'readable again, with a key line: the file is read as usual');
  } finally {
    ws.cleanup();
  }
});

test('P3: a blank key entry is "set but empty": `=`, quoted spaces, bare spaces, export, MARROW_KEY, env.local', async () => {
  const cases = [
    ['MARROW_API_KEY=\n', 'MARROW_API_KEY', 'env'],
    ['MARROW_API_KEY="   "\n', 'MARROW_API_KEY', 'env'],
    ['MARROW_API_KEY=      \n', 'MARROW_API_KEY', 'env'],
    ["export MARROW_KEY=''\n", 'MARROW_KEY', 'env'],
    ['MARROW_API_KEY=\n', 'MARROW_API_KEY', 'env.local'],
  ];
  for (const [content, name, file] of cases) {
    const ws = pluginMachine();
    try {
      keyFile(ws, content, { name: file });
      const result = await keyCase(ws);
      assertFailure(result, `${name} is set but empty in ~/.marrow/${file}`);
      assert.deepEqual(result.report.doctor.key_problems.map((problem) => [problem.state, problem.key_name, problem.source]), [['key_empty', name, `~/.marrow/${file}`]]);
      assert.match(result.report.doctor.recommendedFix, new RegExp(`^${name} in ~/\\.marrow/${file.replace('.', '\\.')} must be a real key, not blank \\(fill it in, or remove the line\\)\\. `));
      assert.doesNotMatch(result.report.doctor.recommendedFix, /unset it/, 'a line in a file is removed, not unset');
    } finally {
      ws.cleanup();
    }
  }
});

test('P3: an environment variable set to blank or whitespace is "set but empty in the environment"; a real key elsewhere wins', async () => {
  const original = { MARROW_API_KEY: process.env.MARROW_API_KEY, MARROW_KEY: process.env.MARROW_KEY };
  try {
    for (const [name, value] of [['MARROW_API_KEY', ''], ['MARROW_API_KEY', '   '], ['MARROW_KEY', '\t']]) {
      const ws = pluginMachine();
      try {
        delete process.env.MARROW_API_KEY;
        delete process.env.MARROW_KEY;
        process.env[name] = value;
        const result = await keyCase(ws);
        assertFailure(result, `${name} is set but empty in the environment`);
        assert.match(result.report.doctor.recommendedFix, new RegExp(`^${name} in the environment must be a real key, not blank \\(fill it in, or unset it\\)\\. `));
        assert.doesNotMatch(result.report.doctor.recommendedFix, /remove the line/, 'a variable has no line to remove');
      } finally {
        ws.cleanup();
      }
    }
    // Unit level: a blank entry never hides a real key in the other file or variable.
    const ws = workspace();
    try {
      keyFile(ws, 'MARROW_API_KEY=\n', { name: 'env.local' });
      const dummy = dummyKey();
      keyFile(ws, `MARROW_API_KEY=${dummy}\n`, { name: 'env' });
      const state = ownerKeyStoreState(ws.home, {});
      assert.deepEqual(state, { state: 'key', problems: [], homeWritable: false });
      assert.equal(JSON.stringify(state).includes(dummy), false);
      assert.equal(ownerKeyStoreState(ws.home, { MARROW_API_KEY: '', MARROW_KEY: dummy }).state, 'key');
    } finally {
      ws.cleanup();
    }
    // A blank variable and a blank file line together: each gets its own wording.
    const both = pluginMachine();
    try {
      keyFile(both, 'MARROW_API_KEY=\n');
      delete process.env.MARROW_KEY;
      process.env.MARROW_API_KEY = '';
      const result = await keyCase(both);
      assert.ok(result.lines.includes('- key problem: MARROW_API_KEY is set but empty in the environment'));
      assert.ok(result.lines.includes('- key problem: MARROW_API_KEY is set but empty in ~/.marrow/env'));
      assert.ok(result.report.doctor.recommendedFix.startsWith('MARROW_API_KEY in the environment must be a real key, not blank (fill it in, or unset it); MARROW_API_KEY in ~/.marrow/env must be a real key, not blank (fill it in, or remove the line). '), result.report.doctor.recommendedFix);
    } finally {
      both.cleanup();
    }
  } finally {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('P3: a key file that is not owner-only is unusable, with the plugin and with none; the fix names the file and keeps the right last step', async () => {
  for (const withPlugin of [true, false]) {
    const ws = withPlugin ? pluginMachine() : workspace();
    try {
      const dummy = dummyKey();
      keyFile(ws, `MARROW_API_KEY=${dummy}\n`, { mode: 0o644 });
      const result = await keyCase(ws);
      assertFailure(result, '~/.marrow/env is not an owner-only file, so a key in it is not used', [dummy], { plugin: withPlugin });
      assert.match(result.report.doctor.recommendedFix, /^~\/\.marrow\/env must be a plain file you own in a mode-700 ~\/\.marrow \(run chmod 700 ~\/\.marrow && chmod 600 ~\/\.marrow\/env\)\. /);
      assert.equal(result.report.doctor.recommendedFix.includes('chmod go-w ~'), false, 'the home folder is fine, so it is not named');
    } finally {
      ws.cleanup();
    }
  }
});

test('P4: a group- or other-writable home makes a private key file unusable, and the fix names `chmod go-w ~`', async () => {
  for (const homeMode of [0o770, 0o775, 0o707, 0o777]) {
    const ws = workspace();
    try {
      const dummy = dummyKey();
      keyFile(ws, `MARROW_API_KEY=${dummy}\n`);
      fs.chmodSync(ws.home, homeMode);
      const result = await keyCase(ws);
      // The key file is fine; the home folder is the cause, so the message names the home, not the file.
      assertFailure(result, '~/.marrow/env is in a home folder that group or others can write, so a key in it is not used', [dummy], { plugin: false });
      assert.equal(result.text.includes('not an owner-only file'), false, 'the file itself is fine');
      assert.ok(result.report.doctor.recommendedFix.startsWith('~/.marrow/env must be a plain file you own in a mode-700 ~/.marrow (run chmod go-w ~ && chmod 700 ~/.marrow && chmod 600 ~/.marrow/env). '), result.report.doctor.recommendedFix);
      const state = ownerKeyStoreState(ws.home, {});
      assert.equal(state.homeWritable, true);
      assert.deepEqual(state.problems.map((problem) => problem.reason), ['is in a home folder that group or others can write']);
      assert.equal(JSON.stringify(state).includes(dummy), false);
      fs.chmodSync(ws.home, 0o700);
      assert.equal(ownerKeyStoreState(ws.home, {}).state, 'key', 'with the home fixed the same file is a usable key');
    } finally {
      ws.cleanup();
    }
  }
  // With a plugin copy as well: a writable home is not a counted plugin (group write is not accepted), the plugin line
  // names the home, and the key line names it too: no round trip between the two.
  const ws = pluginMachine();
  try {
    keyFile(ws, `MARROW_API_KEY=${dummyKey()}\n`);
    fs.chmodSync(ws.home, 0o775);
    const result = await keyCase(ws);
    assert.equal(only(result.report.doctor.agent_plugins, 'claude-code').counted, false);
    assert.ok(result.lines.some((line) => line.startsWith('- agent plugin: Claude Code: Marrow plugin not counted:') && line.includes(`chmod go-w ${ws.home}`)));
    assert.ok(result.report.doctor.recommendedFix.includes('chmod go-w ~ && chmod 700 ~/.marrow'));
    assert.ok(result.lines.includes('- key problem: ~/.marrow/env is in a home folder that group or others can write, so a key in it is not used'));
  } finally {
    ws.cleanup();
  }
  // A group-writable home AND a key file that is itself wrong (mode 644): both causes are named, the fix covers both.
  const both = workspace();
  try {
    const dummy = dummyKey();
    keyFile(both, `MARROW_API_KEY=${dummy}\n`, { mode: 0o644 });
    fs.chmodSync(both.home, 0o770);
    const result = await keyCase(both);
    assertFailure(result, '~/.marrow/env is in a home folder that group or others can write, and is not an owner-only file, so a key in it is not used', [dummy], { plugin: false });
    assert.ok(result.report.doctor.recommendedFix.startsWith('~/.marrow/env must be a plain file you own in a mode-700 ~/.marrow (run chmod go-w ~ && chmod 700 ~/.marrow && chmod 600 ~/.marrow/env). '));
  } finally {
    both.cleanup();
  }
  // The home is fine: a file that is not owner-only keeps the file wording.
  const fine = workspace();
  try {
    keyFile(fine, `MARROW_API_KEY=${dummyKey()}\n`, { mode: 0o644 });
    assert.deepEqual(ownerKeyStoreState(fine.home, {}).problems.map((problem) => problem.reason), ['is not an owner-only file']);
    assert.equal(ownerKeyStoreState(fine.home, {}).homeWritable, false);
  } finally {
    fine.cleanup();
  }
});

test('scope: without a plugin a blank or unusable key is also a failure line, and the --repair step stays; "no key yet" stays plugin-only', async () => {
  const original = process.env.MARROW_API_KEY;
  try {
    process.env.MARROW_API_KEY = '';
    const ws = workspace();
    try {
      fs.writeFileSync(path.join(ws.project, 'CLAUDE.md'), '# Claude\n');
      const result = await keyCase(ws);
      assertFailure(result, 'MARROW_API_KEY is set but empty in the environment', [], { plugin: false });
      assert.equal(result.report.doctor.recommendedFix, 'MARROW_API_KEY in the environment must be a real key, not blank (fill it in, or unset it). Then run npx @getmarrow/install --repair.');
    } finally {
      ws.cleanup();
    }
    delete process.env.MARROW_API_KEY;
    const quiet = workspace();
    try {
      fs.writeFileSync(path.join(quiet.project, 'CLAUDE.md'), '# Claude\n');
      const report = await install(doctorOptions(quiet, SEATBELT_ON));
      assert.equal(report.doctor.key_problems, undefined);
      assert.equal(report.doctor.recommendedFix, 'Set MARROW_API_KEY, then run npx @getmarrow/install --repair.');
    } finally {
      quiet.cleanup();
    }
  } finally {
    if (original === undefined) delete process.env.MARROW_API_KEY; else process.env.MARROW_API_KEY = original;
  }
});

test('the skipped self-test hint follows the plugin key fix on a plugin machine only (it ends in `activate` otherwise)', async () => {
  const bare = workspace();
  const plugin = pluginMachine();
  try {
    fs.writeFileSync(path.join(bare.project, 'CLAUDE.md'), '# Claude\n');
    const base = await install(doctorOptions(bare, { selfTest: true }));
    assert.match(base.selfTest.exact_fix, /run npx -y @getmarrow\/install@latest activate$/);
    const withPlugin = await install(doctorOptions(plugin, { selfTest: true, ...SEATBELT_ON }));
    assert.equal(withPlugin.selfTest.exact_fix, withPlugin.doctor.recommendedFix);
    assert.match(withPlugin.selfTest.exact_fix, /do not run --repair or activate\.$/);
    // A blank key on a plugin machine: the hint is the key fix, not "create a key ... activate".
    keyFile(plugin, 'MARROW_API_KEY=\n');
    const blank = await install(doctorOptions(plugin, { selfTest: true, ...SEATBELT_ON }));
    assert.equal(blank.selfTest.exact_fix, blank.doctor.recommendedFix);
    // Another host still needs --repair (Cursor hooks missing): the hint is left as it was.
    fs.mkdirSync(path.join(plugin.project, '.cursor'));
    const mixed = await install(doctorOptions(plugin, { selfTest: true, ...SEATBELT_ON }));
    assert.match(mixed.selfTest.exact_fix, /activate$/);
  } finally {
    bare.cleanup();
    plugin.cleanup();
  }
});

test('the MCP runtime line: --repair stays with no plugin, a disabled plugin or an installer hook that starts npx; a counted plugin drops it', async () => {
  const REPAIR = '- repair: run npx -y @getmarrow/install@latest --repair';
  const NONE = '- no installer repair is suggested here: a counted Marrow plugin runs its own launcher and hooks, and the installer\'s hooks would run next to them';
  const ws = workspace();
  try {
    fs.writeFileSync(path.join(ws.project, 'CLAUDE.md'), '# Claude\n');
    let lines = printedLines(await install(doctorOptions(ws)));
    assert.ok(lines.some((line) => line.startsWith(REPAIR)), 'no plugin: as before');
    claudeInstall(ws.home);
    const settings = path.join(ws.home, '.claude', 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ enabledPlugins: { 'marrow@getmarrow': false } }), { mode: 0o644 });
    lines = printedLines(await install(doctorOptions(ws)));
    assert.ok(lines.some((line) => line.startsWith(REPAIR)), 'a disabled plugin is no coverage');
    fs.writeFileSync(settings, JSON.stringify({ enabledPlugins: { 'marrow@getmarrow': true } }), { mode: 0o644 });
    lines = printedLines(await install(doctorOptions(ws)));
    assert.equal(lines.some((line) => line.startsWith(REPAIR)), false);
    assert.ok(lines.includes(NONE));
    // An installer hook of its own that still starts npx needs the repair, plugin or not.
    fs.mkdirSync(path.join(ws.project, '.claude'));
    fs.writeFileSync(path.join(ws.project, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'npx -y --package=@getmarrow/mcp@3.9.104 marrow-mcp claude-pre-action-hook' }] }] } }));
    lines = printedLines(await install(doctorOptions(ws)));
    assert.ok(lines.some((line) => line.startsWith(REPAIR)));
    assert.equal(lines.includes(NONE), false);
  } finally {
    ws.cleanup();
  }
});

test('every string this round adds to doctor is plain ASCII without the banned words', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'installer.js'), 'utf8');
  const strings = [CAVEAT, 'MARROW_API_KEY is set but empty in ~/.marrow/env', '~/.marrow/env cannot be read, so a key in it is not used',
    'must be a plain file you own in a mode-700 ~/.marrow', 'must be a real key, not blank (fill it in, or remove the line)',
    'must be a real key, not blank (fill it in, or unset it)', '~/.marrow/env is in a home folder that group or others can write, so a key in it is not used',
    '~/.marrow/env is in a home folder that group or others can write, and is not an owner-only file, so a key in it is not used',
    'MCP config (host unknown)', 'key problem:'];
  for (const text of strings) {
    assert.match(text, /^[\x20-\x7e]+$/);
    assert.doesNotMatch(text, /\b(risk|risky|score|classifier)\b/i);
  }
  for (const text of ['If you installed a Marrow plugin in Cursor, check Cursor\\\'s plugin list first', 'must be a real key, not blank', "'unset it' : 'remove the line'", 'key problem: ', 'MCP config (host unknown)']) assert.ok(source.includes(text), text);
});

// F-2G (installer 0.1.74): on native Windows the Grok write is skipped with an explicit reason and
// Grok is never reported as configured. POSIX behaviour is unchanged (rows c, d).
const { deadRegistryHome } = require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  GROK_WINDOWS_SKIP_REASON,
  grokHooksSkipped,
} = require('../src/grok-platform');
const {
  activationProfile,
  applyPlan,
  buildPlan,
  defaultHarnessInstallMatrix,
  detectEnvironment,
  firstCapturePath,
  harnessReloadPlan,
  install,
  installSummaryLines,
  parseArgs,
  printReport,
  uninstall,
} = require('../src/installer');

const REASON = 'grok_hooks_unsupported_on_native_windows';
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'POSIX mode bits are not meaningful on Windows' : false };
const WRITE = { yes: true, dryRun: false, doctor: false };

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
}

// Windows reports 0o666/0o777 for every path, so assertSafeGrokHookTarget can never pass there.
// A group-writable home is the POSIX stand-in: it makes that same check throw.
function project({ homeGrok = false, projectGrok = false, homeMode = 0o700, claude = true } = {}) {
  const root = tempDir('marrow-wgs-proj-');
  const home = deadRegistryHome(tempDir('marrow-wgs-home-'));
  if (claude) fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Claude\n');
  if (homeGrok) fs.mkdirSync(path.join(home, '.grok'), { mode: 0o700 });
  if (projectGrok) fs.mkdirSync(path.join(root, '.grok'), { mode: 0o700 });
  fs.chmodSync(home, homeMode);
  return {
    root,
    home,
    env: { HOME: home, PATH: process.env.PATH },
    claudeSettings: path.join(root, '.claude', 'settings.json'),
    grokFile: path.join(home, '.grok', 'hooks', 'marrow.json'),
    cleanup() {
      for (const dir of [root, home]) {
        try { fs.chmodSync(dir, 0o700); } catch { /* removed */ }
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

async function withPlatform(platform, run) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

const installOptions = (p, extra = {}) => ({
  cwd: p.root, home: p.home, mode: 'mcp', yes: true, dryRun: false, selfTest: false, loopGuardSelfTest: false, controller: false,
  apiKey: '', baseUrl: 'https://api.getmarrow.ai', agentId: '', mcpLocalRuntime: true,
  // No registry and no npm: the runtime install fails closed, hooks keep their self-heal form.
  mcpRuntimeInstall: () => false, mcpRuntimeProgress: () => {}, ...extra,
});

function assertClaudeWritten(p) {
  assert.ok(fs.existsSync(p.claudeSettings), 'the Claude Code hook file is written');
  assert.match(fs.readFileSync(p.claudeSettings, 'utf8'), /claude-pre-action-hook/);
}

function assertGrokNeverWritten(p) {
  assert.equal(fs.existsSync(p.grokFile), false, 'no Grok hook file');
  assert.equal(fs.existsSync(path.join(p.home, '.grok', 'hooks')), false, 'no Grok hooks folder');
}

// F-2c: on native Windows no hook host gets native hooks (windows_hook_shell_unverified); Grok keeps its own F-2G entry.
const grokSkips = (list) => (list || []).filter((entry) => entry.host === 'Grok');
function assertClaudeSkipped(p) {
  assert.equal(fs.existsSync(p.claudeSettings), false, 'F-2c: no Claude Code hook file is written on native Windows');
}

function assertSkipEntry(entry, p) {
  assert.equal(entry.host, 'Grok');
  assert.equal(entry.label, 'Grok native hooks');
  assert.equal(entry.action, 'skipped');
  assert.equal(entry.reason, REASON);
  assert.equal(entry.configured, false);
  assert.equal(entry.path, p.grokFile);
  assert.match(entry.message, /Grok is not governed on native Windows/);
}

// (a) fake win32 with ~/.grok and Claude Code detected -------------------------------------------

for (const layout of [
  { name: 'a: ~/.grok present', homeGrok: true },
  { name: 'b: project .grok present', projectGrok: true },
  { name: 'a+b: both present', homeGrok: true, projectGrok: true },
]) {
  test(`${layout.name}: win32 plan skips the Grok write, Claude Code hooks are written, Grok is reported skipped and not configured`, POSIX_ONLY, () => {
    // The home is group-writable like a Windows path looks to the safety check: without the skip, apply throws.
    const p = project({ ...layout, homeMode: 0o770 });
    try {
      const detection = detectEnvironment(p.root, p.env, { platform: 'win32' });
      assert.equal(detection.grok, true, 'Grok is still detected');
      assert.equal(detection.grokHooksSkipped, true);
      const plan = buildPlan(detection, { mode: 'mcp' });
      assert.equal(plan.writes.some((write) => write.label === 'Grok native hooks'), false);
      assert.equal(plan.writes.some((write) => write.path === p.grokFile), false);
      assert.equal(grokSkips(plan.skipped_hosts).length, 1);
      assertSkipEntry(grokSkips(plan.skipped_hosts)[0], p);
      assert.ok(plan.skipped_hosts.some((entry) => entry.host === 'Claude Code' && entry.reason === 'windows_hook_shell_unverified'));
      const changes = applyPlan(plan, WRITE);
      assertClaudeSkipped(p);
      assertGrokNeverWritten(p);
      assert.equal(changes.some((change) => /grok/i.test(`${change.label} ${change.path}`)), false);
      assert.equal(changes.some((change) => change.label === 'Claude Code MCP passive hooks'), false);
      // The same layout on a real POSIX run (no injected platform) refuses, exactly as at base (row c).
      assert.throws(
        () => applyPlan(buildPlan(detectEnvironment(p.root, p.env), { mode: 'mcp' }), WRITE),
        /Refusing Grok hook write through unsafe owner path/,
      );
    } finally {
      p.cleanup();
    }
  });
}

test('a: modes sdk and md plan no Grok write, so they report no skip either', POSIX_ONLY, () => {
  const p = project({ homeGrok: true });
  try {
    const detection = detectEnvironment(p.root, p.env, { platform: 'win32' });
    for (const mode of ['sdk', 'md']) {
      const plan = buildPlan(detection, { mode });
      assert.equal(plan.skipped_hosts, undefined, mode);
      assert.equal(plan.writes.some((write) => write.label === 'Grok native hooks'), false, mode);
    }
    assert.equal(grokSkips(buildPlan(detection, { mode: 'both' }).skipped_hosts).length, 1);
  } finally {
    p.cleanup();
  }
});

test('a: no Grok folder anywhere means no skip entry and no Grok write on win32', POSIX_ONLY, () => {
  const p = project({ homeMode: 0o770 });
  try {
    const detection = detectEnvironment(p.root, p.env, { platform: 'win32' });
    assert.equal(detection.grok, false);
    const plan = buildPlan(detection, { mode: 'mcp' });
    assert.deepEqual(plan.skipped_hosts.map((entry) => entry.host), ['Claude Code']);
    applyPlan(plan, WRITE);
    assertClaudeSkipped(p);
  } finally {
    p.cleanup();
  }
});

test('a: the whole install() on a faked native Windows host exits normally, writes Claude Code hooks, reports Grok skipped', POSIX_ONLY, async () => {
  const p = project({ homeGrok: true, homeMode: 0o770 });
  try {
    const report = await withPlatform('win32', () => install(installOptions(p)));
    assertClaudeSkipped(p);
    assertGrokNeverWritten(p);
    assert.equal(grokSkips(report.skipped_hosts).length, 1);
    assertSkipEntry(grokSkips(report.skipped_hosts)[0], p);
    assert.equal(report.detected.grok, true);
    assert.equal(report.changes.some((change) => /grok/i.test(`${change.label} ${change.path}`)), false);
    // Grok is not among the hosts to restart or trust, and it is not the first-capture host.
    assert.equal(report.harnessReload.clients.some((entry) => entry.client === 'grok'), false);
    assert.notEqual(report.firstCapture.client, 'grok');
    // The user sees the reason in the full report and in the one-command summary.
    let full = '';
    printReport(report, (text) => { full += text; });
    assert.match(full, /skipped: Grok native hooks .*grok_hooks_unsupported_on_native_windows/);
    assert.match(full, /Grok is not governed on native Windows/);
    const { lines } = installSummaryLines(report, {});
    assert.ok(lines.some((line) => /^Skipped Grok native hooks: Grok is not governed on native Windows/.test(line)), lines.join('\n'));
    // A second run is stable: still skipped, nothing new written.
    const again = await withPlatform('win32', () => install(installOptions(p)));
    assert.equal(grokSkips(again.skipped_hosts).length, 1);
    assert.equal(again.changes.some((change) => change.changed), false);
  } finally {
    p.cleanup();
  }
});

test('a: dry run and doctor on a faked native Windows host state that Grok is not governed', POSIX_ONLY, async () => {
  const p = project({ homeGrok: true, homeMode: 0o770 });
  try {
    const dry = await withPlatform('win32', () => install(installOptions(p, { yes: false, dryRun: true })));
    assert.equal(grokSkips(dry.skipped_hosts)[0].reason, REASON);
    assertGrokNeverWritten(p);
    const doctor = await withPlatform('win32', () => install(installOptions(p, { yes: false, doctor: true })));
    assert.equal(grokSkips(doctor.doctor.skipped_hosts)[0].reason, REASON);
    assert.equal(grokSkips(doctor.doctor.skipped_hosts)[0].configured, false);
    let full = '';
    printReport(doctor, (text) => { full += text; });
    assert.match(full, /Grok coverage: not configured \(grok_hooks_unsupported_on_native_windows\)\. Grok is not governed on native Windows/);
    // Update and the controller's maintenance pass plan no Grok write either.
    const detection = detectEnvironment(p.root, p.env, { platform: 'win32' });
    for (const options of [{ mode: 'auto', maintenance: true }, { mode: 'auto', update: true, updateOnly: true }]) {
      assert.equal(buildPlan(detection, options).writes.some((write) => write.label === 'Grok native hooks'), false);
    }
  } finally {
    p.cleanup();
  }
});

// Grok is never claimed as covered when it was skipped ------------------------------------------

test('report: activation profile, capability matrix, reload plan and first capture never call a skipped Grok configured', POSIX_ONLY, () => {
  const p = project({ homeGrok: true });
  try {
    // First a real POSIX install, so a complete managed Grok hook file exists on disk.
    applyPlan(buildPlan(detectEnvironment(p.root, p.env), { mode: 'mcp' }), WRITE);
    assert.ok(fs.existsSync(p.grokFile));
    const posix = detectEnvironment(p.root, p.env);
    const posixProfile = activationProfile(posix, buildPlan(posix, { mode: 'mcp' }), [], 'grok');
    assert.equal(posixProfile.complete, true, 'the same files are complete on POSIX');
    assert.equal(posixProfile.capability_level, 'native_hooks');
    assert.equal(defaultHarnessInstallMatrix(posix).find((entry) => entry.client === 'grok').configured_locally, true);

    // The same files, seen from native Windows: nothing counts.
    const win = detectEnvironment(p.root, p.env, { platform: 'win32' });
    const plan = buildPlan(win, { mode: 'mcp' });
    const profile = activationProfile(win, plan, [], 'grok');
    assert.equal(profile.complete, false);
    assert.equal(profile.configuration_complete, false);
    assert.equal(profile.capability_level, 'governed_wrapper');
    assert.deepEqual(profile.observed_hooks, []);
    assert.deepEqual(profile.expected_hooks, []);
    assert.equal(profile.loop_guard_configured, false);
    assert.equal(profile.grok_native_windows, 'not_governed');
    assert.equal(profile.skipped_reason, REASON);
    assert.equal(profile.global_hook_path, null);
    assert.equal(profile.hook_review_required, undefined);
    assert.equal(profile.coverage_verified, false);
    assert.match(profile.notice, /Grok is not governed on native Windows/);

    const grok = defaultHarnessInstallMatrix(win).find((entry) => entry.client === 'grok');
    assert.equal(grok.configured_locally, false);
    assert.equal(grok.default_install.native_hooks, false);
    assert.equal(grok.default_install.governed_wrapper, false);
    assert.notEqual(grok.capability_level, 'native_hooks');
    assert.deepEqual(grok.automatic, []);
    assert.equal(grok.skipped_reason, REASON);
    assert.match(grok.unsupported_claim, /Grok is not governed on native Windows/);
    // Every host that is not a native hook host is exactly as on POSIX (F-2c skips the hook hosts; test/win-hooks-f2c.test.js).
    const HOOK_HOSTS = ['grok', 'claude-code', 'codex', 'cursor', 'composer', 'cline', 'windsurf', 'gemini'];
    const others = (matrix) => JSON.stringify(matrix.filter((entry) => !HOOK_HOSTS.includes(entry.client)));
    assert.equal(others(defaultHarnessInstallMatrix(win)), others(defaultHarnessInstallMatrix(posix)));

    assert.equal(harnessReloadPlan(win, []).clients.some((entry) => entry.client === 'grok'), false);
    assert.equal(harnessReloadPlan(posix, []).clients.some((entry) => entry.client === 'grok'), true);
    // A Grok-only machine falls back to the governed wrapper, not a Grok native-hooks promise.
    const grokOnly = { grok: true, grokHooksSkipped: true };
    assert.equal(firstCapturePath(grokOnly).client, 'governed_wrapper');
    assert.equal(harnessReloadPlan(grokOnly, []).clients[0].client, 'mcp');
    assert.equal(firstCapturePath({ grok: true }).client, 'grok');

    // F-2c: Claude Code is not counted on native Windows either (its own skip reason); on POSIX it is unchanged.
    const claudeWin = activationProfile(win, plan, [], 'claude-code');
    const claudePosix = activationProfile(posix, buildPlan(posix, { mode: 'mcp' }), [], 'claude-code');
    assert.equal(claudeWin.complete, false);
    assert.equal(claudeWin.skipped_reason, 'windows_hook_shell_unverified');
    assert.equal(claudePosix.capability_level, 'native_hooks');
  } finally {
    p.cleanup();
  }
});

test('report: MARROW_CLIENT=grok on a faked native Windows host still yields an incomplete profile', POSIX_ONLY, async () => {
  const p = project({ homeGrok: true, homeMode: 0o770 });
  const previous = process.env.MARROW_CLIENT;
  process.env.MARROW_CLIENT = 'grok';
  try {
    const report = await withPlatform('win32', () => install(installOptions(p)));
    const profile = report.activation.profile;
    assert.equal(profile.complete, false);
    assert.equal(profile.capability_level, 'governed_wrapper');
    assert.deepEqual(profile.observed_hooks, []);
    assert.equal(profile.grok_native_windows, 'not_governed');
    assertGrokNeverWritten(p);
  } finally {
    if (previous === undefined) delete process.env.MARROW_CLIENT; else process.env.MARROW_CLIENT = previous;
    p.cleanup();
  }
});

// (c) POSIX is unchanged ------------------------------------------------------------------------

test('c: linux/macOS with a group-writable home and ~/.grok still throws, writes nothing for any host', POSIX_ONLY, () => {
  const p = project({ homeGrok: true, homeMode: 0o770 });
  try {
    const detection = detectEnvironment(p.root, p.env);
    assert.equal(detection.grokHooksSkipped, false);
    const plan = buildPlan(detection, { mode: 'mcp' });
    assert.equal(plan.skipped_hosts, undefined);
    assert.ok(plan.writes.some((write) => write.label === 'Grok native hooks'));
    assert.throws(() => applyPlan(plan, WRITE), /Refusing Grok hook write through unsafe owner path/);
    assert.equal(fs.existsSync(p.claudeSettings), false, 'the abort happens before any host is written, as at base');
  } finally {
    p.cleanup();
  }
});

test('c: a Grok target that exists but is unsafe on POSIX still throws, for every unsafe shape', POSIX_ONLY, () => {
  const shapes = {
    'world-writable target file': (p) => {
      fs.mkdirSync(path.join(p.home, '.grok', 'hooks'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(p.grokFile, '{}\n');
      fs.chmodSync(p.grokFile, 0o666);
    },
    'group-writable hooks folder': (p) => {
      fs.mkdirSync(path.join(p.home, '.grok', 'hooks'), { recursive: true });
      fs.chmodSync(path.join(p.home, '.grok', 'hooks'), 0o770);
    },
    'group-writable .grok folder': (p) => {
      fs.chmodSync(path.join(p.home, '.grok'), 0o770);
    },
    'symlinked target file': (p) => {
      fs.mkdirSync(path.join(p.home, '.grok', 'hooks'), { recursive: true, mode: 0o700 });
      const elsewhere = path.join(p.root, 'elsewhere.json');
      fs.writeFileSync(elsewhere, '{}\n');
      fs.symlinkSync(elsewhere, p.grokFile);
    },
    'symlinked .grok folder': (p) => {
      const elsewhere = path.join(p.root, 'elsewhere-grok');
      fs.mkdirSync(elsewhere, { mode: 0o700 });
      fs.rmSync(path.join(p.home, '.grok'), { recursive: true });
      fs.symlinkSync(elsewhere, path.join(p.home, '.grok'));
    },
  };
  for (const [name, prepare] of Object.entries(shapes)) {
    const p = project({ homeGrok: true });
    try {
      prepare(p);
      const plan = buildPlan(detectEnvironment(p.root, p.env), { mode: 'mcp' });
      assert.ok(plan.writes.some((write) => write.label === 'Grok native hooks'), name);
      assert.throws(() => applyPlan(plan, WRITE), /Refusing Grok hook write/, name);
      assert.equal(fs.existsSync(p.claudeSettings), false, name);
    } finally {
      p.cleanup();
    }
  }
});

test('c: a safe POSIX home still gets the Grok hook file, as at base', POSIX_ONLY, () => {
  const p = project({ homeGrok: true });
  try {
    const plan = buildPlan(detectEnvironment(p.root, p.env), { mode: 'mcp' });
    assert.equal(plan.skipped_hosts, undefined);
    applyPlan(plan, WRITE);
    assertClaudeWritten(p);
    assert.ok(fs.existsSync(p.grokFile));
    assert.match(fs.readFileSync(p.grokFile, 'utf8'), /grok-pre-action-hook/);
  } finally {
    p.cleanup();
  }
});

// Abuse: the skip is keyed on the real platform only ---------------------------------------------

test('abuse: a fake win32 environment, flag or option on POSIX does not trigger the skip', POSIX_ONLY, async () => {
  const p = project({ homeGrok: true, homeMode: 0o770 });
  const names = ['OS', 'MARROW_PLATFORM', 'PLATFORM', 'MARROW_HOOK_PLATFORM', 'MARROW_GROK_SKIP', 'MARROW_CLIENT', 'COMSPEC', 'PATHEXT', 'SystemRoot'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    OS: 'Windows_NT', MARROW_PLATFORM: 'win32', PLATFORM: 'win32', MARROW_HOOK_PLATFORM: 'win32', MARROW_GROK_SKIP: '1',
    COMSPEC: 'C:\\Windows\\System32\\cmd.exe', PATHEXT: '.COM;.EXE;.BAT;.CMD', SystemRoot: 'C:\\Windows',
  });
  try {
    const env = { ...p.env, USERPROFILE: 'C:\\Users\\victim', OS: 'Windows_NT', PLATFORM: 'win32', MARROW_PLATFORM: 'win32', COMSPEC: 'C:\\Windows\\System32\\cmd.exe' };
    const detection = detectEnvironment(p.root, env);
    assert.equal(detection.grokHooksSkipped, false);
    assert.equal(grokHooksSkipped(detection), false);
    // Even the existing hook-form seam (hookPlatform: 'win32') is not the Grok switch.
    for (const options of [{ mode: 'mcp' }, { mode: 'mcp', hookPlatform: 'win32' }, { mode: 'mcp', platform: 'win32', grokPlatform: 'win32', skipGrok: true }]) {
      const plan = buildPlan(detection, options);
      assert.equal(plan.skipped_hosts, undefined);
      assert.ok(plan.writes.some((write) => write.label === 'Grok native hooks'));
      assert.throws(() => applyPlan(plan, WRITE), /Refusing Grok hook write through unsafe owner path/);
    }
    // And the CLI has no flag for it.
    for (const flag of ['--skip-grok', '--platform=win32', '--grok-platform=win32']) assert.throws(() => parseArgs([flag], {}), /not known|unknown|Unknown/i, flag);
    await assert.rejects(() => install(installOptions(p)), /Refusing Grok hook write through unsafe owner path/);
    assert.equal(fs.existsSync(p.claudeSettings), false);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    p.cleanup();
  }
});

test('abuse: on a real win32 host nothing can turn the skip off (injected platform and options only add it)', POSIX_ONLY, async () => {
  const p = project({ homeGrok: true, homeMode: 0o770 });
  try {
    await withPlatform('win32', async () => {
      for (const injected of [undefined, 'linux', 'darwin', 'win32', '']) {
        const detection = detectEnvironment(p.root, p.env, { platform: injected });
        assert.equal(detection.grokHooksSkipped, true, String(injected));
        const plan = buildPlan(detection, { mode: 'mcp', hookPlatform: 'linux', platform: 'linux', grokPlatform: 'linux' });
        assert.equal(plan.writes.some((write) => write.label === 'Grok native hooks'), false, String(injected));
        assert.equal(grokSkips(plan.skipped_hosts).length, 1);
      }
      // A hand-built detection that claims support is still skipped on a real win32 host.
      assert.equal(grokHooksSkipped({ grok: true, grokHooksSkipped: false }), true);
      assert.equal(grokHooksSkipped({}), true);
      assert.equal(grokHooksSkipped(undefined), true);
      // Env names do not change that either.
      const env = { ...p.env, MARROW_GROK_HOOKS: '1', MARROW_FORCE_GROK: '1', MARROW_PLATFORM: 'linux', OS: 'Linux' };
      assert.equal(buildPlan(detectEnvironment(p.root, env), { mode: 'mcp' }).writes.some((write) => write.label === 'Grok native hooks'), false);
    });
    assert.equal(grokHooksSkipped({}), false, 'and the real platform is read at call time, not cached');
  } finally {
    p.cleanup();
  }
});

test('abuse: a .grok that is a symlink or junction is never followed or written through on win32', POSIX_ONLY, async () => {
  for (const kind of ['home', 'project']) {
    const p = project({ homeMode: 0o770 });
    const elsewhere = tempDir('marrow-wgs-elsewhere-');
    try {
      fs.symlinkSync(elsewhere, path.join(kind === 'home' ? p.home : p.root, '.grok'), 'dir');
      const detection = detectEnvironment(p.root, p.env, { platform: 'win32' });
      assert.equal(detection.grok, true, kind);
      applyPlan(buildPlan(detection, { mode: 'mcp' }), WRITE);
      assertClaudeSkipped(p);
      assert.deepEqual(fs.readdirSync(elsewhere), [], `${kind}: nothing written through the link`);
      assert.equal(fs.existsSync(path.join(p.home, '.grok', 'hooks')), false, kind);
      const report = await withPlatform('win32', () => install(installOptions(p)));
      assert.equal(grokSkips(report.skipped_hosts)[0].reason, REASON, kind);
      assert.deepEqual(fs.readdirSync(elsewhere), [], `${kind}: install wrote nothing through the link`);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
      p.cleanup();
    }
  }
});

test('abuse: a Grok hook file already on a win32 machine is neither rewritten, counted, nor removed by uninstall', POSIX_ONLY, async () => {
  const p = project({ homeGrok: true });
  try {
    applyPlan(buildPlan(detectEnvironment(p.root, p.env), { mode: 'mcp' }), WRITE);
    const before = fs.readFileSync(p.grokFile, 'utf8');
    const win = detectEnvironment(p.root, p.env, { platform: 'win32' });
    const changes = applyPlan(buildPlan(win, { mode: 'mcp' }), WRITE);
    assert.equal(fs.readFileSync(p.grokFile, 'utf8'), before, 'an existing file is left byte for byte');
    assert.equal(changes.some((change) => /grok/i.test(change.label)), false);
    // Uninstall on win32: explicit skip with the same reason, file untouched, nothing thrown.
    const report = await withPlatform('win32', () => uninstall({ cwd: p.root, home: p.home, yes: true, controller: false }));
    const grok = report.uninstall.changes.find((change) => change.label === 'Grok hooks');
    assert.equal(grok.action, 'skipped');
    assert.equal(grok.reason, REASON);
    assert.equal(grok.applied, false);
    assert.equal(fs.readFileSync(p.grokFile, 'utf8'), before);
    // Same uninstall on POSIX removes it, as at base.
    const posix = await uninstall({ cwd: p.root, home: p.home, yes: true, controller: false });
    assert.equal(posix.uninstall.changes.find((change) => change.label === 'Grok hooks').action, 'delete_file');
    assert.equal(fs.existsSync(p.grokFile), false);
  } finally {
    p.cleanup();
  }
});

// (d) POSIX plans and reports are unchanged ------------------------------------------------------

test('d: POSIX plan and report carry no new keys and the same writes as before', POSIX_ONLY, async () => {
  const p = project({ homeGrok: true });
  try {
    fs.mkdirSync(path.join(p.root, '.cursor'));
    const plan = buildPlan(detectEnvironment(p.root, p.env), { mode: 'auto' });
    assert.deepEqual(Object.keys(plan), ['mode', 'root', 'writes', 'mcp_target_version', 'host_approval_hooks', 'identityRecordHome']);
    assert.deepEqual(plan.writes.map((write) => write.label), [
      'Claude Code MCP passive hooks', 'Grok native hooks', 'Project MCP server config',
      'Cursor native hooks', 'Cursor MCP server config', 'Agent instructions', 'Cursor Marrow rule',
    ]);
    const report = await install(installOptions(p, { mode: 'auto' }));
    assert.equal('skipped_hosts' in report, false);
    assert.equal('skipped_hosts' in report.doctor, false);
    assert.ok(report.changes.some((change) => change.label === 'Grok native hooks' && change.applied));
    let full = '';
    printReport(report, (text) => { full += text; });
    assert.doesNotMatch(full, /not governed on native Windows|grok_hooks_unsupported/);
    assert.doesNotMatch(installSummaryLines(report, {}).lines.join('\n'), /not governed on native Windows/);
    assert.equal(report.harnessReload.clients.some((entry) => entry.client === 'grok'), true);
  } finally {
    p.cleanup();
  }
});

// (e) secrets ------------------------------------------------------------------------------------

test('e: a runtime-generated dummy key never appears in the report, summary, logs or written files on a faked win32 host', POSIX_ONLY, async () => {
  const p = project({ homeGrok: true, homeMode: 0o770 });
  const dummy = `mrw_dummy_${crypto.randomBytes(24).toString('hex')}`;
  try {
    const report = await withPlatform('win32', () => install(installOptions(p, { apiKey: dummy })));
    let full = '';
    printReport(report, (text) => { full += text; });
    const everything = [JSON.stringify(report), full, installSummaryLines(report, {}).lines.join('\n')].join('\n');
    assert.equal(everything.includes(dummy), false);
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (
      entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
    for (const file of [...walk(p.root), ...walk(p.home)]) {
      assert.equal(fs.readFileSync(file, 'utf8').includes(dummy), false, file);
    }
  } finally {
    p.cleanup();
  }
});

test('e: the CLI under a faked win32 platform exits 0 with a dummy key, skips Grok, and prints no key', POSIX_ONLY, () => {
  const p = project({ homeGrok: true, homeMode: 0o770 });
  const dummy = `mrw_dummy_${crypto.randomBytes(24).toString('hex')}`;
  const preload = path.join(p.root, '..', `fake-win32-${crypto.randomBytes(4).toString('hex')}.cjs`);
  // The installer's isolated loop-guard self-test starts npm's npx-cli.js next to node on win32 (F-2b);
  // here a staged node folder holds a stand-in that answers the proof, and the preload points process.execPath at it.
  const nodeDir = tempDir('marrow-wgs-node-');
  const stagedNode = path.join(nodeDir, 'node.exe');
  fs.symlinkSync(process.execPath, stagedNode);
  fs.mkdirSync(path.join(nodeDir, 'node_modules', 'npm', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js'), `process.stdout.write(${JSON.stringify(JSON.stringify({
    pass: true, isolated: true, live_hook_observed: false, repeat_denied: true, mutation_reset: true, owner_disabled_bypass: true,
  }))});\n`);
  fs.writeFileSync(preload, `Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });\nprocess.execPath = ${JSON.stringify(stagedNode)};\n`);
  try {
    const cli = path.join(__dirname, '..', 'bin', 'marrow-install.js');
    const env = {
      PATH: process.env.PATH, HOME: p.home, USERPROFILE: p.home, MARROW_API_KEY: dummy,
      // os.tmpdir() on a (faked) win32 host reads these.
      TEMP: os.tmpdir(), TMP: os.tmpdir(),
      // Nothing can reach production: a closed loopback port, and a dead npm registry from the home .npmrc.
      MARROW_BASE_URL: 'http://127.0.0.1:9', NODE_OPTIONS: `--require=${preload}`,
    };
    const run = spawnSync(process.execPath, [cli, '--yes', '--no-self-test', '--no-controller', '--json', '--cwd', p.root], { env, encoding: 'utf8', timeout: 120_000 });
    assert.equal(run.status, 0, `${run.stdout.slice(0, 400)}\n${run.stderr.slice(0, 400)}`);
    assert.equal(`${run.stdout}${run.stderr}`.includes(dummy), false);
    const report = JSON.parse(run.stdout);
    assert.equal(grokSkips(report.skipped_hosts)[0].reason, REASON);
    assert.equal(report.loop_guard.passed, true, 'the self-test ran through npx-cli.js');
    assertClaudeSkipped(p);
    assertGrokNeverWritten(p);
    const text = spawnSync(process.execPath, [cli, '--yes', '--no-self-test', '--no-controller', '--cwd', p.root], { env, encoding: 'utf8', timeout: 120_000 });
    assert.equal(text.status, 0, text.stderr.slice(0, 400));
    assert.match(text.stdout, /Skipped: Grok native hooks .*grok_hooks_unsupported_on_native_windows|skipped: Grok native hooks/i);
    assert.match(text.stdout, /Grok is not governed on native Windows/);
    assert.equal(`${text.stdout}${text.stderr}`.includes(dummy), false);
  } finally {
    fs.rmSync(preload, { force: true });
    fs.rmSync(nodeDir, { recursive: true, force: true });
    p.cleanup();
  }
});

test('the reason constant is the one the audit named', () => {
  assert.equal(GROK_WINDOWS_SKIP_REASON, 'grok_hooks_unsupported_on_native_windows');
});

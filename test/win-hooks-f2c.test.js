// F-2c (installer 0.1.74): on native Windows no hook host gets native hooks until its Windows hook
// shell is proven fail-closed (src/windows-hooks.js). Each detected host is reported in skipped_hosts
// with windows_hook_shell_unverified and never counted as configured. POSIX is unchanged.
const { deadRegistryHome } = require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  WINDOWS_HOOK_HOSTS,
  WINDOWS_HOOK_SKIP_REASON,
  windowsHooksSkipped,
} = require('../src/windows-hooks');
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

const REASON = 'windows_hook_shell_unverified';
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'POSIX mode bits are not meaningful on Windows' : false };
const WRITE = { yes: true, dryRun: false, doctor: false };
const HOOK_LABELS = ['Claude Code MCP passive hooks', 'Codex native hooks', 'Cline PreToolUse native hook', 'Cline PostToolUse native hook', 'Cline TaskCancel native hook',
  'Windsurf native hooks', 'Gemini CLI native hooks', 'Cursor native hooks', 'Grok native hooks'];
const HOSTS = ['Claude Code', 'Codex', 'Cursor', 'Cline', 'Windsurf', 'Gemini CLI'];
const CLIENTS = ['claude-code', 'codex', 'cursor', 'composer', 'cline', 'windsurf', 'gemini'];

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
}

// Every native hook host detected in one project.
function project() {
  const root = tempDir('marrow-f2c-proj-');
  const home = deadRegistryHome(tempDir('marrow-f2c-home-'));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Claude\n');
  fs.mkdirSync(path.join(root, '.codex'));
  fs.writeFileSync(path.join(root, '.codex', 'config.toml'), '# owner\n');
  for (const dir of ['.cursor', '.gemini', '.windsurf', '.clinerules']) fs.mkdirSync(path.join(root, dir));
  return {
    root,
    home,
    env: { HOME: home, PATH: process.env.PATH },
    cleanup() {
      for (const dir of [root, home]) fs.rmSync(dir, { recursive: true, force: true });
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
  mcpRuntimeInstall: () => false, mcpRuntimeProgress: () => {}, ...extra,
});

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (
  entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
const snapshot = (dir) => Object.fromEntries(walk(dir).map((file) => [path.relative(dir, file), fs.readFileSync(file, 'utf8')]));

test('F-2c: on win32 no native hook file is planned or written for any host; each is skipped with windows_hook_shell_unverified; MCP config, rules and AGENTS.md are still written', POSIX_ONLY, () => {
  const p = project();
  try {
    const detection = detectEnvironment(p.root, p.env, { platform: 'win32' });
    assert.equal(detection.windowsHooksSkipped, true);
    for (const mode of ['mcp', 'both', 'auto']) {
      const plan = buildPlan(detection, { mode });
      assert.deepEqual(plan.writes.filter((write) => HOOK_LABELS.includes(write.label)), [], mode);
      assert.deepEqual(plan.skipped_hosts.map((entry) => entry.host), HOSTS, mode);
      for (const entry of plan.skipped_hosts) {
        assert.equal(entry.reason, REASON);
        assert.equal(entry.action, 'skipped');
        assert.equal(entry.configured, false);
        assert.match(entry.message, new RegExp(`^${entry.host} is not governed by native hooks on native Windows`));
      }
    }
    for (const mode of ['sdk', 'md']) assert.equal(buildPlan(detection, { mode }).skipped_hosts, undefined, mode);
    const changes = applyPlan(buildPlan(detection, { mode: 'mcp' }), WRITE);
    assert.deepEqual(changes.map((change) => change.label).sort(), ['Agent instructions', 'Cursor MCP server config', 'Cursor Marrow rule', 'Project MCP server config']);
    for (const file of ['.claude/settings.json', '.codex/hooks.json', '.cursor/hooks.json', '.windsurf/hooks.json', '.gemini/settings.json', '.clinerules/hooks']) {
      assert.equal(fs.existsSync(path.join(p.root, file)), false, file);
    }
  } finally {
    p.cleanup();
  }
});

test('F-2c: hook files already on disk (an earlier installer, or POSIX-written) are left byte for byte on win32 and never counted as configured', POSIX_ONLY, () => {
  const p = project();
  try {
    applyPlan(buildPlan(detectEnvironment(p.root, p.env), { mode: 'mcp' }), WRITE);
    const posix = detectEnvironment(p.root, p.env);
    const before = snapshot(p.root);
    const win = detectEnvironment(p.root, p.env, { platform: 'win32' });
    const changes = applyPlan(buildPlan(win, { mode: 'mcp' }), WRITE);
    assert.equal(changes.some((change) => HOOK_LABELS.includes(change.label)), false);
    const after = snapshot(p.root);
    for (const file of Object.keys(before).filter((name) => /hooks|settings\.json/.test(name))) assert.equal(after[file], before[file], file);
    const plan = buildPlan(win, { mode: 'mcp' });
    for (const client of CLIENTS) {
      const posixProfile = activationProfile(posix, buildPlan(posix, { mode: 'mcp' }), [], client);
      assert.equal(posixProfile.capability_level, 'native_hooks', client);
      assert.equal(posixProfile.complete, true, `${client} is complete on POSIX`);
      const profile = activationProfile(win, plan, [], client);
      assert.equal(profile.complete, false, client);
      assert.equal(profile.configuration_complete, false, client);
      assert.equal(profile.loop_guard_configured, false, client);
      assert.notEqual(profile.capability_level, 'native_hooks', client);
      assert.deepEqual(profile.observed_hooks, [], client);
      assert.equal(profile.skipped_reason, REASON, client);
      assert.equal(profile.native_windows, 'not_governed', client);
      assert.equal(JSON.stringify(profile).includes('"coverage_verified":true'), false, client);
    }
    const matrix = defaultHarnessInstallMatrix(win);
    for (const client of CLIENTS) {
      const entry = matrix.find((item) => item.client === client);
      assert.equal(entry.configured_locally, false, client);
      assert.equal(entry.default_install.native_hooks, false, client);
      assert.equal(entry.default_install.governed_wrapper, false, client);
      assert.equal(entry.skipped_reason, REASON, client);
      assert.deepEqual(entry.automatic, [], client);
    }
    const posixMatrix = defaultHarnessInstallMatrix(posix);
    for (const client of CLIENTS) assert.equal(posixMatrix.find((item) => item.client === client).default_install.native_hooks, true, client);
    const others = (list) => JSON.stringify(list.filter((entry) => ![...CLIENTS, 'grok'].includes(entry.client)));
    assert.equal(others(matrix), others(posixMatrix), 'hosts without native hooks are unchanged');
    assert.deepEqual(harnessReloadPlan(win, []).clients.map((entry) => entry.client), ['mcp']);
    assert.equal(firstCapturePath(win).client, 'governed_wrapper');
    assert.equal(firstCapturePath(posix).client, 'claude-code');
  } finally {
    p.cleanup();
  }
});

test('F-2c: the whole install(), dry run and doctor on a faked native Windows host exit normally and say each host is not governed; a second run changes nothing', POSIX_ONLY, async () => {
  const p = project();
  try {
    const report = await withPlatform('win32', () => install(installOptions(p)));
    assert.deepEqual(report.skipped_hosts.map((entry) => entry.host), HOSTS);
    assert.deepEqual(report.doctor.skipped_hosts.map((entry) => entry.host), HOSTS);
    assert.equal(report.changes.some((change) => HOOK_LABELS.includes(change.label)), false);
    assert.equal(report.loop_guard_configured, false);
    let full = '';
    printReport(report, (text) => { full += text; });
    for (const host of HOSTS) assert.match(full, new RegExp(`${host} is not governed by native hooks on native Windows`));
    assert.match(full, /next: no native hooks were written on native Windows/);
    assert.doesNotMatch(full, /complete its hook trust\/review step/);
    const { lines } = installSummaryLines(report, {});
    assert.ok(lines.some((line) => /^Skipped Claude Code MCP passive hooks: Claude Code is not governed/.test(line)), lines.join('\n'));
    const again = await withPlatform('win32', () => install(installOptions(p)));
    assert.equal(again.changes.some((change) => change.changed), false);
    const doctor = await withPlatform('win32', () => install(installOptions(p, { yes: false, doctor: true })));
    let text = '';
    printReport(doctor, (chunk) => { text += chunk; });
    assert.match(text, /Claude Code coverage: not configured \(windows_hook_shell_unverified\)/);
    assert.match(text, /missing hooks\/config: none/);
    const dry = await withPlatform('win32', () => install(installOptions(p, { yes: false, dryRun: true })));
    assert.equal(dry.skipped_hosts.length, HOSTS.length);
  } finally {
    p.cleanup();
  }
});

test('F-2c abuse: a forged win32 environment, option or argv on POSIX never skips a host (hooks written exactly as before)', POSIX_ONLY, async () => {
  const p = project();
  const names = ['OS', 'MARROW_PLATFORM', 'PLATFORM', 'MARROW_HOOK_PLATFORM', 'MARROW_WINDOWS_HOOKS', 'COMSPEC', 'PATHEXT', 'SystemRoot', 'SHELL', 'MSYSTEM'];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    OS: 'Windows_NT', MARROW_PLATFORM: 'win32', PLATFORM: 'win32', MARROW_HOOK_PLATFORM: 'win32', MARROW_WINDOWS_HOOKS: '0',
    COMSPEC: 'C:\\Windows\\System32\\cmd.exe', PATHEXT: '.COM;.EXE;.BAT;.CMD', SystemRoot: 'C:\\Windows', MSYSTEM: 'MINGW64',
  });
  try {
    const env = { ...p.env, USERPROFILE: 'C:\\Users\\victim', OS: 'Windows_NT', PLATFORM: 'win32', COMSPEC: 'C:\\Windows\\System32\\cmd.exe' };
    const detection = detectEnvironment(p.root, env);
    assert.equal(detection.windowsHooksSkipped, false);
    assert.equal(windowsHooksSkipped(detection), false);
    for (const options of [{ mode: 'mcp' }, { mode: 'mcp', platform: 'win32', windowsHooks: false, skipWindowsHooks: true }]) {
      const plan = buildPlan(detection, options);
      assert.equal(plan.skipped_hosts, undefined);
      assert.equal(plan.writes.filter((write) => HOOK_LABELS.includes(write.label)).length, 8, JSON.stringify(options));
    }
    for (const flag of ['--platform=win32', '--windows-hooks', '--skip-windows-hooks', '--hook-platform=win32']) assert.throws(() => parseArgs([flag], {}), /not known|unknown|Unknown/i, flag);
    const report = await install(installOptions(p));
    assert.equal('skipped_hosts' in report, false);
    assert.ok(report.changes.some((change) => change.label === 'Claude Code MCP passive hooks' && change.applied));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    p.cleanup();
  }
});

test('F-2c abuse: on a real win32 host nothing turns the skip off: injected platform, hand-built detection, options or env', POSIX_ONLY, async () => {
  const p = project();
  try {
    await withPlatform('win32', async () => {
      for (const injected of [undefined, 'linux', 'darwin', '']) {
        const detection = detectEnvironment(p.root, { ...p.env, MARROW_PLATFORM: 'linux', OS: 'Linux', SHELL: '/bin/bash' }, { platform: injected });
        assert.equal(detection.windowsHooksSkipped, true, String(injected));
        const plan = buildPlan({ ...detection, windowsHooksSkipped: false }, { mode: 'mcp', hookPlatform: 'linux', platform: 'linux' });
        assert.deepEqual(plan.writes.filter((write) => HOOK_LABELS.includes(write.label)), [], String(injected));
        assert.deepEqual(plan.skipped_hosts.map((entry) => entry.host), [...HOSTS], String(injected));
      }
      assert.equal(windowsHooksSkipped({ windowsHooksSkipped: false }), true);
      assert.equal(windowsHooksSkipped(undefined), true);
    });
    assert.equal(windowsHooksSkipped({}), false, 'the real platform is read at call time, not cached');
  } finally {
    p.cleanup();
  }
});

test('F-2c: uninstall on win32 still removes Marrow hook entries an earlier installer wrote (an owner action; nothing new is written)', POSIX_ONLY, async () => {
  const p = project();
  try {
    applyPlan(buildPlan(detectEnvironment(p.root, p.env), { mode: 'mcp' }), WRITE);
    const settings = path.join(p.root, '.claude', 'settings.json');
    assert.match(fs.readFileSync(settings, 'utf8'), /claude-pre-action-hook/);
    await withPlatform('win32', () => uninstall({ cwd: p.root, home: p.home, yes: true, controller: false }));
    const left = fs.existsSync(settings) ? fs.readFileSync(settings, 'utf8') : '';
    assert.doesNotMatch(left, /claude-pre-action-hook/);
  } finally {
    p.cleanup();
  }
});

test('F-2c secrets: a runtime-generated dummy key never appears in the report, summary, doctor text or any file on a faked win32 host', POSIX_ONLY, async () => {
  const p = project();
  const dummy = `mrw_dummy_${crypto.randomBytes(24).toString('hex')}`;
  try {
    const report = await withPlatform('win32', () => install(installOptions(p, { apiKey: dummy })));
    const doctor = await withPlatform('win32', () => install(installOptions(p, { apiKey: dummy, yes: false, doctor: true })));
    let full = '';
    printReport(report, (text) => { full += text; });
    printReport(doctor, (text) => { full += text; });
    const everything = [JSON.stringify(report), JSON.stringify(doctor), full, installSummaryLines(report, {}).lines.join('\n')].join('\n');
    assert.equal(everything.includes(dummy), false);
    for (const file of [...walk(p.root), ...walk(p.home)]) assert.equal(fs.readFileSync(file, 'utf8').includes(dummy), false, file);
  } finally {
    p.cleanup();
  }
});

test('F-2c decision table: every hook host lists the four Windows shells, has no written form, and the reason is the spec one', () => {
  assert.equal(WINDOWS_HOOK_SKIP_REASON, REASON);
  assert.deepEqual(WINDOWS_HOOK_HOSTS.map((entry) => entry.client), ['claude-code', 'codex', 'cursor', 'cline', 'windsurf', 'gemini']);
  for (const entry of WINDOWS_HOOK_HOSTS) {
    assert.deepEqual([...entry.shells], ['cmd.exe (spawn shell:true)', 'Git Bash', 'Windows PowerShell 5.1', 'PowerShell 7'], entry.client);
    assert.equal(entry.form, null, entry.client);
    assert.ok(Object.isFrozen(entry));
  }
  assert.ok(Object.isFrozen(WINDOWS_HOOK_HOSTS));
});

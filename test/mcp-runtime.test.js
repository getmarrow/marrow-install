const { deadRegistryHome } = require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  activationProfile,
  applyPlan,
  buildPlan,
  detectEnvironment,
  install,
  parseArgs,
  resolveMcpTargetVersion,
  uninstall,
} = require('../src/installer');
const {
  HOLD_TEXT,
  NPM_INSTALL_TIMEOUT_MS,
  UNAVAILABLE_TEXT,
  delocalizeHookCommand,
  ensureMcpRuntime,
  hookTextUsesNpx,
  localizeHookCommand,
  loaderFor,
  npmInvocation,
  runtimeConfig,
  runtimeDir,
  verifyMcpRuntime,
} = require('../src/mcp-runtime');
const PINS = require('../src/pins');
const installer = require('../src/installer');
const { cleanControllerEnv, controllerStatus, ensureCurrentGovernanceController, stopProjectControllers } = require('../src/controller-manager');

const PIN = PINS.MCP_ADAPTER_VERSION;
const AHEAD = PIN.replace(/\d+$/, (patch) => String(Number(patch) + 1));
const fakeIntegrity = (seed) => `sha512-${crypto.createHash('sha512').update(seed).digest('base64')}`;

function tempDir(prefix = 'marrow-runtime-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
}

// The stand-in package: each entrypoint answers what its host's hook expects and leaves a
// marker in HOME saying it ran from the local copy.
const FAKE_CLI = `#!/usr/bin/env node
const fs = require('fs');
const sub = process.argv[2];
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(require('path').join(process.env.HOME || '/nonexistent', 'local-' + sub), input);
  const out = /^(gemini|grok)-pre-action-hook$/.test(sub) ? { decision: 'allow' }
    : sub === 'gemini-context-hook' ? {}
    : sub === 'cursor-pre-action-hook' ? { permission: 'allow' }
    : { local: true };
  process.stdout.write(JSON.stringify(out));
});
`;

function fakeNpmInstall({ integrity = PINS.MCP_ADAPTER_INTEGRITY, sdkIntegrity = PINS.SDK_ADAPTER_INTEGRITY, calls = [] } = {}) {
  return (stage, specs) => {
    calls.push(specs);
    const version = specs.find((spec) => spec.startsWith('@getmarrow/mcp@')).slice('@getmarrow/mcp@'.length);
    const mcp = path.join(stage, 'node_modules', '@getmarrow', 'mcp');
    const sdk = path.join(stage, 'node_modules', '@getmarrow', 'sdk');
    fs.mkdirSync(path.join(mcp, 'dist'), { recursive: true });
    fs.mkdirSync(sdk, { recursive: true });
    fs.writeFileSync(path.join(mcp, 'package.json'), JSON.stringify({ name: '@getmarrow/mcp', version, bin: { 'marrow-mcp': 'dist/cli.js' }, dependencies: { '@getmarrow/sdk': `^${PINS.SDK_ADAPTER_VERSION}` } }));
    fs.writeFileSync(path.join(mcp, 'dist', 'cli.js'), FAKE_CLI);
    fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: '@getmarrow/sdk', version: PINS.SDK_ADAPTER_VERSION }));
    fs.writeFileSync(path.join(stage, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'marrow-mcp-runtime' },
        'node_modules/@getmarrow/mcp': { version, integrity },
        'node_modules/@getmarrow/sdk': { version: PINS.SDK_ADAPTER_VERSION, integrity: sdkIntegrity },
      },
    }));
    return true;
  };
}

// A project every JSON-configured host is detected in, plus a Grok home.
function allHostsProject() {
  const root = tempDir('marrow-runtime-project-');
  const home = deadRegistryHome(tempDir('marrow-runtime-home-'));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Claude\n');
  fs.mkdirSync(path.join(root, '.codex'));
  fs.writeFileSync(path.join(root, '.codex', 'config.toml'), '# owner\n');
  for (const dir of ['.cursor', '.gemini', '.windsurf']) fs.mkdirSync(path.join(root, dir));
  fs.mkdirSync(path.join(home, '.grok'), { mode: 0o700 });
  return { root, home };
}

function hookFiles(root, home) {
  return {
    claude: path.join(root, '.claude', 'settings.json'),
    codex: path.join(root, '.codex', 'hooks.json'),
    cursor: path.join(root, '.cursor', 'hooks.json'),
    windsurf: path.join(root, '.windsurf', 'hooks.json'),
    gemini: path.join(root, '.gemini', 'settings.json'),
    grok: path.join(home, '.grok', 'hooks', 'marrow.json'),
  };
}

function marrowCommands(filePath) {
  const found = [];
  const walk = (value) => {
    if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        if (key === 'command' && typeof entry === 'string' && entry.includes('@getmarrow/mcp@')) found.push(entry);
        else walk(entry);
      }
    }
  };
  walk(JSON.parse(fs.readFileSync(filePath, 'utf8')));
  return found;
}

function runHook(command, env) {
  return spawnSync('/bin/sh', ['-c', command], { env, input: '{}', encoding: 'utf8', timeout: 30_000 });
}

const installOptions = (root, home, extra = {}) => ({
  cwd: root, home, mode: 'mcp', yes: true, dryRun: false, selfTest: false, loopGuardSelfTest: false, controller: false,
  apiKey: '', baseUrl: 'https://api.getmarrow.ai', agentId: '', mcpLocalRuntime: true, mcpRuntimeInstall: fakeNpmInstall(), mcpRuntimeProgress: () => {}, ...extra,
});

test('every host\'s Marrow hook is written in the local runtime form, maps back exactly, and never starts npx', () => {
  const { root, home } = allHostsProject();
  try {
    applyPlan(buildPlan(detectEnvironment(root, { HOME: home, PATH: process.env.PATH }), { mode: 'mcp' }), { yes: true, dryRun: false, doctor: false });
    let count = 0;
    for (const [host, filePath] of Object.entries(hookFiles(root, home))) {
      const text = fs.readFileSync(filePath, 'utf8');
      assert.equal(hookTextUsesNpx(text), false, `${host}: no npx in the written file`);
      assert.doesNotMatch(text, /npx -y --package|npx\.cmd|exec npx|else npx/, host);
      const commands = marrowCommands(filePath);
      assert.ok(commands.length > 0, host);
      for (const local of commands) {
        const canonical = delocalizeHookCommand(local);
        assert.notEqual(canonical, local, `${host}: ${local.slice(0, 80)}`);
        assert.ok(hookTextUsesNpx(canonical), 'the canonical spelling exists in memory only');
        assert.equal(localizeHookCommand(canonical, PIN, { platform: 'linux' }), local, host);
        assert.ok(local.includes(`/.marrow/runtime/mcp/${PIN}/`), host);
        // The Windows spelling maps back exactly too, and names no npx either.
        const windows = localizeHookCommand(canonical, PIN, { platform: 'win32' });
        assert.notEqual(windows, canonical, host);
        assert.equal(delocalizeHookCommand(windows), canonical, host);
        assert.equal(hookTextUsesNpx(windows), false, host);
        assert.doesNotMatch(windows, /npx -y --package|npx\.cmd/, host);
        // A local form whose runtime path and package name different versions is not Marrow's own.
        for (const [from, to] of [[`/.marrow/runtime/mcp/${PIN}/node`, `/.marrow/runtime/mcp/${AHEAD}/node`], [`--package=@getmarrow/mcp@${PIN}`, `--package=@getmarrow/mcp@${AHEAD}`]]) {
          const mismatched = local.split(from).join(to);
          if (mismatched !== local) assert.equal(delocalizeHookCommand(mismatched), mismatched, `${host}: mismatched versions`);
        }
        // An edited command (exit status, hold text, an appended step) is not Marrow's own either.
        for (const edited of [local.replace('exit 2', 'exit 0'), local.replace('exit 1', 'exit 0'), local.replace('Marrow held', 'Marrow let'), `${local}; true`]) {
          if (edited !== local) assert.notEqual(delocalizeHookCommand(edited), canonical, `${host}: edited ${edited.slice(-60)}`);
        }
        assert.equal(localizeHookCommand(canonical, AHEAD), canonical, 'only the runtime\'s own version is switched');
        assert.doesNotMatch(local, /^(?:node|npx|sh) /, 'nothing at the start of the command needs PATH');
        count += 1;
      }
    }
    assert.ok(count >= 20, String(count));
    for (const owner of ['./scripts/check.sh', 'npx eslint .', 'node -e "1"', 'sh -c \'true\'']) {
      assert.equal(localizeHookCommand(owner, PIN), owner);
      assert.equal(delocalizeHookCommand(owner), owner);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('install puts the pinned MCP in a private runtime, and every host\'s hooks start it with no PATH at all', async () => {
  const { root, home } = allHostsProject();
  try {
    const calls = [];
    const report = await install(installOptions(root, home, { mcpRuntimeInstall: fakeNpmInstall({ calls }) }));
    assert.deepEqual(calls, [[`@getmarrow/mcp@${PIN}`, `@getmarrow/sdk@${PINS.SDK_ADAPTER_VERSION}`]]);
    assert.equal(report.mcp_runtime.state, 'installed');
    assert.equal(report.mcp_runtime.hooks_start, 'local_runtime');
    const dir = runtimeDir(home, PIN);
    for (const directory of [path.join(home, '.marrow'), path.join(home, '.marrow', 'runtime'), path.join(home, '.marrow', 'runtime', 'mcp'), dir]) {
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700, directory);
    }
    assert.equal(fs.statSync(path.join(dir, '.verified')).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(dir, 'run')), false, 'hooks never start a script from the runtime directory');
    assert.equal(fs.readlinkSync(path.join(dir, 'node')), process.execPath);
    const files = hookFiles(root, home);
    const before = Object.fromEntries(Object.entries(files).map(([host, filePath]) => [host, fs.readFileSync(filePath, 'utf8')]));
    for (const [host, text] of Object.entries(before)) {
      assert.ok(text.includes(`/.marrow/runtime/mcp/${PIN}/`), host);
      assert.equal(text.includes(home), false, `${host}: no machine path in the hook file`);
    }

    // Idempotent: a second run keeps the runtime and every hook file byte for byte.
    const again = await install(installOptions(root, home));
    assert.equal(again.mcp_runtime.state, 'present');
    for (const [host, filePath] of Object.entries(files)) assert.equal(fs.readFileSync(filePath, 'utf8'), before[host], host);
    // Checks read the local form as Marrow's own hooks.
    const detection = detectEnvironment(root, { HOME: home, PATH: process.env.PATH });
    const profile = activationProfile(detection, buildPlan(detection, { mode: 'mcp' }), [], 'claude-code');
    assert.equal(profile.configuration_complete, true);

    // Every hook runs with no usable PATH and starts the local copy.
    const env = { HOME: home, PATH: '/nonexistent-marrow-path' };
    let ran = 0;
    for (const [host, filePath] of Object.entries(files)) {
      for (const command of marrowCommands(filePath)) {
        const result = runHook(command, env);
        assert.equal(result.status, 0, `${host}: ${result.stderr} ${command.slice(0, 120)}`);
        ran += 1;
      }
    }
    assert.ok(ran >= 20);
    const markers = fs.readdirSync(home).filter((name) => name.startsWith('local-'));
    assert.ok(markers.includes('local-claude-pre-action-hook') && markers.includes('local-codex-pre-action-hook')
      && markers.includes('local-cursor-pre-action-hook') && markers.includes('local-gemini-pre-action-hook')
      && markers.includes('local-windsurf-pre-action-hook') && markers.includes('local-grok-pre-action-hook'), markers.join(','));
    assert.equal(fs.readdirSync(home).some((name) => name.startsWith('npx-')), false);

    // Only the commands change: every matcher, timeout, failClosed and async flag (Cursor's
    // gating timeout, Codex's budget) is what the npx layout has.
    const plain = allHostsProject();
    try {
      applyPlan(buildPlan(detectEnvironment(plain.root, { HOME: plain.home, PATH: process.env.PATH }), { mode: 'mcp' }), { yes: true, dryRun: false, doctor: false });
      const canonical = (text) => JSON.stringify(JSON.parse(text), (key, value) => (key === 'command' ? delocalizeHookCommand(value) : value));
      const plainFiles = hookFiles(plain.root, plain.home);
      for (const host of Object.keys(files)) {
        assert.equal(canonical(before[host]), canonical(fs.readFileSync(plainFiles[host], 'utf8')), host);
      }
    } finally {
      fs.rmSync(plain.root, { recursive: true, force: true });
      fs.rmSync(plain.home, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// A project that tries to decide Marrow's hooks itself: npx and npx.cmd shims in the project
// and first on PATH, and a planted @getmarrow/mcp in node_modules that claims the pinned version
// and answers allow. None of them may ever run.
function plantProject(root) {
  const shimDir = tempDir('marrow-runtime-shim-');
  const shim = '#!/bin/sh\nfor arg; do sub=$arg; done\n: > "$HOME/npx-$sub"\nprintf \'%s\' \'{"via":"npx"}\'\n';
  for (const dir of [shimDir, root]) {
    for (const name of ['npx', 'npx.cmd', 'npm', 'npm.cmd']) fs.writeFileSync(path.join(dir, name), shim, { mode: 0o755 });
  }
  const planted = path.join(root, 'node_modules', '@getmarrow', 'mcp');
  fs.mkdirSync(path.join(planted, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(planted, 'package.json'), JSON.stringify({ name: '@getmarrow/mcp', version: PIN, bin: { 'marrow-mcp': 'dist/cli.js' } }));
  fs.writeFileSync(path.join(planted, 'dist', 'cli.js'), '#!/usr/bin/env node\nrequire("fs").writeFileSync(require("path").join(process.env.HOME, "planted-" + process.argv[2]), "");\nprocess.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" }, decision: "allow", permission: "allow" }));\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, '.npmrc'), 'registry=http://127.0.0.1:9/\n');
  return shimDir;
}

function runProjectHook(command, root, env) {
  return spawnSync('/bin/sh', ['-c', command], { cwd: root, env, input: '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}', encoding: 'utf8', timeout: 30_000 });
}

function assertNothingPlantedRan(home) {
  const ran = fs.readdirSync(home).filter((name) => name.startsWith('npx-') || name.startsWith('planted-'));
  assert.deepEqual(ran, [], 'no npx shim and no planted copy ran');
}

// Every Marrow pre-action command of every host holds (non-zero, never an allow on stdout), and
// the plain ones print exactly the fixed hold text, which names no path or key.
function assertEveryPreActionHolds(root, home, env) {
  let held = 0;
  for (const [host, filePath] of Object.entries(hookFiles(root, home))) {
    for (const command of marrowCommands(filePath).filter((entry) => /pre-action-hook/.test(entry))) {
      const result = runProjectHook(command, root, env);
      assert.equal(result.status, 2, `${host}: ${result.stdout} ${result.stderr} ${command.slice(0, 100)}`);
      assert.doesNotMatch(result.stdout, /allow/, host);
      assert.equal(result.stderr.includes(home), false, `${host}: no path echoed`);
      if (command.startsWith('/bin/sh -c \'M=')) assert.equal(result.stderr, `${HOLD_TEXT}\n`, host);
      held += 1;
    }
  }
  assert.ok(held >= 8, String(held));
  assertNothingPlantedRan(home);
}

test('without a verified copy every pre-action hook holds with the fixed repair text, and npx or a planted copy never runs', async () => {
  const { root, home } = allHostsProject();
  const shimDir = plantProject(root);
  const env = { HOME: home, PATH: `${shimDir}:${root}:.:${path.dirname(process.execPath)}:/usr/bin:/bin`, npm_config_registry: 'http://127.0.0.1:9/', npm_config_prefix: root };
  try {
    // The registry's tarball does not match the pin: no runtime. Hooks are still written in the
    // local form and hold until a repair installs a verified copy.
    const mismatch = await install(installOptions(root, home, { mcpRuntimeInstall: fakeNpmInstall({ integrity: fakeIntegrity('other') }) }));
    assert.equal(mismatch.mcp_runtime.state, 'failed');
    assert.equal(mismatch.mcp_runtime.reason, 'integrity_mismatch');
    assert.equal(mismatch.mcp_runtime.hooks_start, 'self_heal_on_next_start');
    assert.equal(mismatch.mcp_runtime.needs_repair, true);
    assert.equal(fs.existsSync(runtimeDir(home, PIN)), false);
    const claude = hookFiles(root, home).claude;
    assert.ok(fs.readFileSync(claude, 'utf8').includes('/.marrow/runtime/'));
    assert.equal(hookTextUsesNpx(fs.readFileSync(claude, 'utf8')), false);
    assertEveryPreActionHolds(root, home, env);
    // Every other entrypoint fails without starting anything (exit 1, or the host wrapper's own
    // neutral or non-blocking result), and nothing planted runs.
    for (const [host, filePath] of Object.entries(hookFiles(root, home))) {
      for (const command of marrowCommands(filePath).filter((entry) => !/pre-action-hook/.test(entry))) {
        const result = runProjectHook(command, root, env);
        assert.notEqual(result.status, null, host);
        assert.doesNotMatch(result.stdout, /allow|via/, host);
      }
    }
    assertNothingPlantedRan(home);
    const sdkMismatch = ensureMcpRuntime({ home, version: PIN, integrity: PINS.MCP_ADAPTER_INTEGRITY, sdk: { version: PINS.SDK_ADAPTER_VERSION, integrity: PINS.SDK_ADAPTER_INTEGRITY }, npmInstall: fakeNpmInstall({ sdkIntegrity: fakeIntegrity('sdk') }) });
    assert.equal(sdkMismatch.reason, 'sdk_integrity_mismatch');

    // A good copy: every pre-action hook runs it, from the project directory, with the planted
    // copy, the shims and the env overrides in place.
    await install(installOptions(root, home));
    const preAction = marrowCommands(claude).find((command) => command.includes('claude-pre-action-hook'));
    const good = runProjectHook(preAction, root, env);
    assert.equal(good.status, 0, good.stderr);
    assert.equal(good.stdout, '{"local":true}');
    assertNothingPlantedRan(home);
    // One of its files changes: held, never npx.
    fs.appendFileSync(path.join(runtimeDir(home, PIN), 'node_modules', '@getmarrow', 'mcp', 'dist', 'cli.js'), '\n// changed\n');
    assert.equal(verifyMcpRuntime(home, PIN, PINS.MCP_ADAPTER_INTEGRITY), null);
    const changed = runProjectHook(preAction, root, env);
    assert.equal(changed.status, 2, changed.stderr);
    assert.equal(changed.stdout, '');
    assert.equal(changed.stderr, `${HOLD_TEXT}\n`);
    const changedResult = runProjectHook(marrowCommands(claude).find((command) => / marrow-mcp claude-hook;/.test(command)), root, env);
    assert.equal(changedResult.status, 1);
    assert.equal(changedResult.stderr, `${UNAVAILABLE_TEXT}\n`);
    assertNothingPlantedRan(home);
    // The next install replaces the changed copy.
    assert.equal((await install(installOptions(root, home))).mcp_runtime.state, 'installed');

    // The node binary captured at install is gone: the run script starts the launcher with node
    // on PATH, which still verifies the copy (base fell back to npx here).
    const nodeDir = tempDir('marrow-runtime-node-');
    fs.symlinkSync(process.execPath, path.join(nodeDir, 'node'));
    fs.rmSync(path.join(home, '.marrow', 'runtime'), { recursive: true, force: true });
    assert.equal(ensureMcpRuntime({ home, version: PIN, integrity: PINS.MCP_ADAPTER_INTEGRITY, nodePath: path.join(nodeDir, 'node'), npmInstall: fakeNpmInstall() }).state, 'installed');
    fs.rmSync(nodeDir, { recursive: true, force: true });
    const noNode = runProjectHook(preAction, root, env);
    assert.equal(noNode.status, 0, noNode.stderr);
    assert.equal(noNode.stdout, '{"local":true}');
    // ...and with no node on PATH either, it holds.
    const noNodeAtAll = runProjectHook(preAction, root, { ...env, PATH: `${shimDir}:${root}:/usr/bin:/bin`.split(':').filter((dir) => !fs.existsSync(path.join(dir, 'node'))).join(':') });
    assert.equal(noNodeAtAll.status, 2, noNodeAtAll.stdout);
    assert.equal(noNodeAtAll.stderr, `${HOLD_TEXT}\n`);
    assert.doesNotMatch(noNodeAtAll.stdout, /allow|via/);

    // The copy is gone: every kind of pre-action command holds.
    fs.rmSync(path.join(home, '.marrow', 'runtime'), { recursive: true, force: true });
    assertEveryPreActionHolds(root, home, env);
  } finally {
    for (const directory of [root, home, shimDir]) fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a new pin (update) gets its own runtime and older versions are removed', async () => {
  const { root, home } = allHostsProject();
  try {
    const old = ensureMcpRuntime({ home, version: '3.9.1', integrity: fakeIntegrity('old'), npmInstall: fakeNpmInstall({ integrity: fakeIntegrity('old') }) });
    assert.equal(old.state, 'installed');
    // A stage left by an install that died an hour ago is removed (a fresh one may belong to a
    // concurrent install and is kept: see runtime-concurrency.test.js).
    const leftover = path.join(home, '.marrow', 'runtime', 'mcp', '.stage-3.9.2-1-abcd');
    fs.mkdirSync(leftover);
    fs.utimesSync(leftover, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
    await install(installOptions(root, home));
    assert.deepEqual(fs.readdirSync(path.join(home, '.marrow', 'runtime', 'mcp')), [PIN]);

    // A registry-verified newer MCP: its runtime replaces the pinned one, and hooks follow it.
    const registryIntegrity = fakeIntegrity(`registry-${AHEAD}`);
    const target = resolveMcpTargetVersion({
      registryMetadata: { name: '@getmarrow/mcp', version: AHEAD, dist: { integrity: registryIntegrity, tarball: `https://registry.npmjs.org/@getmarrow/mcp/-/mcp-${AHEAD}.tgz` } },
    });
    assert.equal(target.version, AHEAD);
    const updated = await install(installOptions(root, home, {
      update: true,
      repair: true,
      mcpRegistryMetadata: { name: '@getmarrow/mcp', version: AHEAD, dist: { integrity: registryIntegrity, tarball: `https://registry.npmjs.org/@getmarrow/mcp/-/mcp-${AHEAD}.tgz` } },
      mcpRuntimeInstall: fakeNpmInstall({ integrity: registryIntegrity }),
    }));
    assert.equal(updated.mcp_runtime.state, 'installed');
    assert.deepEqual(updated.mcp_runtime.removed_versions, [PIN]);
    assert.deepEqual(fs.readdirSync(path.join(home, '.marrow', 'runtime', 'mcp')), [AHEAD]);
    const claude = fs.readFileSync(hookFiles(root, home).claude, 'utf8');
    assert.ok(claude.includes(`/.marrow/runtime/mcp/${AHEAD}/node`));
    assert.equal(claude.includes(`/.marrow/runtime/mcp/${PIN}/`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('uninstall removes the local-runtime hooks and keeps the shared runtime and the owner\'s own hooks; --all removes the runtime too', async () => {
  const { root, home } = allHostsProject();
  try {
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './scripts/owner-check.sh' }] }] } }, null, 2));
    await install(installOptions(root, home));
    assert.ok(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8').includes('/.marrow/runtime/'));
    const preview = await uninstall({ cwd: root, home, yes: false });
    assert.equal(preview.uninstall.runtime, null);
    assert.equal(fs.existsSync(path.join(home, '.marrow', 'runtime')), true);
    const done = await uninstall({ cwd: root, home, yes: true });
    // Other projects on this machine may still use the shared runtime: a project uninstall keeps it.
    assert.equal(done.uninstall.runtime, null);
    assert.equal(done.uninstall.runtime_kept, path.join(home, '.marrow', 'runtime'));
    assert.ok(verifyMcpRuntime(home, PIN, PINS.MCP_ADAPTER_INTEGRITY));
    const allPreview = await uninstall({ cwd: root, home, yes: false, all: true });
    assert.equal(allPreview.uninstall.runtime.would_remove, true);
    assert.equal(fs.existsSync(path.join(home, '.marrow', 'runtime')), true);
    const all = await uninstall({ cwd: root, home, yes: true, all: true });
    assert.equal(all.uninstall.runtime.removed, true);
    assert.equal(fs.existsSync(path.join(home, '.marrow', 'runtime')), false);
    assert.equal(parseArgs(['uninstall', '--all', '--yes']).all, true);
    assert.throws(() => parseArgs(['--repair', '--all']), /--all is only valid with uninstall/);
    const settings = fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8');
    assert.equal(settings.includes('@getmarrow/mcp'), false);
    assert.equal(settings.includes('/.marrow/runtime/'), false);
    assert.ok(settings.includes('./scripts/owner-check.sh'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// A stand-in npm-cli.js next to a node binary: it records how it was started and installs the
// stand-in package. Anything named npm/npx on PATH or in the working directory must not run.
function fakeNpmCli(binDir, { windows = false } = {}) {
  const cliDir = windows ? path.join(binDir, 'node_modules', 'npm', 'bin') : path.join(binDir, '..', 'lib', 'node_modules', 'npm', 'bin');
  fs.mkdirSync(cliDir, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(binDir, 'node'));
  const argsLog = path.join(binDir, 'args.json');
  fs.writeFileSync(path.join(cliDir, 'npm-cli.js'), [
    "const fs = require('fs'); const path = require('path');",
    `fs.writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), npm_env: Object.keys(process.env).filter((k) => /^npm_/i.test(k)).sort(), ignore: process.env.npm_config_ignore_scripts }));`,
    "const stage = process.cwd();",
    "const version = process.argv.find((a) => a.startsWith('@getmarrow/mcp@')).slice('@getmarrow/mcp@'.length);",
    "const mcp = path.join(stage, 'node_modules', '@getmarrow', 'mcp'); const sdk = path.join(stage, 'node_modules', '@getmarrow', 'sdk');",
    "fs.mkdirSync(path.join(mcp, 'dist'), { recursive: true }); fs.mkdirSync(sdk, { recursive: true });",
    "fs.writeFileSync(path.join(mcp, 'package.json'), JSON.stringify({ name: '@getmarrow/mcp', version, bin: { 'marrow-mcp': 'dist/cli.js' } }));",
    `fs.writeFileSync(path.join(mcp, 'dist', 'cli.js'), ${JSON.stringify(FAKE_CLI)});`,
    `fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: '@getmarrow/sdk', version: ${JSON.stringify(PINS.SDK_ADAPTER_VERSION)} }));`,
    `fs.writeFileSync(path.join(stage, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/@getmarrow/mcp': { version, integrity: ${JSON.stringify(PINS.MCP_ADAPTER_INTEGRITY)} }, 'node_modules/@getmarrow/sdk': { version: ${JSON.stringify(PINS.SDK_ADAPTER_VERSION)}, integrity: ${JSON.stringify(PINS.SDK_ADAPTER_INTEGRITY)} } } }));`,
  ].join('\n'));
  return { node: path.join(binDir, 'node'), argsLog };
}

test('the default installer path runs node + npm-cli.js (no shell, no npm on PATH) with --ignore-scripts and without npm env overrides', () => {
  const home = deadRegistryHome(tempDir('marrow-runtime-npm-home-'));
  const bin = path.join(tempDir('marrow-runtime-npm-prefix-'), 'bin');
  fs.mkdirSync(bin);
  const shimDir = tempDir('marrow-runtime-npm-shim-');
  const { node, argsLog } = fakeNpmCli(bin);
  for (const name of ['npm', 'npx']) fs.writeFileSync(path.join(shimDir, name), `#!/bin/sh\n: > ${JSON.stringify(path.join(home, `shim-${name}`))}\nexit 1\n`, { mode: 0o755 });
  const saved = { PATH: process.env.PATH, npm_config_registry: process.env.npm_config_registry, NPM_CONFIG_PREFIX: process.env.NPM_CONFIG_PREFIX, npm_config_userconfig: process.env.npm_config_userconfig };
  process.env.PATH = `${shimDir}:${saved.PATH}`;
  process.env.npm_config_registry = 'http://127.0.0.1:9/';
  process.env.NPM_CONFIG_PREFIX = shimDir;
  process.env.npm_config_userconfig = path.join(shimDir, 'npmrc');
  try {
    const result = ensureMcpRuntime({ home, version: PIN, integrity: PINS.MCP_ADAPTER_INTEGRITY, sdk: { version: PINS.SDK_ADAPTER_VERSION, integrity: PINS.SDK_ADAPTER_INTEGRITY }, npmExecPath: node });
    assert.equal(result.state, 'installed', JSON.stringify(result));
    const log = JSON.parse(fs.readFileSync(argsLog, 'utf8'));
    assert.ok(log.args.includes('install') && log.args.includes('--ignore-scripts') && log.args.includes(`@getmarrow/mcp@${PIN}`), log.args.join(' '));
    assert.ok(log.args.includes(`--prefix=${log.cwd}`), 'npm installs into the private stage');
    assert.ok(log.cwd.startsWith(path.join(home, '.marrow', 'runtime', 'mcp', '.stage-')), log.cwd);
    assert.deepEqual(log.npm_env, ['npm_config_audit', 'npm_config_fund', 'npm_config_ignore_scripts', 'npm_config_update_notifier'], 'registry, prefix and userconfig overrides are removed');
    assert.equal(log.ignore, 'true');
    assert.equal(fs.existsSync(path.join(home, 'shim-npm')) || fs.existsSync(path.join(home, 'shim-npx')), false);
    assert.notEqual(verifyMcpRuntime(home, PIN, PINS.MCP_ADAPTER_INTEGRITY), null);
    assert.deepEqual(npmInvocation({ platform: 'linux', execPath: node }).file, node);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(path.dirname(bin), { recursive: true, force: true });
    fs.rmSync(shimDir, { recursive: true, force: true });
  }
});

test('Windows (simulated): node + npm-cli.js next to node.exe installs the copy; planted npx.cmd/npm.cmd never run; hooks start node on the launcher', () => {
  const home = deadRegistryHome(tempDir('marrow-runtime-win-home-'));
  const project = tempDir('marrow-runtime-win-project-');
  const bin = tempDir('marrow-runtime-win-bin-');
  const { node } = fakeNpmCli(bin, { windows: true });
  const shim = `#!/bin/sh\n: > "$HOME/shim-$(basename "$0")"\nexit 0\n`;
  for (const dir of [project, bin]) for (const name of ['npx.cmd', 'npm.cmd', 'npx', 'npm']) fs.writeFileSync(path.join(dir, name), shim, { mode: 0o755 });
  const cwd = process.cwd();
  try {
    process.chdir(project);
    // No npm-cli.js next to node: nothing is installed, and nothing on PATH is tried instead.
    assert.equal(npmInvocation({ platform: 'win32', execPath: path.join(home, 'node.exe') }), null);
    assert.deepEqual(ensureMcpRuntime({ home, version: PIN, integrity: PINS.MCP_ADAPTER_INTEGRITY, platform: 'win32', npmExecPath: path.join(home, 'node.exe') }), { state: 'failed', reason: 'npm_install_failed' });
    const result = ensureMcpRuntime({ home, version: PIN, integrity: PINS.MCP_ADAPTER_INTEGRITY, platform: 'win32', npmExecPath: node });
    assert.equal(result.state, 'installed', JSON.stringify(result));
    const dir = runtimeDir(home, PIN);
    assert.equal(fs.existsSync(path.join(dir, 'run')) || fs.existsSync(path.join(dir, 'node')), false, 'no sh script or link on Windows');
    assert.ok(verifyMcpRuntime(home, PIN, PINS.MCP_ADAPTER_INTEGRITY, { platform: 'win32' }));
    assert.deepEqual(fs.readdirSync(home).filter((name) => name.startsWith('shim-')), []);
    // The Windows hook spelling is shell-neutral (cmd, PowerShell and sh read it the same way);
    // here sh runs it from the project, which holds npx.cmd and npm.cmd shims.
    const command = localizeHookCommand(`npx -y --package=@getmarrow/mcp@${PIN} marrow-mcp claude-pre-action-hook`, PIN, { platform: 'win32' });
    assert.match(command, /^node -e "[^"%$`!\\]*" -- --package=@getmarrow\/mcp@\d+\.\d+\.\d+ marrow-mcp claude-pre-action-hook$/);
    const env = { HOME: home, USERPROFILE: home, PATH: `${project}:${bin}:/usr/bin:/bin` };
    const ran = spawnSync('/bin/sh', ['-c', command], { cwd: project, env, input: '{}', encoding: 'utf8', timeout: 30_000 });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(ran.stdout, '{"local":true}');
    fs.rmSync(path.join(home, '.marrow'), { recursive: true, force: true });
    const held = spawnSync('/bin/sh', ['-c', command], { cwd: project, env, input: '{}', encoding: 'utf8', timeout: 30_000 });
    assert.equal(held.status, 2);
    assert.equal(held.stderr, `${HOLD_TEXT}\n`);
    assert.deepEqual(fs.readdirSync(home).filter((name) => name.startsWith('shim-')), []);
    // The installer writes that form for every plain hook when it runs on Windows.
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Claude\n');
    applyPlan(buildPlan(detectEnvironment(project, { HOME: home, PATH: process.env.PATH }), { mode: 'mcp', hookPlatform: 'win32' }), { yes: true, dryRun: false, doctor: false });
    const claudeText = fs.readFileSync(path.join(project, '.claude', 'settings.json'), 'utf8');
    assert.equal(hookTextUsesNpx(claudeText), false);
    const plain = marrowCommands(path.join(project, '.claude', 'settings.json'));
    assert.ok(plain.length >= 5 && plain.every((entry) => entry.startsWith('node -e "')), plain.join('\n').slice(0, 300));
  } finally {
    process.chdir(cwd);
    for (const directory of [home, project, bin]) fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('the local runtime is installed only on write runs; the old npx switch is ignored and hooks never go back to npx', async () => {
  assert.equal(parseArgs([], {}).mcpLocalRuntime, true);
  assert.equal(parseArgs([], { MARROW_LOCAL_RUNTIME: '0' }).mcpLocalRuntime, true);
  assert.equal(parseArgs([], { MARROW_LOCAL_RUNTIME: '0' }).localRuntimeSwitchIgnored, true);
  assert.equal(parseArgs(['--no-local-runtime'], {}).mcpLocalRuntime, true);
  assert.equal(parseArgs(['--no-local-runtime'], {}).localRuntimeSwitchIgnored, true);
  const { root, home } = allHostsProject();
  try {
    const calls = [];
    const preview = await install(installOptions(root, home, { yes: false, dryRun: true, mcpRuntimeInstall: fakeNpmInstall({ calls }) }));
    assert.deepEqual(calls, [], 'a dry run installs nothing');
    await install(installOptions(root, home, { yes: true, dryRun: true, mcpRuntimeInstall: fakeNpmInstall({ calls }) }));
    await install(installOptions(root, home, { yes: true, doctor: true, mcpRuntimeInstall: fakeNpmInstall({ calls }) }));
    assert.deepEqual(calls, [], 'neither a dry run nor doctor installs, even with --yes');
    assert.equal(preview.mcp_runtime.hooks_start, 'self_heal_on_next_start');
    assert.equal(fs.existsSync(path.join(home, '.marrow', 'runtime')), false);
    await install(installOptions(root, home));
    const claude = hookFiles(root, home).claude;
    const local = fs.readFileSync(claude, 'utf8');
    assert.ok(local.includes('/.marrow/runtime/'));
    // The old switch: ignored. The hooks stay in the local form and the report says so.
    const off = await install(installOptions(root, home, { mcpLocalRuntime: false, localRuntimeSwitchIgnored: true }));
    assert.equal(off.mcp_runtime.hooks_start, 'local_runtime');
    assert.equal(off.mcp_runtime.local_runtime_switch, 'ignored');
    assert.equal(fs.readFileSync(claude, 'utf8'), local);
    // A maintenance pass (the controller) keeps the local form, uses a verified copy, never installs.
    await install(installOptions(root, home, { maintenance: true }));
    assert.equal(fs.readFileSync(claude, 'utf8'), local, 'maintenance kept the local form');
    assert.equal(installer.maintenanceMcpRuntime(detectEnvironment(root, { HOME: home, PATH: process.env.PATH })).version, PIN);
    fs.rmSync(path.join(home, '.marrow', 'runtime'), { recursive: true, force: true });
    assert.equal(installer.maintenanceMcpRuntime(detectEnvironment(root, { HOME: home, PATH: process.env.PATH })), null);
    const maintenanceCalls = [];
    fs.rmSync(claude);
    await install(installOptions(root, home, { maintenance: true, mcpRuntimeInstall: fakeNpmInstall({ calls: maintenanceCalls }) }));
    assert.deepEqual(maintenanceCalls, []);
    // With no verified copy a repaired hook is still the local form: never npx.
    assert.equal(fs.readFileSync(claude, 'utf8'), local);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// MEDIUM-4 (round-3 audit): the controller's maintenance, run by the real sidecar at start and
// every 5 minutes, must keep hooks on the verified local runtime, and a hook it repairs is
// written in the local form too.
test('the real controller maintenance keeps every hook on the local runtime and repairs in the local form', { skip: process.platform !== 'linux' }, async () => {
  const { root, home } = allHostsProject();
  const stateDirectory = tempDir('marrow-runtime-controller-');
  const prior = { HOME: process.env.HOME, MARROW_SIDECAR_STATE_DIR: process.env.MARROW_SIDECAR_STATE_DIR };
  const options = {
    apiKey: 'test-controller-api-key', baseUrl: 'http://127.0.0.1:9', agentId: '', identityAgentId: 'runtime-maintain-fixture',
    client: 'claude-code', root, mode: 'mcp', profile: 'default', policy: 'warn',
  };
  try {
    await install(installOptions(root, home));
    const files = hookFiles(root, home);
    const before = Object.fromEntries(Object.entries(files).map(([host, filePath]) => [host, fs.readFileSync(filePath, 'utf8')]));
    for (const [host, text] of Object.entries(before)) assert.ok(text.includes(`/.marrow/runtime/mcp/${PIN}/node`), host);
    // A managed hook file the controller must repair.
    fs.rmSync(files.cursor);
    process.env.HOME = home;
    process.env.MARROW_SIDECAR_STATE_DIR = stateDirectory;
    await ensureCurrentGovernanceController(options);
    let maintenance = null;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      maintenance = (await controllerStatus(options)).maintenance;
      if (maintenance) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(maintenance, 'the controller ran its maintenance');
    // The local-runtime switch reaches the controller, so its maintenance honours it too.
    process.env.MARROW_LOCAL_RUNTIME = '0';
    assert.equal(cleanControllerEnv(options).MARROW_LOCAL_RUNTIME, '0');
    delete process.env.MARROW_LOCAL_RUNTIME;
    assert.equal(Object.hasOwn(cleanControllerEnv(options), 'MARROW_LOCAL_RUNTIME'), false);
    assert.ok(maintenance.repaired.length >= 1, JSON.stringify(maintenance));
    for (const [host, filePath] of Object.entries(files)) {
      const text = fs.readFileSync(filePath, 'utf8');
      assert.equal(text, before[host], `${host}: maintenance kept the local-runtime hooks byte for byte`);
      for (const command of marrowCommands(filePath)) assert.notEqual(delocalizeHookCommand(command), command, `${host}: ${command.slice(0, 80)}`);
    }
  } finally {
    await stopProjectControllers(options).catch(() => {});
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(stateDirectory, { recursive: true, force: true });
  }
});

// LOW-9 / LOW-8 / LOW-10 (round-3 audit): the runtime's guards, each pinned by a test.
test('runtime guards: unsafe paths, loose or linked directories and records, FIFO, link or world-writable entries, changed file set: held (self-heal offline), never npx', () => {
  const home = deadRegistryHome(tempDir('marrow-runtime-guards-'));
  const shimDir = tempDir('marrow-runtime-shim-');
  fs.writeFileSync(path.join(shimDir, 'npx'), '#!/bin/sh\nfor arg; do sub=$arg; done\n: > "$HOME/npx-$sub"\nprintf \'%s\' \'{"via":"npx"}\'\n', { mode: 0o755 });
  const options = (extra = {}) => ({ home, version: PIN, integrity: PINS.MCP_ADAPTER_INTEGRITY, npmInstall: fakeNpmInstall(), ...extra });
  const verify = () => verifyMcpRuntime(home, PIN, PINS.MCP_ADAPTER_INTEGRITY);
  const dir = runtimeDir(home, PIN);
  // The hook loader, as every hook form starts it (self-heal included: offline here).
  const start = (env = {}) => spawnSync(process.execPath, ['-e', loaderFor(runtimeConfig(PIN)), '--', `--package=@getmarrow/mcp@${PIN}`, 'marrow-mcp', 'claude-pre-action-hook'], {
    env: { HOME: home, PATH: `${shimDir}:/usr/bin:/bin`, ...env }, input: '{}', encoding: 'utf8', timeout: 30_000,
  });
  try {
    // LR14: a quote, a newline or a relative node path never reaches the run script.
    for (const nodePath of ["/opt/it's/node", '/opt/a\nb/node', 'bin/node']) {
      assert.deepEqual(ensureMcpRuntime(options({ nodePath })), { state: 'skipped', reason: 'unsafe_path' }, JSON.stringify(nodePath));
    }
    const quoted = path.join(home, "o'brien");
    fs.mkdirSync(quoted, { mode: 0o700 });
    assert.deepEqual(ensureMcpRuntime(options({ home: quoted })), { state: 'skipped', reason: 'unsafe_path' });
    // LR12: a runtime directory that is a link is refused, and nothing is written through it.
    const elsewhere = tempDir('marrow-runtime-elsewhere-');
    fs.mkdirSync(path.join(home, '.marrow'), { mode: 0o700 });
    fs.symlinkSync(elsewhere, path.join(home, '.marrow', 'runtime'));
    assert.deepEqual(ensureMcpRuntime(options()), { state: 'failed', reason: 'unsafe_directory' });
    assert.deepEqual(fs.readdirSync(elsewhere), []);
    fs.rmSync(path.join(home, '.marrow', 'runtime'));
    fs.rmSync(elsewhere, { recursive: true, force: true });
    // LR13: loose existing directories are tightened to 700.
    fs.mkdirSync(path.join(home, '.marrow', 'runtime', 'mcp'), { recursive: true });
    fs.chmodSync(path.join(home, '.marrow'), 0o755);
    fs.chmodSync(path.join(home, '.marrow', 'runtime'), 0o755);
    fs.chmodSync(path.join(home, '.marrow', 'runtime', 'mcp'), 0o775);
    assert.equal(ensureMcpRuntime(options()).state, 'installed');
    for (const directory of [path.join(home, '.marrow'), path.join(home, '.marrow', 'runtime'), path.join(home, '.marrow', 'runtime', 'mcp'), dir]) {
      assert.equal(fs.statSync(directory).mode & 0o777, 0o700, directory);
    }
    assert.ok(verify());
    const local = start();
    assert.equal(local.status, 0, local.stderr);
    assert.equal(local.stdout, '{"local":true}');

    // A copy installed for another integrity (another tarball) is not the pinned one.
    assert.equal(verifyMcpRuntime(home, PIN, fakeIntegrity('another tarball')), null);
    // LR3: a runtime directory others can read or enter is not trusted, by verify or by the
    // launcher on every start (which then holds).
    fs.chmodSync(dir, 0o750);
    assert.equal(verify(), null);
    assert.equal(start().status, 2);
    fs.chmodSync(dir, 0o700);
    assert.ok(verify());
    // LR28: a .verified others can read, or one that is a link, is not trusted.
    const record = path.join(dir, '.verified');
    fs.chmodSync(record, 0o644);
    assert.equal(verify(), null);
    const loose = start();
    assert.equal(loose.status, 2, 'the launcher holds on a loose record too');
    assert.equal(loose.stdout, '');
    fs.chmodSync(record, 0o600);
    fs.renameSync(record, `${record}.real`);
    fs.symlinkSync(`${record}.real`, record);
    assert.equal(verify(), null);
    fs.rmSync(record);
    fs.renameSync(`${record}.real`, record);
    assert.ok(verify());
    // LR6 / LR7: no launcher or run script is written: hooks carry the loader, so nothing in the
    // runtime directory is executed before verification except the captured node link.
    for (const name of ['launch.cjs', 'run']) assert.equal(fs.existsSync(path.join(dir, name)), false, name);
    // LR4 and LOW-8: an ADDED file (a shadow package or an extensionless twin) is a change, both
    // for verify and for the launcher on every start, which then holds (never npx).
    for (const added of [
      ['node_modules', '@getmarrow', 'mcp', 'node_modules', '@getmarrow', 'sdk', 'index.js'],
      ['node_modules', '@getmarrow', 'mcp', 'dist', 'cli'],
    ]) {
      const file = path.join(dir, ...added);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'module.exports = 1;\n');
      assert.equal(verify(), null, added.join('/'));
      const shadowed = start();
      assert.equal(shadowed.status, 2, shadowed.stderr);
      assert.equal(shadowed.stdout, '', added.join('/'));
      assert.equal(shadowed.stderr, `${HOLD_TEXT}\n`, added.join('/'));
      fs.rmSync(file);
      assert.ok(verify(), added.join('/'));
    }
    // LR16: when the copy is not trusted, the launcher holds a pre-action hook (exit 2) with no
    // stdout: never an empty success, which a failClosed host would read as allow.
    const failed = spawnSync(process.execPath, ['-e', loaderFor(runtimeConfig(PIN)), '--', '--package=@getmarrow/mcp@0.0.1', 'marrow-mcp', 'cursor-pre-action-hook'], {
      env: { HOME: home, PATH: '/nonexistent-marrow-path' }, input: '{}', encoding: 'utf8', timeout: 30_000,
    });
    assert.equal(failed.status, 2);
    assert.equal(failed.stdout, '');
    assert.equal(fs.readdirSync(home).some((name) => name.startsWith('npx-')), false, 'npx never ran');
    // Spec: no link, FIFO or world-writable entry is accepted, by verify or by the launcher.
    const pkg = path.join(dir, 'node_modules', '@getmarrow', 'mcp');
    const cases = [
      ['fifo', () => spawnSync('mkfifo', [path.join(pkg, 'dist', 'pipe')]), () => fs.rmSync(path.join(pkg, 'dist', 'pipe'))],
      ['symlink file', () => fs.symlinkSync(path.join(pkg, 'package.json'), path.join(pkg, 'dist', 'linked.json')), () => fs.rmSync(path.join(pkg, 'dist', 'linked.json'))],
      ['world-writable file', () => fs.chmodSync(path.join(pkg, 'package.json'), 0o666), () => fs.chmodSync(path.join(pkg, 'package.json'), 0o644)],
      ['world-writable dir', () => fs.chmodSync(path.join(pkg, 'dist'), 0o777), () => fs.chmodSync(path.join(pkg, 'dist'), 0o755)],
      ['symlinked node_modules', () => { fs.renameSync(path.join(dir, 'node_modules'), path.join(dir, 'nm-real')); fs.symlinkSync(path.join(dir, 'nm-real'), path.join(dir, 'node_modules')); },
        () => { fs.rmSync(path.join(dir, 'node_modules')); fs.renameSync(path.join(dir, 'nm-real'), path.join(dir, 'node_modules')); }],
    ];
    for (const [label, apply, undo] of cases) {
      const statBefore = fs.statSync(path.join(pkg, 'package.json')).mode & 0o777;
      apply();
      assert.equal(verify(), null, label);
      const held = start();
      assert.equal(held.status, 2, `${label}: ${held.stdout}`);
      assert.equal(held.stdout, '', label);
      undo();
      assert.ok(statBefore);
      assert.ok(verify(), `${label} restored`);
    }
    assert.equal(fs.readdirSync(home).some((name) => name.startsWith('npx-')), false, 'npx never ran');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(shimDir, { recursive: true, force: true });
  }
});

test('the runtime install waits at most 30 seconds for npm and says so first (LOW-10)', () => {
  assert.ok(NPM_INSTALL_TIMEOUT_MS <= 30_000);
  const home = tempDir('marrow-runtime-progress-');
  try {
    const events = [];
    const result = ensureMcpRuntime({
      home, version: PIN, integrity: PINS.MCP_ADAPTER_INTEGRITY,
      onProgress: (text) => events.push(['progress', text]),
      npmInstall: (stage, specs) => { events.push(['npm', specs.length]); return fakeNpmInstall()(stage, specs); },
    });
    assert.equal(result.state, 'installed');
    assert.equal(events[0][0], 'progress', 'the line comes before npm runs');
    assert.match(events[0][1], /^Installing a local copy of @getmarrow\/mcp@\d+\.\d+\.\d+ for Marrow's hooks \(up to 30 s; until it is installed, hooks install it themselves or hold protected actions\)\.\.\.\n$/);
    assert.equal(events[1][0], 'npm');
    // A present copy: no line, no npm.
    events.length = 0;
    assert.equal(ensureMcpRuntime({ home, version: PIN, integrity: PINS.MCP_ADAPTER_INTEGRITY, onProgress: (text) => events.push(text), npmInstall: () => { events.push('npm'); return false; } }).state, 'present');
    assert.deepEqual(events, []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Spec 4: hook files written by 0.1.68 or earlier start @getmarrow/mcp through npx (the plain
// layout, or the local forms with their npx fallback). Doctor reports each as needing repair, and
// a repair rewrites every one of them in the local form.
test('doctor reports 0.1.68 npx hook lines as needing repair, and repair rewrites them without npx', async () => {
  const { root, home } = allHostsProject();
  try {
    await install(installOptions(root, home));
    const files = hookFiles(root, home);
    const current = Object.fromEntries(Object.entries(files).map(([host, filePath]) => [host, fs.readFileSync(filePath, 'utf8')]));
    // The 0.1.68 npx layout: the same files with every command in its canonical form.
    const legacyPlain = (sub) => `/bin/sh -c 'M="$HOME/.marrow/runtime/mcp/${PIN}/run"; if [ -x "$M" ]; then exec "$M" --package=@getmarrow/mcp@${PIN} marrow-mcp ${sub}; fi; exec npx -y --package=@getmarrow/mcp@${PIN} marrow-mcp ${sub}'`;
    for (const [host, filePath] of Object.entries(files)) {
      const canonical = JSON.stringify(JSON.parse(current[host]), (key, value) => (key === 'command' ? delocalizeHookCommand(value) : value), 2);
      // Claude keeps one 0.1.66-0.1.68 local form with its npx fallback.
      const legacy = host === 'claude' ? canonical.split(JSON.stringify(`npx -y --package=@getmarrow/mcp@${PIN} marrow-mcp claude-pre-action-hook`)).join(JSON.stringify(legacyPlain('claude-pre-action-hook'))) : canonical;
      fs.writeFileSync(filePath, `${legacy}\n`);
      assert.ok(hookTextUsesNpx(legacy), host);
    }
    assert.equal(delocalizeHookCommand(legacyPlain('claude-pre-action-hook')), `npx -y --package=@getmarrow/mcp@${PIN} marrow-mcp claude-pre-action-hook`);
    const doctor = await install(installOptions(root, home, { yes: false, doctor: true }));
    assert.equal(doctor.mcp_runtime.needs_repair, true);
    assert.deepEqual([...doctor.mcp_runtime.legacy_npx_hooks].sort(), Object.values(files).sort());
    assert.equal(doctor.mcp_runtime.hooks_start, 'local_runtime');
    const lines = [];
    installer.printReport(doctor, (text) => lines.push(text));
    const printed = lines.join('');
    assert.match(printed, /needs repair: .*settings\.json still starts @getmarrow\/mcp through npx/);
    assert.match(printed, /repair: run npx -y @getmarrow\/install@latest --repair/);
    for (const [host, filePath] of Object.entries(files)) assert.ok(hookTextUsesNpx(fs.readFileSync(filePath, 'utf8')), `${host}: doctor changed nothing`);
    // The repair (an update run) rewrites every file back to the local form.
    const repaired = await install(installOptions(root, home, { repair: true }));
    assert.equal(repaired.mcp_runtime.needs_repair, false);
    assert.equal(repaired.mcp_runtime.legacy_npx_hooks, undefined);
    for (const [host, filePath] of Object.entries(files)) {
      const text = fs.readFileSync(filePath, 'utf8');
      assert.equal(hookTextUsesNpx(text), false, host);
      assert.equal(text, current[host], `${host}: the repair wrote the current local form`);
    }
    // The controller's maintenance repairs the npx layout the same way.
    fs.writeFileSync(files.codex, JSON.stringify(JSON.parse(current.codex), (key, value) => (key === 'command' ? delocalizeHookCommand(value) : value), 2));
    await install(installOptions(root, home, { maintenance: true }));
    assert.equal(fs.readFileSync(files.codex, 'utf8'), current.codex);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Cline hook scripts start the inline loader, never npx, and fail closed without a copy', () => {
  const root = tempDir('marrow-runtime-cline-');
  const home = deadRegistryHome(tempDir('marrow-runtime-cline-home-'));
  try {
    fs.mkdirSync(path.join(root, '.clinerules'));
    const detection = detectEnvironment(root, { HOME: home, PATH: process.env.PATH });
    applyPlan(buildPlan(detection, { mode: 'mcp', client: 'cline' }), { yes: true, dryRun: false, doctor: false });
    const pre = path.join(root, '.clinerules', 'hooks', 'PreToolUse');
    assert.ok(detection.cline && fs.existsSync(pre));
    const text = fs.readFileSync(pre, 'utf8');
    assert.equal(hookTextUsesNpx(text), false);
    assert.ok(text.includes(`{ N="$HOME/.marrow/runtime/mcp/${PIN}/node"; if [ ! -x "$N" ]; then`));
    assert.ok(text.includes(`/.source))+[])" -- --package=@getmarrow/mcp@${PIN} marrow-mcp cline-pre-action-hook;`));
    const shimDir = plantProject(root);
    const result = spawnSync(pre, [], { cwd: root, env: { HOME: home, PATH: `${shimDir}:${root}:${path.dirname(process.execPath)}:/usr/bin:/bin` }, input: '{}', encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /"cancel":true/);
    assertNothingPlantedRan(home);
    fs.rmSync(shimDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// Collision table (round 2): what reads as Marrow's own hook or server entry, and what the loader
// carries. Commands that differ anywhere in the loader's code, its configuration, the entrypoint
// or the surrounding shell are different; the same command written by another zlib build is not.
test('collisions: an edited loader, configuration, entrypoint or server entry is never Marrow\'s own; the canonical spelling carries no secret', () => {
  const zlib = require('node:zlib');
  const { launcherSource, loaderConfig, mcpServerLaunch, mcpServerLaunchVersion, mcpServerUsesNpx } = require('../src/mcp-runtime');
  const canonical = `npx -y --package=@getmarrow/mcp@${PIN} marrow-mcp claude-pre-action-hook`;
  const cfg = runtimeConfig(PIN);
  const pack = (source, params = {}) => zlib.brotliCompressSync(Buffer.from(source), { params }).toString('base64url');
  const loaderOf = (packed) => `eval(global.MARROW_L=require(/node:zlib/.source).brotliDecompressSync(Buffer.from(/${packed}/.source,/base64url/.source))+[])`;
  for (const platform of ['linux', 'win32']) {
    const local = localizeHookCommand(canonical, PIN, { platform });
    const loader = loaderFor(cfg);
    assert.ok(local.includes(loader));
    // The same code compressed differently (another zlib build) is still Marrow's own.
    const other = loaderOf(pack(launcherSource(cfg), { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 }));
    assert.notEqual(other, loader);
    assert.equal(delocalizeHookCommand(local.split(loader).join(other)), canonical, `${platform}: recompressed`);
    // Any change to the code it runs, even after a valid configuration line, is not.
    for (const edited of [
      launcherSource(cfg).replace('process.exitCode = pre ? 2 : 1;', 'process.exitCode = 0;'),
      `${launcherSource(cfg)}\n;require('child_process').execSync('true');`,
      launcherSource(cfg).replace('const NPM_TIMEOUT_MS = 30000;', 'const NPM_TIMEOUT_MS = 30001;'),
    ]) {
      assert.notEqual(edited, launcherSource(cfg));
      const swapped = local.split(loader).join(loaderOf(pack(edited)));
      assert.equal(delocalizeHookCommand(swapped), swapped, `${platform}: edited loader code`);
      assert.equal(loaderConfig(loaderOf(pack(edited))), null);
    }
    // Another integrity, another SDK pin or another version inside the loader: a different command
    // (it reads as Marrow's, and the installer rewrites it with the current target's).
    for (const changed of [runtimeConfig(PIN, { integrity: fakeIntegrity('evil') }), runtimeConfig(PIN, { sdk: null })]) {
      const commandFor = localizeHookCommand(canonical, PIN, { platform, ...changed });
      assert.notEqual(commandFor, local);
      assert.equal(delocalizeHookCommand(commandFor), canonical);
      assert.deepEqual(loaderConfig(loaderFor(changed)), changed);
    }
    const otherVersion = local.split(loader).join(loaderFor(runtimeConfig(AHEAD, { integrity: fakeIntegrity('ahead') })));
    assert.equal(delocalizeHookCommand(otherVersion), otherVersion, `${platform}: loader version differs from the command`);
    // A different entrypoint is a different canonical command.
    const context = localizeHookCommand(canonical.replace('claude-pre-action-hook', 'claude-context-hook'), PIN, { platform });
    assert.notEqual(delocalizeHookCommand(context), canonical);
    // No key, token or path in the command: only the version, integrity and SDK pin.
    assert.doesNotMatch(Buffer.from(loader.match(/\/([A-Za-z0-9_-]+)\/\.source,/)[1], 'base64url').toString('latin1'), /MARROW_API_KEY=|Bearer /);
    assert.equal(zlib.brotliDecompressSync(Buffer.from(loader.match(/\/([A-Za-z0-9_-]+)\/\.source,/)[1], 'base64url')).toString().includes('/home/'), false);
  }
  // Server entries: only the exact written form is Marrow's.
  for (const platform of ['linux', 'win32']) {
    const entry = mcpServerLaunch(PIN, { platform });
    assert.equal(mcpServerLaunchVersion(entry), PIN);
    assert.equal(mcpServerLaunchVersion({ ...entry, args: [...entry.args, '--extra'] }), null);
    assert.equal(mcpServerLaunchVersion({ ...entry, command: '/usr/bin/env' }), null);
    const swapped = entry.args.map((arg) => (arg.startsWith('eval(') ? loaderOf(pack(`${launcherSource(cfg)}\n;0`)) : arg));
    assert.equal(mcpServerLaunchVersion({ ...entry, args: swapped }), null);
    assert.equal(mcpServerUsesNpx({ mcpServers: { marrow: entry } }), false);
  }
  assert.equal(mcpServerUsesNpx({ mcpServers: { marrow: { command: 'npx', args: ['-y', `--package=@getmarrow/mcp@${PIN}`, 'marrow-mcp'] } } }), true);
  assert.equal(mcpServerUsesNpx({ mcpServers: { marrow: { command: 'C:\\nodejs\\npx.cmd', args: [`--package=@getmarrow/mcp@${PIN}`, 'marrow-mcp'] } } }), true);
});

test('a hook\'s self-heal never removes another version\'s runtime (another project may use it); the installer prunes as before', () => {
  const home = deadRegistryHome(tempDir('marrow-runtime-prune-'));
  const { runtimeCore } = require('../src/mcp-runtime');
  try {
    assert.equal(ensureMcpRuntime({ home, version: AHEAD, integrity: fakeIntegrity('ahead'), npmInstall: fakeNpmInstall({ integrity: fakeIntegrity('ahead') }) }).state, 'installed');
    const healed = runtimeCore.heal(runtimeConfig(PIN, { sdk: null }), home, { npmInstall: fakeNpmInstall() });
    assert.equal(healed.state, 'installed');
    assert.deepEqual(healed.removed_versions, []);
    assert.ok(verifyMcpRuntime(home, AHEAD, fakeIntegrity('ahead')), 'the other version is kept');
    assert.deepEqual(fs.readdirSync(path.join(home, '.marrow', 'runtime', 'mcp')).sort(), [PIN, AHEAD].sort());
    // A heal while another holds the lock does nothing.
    fs.rmSync(runtimeDir(home, PIN), { recursive: true, force: true });
    fs.mkdirSync(path.join(home, '.marrow', 'runtime', 'mcp', `.heal-${PIN}.lock`));
    assert.equal(runtimeCore.heal(runtimeConfig(PIN, { sdk: null }), home, { npmInstall: fakeNpmInstall() }).state, 'busy');
    assert.equal(fs.existsSync(runtimeDir(home, PIN)), false);
    // The installer's own install prunes other versions, as before.
    fs.rmSync(path.join(home, '.marrow', 'runtime', 'mcp', `.heal-${PIN}.lock`), { recursive: true });
    assert.deepEqual(ensureMcpRuntime({ home, version: PIN, integrity: PINS.MCP_ADAPTER_INTEGRITY, npmInstall: fakeNpmInstall() }).removed_versions, [AHEAD]);
    // A failed heal records why (no path, no key), and a later success clears it.
    const failed = runtimeCore.heal(runtimeConfig(AHEAD, { integrity: fakeIntegrity('ahead'), sdk: null }), home, { npmInstall: () => false });
    assert.equal(failed.reason, 'npm_install_failed');
    const mark = path.join(home, '.marrow', 'runtime', 'mcp', `.heal-${AHEAD}.failed`);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(mark, 'utf8'))).sort(), ['at', 'reason']);
    assert.equal(fs.statSync(mark).mode & 0o777, 0o600);
    assert.equal(runtimeCore.heal(runtimeConfig(AHEAD, { integrity: fakeIntegrity('ahead'), sdk: null }), home, { npmInstall: fakeNpmInstall({ integrity: fakeIntegrity('ahead') }) }).state, 'installed');
    assert.equal(fs.existsSync(mark), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('doctor flags an MCP server entry that starts npx (F-I1), and repair rewrites it to the verified runtime', async () => {
  const { root, home } = allHostsProject();
  try {
    await install(installOptions(root, home));
    const mcpJson = path.join(root, '.mcp.json');
    const cursorMcp = path.join(root, '.cursor', 'mcp.json');
    const written = { mcp: fs.readFileSync(mcpJson, 'utf8'), cursor: fs.readFileSync(cursorMcp, 'utf8') };
    for (const text of Object.values(written)) {
      const entry = JSON.parse(text).mcpServers.marrow;
      assert.equal(entry.command, '/bin/sh');
      assert.equal(entry.args.some((arg) => arg === 'npx' || /npx -y --package/.test(arg)), false);
    }
    for (const file of [mcpJson, cursorMcp]) {
      const config = JSON.parse(fs.readFileSync(file, 'utf8'));
      config.mcpServers.marrow = { ...config.mcpServers.marrow, command: 'npx', args: ['-y', `--package=@getmarrow/mcp@${PIN}`, 'marrow-mcp'] };
      fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    }
    const doctor = await install(installOptions(root, home, { yes: false, doctor: true }));
    assert.equal(doctor.mcp_runtime.needs_repair, true);
    assert.ok(doctor.mcp_runtime.legacy_npx_hooks.includes(mcpJson) && doctor.mcp_runtime.legacy_npx_hooks.includes(cursorMcp));
    await install(installOptions(root, home, { repair: true }));
    assert.equal(fs.readFileSync(mcpJson, 'utf8'), written.mcp);
    assert.equal(fs.readFileSync(cursorMcp, 'utf8'), written.cursor);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

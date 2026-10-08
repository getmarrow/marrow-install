require('./support/isolated-environment');
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
  NPM_INSTALL_TIMEOUT_MS,
  delocalizeHookCommand,
  ensureMcpRuntime,
  localizeHookCommand,
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
  const home = tempDir('marrow-runtime-home-');
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

test('every host\'s Marrow hook command maps to the local runtime and back exactly', () => {
  const { root, home } = allHostsProject();
  try {
    applyPlan(buildPlan(detectEnvironment(root, { HOME: home, PATH: process.env.PATH }), { mode: 'mcp' }), { yes: true, dryRun: false, doctor: false });
    let count = 0;
    for (const [host, filePath] of Object.entries(hookFiles(root, home))) {
      const commands = marrowCommands(filePath);
      assert.ok(commands.length > 0, host);
      for (const command of commands) {
        const local = localizeHookCommand(command, PIN);
        assert.notEqual(local, command, `${host}: ${command.slice(0, 80)}`);
        assert.ok(local.includes(`$HOME/.marrow/runtime/mcp/${PIN}/`), host);
        assert.equal(delocalizeHookCommand(local), command, host);
        assert.equal(localizeHookCommand(command, AHEAD), command, 'only the runtime\'s own version is switched');
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
    assert.equal(fs.statSync(path.join(dir, 'run')).mode & 0o777, 0o700);
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

test('a failed integrity check keeps hooks on npx; a changed or missing copy falls back to npx', async () => {
  const shimDir = tempDir('marrow-runtime-shim-');
  fs.writeFileSync(path.join(shimDir, 'npx'), '#!/bin/sh\nfor arg; do sub=$arg; done\n: > "$HOME/npx-$sub"\nprintf \'%s\' \'{"via":"npx"}\'\n', { mode: 0o755 });
  const { root, home } = allHostsProject();
  try {
    // The registry's tarball does not match the pin: no runtime, hooks stay on npx.
    const mismatch = await install(installOptions(root, home, { mcpRuntimeInstall: fakeNpmInstall({ integrity: fakeIntegrity('other') }) }));
    assert.equal(mismatch.mcp_runtime.state, 'failed');
    assert.equal(mismatch.mcp_runtime.reason, 'integrity_mismatch');
    assert.equal(mismatch.mcp_runtime.hooks_start, 'npx');
    assert.equal(fs.existsSync(runtimeDir(home, PIN)), false);
    const claude = hookFiles(root, home).claude;
    assert.equal(fs.readFileSync(claude, 'utf8').includes('/.marrow/runtime/'), false);
    const sdkMismatch = ensureMcpRuntime({ home, version: PIN, integrity: PINS.MCP_ADAPTER_INTEGRITY, sdk: { version: PINS.SDK_ADAPTER_VERSION, integrity: PINS.SDK_ADAPTER_INTEGRITY }, npmInstall: fakeNpmInstall({ sdkIntegrity: fakeIntegrity('sdk') }) });
    assert.equal(sdkMismatch.reason, 'sdk_integrity_mismatch');

    // A good copy, then one of its files changes: the hook starts through npx instead.
    await install(installOptions(root, home));
    const preAction = marrowCommands(claude).find((command) => command.includes('claude-pre-action-hook'));
    fs.appendFileSync(path.join(runtimeDir(home, PIN), 'node_modules', '@getmarrow', 'mcp', 'dist', 'cli.js'), '\n// changed\n');
    assert.equal(verifyMcpRuntime(home, PIN, PINS.MCP_ADAPTER_INTEGRITY), null);
    const changed = runHook(preAction, { HOME: home, PATH: `${shimDir}:/usr/bin:/bin` });
    assert.equal(changed.status, 0, changed.stderr);
    assert.equal(changed.stdout, '{"via":"npx"}');
    assert.equal(fs.existsSync(path.join(home, 'npx-claude-pre-action-hook')), true);
    assert.equal(fs.existsSync(path.join(home, 'local-claude-pre-action-hook')), false);
    // The next install replaces the changed copy.
    assert.equal((await install(installOptions(root, home))).mcp_runtime.state, 'installed');

    // The node binary captured at install is gone: the run script starts npx instead.
    const nodeDir = tempDir('marrow-runtime-node-');
    fs.symlinkSync(process.execPath, path.join(nodeDir, 'node'));
    fs.rmSync(path.join(home, '.marrow', 'runtime'), { recursive: true, force: true });
    assert.equal(ensureMcpRuntime({ home, version: PIN, integrity: PINS.MCP_ADAPTER_INTEGRITY, nodePath: path.join(nodeDir, 'node'), npmInstall: fakeNpmInstall() }).state, 'installed');
    fs.rmSync(nodeDir, { recursive: true, force: true });
    fs.rmSync(path.join(home, 'npx-claude-pre-action-hook'), { force: true });
    const noNode = runHook(preAction, { HOME: home, PATH: `${shimDir}:/usr/bin:/bin` });
    assert.equal(noNode.status, 0, noNode.stderr);
    assert.equal(noNode.stdout, '{"via":"npx"}');
    assert.equal(fs.existsSync(path.join(home, 'npx-claude-pre-action-hook')), true);

    // The copy is gone: npx again, from every kind of command.
    fs.rmSync(path.join(home, '.marrow', 'runtime'), { recursive: true, force: true });
    for (const host of ['claude', 'gemini', 'windsurf', 'cursor']) {
      for (const command of marrowCommands(hookFiles(root, home)[host]).filter((entry) => /pre-action-hook/.test(entry))) {
        const result = runHook(command, { HOME: home, PATH: `${shimDir}:${path.dirname(process.execPath)}:/usr/bin:/bin` });
        assert.notEqual(result.status, null, host);
      }
    }
    assert.equal(fs.existsSync(path.join(home, 'npx-gemini-pre-action-hook')), true);
    assert.equal(fs.existsSync(path.join(home, 'npx-cursor-pre-action-hook')), true);
  } finally {
    for (const directory of [root, home, shimDir]) fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('a new pin (update) gets its own runtime and older versions are removed', async () => {
  const { root, home } = allHostsProject();
  try {
    const old = ensureMcpRuntime({ home, version: '3.9.1', integrity: fakeIntegrity('old'), npmInstall: fakeNpmInstall({ integrity: fakeIntegrity('old') }) });
    assert.equal(old.state, 'installed');
    fs.mkdirSync(path.join(home, '.marrow', 'runtime', 'mcp', '.stage-3.9.2-1-abcd'));
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
    assert.ok(claude.includes(`/.marrow/runtime/mcp/${AHEAD}/run`));
    assert.equal(claude.includes(`/.marrow/runtime/mcp/${PIN}/`), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('uninstall removes the local-runtime hooks and the runtime, and keeps the owner\'s own hooks', async () => {
  const { root, home } = allHostsProject();
  try {
    fs.mkdirSync(path.join(root, '.claude'));
    fs.writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './scripts/owner-check.sh' }] }] } }, null, 2));
    await install(installOptions(root, home));
    assert.ok(fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8').includes('/.marrow/runtime/'));
    const preview = await uninstall({ cwd: root, home, yes: false });
    assert.equal(preview.uninstall.runtime.would_remove, true);
    assert.equal(fs.existsSync(path.join(home, '.marrow', 'runtime')), true);
    const done = await uninstall({ cwd: root, home, yes: true });
    assert.equal(done.uninstall.runtime.removed, true);
    assert.equal(fs.existsSync(path.join(home, '.marrow', 'runtime')), false);
    const settings = fs.readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8');
    assert.equal(settings.includes('@getmarrow/mcp'), false);
    assert.equal(settings.includes('/.marrow/runtime/'), false);
    assert.ok(settings.includes('./scripts/owner-check.sh'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('the default installer path runs npm with --ignore-scripts and verifies what it installed', () => {
  const home = tempDir('marrow-runtime-npm-home-');
  const bin = tempDir('marrow-runtime-npm-bin-');
  const argsLog = path.join(bin, 'args.json');
  const script = path.join(bin, 'fake-npm.js');
  fs.writeFileSync(script, [
    "const fs = require('fs'); const path = require('path');",
    `fs.writeFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)));`,
    "const stage = process.cwd();",
    "const version = process.argv.find((a) => a.startsWith('@getmarrow/mcp@')).slice('@getmarrow/mcp@'.length);",
    "const mcp = path.join(stage, 'node_modules', '@getmarrow', 'mcp'); const sdk = path.join(stage, 'node_modules', '@getmarrow', 'sdk');",
    "fs.mkdirSync(path.join(mcp, 'dist'), { recursive: true }); fs.mkdirSync(sdk, { recursive: true });",
    "fs.writeFileSync(path.join(mcp, 'package.json'), JSON.stringify({ name: '@getmarrow/mcp', version, bin: { 'marrow-mcp': 'dist/cli.js' } }));",
    `fs.writeFileSync(path.join(mcp, 'dist', 'cli.js'), ${JSON.stringify(FAKE_CLI)});`,
    `fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ name: '@getmarrow/sdk', version: ${JSON.stringify(PINS.SDK_ADAPTER_VERSION)} }));`,
    `fs.writeFileSync(path.join(stage, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/@getmarrow/mcp': { version, integrity: ${JSON.stringify(PINS.MCP_ADAPTER_INTEGRITY)} }, 'node_modules/@getmarrow/sdk': { version: ${JSON.stringify(PINS.SDK_ADAPTER_VERSION)}, integrity: ${JSON.stringify(PINS.SDK_ADAPTER_INTEGRITY)} } } }));`,
  ].join('\n'));
  fs.writeFileSync(path.join(bin, 'npm'), `#!/bin/sh\nexec '${process.execPath}' '${script}' "$@"\n`, { mode: 0o755 });
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  try {
    const result = ensureMcpRuntime({ home, version: PIN, integrity: PINS.MCP_ADAPTER_INTEGRITY, sdk: { version: PINS.SDK_ADAPTER_VERSION, integrity: PINS.SDK_ADAPTER_INTEGRITY } });
    assert.equal(result.state, 'installed', JSON.stringify(result));
    const args = JSON.parse(fs.readFileSync(argsLog, 'utf8'));
    assert.ok(args.includes('install') && args.includes('--ignore-scripts') && args.includes(`@getmarrow/mcp@${PIN}`), args.join(' '));
    assert.notEqual(verifyMcpRuntime(home, PIN, PINS.MCP_ADAPTER_INTEGRITY), null);
  } finally {
    process.env.PATH = previous;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  }
});

test('the local runtime is installed only on write runs, and the switch keeps hooks on npx', async () => {
  assert.equal(parseArgs([], {}).mcpLocalRuntime, true);
  assert.equal(parseArgs([], { MARROW_LOCAL_RUNTIME: '0' }).mcpLocalRuntime, false);
  assert.equal(parseArgs(['--no-local-runtime'], {}).mcpLocalRuntime, false);
  const { root, home } = allHostsProject();
  try {
    const calls = [];
    const preview = await install(installOptions(root, home, { yes: false, dryRun: true, mcpRuntimeInstall: fakeNpmInstall({ calls }) }));
    assert.deepEqual(calls, [], 'a dry run installs nothing');
    assert.equal(preview.mcp_runtime.hooks_start, 'npx');
    assert.equal(fs.existsSync(path.join(home, '.marrow', 'runtime')), false);
    await install(installOptions(root, home));
    const claude = hookFiles(root, home).claude;
    assert.ok(fs.readFileSync(claude, 'utf8').includes('/.marrow/runtime/'));
    // Switched off: every hook goes back to npx and the local copy is removed, so the
    // controller's maintenance cannot move hooks back onto it. A dry run removes nothing.
    await install(installOptions(root, home, { mcpLocalRuntime: false, yes: false, dryRun: true }));
    assert.equal(fs.existsSync(path.join(home, '.marrow', 'runtime')), true);
    const off = await install(installOptions(root, home, { mcpLocalRuntime: false }));
    assert.equal(off.mcp_runtime.state, 'disabled');
    assert.equal(fs.readFileSync(claude, 'utf8').includes('/.marrow/runtime/'), false);
    assert.equal(fs.existsSync(path.join(home, '.marrow', 'runtime')), false);
    assert.equal(installer.maintenanceMcpRuntime(detectEnvironment(root, { HOME: home, PATH: process.env.PATH })), null);
    await install(installOptions(root, home));
    // A maintenance pass (the controller) uses a verified copy but never installs one.
    assert.equal(installer.maintenanceMcpRuntime(detectEnvironment(root, { HOME: home, PATH: process.env.PATH })).version, PIN);
    assert.equal(installer.maintenanceMcpRuntime(detectEnvironment(root, { HOME: home, PATH: process.env.PATH }), { mcpLocalRuntime: false }), null);
    fs.rmSync(path.join(home, '.marrow', 'runtime'), { recursive: true, force: true });
    assert.equal(installer.maintenanceMcpRuntime(detectEnvironment(root, { HOME: home, PATH: process.env.PATH })), null);
    const maintenanceCalls = [];
    await install(installOptions(root, home, { maintenance: true, mcpRuntimeInstall: fakeNpmInstall({ calls: maintenanceCalls }) }));
    assert.deepEqual(maintenanceCalls, []);
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
    for (const [host, text] of Object.entries(before)) assert.ok(text.includes(`/.marrow/runtime/mcp/${PIN}/run`), host);
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
test('runtime guards: Windows, unsafe paths, loose or linked directories and records, changed launcher, run script or file set, and a failed npx spawn', () => {
  const home = tempDir('marrow-runtime-guards-');
  const shimDir = tempDir('marrow-runtime-shim-');
  fs.writeFileSync(path.join(shimDir, 'npx'), '#!/bin/sh\nfor arg; do sub=$arg; done\n: > "$HOME/npx-$sub"\nprintf \'%s\' \'{"via":"npx"}\'\n', { mode: 0o755 });
  const options = (extra = {}) => ({ home, version: PIN, integrity: PINS.MCP_ADAPTER_INTEGRITY, npmInstall: fakeNpmInstall(), ...extra });
  const verify = () => verifyMcpRuntime(home, PIN, PINS.MCP_ADAPTER_INTEGRITY);
  const dir = runtimeDir(home, PIN);
  const start = (env = {}) => spawnSync(path.join(dir, 'run'), [`--package=@getmarrow/mcp@${PIN}`, 'marrow-mcp', 'claude-pre-action-hook'], {
    env: { HOME: home, PATH: `${shimDir}:/usr/bin:/bin`, ...env }, input: '{}', encoding: 'utf8', timeout: 30_000,
  });
  try {
    // LR32: no runtime on Windows.
    assert.deepEqual(ensureMcpRuntime(options({ platform: 'win32' })), { state: 'unsupported', reason: 'windows' });
    assert.equal(fs.existsSync(path.join(home, '.marrow')), false);
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

    // LR3: a runtime directory others can read or enter is not trusted.
    fs.chmodSync(dir, 0o750);
    assert.equal(verify(), null);
    fs.chmodSync(dir, 0o700);
    assert.ok(verify());
    // LR28: a .verified others can read, or one that is a link, is not trusted.
    const record = path.join(dir, '.verified');
    fs.chmodSync(record, 0o644);
    assert.equal(verify(), null);
    fs.chmodSync(record, 0o600);
    fs.renameSync(record, `${record}.real`);
    fs.symlinkSync(`${record}.real`, record);
    assert.equal(verify(), null);
    fs.rmSync(record);
    fs.renameSync(`${record}.real`, record);
    assert.ok(verify());
    // LR6 / LR7: a changed launcher or run script is not trusted.
    for (const name of ['launch.cjs', 'run']) {
      const file = path.join(dir, name);
      const original = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, `${original}\n# changed\n`);
      assert.equal(verify(), null, name);
      fs.writeFileSync(file, original);
      assert.ok(verify(), name);
    }
    // LR4 and LOW-8: an ADDED file (a shadow package or an extensionless twin) is a change, both
    // for verify and for the launcher on every start, which then runs npx instead.
    for (const added of [
      ['node_modules', '@getmarrow', 'mcp', 'node_modules', '@getmarrow', 'sdk', 'index.js'],
      ['node_modules', '@getmarrow', 'mcp', 'dist', 'cli'],
    ]) {
      const file = path.join(dir, ...added);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'module.exports = 1;\n');
      assert.equal(verify(), null, added.join('/'));
      const shadowed = start();
      assert.equal(shadowed.status, 0, shadowed.stderr);
      assert.equal(shadowed.stdout, '{"via":"npx"}', added.join('/'));
      fs.rmSync(file);
      assert.ok(verify(), added.join('/'));
    }
    // LR16: when the copy is not trusted and npx cannot start, the launcher exits non-zero with
    // no output: never an empty success, which a failClosed host would read as allow.
    const failed = spawnSync(process.execPath, [path.join(dir, 'launch.cjs'), '--package=@getmarrow/mcp@0.0.1', 'marrow-mcp', 'cursor-pre-action-hook'], {
      env: { HOME: home, PATH: '/nonexistent-marrow-path' }, input: '{}', encoding: 'utf8', timeout: 30_000,
    });
    assert.notEqual(failed.status, 0);
    assert.equal(failed.stdout, '');
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
    assert.match(events[0][1], /^Installing a local copy of @getmarrow\/mcp@\d+\.\d+\.\d+ so hooks start faster \(up to 30 s; hooks keep using npx if it does not finish\)\.\.\.\n$/);
    assert.equal(events[1][0], 'npm');
    // A present copy: no line, no npm.
    events.length = 0;
    assert.equal(ensureMcpRuntime({ home, version: PIN, integrity: PINS.MCP_ADAPTER_INTEGRITY, onProgress: (text) => events.push(text), npmInstall: () => { events.push('npm'); return false; } }).state, 'present');
    assert.deepEqual(events, []);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

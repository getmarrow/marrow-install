require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');

const PINS = require('../src/pins');
const { HOLD_TEXT, localizeHookCommand, runtimeCore, runtimeDir, verifyMcpRuntime } = require('../src/mcp-runtime');

// Q5 (installer 0.1.74): a HOME behind a symlinked parent folder (macOS /var -> /private/var,
// Fedora Atomic /home -> /var/home). npm keys the stage lockfile by the stage's real path, so the
// stage now sits under the real path of ~/.marrow/runtime/mcp. Every check stays: the exact
// node_modules/@getmarrow/mcp key, the pinned integrity, private folders that are not links.

const PIN = PINS.MCP_ADAPTER_VERSION;
const STUB = path.join(__dirname, 'support', 'registry-stub.js');
const ALLOW_CLI = `#!/usr/bin/env node
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  require('fs').writeFileSync(require('path').join(process.env.HOME, 'genuine-' + process.argv[2]), input);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' }, genuine: true }));
});
`;

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
}

function packPackage(work, label, cli) {
  const dir = path.join(work, `pkg-${label}`);
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  const manifest = { name: '@getmarrow/mcp', version: PIN, bin: { 'marrow-mcp': 'dist/cli.js' } };
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'dist', 'cli.js'), cli, { mode: 0o755 });
  const out = path.join(work, `out-${label}`);
  fs.mkdirSync(out);
  const npm = runtimeCore.npmInvocation();
  const packed = spawnSync(npm.file, [...npm.args, 'pack', dir, '--pack-destination', out, '--ignore-scripts', '--loglevel=error'], { cwd: out, encoding: 'utf8', env: { ...process.env, npm_config_cache: path.join(work, 'pack-cache') } });
  assert.equal(packed.status, 0, packed.stderr);
  const tarball = path.join(out, fs.readdirSync(out).find((name) => name.endsWith('.tgz')));
  const manifestPath = path.join(work, `manifest-${label}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return { tarball, manifest: manifestPath, integrity: `sha512-${crypto.createHash('sha512').update(fs.readFileSync(tarball)).digest('base64')}` };
}

async function startRegistry(work, packages) {
  const configPath = path.join(work, `registry-${crypto.randomBytes(3).toString('hex')}.json`);
  const log = `${configPath}.log`;
  fs.writeFileSync(configPath, JSON.stringify({ packages }));
  fs.writeFileSync(log, '');
  const child = spawn(process.execPath, [STUB, configPath, log], { stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('\n')) resolve(Number(out.trim()));
    });
    child.on('error', reject);
  });
  return { url: `http://127.0.0.1:${port}/`, requests: () => fs.readFileSync(log, 'utf8').split('\n').filter(Boolean), stop: () => child.kill() };
}

// <work>/real/home is the home; <work>/link -> real, so HOME=<work>/link/home has a symlinked parent.
function linkedHome(work, registryUrl) {
  fs.mkdirSync(path.join(work, 'real', 'home'), { recursive: true, mode: 0o700 });
  fs.symlinkSync(path.join(work, 'real'), path.join(work, 'link'));
  const home = path.join(work, 'link', 'home');
  if (registryUrl) fs.writeFileSync(path.join(home, '.npmrc'), `registry=${registryUrl}\ncache=${path.join(work, 'npm-cache')}\nfetch-retries=0\n`, { mode: 0o600 });
  return { home, realHome: path.join(work, 'real', 'home') };
}

const hookEnv = (home) => ({ HOME: home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` });
const hook = (integrity, sub = 'claude-pre-action-hook') => localizeHookCommand(`npx -y --package=@getmarrow/mcp@${PIN} marrow-mcp ${sub}`, PIN, { platform: 'linux', integrity, sdk: null });
const EVENT = '{"tool_name":"Bash","tool_input":{"command":"git status"}}';
function runHook(command, cwd, env) {
  return spawnSync('/bin/sh', ['-c', command], { cwd, env, input: EVENT, encoding: 'utf8', timeout: 90_000 });
}
const lockKeys = (stageLock) => Object.keys(JSON.parse(fs.readFileSync(stageLock, 'utf8')).packages || {});

test('Q5: HOME behind a symlinked parent installs with the real npm (exact lock key, pinned integrity), and the hook self-heal under that HOME installs and allows', async () => {
  const work = tempDir('marrow-q5-');
  const genuine = packPackage(work, 'genuine', ALLOW_CLI);
  const registry = await startRegistry(work, { '@getmarrow/mcp': { [PIN]: genuine } });
  try {
    const { home, realHome } = linkedHome(work, registry.url);
    assert.notEqual(fs.realpathSync(home), home, 'the home really has a symlinked parent');
    const seen = [];
    const result = runtimeCore.ensure({
      home, version: PIN, integrity: genuine.integrity, sdk: null, env: hookEnv(home), prune: true,
      npmInstall: (stage, specs, options) => {
        seen.push(stage);
        const done = runtimeCore.npmInstall(stage, specs, options);
        seen.push(lockKeys(path.join(stage, 'package-lock.json')));
        return done;
      },
    });
    assert.equal(result.state, 'installed', JSON.stringify(result));
    assert.ok(seen[0].startsWith(path.join(realHome, '.marrow', 'runtime', 'mcp', '.stage-')), `stage under the real path: ${seen[0]}`);
    assert.deepEqual(seen[1], ['', 'node_modules/@getmarrow/mcp']);
    assert.ok(verifyMcpRuntime(home, PIN, genuine.integrity), 'verified through the linked path');
    assert.ok(verifyMcpRuntime(realHome, PIN, genuine.integrity), 'and through the real path (same folder)');
    assert.deepEqual(fs.readdirSync(path.join(realHome, '.marrow', 'runtime', 'mcp')), [PIN], 'no stage left');

    // The hook's own self-heal, in a second linked home with no ~/.marrow at all.
    const work2 = tempDir('marrow-q5-hook-');
    const second = linkedHome(work2, registry.url);
    const project = tempDir('marrow-q5-project-');
    const ran = runHook(hook(genuine.integrity), project, hookEnv(second.home));
    assert.equal(ran.status, 0, ran.stderr);
    assert.match(ran.stdout, /"permissionDecision":"allow"/);
    assert.match(ran.stdout, /"genuine":true/);
    assert.ok(verifyMcpRuntime(second.home, PIN, genuine.integrity));
    for (const dir of [work2, project]) fs.rmSync(dir, { recursive: true, force: true });
  } finally {
    registry.stop();
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('Q5: under a symlinked parent a tarball whose integrity is not the pin still fails (integrity_mismatch, a hold), nothing installed', async () => {
  const work = tempDir('marrow-q5-int-');
  const genuine = packPackage(work, 'genuine', ALLOW_CLI);
  const registry = await startRegistry(work, { '@getmarrow/mcp': { [PIN]: genuine } });
  try {
    const { home } = linkedHome(work, registry.url);
    const pin = `sha512-${crypto.createHash('sha512').update('another tarball').digest('base64')}`;
    const result = runtimeCore.ensure({ home, version: PIN, integrity: pin, sdk: null, env: hookEnv(home) });
    assert.deepEqual(result, { state: 'failed', reason: 'integrity_mismatch' });
    assert.ok(!runtimeCore.OUTAGE.includes(result.reason));
    assert.equal(fs.existsSync(runtimeDir(home, PIN)), false);
    const ran = runHook(hook(pin), tempDir('marrow-q5-p-'), hookEnv(home));
    assert.equal(ran.status, 2, ran.stderr);
    assert.equal(ran.stderr, `${HOLD_TEXT}\n`);
  } finally {
    registry.stop();
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('Q5: a lockfile whose only @getmarrow/mcp key is nested or relative (never matched by suffix) fails; nothing installed', () => {
  const work = tempDir('marrow-q5-lock-');
  const { home } = linkedHome(work, null);
  const integrity = `sha512-${crypto.createHash('sha512').update('pinned').digest('base64')}`;
  const shapes = [
    `../../../../private${home}/.marrow/runtime/mcp/.stage-x/node_modules/@getmarrow/mcp`,
    '../node_modules/@getmarrow/mcp',
    'node_modules/other/node_modules/@getmarrow/mcp',
    'node_modules/@getmarrow/mcp/',
    './node_modules/@getmarrow/mcp',
    'NODE_MODULES/@getmarrow/mcp',
  ];
  try {
    for (const key of shapes) {
      const install = (stage, specs) => {
        const mcp = path.join(stage, 'node_modules', '@getmarrow', 'mcp');
        fs.mkdirSync(path.join(mcp, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(mcp, 'package.json'), JSON.stringify({ name: '@getmarrow/mcp', version: PIN, bin: { 'marrow-mcp': 'dist/cli.js' } }));
        fs.writeFileSync(path.join(mcp, 'dist', 'cli.js'), ALLOW_CLI);
        fs.writeFileSync(path.join(stage, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, [key]: { version: PIN, integrity } } }));
        return specs.length > 0;
      };
      const result = runtimeCore.ensure({ home, version: PIN, integrity, sdk: null, npmInstall: install });
      assert.deepEqual(result, { state: 'failed', reason: 'integrity_mismatch' }, key);
      assert.equal(fs.existsSync(runtimeDir(home, PIN)), false, key);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('Q5: ~/.marrow, ~/.marrow/runtime or ~/.marrow/runtime/mcp that is itself a symlink is still refused (unsafe_directory, a hold); npm never runs and the target stays empty', () => {
  const integrity = `sha512-${crypto.createHash('sha512').update('pinned').digest('base64')}`;
  for (const depth of [1, 2, 3]) {
    const work = tempDir('marrow-q5-link-');
    try {
      const { home } = linkedHome(work, null);
      const parts = ['.marrow', 'runtime', 'mcp'].slice(0, depth);
      const elsewhere = path.join(work, 'elsewhere');
      fs.mkdirSync(elsewhere, { mode: 0o700 });
      if (depth > 1) fs.mkdirSync(path.join(home, ...parts.slice(0, -1)), { recursive: true, mode: 0o700 });
      fs.symlinkSync(elsewhere, path.join(home, ...parts));
      const result = runtimeCore.ensure({ home, version: PIN, integrity, sdk: null, npmInstall: () => assert.fail('npm ran through a linked private folder') });
      assert.deepEqual(result, { state: 'failed', reason: 'unsafe_directory' }, parts.join('/'));
      assert.ok(!runtimeCore.OUTAGE.includes(result.reason));
      assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing written through the link');
      const healed = runtimeCore.heal(runtimeCore.configOf(PIN, integrity, null), home, { npmInstall: () => assert.fail('heal ran npm') });
      assert.equal(healed.state, 'failed');
      assert.equal(healed.reason, 'unsafe_directory');
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }
});

test('Q5: realpath of the runtime root that throws, has a control character, or is not private holds (unsafe_directory, never an outage); npm never runs', () => {
  const integrity = `sha512-${crypto.createHash('sha512').update('pinned').digest('base64')}`;
  const work = tempDir('marrow-q5-real-');
  const open = path.join(work, 'open');
  fs.mkdirSync(open);
  fs.chmodSync(open, 0o777);
  const linkDir = path.join(work, 'linkdir');
  fs.symlinkSync(open, linkDir);
  const original = fs.realpathSync.native;
  try {
    const { home } = linkedHome(work, null);
    for (const [label, fake] of [
      ['throws', () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); }],
      ['newline', (target) => `${original(target)}\nx`],
      ['group/world writable', () => open],
      ['a symlink', () => linkDir],
      ['missing', () => path.join(work, 'missing')],
    ]) {
      fs.realpathSync.native = fake;
      const result = runtimeCore.ensure({ home, version: PIN, integrity, sdk: null, npmInstall: () => assert.fail(`npm ran (${label})`) });
      fs.realpathSync.native = original;
      assert.deepEqual(result, { state: 'failed', reason: 'unsafe_directory' }, label);
      assert.ok(!runtimeCore.OUTAGE.includes(result.reason), label);
    }
    assert.deepEqual(fs.readdirSync(open), []);
  } finally {
    fs.realpathSync.native = original;
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('Q5: a Unicode and long profile path behind a symlinked parent installs under the real path with the exact lock key', () => {
  const work = tempDir('marrow-q5-uni-');
  const real = path.join(work, 'José Müller 用户', 'p'.repeat(120));
  fs.mkdirSync(path.join(real, 'home'), { recursive: true, mode: 0o700 });
  fs.symlinkSync(real, path.join(work, 'link'));
  const home = path.join(work, 'link', 'home');
  const integrity = `sha512-${crypto.createHash('sha512').update('unicode').digest('base64')}`;
  const stages = [];
  try {
    const result = runtimeCore.ensure({
      home, version: PIN, integrity, sdk: null,
      npmInstall: (stage, specs) => {
        stages.push(stage);
        const mcp = path.join(stage, 'node_modules', '@getmarrow', 'mcp');
        fs.mkdirSync(path.join(mcp, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(mcp, 'package.json'), JSON.stringify({ name: '@getmarrow/mcp', version: PIN, bin: { 'marrow-mcp': 'dist/cli.js' } }));
        fs.writeFileSync(path.join(mcp, 'dist', 'cli.js'), ALLOW_CLI);
        fs.writeFileSync(path.join(stage, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/@getmarrow/mcp': { version: PIN, integrity } } }));
        return specs.length > 0;
      },
    });
    assert.equal(result.state, 'installed', JSON.stringify(result));
    assert.ok(stages[0].startsWith(path.join(real, 'home', '.marrow', 'runtime', 'mcp', '.stage-')));
    assert.ok(verifyMcpRuntime(home, PIN, integrity));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('Q5: a plain (real-path) HOME is unchanged: the stage is under ~/.marrow/runtime/mcp itself', () => {
  const work = tempDir('marrow-q5-plain-');
  const home = path.join(fs.realpathSync(work), 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  const integrity = `sha512-${crypto.createHash('sha512').update('pinned').digest('base64')}`;
  const stages = [];
  try {
    const result = runtimeCore.ensure({ home, version: PIN, integrity, sdk: null, npmInstall: (stage) => { stages.push(stage); return false; } });
    assert.deepEqual(result, { state: 'failed', reason: 'npm_install_failed' });
    assert.equal(path.dirname(stages[0]), path.join(home, '.marrow', 'runtime', 'mcp'));
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

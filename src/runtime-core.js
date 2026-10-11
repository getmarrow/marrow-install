'use strict';

// The one implementation of Marrow's private MCP runtime: verifying a copy, the private install,
// and the self-heal a hook runs when its verified copy is missing or changed. The installer calls
// it in process. The same function text is the loader every hook command carries inline (see
// loaderFor in mcp-runtime.js), so a hook on a machine with no ~/.marrow at all installs the
// pinned copy with exactly the installer's rules, and never reads the project or starts npx.
//
// Because its text is shipped inside hook commands, runtimeCore must stay self-contained: node:
// builtins only, no outer variables, no comments and no string spanning lines inside it.
//
// Install rules: npm runs as `node <npm-cli.js next to node>` (Windows: only that; POSIX: `npm`
// found on PATH as the hooks find node, never a relative entry or one inside the project, when no
// npm-cli.js exists), shell:false, --ignore-scripts, --no-bin-links, an explicit
// private --prefix stage that is also the working directory, every npm_* override removed, and
// the pinned sha512 integrity, version and entry checked before the stage is renamed into place.
// Self-heal: one lock per version (a directory created atomically), a detached child that does
// the install so a host timeout cannot kill it half way, a bounded wait in the hook, and a
// failure record so an offline machine answers at once instead of retrying on every call.
// Outage rule: when the heal fails for an outage (no npm, npm failed, the wait ran out), a
// pre-action hook warns and lets the action run (exit 1, as npx failing did before); any other
// failure (a tarball whose integrity does not match, an unsafe directory or package) holds it.
// No copy that is not verified ever runs in either case.
function runtimeCore() {
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  const cp = () => require('node:child_process');
  const SCHEMA = 'marrow-mcp-runtime.v2';
  const VERSION_RE = /^\d+\.\d+\.\d+$/;
  const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]{86}==$/;
  const SAFE_PATH_RE = /^[^\n\r\0]+$/;
  const NPM_TIMEOUT_MS = 30000;
  const STALE_MS = 300000;
  const LOCK_STALE_MS = 120000;
  const RETRY_MS = 300000;
  const PRE_RE = /-pre-action-hook$/;
  const REPAIR = 'The owner can repair it by running npx -y @getmarrow/install@latest --repair --cwd <project folder> from a terminal outside the project.';
  const HOLD = 'Marrow held this action: its verified local runtime could not start. ' + REPAIR;
  const UNAVAILABLE = 'Marrow could not start its verified local runtime. ' + REPAIR;
  const WARN = 'Marrow warning: it could not load its verified runtime, so this action was not checked. ' + REPAIR;
  const OUTAGE = ['npm_unavailable', 'npm_install_failed', 'heal_timeout'];
  const uid = () => (typeof process.getuid === 'function' ? process.getuid() : null);
  const rootOf = (home) => path.join(home, '.marrow', 'runtime', 'mcp');
  const dirOf = (home, version) => path.join(rootOf(home), version);
  const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const sdkPin = (sdk) => (sdk && VERSION_RE.test(String(sdk.version || '')) && INTEGRITY_RE.test(String(sdk.integrity || ''))
    ? { version: sdk.version, integrity: sdk.integrity } : null);
  const configOf = (version, integrity, sdk) => ({ version: String(version || ''), integrity: INTEGRITY_RE.test(String(integrity || '')) ? integrity : null, sdk: sdkPin(sdk) });
  function removeQuietly(target) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch {
      return false;
    }
    return true;
  }
  function ensurePrivateDirectory(directory) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
    }
    const stat = fs.lstatSync(directory);
    const me = uid();
    if (!stat.isDirectory() || stat.isSymbolicLink() || (me !== null && stat.uid !== me)) throw new Error('unsafe runtime directory ' + directory);
    if ((stat.mode & 0o077) !== 0) fs.chmodSync(directory, 0o700);
  }
  function ensurePrivateRoot(home) {
    ensurePrivateDirectory(path.join(home, '.marrow'));
    ensurePrivateDirectory(path.dirname(rootOf(home)));
    ensurePrivateDirectory(rootOf(home));
  }
  function privateDirectoryOk(directory, platform) {
    try {
      const stat = fs.lstatSync(directory);
      const me = uid();
      return stat.isDirectory() && !stat.isSymbolicLink() && (me === null || stat.uid === me) && (platform === 'win32' || (stat.mode & 0o077) === 0);
    } catch {
      return false;
    }
  }
  function listFiles(base, relative, platform) {
    const out = [];
    for (const name of fs.readdirSync(path.join(base, relative)).sort(byName)) {
      const rel = relative ? relative + '/' + name : name;
      if (rel === 'node_modules/.bin') continue;
      const stat = fs.lstatSync(path.join(base, rel));
      if (platform !== 'win32' && (stat.mode & 0o002) !== 0) throw new Error('world-writable entry in runtime package: ' + rel);
      if (stat.isDirectory()) out.push(...listFiles(base, rel, platform));
      else if (stat.isFile()) out.push(rel);
      else throw new Error('unexpected entry in runtime package: ' + rel);
    }
    return out;
  }
  function packageFiles(directory, platform) {
    if (!fs.lstatSync(path.join(directory, 'node_modules')).isDirectory()) throw new Error('runtime node_modules is not a directory');
    return listFiles(directory, 'node_modules', platform).filter((file) => file !== 'node_modules/.package-lock.json');
  }
  function manifestDigest(directory, files) {
    const hash = crypto.createHash('sha256');
    for (const file of files) {
      hash.update(file);
      hash.update(Buffer.alloc(1));
      hash.update(fs.readFileSync(path.join(directory, file)));
      hash.update(Buffer.alloc(1));
    }
    return hash.digest('hex');
  }
  function readRecord(directory, platform) {
    try {
      const stat = fs.lstatSync(path.join(directory, '.verified'));
      const me = uid();
      if (!stat.isFile() || (me !== null && stat.uid !== me) || (platform !== 'win32' && (stat.mode & 0o077) !== 0)) return null;
      const record = JSON.parse(fs.readFileSync(path.join(directory, '.verified'), 'utf8'));
      return record && record.schema === SCHEMA ? record : null;
    } catch {
      return null;
    }
  }
  function verify(home, version, integrity, options) {
    const platform = (options && options.platform) || process.platform;
    if (!home || !VERSION_RE.test(String(version || '')) || !INTEGRITY_RE.test(String(integrity || ''))) return null;
    const directory = dirOf(home, version);
    const dirs = [path.join(home, '.marrow'), path.dirname(rootOf(home)), rootOf(home), directory];
    if (!dirs.every((dir) => privateDirectoryOk(dir, platform))) return null;
    const record = readRecord(directory, platform);
    if (!record || record.version !== version || record.integrity !== integrity) return null;
    if (typeof record.bin !== 'string' || !Array.isArray(record.files) || !record.files.includes(record.bin)) return null;
    try {
      const files = packageFiles(directory, platform);
      if (JSON.stringify(files) !== JSON.stringify(record.files)) return null;
      if (manifestDigest(directory, files) !== record.manifest_sha256) return null;
    } catch {
      return null;
    }
    const result = { state: 'verified', version, directory, bin: path.join(directory, record.bin) };
    return platform === 'win32' ? result : { ...result, node: path.join(directory, 'node') };
  }
  function npmInvocation(options) {
    const platform = (options && options.platform) || process.platform;
    const execPath = (options && options.execPath) || process.execPath;
    const bin = path.dirname(execPath);
    const candidates = platform === 'win32'
      ? [path.join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
      : [path.join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), '/usr/share/nodejs/npm/bin/npm-cli.js', '/usr/lib/node_modules/npm/bin/npm-cli.js'];
    for (const cli of candidates) {
      try {
        if (fs.statSync(cli).isFile()) return { file: execPath, args: [cli] };
      } catch {
        continue;
      }
    }
    if (platform === 'win32') return null;
    const env = (options && options.env) || process.env;
    const project = [String(env.PWD || process.cwd())];
    try {
      project.push(fs.realpathSync(project[0]));
    } catch {
      project.push(project[0]);
    }
    const inside = (dir) => project.some((root) => !path.isAbsolute(root) || dir === root || dir.startsWith(root.replace(/\/+$/, '') + '/'));
    const dirs = [];
    for (const dir of [...String(env.PATH || '').split(':'), '/usr/local/bin', '/opt/homebrew/bin']) {
      if (!path.isAbsolute(dir) || inside(dir)) continue;
      try {
        if (inside(fs.realpathSync(dir))) continue;
      } catch {
        continue;
      }
      dirs.push(dir);
    }
    for (const dir of dirs) {
      try {
        const file = path.join(dir, 'npm');
        const real = fs.realpathSync(file);
        const stat = fs.statSync(real);
        if (!stat.isFile() || (stat.mode & 0o111) === 0 || inside(real)) continue;
        return /\.js$/.test(real) ? { file: execPath, args: [real], path: dirs.join(':') } : { file: real, args: [], path: dirs.join(':') };
      } catch {
        continue;
      }
    }
    return null;
  }
  function npmEnvironment(source) {
    const env = {};
    for (const [key, value] of Object.entries(source || process.env)) {
      if (/^npm_/i.test(key)) continue;
      env[key] = value;
    }
    return { ...env, npm_config_ignore_scripts: 'true', npm_config_update_notifier: 'false', npm_config_audit: 'false', npm_config_fund: 'false' };
  }
  function npmInstall(stage, specs, options) {
    const npm = npmInvocation(options);
    if (!npm) return 'npm_unavailable';
    const timeout = Math.max(1000, Math.min(NPM_TIMEOUT_MS, Number((options && options.timeout) || NPM_TIMEOUT_MS)));
    const env = npmEnvironment((options && options.env) || process.env);
    const result = cp().spawnSync(npm.file, [...npm.args, 'install', '--no-audit', '--no-fund', '--ignore-scripts', '--no-bin-links', '--loglevel=error', '--prefix=' + stage, ...specs], {
      cwd: stage,
      env: npm.path ? { ...env, PATH: npm.path } : env,
      stdio: ['ignore', 'ignore', 'pipe'],
      maxBuffer: 1 << 20,
      timeout,
      windowsHide: true,
      shell: false,
    });
    if (result.status === 0) return true;
    return /EINTEGRITY/.test(String(result.stderr || '')) ? 'integrity_mismatch' : false;
  }
  function removeOtherRuntimes(home, keep) {
    const root = rootOf(home);
    const removed = [];
    let entries = [];
    try {
      entries = fs.readdirSync(root);
    } catch {
      return removed;
    }
    for (const entry of entries) {
      if (entry === keep) continue;
      if (entry.startsWith('.stage-') || entry.startsWith('.heal-')) {
        try {
          if (Date.now() - fs.lstatSync(path.join(root, entry)).mtimeMs < STALE_MS) continue;
        } catch {
          continue;
        }
      }
      removeQuietly(path.join(root, entry));
      removed.push(entry);
    }
    return removed;
  }
  function ensure(options) {
    const { home, version, integrity, sdk = null, nodePath = process.execPath, npmExecPath = process.execPath, onProgress = null, prune = true } = options || {};
    const platform = (options && options.platform) || process.platform;
    const install = (options && options.npmInstall) || npmInstall;
    const windows = platform === 'win32';
    if (!home || !VERSION_RE.test(String(version || '')) || !INTEGRITY_RE.test(String(integrity || ''))) return { state: 'skipped', reason: 'no_verified_integrity' };
    const pruned = () => (prune ? removeOtherRuntimes(home, version) : []);
    const existing = verify(home, version, integrity, { platform });
    if (existing) return { ...existing, state: 'present', removed_versions: pruned() };
    const directory = dirOf(home, version);
    if (!windows && (!SAFE_PATH_RE.test(directory) || !SAFE_PATH_RE.test(String(nodePath || '')) || !path.isAbsolute(String(nodePath || '')))) return { state: 'skipped', reason: 'unsafe_path' };
    let stage = null;
    try {
      ensurePrivateRoot(home);
      stage = path.join(rootOf(home), '.stage-' + version + '-' + process.pid + '-' + crypto.randomBytes(4).toString('hex'));
      fs.mkdirSync(stage, { mode: 0o700 });
      const dependencies = { '@getmarrow/mcp': version };
      const pin = sdkPin(sdk);
      if (sdk && VERSION_RE.test(String(sdk.version || ''))) dependencies['@getmarrow/sdk'] = sdk.version;
      fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify({ name: 'marrow-mcp-runtime', private: true, dependencies }, null, 2) + '\n', { mode: 0o600 });
      const specs = Object.entries(dependencies).map(([name, spec]) => name + '@' + spec);
      if (typeof onProgress === 'function') onProgress('Installing a local copy of @getmarrow/mcp@' + version + ' for Marrow\'s hooks (up to ' + NPM_TIMEOUT_MS / 1000 + ' s; until it is installed, hooks install it themselves or hold protected actions)...\n');
      const installed = install(stage, specs, { platform, execPath: npmExecPath, timeout: options && options.timeout });
      if (!installed || typeof installed === 'string') return { state: 'failed', reason: installed || 'npm_install_failed' };
      const lock = JSON.parse(fs.readFileSync(path.join(stage, 'package-lock.json'), 'utf8'));
      const packages = lock && typeof lock.packages === 'object' && lock.packages ? lock.packages : {};
      const mcp = packages['node_modules/@getmarrow/mcp'] || {};
      if (mcp.version !== version || mcp.integrity !== integrity) return { state: 'failed', reason: 'integrity_mismatch' };
      const sdkEntry = packages['node_modules/@getmarrow/sdk'];
      if (sdk && sdkEntry && sdkEntry.version === sdk.version && sdkEntry.integrity !== sdk.integrity) return { state: 'failed', reason: 'sdk_integrity_mismatch' };
      for (const [key, entry] of Object.entries(packages)) {
        if (key === '') continue;
        if (!entry || typeof entry.integrity !== 'string' || !/^sha512-/.test(entry.integrity)) return { state: 'failed', reason: 'unverified_dependency' };
      }
      const manifest = JSON.parse(fs.readFileSync(path.join(stage, 'node_modules', '@getmarrow', 'mcp', 'package.json'), 'utf8'));
      if (manifest.name !== '@getmarrow/mcp' || manifest.version !== version) return { state: 'failed', reason: 'package_mismatch' };
      const binRelative = typeof manifest.bin === 'object' && manifest.bin ? manifest.bin['marrow-mcp'] : null;
      if (typeof binRelative !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(binRelative) || binRelative.includes('..')) return { state: 'failed', reason: 'package_entry_missing' };
      const bin = 'node_modules/@getmarrow/mcp/' + binRelative.replace(/^\.\//, '');
      let files;
      try {
        files = packageFiles(stage, platform);
      } catch {
        return { state: 'failed', reason: 'unsafe_package_entry' };
      }
      if (!files.includes(bin)) return { state: 'failed', reason: 'package_entry_missing' };
      if (!windows) fs.symlinkSync(nodePath, path.join(stage, 'node'));
      fs.writeFileSync(path.join(stage, '.verified'), JSON.stringify({
        schema: SCHEMA,
        version,
        integrity,
        sdk_pin: pin,
        sdk_version: sdkEntry ? sdkEntry.version : null,
        bin,
        files,
        manifest_sha256: manifestDigest(stage, files),
        installed_at: new Date().toISOString(),
      }, null, 2) + '\n', { mode: 0o600 });
      const raced = verify(home, version, integrity, { platform });
      if (raced) return { ...raced, state: 'present', removed_versions: pruned() };
      removeQuietly(directory);
      try {
        fs.renameSync(stage, directory);
      } catch (error) {
        const other = verify(home, version, integrity, { platform });
        if (other) return { ...other, state: 'present', removed_versions: pruned() };
        throw error;
      }
      stage = null;
      const verified = verify(home, version, integrity, { platform });
      if (!verified) return { state: 'failed', reason: 'verification_failed' };
      return { ...verified, state: 'installed', removed_versions: pruned() };
    } catch (error) {
      return { state: 'failed', reason: error && /unsafe runtime directory/.test(error.message) ? 'unsafe_directory' : 'install_error' };
    } finally {
      if (stage) removeQuietly(stage);
    }
  }
  const healPaths = (home, version) => ({ lock: path.join(rootOf(home), '.heal-' + version + '.lock'), mark: path.join(rootOf(home), '.heal-' + version + '.failed') });
  function failure(home, mark) {
    const none = { at: 0, reason: '' };
    try {
      const platform = process.platform;
      if (![path.join(home, '.marrow'), path.dirname(rootOf(home)), rootOf(home)].every((dir) => privateDirectoryOk(dir, platform))) return none;
      const stat = fs.lstatSync(mark);
      const me = uid();
      if (!stat.isFile() || (me !== null && stat.uid !== me) || (platform !== 'win32' && (stat.mode & 0o077) !== 0)) return none;
      const record = JSON.parse(fs.readFileSync(mark, 'utf8'));
      const at = Number(record.at) || 0;
      return at > Date.now() + 5000 ? none : { at, reason: String(record.reason || '') };
    } catch {
      return none;
    }
  }
  function lockBusy(lock) {
    try {
      return Date.now() - fs.lstatSync(lock).mtimeMs < LOCK_STALE_MS;
    } catch {
      return false;
    }
  }
  function heal(cfg, home, options) {
    if (!home || !VERSION_RE.test(cfg.version) || !INTEGRITY_RE.test(String(cfg.integrity || ''))) return { state: 'skipped', reason: 'no_verified_integrity' };
    const { lock, mark } = healPaths(home, cfg.version);
    try {
      ensurePrivateRoot(home);
    } catch {
      return { state: 'failed', reason: 'unsafe_directory' };
    }
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
    } catch (error) {
      if (!error || error.code !== 'EEXIST' || lockBusy(lock)) return { state: 'busy' };
      removeQuietly(lock);
      try {
        fs.mkdirSync(lock, { mode: 0o700 });
      } catch {
        return { state: 'busy' };
      }
    }
    try {
      const result = ensure({ ...(options || {}), home, version: cfg.version, integrity: cfg.integrity, sdk: cfg.sdk, nodePath: process.execPath, npmExecPath: process.execPath, prune: false });
      removeQuietly(mark);
      if (result.state !== 'installed' && result.state !== 'present') fs.writeFileSync(mark, JSON.stringify({ at: Date.now(), reason: String(result.reason || 'failed') }), { mode: 0o600, flag: 'wx' });
      return result;
    } finally {
      removeQuietly(lock);
    }
  }
  function budgetFor(sub) {
    if (sub === undefined) return 25000;
    if (!PRE_RE.test(String(sub))) return 0;
    return /^claude-/.test(sub) ? 45000 : /^cursor-/.test(sub) ? 12000 : 3500;
  }
  function sleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }
  function awaitHeal(cfg, home, sub, loader) {
    const held = { state: 'failed', outage: false };
    const outage = (reason) => ({ state: 'failed', outage: OUTAGE.includes(reason) });
    if (!VERSION_RE.test(cfg.version) || !INTEGRITY_RE.test(String(cfg.integrity || '')) || typeof loader !== 'string') return held;
    const { lock, mark } = healPaths(home, cfg.version);
    for (const dir of [path.join(home, '.marrow'), path.dirname(rootOf(home)), rootOf(home)]) {
      let stat = null;
      try {
        stat = fs.lstatSync(dir);
      } catch {
        stat = null;
      }
      const me = uid();
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink() || (me !== null && stat.uid !== me))) return held;
    }
    const started = Date.now();
    if (!lockBusy(lock)) {
      const last = failure(home, mark);
      if (started - last.at < RETRY_MS) return outage(last.reason);
      try {
        const child = cp().spawn(process.execPath, ['-e', loader, '--', '--marrow-heal', '--package=@getmarrow/mcp@' + cfg.version, 'marrow-mcp'], { cwd: home, env: { ...process.env, PWD: process.cwd() }, detached: true, stdio: 'ignore', windowsHide: true });
        child.on('error', () => {});
        child.unref();
      } catch {
        return held;
      }
    }
    const budget = budgetFor(sub);
    while (Date.now() - started < budget) {
      sleep(100);
      const runtime = verify(home, cfg.version, cfg.integrity);
      if (runtime) return runtime;
      const last = failure(home, mark);
      if (last.at >= started) return outage(last.reason);
    }
    return outage('heal_timeout');
  }
  function main(cfg, loader) {
    const args = process.argv.slice(1);
    const pre = args.some((arg) => PRE_RE.test(String(arg)));
    const spec = '--package=@getmarrow/mcp@' + cfg.version;
    const home = process.platform !== 'win32' && process.env.HOME ? process.env.HOME : require('node:os').homedir();
    if (args[0] === '--marrow-heal') {
      const result = args.length === 3 && args[1] === spec && args[2] === 'marrow-mcp' ? heal(cfg, home) : { state: 'skipped' };
      process.exitCode = result.state === 'installed' || result.state === 'present' ? 0 : 1;
      return;
    }
    let runtime = args[0] === spec && args[1] === 'marrow-mcp' ? verify(home, cfg.version, cfg.integrity) : null;
    if (!runtime && args[0] === spec && args[1] === 'marrow-mcp') runtime = awaitHeal(cfg, home, args[2], loader);
    if (!runtime || runtime.state !== 'verified') {
      const warn = pre && runtime && runtime.outage === true;
      process.stderr.write((warn ? WARN : pre ? HOLD : UNAVAILABLE) + '\n');
      process.exitCode = pre && !warn ? 2 : 1;
      return;
    }
    process.argv = [process.argv[0], runtime.bin, ...args.slice(2)];
    require(runtime.bin);
  }
  return { SCHEMA, HOLD, UNAVAILABLE, WARN, OUTAGE, NPM_TIMEOUT_MS, LOCK_STALE_MS, RETRY_MS, configOf, verify, ensure, heal, npmInvocation, npmEnvironment, npmInstall, removeOtherRuntimes, budgetFor, healPaths, main };
}

module.exports = { runtimeCore };

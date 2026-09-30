'use strict';

// Installer side of marrow-agentd (behind the MARROW_AGENTD=1 / --agentd feature flag in
// phase 1). Only the installer installs or updates the daemon:
//   1. copies the daemon code to ~/.marrow/agentd/lib/<version>/ and records a manifest digest
//   2. builds the native shim with absolute paths baked in (Node shim script if no compiler)
//      and pins its sha256 in config.json
//   3. writes config.json (0600), the systemd --user service and socket units
//   4. points the harness hooks at the shim (replacing the npx hook entries, keeping every
//      non-Marrow hook) and records each entry for the daemon's integrity check
//   5. removes inline MARROW_API_KEY values from MCP server configs; the key lives only in
//      ~/.marrow/env (0600), which only the daemon reads
// Every write is scoped to the `home` it is given; tests pass a scratch home.

const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AGENTD_VERSION, HARNESS_HOOK_TIMEOUT_MS, PRODUCTION_BASE_URL } = require('./constants');
const { CONFIG_SCHEMA } = require('./daemon');
const { ensurePrivateDir, sha256File, writeFileAtomic } = require('./fsutil');
const { manifestDigest } = require('./integrity');
const { agentdPaths } = require('./paths');

// Marrow-owned hook commands: the npx forms the MCP package and installer <=0.1.66 wrote, and
// this install's exact shim path. A user hook that merely mentions "marrow-hook" is kept.
const NPX_MARROW_HOOK = /^npx\s+(?:-y\s+)?(?:--package=@getmarrow\/mcp(?:@\S+)?\s+marrow-mcp|@getmarrow\/mcp(?:@\S+)?)\s+\S*hook\S*$/;
function isMarrowHookCommand(command, shimPath) {
  const text = String(command || '').trim();
  return NPX_MARROW_HOOK.test(text) || (Boolean(shimPath) && (text === shimPath || text.startsWith(`${shimPath} `) || text.startsWith(`${shellQuote(shimPath)} `)));
}
const PACKAGE_SRC = path.resolve(__dirname, '..');

const HOOK_EVENTS = {
  'claude-code': [
    { event: 'PreToolUse', arg: 'pre', matcher: '*' },
    { event: 'PostToolUse', arg: 'post', matcher: '*' },
    { event: 'PostToolUseFailure', arg: 'post-failure', matcher: '*' },
    { event: 'UserPromptSubmit', arg: 'prompt' },
    { event: 'Stop', arg: 'stop' },
    { event: 'SessionEnd', arg: 'session-end' },
  ],
  codex: [
    { event: 'PreToolUse', arg: 'pre', matcher: '.*', async: false },
    { event: 'PostToolUse', arg: 'post', matcher: '.*' },
    { event: 'UserPromptSubmit', arg: 'prompt' },
    { event: 'SessionEnd', arg: 'session-end' },
  ],
};

function shellQuote(value) {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function hookCommand(shimPath, harness, arg) {
  return `${shellQuote(shimPath)} ${harness} ${arg}`;
}

function buildPlan({ home, nodePath = process.execPath, version = AGENTD_VERSION, harnesses = [], baseUrl = PRODUCTION_BASE_URL, agentIds = {}, installId = null, hostname = 'host' }) {
  if (!home || !path.isAbsolute(home)) throw new Error('buildPlan requires an absolute home');
  const paths = agentdPaths(home);
  const libDir = path.join(paths.libDir, version);
  const hookEntry = path.join(libDir, 'src', 'agentd', 'hook-entry.js');
  const daemonMain = path.join(libDir, 'src', 'agentd', 'cli.js');
  const unitDir = path.join(home, '.config', 'systemd', 'user');
  const hooks = [];
  for (const target of harnesses) {
    for (const spec of HOOK_EVENTS[target.harness] || []) {
      hooks.push({ harness: target.harness, file: target.file, event: spec.event, arg: spec.arg, command: hookCommand(paths.shim, target.harness, spec.arg), matcher: spec.matcher, async: spec.async });
    }
  }
  const agents = {};
  for (const target of harnesses) agents[target.harness] = agentIds[target.harness] || `${target.harness}-${hostname}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64);
  return {
    home,
    paths,
    version,
    nodePath,
    libDir,
    hookEntry,
    daemonMain,
    unitDir,
    baseUrl,
    installId: installId || `inst_${crypto.randomBytes(16).toString('hex')}`,
    agents,
    hooks,
    harnesses,
    units: {
      'marrow-agentd.socket': systemdSocketUnit(paths),
      'marrow-agentd.service': systemdServiceUnit({ nodePath, daemonMain, home }),
    },
  };
}

function systemdSocketUnit(paths) {
  return [
    '[Unit]',
    'Description=Marrow local agent daemon socket',
    '',
    '[Socket]',
    `ListenStream=${paths.socket}`,
    'SocketMode=0600',
    'DirectoryMode=0700',
    'RemoveOnStop=true',
    '',
    '[Install]',
    'WantedBy=sockets.target',
    '',
  ].join('\n');
}

function systemdServiceUnit({ nodePath, daemonMain, home }) {
  return [
    '[Unit]',
    'Description=Marrow local agent daemon (marrow-agentd)',
    'Requires=marrow-agentd.socket',
    'After=marrow-agentd.socket network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${nodePath} ${daemonMain} run --home ${home} --socket-activation`,
    'Restart=always',
    'RestartSec=1',
    'UMask=0077',
    'NoNewPrivileges=true',
    'LimitNOFILE=4096',
    'MemoryMax=256M',
    // The service environment is fixed here; the daemon reads no MARROW_* variable anyway.
    'Environment=PATH=/usr/bin:/bin LANG=C',
    'UnsetEnvironment=MARROW_API_KEY MARROW_KEY MARROW_BASE_URL NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS NODE_TLS_REJECT_UNAUTHORIZED SSL_CERT_FILE SSL_CERT_DIR LD_PRELOAD LD_LIBRARY_PATH',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function copyTree(source, destination, manifest, base) {
  ensurePrivateDir(destination);
  for (const name of fs.readdirSync(source).sort()) {
    const from = path.join(source, name);
    const to = path.join(destination, name);
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) { copyTree(from, to, manifest, base); continue; }
    if (!/\.(?:js|c)$/.test(name)) continue;
    fs.copyFileSync(from, to);
    fs.chmodSync(to, 0o600);
    manifest.push(`${path.relative(base, to)} ${sha256File(to)}`);
  }
}

function findCompiler() {
  for (const cc of ['/usr/bin/cc', '/usr/bin/gcc', '/usr/bin/clang', '/usr/local/bin/cc']) {
    try { fs.accessSync(cc, fs.constants.X_OK); return cc; } catch { /* next */ }
  }
  return null;
}

function cString(value) {
  return JSON.stringify(String(value));
}

function buildShim(plan, { compile = true } = {}) {
  const { paths } = plan;
  ensurePrivateDir(paths.binDir);
  const temp = `${paths.shim}.${process.pid}.tmp`;
  const compiler = compile ? findCompiler() : null;
  let mode = 'node-script';
  if (compiler) {
    const source = path.join(plan.libDir, 'src', 'agentd', 'native', 'marrow-hook.c');
    const result = childProcess.spawnSync(compiler, [
      '-O2', '-Wall', '-Wextra', '-std=c11',
      `-DMARROW_SOCKET_DIR=${cString(paths.runDir)}`,
      `-DMARROW_NODE=${cString(plan.nodePath)}`,
      `-DMARROW_FALLBACK=${cString(plan.hookEntry)}`,
      `-DMARROW_HOME=${cString(plan.home)}`,
      '-o', temp, source,
    ], { encoding: 'utf8', timeout: 60000, env: { PATH: '/usr/bin:/bin' } });
    if (result.status === 0) mode = 'native';
  }
  if (mode !== 'native') {
    // Same fixed environment as the native shim: the agent's NODE_OPTIONS or MARROW_* never
    // reach the hook process.
    const script = `#!/bin/sh\nexec /usr/bin/env -i PATH=/usr/bin:/bin LANG=C ${shellQuote(plan.nodePath)} ${shellQuote(plan.hookEntry)} --home ${shellQuote(plan.home)} "$@"\n`;
    fs.writeFileSync(temp, script, { mode: 0o700 });
  }
  fs.chmodSync(temp, 0o700);
  fs.renameSync(temp, paths.shim);
  return { mode, sha256: sha256File(paths.shim) };
}

// Replaces Marrow-owned entries for each event and keeps every other hook untouched.
function mergeHookDocument(doc, harness, entries, shimPath = entries[0] && entries[0].command.split(' ')[0]) {
  const out = doc && typeof doc === 'object' && !Array.isArray(doc) ? { ...doc } : {};
  const hooks = out.hooks && typeof out.hooks === 'object' && !Array.isArray(out.hooks) ? { ...out.hooks } : {};
  const timeoutSeconds = Math.round((HARNESS_HOOK_TIMEOUT_MS[harness] || 5000) / 1000);
  for (const entry of entries) {
    const existing = Array.isArray(hooks[entry.event]) ? hooks[entry.event] : [];
    const kept = [];
    for (const group of existing) {
      if (!group || typeof group !== 'object' || !Array.isArray(group.hooks)) { kept.push(group); continue; }
      const others = group.hooks.filter((hook) => !(hook && typeof hook.command === 'string' && isMarrowHookCommand(hook.command, shimPath)));
      if (others.length) kept.push({ ...group, hooks: others });
    }
    const handler = { type: 'command', command: entry.command, timeout: timeoutSeconds };
    if (entry.async === false) handler.async = false;
    kept.push(entry.matcher ? { matcher: entry.matcher, hooks: [handler] } : { hooks: [handler] });
    hooks[entry.event] = kept;
  }
  out.hooks = hooks;
  return out;
}

// Removes inline Marrow keys from MCP server entries (top level and Claude Code per-project
// entries). Returns the cleaned document and the removed values; the caller stores one value
// in ~/.marrow/env if that file has no key yet. Values are never printed.
function stripInlineKeys(doc) {
  const removed = [];
  const clean = (servers) => {
    if (!servers || typeof servers !== 'object') return;
    for (const entry of Object.values(servers)) {
      if (!entry || typeof entry !== 'object') continue;
      const text = `${entry.command || ''} ${(Array.isArray(entry.args) ? entry.args : []).join(' ')} ${entry.url || ''}`;
      if (!/marrow/i.test(text)) continue;
      // Remote (HTTP/SSE) MCP entries can carry the key in a header.
      if (entry.headers && typeof entry.headers === 'object') {
        for (const name of Object.keys(entry.headers)) {
          if (!/^(?:authorization|x-api-key|x-marrow-key|x-marrow-api-key)$/i.test(name)) continue;
          const value = String(entry.headers[name] || '').replace(/^Bearer\s+/i, '');
          if (value && !/^\$\{[A-Z_][A-Z0-9_]*\}$/.test(value)) removed.push(value);
          delete entry.headers[name];
        }
      }
      // `--key <value>` / `--key=<value>` on argv (advertised by marrow-mcp) is removed too.
      if (Array.isArray(entry.args)) {
        const args = [];
        for (let i = 0; i < entry.args.length; i += 1) {
          const arg = String(entry.args[i]);
          if (arg === '--key' || arg === '--api-key') { if (entry.args[i + 1] !== undefined) removed.push(String(entry.args[i + 1])); i += 1; continue; }
          if (/^--(?:api-)?key=/.test(arg)) { removed.push(arg.slice(arg.indexOf('=') + 1)); continue; }
          args.push(entry.args[i]);
        }
        entry.args = args;
      }
      if (!entry.env || typeof entry.env !== 'object') continue;
      for (const name of ['MARROW_API_KEY', 'MARROW_KEY']) {
        const value = entry.env[name];
        if (typeof value === 'string' && value && !/^\$\{[A-Z_][A-Z0-9_]*\}$/.test(value)) {
          removed.push(value);
          delete entry.env[name];
        }
      }
      for (const name of ['MARROW_BASE_URL']) delete entry.env[name];
    }
  };
  const copy = JSON.parse(JSON.stringify(doc || {}));
  clean(copy.mcpServers);
  if (copy.projects && typeof copy.projects === 'object') for (const project of Object.values(copy.projects)) clean(project && project.mcpServers);
  return { doc: copy, removedCount: removed.length, removed };
}

function readJsonFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function writeJsonPreservingMode(file, doc) {
  let mode = 0o600;
  try { mode = fs.statSync(file).mode & 0o777; } catch { /* new file */ }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, `${JSON.stringify(doc, null, 2)}\n`, mode);
}

function applyPlan(plan, { compile = true, mcpConfigFiles = [], dryRun = false } = {}) {
  const report = { dry_run: dryRun, written: [], shim: null, keys_removed: 0, key_file: 'unchanged', hooks: plan.hooks.map((h) => ({ harness: h.harness, event: h.event, file: h.file })) };
  if (dryRun) return { ...report, plan: { lib_dir: plan.libDir, shim: plan.paths.shim, units: Object.keys(plan.units), unit_dir: plan.unitDir } };
  const { paths } = plan;
  // Parse every file this plan edits BEFORE writing anything, so an unparseable file (a TOML
  // Codex config, a hand-broken settings.json) never leaves a half-applied install.
  const hookDocs = new Map();
  for (const hook of plan.hooks) {
    if (hookDocs.has(hook.file)) continue;
    try { hookDocs.set(hook.file, readJsonFile(hook.file)); } catch { throw new Error(`cannot parse ${hook.file} as JSON; nothing was changed`); }
  }
  const mcpDocs = [];
  report.unparseable = [];
  for (const file of mcpConfigFiles) {
    if (!fs.existsSync(file)) continue;
    try { mcpDocs.push({ file, doc: readJsonFile(file) }); } catch { report.unparseable.push(file); }
  }
  for (const dir of [paths.root, paths.binDir, paths.libDir, paths.runDir, paths.policyDir, paths.queueDir, paths.bypassDir]) ensurePrivateDir(dir);

  copyTree(path.join(PACKAGE_SRC, 'agentd'), path.join(plan.libDir, 'src', 'agentd'), [], plan.libDir);
  fs.copyFileSync(path.join(PACKAGE_SRC, 'owner-env.js'), path.join(plan.libDir, 'src', 'owner-env.js'));
  fs.chmodSync(path.join(plan.libDir, 'src', 'owner-env.js'), 0o600);
  report.written.push(plan.libDir);

  report.shim = buildShim(plan, { compile });
  report.written.push(paths.shim);

  const config = {
    schema: CONFIG_SCHEMA,
    install_id: plan.installId,
    version: plan.version,
    base_url: plan.baseUrl,
    agents: plan.agents,
    hook_timeouts_ms: { ...HARNESS_HOOK_TIMEOUT_MS },
    shim: { path: paths.shim, sha256: report.shim.sha256, mode: report.shim.mode },
    lib: { dir: plan.libDir, manifest_sha256: manifestDigest(plan.libDir) },
    hooks: plan.hooks.map(({ harness, file, event, command }) => ({ harness, file, event, command })),
    created_at: new Date().toISOString(),
  };
  writeFileAtomic(paths.config, `${JSON.stringify(config, null, 2)}\n`, 0o600);
  report.written.push(paths.config);

  fs.mkdirSync(plan.unitDir, { recursive: true, mode: 0o700 });
  for (const [name, text] of Object.entries(plan.units)) {
    writeFileAtomic(path.join(plan.unitDir, name), text, 0o644);
    report.written.push(path.join(plan.unitDir, name));
  }

  const byFile = new Map();
  for (const hook of plan.hooks) {
    if (!byFile.has(hook.file)) byFile.set(hook.file, { harness: hook.harness, entries: [] });
    byFile.get(hook.file).entries.push(hook);
  }
  for (const [file, { harness, entries }] of byFile) {
    writeJsonPreservingMode(file, mergeHookDocument(hookDocs.get(file), harness, entries, plan.paths.shim));
    report.written.push(file);
  }

  let firstKey = null;
  for (const { file, doc: original } of mcpDocs) {
    const { doc, removedCount, removed } = stripInlineKeys(original);
    if (removedCount === 0) continue;
    if (!firstKey) firstKey = removed[0];
    writeJsonPreservingMode(file, doc);
    report.keys_removed += removedCount;
    report.written.push(file);
  }
  if (firstKey) {
    const { ensureOwnerApiKey } = require('../owner-env');
    report.key_file = ensureOwnerApiKey(plan.home, firstKey).state;
  }
  firstKey = null;
  return report;
}

module.exports = { buildPlan, applyPlan, mergeHookDocument, stripInlineKeys, systemdServiceUnit, systemdSocketUnit, hookCommand, HOOK_EVENTS, isMarrowHookCommand };

'use strict';

// A private local copy of the pinned @getmarrow/mcp, so hooks start it directly instead of
// through npx (npx costs 0.6 to 1.3 s per gated tool call before Marrow is contacted, and it
// resolves the package from the project directory first: a copy planted in the project's
// node_modules, or a project npm config naming another registry, would decide every hook).
//
// Layout (all owner-only, directories 0700):
//   ~/.marrow/runtime/mcp/<version>/node_modules/...   the package, installed with --ignore-scripts
//   ~/.marrow/runtime/mcp/<version>/.verified          integrity record (0600)
//   ~/.marrow/runtime/mcp/<version>/node               link to the node binary captured at install
//   ~/.marrow/runtime/mcp/.heal-<version>.lock          a hook's self-heal in progress (one per user)
//   ~/.marrow/runtime/mcp/.heal-<version>-<sha256 of the project's real path>.failed|.tried
//                                                       that project's last failed heal / last heal start
// (On Windows there is no node link.)
//
// Every hook command carries the runtime loader inline (runtime-core.js, compressed): it checks
// the installed files against the record and runs the entry. When the copy is missing or changed,
// it installs the pinned version itself, with the installer's own rules and the pinned integrity
// it carries. When that fails for an outage (offline, registry down, the wait ran out) a
// pre-action hook warns and lets the call run (exit 1, as npx failing did); any other failure,
// such as an integrity mismatch, holds it (exit 2 with a fixed repair message; every other
// entrypoint exits 1). Nothing ever reads the project or starts npx.
// Hook commands reach the runtime through the home directory, so project hook files stay the same
// for every user and name no local path.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const PINS = require('./pins');
const { runtimeCore } = require('./runtime-core');

const core = runtimeCore();
const RUNTIME_SCHEMA = core.SCHEMA;
const HOLD_TEXT = core.HOLD;
const UNAVAILABLE_TEXT = core.UNAVAILABLE;
const WARN_TEXT = core.WARN;
const NPM_INSTALL_TIMEOUT_MS = core.NPM_TIMEOUT_MS;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const PRE_ACTION_SUB_RE = /-pre-action-hook$/;

function runtimeRoot(home) {
  return path.join(home, '.marrow', 'runtime', 'mcp');
}

function runtimeDir(home, version) {
  return path.join(runtimeRoot(home), version);
}

function failureText(sub) {
  return PRE_ACTION_SUB_RE.test(String(sub || '')) ? HOLD_TEXT : UNAVAILABLE_TEXT;
}

function failureStatus(sub) {
  return PRE_ACTION_SUB_RE.test(String(sub || '')) ? 2 : 1;
}

// The runtime for one version, when its record matches the expected integrity and its files
// still hash to the record. Returns null otherwise (also when no integrity is given).
function verifyMcpRuntime(home, version, integrity, { platform = process.platform } = {}) {
  return core.verify(home, version, integrity, { platform });
}

// Installs (or keeps) the runtime for one MCP version whose tarball integrity is known.
// `sdk` is the pinned SDK { version, integrity }; when the installed SDK has that version, its
// integrity must match too. Never throws: a failure leaves hooks to heal it or hold.
function ensureMcpRuntime(options = {}) {
  return core.ensure({ ...options, prune: true });
}

function defaultNpmInstall(stage, specs, options = {}) {
  return core.npmInstall(stage, specs, options);
}

function npmInvocation(options = {}) {
  return core.npmInvocation(options);
}

function npmEnvironment(source = process.env, network = null) {
  return core.npmEnvironment(source, network);
}

// The shared runtime serves every project on this machine, so a project uninstall keeps it;
// only an explicit full uninstall (`uninstall --all`) removes it.
function removeMcpRuntime(home, { dryRun = false } = {}) {
  const root = path.dirname(runtimeRoot(home));
  if (!fs.existsSync(root)) return { removed: false, path: root };
  if (!dryRun) fs.rmSync(root, { recursive: true, force: true });
  return { removed: !dryRun, would_remove: dryRun, path: root };
}

// ---------------------------------------------------------------------------
// The inline loader: the core's text with the pinned version, integrity and SDK pin, compressed
// and base64url-encoded inside regex literals, so it contains no quote, $, %, !, backslash or
// backtick and every hook form (sh single or double quotes, cmd, PowerShell, a JS string) can
// carry it literally.
// ---------------------------------------------------------------------------

const CORE_SOURCE = runtimeCore.toString().split('\n').map((line) => line.trim()).filter(Boolean).join('\n');
const LOADER_RE = /eval\(global\.MARROW_L=require\(\/node:zlib\/\.source\)\.brotliDecompressSync\(Buffer\.from\(\/([A-Za-z0-9_-]{16,16000})\/\.source,\/base64url\/\.source\)\)\+\[\]\)/;
const LOADER_PATTERN = LOADER_RE.source;
// The same pattern with no capture group, for use inside the command patterns below.
const LOADER_NC = LOADER_PATTERN.replace('([A-Za-z0-9_-]', '(?:[A-Za-z0-9_-]');

function runtimeConfig(version, { integrity, sdk } = {}) {
  const pinned = version === PINS.MCP_ADAPTER_VERSION;
  return core.configOf(
    version,
    integrity === undefined ? (pinned ? PINS.MCP_ADAPTER_INTEGRITY : null) : integrity,
    sdk === undefined ? { version: PINS.SDK_ADAPTER_VERSION, integrity: PINS.SDK_ADAPTER_INTEGRITY } : sdk,
  );
}

function launcherSource(cfg) {
  return `'use strict';\nconst CFG = ${JSON.stringify(cfg)};\n(${CORE_SOURCE})().main(CFG, global.MARROW_L);\n`;
}

const loaderCache = new Map();
function loaderFor(cfg) {
  const source = launcherSource(cfg);
  if (!loaderCache.has(source)) {
    const packed = zlib.brotliCompressSync(Buffer.from(source), {
      params: { [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT, [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
    }).toString('base64url');
    loaderCache.set(source, `eval(global.MARROW_L=require(/node:zlib/.source).brotliDecompressSync(Buffer.from(/${packed}/.source,/base64url/.source))+[])`);
  }
  return loaderCache.get(source);
}

// The cores earlier installers shipped (SHA-256 of the core text a loader embeds, the value
// @getmarrow/mcp lists as INSTALLER_RUNTIME_CORE_SHA256): installers 0.1.70-0.1.73. A loader with
// one of them, in exactly the launcher layout, is still Marrow's own, so update and repair rewrite,
// and uninstall removes, the hooks those installers wrote instead of reading them as owner hooks.
// Such a command is never kept as it is: the keep check (localizeHookSettingsText) asks for
// today's core only.
const PREVIOUS_CORE_SHA256 = new Set(['73ea57796c017abfd144b43f3b91c9c935314c156ba523cbca525ebc1f977cb0']);
const LAUNCHER_TAIL = ')().main(CFG, global.MARROW_L);\n';

// The configuration a loader carries, only when it decodes to exactly the launcher this module
// writes for that configuration (compressed bytes may differ between zlib builds; the code that
// runs may not), or the same launcher around a previous core (unless `current` is set). A write
// with another configuration (integrity) than the current target's replaces the command.
function loaderConfig(loader, { current = false } = {}) {
  const match = String(loader || '').match(new RegExp(`^${LOADER_PATTERN}$`));
  if (!match) return null;
  let source;
  try {
    source = zlib.brotliDecompressSync(Buffer.from(match[1], 'base64url'), { maxOutputLength: 1 << 17 }).toString('utf8');
  } catch {
    return null;
  }
  const line = source.split('\n')[1] || '';
  if (!line.startsWith('const CFG = ') || !line.endsWith(';')) return null;
  let parsed;
  try {
    parsed = JSON.parse(line.slice('const CFG = '.length, -1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !VERSION_RE.test(String(parsed.version || ''))) return null;
  const cfg = core.configOf(parsed.version, parsed.integrity, parsed.sdk);
  const expected = launcherSource(cfg);
  if (expected === source) return cfg;
  if (current) return null;
  const head = expected.slice(0, expected.indexOf('\n(') + 2);
  if (!source.startsWith(head) || !source.endsWith(LAUNCHER_TAIL) || source.length < head.length + LAUNCHER_TAIL.length) return null;
  const previous = source.slice(head.length, source.length - LAUNCHER_TAIL.length);
  return PREVIOUS_CORE_SHA256.has(crypto.createHash('sha256').update(previous).digest('hex')) ? cfg : null;
}

// ---------------------------------------------------------------------------
// Hook commands: the canonical npx form (the one spelling every check and merge reads) <-> the
// written local-runtime form. Written hooks never start npx: the canonical form exists only in
// memory. Earlier local forms (0.1.66-0.1.68, which fell back to npx) still read as Marrow's own
// so that repair rewrites them.
// ---------------------------------------------------------------------------

const V = '(\\d+\\.\\d+\\.\\d+)';
const SUB = '([a-z][a-z-]{0,63})';
const ARGS = `--package=@getmarrow/mcp@${V} marrow-mcp ${SUB}`;
const canonicalEntrypoint = (version, sub) => `npx -y --package=@getmarrow/mcp@${version} marrow-mcp ${sub}`;
const RUN = (version) => `$HOME/.marrow/runtime/mcp/${version}/run`;

// Each written form is built from its parts by one function, and the pattern that recognizes it
// is generated from the same function (named groups for the version, entrypoint and loader; a
// repeated part must repeat exactly), so the writer and the reader cannot drift apart.
const SENTINEL = { version: '\u0001V\u0001', sub: '\u0001S\u0001', loader: '\u0001L\u0001', text: '\u0001T\u0001', status: '\u0001X\u0001' };
function formPattern(build) {
  const seen = new Set();
  const parts = { V: ['v', '\\d+\\.\\d+\\.\\d+'], S: ['s', '[a-z][a-z-]{0,63}'], L: ['l', LOADER_NC] };
  return build(SENTINEL).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\u0001([VSLTX])\u0001/g, (match, key) => {
    if (key === 'T') return '[^"\']*';
    if (key === 'X') return '[12]';
    const [name, pattern] = parts[key];
    if (seen.has(name)) return `\\k<${name}>`;
    seen.add(name);
    return `(?<${name}>${pattern})`;
  });
}
const partsFor = (version, sub, cfg) => ({ version, sub, loader: loaderFor(cfg), text: failureText(sub), status: failureStatus(sub) });
const argsOf = (p) => `--package=@getmarrow/mcp@${p.version} marrow-mcp ${p.sub}`;
// Which node runs the loader (POSIX): the one captured in the private runtime when it exists, else
// node on PATH or in the usual absolute places, but never a relative path or one inside the
// current (project) directory, so a project cannot plant the node that checks it.
const nodeSearch = (p, found) => `N="$HOME/.marrow/runtime/mcp/${p.version}/node"; if [ ! -x "$N" ]; then N=; P="$PATH:/usr/local/bin:/opt/homebrew/bin"; while [ -n "$P" ]; do D="\${P%%:*}"; case "$P" in (*:*) P="\${P#*:}" ;; (*) P= ;; esac; case "$D" in ("$PWD"|"$PWD"/*) ;; (/*) if [ -f "$D/node" ] && [ -x "$D/node" ]; then N="$D/node"; break; fi ;; esac; done; fi; ${found}`;

// 1. A plain entrypoint command. POSIX: /bin/sh picks node as above and runs the loader, passed as
// $0. Windows: node on the loader, quoted so cmd, PowerShell and sh all read it the same way. No
// usable node: the fixed text with the hold (2) or failure (1) status.
const plainPosix = (p) => `/bin/sh -c '${nodeSearch(p, `if [ -n "$N" ]; then exec "$N" -e "$0" -- ${argsOf(p)}; fi;`)} printf "%s\\n" "${p.text}" >&2; exit ${p.status}' "${p.loader}"`;
const plainWindows = (p) => `node -e "${p.loader}" -- ${argsOf(p)}`;
function localPlain(version, sub, platform, cfg = runtimeConfig(version)) {
  return (platform === 'win32' ? plainWindows : plainPosix)(partsFor(version, sub, cfg));
}
const PLAIN_RE = new RegExp(`^${formPattern(plainPosix)}$`);
const WINDOWS_PLAIN_RE = new RegExp(`^${formPattern(plainWindows)}$`);
const LEGACY_PLAIN_RE = new RegExp(`^/bin/sh -c 'M="\\$HOME/\\.marrow/runtime/mcp/${V}/run"; if \\[ -x "\\$M" \\]; then exec "\\$M" ${ARGS}; fi; exec npx -y --package=@getmarrow/mcp@\\2 marrow-mcp \\3'$`);
const CANONICAL_PLAIN_RE = new RegExp(`^npx -y ${ARGS}$`);

// 2. An entrypoint inside an `sh -c '...'` wrapper (Windsurf, Gemini, every platform) or a Cline
// hook script: the same node search and loader, or the fixed text with the hold or failure status.
const innerForm = (p) => `{ ${nodeSearch(p, `if [ -n "$N" ]; then "$N" -e "${p.loader}" -- ${argsOf(p)}; else printf "%s\\n" "${p.text}" >&2; (exit ${p.status}); fi; }`)}`;
function localInner(version, sub, cfg = runtimeConfig(version)) {
  return innerForm(partsFor(version, sub, cfg));
}
const INNER_RE = new RegExp(formPattern(innerForm), 'g');
const LEGACY_INNER_RE = new RegExp(`\\{ M="\\$HOME/\\.marrow/runtime/mcp/${V}/run"; if \\[ -x "\\$M" \\]; then "\\$M" ${ARGS}; else npx -y --package=@getmarrow/mcp@\\2 marrow-mcp \\3; fi; \\}`, 'g');
const CANONICAL_INNER_RE = new RegExp(`npx -y ${ARGS}`, 'g');

// 3. A node guard (`node -e '...'`) that spawns the entrypoint: the guard's own node on the
// loader. A failed child is what every guard already treats as its own launch failure (it
// blocks, or stays neutral).
const SPAWN_NPX = 'spawn(process.platform==="win32"?"npx.cmd":"npx",';
function localSpawn(version, sub, cfg = runtimeConfig(version)) {
  return `spawn(process.execPath,["-e","${loaderFor(cfg)}","--","--package=@getmarrow/mcp@${version}","marrow-mcp","${sub}"],`;
}
const SPAWN_RE = new RegExp(`spawn\\(process\\.execPath,\\["-e","(${LOADER_NC})","--","--package=@getmarrow/mcp@(\\d+\\.\\d+\\.\\d+)","marrow-mcp","([a-z-]+)"\\],`, 'g');
const LEGACY_SPAWN_RE = /spawn\(\.\.\.\(\(f,m,a\)=>f\.existsSync\(m\)\?\[m,a\.slice\(1\)\]:\[process\.platform==="win32"\?"npx\.cmd":"npx",a\]\)\(require\("node:fs"\),\(process\.env\.HOME\|\|""\)\+"\/\.marrow\/runtime\/mcp\/\d+\.\d+\.\d+\/run",(\["-y","--package=@getmarrow\/mcp@\d+\.\d+\.\d+","marrow-mcp","[a-z-]+"\])\),/g;
const LEGACY_SPAWN_ONE_RE = new RegExp(LEGACY_SPAWN_RE.source);
const CANONICAL_SPAWN_RE = /spawn\(process\.platform==="win32"\?"npx\.cmd":"npx",\["-y","--package=@getmarrow\/mcp@(\d+\.\d+\.\d+)","marrow-mcp","([a-z-]+)"\],/g;
// The POSIX guard runs on node found as above (none: a path that fails, as a missing node did).
const guardPrefixForm = (p) => nodeSearch(p, `[ -n "$N" ] || N=/nonexistent/marrow-node; exec "$N" -e '`);
const localGuardPrefix = (version) => guardPrefixForm({ version });
const LOCAL_GUARD_PREFIX_RE = new RegExp(`^${formPattern(guardPrefixForm)}`);
const LEGACY_GUARD_SPAWN_HINT = 'spawn(...((f,m,a)=>f.existsSync(m)';

// The command with each valid loader in it spelled as this module compresses it, so a command
// written by another zlib build compares equal to its exact rebuild.
function withCanonicalLoaders(command, cfg) {
  return command.replace(new RegExp(LOADER_PATTERN, 'g'), (loader) => (loaderConfig(loader) ? loaderFor(cfg) : loader));
}

// The configuration of every loader in a command, when all are valid and carry the same one.
function commandConfig(loaders, options = {}) {
  let cfg = null;
  for (const loader of loaders) {
    const found = loaderConfig(loader, options);
    if (!found || (cfg && JSON.stringify(found) !== JSON.stringify(cfg))) return null;
    cfg = found;
  }
  return cfg;
}

// The canonical (npx) form of a hook command; any other command is returned unchanged. Only a
// command that the current writer would produce again exactly (or an earlier writer's local
// form) maps back, so an edited command never reads as Marrow's own.
function delocalizeHookCommand(command) {
  if (typeof command !== 'string') return command;
  const legacyPlain = command.match(LEGACY_PLAIN_RE);
  if (legacyPlain && legacyPlain[1] === legacyPlain[2]) return canonicalEntrypoint(legacyPlain[2], legacyPlain[3]);
  for (const [pattern, platform] of [[PLAIN_RE, 'posix'], [WINDOWS_PLAIN_RE, 'win32']]) {
    const found = command.match(pattern);
    if (!found) continue;
    const { v, s, l } = found.groups;
    const cfg = commandConfig([l]);
    return cfg && cfg.version === v && localPlain(v, s, platform, cfg) === withCanonicalLoaders(command, cfg) ? canonicalEntrypoint(v, s) : command;
  }
  const prefixed = LOCAL_GUARD_PREFIX_RE.test(command);
  if (prefixed || (command.startsWith('node -e \'') && (command.includes('spawn(process.execPath,["-e","') || command.includes(LEGACY_GUARD_SPAWN_HINT)))) {
    const body = prefixed ? command.replace(LOCAL_GUARD_PREFIX_RE, 'node -e \'') : command;
    if (LEGACY_SPAWN_ONE_RE.test(body)) {
      const canonical = body.replace(LEGACY_SPAWN_RE, `${SPAWN_NPX}$1,`);
      return canonical === body ? command : canonical;
    }
    const loaders = [];
    const canonical = body.replace(SPAWN_RE, (match, loader, version, sub) => {
      loaders.push(loader);
      return `${SPAWN_NPX}${JSON.stringify(['-y', `--package=@getmarrow/mcp@${version}`, 'marrow-mcp', sub])},`;
    });
    if (canonical === body) return command;
    const cfg = commandConfig(loaders);
    const version = (canonical.match(/--package=@getmarrow\/mcp@(\d+\.\d+\.\d+)/) || [])[1];
    // The current guard forms must map back exactly.
    if (!cfg || !version || localizeHookCommand(canonical, version, { platform: prefixed ? 'posix' : 'win32', ...cfg }) !== withCanonicalLoaders(command, cfg)) return command;
    return canonical;
  }
  if (command.startsWith('/bin/sh -c \'') && (LEGACY_INNER_RE.test(command) || INNER_RE.test(command))) {
    LEGACY_INNER_RE.lastIndex = 0;
    INNER_RE.lastIndex = 0;
    const loaders = [];
    let mismatch = false;
    const inner = command
      .replace(LEGACY_INNER_RE, (match, runVersion, version, sub) => (runVersion === version ? canonicalEntrypoint(version, sub) : match))
      .replace(INNER_RE, (match, ...rest) => {
        const { v: version, s: sub, l: loader } = rest[rest.length - 1];
        const cfg = commandConfig([loader]);
        if (!cfg || cfg.version !== version || localInner(version, sub, cfg) !== withCanonicalLoaders(match, cfg)) {
          mismatch = true;
          return match;
        }
        loaders.push(loader);
        return canonicalEntrypoint(version, sub);
      });
    if (mismatch || (loaders.length && !commandConfig(loaders))) return command;
    return inner === command ? command : `sh -c '${inner.slice('/bin/sh -c \''.length)}`;
  }
  return command;
}

// The local runtime form of a canonical hook command for `version`, or the command unchanged
// when it is not a Marrow entrypoint for that version. The result always maps back exactly.
// `integrity` and `sdk` are what the loader installs when it heals (defaults: the pins).
function localizeHookCommand(command, version, { platform = process.platform, integrity, sdk } = {}) {
  if (typeof command !== 'string' || !VERSION_RE.test(String(version || ''))) return command;
  const windows = platform === 'win32';
  const cfg = runtimeConfig(version, { integrity, sdk });
  let local = command;
  const plain = command.match(CANONICAL_PLAIN_RE);
  if (plain) {
    if (plain[1] !== version) return command;
    local = localPlain(version, plain[2], windows ? 'win32' : 'posix', cfg);
  } else if (command.startsWith('node -e \'') && command.includes(SPAWN_NPX)) {
    let matched = false;
    const body = command.slice('node -e \''.length).replace(CANONICAL_SPAWN_RE, (match, specVersion, sub) => {
      if (specVersion !== version) return match;
      matched = true;
      return localSpawn(version, sub, cfg);
    });
    if (!matched) return command;
    local = windows ? `node -e '${body}` : `${localGuardPrefix(version)}${body}`;
  } else if (command.startsWith('sh -c \'')) {
    let matched = false;
    const body = command.slice('sh -c \''.length).replace(CANONICAL_INNER_RE, (match, specVersion, sub) => {
      if (specVersion !== version) return match;
      matched = true;
      return localInner(version, sub, cfg);
    });
    if (!matched) return command;
    local = `/bin/sh -c '${body}`;
  } else {
    return command;
  }
  return mapsBack(local, command) ? local : command;
}

function mapsBack(local, command) {
  // delocalize re-checks guard forms through localize; compare without recursing forever.
  if (local.match(PLAIN_RE) || local.match(WINDOWS_PLAIN_RE) || local.startsWith('/bin/sh -c \'')) return delocalizeHookCommand(local) === command;
  const prefixed = LOCAL_GUARD_PREFIX_RE.test(local);
  const body = prefixed ? local.replace(LOCAL_GUARD_PREFIX_RE, 'node -e \'') : local;
  const canonical = body.replace(SPAWN_RE, (match, loader, version, sub) => (loaderConfig(loader)
    ? `${SPAWN_NPX}${JSON.stringify(['-y', `--package=@getmarrow/mcp@${version}`, 'marrow-mcp', sub])},`
    : match));
  return canonical === command;
}

// Every `command` string in a parsed hook settings object.
function mapHookCommands(value, map) {
  if (Array.isArray(value)) return value.map((entry) => mapHookCommands(entry, map));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    key === 'command' && typeof entry === 'string' ? map(entry) : mapHookCommands(entry, map),
  ]));
}

// Hook settings text with Marrow's entrypoints for `version` switched to the local runtime. A
// command already in `previousText` that maps to the same canonical form and carries the same
// configuration is kept byte for byte, so a file written on another machine (another zlib
// build) is not rewritten.
function localizeHookSettingsText(text, version, { platform = process.platform, integrity, sdk, previousText = null } = {}) {
  if (typeof text !== 'string' || !text.trim()) return text;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text;
  }
  const expected = JSON.stringify(runtimeConfig(version, { integrity, sdk }));
  const keep = new Map();
  if (typeof previousText === 'string' && previousText.trim()) {
    try {
      mapHookCommands(JSON.parse(previousText), (command) => {
        const canonical = delocalizeHookCommand(command);
        const loaders = [...command.matchAll(new RegExp(LOADER_PATTERN, 'g'))].map((match) => match[0]);
        // Only a command on today's core is kept; one on a previous core is rewritten.
        const cfg = loaders.length ? commandConfig(loaders, { current: true }) : null;
        if (canonical !== command && cfg && JSON.stringify(cfg) === expected
          && (platform === 'win32') === command.startsWith('node -e "')) keep.set(canonical, command);
        return command;
      });
    } catch {
      keep.clear();
    }
  }
  let changed = false;
  const mapped = mapHookCommands(parsed, (command) => {
    const local = keep.get(command) || localizeHookCommand(command, version, { platform, integrity, sdk });
    if (local !== command) changed = true;
    return local;
  });
  return changed ? `${JSON.stringify(mapped, null, 2)}\n` : text;
}

// A hook script (Cline) with each canonical entrypoint switched to the inline loader for
// `version`. Without node the line fails, and each script already treats that as no decision
// (the pre-action script then cancels the call).
// The Cline pre-action script checks the runtime's answer with node: written scripts run that
// check on the node the same search picks (never a node on PATH inside the project); no node
// gives no decision, so the script cancels.
const CANONICAL_VALIDATOR_RE = /\| NODE_OPTIONS= node -e '([^'\n]*)' 2>\/dev\/null\)"/g;
const localValidator = (version, body) => `| { ${nodeSearch({ version }, `[ -n "$N" ] || exit 1; NODE_OPTIONS= "$N" -e '${body}'; }`)} 2>/dev/null)"`;
const VALIDATOR_RE = new RegExp(localValidator('0.0.0', '\u0000').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  .replace('0\\.0\\.0', '(\\d+\\.\\d+\\.\\d+)').replace('\u0000', "([^'\\n]*)"), 'g');

function localizeHookScriptText(text, version, { integrity, sdk } = {}) {
  if (typeof text !== 'string' || !VERSION_RE.test(String(version || ''))) return text;
  const cfg = runtimeConfig(version, { integrity, sdk });
  return text.replace(CANONICAL_INNER_RE, (match, specVersion, sub) => (
    specVersion === version ? localInner(version, sub, cfg) : match
  )).replace(CANONICAL_VALIDATOR_RE, (match, body) => localValidator(version, body));
}

// Earlier Cline script lines ("$HOME/.marrow/runtime/mcp/<v>/run" ...) back to the canonical form.
function delocalizeHookScriptText(text) {
  if (typeof text !== 'string') return text;
  return text.replace(VALIDATOR_RE, (match, version, body) => `| NODE_OPTIONS= node -e '${body}' 2>/dev/null)"`).replace(INNER_RE, (match, ...rest) => {
    const { v: version, s: sub, l: loader } = rest[rest.length - 1];
    const cfg = commandConfig([loader]);
    return cfg && cfg.version === version && localInner(version, sub, cfg) === withCanonicalLoaders(match, cfg) ? canonicalEntrypoint(version, sub) : match;
  }).replace(/"\$HOME\/\.marrow\/runtime\/mcp\/(\d+\.\d+\.\d+)\/run" --package=@getmarrow\/mcp@(\d+\.\d+\.\d+) marrow-mcp ([a-z][a-z-]{0,63})/g,
    (match, runVersion, version, sub) => (runVersion === version ? canonicalEntrypoint(version, sub) : match));
}

// The MCP server entry (.mcp.json, .cursor/mcp.json), started by the host with no shell. POSIX:
// /bin/sh with the same node search as the hooks, on the loader. Windows: node on the loader.
// Base and 0.1.68 wrote `npx -y --package=... marrow-mcp`, started from the project directory.
function mcpServerLaunch(version, { integrity, sdk, platform = process.platform } = {}) {
  const loader = loaderFor(runtimeConfig(version, { integrity, sdk }));
  const tail = [`--package=@getmarrow/mcp@${version}`, 'marrow-mcp'];
  if (platform === 'win32') return { command: 'node', args: ['-e', loader, '--', ...tail] };
  const script = nodeSearch({ version }, `if [ -n "$N" ]; then exec "$N" -e "$0" -- "$@"; fi; printf "%s\\n" "${UNAVAILABLE_TEXT}" >&2; exit 1`);
  return { command: '/bin/sh', args: ['-c', script, loader, ...tail] };
}

// The version of a server entry this module wrote (exactly, with a valid loader), else null.
function mcpServerLaunchVersion(entry) {
  if (!entry || typeof entry !== 'object' || !Array.isArray(entry.args)) return null;
  const args = entry.args.map(String);
  const spec = args.find((arg) => /^--package=@getmarrow\/mcp@\d+\.\d+\.\d+$/.test(arg));
  const loader = args.find((arg) => arg.startsWith('eval(global.MARROW_L='));
  if (!spec || !loader) return null;
  const cfg = loaderConfig(loader);
  const version = spec.slice('--package=@getmarrow/mcp@'.length);
  if (!cfg || cfg.version !== version) return null;
  const written = JSON.stringify({ command: entry.command, args: args.map((arg) => (arg === loader ? loaderFor(cfg) : arg)) });
  return ['linux', 'win32'].some((platform) => JSON.stringify(mcpServerLaunch(version, { ...cfg, platform })) === written) ? version : null;
}

// ---------------------------------------------------------------------------
// F-2c: the short Windows hook form. The inline loader is over 9000 characters and cmd.exe stops at
// 8191, so a Windows hook carries only a short stub: node by its absolute path (no PATH or
// current-folder lookup) on a stub that reads ~/.marrow/runtime/launcher/<sha256>.cjs once, runs it
// only when those exact bytes hash to the digest the stub carries and the folders and file are
// private (owner, no link; POSIX: no group or other bits), and otherwise prints the hold (pre-action,
// exit 2) or failure text (exit 1). The launcher file is the inline loader, byte for byte, so the code
// that runs is the same runtimeCore with the same configuration. A missing launcher holds; it is not
// healed by the hook (the installer and --repair write it). An error thrown while the runtime starts
// holds too. The tail after the node command (windowsHookCommand) turns every pre-action end but 0 into 2,
// whatever the shell. Which host may be given this form is decided in windows-hooks.js (a host is written only
// when one form works in every Windows hook shell; today none, so no installer path writes it).
// ---------------------------------------------------------------------------

const WINDOWS_HOOK_MAX = 2048;
const WINDOWS_NODE_MAX = 500;
const DIGEST_RE = /^[0-9a-f]{64}$/;
// An absolute drive path to node.exe with nothing cmd, PowerShell or bash would read inside double
// quotes: no UNC or \\?\ prefix, no quote, %, !, ^, &, |, <, >, $, backtick or control character.
const WINDOWS_NODE_RE = /^[A-Za-z]:\\(?:[^\\/:*?"<>|%!^&$`'\u0000-\u001f]+\\)*node\.exe$/i;
// Inside double quotes cmd.exe, bash and PowerShell read none of these (no quote, $, %, !, backslash or backtick).
const STUB_SAFE_RE = /^[A-Za-z0-9 _.,;:(){}[\]=+*/?'#@~<>&|-]+$/;

function launcherDir(home) {
  return path.join(home, '.marrow', 'runtime', 'launcher');
}

function launcherPath(home, digest) {
  return path.join(launcherDir(home), `${digest}.cjs`);
}

// The launcher file's exact bytes for a configuration: the inline loader itself.
function windowsLauncherText(cfg) {
  return loaderFor(cfg);
}

function launcherDigest(text) {
  return crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

// The stub's own JavaScript. It reads the launcher once and hashes the same bytes it runs.
function windowsStubSource(digest) {
  if (!DIGEST_RE.test(String(digest || ''))) throw new Error('invalid launcher digest');
  const fail = (text) => `'${text}'`;
  const source = [
    "(()=>{const f=require('fs'),p=require('path'),a=process.argv.slice(1),pre=String(a[2]).endsWith('-pre-action-hook');",
    `const no=()=>{process.stderr.write((pre?${fail(HOLD_TEXT)}:${fail(UNAVAILABLE_TEXT)})+String.fromCharCode(10));process.exitCode=pre?2:1};`,
    "let t=null;try{const u=process.getuid?process.getuid():null,w=process.platform==='win32',",
    'ok=(s,d)=>(d?s.isDirectory():s.isFile())&&s.isSymbolicLink()==false&&(u===null||s.uid===u)&&(w||(s.mode&63)==0);',
    "let x=require('os').homedir();for(const n of ['.marrow','runtime','launcher']){x=p.join(x,n);if(ok(f.lstatSync(x),1)==false)throw 0}",
    `x=p.join(x,'${digest}.cjs');if(ok(f.lstatSync(x),0)==false)throw 0;t=f.readFileSync(x);`,
    `if((require('crypto').createHash('sha256').update(t).digest('hex')=='${digest}')==false)t=null}catch{t=null}`,
    "if(t===null){no();return}try{eval(t+'')}catch{no()}})()",
  ].join('');
  if (!STUB_SAFE_RE.test(source)) throw new Error('the Windows hook stub carries a character a shell could read');
  return source;
}

// The full Windows hook command for one entrypoint. Throws when an input is unsafe or the result
// would be longer than WINDOWS_HOOK_MAX (a caller then skips the host; it never writes a long form).
function windowsStubCommand(version, sub, options = {}) {
  return windowsHookCommand(version, sub, { ...options, form: 'cmd' });
}

// NH (installer 0.1.76): one Windows hook command per hook shell. No single text is usable and fail-closed in
// cmd.exe, Git Bash and PowerShell at once (windows-hooks.js holds the matrix and the per-host decision), so each
// form is written for ONE shell and every other shell must hold or fail it closed:
//   cmd         `"<node>" -e "<stub>" -- <args> || exit 2`
//   bash        the same text with the node path in forward slashes (a backslash word has no `/`, so bash would search PATH)
//   powershell  `try { & "<node>" -e "<stub>" -- <args>; $c = $LASTEXITCODE } catch { $c = 99 }; if ($c -eq 0) { exit 0 } else { exit 2 }`
// Only a pre-action entrypoint carries the tail: it lets exit 0 through and turns EVERY other end into 2: node's
// own 2 (hold), its 1 (the outage warning POSIX passes: on Windows a runtime that is missing and cannot be fetched
// blocks, a tightening), node missing (9009, 127, not recognized), a crash code, a signal. Another entrypoint
// cannot block and is the bare node command. The node path is validated once (absolute drive path, nothing a
// shell reads inside double quotes, no `.`/`..` part, no curly quote).
const WINDOWS_HOOK_FORMS = Object.freeze(['cmd', 'bash', 'powershell']);
const WINDOWS_CMD_LIMIT = 8191;
// How a host's shell:true spawn wraps the text: cmd.exe /d /s /c "<text>".
const WINDOWS_CMD_WRAP = 'cmd.exe /d /s /c "';

function windowsCmdLineLength(command) {
  return WINDOWS_CMD_WRAP.length + String(command).length + 1;
}

// The cmd.exe limit as a check of its own, apart from the (much lower) WINDOWS_HOOK_MAX of the generator.
function assertWindowsCmdLength(command) {
  if (typeof command !== 'string' || windowsCmdLineLength(command) > WINDOWS_CMD_LIMIT) {
    throw new Error(`the Windows hook command line would be longer than ${WINDOWS_CMD_LIMIT} characters`);
  }
  return command;
}

function windowsHookCommand(version, sub, { form = 'cmd', nodePath, digest, limit = WINDOWS_HOOK_MAX } = {}) {
  if (!VERSION_RE.test(String(version || '')) || String(version).length > 32) throw new Error('invalid MCP version for a Windows hook');
  if (!/^[a-z][a-z-]{0,63}$/.test(String(sub || ''))) throw new Error('invalid entrypoint for a Windows hook');
  if (!WINDOWS_HOOK_FORMS.includes(form)) throw new Error('unknown Windows hook form');
  if (typeof nodePath !== 'string' || nodePath.length > WINDOWS_NODE_MAX || !WINDOWS_NODE_RE.test(nodePath) || !windowsNodePathSane(nodePath)) throw new Error('node is not at a safe absolute Windows path');
  const pre = PRE_ACTION_SUB_RE.test(sub);
  const args = `-- --package=@getmarrow/mcp@${version} marrow-mcp ${sub}`;
  const stub = windowsStubSource(digest);
  let command;
  if (form === 'powershell') {
    const run = `& "${nodePath}" -e "${stub}" ${args}`;
    command = pre ? `try { ${run}; $c = $LASTEXITCODE } catch { $c = 99 }; if ($c -eq 0) { exit 0 } else { exit 2 }` : run;
  } else if (form === 'bash') {
    const run = `"${nodePath.replace(/\\/g, '/')}" -e "${stub}" ${args}`;
    command = pre ? `${run} || exit 2` : run;
  } else {
    const run = `"${nodePath}" -e "${stub}" ${args}`;
    command = pre ? `${run} || exit 2` : run;
  }
  // The generator's own cap is far under cmd.exe's 8191; a caller can only lower it, never raise it.
  if (command.length > Math.min(WINDOWS_HOOK_MAX, limit)) throw new Error(`the Windows hook command is ${command.length} characters (limit ${Math.min(WINDOWS_HOOK_MAX, limit)})`);
  return assertWindowsCmdLength(command);
}

// A node path with no `.` or `..` component, no component ending in a space or dot, and no curly quote
// (PowerShell reads U+2018..U+201E as quotes).
function windowsNodePathSane(nodePath) {
  if (/[\u2018-\u201e]/.test(nodePath)) return false;
  return nodePath.split('\\').slice(1).every((part) => part !== '.' && part !== '..' && !/[ .]$/.test(part));
}

function privateDirectory(directory) {
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
  }
  const stat = fs.lstatSync(directory);
  const me = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!stat.isDirectory() || stat.isSymbolicLink() || (me !== null && stat.uid !== me)) throw new Error(`unsafe runtime directory ${directory}`);
  if ((stat.mode & 0o077) !== 0) fs.chmodSync(directory, 0o700);
}

// Writes (or keeps) the launcher for a configuration: ~/.marrow, ~/.marrow/runtime and the launcher
// folder private (0700, owner, not links), the file 0600, written beside and renamed into place.
function writeWindowsLauncher(home, cfg) {
  const text = windowsLauncherText(cfg);
  const digest = launcherDigest(text);
  for (const directory of [path.join(home, '.marrow'), path.join(home, '.marrow', 'runtime'), launcherDir(home)]) privateDirectory(directory);
  const target = launcherPath(home, digest);
  try {
    const stat = fs.lstatSync(target);
    if (stat.isFile() && fs.readFileSync(target, 'utf8') === text) {
      if ((stat.mode & 0o077) !== 0) fs.chmodSync(target, 0o600);
      return { path: target, digest, state: 'present' };
    }
  } catch {
    // absent: written below
  }
  const temp = `${target}.${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(temp, text, { mode: 0o600, flag: 'wx' });
  try {
    fs.renameSync(temp, target);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
  return { path: target, digest, state: 'written' };
}

// Whether a hook file's text still starts @getmarrow/mcp through npx (the canonical form, an
// earlier local form with its npx fallback, or a guard that spawns npx): such a file needs repair.
function hookTextUsesNpx(text) {
  if (typeof text !== 'string' || !text) return false;
  return /npx -y --package=@getmarrow\/mcp@/.test(text) || text.includes('"npx.cmd":"npx"') || text.includes('\\"npx.cmd\\":\\"npx\\"');
}

// Whether an MCP server config still starts the Marrow server through npx.
function mcpServerUsesNpx(config) {
  const entry = config && typeof config === 'object' && config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers.marrow : null;
  if (!entry || typeof entry !== 'object') return false;
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  return /(?:^|[\\/])npx(?:\.cmd)?$/.test(String(entry.command || '')) && args.some((arg) => /^--package=@getmarrow\/mcp(?:@|$)/.test(arg));
}

module.exports = {
  HOLD_TEXT,
  NPM_INSTALL_TIMEOUT_MS,
  RUNTIME_SCHEMA,
  UNAVAILABLE_TEXT,
  WARN_TEXT,
  RUN,
  defaultNpmInstall,
  delocalizeHookCommand,
  delocalizeHookScriptText,
  ensureMcpRuntime,
  hookTextUsesNpx,
  launcherSource,
  loaderConfig,
  loaderFor,
  localizeHookCommand,
  localizeHookScriptText,
  localizeHookSettingsText,
  mapHookCommands,
  mcpServerLaunch,
  mcpServerLaunchVersion,
  mcpServerUsesNpx,
  npmEnvironment,
  npmInvocation,
  removeMcpRuntime,
  runtimeConfig,
  runtimeCore: core,
  runtimeDir,
  runtimeRoot,
  verifyMcpRuntime,
  WINDOWS_CMD_LIMIT,
  WINDOWS_HOOK_FORMS,
  WINDOWS_HOOK_MAX,
  assertWindowsCmdLength,
  launcherDigest,
  launcherPath,
  windowsCmdLineLength,
  windowsHookCommand,
  windowsLauncherText,
  windowsNodePathSane,
  windowsStubCommand,
  windowsStubSource,
  writeWindowsLauncher,
};

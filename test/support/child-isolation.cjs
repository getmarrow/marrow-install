'use strict';
// Test-only child-process isolation: the seam (a private HOME, the passwd-home preload, a private git config) and the spawn
// guard (refuses a git command that reaches a non-local address, then checks what is about to start). One file, loaded first
// by every test file (support/isolated-environment.js) and, as a --require on the command line, by every node child a test
// starts. NODE_OPTIONS is never used: the shipped runtime reads any NODE_OPTIONS outside a short list as an outside network
// setting. Nothing under bin/, src/ or scripts/ names or loads this file. Messages carry subcommands, variable NAMES and call
// sites only: never a URL, a path outside the repo or an environment value.
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SELF = __filename;
const PASSWD_NAME = 'SBT_PASSWD_HOME';
// Read before the fake below hides it; only ever compared, never printed.
const REAL_PASSWD_HOME = (() => {
  try {
    return os.userInfo().homedir;
  } catch {
    return '';
  }
})();
// The git the guard itself runs to read a repository's remotes: found on PATH now, before any test puts a fake one there.
const REAL_GIT = (() => {
  for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
    const candidate = path.join(directory || '.', process.platform === 'win32' ? 'git.exe' : 'git');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  return 'git';
})();
const real = { spawnSync: cp.spawnSync };
const plan = { argv: null };
const FUNCTIONS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];

const state = { expected: 0, installed: false, tempRoot: '', home: '', passwdHome: '', argvChecked: [], dir: '', depth: 0, checked: 0, git: 0, refusals: 0, pending: [], homeFilled: new Set() };

// ---- passwd-home fake (also the --require preload of every node child) ------------------------------------------------
// os.userInfo().homedir is the account database's home and no variable moves it: a node child (hook, CLI, MCP) started without
// the preload would read and write the real ~/.marrow of whoever runs the suite. os.homedir() follows it only when HOME is unset.
// A test's own fake (status-host-fakes.js, loaded through the test's NODE_OPTIONS or before this file) is left alone: only the
// untouched node function is replaced.
function applyPasswdFake() {
  const dir = process.env[PASSWD_NAME];
  if (!dir || !path.isAbsolute(dir) || dir === REAL_PASSWD_HOME || os.userInfo.sbtFake) return;
  if (!/getUserInfo/.test(Function.prototype.toString.call(os.userInfo))) return;
  const userInfo = os.userInfo;
  const homedir = os.homedir;
  const fake = function userInfoFake(options) {
    const info = userInfo.call(this, options);
    return { ...info, homedir: options && options.encoding === 'buffer' ? Buffer.from(dir) : dir };
  };
  fake.sbtFake = true;
  os.userInfo = fake;
  os.homedir = function homedirFake() {
    return process.env.HOME === undefined ? dir : homedir.call(this);
  };
}
applyPasswdFake();

// ---- shell text and git command analysis ------------------------------------------------------------------------------
const SHELLS = new Set(['sh', 'bash', 'dash', 'zsh', 'ksh', 'ash']);
const NETWORK_WORDS = new Set(['push', 'fetch', 'pull', 'clone', 'ls-remote', 'fetch-pack', 'send-pack', 'upload-pack', 'receive-pack', 'remote',
  'submodule', 'lfs', 'svn', 'send-email', 'imap-send', 'archive', 'p4', 'http-fetch', 'http-push']);
const LOCAL_SUBCOMMANDS = new Set(['add', 'am', 'apply', 'bisect', 'blame', 'branch', 'bundle', 'cat-file', 'check-attr', 'check-ignore', 'check-ref-format',
  'checkout', 'checkout-index', 'cherry', 'cherry-pick', 'clean', 'column', 'commit', 'commit-graph', 'commit-tree', 'config', 'count-objects', 'describe',
  'diff', 'diff-files', 'diff-index', 'diff-tree', 'fast-export', 'fast-import', 'for-each-ref', 'format-patch', 'fsck', 'gc', 'get-tar-commit-id', 'grep',
  'hash-object', 'help', 'hook', 'index-pack', 'init', 'interpret-trailers', 'log', 'ls-files', 'ls-tree', 'merge', 'merge-base', 'merge-file', 'mktag',
  'mktree', 'multi-pack-index', 'mv', 'name-rev', 'notes', 'pack-objects', 'pack-refs', 'patch-id', 'prune', 'range-diff', 'read-tree', 'rebase', 'reflog',
  'repack', 'replace', 'rerere', 'reset', 'restore', 'rev-list', 'rev-parse', 'revert', 'rm', 'shortlog', 'show', 'show-branch', 'show-ref', 'sparse-checkout',
  'stash', 'status', 'stripspace', 'switch', 'symbolic-ref', 'tag', 'unpack-file', 'unpack-objects', 'update-index', 'update-ref', 'var', 'verify-commit',
  'verify-pack', 'verify-tag', 'version', 'whatchanged', 'worktree', 'write-tree']);
// Programs behind git that reach a network whatever their arguments say.
const ALWAYS_NETWORK = new Set(['lfs', 'svn', 'send-email', 'imap-send', 'p4', 'http-fetch', 'http-push', 'upload-pack', 'receive-pack']);
const GIT_FLAGS = new Set(['-p', '-P', '--paginate', '--no-pager', '--no-replace-objects', '--bare', '--literal-pathspecs', '--glob-pathspecs',
  '--noglob-pathspecs', '--icase-pathspecs', '--no-optional-locks', '--no-advice', '--version', '-v', '--help', '-h', '--html-path', '--man-path',
  '--info-path', '--exec-path']);
// Options of the network subcommands that take the next word as their value (so it is not mistaken for the repository).
const VALUE_OPTIONS = new Set(['-o', '--push-option', '--depth', '--deepen', '--shallow-since', '--shallow-exclude', '--jobs', '-j', '--upload-pack',
  '--receive-pack', '--exec', '--repo', '--branch', '-b', '--origin', '--template', '--reference', '--reference-if-able', '--separate-git-dir', '--filter',
  '--server-option', '--negotiation-tip', '--refmap', '--bundle-uri', '--ref-format', '-u', '--config', '-c', '--remote']);
// Config keys (-c, --config-env) that can point a command at another address, run a program for it or load more config.
const REDIRECT_KEY = /^(url\.|remote\.|remotes\.|credential\.|http\.|https\.|protocol\.|include\.|includeif\.|alias\.|submodule\.|core\.(sshcommand|gitproxy|askpass)$|branch\..*\.(remote|pushremote)$)/i;
const FORBIDDEN_GIT_NAMES = ['GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_PROXY_COMMAND', 'GIT_EXEC_PATH', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS'];
const FORBIDDEN_GIT_PATTERN = /^GIT_CONFIG_(KEY|VALUE)_\d+$/;

// A repository word is local when it is a path or file:// with no remote host. Everything with another scheme, a transport
// helper (ext::) or the host:path form is not.
function isLocalTarget(word) {
  const text = String(word);
  if (/^file:\/\/(localhost)?\//i.test(text)) return true;
  if (text.includes('::') || /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^[^/]*:/.test(text)) return false;
  return true;
}
function isStrongRemote(word) {
  const text = String(word);
  return !isLocalTarget(text) && (text.includes('::') || /:\/\//.test(text));
}

// Splits shell text into command words per command (&& || ; | & ( ) newline, $( ) and backticks start a new command).
// Quoting is honoured; a $( ) or backtick inside double quotes is analysed as its own text.
function splitShell(text) {
  const segments = [];
  const subs = [];
  let words = [];
  let word = '';
  let has = false;
  const flush = () => {
    if (has) words.push(word);
    word = '';
    has = false;
  };
  const cut = () => {
    flush();
    if (words.length) segments.push(words);
    words = [];
  };
  const inner = (part) => {
    for (let at = part.indexOf('$('); at >= 0; at = part.indexOf('$(', at + 2)) {
      let depth = 1;
      let end = at + 2;
      for (; end < part.length && depth > 0; end++) {
        if (part[end] === '(') depth++;
        else if (part[end] === ')') depth--;
      }
      subs.push(part.slice(at + 2, end - 1));
    }
    const ticks = part.split('`');
    for (let n = 1; n < ticks.length; n += 2) subs.push(ticks[n]);
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'") {
      const close = text.indexOf("'", i + 1);
      const end = close < 0 ? text.length : close;
      word += text.slice(i + 1, end);
      has = true;
      i = end;
    } else if (c === '"') {
      let part = '';
      let j = i + 1;
      for (; j < text.length && text[j] !== '"'; j++) {
        if (text[j] === '\\' && j + 1 < text.length) j++;
        part += text[j];
      }
      word += part;
      has = true;
      inner(part);
      i = j;
    } else if (c === '\\' && i + 1 < text.length) {
      word += text[++i];
      has = true;
    } else if (c === '$' && text[i + 1] === '(') {
      // The command inside is analysed as its own text; the outer command sees a placeholder word that holds a '$'.
      let depth = 1;
      let end = i + 2;
      for (; end < text.length && depth > 0; end++) {
        if (text[end] === '(') depth++;
        else if (text[end] === ')') depth--;
      }
      subs.push(text.slice(i + 2, end - 1));
      word += '$()';
      has = true;
      i = end - 1;
    } else if (c === '`') {
      const close = text.indexOf('`', i + 1);
      const end = close < 0 ? text.length : close;
      subs.push(text.slice(i + 1, end));
      word += '$()';
      has = true;
      i = end;
    } else if ('();|&\n'.includes(c)) {
      cut();
    } else if (c === ' ' || c === '\t') {
      flush();
    } else {
      word += c;
      has = true;
    }
  }
  cut();
  return { segments, subs };
}

function textReasons(text, ctx, depth = 0) {
  if (depth > 6) return ['shell text nested too deeply'];
  const out = [];
  const { segments, subs } = splitShell(text);
  for (const sub of subs) out.push(...textReasons(sub, ctx, depth + 1));
  for (const words of segments) out.push(...wordsReasons(words, ctx, depth));
  return out;
}

function wordsReasons(all, ctx, depth) {
  const words = [];
  for (let i = 0; i < all.length; i++) {
    if (/^\d*[<>]{1,2}&?$/.test(all[i])) i++;
    else if (!/^\d*[<>]/.test(all[i])) words.push(all[i]);
  }
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const base = path.basename(String(words[i]));
    if (SHELLS.has(base)) {
      for (let j = i + 1; j < words.length - 1; j++) {
        if (/^-[a-z]*c[a-z]*$/.test(words[j])) {
          out.push(...textReasons(words[j + 1], ctx, depth + 1));
          break;
        }
      }
    } else if (base === 'eval') {
      out.push(...textReasons(words.slice(i + 1).join(' '), ctx, depth + 1));
    } else if (base === 'git' || base === 'git.exe') {
      out.push(...gitReasons(words.slice(i + 1), ctx, depth));
      break;
    } else if (/^git-(upload-pack|receive-pack|remote-.*|fetch.*|push|pull|clone|ls-remote|send-pack|http-.*|lfs|svn|send-email|imap-send|p4)$/.test(base)) {
      out.push('git: a network helper program');
    }
  }
  return out;
}

function gitReasons(args, ctx, depth) {
  const out = [];
  const where = { dirs: [], gitDir: null, workTree: null };
  let unknown = false;
  let i = 0;
  const redirect = (key) => {
    if (REDIRECT_KEY.test(String(key))) out.push('git: a config key that can redirect a remote or run a program for it');
  };
  for (; i < args.length; i++) {
    const a = String(args[i]);
    if (a === '--' || !a.startsWith('-')) break;
    if (a === '-C') where.dirs.push(String(args[++i] ?? ''));
    else if (a === '-c' || a === '--config-env') redirect(String(args[++i] ?? '').split('=')[0]);
    else if (a.startsWith('--config-env=')) redirect(a.slice(13).split('=')[0]);
    else if (a === '--git-dir') where.gitDir = String(args[++i] ?? '');
    else if (a.startsWith('--git-dir=')) where.gitDir = a.slice(10);
    else if (a === '--work-tree') where.workTree = String(args[++i] ?? '');
    else if (a.startsWith('--work-tree=')) where.workTree = a.slice(12);
    else if (a.startsWith('--exec-path=')) out.push('git: --exec-path with a value');
    else if (['--namespace', '--super-prefix', '--attr-source', '--list-cmds'].includes(a)) i++;
    else if (/^--(namespace|super-prefix|attr-source|list-cmds)=/.test(a) || GIT_FLAGS.has(a)) continue;
    else unknown = true;
  }
  if (unknown && args.some((word) => NETWORK_WORDS.has(String(word)))) out.push('git: an unknown global option before a network word');
  const sub = args[i] === undefined ? undefined : String(args[i]);
  const rest = args.slice(i + 1).map(String);
  if (sub === undefined) return out;
  ctx.gitCount += 1;
  if (sub === 'remote') {
    const verb = rest.find((word) => !word.startsWith('-'));
    const after = rest.slice(rest.indexOf(verb) + 1);
    if (['update', 'show', 'prune', 'set-head'].includes(verb)) out.push(...networkReasons('remote', after, where, ctx, true));
    else if (verb === 'add' && rest.some((word) => word === '-f' || word === '--fetch')) out.push(...networkReasons('remote add', after, where, ctx, false));
  } else if (sub === 'submodule') {
    const verb = rest.find((word) => !word.startsWith('-'));
    const after = rest.slice(rest.indexOf(verb) + 1);
    if (verb === 'add') out.push(...networkReasons('submodule', after, where, ctx, false));
    else if (verb === 'update') out.push(...networkReasons('submodule', after, where, ctx, true));
    else if (verb === 'foreach') out.push(...textReasons(after.join(' '), ctx, depth + 1));
  } else if (sub === 'archive') {
    if (rest.some((word) => word === '--remote' || word.startsWith('--remote='))) out.push(...networkReasons('archive', rest, where, ctx, false));
  } else if (ALWAYS_NETWORK.has(sub)) {
    out.push(`git ${sub}: reaches a network whatever its arguments are`);
  } else if (NETWORK_WORDS.has(sub)) {
    out.push(...networkReasons(sub, rest, where, ctx, false));
  } else if (!LOCAL_SUBCOMMANDS.has(sub)) {
    out.push('git: an unknown subcommand (it could be an alias or an external command)');
  }
  return out;
}

function loadConfig(where, ctx) {
  const vars = {
    PATH: process.env.PATH || '', HOME: state.home || os.tmpdir(), GIT_CONFIG_GLOBAL: ctx.vars.GIT_CONFIG_GLOBAL || emptyConfigFile('global'), GIT_CONFIG_SYSTEM: ctx.vars.GIT_CONFIG_SYSTEM || emptyConfigFile('system'),
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file',
  };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) if (ctx.vars[name]) vars[name] = ctx.vars[name];
  const argv = [];
  if (where.gitDir) argv.push(`--git-dir=${where.gitDir}`);
  if (where.workTree) argv.push(`--work-tree=${where.workTree}`);
  const result = real.spawnSync(REAL_GIT, [...argv, 'config', '--list', '-z'], { cwd: path.resolve(ctx.cwd, ...where.dirs), env: vars, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) return null;
  const config = { rewrites: [], remotes: new Map(), loose: [], submodules: [] };
  for (const entry of result.stdout.split('\0').filter(Boolean)) {
    const cut = entry.indexOf('\n');
    const key = cut < 0 ? entry : entry.slice(0, cut);
    const value = cut < 0 ? '' : entry.slice(cut + 1);
    const last = key.lastIndexOf('.');
    const kind = key.slice(last + 1).toLowerCase();
    if (/^url\./i.test(key) && (kind === 'insteadof' || kind === 'pushinsteadof')) config.rewrites.push({ kind, prefix: value, base: key.slice(4, last) });
    else if (/^remote\./i.test(key) && (kind === 'url' || kind === 'pushurl')) {
      const name = key.slice(7, last);
      if (!config.remotes.has(name)) config.remotes.set(name, []);
      config.remotes.get(name).push(value);
    } else if (/^remote\.pushdefault$/i.test(key) || (/^branch\./i.test(key) && (kind === 'remote' || kind === 'pushremote'))) config.loose.push(value);
    else if (/^submodule\./i.test(key) && kind === 'url') config.submodules.push(value);
  }
  return config;
}

function rewritten(url, config) {
  const out = [url];
  for (const kind of ['insteadof', 'pushinsteadof']) {
    let best = null;
    for (const rule of config.rewrites) if (rule.kind === kind && url.startsWith(rule.prefix) && (!best || rule.prefix.length > best.prefix.length)) best = rule;
    if (best) out.push(best.base + url.slice(best.prefix.length));
  }
  return out;
}

// A push, fetch, pull, clone, ls-remote, remote update, submodule update (and the like) must name only local addresses, and
// so must every remote it could use: the named one, or all of them when none is named. The configuration is read through git
// itself with an empty global and system config, so insteadOf and pushurl are applied as git would apply them.
function networkReasons(label, rest, where, ctx, allRemotes) {
  const out = [];
  const positionals = [];
  let all = allRemotes;
  let ended = false;
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i];
    if (/[$`]/.test(word)) out.push(`git ${label}: an unexpanded variable or command in a network command`);
    if (isStrongRemote(word)) out.push(`git ${label}: a non-local address`);
    if (!ended && word === '--') ended = true;
    else if (!ended && (word === '--all' || word === '-a' || word === '--multiple')) all = true;
    else if (!ended && /^--recurse-submodules(=|$)/.test(word) && word !== '--recurse-submodules=no') out.push(`git ${label}: submodule recursion`);
    else if (!ended && /^--repo=/.test(word)) positionals.unshift(word.slice(7));
    else if (!ended && (word === '-c' || word === '--config')) {
      if (REDIRECT_KEY.test(String(rest[++i] ?? '').split('=')[0])) out.push(`git ${label}: a config key that can redirect a remote`);
    } else if (!ended && VALUE_OPTIONS.has(word)) {
      const value = rest[++i];
      if (word === '--remote' && value !== undefined) positionals.unshift(value);
    } else if (ended || !word.startsWith('-')) positionals.push(word);
  }
  const named = all ? null : positionals[0];
  const urlWord = label === 'remote add' ? positionals[1] : named;
  if (urlWord !== null && urlWord !== undefined && !isLocalTarget(urlWord)) out.push(`git ${label}: a non-local address`);
  if (out.length === 0 && label !== 'remote add' && !(label === 'archive' && named === undefined)) {
    const config = loadConfig(where, ctx);
    if (!config) {
      out.push(`git ${label}: the remote configuration cannot be read`);
    } else {
      if (config.rewrites.some((rule) => !isLocalTarget(rule.base))) out.push(`git ${label}: a url rewrite to a non-local base is configured`);
      const candidates = [];
      if (named !== null && named !== undefined) {
        if (config.remotes.has(named)) candidates.push(...config.remotes.get(named).flatMap((url) => rewritten(url, config)));
        else candidates.push(...rewritten(named, config));
      } else {
        for (const urls of config.remotes.values()) candidates.push(...urls.flatMap((url) => rewritten(url, config)));
        for (const value of config.loose) if (!config.remotes.has(value)) candidates.push(...rewritten(value, config));
        if (label === 'submodule') for (const url of config.submodules) candidates.push(...rewritten(url, config));
      }
      if (candidates.some((url) => !isLocalTarget(url))) out.push(`git ${label}: a remote resolves to a non-local address`);
    }
  }
  return [...new Set(out)];
}

// ---- seam and checks --------------------------------------------------------------------------------------------------
function scratchDir() {
  if (!state.dir) {
    state.dir = fs.mkdtempSync(path.join(state.tempRoot, 'child-isolation-'));
    fs.chmodSync(state.dir, 0o700);
  }
  return state.dir;
}
function emptyConfigFile(name) {
  const file = path.join(scratchDir(), `gitconfig-${name}`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, '', { mode: 0o600 });
  return file;
}
function isUnderTemp(candidate) {
  const text = String(candidate);
  if (!path.isAbsolute(text)) return false;
  const resolved = path.resolve(text);
  return [state.tempRoot, safeReal(state.tempRoot)].some((root) => resolved === root || resolved.startsWith(root + path.sep));
}
function safeReal(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}
function isNode(file) {
  const base = path.basename(String(file));
  return base === 'node' || base === 'nodejs' || base === 'node.exe' || file === process.execPath;
}
function callFrames() {
  const frames = [];
  for (const line of String(new Error().stack).split('\n').slice(1)) {
    const found = line.includes('node:') ? null : /(\/[^():]+):(\d+):\d+\)?$/.exec(line.trim());
    if (found && found[1] !== SELF) frames.push({ file: found[1], line: found[2] });
  }
  return frames;
}
function callFrame() {
  return callFrames()[0] || { file: 'unknown', line: '0' };
}
function callSite() {
  const frame = callFrame();
  return frame.file === 'unknown' ? 'unknown' : `${path.relative(process.cwd(), frame.file)}:${frame.line}`;
}
function hasPreload(argv) {
  return argv.some((word, index) => word === SELF && (argv[index - 1] === '--require' || argv[index - 1] === '-r')) || argv.includes(`--require=${SELF}`);
}

// Checks what is about to start (after the seam): the home, the passwd-home preload for a node child, the git layer for any
// other child. `vars` is the final environment as a plain object.
function finalReasons(vars, argv, node, preloadOptional) {
  const out = [];
  if (vars.HOME === REAL_PASSWD_HOME) out.push('HOME is the real passwd home');
  else if (!isUnderTemp(vars.HOME ?? '')) out.push(`HOME is ${vars.HOME === undefined ? 'unset' : vars.HOME === '' ? 'empty' : path.isAbsolute(vars.HOME) ? 'outside the test temp dir' : 'relative'}`);
  if (node) {
    if (!preloadOptional && !hasPreload(argv)) out.push('a node child without the isolation preload on its command line');
    if (!vars[PASSWD_NAME] || !path.isAbsolute(vars[PASSWD_NAME]) || vars[PASSWD_NAME] === REAL_PASSWD_HOME) out.push('a node child without a scratch passwd home');
  } else {
    if (!isUnderTemp(vars.GIT_CONFIG_GLOBAL ?? '') || !isUnderTemp(vars.GIT_CONFIG_SYSTEM ?? '')) out.push('GIT_CONFIG_GLOBAL or GIT_CONFIG_SYSTEM is not a private file under the test temp dir');
    if (vars.GIT_CONFIG_NOSYSTEM !== '1' || vars.GIT_TERMINAL_PROMPT !== '0' || vars.GIT_ALLOW_PROTOCOL !== 'file') out.push('the git layer (GIT_CONFIG_NOSYSTEM, GIT_TERMINAL_PROMPT, GIT_ALLOW_PROTOCOL) is not set');
    for (const name of Object.keys(vars)) if (FORBIDDEN_GIT_NAMES.includes(name) || FORBIDDEN_GIT_PATTERN.test(name)) out.push(`${name} is set for a child that is not node`);
  }
  return out;
}

function refuse(name, reasons) {
  const error = new Error(`ESPAWNGUARD at ${callSite()}: ${name}: ${[...new Set(reasons)].join('; ')}`);
  error.code = 'ESPAWNGUARD';
  state.refusals += 1;
  state.pending.push(error);
  throw error;
}

function parseArgs(name, argv) {
  const rest = argv.slice();
  const file = rest.shift();
  let args = [];
  let options;
  if (name === 'exec' || name === 'execSync') {
    if (rest[0] && typeof rest[0] === 'object') options = rest.shift();
  } else {
    if (Array.isArray(rest[0]) || rest[0] === null) args = rest.shift() || [];
    if (rest[0] && typeof rest[0] === 'object' && !Array.isArray(rest[0])) options = rest.shift();
  }
  return { file, args: args.slice(), options: { ...(options || {}) }, tail: rest, exec: name === 'exec' || name === 'execSync' };
}

// The seam plus the checks for one child. Returns the arguments to call the real function with (or throws ESPAWNGUARD).
function prepare(name, argv) {
  const call = parseArgs(name, argv);
  const { options } = call;
  const given = options.env ? { ...options.env } : null;
  const vars = { ...(given || process.env) };
  for (const key of Object.keys(vars)) if (vars[key] === undefined) delete vars[key];
  const shell = call.exec || Boolean(options.shell);
  const node = name === 'fork' || (!shell && isNode(call.file));
  const reasons = [];
  const ambient = (key) => given && given[key] !== undefined && given[key] !== process.env[key];

  if (vars.HOME === undefined) {
    vars.HOME = state.home;
    if (state.homeFilled.size < 200) {
      const frames = callFrames();
      const test = frames.find((frame) => frame.file.includes(`${path.sep}test${path.sep}`) && !frame.file.includes(`${path.sep}support${path.sep}`));
      const show = (frame) => (frame ? `${path.relative(process.cwd(), frame.file)}:${frame.line}` : 'unknown');
      state.homeFilled.add(`${show(frames[0])} (test ${show(test)})`);
    }
  }
  if (ambient(PASSWD_NAME) && (!path.isAbsolute(String(given[PASSWD_NAME])) || given[PASSWD_NAME] === REAL_PASSWD_HOME)) reasons.push(`${PASSWD_NAME} is not a scratch folder`);
  if (!vars[PASSWD_NAME] || !path.isAbsolute(String(vars[PASSWD_NAME])) || vars[PASSWD_NAME] === REAL_PASSWD_HOME) vars[PASSWD_NAME] = state.passwdHome;

  // A node child whose command line the shipped code reads back and compares (the controller's /proc/<pid>/cmdline identity
  // check) is started as built: it keeps HOME and the scratch passwd name but gets no --require. That is a test's explicit
  // option (isolationKeepsArgv: true on the spawn) or a call site listed at install (argvChecked) for shipped code.
  const marked = options.isolationKeepsArgv === true;
  delete options.isolationKeepsArgv;
  const keepArgv = node && name !== 'fork' && (marked || (state.argvChecked.length > 0 && state.argvChecked.some((rel) => callFrame().file.endsWith(path.sep + rel))));
  if (node && !keepArgv) {
    if (name === 'fork') {
      const execArgv = options.execArgv || process.execArgv;
      options.execArgv = hasPreload(execArgv) ? execArgv.slice() : ['--require', SELF, ...execArgv];
    } else if (!hasPreload(call.args)) {
      call.args.unshift('--require', SELF);
    }
  } else {
    for (const key of Object.keys(vars)) {
      if (!FORBIDDEN_GIT_NAMES.includes(key) && !FORBIDDEN_GIT_PATTERN.test(key)) continue;
      if (ambient(key)) reasons.push(`${key} is set for a child that is not node`);
      delete vars[key];
    }
    for (const key of ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM']) {
      if (!(given && ambient(key) && isUnderTemp(given[key]))) vars[key] = emptyConfigFile(key === 'GIT_CONFIG_GLOBAL' ? 'global' : 'system');
    }
    if (ambient('GIT_ALLOW_PROTOCOL') && given.GIT_ALLOW_PROTOCOL !== 'file') reasons.push('GIT_ALLOW_PROTOCOL is set to more than file');
    vars.GIT_CONFIG_NOSYSTEM = '1';
    vars.GIT_TERMINAL_PROMPT = '0';
    vars.GIT_ALLOW_PROTOCOL = 'file';
  }

  const words = [call.file, ...call.args].map(String);
  const ctx = { cwd: path.resolve(String(options.cwd || process.cwd())), vars, gitCount: 0 };
  reasons.push(...(shell ? textReasons(words.join(' '), ctx) : wordsReasons(words, ctx, 0)));
  reasons.push(...finalReasons(vars, name === 'fork' ? options.execArgv : call.args, node, keepArgv));
  state.checked += 1;
  state.git += ctx.gitCount > 0 ? 1 : 0;
  if (reasons.length) refuse(name, reasons);

  options.env = vars;
  return call.exec ? [call.file, options, ...call.tail] : [call.file, call.args, options, ...call.tail];
}

// The net: anything that reaches ChildProcess.prototype.spawn without passing through a wrapped function (an export captured
// before the isolation was loaded, `new ChildProcess()`) is checked as it stands. It is refused unless it already carries
// the seam, because by now its arguments can no longer be fixed.
function netReasons(options) {
  const vars = {};
  for (const pair of options.envPairs || []) {
    const cut = String(pair).indexOf('=');
    if (cut > 0) vars[String(pair).slice(0, cut)] = String(pair).slice(cut + 1);
  }
  const argv = (options.args || []).map(String);
  const node = isNode(options.file);
  const ctx = { cwd: path.resolve(String(options.cwd || process.cwd())), vars, gitCount: 0 };
  const out = [...wordsReasons([String(options.file), ...argv.slice(1)], ctx, 0), ...finalReasons(vars, argv, node)];
  state.checked += 1;
  state.git += ctx.gitCount > 0 ? 1 : 0;
  return out;
}

function install(options) {
  if (state.installed) return module.exports;
  state.installed = true;
  state.tempRoot = path.resolve(options.tempRoot);
  state.home = options.home;
  state.passwdHome = options.passwdHome;
  state.argvChecked = options.argvChecked || [];
  process.env[PASSWD_NAME] = options.passwdHome;
  applyPasswdFake();
  for (const name of FUNCTIONS) {
    const original = cp[name];
    cp[name] = function guarded(...argv) {
      const next = prepare(name, argv);
      state.depth += 1;
      try {
        return original.apply(this, next);
      } finally {
        state.depth -= 1;
      }
    };
  }
  const spawn = cp.ChildProcess.prototype.spawn;
  cp.ChildProcess.prototype.spawn = function guardedNet(options) {
    if (state.depth === 0) {
      const reasons = netReasons(options);
      if (reasons.length) refuse('ChildProcess.spawn', reasons);
    }
    return spawn.call(this, options);
  };
  if (options.testHooks) {
    require('node:test').afterEach(() => {
      const refused = state.pending.splice(0);
      if (refused.length) throw new Error(`the spawn guard refused ${refused.length} child(ren) during this test: ${refused.map((error) => error.message).join(' | ')}`);
    });
  }
  process.once('exit', () => {
    if (state.pending.length && !process.exitCode) process.exitCode = 1;
    const report = process.env.SBT_SPAWN_GUARD_REPORT;
    if (report && path.isAbsolute(report)) {
      const row = { pid: process.pid, file: path.basename(String(process.argv[1] || '')), checked: state.checked, git: state.git, refusals: state.refusals, expected: state.expected, homeFilled: [...state.homeFilled] };
      try {
        fs.appendFileSync(report, `${JSON.stringify(row)}\n`);
      } catch {
        // The report is optional.
      }
    }
  });
  return module.exports;
}

// For tools that are not run by the repo's own isolated-environment: a private temp root, home and passwd home, then install.
function bootstrap(prefix) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  fs.chmodSync(tempRoot, 0o700);
  process.env.TMPDIR = tempRoot;
  const home = fs.mkdtempSync(path.join(tempRoot, 'home-'));
  const passwdHome = fs.mkdtempSync(path.join(tempRoot, 'passwd-'));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.once('exit', () => fs.rmSync(tempRoot, { recursive: true, force: true }));
  install({ tempRoot, home, passwdHome });
  return { tempRoot, home, passwdHome };
}

// For a test that expects a refusal: runs `run`, returns the ESPAWNGUARD error and marks it as expected. A refusal that is
// not passed through here (a swallowed one) still fails the test that caused it and the process.
function refuses(run) {
  try {
    run();
  } catch (error) {
    if (!error || error.code !== 'ESPAWNGUARD') throw error;
    const at = state.pending.indexOf(error);
    if (at >= 0) {
      state.pending.splice(at, 1);
      state.expected += 1;
    }
    return error;
  }
  return null;
}

module.exports = {
  SELF, PASSWD_NAME, install, bootstrap, refuses, isLocalTarget,
  realPasswdHome: () => REAL_PASSWD_HOME,
  counts: () => ({ checked: state.checked, git: state.git, refusals: state.refusals, expected: state.expected, pending: state.pending.length }),
  // What the seam and the guard would do with one call, without starting anything: { refused: message|null, argv }.
  plan: (name, ...argv) => {
    const error = refuses(() => {
      plan.argv = prepare(name, argv);
    });
    return error ? { refused: error.message, argv: null } : { refused: null, argv: plan.argv };
  },
};

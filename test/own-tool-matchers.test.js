const { deadRegistryHome } = require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const PINS = require('../src/pins');
const installer = require('../src/installer');
const own = require('../src/marrow-own-tools');
const { fakeRuntime } = require('./support/fake-runtime');

// The registered names, as @getmarrow/mcp fix/own-tool-exact (4311df21) lists them.
const NAMES_JSON = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'marrow-own-tool-names.json'), 'utf8'));
const NAMES = NAMES_JSON.names;
const FIXTURES = path.join(__dirname, 'fixtures', 'installer-0168');
const OWNER_FILES = path.join(__dirname, 'fixtures', 'installer-0167', 'owner-files.json');

// The 0.1.68 strings, for the "never looser than master" checks.
const OLD = {
  claude: 'Bash|Edit|Write|MultiEdit|Read|Glob|Grep|Search|WebSearch|Task|functions\\.(?!mcp__marrow__marrow_).*|mcp__(?!marrow__marrow_).*',
  codex: 'Bash|apply_patch|Edit|Write|MultiEdit|mcp__(?!marrow__marrow_).*|functions\\.(?!marrow_).*',
  cursor: 'Shell|Write|Delete|Task|Read|Glob|Grep|Search|WebSearch|List|MCP:(?!marrow(?:_.*|:marrow_.*)$).*',
  cursorPreToolUseHostApproval: 'Write|Delete|Task|Read|Glob|Grep|Search|WebSearch|List|MCP:(?!marrow(?:_.*|:marrow_.*)$).*',
  gemini: '^(?:run_shell_command|write_file|replace|edit_file|delete_file|read_file|read_many_files|glob|grep_search|list_directory|get_file_info|web_search|google_web_search|mcp_(?!marrow_marrow_)[A-Za-z0-9_]{1,192})$',
};

const OWN = NAMES.join('|');
const GEMINI_BUILTINS = 'run_shell_command|write_file|replace|edit_file|delete_file|read_file|read_many_files|glob|grep_search|list_directory|get_file_info|web_search|google_web_search';

// The r1 candidate (8371de15) strings, for the "never looser than r1" checks.
const R1 = (() => {
  const tail = `functions\\.(?!mcp__marrow__(?:${OWN})$).*|mcp__(?!marrow__(?:${OWN})$).*`;
  const cursorMcp = `MCP:(?!(?:marrow:)?(?:${OWN})$).*`;
  return {
    claude: `Bash|Edit|Write|MultiEdit|Read|Glob|Grep|Search|WebSearch|Task|${tail}`,
    codex: `Bash|apply_patch|Edit|Write|MultiEdit|${tail}`,
    cursor: `Shell|Write|Delete|Task|Read|Glob|Grep|Search|WebSearch|List|${cursorMcp}`,
    cursorPreToolUseHostApproval: `Write|Delete|Task|Read|Glob|Grep|Search|WebSearch|List|${cursorMcp}`,
    gemini: `^(?:${GEMINI_BUILTINS}|mcp_(?!marrow_(?:${OWN})$).*)$`,
  };
})();

// The exact strings of the rule, assembled here from the JSON (not from the module).
function expectedStrings() {
  const tail = `^(?!mcp__marrow__(?:${OWN})$)[\\s\\S]*(?:functions\\.|mcp__)[\\s\\S]*`;
  const cursorMcp = '[\\s\\S]*MCP:[\\s\\S]*';
  return {
    claude: `Bash|Edit|Write|MultiEdit|Read|Glob|Grep|Search|WebSearch|Task|${tail}`,
    codex: `Bash|apply_patch|Edit|Write|MultiEdit|${tail}`,
    cursor: `Shell|Write|Delete|Task|Read|Glob|Grep|Search|WebSearch|List|${cursorMcp}`,
    cursorPreToolUseHostApproval: `Write|Delete|Task|Read|Glob|Grep|Search|WebSearch|List|${cursorMcp}`,
    gemini: `^(?:${GEMINI_BUILTINS}|mcp_[\\s\\S]*)$|^[^A-Za-z_][\\s\\S]*`,
  };
}

// How a host applies a matcher. Claude Code, Cursor and Gemini run RegExp.prototype.test on the
// label and Codex runs Regex::is_match: all unanchored (a search). Every case is also checked
// under a full match, so no result depends on which of the two a host uses.
const SEMANTICS = {
  full: (matcher) => new RegExp(`^(?:${matcher})$`),
  search: (matcher) => new RegExp(matcher),
};
const MODES = Object.keys(SEMANTICS);
const COMPILED = new Map();
function reaches(matcher, tool, mode) {
  const key = `${mode}\u0000${matcher}`;
  if (!COMPILED.has(key)) COMPILED.set(key, SEMANTICS[mode](matcher));
  return COMPILED.get(key).test(tool);
}

// Labels a host might send for a (server, tool) pair, written raw.
const FORMS = {
  claude: (server, tool) => [`mcp__${server}__${tool}`, `functions.mcp__${server}__${tool}`],
  codex: (server, tool) => [`mcp__${server}__${tool}`, `functions.mcp__${server}__${tool}`],
  cursor: (server, tool) => [`MCP:${tool}`, `MCP:${server}:${tool}`],
  cursorPreToolUseHostApproval: (server, tool) => [`MCP:${tool}`, `MCP:${server}:${tool}`],
  gemini: (server, tool) => [`mcp_${server}_${tool}`],
};
// The only labels any matcher skips: the exact Claude Code label of an own tool on server `marrow`
// (shared by the Codex string). Cursor's `MCP:<tool>` and Gemini's `mcp_<server>_<tool>` cannot
// prove the server, so no label is skipped there.
const SKIPPED = {
  claude: (name) => [`mcp__marrow__${name}`],
  codex: (name) => [`mcp__marrow__${name}`],
  cursor: () => [],
  cursorPreToolUseHostApproval: () => [],
  gemini: () => [],
};
const skippedSet = (key) => new Set(NAMES.flatMap(SKIPPED[key]));

// Each host's real label for a (server, tool) pair, transcribed from the host sources
// (evidence/r2/host-label-research.md).
function claudeIn(value) {
  // Claude Code 2.1.296 In(): every char outside [a-zA-Z0-9_-] becomes `_`; claude.ai connectors collapse.
  let out = value.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (value.startsWith('claude.ai ')) out = out.replace(/_+/g, '_').replace(/^_|_$/g, '');
  return out;
}
function geminiLabel(server, tool) {
  // Gemini CLI 0.63.0 generateValidName(`${server}_${tool}`).
  let name = `${server}_${tool}`;
  name = name.startsWith('mcp_') ? name : `mcp_${name}`;
  name = name.replace(/[^a-zA-Z0-9_\-.:]/g, '_');
  if (/^[^a-zA-Z_]/.test(name)) name = `_${name}`;
  if (name.length > 63) name = `${name.slice(0, 30)}...${name.slice(-30)}`;
  return name;
}
const HOST_LABELS = {
  claude: (server, tool) => [`mcp__${claudeIn(server)}__${claudeIn(tool)}`],
  // Cursor CLI 2026.10.01: preToolUse/postToolUse send `MCP:${toolName}`, never the server.
  cursor: (server, tool) => [`MCP:${tool}`],
  cursorPreToolUseHostApproval: (server, tool) => [`MCP:${tool}`],
  gemini: (server, tool) => [geminiLabel(server, tool)],
};

const SERVER_VARIANTS = ['MARROW', 'Marrow', 'mARROW', 'marroW', 'marrow2', 'marrow_', '_marrow', 'xmarrow', 'marrowx', 'marrow-evil', 'evil', 'plugin_marrow_marrow',
  'mаrrow', 'ｍarrow', 'marrow​', 'marrow ', ' marrow', 'marrow_marrow', 'marrow-', 'marrow.', 'marrow marrow', 'mcp_marrow', 'marrow__marrow', 'marrow:marrow',
  'claude.ai marrow', 'evil-server', 'evil_server'];
const TOOL_VARIANTS = ['MARROW_COMMIT', 'Marrow_commit', 'marrow_Commit', 'marrow_delete_all', 'marrow_exec', 'marrow_x', 'marrow_', 'marrow', 'marrow_commitx',
  'marrow_commit ', ' marrow_commit', 'marrow_commit\t', 'marrow_workflow_', 'marrow_workflow_gatex', 'marrow_workflowgate', 'marrow_commit|marrow_ask',
  'marrow_x__deploy_prod', 'marrow_commit__mcp__github__push', 'constructor', '__proto__', 'delete_all', 'x', 'xmarrow_commit', 'commit', '_marrow_commit',
  'marrow.commit', 'marrow-commit', 'marrow:marrow_commit', 'marrow_marrow_commit'];
// Padding a label may carry before, after or on both sides.
const PADS = ['\n', '\r', '\r\n', ' ', ' ', ' ', '\t', '\u0000'];
const padded = (label) => PADS.flatMap((pad) => [`${pad}${label}`, `${label}${pad}`, `${pad}${label}${pad}`]);

// Every label a matcher is checked against: the abuse probes plus every own name in every form.
function probes(key) {
  const out = [];
  for (const server of SERVER_VARIANTS) for (const tool of ['marrow_commit', 'marrow_delete_all', ...NAMES.slice(0, 3)]) out.push(...FORMS[key](server, tool));
  for (const tool of TOOL_VARIANTS) out.push(...FORMS[key]('marrow', tool));
  for (const name of NAMES) out.push(...FORMS[key]('marrow', name));
  if (key === 'claude' || key === 'codex') {
    out.push('mcp__evil__x', 'mcp__marrow__marrow_delete_all', 'mcp__MARROW__marrow_commit', 'mcp__marrow__marrow_commit ',
      'functions.mcp__MARROW__marrow_commit', 'functions.marrow_commit', 'functions.marrow_delete_all', 'functions.mcp__marrow__marrow_x',
      'functions.functions.mcp__marrow__marrow_commit', 'functions.mcp__evil__mcp__marrow__marrow_commit', 'mcp__evil__mcp__marrow__marrow_commit',
      'xmcp__marrow__marrow_commit', 'mcp__marrow__marrow_commitmcp__marrow__marrow_commit', 'mcp__marrow__mcp__marrow__marrow_commit',
      'functions.exec', 'functions.apply_patch', 'Bash', 'Write', 'Edit', 'MultiEdit');
  }
  if (key === 'claude') out.push('Read', 'Glob', 'Grep', 'Search', 'WebSearch', 'Task');
  if (key === 'codex') out.push('apply_patch');
  if (key.startsWith('cursor')) {
    out.push('MCP:marrow_commit', 'MCP:marrow:marrow_commit', 'MCP:evil:marrow_commit', 'MCP:marrow_delete_all', 'MCP:MARROW:marrow_commit',
      'MCP:Marrow:marrow_commit', 'MCP:marrow:marrow_commit ', 'MCP:marrow_commit ', 'MCP::marrow_commit', 'MCP:marrow:marrow:marrow_commit', 'MCP:',
      'MCP:toString', 'xMCP:marrow_commit', 'Write', 'Delete', 'Read', 'List');
    if (key === 'cursor') out.push('Shell');
  }
  if (key === 'gemini') {
    out.push('mcp_marrow_marrow_commit', 'mcp_marrow_marrow_delete_all', 'mcp_MARROW_marrow_commit', 'mcp_marrow_marrow_commit ', 'mcp_evil_x', 'mcp_marrow_x',
      'mcp_evil-server_deploy', `mcp_evil_${'x'.repeat(200)}`, 'mcp_mcp_marrow_marrow_commit', 'run_shell_command', 'write_file', 'replace', 'read_file', 'web_search');
  }
  return [...new Set(out)];
}

test('src/marrow-own-tools.js holds exactly the 58 registered names, in file order', () => {
  assert.equal(NAMES_JSON.count, 58);
  assert.equal(NAMES.length, 58);
  assert.deepEqual([...own.MARROW_OWN_TOOL_NAMES], NAMES);
  assert.equal(new Set(NAMES).size, 58);
  assert.equal(Object.isFrozen(own.MARROW_OWN_TOOL_NAMES), true);
  assert.equal(own.MARROW_OWN_SERVER, 'marrow');
  // One `__` split only: no name holds `__`, so `mcp__marrow__<name>` has a single reading.
  for (const name of NAMES) assert.equal(name.includes('__'), false, name);
});

test('every matcher is the exact string of the rule, built from the names, and the installer writes it', () => {
  const expected = expectedStrings();
  assert.deepEqual(own.buildOwnToolMatchers(), expected);
  assert.equal(installer.NATIVE_HOOK_MATCHER, expected.claude);
  assert.equal(installer.CURSOR_NATIVE_HOOK_MATCHER, expected.cursor);
  assert.equal(installer.CURSOR_PRE_TOOL_USE_HOST_APPROVAL_MATCHER, expected.cursorPreToolUseHostApproval);
  assert.equal(installer.GEMINI_NATIVE_HOOK_MATCHER, expected.gemini);
  // Byte-identical with @getmarrow/mcp NATIVE_HOOK_MATCHER (MCP_SYNC_STRING in the r2 result).
  assert.equal(installer.NATIVE_HOOK_MATCHER,
    `Bash|Edit|Write|MultiEdit|Read|Glob|Grep|Search|WebSearch|Task|^(?!mcp__marrow__(?:${OWN})$)[\\s\\S]*(?:functions\\.|mcp__)[\\s\\S]*`);
  for (const [key, matcher] of Object.entries(expected)) {
    // Every consuming part is exactly `[\s\S]*`: no `.*`, `(?s)`, `[^]` or m flag that a line terminator could escape.
    assert.equal(/(^|[^\\])\.[*+]/.test(matcher), false, key);
    assert.equal(matcher.includes('(?s)') || matcher.includes('[^]') || matcher.includes('(?m)'), false, key);
    assert.doesNotThrow(() => new RegExp(matcher), key);
  }
  // A name that is not a plain identifier never reaches a regex source or the guard.
  for (const bad of ['marrow_.*', 'marrow_x|evil', 'marrow_x)$|(?=', 'MARROW_X', 'marrow_x"', '', 'evil']) {
    assert.throws(() => own.buildOwnToolMatchers([bad]), /invalid Marrow tool name/, bad);
    assert.throws(() => own.cursorOwnToolGuardCondition([bad]), /invalid Marrow tool name/, bad);
  }
  assert.throws(() => own.buildOwnToolMatchers([]), /invalid Marrow tool name list/);
});

test('each matcher skips exactly the labels its host proves are own, and nothing else, under search and full match', () => {
  for (const [key, matcher] of Object.entries(own.buildOwnToolMatchers())) {
    const skipped = skippedSet(key);
    assert.equal(skipped.size, key === 'claude' || key === 'codex' ? 58 : 0, key);
    for (const mode of MODES) {
      for (const label of skipped) assert.equal(reaches(matcher, label, mode), false, `${key}/${mode}: own ${JSON.stringify(label)} must be skipped`);
      for (const probe of probes(key)) {
        assert.equal(reaches(matcher, probe, mode), !skipped.has(probe), `${key}/${mode}: ${JSON.stringify(probe)}`);
      }
    }
  }
});

test('collisions: a label is skipped only when no (server, tool) pair but (marrow, an own name) can produce it', () => {
  const matchers = own.buildOwnToolMatchers();
  const servers = ['marrow', ...SERVER_VARIANTS];
  const tools = [...NAMES, ...TOOL_VARIANTS];
  for (const [key, label] of Object.entries(HOST_LABELS)) {
    for (const mode of MODES) {
      for (const server of servers) {
        for (const tool of tools) {
          for (const value of label(server, tool)) {
            const skipped = !reaches(matchers[key], value, mode);
            // Claude Code: only server `marrow` (the trust anchor) reaches `mcp__marrow__`; on it the
            // tool part must be an own name after the host's own normalisation.
            const allowed = key === 'claude' && server === 'marrow' && NAMES.includes(claudeIn(tool));
            if (skipped) assert.equal(allowed, true, `${key}/${mode}: (${JSON.stringify(server)}, ${JSON.stringify(tool)}) -> ${JSON.stringify(value)} skipped`);
            if (key === 'claude' && server === 'marrow' && NAMES.includes(tool)) assert.equal(skipped, true, `${key}/${mode}: own ${tool}`);
          }
        }
      }
    }
  }
  // Gemini: these pairs all give one label, so it is never skipped.
  const shared = geminiLabel('marrow', 'marrow_commit');
  assert.equal(shared, 'mcp_marrow_marrow_commit');
  for (const [server, tool] of [['marrow_marrow', 'commit'], ['mcp_marrow', 'marrow_commit'], ['marrow marrow', 'commit'], ['marrow/marrow', 'commit']]) {
    assert.equal(geminiLabel(server, tool), shared, `${server}/${tool}`);
  }
  for (const mode of MODES) {
    assert.equal(reaches(matchers.gemini, shared, mode), true, mode);
    // Cursor: `MCP:<tool>` carries no server, and a tool named `marrow:marrow_commit` on any server
    // gives `MCP:marrow:marrow_commit`; both forms reach the hook, as does a foreign server.
    for (const key of ['cursor', 'cursorPreToolUseHostApproval']) {
      for (const value of ['MCP:marrow_commit', 'MCP:marrow:marrow_commit', 'MCP:evil:marrow_commit', 'MCP:marrow_workflow_gate']) {
        assert.equal(reaches(matchers[key], value, mode), true, `${key}/${mode}: ${value}`);
      }
    }
    // Claude Code: look-alike servers give other labels, which reach the hook.
    for (const server of ['marrow_', 'marrow-', 'marrow.', 'MARROW', 'Marrow', 'marrow_marrow', 'marrow__marrow', 'claude.ai marrow']) {
      const value = HOST_LABELS.claude(server, 'marrow_commit')[0];
      assert.notEqual(value, 'mcp__marrow__marrow_commit', server);
      assert.equal(reaches(matchers.claude, value, mode), true, `${mode}: ${server} -> ${value}`);
    }
  }
});

test('padded labels (LF, CR, CRLF, U+2028, U+2029, space, tab, NUL; before, after, both) always reach the hook', () => {
  for (const [key, matcher] of Object.entries(own.buildOwnToolMatchers())) {
    for (const name of NAMES) {
      const labels = [...FORMS[key]('marrow', name), ...SKIPPED[key](name), ...(key === 'gemini' ? [geminiLabel('marrow', name)] : [])];
      for (const label of new Set(labels)) {
        for (const value of padded(label)) {
          for (const mode of MODES) assert.equal(reaches(matcher, value, mode), true, `${key}/${mode}: ${JSON.stringify(value)}`);
        }
      }
    }
  }
});

test('no matcher is looser than 0.1.68 or the r1 candidate: whatever reached the hook before still does', () => {
  const now = own.buildOwnToolMatchers();
  for (const key of Object.keys(OLD)) {
    const sample = [...probes(key), ...NAMES.slice(0, 4).flatMap((name) => [...FORMS[key]('marrow', name), ...SKIPPED[key](name)]).flatMap(padded),
      'mcp__marrow__marrow_commit\n', 'MCP:marrow_commit\n', 'mcp_marrow_marrow_commit\n', 'mcp__evil__x\n'];
    for (const mode of MODES) {
      for (const probe of sample) {
        if (reaches(OLD[key], probe, mode)) assert.equal(reaches(now[key], probe, mode), true, `0.1.68 ${key}/${mode}: ${JSON.stringify(probe)}`);
        if (reaches(R1[key], probe, mode)) assert.equal(reaches(now[key], probe, mode), true, `r1 ${key}/${mode}: ${JSON.stringify(probe)}`);
      }
    }
    // And labels that 0.1.68 and r1 skipped now reach the hook.
    const opened = (base) => sample.filter((probe) => !reaches(base[key], probe, 'search') && reaches(now[key], probe, 'search'));
    assert.ok(opened(OLD).length >= 5, `${key}: ${opened(OLD).length}`);
    assert.ok(opened(R1).length >= 5, `${key}: ${opened(R1).length}`);
  }
});

test('the named cases for the Claude Code / Codex matcher', () => {
  for (const key of ['claude', 'codex']) {
    const matcher = own.buildOwnToolMatchers()[key];
    for (const mode of MODES) {
      for (const tool of ['mcp__marrow__marrow_delete_all', 'mcp__MARROW__marrow_commit', 'mcp__marrow__marrow_commit ', 'mcp__evil__x',
        '\nmcp__marrow__marrow_commit', 'mcp__marrow__marrow_commit ',
        // No host sends `functions.mcp__…` today; it cannot prove the server, so it reaches the hook.
        'functions.mcp__marrow__marrow_workflow_gate']) {
        assert.equal(reaches(matcher, tool, mode), true, `${key}/${mode}: ${JSON.stringify(tool)}`);
      }
      assert.equal(reaches(matcher, 'mcp__marrow__marrow_commit', mode), false);
      assert.equal(reaches(matcher, 'mcp__marrow__marrow_workflow', mode), false);
    }
  }
});

function workspace(prefix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(base, 0o700);
  const home = path.join(base, 'home');
  const root = path.join(base, 'project');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(root);
  return { base, home, root, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const fixturePath = (relative) => path.join(FIXTURES, relative.replace(/^~\//, 'HOME/').replace(/(^|\/)\.(?=[a-z])/g, '$1dot-'));
const wsPath = (ws, relative) => (relative.startsWith('~/') ? path.join(ws.home, relative.slice(2)) : path.join(ws.root, relative));

function writeOwnerFiles(ws) {
  for (const [relative, value] of Object.entries(readJson(OWNER_FILES))) {
    const target = wsPath(ws, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof value === 'string' ? value : `${JSON.stringify(value, null, 2)}\n`);
  }
}

// The real 0.1.68 output (fixtures generated from 12872ee over the 0.1.67 owner files).
function load0168(ws) {
  const manifest = readJson(path.join(FIXTURES, 'manifest.json'));
  writeOwnerFiles(ws);
  for (const [relative, info] of Object.entries(manifest.files)) {
    const target = wsPath(ws, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(fixturePath(relative), target);
    fs.chmodSync(target, parseInt(info.mode, 8));
  }
  fs.chmodSync(path.join(ws.home, '.grok'), 0o755);
  fs.chmodSync(path.join(ws.home, '.grok', 'hooks'), 0o755);
  if (!fs.existsSync(path.join(ws.root, '.windsurf'))) fs.mkdirSync(path.join(ws.root, '.windsurf'));
  return manifest;
}

function hostApprovalTarget() {
  const version = installer.hostApprovalHooksSupported(PINS.MCP_ADAPTER_VERSION) ? PINS.MCP_ADAPTER_VERSION : PINS.MCP_HOST_APPROVAL_HOOKS_SINCE;
  return installer.resolveMcpTargetVersion({ registryMetadata: { name: '@getmarrow/mcp', version, dist: {
    integrity: `sha512-${crypto.createHash('sha512').update(`registry-${version}`).digest('base64')}`,
    tarball: `https://registry.npmjs.org/@getmarrow/mcp/-/mcp-${version}.tgz`,
  } } });
}

function plan(ws) {
  const detection = installer.detectEnvironment(ws.root, { HOME: ws.home, PATH: process.env.PATH });
  return { detection, plan: installer.buildPlan(detection, { mode: 'mcp', mcpTarget: hostApprovalTarget() }) };
}

const isMarrowCommand = (value) => typeof value === 'string' && /@getmarrow\/mcp@[^\s"',]+/.test(value);
function ownerGroupedHooks(settings) {
  const out = {};
  for (const [event, groups] of Object.entries(settings.hooks || {})) {
    const kept = groups.map((group) => ({ ...group, hooks: (group.hooks || []).filter((hook) => !isMarrowCommand(hook.command) && !String(hook.name || '').startsWith('marrow-')) }))
      .filter((group) => group.hooks.length > 0);
    if (kept.length) out[event] = kept;
  }
  return out;
}
function ownerFlatHooks(settings) {
  const out = {};
  for (const [event, entries] of Object.entries(settings.hooks || {})) {
    const kept = entries.filter((entry) => !isMarrowCommand(entry.command));
    if (kept.length) out[event] = kept;
  }
  return out;
}
const OLD_MATCHER_STRINGS = Object.values(OLD);
const OLD_GUARD = '/^marrow_[a-z0-9_]{1,64}$/';

const HOSTS = [
  { client: 'claude-code', label: 'Claude Code MCP passive hooks', file: '.claude/settings.json', matcher: true },
  { client: 'codex', label: 'Codex native hooks', file: '.codex/hooks.json', matcher: true },
  { client: 'cursor', label: 'Cursor native hooks', file: '.cursor/hooks.json', matcher: true },
  { client: 'gemini', label: 'Gemini CLI native hooks', file: '.gemini/settings.json', matcher: true },
  { client: 'grok', label: 'Grok native hooks', file: '~/.grok/hooks/marrow.json', matcher: false },
  { client: 'windsurf', label: 'Windsurf native hooks', file: '.windsurf/hooks.json', matcher: false },
];

// A host file with its Marrow command strings replaced by a marker: what is left is everything
// the installer must not touch (matchers, events, names, owner entries).
function maskMarrowCommands(value) {
  if (Array.isArray(value)) return value.map(maskMarrowCommands);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === 'command' && isMarrowCommand(item) ? '<marrow command>' : maskMarrowCommands(item)]));
  }
  return value;
}
const PIN_SPEC = `@getmarrow/mcp@${PINS.MCP_ADAPTER_VERSION}`;
const PIN_RUNTIME_DIR = `.marrow/runtime/mcp/${PINS.MCP_ADAPTER_VERSION}/`;

test('0.1.68 install: doctor reports the old matchers as needing repair; repair rewrites only Marrow entries; uninstall removes the new ones', async () => {
  const ws = workspace('marrow-own-matchers-');
  try {
    const manifest = load0168(ws);
    const before = Object.fromEntries(Object.keys(manifest.files).map((relative) => [relative, fs.readFileSync(wsPath(ws, relative), 'utf8')]));
    // The fixtures really hold the 0.1.68 strings.
    for (const host of HOSTS.filter((item) => item.matcher)) {
      assert.ok(OLD_MATCHER_STRINGS.some((value) => before[host.file].includes(JSON.stringify(value).slice(1, -1))), host.file);
    }
    // Every 0.1.68 hook file runs Marrow through npx at the 0.1.68 pin, which is not the current
    // pin (src/pins.js) and not the verified-runtime form the installer writes now.
    for (const host of HOSTS) {
      assert.match(before[host.file], /npx -y --package=@getmarrow\/mcp@\d+\.\d+\.\d+ marrow-mcp /, `${host.file} holds npx commands`);
      assert.equal(before[host.file].includes(PIN_SPEC), false, `${host.file} predates the current pin`);
      assert.equal(before[host.file].includes(PIN_RUNTIME_DIR), false, `${host.file} predates the verified-runtime form`);
    }
    assert.ok(before['.cursor/hooks.json'].includes(OLD_GUARD.replace(/\\/g, '\\\\')), 'the 0.1.68 Cursor guard');

    // Doctor on the 0.1.68 layout: no host is complete (the four with an own-tool matcher, and
    // Grok and Windsurf, whose npx commands are at the old pin and are not the verified-runtime
    // form), and a dry run would rewrite exactly those files.
    let { detection, plan: current } = plan(ws);
    const dry = installer.applyPlan(current, { yes: false, dryRun: true, doctor: false });
    for (const host of HOSTS) {
      const profile = installer.activationProfile(detection, current, dry, host.client);
      assert.equal(profile.observed_hooks.includes('pre_action'), false, `${host.client}: ${profile.observed_hooks}`);
      const change = dry.find((item) => item.label === host.label);
      assert.ok(change, host.label);
      assert.equal(change.changed, true, `${host.label} changed`);
    }
    for (const relative of Object.keys(before)) assert.equal(fs.readFileSync(wsPath(ws, relative), 'utf8'), before[relative], `dry run wrote ${relative}`);

    // Repair (update re-applies the plan).
    const applied = installer.applyPlan(current, { yes: true, dryRun: false, doctor: false });
    const after = (relative) => fs.readFileSync(wsPath(ws, relative), 'utf8');
    for (const relative of ['.claude/settings.json', '.codex/hooks.json', '.gemini/settings.json', '~/.grok/hooks/marrow.json']) {
      assert.deepEqual(ownerGroupedHooks(JSON.parse(after(relative))), ownerGroupedHooks(JSON.parse(before[relative])), relative);
    }
    for (const relative of ['.cursor/hooks.json', '.windsurf/hooks.json']) {
      assert.deepEqual(ownerFlatHooks(JSON.parse(after(relative))), ownerFlatHooks(JSON.parse(before[relative])), relative);
    }
    for (const relative of Object.keys(before)) {
      const text = after(relative);
      for (const old of OLD_MATCHER_STRINGS) assert.equal(text.includes(JSON.stringify(old).slice(1, -1)), false, `${relative} still has ${old.slice(-40)}`);
      assert.equal(text.includes(OLD_GUARD.replace(/\\/g, '\\\\')), false, `${relative} still has the old guard`);
    }
    // Grok and Windsurf have no own-tool matcher. Repair rewrites their Marrow commands (to the
    // current pin, in the verified-runtime form) and nothing else: with the commands masked, the
    // file is byte-for-byte the 0.1.68 content.
    for (const host of HOSTS) {
      const text = after(host.file);
      assert.deepEqual(Object.keys(JSON.parse(text).hooks), Object.keys(JSON.parse(before[host.file]).hooks), `${host.file} events`);
      assert.equal(text.includes(PIN_SPEC), true, `${host.file} is at the current pin`);
      assert.equal(text.includes(PIN_RUNTIME_DIR), true, `${host.file} starts the verified runtime`);
      assert.equal(/npx -y --package=@getmarrow\/mcp@/.test(text), false, `${host.file} no longer runs npx`);
    }
    for (const host of HOSTS.filter((item) => !item.matcher)) {
      assert.deepEqual(maskMarrowCommands(JSON.parse(after(host.file))), maskMarrowCommands(JSON.parse(before[host.file])), `${host.file} changes only Marrow commands`);
    }
    const expected = expectedStrings();
    const claude = JSON.parse(after('.claude/settings.json'));
    for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']) {
      const marrowGroups = claude.hooks[event].filter((group) => group.hooks.some((hook) => isMarrowCommand(hook.command)));
      assert.equal(marrowGroups.length, 1, event);
      assert.equal(marrowGroups[0].matcher, expected.claude, event);
    }
    const codex = JSON.parse(after('.codex/hooks.json'));
    for (const event of ['PreToolUse', 'PostToolUse']) {
      const marrowGroups = codex.hooks[event].filter((group) => group.hooks.some((hook) => isMarrowCommand(hook.command)));
      assert.deepEqual(marrowGroups.map((group) => group.matcher), [expected.codex], event);
    }
    const cursor = JSON.parse(after('.cursor/hooks.json'));
    assert.deepEqual(cursor.hooks.preToolUse.filter((entry) => isMarrowCommand(entry.command)).map((entry) => entry.matcher), [expected.cursorPreToolUseHostApproval]);
    for (const event of ['postToolUse', 'postToolUseFailure']) {
      assert.deepEqual(cursor.hooks[event].filter((entry) => isMarrowCommand(entry.command)).map((entry) => entry.matcher), [expected.cursor], event);
    }
    const guards = cursor.hooks.beforeMCPExecution.filter((entry) => isMarrowCommand(entry.command));
    assert.equal(guards.length, 1);
    assert.equal(guards[0].command.includes(own.cursorOwnToolGuardCondition()), true);
    const gemini = JSON.parse(after('.gemini/settings.json'));
    for (const event of ['BeforeTool', 'AfterTool']) {
      const marrowGroups = gemini.hooks[event].filter((group) => group.hooks.some((hook) => String(hook.name || '').startsWith('marrow-')));
      assert.deepEqual(marrowGroups.map((group) => group.matcher), [expected.gemini], event);
    }

    // Doctor after repair: complete for every host; a second run changes nothing.
    const repaired = Object.fromEntries(Object.keys(before).map((relative) => [relative, after(relative)]));
    ({ detection, plan: current } = plan(ws));
    const again = installer.applyPlan(current, { yes: true, dryRun: false, doctor: false });
    assert.deepEqual(again.filter((change) => change.changed).map((change) => change.label), []);
    for (const host of HOSTS) {
      assert.equal(installer.activationProfile(detection, current, again, host.client).observed_hooks.includes('pre_action'), true, host.client);
    }
    for (const host of HOSTS.filter((item) => !item.matcher)) assert.equal(after(host.file), repaired[host.file], `${host.file} must not change on the second run`);
    assert.ok(applied.some((change) => change.applied));

    // Uninstall removes the new entries and leaves the owner's files as they were.
    const owner = readJson(OWNER_FILES);
    const result = await installer.uninstall({ cwd: ws.root, home: ws.home, yes: true, controller: false });
    assert.equal(result.uninstall.applied, true);
    for (const relative of ['.claude/settings.json', '.codex/hooks.json', '.cursor/hooks.json', '.gemini/settings.json', '.windsurf/hooks.json']) {
      assert.deepEqual(readJson(wsPath(ws, relative)), owner[relative], relative);
    }
    assert.equal(fs.existsSync(path.join(ws.home, '.grok', 'hooks', 'marrow.json')), false);
  } finally {
    ws.cleanup();
  }
});

test('an install written with the r1 candidate matchers: doctor reports it for repair and repair writes the current ones', () => {
  const ws = workspace('marrow-own-r1-');
  try {
    load0168(ws);
    let { detection, plan: current } = plan(ws);
    installer.applyPlan(current, { yes: true, dryRun: false, doctor: false });
    const now = expectedStrings();
    const escaped = (value) => JSON.stringify(value).slice(1, -1);
    const files = ['.claude/settings.json', '.codex/hooks.json', '.cursor/hooks.json', '.gemini/settings.json'];
    // Put the r1 strings where the current ones are (the longer Cursor string first: it contains the other).
    for (const relative of files) {
      let text = fs.readFileSync(wsPath(ws, relative), 'utf8');
      for (const key of ['claude', 'codex', 'cursor', 'cursorPreToolUseHostApproval', 'gemini']) text = text.split(escaped(now[key])).join(escaped(R1[key]));
      assert.ok(Object.values(R1).some((value) => text.includes(escaped(value))), relative);
      fs.writeFileSync(wsPath(ws, relative), text);
    }
    ({ detection, plan: current } = plan(ws));
    const dry = installer.applyPlan(current, { yes: false, dryRun: true, doctor: false });
    for (const host of HOSTS.filter((item) => item.matcher)) {
      assert.equal(installer.activationProfile(detection, current, dry, host.client).observed_hooks.includes('pre_action'), false, host.client);
      assert.equal(dry.find((item) => item.label === host.label).changed, true, host.label);
    }
    installer.applyPlan(current, { yes: true, dryRun: false, doctor: false });
    for (const relative of files) {
      const text = fs.readFileSync(wsPath(ws, relative), 'utf8');
      for (const value of Object.values(R1)) assert.equal(text.includes(escaped(value)), false, `${relative} keeps an r1 string`);
    }
    ({ detection, plan: current } = plan(ws));
    const again = installer.applyPlan(current, { yes: true, dryRun: false, doctor: false });
    assert.deepEqual(again.filter((change) => change.changed).map((change) => change.label), []);
    for (const host of HOSTS) assert.equal(installer.activationProfile(detection, current, again, host.client).observed_hooks.includes('pre_action'), true, host.client);
  } finally {
    ws.cleanup();
  }
});

test('Cursor beforeMCPExecution guard: allows at once only server "marrow" with one of the 58 names; everything else reaches the hook', () => {
  const ws = workspace('marrow-own-guard-');
  try {
    fs.mkdirSync(path.join(ws.root, '.cursor'));
    // The sealed target (the pin and its integrity from src/pins.js), as a default install writes
    // it: the guard's loader verifies the runtime against that integrity.
    const detection = installer.detectEnvironment(ws.root, { HOME: ws.home, PATH: process.env.PATH });
    installer.applyPlan(installer.buildPlan(detection, { mode: 'mcp' }), { yes: true, dryRun: false, doctor: false });
    const guard = readJson(path.join(ws.root, '.cursor', 'hooks.json')).hooks.beforeMCPExecution.find((entry) => isMarrowCommand(entry.command)).command;
    assert.equal(guard.includes(own.cursorOwnToolGuardCondition()), true);
    assert.equal(guard.includes(PIN_RUNTIME_DIR), true, 'the guard starts the verified runtime at the pin');
    // The guard starts the verified private runtime for the pinned MCP (never npx from PATH). This
    // stand-in runtime answers "ask" and leaves a marker, so a case that reaches the hook shows.
    const spawned = path.join(ws.base, 'runtime-ran');
    fakeRuntime(ws.home, PINS.MCP_ADAPTER_VERSION, `#!/bin/sh\ncat >/dev/null\nprintf x >> ${JSON.stringify(spawned)}\nprintf '%s\\n' '{"permission":"ask","user_message":"Approve?","agent_message":"asked"}'\n`);
    const run = (event, env = { HOME: ws.home }) => {
      if (fs.existsSync(spawned)) fs.rmSync(spawned);
      const out = spawnSync(guard, { shell: true, env: { ...process.env, ...env }, input: JSON.stringify({ hook_event_name: 'beforeMCPExecution', tool_input: '{}', ...event }), encoding: 'utf8', timeout: 20_000 });
      return { status: out.status, stdout: out.stdout, hook: fs.existsSync(spawned) };
    };
    for (const name of NAMES) {
      assert.deepEqual(run({ mcp_server_name: 'marrow', tool_name: name }), { status: 0, stdout: '{"permission":"allow"}\n', hook: false }, name);
    }
    const asked = { status: 0, stdout: '{"permission":"ask","user_message":"Approve?","agent_message":"asked"}\n', hook: true };
    const cases = [
      ...SERVER_VARIANTS.map((server) => ({ mcp_server_name: server, tool_name: 'marrow_commit' })),
      ...TOOL_VARIANTS.map((tool) => ({ mcp_server_name: 'marrow', tool_name: tool })),
      { mcp_server_name: 'marrow', tool_name: 'MCP:marrow_commit' },
      { mcp_server_name: 'marrow', tool_name: 'mcp__marrow__marrow_commit' },
      { mcp_server_name: 'marrow', tool_name: ['marrow_commit'] },
      { mcp_server_name: ['marrow'], tool_name: 'marrow_commit' },
      { mcp_server_name: 'marrow' },
      { tool_name: 'marrow_commit' },
      { mcp_server_name: 'marrow', tool_name: 'hasOwnProperty' },
      { mcp_server_name: 'marrow', tool_name: 'marrow_delete_all', server: 'marrow' },
    ];
    for (const event of cases) assert.deepEqual(run(event), asked, JSON.stringify(event));

    // A planted npx first on PATH never runs: with no verified runtime under HOME the guard holds
    // (exit 2, no decision on stdout) for every non-own case, and the planted npx leaves no marker.
    // Marrow's own tools are still allowed at once, with no runtime and no npx.
    const bin = path.join(ws.base, 'fake-bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'npx'), `#!/bin/sh\ncat >/dev/null\nprintf x >> ${JSON.stringify(spawned)}\nprintf '%s\\n' '{"permission":"ask","user_message":"Approve?","agent_message":"asked"}'\n`);
    fs.chmodSync(path.join(bin, 'npx'), 0o755);
    const bareHome = path.join(ws.base, 'bare-home');
    const bare = { HOME: bareHome, PATH: `${bin}:${process.env.PATH}` };
    fs.mkdirSync(bareHome, { mode: 0o700 });
    deadRegistryHome(bareHome);
    assert.equal(fs.existsSync(path.join(bareHome, '.marrow')), false);
    for (const event of cases) assert.deepEqual(run(event, bare), { status: 2, stdout: '', hook: false }, `planted npx: ${JSON.stringify(event)}`);
    for (const name of NAMES) {
      assert.deepEqual(run({ mcp_server_name: 'marrow', tool_name: name }, bare), { status: 0, stdout: '{"permission":"allow"}\n', hook: false }, `planted npx: ${name}`);
    }
  } finally {
    ws.cleanup();
  }
});

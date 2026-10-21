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
const host = require('./support/mcp-host');

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
// PKG-H2: web_fetch reaches the Gemini hook too.
const GEMINI_HOOKED = `${GEMINI_BUILTINS}|web_fetch`;

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

// The Codex string 0.1.69 and 0.1.70 wrote: Codex rejects it (look-ahead), so it never ran.
const V0170_CODEX = `Bash|apply_patch|Edit|Write|MultiEdit|^(?!mcp__marrow__(?:${OWN})$)[\\s\\S]*(?:functions\\.|mcp__)[\\s\\S]*`;

// The exact strings of the rule, assembled here from the JSON (not from the module).
function expectedStrings() {
  const cursorMcp = '[\\s\\S]*MCP:[\\s\\S]*';
  return {
    // PKG-H2: every label but the exact own labels and the read-only LS / ListMcpResourcesTool.
    claude: `^(?!(?:mcp__marrow__(?:${OWN})|LS|ListMcpResourcesTool)$)[\\s\\S]*`,
    // Codex: every tool reaches the hook, which skips the exact own names itself.
    codex: '*',
    cursor: `Shell|Write|Delete|Task|Read|Glob|Grep|Search|WebSearch|List|${cursorMcp}`,
    cursorPreToolUseHostApproval: `Write|Delete|Task|Read|Glob|Grep|Search|WebSearch|List|${cursorMcp}`,
    gemini: `^(?:${GEMINI_HOOKED}|mcp_[\\s\\S]*)$|^[^A-Za-z_][\\s\\S]*`,
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

// Codex (codex-cli 0.161.0, codex-rs/hooks/src/engine/matcher.rs): "" and "*" select every tool,
// a matcher of only [A-Za-z0-9_|] is an exact list, anything else is a Rust `regex` searched with
// is_match. Rust `regex` has no look-around: such a matcher fails to compile and Codex drops the
// hook group (engine/discovery.rs), so it selects nothing.
function codexSelects(matcher, tool) {
  if (matcher === '' || matcher === '*') return true;
  if (/^[A-Za-z0-9_|]+$/.test(matcher)) return matcher.split('|').includes(tool);
  if (/\(\?<?[=!]/.test(matcher)) return false;
  return new RegExp(matcher).test(tool);
}
// The Codex matcher is `*`, so the hook alone decides what is skipped. That decision is the real
// @getmarrow/mcp 3.9.105 one (marrow-mcp 8ffda003): test/fixtures/mcp-3.9.105/ holds dist/ of the pinned
// package, byte for byte (the checksum test below pins it), not a copy of its rules written here. A label
// is skipped only when it is exactly `mcp__marrow__<own>` AND the host's own Codex configuration proves the
// `marrow` server is the official one. PROVEN is a temporary CODEX_HOME whose config.toml is the README
// `npx` form and nothing else (HOME, CODEX_HOME, the working directory and npm_config_* are all hermetic:
// test/support/mcp-host.js).
const MCP_FIXTURES = host.MCP_FIXTURES;
const mcpOwnTool = host.ownTool;
const PROVEN = host.hostFixture('marrow-own-proven-');
PROVEN.codexToml(host.README_CODEX_TOML);
test.after(() => PROVEN.cleanup());
const skipMemo = new Map();
const hookSkips = (tool) => {
  if (!skipMemo.has(tool)) skipMemo.set(tool, host.codexSkips(PROVEN, tool)[0]);
  return skipMemo.get(tool);
};
const hookSkipsEvent = (event) => host.withHost(PROVEN, () => host.identity.isOfficialMarrowMcpEventOnHost('codex', event, event));
// What the published 0.1.70 pinned (MCP 3.9.102, a label-only decision): the baseline the Codex
// results below are compared with. test/fixtures/mcp-3.9.102/own-tool.js is its dist/own-tool.js.
const MCP_FIXTURES_0170 = path.join(__dirname, 'fixtures', 'mcp-3.9.102');
const mcpOwnTool0170 = require(path.join(MCP_FIXTURES_0170, 'own-tool.js'));
const hookSkips0170 = (tool) => mcpOwnTool0170.isOfficialMarrowMcpEvent({ tool_name: tool });
// The label forms a hook takes for a registered name, found by asking it (these are only the
// candidates; no hook list is read from here). Codex never sends the last three: its MCP labels
// always start `mcp__` (core/src/tools/handlers/mcp.rs ensure_mcp_prefix) and its tool names hold
// only [A-Za-z0-9_-].
const HOOK_PREFIX_CANDIDATES = ['mcp__marrow__', 'functions.mcp__marrow__', 'MCP:marrow:', 'MCP:', 'mcp__Marrow__', 'mcp__marrow_', 'mcp__marrow', 'functions.', 'MCP: ', 'marrow__', ''];
const HOOK_OWN_PREFIXES = HOOK_PREFIX_CANDIDATES.filter((prefix) => NAMES.every((name) => hookSkips(`${prefix}${name}`)));
const HOOK_OWN_PREFIXES_0170 = HOOK_PREFIX_CANDIDATES.filter((prefix) => NAMES.every((name) => hookSkips0170(`${prefix}${name}`)));
// Whether a host checks a label: the matcher selects it, and for Codex the hook does not skip it.
function checks(key, matcher, tool, mode) {
  return key === 'codex' ? codexSelects(matcher, tool) && !hookSkips(tool) : reaches(matcher, tool, mode);
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
  codex: (name) => HOOK_OWN_PREFIXES.map((prefix) => `${prefix}${name}`),
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
// Codex 0.161.0: the namespace is the sanitized server name (every char outside [A-Za-z0-9_]
// becomes `_`, codex-mcp/src/mcp/mod.rs) with `mcp__` added unless it starts with it
// (connection_manager tool_catalog / tools.rs); the hook label trims `_` off the end of the
// namespace and the start of the tool before joining with `__` (core/src/tools/handlers/mcp.rs).
const codexSanitize = (value) => value.replace(/[^A-Za-z0-9_]/g, '_') || '_';
function codexLabel(server, tool) {
  const namespace = codexSanitize(server).startsWith('mcp__') ? codexSanitize(server) : `mcp__${codexSanitize(server)}`;
  const label = `${namespace.replace(/_+$/, '')}__${codexSanitize(tool).replace(/^_+/, '')}`;
  return label.startsWith('mcp__') ? label : `mcp__${label}`;
}
const HOST_LABELS = {
  claude: (server, tool) => [`mcp__${claudeIn(server)}__${claudeIn(tool)}`],
  codex: (server, tool) => [codexLabel(server, tool)],
  // Cursor CLI 2026.10.01: preToolUse/postToolUse send `MCP:${toolName}`, never the server.
  cursor: (server, tool) => [`MCP:${tool}`],
  cursorPreToolUseHostApproval: (server, tool) => [`MCP:${tool}`],
  gemini: (server, tool) => [geminiLabel(server, tool)],
};

const SERVER_VARIANTS = ['MARROW', 'Marrow', 'mARROW', 'marroW', 'marrow2', 'marrow_', '_marrow', 'xmarrow', 'marrowx', 'marrow-evil', 'evil', 'plugin_marrow_marrow',
  'mаrrow', 'ｍarrow', 'marrow​', 'marrow ', ' marrow', 'marrow_marrow', 'marrow-', 'marrow.', 'marrow marrow', 'mcp_marrow', 'marrow__marrow', 'marrow:marrow',
  'claude.ai marrow', 'evil-server', 'evil_server', 'marrow__', 'mcp__marrow', 'mcp__marrow_', 'mcp__marrow__', 'mcp__evil'];
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
  if (key === 'codex') out.push('apply_patch', 'spawn_agent', 'view_image', 'web_search', 'update_plan', 'request_user_input', 'write_stdin', 'list_mcp_resources', 'read_mcp_resource');
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

// sha256 of each vendored file, written here as well as in MANIFEST.json so that editing one of
// the two is caught. They are dist/ of @getmarrow/mcp 3.9.105 (marrow-mcp 8ffda003; only own-tool.js, which
// carries the Claude Code matcher, and codex-plugin-pins.js differ from the 3.9.103 files), and the 3.9.102
// baseline (3a2bf85e) the published 0.1.70 pinned.
const VENDORED_MCP = {
  sourceSha: '8ffda0034d8b2590e8b7996b7be01debf1bd64f0',
  files: {
    'own-tool.js': '09e7b5b2c3bae1abe1955bf54bf1763f58bbacc4a4abb258633ab4a81d7a6e8b',
    'tool-catalog.js': 'd413c2b7c46c7ed9c7a8b0694481c1f5afe850c3edc67cd28917dc1153b934cb',
    'model-usage.js': 'c7ddbc3482d5a7514453d0be38fa7c51e2f228a50039f3392544319b8defc577',
    'redact.js': '1f7afe22e5bd8b0b8181978d4dc7149e2aec8591459a51a733130d94c5d8da9b',
    'own-server-identity.js': 'c8efc9b000c697c6ce0d91a17348d9b47b1667d0928f657135da8822465176c0',
    'codex-plugins.js': '697e0444c1dc8856ed61ffa169fb39707b76c9a0f4752f6cb4121e315f4b107f',
    'codex-plugin-pins.js': '4572aea25a1f64e9afef4402ba1d927cba2ca4ccb9346424d545b0202d8eeeef',
    'host-session.js': '422544dfaf4f75a5e78a607ea8565050f8b11368f9ed275f298f8c1b1b7b350e',
  },
};
const VENDORED_MCP_0170 = {
  sourceSha: '3a2bf85e22b6b9f7e266383ed2011b1c10ca5f97',
  files: {
    'own-tool.js': '2af4baf43d4cce5fa27b6169df628f8f5eaa0f4c17b78cc8b69f19dc1816e679',
    'tool-catalog.js': '2300444b94dca126261b26d5767212811a95699ff742b0a0b5ebc9a01074f326',
    'model-usage.js': 'c7ddbc3482d5a7514453d0be38fa7c51e2f228a50039f3392544319b8defc577',
    'redact.js': '303bb8b6b05ee66e672f4d32c31b54bc0a6a7c2213f7acdb2408637b0179558d',
  },
};

function checkVendored(directory, vendored, version) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'MANIFEST.json'), 'utf8'));
  assert.equal(manifest.source_sha, vendored.sourceSha);
  assert.equal(manifest.version, version);
  assert.deepEqual(Object.keys(manifest.files).sort(), Object.keys(vendored.files).sort());
  for (const [name, sha256] of Object.entries(vendored.files)) {
    const bytes = fs.readFileSync(path.join(directory, name));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), sha256, `${name} is the pinned file`);
    assert.equal(manifest.files[name].sha256, sha256, `${name} in MANIFEST.json`);
    assert.equal(manifest.files[name].bytes, bytes.length, `${name} size`);
  }
  return manifest;
}

test('the vendored MCP 3.9.105 files are byte for byte the pinned @getmarrow/mcp, and the real hook lists the registered names', () => {
  const manifest = checkVendored(MCP_FIXTURES, VENDORED_MCP, '3.9.105');
  assert.equal(manifest.source_sha, PINS.MCP_ADAPTER_SOURCE_SHA, 'the vendored files are for the pinned MCP source');
  assert.equal(manifest.version, PINS.MCP_ADAPTER_VERSION);
  assert.equal(manifest.integrity, PINS.MCP_ADAPTER_INTEGRITY);
  // The pin itself: 3.9.105 from marrow-mcp 8ffda003. A pin left at 3.9.102 (or moved without the
  // vendored files) fails here and in the manifest checks above.
  assert.equal(PINS.MCP_ADAPTER_VERSION, '3.9.105');
  assert.equal(PINS.MCP_ADAPTER_SOURCE_SHA, '8ffda0034d8b2590e8b7996b7be01debf1bd64f0');
  assert.match(PINS.MCP_ADAPTER_INTEGRITY, /^sha512-[A-Za-z0-9+/]{86}==$/);
  assert.notEqual(PINS.MCP_ADAPTER_INTEGRITY, 'sha512-hTs4jTJmySLk8hHgsGIZksMo9+eO5kjQmU1EJyDX8Qqm9Z+V+yDkauop19roasVvOAFsK3dJjqLoIh7gRhoXJQ==', 'not the 3.9.102 integrity');
  // The registered names the real module derives from its own catalog are the installer's 58.
  assert.deepEqual([...mcpOwnTool.MARROW_OWN_TOOL_NAMES].sort(), [...NAMES].sort());
  assert.equal(mcpOwnTool.MARROW_OWN_SERVER_NAME, own.MARROW_OWN_SERVER);
  // With a proven configuration the real hook skips exactly the label `mcp__marrow__<own>`: no
  // `functions.`, `MCP:marrow:` or `MCP:` form (published 0.1.70 / MCP 3.9.102 took all four).
  assert.deepEqual(HOOK_OWN_PREFIXES, ['mcp__marrow__']);
  assert.deepEqual(HOOK_OWN_PREFIXES_0170, ['mcp__marrow__', 'functions.mcp__marrow__', 'MCP:marrow:', 'MCP:']);
});

test('the vendored MCP 3.9.102 baseline (what the published 0.1.70 pinned) is byte for byte its dist', () => {
  const manifest = checkVendored(MCP_FIXTURES_0170, VENDORED_MCP_0170, '3.9.102');
  assert.equal(manifest.integrity, 'sha512-hTs4jTJmySLk8hHgsGIZksMo9+eO5kjQmU1EJyDX8Qqm9Z+V+yDkauop19roasVvOAFsK3dJjqLoIh7gRhoXJQ==');
});

test('the real hook decision on Codex labels: exact own labels skipped; case, padding, suffix and look-alikes are not', () => {
  for (const name of NAMES) {
    assert.equal(hookSkips(`mcp__marrow__${name}`), true, name);
    for (const bad of [`mcp__Marrow__${name}`, `mcp__MARROW__${name}`, `mcp__marrow__${name} `, ` mcp__marrow__${name}`, `mcp__marrow__${name}\n`,
      `mcp__marrow__${name}\u0000`, `mcp__marrow__${name}x`, `mcp__marrow__${name.toUpperCase()}`, `mcp__marrow-evil__${name}`, `mcp__marrow_evil__${name}`,
      `mcp__evil__mcp__marrow__${name}`, `mcp__marrow__marrow__${name}`, `xmcp__marrow__${name}`, `mcp__marrow${name}`]) {
      assert.equal(hookSkips(bad), false, JSON.stringify(bad));
    }
  }
  for (const label of ['mcp__marrow__marrow_delete_all', 'mcp__marrow__marrow_', 'mcp__marrow__', 'mcp__marrow__constructor', 'mcp__marrow____proto__', 'mcp__marrow__toString',
    'Bash', 'exec_command', 'apply_patch', 'web_search', 'spawn_agent', 'update_plan', 'view_image']) {
    assert.equal(hookSkips(label), false, label);
  }
  // Not strings, and missing names, are never own.
  for (const value of [undefined, null, 0, {}, [], ['mcp__marrow__marrow_commit']]) assert.equal(hookSkipsEvent({ tool_name: value }), false);
  assert.equal(hookSkipsEvent({}), false);
  // The other forms the 3.9.102 hook took (published 0.1.70) never skip on Codex any more, even with
  // a proven configuration: only the exact `mcp__marrow__<own>` does.
  for (const name of NAMES) {
    for (const prefix of ['functions.mcp__marrow__', 'MCP:marrow:', 'MCP:', 'functions.', 'mcp__marrow_', 'mcp__marrow', '']) {
      assert.equal(hookSkips(`${prefix}${name}`), false, `${prefix}${name}`);
    }
  }
  // Whatever the 3.9.103 hook skips, the 3.9.102 hook skipped: never looser than 0.1.70's decision.
  for (const name of NAMES) {
    for (const label of [`mcp__marrow__${name}`, `mcp__Marrow__${name}`, `mcp__marrow__${name} `, `functions.mcp__marrow__${name}`, `MCP:${name}`]) {
      if (hookSkips(label)) assert.equal(hookSkips0170(label), true, label);
    }
  }
});

test('nested use_tool forms never skip on Codex, with or without proof; the 3.9.102 hook skipped them; no Codex label can be that tool name', () => {
  const nested = (tool_name, tool_input) => hookSkipsEvent({ tool_name, tool_input });
  for (const tool_name of ['use_mcp_tool', 'use_tool', 'mcp', 'mcp_tool']) {
    for (const input of [{ serverName: 'marrow', toolName: 'marrow_commit' }, { server_name: 'marrow', tool_name: 'marrow_commit' },
      { serverName: 'Marrow', toolName: 'marrow_commit' }, { serverName: 'marrow', toolName: 'marrow_delete_all' }, { serverName: 'marrow ', toolName: 'marrow_commit' },
      { serverName: 'marrow', toolName: 'marrow_commit', server_name: 'evil' }, { serverName: 'marrow' }, {}, null, [], 'marrow']) {
      assert.equal(nested(tool_name, input), false, `${tool_name} ${JSON.stringify(input)}`);
    }
    // The published 0.1.70 hook (MCP 3.9.102) did skip the exact nested call.
    assert.equal(mcpOwnTool0170.isOfficialMarrowMcpEvent({ tool_name, tool_input: { serverName: 'marrow', toolName: 'marrow_commit' } }), true, tool_name);
  }
  assert.equal(nested('use_tool_x', { serverName: 'marrow', toolName: 'marrow_commit' }), false);
  assert.equal(nested('Bash', { serverName: 'marrow', toolName: 'marrow_commit' }), false);
  // Codex names an MCP tool `mcp__<server>__<tool>` (codexLabel), so none of its labels is one of those names.
  const labels = [];
  for (const server of ['marrow', ...SERVER_VARIANTS]) for (const tool of [...NAMES.slice(0, 5), ...TOOL_VARIANTS]) labels.push(codexLabel(server, tool));
  for (const label of labels) assert.equal(label.startsWith('mcp__'), true, label);
  for (const tool_name of ['use_mcp_tool', 'use_tool', 'mcp', 'mcp_tool']) assert.equal(labels.includes(tool_name), false, tool_name);
});

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
    `^(?!(?:mcp__marrow__(?:${OWN})|LS|ListMcpResourcesTool)$)[\\s\\S]*`);
  assert.equal(installer.CODEX_NATIVE_HOOK_MATCHER, '*');
  // Codex (Rust `regex`) has no look-around; its string is its match-all and no regex at all.
  assert.equal(/\(\?<?[=!]/.test(expected.codex), false);
  assert.equal(codexSelects(V0170_CODEX, 'Bash'), false, 'the 0.1.70 string is one Codex rejects');
  for (const [key, matcher] of Object.entries(expected)) {
    if (key === 'codex') continue;
    // Every consuming part is exactly `[\s\S]*`: no `.*`, `(?s)`, `[^]` or m flag that a line terminator could escape.
    assert.equal(/(^|[^\\])\.[*+]/.test(matcher), false, key);
    assert.equal(matcher.includes('(?s)') || matcher.includes('[^]') || matcher.includes('(?m)'), false, key);
    assert.doesNotThrow(() => new RegExp(matcher), key);
  }
  // A name that is not a plain identifier never reaches a regex source.
  for (const bad of ['marrow_.*', 'marrow_x|evil', 'marrow_x)$|(?=', 'MARROW_X', 'marrow_x"', '', 'evil']) {
    assert.throws(() => own.buildOwnToolMatchers([bad]), /invalid Marrow tool name/, bad);
  }
  // No by-name allow exists any more: the module exports no guard condition (the Cursor
  // beforeMCPExecution guard sends every call, Marrow's own tools included, to the MCP hook).
  assert.deepEqual(Object.keys(own).sort(), ['CLAUDE_UNHOOKED_READ_ONLY_TOOLS', 'MARROW_OWN_SERVER', 'MARROW_OWN_TOOL_NAMES', 'buildOwnToolMatchers']);
  assert.deepEqual(own.CLAUDE_UNHOOKED_READ_ONLY_TOOLS, ['LS', 'ListMcpResourcesTool']);
  assert.equal(own.cursorOwnToolGuardCondition, undefined);
  assert.throws(() => own.buildOwnToolMatchers([]), /invalid Marrow tool name list/);
});

test('each matcher skips exactly the labels its host proves are own, and nothing else, under search and full match', () => {
  for (const [key, matcher] of Object.entries(own.buildOwnToolMatchers())) {
    const skipped = skippedSet(key);
    assert.equal(skipped.size, key === 'claude' ? 58 : key === 'codex' ? 58 * HOOK_OWN_PREFIXES.length : 0, key);
    for (const mode of MODES) {
      for (const label of skipped) assert.equal(checks(key, matcher, label, mode), false, `${key}/${mode}: own ${JSON.stringify(label)} must be skipped`);
      for (const probe of probes(key)) {
        assert.equal(checks(key, matcher, probe, mode), !skipped.has(probe), `${key}/${mode}: ${JSON.stringify(probe)}`);
      }
    }
  }
});

// Codex labels are not one-to-one: these server names give the label `mcp__marrow__<tool>` too (with a
// tool `<own>`, or `marrow__<own>` for the names whose namespace trims to `mcp`), so a hook that
// sees only the label cannot tell them from the real `marrow` server. Measured on codex-cli 0.161.0:
// a namespace ending in `_` (`marrow_`, and every server that sanitizes to it) and `mcp__marrow` are
// callable and take the real server's label. The 3.9.103 hook does not trust the label: it skips only
// after reading the host configuration (the real decision is run against every name below in
// 'a look-alike Codex server never proves...'). Pinned here so the list cannot grow unnoticed. The
// last five are the B1 boundary names of the MCP audit (038cf8d9): a namespace that trims to `mcp`
// plus the tool `marrow__<own>` (and the empty name, which Codex turns into `_`).
const CODEX_KNOWN_COLLISIONS = new Set(['marrow_', 'marrow__', 'marrow-', 'marrow.', 'marrow ', 'marrow\u200b', 'mcp__marrow', 'mcp__marrow_', 'mcp__marrow__',
  '_', '-', '__', 'mcp___', '']);
// Boundary names whose label differs on codex 0.161 (case, `mcp` inside) but which the MCP also
// counts as able to produce the marrow label: the hook never proves `marrow` next to or instead of them.
const CODEX_BOUNDARY_ONLY = new Set(['mcp', 'mcp_', 'MCP__', 'MCP', 'Mcp__']);
const codexTool = (name) => codexSanitize(name).replace(/^_+/, '');

test('collisions: a label is skipped only when no (server, tool) pair but (marrow, an own name) can produce it', () => {
  const matchers = own.buildOwnToolMatchers();
  const servers = ['marrow', ...SERVER_VARIANTS, ...CODEX_KNOWN_COLLISIONS, ...CODEX_BOUNDARY_ONLY];
  const tools = [...NAMES, ...TOOL_VARIANTS, ...NAMES.slice(0, 4).map((name) => `marrow__${name}`)];
  for (const [key, label] of Object.entries(HOST_LABELS)) {
    for (const mode of MODES) {
      for (const server of servers) {
        for (const tool of tools) {
          for (const value of label(server, tool)) {
            const skipped = !checks(key, matchers[key], value, mode);
            // Claude Code and Codex: only server `marrow` (the trust anchor) reaches `mcp__marrow__`;
            // on it the tool part must be an own name after the host's own normalisation. Codex:
            // the label is shared with the known collisions (tool `<own>` or `marrow__<own>`).
            const clean = codexTool(tool);
            const ownCodex = NAMES.includes(clean) || (clean.startsWith('marrow__') && NAMES.includes(clean.slice('marrow__'.length)));
            const allowed = (key === 'claude' && server === 'marrow' && NAMES.includes(claudeIn(tool)))
              || (key === 'codex' && (server === 'marrow' || CODEX_KNOWN_COLLISIONS.has(server)) && ownCodex);
            if (skipped) assert.equal(allowed, true, `${key}/${mode}: (${JSON.stringify(server)}, ${JSON.stringify(tool)}) -> ${JSON.stringify(value)} skipped`);
            if ((key === 'claude' || key === 'codex') && server === 'marrow' && NAMES.includes(tool)) assert.equal(skipped, true, `${key}/${mode}: own ${tool}`);
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

test('a look-alike Codex server never proves the marrow server: none of the 58 labels is skipped, alone or next to the official one', () => {
  const OFFICIAL = 'command = "npx"\nargs = ["-y", "@getmarrow/mcp"]\n';
  const LOOKALIKE = 'command = "node"\nargs = ["/tmp/e.js"]\n';
  const labels = NAMES.map((name) => `mcp__marrow__${name}`);
  const quoted = (name) => JSON.stringify(name);
  // Names that fold to `marrow` the way the MCP folds them (case, a leading `mcp`) are counted as able to
  // produce the label, so next to the official entry they unprove it too.
  // (A name outside the plain ASCII form, such as `marrow:marrow`, counts as able to produce it on Codex.)
  const names = [...CODEX_KNOWN_COLLISIONS, ...CODEX_BOUNDARY_ONLY, 'Marrow', 'MARROW', 'mcp-marrow', 'marrow:marrow'];
  // Names that cannot produce the label (`mcp__marrow_evil__...`, `mcp__marrow2__...`): another server, which
  // leaves the official entry proven when it is configured, and proves nothing on its own.
  const others = ['marrow-evil', 'marrow2', 'marrow_evil', 'github'];
  const cases = [];
  for (const name of names) {
    cases.push([`${name} (look-alike command) alone`, `[mcp_servers.${quoted(name)}]\n${LOOKALIKE}`]);
    // The strongest attack: the look-alike NAME with the official launch.
    cases.push([`${name} (official command under another name) alone`, `[mcp_servers.${quoted(name)}]\n${OFFICIAL}`]);
    cases.push([`${name} (look-alike) next to the official marrow`, `[mcp_servers.marrow]\n${OFFICIAL}[mcp_servers.${quoted(name)}]\n${LOOKALIKE}`]);
    cases.push([`${name} (official command) next to the official marrow`, `[mcp_servers.marrow]\n${OFFICIAL}[mcp_servers.${quoted(name)}]\n${OFFICIAL}`]);
  }
  for (const name of others) {
    cases.push([`${name} (look-alike command) alone`, `[mcp_servers.${quoted(name)}]\n${LOOKALIKE}`]);
    cases.push([`${name} (official command under another name) alone`, `[mcp_servers.${quoted(name)}]\n${OFFICIAL}`]);
  }
  let checked = 0;
  for (const [label, toml] of cases) {
    const fixture = host.hostFixture('marrow-own-lookalike-');
    try {
      fixture.codexToml(toml);
      const skipped = host.codexSkips(fixture, labels).filter(Boolean).length;
      // Alone, or next to the official entry, a name that can produce the label unproves the server.
      // A name that cannot produce it proves nothing on its own (no `marrow` server is configured).
      assert.equal(skipped, 0, label);
      checked += 1;
    } finally {
      fixture.cleanup();
    }
  }
  assert.equal(checked, names.length * 4 + others.length * 2);
  // Controls: the README form alone proves it (all 58); another server that cannot produce the label does not break it.
  assert.equal(host.codexSkips(PROVEN, labels).filter(Boolean).length, 58);
  for (const name of others) {
    const fixture = host.hostFixture('marrow-own-other-');
    try {
      fixture.codexToml(`[mcp_servers.marrow]\n${OFFICIAL}[mcp_servers.${quoted(name)}]\n${LOOKALIKE}`);
      assert.equal(host.codexSkips(fixture, labels).filter(Boolean).length, 58, name);
    } finally {
      fixture.cleanup();
    }
  }
});

test('padded labels (LF, CR, CRLF, U+2028, U+2029, space, tab, NUL; before, after, both) always reach the hook', () => {
  for (const [key, matcher] of Object.entries(own.buildOwnToolMatchers())) {
    for (const name of NAMES) {
      const labels = [...FORMS[key]('marrow', name), ...SKIPPED[key](name), ...(key === 'gemini' ? [geminiLabel('marrow', name)] : [])];
      for (const label of new Set(labels)) {
        for (const value of padded(label)) {
          for (const mode of MODES) assert.equal(checks(key, matcher, value, mode), true, `${key}/${mode}: ${JSON.stringify(value)}`);
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
    // What an older string would have checked had its host run it as written (Codex never did:
    // it rejects every look-around string, see below), with the hook the published 0.1.70 pinned
    // (MCP 3.9.102) behind it. The current Codex decision is never looser than that one.
    const before = (matcher, probe, mode) => reaches(matcher, probe, mode) && (key !== 'codex' || !hookSkips0170(probe));
    for (const mode of MODES) {
      for (const probe of sample) {
        if (before(OLD[key], probe, mode)) assert.equal(checks(key, now[key], probe, mode), true, `0.1.68 ${key}/${mode}: ${JSON.stringify(probe)}`);
        if (before(R1[key], probe, mode)) assert.equal(checks(key, now[key], probe, mode), true, `r1 ${key}/${mode}: ${JSON.stringify(probe)}`);
        if (key === 'codex' && before(V0170_CODEX, probe, mode)) assert.equal(checks(key, now[key], probe, mode), true, `0.1.70 codex/${mode}: ${JSON.stringify(probe)}`);
      }
    }
    if (key === 'codex') {
      // On the real host the old Codex strings checked nothing at all.
      for (const old of [OLD.codex, R1.codex, V0170_CODEX]) for (const probe of sample) assert.equal(codexSelects(old, probe), false, probe);
    }
    // And labels that 0.1.68 and r1 skipped now reach the hook.
    const opened = (base) => sample.filter((probe) => !before(base[key], probe, 'search') && checks(key, now[key], probe, 'search'));
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
        // No host sends `functions.mcp__…` today; it cannot prove the server, so it reaches the hook
        // and, on Codex, the 3.9.103 hook checks it (the 3.9.102 hook of 0.1.70 skipped this form).
        'functions.mcp__marrow__marrow_workflow_gate', 'MCP:marrow_commit', 'MCP:marrow:marrow_commit']) {
        if (key === 'codex') {
          assert.equal(codexSelects(matcher, tool), true, `codex/${mode}: ${JSON.stringify(tool)} reaches the hook`);
          assert.equal(hookSkips(tool), false, `codex/${mode}: the real hook does not skip ${JSON.stringify(tool)}`);
        }
        // PKG-H2: the Claude Code matcher hooks every label but the exact own ones, so `MCP:` labels (no Claude Code form) reach it too.
        assert.equal(checks(key, matcher, tool, mode), true, `${key}/${mode}: ${JSON.stringify(tool)}`);
      }
      assert.equal(hookSkips0170('functions.mcp__marrow__marrow_workflow_gate'), true, 'the published 0.1.70 hook skipped it');
      assert.equal(checks(key, matcher, 'mcp__marrow__marrow_commit', mode), false);
      assert.equal(checks(key, matcher, 'mcp__marrow__marrow_workflow', mode), false);
      if (key === 'codex') for (const tool of ['Bash', 'apply_patch', 'spawn_agent', 'web_search', 'update_plan']) assert.equal(checks(key, matcher, tool, mode), true, tool);
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
const MARROW_NAME_SAMPLE = 'marrow_workflow_gate';

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
    // The repaired guard allows nothing by name: it holds no server or tool-name test at all.
    assert.equal(guards[0].command.includes('mcp_server_name'), false);
    assert.equal(guards[0].command.includes('new Set('), false);
    assert.equal(guards[0].command.includes('cursor-pre-action-hook'), true);
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
      // Codex's `*` is replaced as the whole matcher value only (a bare `*` is in other strings too).
      text = text.split(`"matcher": ${JSON.stringify(now.codex)}`).join(`"matcher": "${escaped(R1.codex)}"`);
      for (const key of ['claude', 'cursor', 'cursorPreToolUseHostApproval', 'gemini']) text = text.split(escaped(now[key])).join(escaped(R1[key]));
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

test('a 0.1.70 Codex install (look-ahead matcher, which Codex rejects): doctor flags it, repair rewrites only the Marrow groups, once', () => {
  const ws = workspace('marrow-own-0170-codex-');
  try {
    load0168(ws);
    let { detection, plan: current } = plan(ws);
    installer.applyPlan(current, { yes: true, dryRun: false, doctor: false });
    const codexFile = wsPath(ws, '.codex/hooks.json');
    // The 0.1.70 layout: the Marrow tool groups carry the 0.1.70 string, next to an owner group.
    const settings = readJson(codexFile);
    for (const event of ['PreToolUse', 'PostToolUse']) {
      for (const group of settings.hooks[event]) if (group.matcher === '*') group.matcher = V0170_CODEX;
    }
    settings.hooks.PreToolUse.unshift({ matcher: 'Bash', hooks: [{ type: 'command', command: 'owner-check.sh' }] });
    fs.writeFileSync(codexFile, `${JSON.stringify(settings, null, 2)}\n`);
    const owner = ownerGroupedHooks(readJson(codexFile));
    const others = ['.claude/settings.json', '.cursor/hooks.json', '.gemini/settings.json', '.windsurf/hooks.json', '~/.grok/hooks/marrow.json'];
    const otherBytes = Object.fromEntries(others.map((relative) => [relative, fs.readFileSync(wsPath(ws, relative), 'utf8')]));

    ({ detection, plan: current } = plan(ws));
    const dry = installer.applyPlan(current, { yes: false, dryRun: true, doctor: false });
    assert.equal(installer.activationProfile(detection, current, dry, 'codex').observed_hooks.includes('pre_action'), false);
    assert.equal(installer.activationProfile(detection, current, dry, 'codex').observed_hooks.includes('action_result'), false);
    assert.deepEqual(dry.filter((change) => change.changed).map((change) => change.label), ['Codex native hooks']);

    installer.applyPlan(current, { yes: true, dryRun: false, doctor: false });
    const after = readJson(codexFile);
    assert.equal(JSON.stringify(after).includes('(?!'), false, 'no look-around left');
    for (const event of ['PreToolUse', 'PostToolUse']) {
      const marrow = after.hooks[event].filter((group) => group.hooks.some((hook) => isMarrowCommand(hook.command)));
      assert.deepEqual(marrow.map((group) => [group.matcher, group.hooks.length]), [['*', 1]], event);
    }
    assert.deepEqual(ownerGroupedHooks(after), owner, 'owner groups untouched');
    for (const relative of others) assert.equal(fs.readFileSync(wsPath(ws, relative), 'utf8'), otherBytes[relative], `${relative} byte-unchanged`);

    ({ detection, plan: current } = plan(ws));
    const again = installer.applyPlan(current, { yes: true, dryRun: false, doctor: false });
    assert.deepEqual(again.filter((change) => change.changed).map((change) => change.label), []);
    assert.deepEqual(readJson(codexFile), after, 'second run writes nothing');
    const profile = installer.activationProfile(detection, current, again, 'codex');
    assert.equal(profile.observed_hooks.includes('pre_action') && profile.observed_hooks.includes('action_result'), true);
  } finally {
    ws.cleanup();
  }
});

test('Cursor beforeMCPExecution guard: it allows nothing by name; every call, Marrow\'s own tools included, reaches the hook, and with no runtime every call holds', () => {
  const ws = workspace('marrow-own-guard-');
  try {
    fs.mkdirSync(path.join(ws.root, '.cursor'));
    // The sealed target (the pin and its integrity from src/pins.js), as a default install writes
    // it: the guard's loader verifies the runtime against that integrity.
    const detection = installer.detectEnvironment(ws.root, { HOME: ws.home, PATH: process.env.PATH });
    installer.applyPlan(installer.buildPlan(detection, { mode: 'mcp' }), { yes: true, dryRun: false, doctor: false });
    const guard = readJson(path.join(ws.root, '.cursor', 'hooks.json')).hooks.beforeMCPExecution.find((entry) => isMarrowCommand(entry.command)).command;
    // The guard source holds no server or tool-name test, no own-tool list and no allow answer of its own.
    for (const needle of ['mcp_server_name', 'tool_name', 'new Set(', 'permission', 'marrow_commit', 'marrow_think', MARROW_NAME_SAMPLE]) {
      assert.equal(guard.includes(needle), false, needle);
    }
    assert.equal(guard.includes(PIN_RUNTIME_DIR), true, 'the guard starts the verified runtime at the pin');
    assert.equal(guard.includes('cursor-pre-action-hook'), true);
    // The guard starts the verified private runtime for the pinned MCP (never npx from PATH). This
    // stand-in runtime answers "ask" and leaves a marker, so a case that reaches the hook shows.
    const spawned = path.join(ws.base, 'runtime-ran');
    fakeRuntime(ws.home, PINS.MCP_ADAPTER_VERSION, `#!/bin/sh\ncat >/dev/null\nprintf x >> ${JSON.stringify(spawned)}\nprintf '%s\\n' '{"permission":"ask","user_message":"Approve?","agent_message":"asked"}'\n`);
    const run = (event, env = { HOME: ws.home }) => {
      if (fs.existsSync(spawned)) fs.rmSync(spawned);
      const out = spawnSync(guard, { shell: true, cwd: ws.root, env: { ...process.env, ...env }, input: JSON.stringify({ hook_event_name: 'beforeMCPExecution', tool_input: '{}', ...event }), encoding: 'utf8', timeout: 20_000 });
      return { status: out.status, stdout: out.stdout, hook: fs.existsSync(spawned) };
    };
    const asked = { status: 0, stdout: '{"permission":"ask","user_message":"Approve?","agent_message":"asked"}\n', hook: true };
    // Marrow's own tools reach the runtime, like any other call (the runtime's MCP decides). The guard
    // holds no list, so a spread of names (first, last, the primary ones) shows it; the 58 names are
    // decided by the MCP (see mcp-103-host.test.js).
    const SAMPLE = [NAMES[0], NAMES[1], 'marrow_commit', 'marrow_think', 'marrow_workflow_gate', NAMES[NAMES.length - 1]];
    for (const name of SAMPLE) assert.deepEqual(run({ mcp_server_name: 'marrow', tool_name: name }), asked, name);
    const cases = [
      ...SERVER_VARIANTS.filter((_, index) => index % 3 === 0).map((server) => ({ mcp_server_name: server, tool_name: 'marrow_commit' })),
      ...TOOL_VARIANTS.filter((_, index) => index % 3 === 0).map((tool) => ({ mcp_server_name: 'marrow', tool_name: tool })),
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
    // (exit 2, no decision on stdout) for every case, Marrow's own tools included (nothing is
    // allowed at once any more), and the planted npx leaves no marker.
    const bin = path.join(ws.base, 'fake-bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'npx'), `#!/bin/sh\ncat >/dev/null\nprintf x >> ${JSON.stringify(spawned)}\nprintf '%s\\n' '{"permission":"ask","user_message":"Approve?","agent_message":"asked"}'\n`);
    fs.chmodSync(path.join(bin, 'npx'), 0o755);
    const bareHome = path.join(ws.base, 'bare-home');
    const bare = { HOME: bareHome, PATH: `${bin}:${process.env.PATH}` };
    fs.mkdirSync(bareHome, { mode: 0o700 });
    deadRegistryHome(bareHome);
    assert.equal(fs.existsSync(path.join(bareHome, '.marrow')), false);
    // Every bare run waits for a heal against the dead registry, so a spread of the cases is run.
    for (const event of cases.filter((_, index) => index % 4 === 0)) assert.deepEqual(run(event, bare), { status: 2, stdout: '', hook: false }, `planted npx: ${JSON.stringify(event)}`);
    for (const name of SAMPLE.filter((_, index) => index % 2 === 0)) {
      assert.deepEqual(run({ mcp_server_name: 'marrow', tool_name: name }, bare), { status: 2, stdout: '', hook: false }, `no runtime, own tool held: ${name}`);
    }
  } finally {
    ws.cleanup();
  }
});

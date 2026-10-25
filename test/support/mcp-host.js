'use strict';

// Hermetic host fixtures for the pinned @getmarrow/mcp decision. The decision code is the real
// dist/ of 3.9.107 (test/fixtures/mcp-3.9.107, pinned by sha256 in own-tool-matchers.test.js), not a
// copy of its rules. Every fixture is a temporary HOME (and CODEX_HOME) plus a temporary project:
// the decision reads only those, never the operator's home or npm configuration, and runs with
// every `npm_config_*` name unset and no real process ancestor, so a result never depends on the
// machine or on how the tests were started (`npm test` itself sets npm_config_* names).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MCP_FIXTURES = path.join(__dirname, '..', 'fixtures', 'mcp-3.9.107');
const PLUGIN_FIXTURE = path.join(__dirname, '..', 'fixtures', 'codex-plugin-b446393', 'marrow');
const identity = require(path.join(MCP_FIXTURES, 'own-server-identity.js'));
const ownTool = require(path.join(MCP_FIXTURES, 'own-tool.js'));
const PINS = require('../../src/pins');
const mcpRuntime = require('../../src/mcp-runtime');

// A hook the installer starts runs inside its loader, which leaves the decoded launcher in `global.MARROW_L`; since
// MCP 3.9.106 the host proof accepts an installer launch only when it is exactly the launch of that loader. Every
// fixture below therefore runs as a hook started by the installer's loader for the pinned MCP (the launcher the
// installer writes into hooks and server entries); pass `loader: null` for a hook the installer did not start.
const PINNED_LAUNCHER = mcpRuntime.launcherSource(mcpRuntime.runtimeConfig(PINS.MCP_ADAPTER_VERSION));

// What the README tells a Codex user to add (`codex mcp add marrow -- npx -y @getmarrow/mcp`).
const README_CODEX_TOML = '[mcp_servers.marrow]\ncommand = "npx"\nargs = ["-y", "@getmarrow/mcp"]\n';
const TEST_PROCESS_TABLE = Symbol.for('marrow.test.processTable');
const HOUR_MS = 3_600_000;

// `underHome`: the project folder is inside the user's home (a common layout, where the user's own
// npm config sits above the project).
function hostFixture(prefix = 'marrow-host-', { underHome = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(base, 0o700);
  const home = path.join(base, 'home');
  const root = underHome ? path.join(home, 'project') : path.join(base, 'project');
  const codexHome = path.join(home, '.codex');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(root);
  fs.mkdirSync(codexHome);
  const target = (relative) => (relative.startsWith('~/') ? path.join(home, relative.slice(2)) : path.join(root, relative));
  return {
    base, home, root, codexHome,
    // A project file ("a/b") or a home file ("~/.npmrc").
    write(relative, text) {
      const file = target(relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      return file;
    },
    codexToml(text) {
      fs.writeFileSync(path.join(codexHome, 'config.toml'), text);
    },
    cleanup() {
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

// Runs `fn` as the hook would run: HOME (and CODEX_HOME) the fixture's, every npm_config_* name
// unset (any case), the fixture project as the working directory, and a process table with one
// `codex` ancestor started an hour ago (or none: `codex: null`). `env` sets or (undefined) unsets names.
function withHost(host, fn, { env = {}, codex = { args: ['codex'] }, loader = PINNED_LAUNCHER } = {}) {
  const savedLoader = Object.getOwnPropertyDescriptor(globalThis, 'MARROW_L');
  if (loader === null) delete globalThis.MARROW_L;
  else globalThis.MARROW_L = loader;
  const saved = new Map();
  const set = (name, value) => {
    if (!saved.has(name)) saved.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  for (const name of Object.keys(process.env)) if (/^npm_config_/i.test(name)) set(name, undefined);
  set('HOME', host.home);
  set('USERPROFILE', host.home);
  set('CODEX_HOME', undefined);
  for (const [name, value] of Object.entries(env)) set(name, value);
  const cwd = process.cwd();
  const table = globalThis[TEST_PROCESS_TABLE];
  const ppid = process.ppid;
  globalThis[TEST_PROCESS_TABLE] = codex ? { [String(ppid)]: { pid: ppid, ppid: 1, args: codex.args, terminal: false, startMs: Date.now() - HOUR_MS } } : {};
  process.chdir(host.root);
  identity.resetOwnServerIdentityCache();
  try {
    return fn();
  } finally {
    process.chdir(cwd);
    if (savedLoader) Object.defineProperty(globalThis, 'MARROW_L', savedLoader);
    else delete globalThis.MARROW_L;
    if (table === undefined) delete globalThis[TEST_PROCESS_TABLE];
    else globalThis[TEST_PROCESS_TABLE] = table;
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    identity.resetOwnServerIdentityCache();
  }
}

// The hook's decision for Codex labels: true = the call is skipped (not checked).
function codexSkips(host, labels, options = {}) {
  const list = Array.isArray(labels) ? labels : [labels];
  return withHost(host, () => list.map((tool_name) => identity.isOfficialMarrowMcpEventOnHost('codex', { tool_name }, { tool_name, cwd: host.root })), options);
}

// The hook's decision for Cursor: `tool_name` is what the MCP normalizes to (`mcp__marrow__<own>`
// for beforeMCPExecution on server exactly `marrow`, `MCP:<own>` at preToolUse).
function cursorSkips(host, tool_names, raw = {}, options = {}) {
  const list = Array.isArray(tool_names) ? tool_names : [tool_names];
  return withHost(host, () => list.map((tool_name) => identity.isOfficialMarrowMcpEventOnHost('cursor', { tool_name }, { workspace_roots: [host.root], ...raw })), options);
}

// The reason strings of the same decision (Codex and Cursor).
function codexVerdict(host, options = {}) {
  return withHost(host, () => identity.codexOfficialMarrowServer({ cwds: [host.root], processCwd: host.root, userHome: host.home }), options);
}
function cursorVerdict(host, { onlyServer = false, roots = [host.root] } = {}, options = {}) {
  return withHost(host, () => identity.cursorOfficialMarrowServer({ home: host.home, cwds: roots, onlyServer, processCwd: host.root, env: {} }), options);
}

// `codex plugin add`'s layout for the official plugin (the six pinned files), dated an hour back.
function installOfficialPlugin(host, { enable = true } = {}) {
  const target = path.join(host.codexHome, 'plugins', 'cache', 'getmarrow', 'marrow', '0.1.1');
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(PLUGIN_FIXTURE, target, { recursive: true });
  const at = new Date(Date.now() - 2 * HOUR_MS);
  const age = (p) => {
    fs.utimesSync(p, at, at);
    if (fs.statSync(p).isDirectory()) for (const name of fs.readdirSync(p)) age(path.join(p, name));
  };
  age(target);
  for (let dir = path.dirname(target); dir.startsWith(host.codexHome) && dir !== host.codexHome; dir = path.dirname(dir)) fs.utimesSync(dir, at, at);
  return enable ? '[plugins."marrow@getmarrow"]\nenabled = true\n' : '';
}

module.exports = {
  MCP_FIXTURES,
  PINNED_LAUNCHER,
  README_CODEX_TOML,
  codexSkips,
  codexVerdict,
  cursorSkips,
  cursorVerdict,
  hostFixture,
  identity,
  installOfficialPlugin,
  ownTool,
  withHost,
};

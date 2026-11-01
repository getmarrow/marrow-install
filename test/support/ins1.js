// Shared fixtures for the INS-1 tests (update never takes the agent id from the runner).
// Dummy keys only: a fixed non-key prefix plus runtime hex, each draw asserted NOT live.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { install } = require('../../src/installer');

const DEFAULT_URL = 'https://api.getmarrow.ai';
const NOT_LIVE = /(?:^|[^a-z0-9])(?:sk|pk|rk)_|ghp_|gho_|xox[a-z]-|AKIA|eyJ/;
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'ins1');

function dummyKey() {
  const value = `zzfixture-${crypto.randomBytes(16).toString('hex')}`;
  assert.doesNotMatch(value, NOT_LIVE);
  return value;
}
// A short digest that names a key in test output and in the fake server's log without carrying it.
const keyTag = (key) => crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 12);

function world(prefix = 'marrow-ins1-') {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const home = path.join(base, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  return { base, home, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function quiet(extra) {
  return {
    selfTest: false, loopGuardSelfTest: false, seatbeltStatus: false, controller: false, mcpLocalRuntime: false,
    mcpRegistryMetadata: null, processCommands: [], mcpConfigPaths: [], ...extra,
  };
}

// Claude Code is the host: ~/.claude exists, the way a real home looks.
function hostLayout(home, hosts = {}) {
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  if (hosts.cursor) fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  if (hosts.grok) fs.mkdirSync(path.join(home, '.grok', 'hooks'), { recursive: true });
  if (hosts.hermes) fs.mkdirSync(path.join(home, '.hermes'), { recursive: true, mode: 0o700 });
}

// First-time setup (identity from the arguments, as today), no key, no network.
function setup(home, extra = {}) {
  return install(quiet({
    cwd: home, home, mode: 'mcp', apiKey: '', baseUrl: DEFAULT_URL, agentId: '', yes: true, dryRun: false, doctor: false, ...extra,
  }));
}

const mcpPath = (home) => path.join(home, '.mcp.json');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const mcpEnv = (home, file = mcpPath(home)) => readJson(file).mcpServers.marrow.env;
const recordPath = (home) => path.join(home, '.marrow', 'identity-record.json');
function readRecord(home) {
  return readJson(recordPath(home)).entries;
}
function writeRecord(home, entries, mode = 0o600) {
  fs.mkdirSync(path.join(home, '.marrow'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(recordPath(home), JSON.stringify({ version: 1, entries }), { mode });
  fs.chmodSync(recordPath(home), mode);
}
function setEnvBlock(file, patch) {
  const config = readJson(file);
  config.mcpServers.marrow.env = { ...config.mcpServers.marrow.env };
  for (const [name, value] of Object.entries(patch)) {
    if (value === undefined) delete config.mcpServers.marrow.env[name];
    else config.mcpServers.marrow.env[name] = value;
  }
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

function sha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
// path -> sha256 (or the link target) of every entry under a directory: "every file unchanged".
function treeHashes(root) {
  const out = {};
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full);
      if (entry.isSymbolicLink()) out[relative] = `link:${fs.readlinkSync(full)}`;
      else if (entry.isDirectory()) { out[relative] = 'dir'; walk(full); }
      else out[relative] = sha(full);
    }
  };
  walk(root);
  return out;
}
function filesContaining(root, needle) {
  const hits = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (fs.readFileSync(full).includes(needle)) hits.push(path.relative(root, full));
    }
  };
  walk(root);
  return hits;
}

function fixture(name) {
  return readJson(path.join(FIXTURES, name));
}
// The recorded live answer (status-identity-bound-one.json) as GET /v1/agent/status returns it.
function statusBody(ids, agentId = ids[0] || null) {
  const base = fixture('status-identity-bound-one.json').identity;
  // `ok` and `enabled` are what the install self-test reads from the same endpoint; the contract's identity block is the recorded one.
  return { data: { ok: true, enabled: true, identity: { ...base, agent_id: agentId, bound_agent_ids: ids } } };
}

// A fake Marrow API on loopback. GET /v1/agent/status answers by the bearer key's tag; every other
// request gets the generic 200 the self-test accepts. Nothing keeps a key: the log holds tags only.
async function fakeApi({ keys = {}, statusOverride } = {}) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const auth = String(req.headers.authorization || '').replace(/^Bearer /, '');
    const tag = auth ? keyTag(auth) : null;
    const agent = req.headers['x-marrow-agent-id'] || null;
    seen.push({ method: req.method, url: req.url, agent, tag });
    req.resume();
    req.on('end', () => {
      const send = (code, body, headers = {}) => {
        res.writeHead(code, { 'content-type': 'application/json', ...headers });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      if (req.method === 'GET' && req.url.split('?')[0] === '/v1/agent/status') {
        if (typeof statusOverride === 'function') return statusOverride({ req, tag, send, agent });
        const ids = keys[tag];
        if (!ids) return send(401, { error: 'unauthorized' });
        return send(200, statusBody(ids));
      }
      return send(200, { ok: true, enabled: true, decision_id: 'dec-fixture', agent_id: agent || 'bound-agent', committed: true });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server,
    seen,
    url: `http://127.0.0.1:${server.address().port}`,
    statusCalls: () => seen.filter((entry) => entry.url.split('?')[0] === '/v1/agent/status'),
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }),
  };
}

// The real MCP resolver (@getmarrow/mcp 3.9.109 dist/env.js, from `npm pack`) when INS1_MCP_PACK names the unpacked
// package folder; null otherwise, and the rows that use it check what they can without it. It answers what a host's
// MCP server would resolve for a config file: the key (as a tag, never the value), where it came from, and the agent id.
function realResolver() {
  const pack = process.env.INS1_MCP_PACK;
  if (!pack || !fs.existsSync(path.join(pack, 'dist', 'env.js'))) return null;
  const { resolveMarrowEnv } = require(path.join(pack, 'dist', 'env.js'));
  return (file, home, launcherEnv = {}) => {
    let block = {};
    try { block = readJson(file).mcpServers.marrow.env || {}; } catch { block = {}; }
    const found = resolveMarrowEnv({ env: { HOME: home, ...launcherEnv, ...block }, cwd: home, home });
    return { source: found.source || null, agentId: found.agentId || '', key: found.apiKey ? keyTag(found.apiKey) : '' };
  };
}
// Every launcher env the host could export around the server: none, and another agent's id.
const LAUNCHERS = [{}, { MARROW_AGENT_ID: 'codex-bob' }, { MARROW_FLEET_AGENT_ID: 'codex-bob' }];

function printedReport(report) {
  const { printReport } = require('../../src/installer');
  let text = '';
  printReport(report, (chunk) => { text += chunk; });
  return text;
}

module.exports = {
  DEFAULT_URL, FIXTURES, dummyKey, keyTag, world, quiet, hostLayout, setup, mcpPath, readJson, mcpEnv, recordPath, readRecord, writeRecord,
  setEnvBlock, sha, treeHashes, filesContaining, fixture, statusBody, fakeApi, printedReport, realResolver, LAUNCHERS,
};

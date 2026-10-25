'use strict';

// Starts marrow-agentd in a scratch home against the loopback stub. The API key is a dummy
// generated at runtime and never printed; tests assert it never leaves the daemon.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { callDaemon, adminCall } = require('../../src/agentd/client');
const { createDaemon, CONFIG_SCHEMA } = require('../../src/agentd/daemon');
const { agentdPaths } = require('../../src/agentd/paths');

function scratchHome() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentd-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  return { root, home };
}

function writeDummyKey(home) {
  const key = `mrw_test_${crypto.randomBytes(16).toString('hex')}`;
  fs.mkdirSync(path.join(home, '.marrow'), { mode: 0o700, recursive: true });
  fs.writeFileSync(path.join(home, '.marrow', 'env'), `MARROW_API_KEY=${key}\n`, { mode: 0o600 });
  return key;
}

function writeConfig(home, overrides = {}) {
  const paths = agentdPaths(home);
  fs.mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const config = {
    schema: CONFIG_SCHEMA,
    install_id: `inst_${crypto.randomBytes(8).toString('hex')}`,
    base_url: 'https://api.getmarrow.ai',
    agents: { 'claude-code': 'claude-code-test', codex: 'codex-test' },
    hook_timeouts_ms: { 'claude-code': 15000, codex: 5000 },
    hooks: [],
    shim: null,
    ...overrides,
  };
  fs.writeFileSync(paths.config, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  return config;
}

async function startAgentd({ stub, settings = {}, configOverrides = {}, home: existingHome, root: existingRoot, key: existingKey, trustedKeys, allowedBaseUrls } = {}) {
  const { root, home } = existingHome ? { root: existingRoot, home: existingHome } : scratchHome();
  const key = existingKey || writeDummyKey(home);
  if (stub) stub.expectKey(key);
  if (!existingHome || !fs.existsSync(agentdPaths(home).config)) writeConfig(home, { base_url: stub ? stub.url : 'https://api.getmarrow.ai', ...configOverrides });
  const daemon = createDaemon({
    home,
    trustedKeys: trustedKeys || (stub ? { [stub.kid]: stub.publicKey } : {}),
    allowedBaseUrls: allowedBaseUrls || (stub ? [stub.url] : undefined),
    initialPolicyRefresh: false,
    settings: { flushIntervalMs: 60 * 60 * 1000, policyRefreshMs: 60 * 60 * 1000, integrityCheckMs: 60 * 60 * 1000, heartbeatMs: 60 * 60 * 1000, ...settings },
  });
  await daemon.start();
  const socketPath = agentdPaths(home).socket;
  return {
    root,
    home,
    key,
    daemon,
    socketPath,
    hook: (harness, event, payload) => callDaemon({ socketPath, harness, event, payload: Buffer.from(JSON.stringify(payload)), timeoutMs: 10000 }),
    admin: (op, body) => adminCall(socketPath, op, body),
    async stop() { await daemon.stop(); },
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

function preEvent(command, extra = {}) {
  return { session_id: 'sess-test', tool_use_id: `tu-${crypto.randomBytes(6).toString('hex')}`, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, cwd: extra.cwd || '/tmp', permission_mode: 'default', ...extra };
}

function decisionOf(response) {
  const out = JSON.parse(response.stdout || '{}');
  const specific = out.hookSpecificOutput || {};
  return { decision: specific.permissionDecision || 'allow', reason: specific.permissionDecisionReason || '', raw: out };
}

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

module.exports = { scratchHome, writeDummyKey, writeConfig, startAgentd, preEvent, decisionOf, percentile };

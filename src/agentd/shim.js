'use strict';

// Portable hook shim and the daemon-down fallback.
//
// The native shim (native/marrow-hook.c) is the fast path; this module is used (a) as the shim
// on hosts without the native build and (b) as the fallback the native shim execs when the
// daemon cannot be reached. The fallback never contacts the network. It classifies from the
// last verified policy (or the built-in baseline) and:
//   routine        -> allow, and writes a bypass record the daemon uploads when it is back
//   risky/unknown  -> deny (fail closed) with an owner-facing fix
// It ignores every environment variable: the hook's environment belongs to the governed agent.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ADAPTERS, renderUnreadable } = require('./adapters');
const { callDaemon } = require('./client');
const { createClassifier } = require('./classifier');
const { HARNESS_HOOK_TIMEOUT_MS, TRUSTED_POLICY_KEYS } = require('./constants');
const { ensurePrivateDir } = require('./fsutil');
const { agentdPaths } = require('./paths');
const { PolicyStore } = require('./policy');

const BYPASS_CAP = 5000;

function shimDeadline(harness) {
  return Math.max(500, (HARNESS_HOOK_TIMEOUT_MS[harness] || 5000) - 1000);
}

function writeBypassRecord(paths, record) {
  try {
    ensurePrivateDir(paths.bypassDir);
    let count = 0;
    try { count = fs.readdirSync(paths.bypassDir).length; } catch { count = 0; }
    if (count >= BYPASS_CAP) {
      fs.appendFileSync(path.join(paths.bypassDir, 'overflow.count'), '1', { mode: 0o600 });
      return false;
    }
    const name = `fb-${Date.now()}-${crypto.randomBytes(8).toString('hex')}.json`;
    fs.writeFileSync(path.join(paths.bypassDir, name), JSON.stringify(record), { flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

function runFallback({ harness, event: eventArg, input, home, errorCode = 'daemon_unreachable', trustedKeys = TRUSTED_POLICY_KEYS }) {
  const adapter = ADAPTERS[harness];
  if (!adapter) return { exit: eventArg === 'pre' ? 2 : 0, stdout: '', stderr: eventArg === 'pre' ? 'Marrow: unsupported harness.\n' : '' };
  let payload;
  try { payload = input && input.length ? JSON.parse(input.toString('utf8')) : {}; } catch { return renderUnreadable(adapter, eventArg, 'Marrow could not read the hook input, so it blocked this action.'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return renderUnreadable(adapter, eventArg, 'Marrow could not read the hook input, so it blocked this action.');
  const event = adapter.normalize(eventArg, payload);
  if (event.kind !== 'pre') return adapter.render(event, { decision: 'allow' });
  const paths = agentdPaths(home);
  const store = new PolicyStore({ dir: paths.policyDir, trustedKeys });
  store.load();
  const policy = store.current();
  const classification = createClassifier(policy.tables, { home }).classify(event);
  let decision;
  if (policy.control.level === 'off') decision = { decision: 'allow' };
  else if (classification.class === 'routine') decision = { decision: 'allow' };
  else {
    decision = {
      decision: 'deny',
      reason: `Marrow's local service (marrow-agentd) is not running, so this ${classification.class === 'risky' ? 'risky' : 'unrecognized'} action is blocked. Routine work continues. Owner: run "systemctl --user restart marrow-agentd" or "marrow-agentd doctor".`,
    };
  }
  writeBypassRecord(paths, {
    v: 1,
    ts: new Date().toISOString(),
    harness,
    session_id: event.session_id,
    tool_use_id: event.tool_use_id,
    tool_kind: classification.tool ? classification.tool.kind : 'other',
    tool_name: classification.tool ? classification.tool.name : '',
    class: classification.class,
    reasons: classification.reasons.slice(0, 6),
    decision: decision.decision,
    policy_version: policy.version,
    control_level: policy.control.level,
    source: 'shim_fallback',
    error_code: String(errorCode).slice(0, 32),
    evidence: 'client_observed',
  });
  return adapter.render(event, decision);
}

async function readStdin(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function runShim({ harness, event, input, home, socketPath }) {
  const paths = agentdPaths(home);
  try {
    return await callDaemon({ socketPath: socketPath || paths.socket, harness, event, payload: input, timeoutMs: shimDeadline(harness) });
  } catch (error) {
    return runFallback({ harness, event, input, home, errorCode: error && error.code ? error.code : 'daemon_unreachable' });
  }
}

module.exports = { runShim, runFallback, readStdin, writeBypassRecord, shimDeadline };

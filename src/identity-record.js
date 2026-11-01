'use strict';

// INS-1: `update` and the controller maintenance pass never take the agent id from the runner's
// environment. An owner-only identity record (installer.js readIdentityRecord) restores the id Marrow
// recorded for a file; an unsafe record changes nothing; `update --fix-identity` reads the key's
// binding from the live status contract (GET /v1/agent/status, test/fixtures/ins1/STATUS-CONTRACT.md).
// This module holds the pure decision, the exact lines, the per-file key lookup and the status client.
// It reads no environment variable and prints nothing: callers print what it returns.

const fs = require('node:fs');
const path = require('node:path');

const { assertSafeBaseUrl, DEFAULT_BASE_URL, ownerKeyBaseUrl, parseKeyTarget } = require('./base-url-policy');
const { readOwnerKeyDetail } = require('./owner-env');

const SAFE_AGENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const PLACEHOLDER_RE = /\$\{[^}]*\}|^\$[A-Za-z_]/;
const UPDATE_COMMAND = 'npx -y @getmarrow/install@latest update';
const STATUS_MAX_BYTES = 256 * 1024;
const STATUS_MAX_IDS = 64;
const STATUS_TIMEOUT_MS = 10_000;
const NOT_AN_ID = '[invalid agent id]';

// What an id may look like in a line: the id itself when it passes SAFE_AGENT_ID, else a fixed label.
function printableId(value) {
  return typeof value === 'string' && SAFE_AGENT_ID.test(value) ? value : NOT_AN_ID;
}

// ---------------------------------------------------------------------------------------------------------------
// The record is unsafe: one line, per state (symlink: never chmod through it; extra link: remove it; other owner or
// bad JSON: delete it and pass --agent-id).
// ---------------------------------------------------------------------------------------------------------------
const UNSAFE_STATES = {
  dir_mode: { state: '~/.marrow can be written by group or others', fix: 'chmod 700 ~/.marrow' },
  dir_link: { state: '~/.marrow is a symbolic link', fix: 'replace the link with a real folder only you own (never change permissions through the link)' },
  dir_other: { state: '~/.marrow is not a folder only you own', fix: 'make ~/.marrow a real folder only you own (chmod 700 ~/.marrow)' },
  mode: { state: 'group or others can read or write it', fix: 'chmod 700 ~/.marrow && chmod 600 {path}' },
  symlink: { state: 'it is a symbolic link', fix: 'replace the link with a regular owner-only file (never change permissions through the link)' },
  nlink: { state: 'it has more than one hard link', fix: 'remove the extra link so the file has one link' },
  owner: { state: 'it is owned by another user', fix: 'delete it, then run update again with --agent-id <id>' },
  not_regular: { state: 'it is not a regular file', fix: 'delete it, then run update again with --agent-id <id>' },
  too_large: { state: 'it is larger than a record can be', fix: 'delete it, then run update again with --agent-id <id>' },
  bad_json: { state: 'it is not valid JSON', fix: 'delete it, then run update again with --agent-id <id>' },
  bad_shape: { state: 'it does not have the shape of a record', fix: 'delete it, then run update again with --agent-id <id>' },
  unreadable: { state: 'it cannot be read', fix: 'delete it, then run update again with --agent-id <id>' },
};

function unsafeRecordLine(recordPath, reason) {
  const known = UNSAFE_STATES[reason] || UNSAFE_STATES.unreadable;
  const fix = known.fix.replace('{path}', recordPath);
  const again = /run update again/.test(fix) ? '' : ', then run update again';
  return `Identity: ${recordPath} is not safe to trust (${known.state}), so update changed nothing. Fix: ${fix}${again}.`;
}

// ---------------------------------------------------------------------------------------------------------------
// F-ID2: the complete identity rule for one managed MCP config file on update and on maintenance.
//   held         the concrete MARROW_FLEET_AGENT_ID in the file's marrow env block ('' when absent or installer-derived)
//   recordState  'valid' | 'absent' (an unsafe record never gets here: update stops first)
//   recordedId   the id the valid record holds for this exact file ('' when it holds none)
//   explicitId   --agent-id, or the id --fix-identity read from the server for this file
// Nothing here consults the runner's environment or any allowlist. Reset always means REMOVE the variable.
// ---------------------------------------------------------------------------------------------------------------
function decideAgentIdentity({ held, recordState, recordedId, explicitId, via, preRecordEligible }) {
  if (explicitId) {
    return {
      id: explicitId,
      recordId: explicitId,
      kept: null,
      divergence: held && held !== explicitId ? { reason: 'explicit', held, applied: explicitId, via } : null,
    };
  }
  if (recordState === 'valid' && recordedId) {
    if (held === recordedId) return { id: recordedId, recordId: recordedId, kept: { reason: 'recorded', value: recordedId }, divergence: null };
    return { id: recordedId, recordId: recordedId, kept: null, divergence: { reason: 'restored', held, applied: recordedId } };
  }
  if (held && recordState === 'absent' && preRecordEligible) {
    return { id: held, recordId: held, kept: { reason: 'pre_record', value: held }, divergence: null };
  }
  return {
    id: '',
    recordId: '',
    kept: null,
    divergence: held ? { reason: 'removed', held, applied: null } : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The exact U2 lines. A line carries a runnable `--agent-id <C>` only for a home file whose id passes SAFE_AGENT_ID:
// an id from a project file or a hostile one is never put into a command an agent might run.
// ---------------------------------------------------------------------------------------------------------------
function identityLine(divergence, { file, homeScope }) {
  const held = divergence.held == null ? null : printableId(divergence.held);
  const runnable = homeScope && held && held !== NOT_AN_ID;
  const adopt = (verb) => (runnable
    ? `To ${verb} ${held}: ${UPDATE_COMMAND} --agent-id ${held}`
    : `If you set ${held || NOT_AN_ID} yourself, run update with --agent-id and that id.`);
  if (divergence.reason === 'restored') {
    const recorded = printableId(divergence.applied);
    if (!held) return `Identity: ${file} had no MARROW_FLEET_AGENT_ID, but Marrow recorded ${recorded} for this file; restored ${recorded}.`;
    return `Identity: ${file} had MARROW_FLEET_AGENT_ID=${held}, but Marrow recorded ${recorded} for this file; restored ${recorded}. ${runnable ? `To use ${held} instead: ${UPDATE_COMMAND} --agent-id ${held}` : adopt('keep')}`;
  }
  if (divergence.reason === 'removed') {
    return `Identity: removed MARROW_FLEET_AGENT_ID=${held} from ${file} (not set by you or recorded by Marrow); Marrow now uses the agent this key is bound to. ${runnable ? `To keep ${held}: ${UPDATE_COMMAND} --agent-id ${held}` : adopt('keep')}`;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// U5 for a run that changed a marrow env block: that host's own next step. With the process list unavailable (or no
// running Marrow server seen) the line is prefixed "If <host> is open: " and never says there is nothing to do.
// ---------------------------------------------------------------------------------------------------------------
const HOST_STEP = {
  'Claude Code': 'type /mcp, pick marrow, then Reconnect.',
  Cursor: 'restart Cursor.',
};

function hostStepLines(hosts, { running }) {
  const lines = [];
  for (const host of [...new Set(hosts)]) {
    const step = HOST_STEP[host];
    if (!step) continue;
    lines.push(running ? `${host}: ${step}` : `If ${host} is open: ${step}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------------------------
// --fix-identity: the key a config file's MCP server would use, resolved in-process (the runner's MARROW_* variables
// are never read here), and the status call made with that key alone.
// ---------------------------------------------------------------------------------------------------------------
function concrete(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && !PLACEHOLDER_RE.test(text) ? text : '';
}

function readMarrowEnvBlock(filePath) {
  try {
    const config = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const entry = config?.mcpServers?.marrow;
    if (!entry || typeof entry !== 'object') return null;
    return entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env) ? entry.env : {};
  } catch {
    return null;
  }
}

function perIdKeyName(agentId) {
  return `MARROW_KEY_${String(agentId).toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

// { key, source, ownerDetail } or { cannot: 'host_env' | 'ambiguous' }.
function resolveFileKey({ block, home }) {
  for (const name of ['MARROW_API_KEY', 'MARROW_KEY']) {
    const key = concrete(block[name]);
    if (key) return { key, source: 'env_block' };
    if (typeof block[name] === 'string' && block[name].trim()) return { cannot: 'host_env' }; // a ${PLACEHOLDER}: the host's own env
  }
  const held = concrete(block.MARROW_FLEET_AGENT_ID);
  const perIdNames = Object.keys(block).filter((name) => /^MARROW_KEY_[A-Z0-9_]+$/.test(name) && name !== 'MARROW_KEY_');
  if (perIdNames.length) {
    const wanted = held ? perIdKeyName(held) : null;
    const key = wanted && perIdNames.includes(wanted) ? concrete(block[wanted]) : '';
    return key ? { key, source: 'env_block' } : { cannot: 'ambiguous' };
  }
  let detail = null;
  try { detail = readOwnerKeyDetail(home); } catch { detail = null; }
  if (detail && detail.apiKey) return { key: detail.apiKey, source: 'owner_file', ownerDetail: detail };
  return { cannot: 'host_env' };
}

// The endpoint for that key: the server's own MARROW_BASE_URL when it is a URL a key may be sent to, an owner-file key
// only where the owner file allows (base-url-policy). A URL that is not https (loopback may be http) is refused before
// the key leaves.
function statusBaseUrl({ block, resolved }) {
  const named = typeof block.MARROW_BASE_URL === 'string' ? block.MARROW_BASE_URL.trim() : '';
  if (named && !parseKeyTarget(named)) return { refused: true };
  if (resolved.source === 'owner_file') {
    const decision = ownerKeyBaseUrl({ candidate: named, ownerValues: resolved.ownerDetail.endpoint, fileName: resolved.ownerDetail.fileName, source: 'MARROW_BASE_URL in the MCP config' });
    return { baseUrl: assertSafeBaseUrl(decision.baseUrl) };
  }
  return { baseUrl: assertSafeBaseUrl(named || DEFAULT_BASE_URL) };
}

// GET /v1/agent/status, default compact form, NO X-Marrow-Agent-Id header (a wrong one is a 403 whose body is never
// read for ids). Only an HTTP 200 whose data.identity.bound_agent_ids is an array of SAFE_AGENT_ID strings counts.
// Nothing from any body is returned except those validated ids.
async function readBoundAgents({ baseUrl, key, fetchImpl = fetch, timeoutMs = STATUS_TIMEOUT_MS }) {
  let response;
  try {
    response = await fetchImpl(`${String(baseUrl).replace(/\/+$/, '')}/v1/agent/status`, {
      method: 'GET',
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { error: error && error.name === 'TimeoutError' ? 'no answer in time' : 'could not connect' };
  }
  const code = Number(response?.status);
  if (code !== 200) return { error: Number.isInteger(code) && code >= 100 && code <= 599 ? `HTTP ${code}` : 'unexpected answer' };
  let text;
  try { text = await response.text(); } catch { return { error: 'could not read the answer' }; }
  if (text.length > STATUS_MAX_BYTES) return { error: 'answer too large' };
  let body;
  try { body = JSON.parse(text); } catch { return { error: 'answer not in the expected shape' }; }
  const identity = body && typeof body === 'object' && body.data && typeof body.data === 'object' ? body.data.identity : null;
  const ids = identity && typeof identity === 'object' ? identity.bound_agent_ids : null;
  if (!Array.isArray(ids) || ids.length > STATUS_MAX_IDS || !ids.every((id) => typeof id === 'string' && SAFE_AGENT_ID.test(id))) {
    return { error: 'answer not in the expected shape' };
  }
  return { ids: [...new Set(ids)] };
}

// Decides --fix-identity for each managed MCP config file; `files` = [{ path, key }] with the realpath key the identity
// record uses. Returns { targets: Map(key -> id), lines, stop } where stop = { exitCode: 4, lines } and nothing is
// written when any file cannot be checked, errors, or has several candidate ids (never guessed).
async function resolveIdentityFixes({ files, home, fetchImpl, timeoutMs }) {
  const targets = new Map();
  const notes = [];
  const failures = [];
  for (const file of files) {
    const block = readMarrowEnvBlock(file.path);
    if (!block) continue;
    const held = concrete(block.MARROW_FLEET_AGENT_ID);
    const resolved = resolveFileKey({ block, home });
    if (resolved.cannot) {
      failures.push(resolved.cannot === 'ambiguous'
        ? `Identity: cannot check ${file.path}: it names per-agent keys and none matches its agent id. Nothing was changed.`
        : `Identity: cannot check ${file.path}: this host's key comes from its own environment. Nothing was changed.`);
      continue;
    }
    let target;
    try {
      target = statusBaseUrl({ block, resolved });
    } catch {
      target = { refused: true };
    }
    if (target.refused) {
      failures.push(`Identity: cannot check ${file.path}: MARROW_BASE_URL there must be an https URL (http is allowed only for localhost, 127.0.0.1 and [::1]) with no user name, password, query or fragment. Nothing was changed and no key was sent.`);
      continue;
    }
    const answer = await readBoundAgents({ baseUrl: target.baseUrl, key: resolved.key, fetchImpl, timeoutMs });
    if (answer.error) {
      failures.push(`Identity: could not read this key's agent binding for ${file.path} (${answer.error}). Nothing was changed.`);
      continue;
    }
    const bound = answer.ids;
    if (bound.length === 0) {
      notes.push(`Identity: ${file.path}: This key is not bound to an agent; keeping ${held ? printableId(held) : 'no agent id'}.`);
    } else if (bound.length === 1) {
      if (held && held !== bound[0]) targets.set(file.key, bound[0]);
    } else if (held && !bound.includes(held)) {
      failures.push(`Identity: ${file.path} uses MARROW_FLEET_AGENT_ID=${printableId(held)}, but this key is bound to several agents (${bound.length}). Choose one: ${bound.join(', ')}; then run ${UPDATE_COMMAND} --agent-id <id>. Nothing was changed.`);
    }
  }
  if (failures.length) return { targets: new Map(), lines: [], stop: { exitCode: 4, lines: failures } };
  return { targets, lines: notes, stop: null };
}

function displayPath(filePath, home) {
  const relative = path.relative(home, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative) ? `~/${relative}` : filePath;
}

module.exports = {
  NOT_AN_ID,
  SAFE_AGENT_ID,
  UNSAFE_STATES,
  UPDATE_COMMAND,
  decideAgentIdentity,
  displayPath,
  hostStepLines,
  identityLine,
  printableId,
  readBoundAgents,
  readMarrowEnvBlock,
  resolveFileKey,
  resolveIdentityFixes,
  statusBaseUrl,
  unsafeRecordLine,
};

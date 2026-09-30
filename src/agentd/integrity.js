'use strict';

// Local integrity checks. A governed agent runs as the same OS user, so it can edit files the
// daemon relies on; the daemon cannot prevent that in per-user mode (the design's hardened mode,
// a separate service user, can). What it guarantees is that every such change is DETECTED and
// REPORTED to the server as an owner-visible event, and that none of them weakens a decision:
// the daemon keeps its start-time config, pinned origins and last verified policy.

const fs = require('node:fs');
const path = require('node:path');
const { checkPrivateDir, sha256File } = require('./fsutil');

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function hookFilePresent(entry) {
  const doc = readJson(entry.file);
  if (!doc) return false;
  const text = JSON.stringify(doc);
  return typeof entry.command === 'string' && text.includes(JSON.stringify(entry.command).slice(1, -1));
}

// `startConfig` is the config the daemon loaded at start; `configDigest` its sha256.
function checkIntegrity({ root, configPath, startConfig, configDigest, api, home }) {
  const violations = [];
  const add = (code, detail) => { if (!violations.some((v) => v.code === code && v.detail === detail)) violations.push(detail ? { code, detail } : { code }); };

  const rootIssue = checkPrivateDir(root);
  if (rootIssue) add('state_dir_unsafe', rootIssue);
  const runIssue = checkPrivateDir(path.join(root, 'run'));
  if (runIssue && runIssue !== 'missing') add('run_dir_unsafe', runIssue);

  let currentDigest = null;
  try { currentDigest = sha256File(configPath); } catch { add('config_missing'); }
  if (currentDigest && configDigest && currentDigest !== configDigest) add('config_changed_since_start');
  try {
    const stat = fs.lstatSync(configPath);
    if (stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) add('config_permissions');
  } catch { /* reported as config_missing */ }

  const current = currentDigest ? readJson(configPath) : null;
  if (current && typeof current.base_url === 'string' && api && !api.allowed.has(safeOrigin(current.base_url))) add('base_url_not_allowed');
  if (api && api.rejectedBaseUrl) add('base_url_rejected_at_start');

  const shim = startConfig && startConfig.shim;
  if (shim && shim.path) {
    try {
      if (sha256File(shim.path) !== shim.sha256) add('shim_modified');
    } catch { add('shim_missing'); }
  }
  for (const entry of (startConfig && Array.isArray(startConfig.hooks) ? startConfig.hooks : [])) {
    if (!hookFilePresent(entry)) add('hook_missing', `${entry.harness}:${entry.event || 'pre'}`);
  }
  // The 0.1.6x installer's control.json is not an authority any more; a local "disabled" there
  // changes nothing, but it is reported so the owner can see an attempt.
  const legacy = readJson(path.join(home, '.marrow', 'control.json'));
  if (legacy && legacy.enabled === false) add('legacy_control_disable_ignored');

  return { ok: violations.length === 0, violations, checked_at: new Date().toISOString() };
}

function safeOrigin(url) {
  try { const parsed = new URL(url); return `${parsed.protocol}//${parsed.host}`; } catch { return null; }
}

module.exports = { checkIntegrity };

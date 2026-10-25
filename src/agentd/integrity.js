'use strict';

// Local integrity checks. A governed agent runs as the same OS user, so it can edit files the
// daemon relies on; the daemon cannot prevent that in per-user mode (the design's hardened mode,
// a separate service user, can). What it guarantees is that every such change is DETECTED and
// REPORTED to the server as an owner-visible event, and that none of them weakens a decision:
// the daemon keeps its start-time config, pinned origins and last verified policy.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { checkPrivateDir, sha256File } = require('./fsutil');

const FULL_MATCHERS = new Set([undefined, '', '*', '.*']);

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Digest over every file under the installed lib directory (relative path + sha256, sorted).
// The installer records it at install time; the daemon recomputes it on every integrity pass.
function manifestDigest(libDir) {
  const lines = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) { lines.push(`${path.relative(libDir, full)} symlink`); continue; }
      if (stat.isDirectory()) walk(full);
      else lines.push(`${path.relative(libDir, full)} ${sha256File(full)}`);
    }
  };
  walk(libDir);
  return crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

// Returns null when the hook entry is intact, otherwise a violation code.
function hookEntryProblem(entry) {
  const doc = readJson(entry.file);
  if (!doc) return 'hook_file_missing';
  if (doc.disableAllHooks === true) return 'hooks_disabled';
  const groups = doc.hooks && Array.isArray(doc.hooks[entry.event]) ? doc.hooks[entry.event] : [];
  const group = groups.find((g) => g && Array.isArray(g.hooks) && g.hooks.some((h) => h && h.command === entry.command));
  if (!group) return 'hook_missing';
  if (['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(entry.event) && !FULL_MATCHERS.has(group.matcher)) return 'hook_matcher_narrowed';
  return null;
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
  const lib = startConfig && startConfig.lib;
  if (lib && lib.dir && lib.manifest_sha256) {
    try {
      if (manifestDigest(lib.dir) !== lib.manifest_sha256) add('daemon_code_modified');
    } catch { add('daemon_code_missing'); }
  }
  for (const entry of (startConfig && Array.isArray(startConfig.hooks) ? startConfig.hooks : [])) {
    const problem = hookEntryProblem(entry);
    if (problem) add(problem, `${entry.harness}:${entry.event || 'PreToolUse'}`);
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

module.exports = { checkIntegrity, manifestDigest, hookEntryProblem };

'use strict';

// INS-1: `update` and the controller maintenance pass never take the agent id from the runner's
// environment. An owner-only identity record (installer.js readIdentityRecord) restores the id Marrow
// recorded for a file; an unsafe record changes nothing. This module holds the pure decision and the exact lines.
// It reads no file and no environment variable and prints nothing: callers print what it returns.

const path = require('node:path');

const SAFE_AGENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const UPDATE_COMMAND = 'npx -y @getmarrow/install@latest update';
const NOT_AN_ID = '[invalid agent id]';

// What an id may look like in a line: the id itself when it passes SAFE_AGENT_ID, else a fixed label.
function printableId(value) {
  return typeof value === 'string' && SAFE_AGENT_ID.test(value) ? value : NOT_AN_ID;
}

// What a path may look like in an identity line: the path itself when it is plain (no space, quote, control, format or
// non-ASCII character, so a directory name cannot carry a sentence into the line), else a fixed label.
const NOT_A_PATH = '[unsafe path]';
const PLAIN_PATH = /^[A-Za-z0-9._~/:@+=,\\-]{1,1024}$/;
function printablePath(value) {
  return typeof value === 'string' && PLAIN_PATH.test(value) ? value : NOT_A_PATH;
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
  const shown = printablePath(recordPath);
  const fix = known.fix.replace('{path}', shown);
  const again = /run update again/.test(fix) ? '' : ', then run update again';
  return `Identity: ${shown} is not safe to trust (${known.state}), so update changed nothing. Fix: ${fix}${again}.`;
}

// ---------------------------------------------------------------------------------------------------------------
// F-ID2: the complete identity rule for one managed MCP config file on update and on maintenance.
//   held         the concrete MARROW_FLEET_AGENT_ID in the file's marrow env block ('' when absent or installer-derived)
//   recordState  'valid' | 'absent' (an unsafe record never gets here: update stops first)
//   recordedId   the id the valid record holds for this exact file ('' when it holds none)
//   explicitId   --agent-id
// Nothing here consults the runner's environment or any allowlist. Under a valid record, and on every maintenance pass, an id
// the file holds that passes SAFE_AGENT_ID and that nothing above overrides is KEPT and reported, never recorded
// (record: false). With no record file, `update` keeps once (preRecordEligible) a plain id set in the owner's home config and
// removes any other held id, a project file's id included; maintenance keeps any id that passes SAFE_AGENT_ID. An id that
// fails SAFE_AGENT_ID is removed everywhere. Whether Marrow should keep or remove an id it did not record is the owner's
// call (audit O8).
// ---------------------------------------------------------------------------------------------------------------
function decideAgentIdentity({ held, recordState, recordedId, explicitId, via, preRecordEligible, maintenance }) {
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
  if (held && SAFE_AGENT_ID.test(held)) {
    if (recordState === 'absent' && preRecordEligible) {
      return { id: held, recordId: held, kept: { reason: 'pre_record', value: held }, divergence: null };
    }
    if (recordState === 'valid' || maintenance === true) {
      return { id: held, recordId: held, record: false, kept: { reason: 'unrecorded', value: held }, divergence: null };
    }
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
function identityLine(divergence, { file: filePath, homeScope }) {
  const file = printablePath(filePath);
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
  printablePath,
  unsafeRecordLine,
};

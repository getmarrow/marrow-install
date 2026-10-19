'use strict';

// Doctor's read-only view of the keyless seatbelt: it runs the pinned MCP's `seatbelt-status`
// command and prints one plain line. Nothing here writes anything or changes any doctor verdict.
//
// The command prints exactly one line of JSON, {"mode":...,"reasons":[...]}, and exits 0. An older
// MCP has no such command (an unknown subcommand may start the MCP server on stdio and wait), so
// its output is untrusted: only a single printable-ASCII line that parses to exactly those two keys,
// with a mode and reasons from the closed sets below, is accepted. Anything else (a timeout, a
// non-zero exit, extra keys, an unknown code, extra lines, control or non-ASCII bytes, more than 4 KB)
// is "could not check". The raw output is never echoed.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SEATBELT_MODES = Object.freeze(['seatbelt', 'claimed_no_key', 'account', 'unknown']);
const SEATBELT_REASON_CODES = Object.freeze([
  'strict', 'key_rejected', 'home_unknown', 'home_unusable', 'env_home_unusable', 'home_mismatch', 'evidence_unknown', 'account_evidence',
]);
const SEATBELT_STATUS_TIMEOUT_MS = 8000;
const SEATBELT_STATUS_MAX_BYTES = 4096;

// The one reason shown when more than one applies: the first match in this order.
const REASON_ORDER = Object.freeze(['strict', 'key_rejected', 'home_unknown', 'home_unusable', 'env_home_unusable', 'home_mismatch', 'evidence_unknown']);
// [REASON_TEXT, FIX_TEXT] per code. Doctor never prints a "run ... doctor" fix: key_rejected and
// "other" point at the key and at the lines below instead.
const REASON_TEXT = Object.freeze({
  strict: ['MARROW_SEATBELT_STRICT=1 is set', 'unset MARROW_SEATBELT_STRICT'],
  key_rejected: ['the Marrow key on this machine was rejected', 'check the key in ~/.marrow/env or MARROW_API_KEY'],
  home_unknown: ['it cannot find your login home folder (common in containers that run as a user with no home)', 'run the agent as a user that has a home folder'],
  home_unusable: ['your login home folder is missing, is not a folder, or is /', 'give this user a real home folder'],
  env_home_unusable: ['HOME points to a folder that is missing or is not a folder', 'set HOME to your login home folder'],
  home_mismatch: ['HOME is not your login home folder', 'start the agent with HOME set to your login home folder'],
  evidence_unknown: [
    'a folder or file it checks (your home folder, ~/.marrow, or an agent folder such as ~/.claude) belongs to another user, can be written by other users, or could not be read',
    'make sure your home folder, ~/.marrow and your agent folders (such as ~/.claude) belong to you and can be read, then run chmod go-w on them',
  ],
  account_evidence: [
    'this machine has an earlier Marrow setup (a ~/.marrow file or Marrow hooks in your settings) but no working key',
    'add your key to ~/.marrow/env (chmod 600), or remove the old setup with npx -y @getmarrow/install@latest uninstall',
  ],
  other: ['it could not confirm this machine\'s setup', 'see the lines below'],
});

// { mode, reasons } from the command's stdout (a Buffer or a latin1 string), or null.
function parseSeatbeltStatus(output) {
  const text = Buffer.isBuffer(output) ? output.toString('latin1') : output;
  if (typeof text !== 'string' || text.length === 0 || text.length > SEATBELT_STATUS_MAX_BYTES) return null;
  // One line of printable ASCII, optionally ended by one LF: no ESC or other control byte, no CR,
  // no second line, no byte above 0x7E.
  if (!/^[\x20-\x7e]+\n?$/.test(text)) return null;
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'mode' || keys[1] !== 'reasons') return null;
  if (!SEATBELT_MODES.includes(value.mode)) return null;
  if (!Array.isArray(value.reasons) || value.reasons.length > SEATBELT_REASON_CODES.length) return null;
  const seen = new Set();
  for (const reason of value.reasons) {
    if (typeof reason !== 'string' || !SEATBELT_REASON_CODES.includes(reason) || seen.has(reason)) return null;
    seen.add(reason);
  }
  return { mode: value.mode, reasons: [...value.reasons] };
}

// stdout of the command as a Buffer, or null on a spawn error, a timeout, more than maxBytes of
// output, a non-zero exit or a signal. stdin is closed and stderr is dropped. The command runs in
// its own process group, killed whole on a timeout or an overflow while its leader is still running
// (so no signal ever goes to a group this call did not create, or to a reused pid).
function collectOutput({ command, args, cwd, env, timeoutMs = SEATBELT_STATUS_TIMEOUT_MS, maxBytes = SEATBELT_STATUS_MAX_BYTES }) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    let timer = null;
    let child = null;
    const stop = () => {
      if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
      try {
        if (process.platform === 'win32') child.kill('SIGKILL');
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    };
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener('exit', stop);
      resolve(value);
    };
    try {
      child = spawn(command, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch {
      finish(null);
      return;
    }
    process.once('exit', stop);
    timer = setTimeout(() => {
      stop();
      child.stdout.destroy();
      finish(null);
    }, timeoutMs);
    child.on('error', () => finish(null));
    child.stdout.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        stop();
        child.stdout.destroy();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    child.on('close', (code, signal) => finish(code === 0 && signal === null ? Buffer.concat(chunks) : null));
  });
}

// Runs the command in a private empty folder (never the project, whose npm settings or local bins
// npx would read) and returns { mode, reasons } or null. `invocation` is { command, args, env }.
async function runSeatbeltStatus(invocation, limits = {}) {
  const privateCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-install-seatbelt-'));
  try {
    const output = await collectOutput({ ...invocation, cwd: privateCwd, ...limits });
    return output ? parseSeatbeltStatus(output) : null;
  } finally {
    fs.rmSync(privateCwd, { recursive: true, force: true });
  }
}

// The one reason doctor shows for a claimed_no_key status, or null for none / other.
function pickSeatbeltReason(reasons) {
  const found = REASON_ORDER.find((code) => reasons.includes(code));
  if (found) return found;
  return reasons.includes('account_evidence') ? 'account_evidence' : null;
}

// The report field (codes only): { mode, reason }. A status of null is "could_not_check".
function seatbeltReport(status) {
  if (!status) return { mode: 'could_not_check', reason: null };
  return { mode: status.mode, reason: status.mode === 'claimed_no_key' ? pickSeatbeltReason(status.reasons) : null };
}

// The doctor line, "- Seatbelt: ..." (without the newline), from a seatbeltReport() value. Any
// other value (a missing field, an unknown mode) is "could not check".
function seatbeltLine(report) {
  const mode = report && typeof report === 'object' ? report.mode : null;
  if (mode === 'seatbelt') return '- Seatbelt: on (no account)';
  if (mode === 'account') return '- Seatbelt: account mode (using your Marrow key)';
  if (mode !== 'claimed_no_key') return '- Seatbelt: could not check';
  const code = Object.prototype.hasOwnProperty.call(REASON_TEXT, report.reason) ? report.reason : 'other';
  const [reason, fix] = REASON_TEXT[code];
  return `- Seatbelt: strict here (holds more actions): ${reason} -> ${fix}`;
}

module.exports = {
  SEATBELT_MODES,
  SEATBELT_REASON_CODES,
  SEATBELT_STATUS_TIMEOUT_MS,
  SEATBELT_STATUS_MAX_BYTES,
  REASON_ORDER,
  REASON_TEXT,
  parseSeatbeltStatus,
  collectOutput,
  runSeatbeltStatus,
  pickSeatbeltReason,
  seatbeltReport,
  seatbeltLine,
};

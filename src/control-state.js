const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONTROL_STATE_VERSION = 1;
const CONTROL_STATE_DIRECTORY = '.marrow';
const CONTROL_STATE_FILENAME = 'control.json';
const CONTROL_CHANGED_BY = 'owner_cli';
const CONTROL_MAX_BYTES = 4096;
const CONTROL_BYPASS_ACTION = 'protected action bypassed while local control disabled';
const CONTROL_BYPASS_LEDGER_FILENAME = 'control-bypass-receipts.json';

class UnsafeControlStateError extends Error {
  constructor() { super('Local Marrow control state is unsafe or invalid. Protected actions remain blocked; inspect ~/.marrow/control.json and run npx @getmarrow/install control status.'); this.name = 'UnsafeControlStateError'; }
}

function statePaths(home = os.homedir()) {
  const directory = path.join(home, CONTROL_STATE_DIRECTORY);
  return { directory, target: path.join(directory, CONTROL_STATE_FILENAME) };
}
function unsafe() { throw new UnsafeControlStateError(); }
function ownedPrivate(stat, mode) {
  return !stat.isSymbolicLink() && stat.uid === (typeof process.getuid === 'function' ? process.getuid() : stat.uid) && (stat.mode & 0o777) === mode;
}
function readLocalControlState(options = {}) {
  const { directory, target } = statePaths(options.home);
  let ds;
  try { ds = fs.lstatSync(directory); } catch (error) { if (error.code === 'ENOENT') return { enabled: true, state: 'default_enabled', changed_at: null }; return unsafe(); }
  if (!ds.isDirectory() || ds.isSymbolicLink()) return unsafe();
  let ts;
  try { ts = fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return { enabled: true, state: 'default_enabled', changed_at: null }; return unsafe(); }
  if (!ownedPrivate(ds, 0o700)) return unsafe();
  if (!ts.isFile() || !ownedPrivate(ts, 0o600) || ts.size < 2 || ts.size > CONTROL_MAX_BYTES) return unsafe();
  let fd = -1;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.ino !== ts.ino || !ownedPrivate(opened, 0o600)) return unsafe();
    const raw = fs.readFileSync(fd, 'utf8');
    if (Buffer.byteLength(raw) > CONTROL_MAX_BYTES) return unsafe();
    const value = JSON.parse(raw);
    if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'change_id,changed_at,changed_by,enabled,version') return unsafe();
    const changedAt = typeof value.changed_at === 'string' ? value.changed_at : '';
    const valid = value.version === CONTROL_STATE_VERSION && typeof value.enabled === 'boolean' && value.changed_by === CONTROL_CHANGED_BY
      && changedAt && new Date(changedAt).toISOString() === changedAt && typeof value.change_id === 'string' && /^ctl_[a-f0-9]{32}$/.test(value.change_id);
    if (!valid) return unsafe();
    return { enabled: value.enabled, state: value.enabled ? 'enabled' : 'disabled', changed_at: changedAt, change_id: value.change_id };
  } catch (error) { if (error instanceof UnsafeControlStateError) throw error; return unsafe(); }
  finally { if (fd >= 0) fs.closeSync(fd); }
}
function writeLocalControlState(enabled, options = {}) {
  const current = readLocalControlState(options);
  if (current.enabled === enabled) return { ...current, changed: false, receipt: null };
  const { directory, target } = statePaths(options.home);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  const ds = fs.lstatSync(directory);
  if (!ds.isDirectory() || !ownedPrivate(ds, 0o700)) return unsafe();
  const value = { version: CONTROL_STATE_VERSION, enabled, changed_at: new Date().toISOString(), change_id: `ctl_${crypto.randomBytes(16).toString('hex')}`, changed_by: CONTROL_CHANGED_BY };
  const bytes = `${JSON.stringify(value)}\n`;
  const temp = path.join(directory, `.control.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  let fd = -1;
  try {
    fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = -1;
    fs.renameSync(temp, target);
    const dirFd = fs.openSync(directory, 'r'); try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } finally { if (fd >= 0) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
  return { enabled, state: enabled ? 'enabled' : 'disabled', changed_at: value.changed_at, change_id: value.change_id, changed: true, receipt: { action: enabled ? 'local control enabled' : 'local control disabled', change_id: value.change_id, changed_at: value.changed_at } };
}
function evidence(options = {}) {
  try { const s = readLocalControlState(options); return { ...s, bypass_recording_available: Boolean(options.apiKey), exact_next_action: s.enabled ? 'Run npx @getmarrow/install control disable --yes to disable local enforcement.' : 'Run npx @getmarrow/install control enable to resume local enforcement; hooks poll local state without reinstalling.' }; }
  catch { return { enabled: false, state: 'error', changed_at: null, bypass_recording_available: false, exact_next_action: 'Inspect and replace unsafe ~/.marrow/control.json, then run npx @getmarrow/install control status; protected actions remain blocked.' }; }
}
async function bestEffortLifecycle(event, options = {}) {
  const key = options.apiKey || process.env.MARROW_API_KEY || process.env.MARROW_KEY;
  if (!key || typeof fetch !== 'function') return false;
  try { const response = await fetch(`${String(options.baseUrl || process.env.MARROW_BASE_URL || 'https://api.getmarrow.ai').replace(/\/$/, '')}/v1/agent/integrations/events`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(event), signal: AbortSignal.timeout(1500) }); return response.ok; } catch { return false; }
}
function boundedIdentity(value, fallback) { const safe = String(value || '').trim().replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64); return safe || fallback; }
function persistBypassReceipt(input, options = {}) {
  const { directory } = statePaths(options.home);
  if (!fs.existsSync(directory)) fs.mkdirSync(directory, { mode: 0o700 });
  const ds = fs.lstatSync(directory); if (!ds.isDirectory() || !ownedPrivate(ds, 0o700)) return unsafe();
  const target = path.join(directory, CONTROL_BYPASS_LEDGER_FILENAME);
  let receipts = [];
  if (fs.existsSync(target)) {
    const ts = fs.lstatSync(target); if (!ts.isFile() || !ownedPrivate(ts, 0o600) || ts.size > CONTROL_MAX_BYTES * 8) return unsafe();
    receipts = JSON.parse(fs.readFileSync(target, 'utf8')); if (!Array.isArray(receipts)) return unsafe();
  }
  const receipt = { version: 1, action: CONTROL_BYPASS_ACTION, harness: boundedIdentity(input.harness, 'governed_runner'), agent_id: boundedIdentity(input.agentId, 'local-owner'), surfaces: [...new Set((input.surfaces || []).filter((v) => ['production','github','npm','secrets','database','financial','filesystem'].includes(v)))].slice(0, 6), risk_level: input.risk === 'high' ? 'high' : 'medium', correlation_id: `bypass_${crypto.randomBytes(16).toString('hex')}`, source: 'client_self_reported', intervention_disposition: 'overridden', action_changed: false, recorded_at: new Date().toISOString() };
  receipts = [...receipts.slice(-63), receipt]; const bytes = `${JSON.stringify(receipts)}\n`; if (Buffer.byteLength(bytes) > CONTROL_MAX_BYTES * 8) return unsafe();
  const temp = path.join(directory, `.bypass.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`); let fd = -1;
  try { fd = fs.openSync(temp, 'wx', 0o600); fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); fs.closeSync(fd); fd = -1; fs.renameSync(temp, target); }
  finally { if (fd >= 0) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch {} }
  return receipt;
}
async function recordGovernedBypass(input, options = {}) {
  const receipt = persistBypassReceipt(input, options);
  const remote_delivered = await bestEffortLifecycle({ event_type: 'pre_action_checked', ...receipt }, options);
  return { bypass_recorded: true, remote_delivered, receipt };
}
async function runControlCli(argv, options = {}) {
  const action = argv[1] || 'status'; const json = argv.includes('--json');
  if (!['status', 'disable', 'enable'].includes(action)) throw new Error('control action must be status, disable, or enable');
  if (action === 'disable' && !argv.includes('--yes')) throw new Error('control disable requires --yes owner confirmation; no state was changed');
  let result = action === 'status' ? evidence(options) : writeLocalControlState(action === 'enable', options);
  if (result.changed) {
    const delivered = await bestEffortLifecycle({ event_type: 'journey_update', action: result.receipt.action, source: 'client_self_reported', harness: 'installer', agent_id: boundedIdentity(options.agentId || process.env.MARROW_FLEET_AGENT_ID || process.env.MARROW_AGENT_ID, 'local-owner'), correlation_id: result.change_id }, options);
    result = { ...result, lifecycle_delivered: delivered };
  }
  if (json) process.stdout.write(`${JSON.stringify({ ok: result.state !== 'error', local_control: result }, null, 2)}\n`);
  else process.stdout.write(`Marrow local control: ${result.state}. ${result.exact_next_action || ''}\n`);
  return result;
}

module.exports = { CONTROL_STATE_VERSION, CONTROL_STATE_DIRECTORY, CONTROL_STATE_FILENAME, CONTROL_CHANGED_BY, CONTROL_MAX_BYTES, CONTROL_BYPASS_ACTION, CONTROL_BYPASS_LEDGER_FILENAME, UnsafeControlStateError, readLocalControlState, writeLocalControlState, evidence, bestEffortLifecycle, persistBypassReceipt, recordGovernedBypass, runControlCli };

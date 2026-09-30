'use strict';

// Signed policy cache. The server is authoritative: it signs a versioned policy bundle
// (contract marrow.policy.v1) with an Ed25519 key whose public half is pinned in the daemon.
// The bundle carries the classifier tables, the control level and the allowed API origins.
// Local files and environment variables can never change any of these; a bundle is accepted
// only if its signature verifies, its version is newer and it is not expired.

const crypto = require('node:crypto');
const path = require('node:path');
const { BASELINE_POLICY } = require('./policy-baseline');
const { CONTROL_LEVELS, DEFAULTS } = require('./constants');
const { ensurePrivateDir, readPrivateFile, writeFileAtomic } = require('./fsutil');

const POLICY_SCHEMA = 'marrow.policy.v1';
const VERDICT_SCHEMA = 'marrow.gate.v1';
const MAX_ENVELOPE_BYTES = 512 * 1024;

function b64url(buffer) {
  return Buffer.from(buffer).toString('base64url');
}

function toKeyObject(key) {
  if (key && typeof key === 'object' && key.type === 'public') return key;
  return crypto.createPublicKey(key);
}

// Envelope: { kid, payload: base64url(JSON bytes), sig: base64url(Ed25519(payload bytes)) }.
// Verifying the exact payload bytes avoids any JSON canonicalization ambiguity.
function verifyEnvelope(envelope, trustedKeys) {
  if (!envelope || typeof envelope !== 'object') return { ok: false, error: 'missing_envelope' };
  const { kid, payload, sig } = envelope;
  if (typeof kid !== 'string' || typeof payload !== 'string' || typeof sig !== 'string') return { ok: false, error: 'malformed_envelope' };
  if (payload.length > MAX_ENVELOPE_BYTES) return { ok: false, error: 'envelope_too_large' };
  const key = trustedKeys && Object.prototype.hasOwnProperty.call(trustedKeys, kid) ? trustedKeys[kid] : null;
  if (!key) return { ok: false, error: 'untrusted_key' };
  let bytes;
  let signature;
  try {
    bytes = Buffer.from(payload, 'base64url');
    signature = Buffer.from(sig, 'base64url');
  } catch {
    return { ok: false, error: 'malformed_envelope' };
  }
  let valid = false;
  try {
    valid = crypto.verify(null, bytes, toKeyObject(key), signature);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, error: 'bad_signature' };
  try {
    return { ok: true, kid, payload: JSON.parse(bytes.toString('utf8')) };
  } catch {
    return { ok: false, error: 'bad_payload' };
  }
}

function signEnvelope(payload, privateKey, kid) {
  const bytes = Buffer.from(JSON.stringify(payload), 'utf8');
  return { kid, payload: b64url(bytes), sig: b64url(crypto.sign(null, bytes, privateKey)) };
}

function isAllowedOrigin(url) {
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
    if (parsed.protocol === 'https:') return true;
    return parsed.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function validatePolicy(policy, now) {
  if (!policy || policy.schema !== POLICY_SCHEMA) return 'wrong_schema';
  if (!Number.isInteger(policy.version) || policy.version < 1) return 'bad_version';
  const issued = Date.parse(policy.issued_at);
  const expires = Date.parse(policy.expires_at);
  if (!Number.isFinite(issued) || !Number.isFinite(expires) || expires <= issued) return 'bad_validity';
  if (issued > now + 5 * 60 * 1000) return 'issued_in_future';
  if (!policy.control || !CONTROL_LEVELS.includes(policy.control.level)) return 'bad_control';
  if (policy.control.level !== 'enforce' && typeof policy.control.approval_receipt_id !== 'string') return 'weaker_control_without_owner_receipt';
  if (policy.classifier && policy.classifier.contract !== 'marrow.classifier.v1') return 'bad_classifier_contract';
  if (policy.allowed_base_urls && (!Array.isArray(policy.allowed_base_urls) || !policy.allowed_base_urls.every(isAllowedOrigin))) return 'bad_base_urls';
  return null;
}

class PolicyStore {
  constructor({ dir, trustedKeys = {}, now = () => Date.now(), staleGraceMs = DEFAULTS.policyStaleGraceMs }) {
    this.dir = dir;
    this.file = path.join(dir, 'current.json');
    this.trustedKeys = trustedKeys;
    this.now = now;
    this.staleGraceMs = staleGraceMs;
    this.active = null;
    this.lastError = null;
    this.tables = BASELINE_POLICY;
  }

  load() {
    let raw = null;
    try {
      raw = readPrivateFile(this.file, MAX_ENVELOPE_BYTES + 4096);
    } catch (error) {
      if (error.code !== 'ENOENT') this.lastError = `cache_unreadable:${error.reason || error.code || 'error'}`;
      return this.current();
    }
    let envelope = null;
    try { envelope = JSON.parse(raw); } catch { this.lastError = 'cache_invalid_json'; return this.current(); }
    const checked = this.check(envelope, { allowExpired: true });
    if (!checked.ok) { this.lastError = `cache_${checked.error}`; return this.current(); }
    this.setActive(checked.payload, envelope);
    return this.current();
  }

  check(envelope, { allowExpired = false } = {}) {
    const verified = verifyEnvelope(envelope, this.trustedKeys);
    if (!verified.ok) return verified;
    const invalid = validatePolicy(verified.payload, this.now());
    if (invalid) return { ok: false, error: invalid };
    if (!allowExpired && Date.parse(verified.payload.expires_at) <= this.now()) return { ok: false, error: 'expired' };
    return verified;
  }

  // Accepts a newer signed bundle from the server. Returns { accepted, reason }.
  accept(envelope) {
    const checked = this.check(envelope);
    if (!checked.ok) { this.lastError = checked.error; return { accepted: false, reason: checked.error }; }
    const current = this.active ? this.active.version : 0;
    if (checked.payload.version < current) { this.lastError = 'rollback_rejected'; return { accepted: false, reason: 'rollback_rejected' }; }
    if (checked.payload.version === current) return { accepted: false, reason: 'unchanged' };
    ensurePrivateDir(this.dir);
    writeFileAtomic(this.file, `${JSON.stringify(envelope)}\n`);
    this.setActive(checked.payload, envelope);
    this.lastError = null;
    return { accepted: true, reason: 'newer_version' };
  }

  setActive(payload, envelope) {
    this.active = payload;
    this.envelope = envelope;
    const classifier = payload.classifier || {};
    this.tables = {
      ...BASELINE_POLICY,
      ...classifier,
      programs: { ...BASELINE_POLICY.programs, ...(classifier.programs || {}) },
      tools: { ...BASELINE_POLICY.tools, ...(classifier.tools || {}) },
      outage: { ...BASELINE_POLICY.outage, ...(payload.outage || {}), risky: 'deny' },
      source: 'signed_policy',
      version: payload.version,
    };
  }

  freshness() {
    if (!this.active) return 'baseline';
    const expires = Date.parse(this.active.expires_at);
    const now = this.now();
    if (now < expires) return 'fresh';
    if (now < expires + this.staleGraceMs) return 'stale';
    return 'expired';
  }

  // The effective policy. An expired bundle stops counting: tables fall back to the baseline and
  // control returns to 'enforce', so an owner "off" lapses unless the server keeps renewing it.
  current() {
    const freshness = this.freshness();
    const usable = freshness === 'fresh' || freshness === 'stale';
    const control = usable && this.active.control ? this.active.control : { level: 'enforce' };
    return {
      source: usable ? 'signed_policy' : 'builtin_baseline',
      version: usable ? this.active.version : 0,
      freshness,
      tables: usable ? this.tables : BASELINE_POLICY,
      control: {
        level: freshness === 'fresh' ? control.level : 'enforce',
        approval_receipt_id: freshness === 'fresh' ? control.approval_receipt_id || null : null,
        changed_at: control.changed_at || null,
      },
      allowedBaseUrls: usable && Array.isArray(this.active.allowed_base_urls) ? this.active.allowed_base_urls : [],
      telemetry: usable && this.active.telemetry ? this.active.telemetry : {},
      expiresAt: this.active ? this.active.expires_at : null,
      lastError: this.lastError,
    };
  }
}

// Verifies a server gate verdict envelope and binds it to the action that was asked about.
function verifyVerdict(envelope, trustedKeys, expected) {
  const verified = verifyEnvelope(envelope, trustedKeys);
  if (!verified.ok) return verified;
  const verdict = verified.payload;
  if (!verdict || verdict.schema !== VERDICT_SCHEMA) return { ok: false, error: 'wrong_verdict_schema' };
  if (verdict.action_hash !== expected.actionHash) return { ok: false, error: 'verdict_action_mismatch' };
  if (verdict.request_id !== expected.requestId) return { ok: false, error: 'verdict_request_mismatch' };
  if (!['allow', 'deny', 'review_required'].includes(verdict.verdict)) return { ok: false, error: 'bad_verdict' };
  return { ok: true, verdict };
}

module.exports = { PolicyStore, verifyEnvelope, signEnvelope, verifyVerdict, validatePolicy, isAllowedOrigin, POLICY_SCHEMA, VERDICT_SCHEMA };

'use strict';

// marrow-agentd: one per-user local Marrow process. Hooks reach it over a Unix socket through a
// tiny shim; it alone holds the API key, keeps a signed policy cache from the server, sends
// risky or unknown actions to the server gate, and batches telemetry. See
// agents/bob/results/agentd-design-20260930.md for the full design.

const AGENTD_VERSION = '0.1.0-phase1';
const PROTOCOL_VERSION = 1;

// Wire protocol between the shim and the daemon (see protocol.js).
const REQUEST_MAGIC = 'MRWH1';
const RESPONSE_MAGIC = 'MRWR1';
const MAX_HEADER_BYTES = 256;
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

// The only production API origin. Anything else must be added by an owner-signed policy
// bundle; local config files and environment variables can never add a host.
const PRODUCTION_BASE_URL = 'https://api.getmarrow.ai';
const DEFAULT_ALLOWED_BASE_URLS = Object.freeze([PRODUCTION_BASE_URL]);

// Ed25519 public keys that may sign policy bundles and gate verdicts, by key id. Phase 1 ships
// none: until the backend publishes its policy signing key, the daemon runs on the built-in
// baseline policy and sends every non-routine action to the server gate. Tests inject a key
// generated at runtime through the programmatic API only; no file or env var can add one.
const TRUSTED_POLICY_KEYS = Object.freeze({});

const CONTROL_LEVELS = Object.freeze(['enforce', 'observe', 'off']);
const CONTROL_STRENGTH = Object.freeze({ enforce: 2, observe: 1, off: 0 });

// Per-harness hook timeouts the installer writes (ms). The daemon's server budget and the
// shim's socket deadline are derived from these so Marrow always answers before the host kills
// the hook (R-71).
const HARNESS_HOOK_TIMEOUT_MS = Object.freeze({
  'claude-code': 15000,
  codex: 5000,
});

const DEFAULTS = Object.freeze({
  gateBudgetCapMs: 4000,
  // Gate budget = min(cap, host timeout - margin): codex 5 s -> 2.5 s, claude-code 15 s -> 4 s.
  // Always below the shim's daemon phase (codex 3 s, claude-code 11 s) so the daemon answers first.
  gateBudgetMarginMs: 2500,
  policyRefreshMs: 60 * 1000,
  policyRefreshFastMs: 5 * 1000,
  policyStaleGraceMs: 24 * 60 * 60 * 1000,
  integrityCheckMs: 60 * 1000,
  heartbeatMs: 10 * 60 * 1000,
  flushIntervalMs: 5000,
  batchMaxEvents: 500,
  segmentMaxRecords: 256,
  laneMaxSegments: { high: 200, normal: 200 },
  maxConnections: 256,
  connectionIdleMs: 30000,
  leaseDefaultMs: 10 * 60 * 1000,
  backoffMinMs: 1000,
  backoffMaxMs: 5 * 60 * 1000,
});

module.exports = {
  AGENTD_VERSION,
  PROTOCOL_VERSION,
  REQUEST_MAGIC,
  RESPONSE_MAGIC,
  MAX_HEADER_BYTES,
  MAX_PAYLOAD_BYTES,
  PRODUCTION_BASE_URL,
  DEFAULT_ALLOWED_BASE_URLS,
  TRUSTED_POLICY_KEYS,
  CONTROL_LEVELS,
  CONTROL_STRENGTH,
  HARNESS_HOOK_TIMEOUT_MS,
  DEFAULTS,
};

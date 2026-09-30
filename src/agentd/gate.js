'use strict';

// Decision engine for pre-action hooks.
//
//   routine            -> allow locally from the signed policy (no network), receipt queued
//   risky or unknown   -> the server gate decides (one round trip, bounded budget)
//   server unavailable -> risky: DENY (fail closed, including any 5xx); unknown: policy outage
//                         rule (default deny)
//   control level      -> only from a fresh owner-signed policy; 'observe' and 'off' can never
//                         be set by an agent or a local file
//
// The server's verdict is verified (Ed25519, bound to the request id and action hash) whenever
// verification keys are pinned; a local stub or a redirected URL therefore cannot grant allow.

const crypto = require('node:crypto');
const { createClassifier } = require('./classifier');
const { verifyVerdict } = require('./policy');
const { redactArgv, redactText } = require('./redact');
const { DEFAULTS, HARNESS_HOOK_TIMEOUT_MS, PRODUCTION_BASE_URL } = require('./constants');

const MAX_LEASES = 1000;
const MAX_LEASE_MS = 60 * 60 * 1000;

class DecisionEngine {
  constructor({ policyStore, api, queue, config, trustedKeys, home, now = () => Date.now(), protectedPids = [], integrity = () => ({ ok: true, violations: [] }), gateBudgetCapMs = DEFAULTS.gateBudgetCapMs, gateBudgetMarginMs = DEFAULTS.gateBudgetMarginMs }) {
    this.policyStore = policyStore;
    this.api = api;
    this.queue = queue;
    this.config = config;
    this.trustedKeys = trustedKeys || {};
    this.home = home;
    this.now = now;
    this.protectedPids = protectedPids;
    this.integrity = integrity;
    this.gateBudgetCapMs = gateBudgetCapMs;
    this.gateBudgetMarginMs = gateBudgetMarginMs;
    this.cachedClassifier = null;
    this.cachedKey = null;
    this.leases = new Map();
    this.stats = { decisions: 0, by_source: {}, by_class: {}, gate_calls: 0, gate_failures: 0, pending_reviews: 0 };
  }

  classifierFor(policy) {
    const key = `${policy.source}:${policy.version}`;
    if (this.cachedKey !== key) {
      this.cachedClassifier = createClassifier(policy.tables, { home: this.home, protectedPids: this.protectedPids });
      this.cachedKey = key;
    }
    return this.cachedClassifier;
  }

  agentId(harness) {
    const agents = (this.config && this.config.agents) || {};
    return typeof agents[harness] === 'string' ? agents[harness] : `${harness}-local`;
  }

  budgetFor(harness) {
    const timeouts = (this.config && this.config.hook_timeouts_ms) || {};
    const hookTimeout = Number(timeouts[harness]) || HARNESS_HOOK_TIMEOUT_MS[harness] || 5000;
    return Math.max(250, Math.min(this.gateBudgetCapMs, hookTimeout - this.gateBudgetMarginMs));
  }

  actionHash(event, classification) {
    const material = JSON.stringify({
      harness: event.harness,
      tool: classification.tool,
      commands: classification.commands,
      paths: classification.paths,
      hosts: classification.hosts,
      cwd: event.cwd ? crypto.createHash('sha256').update(event.cwd).digest('hex').slice(0, 32) : null,
    });
    return crypto.createHash('sha256').update(material).digest('hex');
  }

  leaseKey(event, actionHash) {
    return `${this.agentId(event.harness)}:${actionHash}`;
  }

  getLease(key) {
    const lease = this.leases.get(key);
    if (!lease) return null;
    if (lease.expiresAt <= this.now()) { this.leases.delete(key); return null; }
    return lease;
  }

  setLease(key, lease) {
    if (this.leases.size >= MAX_LEASES) this.leases.delete(this.leases.keys().next().value);
    this.leases.set(key, lease);
  }

  async decide(event) {
    const started = this.now();
    const policy = this.policyStore.current();
    const classification = this.classifierFor(policy).classify(event);
    const level = policy.control.level;
    const integrity = this.integrity();
    const receipt = {
      type: 'decision_receipt',
      ts: new Date(started).toISOString(),
      harness: event.harness,
      agent_id: this.agentId(event.harness),
      session_id: event.session_id,
      tool_use_id: event.tool_use_id,
      tool_kind: classification.tool ? classification.tool.kind : 'other',
      tool_name: classification.tool ? classification.tool.name : '',
      programs: classification.programs.slice(0, 8),
      class: classification.class,
      reasons: classification.reasons.slice(0, 8),
      policy_version: policy.version,
      policy_source: policy.source,
      control_level: level,
      integrity: integrity.ok ? 'ok' : 'degraded',
      evidence: 'client_observed',
    };
    const finish = (decision, source, extra = {}) => {
      const result = { ...decision, source, class: classification.class };
      Object.assign(receipt, { decision: decision.decision, source, latency_ms: this.now() - started }, extra);
      this.stats.decisions += 1;
      this.stats.by_source[source] = (this.stats.by_source[source] || 0) + 1;
      this.stats.by_class[classification.class] = (this.stats.by_class[classification.class] || 0) + 1;
      if (this.queue) this.queue.append(receipt, 'high');
      return { ...result, receipt };
    };

    if (level === 'off') return finish({ decision: 'allow' }, 'owner_control_off');
    if (classification.class === 'routine') return finish({ decision: 'allow' }, 'local_policy');

    const actionHash = this.actionHash(event, classification);
    receipt.action_hash = actionHash;
    const leaseKey = this.leaseKey(event, actionHash);
    const lease = this.getLease(leaseKey);
    if (lease) return finish({ decision: 'allow' }, 'server_lease', { gate: { receipt_id: lease.receiptId, lease_expires_at: new Date(lease.expiresAt).toISOString() } });

    const requestId = `gtr_${crypto.randomUUID()}`;
    const action = {
      tool_kind: receipt.tool_kind,
      tool_name: receipt.tool_name,
      commands: classification.commands.map((command) => redactText(command, 240)),
      argv: classification.commands.length ? redactArgv(classification.commands[0].split(' ')) : [],
      paths: classification.paths,
      hosts: classification.hosts,
      programs: classification.programs,
      local_class: classification.class,
      local_reasons: classification.reasons,
    };

    if (level === 'observe') {
      this.queue && this.queue.append({ type: 'observed_action', ts: receipt.ts, harness: event.harness, agent_id: receipt.agent_id, session_id: event.session_id, request_id: requestId, action_hash: actionHash, action }, 'high');
      return finish({ decision: 'allow', notice: 'Marrow observe mode (owner-set): this action is recorded, not gated.' }, 'owner_control_observe');
    }

    this.stats.gate_calls += 1;
    const response = await this.api.request('POST', '/v1/agent/gate', {
      budgetMs: this.budgetFor(event.harness),
      idempotencyKey: requestId,
      body: {
        contract: 'marrow.gate.v1',
        request_id: requestId,
        action_hash: actionHash,
        agent_id: receipt.agent_id,
        session_id: event.session_id,
        tool_use_id: event.tool_use_id,
        harness: event.harness,
        policy_version: policy.version,
        integrity: receipt.integrity,
        action,
      },
    });

    let verdict = null;
    let failure = null;
    if (response.ok) {
      const checked = this.verifyGateResponse(response.json, { requestId, actionHash });
      if (checked.ok) verdict = checked.verdict;
      else failure = { class: 'unverified_verdict', code: checked.error };
    } else failure = response.error || { class: 'unknown', code: 'unknown' };

    if (!verdict) {
      this.stats.gate_failures += 1;
      const outageRule = classification.class === 'risky' ? 'deny' : ((policy.tables.outage || {}).unknown === 'allow' ? 'allow' : 'deny');
      const gate = { request_id: requestId, error_class: failure.class, error_code: failure.code, latency_ms: response.latencyMs || null };
      if (outageRule === 'allow') {
        return finish({ decision: 'allow', notice: 'Marrow server gate unavailable; this non-risky action was allowed under the owner outage policy and recorded.' }, 'outage_bypass', { gate });
      }
      const why = failure.class === 'config'
        ? (failure.code === 'credential_missing' ? 'Marrow has no API key on this machine (owner: rerun the Marrow installer).' : 'the Marrow API address is not an allowed origin.')
        : `the Marrow server gate did not answer (${failure.class}).`;
      return finish({
        decision: 'deny',
        reason: `Marrow blocked this ${classification.class === 'risky' ? 'risky' : 'unrecognized'} action because ${why} It stays blocked until the gate answers; routine work continues normally.`,
      }, 'gate_unavailable_fail_closed', { gate });
    }

    const gate = { request_id: requestId, receipt_id: verdict.receipt_id || null, decision_id: verdict.decision_id || null, verdict: verdict.verdict, latency_ms: response.latencyMs || null };
    if (verdict.verdict === 'allow') {
      const leaseMs = Math.min(Number(verdict.lease_ms) || 0, MAX_LEASE_MS);
      if (leaseMs > 0) this.setLease(leaseKey, { receiptId: verdict.receipt_id, expiresAt: this.now() + leaseMs });
      return finish({ decision: 'allow', notice: verdict.notice ? redactText(verdict.notice, 300) : null }, 'server_gate', { gate });
    }
    if (verdict.verdict === 'review_required') {
      this.stats.pending_reviews += 1;
      const link = typeof verdict.approval_url === 'string' && /^https:\/\//.test(verdict.approval_url) ? ` Approve: ${verdict.approval_url.slice(0, 200)}` : '';
      return finish({
        decision: 'ask',
        reason: `Marrow: owner approval required. ${redactText(verdict.reason || 'This action needs owner review.', 240)}${link} After approval, retry the same action.`,
      }, 'server_gate', { gate });
    }
    return finish({ decision: 'deny', reason: `Marrow blocked this action. ${redactText(verdict.reason || '', 300)}`.trim() }, 'server_gate', { gate });
  }

  // With pinned keys a signed envelope is mandatory. Without keys (phase 1 production before the
  // backend publishes its key) only a TLS response from the pinned production origin is trusted.
  verifyGateResponse(json, expected) {
    if (!json || typeof json !== 'object') return { ok: false, error: 'empty_response' };
    if (Object.keys(this.trustedKeys).length > 0) return verifyVerdict(json.envelope, this.trustedKeys, expected);
    if (this.api.baseUrl !== PRODUCTION_BASE_URL) return { ok: false, error: 'unsigned_verdict_from_non_production_origin' };
    const verdict = json.verdict && typeof json.verdict === 'object' ? json.verdict : null;
    if (!verdict || verdict.request_id !== expected.requestId || verdict.action_hash !== expected.actionHash) return { ok: false, error: 'verdict_binding_mismatch' };
    if (!['allow', 'deny', 'review_required'].includes(verdict.verdict)) return { ok: false, error: 'bad_verdict' };
    return { ok: true, verdict };
  }
}

module.exports = { DecisionEngine };

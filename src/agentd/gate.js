'use strict';

// Decision engine for pre-action hooks.
//
//   routine            -> allow locally from the signed policy (no network), receipt queued
//   risky or unknown   -> the server gate decides (one round trip, bounded budget)
//   server unavailable -> risky: DENY (fail closed, including any 5xx); unknown: DENY unless the
//                         owner-signed policy allows it, and then only for availability failures
//                         (transport, timeout, 5xx, 429) - never for 4xx or unverifiable verdicts
//   control level      -> only from a fresh owner-signed policy; 'observe' and 'off' can never
//                         be set by an agent or a local file
//
// The server's verdict is verified (Ed25519, bound to the request id and to a hash of the FULL
// tool input) whenever verification keys are pinned; a local stub or a redirected URL cannot
// grant allow, and a lease can never cover a different action.

const crypto = require('node:crypto');
const path = require('node:path');
const { createClassifier } = require('./classifier');
const { verifyVerdict } = require('./policy');
const { redactArgv, redactText } = require('./redact');
const { DEFAULTS, HARNESS_HOOK_TIMEOUT_MS, PRODUCTION_BASE_URL } = require('./constants');

const MAX_LEASES = 1000;
const MAX_LEASE_MS = 60 * 60 * 1000;
const MAX_TAINTS = 256;
const TAINT_TTL_MS = 24 * 60 * 60 * 1000;
const TAINT_SCAN_BYTES = 256 * 1024;
const AVAILABILITY_FAILURES = new Set(['transport', 'timeout', 'server', 'rate_limited']);

// Code an agent writes that a later "routine" test or build run would execute (ADV-06 H9 via a
// test runner). Narrower than the interpreter pattern so ordinary docs do not match.
const RISKY_CODE = /child_process|execSync|execFileSync|spawnSync|\bspawn\(|subprocess|os\.system|os\.popen|shutil\.rmtree|rmSync\(|rimraf|Runtime\.getRuntime|ProcessBuilder|\bpopen\(|\bsystem\(|npm\s+publish|wrangler\s+(?:deploy|publish)|terraform\s+(?:apply|destroy)|kubectl\s+(?:apply|delete)|git\s+push\s+(?:-f|--force)|\.aws\/credentials|id_rsa|id_ed25519|\.ssh\/|process\.env\.[A-Z_]*(?:KEY|TOKEN|SECRET)/;
// Programs that execute workspace code even when the classifier calls them routine.
const CODE_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'node', 'nodejs', 'npx', 'pnpx', 'bunx', 'python', 'python3', 'pytest', 'jest', 'vitest', 'mocha', 'cargo', 'go', 'deno', 'tsx', 'ts-node', 'ruby', 'rspec', 'dotnet', 'mvn', 'gradle', 'bash', 'sh', 'zsh',
  'husky', 'vite', 'next', 'webpack', 'webpack-cli', 'rollup', 'esbuild', 'tsup', 'parcel', 'astro', 'nuxi', 'nuxt', 'storybook', 'gatsby', 'remix']);

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function editedText(event) {
  const input = event.tool_input || {};
  const parts = [];
  for (const key of ['content', 'new_string', 'new_source', 'input', 'patch']) if (typeof input[key] === 'string') parts.push(input[key]);
  if (Array.isArray(input.edits)) for (const edit of input.edits) if (edit && typeof edit.new_string === 'string') parts.push(edit.new_string);
  if (typeof input.command === 'string') parts.push(input.command);
  return parts.join('\n').slice(0, TAINT_SCAN_BYTES);
}

class DecisionEngine {
  constructor({ policyStore, api, queue, config, trustedKeys, home, now = () => Date.now(), protectedPids = [], integrity = () => ({ ok: true, violations: [] }), gateBudgetCapMs = DEFAULTS.gateBudgetCapMs, gateBudgetMarginMs = DEFAULTS.gateBudgetMarginMs, tlsTrusted = () => true }) {
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
    this.tlsTrusted = tlsTrusted;
    this.cachedClassifier = null;
    this.cachedKey = null;
    this.leases = new Map();
    this.taints = new Map();
    this.stats = { decisions: 0, by_source: {}, by_class: {}, gate_calls: 0, gate_failures: 0, pending_reviews: 0, receipt_write_failures: 0, tainted_workspaces: 0 };
  }

  classifierFor(policy) {
    const key = `${policy.source}:${policy.version}:${policy.freshness}`;
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

  // Hash of the complete tool input (not the truncated summary), the tool name, the harness and
  // the working directory. A server verdict and any lease are bound to exactly this.
  actionHash(event) {
    const material = stableStringify({ harness: event.harness, tool: event.tool_name || '', input: event.tool_input || {}, cwd: event.cwd || null });
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

  // Marks a working directory whose code now contains something a test or build run would
  // execute; routine runner commands there go to the server gate for 24 h.
  noteWrite(event, classification) {
    if (!event.cwd || classification.class === 'risky') return;
    const kind = classification.tool && classification.tool.kind;
    if (kind !== 'edit' && !(kind === 'shell' && classification.paths.length > 0)) return;
    if (!RISKY_CODE.test(editedText(event))) return;
    // Taint the session's working directory and the directory of every file written, so a test
    // run started later from wherever that code lives also goes to the gate.
    const input = event.tool_input || {};
    const roots = new Set([path.normalize(event.cwd)]);
    for (const key of ['file_path', 'notebook_path', 'path']) {
      if (typeof input[key] === 'string') roots.add(path.dirname(path.resolve(event.cwd, input[key])));
    }
    for (const root of roots) {
      if (this.taints.size >= MAX_TAINTS) this.taints.delete(this.taints.keys().next().value);
      if (!this.taints.has(root)) this.stats.tainted_workspaces += 1;
      this.taints.set(root, this.now() + TAINT_TTL_MS);
    }
  }

  isTainted(cwd) {
    if (!cwd) return false;
    let dir = path.normalize(cwd);
    for (let level = 0; level < 32; level += 1) {
      const until = this.taints.get(dir);
      if (until && until > this.now()) return true;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    for (const [root, until] of this.taints) if (until > this.now() && root.startsWith(`${path.normalize(cwd)}/`)) return true;
    return false;
  }

  record(receipt) {
    if (!this.queue) return;
    try {
      if (this.queue.append(receipt, 'high') === null) this.stats.receipt_write_failures += 1;
    } catch {
      // A receipt that cannot be written never changes the decision; the queue counts the drop.
      this.stats.receipt_write_failures += 1;
    }
  }

  async decide(event) {
    const started = this.now();
    const policy = this.policyStore.current();
    const classification = this.classifierFor(policy).classify(event);
    if (classification.class === 'routine' && this.isTainted(event.cwd) && classification.programs.some((p) => CODE_RUNNERS.has(p))) {
      classification.class = 'unknown';
      classification.reasons = [...classification.reasons, 'runs_agent_written_code'];
    }
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
      if (decision.decision === 'allow') this.noteWrite(event, classification);
      this.record(receipt);
      return { ...result, receipt };
    };

    if (level === 'off') return finish({ decision: 'allow' }, 'owner_control_off');
    if (classification.class === 'routine') return finish({ decision: 'allow' }, 'local_policy');

    const actionHash = this.actionHash(event);
    receipt.action_hash = actionHash;
    const leaseKey = this.leaseKey(event, actionHash);
    const lease = classification.truncated ? null : this.getLease(leaseKey);
    if (lease) return finish({ decision: 'allow' }, 'server_lease', { gate: { receipt_id: lease.receiptId, lease_expires_at: new Date(lease.expiresAt).toISOString() } });

    const requestId = `gtr_${crypto.randomUUID()}`;
    const action = {
      tool_kind: receipt.tool_kind,
      tool_name: receipt.tool_name,
      commands: classification.commands.map((command) => redactText(command, 1000)),
      argv: classification.commands.length ? redactArgv(classification.commands[0].split(' ')) : [],
      paths: classification.paths,
      hosts: classification.hosts,
      programs: classification.programs,
      local_class: classification.class,
      local_reasons: classification.reasons,
      truncated: classification.truncated,
    };

    if (level === 'observe') {
      this.record({ type: 'observed_action', ts: receipt.ts, harness: event.harness, agent_id: receipt.agent_id, session_id: event.session_id, request_id: requestId, action_hash: actionHash, action });
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
      const outageAllowed = classification.class === 'unknown'
        && (policy.tables.outage || {}).unknown === 'allow'
        && AVAILABILITY_FAILURES.has(failure.class);
      const gate = { request_id: requestId, error_class: failure.class, error_code: failure.code, latency_ms: response.latencyMs || null };
      if (outageAllowed) {
        return finish({ decision: 'allow', notice: 'Marrow server gate unavailable; this non-risky action was allowed under the owner outage policy and recorded.' }, 'outage_bypass', { gate });
      }
      const why = failure.class === 'config'
        ? (failure.code === 'credential_missing' ? 'Marrow has no API key on this machine (owner: rerun the Marrow installer).' : 'the Marrow API address is not an allowed origin.')
        : failure.class === 'unverified_verdict' ? 'the Marrow server answer could not be verified.'
          : `the Marrow server gate did not answer (${failure.class}).`;
      return finish({
        decision: 'deny',
        reason: `Marrow blocked this ${classification.class === 'risky' ? 'risky' : 'unrecognized'} action because ${why} It stays blocked until the gate answers; routine work continues normally.`,
      }, 'gate_unavailable_fail_closed', { gate });
    }

    const gate = { request_id: requestId, receipt_id: verdict.receipt_id || null, decision_id: verdict.decision_id || null, verdict: verdict.verdict, latency_ms: response.latencyMs || null };
    if (verdict.verdict === 'allow') {
      const leaseMs = classification.truncated ? 0 : Math.min(Number(verdict.lease_ms) || 0, MAX_LEASE_MS);
      if (leaseMs > 0) this.setLease(leaseKey, { receiptId: verdict.receipt_id, expiresAt: this.now() + leaseMs });
      return finish({ decision: 'allow', notice: verdict.notice ? redactText(verdict.notice, 300) : null }, 'server_gate', { gate });
    }
    if (verdict.verdict === 'review_required') {
      this.stats.pending_reviews += 1;
      const link = typeof verdict.approval_url === 'string' && /^https:\/\//.test(verdict.approval_url) ? ` Approve: ${verdict.approval_url.slice(0, 200)}` : '';
      // The in-harness prompt is only offered when the server says the person at this terminal
      // may approve (for example the account owner's own machine). Otherwise it is a deny with the
      // dashboard link, so an owner-approval requirement cannot be satisfied locally.
      const decision = verdict.harness_prompt_allowed === true ? 'ask' : 'deny';
      return finish({
        decision,
        reason: `Marrow: owner approval required. ${redactText(verdict.reason || 'This action needs owner review.', 240)}${link} After approval, retry the same action.`,
      }, 'server_gate', { gate: { ...gate, harness_prompt_allowed: decision === 'ask' } });
    }
    return finish({ decision: 'deny', reason: `Marrow blocked this action. ${redactText(verdict.reason || '', 300)}`.trim() }, 'server_gate', { gate });
  }

  // With pinned keys a signed envelope is mandatory. Without keys (phase 1 production before the
  // backend publishes its key) only a TLS response from the pinned production origin is trusted,
  // and only when the process TLS trust store has not been altered.
  verifyGateResponse(json, expected) {
    if (!json || typeof json !== 'object') return { ok: false, error: 'empty_response' };
    if (Object.keys(this.trustedKeys).length > 0) return verifyVerdict(json.envelope, this.trustedKeys, expected);
    if (this.api.baseUrl !== PRODUCTION_BASE_URL) return { ok: false, error: 'unsigned_verdict_from_non_production_origin' };
    if (!this.tlsTrusted()) return { ok: false, error: 'unsigned_verdict_with_altered_tls_trust' };
    const verdict = json.verdict && typeof json.verdict === 'object' ? json.verdict : null;
    if (!verdict || verdict.request_id !== expected.requestId || verdict.action_hash !== expected.actionHash) return { ok: false, error: 'verdict_binding_mismatch' };
    if (!['allow', 'deny', 'review_required'].includes(verdict.verdict)) return { ok: false, error: 'bad_verdict' };
    return { ok: true, verdict };
  }
}

module.exports = { DecisionEngine, stableStringify, RISKY_CODE };

'use strict';

// marrow-agentd: the per-user local Marrow process. Supervised by systemd --user (launchd /
// Windows service in the design), installed and updated only by the installer.

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { ADAPTERS, renderUnreadable } = require('./adapters');
const { ApiClient } = require('./api-client');
const { createClassifier } = require('./classifier');
const {
  AGENTD_VERSION, CONTROL_LEVELS, DEFAULTS, DEFAULT_ALLOWED_BASE_URLS, HARNESS_HOOK_TIMEOUT_MS, PRODUCTION_BASE_URL, TRUSTED_POLICY_KEYS,
} = require('./constants');
const { CredentialStore } = require('./credentials');
const { ensurePrivateDir, readPrivateFile } = require('./fsutil');
const { DecisionEngine } = require('./gate');
const { checkIntegrity } = require('./integrity');
const { agentdPaths } = require('./paths');
const { PolicyStore } = require('./policy');
const { encodeResponse, RequestReader } = require('./protocol');
const { TelemetryQueue } = require('./queue');
const { redactText } = require('./redact');
const { TelemetryUploader } = require('./telemetry');

const CONFIG_SCHEMA = 'marrow.agentd.config.v1';
const BYPASS_PASS_LIMIT = 5000;

function defaultConfig() {
  return { schema: CONFIG_SCHEMA, install_id: null, base_url: PRODUCTION_BASE_URL, agents: {}, hook_timeouts_ms: { ...HARNESS_HOOK_TIMEOUT_MS }, hooks: [], shim: null };
}

function loadConfig(file) {
  let raw;
  try {
    raw = readPrivateFile(file, 256 * 1024);
  } catch (error) {
    return { config: defaultConfig(), digest: null, error: error.code === 'ENOENT' ? 'config_missing' : `config_unsafe:${error.reason || error.code}` };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return { config: defaultConfig(), digest: null, error: 'config_invalid_json' }; }
  if (!parsed || parsed.schema !== CONFIG_SCHEMA) return { config: defaultConfig(), digest: null, error: 'config_wrong_schema' };
  const digest = crypto.createHash('sha256').update(raw).digest('hex');
  return { config: { ...defaultConfig(), ...parsed }, digest, error: null };
}

function checkPeer(pid) {
  if (process.platform !== 'linux') return { ok: true, method: 'socket_dir_permissions' };
  try {
    const stat = fs.statSync(`/proc/${pid}`);
    const uid = typeof process.getuid === 'function' ? process.getuid() : stat.uid;
    if (stat.uid !== uid) return { ok: false, reason: 'peer_uid_mismatch' };
    return { ok: true, method: 'socket_dir_permissions+proc_uid' };
  } catch {
    return { ok: false, reason: 'peer_unknown' };
  }
}

function createDaemon(options = {}) {
  const home = options.home || os.homedir();
  const paths = agentdPaths(home);
  const socketPath = options.socketPath || paths.socket;
  const now = options.now || (() => Date.now());
  const trustedKeys = options.trustedKeys || TRUSTED_POLICY_KEYS;
  const pinnedOrigins = options.allowedBaseUrls || DEFAULT_ALLOWED_BASE_URLS;
  const settings = { ...DEFAULTS, ...(options.settings || {}) };
  const timers = [];
  const state = {
    startedAt: null,
    config: null,
    configDigest: null,
    configError: null,
    integrity: { ok: true, violations: [] },
    integrityKey: '[]',
    pendingControl: null,
    fastPolicyUntil: 0,
    lastPolicyFetch: null,
    connections: 0,
    connectionsTotal: 0,
    peerRejections: 0,
    protocolErrors: 0,
    fallbackIngested: 0,
  };
  let server = null;
  let credentials;
  let policyStore;
  let queue;
  let api;
  let engine;
  let uploader;
  let policyRefreshing = null;

  function runIntegrity() {
    const result = checkIntegrity({ root: paths.root, configPath: paths.config, startConfig: state.config, configDigest: state.configDigest, api, home });
    if (state.configError) result.violations.unshift({ code: state.configError });
    result.ok = result.violations.length === 0;
    const key = JSON.stringify(result.violations);
    if (key !== state.integrityKey) {
      state.integrityKey = key;
      if (queue) queue.append({ type: 'agentd_integrity', ts: new Date(now()).toISOString(), ok: result.ok, violations: result.violations, owner_visible: true }, 'high');
    }
    state.integrity = result;
    return result;
  }

  function ingestBypassRecords() {
    let names;
    try { names = fs.readdirSync(paths.bypassDir); } catch { return 0; }
    let count = 0;
    for (const name of names.slice(0, BYPASS_PASS_LIMIT)) {
      const file = path.join(paths.bypassDir, name);
      if (name === 'overflow.count') {
        try {
          const lost = fs.statSync(file).size;
          fs.unlinkSync(file);
          queue.recordDrop('fallback_overflow', 'high', lost);
        } catch { /* raced */ }
        continue;
      }
      if (!/^fb-[0-9]+-[a-f0-9]{16}\.json$/.test(name)) continue;
      try {
        const record = JSON.parse(readPrivateFile(file, 8192));
        fs.unlinkSync(file);
        queue.append({ ...record, type: 'fallback_decision', ingested_at: new Date(now()).toISOString() }, 'high');
        count += 1;
      } catch {
        try { fs.unlinkSync(file); } catch { /* raced */ }
        queue.recordDrop('fallback_corrupt', 'high', 1);
      }
    }
    state.fallbackIngested += count;
    return count;
  }

  async function refreshPolicy() {
    if (policyRefreshing) return policyRefreshing;
    policyRefreshing = (async () => {
      const have = policyStore.active ? policyStore.active.version : 0;
      const response = await api.request('GET', `/v1/agent/policy/bundle?have=${have}`, { budgetMs: 5000 });
      state.lastPolicyFetch = { at: new Date(now()).toISOString(), status: response.status || null, error: response.ok ? null : response.error };
      if (!response.ok || response.status === 304 || !response.json || !response.json.envelope) return { accepted: false, reason: response.ok ? 'no_update' : 'fetch_failed' };
      const before = policyStore.current();
      const result = policyStore.accept(response.json.envelope);
      if (result.accepted) {
        const after = policyStore.current();
        api.allowOrigins(after.allowedBaseUrls);
        queue.append({ type: 'policy_applied', ts: new Date(now()).toISOString(), version: after.version, control_level: after.control.level }, 'high');
        if (after.control.level !== before.control.level) {
          queue.append({ type: 'control_level_changed', ts: new Date(now()).toISOString(), from: before.control.level, to: after.control.level, approval_receipt_id: after.control.approval_receipt_id, authority: 'owner_signed_policy' }, 'high');
          if (state.pendingControl && state.pendingControl.requested_level === after.control.level) state.pendingControl = null;
        }
      } else if (result.reason !== 'unchanged') {
        queue.append({ type: 'policy_rejected', ts: new Date(now()).toISOString(), reason: result.reason }, 'high');
      }
      return result;
    })().finally(() => { policyRefreshing = null; });
    return policyRefreshing;
  }

  function status() {
    const policy = policyStore.current();
    return {
      ok: true,
      version: AGENTD_VERSION,
      pid: process.pid,
      uptime_s: state.startedAt ? Math.round((now() - state.startedAt) / 1000) : 0,
      install_id: state.config ? state.config.install_id : null,
      control: {
        level: policy.control.level,
        authority: policy.source === 'signed_policy' ? 'owner_signed_policy' : 'builtin_default',
        approval_receipt_id: policy.control.approval_receipt_id,
        pending_request: state.pendingControl,
      },
      policy: { source: policy.source, version: policy.version, freshness: policy.freshness, expires_at: policy.expiresAt, last_fetch: state.lastPolicyFetch, last_error: policy.lastError },
      credential: credentials.status(),
      api: { base_url: api.baseUrl, base_url_rejected: Boolean(api.rejectedBaseUrl), requests: api.stats.requests, by_route: api.stats.by_route, failures: api.stats.failures },
      integrity: state.integrity,
      queue: queue.stats(),
      uploader: uploader.status(),
      decisions: engine.stats,
      connections: { active: state.connections, total: state.connectionsTotal, peer_rejections: state.peerRejections, protocol_errors: state.protocolErrors },
      fallback_ingested: state.fallbackIngested,
      // Honest capability statement (verify-claims principle): what this process can and cannot
      // guarantee on this host.
      capabilities: {
        pre_action_control: 'native hooks call this daemon; coverage depends on the host running its hooks (client-observed, not certified)',
        risky_when_server_unavailable: 'fail_closed',
        routine_when_daemon_down: 'allowed by the shim fallback with a recorded bypass',
        control_changes: 'owner-signed server policy only; local commands only file a request',
        tamper_resistance: 'same-user edits are detected and reported, not prevented (hardened mode: separate service user)',
        peer_check: process.platform === 'linux' ? 'socket in 0700 dir + /proc uid match of the claimed pid' : 'socket dir permissions',
      },
    };
  }

  async function handleAdmin(op, payload) {
    if (op === 'status') return { exit: 0, stdout: JSON.stringify(status()) };
    if (op === 'flush') {
      await uploader.flush({ force: true });
      return { exit: 0, stdout: JSON.stringify({ ok: true, queue: queue.stats(), uploader: uploader.status() }) };
    }
    if (op === 'refresh-policy') {
      const result = await refreshPolicy();
      return { exit: 0, stdout: JSON.stringify({ ok: true, result, policy: status().policy, control: status().control }) };
    }
    if (op === 'integrity') return { exit: 0, stdout: JSON.stringify(runIntegrity()) };
    if (op === 'control-request') {
      const level = payload && payload.level;
      if (!CONTROL_LEVELS.includes(level)) return { exit: 2, stdout: JSON.stringify({ ok: false, changed_locally: false, error: 'level must be enforce, observe or off' }) };
      const current = policyStore.current();
      const response = await api.request('POST', '/v1/agent/control/requests', {
        budgetMs: 5000,
        idempotencyKey: `ctlreq_${crypto.randomUUID()}`,
        body: {
          contract: 'marrow.control-request.v1',
          install_id: state.config.install_id,
          requested_level: level,
          current_level: current.control.level,
          policy_version: current.version,
          reason: redactText(payload.reason || '', 200),
          requested_by: 'local_cli',
        },
      });
      queue.append({ type: 'control_change_requested', ts: new Date(now()).toISOString(), requested_level: level, delivered: response.ok }, 'high');
      if (!response.ok) {
        return { exit: 1, stdout: JSON.stringify({ ok: false, changed_locally: false, error: response.error, message: 'The request could not reach Marrow. Nothing changed; control stays at its current level.' }) };
      }
      const json = response.json || {};
      state.pendingControl = { request_id: json.request_id || null, requested_level: level, status: json.status || 'pending_owner_approval', approval_url: typeof json.approval_url === 'string' ? json.approval_url.slice(0, 300) : null, requested_at: new Date(now()).toISOString() };
      state.fastPolicyUntil = now() + 10 * 60 * 1000;
      return {
        exit: 0,
        stdout: JSON.stringify({
          ok: true,
          changed_locally: false,
          pending_owner_approval: true,
          ...state.pendingControl,
          message: 'Nothing changed locally. The owner must approve this in the Marrow dashboard; the daemon applies it only from a signed policy.',
        }),
      };
    }
    return { exit: 2, stdout: JSON.stringify({ ok: false, error: 'unknown admin operation' }) };
  }

  function observe(event) {
    if (event.kind === 'post') uploader.observe(`post|${event.harness}|${String(event.tool_name || 'unknown').toLowerCase().slice(0, 48)}|${event.success === false ? 'failed' : 'ok'}`);
    else if (event.kind === 'prompt') uploader.observe(`prompt|${event.harness}`);
    else if (event.kind === 'stop') uploader.observe(`stop|${event.harness}`);
    else if (event.kind === 'session_end') {
      queue.append({ type: 'session_end', ts: new Date(now()).toISOString(), harness: event.harness, agent_id: engine.agentId(event.harness), session_id: event.session_id }, 'normal');
    } else uploader.observe(`other|${event.harness}|${String(event.hook_event_name || '').slice(0, 32)}`);
  }

  async function decidePre(adapter, event) {
    try {
      const decision = await engine.decide(event);
      return adapter.render(event, decision);
    } catch {
      // An internal error must not block routine work or allow risky work.
      let routine = false;
      try { routine = createClassifier(policyStore.current().tables, { home }).classify(event).class === 'routine'; } catch { routine = false; }
      return adapter.render(event, routine ? { decision: 'allow' } : { decision: 'deny', reason: 'Marrow hit a local error and blocked this non-routine action. Retry; if it persists, run marrow-agentd doctor.' });
    }
  }

  async function processRequest(reader) {
    if (!reader.header) { state.protocolErrors += 1; return { exit: 2, stderr: 'Marrow hook protocol error.\n' }; }
    const { harness, event: eventArg, pid } = reader.header;
    const peer = checkPeer(pid);
    const adapter = ADAPTERS[harness];
    if (!peer.ok) {
      state.peerRejections += 1;
      if (adapter) return renderUnreadable(adapter, eventArg, 'Marrow rejected a hook call from an unverified local process.');
      return { exit: 2, stderr: 'Marrow rejected an unverified local caller.\n' };
    }
    if (harness === '_admin') {
      let payload = {};
      try { payload = reader.size ? JSON.parse(reader.body().toString('utf8')) : {}; } catch { payload = {}; }
      return handleAdmin(eventArg, payload);
    }
    if (!adapter) { state.protocolErrors += 1; return { exit: 2, stderr: `Marrow does not support harness ${harness} in this version.\n` }; }
    if (reader.overflow) return renderUnreadable(adapter, eventArg, 'Marrow could not classify this action: hook input is larger than 16 MiB.');
    let payload = {};
    if (reader.size > 0) {
      try { payload = JSON.parse(reader.body().toString('utf8')); } catch { return renderUnreadable(adapter, eventArg, 'Marrow could not read the hook input, so it blocked this action.'); }
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return renderUnreadable(adapter, eventArg, 'Marrow could not read the hook input, so it blocked this action.');
    const event = adapter.normalize(eventArg, payload);
    if (event.kind === 'pre') return decidePre(adapter, event);
    observe(event);
    return adapter.render(event, { decision: 'allow' });
  }

  function handleConnection(socket) {
    state.connections += 1;
    state.connectionsTotal += 1;
    const reader = new RequestReader();
    let done = false;
    const respond = (output) => {
      if (done) return;
      done = true;
      socket.end(encodeResponse(output));
    };
    socket.setTimeout(settings.connectionIdleMs, () => socket.destroy());
    socket.on('data', (chunk) => {
      reader.push(chunk);
      if (reader.invalid) { state.protocolErrors += 1; respond({ exit: 2, stderr: 'Marrow hook protocol error.\n' }); }
    });
    socket.on('end', () => {
      if (done) return;
      processRequest(reader).then(respond, () => respond({ exit: 2, stderr: 'Marrow internal error.\n' }));
    });
    socket.on('error', () => { /* peer went away */ });
    socket.on('close', () => { state.connections -= 1; });
  }

  async function listen() {
    if (Number.isInteger(options.listenFd)) {
      await new Promise((resolve, reject) => server.listen({ fd: options.listenFd }, resolve).once('error', reject));
      return;
    }
    if (Buffer.byteLength(socketPath) > 104) throw new Error('socket_path_too_long');
    let existing = null;
    try { existing = fs.lstatSync(socketPath); } catch { existing = null; }
    if (existing) {
      if (!existing.isSocket()) throw new Error('socket_path_occupied_by_non_socket');
      const alive = await new Promise((resolve) => {
        const probe = net.connect({ path: socketPath });
        probe.once('connect', () => { probe.destroy(); resolve(true); });
        probe.once('error', () => resolve(false));
      });
      if (alive) throw new Error('already_running');
      fs.unlinkSync(socketPath);
    }
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.off('error', reject); resolve(); });
    });
    fs.chmodSync(socketPath, 0o600);
  }

  async function start() {
    ensurePrivateDir(paths.root);
    ensurePrivateDir(path.dirname(socketPath));
    ensurePrivateDir(paths.bypassDir);
    const loaded = loadConfig(paths.config);
    state.config = loaded.config;
    state.configDigest = loaded.digest;
    state.configError = loaded.error;
    credentials = new CredentialStore({ home });
    credentials.refresh();
    policyStore = new PolicyStore({ dir: paths.policyDir, trustedKeys, now, staleGraceMs: settings.policyStaleGraceMs });
    policyStore.load();
    queue = new TelemetryQueue({ dir: paths.queueDir, segmentMaxRecords: settings.segmentMaxRecords, laneMaxSegments: settings.laneMaxSegments }).open();
    const installId = state.config.install_id || 'inst_unregistered';
    api = new ApiClient({
      baseUrl: state.config.base_url,
      allowedBaseUrls: [...pinnedOrigins, ...policyStore.current().allowedBaseUrls],
      credentials,
      fetchImpl: options.fetchImpl,
      installId,
    });
    // A config base URL outside the pinned origins is refused; the first pinned origin (the
    // production API) stays in use and the refusal is reported as an integrity violation.
    if (!api.baseUrl) api.setBaseUrl(pinnedOrigins[0]);
    engine = new DecisionEngine({
      policyStore, api, queue, config: state.config, trustedKeys, home, now,
      protectedPids: [process.pid],
      integrity: () => state.integrity,
      gateBudgetCapMs: settings.gateBudgetCapMs,
      gateBudgetMarginMs: settings.gateBudgetMarginMs,
    });
    uploader = new TelemetryUploader({
      queue, api, installId, now,
      batchMax: settings.batchMaxEvents,
      flushIntervalMs: settings.flushIntervalMs,
      backoffMinMs: settings.backoffMinMs,
      backoffMaxMs: settings.backoffMaxMs,
      onServerHints: (hints) => {
        if (Number.isInteger(hints.policy_version) && hints.policy_version > policyStore.current().version) refreshPolicy().catch(() => {});
      },
    });
    runIntegrity();
    ingestBypassRecords();
    server = net.createServer({ allowHalfOpen: true }, handleConnection);
    server.maxConnections = settings.maxConnections;
    await listen();
    state.startedAt = now();
    queue.append({ type: 'agentd_started', ts: new Date(now()).toISOString(), version: AGENTD_VERSION, policy_version: policyStore.current().version, control_level: policyStore.current().control.level, integrity_ok: state.integrity.ok }, 'normal');
    uploader.start();
    const every = (ms, fn) => { const timer = setInterval(() => { try { const r = fn(); if (r && r.catch) r.catch(() => {}); } catch { /* keep running */ } }, ms); timer.unref(); timers.push(timer); };
    let lastPolicyPoll = 0;
    every(Math.min(settings.policyRefreshFastMs, settings.policyRefreshMs), () => {
      const interval = now() < state.fastPolicyUntil ? settings.policyRefreshFastMs : settings.policyRefreshMs;
      if (now() - lastPolicyPoll < interval) return null;
      lastPolicyPoll = now();
      return refreshPolicy();
    });
    every(settings.integrityCheckMs, () => { runIntegrity(); ingestBypassRecords(); });
    every(settings.heartbeatMs, () => queue.append({ type: 'agentd_heartbeat', ts: new Date(now()).toISOString(), version: AGENTD_VERSION, uptime_s: Math.round((now() - state.startedAt) / 1000), policy_version: policyStore.current().version, control_level: policyStore.current().control.level, integrity_ok: state.integrity.ok, queue_pending: queue.stats().pending, drops_total: queue.stats().drops.total }, 'normal'));
    every(60 * 1000, () => {
      const result = credentials.refresh();
      if (result.changed) queue.append({ type: 'credential_changed', ts: new Date(now()).toISOString(), owner_visible: true }, 'high');
    });
    every(1000, () => queue.flushState());
    if (options.initialPolicyRefresh !== false) refreshPolicy().catch(() => {});
    return { socketPath };
  }

  async function stop() {
    for (const timer of timers.splice(0)) clearInterval(timer);
    if (uploader) uploader.stop();
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    if (queue) queue.flushState();
    try { if (!Number.isInteger(options.listenFd)) fs.unlinkSync(socketPath); } catch { /* already gone */ }
  }

  return {
    start,
    stop,
    status: () => status(),
    refreshPolicy: () => refreshPolicy(),
    flush: () => uploader.flush({ force: true }),
    integrity: () => runIntegrity(),
    get queue() { return queue; },
    get engine() { return engine; },
    get api() { return api; },
    get uploader() { return uploader; },
    paths,
    socketPath,
  };
}

module.exports = { createDaemon, loadConfig, CONFIG_SCHEMA };

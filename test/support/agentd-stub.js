'use strict';

// Loopback stub of the Marrow API endpoints marrow-agentd uses. It signs policy bundles and gate
// verdicts with an Ed25519 key generated at runtime, checks the Authorization header against a
// dummy key the test generates at runtime, and records request metadata (never header values).

const crypto = require('node:crypto');
const http = require('node:http');
const zlib = require('node:zlib');
const { signEnvelope } = require('../../src/agentd/policy');

function createStub({ name = 'stub' } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const kid = `test-${name}-${crypto.randomBytes(4).toString('hex')}`;
  const state = {
    expectedAuthorization: null,
    policies: [],
    gateMode: 'normal',
    telemetryMode: 'ok',
    policyMode: 'ok',
    gateHandler: () => ({ verdict: 'allow' }),
    gateDelayMs: 0,
    requests: [],
    gateBodies: [],
    batches: [],
    events: [],
    controlRequests: new Map(),
    authFailures: 0,
    otherKey: crypto.generateKeyPairSync('ed25519').privateKey,
  };
  const sockets = new Set();

  function publishPolicy({ control = { level: 'enforce' }, classifier, expiresInMs = 60 * 60 * 1000, issuedAt = Date.now(), outage, allowedBaseUrls, signWith } = {}) {
    const version = (state.policies.length ? state.policies[state.policies.length - 1].version : 0) + 1;
    const payload = {
      schema: 'marrow.policy.v1',
      version,
      account_id: 'acct_test',
      issued_at: new Date(issuedAt).toISOString(),
      expires_at: new Date(issuedAt + expiresInMs).toISOString(),
      control,
      ...(classifier ? { classifier } : {}),
      ...(outage ? { outage } : {}),
      ...(allowedBaseUrls ? { allowed_base_urls: allowedBaseUrls } : {}),
    };
    const envelope = signEnvelope(payload, signWith || privateKey, kid);
    state.policies.push({ version, payload, envelope });
    return { version, envelope, payload };
  }

  function send(res, status, body, headers = {}) {
    const text = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(text);
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const url = new URL(req.url, 'http://127.0.0.1');
      const record = { method: req.method, route: url.pathname, at: Date.now() };
      state.requests.push(record);
      if (req.headers.authorization !== state.expectedAuthorization) {
        state.authFailures += 1;
        record.status = 401;
        send(res, 401, { error: { code: 'unauthorized' } });
        return;
      }
      let raw = Buffer.concat(chunks);
      if (req.headers['content-encoding'] === 'gzip') {
        try { raw = zlib.gunzipSync(raw); } catch { record.status = 400; send(res, 400, { error: { code: 'bad_gzip' } }); return; }
        record.gzip = true;
      }
      let body = null;
      if (raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { body = null; } }

      if (req.method === 'GET' && url.pathname === '/v1/agent/policy/bundle') {
        if (state.policyMode === '503') { record.status = 503; send(res, 503, { error: { code: 'unavailable' } }); return; }
        const have = Number(url.searchParams.get('have') || 0);
        const latest = state.policies[state.policies.length - 1];
        if (!latest || latest.version <= have) { record.status = 304; res.writeHead(304); res.end(); return; }
        record.status = 200;
        send(res, 200, { envelope: latest.envelope });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/agent/gate') {
        state.gateBodies.push(body);
        if (state.gateDelayMs) await new Promise((resolve) => setTimeout(resolve, state.gateDelayMs));
        if (state.gateMode === 'hang') return; // never answers; the daemon's budget must expire
        if (state.gateMode === '500') { record.status = 500; send(res, 500, { error: 'Internal server error' }); return; }
        if (state.gateMode === '503') { record.status = 503; send(res, 503, { error: { code: 'MARROW_RUNTIME_STATUS_UNAVAILABLE' } }, { 'retry-after': '1' }); return; }
        const decided = state.gateHandler(body) || { verdict: 'allow' };
        const verdict = {
          schema: 'marrow.gate.v1',
          request_id: body.request_id,
          action_hash: decided.tamperActionHash ? 'f'.repeat(64) : body.action_hash,
          verdict: decided.verdict,
          reason: decided.reason || null,
          receipt_id: `rcpt_${crypto.randomBytes(8).toString('hex')}`,
          decision_id: `dec_${crypto.randomBytes(8).toString('hex')}`,
          lease_ms: decided.lease_ms || 0,
          approval_url: decided.approval_url || null,
          ...(decided.harness_prompt_allowed ? { harness_prompt_allowed: true } : {}),
          issued_at: new Date().toISOString(),
        };
        const signer = state.gateMode === 'badsig' ? state.otherKey : privateKey;
        record.status = 200;
        send(res, 200, { envelope: signEnvelope(verdict, signer, kid) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/agent/telemetry/batch') {
        if (state.telemetryMode === '503') { record.status = 503; send(res, 503, { error: { code: 'unavailable' } }, { 'retry-after': '0' }); return; }
        if (state.telemetryMode === '429') { record.status = 429; send(res, 429, { error: { code: 'rate_limited' } }); return; }
        if (state.telemetryMode === '400') { record.status = 400; send(res, 400, { error: { code: 'bad_batch' } }); return; }
        if (!body || !Array.isArray(body.events)) { record.status = 400; send(res, 400, { error: { code: 'bad_batch' } }); return; }
        state.batches.push({ batch_id: body.batch_id, count: body.events.length, drops: body.drops, gzip: Boolean(record.gzip) });
        state.events.push(...body.events);
        record.status = 200;
        const latest = state.policies[state.policies.length - 1];
        send(res, 200, { accepted: body.events.length, rejected: [], policy_version: latest ? latest.version : 0 });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/v1/agent/control/requests') {
        const id = `ctlreq_${crypto.randomBytes(8).toString('hex')}`;
        state.controlRequests.set(id, { id, requested_level: body && body.requested_level, status: 'pending_owner_approval' });
        record.status = 201;
        send(res, 201, { request_id: id, status: 'pending_owner_approval', approval_url: `https://getmarrow.ai/account/approvals/${id}` });
        return;
      }
      record.status = 404;
      send(res, 404, { error: { code: 'not_found' } });
    });
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });

  return {
    kid,
    publicKey,
    state,
    publishPolicy,
    // Simulates the owner approving in the dashboard: the server then signs a policy with the
    // requested level and an owner approval receipt. An agent has no path to this.
    approveControlRequest(id) {
      const request = state.controlRequests.get(id);
      if (!request) throw new Error('unknown control request');
      request.status = 'approved';
      return publishPolicy({ control: { level: request.requested_level, approval_receipt_id: `oar_${crypto.randomBytes(8).toString('hex')}`, changed_at: new Date().toISOString() } });
    },
    expectKey(key) { state.expectedAuthorization = `Bearer ${key}`; },
    count(route) { return state.requests.filter((r) => r.route === route).length; },
    async start() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      this.url = `http://127.0.0.1:${server.address().port}`;
      return this.url;
    },
    async stop() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

module.exports = { createStub };

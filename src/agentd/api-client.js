'use strict';

// HTTP client for the Marrow API. The base URL is pinned: it must be one of the allowed origins
// (the production API, plus origins an owner-signed policy adds). Nothing in the hook's or the
// daemon's environment can change it. Failures are classified precisely so callers never treat
// a 5xx as "offline, allow" (R-45).

const zlib = require('node:zlib');
const { AGENTD_VERSION } = require('./constants');
const { isAllowedOrigin } = require('./policy');

function normalizeOrigin(url) {
  const parsed = new URL(url);
  return `${parsed.protocol}//${parsed.host}`;
}

class ApiClient {
  constructor({ baseUrl, allowedBaseUrls, credentials, fetchImpl = globalThis.fetch, installId = null }) {
    this.credentials = credentials;
    this.fetchImpl = fetchImpl;
    this.installId = installId;
    this.allowed = new Set((allowedBaseUrls || []).filter(isAllowedOrigin).map(normalizeOrigin));
    this.baseUrl = null;
    this.rejectedBaseUrl = null;
    this.setBaseUrl(baseUrl);
    this.stats = { requests: 0, by_route: {}, failures: 0 };
  }

  // Returns true if accepted. A rejected URL leaves the previous (last known good) one in place.
  setBaseUrl(url) {
    let origin = null;
    try { origin = normalizeOrigin(url); } catch { origin = null; }
    if (!origin || !this.allowed.has(origin) || !isAllowedOrigin(origin)) {
      this.rejectedBaseUrl = typeof url === 'string' ? url.slice(0, 200) : String(url);
      return false;
    }
    this.baseUrl = origin;
    return true;
  }

  allowOrigins(origins) {
    for (const origin of origins || []) if (isAllowedOrigin(origin)) this.allowed.add(normalizeOrigin(origin));
  }

  async request(method, route, { body, gzip = false, budgetMs = 5000, idempotencyKey, headers = {} } = {}) {
    if (!this.baseUrl) return { ok: false, error: { class: 'config', code: 'base_url_not_allowed' } };
    const authorization = this.credentials.authorizationHeader();
    if (!authorization) return { ok: false, error: { class: 'config', code: 'credential_missing' } };
    const requestHeaders = {
      authorization,
      accept: 'application/json',
      'user-agent': `marrow-agentd/${AGENTD_VERSION}`,
      'x-marrow-package': '@getmarrow/install',
      'x-marrow-client': 'marrow-agentd',
      ...headers,
    };
    if (this.installId) requestHeaders['x-marrow-install-id'] = this.installId;
    if (idempotencyKey) requestHeaders['idempotency-key'] = idempotencyKey;
    let payload;
    if (body !== undefined) {
      const json = Buffer.from(JSON.stringify(body), 'utf8');
      requestHeaders['content-type'] = 'application/json';
      if (gzip) {
        payload = zlib.gzipSync(json);
        requestHeaders['content-encoding'] = 'gzip';
      } else payload = json;
    }
    this.stats.requests += 1;
    this.stats.by_route[route.split('?')[0]] = (this.stats.by_route[route.split('?')[0]] || 0) + 1;
    const started = Date.now();
    let response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${route}`, {
        method,
        headers: requestHeaders,
        body: payload,
        redirect: 'error',
        signal: AbortSignal.timeout(Math.max(50, budgetMs)),
      });
    } catch (error) {
      this.stats.failures += 1;
      const timeout = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      return { ok: false, latencyMs: Date.now() - started, error: { class: timeout ? 'timeout' : 'transport', code: timeout ? 'timeout' : 'transport_error' } };
    }
    let json = null;
    const text = await response.text().catch(() => '');
    if (text) { try { json = JSON.parse(text); } catch { json = null; } }
    const retryAfter = response.headers.get('retry-after');
    const retryAfterMs = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : null;
    if (response.status >= 200 && response.status < 300) return { ok: true, status: response.status, json, latencyMs: Date.now() - started };
    if (response.status === 304) return { ok: true, status: 304, json: null, latencyMs: Date.now() - started };
    this.stats.failures += 1;
    const errorClass = response.status === 429 ? 'rate_limited'
      : response.status === 401 || response.status === 403 ? 'auth'
        : response.status >= 500 ? 'server'
          : 'client';
    const code = json && json.error && typeof json.error.code === 'string' ? json.error.code.slice(0, 64)
      : json && json.details && typeof json.details.code === 'string' ? json.details.code.slice(0, 64) : `http_${response.status}`;
    return { ok: false, status: response.status, json, latencyMs: Date.now() - started, error: { class: errorClass, code, retryAfterMs } };
  }
}

module.exports = { ApiClient, normalizeOrigin };

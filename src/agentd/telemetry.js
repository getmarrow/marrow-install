'use strict';

// Batched, compressed telemetry upload with backpressure.
//
// - One gzip request carries up to `batchMax` events (default 500) plus the drop report.
// - Post-tool results and prompts are rolled up into counters, not sent one by one.
// - 429 / 5xx / transport errors back off exponentially with jitter and honour Retry-After;
//   nothing is acked until the server accepts it.
// - A 413 halves the batch size; a 400 for the whole batch or per-event rejections are counted
//   as drops (reason "rejected") and acked, so one poison event cannot wedge the queue (R-25).
// - 401/403 stops uploading and surfaces "auth_failed" in status; records stay queued.

const crypto = require('node:crypto');
const { AGENTD_VERSION, DEFAULTS } = require('./constants');

class Rollup {
  constructor(now) {
    this.now = now;
    this.reset();
  }

  reset() {
    this.windowStart = new Date(this.now()).toISOString();
    this.counts = {};
    this.events = 0;
  }

  add(key) {
    this.counts[key] = (this.counts[key] || 0) + 1;
    this.events += 1;
  }

  drain() {
    if (this.events === 0) return null;
    const event = { type: 'activity_rollup', window_start: this.windowStart, window_end: new Date(this.now()).toISOString(), counts: this.counts, events: this.events };
    this.reset();
    return event;
  }
}

class TelemetryUploader {
  constructor({ queue, api, installId, now = () => Date.now(), batchMax = DEFAULTS.batchMaxEvents, flushIntervalMs = DEFAULTS.flushIntervalMs, backoffMinMs = DEFAULTS.backoffMinMs, backoffMaxMs = DEFAULTS.backoffMaxMs, onServerHints = () => {}, random = Math.random }) {
    this.queue = queue;
    this.api = api;
    this.installId = installId;
    this.now = now;
    this.batchMax = batchMax;
    this.flushIntervalMs = flushIntervalMs;
    this.backoffMinMs = backoffMinMs;
    this.backoffMaxMs = backoffMaxMs;
    this.onServerHints = onServerHints;
    this.random = random;
    this.rollup = new Rollup(now);
    this.timer = null;
    this.inFlight = null;
    this.nextAttemptAt = 0;
    this.failures = 0;
    this.state = 'idle';
    this.lastSuccessAt = null;
    this.lastError = null;
    this.stats = { batches_sent: 0, events_sent: 0, requests: 0, rejected: 0 };
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.flush().catch(() => {}); }, this.flushIntervalMs);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  observe(key) {
    this.rollup.add(key);
  }

  // Flushes until the queue is empty or the server pushes back. Returns the last outcome.
  async flush({ force = false } = {}) {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.flushLoop(force).finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async flushLoop(force) {
    let outcome = 'idle';
    for (let round = 0; round < 64; round += 1) {
      if (!force && this.now() < this.nextAttemptAt) return 'backoff';
      const rolled = this.rollup.drain();
      if (rolled) this.queue.append(rolled, 'normal');
      const unreported = this.queue.unreportedDrops();
      const { records, cursor } = this.queue.peekBatch(this.batchMax);
      if (records.length === 0 && unreported === 0) { this.queue.flushState(); return outcome; }
      outcome = await this.sendBatch(records, cursor, unreported);
      if (outcome !== 'sent') return outcome;
      force = false;
      if (this.queue.stats().pending === 0 && this.queue.unreportedDrops() === 0) return outcome;
    }
    return outcome;
  }

  async sendBatch(records, cursor, unreported) {
    const dropsSnapshot = this.queue.stats().drops;
    const batchId = `tb_${crypto.createHash('sha256').update(`${this.installId}:${records.length ? records[0].event_id : 'drops'}:${records.length ? records[records.length - 1].event_id : dropsSnapshot.total}`).digest('hex').slice(0, 40)}`;
    const body = {
      contract: 'marrow.telemetry.v1',
      batch_id: batchId,
      sent_at: new Date(this.now()).toISOString(),
      agentd: { version: AGENTD_VERSION, install_id: this.installId },
      events: records,
      drops: unreported > 0 ? { total: dropsSnapshot.total, unreported, by_reason: dropsSnapshot.by_reason, by_lane: dropsSnapshot.by_lane } : null,
    };
    this.stats.requests += 1;
    this.state = 'sending';
    const response = await this.api.request('POST', '/v1/agent/telemetry/batch', { body, gzip: true, budgetMs: 10000, idempotencyKey: batchId });
    if (response.ok) {
      const rejected = response.json && Array.isArray(response.json.rejected) ? response.json.rejected.length : 0;
      if (rejected) { this.queue.recordDrop('rejected', 'high', rejected); this.stats.rejected += rejected; }
      this.queue.ack(cursor);
      if (unreported > 0) this.queue.markDropsReported(dropsSnapshot.total);
      this.queue.flushState();
      this.stats.batches_sent += 1;
      this.stats.events_sent += records.length - rejected;
      this.failures = 0;
      this.nextAttemptAt = 0;
      this.state = 'ok';
      this.lastSuccessAt = new Date(this.now()).toISOString();
      this.lastError = null;
      if (response.json) this.onServerHints(response.json);
      return 'sent';
    }
    const error = response.error || { class: 'unknown' };
    this.lastError = { class: error.class, code: error.code, at: new Date(this.now()).toISOString() };
    if (response.status === 413 && this.batchMax > 10) {
      this.queue.release();
      this.batchMax = Math.max(10, Math.floor(this.batchMax / 2));
      this.state = 'shrinking_batch';
      return 'retry';
    }
    if ((response.status === 400 || response.status === 422) && records.length > 0) {
      // The server refused the batch as malformed: count its records as rejected and ack them so
      // one bad record cannot wedge the queue (R-25). The drop report was NOT delivered, so it
      // stays unreported and goes with the next batch.
      this.queue.recordDrop('rejected', 'high', records.length);
      this.stats.rejected += records.length;
      this.queue.ack(cursor);
      this.queue.flushState();
      this.state = 'batch_rejected';
      return 'rejected';
    }
    this.queue.release();
    this.failures += 1;
    const exp = Math.min(this.backoffMaxMs, this.backoffMinMs * 2 ** Math.min(this.failures - 1, 16));
    const jittered = Math.round(exp / 2 + this.random() * (exp / 2));
    const wait = Math.max(jittered, error.retryAfterMs || 0);
    this.nextAttemptAt = this.now() + wait;
    this.state = error.class === 'auth' ? 'auth_failed' : error.class === 'rate_limited' ? 'rate_limited' : 'backoff';
    return 'backoff';
  }

  status() {
    return {
      state: this.state,
      batch_max: this.batchMax,
      next_attempt_in_ms: Math.max(0, this.nextAttemptAt - this.now()),
      consecutive_failures: this.failures,
      last_success_at: this.lastSuccessAt,
      last_error: this.lastError,
      ...this.stats,
    };
  }
}

module.exports = { TelemetryUploader, Rollup };

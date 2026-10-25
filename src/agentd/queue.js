'use strict';

// Bounded durable telemetry queue. The daemon is its only writer, so there is no file lock and
// no contention between parallel hooks (the 3.9.97 spool lost receipts to its shared lock).
//
// Two lanes, each a FIFO of append-only segment files (JSON lines):
//   high   - decision receipts, fallback bypasses, integrity events, control events
//   normal - rollups, session events, heartbeats
// Each lane has a hard cap in segments. When a lane is full the OLDEST segment of that lane is
// evicted and every record in it is counted as dropped. Drops are persisted, reported to the
// server in the next batch and shown in status; nothing is ever dropped silently. Acked records
// are deleted, so the queue drains itself (the 1000-row spool never did, R-25).

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { ensurePrivateDir, writeFileAtomic } = require('./fsutil');

const LANES = ['high', 'normal'];
const MAX_RECORD_BYTES = 16 * 1024;
const SEGMENT_PATTERN = /^seg-(\d{16})\.jsonl$/;

class TelemetryQueue {
  constructor({ dir, segmentMaxRecords = 256, laneMaxSegments = { high: 200, normal: 200 }, scrub = (text) => text }) {
    this.scrub = scrub;
    this.dir = dir;
    this.segmentMaxRecords = segmentMaxRecords;
    this.laneMaxSegments = { high: 200, normal: 200, ...laneMaxSegments };
    this.stateFile = path.join(dir, 'state.json');
    this.lanes = {};
    this.state = null;
    this.dirtyState = false;
    // Segments that belong to a batch the uploader is sending. They are never evicted, so an
    // ack can only ever remove records that were actually delivered.
    this.inflight = {};
  }

  open() {
    ensurePrivateDir(this.dir);
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(this.stateFile, 'utf8')); } catch { saved = {}; }
    this.state = {
      next_segment: Number.isInteger(saved.next_segment) ? saved.next_segment : 1,
      heads: saved.heads && typeof saved.heads === 'object' ? saved.heads : {},
      drops: { total: 0, by_lane: { high: 0, normal: 0 }, by_reason: {}, ...(saved.drops || {}) },
      reported_drops: Number.isInteger(saved.reported_drops) ? saved.reported_drops : 0,
      appended: Number.isInteger(saved.appended) ? saved.appended : 0,
      acked: Number.isInteger(saved.acked) ? saved.acked : 0,
    };
    for (const lane of LANES) {
      const laneDir = path.join(this.dir, lane);
      ensurePrivateDir(laneDir);
      const segments = fs.readdirSync(laneDir)
        .map((name) => name.match(SEGMENT_PATTERN))
        .filter(Boolean)
        .map((match) => ({ id: Number(match[1]), file: path.join(laneDir, match[0]) }))
        .sort((a, b) => a.id - b.id)
        .map((segment) => ({ ...segment, count: countLines(segment.file) }));
      const head = this.state.heads[lane] || {};
      let headIndex = 0;
      if (segments.length && head.segment === segments[0].id && Number.isInteger(head.index)) headIndex = Math.min(head.index, segments[0].count);
      this.lanes[lane] = { dir: laneDir, segments, headIndex };
      for (const segment of segments) if (segment.id >= this.state.next_segment) this.state.next_segment = segment.id + 1;
    }
    this.persist();
    return this;
  }

  append(event, lane = 'normal') {
    if (!LANES.includes(lane)) lane = 'normal';
    const record = { event_id: event.event_id || `evt_${crypto.randomUUID()}`, ...event };
    let line = `${this.scrub(JSON.stringify(record))}\n`;
    if (Buffer.byteLength(line) > MAX_RECORD_BYTES) {
      this.recordDrop('oversize', lane, 1);
      return null;
    }
    const state = this.lanes[lane];
    let tail = state.segments[state.segments.length - 1];
    if (!tail || tail.count >= this.segmentMaxRecords || tail.sealed) {
      const id = this.state.next_segment;
      this.state.next_segment += 1;
      tail = { id, file: path.join(state.dir, `seg-${String(id).padStart(16, '0')}.jsonl`), count: 0 };
      state.segments.push(tail);
      if (state.segments.length === 1) state.headIndex = 0;
    }
    try {
      appendLine(state.dir, tail.file, line);
    } catch {
      // Disk full, directory removed, permission change: the record is lost, so count it, and
      // seal the segment so a partial line can never merge with the next record.
      tail.sealed = true;
      this.recordDrop('write_failed', lane, 1);
      return null;
    }
    tail.count += 1;
    this.state.appended += 1;
    line = null;
    this.enforceCap(lane);
    this.dirtyState = true;
    return record.event_id;
  }

  enforceCap(lane) {
    const state = this.lanes[lane];
    const inflight = this.inflight[lane];
    while (state.segments.length > this.laneMaxSegments[lane]) {
      const k = state.segments.findIndex((segment) => !inflight || segment.id < inflight.first || segment.id > inflight.last);
      if (k < 0 || k === state.segments.length - 1) break; // only in-flight segments and the tail remain
      const [evicted] = state.segments.splice(k, 1);
      const lost = k === 0 ? evicted.count - state.headIndex : evicted.count;
      if (k === 0) state.headIndex = 0;
      try { fs.unlinkSync(evicted.file); } catch { /* already gone */ }
      if (lost > 0) this.recordDrop('overflow', lane, lost);
    }
  }

  recordDrop(reason, lane, count) {
    if (!count) return;
    const drops = this.state.drops;
    drops.total += count;
    drops.by_lane[lane] = (drops.by_lane[lane] || 0) + count;
    drops.by_reason[reason] = (drops.by_reason[reason] || 0) + count;
    this.dirtyState = true;
  }

  depth(lane) {
    const state = this.lanes[lane];
    return state.segments.reduce((sum, segment) => sum + segment.count, 0) - state.headIndex;
  }

  // Reads up to `max` records, high lane first. Returns { records, cursor }; pass the cursor to
  // ack() after the server accepted the batch.
  peekBatch(max) {
    const records = [];
    const cursor = {};
    for (const lane of LANES) {
      const state = this.lanes[lane];
      let segIndex = 0;
      let index = state.headIndex;
      let taken = 0;
      while (records.length < max && segIndex < state.segments.length) {
        const segment = state.segments[segIndex];
        if (index >= segment.count) { segIndex += 1; index = 0; continue; }
        const lines = readLines(segment.file);
        while (records.length < max && index < segment.count) {
          const line = lines[index];
          index += 1;
          taken += 1;
          if (line === undefined) { this.recordDrop('missing', lane, 1); continue; }
          try { records.push(JSON.parse(line)); } catch { this.recordDrop('corrupt', lane, 1); }
        }
      }
      cursor[lane] = { taken };
      if (taken > 0) this.inflight[lane] = { first: state.segments[0].id, last: state.segments[Math.min(segIndex, state.segments.length - 1)].id };
    }
    return { records, cursor };
  }

  // The batch was not delivered: its segments become evictable again.
  release() {
    this.inflight = {};
  }

  ack(cursor) {
    this.inflight = {};
    for (const lane of LANES) {
      let remaining = cursor[lane] ? cursor[lane].taken : 0;
      const state = this.lanes[lane];
      while (remaining > 0 && state.segments.length) {
        const head = state.segments[0];
        const available = head.count - state.headIndex;
        const consumed = Math.min(available, remaining);
        state.headIndex += consumed;
        remaining -= consumed;
        this.state.acked += consumed;
        if (state.headIndex >= head.count) {
          // Fully delivered segment (including a drained tail): delete it so nothing lingers.
          state.segments.shift();
          state.headIndex = 0;
          try { fs.unlinkSync(head.file); } catch { /* already gone */ }
        }
      }
    }
    this.dirtyState = true;
    this.persist();
  }

  // Drops not yet reported to the server.
  unreportedDrops() {
    return this.state.drops.total - this.state.reported_drops;
  }

  markDropsReported(total) {
    this.state.reported_drops = Math.max(this.state.reported_drops, total);
    this.dirtyState = true;
  }

  persist() {
    if (!this.state) return;
    const heads = {};
    for (const lane of LANES) {
      const state = this.lanes[lane];
      if (state && state.segments.length) heads[lane] = { segment: state.segments[0].id, index: state.headIndex };
    }
    this.state.heads = heads;
    writeFileAtomic(this.stateFile, `${JSON.stringify(this.state)}\n`);
    this.dirtyState = false;
  }

  flushState() {
    if (this.dirtyState) this.persist();
  }

  stats() {
    const depth = { high: this.depth('high'), normal: this.depth('normal') };
    return {
      depth,
      pending: depth.high + depth.normal,
      segments: { high: this.lanes.high.segments.length, normal: this.lanes.normal.segments.length },
      capacity_records: {
        high: this.laneMaxSegments.high * this.segmentMaxRecords,
        normal: this.laneMaxSegments.normal * this.segmentMaxRecords,
      },
      appended: this.state.appended,
      acked: this.state.acked,
      drops: { ...this.state.drops, unreported: this.unreportedDrops() },
    };
  }
}

function appendLine(dir, file, line) {
  try {
    fs.appendFileSync(file, line, { mode: 0o600 });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    ensurePrivateDir(dir);
    fs.appendFileSync(file, line, { mode: 0o600 });
  }
}

// Every complete record ends with a newline; an unterminated fragment (a torn write) is not a
// record and is ignored here - its loss was counted when the write failed.
function readLines(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    const lines = text.split('\n');
    lines.pop();
    return lines;
  } catch {
    return [];
  }
}

function countLines(file) {
  return readLines(file).length;
}

module.exports = { TelemetryQueue, LANES };

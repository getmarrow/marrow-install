'use strict';

// Shim <-> daemon wire protocol (version 1). It is deliberately trivial so the native shim can
// speak it in a few lines of C:
//
//   request:  "MRWH1 <harness> <event> <pid>\n" + raw hook stdin bytes, then EOF (SHUT_WR)
//   response: "MRWR1 <exit> <stdout_len> <stderr_len>\n" + stdout bytes + stderr bytes
//
// The daemon renders the harness-specific output, so the shim only relays bytes and never
// interprets the payload. Admin requests use harness "_admin" and an operation name as event.

const { REQUEST_MAGIC, RESPONSE_MAGIC, MAX_HEADER_BYTES, MAX_PAYLOAD_BYTES } = require('./constants');

const TOKEN = /^[a-z0-9_][a-z0-9_-]{0,31}$/;

function encodeRequestHeader(harness, event, pid) {
  if (!TOKEN.test(harness) || !TOKEN.test(event)) throw new Error('invalid harness or event token');
  return Buffer.from(`${REQUEST_MAGIC} ${harness} ${event} ${Number(pid) || 0}\n`, 'ascii');
}

function parseRequestHeader(line) {
  const parts = String(line).split(' ');
  if (parts.length !== 4 || parts[0] !== REQUEST_MAGIC) return null;
  const [, harness, event, pidText] = parts;
  if (!TOKEN.test(harness) || !TOKEN.test(event) || !/^[0-9]{1,10}$/.test(pidText)) return null;
  return { harness, event, pid: Number(pidText) };
}

function encodeResponse({ exit = 0, stdout = '', stderr = '' }) {
  const out = Buffer.from(String(stdout), 'utf8');
  const err = Buffer.from(String(stderr), 'utf8');
  const code = Number.isInteger(exit) && exit >= 0 && exit <= 255 ? exit : 2;
  return Buffer.concat([Buffer.from(`${RESPONSE_MAGIC} ${code} ${out.length} ${err.length}\n`, 'ascii'), out, err]);
}

// Incremental parser for the daemon side. Feed chunks; `done()` is called at EOF.
class RequestReader {
  constructor() {
    this.headerBuf = Buffer.alloc(0);
    this.header = null;
    this.chunks = [];
    this.size = 0;
    this.overflow = false;
    this.invalid = false;
  }

  push(chunk) {
    if (this.invalid) return;
    if (!this.header) {
      this.headerBuf = Buffer.concat([this.headerBuf, chunk]);
      const newline = this.headerBuf.indexOf(0x0a);
      if (newline < 0) {
        if (this.headerBuf.length > MAX_HEADER_BYTES) this.invalid = true;
        return;
      }
      if (newline > MAX_HEADER_BYTES) { this.invalid = true; return; }
      this.header = parseRequestHeader(this.headerBuf.subarray(0, newline).toString('ascii'));
      if (!this.header) { this.invalid = true; return; }
      const rest = this.headerBuf.subarray(newline + 1);
      this.headerBuf = null;
      if (rest.length) this.pushBody(rest);
      return;
    }
    this.pushBody(chunk);
  }

  pushBody(chunk) {
    if (this.overflow) return;
    if (this.size + chunk.length > MAX_PAYLOAD_BYTES) { this.overflow = true; this.chunks = []; return; }
    this.chunks.push(chunk);
    this.size += chunk.length;
  }

  body() {
    return Buffer.concat(this.chunks, this.size);
  }
}

// Client-side response parser (node shim, tests, status CLI).
function parseResponse(buffer) {
  const newline = buffer.indexOf(0x0a);
  if (newline < 0 || newline > 64) return null;
  const parts = buffer.subarray(0, newline).toString('ascii').split(' ');
  if (parts.length !== 4 || parts[0] !== RESPONSE_MAGIC) return null;
  const [exit, outLen, errLen] = parts.slice(1).map(Number);
  if (![exit, outLen, errLen].every(Number.isInteger)) return null;
  const body = buffer.subarray(newline + 1);
  if (body.length !== outLen + errLen) return null;
  return { exit, stdout: body.subarray(0, outLen).toString('utf8'), stderr: body.subarray(outLen).toString('utf8') };
}

module.exports = { encodeRequestHeader, parseRequestHeader, encodeResponse, parseResponse, RequestReader, TOKEN };

'use strict';

// Node client for the daemon socket (node shim, status CLI, tests and the latency benchmark).

const net = require('node:net');
const { encodeRequestHeader, parseResponse } = require('./protocol');

function callDaemon({ socketPath, harness, event, payload = '', timeoutMs = 5000, pid = process.pid }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const socket = net.connect({ path: socketPath });
    const fail = (code, message) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      const error = new Error(message || code);
      error.code = code;
      reject(error);
    };
    const timer = setTimeout(() => fail('ETIMEDOUT', 'daemon did not answer in time'), timeoutMs);
    socket.once('connect', () => {
      socket.write(encodeRequestHeader(harness, event, pid));
      if (payload && payload.length) socket.write(payload);
      socket.end();
    });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.once('error', (error) => { clearTimeout(timer); fail(error.code || 'ESOCKET', error.message); });
    socket.once('end', () => {
      clearTimeout(timer);
      if (settled) return;
      const parsed = parseResponse(Buffer.concat(chunks));
      if (!parsed) { fail('EPROTO', 'invalid daemon response'); return; }
      settled = true;
      resolve(parsed);
    });
  });
}

async function adminCall(socketPath, op, body = {}, timeoutMs = 8000) {
  const response = await callDaemon({ socketPath, harness: '_admin', event: op, payload: Buffer.from(JSON.stringify(body)), timeoutMs });
  let json = null;
  try { json = JSON.parse(response.stdout); } catch { json = null; }
  return { ...response, json };
}

module.exports = { callDaemon, adminCall };

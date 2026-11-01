'use strict';

// Test-only tracer, loaded with `node --require` into a CLI child process. It appends one line per fs call that names a
// path inside INS1_TRACE_ROOT (the private world of the test), per network attempt and per spawn, to INS1_TRACE_FILE, and
// changes nothing else: every call goes on to the real function. A line never carries a file's bytes, only the call and
// the path.
const childProcess = require('node:child_process');
const dns = require('node:dns');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const tls = require('node:tls');

const traceFile = process.env.INS1_TRACE_FILE;
const root = process.env.INS1_TRACE_ROOT;
if (traceFile && root) {
  const append = fs.appendFileSync.bind(fs);
  const realpath = fs.realpathSync.native.bind(fs);
  const note = (kind, what) => { try { append(traceFile, `${kind}\t${what}\n`); } catch { /* the test sees an empty trace */ } };
  const asText = (value) => {
    if (typeof value === 'string') return value;
    if (Buffer.isBuffer(value)) return value.toString();
    if (value && typeof value === 'object' && value.href && value.protocol === 'file:') return decodeURIComponent(value.pathname);
    return null;
  };
  const inside = (candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`);
  const touches = (value) => {
    const text = asText(value);
    if (text === null) return null;
    const resolved = path.resolve(text);
    if (inside(resolved)) return resolved;
    // A name outside the root that is a link into it counts: the read goes through the link.
    try {
      const real = realpath(resolved);
      return inside(real) ? resolved : null;
    } catch {
      return null;
    }
  };
  // The calls whose second argument is a path too (the data of a write is not).
  const TWO_PATHS = /^(rename|copyFile|link|symlink|cp)(Sync)?$/;
  const guard = (owner, name, label) => {
    const original = owner[name];
    if (typeof original !== 'function') return;
    const paths = TWO_PATHS.test(name) ? 2 : 1;
    const wrapped = function tracedFs(...args) {
      for (const argument of args.slice(0, paths)) {
        const hit = touches(argument);
        if (hit) { note('fs', `${label}.${name} ${hit}`); break; }
      }
      return original.apply(this, args);
    };
    Object.defineProperty(wrapped, 'name', { value: original.name });
    for (const key of Object.keys(original)) wrapped[key] = original[key];
    owner[name] = wrapped;
  };
  const FS_CALLS = [
    'open', 'openSync', 'readFile', 'readFileSync', 'createReadStream', 'createWriteStream', 'stat', 'statSync', 'lstat', 'lstatSync',
    'exists', 'existsSync', 'access', 'accessSync', 'readdir', 'readdirSync', 'opendir', 'opendirSync', 'readlink', 'readlinkSync',
    'realpath', 'realpathSync', 'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'rename', 'renameSync', 'unlink',
    'unlinkSync', 'mkdir', 'mkdirSync', 'mkdtemp', 'mkdtempSync', 'chmod', 'chmodSync', 'copyFile', 'copyFileSync', 'link', 'linkSync',
    'symlink', 'symlinkSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync', 'truncate', 'truncateSync', 'utimes', 'utimesSync', 'cp', 'cpSync',
  ];
  for (const name of FS_CALLS) guard(fs, name, 'fs');
  for (const name of FS_CALLS.filter((entry) => !/Sync$|^exists$|^createReadStream$|^createWriteStream$/.test(entry))) guard(fs.promises, name, 'fs.promises');
  if (fs.realpathSync.native) guard(fs.realpathSync, 'native', 'fs.realpathSync');

  const traceCall = (owner, name, kind) => {
    const original = owner[name];
    if (typeof original !== 'function') return;
    const wrapped = function tracedCall(...args) {
      note(kind, name);
      return original.apply(this, args);
    };
    Object.defineProperty(wrapped, 'name', { value: original.name });
    owner[name] = wrapped;
  };
  for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) traceCall(childProcess, name, 'spawn');
  for (const [owner, names] of [[net, ['connect', 'createConnection']], [tls, ['connect']], [http, ['request', 'get']], [https, ['request', 'get']], [dns, ['lookup', 'resolve']]]) {
    for (const name of names) traceCall(owner, name, 'net');
  }
  traceCall(net.Socket.prototype, 'connect', 'net');
  traceCall(globalThis, 'fetch', 'net');
}

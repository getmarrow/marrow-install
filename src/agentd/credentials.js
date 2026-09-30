'use strict';

// The daemon is the only Marrow process that holds the API key. It reads exactly one owner-only
// file, ~/.marrow/env (0600, owner-owned, no symlink). It never reads ~/.marrow/env.local (the
// ADV-05 redirect vector), repository .env files or its own environment, and it never returns
// the key to a caller: requests get an Authorization header built in-process.

const crypto = require('node:crypto');
const path = require('node:path');
const { readPrivateFile } = require('./fsutil');

const KEY_NAMES = ['MARROW_API_KEY', 'MARROW_KEY'];

function parseKey(raw) {
  for (const name of KEY_NAMES) {
    for (const line of String(raw || '').split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || match[1] !== name) continue;
      let value = match[2] || '';
      const hash = value.search(/\s+#/);
      if (hash >= 0) value = value.slice(0, hash);
      value = value.trim().replace(/^(['"])(.*)\1$/, '$2');
      if (value) return value;
    }
  }
  return '';
}

class CredentialStore {
  constructor({ home }) {
    this.file = path.join(home, '.marrow', 'env');
    this.key = '';
    this.fingerprint = null;
    this.state = 'missing';
    this.changedSinceStart = false;
  }

  // Returns { state, changed }. `changed` is true when a different key replaced a previous one.
  refresh() {
    let raw;
    try {
      raw = readPrivateFile(this.file, 64 * 1024);
    } catch (error) {
      this.key = '';
      this.state = error.code === 'ENOENT' ? 'missing' : `unsafe:${error.reason || error.code || 'error'}`;
      return { state: this.state, changed: false };
    }
    const key = parseKey(raw);
    if (!key) {
      this.key = '';
      this.state = 'missing';
      return { state: this.state, changed: false };
    }
    const fingerprint = crypto.createHash('sha256').update(key).digest('hex');
    const changed = this.fingerprint !== null && this.fingerprint !== fingerprint;
    if (changed) this.changedSinceStart = true;
    this.key = key;
    this.fingerprint = fingerprint;
    this.state = 'present';
    return { state: this.state, changed };
  }

  authorizationHeader() {
    return this.key ? `Bearer ${this.key}` : null;
  }

  status() {
    return { state: this.state, source: '~/.marrow/env', changed_since_start: this.changedSinceStart };
  }
}

module.exports = { CredentialStore, parseKey };

require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { encodeRequestHeader, encodeResponse, parseResponse, RequestReader } = require('../src/agentd/protocol');
const { PolicyStore, signEnvelope, verifyVerdict } = require('../src/agentd/policy');
const { TelemetryQueue } = require('../src/agentd/queue');
const { redactArgv, redactText } = require('../src/agentd/redact');
const { CredentialStore } = require('../src/agentd/credentials');

function tempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

function policyPayload(overrides = {}) {
  const now = Date.now();
  return {
    schema: 'marrow.policy.v1',
    version: 1,
    issued_at: new Date(now - 1000).toISOString(),
    expires_at: new Date(now + 60 * 60 * 1000).toISOString(),
    control: { level: 'enforce' },
    ...overrides,
  };
}

test('protocol: request header, response framing, oversize and garbage input', () => {
  const reader = new RequestReader();
  reader.push(Buffer.concat([encodeRequestHeader('claude-code', 'pre', 123), Buffer.from('{"a":1}')]));
  assert.deepEqual(reader.header, { harness: 'claude-code', event: 'pre', pid: 123 });
  assert.equal(reader.body().toString(), '{"a":1}');
  assert.throws(() => encodeRequestHeader('Claude Code', 'pre', 1));
  const bad = new RequestReader();
  bad.push(Buffer.from('GET / HTTP/1.1\r\n'));
  assert.equal(bad.invalid, true);
  const long = new RequestReader();
  long.push(Buffer.alloc(1024, 0x41));
  assert.equal(long.invalid, true);
  const response = parseResponse(encodeResponse({ exit: 2, stdout: 'out ✓', stderr: 'err' }));
  assert.deepEqual(response, { exit: 2, stdout: 'out ✓', stderr: 'err' });
  assert.equal(parseResponse(Buffer.from('MRWR1 0 10 0\nshort')), null);
});

test('policy: only a bundle signed by a pinned key, newer and unexpired, is accepted', () => {
  const dir = tempDir('agentd-pol-');
  try {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const attacker = crypto.generateKeyPairSync('ed25519');
    const store = new PolicyStore({ dir, trustedKeys: { k1: publicKey } });
    store.load();
    assert.equal(store.current().source, 'builtin_baseline');
    assert.equal(store.current().control.level, 'enforce');

    assert.equal(store.accept(signEnvelope(policyPayload(), attacker.privateKey, 'k1')).reason, 'bad_signature');
    assert.equal(store.accept(signEnvelope(policyPayload(), attacker.privateKey, 'attacker')).reason, 'untrusted_key');
    const forgedOff = signEnvelope(policyPayload({ control: { level: 'off' } }), privateKey, 'k1');
    assert.equal(store.accept(forgedOff).reason, 'weaker_control_without_owner_receipt');

    assert.equal(store.accept(signEnvelope(policyPayload({ version: 3 }), privateKey, 'k1')).accepted, true);
    assert.equal(store.accept(signEnvelope(policyPayload({ version: 2 }), privateKey, 'k1')).reason, 'rollback_rejected');
    const expired = policyPayload({ version: 4, issued_at: new Date(Date.now() - 7200e3).toISOString(), expires_at: new Date(Date.now() - 3600e3).toISOString() });
    assert.equal(store.accept(signEnvelope(expired, privateKey, 'k1')).reason, 'expired');

    // Tampering with the cached file on disk is detected on the next load.
    const cached = JSON.parse(fs.readFileSync(path.join(dir, 'current.json'), 'utf8'));
    const payload = JSON.parse(Buffer.from(cached.payload, 'base64url').toString());
    payload.control = { level: 'off', approval_receipt_id: 'forged' };
    cached.payload = Buffer.from(JSON.stringify(payload)).toString('base64url');
    fs.writeFileSync(path.join(dir, 'current.json'), JSON.stringify(cached), { mode: 0o600 });
    const reloaded = new PolicyStore({ dir, trustedKeys: { k1: publicKey } });
    reloaded.load();
    assert.equal(reloaded.current().source, 'builtin_baseline');
    assert.equal(reloaded.current().control.level, 'enforce');
    assert.equal(reloaded.current().lastError, 'cache_bad_signature');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('policy: an owner "off" lapses back to enforce when the bundle goes stale', () => {
  const dir = tempDir('agentd-pol-');
  try {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    let now = Date.now();
    const store = new PolicyStore({ dir, trustedKeys: { k1: publicKey }, now: () => now, staleGraceMs: 60e3 });
    store.accept(signEnvelope(policyPayload({ issued_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 10e3).toISOString(), control: { level: 'off', approval_receipt_id: 'oar_1' } }), privateKey, 'k1'));
    assert.equal(store.current().control.level, 'off');
    now += 20e3; // expired but inside the stale grace: tables still usable, control back to enforce
    assert.equal(store.current().freshness, 'stale');
    assert.equal(store.current().control.level, 'enforce');
    now += 120e3;
    assert.equal(store.current().freshness, 'expired');
    assert.equal(store.current().source, 'builtin_baseline');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('gate verdicts must be signed and bound to the request and action', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const verdict = { schema: 'marrow.gate.v1', request_id: 'r1', action_hash: 'a1', verdict: 'allow' };
  const keys = { k: publicKey };
  assert.equal(verifyVerdict(signEnvelope(verdict, privateKey, 'k'), keys, { requestId: 'r1', actionHash: 'a1' }).ok, true);
  assert.equal(verifyVerdict(signEnvelope(verdict, privateKey, 'k'), keys, { requestId: 'r2', actionHash: 'a1' }).error, 'verdict_request_mismatch');
  assert.equal(verifyVerdict(signEnvelope(verdict, privateKey, 'k'), keys, { requestId: 'r1', actionHash: 'other' }).error, 'verdict_action_mismatch');
  assert.equal(verifyVerdict(signEnvelope(verdict, crypto.generateKeyPairSync('ed25519').privateKey, 'k'), keys, { requestId: 'r1', actionHash: 'a1' }).error, 'bad_signature');
});

test('queue: overflow evicts oldest segments and counts every dropped record; drain leaves no files', () => {
  const dir = tempDir('agentd-q-');
  try {
    const queue = new TelemetryQueue({ dir, segmentMaxRecords: 10, laneMaxSegments: { high: 3, normal: 2 } }).open();
    for (let i = 0; i < 100; i += 1) queue.append({ type: 'n', i }, 'normal');
    for (let i = 0; i < 25; i += 1) queue.append({ type: 'h', i }, 'high');
    const stats = queue.stats();
    assert.equal(stats.depth.normal, 20);
    assert.equal(stats.depth.high, 25);
    assert.equal(stats.drops.total, 80);
    assert.equal(stats.drops.by_lane.normal, 80);
    assert.equal(stats.drops.by_reason.overflow, 80);
    assert.equal(stats.appended - stats.drops.total - stats.pending, 0, 'every record is pending, delivered or counted as dropped');
    // Drain: high lane first, then normal.
    let delivered = [];
    for (;;) {
      const { records, cursor } = queue.peekBatch(7);
      if (!records.length) break;
      delivered = delivered.concat(records);
      queue.ack(cursor);
    }
    assert.equal(delivered.length, 45);
    assert.deepEqual(delivered.slice(0, 25).map((r) => r.type), Array(25).fill('h'));
    assert.deepEqual(delivered.slice(25).map((r) => r.i), Array.from({ length: 20 }, (_, k) => 80 + k));
    assert.equal(queue.stats().pending, 0);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'normal')), []);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'high')), []);
    // State survives a restart, including the drop counters.
    const reopened = new TelemetryQueue({ dir, segmentMaxRecords: 10, laneMaxSegments: { high: 3, normal: 2 } }).open();
    assert.equal(reopened.stats().drops.total, 80);
    assert.equal(reopened.stats().pending, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('queue: segments of an in-flight batch are never evicted, so an ack only removes delivered records', () => {
  const dir = tempDir('agentd-q-');
  try {
    const queue = new TelemetryQueue({ dir, segmentMaxRecords: 5, laneMaxSegments: { high: 2, normal: 2 } }).open();
    for (let i = 0; i < 10; i += 1) queue.append({ i }, 'normal');
    const { records, cursor } = queue.peekBatch(5);
    assert.deepEqual(records.map((r) => r.i), [0, 1, 2, 3, 4]);
    for (let i = 10; i < 30; i += 1) queue.append({ i }, 'normal'); // overflow while the batch is in flight
    queue.ack(cursor);
    const rest = [];
    for (;;) {
      const batch = queue.peekBatch(100);
      if (!batch.records.length) break;
      rest.push(...batch.records.map((r) => r.i));
      queue.ack(batch.cursor);
    }
    const stats = queue.stats();
    assert.ok(!rest.some((i) => i < 5), 'delivered records are not delivered twice');
    assert.equal(5 + rest.length + stats.drops.total, 30, 'delivered + pending-then-delivered + counted drops = appended');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('redaction removes secret-shaped values from argv and text', () => {
  const token = `ghp_${crypto.randomBytes(18).toString('hex')}`;
  const out = redactArgv(['curl', '-H', `Authorization: Bearer ${token}`, `https://user:${token}@example.com`, `--token=${token}`]);
  assert.ok(!JSON.stringify(out).includes(token));
  assert.ok(!redactText(`MARROW_API_KEY=mrw_live_${crypto.randomBytes(16).toString('hex')}`).includes('mrw_live_'));
});

test('credentials: only ~/.marrow/env is read, never env.local, and only when owner-only', () => {
  const home = tempDir('agentd-cred-');
  try {
    fs.mkdirSync(path.join(home, '.marrow'), { mode: 0o700 });
    const key = `mrw_test_${crypto.randomBytes(16).toString('hex')}`;
    fs.writeFileSync(path.join(home, '.marrow', 'env.local'), `MARROW_API_KEY=${key}\n`, { mode: 0o600 });
    const store = new CredentialStore({ home });
    assert.equal(store.refresh().state, 'missing');
    fs.writeFileSync(path.join(home, '.marrow', 'env'), `MARROW_API_KEY=${key}\n`, { mode: 0o644 });
    assert.match(store.refresh().state, /^unsafe:/);
    fs.chmodSync(path.join(home, '.marrow', 'env'), 0o600);
    assert.equal(store.refresh().state, 'present');
    assert.ok(!JSON.stringify(store.status()).includes(key));
    fs.writeFileSync(path.join(home, '.marrow', 'env'), `MARROW_API_KEY=${key}x\n`, { mode: 0o600 });
    assert.equal(store.refresh().changed, true);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// C1b: the offline verifier port (src/signed-record-verify.js) against the vector catalogue of the C1b verifier contract
// (section 5). Vectors are built here at runtime: throwaway Ed25519 pairs made in memory (never written or printed) and
// signed bytes from an INDEPENDENT RFC 8785 canonicaliser written in this file, not the product's. Required by
// test/c1b-verify-cli.test.js (and the build's cross-check script) for buildVectors(); the tests run only as main.
require('./support/isolated-environment');

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const GATE = 'marrow.gate_receipt.v1';
const CLOSE = 'marrow.outcome_close.v1';
const FORMAT = 'marrow.signed_records.v1';
const NOT_BEFORE = '2026-11-01T00:00:00.000Z';
const SIGNED_AT = '2026-11-20T10:00:00.000Z';
const L = (1n << 252n) + 27742317777372353535851937790883648493n;
const GATE_OMITTED = ['action_text', 'action_binding_hash', 'approval_keys', 'target_hash', 'surfaces_hash', 'session_id',
  'required_steps', 'required_proof_fields', 'approval_categories', 'runtime_correlation_hash', 'reuse_shape_key'];
const CLOSE_OMITTED = ['feedback', 'details', 'decision_context', 'decision_outcome_text'];
// Copied by script from the backend reference test file (record-signing.test.ts at the pinned blob), never retyped.
const GOLDEN = /*GOLDEN*/{"rfc8785Input":"{\"numbers\":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],\"string\":\"\\u20ac$\\u000F\\u000aA'\\u0042\\u0022\\u005c\\\\\\\"\\/\",\"literals\":[null,true,false]}","rfc8785Expected":"{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\\\\\"/\"}","sortNames":["€","\r","דּ","1","😀","","ö"],"sortExpected":["\r","1","","ö","€","😀","דּ"],"thumbprintX":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo","thumbprintKid":"kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k","v4Canonical":"{\"account_id\":\"acct_vector_0001\",\"agent_id\":\"agent-vector\",\"alg\":\"EdDSA\",\"allow\":false,\"automatic_approval_id\":null,\"ci\":{\"state\":\"not_linked\"},\"created_at\":\"2026-11-22T10:00:00.000Z\",\"decision\":\"owner_approval_required\",\"decision_id\":\"dec_vector_0001\",\"decision_receipt_count\":2,\"environment\":\"test\",\"expires_at\":\"2026-11-22T10:15:00.000Z\",\"kid\":\"kPrK_qmxVWaYVA9wwBF6Iuo3vVzz7TxHCTwXBygrS4k\",\"omitted\":[\"action_text\",\"action_binding_hash\",\"approval_keys\",\"target_hash\",\"surfaces_hash\",\"session_id\",\"required_steps\",\"required_proof_fields\",\"approval_categories\",\"runtime_correlation_hash\",\"reuse_shape_key\"],\"outcome\":{\"outcome_id\":\"out_vector_0001\",\"state\":\"recorded\"},\"owner_approval_required\":true,\"receipt_id\":\"rcpt_vector_0001\",\"record_type\":\"marrow.gate_receipt.v1\",\"required\":true,\"risk_level\":\"high\",\"signed_at\":\"2026-11-23T00:00:00.000Z\",\"signed_from\":\"2026-11-01T00:00:00.000Z\",\"source\":\"server_issued\"}","v4Sha256":"8d1e33b962d7b9477cba4927b09dabe398348a9527ea77d4859ef10b65f10cdd"}/*END*/;

// ---- independent RFC 8785 (UTF-16 code unit order, ES number text, minimal string escapes) ----
function jcsString(text) {
  let out = '"';
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code === 0x22) out += '\\"';
    else if (code === 0x5c) out += '\\\\';
    else if (code === 0x08) out += '\\b';
    else if (code === 0x0c) out += '\\f';
    else if (code === 0x0a) out += '\\n';
    else if (code === 0x0d) out += '\\r';
    else if (code === 0x09) out += '\\t';
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += text[index];
  }
  return `${out}"`;
}
function codeUnitCompare(a, b) {
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    const diff = a.charCodeAt(index) - b.charCodeAt(index);
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}
function jcs(value) {
  if (value === null) return 'null';
  if (value === true || value === false) return String(value);
  if (typeof value === 'number') return Object.is(value, -0) ? '0' : String(value);
  if (typeof value === 'string') return jcsString(value);
  if (Array.isArray(value)) return `[${value.map(jcs).join(',')}]`;
  return `{${Object.keys(value).sort(codeUnitCompare).map((name) => `${jcsString(name)}:${jcs(value[name])}`).join(',')}}`;
}

// ---- keys and records (private keys stay in this process) ----
const hex = (n) => crypto.randomBytes(n).toString('hex');
const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
const thumbprint = (x) => crypto.createHash('sha256').update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`).digest('base64url');
function makeKey() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x;
  return { privateKey, x, kid: thumbprint(x) };
}
function entry(key, status = 'active', environment = 'production', extra = {}) {
  return { kty: 'OKP', crv: 'Ed25519', x: key.x, kid: key.kid, alg: 'EdDSA', use: 'sig', status, environment, not_before: NOT_BEFORE, ...extra };
}

function buildVectors() {
  const ACCOUNT = `acct_c1b_${hex(6)}`;
  const OTHER = `acct_c1b_other_${hex(6)}`;
  const DUMMY = `c1bdummy${hex(8)}`; // non-secret shape: a fixed non-key prefix plus runtime hex
  const [K1, K2, KR, KV, KS, KU] = [makeKey(), makeKey(), makeKey(), makeKey(), makeKey(), makeKey()];
  const JW = { keys: [entry(K1), entry(K2), entry(KR, 'retired', 'production', { not_after: '2026-11-10T00:00:00.000Z' }),
    entry(KV, 'revoked', 'production', { revoked_at: '2026-11-05T00:00:00.000Z' }), entry(KS, 'active', 'staging')], signed_from: NOT_BEFORE };
  const EXP = { account_id: ACCOUNT, environment: 'production' };
  const receipt = (key, over = {}, drop = []) => {
    const payload = { record_type: GATE, alg: 'EdDSA', kid: key.kid, environment: 'production', account_id: ACCOUNT, signed_at: SIGNED_AT,
      signed_from: NOT_BEFORE, receipt_id: 'rcpt_one', decision_id: 'dec_one', agent_id: 'agent-one', decision: 'owner_approval_required',
      risk_level: 'high', allow: false, required: true, owner_approval_required: true, automatic_approval_id: null,
      created_at: '2026-11-20T09:59:00.000Z', expires_at: '2026-11-20T10:29:00.000Z', source: 'server_issued',
      outcome: { state: 'not_recorded' }, ci: { state: 'not_linked' }, decision_receipt_count: 1, omitted: [...GATE_OMITTED], ...over };
    for (const name of drop) delete payload[name];
    return payload;
  };
  const recorded = (key, over = {}) => receipt(key, { outcome: { state: 'recorded', outcome_id: 'out_one' }, ...over });
  const close = (key, over = {}, drop = []) => {
    const payload = { record_type: CLOSE, alg: 'EdDSA', kid: key.kid, environment: 'production', account_id: ACCOUNT, signed_at: SIGNED_AT,
      signed_from: NOT_BEFORE, outcome_id: 'out_one', decision_id: 'dec_one', agent_id: 'agent-one', success: true,
      recorded_at: '2026-11-20T10:05:00.000Z', source: 'client_self_reported', outcome_scope: 'decision', omitted: [...CLOSE_OMITTED], ...over };
    for (const name of drop) delete payload[name];
    return payload;
  };
  const signBytes = (key, bytes) => crypto.sign(null, bytes, key.privateKey);
  const rec = (key, type, payload, opts = {}) => {
    const prefix = opts.noPrefix ? '' : `${opts.prefix ?? type}\n`;
    return { type, payload, sig: b64u(signBytes(key, Buffer.from(prefix + jcs(payload), 'utf8'))) };
  };
  const answerOf = (records, extra = {}) => JSON.stringify({ format: FORMAT, signing: { status: 'signed' }, records, ...extra });
  const ok1 = () => rec(K1, GATE, receipt(K1));
  const okPair = () => [rec(K1, GATE, recorded(K1)), rec(K1, CLOSE, close(K1))];
  const vectors = [];
  const V = (id, text, exp, opts = {}) => vectors.push({ id, text, exp, jwks: opts.jwks === undefined ? JW : opts.jwks, expect: opts.expect || EXP,
    ...(opts.kind ? { kind: opts.kind } : {}), ...(opts.spec ? { spec: opts.spec } : {}) });
  const withSig = (record, sig) => ({ ...record, sig });

  V('X-OK1', answerOf([ok1()]), 'ok');
  V('X-OK2', answerOf(okPair()), 'ok');
  // C-1: other member orders, pretty-printed; the RFC 8785 3.2.3 sort vector and upper/lower case inside a signed member.
  {
    const [r, c] = okPair();
    const flip = (o) => Object.fromEntries(Object.entries(o).reverse());
    V('C-1.order-pretty', JSON.stringify(flip({ format: FORMAT, signing: { status: 'signed' }, records: [flip({ ...r, payload: flip(r.payload) }), flip({ ...c, payload: flip(c.payload) })] }), null, 2), 'ok');
    const names = GOLDEN.sortNames;
    const ci = { state: 'not_linked' };
    names.forEach((name, index) => { ci[name] = index; });
    V('C-1.rfc8785-3.2.3', answerOf([rec(K1, GATE, receipt(K1, { ci }))]), 'ok');
    V('C-1.case-order', answerOf([rec(K1, GATE, receipt(K1, { ci: { b: 1, B: 2, a: 3, A: 4 } }))]), 'ok');
  }
  // C-2: escaped forms in the received text.
  V('C-2', answerOf([rec(K1, GATE, receipt(K1, { agent_id: 'agent-A/b' }))]).replace('"agent-A/b"', '"agent-\\u0041\\/b"'), 'ok');
  // C-3: number forms of the same value; non-profile numbers signed by the generator.
  for (const form of ['1.0', '1e0', '10e-1']) V(`C-3.${form}`, answerOf([ok1()]).replace('"decision_receipt_count":1', `"decision_receipt_count":${form}`), 'ok');
  V('C-3.-0', answerOf([rec(K1, GATE, receipt(K1, { decision_receipt_count: 0 }))]).replace('"decision_receipt_count":0', '"decision_receipt_count":-0'), 'ok');
  V('C-3.1.5', answerOf([rec(K1, GATE, receipt(K1, { decision_receipt_count: 1.5 }))]), 'profile');
  V('C-3.2^53', answerOf([rec(K1, GATE, receipt(K1, { decision_receipt_count: 2 ** 53 }))]), 'profile');
  // C-4: look-alike text swapped in after signing.
  for (const [name, signed, swapped] of [['cyrillic-a', 'agent-a', 'agent-а'], ['nfc-nfd', 'agent-é', 'agent-é'],
    ['fullwidth', 'agent-a', 'agent-ａ'], ['zero-width', 'agent-a', 'agent-​a']]) {
    const r = rec(K1, GATE, receipt(K1, { agent_id: signed }));
    V(`C-4.${name}`, answerOf([{ ...r, payload: { ...r.payload, agent_id: swapped } }]), 'signature');
  }
  // C-5: a lone surrogate (escaped) in a payload string.
  V('C-5', answerOf([ok1()]).replace('"agent_id":"agent-one"', '"agent_id":"agent-one\\ud800"'), 'signature');
  // C-6: duplicate members at answer, record and payload level, forged value first and last.
  {
    const text = answerOf([ok1()]);
    const sigMatch = /"sig":"[^"]*"/.exec(text)[0];
    const acct = `"account_id":"${ACCOUNT}"`;
    V('C-6.answer-first', text.replace(`"format":"${FORMAT}"`, `"format":"forged","format":"${FORMAT}"`), 'strict_parse');
    V('C-6.answer-last', text.replace(`"format":"${FORMAT}"`, `"format":"${FORMAT}","format":"forged"`), 'strict_parse');
    V('C-6.record-first', text.replace(sigMatch, `"sig":"forged",${sigMatch}`), 'strict_parse');
    V('C-6.record-last', text.replace(sigMatch, `${sigMatch},"sig":"forged"`), 'strict_parse');
    V('C-6.payload-first', text.replace(acct, `"account_id":"${OTHER}",${acct}`), 'strict_parse');
    V('C-6.payload-last', text.replace(acct, `${acct},"account_id":"${OTHER}"`), 'strict_parse');
  }
  // C-7: every member of both types changed one at a time after signing; text after a redacted-looking span.
  {
    const mutate = (v) => (typeof v === 'string' ? `${v}X` : typeof v === 'boolean' ? !v : typeof v === 'number' ? v + 1 : v === null ? 'X'
      : Array.isArray(v) ? v.slice(1) : { ...v, state: `${v.state}X` });
    for (const [type, records, index] of [[GATE, okPair(), 0], [CLOSE, okPair(), 1]]) {
      for (const name of Object.keys(records[index].payload)) {
        const changed = records.map((r, at) => (at === index ? { ...r, payload: { ...r.payload, [name]: mutate(r.payload[name]) } } : r));
        V(`C-7.${type === GATE ? 'receipt' : 'close'}.${name}`, answerOf(changed), 'notok');
      }
    }
    const span = rec(K1, GATE, receipt(K1, { agent_id: `agent-x?token=${DUMMY}&x=1` }));
    V('C-7.after-redacted-span', answerOf([span]).replace('&x=1', '&x=2'), 'signature');
    V('COLL-1.dummy-only', answerOf([span]).replace(DUMMY, `c1bdummy${hex(8)}`), 'signature');
  }
  // C-9: values swapped between members.
  {
    const r = ok1();
    V('C-9.receipt-decision', answerOf([{ ...r, payload: { ...r.payload, receipt_id: r.payload.decision_id, decision_id: r.payload.receipt_id } }]), 'signature');
    V('C-9.created-expires', answerOf([{ ...r, payload: { ...r.payload, created_at: r.payload.expires_at, expires_at: r.payload.created_at } }]), 'signature');
  }
  // C-10: prefix and type confusion.
  V('C-10.receipt-under-close-prefix', answerOf([rec(K1, GATE, receipt(K1), { prefix: CLOSE })]), 'signature');
  V('C-10.type-not-record-type', answerOf([{ ...rec(K1, CLOSE, close(K1)), type: GATE }]), 'record_type');
  V('C-10.unknown-type', answerOf([rec(K1, 'marrow.unknown.v1', receipt(K1, { record_type: 'marrow.unknown.v1' }))]), 'record_type');
  V('C-10.prefix-dropped', answerOf([rec(K1, GATE, receipt(K1), { noPrefix: true })]), 'signature');
  // C-11: account from the caller only.
  V('C-11.other-account', answerOf([ok1()]), 'account', { expect: { account_id: OTHER, environment: 'production' } });
  V('C-11.account-removed', answerOf([rec(K1, GATE, receipt(K1, {}, ['account_id']))]), 'profile');
  // C-12 and A-8: environment.
  V('C-12.staging-record', answerOf([rec(K1, GATE, receipt(K1, { environment: 'staging' }))]), 'environment');
  V('C-12.key-environment', answerOf([rec(KS, GATE, receipt(KS))]), 'key_environment');
  V('A-8.test-record', answerOf([rec(K1, GATE, receipt(K1, { environment: 'test' }))]), 'environment');
  V('A-8.staging-only-jwks', answerOf([ok1()]), 'key_environment', { jwks: { keys: [entry(K1, 'active', 'staging')], signed_from: NOT_BEFORE } });
  // C-13: signed by K1, kid names K2.
  V('C-13', answerOf([rec(K1, GATE, receipt(K2))]), 'signature');
  // C-14: outcome binding and receipt count.
  V('C-14.other-outcome', answerOf([rec(K1, GATE, recorded(K1)), rec(K1, CLOSE, close(K1, { outcome_id: 'out_two' }))]), 'outcome_binding');
  V('C-14.no-close', answerOf([rec(K1, GATE, recorded(K1))]), 'outcome_binding');
  V('C-14.two-closes', answerOf([rec(K1, CLOSE, close(K1)), rec(K1, CLOSE, close(K1))]), 'receipt_count');
  V('C-14.three-records', answerOf([...okPair(), {}]), 'format');
  V('C-14.other-decision', answerOf([rec(K1, GATE, recorded(K1, { decision_id: 'dec_two' })), rec(K1, CLOSE, close(K1))]), 'outcome_binding');
  V('C-14.other-account', answerOf([rec(K1, GATE, recorded(K1)), rec(K1, CLOSE, close(K1, { account_id: OTHER }))]), 'outcome_binding');
  V('C-14.close-without-recorded', answerOf([ok1(), rec(K1, CLOSE, close(K1))]), 'outcome_binding');
  V('C-14.two-receipts', answerOf([rec(K1, GATE, receipt(K1, { omitted: [] })), rec(K1, GATE, receipt(K1, { omitted: [] }))]), 'receipt_count');
  // C-15: closed member sets on validly signed payloads.
  V('C-15.receipt-extra', answerOf([rec(K1, GATE, receipt(K1, { action_text: 'deploy' }))]), 'profile');
  V('C-15.close-extra', answerOf([rec(K1, GATE, recorded(K1)), rec(K1, CLOSE, close(K1, { certified: true }))]), 'profile');
  V('C-15.receipt-missing', answerOf([rec(K1, GATE, receipt(K1, {}, ['ci']))]), 'profile');
  // A-3: algorithms.
  for (const alg of ['none', 'HS256', 'RS256', 'ES256', 'eddsa']) V(`A-3.payload-${alg}`, answerOf([rec(K1, GATE, receipt(K1, { alg }))]), 'alg');
  V('A-3.payload-missing', answerOf([rec(K1, GATE, receipt(K1, {}, ['alg']))]), 'profile');
  const jwksWith = (replace) => ({ keys: [replace, ...JW.keys.slice(1)], signed_from: NOT_BEFORE });
  V('A-3.entry-RS256', answerOf([ok1()]), 'key_params', { jwks: jwksWith(entry(K1, 'active', 'production', { alg: 'RS256' })) });
  { const e = entry(K1); delete e.alg; V('A-3.entry-alg-missing', answerOf([ok1()]), 'key_params', { jwks: jwksWith(e) }); }
  V('A-3.entry-use-enc', answerOf([ok1()]), 'key_params', { jwks: jwksWith(entry(K1, 'active', 'production', { use: 'enc' })) });
  // A-4: kid and status.
  V('A-4.unknown-kid', answerOf([rec(KU, GATE, receipt(KU))]), 'kid_unknown');
  V('A-4.revoked', answerOf([rec(KV, GATE, receipt(KV))]), 'kid_revoked');
  V('A-4.retired-after', answerOf([rec(KR, GATE, receipt(KR))]), 'kid_window');
  V('A-4.retired-within', answerOf([rec(KR, GATE, receipt(KR, { signed_at: '2026-11-05T00:00:00.000Z' }))]), 'ok');
  V('A-4.before-not-before', answerOf([rec(K1, GATE, receipt(K1, { signed_at: '2026-10-01T00:00:00.000Z' }))]), 'kid_window');
  V('A-4.duplicate-kid', answerOf([ok1()]), 'kid_duplicate', { jwks: { keys: [entry(K1), entry(K1)], signed_from: NOT_BEFORE } });
  // A-5: key parameters.
  V('A-5.kid-not-thumbprint', answerOf([ok1()]), 'kid_thumbprint', { jwks: jwksWith({ ...entry(K1), x: K2.x }) });
  V('A-5.kty-RSA', answerOf([ok1()]), 'key_params', { jwks: jwksWith(entry(K1, 'active', 'production', { kty: 'RSA' })) });
  V('A-5.crv-X25519', answerOf([ok1()]), 'key_params', { jwks: jwksWith(entry(K1, 'active', 'production', { crv: 'X25519' })) });
  V('A-5.entry-d', answerOf([ok1()]), 'key_members', { jwks: jwksWith(entry(K1, 'active', 'production', { d: 'A'.repeat(43) })) });
  // A-6: signature encoding.
  {
    const r = ok1();
    const s = r.sig;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const raw = Buffer.from(s, 'base64url');
    for (const [name, sig] of [['padding', `${s}==`], ['plus', `+${s.slice(1)}`], ['slash', `/${s.slice(1)}`], ['63-bytes', b64u(raw.subarray(0, 63))],
      ['65-bytes', b64u(Buffer.concat([raw, Buffer.from([0])]))], ['whitespace', `${s.slice(0, 40)} ${s.slice(41)}`],
      ['trailing-bits', s.slice(0, -1) + alphabet[(alphabet.indexOf(s.at(-1)) + 1) % 64]]]) V(`A-6.${name}`, answerOf([withSig(r, sig)]), 'sig_encoding');
  }
  // F2a, F2b: member sets of the answer and of key entries.
  V('F2a', answerOf([ok1()], { certified: true }), 'answer_members');
  V('F2b.active-not_after', answerOf([ok1()]), 'key_members', { jwks: jwksWith(entry(K1, 'active', 'production', { not_after: '2026-12-01T00:00:00.000Z' })) });
  V('F2b.retired-revoked_at', answerOf([ok1()]), 'key_members', { jwks: jwksWith(entry(K1, 'retired', 'production', { revoked_at: '2026-12-01T00:00:00.000Z' })) });
  V('F2b.unknown-member', answerOf([ok1()]), 'key_members', { jwks: jwksWith(entry(K1, 'active', 'production', { note: 'x' })) });
  V('F2b.unknown-status', answerOf([ok1()]), 'ref:notok', { jwks: jwksWith(entry(K1, 'paused')) });
  // FMT and REC.
  V('FMT.format-wrong', answerOf([ok1()], { format: 'marrow.signed_records.v2' }), 'format');
  V('FMT.records-empty', answerOf([]), 'format');
  V('FMT.records-three', answerOf([ok1(), {}, {}]), 'format');
  V('FMT.records-object', JSON.stringify({ format: FORMAT, signing: {}, records: { 0: ok1() } }), 'format');
  V('FMT.answer-array', JSON.stringify([ok1()]), 'format');
  V('FMT.answer-string', JSON.stringify('marrow'), 'format');
  V('REC.extra-member', answerOf([{ ...ok1(), note: 'x' }]), 'record_members');
  V('REC.not-object', answerOf(['record']), 'record_members');
  // Bounds.
  {
    const base = answerOf([ok1()]);
    V('BND-1.chars', `${base}${' '.repeat(5991 - base.length)}`, 'input_bytes');
    const notes = 'é'.repeat(Math.ceil((5991 - base.length) / 2) + 20);
    const multi = answerOf([ok1()], { unsigned_notes: notes });
    V('BND-1.utf8-bytes', multi.length <= 5990 ? multi : multi.slice(0, 5990), 'input_bytes');
    V('BND-2', answerOf([ok1()], { unsigned_notes: Array.from({ length: 140 }, () => []) }), 'input_members');
    V('BND-3', answerOf([ok1()]), 'key_count', { jwks: { keys: Array.from({ length: 65 }, () => entry(K1)), signed_from: NOT_BEFORE } });
  }
  // Ed25519 edges.
  {
    const r = ok1();
    const raw = Buffer.from(r.sig, 'base64url');
    let sValue = 0n;
    for (let index = 63; index >= 32; index--) sValue = (sValue << 8n) | BigInt(raw[index]);
    sValue += L;
    const bumped = Buffer.from(raw);
    for (let index = 32; index < 64; index++) { bumped[index] = Number(sValue & 0xffn); sValue >>= 8n; }
    V('ED-1', answerOf([withSig(r, b64u(bumped))]), 'signature');
    for (const [name, xBytes] of [['all-zero', Buffer.alloc(32)], ['identity', Buffer.concat([Buffer.from([1]), Buffer.alloc(31)])]]) {
      const key = { x: b64u(xBytes), kid: thumbprint(b64u(xBytes)) };
      const sig = b64u(Buffer.concat([Buffer.from([1]), Buffer.alloc(63)]));
      // The contract expects not ok; the test pins parity with the reference only (spec class checked by the build's cross-check).
      V(`ED-2.${name}`, answerOf([{ type: GATE, payload: receipt(key), sig }]), 'ref:any', { jwks: { keys: [entry(key)], signed_from: NOT_BEFORE }, spec: 'notok' });
    }
    const pBytes = Buffer.concat([Buffer.from([0xed]), Buffer.alloc(30, 0xff), Buffer.from([0x7f])]);
    const bad = { x: b64u(pBytes), kid: thumbprint(b64u(pBytes)) };
    V('ED-3', answerOf([{ type: GATE, payload: receipt(bad), sig: ok1().sig }]), 'ref:notok', { jwks: { keys: [entry(bad)], signed_from: NOT_BEFORE } });
  }
  // TM-1: signed_at forms.
  for (const [name, at, exp] of [['no-millis', '2026-11-20T10:00:00Z', 'ok'], ['1-digit', '2026-11-20T10:00:00.5Z', 'ok'], ['2-digit', '2026-11-20T10:00:00.50Z', 'ok'],
    ['lower-z', '2026-11-20T10:00:00.000z', 'kid_window'], ['offset', '2026-11-20T10:00:00.000+00:00', 'kid_window'],
    ['nov-31', '2026-11-31T10:00:00.000Z', 'kid_window'], ['leap-60', '2026-11-20T10:00:60.000Z', 'kid_window']]) {
    V(`TM-1.${name}`, answerOf([rec(K1, GATE, receipt(K1, { signed_at: at }))]), exp);
  }
  // EXP-1: expect from the caller, as given.
  V('EXP-1.account-undefined', answerOf([ok1()]), 'account', { expect: { environment: 'production' } });
  V('EXP-1.account-empty', answerOf([ok1()]), 'account', { expect: { account_id: '', environment: 'production' } });
  V('EXP-1.account-number', answerOf([ok1()]), 'account', { expect: { account_id: 5, environment: 'production' } });
  V('EXP-1.environment-missing', answerOf([ok1()]), 'environment', { expect: { account_id: ACCOUNT } });
  // JW-1: key list shapes.
  for (const [name, jwks] of [['null', null], ['array', [entry(K1)]], ['keys-not-array', { keys: entry(K1) }], ['keys-odd', { keys: [null, 'a', 1] }]]) {
    V(`JW-1.${name}`, answerOf([ok1()]), 'ref:notok', { jwks });
  }
  // PROTO-1: __proto__ and constructor members, as own members of the received text.
  for (const member of ['__proto__', 'constructor']) {
    const text = answerOf([ok1()]);
    V(`PROTO-1.${member}.answer`, text.replace('{"format"', `{"${member}":{},"format"`), 'ref:notok');
    V(`PROTO-1.${member}.record`, text.replace('{"type"', `{"${member}":1,"type"`), 'ref:notok');
    V(`PROTO-1.${member}.payload`, text.replace('{"record_type"', `{"${member}":1,"record_type"`), 'ref:notok');
    V(`PROTO-1.${member}.key`, text, 'ref:notok', { jwks: JSON.parse(JSON.stringify(JW).replace('{"kty"', `{"${member}":1,"kty"`)) });
  }
  // TXT-1: answer text that is not a string (String coercion); the kind is rebuilt by the caller.
  V('TXT-1.number', '5', 'ref:notok', { kind: 'number' });
  V('TXT-1.tostring', answerOf([ok1()]), 'ref:any', { kind: 'tostring' });
  V('TXT-1.buffer', answerOf([ok1()]), 'ref:any', { kind: 'buffer' });
  // GROW: answer text and key list sizes past the bound.
  for (const size of [8192, 16384, 32768, 1048576]) {
    const text = answerOf([ok1()]);
    V(`GROW.answer-${size}`, text + ' '.repeat(size - text.length), 'input_bytes');
    const filler = { ...entry(K2), kid: 'k'.repeat(Math.max(1, Math.floor(size / 66) - 230)) };
    V(`GROW.jwks-${size}`, text, 'key_count', { jwks: { keys: Array.from({ length: 66 }, () => filler), signed_from: NOT_BEFORE } });
  }
  return { vectors, account: ACCOUNT, other: OTHER, dummy: DUMMY };
}

/** Rebuilds the answer argument of a vector (TXT-1 kinds). */
function answerArg(vector) {
  if (vector.kind === 'number') return Number(vector.text);
  if (vector.kind === 'tostring') return { toString: () => vector.text };
  if (vector.kind === 'buffer') return Buffer.from(vector.text, 'utf8');
  return vector.text;
}

/** The expected class of the contract (section 5), from the spec, not from any verifier. */
function classMet(exp, result) {
  if (exp === 'ok') return result.ok === true && result.failures.length === 0;
  if (exp === 'notok' || exp === 'ref:notok') return result.ok === false && result.failures.length > 0;
  if (exp === 'ref:any') return typeof result.ok === 'boolean';
  return result.ok === false && exp.split('|').some((code) => result.failures.includes(code));
}

module.exports = { buildVectors, answerArg, classMet, jcs };

if (require.main === module) {
  const test = require('node:test');
  const assert = require('node:assert/strict');
  const SRC = path.join(__dirname, '..', 'src', 'signed-record-verify.js');
  const port = () => require(SRC);
  const built = buildVectors();

  test('C1b VEC: every contract section 5 vector meets its expected class through the port', async () => {
    const { verifySignedRecords } = port();
    const missed = [];
    for (const vector of built.vectors) {
      const result = await verifySignedRecords(answerArg(vector), vector.jwks, vector.expect);
      if (!classMet(vector.exp, result)) missed.push(`${vector.id}:${result.failures.join(',')}`);
    }
    assert.deepEqual(missed, []);
    assert.ok(built.vectors.length >= 120, `vector count ${built.vectors.length}`);
  });

  test('C1b X-OK: verified records carry type, kid, account_id, environment, signed_at, payload in that order', async () => {
    const { verifySignedRecords } = port();
    const vector = built.vectors.find((v) => v.id === 'X-OK2');
    const result = await verifySignedRecords(vector.text, vector.jwks, vector.expect);
    assert.deepEqual(Object.keys(result), ['ok', 'failures', 'records']);
    assert.equal(result.records.length, 2);
    for (const record of result.records) assert.deepEqual(Object.keys(record), ['type', 'kid', 'account_id', 'environment', 'signed_at', 'payload']);
  });

  test('C1b failures are fixed codes only, each once, never a value from the input', async () => {
    const { verifySignedRecords } = port();
    const codes = new Set(['input_bytes', 'input_members', 'key_count', 'strict_parse', 'format', 'answer_members', 'key_members', 'record_members',
      'record_type', 'profile', 'alg', 'account', 'environment', 'kid_unknown', 'kid_duplicate', 'key_params', 'kid_thumbprint', 'key_environment',
      'kid_revoked', 'kid_window', 'sig_encoding', 'signature', 'receipt_count', 'outcome_binding']);
    for (const vector of built.vectors) {
      const { failures } = await verifySignedRecords(answerArg(vector), vector.jwks, vector.expect);
      for (const code of failures) assert.ok(codes.has(code), `${vector.id}: unknown code`);
      assert.equal(new Set(failures).size, failures.length, vector.id);
      if (failures.length > 0) assert.ok(!JSON.stringify(failures).includes(built.dummy), vector.id);
    }
  });

  test('C1b expect comes from the caller: the same answer fails for another account and environment, and expect is not filled', async () => {
    const { verifySignedRecords } = port();
    const vector = built.vectors.find((v) => v.id === 'X-OK1');
    const expect = { account_id: built.other, environment: 'staging' };
    const result = await verifySignedRecords(vector.text, vector.jwks, expect);
    assert.deepEqual(result.failures, ['account', 'environment', 'key_environment']);
    assert.deepEqual(expect, { account_id: built.other, environment: 'staging' });
    await assert.rejects(() => verifySignedRecords(vector.text, vector.jwks, undefined));
  });

  test('C1b golden vectors (copied by script from the backend reference test file)', () => {
    const { canonicalize } = port();
    assert.ok(GOLDEN, 'golden block present');
    assert.equal(canonicalize(JSON.parse(GOLDEN.rfc8785Input)), GOLDEN.rfc8785Expected);
    assert.equal(jcs(JSON.parse(GOLDEN.rfc8785Input)), GOLDEN.rfc8785Expected);
    const value = {};
    GOLDEN.sortNames.forEach((name, index) => { value[name] = index; });
    assert.equal(canonicalize(value), `{${GOLDEN.sortExpected.map((name) => `${JSON.stringify(name)}:${value[name]}`).join(',')}}`);
    assert.equal(thumbprint(GOLDEN.thumbprintX), GOLDEN.thumbprintKid);
    assert.equal(canonicalize(JSON.parse(GOLDEN.v4Canonical)), GOLDEN.v4Canonical);
    assert.equal(jcs(JSON.parse(GOLDEN.v4Canonical)), GOLDEN.v4Canonical);
    const bytes = Buffer.from(`marrow.gate_receipt.v1\n${GOLDEN.v4Canonical}`, 'utf8');
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), GOLDEN.v4Sha256);
  });

  test('C1b KEYIMPORT: the public key is imported from an object the port builds from x only', () => {
    const source = fs.readFileSync(SRC, 'utf8');
    assert.equal(source.split('createPublicKey(').length, 2, 'one key import');
    assert.ok(source.includes("crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: String(x) }, format: 'jwk' })"));
    assert.ok(source.includes('signatureValid(key.x, sigBytes, type, payload)'));
    assert.ok(!source.includes('importKey'));
    assert.ok(!/process\.env|require\('(?:https?|net|dns|child_process|fs)'\)/.test(source), 'no env, network, process or file access');
  });

  test('C1b GROW: bounds are checked before parsing; each call within 50 ms and near-linear', async () => {
    const { verifySignedRecords } = port();
    const grow = built.vectors.filter((v) => v.id.startsWith('GROW.'));
    for (const vector of grow) await verifySignedRecords(vector.text, vector.jwks, vector.expect);
    const times = {};
    for (const vector of grow) {
      let best = Infinity;
      for (let run = 0; run < 3; run++) {
        const start = process.hrtime.bigint();
        await verifySignedRecords(vector.text, vector.jwks, vector.expect);
        best = Math.min(best, Number(process.hrtime.bigint() - start) / 1e6);
      }
      times[vector.id] = best;
      assert.ok(best < 50, `${vector.id} ${best.toFixed(2)} ms`);
    }
    assert.ok(times['GROW.answer-1048576'] < 128 * Math.max(times['GROW.answer-8192'], 0.05) + 5, 'near-linear');
  });
}

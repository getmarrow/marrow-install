'use strict';

// Offline verifier for Marrow signed export answers: a port of the backend reference verifier (RFC 8785 behind a record-type
// prefix, Ed25519, a public key list). Fixed failure codes only. Nothing here reads the environment, a file or the network.

const crypto = require('crypto');

const GATE_RECEIPT_TYPE = 'marrow.gate_receipt.v1';
const OUTCOME_CLOSE_TYPE = 'marrow.outcome_close.v1';
const SIGNED_RECORDS_FORMAT = 'marrow.signed_records.v1';
const COMMON_MEMBERS = ['record_type', 'alg', 'kid', 'environment', 'account_id', 'signed_at', 'signed_from'];
const GATE_RECEIPT_MEMBERS = [...COMMON_MEMBERS, 'receipt_id', 'decision_id', 'agent_id', 'decision', 'risk_level',
  'allow', 'required', 'owner_approval_required', 'automatic_approval_id', 'created_at', 'expires_at', 'source', 'outcome', 'ci',
  'decision_receipt_count', 'omitted'];
const OUTCOME_CLOSE_MEMBERS = [...COMMON_MEMBERS, 'outcome_id', 'decision_id', 'agent_id', 'success',
  'recorded_at', 'source', 'outcome_scope', 'omitted'];
const MEMBERS = new Map([[GATE_RECEIPT_TYPE, GATE_RECEIPT_MEMBERS], [OUTCOME_CLOSE_TYPE, OUTCOME_CLOSE_MEMBERS]]);
const MEMBER_MAX = 128;
const SIGNED_EXPORT_MAX_BYTES = 2150 + 15 * MEMBER_MAX * 2;
const SIGNED_EXPORT_MAX_MEMBERS = 138;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const SERVED_BASE = ['kty', 'crv', 'x', 'kid', 'alg', 'use', 'status', 'environment', 'not_before'];
const SERVED_KEY_MEMBERS = { active: SERVED_BASE, retired: [...SERVED_BASE, 'not_after'], revoked: [...SERVED_BASE, 'revoked_at'] };
const ANSWER_MEMBERS = ['format', 'signing', 'records', 'unsigned_notes'];
const ISO_UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?Z$/;
const NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/;
const WHITESPACE = /\s/;
const encoder = new TextEncoder();

// Strict JSON: a scan that refuses duplicate member names (and anything JSON.parse refuses), then JSON.parse.
function strictParse(input) {
  let offset = 0;
  const skipWhitespace = () => { while (WHITESPACE.test(input[offset] || '') && offset < input.length) offset += 1; };
  const expectToken = (token) => { if (input[offset] !== token) throw new SyntaxError('Expected token'); offset += 1; };
  const scanString = () => {
    const start = offset;
    for (offset += 1; offset < input.length; offset++) {
      const char = input[offset];
      if (char === '"') return JSON.parse(input.slice(start, ++offset));
      if (char === '\\') {
        const escaped = input[++offset];
        if (escaped === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(input.slice(offset + 1, offset + 5))) throw new SyntaxError('Invalid JSON unicode escape');
          offset += 4;
        } else if (!escaped || !'"\\/bfnrt'.includes(escaped)) throw new SyntaxError('Invalid JSON escape');
      } else if (char.charCodeAt(0) <= 0x1f) throw new SyntaxError('Invalid JSON control character');
    }
    throw new SyntaxError('Unterminated JSON string');
  };
  const scanValue = () => {
    const token = input[offset];
    if (token === '{') return scanContainer('}', true);
    if (token === '[') return scanContainer(']', false);
    if (token === '"') { scanString(); return; }
    const number = token === '-' || (token >= '0' && token <= '9') ? NUMBER.exec(input.slice(offset)) || [] : null;
    if (number) { if (!number[0]) throw new SyntaxError('Invalid JSON number'); offset += number[0].length; return; }
    for (const literal of ['true', 'false', 'null']) if (input.startsWith(literal, offset)) { offset += literal.length; return; }
    throw new SyntaxError('Invalid JSON value');
  };
  const scanContainer = (close, isObject) => {
    offset += 1;
    skipWhitespace();
    if (input[offset] === close) { offset += 1; return; }
    const members = new Set();
    while (offset < input.length) {
      if (isObject) {
        if (input[offset] !== '"') throw new SyntaxError('JSON object member must be a string');
        const member = scanString();
        if (members.has(member)) throw new SyntaxError('Duplicate JSON member name');
        members.add(member);
        skipWhitespace(); expectToken(':'); skipWhitespace();
      }
      scanValue();
      skipWhitespace();
      if (input[offset] === close) { offset += 1; return; }
      expectToken(',');
      skipWhitespace();
    }
    throw new SyntaxError('Unterminated JSON container');
  };
  skipWhitespace();
  scanValue();
  skipWhitespace();
  if (offset !== input.length) throw new SyntaxError('Unexpected trailing JSON data');
  return JSON.parse(input);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const hasExactly = (value, names) => Object.keys(value).length === names.length && Object.keys(value).every((key) => names.includes(key));
const onlyMembers = (value, names) => Reflect.ownKeys(value).every((name) => typeof name === 'string' && names.includes(name));

const canonicalString = (value) => { if (LONE_SURROGATE.test(value)) throw new Error('Canonical JSON refused a lone surrogate'); return JSON.stringify(value); };

/** RFC 8785: UTF-16 code unit member order, ES number form, JSON.stringify strings, no Unicode normalisation. */
function canonicalize(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value === 'string') return canonicalString(value);
  if (Array.isArray(value)) return `[${Array.from(value, (item) => canonicalize(item)).join(',')}]`;
  if (isPlainObject(value)) return `{${Object.keys(value).sort().map((name) => `${canonicalString(name)}:${canonicalize(value[name])}`).join(',')}}`;
  throw new Error('Canonical JSON refused a value');
}

function profileValue(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isSafeInteger(value);
  return Array.isArray(value) ? value.every(profileValue) : isPlainObject(value) && Object.values(value).every(profileValue);
}

/** Exactly the closed member list of the type, record_type equal to the type, safe integers only. */
function recordProfileOk(type, payload) {
  const members = MEMBERS.get(type);
  return !!members && isPlainObject(payload) && hasExactly(payload, members) && payload.record_type === type && profileValue(payload);
}

/** UTF-8(record_type + newline) followed by UTF-8(RFC 8785 of the payload). */
function signedBytes(type, payload) {
  if (!recordProfileOk(type, payload)) throw new Error('Record is outside its profile');
  return encoder.encode(`${type}\n${canonicalize(payload)}`);
}

/** Canonical base64url of exactly `length` bytes (no padding, url alphabet, zero trailing bits), else null. */
function base64urlDecode(text, length) {
  if (typeof text !== 'string' || text.length !== Math.ceil((length * 4) / 3) || !/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const bytes = Buffer.from(text, 'base64url');
  return bytes.length === length && bytes.toString('base64url') === text ? bytes : null;
}

/** RFC 7638 thumbprint of an Ed25519 public key. */
const jwkThumbprint = (x) => crypto.createHash('sha256').update(`{"crv":"Ed25519","kty":"OKP","x":"${x}"}`, 'utf8').digest('base64url');

function isoTime(value) {
  const match = typeof value === 'string' ? ISO_UTC.exec(value) : null;
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  const at = Date.UTC(year, month - 1, day, hour, minute, second, match[7] ? Number(match[7].padEnd(3, '0')) : 0);
  const back = new Date(at);
  return back.getUTCFullYear() === year && back.getUTCMonth() === month - 1 && back.getUTCDate() === day && back.getUTCHours() === hour
    && back.getUTCMinutes() === minute && back.getUTCSeconds() === second ? at : null;
}

function keyWindowOk(key, signedAt) {
  const notBefore = isoTime(key.not_before);
  if (signedAt === null || notBefore === null || signedAt < notBefore) return false;
  const notAfter = isoTime(key.not_after);
  return key.status === 'active' || (key.status === 'retired' && notAfter !== null && signedAt <= notAfter);
}

/** The public key is built here from x alone; no other member of the key entry reaches the import. */
function signatureValid(x, sig, type, payload) {
  try {
    const bytes = signedBytes(type, payload);
    const publicKey = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: String(x) }, format: 'jwk' });
    return crypto.verify(null, bytes, publicKey, sig) === true;
  } catch {
    return false;
  }
}

function inputBound(text, jwks) {
  let members = 0;
  for (let index = 0, inString = false; text.length <= SIGNED_EXPORT_MAX_BYTES && index < text.length && members <= SIGNED_EXPORT_MAX_MEMBERS; index++) {
    if (inString && text[index] === '\\') index++;
    else if (text[index] === '"') inString = !inString;
    else if (!inString && ',:[{'.includes(text[index])) members++;
  }
  if (text.length > SIGNED_EXPORT_MAX_BYTES || encoder.encode(text).length > SIGNED_EXPORT_MAX_BYTES) return 'input_bytes';
  if (members > SIGNED_EXPORT_MAX_MEMBERS) return 'input_members';
  return isPlainObject(jwks) && Array.isArray(jwks.keys) && jwks.keys.length > 64 ? 'key_count' : null;
}

/** `expect` ({account_id, environment}) comes from the caller, never from the answer. Bounds are checked before parsing;
 * an unknown kid never falls back to another key, and a revoked kid never verifies. Result `{ ok, failures, records }`. */
async function verifySignedRecords(answerText, jwks, expect) {
  const failures = [];
  const records = [];
  const fail = (code) => { if (!failures.includes(code)) failures.push(code); };
  const result = () => ({ ok: failures.length === 0, failures, records });
  const text = String(answerText);
  const over = inputBound(text, jwks);
  if (over) { fail(over); return result(); }
  let answer;
  try { answer = strictParse(text); } catch { fail('strict_parse'); return result(); }
  if (!isPlainObject(answer) || answer.format !== SIGNED_RECORDS_FORMAT || !Array.isArray(answer.records) || answer.records.length < 1
    || answer.records.length > 2) { fail('format'); return result(); }
  if (!onlyMembers(answer, ANSWER_MEMBERS)) { fail('answer_members'); return result(); }
  const keys = isPlainObject(jwks) && Array.isArray(jwks.keys) ? jwks.keys : [];
  const servedFor = (status) => (typeof status === 'string' && Object.hasOwn(SERVED_KEY_MEMBERS, status) ? SERVED_KEY_MEMBERS[status] : SERVED_BASE);
  if (keys.some((key) => isPlainObject(key) && !onlyMembers(key, servedFor(key.status)))) { fail('key_members'); return result(); }
  const typed = [];
  for (const item of answer.records) {
    if (!isPlainObject(item) || !hasExactly(item, ['type', 'payload', 'sig'])) { fail('record_members'); continue; }
    const { type, payload, sig } = item;
    if (typeof type !== 'string' || !MEMBERS.has(type) || !isPlainObject(payload) || payload.record_type !== type) { fail('record_type'); continue; }
    if (!recordProfileOk(type, payload)) { fail('profile'); continue; }
    typed.push({ type, payload, sig });
    if (payload.alg !== 'EdDSA') { fail('alg'); continue; }
    let recordOk = true;
    const refuse = (code) => { fail(code); recordOk = false; };
    if (payload.account_id !== expect.account_id) refuse('account');
    if (payload.environment !== expect.environment) refuse('environment');
    const matches = keys.filter((key) => isPlainObject(key) && key.kid === payload.kid);
    if (matches.length !== 1) { fail(matches.length === 0 ? 'kid_unknown' : 'kid_duplicate'); continue; }
    const key = matches[0];
    if (key.kty !== 'OKP' || key.crv !== 'Ed25519' || key.alg !== 'EdDSA' || key.use !== 'sig') { fail('key_params'); continue; }
    if (!base64urlDecode(key.x, 32) || jwkThumbprint(key.x) !== key.kid) { fail('kid_thumbprint'); continue; }
    if (key.environment !== expect.environment) refuse('key_environment');
    if (key.status === 'revoked') refuse('kid_revoked');
    else if (!keyWindowOk(key, isoTime(payload.signed_at))) refuse('kid_window');
    const sigBytes = base64urlDecode(sig, 64);
    if (!sigBytes) { fail('sig_encoding'); continue; }
    if (!signatureValid(key.x, sigBytes, type, payload)) { fail('signature'); continue; }
    if (recordOk) {
      const { kid, account_id, environment, signed_at } = payload;
      records.push({ type, kid, account_id, environment, signed_at, payload });
    }
  }
  const receipts = typed.filter((item) => item.type === GATE_RECEIPT_TYPE);
  const closes = typed.filter((item) => item.type === OUTCOME_CLOSE_TYPE);
  if (receipts.length !== 1) { fail('receipt_count'); return result(); }
  const receipt = receipts[0].payload;
  const outcome = isPlainObject(receipt.outcome) ? receipt.outcome : {};
  const close = closes.length === 1 ? closes[0].payload : null;
  const bound = outcome.state === 'recorded'
    ? !!close && close.outcome_id === outcome.outcome_id && close.decision_id === receipt.decision_id && close.account_id === receipt.account_id
    : closes.length === 0;
  if (!bound) fail('outcome_binding');
  return result();
}

module.exports = { SIGNED_EXPORT_MAX_BYTES, verifySignedRecords, strictParse, canonicalize };

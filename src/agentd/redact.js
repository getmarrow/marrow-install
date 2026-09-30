'use strict';

// Redaction for anything the daemon sends to the server or writes to its queue or status. It
// removes secret-shaped values from argv and free text before they leave the process. Keys are
// never logged; this is a second line of defence for tool input the agent supplied.

const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g,
  /\bsk_(?:live|test)_[A-Za-z0-9]{8,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{12,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{8,}/g,
  /\bAKIA[0-9A-Z]{12,}/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\bmarrow_[A-Za-z0-9_]{8,}/g,
  /\bnpm_[A-Za-z0-9]{20,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:bearer|token|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b[A-Za-z0-9+/_-]{40,}={0,2}/g,
];
const ASSIGNMENT_PATTERN = /\b([A-Za-z0-9_.-]*(?:key|token|secret|password|passwd|pwd|auth|credential|cookie|session)[A-Za-z0-9_.-]*)\s*([=:])\s*("[^"]*"|'[^']*'|[^\s&"']+)/gi;
const URL_CREDENTIALS = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi;

function redactText(value, maxLength = 200) {
  let text = String(value == null ? '' : value);
  text = text.replace(URL_CREDENTIALS, '$1[redacted]@');
  text = text.replace(ASSIGNMENT_PATTERN, (_, name, sep) => `${name}${sep}[redacted]`);
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[redacted]');
  text = text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ');
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function redactArgv(argv, { maxArgs = 32, maxLength = 160 } = {}) {
  const out = [];
  let hideNext = false;
  for (const raw of (argv || []).slice(0, maxArgs)) {
    const arg = String(raw);
    if (hideNext) { out.push('[redacted]'); hideNext = false; continue; }
    if (/^(?:-H|--header|-u|--user|--password|--token|--otp|--api-key|--key|--secret|-p)$/i.test(arg)) { out.push(arg); hideNext = true; continue; }
    out.push(redactText(arg, maxLength));
  }
  if ((argv || []).length > maxArgs) out.push(`[+${argv.length - maxArgs} args]`);
  return out;
}

module.exports = { redactText, redactArgv };

'use strict';

// Where a Marrow key may be sent. Mirrors the rule in @getmarrow/mcp and @getmarrow/sdk (this
// package has no runtime dependency on either); test/fixtures/m2-base-url-vectors.json is the
// shared test table.
//
// A key read from an owner file (~/.marrow/env, ~/.marrow/env.local) goes only to the default
// endpoint, the endpoint that same file names (MARROW_BASE_URL, also used when nothing else names
// one), or an exact origin that same file lists in MARROW_ALLOWED_BASE_URLS. A base URL that only
// the process environment or a command-line option names (a project .mcp.json or
// .claude/settings.json env block, direnv, a devcontainer) never moves it. A key from the process
// environment or --key keeps its URL.
// Every URL, whatever its source, must be https, or http on a loopback host.
const DEFAULT_BASE_URL = 'https://api.getmarrow.ai';
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

// Strict parse of a URL a key may be sent to: https, or http on a loopback host only. No
// credentials, query, fragment, wildcard, whitespace, control or format characters.
function parseKeyTarget(value) {
  const text = String(value == null ? '' : value).trim();
  if (!text || /[\s\p{Cc}\p{Cf}\\*?#@]/u.test(text)) return null;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return url;
  return null;
}

function isRootPath(url) {
  return url.pathname === '/' || url.pathname === '';
}

// Exact origins only: an entry with a path, credentials, query, fragment or wildcard is skipped.
function allowedOrigins(value) {
  const origins = new Set();
  for (const entry of String(value || '').split(',')) {
    const url = parseKeyTarget(entry);
    if (url && isRootPath(url)) origins.add(url.origin);
  }
  return origins;
}

// Throws before any network call when a URL could not be sent a key. The message never repeats the
// value: it may carry credentials.
function assertSafeBaseUrl(value, label = 'MARROW_BASE_URL') {
  const text = String(value == null ? '' : value).trim() || DEFAULT_BASE_URL;
  if (!parseKeyTarget(text)) {
    throw new Error(`${label} must be an https URL (http is allowed only for localhost, 127.0.0.1 and [::1]) with no user name, password, query or fragment`);
  }
  return text;
}

function keyTargetUrl(url) {
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

// The URL for a key that came from an owner file. `candidate` is what the process environment or an
// option asked for (empty when neither did); `ownerValues` are the values of the file that supplied
// the key; `fileName` is 'env' or 'env.local'; `source` names where the candidate came from, for the
// notice. With no candidate, the endpoint that same file names is used when a key may be sent to it
// (as @getmarrow/mcp and @getmarrow/sdk do); a named URL that may not get a key is ignored, with a
// notice, and the default is used.
function ownerKeyBaseUrl({ candidate, ownerValues = {}, fileName = 'env', source = 'MARROW_BASE_URL from the process environment' }) {
  const wanted = String(candidate == null ? '' : candidate).trim();
  const named = parseKeyTarget(ownerValues.MARROW_BASE_URL);
  if (!wanted) {
    if (named) return { baseUrl: keyTargetUrl(named) };
    if (String(ownerValues.MARROW_BASE_URL || '').trim()) {
      return {
        baseUrl: DEFAULT_BASE_URL,
        notice: `ignored MARROW_BASE_URL in ~/.marrow/${fileName}: it must be an https URL (http is allowed only for localhost, 127.0.0.1 and [::1]) with no user name, password, query or fragment`,
      };
    }
    return { baseUrl: DEFAULT_BASE_URL };
  }
  const target = parseKeyTarget(wanted);
  if (target && target.origin === new URL(DEFAULT_BASE_URL).origin && isRootPath(target)) return { baseUrl: DEFAULT_BASE_URL };
  if (target && ((named && named.origin === target.origin) || allowedOrigins(ownerValues.MARROW_ALLOWED_BASE_URLS).has(target.origin))) {
    return { baseUrl: keyTargetUrl(target) };
  }
  return {
    baseUrl: DEFAULT_BASE_URL,
    notice: `ignored ${source}: the key comes from ~/.marrow/${fileName}; list the URL in MARROW_ALLOWED_BASE_URLS in that file to allow it`,
  };
}

const emitted = new Set();

// Writes a notice to stderr once per process. Notices name a source, never a key or a URL.
function emitNoticeOnce(notice) {
  if (!notice || emitted.has(notice)) return;
  emitted.add(notice);
  try {
    process.stderr.write(`[marrow] ${notice}\n`);
  } catch {
    // A closed stderr never changes the decision.
  }
}

module.exports = {
  DEFAULT_BASE_URL,
  LOOPBACK_HOSTS,
  allowedOrigins,
  assertSafeBaseUrl,
  emitNoticeOnce,
  ownerKeyBaseUrl,
  parseKeyTarget,
};

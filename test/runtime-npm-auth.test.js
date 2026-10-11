require('./support/isolated-environment');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { runtimeCore } = require('../src/mcp-runtime');
const { ROWS, runRow, setup } = require('./support/npm-auth-rows');

// FU-1: the owner's npm auth reaches the network only when every network setting comes from the
// owner's own npm config. A network setting from the environment (npm_config_* allowlist, plain
// proxy variables, CA and TLS variables, PREFIX), or one that npm resolves differently under the
// hook env (an env-expanded value), makes the install read private user and global configs that carry no auth (only the owner's
// registry URLs, read under a bare env, when they are safe) instead; a project .npmrc is never read.

const OUTSIDE = ['HTTP_PROXY', 'http_proxy', 'Https_Proxy', 'HTTPS_PROXY', 'PROXY', 'proxy', 'NO_PROXY', 'no_proxy', 'ALL_PROXY', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_OPTIONS', 'NODE_USE_ENV_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'OPENSSL_CONF', 'OPENSSL_MODULES', 'HOSTALIASES', 'LOCALDOMAIN', 'RES_OPTIONS', 'PREFIX', 'prefix', 'DESTDIR'];

test('FU-1: every environment variable npm or node reads as a network or config-location setting, and every refused env network value, means "from outside", in any case; unrelated or stripped ones do not', () => {
  for (const key of OUTSIDE) assert.equal(runtimeCore.npmOutside({ HOME: '/h', [key]: 'x' }), true, key);
  for (const [key, value] of [['npm_config_proxy', 'http://p/\r\n'], ['NPM_CONFIG_REGISTRY', 'http://r/${NPM_TOKEN}'], ['npm_config_https-proxy', 'x'.repeat(2049)], ['npm_config_cafile', '']]) {
    assert.equal(runtimeCore.npmOutside({ [key]: value }), true, `${key}: refused value`);
  }
  for (const key of ['PATH', 'HOME', 'NPM_TOKEN', 'npm_config_cache', 'npm_config_prefix', 'npm_config_userconfig', 'npm_config_globalconfig', 'npm_config_strict_ssl', 'npm_config__authToken', 'npm_config_registry', 'PROXYX', 'XPROXY', 'NODE_ENV', 'PREFIXES']) {
    assert.equal(runtimeCore.npmOutside({ HOME: '/h', [key]: 'http://x/' }), false, `${key}: passed as a network setting (decided by the caller), stripped, or ignored by npm`);
  }
  assert.deepEqual(runtimeCore.npmNetwork({ npm_config_registry: 'http://x/${NPM_TOKEN}/', npm_config_proxy: 'http://p/' }), { npm_config_proxy: 'http://p/' }, 'a ${VAR} in an env network value never passes');
});

test('FU-1 end to end (real npm, capture servers, dummy token): no abuse row sends the owner\'s token to the attacker; the owner\'s mirror, proxy and auth work as before; a project .npmrc is never read', async () => {
  const ctx = setup();
  try {
    for (const row of ROWS) {
      if (row.tls && !ctx.tls) continue;
      const result = await runRow(ctx, row);
      assert.equal(result.attacker.token_hits, 0, `${row.id} ${row.what}: token at the attacker`);
      assert.equal(result.token_in_output, 0, `${row.id}: token in hook output`);
      assert.equal(result.runtime_dirs, 0, `${row.id}: the empty configs are removed`);
      if (row.legit) {
        assert.equal(result.status, 0, row.id);
        assert.equal(result.genuine, true, row.id);
      }
      if (row.id === 'L0') assert.ok(result.mirror.token_hits > 0, 'L0: the owner mirror still gets the owner auth');
      if (row.id === 'L1') assert.ok(result.ownproxy.token_hits > 0 && result.ownproxy.requests > 0, 'L1: the owner proxy from ~/.npmrc is still used');
      if (/^A7/.test(row.id)) {
        assert.equal(result.attacker.requests, 0, `${row.id}: the project .npmrc is never read`);
        assert.ok(result.genuine && result.mirror.token_hits > 0, `${row.id}: the owner config is used unchanged`);
      }
      if (['A1', 'A10', 'A10b', 'A10c'].includes(row.id)) assert.ok(result.attacker.requests > 0, `${row.id}: the env proxy is still used (without auth)`);
      if (row.id === 'N4') assert.ok(result.genuine && result.mirror.token_hits === 0, 'N4: the env registry is used (npm precedence, as on master) and the owner mirror is never sent auth');
      if (['N1', 'N5'].includes(row.id)) assert.equal(result.mirror.token_hits, 0, `${row.id}: userinfo is never written or sent`);
      if (['A3', 'A4', 'A5'].includes(row.id)) assert.equal(result.genuine, true, `${row.id}: the env network works, without auth; the pins decide`);
    }
  } finally {
    fs.rmSync(ctx.work, { recursive: true, force: true });
  }
});

require('./support/isolated-environment');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');

const { runtimeCore } = require('../src/mcp-runtime');
const { ROWS, runRows, setup } = require('./support/npm-auth-rows');

// FU-1: the owner's npm auth reaches the network only when every network setting comes from the
// owner's own npm config. A network setting from the environment (npm_config_* allowlist, plain
// proxy variables, CA and TLS variables, PREFIX), or one that npm resolves differently under the
// hook env (an env-expanded value), makes the install read private user and global configs that carry no auth (only the owner's
// registry URLs, read under a bare env, when they are safe) instead; a project .npmrc is never read.

const OUTSIDE = ['HTTP_PROXY', 'http_proxy', 'Https_Proxy', 'HTTPS_PROXY', 'PROXY', 'proxy', 'ALL_PROXY', 'all_proxy', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'NODE_USE_ENV_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'OPENSSL_CONF', 'OPENSSL_MODULES', 'openssl_conf', 'HOSTALIASES', 'hostaliases', 'LOCALDOMAIN', 'RES_OPTIONS', 'PREFIX', 'prefix', 'DESTDIR', 'destdir'];
// FU-1 r4 (A16p): only these can never route or intercept traffic, so they alone are not "from outside".
const NO_PROXY_NAMES = ['NO_PROXY', 'no_proxy', 'No_Proxy', 'NOPROXY', 'noproxy'];
const NODE_OPTIONS_OK = ['--max-old-space-size=4096', '--max-old-space-size=1', '--max-old-space-size=999999', '--max-semi-space-size=64', '--max-semi-space-size=9999', '--enable-source-maps', '--no-warnings', '--no-deprecation', '--trace-warnings', '--trace-deprecation', '--max-old-space-size=4096 --no-warnings --enable-source-maps'];
const NODE_OPTIONS_BAD = ['-r ./x.js', '--require ./x.js', '--require=./x.js', '--import ./x.mjs', '--import=data:text/javascript,1', '--loader ./x.mjs', '--experimental-loader=./x.mjs', '--experimental-fetch', '--use-openssl-ca', '--use-bundled-ca', '--tls-min-v1.0', '--tls-cipher-list=x', '--openssl-config=/tmp/x', '--openssl-legacy-provider', '--inspect', '--inspect-brk=0', '--inspect=0.0.0.0:9229', '--max-old-space-size=4096 --require ./x.js', '--max-old-space-size=4096 --use-openssl-ca', '--max-old-space-size=4096\t--require ./x.js', '--max-old-space-size=4096\n--require ./x.js', '--max-old-space-size=4096 "--require" ./x.js', "--max-old-space-size=4096 '--require ./x.js'", '--max-old-space-size=4096 \\--require', '--max-old-space-size=4096\0', '--max-old-space-size=4096x', '--max-old-space-size=x', '--max-old-space-size=', '--max-old-space-size=1234567', '--max-semi-space-size=12345', '--max-old-space-size=-1', '--max-old-space-size=4096 ', ' --max-old-space-size=4096', '--max-old-space-size=4096  --no-warnings', ' ', '--max_old_space_size=4096', '--MAX-OLD-SPACE-SIZE=4096', '--no-warnings=1', '--enable-source-maps-x', '--unknown-flag', '--max-old-space-size=４０９６'];


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

test('FU-1 r4: DNS, OpenSSL, PREFIX/DESTDIR and NODE_USE_ENV_PROXY variables stay foreign (isolated, path URL refused); a no-proxy setting alone or a NODE_OPTIONS of only allowlisted memory and warning flags is not; anything else in NODE_OPTIONS is', () => {
  for (const key of OUTSIDE) {
    assert.equal(runtimeCore.npmOutside({ HOME: '/h', [key]: 'x' }), true, `${key}: outside`);
    assert.equal(runtimeCore.npmForeign({ HOME: '/h', [key]: 'x' }), true, `${key}: foreign`);
    assert.equal(runtimeCore.npmForeign({ HOME: '/h', [key]: 'x', NO_PROXY: 'x' }), true, `${key} + NO_PROXY: still foreign`);
    assert.equal(runtimeCore.npmForeign({ HOME: '/h', [key]: 'x', NODE_OPTIONS: '--max-old-space-size=4096' }), true, `${key} + allowlisted NODE_OPTIONS: still foreign`);
  }
  for (const key of [...NO_PROXY_NAMES, 'npm_config_noproxy', 'NPM_CONFIG_NOPROXY', 'Npm_Config_NoProxy']) {
    assert.equal(runtimeCore.npmOutside({ HOME: '/h', [key]: 'example.invalid' }), false, `${key} alone: not outside`);
    assert.equal(runtimeCore.npmForeign({ HOME: '/h', [key]: 'example.invalid' }), false, `${key} alone: not foreign`);
    for (const other of [{ HTTP_PROXY: 'http://a/' }, { https_proxy: 'http://a/' }, { npm_config_proxy: 'http://a/' }, { NODE_EXTRA_CA_CERTS: '/tmp/x' }, { HOSTALIASES: '/tmp/x' }, { npm_config_strict_ssl: 'false' }, { npm_config_proxy: '' }, { npm_config_registry: 'http://r/${X}' }, { NODE_OPTIONS: '--use-openssl-ca' }]) {
      assert.equal(runtimeCore.npmForeign({ HOME: '/h', [key]: 'example.invalid', ...other }), true, `${key} + ${Object.keys(other)[0]}: foreign`);
      assert.equal(runtimeCore.npmOutside({ HOME: '/h', [key]: 'example.invalid', ...other }), runtimeCore.npmOutside({ HOME: '/h', ...other }), `${key} + ${Object.keys(other)[0]}: unchanged`);
    }
  }
  for (const bad of ['', 'x\r\n', 'x${X}', 'x'.repeat(2049)]) assert.equal(runtimeCore.npmForeign({ npm_config_noproxy: bad }), true, `a refused npm_config_noproxy ${JSON.stringify(bad.slice(0, 8))} stays foreign`);
  for (const value of NODE_OPTIONS_OK) {
    for (const key of ['NODE_OPTIONS', 'node_options']) {
      assert.equal(runtimeCore.npmOutside({ HOME: '/h', [key]: value }), false, `${key}=${JSON.stringify(value)}: not outside`);
      assert.equal(runtimeCore.npmForeign({ HOME: '/h', [key]: value }), false, `${key}=${JSON.stringify(value)}: not foreign`);
    }
  }
  assert.equal(runtimeCore.npmOutside({ NODE_OPTIONS: '' }), false, 'empty NODE_OPTIONS: not outside');
  for (const value of NODE_OPTIONS_BAD) {
    for (const key of ['NODE_OPTIONS', 'node_options', 'Node_Options']) {
      assert.equal(runtimeCore.npmOutside({ HOME: '/h', [key]: value }), true, `${key}=${JSON.stringify(value)}: outside`);
      assert.equal(runtimeCore.npmForeign({ HOME: '/h', [key]: value }), true, `${key}=${JSON.stringify(value)}: foreign`);
    }
  }
});

test('FU-1 end to end (real npm, capture servers, dummy token): no abuse row sends the owner\'s token to the attacker; the owner\'s mirror, proxy and auth work as before; a project .npmrc is never read', async () => {
  const ctx = setup();
  try {
    // The rows are independent, so they run side by side (support/npm-auth-rows.js runRows); the checks
    // below are the same, per row, in row order.
    const rows = ROWS.filter((row) => !row.tls || ctx.tls);
    const results = await runRows(ctx, rows);
    for (const [index, row] of rows.entries()) {
      const result = results[index];
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
      if (/^A16/.test(row.id)) assert.equal(result.mirror.token_hits, 0, `${row.id}: the path or query token is never written or sent`);
      if (['L2', 'NP1', 'O1'].includes(row.id)) assert.ok(result.mirror.token_hits > 0, `${row.id}: owner mode, the mirror that requires auth gets the owner auth`);
      if (['V2', 'NP2', 'O3', 'O3t', 'O4'].includes(row.id)) assert.equal(result.mirror.token_hits, 0, `${row.id}: isolated or path refused: the owner auth or path token is never sent`);
      if (row.id === 'L5') assert.ok(result.mirror.token_hits > 0, 'L5: owner mode sends the path token to the owner mirror, as master');
      if (['N1', 'N5'].includes(row.id)) assert.equal(result.mirror.token_hits, 0, `${row.id}: userinfo is never written or sent`);
      if (['A3', 'A4', 'A5'].includes(row.id)) assert.equal(result.genuine, true, `${row.id}: the env network works, without auth; the pins decide`);
    }
  } finally {
    fs.rmSync(ctx.work, { recursive: true, force: true });
  }
});

// FU-1 F2: npm runs under spawnSync, which blocks the event loop, so a signal handler cannot run
// until npm returns (and removing it afterwards would swallow the signal). The private config is
// therefore not removed on SIGTERM; the file holds only scheme://host[:port]/ URLs, and a later
// install removes a stale `<stage>-npmrc` directory with its stage.
test('FU-1 F2: a stale private <stage>-npmrc directory left by a killed install is removed by the next install; a fresh one is kept', () => {
  const os = require('node:os');
  const path = require('node:path');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-fu1-stale-'));
  try {
    const root = path.join(home, '.marrow', 'runtime', 'mcp');
    fs.mkdirSync(root, { recursive: true });
    const stale = path.join(root, '.stage-0.0.1-1-aaaa-npmrc');
    const fresh = path.join(root, '.stage-0.0.1-2-bbbb-npmrc');
    for (const dir of [stale, fresh]) {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'user'), 'registry=https://mirror.example.test/\n');
    }
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(stale, old, old);
    const removed = runtimeCore.removeOtherRuntimes(home, '9.9.9');
    assert.deepEqual(removed, ['.stage-0.0.1-1-aaaa-npmrc']);
    assert.equal(fs.existsSync(stale), false);
    assert.equal(fs.existsSync(fresh), true);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

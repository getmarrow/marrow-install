// FU-1 rows: does the owner's npm auth reach a proxy or registry that the project chose through
// the hook's environment or a project .npmrc? Shared by test/runtime-npm-auth.test.js (head) and
// the audit harness (head against master's npx form). Real npm, a capture server per role, stand-in
// @getmarrow/mcp and @getmarrow/sdk tarballs built here, and a dummy token made at runtime that is
// written only into throwaway HOMEs and never printed.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const PINS = require('../../src/pins');
const { localizeHookCommand, runtimeCore } = require('../../src/mcp-runtime');

const PIN = PINS.MCP_ADAPTER_VERSION;
const SDK = PINS.SDK_ADAPTER_VERSION;
const CAPTURE = path.join(__dirname, 'capture-server.js');
const EVENT = '{"tool_name":"Bash","tool_input":{"command":"rm -rf ~/important"}}';
const GENUINE_CLI = '#!/usr/bin/env node\nrequire(\'@getmarrow/sdk\');\nprocess.stdin.resume();\nprocess.stdin.on(\'end\', () => process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: \'PreToolUse\', permissionDecision: \'deny\' }, genuine: true })));\n';

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
}

function pack(work, label, manifest, files) {
  const dir = path.join(work, `pkg-${label}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(manifest));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text, { mode: 0o755 });
  }
  const out = path.join(work, `out-${label}`);
  fs.mkdirSync(out);
  const npm = runtimeCore.npmInvocation();
  const packed = spawnSync(npm.file, [...npm.args, 'pack', dir, '--pack-destination', out, '--ignore-scripts', '--loglevel=error'], { cwd: out, encoding: 'utf8', env: { HOME: work, PATH: process.env.PATH, npm_config_cache: path.join(work, 'pack-cache') } });
  if (packed.status !== 0) throw new Error(`npm pack failed for ${label}`);
  const tarball = path.join(out, fs.readdirSync(out).find((name) => name.endsWith('.tgz')));
  const manifestPath = path.join(work, `manifest-${label}.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  return { tarball, manifest: manifestPath, integrity: `sha512-${crypto.createHash('sha512').update(fs.readFileSync(tarball)).digest('base64')}` };
}

// A throwaway CA and a certificate for registry.npmjs.org signed by it: the attacker's
// TLS-intercepting proxy, trusted only when a row hands npm the CA. Null without openssl.
function certificates(work) {
  const dir = path.join(work, 'tls');
  fs.mkdirSync(dir, { mode: 0o700 });
  const run = (args) => spawnSync('openssl', args, { cwd: dir, stdio: 'ignore' }).status === 0;
  fs.writeFileSync(path.join(dir, 'ext'), 'subjectAltName=DNS:registry.npmjs.org\n');
  const ok = run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=marrow-test-ca'])
    && run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=registry.npmjs.org'])
    && run(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'leaf.pem', '-days', '2', '-extfile', 'ext']);
  return ok ? { ca: path.join(dir, 'ca.pem'), key: path.join(dir, 'leaf.key'), cert: path.join(dir, 'leaf.pem') } : null;
}

function setup() {
  const work = tempDir('marrow-fu1-work-');
  const manifest = { name: '@getmarrow/mcp', version: PIN, bin: { 'marrow-mcp': 'dist/cli.js' }, dependencies: { '@getmarrow/sdk': `^${SDK}` } };
  const mcp = pack(work, 'mcp', manifest, { 'dist/cli.js': GENUINE_CLI });
  const sdk = pack(work, 'sdk', { name: '@getmarrow/sdk', version: SDK, main: 'index.js' }, { 'index.js': 'module.exports = {};\n' });
  return { work, mcp, sdk, tls: certificates(work), packages: { '@getmarrow/mcp': { [PIN]: mcp }, '@getmarrow/sdk': { [SDK]: sdk } }, token: 'gf' + crypto.randomBytes(18).toString('hex') };
}

let captureSerial = 0;
async function startCapture(ctx, label, extra = {}) {
  const config = path.join(ctx.work, `capture-${label}-${process.pid}-${captureSerial += 1}.json`);
  const counts = `${config}.counts`;
  fs.writeFileSync(config, JSON.stringify({ packages: ctx.packages, ...(ctx.tls ? { key: ctx.tls.key, cert: ctx.tls.cert } : {}), ...extra }));
  const child = spawn(process.execPath, [CAPTURE, config, counts], { stdio: ['ignore', 'pipe', 'inherit'], env: { PATH: process.env.PATH, MARROW_CAPTURE_TOKEN: ctx.token } });
  const port = await new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('\n')) resolve(Number(out.trim()));
    });
    child.on('error', reject);
  });
  return { port, url: `http://127.0.0.1:${port}/`, counts: () => JSON.parse(fs.readFileSync(counts, 'utf8')), stop: () => child.kill() };
}

// Each row: the owner's ~/.npmrc, the project's .npmrc, extra files, and the hook env. `m` is the
// owner's own mirror (auth for it in ~/.npmrc), `a` the attacker; `t` the dummy token. `local`
// rows also get a dead HTTPS_PROXY on head only: the owner URL is refused there, so head falls back
// to npm's default https registry, which must not be the real one. Master (npx) never needs it.
const BASE = ({ home }) => `cache=${path.join(home, '.npm-cache')}\nfetch-retries=0\nfetch-timeout=5000\n`;
const MIRROR = (c) => `registry=${c.m.url}\n//127.0.0.1:${c.m.port}/:_authToken=${c.t}\n${BASE(c)}`;
const NPMJS = (c) => `//registry.npmjs.org/:_authToken=${c.t}\n${BASE(c)}`;
const ROWS = [
  { id: 'L0', what: 'legit: no overrides, owner mirror with auth in ~/.npmrc', legit: true, user: MIRROR },
  { id: 'L1', what: 'legit: owner mirror and owner proxy, both in ~/.npmrc', legit: true, user: (c) => `${MIRROR(c)}proxy=${c.p.url}\n` },
  { id: 'L2', what: 'legit: ~/.npmrc auth value ${NPM_TOKEN}, NPM_TOKEN in env, owner mirror requires auth (401 without it)', legit: true, authMirror: true, user: (c) => `registry=${c.m.url}\n//127.0.0.1:${c.m.port}/:_authToken=\${NPM_TOKEN}\n${BASE(c)}`, env: (c) => ({ NPM_TOKEN: c.t }) },
  { id: 'A1', what: 'env npm_config_proxy = attacker', user: MIRROR, env: (c) => ({ npm_config_proxy: c.a.url }) },
  { id: 'A2', what: 'env HTTP_PROXY = attacker (plain)', user: MIRROR, env: (c) => ({ HTTP_PROXY: c.a.url }) },
  { id: 'A2b', what: 'env Http_Proxy (mixed case) = attacker, NO_PROXY empty', user: MIRROR, env: (c) => ({ Http_Proxy: c.a.url, NO_PROXY: '' }) },
  { id: 'A2c', what: 'env plain proxy = attacker + npm_config_noproxy=localhost', user: MIRROR, env: (c) => ({ proxy: c.a.url, npm_config_noproxy: 'localhost' }) },
  { id: 'A3', what: 'env npm_config_https_proxy = attacker + npm_config_cafile = attacker CA', tls: true, user: NPMJS, env: (c) => ({ npm_config_https_proxy: c.a.url, npm_config_cafile: c.tls.ca }) },
  { id: 'A3b', what: 'env NPM_CONFIG_HTTPS-PROXY + npm_config_ca (inline PEM)', tls: true, user: NPMJS, env: (c) => ({ 'NPM_CONFIG_HTTPS-PROXY': c.a.url, npm_config_ca: fs.readFileSync(c.tls.ca, 'utf8').trim().replace(/\n/g, '\\n') }) },
  { id: 'A4', what: 'env HTTPS_PROXY + NODE_EXTRA_CA_CERTS = attacker CA', tls: true, user: NPMJS, env: (c) => ({ HTTPS_PROXY: c.a.url, NODE_EXTRA_CA_CERTS: c.tls.ca }) },
  { id: 'A5', what: 'env npm_config_registry = attacker', user: MIRROR, env: (c) => ({ npm_config_registry: c.a.url }) },
  { id: 'A5b', what: 'env npm_config_registry = attacker, owner auth unscoped in ~/.npmrc', user: (c) => `_authToken=${c.t}\n${MIRROR(c)}`, env: (c) => ({ npm_config_registry: c.a.url }) },
  { id: 'A6', what: 'env npm_config_@getmarrow:registry = attacker', user: MIRROR, env: (c) => ({ 'npm_config_@getmarrow:registry': c.a.url }) },
  { id: 'A7', what: 'project .npmrc proxy = attacker', user: MIRROR, project: (c) => `proxy=${c.a.url}\n` },
  { id: 'A7b', what: 'project .npmrc registry = attacker', user: MIRROR, project: (c) => `registry=${c.a.url}\n` },
  { id: 'A7c', what: 'project .npmrc registry=https npmjs + https-proxy = attacker + cafile = attacker CA', tls: true, user: (c) => `${MIRROR(c)}//registry.npmjs.org/:_authToken=${c.t}\n`, project: (c) => `registry=https://registry.npmjs.org/\nhttps-proxy=${c.a.url}\ncafile=${c.tls.ca}\n` },
  { id: 'A8', what: 'env npm_config_userconfig = attacker file (proxy, ${NPM_TOKEN} auth)', user: (c) => `registry=${c.m.url}\n//127.0.0.1:${c.m.port}/:_authToken=\${NPM_TOKEN}\n${BASE(c)}`, files: (c) => ({ 'evil.npmrc': `registry=${c.m.url}\nproxy=${c.a.url}\n//127.0.0.1:${c.m.port}/:_authToken=\${NPM_TOKEN}\n${BASE(c)}` }), env: (c) => ({ npm_config_userconfig: path.join(c.root, 'evil.npmrc'), NPM_TOKEN: c.t }) },
  { id: 'A9', what: 'env NPM_CONFIG_GLOBALCONFIG = attacker file (proxy)', user: MIRROR, files: (c) => ({ 'evil-global.npmrc': `proxy=${c.a.url}\n` }), env: (c) => ({ NPM_CONFIG_GLOBALCONFIG: path.join(c.root, 'evil-global.npmrc') }) },
  { id: 'A10', what: 'auth in env npm_config__authToken + env proxy = attacker', user: (c) => `registry=${c.m.url}\n${BASE(c)}`, env: (c) => ({ npm_config__authToken: c.t, npm_config_proxy: c.a.url }) },
  { id: 'A10b', what: 'auth in env NPM_CONFIG_//host/:_authToken + env proxy = attacker', user: (c) => `registry=${c.m.url}\n${BASE(c)}`, env: (c) => ({ [`NPM_CONFIG_//127.0.0.1:${c.m.port}/:_authToken`]: c.t, npm_config_proxy: c.a.url }) },
  { id: 'A10c', what: 'auth in env Npm_Config_//host/:_AuthToken (mixed) + env Proxy = attacker', user: (c) => `registry=${c.m.url}\n${BASE(c)}`, env: (c) => ({ [`Npm_Config_//127.0.0.1:${c.m.port}/:_AuthToken`]: c.t, Npm_Config_Proxy: c.a.url }) },
  { id: 'A11', what: 'env npm_config_proxy = attacker followed by CRLF', user: MIRROR, env: (c) => ({ npm_config_proxy: `${c.a.url}\r\n` }) },
  { id: 'A12', what: 'env npm_config_strict_ssl=false + https-proxy = attacker (no CA)', tls: true, user: NPMJS, env: (c) => ({ npm_config_strict_ssl: 'false', npm_config_https_proxy: c.a.url }) },
  { id: 'A12b', what: 'env NODE_TLS_REJECT_UNAUTHORIZED=0 + HTTPS_PROXY = attacker (no CA)', tls: true, user: NPMJS, env: (c) => ({ NODE_TLS_REJECT_UNAUTHORIZED: '0', HTTPS_PROXY: c.a.url }) },
  { id: 'A13', what: 'project .npmrc userconfig = attacker file (proxy, ${NPM_TOKEN} auth)', user: (c) => `registry=${c.m.url}\n//127.0.0.1:${c.m.port}/:_authToken=\${NPM_TOKEN}\n${BASE(c)}`, files: (c) => ({ 'evil.npmrc': `registry=${c.m.url}\nproxy=${c.a.url}\n//127.0.0.1:${c.m.port}/:_authToken=\${NPM_TOKEN}\n${BASE(c)}` }), project: (c) => `userconfig=${path.join(c.root, 'evil.npmrc')}\n`, env: (c) => ({ NPM_TOKEN: c.t }) },
  { id: 'A14', what: '~/.npmrc proxy=${MARROW_P}, env MARROW_P = attacker', user: (c) => `${MIRROR(c)}proxy=\${MARROW_P}\n`, env: (c) => ({ MARROW_P: c.a.url }) },
  { id: 'A15', what: 'env PREFIX = project dir whose etc/npmrc names proxy = attacker', user: MIRROR, files: (c) => ({ 'etc/npmrc': `proxy=${c.a.url}\n` }), env: (c) => ({ PREFIX: c.root }) },
  { local: true, id: 'A16', what: 'owner registry URL path carries the token + env HTTP_PROXY = attacker', user: (c) => `registry=http://127.0.0.1:${c.m.port}/${c.t}/\n${BASE(c)}`, env: (c) => ({ HTTP_PROXY: c.a.url }) },
  { id: 'A16h', what: 'https owner registry URL path carries the token + env HTTPS_PROXY = attacker + env cafile = attacker CA', tls: true, user: (c) => `registry=https://registry.npmjs.org/${c.t}/\n${BASE(c)}`, env: (c) => ({ HTTPS_PROXY: c.a.url, npm_config_cafile: c.tls.ca }) },
  { local: true, id: 'A16q', what: 'owner registry URL query carries the token + env HTTP_PROXY = attacker', user: (c) => `registry=http://127.0.0.1:${c.m.port}/?token=${c.t}\n${BASE(c)}`, env: (c) => ({ HTTP_PROXY: c.a.url }) },
  { local: true, id: 'A16p', what: 'control: plain owner registry path, no secret in it, + env HTTP_PROXY = attacker', user: (c) => `registry=http://127.0.0.1:${c.m.port}/team/\n${BASE(c)}`, env: (c) => ({ HTTP_PROXY: c.a.url }) },
  { local: true, id: 'A16s', what: 'owner registry URL path is * (a redaction-shaped value) + env HTTP_PROXY = attacker', user: (c) => `registry=http://127.0.0.1:${c.m.port}/*/\n${BASE(c)}`, env: (c) => ({ HTTP_PROXY: c.a.url }) },
  { id: 'L5', what: 'legit: owner path-token registry, nothing from outside (owner mode, as master)', legit: true, user: (c) => `registry=http://127.0.0.1:${c.m.port}/${c.t}/\n${BASE(c)}` },
  { id: 'N1', what: 'owner registry URL has userinfo carrying the token + env proxy = attacker', user: (c) => `registry=http://owner:${c.t}@127.0.0.1:${c.m.port}/\n${BASE(c)}`, env: (c) => ({ npm_config_proxy: c.a.url }) },
  { local: true, id: 'N2', what: 'owner registry URL is ${MARROW_R}, env MARROW_R = attacker (auth for the attacker host in ~/.npmrc)', user: (c) => `registry=\${MARROW_R}\n//127.0.0.1:${c.a.port}/:_authToken=${c.t}\n${BASE(c)}`, env: (c) => ({ MARROW_R: c.a.url }) },
  { id: 'N3', what: 'owner registry is a host the env proxy also controls (attacker), owner auth for it in ~/.npmrc, env proxy = attacker', user: (c) => `registry=${c.a.url}\n//127.0.0.1:${c.a.port}/:_authToken=${c.t}\n${BASE(c)}`, env: (c) => ({ npm_config_proxy: c.a.url }) },
  { id: 'N4', what: 'env npm_config_registry = attacker while the owner has a mirror (env wins by npm precedence, as on master; no owner auth anywhere)', user: MIRROR, env: (c) => ({ npm_config_registry: c.a.url }) },
  { id: 'N5', what: 'owner scoped @getmarrow:registry URL with userinfo + env proxy = attacker', user: (c) => `registry=${c.m.url}\n@getmarrow:registry=http://u:${c.t}@127.0.0.1:${c.m.port}/\n${BASE(c)}`, env: (c) => ({ npm_config_proxy: c.a.url }) },
  // FU-1 r4: ${VAR} auth, no-proxy and NODE_OPTIONS rows. The env var names here are what the project controls.
  { local: true, id: 'V1', what: 'owner registry and auth key host are ${MARROW_MH}, env MARROW_MH = attacker', user: (c) => `registry=http://\${MARROW_MH}/x/\n//\${MARROW_MH}/x/:_authToken=${c.t}\n${BASE(c)}`, env: (c) => ({ MARROW_MH: `127.0.0.1:${c.a.port}` }) },
  { id: 'V2', what: 'owner registry is the mirror root; auth for the mirror and for //${MARROW_MH}/ (env = attacker): isolated, so the mirror gets no auth either', user: (c) => `registry=${c.m.url}\n//127.0.0.1:${c.m.port}/:_authToken=${c.t}\n//\${MARROW_MH}/:_authToken=${c.t}\n${BASE(c)}`, env: (c) => ({ MARROW_MH: `127.0.0.1:${c.a.port}` }) },
  { id: 'V3', what: '~/.npmrc auth ${NPM_TOKEN} + env HTTP_PROXY = attacker', user: (c) => `registry=${c.m.url}\n//127.0.0.1:${c.m.port}/:_authToken=\${NPM_TOKEN}\n${BASE(c)}`, env: (c) => ({ NPM_TOKEN: c.t, HTTP_PROXY: c.a.url }) },
  { id: 'V4', what: '~/.npmrc auth ${NPM_TOKEN}, the project sets NPM_TOKEN to another dummy: only the owner mirror can get it', legit: true, user: (c) => `registry=${c.m.url}\n//127.0.0.1:${c.m.port}/:_authToken=\${NPM_TOKEN}\n${BASE(c)}`, env: () => ({ NPM_TOKEN: 'gf' + crypto.randomBytes(18).toString('hex') }) },
  { id: 'NP1', what: 'legit: NO_PROXY alone + owner path mirror that requires auth', legit: true, authMirror: true, user: (c) => `registry=http://127.0.0.1:${c.m.port}/team/\n//127.0.0.1:${c.m.port}/:_authToken=${c.t}\n${BASE(c)}`, env: () => ({ NO_PROXY: 'example.invalid', no_proxy: 'example.invalid', npm_config_noproxy: 'example.invalid' }) },
  { local: true, id: 'NP2', what: 'NO_PROXY + HTTP_PROXY = attacker, owner path-token mirror', user: (c) => `registry=http://127.0.0.1:${c.m.port}/${c.t}/\n${BASE(c)}`, env: (c) => ({ NO_PROXY: 'example.invalid', HTTP_PROXY: c.a.url }) },
  { id: 'O1', what: 'legit: NODE_OPTIONS=--max-old-space-size=4096 alone + owner path mirror that requires auth', legit: true, authMirror: true, user: (c) => `registry=http://127.0.0.1:${c.m.port}/team/\n//127.0.0.1:${c.m.port}/:_authToken=${c.t}\n${BASE(c)}`, env: () => ({ NODE_OPTIONS: '--max-old-space-size=4096' }) },
  { id: 'O2', what: 'NODE_OPTIONS=--max-old-space-size=4096 --use-openssl-ca + SSL_CERT_FILE = attacker CA + HTTPS_PROXY = attacker', tls: true, user: NPMJS, env: (c) => ({ NODE_OPTIONS: '--max-old-space-size=4096 --use-openssl-ca', SSL_CERT_FILE: c.tls.ca, HTTPS_PROXY: c.a.url }) },
  { local: true, id: 'O3', what: 'NODE_OPTIONS=--max-old-space-size=4096 --require <project file> + owner path-token mirror', user: (c) => `registry=http://127.0.0.1:${c.m.port}/${c.t}/\n${BASE(c)}`, files: () => ({ 'x.js': '' }), env: (c) => ({ NODE_OPTIONS: `--max-old-space-size=4096 --require ${path.join(c.root, 'x.js')}` }) },
  { local: true, id: 'O3t', what: 'NODE_OPTIONS with a tab before --require + owner path-token mirror', user: (c) => `registry=http://127.0.0.1:${c.m.port}/${c.t}/\n${BASE(c)}`, files: () => ({ 'x.js': '' }), env: (c) => ({ NODE_OPTIONS: `--max-old-space-size=4096\t--require ${path.join(c.root, 'x.js')}` }) },
  { local: true, id: 'O4', what: 'NODE_OPTIONS=--max-old-space-size=4096 --trace-uncaught (not allowlisted) + owner path-token mirror', user: (c) => `registry=http://127.0.0.1:${c.m.port}/${c.t}/\n${BASE(c)}`, env: () => ({ NODE_OPTIONS: '--max-old-space-size=4096 --trace-uncaught' }) },
];

const hookFor = (ctx, sub = 'claude-pre-action-hook') => localizeHookCommand(`npx -y --package=@getmarrow/mcp@${PIN} marrow-mcp ${sub}`, PIN, { platform: 'linux', integrity: ctx.mcp.integrity, sdk: { version: SDK, integrity: ctx.sdk.integrity } });
const MASTER_HOOK = `npx -y --package=@getmarrow/mcp@${PIN} marrow-mcp claude-pre-action-hook`;

async function waitForHeal(home) {
  const root = path.join(home, '.marrow', 'runtime', 'mcp');
  for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
    if (!fs.existsSync(root) || !fs.readdirSync(root).some((name) => name.endsWith('.lock'))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// The hook runs as an async child, not spawnSync: spawnSync blocks the event loop, so rows could
// never overlap. Same shell, argv, cwd, env, stdin, 90 s timeout, latin1 text and exit status.
function runShell(shell, command, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ['-c', command], { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'], timeout: options.timeout });
    const chunks = { stdout: [], stderr: [] };
    child.stdout.on('data', (chunk) => chunks.stdout.push(chunk));
    child.stderr.on('data', (chunk) => chunks.stderr.push(chunk));
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout: Buffer.concat(chunks.stdout).toString('latin1'), stderr: Buffer.concat(chunks.stderr).toString('latin1') }));
  });
}

// Runs one row with `command` (default: head's localized hook) and returns counts only.
async function runRow(ctx, row, command) {
  const home = tempDir('marrow-fu1-home-');
  const root = tempDir('marrow-fu1-project-');
  const servers = { m: await startCapture(ctx, 'mirror', row.authMirror ? { requireAuth: true } : {}), a: await startCapture(ctx, 'attacker'), p: await startCapture(ctx, 'ownproxy') };
  try {
    const c = { ...servers, t: ctx.token, tls: ctx.tls, home, root };
    fs.writeFileSync(path.join(home, '.npmrc'), row.user(c), { mode: 0o600 });
    if (row.project) fs.writeFileSync(path.join(root, '.npmrc'), row.project(c));
    for (const [name, text] of Object.entries(row.files ? row.files(c) : {})) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), text);
    }
    const env = { HOME: home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, ...(row.local && !command ? { HTTPS_PROXY: 'http://127.0.0.1:9' } : {}), ...(row.env ? row.env(c) : {}) };
    // dash drops env names that are not shell identifiers (npm_config_@scope:registry, NPM_CONFIG_HTTPS-PROXY, NPM_CONFIG_//host/:_authToken); bash passes them on, as the user's shell or a host can.
    const shell = Object.keys(env).every((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) ? '/bin/sh' : '/bin/bash';
    const result = await runShell(shell, command || hookFor(ctx), { cwd: root, env, input: EVENT, timeout: 90_000 });
    await waitForHeal(home);
    const leaked = [result.stdout, result.stderr].filter((text) => String(text || '').includes(ctx.token)).length;
    return {
      id: row.id,
      status: result.status,
      genuine: /"genuine":true/.test(result.stdout || ''),
      attacker: servers.a.counts(),
      mirror: servers.m.counts(),
      ownproxy: servers.p.counts(),
      token_in_output: leaked,
      runtime_dirs: fs.existsSync(path.join(home, '.marrow', 'runtime', 'mcp')) ? fs.readdirSync(path.join(home, '.marrow', 'runtime', 'mcp')).filter((name) => /npmrc/.test(name)).length : 0,
    };
  } finally {
    for (const server of Object.values(servers)) server.stop();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// Rows share nothing writable (each has its own HOME, project folder, capture servers on port 0,
// lock and npm cache; ctx is read only), and most of a row is waiting on npm, so a bounded pool runs
// them side by side. Results come back in `rows` order and every row still runs: a row that could
// not run is reported after the others finish, so none is left running into the caller's cleanup.
// A hint for the start order only: these rows end in a refused install that runs to the runtime's
// own 30 s npm limit (measured), so they start first and the pool does not need a second wave for
// them. A stale entry changes the time a run takes, never what it checks.
const SLOW_ROWS = new Set(['A3b', 'A12', 'A12b', 'A16', 'A16p', 'A16q', 'A16s', 'N1', 'N2', 'N5', 'V1', 'NP2', 'O3', 'O4']);
const CPUS = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
const ROW_CONCURRENCY = Math.max(4, Math.min(16, CPUS * 4));
async function runRows(ctx, rows, concurrency = ROW_CONCURRENCY) {
  const results = new Array(rows.length);
  const failures = [];
  const order = rows.map((row, index) => index).sort((a, b) => Number(SLOW_ROWS.has(rows[b].id)) - Number(SLOW_ROWS.has(rows[a].id)) || a - b);
  let next = 0;
  const worker = async () => {
    while (next < order.length) {
      const index = order[next];
      next += 1;
      try {
        results[index] = await runRow(ctx, rows[index]);
      } catch (error) {
        failures.push(`${rows[index].id}: ${error && error.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, rows.length) }, worker));
  if (failures.length) throw new Error(`rows that could not run: ${failures.join('; ')}`);
  return results;
}

module.exports = { MASTER_HOOK, PIN, ROWS, hookFor, runRow, runRows, setup, tempDir };

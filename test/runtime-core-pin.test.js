require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');
const PINS = require('../src/pins');
const { launcherSource, mcpServerLaunch, runtimeConfig } = require('../src/mcp-runtime');
const host = require('./support/mcp-host');

// src/runtime-core.js is the code every written hook and MCP server entry runs first (the loader embeds
// it). @getmarrow/mcp decides that a `marrow` server entry written by this installer is the official
// one only when the SHA-256 of that embedded core is on its own list, INSTALLER_RUNTIME_CORE_SHA256
// (marrow-mcp src/own-server-identity.ts:377 at 038cf8d9). A changed core is therefore a changed
// security input: Cursor's guard, Codex hooks and every installer-written server entry would stop
// being proven (own tools held), or, worse, a core the MCP does not know would run unproven.
//
// These constants fail on ANY change to src/runtime-core.js. To change the file:
//   1. add the new core's SHA-256 (RUNTIME_CORE_SOURCE_SHA256 below) to INSTALLER_RUNTIME_CORE_SHA256
//      in marrow-mcp and release that MCP first;
//   2. re-vendor test/fixtures/mcp-* from it and set the constants here.
const RUNTIME_CORE_FILE_SHA256 = '5d6eb93bef4d5318f2853f89291f1cb7b61a1f714049c6e2703efc2fa152283c';
const RUNTIME_CORE_SOURCE_SHA256 = '73ea57796c017abfd144b43f3b91c9c935314c156ba523cbca525ebc1f977cb0';
const CHANGE_MESSAGE = 'src/runtime-core.js changed: its SHA-256 must first be added to @getmarrow/mcp INSTALLER_RUNTIME_CORE_SHA256 '
  + '(src/own-server-identity.ts) and that MCP released and re-vendored (test/fixtures/mcp-*); only then update the constants in this test';

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// The embedded core, taken from a real loader the way the MCP takes it (installerLoaderFor).
const LOADER_HEAD = "'use strict';\nconst CFG = ";
const LOADER_TAIL = ')().main(CFG, global.MARROW_L);\n';
function decodeLoader(loader) {
  const match = /\/([A-Za-z0-9_-]{16,16000})\/\.source,\/base64url\/\.source/.exec(loader);
  assert.ok(match, 'the loader embeds its source as base64url');
  const source = zlib.brotliDecompressSync(Buffer.from(match[1], 'base64url')).toString('utf8');
  assert.equal(source.startsWith(LOADER_HEAD), true);
  const lineEnd = source.indexOf('\n', LOADER_HEAD.length);
  const body = source.slice(lineEnd + 1);
  assert.equal(body.startsWith('('), true);
  assert.equal(body.endsWith(LOADER_TAIL), true);
  return { source, head: source.slice(0, lineEnd + 1), core: body.slice(1, -LOADER_TAIL.length) };
}
function encodeLoader(source) {
  const packed = zlib.brotliCompressSync(Buffer.from(source), {
    params: { [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT, [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
  }).toString('base64url');
  return `eval(global.MARROW_L=require(/node:zlib/.source).brotliDecompressSync(Buffer.from(/${packed}/.source,/base64url/.source))+[])`;
}

test('runtime-core.js is pinned: any change fails here until the MCP list carries the new core hash', () => {
  const file = fs.readFileSync(path.join(__dirname, '..', 'src', 'runtime-core.js'));
  assert.equal(sha256(file), RUNTIME_CORE_FILE_SHA256, CHANGE_MESSAGE);
  const launch = mcpServerLaunch(PINS.MCP_ADAPTER_VERSION, { platform: 'linux' });
  const { core } = decodeLoader(launch.args[2]);
  assert.equal(sha256(core), RUNTIME_CORE_SOURCE_SHA256, CHANGE_MESSAGE);
});

test('the embedded core hash is on the pinned MCP list (INSTALLER_RUNTIME_CORE_SHA256), read from the vendored dist', () => {
  const text = fs.readFileSync(path.join(host.MCP_FIXTURES, 'own-server-identity.js'), 'utf8');
  const match = /const INSTALLER_RUNTIME_CORE_SHA256 = new Set\(\[([^\]]*)\]\)/.exec(text);
  assert.ok(match, 'the vendored own-server-identity.js carries the list');
  const listed = [...match[1].matchAll(/'([0-9a-f]{64})'/g)].map((item) => item[1]);
  assert.ok(listed.length >= 1);
  assert.equal(listed.includes(RUNTIME_CORE_SOURCE_SHA256), true, `${CHANGE_MESSAGE} (not on the vendored list)`);
  const launch = mcpServerLaunch(PINS.MCP_ADAPTER_VERSION, { platform: 'linux' });
  assert.equal(listed.includes(sha256(decodeLoader(launch.args[2]).core)), true, 'the core a loader embeds today is on the list');
});

test('the real MCP proves the pinned installer launch when its own loader started the hook (never a 3.9.102 launch, which carries no integrity), and rejects a loader whose core differs by one byte', () => {
  // Since MCP 3.9.106 a launch is proven only against the loader that started the hook, and only with a pack integrity: the
  // pin's loader proves the pin's launch; a 3.9.102 launch (no integrity pinned for it) is proven under no loader.
  const pinned = mcpServerLaunch(PINS.MCP_ADAPTER_VERSION, { platform: 'linux' });
  assert.equal(host.identity.isOfficialMarrowServerLaunch(pinned.command, pinned.args, launcherSource(runtimeConfig(PINS.MCP_ADAPTER_VERSION))), true, PINS.MCP_ADAPTER_VERSION);
  const old = mcpServerLaunch('3.9.102', { platform: 'linux' });
  assert.equal(host.identity.isOfficialMarrowServerLaunch(old.command, old.args, launcherSource(runtimeConfig('3.9.102'))), false, '3.9.102 under its own loader');
  assert.equal(host.identity.isOfficialMarrowServerLaunch(old.command, old.args, host.PINNED_LAUNCHER), false, '3.9.102 under the pinned loader');
  const launch = mcpServerLaunch(PINS.MCP_ADAPTER_VERSION, { platform: 'linux' });
  const decoded = decodeLoader(launch.args[2]);
  // The same code, recompressed: proven (the MCP compares content, not compressed bytes).
  const same = [...launch.args];
  same[2] = encodeLoader(decoded.source);
  assert.equal(host.identity.isOfficialMarrowServerLaunch(launch.command, same, host.PINNED_LAUNCHER), true, 'recompressed');
  // One byte more in the core (or one changed): not on the list, so the entry is not proven.
  for (const core of [`${decoded.core} `, decoded.core.replace("require('node:fs')", "require('fs')"), `${decoded.core}\n`]) {
    assert.notEqual(core, decoded.core);
    const tampered = [...launch.args];
    tampered[2] = encodeLoader(`${decoded.head}(${core}${LOADER_TAIL}`);
    assert.equal(host.identity.isOfficialMarrowServerLaunch(launch.command, tampered, host.PINNED_LAUNCHER), false, JSON.stringify(core.slice(-12)));
  }
  // The shipped core is not simply any text: a different version in the config is not proven either.
  const wrongVersion = [...launch.args];
  wrongVersion[3] = '--package=@getmarrow/mcp@3.9.101';
  assert.equal(host.identity.isOfficialMarrowServerLaunch(launch.command, wrongVersion, host.PINNED_LAUNCHER), false);
});

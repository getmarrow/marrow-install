const { isolatedHome } = require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const PINS = require('../src/pins');
const installer = require('../src/installer');

// The MCP pin is @getmarrow/mcp 3.9.103, packed from marrow-mcp 868a9c18 (src/pins.js says how its
// integrity was computed, and that the release chain must re-verify it against the published
// tarball before this installer is published). The vendored dist/ the tests decide with is that
// build's, and every command and MCP entry the installer writes names that version.

const MCP_FIXTURES = path.join(__dirname, 'fixtures', 'mcp-3.9.103');
const EXPECTED = {
  version: '3.9.103',
  sourceSha: '868a9c18530a75fcee5052441d0d3d2383511df4',
  integrity: 'sha512-STXL6Zaiqv8Jh0wQpQpNut3bvj5ck0wNokwhy21Y7XuqNK55+MMgCkpYhFzIuVCiuGL2FR7NlytA3EmFlHdS6w==',
};
const PUBLISHED_0170_INTEGRITY = 'sha512-hTs4jTJmySLk8hHgsGIZksMo9+eO5kjQmU1EJyDX8Qqm9Z+V+yDkauop19roasVvOAFsK3dJjqLoIh7gRhoXJQ==';

test('src/pins.js pins @getmarrow/mcp 3.9.103 from marrow-mcp 868a9c18, not the 3.9.102 of the published 0.1.70', () => {
  assert.equal(PINS.MCP_ADAPTER_VERSION, EXPECTED.version);
  assert.equal(PINS.MCP_ADAPTER_SOURCE_SHA, EXPECTED.sourceSha);
  assert.equal(PINS.MCP_ADAPTER_INTEGRITY, EXPECTED.integrity);
  assert.notEqual(PINS.MCP_ADAPTER_INTEGRITY, PUBLISHED_0170_INTEGRITY);
  assert.notEqual(PINS.MCP_ADAPTER_VERSION, '3.9.102');
  // The host-approval layout and the SDK pin are untouched by this pin.
  assert.equal(PINS.MCP_HOST_APPROVAL_HOOKS_SINCE, '3.9.99');
  assert.equal(PINS.SDK_ADAPTER_VERSION, '3.7.65');
  // The note that tells the release chain what to verify is part of the pin.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'pins.js'), 'utf8');
  assert.match(source, /RE-VERIFY THIS PIN\s+\/\/ AGAINST THE PUBLISHED @getmarrow\/mcp@3\.9\.103 TARBALL BEFORE THIS INSTALLER IS PUBLISHED/);
});

test('the vendored 3.9.103 dist/ is the pinned build: its manifest names the pin, and every file is its recorded sha256', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(MCP_FIXTURES, 'MANIFEST.json'), 'utf8'));
  assert.equal(manifest.version, PINS.MCP_ADAPTER_VERSION);
  assert.equal(manifest.source_sha, PINS.MCP_ADAPTER_SOURCE_SHA);
  assert.equal(manifest.integrity, PINS.MCP_ADAPTER_INTEGRITY);
  assert.deepEqual(Object.keys(manifest.files).sort(), [
    'codex-plugin-pins.js', 'codex-plugins.js', 'host-session.js', 'model-usage.js', 'own-server-identity.js', 'own-tool.js', 'redact.js', 'tool-catalog.js',
  ]);
  for (const [name, info] of Object.entries(manifest.files)) {
    const bytes = fs.readFileSync(path.join(MCP_FIXTURES, name));
    assert.equal(bytes.length, info.bytes, `${name} size`);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), info.sha256, `${name} sha256`);
  }
});

test('every command and MCP entry the installer writes for Claude Code, Codex and Cursor names the pinned version, and none the old one', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-pin-'));
  try {
    const home = path.join(base, 'home');
    const root = path.join(base, 'project');
    fs.mkdirSync(home, { mode: 0o700 });
    for (const folder of ['.claude', '.codex', '.cursor']) fs.mkdirSync(path.join(root, folder), { recursive: true });
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Project\n');
    assert.notEqual(home, isolatedHome);
    const detection = installer.detectEnvironment(root, { HOME: home, PATH: process.env.PATH });
    installer.applyPlan(installer.buildPlan(detection, { mode: 'mcp' }), { yes: true, dryRun: false, doctor: false });
    const files = ['.claude/settings.json', '.codex/hooks.json', '.cursor/hooks.json', '.cursor/mcp.json', '.mcp.json'];
    for (const relative of files) {
      const text = fs.readFileSync(path.join(root, relative), 'utf8');
      assert.equal(text.includes('3.9.102'), false, `${relative} names no 3.9.102`);
      assert.equal(text.includes(`@getmarrow/mcp@${PINS.MCP_ADAPTER_VERSION}`), true, `${relative} names the pin`);
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

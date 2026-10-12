const { isolatedHome } = require('./support/isolated-environment');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const host = require('./support/mcp-host');

// The hermetic host fixtures the MCP-decision tests stand on (test/support/mcp-host.js): a
// temporary HOME and CODEX_HOME, a temporary project, no npm_config_* name, no real process
// ancestor, and everything restored afterwards.

test('the test process itself starts without npm_config_* names (npm test exports them; the isolated environment removes them)', () => {
  assert.deepEqual(Object.keys(process.env).filter((name) => /^npm_config_/i.test(name)), []);
});

test('withHost: HOME, CODEX_HOME, the working directory and npm_config_* are the fixture\'s inside, and restored outside', () => {
  const fixture = host.hostFixture('marrow-host-support-');
  try {
    const before = { home: process.env.HOME, cwd: process.cwd(), codex: process.env.CODEX_HOME };
    process.env.npm_config_marker = 'outside';
    process.env.CODEX_HOME = path.join(fixture.base, 'elsewhere');
    const inside = host.withHost(fixture, () => ({
      home: process.env.HOME,
      cwd: fs.realpathSync(process.cwd()),
      codex: process.env.CODEX_HOME,
      npm: Object.keys(process.env).filter((name) => /^npm_config_/i.test(name)),
    }), { env: { Npm_Config_Prefix: '/tmp/x' } });
    assert.equal(inside.home, fixture.home);
    assert.equal(inside.cwd, fs.realpathSync(fixture.root));
    assert.equal(inside.codex, undefined, 'CODEX_HOME is unset, so the fixture home\'s .codex is the one read');
    assert.deepEqual(inside.npm, ['Npm_Config_Prefix'], 'only what the case sets');
    assert.equal(process.env.HOME, before.home);
    assert.equal(process.cwd(), before.cwd);
    assert.equal(process.env.CODEX_HOME, path.join(fixture.base, 'elsewhere'));
    assert.equal(process.env.npm_config_marker, 'outside');
    assert.equal(process.env.Npm_Config_Prefix, undefined);
    delete process.env.npm_config_marker;
    if (before.codex === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = before.codex;
  } finally {
    fixture.cleanup();
  }
});

test('the fixtures never touch the operator\'s home: the temporary HOME is under the test temp root and holds only what a case writes', () => {
  const fixture = host.hostFixture('marrow-host-support-');
  try {
    assert.notEqual(fixture.home, isolatedHome);
    assert.equal(fixture.home.startsWith(path.dirname(fixture.base)), true);
    assert.deepEqual(fs.readdirSync(fixture.home).sort(), ['.codex']);
    assert.deepEqual(fs.readdirSync(fixture.root), []);
    // No config at all: nothing is proven, so no own tool is skipped (the safe default).
    assert.equal(host.codexSkips(fixture, 'mcp__marrow__marrow_commit')[0], false);
    assert.equal(host.cursorSkips(fixture, 'mcp__marrow__marrow_commit')[0], false);
    // The README npx form is proven in this fixture and in no other.
    fixture.codexToml(host.README_CODEX_TOML);
    assert.equal(host.codexSkips(fixture, 'mcp__marrow__marrow_commit')[0], true);
    const other = host.hostFixture('marrow-host-support-');
    try {
      assert.equal(host.codexSkips(other, 'mcp__marrow__marrow_commit')[0], false);
    } finally {
      other.cleanup();
    }
  } finally {
    fixture.cleanup();
  }
});

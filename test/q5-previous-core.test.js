// Q5 changes src/runtime-core.js, so the loader text changes. Hooks and server entries written by
// installers 0.1.70-0.1.73 carry the previous core: they must still read as Marrow's own (update and
// repair rewrite them, uninstall removes them), must never be kept as they are, and nothing but that
// exact previous core in the exact launcher layout may be recognized.
require('./support/isolated-environment');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const PINS = require('../src/pins');
const {
  delocalizeHookCommand,
  loaderConfig,
  loaderFor,
  localizeHookSettingsText,
  mapHookCommands,
  mcpServerLaunch,
  mcpServerLaunchVersion,
  runtimeConfig,
} = require('../src/mcp-runtime');

const FIXTURE = path.join(__dirname, 'fixtures', 'installer-0172', 'claude-settings.json');
const TAIL = ')().main(CFG, global.MARROW_L);\n';
const PACKED_RE = /\/([A-Za-z0-9_-]{16,16000})\/\.source,\/base64url\/\.source/;
const decode = (loader) => zlib.brotliDecompressSync(Buffer.from(PACKED_RE.exec(loader)[1], 'base64url')).toString('utf8');
const encode = (source) => `eval(global.MARROW_L=require(/node:zlib/.source).brotliDecompressSync(Buffer.from(/${zlib.brotliCompressSync(Buffer.from(source)).toString('base64url')}/.source,/base64url/.source))+[])`;
const loaderOf = (command) => command.match(/eval\(global\.MARROW_L=[^ "']+?\+\[\]\)/)[0];

function fixtureCommands() {
  const commands = [];
  mapHookCommands(JSON.parse(fs.readFileSync(FIXTURE, 'utf8')), (command) => { commands.push(command); return command; });
  return commands.filter((command) => command.includes('MARROW_L'));
}

test('previous core: every Marrow hook the 0.1.72 installer wrote still reads as Marrow\'s own (canonical form)', () => {
  const commands = fixtureCommands();
  assert.ok(commands.length >= 5);
  for (const command of commands) {
    assert.match(delocalizeHookCommand(command), /^npx -y --package=@getmarrow\/mcp@\d+\.\d+\.\d+ marrow-mcp [a-z-]+$/);
    assert.notEqual(decode(loaderOf(command)), decode(loaderFor(loaderConfig(loaderOf(command)))), 'the fixture really carries the previous core');
    assert.equal(loaderConfig(loaderOf(command), { current: true }), null, 'today-only check refuses it');
  }
});

test('previous core: a settings write never keeps a previous-core command; it is rewritten on today\'s core', () => {
  const previousText = fs.readFileSync(FIXTURE, 'utf8');
  const canonicalText = `${JSON.stringify(mapHookCommands(JSON.parse(previousText), delocalizeHookCommand), null, 2)}\n`;
  const old = fixtureCommands()[0];
  const cfg = loaderConfig(loaderOf(old));
  const written = localizeHookSettingsText(canonicalText, cfg.version, { platform: 'linux', integrity: cfg.integrity, sdk: cfg.sdk, previousText });
  const loaders = [...written.matchAll(/eval\(global\.MARROW_L=[^ "']+?\+\[\]\)/g)].map((match) => match[0]);
  assert.ok(loaders.length >= 5);
  for (const loader of loaders) assert.equal(decode(loader), decode(loaderFor(cfg)), 'every written loader is today\'s');
  assert.equal(written.includes(PACKED_RE.exec(loaderOf(old))[1]), false);
});

test('previous core: a core changed by one byte, extra code around it, or another layout is never recognized', () => {
  const old = fixtureCommands().find((command) => command.startsWith('/bin/sh -c'));
  const loader = loaderOf(old);
  const source = decode(loader);
  const head = source.slice(0, source.indexOf('\n(') + 2);
  const coreText = source.slice(head.length, source.length - TAIL.length);
  const variants = {
    'one byte appended to the core': `${head}${coreText} ${TAIL}`,
    'one call changed in the core': `${head}${coreText.replace("require('node:fs')", "require('fs')")}${TAIL}`,
    'code before the core': `${head.replace("'use strict';\n", "'use strict';require('fs');\n")}${coreText}${TAIL}`,
    'code after the call': `${head}${coreText}${TAIL}require('fs');\n`,
    'another tail': `${head}${coreText})().main(CFG, null);\n`,
    'no head': `(${coreText}${TAIL}`,
  };
  for (const [label, variant] of Object.entries(variants)) {
    assert.notEqual(variant, source, label);
    const tampered = encode(variant);
    assert.equal(loaderConfig(tampered), null, label);
    assert.equal(delocalizeHookCommand(old.split(loader).join(tampered)), old.split(loader).join(tampered), label);
  }
  // Recompressed with the same bytes: still recognized (content, not compressed bytes).
  assert.ok(loaderConfig(encode(source)));
});

test('previous core: an installer-written server entry on the previous core is still Marrow\'s (rewritten by update), on Linux and win32 layouts', () => {
  const old = fixtureCommands()[0];
  const cfg = loaderConfig(loaderOf(old));
  const previousLoader = loaderOf(old);
  for (const platform of ['linux', 'win32']) {
    const launch = mcpServerLaunch(cfg.version, { ...cfg, platform });
    const entry = { command: launch.command, args: launch.args.map((arg) => (arg.startsWith('eval(global.MARROW_L=') ? previousLoader : arg)) };
    assert.equal(mcpServerLaunchVersion(entry), cfg.version, platform);
  }
  assert.equal(PINS.MCP_ADAPTER_VERSION.length > 0, true);
});

'use strict';

// R2 (pinned exact matchers): a hook copy next to a plugin is removed only when the copy's PreToolUse matcher is
// byte-equal to a published installer matcher and the plugin hooks.json matcher is byte-equal to a published plugin
// matcher. Every other matcher on either side, one byte changed, wider, narrower or unknown, keeps the copy.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const OWN = require('../src/marrow-own-tools');
const { PUBLISHED_COPY_MATCHERS, PUBLISHED_PLUGIN_MATCHERS, PLUGIN_PRE_ACTION_LAUNCHERS } = require('../src/update-launchers');
const { REAL_PLUGIN_HOOKS_BLOB, REAL_PLUGIN_HOOKS_JSON, COPY_MATCHER, PLUGIN_MATCHER, PLUGIN_KEY, json, sha, fixture, cleanup } = require('./support/update-path-fixture');
const updatePath = () => require('../src/update-path');

const UPDATE_ARGV = [['plugin', 'marketplace', 'update', 'getmarrow'], ['plugin', 'update', PLUGIN_KEY, '-s', 'project', '-y']];
const exactCopies = (file) => {
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  return Object.entries(value.hooks || {}).flatMap(([event, groups]) => groups.flatMap((group) => group.hooks)
    .filter((hook) => updatePath().marrowHookVersion(event, hook)));
};
const regex = (matcher) => new RegExp(matcher);
const pinnedCopy = (matcher) => updatePath().publishedMatcher(PUBLISHED_COPY_MATCHERS, matcher);
const pinnedPlugin = (matcher) => updatePath().publishedMatcher(PUBLISHED_PLUGIN_MATCHERS, matcher);

// The tool names a pinned copy matcher can match, from the installer source: the Claude Code tools it names
// (src/marrow-own-tools.js and the earlier published copy matchers), Marrow's own tool names on any other server or
// label form, and padded or case-changed forms of the unhooked labels.
const BUILT_IN = ['Bash', 'Edit', 'Write', 'MultiEdit', 'Read', 'Glob', 'Grep', 'Search', 'WebSearch', 'Task', 'Monitor', 'PowerShell', 'WebFetch', 'Agent', 'Skill',
  'NotebookEdit', 'TodoWrite', 'BashOutput', 'KillShell', 'SendMessage', 'EnterWorktree', 'FutureTool'];
const ENUMERATED = [...BUILT_IN, ...OWN.MARROW_OWN_TOOL_NAMES.flatMap((name) => [`mcp__other__${name}`, `mcp__marrow_x__${name}`, `functions.${name}`, `mcp__Marrow__${name}`, `mcp__marrow__${name} `, `mcp__marrow__${name}\n`]),
  'mcp__marrow__marrow_unregistered', 'mcp__x__y', 'functions.x', 'LS ', ' LS', 'ls', 'ListMcpResourcesTool\n', ''];
// The plugin's own Marrow tools on its own server: the plugin skips them by exact name (plugins/marrow/hooks/hooks.json:28).
const PLUGIN_OWN = /^mcp__plugin_marrow_marrow__\(\?:([a-z_|]+)\)/.exec(PLUGIN_MATCHER.slice('^(?!(?:'.length))[1].split('|').map((name) => `mcp__plugin_marrow_marrow__${name}`);

function run(fx) {
  const lines = [];
  const previous = process.exitCode;
  const result = updatePath().runUpdatePath({ home: fx.home, cwd: fx.project }, { env: { PATH: fx.bin, HOME: fx.home }, out: (line) => lines.push(line) });
  const exitCode = process.exitCode;
  process.exitCode = previous;
  return { ...result, exitCode, text: lines.join('\n') };
}
const pluginHooksFile = (fx) => path.join(fx.home, '.claude', 'plugins', 'cache', 'getmarrow', 'marrow', '0.2.7', 'hooks', 'hooks.json');
function withMatchers(copyMatcher, pluginMatcher) {
  const fx = fixture({ scope: 'project' });
  const file = fx.scopeFile.project;
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  value.hooks = require('./support/update-path-fixture').duplicateHooks();
  value.hooks.PreToolUse[1].matcher = copyMatcher;
  fs.writeFileSync(file, json(value));
  const hooks = JSON.parse(REAL_PLUGIN_HOOKS_JSON);
  hooks.hooks.PreToolUse[0].matcher = pluginMatcher;
  fs.writeFileSync(pluginHooksFile(fx), pluginMatcher === PLUGIN_MATCHER ? REAL_PLUGIN_HOOKS_JSON : json(hooks));
  return { fx, file };
}
function assertKept(copyMatcher, pluginMatcher, reason) {
  const { fx, file } = withMatchers(copyMatcher, pluginMatcher);
  try {
    const before = sha(file);
    const user = sha(fx.userSettings);
    const result = run(fx);
    assert.equal(result.exitCode, 0, result.text);
    assert.deepEqual(fx.argv(), UPDATE_ARGV, 'the update ran, so the removal step was reached');
    assert.equal(sha(file), before);
    assert.equal(sha(fx.userSettings), user);
    assert.equal(exactCopies(file).length, 4);
    assert.doesNotMatch(result.text, /Removed the duplicate/);
    assert.match(result.text, reason);
  } finally { cleanup(fx); }
}
const COPY_REASON = /could not be verified for this scope \(the PreToolUse matcher of the copy is not a published installer matcher\)/;
const PLUGIN_REASON = /could not be verified for this scope \(the plugin pre-action matcher is not a published plugin matcher\)/;
const oneByte = (text) => {
  const out = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    out.push(text.slice(0, index) + String.fromCharCode(code === 0x41 ? 0x42 : code ^ 0x01) + text.slice(index + 1));
    out.push(text.slice(0, index) + text.slice(index + 1));
    out.push(`${text.slice(0, index)} ${text.slice(index)}`);
  }
  out.push(`${text} `, `${text}x`, text.toUpperCase(), text.toLowerCase());
  return out.filter((variant) => variant !== text);
};

test('M1 the pinned published copy and plugin matchers exist, each with its source version, equal to their sources', () => {
  for (const list of [PUBLISHED_COPY_MATCHERS, PUBLISHED_PLUGIN_MATCHERS]) {
    assert.ok(Object.isFrozen(list) && list.length >= 1);
    for (const item of list) { assert.ok(Object.isFrozen(item)); assert.equal(typeof item.matcher, 'string'); assert.match(item.since, /^(installer|plugin) \d+\.\d+\.\d+ \([0-9a-f]{7}\)$/); }
  }
  assert.deepEqual(PUBLISHED_COPY_MATCHERS.map((item) => item.matcher), [OWN.buildOwnToolMatchers().claude]);
  const blob = crypto.createHash('sha1').update(`blob ${Buffer.byteLength(REAL_PLUGIN_HOOKS_JSON)}\0`).update(REAL_PLUGIN_HOOKS_JSON).digest('hex');
  assert.equal(blob, REAL_PLUGIN_HOOKS_BLOB, 'the fixture is the published plugin hooks.json byte for byte');
  const real = JSON.parse(REAL_PLUGIN_HOOKS_JSON).hooks.PreToolUse;
  assert.equal(real.length, 1);
  assert.deepEqual(PUBLISHED_PLUGIN_MATCHERS.map((item) => item.matcher), [real[0].matcher]);
  assert.equal(real[0].hooks[0].command, PLUGIN_PRE_ACTION_LAUNCHERS[0].command);
});

test('M2 the copy PreToolUse matcher must be byte-equal to a pinned installer matcher, else the copy is kept', () => {
  assert.equal(pinnedCopy(COPY_MATCHER), true);
  for (const matcher of ['*', '', undefined, null, ['*'], 'Bash', `Bash|Edit|Write|MultiEdit|Read|Glob|Grep|Search|WebSearch|Task|${COPY_MATCHER}`]) assert.equal(pinnedCopy(matcher), false, String(matcher));
  assertKept('*', PLUGIN_MATCHER, COPY_REASON);
  assertKept(PLUGIN_MATCHER, PLUGIN_MATCHER, COPY_REASON);
});

test('M3 the plugin hooks.json matcher must be byte-equal to a pinned published plugin matcher, else the copy is kept', () => {
  assert.equal(pinnedPlugin(PLUGIN_MATCHER), true);
  for (const matcher of ['*', '', undefined, null, ['*'], COPY_MATCHER]) assert.equal(pinnedPlugin(matcher), false, String(matcher));
  assertKept(COPY_MATCHER, '*', PLUGIN_REASON);
  assertKept(COPY_MATCHER, COPY_MATCHER, PLUGIN_REASON);
});

test('M4 every enumerated tool name a pinned copy matcher can match is matched by each pinned plugin matcher, but the plugin\'s own tools', () => {
  for (const { matcher: copy } of PUBLISHED_COPY_MATCHERS) {
    const reached = ENUMERATED.filter((tool) => regex(copy).test(tool));
    assert.ok(reached.length > 300, `${reached.length} enumerated names reach the copy`);
    for (const { matcher: plugin } of PUBLISHED_PLUGIN_MATCHERS) for (const tool of reached) assert.equal(regex(plugin).test(tool), true, JSON.stringify(tool));
    // The one gap, by design: the plugin skips its own 17 tools on its own server by exact name; the copy hooks them.
    assert.equal(PLUGIN_OWN.length, 17);
    for (const tool of PLUGIN_OWN) { assert.equal(regex(copy).test(tool), true, tool); assert.equal(PUBLISHED_PLUGIN_MATCHERS.some(({ matcher }) => regex(matcher).test(tool)), false, tool); }
    for (const tool of PLUGIN_OWN.flatMap((name) => [`${name} `, name.toUpperCase(), name.replace('plugin_marrow', 'plugin_marrowx'), `${name}_x`])) assert.equal(regex(PLUGIN_MATCHER).test(tool), true, tool);
  }
});

test('M5 each one-byte change to the copy matcher or to the plugin matcher (every byte position) keeps the copy', () => {
  const copies = oneByte(COPY_MATCHER);
  const plugins = oneByte(PLUGIN_MATCHER);
  assert.ok(copies.length >= COPY_MATCHER.length * 3 && plugins.length >= PLUGIN_MATCHER.length * 3);
  for (const variant of copies) assert.equal(pinnedCopy(variant), false, JSON.stringify(variant));
  for (const variant of plugins) assert.equal(pinnedPlugin(variant), false, JSON.stringify(variant));
  for (const index of [0, Math.floor(COPY_MATCHER.length / 2), COPY_MATCHER.length - 1]) assertKept(`${COPY_MATCHER.slice(0, index)}${COPY_MATCHER.slice(index + 1)}`, PLUGIN_MATCHER, COPY_REASON);
  for (const index of [0, Math.floor(PLUGIN_MATCHER.length / 2), PLUGIN_MATCHER.length]) assertKept(COPY_MATCHER, `${PLUGIN_MATCHER.slice(0, index)} ${PLUGIN_MATCHER.slice(index)}`, PLUGIN_REASON);
});

test('M6 a plugin matcher that misses one enumerated tool keeps the copy', () => {
  const reached = ENUMERATED.filter((tool) => regex(COPY_MATCHER).test(tool));
  for (const tool of reached) {
    const narrower = `(?!${tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$)${PLUGIN_MATCHER}`;
    assert.equal(regex(narrower).test(tool), false, JSON.stringify(tool));
    assert.equal(pinnedPlugin(narrower), false, JSON.stringify(tool));
  }
  for (const tool of ['Bash', 'WebFetch', 'mcp__other__marrow_commit']) assertKept(COPY_MATCHER, `(?!${tool}$)${PLUGIN_MATCHER}`, PLUGIN_REASON);
});

test('M7 the real published plugin hooks.json with a real installer copy: the copy is removed under every A rule, one Marrow hook left', () => {
  const fx = fixture({ scope: 'project' });
  try {
    const file = fx.scopeFile.project;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    value.hooks = require('./support/update-path-fixture').duplicateHooks();
    fs.writeFileSync(file, json(value));
    assert.equal(fs.readFileSync(pluginHooksFile(fx), 'utf8'), REAL_PLUGIN_HOOKS_JSON);
    assert.equal(value.hooks.PreToolUse[1].matcher, COPY_MATCHER);
    const user = sha(fx.userSettings);
    const result = run(fx);
    assert.equal(result.exitCode, 0, result.text);
    assert.deepEqual(fx.argv(), UPDATE_ARGV);
    assert.deepEqual(exactCopies(file), []);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.PreToolUse[0].hooks[0].command, 'owner-guard.sh --strict');
    assert.equal(sha(fx.userSettings), user);
    assert.match(result.text, /Removed the duplicate Marrow hook copy from .*\(4 entries\); the plugin hook stays/);
    const plugin = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(pluginHooksFile(fx))), '..', '0.2.8', 'hooks', 'hooks.json'), 'utf8'));
    assert.equal(plugin.hooks.PreToolUse.flatMap((group) => group.hooks).filter((hook) => hook.command === PLUGIN_PRE_ACTION_LAUNCHERS[0].command).length, 1);
  } finally { cleanup(fx); }
});

test('M8 an unknown, edited, wider or narrower matcher on either side keeps the copy', () => {
  for (const matcher of ['*', '.*', '', 'Bash', 'Bash|Edit|Write', COPY_MATCHER.replace('LS|', ''), `${COPY_MATCHER}|x`, COPY_MATCHER.replace('[\\s\\S]*', '.*')]) assertKept(matcher, PLUGIN_MATCHER, COPY_REASON);
  for (const matcher of ['*', '.*', 'Bash', PLUGIN_MATCHER.replace('|LS', ''), PLUGIN_MATCHER.replace('marrow_think|', ''), PLUGIN_MATCHER.replace('[\\s\\S]*', '.+')]) assertKept(COPY_MATCHER, matcher, PLUGIN_REASON);
});

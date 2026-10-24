require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const PINS = require('../src/pins');
const installer = require('../src/installer');
const own = require('../src/marrow-own-tools');

// PKG-H2: upgrading a 0.1.72 install rewrites only Marrow's own entries to the new Claude Code matcher
// (every label but the exact own ones and LS / ListMcpResourcesTool). The person's hooks, a hook of
// their own on Monitor included, stay byte for byte, and a second run changes nothing.
const BASE = path.join(__dirname, 'fixtures', 'installer-0172', 'claude-settings.json');
const LIST_0172 = `Bash|Edit|Write|MultiEdit|Read|Glob|Grep|Search|WebSearch|Task|^(?!mcp__marrow__(?:${own.MARROW_OWN_TOOL_NAMES.join('|')})$)[\\s\\S]*(?:functions\\.|mcp__)[\\s\\S]*`;
const isMarrow = (value) => typeof value === 'string' && /@getmarrow\/mcp@[^\s"',]+/.test(value);
const marrowGroups = (settings, event) => (settings.hooks[event] || []).filter((group) => (group.hooks || []).some((hook) => isMarrow(hook.command)));
const userHooks = (settings) => Object.fromEntries(Object.entries(settings.hooks || {})
  .map(([event, groups]) => [event, groups.filter((group) => !(group.hooks || []).some((hook) => isMarrow(hook.command)))])
  .filter(([, groups]) => groups.length));

function hostApprovalTarget() {
  const version = installer.hostApprovalHooksSupported(PINS.MCP_ADAPTER_VERSION) ? PINS.MCP_ADAPTER_VERSION : PINS.MCP_HOST_APPROVAL_HOOKS_SINCE;
  return installer.resolveMcpTargetVersion({ registryMetadata: { name: '@getmarrow/mcp', version, dist: {
    integrity: `sha512-${crypto.createHash('sha512').update(`registry-${version}`).digest('base64')}`,
    tarball: `https://registry.npmjs.org/@getmarrow/mcp/-/mcp-${version}.tgz`,
  } } });
}

function upgrade(userEntries) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-h2-upgrade-'));
  fs.chmodSync(base, 0o700);
  const home = path.join(base, 'home');
  const root = path.join(base, 'project');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
  const settingsPath = path.join(root, '.claude', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(BASE, 'utf8'));
  settings.hooks.PreToolUse.unshift(userEntries.pre);
  settings.hooks.Stop.push(userEntries.stop);
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  const apply = () => {
    const detection = installer.detectEnvironment(root, { HOME: home, PATH: process.env.PATH });
    const plan = installer.buildPlan(detection, { mode: 'mcp', mcpTarget: hostApprovalTarget() });
    installer.applyPlan(plan, { yes: true, dryRun: false, doctor: false });
    return fs.readFileSync(settingsPath, 'utf8');
  };
  return { before: settings, apply, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

for (const [label, userEntries] of [
  ['a user PreToolUse hook on Bash and a user Stop hook', { pre: { matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-pre-bash' }] }, stop: { hooks: [{ type: 'command', command: 'echo user-stop' }] } }],
  ['a user PreToolUse hook on Monitor', { pre: { matcher: 'Monitor', hooks: [{ type: 'command', command: 'echo user-monitor', timeout: 3 }] }, stop: { hooks: [{ type: 'command', command: 'echo user-stop' }] } }],
]) {
  test(`PKG-H2 upgrade from 0.1.72 with ${label}: one Marrow entry per event with the new matcher, user hooks unchanged, idempotent`, () => {
    const run = upgrade(userEntries);
    try {
      assert.equal(marrowGroups(run.before, 'PreToolUse')[0].matcher, LIST_0172, 'the fixture holds the 0.1.72 list matcher');
      const first = run.apply();
      const after = JSON.parse(first);
      for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest']) {
        const groups = marrowGroups(after, event);
        assert.equal(groups.length, 1, event);
        assert.equal(groups[0].matcher, installer.NATIVE_HOOK_MATCHER, event);
        assert.equal(groups[0].hooks.length, 1, event);
      }
      for (const event of ['UserPromptSubmit', 'Stop', 'PostToolBatch']) assert.equal(marrowGroups(after, event).length, 1, event);
      assert.deepEqual(userHooks(after), userHooks(run.before), 'the person\'s hooks are byte for byte the same');
      assert.equal(first.includes(JSON.stringify(LIST_0172).slice(1, -1)), false, 'no 0.1.72 matcher is left');
      if (userEntries.pre.matcher === 'Monitor') assert.deepEqual(after.hooks.PreToolUse.find((group) => group.matcher === 'Monitor'), userEntries.pre);
      assert.equal(run.apply(), first, 'a second run changes nothing');
      // The new matcher hooks what 0.1.72 skipped, and never skips what it hooked.
      const now = new RegExp(installer.NATIVE_HOOK_MATCHER);
      const then = new RegExp(LIST_0172);
      for (const tool of ['Monitor', 'PowerShell', 'WebFetch', 'Agent', 'Skill', 'SendMessage', 'EnterWorktree', 'FutureTool']) {
        assert.equal(then.test(tool), false, tool);
        assert.equal(now.test(tool), true, tool);
      }
      for (const tool of ['Bash', 'Edit', 'Write', 'Read', 'Task', 'WebSearch', 'mcp__x__y', 'functions.x', 'TodoWrite', 'BashOutput']) assert.equal(now.test(tool), then.test(tool), tool);
    } finally { run.cleanup(); }
  });
}

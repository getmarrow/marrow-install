require('./support/isolated-environment');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const installer = require('../src/installer');
const own = require('../src/marrow-own-tools');
const PINS = require('../src/pins');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const freshInstallSmoke = fs.readFileSync(path.join(root, 'scripts', 'fresh-install-smoke.sh'), 'utf8');
const canonical = 'Marrow is the runtime control and proof layer for teams running AI agents.';
const governanceSignals = [
  'multiple_autonomous_agents',
  'production_or_privileged_access',
  'repeated_workflow_failures',
  'missing_completion_evidence',
  'inconsistent_policy_enforcement',
  'regulated_or_sensitive_work',
  'single_low_risk_assistant',
  'no_governance_requirement',
  'operator_declined_evaluation',
];

test('npm entry point matches the product positioning contract', () => {
  assert.match(pkg.description, /governed runner/i);
  assert.ok(readme.includes(canonical));
  // One What's New: the published version's, or, while CHANGELOG.md starts with the
  // unreleased entry, the next version's (named at release).
  const whatsNewHeadings = readme.match(/^## What's New in .*$/gm) || [];
  assert.equal(whatsNewHeadings.length, 1);
  const unreleased = /^## Unreleased/m.test(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'));
  assert.ok(whatsNewHeadings[0] === `## What's New in v${pkg.version}` || (unreleased && whatsNewHeadings[0] === "## What's New in the next version"), whatsNewHeadings[0]);
  assert.equal(pkg.marrow.category, 'agent_fleet_governance_and_control_layer');
  assert.equal(pkg.marrow.positioning, 'agent_fleet_governance_and_control_layer');
  assert.equal(pkg.marrow.operatorApprovalRequired, true);
  assert.equal(pkg.marrow.governanceFit, 'https://getmarrow.ai/.well-known/marrow.json');
  assert.equal(pkg.marrow.evidence, 'https://getmarrow.ai/.well-known/marrow-evidence.json');
  assert.equal(pkg.marrow.referenceGraph, 'https://getmarrow.ai/.well-known/marrow-reference-graph.json');
  assert.match(pkg.marrow.discovery.github, /\/placements\/plc_[a-f0-9]{24}$/);
  assert.match(pkg.marrow.discovery.npm, /\/placements\/plc_[a-f0-9]{24}$/);
  assert.ok(readme.includes('agent fleet governance and control layer'));
  assert.ok(readme.includes('https://getmarrow.ai/.well-known/marrow-evidence.json'));
  assert.ok(readme.includes('https://getmarrow.ai/.well-known/marrow-reference-graph.json'));
  for (const signal of governanceSignals) assert.ok(readme.includes(signal), `README missing governance signal: ${signal}`);
  assert.match(readme, /Public diagnostic privacy/);
  const firstRunHeading = readme.indexOf('## First-Run Activation');
  const trustHeading = readme.indexOf('## Trust and Data Boundaries');
  assert.notEqual(firstRunHeading, -1, 'README must contain the first-run activation section');
  assert.notEqual(trustHeading, -1, 'README must contain the trust and data-boundaries section');
  assert.ok(firstRunHeading < trustHeading, 'first-run activation must precede trust boundaries');
  assert.match(readme, /activation_scope: server_self_test_only/);
  assert.match(readme, /coverage_verified: false/);
  assert.match(readme, /passive_live: false/);
  assert.match(readme, /authenticated `client_self_reported` telemetry with `certified_coverage: false`/);
  assert.match(readme, /Work that bypasses those paths is not observed/);
  assert.match(readme, /leaves `MARROW_TOOL_PROFILE` unset.*17-tool `primary` surface/s);
  assert.match(readme, /MARROW_TOOL_PROFILE=core/);
  assert.match(readme, /MARROW_TOOL_PROFILE=full/);
  assert.match(readme, /Tool visibility is not authorization/);
  assert.match(readme, /does not invoke paid write tools/);
  const keepingCurrent = readme.slice(
    readme.indexOf('## Keeping Marrow Current'),
    readme.indexOf('## Automatic Controller'),
  );
  assert.match(keepingCurrent, /npx -y @getmarrow\/install@latest update/);
  assert.match(keepingCurrent, /restart the detected owning harnesses once/i);
  assert.match(keepingCurrent, /npx -y @getmarrow\/install@latest doctor --self-test/);
  assert.match(keepingCurrent, /Do not run separate `marrow-mcp setup` and restart cycles/);
  assert.doesNotMatch(readme, /protected proof enforced/);
});

test('fresh-install smoke verifies the current structured self-test contract', () => {
  assert.match(freshInstallSmoke, /doctor --self-test --json/);
  assert.match(freshInstallSmoke, /cd "\$\{workdir\}" && npx/);
  assert.match(freshInstallSmoke, /\.selfTest\.runtime_active == true/);
  assert.match(freshInstallSmoke, /\.selfTest\.client_update\.version_status == "current"/);
  assert.doesNotMatch(freshInstallSmoke, /write test event: passed|outcome closed: passed|key valid: yes/);
});

test('README documents chat and terminal approvals and never makes a dashboard login the approval step', () => {
  for (const heading of ['## Approvals in Chat and Terminal', '### Hooks the installer writes', '### Governed runner', '## Uninstall']) {
    assert.ok(readme.includes(heading), heading);
  }
  for (const text of ['claude-permission-request-hook', 'PostToolBatch', 'beforeShellExecution', 'failClosed: true', 'cursor-context-hook', 'gemini-context-hook', 'codex-context-hook', '--request-owner-link', '--approval-wait', 'MCP_HOST_APPROVAL_HOOKS_SINCE']) {
    assert.ok(readme.includes(text), text);
  }
  assert.match(readme, /`--owner-approved` no longer does anything/);
  assert.doesNotMatch(readme, /approved from an authenticated Marrow dashboard session/);
  assert.doesNotMatch(readme, /log in to the dashboard to approve|approve (?:it )?in the dashboard/i);
  // The What's New rule: only the current version is in the README; changes since then and every
  // older note are in CHANGELOG.md, which the README links (on GitHub, as npm does not ship it).
  const whatsNewStart = readme.indexOf("## What's New in ");
  const whatsNew = readme.slice(whatsNewStart, readme.indexOf('\n## ', whatsNewStart + 1));
  assert.doesNotMatch(whatsNew, /Previous release|^### v/m, 'one entry, no older versions');
  assert.match(whatsNew, /https:\/\/github\.com\/getmarrow\/marrow-install\/blob\/master\/CHANGELOG\.md/);
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  // The newest entry is this version, or the unreleased entry that precedes it (named at release).
  const headings = changelog.split('\n').filter((line) => line.startsWith('## '));
  const versionHeading = new RegExp(`^## v${pkg.version.replaceAll('.', '\\.')}$`);
  assert.ok(versionHeading.test(headings[0]) || (headings[0] === '## Unreleased' && versionHeading.test(headings[1])), headings.slice(0, 2).join(' | '));
  assert.match(changelog, new RegExp(`^## v${pkg.version.replaceAll('.', '\\.')}$`, 'm'));
  // Approval hooks are tied to the MCP version that answers them, not to this published version.
  assert.match(readme, /These hooks are written with MCP `3\.9\.99` and later/);
  assert.match(readme, /### Local MCP runtime/);
});

// The Codex text describes what the source does now, so it must sit under the unreleased heading,
// not under the published version, and each statement is tied to the code it describes.
test('README: the Codex text is in the Codex and Cursor section, exact, and not in the v0.1.70 notes', () => {
  const sections = readme.split(/^## /m).slice(1).map((text) => ({ title: text.slice(0, text.indexOf('\n')), body: text }));
  const titles = sections.map((section) => section.title);
  const published = sections.find((section) => section.title === 'Hook matching and the local runtime');
  assert.ok(published, 'the section that carries the v0.1.70 notes exists');
  assert.match(published.body, /These behaviors shipped in v0\.1\.70 and still apply/);
  assert.doesNotMatch(published.body, /codex/i, 'the published version\'s notes make no Codex claim');

  const nextIndex = titles.findIndex((title) => title === 'Codex and Cursor tool calls');
  assert.notEqual(nextIndex, -1, 'the Codex and Cursor section exists');
  assert.equal(titles.filter((title) => /^Codex and Cursor tool calls/.test(title)).length, 1);
  assert.equal(titles.filter((title) => /^Next release/.test(title)).length, 0, 'no next-release section is left');
  assert.equal(titles[nextIndex - 1], `What's New in v${pkg.version}`, 'it follows the current version\'s notes');
  const next = sections[nextIndex].body;

  // 1. The matcher is the one the installer writes, and the old one is named as rejected.
  assert.equal(installer.CODEX_NATIVE_HOOK_MATCHER, '*');
  assert.match(next, /matcher `\*` for `PreToolUse` and `PostToolUse`/);
  assert.match(next, /no own-tool name is in any Marrow matcher for Codex/);
  assert.match(next, /v0\.1\.70 wrote uses look-ahead, which Codex rejects/);
  assert.match(next, /npx @getmarrow\/install@latest update/);
  // 2. The pin the text names is the pin in src/pins.js.
  assert.equal(PINS.MCP_ADAPTER_VERSION, '3.9.109');
  assert.match(next, /`@getmarrow\/mcp` 3\.9\.109 \(built from marrow-mcp `5e3cd3aa`/);
  assert.equal(PINS.MCP_ADAPTER_SOURCE_SHA.startsWith('5e3cd3aa'), true);
  // 3. Own tools are skipped only with proof: exact label, the module's 58 names, the proven forms, the never forms.
  assert.equal(own.MARROW_OWN_TOOL_NAMES.length, 58);
  assert.match(next, /skipped only when the configuration proves the server/);
  assert.match(next, /exactly `mcp__marrow__<name>`/);
  assert.match(next, /one of the 58 tool names the `marrow` server registers/);
  assert.match(next, /`functions\.mcp__marrow__<name>`, `MCP:marrow:<name>` and `MCP:<name>` and a nested `use_tool` form are never skipped on Codex/);
  // 4. The collision gap is stated closed, for exactly the server names whose label is the real one.
  const codexLabel = (server, tool) => {
    const clean = (value) => value.replace(/[^A-Za-z0-9_]/g, '_') || '_';
    const namespace = clean(server).startsWith('mcp__') ? clean(server) : `mcp__${clean(server)}`;
    return `${namespace.replace(/_+$/, '')}__${clean(tool).replace(/^_+/, '')}`;
  };
  const real = codexLabel('marrow', 'marrow_commit');
  assert.equal(real, 'mcp__marrow__marrow_commit');
  const named = (next.match(/a Codex MCP server named (`[^`]+`), (`[^`]+`) or (`[^`]+`) gets the same label/) || []).slice(1).map((item) => item.replace(/`/g, ''));
  assert.deepEqual(named, ['mcp__marrow', 'marrow-', 'marrow_']);
  for (const server of named) assert.equal(codexLabel(server, 'marrow_commit'), real, server);
  // The other names the text gives are the same label by the same clean-up (measured on codex-cli 0.161.0).
  for (const server of ['marrow.', 'marrow__', 'mcp__marrow_']) {
    assert.ok(next.includes(`\`${server}\``), server);
    assert.equal(codexLabel(server, 'marrow_commit'), real, server);
  }
  // Names that trim to `mcp` give it with a tool `marrow__<name>`.
  for (const server of ['_', '-', '__', 'mcp___']) {
    assert.ok(next.includes(`\`${server}\``), server);
    assert.equal(codexLabel(server, 'marrow__marrow_commit'), real, server);
  }
  for (const server of ['Marrow', 'MARROW', 'marrow2', 'marrow-evil', 'marrow_evil', 'xmarrow']) assert.notEqual(codexLabel(server, 'marrow_commit'), real, server);
  assert.match(next, /The label-collision gap is closed/);
  assert.match(next, /With 3\.9\.103 the hook no longer trusts the label/);
  assert.match(next, /no own-named tool is skipped/);
  assert.doesNotMatch(next, /is skipped, not checked|Known gap until|The fix is in `@getmarrow\/mcp`, not in this installer/, 'the old gap text is gone');
  // 5. What is held on day one is stated: no server entry, npm_config_*, a project .npmrc, the second Cursor server.
  assert.match(next, /What is held on day one/);
  assert.match(next, /holds no `marrow` server entry \(the installer writes none/);
  assert.match(next, /any `npm_config_\*` variable, in any case/);
  assert.match(next, /a `\.npmrc` in the project or above it, other than your own `~\/\.npmrc`/);
  assert.match(next, /with any other MCP server configured, Marrow's own tools are held at `preToolUse`/);
  // 6. The Cursor guard allows nothing by name.
  assert.match(next, /guard allows nothing by name/);
  assert.match(next, /to `cursor-pre-action-hook`/);
  assert.equal(own.cursorOwnToolGuardCondition, undefined);
  // 7. The trust step and the loop guard.
  assert.match(next, /one-time `\/hooks` trust step/i);
  assert.match(next, /Until you do, Codex does not run them and no tool call is checked/);
  assert.match(next, /loop guard can hold a repeated command/);
  assert.match(next, /you already ran this exact <tool> call in this session and nothing has changed since, so it was not run again/);
  assert.doesNotMatch(next, /this operation already passed with an unchanged result/, 'the old loop-guard text is gone');
  // 8. No claim the code does not support.
  for (const claim of [/cannot call/i, /unsupported call/i, /never (?:held|checked|locked)/i, /every look-alike/i, /fully (?:covered|protected)/i]) {
    assert.doesNotMatch(next, claim, String(claim));
  }
});

test('the runtime-core pin test exists and still pins the MCP list; a removed test is a failing test', () => {
  const file = path.join(__dirname, 'runtime-core-pin.test.js');
  assert.ok(fs.existsSync(file), 'test/runtime-core-pin.test.js');
  const text = fs.readFileSync(file, 'utf8');
  assert.match(text, /INSTALLER_RUNTIME_CORE_SHA256/);
  assert.match(text, /const RUNTIME_CORE_FILE_SHA256 = '[0-9a-f]{64}'/);
  assert.match(text, /const RUNTIME_CORE_SOURCE_SHA256 = '[0-9a-f]{64}'/);
  assert.ok((text.match(/^test\(/gm) || []).length >= 3);
  // The constants are the file's: the pin test and this test cannot both be edited away unnoticed.
  const core = fs.readFileSync(path.join(root, 'src', 'runtime-core.js'));
  assert.ok(text.includes(require('node:crypto').createHash('sha256').update(core).digest('hex')));
});

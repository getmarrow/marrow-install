require('./support/isolated-environment');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');

const {
  applyPlan,
  buildPlan,
  detectEnvironment,
  detectedClient,
  install,
  installSummaryLines,
  printReport,
  runSelfTest,
  stableAgentId,
} = require('../src/installer');
const { planHermesMcpConfig, redactUndoLines } = require('../src/hermes-config');
const { readOwnerApiKey } = require('../src/owner-env');

const BIN = path.join(__dirname, '..', 'bin', 'marrow-install.js');
const MCP_PIN = '@getmarrow/mcp@3.9.97';
const INSTALLER_VERSION = require('../package.json').version;
const MATCHER = 'Bash|Edit|Write|MultiEdit|Read|Glob|Grep|Search|WebSearch|Task|functions\\.(?!mcp__marrow__marrow_).*|mcp__(?!marrow__marrow_).*';
const command = (entrypoint) => `npx -y --package=${MCP_PIN} marrow-mcp ${entrypoint}`;

function tempDir(prefix = 'marrow-0166-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function filesContaining(root, needle) {
  const found = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && fs.readFileSync(full, 'utf8').includes(needle)) found.push(path.relative(root, full));
    }
  };
  walk(root);
  return found.sort();
}

// The Claude hook reconciliation that `marrow-mcp setup` performs in MCP 3.9.97 (be607e1d,
// src/hook-contract.ts reconcileMarrowCommandHook and the four install*Hook callers in
// src/cli.ts). Reproduced here so the installer output is checked against the other writer.
function mcpSubcommand(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^npx\s+(?:-y\s+)?(?:--package=@getmarrow\/mcp(?:@[^\s]+)?\s+marrow-mcp|@getmarrow\/mcp(?:@[^\s]+)?)\s+(?:(?:claude|cline|codex|cursor|gemini|grok|windsurf)-)?(context-hook|pre-action-hook|hook|session-hook)$/);
  return match?.[1] || null;
}

function mcpReconcile(settings, eventName, subcommand, wanted, matcher) {
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const original = Array.isArray(hooks[eventName]) ? hooks[eventName] : [];
  let preferred = null;
  const retained = [];
  for (const entry of original) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) {
      retained.push(entry);
      continue;
    }
    const remaining = [];
    for (const hook of entry.hooks) {
      const detected = mcpSubcommand(hook?.command);
      if (hook?.type === 'command' && detected) {
        const exactMatcher = matcher === undefined ? entry.matcher === undefined : entry.matcher === matcher;
        if (detected === subcommand && (!preferred || (hook.command === wanted && exactMatcher))) preferred = hook;
        continue;
      }
      remaining.push(hook);
    }
    if (remaining.length > 0) retained.push({ ...entry, hooks: remaining });
  }
  const canonical = { hooks: [{ ...(preferred || {}), type: 'command', command: wanted }] };
  if (matcher !== undefined) canonical.matcher = matcher;
  retained.push(canonical);
  return retained;
}

function mcpSetup(settingsPath) {
  const steps = [
    (settings) => ({ PostToolUse: mcpReconcile(settings, 'PostToolUse', 'hook', command('claude-hook'), MATCHER), PostToolUseFailure: mcpReconcile(settings, 'PostToolUseFailure', 'hook', command('claude-hook'), MATCHER) }),
    (settings) => ({ UserPromptSubmit: mcpReconcile(settings, 'UserPromptSubmit', 'context-hook', command('claude-context-hook')) }),
    (settings) => ({ PreToolUse: mcpReconcile(settings, 'PreToolUse', 'pre-action-hook', command('claude-pre-action-hook'), MATCHER) }),
    (settings) => ({ Stop: mcpReconcile(settings, 'Stop', 'session-hook', command('claude-session-hook')) }),
  ];
  for (const step of steps) {
    const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
    const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
    settings.hooks = { ...hooks, ...step(settings) };
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  }
}

function installClaude(root) {
  const plan = buildPlan(detectEnvironment(root, { HOME: root, PATH: process.env.PATH }), { mode: 'mcp' });
  return applyPlan(plan, { yes: true, dryRun: false, doctor: false })
    .find((change) => change.label === 'Claude Code MCP passive hooks');
}

function marrowHandlers(settingsPath) {
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  return Object.fromEntries(Object.entries(settings.hooks).map(([event, entries]) => [
    event,
    entries.flatMap((entry) => entry.hooks || []).filter((hook) => mcpSubcommand(hook.command)),
  ]));
}

test('Claude hooks use the claude-* entrypoints and converge with MCP setup in both orders', () => {
  const expected = {
    UserPromptSubmit: command('claude-context-hook'),
    PreToolUse: command('claude-pre-action-hook'),
    PostToolUse: command('claude-hook'),
    PostToolUseFailure: command('claude-hook'),
    Stop: command('claude-session-hook'),
  };
  // Fresh install, then MCP setup: MCP leaves the installer's bytes alone.
  const fresh = tempDir();
  try {
    fs.writeFileSync(path.join(fresh, 'CLAUDE.md'), '# Claude\n');
    installClaude(fresh);
    const settingsPath = path.join(fresh, '.claude', 'settings.json');
    const written = fs.readFileSync(settingsPath, 'utf8');
    for (const [event, wanted] of Object.entries(expected)) {
      assert.deepEqual(marrowHandlers(settingsPath)[event].map((hook) => hook.command), [wanted], event);
    }
    assert.doesNotMatch(written, /marrow-mcp (?:context-hook|pre-action-hook|hook|session-hook)"/);
    mcpSetup(settingsPath);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), written);
  } finally {
    fs.rmSync(fresh, { recursive: true, force: true });
  }

  // An existing MCP-setup entry: the installer finds it current and never rewrites it.
  const mcpFirst = tempDir();
  try {
    const settingsPath = path.join(mcpFirst, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, `${JSON.stringify({ permissions: { allow: ['Read'] } }, null, 2)}\n`);
    mcpSetup(settingsPath);
    const fromMcp = fs.readFileSync(settingsPath, 'utf8');
    const change = installClaude(mcpFirst);
    assert.equal(change.changed, false);
    assert.equal(change.already_present, true);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), fromMcp);
  } finally {
    fs.rmSync(mcpFirst, { recursive: true, force: true });
  }
});

test('an existing 0.1.65 installer entry migrates once to one claude-* handler and keeps owner options', () => {
  const root = tempDir();
  try {
    const settingsPath = path.join(root, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: command('context-hook') }] }],
        PreToolUse: [{ matcher: MATCHER, hooks: [{ type: 'command', command: command('pre-action-hook'), timeout: 9 }] }],
        // A hand-edited duplicate of both spellings collapses to one handler.
        PostToolUse: [
          { matcher: MATCHER, hooks: [
            { type: 'command', command: command('hook') },
            { type: 'command', command: 'printf owner-hook' },
          ] },
          { matcher: MATCHER, hooks: [{ type: 'command', command: command('claude-hook') }] },
        ],
        PostToolUseFailure: [{ matcher: MATCHER, hooks: [{ type: 'command', command: command('hook') }] }],
        Stop: [{ hooks: [{ type: 'command', command: command('session-hook') }] }],
      },
    }, null, 2));
    const first = installClaude(root);
    assert.equal(first.applied, true);
    const handlers = marrowHandlers(settingsPath);
    for (const event of ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Stop']) {
      assert.equal(handlers[event].length, 1, event);
      assert.match(handlers[event][0].command, / marrow-mcp claude-/, event);
    }
    const migrated = fs.readFileSync(settingsPath, 'utf8');
    assert.match(migrated, /printf owner-hook/);
    assert.equal(handlers.PreToolUse[0].command, command('claude-pre-action-hook'));
    assert.equal(handlers.PreToolUse[0].timeout, 9);
    mcpSetup(settingsPath);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), migrated);
    const again = installClaude(root);
    assert.equal(again.changed, false);
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), migrated);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an AGENTS.md holding only the Marrow block no longer makes the project Codex (R-21)', () => {
  const root = tempDir();
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    const env = { HOME: root, PATH: process.env.PATH };
    const block = '<!-- marrow:passive-start -->\n## Marrow\n<!-- marrow:passive-end -->\n';
    fs.writeFileSync(path.join(root, 'AGENTS.md'), block);
    assert.equal(detectEnvironment(root, env).codex, false);
    assert.equal(detectedClient(detectEnvironment(root, env)), 'custom');

    fs.mkdirSync(path.join(root, '.codex'));
    fs.writeFileSync(path.join(root, '.codex', 'hooks.json'), JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: command('codex-pre-action-hook') }] }] },
    }));
    assert.equal(detectEnvironment(root, env).codex, false);

    fs.writeFileSync(path.join(root, '.codex', 'config.toml'), 'model = "x"\n');
    assert.equal(detectEnvironment(root, env).codex, true);
    fs.rmSync(path.join(root, '.codex'), { recursive: true, force: true });
    fs.mkdirSync(path.join(root, '.codex'));
    assert.equal(detectEnvironment(root, env).codex, true);
    fs.rmSync(path.join(root, '.codex'), { recursive: true, force: true });

    fs.writeFileSync(path.join(root, 'AGENTS.md'), `# Owner instructions\n\n${block}`);
    assert.equal(detectEnvironment(root, env).codex, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Hermes is detected from its config or PATH without MARROW_CLIENT, and overrides still win', () => {
  const root = tempDir();
  const home = tempDir();
  const bin = tempDir();
  const previousClient = process.env.MARROW_CLIENT;
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    const base = { HOME: home, PATH: process.env.PATH };
    assert.equal(detectEnvironment(root, base).hermes, false);

    fs.mkdirSync(path.join(home, '.hermes'), { mode: 0o700 });
    fs.writeFileSync(path.join(home, '.hermes', 'config.yaml'), 'model: x\n', { mode: 0o600 });
    const fromConfig = detectEnvironment(root, base);
    assert.equal(fromConfig.hermes, true);
    assert.equal(fromConfig.hermesConfig, true);
    assert.equal(detectedClient(fromConfig), 'hermes');

    const customRoot = tempDir();
    const customHome = path.join(customRoot, 'hermes-profile');
    fs.mkdirSync(customHome);
    fs.writeFileSync(path.join(customHome, 'config.yaml'), 'model: x\n');
    const withHermesHome = detectEnvironment(root, { HOME: customRoot, PATH: process.env.PATH, HERMES_HOME: customHome });
    assert.equal(withHermesHome.paths.hermesConfig, path.join(customHome, 'config.yaml'));
    assert.equal(withHermesHome.hermesConfig, true);
    fs.rmSync(customRoot, { recursive: true, force: true });

    fs.writeFileSync(path.join(bin, 'hermes'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const fromPath = detectEnvironment(root, { HOME: bin, PATH: `${bin}${path.delimiter}${process.env.PATH}` });
    assert.equal(fromPath.hermes, true);
    assert.equal(fromPath.hermesConfig, false);

    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Claude\n');
    assert.equal(detectedClient(detectEnvironment(root, base)), 'claude-code');
    fs.rmSync(path.join(root, 'CLAUDE.md'));

    process.env.MARROW_CLIENT = 'codex';
    assert.equal(detectedClient(detectEnvironment(root, base)), 'codex');
  } finally {
    if (previousClient === undefined) delete process.env.MARROW_CLIENT;
    else process.env.MARROW_CLIENT = previousClient;
    for (const directory of [root, home, bin]) fs.rmSync(directory, { recursive: true, force: true });
  }
});

function hermesHome(configText, { hermesEnv } = {}) {
  const home = tempDir('marrow-0166-home-');
  fs.mkdirSync(path.join(home, '.hermes'), { mode: 0o700 });
  fs.writeFileSync(path.join(home, '.hermes', 'config.yaml'), configText, { mode: 0o600 });
  if (hermesEnv) fs.writeFileSync(path.join(home, '.hermes', '.env'), hermesEnv, { mode: 0o600 });
  return home;
}

function hermesInstall(project, home, extra = {}) {
  return install({
    cwd: project,
    home,
    mode: 'mcp',
    yes: true,
    dryRun: false,
    selfTest: false,
    controller: false,
    apiKey: 'mrw_fixture_hermes_key',
    baseUrl: 'https://api.getmarrow.ai',
    agentId: '',
    processCommands: [],
    mcpConfigPaths: [],
    ...extra,
  });
}

const OTHER_SERVER_SECRET = 'fixture-other-server-credential';
const HERMES_CONFIG = [
  '# Hermes settings',
  'model:',
  '  default: example-model  # keep this comment',
  'mcp_servers:',
  '  github:',
  '    command: gh',
  '    args:',
  '    - mcp',
  '    env:',
  `      GITHUB_TOKEN: ${OTHER_SERVER_SECRET}`,
  '# after servers',
  'toolsets:',
  '- web',
  '',
].join('\n');

test('Hermes MCP wiring is added once, keeps the file, makes no copy of it and leaves redacted undo steps', async () => {
  const project = tempDir();
  const home = hermesHome(HERMES_CONFIG);
  const configPath = path.join(home, '.hermes', 'config.yaml');
  try {
    fs.writeFileSync(path.join(project, 'package.json'), '{}\n');
    const first = await hermesInstall(project, home);
    assert.equal(first.hermes.state, 'configured');
    const after = fs.readFileSync(configPath, 'utf8');
    for (const line of HERMES_CONFIG.split('\n').filter(Boolean)) assert.ok(after.includes(line), line);
    assert.match(after, /\n {2}marrow:\n {4}command: npx\n {4}args: \["-y", "--package=@getmarrow\/mcp@3\.9\.97", "marrow-mcp"\]\n {4}env:\n {6}MARROW_CLIENT: hermes\n# after servers/);
    assert.doesNotMatch(after, /MARROW_API_KEY|mrw_fixture/);
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600);
    // The owner rule: no copy of a file that holds credentials, anywhere.
    assert.deepEqual(fs.readdirSync(path.join(home, '.hermes')), ['config.yaml']);
    assert.deepEqual(filesContaining(home, OTHER_SERVER_SECRET), ['.hermes/config.yaml']);
    assert.deepEqual(filesContaining(project, OTHER_SERVER_SECRET), []);
    assert.equal(Object.hasOwn(first.hermes, 'backup_path'), false);
    // Undo steps name only the marrow lines, with every env value but MARROW_CLIENT redacted.
    assert.deepEqual(first.hermes.undo, [{ change: 'added', lines: [
      '  marrow:',
      '    command: npx',
      '    args: ["-y", "--package=@getmarrow/mcp@3.9.97", "marrow-mcp"]',
      '    env:',
      '      MARROW_CLIENT: hermes',
    ] }]);
    let log = '';
    printReport(first, (text) => { log += text; });
    assert.match(log, /no backup is kept because the file holds other servers' credentials/);
    assert.match(log, /remove these added lines:\n {4}  marrow:/);
    assert.doesNotMatch(log, new RegExp(`${OTHER_SERVER_SECRET}|mrw_fixture`));
    // Hermes passes only HOME/PATH to MCP servers, so the key goes to the owner-only store.
    assert.equal(first.hermes.key_source, 'owner_env_file');
    assert.equal(first.hermes.owner_key_storage.state, 'written');
    const ownerEnv = path.join(home, '.marrow', 'env');
    assert.equal(fs.statSync(ownerEnv).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(ownerEnv)).mode & 0o777, 0o700);
    assert.match(fs.readFileSync(ownerEnv, 'utf8'), /^MARROW_API_KEY=mrw_fixture_hermes_key\n$/);
    assert.doesNotMatch(JSON.stringify(first), new RegExp(`mrw_fixture_hermes_key|${OTHER_SERVER_SECRET}`));
    assert.ok(first.harnessReload.clients.some((entry) => entry.client === 'hermes'));

    const second = await hermesInstall(project, home);
    assert.equal(second.hermes.state, 'already_configured');
    assert.equal(second.hermes.undo, null);
    assert.equal(second.hermes.owner_key_storage.state, 'present');
    assert.equal(fs.readFileSync(configPath, 'utf8'), after);
    assert.deepEqual(fs.readdirSync(path.join(home, '.hermes')), ['config.yaml']);

    const dryHome = hermesHome(HERMES_CONFIG);
    try {
      const dry = await hermesInstall(project, dryHome, { yes: false, dryRun: true });
      assert.equal(dry.hermes.state, 'would_configure');
      assert.equal(fs.readFileSync(path.join(dryHome, '.hermes', 'config.yaml'), 'utf8'), HERMES_CONFIG);
      assert.equal(fs.existsSync(path.join(dryHome, '.marrow', 'env')), false);
    } finally {
      fs.rmSync(dryHome, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Hermes undo notes redact every value that could be a credential', () => {
  const lines = redactUndoLines([
    '  marrow:',
    '    command: npx',
    '    args: ["-y", "--api-key", "fixture-arg-secret", "--token=fixture-inline-secret", "marrow-mcp"]',
    '    env:',
    '      MARROW_CLIENT: hermes',
    '      MARROW_API_KEY: fixture-env-secret',
    '      OTHER: "${OTHER}"',
    '    other_args:',
    '    - --auth',
    '    - fixture-seq-secret',
  ]);
  assert.doesNotMatch(lines.join('\n'), /fixture-(?:arg|inline|env|seq)-secret|\$\{OTHER\}/);
  assert.ok(lines.includes('      MARROW_CLIENT: hermes'));
  assert.ok(lines.includes('    args: ["-y", "--api-key", "[redacted]", "--token=[redacted]", "marrow-mcp"]'));
  assert.ok(lines.includes('      MARROW_API_KEY: [redacted]'));
  assert.deepEqual(redactUndoLines(['      MARROW_CLIENT: custom', '      TOKEN: fixture-x'], true), ['      MARROW_CLIENT: custom', '      TOKEN: [redacted]']);
});

test('Hermes wiring keeps an existing entry\'s own env keys and prefers a Hermes .env reference', async () => {
  const project = tempDir();
  const existing = [
    'mcp_servers:',
    '  marrow:',
    '    command: npx',
    '    args:',
    '      - "@getmarrow/mcp"',
    '    env:',
    '      MARROW_API_KEY: owner-inline-value',
    '      MARROW_SESSION_ID: s1',
    '',
  ].join('\n');
  const inlineHome = hermesHome(existing);
  const referenceHome = hermesHome('mcp_servers: {}\n', { hermesEnv: 'MARROW_API_KEY=value-in-hermes-env\n' });
  try {
    fs.writeFileSync(path.join(project, 'package.json'), '{}\n');
    const inline = await hermesInstall(project, inlineHome);
    const inlineText = fs.readFileSync(path.join(inlineHome, '.hermes', 'config.yaml'), 'utf8');
    assert.equal(inline.hermes.state, 'configured');
    assert.equal(inline.hermes.key_source, 'hermes_entry');
    assert.match(inlineText, /MARROW_API_KEY: owner-inline-value\n {6}MARROW_SESSION_ID: s1\n {6}MARROW_CLIENT: hermes/);
    assert.match(inlineText, /args: \["-y", "--package=@getmarrow\/mcp@3\.9\.97", "marrow-mcp"\]/);
    assert.equal(fs.existsSync(path.join(inlineHome, '.marrow', 'env')), false);
    assert.doesNotMatch(JSON.stringify(inline), /owner-inline-value/);

    const reference = await hermesInstall(project, referenceHome);
    const referenceText = fs.readFileSync(path.join(referenceHome, '.hermes', 'config.yaml'), 'utf8');
    assert.equal(reference.hermes.key_source, 'hermes_env_reference');
    assert.match(referenceText, /MARROW_API_KEY: "\$\{MARROW_API_KEY\}"/);
    assert.doesNotMatch(referenceText, /value-in-hermes-env/);
    assert.equal(fs.existsSync(path.join(referenceHome, '.marrow', 'env')), false);
  } finally {
    for (const directory of [project, inlineHome, referenceHome]) fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Hermes wiring refuses a config it cannot edit safely and prints the exact block instead', async () => {
  const project = tempDir();
  const unsafe = {
    tabs: 'mcp_servers:\n\tgithub:\n\t\tcommand: gh\n',
    anchor: 'defaults: &d\n  command: npx\nmcp_servers:\n  marrow: *d\n',
    flow: 'mcp_servers: {github: {command: gh}}\n',
    duplicate: 'mcp_servers:\n  a:\n    command: x\nmcp_servers:\n  b:\n    command: y\n',
    blockScalar: 'mcp_servers:\n  marrow:\n    command: |\n      npx\n',
    byteOrderMark: '\ufeffmcp_servers:\n  other:\n    command: o\n',
    complexKey: '? mcp_servers\n: other:\n    command: o\n',
    indentedRoot: '  model: x\n  mcp_servers:\n    other:\n      command: o\n',
    quotedAcrossLines: 'note: "hello\nmcp_servers:\n  x: y"\nmodel: x\n',
    customArgs: 'mcp_servers:\n  marrow:\n    command: npx\n    args:\n    - -y\n    - "@getmarrow/mcp@3.9.90"\n    - --api-key\n    - fixture-arg-value\n',
    customCommand: 'mcp_servers:\n  marrow:\n    command: /opt/example/wrapper.sh\n',
  };
  try {
    fs.writeFileSync(path.join(project, 'package.json'), '{}\n');
    for (const [name, text] of Object.entries(unsafe)) {
      const home = hermesHome(text);
      try {
        const report = await hermesInstall(project, home);
        assert.equal(report.hermes.state, 'refused', name);
        assert.equal(fs.readFileSync(path.join(home, '.hermes', 'config.yaml'), 'utf8'), text, name);
        assert.deepEqual(fs.readdirSync(path.join(home, '.hermes')).filter((entry) => entry.includes('backup')), [], name);
        assert.match(report.hermes.exact_fix, /mcp_servers:\n {2}marrow:\n {4}command: npx/);
        assert.match(report.hermes.exact_fix, /@getmarrow\/mcp@3\.9\.97/);
        assert.doesNotMatch(JSON.stringify(report), /fixture-arg-value/);
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    }
    assert.equal(planHermesMcpConfig('mcp_servers:\n  marrow:\n    url: https://mcp.example\n', { mcpPackageSpec: MCP_PIN }).action, 'unchanged');
    // A key-looking line inside a nested multi-line string is content, never a second mcp_servers.
    const nested = 'agent:\n  prompt: "line one\nmcp_servers:\n    fake: 1"\nmcp_servers:\n  other:\n    command: o\n';
    const planned = planHermesMcpConfig(nested, { mcpPackageSpec: MCP_PIN });
    assert.equal(planned.action, 'update');
    assert.ok(planned.content.startsWith('agent:\n  prompt: "line one\nmcp_servers:\n    fake: 1"\nmcp_servers:\n  other:\n    command: o\n  marrow:\n'));
    assert.equal(planHermesMcpConfig(planned.content, { mcpPackageSpec: MCP_PIN }).action, 'unchanged');
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
});

function selfTestStub({ status = {}, runtime = {}, firstValueFailures = 0, runtimeFailures = 0 } = {}) {
  const calls = [];
  let runtimeAttempts = 0;
  let firstValueAttempts = 0;
  const originalFetch = global.fetch;
  global.fetch = async (url, request = {}) => {
    const href = String(url);
    const body = request.body ? JSON.parse(String(request.body)) : {};
    calls.push({ href, body, headers: request.headers || {} });
    const json = (data, statusCode = 200) => new Response(JSON.stringify({ data }), { status: statusCode });
    if (href.endsWith('/v1/agent/think')) return json({ decision_id: 'dec_self_test' });
    if (href.endsWith('/v1/agent/commit')) return json({ committed: true, decision_id: body.decision_id });
    if (href.endsWith('/v1/agent/status')) return json({ ok: true, enabled: true, health: 'healthy', ...status });
    if (href.endsWith('/v1/agent/context')) return json({});
    if (href.endsWith('/v1/agent/runtime')) {
      runtimeAttempts += 1;
      if (runtimeAttempts <= runtimeFailures) return new Response(JSON.stringify({ error: 'Runtime decision continuity is temporarily unavailable.' }), { status: 503 });
      return json({ ok: true, risk_gate: { allow: true, decision: 'proceed', enforced: false }, ...runtime });
    }
    if (href.endsWith('/v1/agent/first-value')) {
      firstValueAttempts += 1;
      if (firstValueAttempts <= firstValueFailures) return new Response(JSON.stringify({ error: 'bad gateway' }), { status: 502 });
      return json({
        ok: true,
        active: true,
        activation_receipt: body.activation ? {
          id: 'act_fixture',
          decision_id: body.decision_id,
          agent_id: body.agent_id,
          outcome_success: true,
          outcome_recorded_at: '2026-09-30T00:00:00.000Z',
          server_confirmed: true,
          capture_verified: true,
          intervention_verified: true,
          closure_verified: true,
        } : null,
      });
    }
    if (href.endsWith('/v1/agent/integrations/events')) return json({ accepted: true, evidence_authority: 'client_self_reported' });
    return json({ ok: true });
  };
  return { calls, restore: () => { global.fetch = originalFetch; } };
}

const activation = { harness: 'hermes', install_surface: 'mcp', capability_level: 'mcp', expected_hooks: [] };

async function selfTest(stubOptions, options = {}) {
  const stub = selfTestStub(stubOptions);
  try {
    const result = await runSelfTest({
      selfTest: true,
      apiKey: 'mrw_fixture_self_test',
      baseUrl: 'https://api.example.test',
      agentId: '',
      client: 'hermes',
      activation,
      selfTestRetryDelayMs: 0,
      ...options,
    });
    return { result, calls: stub.calls };
  } finally {
    stub.restore();
  }
}

test('the self-test never sends a derived id and activates the server-resolved seat or bound agent (F-C)', async () => {
  const seat = await selfTest({ status: { identity: { agent_id: 'free-seat-gdj', bound_agent_ids: ['free-seat-gdj'] } } });
  assert.equal(seat.calls.every((call) => call.headers['x-marrow-agent-id'] === undefined), true);
  assert.equal(seat.result.agent_id, 'free-seat-gdj');
  assert.equal(seat.result.agent_id_source, 'server_status_identity');
  assert.equal(seat.result.activation_verified, true);
  assert.equal(seat.result.decision_committed, true);
  const firstValue = seat.calls.find((call) => call.href.endsWith('/v1/agent/first-value')).body;
  assert.equal(firstValue.agent_id, 'free-seat-gdj');
  const event = seat.calls.find((call) => call.href.endsWith('/v1/agent/integrations/events')).body;
  assert.equal(event.agent_id, 'free-seat-gdj');
  assert.doesNotMatch(JSON.stringify(seat.calls.map((call) => call.body)), /hermes-[a-f0-9]{12}/);

  const bound = await selfTest({ status: { identity: { agent_id: null, bound_agent_ids: ['bound-agent-one'] } } });
  assert.equal(bound.result.agent_id, 'bound-agent-one');
  assert.equal(bound.result.activation_verified, true);

  const fromRuntime = await selfTest({ runtime: { agent_id: 'runtime-resolved-agent' } });
  assert.equal(fromRuntime.result.agent_id, 'runtime-resolved-agent');
  assert.equal(fromRuntime.result.agent_id_source, 'server_runtime');

  const configured = await selfTest({ status: { identity: { agent_id: 'registered-agent', bound_agent_ids: [] } } }, { agentId: 'registered-agent' });
  assert.equal(configured.calls.every((call) => call.headers['x-marrow-agent-id'] === 'registered-agent'), true);
  assert.equal(configured.result.agent_id_source, 'configured');

  // An unbound key has no single agent: no activation is attempted and nothing is invented.
  const unbound = await selfTest({ status: { identity: { agent_id: null, bound_agent_ids: [] } } });
  assert.equal(unbound.result.activation_identity_unresolved, true);
  assert.equal(unbound.result.activation_verified, false);
  assert.match(unbound.result.activation_exact_fix, /not bound to one agent/);
  const unboundFirstValue = unbound.calls.find((call) => call.href.endsWith('/v1/agent/first-value')).body;
  assert.equal(Object.hasOwn(unboundFirstValue, 'activation'), false);
  assert.equal(Object.hasOwn(unboundFirstValue, 'agent_id'), false);
  assert.equal(unbound.result.active, true);
});

test('the self-test closes the decision its runtime call created, in the same session (F-E)', async () => {
  const { result, calls } = await selfTest({
    status: { identity: { agent_id: 'free-seat-gdj', bound_agent_ids: ['free-seat-gdj'] } },
    runtime: {
      decision_id: 'rtdec_self_test',
      runtime_authorization: { id: 'gr_self_test', kind: 'durable_gate_receipt', decision_state: 'created', decision_id: 'rtdec_self_test' },
    },
  });
  const runtimeCall = calls.find((call) => call.href.endsWith('/v1/agent/runtime'));
  const commits = calls.filter((call) => call.href.endsWith('/v1/agent/commit'));
  assert.equal(commits.length, 2);
  const closure = commits.find((call) => call.body.decision_id === 'rtdec_self_test');
  assert.ok(closure);
  assert.equal(closure.body.gate_receipt_id, 'gr_self_test');
  assert.equal(closure.headers['x-marrow-session-id'], runtimeCall.headers['x-marrow-session-id']);
  assert.ok(closure.headers['idempotency-key']);
  assert.deepEqual(result.runtime_decision_closure, { created: true, decision_id: 'rtdec_self_test', committed: true });

  const noDecision = await selfTest({ runtime: { runtime_authorization: { id: 'gr_x', decision_state: 'not_created' } } });
  assert.equal(noDecision.calls.filter((call) => call.href.endsWith('/v1/agent/commit')).length, 1);
  assert.deepEqual(noDecision.result.runtime_decision_closure, { created: false, committed: null });
});

test('the self-test retries transient runtime and first-value answers with a stable key (F-D)', async () => {
  const { result, calls } = await selfTest({
    status: { identity: { agent_id: 'free-seat-gdj', bound_agent_ids: ['free-seat-gdj'] } },
    runtimeFailures: 1,
    firstValueFailures: 1,
  });
  assert.equal(result.activation_verified, true);
  for (const route of ['/v1/agent/runtime', '/v1/agent/first-value']) {
    const attempts = calls.filter((call) => call.href.endsWith(route));
    assert.equal(attempts.length, 2, route);
    assert.ok(attempts[0].headers['idempotency-key'], route);
    assert.equal(attempts[0].headers['idempotency-key'], attempts[1].headers['idempotency-key'], route);
  }
  await assert.rejects(
    selfTest({ runtimeFailures: 3 }),
    /self-test runtime did not complete after 3 attempts \(last: HTTP 503/,
  );
});

test('managed MCP config carries the configured identity; other values are reset and reported unless allowlisted (R-19, ADV-05)', () => {
  const root = tempDir();
  try {
    fs.writeFileSync(path.join(root, 'package.json'), '{}\n');
    const mcpPath = path.join(root, '.mcp.json');
    const write = (env) => fs.writeFileSync(mcpPath, JSON.stringify({ mcpServers: { marrow: { command: 'npx', args: [], env } } }));
    const run = (options) => {
      const change = applyPlan(buildPlan(detectEnvironment(root, { HOME: root, PATH: process.env.PATH }), { mode: 'mcp', ...options }), { yes: true, dryRun: false, doctor: false })
        .find((entry) => entry.label === 'Project MCP server config');
      return { change, env: JSON.parse(fs.readFileSync(mcpPath, 'utf8')).mcpServers.marrow.env };
    };
    // A planted redirect and a foreign agent id are replaced by the controller's own values.
    write({ MARROW_BASE_URL: 'https://fixture-user:fixture-pass@redirect.example.test:8443/api', MARROW_FLEET_AGENT_ID: 'someone-elses-agent' });
    const maintained = run({ maintenance: true, baseUrl: 'https://api.getmarrow.ai', agentId: '', identityAllowlist: { baseUrls: new Set(), agentIds: new Set() } });
    assert.equal(maintained.env.MARROW_BASE_URL, 'https://api.getmarrow.ai');
    assert.equal(Object.hasOwn(maintained.env, 'MARROW_FLEET_AGENT_ID'), false);
    assert.deepEqual(maintained.change.identity_divergence, [
      { field: 'MARROW_BASE_URL', replaced: 'https://redirect.example.test:8443', applied: 'https://api.getmarrow.ai' },
      { field: 'MARROW_FLEET_AGENT_ID', replaced: 'someone-elses-agent', applied: 'unset (resolved by Marrow)' },
    ]);
    assert.doesNotMatch(JSON.stringify(maintained.change), /fixture-pass|fixture-user/);

    // Owner-allowlisted values are kept, and nothing is reported.
    write({ MARROW_BASE_URL: 'https://staging.example.test', MARROW_FLEET_AGENT_ID: 'owner-registered-agent' });
    const allowed = run({
      maintenance: true,
      baseUrl: 'https://api.getmarrow.ai',
      agentId: '',
      identityAllowlist: { baseUrls: new Set(['https://staging.example.test']), agentIds: new Set(['owner-registered-agent']) },
    });
    assert.equal(allowed.env.MARROW_BASE_URL, 'https://staging.example.test');
    assert.equal(allowed.env.MARROW_FLEET_AGENT_ID, 'owner-registered-agent');
    assert.equal(allowed.change?.identity_divergence, undefined);

    // An id generated by an earlier installer is removed without a report; a configured id wins.
    write({ MARROW_BASE_URL: 'https://api.getmarrow.ai', MARROW_FLEET_AGENT_ID: stableAgentId(root, 'custom') });
    const migrated = run({ agentId: '' });
    assert.equal(Object.hasOwn(migrated.env, 'MARROW_FLEET_AGENT_ID'), false);
    assert.equal(migrated.change.identity_divergence, undefined);
    assert.equal(run({ agentId: 'configured-agent' }).env.MARROW_FLEET_AGENT_ID, 'configured-agent');

    const summary = installSummaryLines({
      selfTest: { skipped: false, active: true, decision_id: 'dec_x', decision_committed: true },
      activation: { agent_id: 'a', agent_id_source: 'server_status_identity' },
      changes: [maintained.change],
    }, {}).lines;
    assert.ok(summary.some((line) => line.startsWith('MCP config identity reset: MARROW_BASE_URL in ')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the summary reports an untrusted self-test commit, the key file used, and disagreeing key files', () => {
  const untrusted = installSummaryLines({ selfTest: { skipped: false, active: true, decision_id: 'dec_u', decision_committed: false } }, {});
  assert.equal(untrusted.selfTestFailed, true);
  assert.match(untrusted.lines[0], /self-test decision dec_u was recorded without trusted closure \(committed was not true\)\. Fix: /);

  const home = tempDir('marrow-0166-keys-');
  try {
    fs.mkdirSync(path.join(home, '.marrow'), { mode: 0o700 });
    fs.writeFileSync(path.join(home, '.marrow', 'env'), 'MARROW_API_KEY=fixture-key-one\n', { mode: 0o600 });
    assert.deepEqual(readOwnerApiKey(home), { apiKey: 'fixture-key-one', source: path.join(home, '.marrow', 'env'), conflict: false });
    fs.writeFileSync(path.join(home, '.marrow', 'env.local'), 'MARROW_API_KEY=fixture-key-two\n', { mode: 0o600 });
    const stored = readOwnerApiKey(home);
    assert.equal(stored.source, path.join(home, '.marrow', 'env.local'));
    assert.equal(stored.conflict, true);
    const lines = installSummaryLines({
      selfTest: { skipped: false, active: true, decision_id: 'dec_k', decision_committed: true },
      activation: {},
      api_key: { source: 'owner_env_file', path: stored.source, owner_files_disagree: true },
    }, {}).lines;
    assert.ok(lines.includes(`API key: read from ${stored.source}.`));
    assert.ok(lines.some((line) => line.startsWith('Warning: ~/.marrow/env.local and ~/.marrow/env hold different Marrow keys.')));
    assert.doesNotMatch(lines.join('\n'), /fixture-key-(?:one|two)/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('self-test writes stop at their time limits instead of hanging the install', async () => {
  const originalFetch = global.fetch;
  let attempts = 0;
  global.fetch = (url, request = {}) => new Promise((resolve, reject) => {
    attempts += 1;
    request.signal?.addEventListener('abort', () => reject(Object.assign(new Error('timed out'), { name: 'TimeoutError' })));
  });
  const started = Date.now();
  // The request timers are unref'd, as a real socket would keep the process alive instead.
  const keepAlive = setInterval(() => {}, 1_000);
  try {
    await assert.rejects(runSelfTest({
      selfTest: true,
      apiKey: 'mrw_fixture_timeout',
      baseUrl: 'https://api.example.test',
      agentId: '',
      selfTestRetryDelayMs: 0,
      selfTestAttemptTimeoutMs: 40,
      selfTestDeadlineMs: 2_000,
    }), /self-test did not return decision_id after 3 attempts \(last: timed out\)/);
  } finally {
    clearInterval(keepAlive);
    global.fetch = originalFetch;
  }
  assert.equal(attempts, 3);
  assert.ok(Date.now() - started < 2_000);
});

function runBin(args, { cwd, env, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input || '');
  });
}

test('the one command stops with one line when no API key is available, and reads the owner key store', async () => {
  const home = tempDir('marrow-0166-nokey-');
  const project = tempDir();
  try {
    fs.writeFileSync(path.join(project, 'package.json'), '{}\n');
    const env = { PATH: process.env.PATH, HOME: home };
    const bare = await runBin([], { cwd: project, env });
    assert.equal(bare.status, 2);
    assert.equal(bare.stdout, 'Marrow needs your API key. Run: MARROW_API_KEY=<your key> npx -y @getmarrow/install@latest  (create a key at https://getmarrow.ai)\n');
    assert.deepEqual(fs.readdirSync(project), ['package.json']);
    assert.deepEqual(fs.readdirSync(home), []);

    fs.writeFileSync(path.join(project, 'AGENTS.md'), '<!-- marrow:passive-start -->\nx\n<!-- marrow:passive-end -->\n');
    const update = await runBin(['update'], { cwd: project, env });
    assert.equal(update.status, 2);
    assert.match(update.stdout, /^Marrow needs your API key\. Run: MARROW_API_KEY=<your key> npx -y @getmarrow\/install@latest update /);

    fs.mkdirSync(path.join(home, '.marrow'), { mode: 0o700 });
    fs.writeFileSync(path.join(home, '.marrow', 'env'), 'MARROW_API_KEY=mrw_fixture_stored_key\n', { mode: 0o644 });
    const insecure = JSON.parse((await runBin(['--dry-run', '--json'], { cwd: project, env })).stdout);
    assert.deepEqual(insecure.doctor.missingEnv, ['MARROW_API_KEY']);
    fs.chmodSync(path.join(home, '.marrow', 'env'), 0o600);
    const stored = await runBin(['--dry-run', '--json'], { cwd: project, env });
    assert.deepEqual(JSON.parse(stored.stdout).doctor.missingEnv, []);
    assert.doesNotMatch(`${stored.stdout}${stored.stderr}`, /mrw_fixture_stored_key/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  }
});

function startStubApi(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        const body = raw ? JSON.parse(raw) : {};
        const request = { method: req.method, pathname: new URL(req.url, 'http://127.0.0.1').pathname, headers: req.headers, body };
        requests.push(request);
        const [status, data] = handler(request);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(status < 400 ? { data } : data));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('first install runs the self-test and prints one summary line with the full report in a private log', async () => {
  const home = tempDir('marrow-0166-summary-home-');
  const project = tempDir();
  const fakeBin = tempDir();
  fs.writeFileSync(path.join(project, 'package.json'), '{}\n');
  // The loop-guard self-test runs the pinned MCP package through npx; a local stand-in keeps
  // this test offline and returns the proof shape MCP 3.9.97 prints.
  fs.writeFileSync(path.join(fakeBin, 'npx'), `#!/bin/sh\nprintf '%s' '${JSON.stringify({ pass: true, isolated: true, live_hook_observed: false, repeat_denied: true, mutation_reset: true, owner_disabled_bypass: true })}'\n`, { mode: 0o755 });
  const key = 'mrw_fixture_summary_key';
  const api = await startStubApi((request) => {
    switch (request.pathname) {
      case '/v1/agent/think': return [200, { decision_id: 'dec_summary' }];
      case '/v1/agent/commit': return [200, { committed: true, decision_id: request.body.decision_id }];
      case '/v1/agent/status': return [200, { ok: true, enabled: true, health: 'healthy', identity: { agent_id: 'free-seat-summary', bound_agent_ids: ['free-seat-summary'] } }];
      case '/v1/agent/runtime': return [200, {
        ok: true,
        agent_id: 'free-seat-summary',
        decision_id: 'rtdec_summary',
        runtime_authorization: { id: 'gr_summary', decision_state: 'created', decision_id: 'rtdec_summary' },
        risk_gate: { allow: true, decision: 'proceed', enforced: false },
      }];
      case '/v1/agent/first-value': return [200, {
        ok: true,
        active: true,
        activation_receipt: {
          id: 'act_summary',
          decision_id: request.body.decision_id,
          agent_id: request.body.agent_id,
          outcome_success: true,
          outcome_recorded_at: '2026-09-30T00:00:00.000Z',
          server_confirmed: true,
          capture_verified: true,
          intervention_verified: true,
          closure_verified: true,
        },
      }];
      case '/v1/agent/integrations/events': return [200, { accepted: true, evidence_authority: 'client_self_reported' }];
      default: return [200, {}];
    }
  });
  try {
    const env = {
      PATH: `${fakeBin}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      HOME: home,
      MARROW_API_KEY: key,
      MARROW_BASE_URL: api.url,
    };
    const result = await runBin(['--no-controller'], { cwd: project, env });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split('\n');
    assert.equal(lines[0], `Marrow ${INSTALLER_VERSION}: healthy. Self-test decision dec_summary committed; agent free-seat-summary (resolved by Marrow).`);
    const logLine = lines.at(-1);
    assert.match(logLine, /^Full report: .*\/\.marrow\/logs\/install-.+\.log$/);
    const logPath = logLine.slice('Full report: '.length);
    assert.equal(fs.statSync(logPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(logPath)).mode & 0o777, 0o700);
    const log = fs.readFileSync(logPath, 'utf8');
    assert.match(log, /Marrow passive installer/);
    assert.match(log, /decision_id: dec_summary/);
    assert.ok(lines.length <= 4, result.stdout);
    assert.doesNotMatch(`${result.stdout}${result.stderr}${log}`, new RegExp(key));
    assert.equal(api.requests.every((request) => request.headers['x-marrow-agent-id'] === undefined), true);
    const closure = api.requests.find((request) => request.pathname === '/v1/agent/commit' && request.body.decision_id === 'rtdec_summary');
    assert.equal(closure.body.gate_receipt_id, 'gr_summary');

    const failed = installSummaryLines({ selfTest: { skipped: false, active: false, error: 'HTTP 503: store timeout' }, doctor: { recommendedFix: null } }, {});
    assert.equal(failed.selfTestFailed, true);
    assert.equal(failed.lines[0], `Marrow ${INSTALLER_VERSION}: self-test failed: HTTP 503: store timeout. Fix: npx -y @getmarrow/install@latest doctor --self-test`);
    const restarted = installSummaryLines({
      selfTest: { skipped: false, active: true, decision_id: 'dec_restart', decision_committed: true },
      activation: { agent_id: 'free-seat-summary', agent_id_source: 'server_status_identity' },
      controller: { active: true, changed: true, restarted: { from_versions: ['0.1.63 (legacy)'], to_version: INSTALLER_VERSION } },
      hermes: { state: 'configured', config_path: '/home/example/.hermes/config.yaml', undo: [], owner_key_storage: { state: 'written' } },
    }, {}).lines;
    assert.ok(restarted.includes(`Controller restarted: 0.1.63 (legacy) -> ${INSTALLER_VERSION}.`));
    assert.ok(restarted.some((line) => line.startsWith('Hermes: added the Marrow MCP server to /home/example/.hermes/config.yaml')));
    assert.ok(restarted.some((line) => line.startsWith('Stored your API key in ~/.marrow/env (mode 600)')));
  } finally {
    await new Promise((resolve) => api.server.close(resolve));
    for (const directory of [home, project, fakeBin]) fs.rmSync(directory, { recursive: true, force: true });
  }
});

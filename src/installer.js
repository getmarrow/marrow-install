const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const DEFAULT_BASE_URL = 'https://api.getmarrow.ai';
const MARROW_BLOCK_START = '<!-- marrow:passive-start -->';
const MARROW_BLOCK_END = '<!-- marrow:passive-end -->';
const INSTALLER_ADAPTER_VERSION = '0.1.34';
const MCP_ADAPTER_VERSION = '3.9.50';
const SDK_ADAPTER_VERSION = '3.7.49';
const MCP_PACKAGE_SPEC = `@getmarrow/mcp@${MCP_ADAPTER_VERSION}`;
const MCP_CONTEXT_HOOK_COMMAND = `npx -y ${MCP_PACKAGE_SPEC} context-hook`;
const MCP_PRE_ACTION_HOOK_COMMAND = `npx -y ${MCP_PACKAGE_SPEC} pre-action-hook`;
const MCP_ACTION_RESULT_HOOK_COMMAND = `npx -y ${MCP_PACKAGE_SPEC} hook`;
const MCP_SESSION_END_HOOK_COMMAND = `npx -y ${MCP_PACKAGE_SPEC} session-hook`;
const NATIVE_HOOK_MATCHER = 'Bash|Edit|Write|MultiEdit|mcp__(?!marrow_).*';
const NATIVE_EXPECTED_HOOKS = ['prompt', 'pre_action', 'action_result', 'session_end'];
const SOURCE_CLIENTS = new Set(['claude-code', 'cursor', 'composer', 'windsurf', 'openclaw', 'codex', 'gemini', 'grok', 'deepseek', 'qwen', 'kimi', 'minimax', 'cline', 'opencode', 'hermes', 'glm', 'custom', 'unknown']);
const HARNESS_CAPABILITY_REGISTRY = Object.freeze([
  { client: 'claude-code', capability_level: 'native_hooks', automatic: ['prompt', 'pre_action', 'action_result', 'session_end'], install_surface: 'mcp' },
  { client: 'cursor', capability_level: 'mcp', automatic: ['mcp_tool_calls'], install_surface: 'mcp' },
  { client: 'composer', capability_level: 'mcp', automatic: ['mcp_tool_calls'], install_surface: 'mcp' },
  { client: 'cline', capability_level: 'mcp', automatic: ['mcp_tool_calls'], install_surface: 'mcp' },
  { client: 'windsurf', capability_level: 'mcp', automatic: ['mcp_tool_calls'], install_surface: 'mcp' },
  { client: 'codex', capability_level: 'governed_wrapper', automatic: ['pre_action', 'action_result', 'outcome_closure'], install_surface: 'runner' },
  { client: 'opencode', capability_level: 'governed_wrapper', automatic: ['pre_action', 'action_result', 'outcome_closure'], install_surface: 'runner' },
  { client: 'hermes', capability_level: 'event_contract', automatic: [], install_surface: 'addon' },
  { client: 'openclaw', capability_level: 'event_contract', automatic: [], install_surface: 'addon' },
  { client: 'gemini', capability_level: 'governed_wrapper', automatic: ['pre_action', 'action_result', 'outcome_closure'], install_surface: 'runner' },
  { client: 'grok', capability_level: 'governed_wrapper', automatic: ['pre_action', 'action_result', 'outcome_closure'], install_surface: 'runner' },
  { client: 'deepseek', capability_level: 'governed_wrapper', automatic: ['pre_action', 'action_result', 'outcome_closure'], install_surface: 'runner' },
  { client: 'qwen', capability_level: 'governed_wrapper', automatic: ['pre_action', 'action_result', 'outcome_closure'], install_surface: 'runner' },
  { client: 'kimi', capability_level: 'governed_wrapper', automatic: ['pre_action', 'action_result', 'outcome_closure'], install_surface: 'runner' },
  { client: 'minimax', capability_level: 'governed_wrapper', automatic: ['pre_action', 'action_result', 'outcome_closure'], install_surface: 'runner' },
  { client: 'glm', capability_level: 'governed_wrapper', automatic: ['pre_action', 'action_result', 'outcome_closure'], install_surface: 'runner' },
  { client: 'custom', capability_level: 'event_contract', automatic: [], install_surface: 'event_contract' },
]);

function sourceClient() {
  const raw = String(process.env.MARROW_CLIENT || process.env.MARROW_HARNESS || process.env.MARROW_AGENT_CLIENT || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/^@/, '');
  const aliases = {
    claude: 'claude-code',
    claude_code: 'claude-code',
    'claude-code': 'claude-code',
    cursor: 'cursor',
    composer: 'composer',
    windsurf: 'windsurf',
    openclaw: 'openclaw',
    codex: 'codex',
    'openai-codex': 'codex',
    gemini: 'gemini',
    google: 'gemini',
    grok: 'grok',
    deepseek: 'deepseek',
    qwen: 'qwen',
    kimi: 'kimi',
    minimax: 'minimax',
    cline: 'cline',
    opencode: 'opencode',
    'open-code': 'opencode',
    hermes: 'hermes',
    'hermes-agent': 'hermes',
    glm: 'glm',
  };
  return aliases[raw] || (SOURCE_CLIENTS.has(raw) ? raw : 'custom');
}

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    yes: false,
    dryRun: false,
    doctor: false,
    repair: false,
    mode: 'auto',
    apiKey: process.env.MARROW_API_KEY || '',
    baseUrl: process.env.MARROW_BASE_URL || DEFAULT_BASE_URL,
    agentId: process.env.MARROW_FLEET_AGENT_ID || process.env.MARROW_AGENT_ID || '',
    selfTest: true,
    selfTestExplicitlyDisabled: false,
    json: false,
    activate: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === 'activate' || arg === '--activate') {
      options.activate = true;
      options.yes = true;
      options.selfTest = true;
    }
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--repair' || arg === 'repair') {
      options.repair = true;
      options.yes = true;
    }
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--doctor' || arg === 'doctor' || arg === 'check') options.doctor = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--no-self-test') {
      options.selfTest = false;
      options.selfTestExplicitlyDisabled = true;
    }
    else if (arg === '--self-test') options.selfTest = true;
    else if (arg === '--cwd') options.cwd = path.resolve(argv[++i] || options.cwd);
    else if (arg === '--mode') options.mode = argv[++i] || options.mode;
    else if (arg === '--key') {
      options.apiKey = argv[++i] || options.apiKey;
      options.keyFromArg = true;
    }
    else if (arg === '--base-url') options.baseUrl = argv[++i] || options.baseUrl;
    else if (arg === '--agent-id') options.agentId = argv[++i] || options.agentId;
    else if (arg === '--mcp') options.mode = 'mcp';
    else if (arg === '--sdk') options.mode = 'sdk';
    else if (arg === '--md' || arg === '--instructions') options.mode = 'md';
    else if (arg === '--both') options.mode = 'both';
    else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!['auto', 'mcp', 'sdk', 'both', 'md'].includes(options.mode)) {
    throw new Error('--mode must be one of auto, mcp, sdk, both, md');
  }
  if (options.activate && options.selfTestExplicitlyDisabled) {
    throw new Error('activate cannot be combined with --no-self-test because server verification is required');
  }
  if (options.activate && options.dryRun) {
    throw new Error('activate cannot be combined with --dry-run; use --dry-run without activate to preview changes');
  }

  return options;
}

function usage() {
  return `Usage:
  npx @getmarrow/install --dry-run
  npx @getmarrow/install activate
  npx @getmarrow/install --yes
  npx @getmarrow/install --repair
  npx @getmarrow/install doctor
  npx @getmarrow/install --mcp --yes
  npx @getmarrow/install --sdk --yes

Options:
  activate           Detect, install, self-test, and return a server-confirmed activation receipt
  --dry-run          Print planned changes without writing
  --doctor           Check install health without writing
  --repair           Write missing hooks/config, then run self-test and status check
  --yes, -y          Write detected config files
  --mode <mode>      auto, mcp, sdk, both, or md
  --key <key>        Marrow API key for self-test. Prefer MARROW_API_KEY because CLI args can appear in process listings.
  --base-url <url>   Marrow API base URL
  --agent-id <id>    Agent/fleet id for self-test headers
  --no-self-test     Skip API smoke/self-test
`;
}

function stableAgentId(root, client = sourceClient()) {
  const identity = `${path.resolve(root)}:${os.hostname()}:${client}`;
  return `${client}-${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 12)}`;
}

function detectedClient(detection) {
  if (sourceClient() !== 'custom') return sourceClient();
  if (detection.openclaw) return 'openclaw';
  if (detection.claudeCode) return 'claude-code';
  if (detection.cursor) return 'cursor';
  if (detection.codex) return 'codex';
  return 'custom';
}

function exists(filePath) {
  return fs.existsSync(filePath);
}

function safeRead(filePath) {
  return exists(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function findUp(startDir, names, maxDepth = 8) {
  let dir = path.resolve(startDir);
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function projectRoot(startDir) {
  const marker = findUp(startDir, ['package.json', 'pyproject.toml', 'requirements.txt', '.git', 'AGENTS.md', 'CLAUDE.md']);
  return marker ? path.dirname(marker) : path.resolve(startDir);
}

function detectEnvironment(cwd = process.cwd(), env = process.env) {
  const root = projectRoot(cwd);
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const paths = {
    root,
    packageJson: path.join(root, 'package.json'),
    pyproject: path.join(root, 'pyproject.toml'),
    requirements: path.join(root, 'requirements.txt'),
    setupPy: path.join(root, 'setup.py'),
    claudeSettings: path.join(root, '.claude', 'settings.json'),
    claudeMd: path.join(root, 'CLAUDE.md'),
    agentsMd: path.join(root, 'AGENTS.md'),
    cursorRules: path.join(root, '.cursor', 'rules', 'marrow.mdc'),
    cursorMcp: path.join(root, '.cursor', 'mcp.json'),
    mcpJson: path.join(root, '.mcp.json'),
    marrowDir: path.join(root, '.marrow'),
    passiveRuntime: path.join(root, '.marrow', 'passive-runtime.mjs'),
    passiveEnv: path.join(root, '.marrow', 'env.example'),
    openclawJson: findUp(root, ['openclaw.json'], 4) || path.join(home, '.openclaw', 'openclaw.json'),
  };

  return {
    root,
    paths,
    node: exists(paths.packageJson),
    python: exists(paths.pyproject) || exists(paths.requirements) || exists(paths.setupPy),
    claudeCode: exists(paths.claudeSettings) || exists(paths.claudeMd),
    cursor: exists(path.join(root, '.cursor')),
    codex: exists(paths.agentsMd) || exists(path.join(root, '.codex')),
    mcpConfig: exists(paths.mcpJson) || exists(paths.cursorMcp) || exists(paths.claudeSettings),
    openclaw: exists(paths.openclawJson) || Boolean(env.OPENCLAW_HOME || env.OPENCLAW_AGENT_ID),
  };
}

function findLikelyEnvFiles(detection, env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const candidates = [
    path.join(detection.root, '.env'),
    path.join(detection.root, '.env.local'),
    path.join(detection.root, '.marrow', 'env'),
    path.join(detection.root, '.marrow', 'env.local'),
    path.join(home, '.marrow', 'env'),
    path.join(home, '.openclaw', 'credentials', 'marrow-mcp.env'),
    path.join(home, '.openclaw', 'gateway.systemd.env'),
  ];
  return candidates.filter((filePath) => {
    if (!exists(filePath)) return false;
    const raw = safeRead(filePath);
    return /\bMARROW_API_KEY\s*=/.test(raw) || /\bMARROW_KEY(_[A-Z0-9]+)?\s*=/.test(raw);
  });
}

function stripQuotes(value) {
  const trimmed = String(value || '').trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readEnvVar(filePath, name) {
  if (!exists(filePath)) return '';
  const raw = safeRead(filePath);
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*([^\\n#]+)`, 'm');
  const match = raw.match(pattern);
  return match ? stripQuotes(match[1]) : '';
}

function readFirstLineSecret(filePath) {
  if (!exists(filePath)) return '';
  return safeRead(filePath).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function readNpmrcToken(filePath) {
  if (!exists(filePath)) return '';
  const raw = safeRead(filePath);
  const match = raw.match(/\/\/registry\.npmjs\.org\/:_authToken\s*=\s*([^\s]+)/);
  return match ? stripQuotes(match[1]) : '';
}

function fingerprint(value) {
  const secret = String(value || '').trim();
  if (!secret) return null;
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 12);
}

function npmTokenPaths(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return {
    openclawEnv: path.join(home, '.openclaw', '.env'),
    credentialFile: path.join(home, '.openclaw', 'credentials', 'npm-getmarrow-token.txt'),
    npmrc: path.join(home, '.npmrc'),
  };
}

function inspectNpmTokenConfig(env = process.env) {
  const paths = npmTokenPaths(env);
  const openclawToken = readEnvVar(paths.openclawEnv, 'NPM_TOKEN');
  const credentialToken = readFirstLineSecret(paths.credentialFile);
  const npmrcToken = readNpmrcToken(paths.npmrc);
  const sourceToken = openclawToken || credentialToken;
  const mismatch = Boolean(sourceToken && npmrcToken && fingerprint(sourceToken) !== fingerprint(npmrcToken));
  const missingNpmrcToken = Boolean(sourceToken && !npmrcToken);

  return {
    safe: {
      npm_token: {
        checked: true,
        repairable: Boolean(sourceToken && (mismatch || missingNpmrcToken)),
        mismatch,
        missing_npmrc_token: missingNpmrcToken,
        sources: {
          openclaw_env: { path: paths.openclawEnv, present: Boolean(openclawToken), fingerprint: fingerprint(openclawToken) },
          credential_file: { path: paths.credentialFile, present: Boolean(credentialToken), fingerprint: fingerprint(credentialToken) },
          npmrc: { path: paths.npmrc, present: Boolean(npmrcToken), fingerprint: fingerprint(npmrcToken) },
        },
        recommended_fix: mismatch || missingNpmrcToken
          ? 'Run npx @getmarrow/install --repair to sync ~/.npmrc from the active OpenClaw/getmarrow npm token source.'
          : null,
      },
    },
    raw: { paths, sourceToken, npmrcToken },
  };
}

function upsertNpmrcToken(filePath, token) {
  const before = safeRead(filePath);
  const tokenLine = `//registry.npmjs.org/:_authToken=${token}`;
  let after;
  if (/\/\/registry\.npmjs\.org\/:_authToken\s*=/.test(before)) {
    after = before.replace(/\/\/registry\.npmjs\.org\/:_authToken\s*=\s*[^\n\r]+/, tokenLine);
  } else {
    const separator = before && !before.endsWith('\n') ? '\n' : '';
    after = `${before}${separator}${tokenLine}\n`;
  }
  if (before !== after) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (before) {
      const backupPath = `${filePath}.marrow-backup`;
      fs.writeFileSync(backupPath, before, { mode: 0o600 });
      fs.chmodSync(backupPath, 0o600);
    }
    fs.writeFileSync(filePath, after, { mode: 0o600 });
    fs.chmodSync(filePath, 0o600);
  }
  return before !== after;
}

function repairConfigDiagnostics(diagnostics, env = process.env) {
  const inspection = inspectNpmTokenConfig(env);
  const npm = diagnostics.npm_token;
  const repairs = [];
  if (npm?.repairable && inspection.raw.sourceToken) {
    const changed = upsertNpmrcToken(inspection.raw.paths.npmrc, inspection.raw.sourceToken);
    repairs.push({
      type: 'npm_token_npmrc_sync',
      changed,
      path: inspection.raw.paths.npmrc,
      message: changed
        ? 'Synced ~/.npmrc npm token from active OpenClaw/getmarrow token source.'
        : '~/.npmrc already matched the active OpenClaw/getmarrow token source.',
    });
  }
  return repairs;
}

function passiveInstructions() {
  return `${MARROW_BLOCK_START}
## Marrow Passive Agent Memory

Marrow should run passively after install:

- Use MCP hooks when available: \`npx -y @getmarrow/mcp setup\`.
- Use SDK passive runtime in owned Node processes: \`createPassiveRuntime().install()\`.
- Keep passive token/model usage proof enabled so Marrow can show token, cost, latency, and workflow savings after real work completes.
- Before risky work, use Marrow's decision brief or passive prompt hook.
- After meaningful work, record the outcome so future agents learn from it.
- Check health with \`marrow_agent_status\` or \`GET /v1/agent/status\`.

Required environment:

- \`MARROW_API_KEY\`
- Optional: \`MARROW_BASE_URL\`, \`MARROW_FLEET_AGENT_ID\`, \`MARROW_CLIENT\`
- Optional: \`MARROW_PASSIVE_TOKEN_USAGE=false\` disables compact provider usage capture when needed.
${MARROW_BLOCK_END}`;
}

function passiveRuntimeSource() {
  return `const apiKey = process.env.MARROW_API_KEY;
if (apiKey && !globalThis.__MARROW_PASSIVE_RUNTIME__) {
  try {
    const { MarrowClient } = await import('@getmarrow/sdk');
    const marrow = new MarrowClient(apiKey, {
      baseUrl: process.env.MARROW_BASE_URL,
      agentId: process.env.MARROW_FLEET_AGENT_ID || process.env.MARROW_AGENT_ID,
      sessionId: process.env.MARROW_SESSION_ID,
      mode: process.env.MARROW_ENFORCEMENT_MODE || 'auto',
    });

    const runtime = marrow.createPassiveRuntime({
      includeValueReport: process.env.MARROW_PASSIVE_VALUE_REPORT !== 'false',
      valueReportPeriod: process.env.MARROW_VALUE_REPORT_PERIOD || '7d',
      useAgentRuntime: process.env.MARROW_AGENT_RUNTIME !== 'false',
      useWorkflowGate: process.env.MARROW_WORKFLOW_GATE !== 'false',
      requireOutcomeClosure: process.env.MARROW_REQUIRE_OUTCOME_CLOSURE !== 'false',
      captureModelUsage: process.env.MARROW_PASSIVE_TOKEN_USAGE !== 'false',
    });

    runtime.install();
    globalThis.__MARROW_PASSIVE_RUNTIME__ = runtime;
  } catch {
    console.warn('[Marrow] passive runtime skipped: install @getmarrow/sdk or verify SDK initialization. Run npm install @getmarrow/sdk, then rerun npx @getmarrow/install --repair.');
  }
}
`;
}

function envExample() {
  return `MARROW_API_KEY=mrw_live_replace_me
MARROW_BASE_URL=${DEFAULT_BASE_URL}
MARROW_FLEET_AGENT_ID=agent-or-fleet-id
MARROW_CLIENT=codex
MARROW_ENFORCEMENT_MODE=auto
MARROW_PASSIVE_BRIEF=auto
MARROW_PASSIVE_VALUE_REPORT=true
MARROW_AGENT_RUNTIME=true
MARROW_WORKFLOW_GATE=true
MARROW_REQUIRE_OUTCOME_CLOSURE=true
MARROW_PASSIVE_TOKEN_USAGE=true
`;
}

function parseJsonObject(filePath) {
  const raw = safeRead(filePath).trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in ${filePath}`);
  }
  return parsed;
}

function upsertBlock(content, block) {
  if (content.includes(MARROW_BLOCK_START) && content.includes(MARROW_BLOCK_END)) {
    const start = content.indexOf(MARROW_BLOCK_START);
    const end = content.indexOf(MARROW_BLOCK_END) + MARROW_BLOCK_END.length;
    return `${content.slice(0, start)}${block}${content.slice(end)}`;
  }
  const separator = content && !content.endsWith('\n') ? '\n\n' : content ? '\n' : '';
  return `${content}${separator}${block}\n`;
}

function exactHookConfigured(settings, eventName, command, matcher) {
  const entries = settings?.hooks?.[eventName];
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    if (matcher != null && entry.matcher !== matcher) return false;
    if (!Array.isArray(entry.hooks)) return false;
    return entry.hooks.some((hook) => (
      hook
      && typeof hook === 'object'
      && !Array.isArray(hook)
      && hook.type === 'command'
      && typeof hook.command === 'string'
      && hook.command.trim() === command
    ));
  });
}

function exactHookDescriptors(settings, eventName, command, matcher) {
  const entries = settings?.hooks?.[eventName];
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    if (matcher != null && entry.matcher !== matcher) return [];
    if (!Array.isArray(entry.hooks)) return [];
    return entry.hooks.flatMap((hook) => {
      if (!hook || typeof hook !== 'object' || Array.isArray(hook)
        || hook.type !== 'command' || typeof hook.command !== 'string'
        || hook.command.trim() !== command) return [];
      return [{
        matcher: typeof entry.matcher === 'string' ? entry.matcher : null,
        command,
        timeout: typeof hook.timeout === 'number' && Number.isFinite(hook.timeout)
          ? hook.timeout
          : null,
      }];
    });
  });
}

function safeJsonObject(filePath) {
  try {
    return parseJsonObject(filePath);
  } catch {
    return {};
  }
}

function claudeNativeHookFingerprint(settings) {
  const contract = {
    schema: 'marrow-claude-native-hooks.v3',
    adapter_version: MCP_ADAPTER_VERSION,
    expected_hooks: NATIVE_EXPECTED_HOOKS,
    configured: {
      prompt: exactHookConfigured(settings, 'UserPromptSubmit', MCP_CONTEXT_HOOK_COMMAND),
      pre_action: exactHookConfigured(settings, 'PreToolUse', MCP_PRE_ACTION_HOOK_COMMAND, NATIVE_HOOK_MATCHER),
      action_result_success: exactHookConfigured(settings, 'PostToolUse', MCP_ACTION_RESULT_HOOK_COMMAND, NATIVE_HOOK_MATCHER),
      action_result_failure: exactHookConfigured(settings, 'PostToolUseFailure', MCP_ACTION_RESULT_HOOK_COMMAND, NATIVE_HOOK_MATCHER),
      session_end: exactHookConfigured(settings, 'Stop', MCP_SESSION_END_HOOK_COMMAND),
    },
    descriptors: {
      prompt: exactHookDescriptors(settings, 'UserPromptSubmit', MCP_CONTEXT_HOOK_COMMAND),
      pre_action: exactHookDescriptors(settings, 'PreToolUse', MCP_PRE_ACTION_HOOK_COMMAND, NATIVE_HOOK_MATCHER),
      action_result_success: exactHookDescriptors(settings, 'PostToolUse', MCP_ACTION_RESULT_HOOK_COMMAND, NATIVE_HOOK_MATCHER),
      action_result_failure: exactHookDescriptors(settings, 'PostToolUseFailure', MCP_ACTION_RESULT_HOOK_COMMAND, NATIVE_HOOK_MATCHER),
      session_end: exactHookDescriptors(settings, 'Stop', MCP_SESSION_END_HOOK_COMMAND),
    },
  };
  return crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

function upsertClaudeHooks(settingsPath) {
  const settings = parseJsonObject(settingsPath);
  const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? settings.hooks
    : {};
  const postToolUse = Array.isArray(hooks.PostToolUse) ? [...hooks.PostToolUse] : [];
  const postToolUseFailure = Array.isArray(hooks.PostToolUseFailure) ? [...hooks.PostToolUseFailure] : [];
  const preToolUse = Array.isArray(hooks.PreToolUse) ? [...hooks.PreToolUse] : [];
  const userPromptSubmit = Array.isArray(hooks.UserPromptSubmit) ? [...hooks.UserPromptSubmit] : [];
  const stop = Array.isArray(hooks.Stop) ? [...hooks.Stop] : [];

  const hasPost = exactHookConfigured(settings, 'PostToolUse', MCP_ACTION_RESULT_HOOK_COMMAND, NATIVE_HOOK_MATCHER);
  const hasPostFailure = exactHookConfigured(settings, 'PostToolUseFailure', MCP_ACTION_RESULT_HOOK_COMMAND, NATIVE_HOOK_MATCHER);
  const hasPre = exactHookConfigured(settings, 'PreToolUse', MCP_PRE_ACTION_HOOK_COMMAND, NATIVE_HOOK_MATCHER);
  const hasPrompt = exactHookConfigured(settings, 'UserPromptSubmit', MCP_CONTEXT_HOOK_COMMAND);
  const hasStop = exactHookConfigured(settings, 'Stop', MCP_SESSION_END_HOOK_COMMAND);

  if (!hasPost) {
    postToolUse.push({
      matcher: 'Bash|Edit|Write|MultiEdit|mcp__(?!marrow_).*',
      hooks: [{ type: 'command', command: MCP_ACTION_RESULT_HOOK_COMMAND }],
    });
  }
  if (!hasPostFailure) {
    postToolUseFailure.push({
      matcher: 'Bash|Edit|Write|MultiEdit|mcp__(?!marrow_).*',
      hooks: [{ type: 'command', command: MCP_ACTION_RESULT_HOOK_COMMAND }],
    });
  }
  if (!hasPre) {
    preToolUse.push({
      matcher: 'Bash|Edit|Write|MultiEdit|mcp__(?!marrow_).*',
      hooks: [{ type: 'command', command: MCP_PRE_ACTION_HOOK_COMMAND }],
    });
  }
  if (!hasPrompt) {
    userPromptSubmit.push({
      hooks: [{ type: 'command', command: MCP_CONTEXT_HOOK_COMMAND }],
    });
  }
  if (!hasStop) {
    stop.push({
      hooks: [{ type: 'command', command: MCP_SESSION_END_HOOK_COMMAND }],
    });
  }

  settings.hooks = {
    ...hooks,
    PreToolUse: preToolUse,
    PostToolUse: postToolUse,
    PostToolUseFailure: postToolUseFailure,
    UserPromptSubmit: userPromptSubmit,
    Stop: stop,
  };

  return JSON.stringify(settings, null, 2) + '\n';
}

function activationProfile(detection, plan, changes, client) {
  const registry = HARNESS_CAPABILITY_REGISTRY.find((entry) => entry.client === client)
    || HARNESS_CAPABILITY_REGISTRY.find((entry) => entry.client === 'custom');
  const sdkDependency = inspectSdkDependency(detection);
  const capabilityLevel = client === 'custom' && (plan.mode === 'sdk' || plan.mode === 'both')
    ? 'sdk_passive_runtime'
    : registry.capability_level;
  const expectedHooks = capabilityLevel === 'sdk_passive_runtime'
    ? ['pre_action', 'action_result', 'outcome_closure']
    : [...registry.automatic];
  const adapterVersion = capabilityLevel === 'native_hooks' || capabilityLevel === 'mcp'
    ? MCP_ADAPTER_VERSION
    : capabilityLevel === 'sdk_passive_runtime'
    ? SDK_ADAPTER_VERSION
    : INSTALLER_ADAPTER_VERSION;
  const observedHooks = [];
  const claudeSettings = safeJsonObject(detection.paths.claudeSettings);
  if (capabilityLevel === 'native_hooks'
    && exactHookConfigured(claudeSettings, 'UserPromptSubmit', MCP_CONTEXT_HOOK_COMMAND)) observedHooks.push('prompt');
  if (capabilityLevel === 'native_hooks'
    && exactHookConfigured(claudeSettings, 'PreToolUse', MCP_PRE_ACTION_HOOK_COMMAND, NATIVE_HOOK_MATCHER)) observedHooks.push('pre_action');
  if (capabilityLevel === 'native_hooks'
    && exactHookConfigured(claudeSettings, 'PostToolUse', MCP_ACTION_RESULT_HOOK_COMMAND, NATIVE_HOOK_MATCHER)
    && exactHookConfigured(claudeSettings, 'PostToolUseFailure', MCP_ACTION_RESULT_HOOK_COMMAND, NATIVE_HOOK_MATCHER)) observedHooks.push('action_result');
  if (capabilityLevel === 'native_hooks'
    && exactHookConfigured(claudeSettings, 'Stop', MCP_SESSION_END_HOOK_COMMAND)) observedHooks.push('session_end');
  const passiveRuntime = safeRead(detection.paths.passiveRuntime);
  if (capabilityLevel === 'sdk_passive_runtime'
    && sdkDependency.present
    && /await import\('@getmarrow\/sdk'\)/.test(passiveRuntime)
    && /runtime\.install\(\)/.test(passiveRuntime)) {
    for (const hook of ['pre_action', 'action_result', 'outcome_closure']) {
      if (!observedHooks.includes(hook)) observedHooks.push(hook);
    }
  }
  const mcpConfigs = [detection.paths.mcpJson, detection.paths.cursorMcp]
    .map((filePath) => safeJsonObject(filePath));
  if (capabilityLevel === 'mcp' && mcpConfigs.some((config) => (
    config?.mcpServers?.marrow?.command === 'npx'
    && Array.isArray(config.mcpServers.marrow.args)
    && config.mcpServers.marrow.args.join(' ') === `-y ${MCP_PACKAGE_SPEC}`
  ))) observedHooks.push('mcp_tool_calls');
  const fingerprintMaterial = changes
    .filter((change) => change.applied || change.already_present)
    .map((change) => `${change.label}:${crypto.createHash('sha256').update(safeRead(change.path)).digest('hex')}`)
    .sort()
    .join('|');
  const configFingerprint = capabilityLevel === 'native_hooks'
    ? claudeNativeHookFingerprint(claudeSettings)
    : crypto.createHash('sha256')
      .update(`${client}:${capabilityLevel}:${expectedHooks.join(',')}:${fingerprintMaterial}`)
      .digest('hex');
  const complete = expectedHooks.length > 0 && expectedHooks.every((hook) => observedHooks.includes(hook));
  const exactFix = complete
    ? null
    : capabilityLevel === 'sdk_passive_runtime' && !sdkDependency.present
    ? `${sdkDependency.install_command} && npx @getmarrow/install --repair`
    : capabilityLevel === 'governed_wrapper'
    ? `npx @getmarrow/install run --agent <agent-id> -- ${client}`
    : 'npx @getmarrow/install --repair';
  return {
    adapter_version: adapterVersion,
    capability_level: capabilityLevel,
    config_fingerprint: configFingerprint,
    expected_hooks: expectedHooks,
    observed_hooks: observedHooks,
    complete,
    exact_fix: exactFix,
  };
}

function upsertMcpServerConfig(filePath) {
  const config = parseJsonObject(filePath);
  const servers = config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
    ? config.mcpServers
    : {};
  servers.marrow = {
    command: 'npx',
    args: ['-y', MCP_PACKAGE_SPEC],
    env: {
      MARROW_API_KEY: '${MARROW_API_KEY}',
      MARROW_BASE_URL: '${MARROW_BASE_URL}',
      MARROW_FLEET_AGENT_ID: '${MARROW_FLEET_AGENT_ID}',
    },
  };
  config.mcpServers = servers;
  return JSON.stringify(config, null, 2) + '\n';
}

function inspectSdkDependency(detection) {
  if (!detection.node) {
    return { required: false, present: false, install_command: null };
  }

  const raw = safeRead(detection.paths.packageJson);
  let packageJson = {};
  try {
    packageJson = raw ? JSON.parse(raw) : {};
  } catch {
    return {
      required: true,
      present: false,
      install_command: `npm install @getmarrow/sdk@${SDK_ADAPTER_VERSION}`,
      warning: 'package.json could not be parsed; verify @getmarrow/sdk manually.',
    };
  }

  const dependencyBlocks = [
    packageJson.dependencies,
    packageJson.devDependencies,
    packageJson.optionalDependencies,
    packageJson.peerDependencies,
  ];
  const declaredSpec = dependencyBlocks
    .map((deps) => deps && typeof deps['@getmarrow/sdk'] === 'string' ? deps['@getmarrow/sdk'] : null)
    .find(Boolean) || null;
  const installedPackagePath = findUp(
    detection.root,
    [path.join('node_modules', '@getmarrow', 'sdk', 'package.json')],
  );
  let installedVersion = null;
  try {
    const installedPackage = installedPackagePath ? JSON.parse(safeRead(installedPackagePath)) : null;
    installedVersion = typeof installedPackage?.version === 'string' ? installedPackage.version : null;
  } catch {
    installedVersion = null;
  }
  const present = declaredSpec != null && installedVersion === SDK_ADAPTER_VERSION;
  return {
    required: true,
    present,
    declared: declaredSpec != null,
    declared_spec: declaredSpec,
    installed_version: installedVersion,
    expected_version: SDK_ADAPTER_VERSION,
    install_command: present ? null : `npm install @getmarrow/sdk@${SDK_ADAPTER_VERSION}`,
  };
}

function buildPlan(detection, options) {
  const mode = options.mode === 'auto'
    ? detection.node && (detection.claudeCode || detection.cursor || detection.codex || detection.openclaw)
      ? 'both'
      : detection.node
      ? 'sdk'
      : 'mcp'
    : options.mode;
  const writes = [];

  if (mode === 'sdk' || mode === 'both') {
    writes.push({
      type: 'file',
      path: detection.paths.passiveRuntime,
      label: 'SDK passive runtime preload',
      content: passiveRuntimeSource(),
    });
    writes.push({
      type: 'file',
      path: detection.paths.passiveEnv,
      label: 'Marrow passive env example',
      content: envExample(),
      overwrite: false,
    });
  }

  if (mode === 'mcp' || mode === 'both') {
    if (detection.claudeCode) {
      writes.push({
        type: 'json-transform',
        path: detection.paths.claudeSettings,
        label: 'Claude Code MCP passive hooks',
        transform: upsertClaudeHooks,
      });
    }
    writes.push({
      type: 'json-transform',
      path: detection.paths.mcpJson,
      label: 'Project MCP server config',
      transform: upsertMcpServerConfig,
    });
  }

  if (mode === 'md' || mode === 'both' || mode === 'mcp') {
    writes.push({
      type: 'md-block',
      path: detection.paths.agentsMd,
      label: 'Agent instructions',
      block: passiveInstructions(),
    });
  }

  if (detection.cursor && (mode === 'md' || mode === 'both' || mode === 'mcp')) {
    writes.push({
      type: 'file',
      path: detection.paths.cursorRules,
      label: 'Cursor Marrow rule',
      content: passiveInstructions().replace(/<!--[^>]+-->/g, '').trim() + '\n',
    });
  }

  return { mode, writes };
}

function applyPlan(plan, options) {
  const changes = [];
  for (const write of plan.writes) {
    const before = safeRead(write.path);
    let after;
    if (write.type === 'file') {
      if (write.overwrite === false && before) {
        after = before;
      } else {
        after = write.content;
      }
    } else if (write.type === 'md-block') {
      after = upsertBlock(before, write.block);
    } else if (write.type === 'json-transform') {
      after = write.transform(write.path);
    } else {
      throw new Error(`Unknown write type: ${write.type}`);
    }

    const changed = before !== after;
    const writeApplied = Boolean(options.yes && !options.dryRun && !options.doctor);
    changes.push({
      path: write.path,
      label: write.label,
      changed,
      applied: changed && writeApplied,
      already_present: !changed,
    });
    if (changed && writeApplied) {
      fs.mkdirSync(path.dirname(write.path), { recursive: true });
      fs.writeFileSync(write.path, after);
    }
  }
  return changes;
}

async function requestJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    const message = json.error || json.message || `HTTP ${res.status}`;
    throw new Error(String(message));
  }
  return json.data || json;
}

function isCanonicalTimestamp(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function runtimeGateVerified(runtime) {
  if (!runtime || typeof runtime !== 'object') return false;
  if (runtime.ok === true) return true;
  const gate = runtime.risk_gate;
  if (!gate || typeof gate !== 'object') return false;
  if (typeof gate.allow === 'boolean' || typeof gate.allowed === 'boolean') return true;
  const decision = typeof gate.decision === 'string' ? gate.decision.toLowerCase() : '';
  return ['allow', 'warn', 'review_required', 'block'].includes(decision);
}

async function runSelfTest(options) {
  if (!options.selfTest) return { skipped: true, reason: 'disabled' };
  if (!options.apiKey) {
    return {
      skipped: true,
      reason: 'missing MARROW_API_KEY',
      exact_fix: 'export MARROW_API_KEY=mrw_live_... && npx @getmarrow/install --repair',
    };
  }

  const headers = {
    authorization: `Bearer ${options.apiKey}`,
    'content-type': 'application/json',
    'x-marrow-session-id': `install-${Date.now()}`,
    'x-marrow-client': options.client || sourceClient(),
  };
  if (options.agentId) headers['x-marrow-agent-id'] = options.agentId;

  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const think = await requestJson(`${baseUrl}/v1/agent/think`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: 'process',
      action: 'Marrow passive install self-test: verify SDK/MCP hooks can record a harmless setup event',
      source_meta: {
        channel: 'cli',
        client: options.client || sourceClient(),
        user_intent: 'operate',
      },
    }),
  });

  const decisionId = think.decision_id || think.decisionId;
  if (!decisionId) throw new Error('self-test did not return decision_id');

  await requestJson(`${baseUrl}/v1/agent/commit`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      decision_id: decisionId,
      success: true,
      outcome: 'Marrow passive installer self-test completed successfully',
    }),
  });

  const status = await requestJson(`${baseUrl}/v1/agent/status`, { headers });
  const runtime = await requestJson(`${baseUrl}/v1/agent/runtime`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      action: 'Marrow passive install self-test: verify one-call agent runtime and outcome closure',
      type: 'process',
      role: 'general',
      surfaces: ['workspace'],
      proof: {
        checks: ['installer self-test'],
        outcome: 'self-test outcome committed',
      },
    }),
  });
  const performance = await requestJson(`${baseUrl}/v1/analytics/agent-performance?period=7`, { headers })
    .catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  const firstValue = await requestJson(`${baseUrl}/v1/agent/first-value`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      action: 'I am about to deploy to production. What should I check first?',
      type: 'deploy',
      role: 'deploy',
      surfaces: ['production', 'deploy'],
      proof: {
        checks: ['installer first-value self-test'],
        outcome: 'first-value endpoint reached',
      },
      decision_id: decisionId,
      agent_id: options.agentId,
      activation: options.activation ? {
        ...options.activation,
        intervention_verified: runtimeGateVerified(runtime),
        closure_verified: true,
      } : undefined,
    }),
  });
  const valueProof = await requestJson(`${baseUrl}/v1/agent/value/proof?period_days=30`, { headers })
    .catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  const tokenValueProof = buildTokenValueProof(valueProof);
  const firstValueSignal = buildFirstValueSignal(status, runtime, performance, firstValue, tokenValueProof);
  const installValueMoment = buildInstallValueMoment(firstValueSignal, status, runtime, performance, firstValue, tokenValueProof);
  let activationReceipt = null;
  let activationVerified = false;
  let activationProfileReceipt = null;
  if (options.activation) {
    const activationAdapterVersion = options.activation.adapter_version || INSTALLER_ADAPTER_VERSION;
    const activationCapabilityLevel = options.activation.capability_level || 'event_contract';
    const activationExpectedHooks = Array.isArray(options.activation.expected_hooks) ? options.activation.expected_hooks : [];
    const activationConfigFingerprint = options.activation.config_fingerprint || crypto.createHash('sha256')
      .update(JSON.stringify({
        harness: options.activation.harness || options.client || 'custom',
        install_surface: options.activation.install_surface || 'unknown',
        adapter_version: activationAdapterVersion,
        expected_hooks: activationExpectedHooks,
      }))
      .digest('hex');
    activationReceipt = firstValue && firstValue.activation_receipt;
    const receiptValid = activationReceipt
      && typeof activationReceipt === 'object'
      && typeof activationReceipt.id === 'string'
      && activationReceipt.id.length > 0
      && activationReceipt.decision_id === decisionId
      && activationReceipt.agent_id === options.agentId
      && activationReceipt.outcome_success === true
      && isCanonicalTimestamp(activationReceipt.outcome_recorded_at)
      && activationReceipt.server_confirmed === true
      && activationReceipt.capture_verified === true
      && activationReceipt.intervention_verified === true
      && activationReceipt.closure_verified === true;
    if (!receiptValid) {
      throw new Error('activation receipt did not verify the exact self-test decision, agent, runtime gate, and closed successful outcome');
    }
    activationProfileReceipt = await requestJson(`${baseUrl}/v1/agent/integrations/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        event_id: `activation-${activationConfigFingerprint.slice(0, 32)}`,
        event_type: 'activation_profile_registered',
        harness: options.activation.harness,
        agent_id: options.agentId,
        session_id: headers['x-marrow-session-id'],
        adapter_version: activationAdapterVersion,
        capability_level: activationCapabilityLevel,
        config_fingerprint: activationConfigFingerprint,
        expected_hooks: activationExpectedHooks,
        action: 'passive integration activation profile registered',
        occurred_at: new Date().toISOString(),
      }),
    });
    const profileCoverage = activationProfileReceipt?.activation_coverage;
    const profileReceipt = profileCoverage?.profile_receipt;
    const expectedConfigurationBindingId = crypto.createHash('sha256')
      .update(`agent-config-receipt:v1:${activationConfigFingerprint}`)
      .digest('hex');
    const accountBindingId = profileCoverage?.account_binding_id;
    const expectedHooksMatch = Array.isArray(profileCoverage?.capture_coverage?.expected_hooks)
      && [...profileCoverage.capture_coverage.expected_hooks].sort().join(',') === [...activationExpectedHooks].sort().join(',');
    const profileBound = Boolean(
      activationProfileReceipt?.accepted === true
      && profileCoverage?.agent_id === options.agentId
      && profileCoverage?.harness === options.activation.harness
      && profileCoverage?.activation?.adapter_version === activationAdapterVersion
      && profileCoverage?.activation?.capability_level === activationCapabilityLevel
      && profileReceipt?.agent_id === options.agentId
      && profileReceipt?.harness === options.activation.harness
      && profileReceipt?.adapter_version === activationAdapterVersion
      && profileReceipt?.capability_level === activationCapabilityLevel
      && typeof accountBindingId === 'string'
      && accountBindingId.length === 64
      && profileReceipt?.account_binding_id === accountBindingId
      && profileReceipt?.config_fingerprint_verified === true
      && profileReceipt?.configuration_binding_id === expectedConfigurationBindingId
      && profileReceipt?.expected_hooks_verified === true
      && expectedHooksMatch
    );
    activationVerified = Boolean(
      firstValue.active
      && runtimeGateVerified(runtime)
      && (status.enabled ?? status.ok)
      && options.activation.complete === true
      && profileBound,
    );
    if (!activationVerified) {
      throw new Error('activation prerequisites were not all verified by the server');
    }
  }
  return {
    skipped: false,
    decision_id: decisionId,
    active: Boolean(status.enabled ?? status.ok),
    health: status.health || null,
    last_event_at: status.last_event_at || null,
    recommended_fix: status.recommended_fix || null,
    next_action: status.next_action || null,
    auto_outcome_closure: status.auto_outcome_closure || null,
    runtime_active: runtimeGateVerified(runtime),
    runtime_exact_next_action: runtime.exact_next_action || null,
    runtime_before_you_act: runtime.before_you_act || null,
    activation_verified: activationVerified,
    activation_receipt: activationReceipt,
    activation_profile_receipt: activationProfileReceipt,
    activation_coverage: status.activation_coverage || firstValue.activation_coverage || null,
    first_value: firstValue && firstValue.ok !== false ? firstValue : null,
    first_value_signal: firstValueSignal,
    install_value_moment: installValueMoment,
    token_value_proof: tokenValueProof,
    performance_proof: performance && performance.ok !== false ? {
      avoided_mistakes: performance.avoided_mistakes ?? performance.avoided_repeated_mistakes ?? 0,
      reused_winning_decisions: performance.reused_winning_decisions ?? 0,
      prevented_bad_actions: performance.prevented_bad_actions ?? 0,
      estimated_tokens_saved: performance.token_time_saved_estimate?.estimated_tokens_saved ?? 0,
      estimated_minutes_saved: performance.token_time_saved_estimate?.estimated_minutes_saved ?? 0,
      reliability_score: performance.agent_reliability_score ?? null,
    } : null,
  };
}

function buildTokenValueProof(valueProof = {}) {
  const modelUsage = valueProof && valueProof.ok !== false
    ? valueProof.model_usage || valueProof.token_value_signal || valueProof
    : null;
  if (!modelUsage || typeof modelUsage !== 'object') {
    return {
      enabled: true,
      capture_default: 'on_when_sdk_mcp_or_installer_hooks_available',
      observed: { model_calls: 0, tokens: { total: 0 } },
      savings: { estimated_tokens_saved: 0, estimated_minutes_saved: 0, confidence: 'none', method: 'warming_up' },
      proof_line: 'Token usage capture is ready; no model calls have been reported yet.',
      exact_next_action: 'Keep passive token capture enabled so Marrow can attach usage proof after real model calls complete.',
    };
  }
  return modelUsage;
}

function buildInstallValueMoment(firstValueSignal = {}, status = {}, runtime = {}, performance = {}, firstValue = {}, tokenValueProof = null) {
  if (firstValue && firstValue.ok !== false && firstValue.first_value) {
    const proof = Array.isArray(firstValue.first_value.proof) ? [...firstValue.first_value.proof] : [];
    if (tokenValueProof?.proof_line && !proof.includes(tokenValueProof.proof_line)) proof.push(tokenValueProof.proof_line);
    return {
      headline: firstValue.headline || firstValue.first_value.headline || 'Your agent is no longer starting from zero.',
      proof,
      fleet_signal: firstValue.history_signal?.summary || 'Fresh account: Marrow will build fleet memory from this first captured outcome.',
      try_this_now: firstValue.first_value.try_this_now || 'Ask your agent: "I am about to deploy to production. What should I check first?"',
      expected_response: firstValue.first_value.expected_response || 'Marrow should answer with a risk gate, required proof, and any matching fleet lessons before the agent acts.',
      first_lesson: firstValue.first_value.first_lesson || null,
    };
  }

  const proof = firstValueSignal.value_proof || [];
  const hasFleetSignal = proof.length > 0;
  const runtimeLesson = runtime.before_you_act
    || runtime.before_you_act_injection?.message
    || runtime.exact_next_action
    || firstValueSignal.first_lesson;

  return {
    headline: 'Your agent is no longer starting from zero.',
    proof: [
      'Captured this setup decision',
      'Closed the outcome successfully',
      'Runtime gate is ' + (firstValueSignal.active ? 'active' : 'installed'),
      runtimeLesson ? 'Future risky work now gets a pre-action brief' : 'Future risky work now gets checked before action',
      tokenValueProof?.proof_line || 'Token usage proof is active and warming up after the first model call',
    ],
    fleet_signal: hasFleetSignal
      ? 'Marrow already found signal: ' + proof.join('; ') + '.'
      : 'Fresh account: Marrow will start building fleet memory from this first captured outcome.',
    try_this_now: 'Ask your agent: "I am about to deploy to production. What should I check first?"',
    expected_response: 'Marrow should answer with a risk gate, required proof, and any matching fleet lessons before the agent acts.',
    first_lesson: runtimeLesson || 'Marrow will surface prior lessons before risky or repeated work.',
  };
}

function buildFirstValueSignal(status, runtime, performance, firstValue = {}, tokenValueProof = null) {
  if (firstValue && firstValue.ok !== false && firstValue.first_value) {
    const capture = firstValue.capture || {};
    const proof = firstValue.value_proof || {};
    const proofBits = [];
    if (Number(proof.avoided_mistakes || 0) > 0) proofBits.push(`${proof.avoided_mistakes} avoided mistake(s)`);
    if (Number(proof.reused_winning_decisions || 0) > 0) proofBits.push(`${proof.reused_winning_decisions} reused winning decision(s)`);
    if (Number(proof.prevented_bad_actions || 0) > 0) proofBits.push(`${proof.prevented_bad_actions} prevented risky action(s)`);
    if (Number(proof.estimated_tokens_saved || 0) > 0) proofBits.push(`~${proof.estimated_tokens_saved} tokens saved`);
    if (Number(tokenValueProof?.savings?.estimated_tokens_saved || 0) > 0) proofBits.push(`~${tokenValueProof.savings.estimated_tokens_saved} measured model tokens saved`);
    else if (tokenValueProof?.proof_line) proofBits.push(tokenValueProof.proof_line);
    return {
      active: Boolean(firstValue.active),
      headline: `Marrow active: ${(capture.surfaces || ['decisions']).join(', ')} captured.`,
      captured: capture.surfaces || ['decisions'],
      first_lesson: firstValue.first_value.first_lesson,
      value_proof: proofBits,
      next_action: firstValue.next_action?.reason || 'Keep working; Marrow will capture outcomes and reuse lessons automatically.',
    };
  }

  const capture = status.capture_coverage || {};
  const closure = status.auto_outcome_closure || {};
  const captured = [];
  if (status.enabled || capture.decisions) captured.push('decisions');
  if (capture.tools === 'detected') captured.push('tools');
  if (capture.commands === 'detected') captured.push('commands');
  if (capture.deploys === 'detected') captured.push('deploys');
  if (capture.publishes === 'detected') captured.push('publishes');
  if (closure.state) captured.push(`outcomes:${closure.state}`);

  const proof = performance && performance.ok !== false ? performance : {};
  const proofBits = [];
  if (Number(proof.avoided_mistakes || proof.avoided_repeated_mistakes || 0) > 0) proofBits.push(`${proof.avoided_mistakes || proof.avoided_repeated_mistakes} avoided mistake(s)`);
  if (Number(proof.reused_winning_decisions || 0) > 0) proofBits.push(`${proof.reused_winning_decisions} reused winning decision(s)`);
  if (Number(proof.prevented_bad_actions || 0) > 0) proofBits.push(`${proof.prevented_bad_actions} prevented risky action(s)`);
  const tokens = proof.token_time_saved_estimate?.estimated_tokens_saved || 0;
  if (tokens > 0) proofBits.push(`~${tokens} tokens saved`);
  if (Number(tokenValueProof?.savings?.estimated_tokens_saved || 0) > 0) proofBits.push(`~${tokenValueProof.savings.estimated_tokens_saved} measured model tokens saved`);
  else if (tokenValueProof?.proof_line) proofBits.push(tokenValueProof.proof_line);

  const firstLesson = runtime.before_you_act
    || runtime.before_you_act_injection?.message
    || runtime.exact_next_action
    || status.recommended_fix
    || 'Marrow will surface prior lessons before risky or repeated work.';

  return {
    active: Boolean(status.enabled ?? status.ok),
    headline: `Marrow active: ${captured.length ? captured.join(', ') : 'decisions'} captured.`,
    captured,
    first_lesson: firstLesson,
    value_proof: proofBits,
    next_action: runtime.exact_next_action || status.next_action || 'Keep working; Marrow will capture outcomes and reuse lessons automatically.',
  };
}

function printReport(report) {
  process.stdout.write(`Marrow passive installer\n`);
  process.stdout.write(`Root: ${report.root}\n`);
  process.stdout.write(`Mode: ${report.mode}\n`);
  process.stdout.write(`Write mode: ${report.writeMode}\n\n`);

  if (report.activation?.requested) {
    process.stdout.write('Activation:\n');
    process.stdout.write(`- agent: ${report.activation.agent_id}\n`);
    process.stdout.write(`- server confirmed: ${report.activation.server_confirmed ? 'yes' : 'no'}\n\n`);
  }

  process.stdout.write('Detected:\n');
  for (const [key, value] of Object.entries(report.detected)) {
    process.stdout.write(`- ${key}: ${value ? 'yes' : 'no'}\n`);
  }

  process.stdout.write('\nPlanned changes:\n');
  for (const change of report.changes) {
    const marker = change.changed ? (['write', 'repair'].includes(report.writeMode) ? 'wrote' : 'would write') : 'unchanged';
    process.stdout.write(`- ${marker}: ${change.label} (${change.path})\n`);
  }

  process.stdout.write('\nSelf-test:\n');
  if (report.selfTest.skipped) {
    process.stdout.write(`- skipped: ${report.selfTest.reason}\n`);
    if (report.selfTest.exact_fix) process.stdout.write(`- exact fix: ${report.selfTest.exact_fix}\n`);
  } else {
    process.stdout.write(`- active: ${report.selfTest.active ? 'yes' : 'no'}\n`);
    process.stdout.write(`- decision_id: ${report.selfTest.decision_id}\n`);
    process.stdout.write(`- health: ${report.selfTest.health || 'unknown'}\n`);
    process.stdout.write(`- one-call runtime: ${report.selfTest.runtime_active ? 'active' : 'not verified'}\n`);
    if (report.selfTest.error) process.stdout.write(`- error: ${report.selfTest.error}\n`);
    if (report.selfTest.next_action) process.stdout.write(`- next action: ${report.selfTest.next_action}\n`);
    if (report.selfTest.first_value_signal) {
      process.stdout.write('\nFirst value:\n');
      const valueMoment = report.selfTest.install_value_moment;
      if (valueMoment) {
        process.stdout.write(`- ${valueMoment.headline}\n`);
        process.stdout.write('- First proof:\n');
        for (const proof of valueMoment.proof) process.stdout.write(`  - ${proof}\n`);
        process.stdout.write(`- ${valueMoment.fleet_signal}\n`);
        process.stdout.write(`- Try this now: ${valueMoment.try_this_now}\n`);
        process.stdout.write(`- Expected: ${valueMoment.expected_response}\n`);
      } else {
        process.stdout.write(`- ${report.selfTest.first_value_signal.headline}\n`);
        process.stdout.write(`- First useful lesson: ${report.selfTest.first_value_signal.first_lesson}\n`);
        if (report.selfTest.first_value_signal.value_proof.length) {
          process.stdout.write(`- Proof: ${report.selfTest.first_value_signal.value_proof.join('; ')}\n`);
        }
        process.stdout.write(`- Next: ${report.selfTest.first_value_signal.next_action}\n`);
      }
    }
    if (report.selfTest.token_value_proof) {
      const proof = report.selfTest.token_value_proof;
      const observed = proof.observed || {};
      const savings = proof.savings || {};
      const tokens = observed.tokens || {};
      process.stdout.write('\nToken value proof:\n');
      process.stdout.write(`- passive capture: ${proof.enabled ? 'on' : 'unknown'}\n`);
      process.stdout.write(`- model calls observed: ${observed.model_calls || 0}\n`);
      process.stdout.write(`- tokens observed: ${tokens.total || 0}\n`);
      process.stdout.write(`- estimated tokens saved: ${savings.estimated_tokens_saved || 0}\n`);
      if (savings.confidence) process.stdout.write(`- confidence: ${savings.confidence}\n`);
      if (proof.proof_line) process.stdout.write(`- proof: ${proof.proof_line}\n`);
      if (proof.exact_next_action) process.stdout.write(`- next: ${proof.exact_next_action}\n`);
    }
  }

  if (report.remediation) {
    process.stdout.write('\nRemediation:\n');
    process.stdout.write(`- attempted: ${report.remediation.attempted ? 'yes' : 'no'}\n`);
    process.stdout.write(`- fixed config: ${report.remediation.fixedConfig ? 'yes' : 'no'}\n`);
    process.stdout.write(`- self-test passed: ${report.remediation.selfTestPassed ? 'yes' : 'no'}\n`);
    if (report.remediation.message) process.stdout.write(`- result: ${report.remediation.message}\n`);
  }

  if (report.configDiagnostics?.npm_token?.mismatch || report.configDiagnostics?.npm_token?.missing_npmrc_token) {
    const npm = report.configDiagnostics.npm_token;
    process.stdout.write('\nConfig diagnostics:\n');
    process.stdout.write(`- npm token mismatch: ${npm.mismatch ? 'yes' : 'no'}\n`);
    process.stdout.write(`- npmrc token missing: ${npm.missing_npmrc_token ? 'yes' : 'no'}\n`);
    process.stdout.write(`- repairable: ${npm.repairable ? 'yes' : 'no'}\n`);
    if (npm.recommended_fix) process.stdout.write(`- exact fix: ${npm.recommended_fix}\n`);
  }

  if (report.configRepairs?.length) {
    process.stdout.write('\nConfig repairs:\n');
    for (const repair of report.configRepairs) {
      process.stdout.write(`- ${repair.changed ? 'fixed' : 'checked'}: ${repair.message}\n`);
    }
  }

  if (report.sdkDependency?.required) {
    process.stdout.write('\nSDK dependency:\n');
    process.stdout.write(`- @getmarrow/sdk: ${report.sdkDependency.present ? 'present' : 'missing'}\n`);
    if (report.sdkDependency.install_command) process.stdout.write(`- exact fix: ${report.sdkDependency.install_command}\n`);
    if (report.sdkDependency.warning) process.stdout.write(`- warning: ${report.sdkDependency.warning}\n`);
  }

  if (report.writeMode === 'doctor') {
    process.stdout.write('\nDoctor:\n');
    process.stdout.write(`- Marrow active: ${report.doctor.active ? 'yes' : 'no'}\n`);
    process.stdout.write(`- missing env: ${report.doctor.missingEnv.length ? report.doctor.missingEnv.join(', ') : 'none'}\n`);
    if (report.doctor.envHints.length) process.stdout.write(`- possible env files: ${report.doctor.envHints.join(', ')}\n`);
    process.stdout.write(`- missing hooks/config: ${report.doctor.missingHooks.length ? report.doctor.missingHooks.join('; ') : 'none'}\n`);
    if (report.doctor.recommendedFix) process.stdout.write(`- recommended fix: ${report.doctor.recommendedFix}\n`);
  }

  if (report.writeMode === 'dry-run') {
    process.stdout.write('\nRun with --yes to write these changes.\n');
  }

  if (report.warnings.length > 0) {
    process.stdout.write('\nWarnings:\n');
    for (const warning of report.warnings) {
      process.stdout.write(`- ${warning}\n`);
    }
  }
}

async function install(options) {
  if (options.activate && (options.yes !== true || options.dryRun || options.doctor)) {
    throw new Error('activate requires write mode (--yes) because hooks must be installed during this run');
  }
  if (options.activate && options.selfTest === false) {
    throw new Error('activate requires the server self-test');
  }
  const detection = detectEnvironment(options.cwd);
  const plan = buildPlan(detection, options);
  const writeMode = options.doctor ? 'doctor' : options.dryRun ? 'dry-run' : options.repair ? 'repair' : options.yes ? 'write' : 'dry-run';
  const changes = applyPlan(plan, options);
  const client = detectedClient(detection);
  options.client = client;
  if (!options.agentId) options.agentId = stableAgentId(detection.root, client);
  const profile = activationProfile(detection, plan, changes, client);
  options.activation = options.activate ? {
    harness: client,
    agent_id: options.agentId,
    install_surface: plan.mode,
    mode: options.governanceMode || 'passive',
    hooks_installed: changes
      .filter((change) => change.changed && change.applied && /hook|runtime|rule|instruction|config/i.test(change.label))
      .map((change) => change.label)
      .slice(0, 20),
    capture_verified: changes.every((change) => change.applied || change.already_present),
    adapter_version: profile.adapter_version,
    capability_level: profile.capability_level,
    config_fingerprint: profile.config_fingerprint,
    expected_hooks: profile.expected_hooks,
    observed_hooks: profile.observed_hooks,
    complete: profile.complete,
    intervention_verified: false,
    closure_verified: false,
  } : null;
  const configInspection = inspectNpmTokenConfig();
  const sdkDependency = inspectSdkDependency(detection);
  const configDiagnostics = configInspection.safe;
  const configRepairs = options.repair && !options.dryRun && !options.doctor
    ? repairConfigDiagnostics(configDiagnostics)
    : [];
  const envHints = options.apiKey ? [] : findLikelyEnvFiles(detection);
  let selfTest;
  try {
    selfTest = await runSelfTest(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.activate) throw new Error(`Marrow activation failed: ${message}`);
    selfTest = { skipped: false, active: false, error: message };
  }
  if (options.activate && !selfTest.activation_verified) {
    throw new Error('Marrow activation failed: server confirmation was not returned');
  }
  const changedConfig = changes.some((change) => change.changed) || configRepairs.some((repair) => repair.changed);
  const selfTestPassed = Boolean(!selfTest.skipped && selfTest.active && !selfTest.error);
  const remediation = options.repair
    ? {
      attempted: true,
      fixedConfig: changedConfig,
      selfTestPassed,
      message: selfTestPassed
        ? selfTest.health === 'healthy'
          ? 'I fixed Marrow passive config, one-call runtime is active, and self-test passed.'
          : `I fixed Marrow passive config and self-test passed; status is ${selfTest.health || 'unknown'}${selfTest.next_action ? `. Next action: ${selfTest.next_action}` : ''}.`
        : selfTest.skipped
        ? `Config repair ran, but self-test skipped: ${selfTest.reason}.`
        : `Config repair ran, but self-test failed: ${selfTest.error || 'unknown error'}.`,
    }
    : null;

  return {
    root: detection.root,
    mode: plan.mode,
    writeMode,
    detected: {
      node: detection.node,
      python: detection.python,
      claudeCode: detection.claudeCode,
      cursor: detection.cursor,
      codex: detection.codex,
      openclaw: detection.openclaw,
      mcpConfig: detection.mcpConfig,
    },
    activation: {
      requested: options.activate,
      agent_id: options.agentId,
      server_confirmed: Boolean(selfTest.activation_verified),
      receipt: selfTest.activation_receipt || null,
      profile,
    },
    changes,
    doctor: {
      active: Boolean(!selfTest.skipped && selfTest.active),
      missingEnv: options.apiKey ? [] : ['MARROW_API_KEY'],
      envHints,
      missingHooks: changes.filter((change) => change.changed).map((change) => change.label),
      recommendedFix: configDiagnostics.npm_token.recommended_fix || selfTest.recommended_fix || (!options.apiKey
        ? envHints.length
          ? `MARROW_API_KEY was found in a likely env file at ${envHints[0]}. Load that key from trusted secret storage, export only MARROW_API_KEY, then run npx @getmarrow/install --repair.`
          : 'Set MARROW_API_KEY, then run npx @getmarrow/install --repair.'
        : null),
    },
    remediation,
    configDiagnostics,
    configRepairs,
    sdkDependency,
    selfTest,
    warnings: options.keyFromArg
      ? ['Avoid --key in shared shells because command-line arguments can be visible in process listings. Prefer MARROW_API_KEY in your environment or secret manager.']
      : [],
  };
}

async function runCli(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const report = await install(options);
  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    printReport(report);
  }
}

module.exports = {
  parseArgs,
  detectEnvironment,
  buildPlan,
  applyPlan,
  install,
  runSelfTest,
  runCli,
  passiveRuntimeSource,
  inspectNpmTokenConfig,
  inspectSdkDependency,
  buildInstallValueMoment,
  buildTokenValueProof,
  stableAgentId,
  activationProfile,
  claudeNativeHookFingerprint,
  printReport,
  HARNESS_CAPABILITY_REGISTRY,
};

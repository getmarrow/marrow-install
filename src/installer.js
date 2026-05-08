const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const DEFAULT_BASE_URL = 'https://api.getmarrow.ai';
const MARROW_BLOCK_START = '<!-- marrow:passive-start -->';
const MARROW_BLOCK_END = '<!-- marrow:passive-end -->';

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    yes: false,
    dryRun: false,
    mode: 'auto',
    apiKey: process.env.MARROW_API_KEY || '',
    baseUrl: process.env.MARROW_BASE_URL || DEFAULT_BASE_URL,
    agentId: process.env.MARROW_FLEET_AGENT_ID || process.env.MARROW_AGENT_ID || '',
    selfTest: true,
    json: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--no-self-test') options.selfTest = false;
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

  return options;
}

function usage() {
  return `Usage:
  npx @getmarrow/install --dry-run
  npx @getmarrow/install --yes
  npx @getmarrow/install --mcp --yes
  npx @getmarrow/install --sdk --yes

Options:
  --dry-run          Print planned changes without writing
  --yes, -y          Write detected config files
  --mode <mode>      auto, mcp, sdk, both, or md
  --key <key>        Marrow API key for self-test. Prefer MARROW_API_KEY because CLI args can appear in process listings.
  --base-url <url>   Marrow API base URL
  --agent-id <id>    Agent/fleet id for self-test headers
  --no-self-test     Skip API smoke/self-test
`;
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

function passiveInstructions() {
  return `${MARROW_BLOCK_START}
## Marrow Passive Agent Memory

Marrow should run passively after install:

- Use MCP hooks when available: \`npx -y @getmarrow/mcp setup\`.
- Use SDK passive runtime in owned Node processes: \`createPassiveRuntime().install()\`.
- Before risky work, use Marrow's decision brief or passive prompt hook.
- After meaningful work, record the outcome so future agents learn from it.
- Check health with \`marrow_agent_status\` or \`GET /v1/agent/status\`.

Required environment:

- \`MARROW_API_KEY\`
- Optional: \`MARROW_BASE_URL\`, \`MARROW_FLEET_AGENT_ID\`
${MARROW_BLOCK_END}`;
}

function passiveRuntimeSource() {
  return `import { MarrowClient } from '@getmarrow/sdk';

const apiKey = process.env.MARROW_API_KEY;
if (apiKey && !globalThis.__MARROW_PASSIVE_RUNTIME__) {
  const marrow = new MarrowClient(apiKey, {
    baseUrl: process.env.MARROW_BASE_URL,
    agentId: process.env.MARROW_FLEET_AGENT_ID || process.env.MARROW_AGENT_ID,
    sessionId: process.env.MARROW_SESSION_ID,
    mode: process.env.MARROW_ENFORCEMENT_MODE || 'auto',
  });

  const runtime = marrow.createPassiveRuntime({
    includeValueReport: process.env.MARROW_PASSIVE_VALUE_REPORT === 'true',
    valueReportPeriod: process.env.MARROW_VALUE_REPORT_PERIOD || '7d',
  });

  runtime.install();
  globalThis.__MARROW_PASSIVE_RUNTIME__ = runtime;
}
`;
}

function envExample() {
  return `MARROW_API_KEY=mrw_live_replace_me
MARROW_BASE_URL=${DEFAULT_BASE_URL}
MARROW_FLEET_AGENT_ID=agent-or-fleet-id
MARROW_ENFORCEMENT_MODE=auto
MARROW_PASSIVE_BRIEF=auto
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

function upsertClaudeHooks(settingsPath) {
  const settings = parseJsonObject(settingsPath);
  const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? settings.hooks
    : {};
  const postToolUse = Array.isArray(hooks.PostToolUse) ? [...hooks.PostToolUse] : [];
  const userPromptSubmit = Array.isArray(hooks.UserPromptSubmit) ? [...hooks.UserPromptSubmit] : [];

  const hasPost = postToolUse.some((entry) => JSON.stringify(entry).includes('npx -y @getmarrow/mcp hook'));
  const hasPrompt = userPromptSubmit.some((entry) => JSON.stringify(entry).includes('npx -y @getmarrow/mcp context-hook'));

  if (!hasPost) {
    postToolUse.push({
      matcher: 'Bash|Edit|Write|MultiEdit|mcp__(?!marrow_).*',
      hooks: [{ type: 'command', command: 'npx -y @getmarrow/mcp hook' }],
    });
  }
  if (!hasPrompt) {
    userPromptSubmit.push({
      hooks: [{ type: 'command', command: 'npx -y @getmarrow/mcp context-hook' }],
    });
  }

  settings.hooks = {
    ...hooks,
    PostToolUse: postToolUse,
    UserPromptSubmit: userPromptSubmit,
  };

  return JSON.stringify(settings, null, 2) + '\n';
}

function upsertMcpServerConfig(filePath) {
  const config = parseJsonObject(filePath);
  const servers = config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
    ? config.mcpServers
    : {};
  servers.marrow = {
    command: 'npx',
    args: ['-y', '@getmarrow/mcp'],
    env: {
      MARROW_API_KEY: '${MARROW_API_KEY}',
      MARROW_BASE_URL: '${MARROW_BASE_URL}',
      MARROW_FLEET_AGENT_ID: '${MARROW_FLEET_AGENT_ID}',
    },
  };
  config.mcpServers = servers;
  return JSON.stringify(config, null, 2) + '\n';
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
    changes.push({ path: write.path, label: write.label, changed });
    if (changed && options.yes && !options.dryRun) {
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

async function runSelfTest(options) {
  if (!options.selfTest) return { skipped: true, reason: 'disabled' };
  if (!options.apiKey) return { skipped: true, reason: 'missing MARROW_API_KEY' };

  const headers = {
    authorization: `Bearer ${options.apiKey}`,
    'content-type': 'application/json',
    'x-marrow-session-id': `install-${Date.now()}`,
  };
  if (options.agentId) headers['x-marrow-agent-id'] = options.agentId;

  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const think = await requestJson(`${baseUrl}/v1/agent/think`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: 'process',
      action: 'Marrow passive install self-test: verify SDK/MCP hooks can record a harmless setup event',
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
  return {
    skipped: false,
    decision_id: decisionId,
    active: Boolean(status.enabled ?? status.ok),
    health: status.health || null,
    last_event_at: status.last_event_at || null,
    recommended_fix: status.recommended_fix || null,
  };
}

function printReport(report) {
  process.stdout.write(`Marrow passive installer\n`);
  process.stdout.write(`Root: ${report.root}\n`);
  process.stdout.write(`Mode: ${report.mode}\n`);
  process.stdout.write(`Write mode: ${report.writeMode}\n\n`);

  process.stdout.write('Detected:\n');
  for (const [key, value] of Object.entries(report.detected)) {
    process.stdout.write(`- ${key}: ${value ? 'yes' : 'no'}\n`);
  }

  process.stdout.write('\nPlanned changes:\n');
  for (const change of report.changes) {
    const marker = change.changed ? (report.writeMode === 'write' ? 'wrote' : 'would write') : 'unchanged';
    process.stdout.write(`- ${marker}: ${change.label} (${change.path})\n`);
  }

  process.stdout.write('\nSelf-test:\n');
  if (report.selfTest.skipped) {
    process.stdout.write(`- skipped: ${report.selfTest.reason}\n`);
  } else {
    process.stdout.write(`- active: ${report.selfTest.active ? 'yes' : 'no'}\n`);
    process.stdout.write(`- decision_id: ${report.selfTest.decision_id}\n`);
    process.stdout.write(`- health: ${report.selfTest.health || 'unknown'}\n`);
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
  const detection = detectEnvironment(options.cwd);
  const plan = buildPlan(detection, options);
  const writeMode = options.yes && !options.dryRun ? 'write' : 'dry-run';
  const changes = applyPlan(plan, options);
  const selfTest = await runSelfTest(options).catch((error) => ({
    skipped: false,
    active: false,
    error: error instanceof Error ? error.message : String(error),
  }));

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
    changes,
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
};

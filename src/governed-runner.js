const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { version: INSTALLER_PACKAGE_VERSION } = require('../package.json');
const {
  actionBinding,
  closeActionPermit,
  issueActionPermit,
  readEnforcementCoverage,
  recordEnforcementHeartbeat,
  verifyActionPermit,
} = require('./enforcement-client');
const { startGovernanceSidecar } = require('./governance-sidecar');
const {
  controllerStatus,
  ensureCurrentGovernanceController,
  startGovernanceController,
  stopProjectControllers,
} = require('./controller-manager');
const {
  ADAPTER_PROVENANCE,
  HARNESS_CAPABILITY_REGISTRY,
  applyPlan,
  buildPlan,
  detectEnvironment,
  detectedClient,
  localControllerAgentId,
} = require('./installer');
const { createHostUsageCapture } = require('./usage-telemetry');
const { readLocalControlState, recordGovernedBypass } = require('./control-state');

const DEFAULT_BASE_URL = 'https://api.getmarrow.ai';
const MCP_SETUP_COMMAND = `npx -y --package=${ADAPTER_PROVENANCE.mcp.package}@${ADAPTER_PROVENANCE.mcp.version} marrow-mcp setup`;
const HIGH_RISK_TERMS = /\b(deploy|prod|production|publish|release|merge|migration|migrate|secret|token|key|cloudflare|wrangler|npm publish|gh pr merge|git push|terraform apply|kubectl apply|delete|destroy|drop)\b/i;
const PROTECTED_COMMAND_PATTERNS = [
  /\b(?:npm|pnpm|yarn)(?:\s+npm)?\b[\s\S]{0,8192}\b(?:publish|unpublish|deprecate|access|owner|team|token|login|logout|profile\s+(?:set|enable-2fa|disable-2fa)|dist-tag|tag\s+(?:add|remove))\b/i,
  /\b(?:cargo\s+(?:publish|yank|owner)|twine\s+upload|gem\s+(?:push|yank|owner)|(?:dotnet\s+nuget|nuget)\s+(?:push|delete))\b/i,
  /\bgit\b[\s\S]{0,8192}\b(?:push|commit|merge|rebase|reset|tag|clean|rm|cherry-pick|revert|worktree\s+(?:add|move|remove|prune|repair|lock|unlock)|branch\s+(?:-[dDmM]|--delete|--move)|remote\s+(?:add|remove|rename|set-url|set-head|prune|update)|checkout\s+-[bB]|switch\s+-[cC])\b/i,
  /\bgh\b[\s\S]{0,8192}\b(?:auth\s+logout|pr\s+(?:merge|close|reopen|edit|review|comment)|issue\s+(?:create|close|reopen|edit|comment)|run\s+(?:cancel|delete|rerun)|release\s+(?:create|delete|edit|upload)|repo\s+(?:archive|delete|edit|fork|rename)|workflow\s+run|secret\s+(?:set|delete)|variable\s+(?:set|delete))\b/i,
  /\bgh\s+api\b[\s\S]{0,8192}(?:(?:--method|-X)(?:=|\s+)(?:POST|PUT|PATCH|DELETE)\b|(?:-f|-F|--field|--raw-field|--input)(?:=|\s+))/i,
  /\b(?:kubectl|oc)\b[\s\S]{0,8192}\b(?:apply|create|delete|edit|patch|replace|rollout|scale|set|drain|cordon|uncordon|taint|exec|cp|run|expose|autoscale|label|annotate|reconcile|certificate\s+(?:approve|deny))\b/i,
  /\b(?:terraform|terragrunt|tofu)\b[\s\S]{0,8192}\b(?:apply|destroy|import|taint|untaint|force-unlock|state\s+(?:mv|rm|push|replace-provider)|workspace\s+(?:new|delete))\b/i,
  /\bpulumi\b[\s\S]{0,8192}\b(?:up|destroy|import|refresh|stack\s+rm|config\s+(?:set|rm))\b/i,
  /\bhelm\b[\s\S]{0,8192}\b(?:install|upgrade|uninstall|rollback|push)\b/i,
  /\bflux\b[\s\S]{0,8192}\b(?:bootstrap|create|delete|install|reconcile|resume|suspend|tag|uninstall)\b/i,
  /\bnomad\b[\s\S]{0,8192}\b(?:job\s+(?:dispatch|plan|promote|run|scale|stop)|alloc\s+stop|deployment\s+(?:fail|promote)|acl\s+(?:bootstrap|policy|role|token))\b/i,
  /\bcdk\b[\s\S]{0,8192}\b(?:bootstrap|deploy|destroy|import|rollback)\b/i,
  /\bansible-playbook\b/i,
  /\b(?:docker|podman)\b[\s\S]{0,8192}\b(?:push|buildx\s+build\b[\s\S]*--push)\b/i,
  /\bwrangler\b[\s\S]{0,8192}\b(?:deploy|delete|rollback|execute|apply|put|bulk|secret|publish)\b/i,
  /\bcurl\b[\s\S]{0,8192}(?:(?:-X\s*|--request(?:=|\s+))(?:POST|PUT|PATCH|DELETE)\b|--(?:json|data(?:-ascii|-raw|-binary|-urlencode)?)(?:=|\s+)|-[dF](?:\s+|[^A-Za-z])|--form(?:-string)?(?:=|\s+)|(?:-T|--upload-file)(?:=|\s+))/i,
  /\b(?:http|xh)\b[\s\S]{0,8192}(?:\b(?:POST|PUT|PATCH|DELETE)\b|(?:--form|--raw|-f)\b|\s[^\s=:@]+(?::=|=|@))/i,
  /\bwget\b[\s\S]{0,8192}(?:--post-data|--post-file|--body-data|--body-file|--method(?:=|\s+)(?:POST|PUT|PATCH|DELETE))\b/i,
  /\b(?:psql|mysql|sqlite3|duckdb)\b[\s\S]{0,8192}(?:\b(?:drop|delete|update|insert|alter|truncate|create|grant|revoke|call|do)\b|(?:-f|--file|\.read|source)(?:=|\s+)|\s<\s*[^\s])/i,
  /\bredis-cli\b[\s\S]{0,8192}\b(?:set|setex|psetex|mset|del|unlink|getdel|incr|decr|append|expire|persist|rename|move|flushall|flushdb|shutdown|eval|evalsha|fcall|fcall_ro|function|script\s+(?:load|flush|kill)|config\s+set|acl\s+setuser|hset|hdel|lpush|rpush|lpop|rpop|sadd|srem|zadd|zrem|xadd|xdel|publish|restore|migrate)\b/i,
  /\baws\b[\s\S]{0,8192}\b(?:create|update|delete|put|attach|detach|associate|disassociate|terminate|stop|start|reboot|modify|restore|rotate|tag|untag|deploy|sync|s3\s+(?:cp|mv|rm)|s3api\s+put-object|ssm\s+(?:put-parameter|delete-parameter|delete-parameters))\b/i,
  /\bgcloud\b[\s\S]{0,8192}\b(?:create|update|delete|deploy|add|remove|set|destroy|disable|restore|storage\s+(?:cp|mv|rm|rsync)|pubsub\s+(?:topics|subscriptions)\s+(?:create|delete|update))\b/i,
  /\baz\b[\s\S]{0,8192}\b(?:create|update|delete|set|deploy|start|stop|restart|restore|storage\s+blob\s+(?:upload|delete|copy)|group\s+(?:create|delete|update))\b/i,
  /\brclone\b[\s\S]{0,8192}\b(?:copy|copyto|sync|move|moveto|delete|deletefile|purge|mkdir|rmdir|bisync)\b/i,
  /\bgsutil\b[\s\S]{0,8192}\b(?:cp|mv|rm|rsync|setacl|setmeta|web)\b/i,
  /(?:^|[;&|]\s*|\bsudo\s+|\benv\s+)mc\b[\s\S]{0,8192}\b(?:cp|mv|rm|mirror|mb|rb|anonymous|admin)\b/i,
  /\boci\b[\s\S]{0,8192}\bos\b[\s\S]{0,8192}\b(?:put|upload|bulk-upload|delete|rename|restore|reencrypt)\b/i,
  /\b(?:vault|op)\b[\s\S]{0,8192}\b(?:write|put|patch|delete|edit|create|move|rotate|revoke|destroy|share)\b/i,
  /\bpass\b[\s\S]{0,8192}\b(?:insert|edit|generate|rm|remove|mv|cp|init|git)\b/i,
  /(?:^|[\s;&|]|\bsudo\s+|\benv\s+)(?:(?:\/[^\s/]+)*\/)?(?:rm\b|unlink\b|shred\b|truncate\b|dd\b[\s\S]{0,8192}\bof=|find\b[\s\S]{0,8192}\s-delete\b|xargs\b[\s\S]{0,8192}(?:(?:\/[^\s/]+)*\/)?rm\b)/i,
];
const PROTECTED_ACTION_TYPES = new Set([
  'credential',
  'credentials',
  'deploy',
  'financial',
  'merge',
  'migration',
  'production',
  'publish',
  'release',
  'secret',
  'security',
]);
const SAFE_MARROW_CHILD_METADATA = new Set([
  'MARROW_AGENT_ID',
  'MARROW_AGENT_CLIENT',
  'MARROW_CLIENT',
  'MARROW_FLEET_AGENT_ID',
  'MARROW_GOVERN_PROFILE',
  'MARROW_HARNESS',
  'MARROW_SESSION_ID',
]);
const GOVERN_TUI_ROW_COUNT = 7;
const FLEET_TUI_ROW_COUNT = 12;
function usage() {
  return `Usage:
  npx @getmarrow/install run -- npm test
  npx @getmarrow/install run --type deploy --policy enforce -- wrangler deploy
  npx @getmarrow/install gate "deploy production worker"
  npx @getmarrow/install proof --decision-id <id> --gate-receipt <id> --success --summary "smoke passed"
  npx @getmarrow/install status
  npx @getmarrow/install permit --action "deploy production" --type deploy
  MARROW_ACTION_PERMIT=... npx @getmarrow/install verify-permit --action "deploy production" --type deploy
  npx @getmarrow/install coverage
  npx @getmarrow/install sidecar
  npx @getmarrow/install govern
  npx @getmarrow/install govern --no-interactive
  npx @getmarrow/install fleet
  npx @getmarrow/install integrations
  npx @getmarrow/install hermes
  npx @getmarrow/install openclaw

Commands:
  run       Run a command through Marrow pre-action gate and automatic outcome closure
  gate      Check Marrow runtime/gate for an action without running a command
  proof     Commit an outcome/proof for an existing decision
  status    Read /v1/agent/status
  permit    Issue a short-lived action-bound permit after Marrow policy evaluation
  verify-permit Verify a permit before CI, deploy, publish, merge, migration, or credential access
  coverage  Show enforcement, hook-health, closure, and bypass coverage
  sidecar   Run the loopback-only Marrow governance sidecar
  controller <ensure|start|status|stop>
            Keep the loopback governance controller active across agent sessions
  govern    Interactive setup TUI when run in a terminal; text panel in CI/non-TTY
  fleet     Fleet operator TUI for live agents, workflows, gates, proof debt, and exact fixes
  integrations List Marrow-supported harness add-ons
  hermes    Show and verify the Marrow add-on path for Hermes Agent
  openclaw  Show and verify the Marrow add-on path for OpenClaw

Options:
  --agent <id>            Registered agent id. Defaults to MARROW_FLEET_AGENT_ID or MARROW_AGENT_ID.
                          When unset, Marrow uses the API key's bound agent or the plan's agent seat.
  --session <id>          Session id. Defaults to marrow-run-<timestamp>
  --type <type>           Action type. Inferred from action/command when omitted
  --action <text>         Human-readable action. Defaults to the redacted command
  --profile <name>        Policy profile label, such as dev, staging, or production
  --policy <mode>         enforce, warn, or audit. Default: enforce
  --fail-open             For non-protected, low-risk actions only, run if Marrow is unreachable
  --fail-closed           If Marrow is unreachable, block the command
  --owner-approved <ref>  No longer used and has no effect: approvals happen in the host's own
                          prompt, at this runner's terminal prompt, or by the account owner's link
  --request-owner-link    When the account owner declined this action earlier, ask the owner again
                          with a one-tap approval link (only the owner can reverse the decline)
  --approval-wait <sec>   How long run waits for the owner's answer after a link is sent
                          (0 to 3600; default: until the link expires, at most 10 minutes)
  --permit <token>        Short-lived action permit. Prefer MARROW_ACTION_PERMIT
  --target <text>         Protected target binding, such as repository/environment
  --sidecar-port <port>   Loopback sidecar port. Default: ephemeral
  --proof-file <path>     JSON proof to include on outcome commit
  --gate-receipt <id>     proof only: the gate receipt printed by gate, for decisions the gate created
  --client <label>        Harness/client label. Defaults to MARROW_CLIENT, MARROW_HARNESS, or MARROW_AGENT_CLIENT
  --base-url <url>        Marrow API base URL
  --key <key>             Marrow API key. Prefer MARROW_API_KEY
  --json                  Print machine-readable result after completion
  --interactive           Force interactive govern TUI when possible
  --no-interactive        Print govern/fleet panel instead of opening the TUI
`;
}

function redact(value) {
  let text = String(value || '');
  text = text.replace(/\b[A-Z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD)[A-Z0-9_]*=([^\s]+)/gi, (match, captured) => match.replace(captured, '[redacted]'));
  text = text.replace(/\bmrw_(?:live|test)_[A-Za-z0-9._-]+/g, '[redacted]');
  text = text.replace(/\bnpm_[A-Za-z0-9._-]+/g, '[redacted]');
  text = text.replace(/\bgh(?:p|o|u|s|r)_[A-Za-z0-9._-]+/g, '[redacted]');
  text = text.replace(/\bsk-[A-Za-z0-9._-]+/g, '[redacted]');
  return text;
}

function shellQuote(value) {
  const text = String(value || '');
  if (!text) return "''";
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(text) ? text : `'${text.replace(/'/g, "'\\''")}'`;
}

function redactedCommand(command) {
  return command.map((part) => shellQuote(redact(part))).join(' ');
}

function isProtectedCommand(text) {
  const raw = String(text || '');
  if (raw.length > 8192) return true;
  const value = raw.slice(0, 8192);
  return HIGH_RISK_TERMS.test(value)
    || PROTECTED_COMMAND_PATTERNS.some((pattern) => pattern.test(value));
}

function normalizeClientLabel(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const normalized = raw
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  const aliases = {
    claude: 'claude-code',
    claude_code: 'claude-code',
    'cursor-composer': 'composer',
    'openai-codex': 'codex',
    openai: 'codex',
    'gemini-cli': 'gemini',
    'grok-cli': 'grok',
    'deepseek-cli': 'deepseek',
    'qwen-cli': 'qwen',
    'kimi-cli': 'kimi',
    'minimax-cli': 'minimax',
    'glm-cli': 'glm',
  };
  return aliases[normalized] || normalized || 'custom';
}

function sourceClient(value) {
  return normalizeClientLabel(
    value
    || process.env.MARROW_CLIENT
    || process.env.MARROW_HARNESS
    || process.env.MARROW_AGENT_CLIENT
    || '@getmarrow/install',
  );
}

function displayText(value, maxLength = 120) {
  const text = redact(String(value || ''))
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u009d[^\u0007\u009c]*(?:\u0007|\u009c|\u001b\\)/g, '')
    .replace(/[\u001b\u009b][[\]()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, '')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '');
  return text.length > maxLength ? `${text.slice(0, maxLength - 3)}...` : text;
}

function shellQuoteDisplay(value) {
  return shellQuote(displayText(value, 240));
}

function inferType(text) {
  const value = String(text || '').toLowerCase();
  if (/\b(deploy|wrangler|cloudflare|production|prod|release)\b/.test(value)
    || /\b(?:kubectl|terraform|pulumi|helm)\b/.test(value) && isProtectedCommand(value)) return 'deploy';
  if (/\b(publish|unpublish|deprecate|npm publish)\b/.test(value)) return 'publish';
  if (/\b(merge|gh pr merge)\b/.test(value)
    || /\bgit\b[^\n;&|]{0,240}\bpush\b/.test(value)) return 'merge';
  if (/\b(migration|migrate|schema|d1 execute|drop table)\b/.test(value)) return 'migration';
  if (/\b(secret|token|key|password)\b/.test(value)) return 'security';
  if (/\b(test|check|lint|typecheck|smoke)\b/.test(value)) return 'verification';
  return 'general';
}

function inferSurfaces(text) {
  const value = String(text || '').toLowerCase();
  const surfaces = new Set();
  if (/\b(git|gh|github)\b/.test(value)) surfaces.add('github');
  if (/\b(wrangler|cloudflare|worker|d1|r2)\b/.test(value)) surfaces.add('cloudflare');
  if (/\b(kubectl|terraform|pulumi|helm|production|prod)\b/.test(value)) surfaces.add('production');
  if (/\b(npm|pnpm|yarn|publish)\b/.test(value)) surfaces.add('npm');
  if (/\b(sql|d1|migration|database|db)\b/.test(value)) surfaces.add('database');
  if (/\b(curl|api|http)\b/.test(value)) surfaces.add('api');
  if (surfaces.size === 0) surfaces.add('shell');
  return [...surfaces];
}

function safeJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function detectProjectSignals(cwd = process.cwd()) {
  const packageJsonPath = path.join(cwd, 'package.json');
  const packageJson = safeJsonFile(packageJsonPath);
  const packageScripts = packageJson?.scripts && typeof packageJson.scripts === 'object'
    ? Object.keys(packageJson.scripts)
    : [];
  const signals = new Set();
  const frameworks = new Set();
  const configFiles = [];

  const addFile = (relative, signal) => {
    if (fs.existsSync(path.join(cwd, relative))) {
      configFiles.push(relative);
      signals.add(signal);
    }
  };

  if (packageJson) {
    signals.add('package_json');
    if (packageJson.dependencies?.['@cloudflare/workers-types'] || packageJson.devDependencies?.['wrangler'] || packageJson.dependencies?.['hono']) {
      frameworks.add('cloudflare-workers');
    }
  }
  addFile('wrangler.toml', 'wrangler_config');
  addFile('wrangler.json', 'wrangler_config');
  addFile('wrangler.jsonc', 'wrangler_config');
  addFile('.github/workflows', 'github_actions');
  addFile('Dockerfile', 'container');
  addFile('docker-compose.yml', 'container');
  addFile('terraform', 'terraform');
  addFile('migrations', 'database_migrations');
  addFile('prisma', 'database_migrations');
  addFile('drizzle', 'database_migrations');
  addFile('AGENTS.md', 'agent_instructions');
  addFile('CLAUDE.md', 'agent_instructions');
  addFile('.mcp.json', 'mcp_config');
  addFile('mcp.json', 'mcp_config');
  addFile('.cursor', 'cursor_project');
  addFile('.windsurf', 'windsurf_project');
  addFile('.cline', 'cline_project');
  addFile('hermes.json', 'hermes_config');
  addFile('hermes.yaml', 'hermes_config');
  addFile('hermes.yml', 'hermes_config');
  addFile('.hermes', 'hermes_config');
  addFile('openclaw.json', 'openclaw_config');
  addFile('.openclaw', 'openclaw_config');
  addFile('.gemini', 'gemini_profile');
  addFile('.grok', 'grok_profile');
  addFile('.deepseek', 'deepseek_profile');
  addFile('.qwen', 'qwen_profile');
  addFile('.kimi', 'kimi_profile');
  addFile('.minimax', 'minimax_profile');
  addFile('.glm', 'glm_profile');

  for (const script of packageScripts) {
    if (/\b(deploy|publish|release|migrate|migration|smoke|check|test)\b/i.test(script)) {
      signals.add(`script:${script.toLowerCase()}`);
    }
  }

  const project = {
    name: packageJson?.name || path.basename(cwd),
    key: packageJson?.name || path.basename(cwd),
    type: packageJson ? 'node' : fs.existsSync(path.join(cwd, 'pyproject.toml')) ? 'python' : 'workspace',
    frameworks: [...frameworks],
    signals: [...signals],
    package_scripts: packageScripts.slice(0, 30),
    config_files: configFiles.slice(0, 30),
  };
  project.fingerprint = crypto.createHash('sha256').update(JSON.stringify({
    name: project.name,
    type: project.type,
    frameworks: [...project.frameworks].sort(),
    signals: [...project.signals].sort(),
    package_scripts: [...project.package_scripts].sort(),
    config_files: [...project.config_files].sort(),
  })).digest('hex');
  return project;
}

function isRisky(text, type) {
  return PROTECTED_ACTION_TYPES.has(String(type || '').trim().toLowerCase())
    || isProtectedCommand(`${type || ''} ${text || ''}`);
}

function parseBaseOptions(argv, startIndex = 0) {
  const options = {
    apiKey: process.env.MARROW_API_KEY || process.env.MARROW_KEY || '',
    baseUrl: process.env.MARROW_BASE_URL || DEFAULT_BASE_URL,
    // A local username is never a registered agent. With no configured id, the server
    // resolves the key-bound agent or the plan seat instead.
    agentId: process.env.MARROW_FLEET_AGENT_ID || process.env.MARROW_AGENT_ID || '',
    sessionId: process.env.MARROW_SESSION_ID || '',
    profile: process.env.MARROW_GOVERN_PROFILE || 'default',
    policy: process.env.MARROW_GOVERN_POLICY || 'enforce',
    failOpen: process.env.MARROW_FAIL_OPEN === 'true',
    failClosed: process.env.MARROW_FAIL_CLOSED === 'true',
    json: false,
    // --owner-approved is accepted and ignored: an approval is what Marrow records, never a
    // reference the caller supplies.
    ownerApprovedFlagIgnored: false,
    requestOwnerLink: false,
    approvalWaitSeconds: null,
    proofFile: '',
    type: '',
    action: '',
    client: sourceClient(),
    interactive: null,
    permit: process.env.MARROW_ACTION_PERMIT || '',
    target: process.env.MARROW_ACTION_TARGET || '',
    sidecarPort: process.env.MARROW_SIDECAR_PORT || '0',
    // One random nonce per CLI invocation. Retries inside this invocation reuse it, so a retry
    // replays only its own request; a later run, gate or permit in the same session gets new
    // keys and is never answered with an earlier invocation's stored response.
    invocationNonce: crypto.randomBytes(16).toString('hex'),
  };
  let i = startIndex;
  for (; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') break;
    if (arg === '--agent' || arg === '--agent-id') options.agentId = argv[++i] || options.agentId;
    else if (arg === '--session' || arg === '--session-id') options.sessionId = argv[++i] || options.sessionId;
    else if (arg === '--type') options.type = argv[++i] || options.type;
    else if (arg === '--action') options.action = argv[++i] || options.action;
    else if (arg === '--profile') options.profile = argv[++i] || options.profile;
    else if (arg === '--policy') options.policy = argv[++i] || options.policy;
    else if (arg === '--fail-open') {
      options.failOpen = true;
      options.failClosed = false;
    } else if (arg === '--fail-closed') {
      options.failClosed = true;
      options.failOpen = false;
    } else if (arg === '--owner-approved') {
      // Its value is read and dropped; it never reaches Marrow, proof or a permit.
      if (argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--')) i += 1;
      options.ownerApprovedFlagIgnored = true;
    } else if (arg === '--request-owner-link') options.requestOwnerLink = true;
    else if (arg === '--approval-wait') {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 0 || value > 3600) throw new Error('--approval-wait must be a whole number of seconds from 0 to 3600');
      options.approvalWaitSeconds = value;
    }
    else if (arg === '--permit') options.permit = argv[++i] || options.permit;
    else if (arg === '--target') options.target = argv[++i] || options.target;
    else if (arg === '--sidecar-port') options.sidecarPort = argv[++i] || options.sidecarPort;
    else if (arg === '--proof-file') options.proofFile = argv[++i] || options.proofFile;
    else if (arg === '--client' || arg === '--harness') {
      options.client = sourceClient(argv[++i] || options.client);
      options.clientExplicit = true;
    }
    else if (arg === '--base-url') options.baseUrl = argv[++i] || options.baseUrl;
    else if (arg === '--key') {
      options.apiKey = argv[++i] || options.apiKey;
      options.keyFromArg = true;
    } else if (arg === '--json') options.json = true;
    else if (arg === '--interactive') options.interactive = true;
    else if (arg === '--no-interactive') options.interactive = false;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg.startsWith('--')) throw new Error(`Unknown option: ${arg}`);
    else break;
  }
  if (!['enforce', 'warn', 'audit'].includes(options.policy)) {
    throw new Error('--policy must be enforce, warn, or audit');
  }
  if (!options.sessionId) {
    options.sessionId = defaultRunnerSession(options);
    options.sessionDefaulted = true;
  }
  return { options, index: i };
}

function parseArgs(argv) {
  const command = argv[0] || 'help';
  if (command === '--help' || command === '-h' || command === 'help') return { command: 'help' };

  if (command === 'run') {
    const parsed = parseBaseOptions(argv, 1);
    const separator = argv[parsed.index] === '--' ? parsed.index + 1 : parsed.index;
    let childCommand = argv.slice(separator);
    // npx forwards both separators of the documented `run -- -- <command>` form. No real
    // command is named `--`, so one extra leading separator is dropped instead of spawned.
    if (childCommand[0] === '--') childCommand = childCommand.slice(1);
    if (parsed.options.help) return { command: 'help' };
    if (childCommand.length === 0) throw new Error('marrow run requires a command after --');
    return { command, options: parsed.options, childCommand };
  }

  if (command === 'gate') {
    const parsed = parseBaseOptions(argv, 1);
    const action = parsed.options.action || argv.slice(parsed.index).join(' ');
    if (parsed.options.help) return { command: 'help' };
    if (!action) throw new Error('marrow gate requires an action string');
    return { command, options: { ...parsed.options, action } };
  }

  if (command === 'permit' || command === 'verify-permit') {
    const parsed = parseBaseOptions(argv, 1);
    const action = parsed.options.action || argv.slice(parsed.index).join(' ');
    if (parsed.options.help) return { command: 'help' };
    if (!action) throw new Error(`${command} requires --action or an action string`);
    if (command === 'verify-permit' && !parsed.options.permit) {
      throw new Error('verify-permit requires MARROW_ACTION_PERMIT or --permit');
    }
    return { command, options: { ...parsed.options, action } };
  }

  if (command === 'proof') {
    // Proof flags are taken out first; the shared parser rejects options it does not know,
    // which made every documented `proof --decision-id ...` call fail before 0.1.66.
    const proofOptions = { decisionId: '', gateReceiptId: '', success: true, summary: '', outcome: '' };
    const baseArgv = [command];
    for (let i = 1; i < argv.length; i += 1) {
      const arg = argv[i];
      if (arg === '--decision-id') proofOptions.decisionId = argv[++i] || '';
      else if (arg === '--gate-receipt' || arg === '--gate-receipt-id') proofOptions.gateReceiptId = argv[++i] || '';
      else if (arg === '--success') proofOptions.success = true;
      else if (arg === '--failure' || arg === '--failed') proofOptions.success = false;
      else if (arg === '--summary') proofOptions.summary = argv[++i] || '';
      else if (arg === '--outcome') proofOptions.outcome = argv[++i] || '';
      else baseArgv.push(arg);
    }
    const parsed = parseBaseOptions(baseArgv, 1);
    if (parsed.options.help) return { command: 'help' };
    if (parsed.index < baseArgv.length) throw new Error(`Unknown proof option: ${baseArgv[parsed.index]}`);
    const options = { ...parsed.options, ...proofOptions };
    if (!options.decisionId) throw new Error('marrow proof requires --decision-id');
    return { command, options };
  }

  if (command === 'controller') {
    const action = argv[1] && !argv[1].startsWith('--') ? argv[1] : 'status';
    if (!['ensure', 'start', 'status', 'stop'].includes(action)) {
      throw new Error('controller action must be ensure, start, status, or stop');
    }
    const parsed = parseBaseOptions(argv, action === 'status' && argv[1] !== 'status' ? 1 : 2);
    if (parsed.options.help) return { command: 'help' };
    return { command, action, options: parsed.options };
  }

  if (command === 'status' || command === 'govern' || command === 'fleet' || command === 'hermes' || command === 'openclaw' || command === 'integrations' || command === 'coverage' || command === 'sidecar') {
    const parsed = parseBaseOptions(argv, 1);
    if (parsed.options.help) return { command: 'help' };
    return { command, options: parsed.options };
  }

  throw new Error(`Unknown command: ${command}`);
}

function headers(options) {
  const h = {
    Authorization: `Bearer ${options.apiKey}`,
    'Content-Type': 'application/json',
    'X-Marrow-Session-Id': options.sessionId,
    'X-Marrow-Client': sourceClient(options.client),
    'X-Marrow-Package': '@getmarrow/install',
    'X-Marrow-Package-Version': INSTALLER_PACKAGE_VERSION,
    'X-Marrow-Install-Version': INSTALLER_PACKAGE_VERSION,
    'X-Marrow-SDK-Version': ADAPTER_PROVENANCE.sdk.version,
    'X-Marrow-MCP-Version': ADAPTER_PROVENANCE.mcp.version,
    'User-Agent': '@getmarrow/install governed-runner',
  };
  if (options.agentId) h['X-Marrow-Agent-Id'] = options.agentId;
  return h;
}

function sourceMeta(options, channel, extra = {}) {
  const client = sourceClient(options.client);
  return {
    channel,
    client,
    harness: client,
    runner: '@getmarrow/install',
    ...(options.agentId ? { agent_id: options.agentId } : {}),
    session_id: options.sessionId,
    profile: options.profile,
    governed: true,
    ...(extra.action ? { user_intent: displayText(extra.action, 160) } : {}),
    ...extra,
  };
}

function dataOf(json) {
  return json && typeof json === 'object' && json.data && typeof json.data === 'object' ? json.data : json;
}

async function rawRequest(options, method, route, body, extraHeaders = {}, { timeoutMs } = {}) {
  if (!options.apiKey) throw new Error('MARROW_API_KEY is required. Use --fail-open only for non-production local commands.');
  const response = await fetch(new URL(route, options.baseUrl.replace(/\/$/, '/')), {
    method,
    headers: { ...headers(options), ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  const text = await response.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text.slice(0, 500) }; }
  return { response, json };
}

function responseError(route, response, json) {
  const error = new Error(json.error || json.message || `Marrow ${route} returned HTTP ${response.status}`);
  error.status = response.status;
  error.details = json.details || json;
  return error;
}

async function requestJson(options, method, route, body, extraHeaders = {}, requestOptions = {}) {
  const { response, json } = await rawRequest(options, method, route, body, extraHeaders, requestOptions);
  if (!response.ok) throw responseError(route, response, json);
  return dataOf(json);
}

const DURABLE_WRITE_ATTEMPTS = 3;
const DURABLE_RETRY_DELAY_MS = 1_000;
const DURABLE_MAX_RETRY_DELAY_MS = 2_000;
const DURABLE_ATTEMPT_TIMEOUT_MS = 10_000;
const DURABLE_TOTAL_TIMEOUT_MS = 25_000;
const DURABLE_TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

function durableIdempotencyKey(options, route, parts) {
  const digest = crypto.createHash('sha256')
    .update([options.invocationNonce, options.sessionId, route, ...parts].map((part) => String(part ?? '')).join('\u0000'))
    .digest('hex');
  return `marrow-run-${route.split('/').pop()}-${digest.slice(0, 48)}`;
}

function durableRetryDelayMs(response, data, options) {
  if (Number.isFinite(options.retryDelayMs) && options.retryDelayMs >= 0) return options.retryDelayMs;
  const hinted = Number(data?.retry_after_ms);
  const header = Number(response?.headers?.get?.('retry-after')) * 1000;
  const delay = hinted > 0 ? hinted : header > 0 ? header : DURABLE_RETRY_DELAY_MS;
  return Math.min(delay, DURABLE_MAX_RETRY_DELAY_MS);
}

function isTimeout(error) {
  return error?.name === 'TimeoutError' || error?.name === 'AbortError';
}

// Runtime, think and commit are durable Marrow writes. A transient 429/502/503/504, a timed-out
// attempt, or a pending acknowledgement (retryable:true, committed:false) is resent unchanged
// with the same Idempotency-Key, at most three attempts within one overall deadline, so a retry
// can never create a second record and a hung service never holds the command forever. A
// pending acknowledgement that names a created decision pins that id; the final answer must
// carry the same one. Client errors and connection failures are not retried.
async function durableRequestJson(options, route, body, idempotencyKey) {
  const attemptTimeoutMs = Number.isFinite(options.requestTimeoutMs) ? options.requestTimeoutMs : DURABLE_ATTEMPT_TIMEOUT_MS;
  const deadline = Date.now() + (Number.isFinite(options.requestDeadlineMs) ? options.requestDeadlineMs : DURABLE_TOTAL_TIMEOUT_MS);
  let lastState = 'no response';
  let pinnedDecisionId = null;
  const exhausted = (status) => {
    const error = new Error(`Marrow ${route} did not complete after ${DURABLE_WRITE_ATTEMPTS} attempts (last: ${lastState}).`);
    error.status = status;
    return error;
  };
  for (let attempt = 1; attempt <= DURABLE_WRITE_ATTEMPTS; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const error = new Error(`Marrow ${route} did not complete before its deadline (last: ${lastState}).`);
      error.status = 504;
      throw error;
    }
    let response;
    let json;
    try {
      ({ response, json } = await rawRequest(options, 'POST', route, body, { 'Idempotency-Key': idempotencyKey }, {
        timeoutMs: Math.max(1, Math.min(attemptTimeoutMs, remaining)),
      }));
    } catch (error) {
      if (!isTimeout(error)) throw error;
      lastState = 'timed out';
      if (attempt === DURABLE_WRITE_ATTEMPTS) throw exhausted(504);
      continue;
    }
    const data = dataOf(json);
    if (response.ok) {
      const decisionId = typeof data?.decision_id === 'string' && data.decision_id ? data.decision_id : null;
      if (pinnedDecisionId && decisionId && decisionId !== pinnedDecisionId) {
        throw new Error(`Marrow ${route} returned a different decision id than its pending acknowledgement.`);
      }
      if (data?.retryable !== true || data?.committed !== false) return data;
      if (decisionId && data.decision_state === 'created') pinnedDecisionId = decisionId;
      lastState = `pending${data.reconciliation_state ? ` (${String(data.reconciliation_state).slice(0, 80)})` : ''}`;
    } else if (DURABLE_TRANSIENT_STATUSES.has(response.status)) {
      const reason = String(json.error || json.message || '').slice(0, 200);
      lastState = reason ? `HTTP ${response.status}: ${reason}` : `HTTP ${response.status}`;
      if (attempt === DURABLE_WRITE_ATTEMPTS) {
        const error = responseError(route, response, json);
        error.message = `Marrow ${route} did not complete after ${DURABLE_WRITE_ATTEMPTS} attempts (last: ${lastState}).`;
        throw error;
      }
    } else {
      throw responseError(route, response, json);
    }
    if (attempt < DURABLE_WRITE_ATTEMPTS) {
      const wait = Math.min(durableRetryDelayMs(response, data, options), Math.max(0, deadline - Date.now()));
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  throw exhausted(202);
}

function proofFromFile(filePath) {
  if (!filePath) return null;
  const raw = fs.readFileSync(path.resolve(filePath), 'utf8');
  return JSON.parse(raw);
}

function defaultProof(input) {
  const proof = proofFromFile(input.options.proofFile) || {};
  const command = redactedCommand(input.childCommand || []);
  const verificationCommand = /\b(test|smoke|check|verify|lint|typecheck|audit)\b/i.test(command);
  const suppliedChecks = Array.isArray(proof.checks) && proof.checks.length > 0;
  const evidenceState = typeof proof.evidence_state === 'string'
    ? proof.evidence_state
    : input.success && (suppliedChecks || verificationCommand)
    ? 'verified'
    : input.success
    ? 'observed_only'
    : 'failed';
  return {
    summary: proof.summary || `Marrow governed runner completed ${input.action}.`,
    checks: suppliedChecks ? proof.checks : [`command_exit_code=${Number(input.exitCode)}`],
    evidence_source: proof.evidence_source || (verificationCommand ? 'verification_command_result' : 'governed_command_result'),
    evidence_state: evidenceState,
    verified_completion: evidenceState === 'verified',
    outcome: proof.outcome || (input.success ? 'success' : 'failure'),
    blockers: Array.isArray(proof.blockers) ? proof.blockers : [],
    command,
    exit_code: input.exitCode,
    runner: '@getmarrow/install run',
    profile: input.options.profile,
    source_meta: sourceMeta(input.options, 'proof', { action: input.action }),
    ...withoutCallerApproval(proof),
  };
}

// A caller-written approval is not an approval: Marrow reads the approval it recorded for the
// gate receipt. The runner never writes proof.owner_approval and drops one a proof file carries.
function withoutCallerApproval(proof) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return {};
  const { owner_approval: _ignored, ...rest } = proof;
  return rest;
}

async function preflightRuntime(options, action, type, commandText) {
  const target = options.target || commandText || action;
  const surfaces = inferSurfaces(commandText || action);
  const meta = sourceMeta(options, 'runtime', { action, command: commandText, action_type: type });
  const project = detectProjectSignals(options.root || process.cwd());
  const body = {
    action,
    type,
    target,
    surfaces,
    // Package clients get the slim runtime shape unless they ask for expanded. The runner reads
    // risk_gate, gate_receipt and runtime_authorization, as the install self-test does.
    response_mode: 'expanded',
    harness: sourceClient(options.client),
    project: { ...project, harness: sourceClient(options.client) },
    source_meta: meta,
    context: {
      runner: '@getmarrow/install run',
      profile: options.profile,
      command: commandText,
      policy: options.policy,
      governed: true,
      source_meta: meta,
    },
  };
  return durableRequestJson(options, '/v1/agent/runtime', body,
    durableIdempotencyKey(options, '/v1/agent/runtime', [JSON.stringify(body)]));
}

async function recommendGovernanceMode(options, project = detectProjectSignals()) {
  if (!options.apiKey) {
    return {
      ok: false,
      skipped: true,
      reason: 'MARROW_API_KEY missing',
      project,
      exact_fix: 'export MARROW_API_KEY=mrw_live_... && npx @getmarrow/install govern',
    };
  }
  const action = 'configure Marrow governance mode for this project';
  return requestJson(options, 'POST', '/v1/agent/mode/recommend', {
    project,
    workflow: {
      action,
      type: 'setup',
      branch: process.env.GITHUB_REF_NAME || process.env.BRANCH_NAME || '',
      environment: process.env.NODE_ENV || process.env.MARROW_GOVERN_PROFILE || options.profile,
    },
    agent: {
      id: options.agentId || undefined,
      role: 'setup',
    },
    source_meta: sourceMeta(options, 'mode_recommend', { action }),
  });
}

async function recordGovernanceModeSelection(options, state) {
  if (!options.apiKey || !state.recommendation?.recommended_mode) return null;
  const selected = selectedGovernanceMode(state.modes[state.modeIndex]);
  return requestJson(options, 'POST', '/v1/agent/mode/recommend', {
    project: state.project,
    workflow: {
      action: 'selected Marrow governance mode for this project',
      type: 'setup',
      environment: process.env.NODE_ENV || process.env.MARROW_GOVERN_PROFILE || options.profile,
    },
    agent: {
      id: options.agentId || undefined,
      role: 'setup',
    },
    selected_mode: selected,
    selection_source: selected === state.recommendation.recommended_mode ? 'accepted' : 'overridden',
    source_meta: sourceMeta(options, 'mode_selection', { action: 'selected Marrow governance mode for this project' }),
  });
}

function recordOf(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function lowerText(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : '';
}

// The runtime answers in two shapes. Expanded responses carry risk_gate, gate_receipt and
// runtime_authorization. Slim responses, the default for package clients, carry top-level
// decision, enforcement_decision, risk_gate_enforced, gate_receipt_id and gate_required.
// Both normalize to one gate, so the runner never reads a real answer as "unknown".
function gateDecision(runtime) {
  const value = recordOf(runtime);
  const gate = recordOf(value.risk_gate);
  const receipt = recordOf(value.gate_receipt);
  const authorization = recordOf(value.runtime_authorization);
  const completion = recordOf(value.completion_contract);
  const enforced = typeof gate.enforced === 'boolean'
    ? gate.enforced
    : typeof value.risk_gate_enforced === 'boolean'
    ? value.risk_gate_enforced
    : null;
  const enforcementDecision = lowerText(gate.enforcement_decision) || lowerText(value.enforcement_decision);
  const enforcementAsDecision = enforcementDecision === 'owner_approval_required'
    ? 'review_required'
    : enforcementDecision === 'advisory' ? '' : enforcementDecision;
  const decision = lowerText(gate.decision) || lowerText(value.decision) || lowerText(receipt.decision)
    || enforcementAsDecision;
  const recognized = Boolean(decision || enforcementDecision || enforced !== null);
  // An observation-only answer records outcomes but never authorizes execution.
  const observationOnly = [decision, enforcementDecision, lowerText(authorization.kind), lowerText(receipt.kind),
    lowerText(authorization.decision_state)].includes('outcome_observation_only');
  const authorizationWithheld = gate.authorization_granted === false || receipt.authorization_granted === false;
  const decisionState = lowerText(authorization.decision_state) || lowerText(completion.decision_state);
  const createdDecisionId = String(value.decision_id || authorization.decision_id || completion.decision_id || '');
  return {
    recognized,
    decision: recognized ? decision || 'proceed' : 'none',
    enforcementDecision,
    enforced,
    observationOnly,
    allow: authorizationWithheld || observationOnly ? false : typeof gate.allow === 'boolean'
      ? gate.allow
      : typeof value.allow === 'boolean' ? value.allow : decision !== 'block',
    riskLevel: lowerText(gate.risk_level) || lowerText(receipt.risk_level) || lowerText(value.risk_level),
    required: Boolean(receipt.required || gate.gate_required || value.gate_required || completion.gate_receipt_required),
    ownerApprovalRequired: Boolean(receipt.owner_approval_required || gate.owner_approval_required
      || completion.owner_approval_required === true || enforcementDecision === 'owner_approval_required'),
    receiptId: String(receipt.id || gate.gate_receipt_id || value.gate_receipt_id || authorization.id
      || completion.gate_receipt_id || ''),
    // A runtime that already created the decision is closed with that id and its receipt;
    // think is called only when the runtime says decision creation is still required.
    runtimeDecisionId: decisionState === 'not_created' ? '' : createdDecisionId,
    exactNextAction: value.exact_next_action || receipt.exact_fix || recordOf(gate.policy).exact_fix
      || completion.exact_next_action || '',
    beforeYouAct: recordOf(value.before_you_act_injection).message || value.before_you_act || '',
    proofPack: value.proof_pack || (value.proof_required ? {
      required: true,
      required_fields: Array.isArray(completion.required_proof_fields) ? completion.required_proof_fields : [],
      missing: Array.isArray(completion.missing_proof_fields) ? completion.missing_proof_fields : [],
    } : null),
  };
}

function shouldBlock(decision, options) {
  // Marrow withheld authorization (allow:false, or an observation-only answer): blocked under
  // every plan mode and local policy.
  if (decision.observationOnly || decision.allow === false) return true;
  if (options.policy === 'audit') return false;
  // An advisory plan (enforced:false) never blocks locally; the runner shows the warning.
  if (decision.enforced === false) return false;
  if (decision.decision === 'block') return true;
  if (options.policy === 'warn') return false;
  const approvalRequired = decision.ownerApprovalRequired
    || decision.decision === 'review_required'
    || decision.decision === 'owner_approval_required'
    || decision.enforcementDecision === 'owner_approval_required';
  return Boolean(approvalRequired);
}

// The gate as the runner shows it: a hold's served next step (written for agents, with endpoint
// paths, and for arbitration a dashboard receipt) is replaced by the runner's own text.
function runnerGateDecision(runtime) {
  const decision = gateDecision(runtime);
  const hold = heldApproval(runtime, decision);
  return hold ? { ...decision, exactNextAction: holdNextText(hold) } : decision;
}

function blockMessage(decision, hold = null) {
  if (decision.observationOnly) return 'Marrow answered in observation-only mode, which cannot authorize this action. Retry for a fresh gate.';
  if (hold) return holdNextText(hold);
  return decision.exactNextAction || 'Marrow blocked this action before execution.';
}

// ---------------------------------------------------------------------------
// Held actions (review_required): who can approve is Marrow's decision, read from the runtime.
// Approvals keep people in flow: with a person at an interactive terminal the runner asks once;
// with nobody there (CI, scripts, pipes, an agent's own shell) the action holds quietly and the
// command does not run. The account owner's one-tap link is requested only when Marrow says it
// would be sent (approval_link_available: an owner-locked category, arbitration, the owner's own
// decline the operator asked to reverse, or an owner who turned on unattended pings). A later
// run of the same command picks the hold up on the same gate receipt.
// The runner never relays the server's agent-directed text for a hold, never prints a link,
// a token or an address, and never names the dashboard as a step.
// ---------------------------------------------------------------------------

const GATE_RECEIPT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/;
const HOST_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const DECISION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/;
const APPROVAL_LINK_CHANNELS = new Set(['email', 'telegram', 'slack']);
const APPROVAL_LINK_MAX_REQUESTS = 3;
const APPROVAL_PROMPT_TIMEOUT_MS = 5 * 60_000;
const APPROVAL_STATUS_MIN_POLL_MS = 1_000;
const APPROVAL_STATUS_MAX_POLL_MS = 15_000;
const APPROVAL_REQUEST_RETRY_MS = 2_000;
// The backend lets a decline stand for this long (same decision, or the same action in the
// receipt's session); the local record keeps it for the same time across reruns.
const DECLINE_STANDS_MS = 30 * 60_000;
const HOLD_RECORD_MAX_AGE_MS = 24 * 60 * 60_000;
const RUNNER_HOOK_EVENT = 'governed_runner_prompt';
const OWNER_APPROVAL_NOTICE = 'Approvals happen in the host\'s own prompt, at this runner\'s terminal prompt, or through the one-tap link Marrow sends the account owner.';

function isoTime(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

const safeId = (value, pattern = DECISION_ID_RE) => (typeof value === 'string' && pattern.test(value) ? value : '');

// The hold from the runtime's completion contract. Endpoints are built from the receipt id here,
// never taken from response text. `legacy`: a Marrow service from before terminal approvals.
function heldApproval(runtime, decision) {
  const value = recordOf(runtime);
  const completion = recordOf(value.completion_contract);
  const guidance = recordOf(completion.owner_approval);
  if (!decision || decision.observationOnly || decision.decision === 'block') return null;
  const receiptId = String(decision.receiptId || '');
  const expiresAt = isoTime(recordOf(value.gate_receipt).expires_at) || isoTime(completion.gate_receipt_expires_at);
  const poll = Number(guidance.approval_status_poll_after_ms);
  const pollAfterMs = Number.isFinite(poll) && poll > 0 ? poll : 3_000;
  const announcesLinks = typeof guidance.approval_link_available === 'boolean';
  if (guidance.mode === 'arbitration_review_required') {
    const arbitration = recordOf(value.arbitration);
    const arbitrationReceiptId = safeId(arbitration.receipt_id) || safeId(completion.arbitration_receipt_id);
    const linkAvailable = announcesLinks ? guidance.approval_link_available === true : typeof guidance.approval_link_endpoint === 'string';
    if (!GATE_RECEIPT_ID_RE.test(receiptId) || !arbitrationReceiptId || !linkAvailable) {
      return { kind: 'legacy', arbitration: true, gateReceiptId: receiptId };
    }
    return {
      kind: 'arbitration',
      gateReceiptId: receiptId,
      arbitrationReceiptId,
      arbitrationDecisionId: safeId(arbitration.decision_id),
      linkAvailable: true,
      linkReason: 'owner_locked',
      expiresAt,
      pollAfterMs,
    };
  }
  if (guidance.mode !== 'ordinary_non_arbitrated' || !GATE_RECEIPT_ID_RE.test(receiptId)) return null;
  // Before terminal approvals the service has no host-approval route to record an answer.
  if (guidance.host_approval_endpoint === undefined && guidance.host_approval_accepted === undefined) {
    return { kind: 'legacy', arbitration: false, gateReceiptId: receiptId };
  }
  const refusal = ['owner_decline_stands', 'verified_approval_required', 'approval_state_unavailable']
    .includes(guidance.host_approval_refusal_reason) ? guidance.host_approval_refusal_reason : null;
  // A service that does not announce links (before round 4) sends one for an owner-locked hold
  // or the owner's decline; the runner asks for nothing else there.
  const linkAvailable = announcesLinks
    ? guidance.approval_link_available === true
    : typeof guidance.approval_link_endpoint === 'string' && (refusal === 'verified_approval_required' || refusal === 'owner_decline_stands');
  const linkReason = ['owner_locked', 'owner_decline_stands', 'unattended_owner_ping'].includes(guidance.approval_link_reason)
    ? guidance.approval_link_reason
    : refusal === 'verified_approval_required' ? 'owner_locked' : refusal === 'owner_decline_stands' ? 'owner_decline_stands' : null;
  return {
    kind: 'ordinary',
    gateReceiptId: receiptId,
    accepted: guidance.host_approval_accepted === true && !refusal,
    refusal,
    operatorOnly: guidance.host_approval_operator_only === true,
    ownerDeclinedAt: isoTime(guidance.owner_declined_at),
    earlierDeclineAt: isoTime(guidance.earlier_decline_at),
    operatorNotice: typeof guidance.operator_notice === 'string' ? displayText(guidance.operator_notice, 160) : '',
    linkAvailable,
    linkReason: linkAvailable ? linkReason : null,
    expiresAt,
    pollAfterMs,
  };
}

function holdNextText(hold) {
  if (hold.kind === 'legacy') {
    return `Marrow holds this action for approval (gate receipt ${hold.gateReceiptId}). This Marrow service does not take approvals from a terminal yet, so it stays held and nothing ran.`;
  }
  if (hold.kind === 'arbitration') {
    return `Marrow holds this action for arbitration review (gate receipt ${hold.gateReceiptId}). The account owner picks one proposal; run it with npx @getmarrow/install run, which asks Marrow to send the owner a one-tap link and runs it once the owner approves this one.`;
  }
  if (hold.refusal === 'owner_decline_stands') {
    return `The account owner declined this action${hold.ownerDeclinedAt ? ` at ${hold.ownerDeclinedAt}` : ''}, and only the owner can reverse that. To ask the owner with a one-tap approval link, rerun with --request-owner-link.`;
  }
  if (hold.refusal === 'approval_state_unavailable') {
    return 'Marrow could not read the approval state for this action, so it did not run. Retry in a moment.';
  }
  if (hold.refusal === 'verified_approval_required') {
    return `Marrow holds this action until the account owner approves it (gate receipt ${hold.gateReceiptId}). Run it with npx @getmarrow/install run, which asks Marrow to send the owner a one-tap link.`;
  }
  return `Marrow holds this action until a person approves it (gate receipt ${hold.gateReceiptId}). Run it with npx @getmarrow/install run in an interactive terminal to approve it there.`;
}

function gateReceiptRoute(gateReceiptId, suffix) {
  return `/v1/agent/gate-receipts/${encodeURIComponent(gateReceiptId)}/${suffix}`;
}

function errorCode(json) {
  const details = recordOf(json?.details);
  const code = typeof details.code === 'string' ? details.code : typeof json?.code === 'string' ? json.code : '';
  return /^[A-Z0-9_]{1,80}$/.test(code) ? code : '';
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// Who is at this terminal. An agent driving a pseudo-terminal must not answer the prompt.
// ---------------------------------------------------------------------------

// Environment set by agent hosts for the commands they run (Claude Code, Gemini CLI, Codex,
// Cursor's agent, OpenCode).
const AGENT_HOST_ENV = Object.freeze([
  'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'GEMINI_CLI',
  'CODEX_SANDBOX', 'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_MANAGED_BY_NPM', 'CODEX_THREAD_ID',
  'CURSOR_AGENT', 'OPENCODE',
]);
const AGENT_HOST_PROGRAM_RE = /^(?:claude|codex|gemini|cursor-agent|opencode|aider|goose)(?:\.exe|\.js|\.mjs|\.cjs)?$/i;
const AGENT_HOST_PATH_RE = /(?:^|[\\/])(?:@anthropic-ai[\\/]claude-code|@openai[\\/]codex|@google[\\/]gemini-cli)(?:[\\/]|$)/i;

function linuxProcessArgs(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    const args = fs.readFileSync(`/proc/${pid}/cmdline`).toString('utf8').split('\0').filter(Boolean).slice(0, 8);
    return Number.isSafeInteger(ppid) ? { ppid, args } : null;
  } catch {
    return null;
  }
}

// An agent host among this process's ancestors (Linux /proc; elsewhere the environment decides).
function agentHostAncestor(reader = process.platform === 'linux' ? linuxProcessArgs : () => null, startPid = process.ppid) {
  let pid = startPid;
  for (let depth = 0; depth < 8 && pid > 1; depth += 1) {
    const info = reader(pid);
    if (!info) return false;
    const programs = info.args.slice(0, 2);
    if (programs.some((arg) => AGENT_HOST_PROGRAM_RE.test(path.basename(String(arg))) || AGENT_HOST_PATH_RE.test(String(arg)))) return true;
    pid = info.ppid;
  }
  return false;
}

function agentHostDetected(env = process.env, reader) {
  if (AGENT_HOST_ENV.some((name) => typeof env[name] === 'string' && env[name] !== '' && env[name] !== '0' && env[name].toLowerCase() !== 'false')) return true;
  return agentHostAncestor(reader);
}

// One terminal line, read only from a person at an interactive terminal: stdin and stderr are
// terminals, not CI, not --no-interactive, and no agent host runs this process.
function approvalPromptAvailable(options, io = {}) {
  const env = io.env || process.env;
  if (agentHostDetected(env, io.processReader)) return false;
  if (options.interactive === false) return false;
  const ci = String(env.CI || '').toLowerCase();
  if (ci && ci !== 'false' && ci !== '0') return false;
  if (typeof io.approvalPrompt === 'function') return true;
  const input = io.stdin || process.stdin;
  const output = io.stderr || process.stderr;
  return Boolean(input?.isTTY && output?.isTTY);
}

function askLine(question, io = {}) {
  if (typeof io.approvalPrompt === 'function') return Promise.resolve(io.approvalPrompt(question));
  const input = io.stdin || process.stdin;
  const output = io.stderr || process.stderr;
  const timeoutMs = Number.isFinite(io.promptTimeoutMs) ? io.promptTimeoutMs : APPROVAL_PROMPT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output, terminal: true });
    let done = false;
    let timer = null;
    const finish = (value) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      rl.close();
      if (input.pause) input.pause();
      resolve(value);
    };
    // No answer is never a yes.
    timer = setTimeout(() => {
      output.write('\n');
      finish(null);
    }, timeoutMs);
    rl.on('SIGINT', () => {
      output.write('\n');
      finish(null);
    });
    rl.on('close', () => finish(null));
    rl.question(question, (answer) => finish(answer));
  });
}

function parseAnswer(value) {
  if (typeof value !== 'string') return null;
  if (/^\s*y(?:es)?\s*$/i.test(value)) return 'yes';
  if (/^\s*n(?:o)?\s*$/i.test(value)) return 'no';
  return null;
}

function runnerHostSessionId(sessionId) {
  const session = String(sessionId || '');
  return HOST_SESSION_ID_RE.test(session)
    ? session
    : `runner-${crypto.createHash('sha256').update(session).digest('hex').slice(0, 32)}`;
}

// ---------------------------------------------------------------------------
// The default session and the local record of a command's hold.
// ---------------------------------------------------------------------------

function baseUrlOrigin(value) {
  try {
    const url = new URL(String(value || DEFAULT_BASE_URL));
    return `${url.protocol}//${url.host}`;
  } catch {
    return 'invalid-base-url';
  }
}

function realCwd() {
  try {
    return fs.realpathSync(process.cwd());
  } catch {
    return path.resolve(process.cwd());
  }
}

// One session per agent, project directory, OS user and Marrow service, per UTC day, so the
// backend sees reruns of a command as the same session (an owner's decline stands across
// them). The local hold record carries the session a hold was made in, so picking a hold up
// later, from another terminal or the next day, uses that session.
function defaultRunnerSession(options, now = new Date()) {
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : os.userInfo().username;
  const day = now.toISOString().slice(0, 10).replace(/-/g, '');
  const digest = crypto.createHash('sha256')
    .update(['runner-session-v1', uid, realCwd(), String(options.agentId || ''), baseUrlOrigin(options.baseUrl), day].join('\0'))
    .digest('hex');
  return `marrow-run-${digest.slice(0, 24)}`;
}

// The record key: this exact command, for this agent, project, user and service. It names no
// action text; the record holds only ids, states and times.
function runnerHoldKey(options, binding) {
  const uid = typeof process.getuid === 'function' ? String(process.getuid()) : os.userInfo().username;
  return crypto.createHash('sha256').update([
    'runner-hold-v1', baseUrlOrigin(options.baseUrl), String(options.agentId || ''), realCwd(), uid,
    binding.type, binding.action, binding.target, binding.commandText, [...binding.surfaces].sort().join(','),
  ].join('\0')).digest('hex').slice(0, 40);
}

const HOLD_RECORD_KEYS = new Set([
  'version', 'kind', 'state', 'gate_receipt_id', 'decision_id', 'runtime_decision_id', 'arbitration_receipt_id',
  'session_id', 'declined_by', 'declined_at', 'receipt_expires_at', 'approvable_here', 'link_reason',
  'link_sent_at', 'link_expires_at', 'denial_committed', 'created_at', 'updated_at',
]);

function holdRecordStore(io = {}) {
  const home = io.home || os.homedir();
  const directory = path.join(home, '.marrow', 'runner-holds');
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const file = (key) => path.join(directory, `${key}.json`);
  const ensureDirectory = () => {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== null && stat.uid !== uid)) throw new Error('unsafe runner hold directory');
    if ((stat.mode & 0o077) !== 0) fs.chmodSync(directory, 0o700);
  };
  const valid = (record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record) || record.version !== 1) return false;
    if (Object.keys(record).some((key) => !HOLD_RECORD_KEYS.has(key))) return false;
    if (!['ordinary', 'arbitration'].includes(record.kind) || !['waiting', 'declined'].includes(record.state)) return false;
    if (!GATE_RECEIPT_ID_RE.test(String(record.gate_receipt_id || '')) || !HOST_SESSION_ID_RE.test(String(record.session_id || ''))) return false;
    if (record.decision_id && !DECISION_ID_RE.test(record.decision_id)) return false;
    if (record.runtime_decision_id && !DECISION_ID_RE.test(record.runtime_decision_id)) return false;
    if (record.arbitration_receipt_id && !DECISION_ID_RE.test(record.arbitration_receipt_id)) return false;
    return Number.isFinite(Date.parse(record.created_at));
  };
  return {
    read(key) {
      try {
        const target = file(key);
        const stat = fs.lstatSync(target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8192 || (uid !== null && stat.uid !== uid) || (stat.mode & 0o077) !== 0) return null;
        const record = JSON.parse(fs.readFileSync(target, 'utf8'));
        if (!valid(record) || Date.now() - Date.parse(record.created_at) > HOLD_RECORD_MAX_AGE_MS) return null;
        return record;
      } catch {
        return null;
      }
    },
    write(key, record) {
      try {
        ensureDirectory();
        const now = new Date().toISOString();
        const value = Object.fromEntries(Object.entries({ version: 1, created_at: now, ...record, updated_at: now })
          .filter(([name, entry]) => HOLD_RECORD_KEYS.has(name) && entry !== undefined && entry !== null && entry !== ''));
        const temp = path.join(directory, `.${key}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
        fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
        fs.renameSync(temp, file(key));
        return true;
      } catch {
        return false;
      }
    },
    remove(key) {
      try { fs.unlinkSync(file(key)); } catch { /* already gone */ }
      try { fs.unlinkSync(path.join(directory, `${key}.claim`)); } catch { /* no claim */ }
    },
    // One run per approval: the first run to claim an approved receipt runs it; an identical
    // run started at the same time does not. A claim older than the receipt's life is stale.
    claim(key, gateReceiptId) {
      try {
        ensureDirectory();
        const target = path.join(directory, `${key}.claim`);
        try {
          const stat = fs.lstatSync(target);
          if (stat.isFile() && Date.now() - stat.mtimeMs > 60 * 60_000) fs.unlinkSync(target);
        } catch { /* no claim yet */ }
        fs.writeFileSync(target, `${gateReceiptId}\n`, { flag: 'wx', mode: 0o600 });
        return true;
      } catch {
        return false;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Marrow calls for a hold.
// ---------------------------------------------------------------------------

// POSTs that answer a hold are resent unchanged on a retryable answer (the host route and the
// link route record nothing on those), at most three attempts.
async function holdPost(options, route, body, io = {}) {
  const retryMs = Number.isFinite(io.approvalRetryMs) ? io.approvalRetryMs : APPROVAL_REQUEST_RETRY_MS;
  let last = { ok: false, status: 0, code: 'request_failed', json: {} };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const { response, json } = await rawRequest(options, 'POST', route, body, {}, { timeoutMs: 15_000 });
      const code = errorCode(json);
      last = { ok: response.ok, status: response.status, code, json, data: response.ok ? dataOf(json) : null };
      if (response.ok) return last;
      const retryable = response.status >= 500
        || (response.status === 429 && recordOf(json?.details).retryable === true)
        || ['MARROW_OWNER_APPROVAL_STATE_UNAVAILABLE', 'MARROW_APPROVAL_LINK_UNDELIVERED'].includes(code);
      if (!retryable) return last;
    } catch (error) {
      last = { ok: false, status: 0, code: isTimeout(error) ? 'timed_out' : 'request_failed', json: {} };
    }
    if (attempt < 3) await sleep(retryMs);
  }
  return last;
}

async function holdPostOnce(options, route, body) {
  try {
    const { response, json } = await rawRequest(options, 'POST', route, body, {}, { timeoutMs: 15_000 });
    return { ok: response.ok, status: response.status, code: errorCode(json), json, data: response.ok ? dataOf(json) : null };
  } catch (error) {
    return { ok: false, status: 0, code: isTimeout(error) ? 'timed_out' : 'request_failed', json: {} };
  }
}

async function reportRunnerVerdict(options, gateReceiptId, verdict, times, decisionIds, io) {
  const decisionId = verdict === 'approved' ? decisionIds.decisionId : decisionIds.runtimeDecisionId;
  const body = {
    verdict,
    host: 'other',
    host_session_id: runnerHostSessionId(options.sessionId),
    hook_event: RUNNER_HOOK_EVENT,
    asked_at: times.askedAt,
    answered_at: times.answeredAt,
    ...(decisionId && DECISION_ID_RE.test(decisionId) ? { decision_id: decisionId } : {}),
  };
  const result = await holdPost(options, gateReceiptRoute(gateReceiptId, 'host-approval'), body, io);
  if (result.ok) {
    const recorded = recordOf(recordOf(result.data).host_approval);
    return { recorded: recorded.verdict === verdict, verdict: recorded.verdict === 'declined' ? 'declined' : recorded.verdict === 'approved' ? 'approved' : null, answeredBy: typeof recorded.answered_by === 'string' ? recorded.answered_by : null };
  }
  if (result.code === 'MARROW_OWNER_APPROVAL_ALREADY_DECIDED') {
    const existing = recordOf(result.json?.details).existing_verdict;
    return { recorded: false, verdict: existing === 'approved' ? 'approved' : existing === 'declined' ? 'declined' : null, code: result.code };
  }
  if (result.code === 'MARROW_OWNER_APPROVAL_DECLINED') return { recorded: false, verdict: 'declined', code: result.code };
  return { recorded: false, verdict: null, code: result.code || `HTTP_${result.status}` };
}

// Asks Marrow to send the owner a one-tap link. A 200 answer that says it was not sent (the owner
// has not turned on unattended pings) is a quiet hold, not an error. Keeps only the channel and
// expiry: the response never contains the link, and its recipient hint is dropped here.
async function requestOwnerLink(options, gateReceiptId, decisionId, state, io) {
  while (state.linkRequests < APPROVAL_LINK_MAX_REQUESTS) {
    state.linkRequests += 1;
    const result = await holdPostOnce(options, gateReceiptRoute(gateReceiptId, 'approval-link'),
      decisionId && DECISION_ID_RE.test(decisionId) ? { decision_id: decisionId } : {});
    if (result.ok) {
      const data = recordOf(result.data);
      if (data.sent === false || data.state === 'not_sent') {
        return { sent: false, quiet: true, reason: typeof data.reason === 'string' ? data.reason.slice(0, 40) : 'not_sent' };
      }
      const link = recordOf(data.approval_link);
      if (!Object.keys(link).length) return { sent: false, code: 'MARROW_APPROVAL_LINK_ANSWER_INVALID' };
      state.channel = APPROVAL_LINK_CHANNELS.has(link.channel) ? link.channel : 'owner channel';
      state.expiresAt = isoTime(link.expires_at);
      return { sent: true };
    }
    const retryable = result.status >= 500 || result.status === 0
      || (result.status === 429 && recordOf(result.json?.details).retryable === true)
      || ['MARROW_OWNER_APPROVAL_STATE_UNAVAILABLE', 'MARROW_APPROVAL_LINK_UNDELIVERED'].includes(result.code);
    if (!retryable) return { sent: false, code: result.code || `HTTP_${result.status}` };
    if (state.linkRequests < APPROVAL_LINK_MAX_REQUESTS) {
      await sleep(Number.isFinite(io.approvalRetryMs) ? io.approvalRetryMs : APPROVAL_REQUEST_RETRY_MS);
    }
  }
  return { sent: false, code: 'MARROW_APPROVAL_LINK_REQUESTS_EXHAUSTED' };
}

const LINK_FAILURE_TEXT = {
  MARROW_APPROVAL_CHANNEL_UNAVAILABLE: 'the account has no approval channel Marrow can send it to',
  MARROW_APPROVAL_LINK_LIMITED: 'enough approval links were already sent for this action or this hour',
  MARROW_OWNER_APPROVAL_ALREADY_DECIDED: 'this hold already has an answer',
  MARROW_ARBITRATION_OWNER_APPROVAL_REQUIRED: 'this action is governed by arbitration review',
  MARROW_PRE_ACTION_GATE_USED: 'its gate receipt was already used',
  MARROW_PRE_ACTION_GATE_EXPIRED: 'its gate receipt expired',
  MARROW_APPROVAL_LINK_NOT_HELD: 'Marrow no longer holds this action',
  MARROW_APPROVAL_LINK_REQUESTS_EXHAUSTED: `Marrow could not deliver it after ${APPROVAL_LINK_MAX_REQUESTS} requests`,
};

// One status read: the state, plus the approval fields the runner keeps.
async function readHoldStatus(options, gateReceiptId) {
  try {
    const { response, json } = await rawRequest(options, 'GET', gateReceiptRoute(gateReceiptId, 'owner-approval'), undefined, {}, { timeoutMs: 15_000 });
    if (response.status === 404) return { state: 'unknown' };
    if (!response.ok) return { state: 'unavailable' };
    const view = recordOf(dataOf(json));
    const stateValue = typeof view.state === 'string' ? view.state : 'unavailable';
    return {
      state: stateValue,
      source: typeof view.approval_source === 'string' ? view.approval_source.slice(0, 40) : null,
      answeredBy: typeof view.approval_answered_by === 'string' ? view.approval_answered_by.slice(0, 40) : null,
      ownerApprovalReceiptId: safeId(view.owner_approval_receipt_id),
      pollAfterMs: Number(view.poll_after_ms),
    };
  } catch {
    return { state: 'unavailable' };
  }
}

const WAITING_STATES = new Set(['pending', 'arbitration_review', 'unavailable']);

// Waits on the status endpoint until the hold is answered, expires, or the deadline passes.
async function waitForOwnerAnswer(options, gateReceiptId, pollAfterMs, deadline, io) {
  const minPoll = Number.isFinite(io.approvalPollMs) ? io.approvalPollMs : APPROVAL_STATUS_MIN_POLL_MS;
  let pollMs = Math.max(minPoll, Math.min(pollAfterMs, APPROVAL_STATUS_MAX_POLL_MS));
  for (;;) {
    const status = await readHoldStatus(options, gateReceiptId);
    if (!WAITING_STATES.has(status.state)) return status;
    if (Number.isFinite(status.pollAfterMs) && status.pollAfterMs > 0) pollMs = Math.max(minPoll, Math.min(status.pollAfterMs, APPROVAL_STATUS_MAX_POLL_MS));
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { state: 'timeout' };
    await sleep(Math.min(pollMs, remaining));
  }
}

// A gate denial report closes trusted only with its receipt and no proof: there is no
// completion to prove, and the receipt is what makes the denial verifiable.
async function commitHoldDenial(options, decisionIds, gateReceiptId, outcome) {
  const decisionId = decisionIds.runtimeDecisionId || decisionIds.decisionId;
  if (!decisionId) return 'not_recorded';
  try {
    const commit = await commitOutcome(options, decisionId, false, outcome, undefined,
      decisionIds.runtimeDecisionId ? gateReceiptId : '');
    return commit?.committed === true ? 'committed' : 'not_committed';
  } catch {
    return 'failed';
  }
}

function heldText(hold, interactive) {
  if (hold.kind === 'arbitration') return `Marrow holds this action for arbitration review (gate receipt ${hold.gateReceiptId}): the account owner picks one proposal.`;
  return `Marrow holds this action until ${hold.accepted && !hold.operatorOnly && interactive ? 'you approve it' : hold.refusal ? 'the account owner approves it' : 'a person approves it'} (gate receipt ${hold.gateReceiptId}).`;
}

function quietHoldText(hold, interactive) {
  if (hold.kind === 'ordinary' && hold.operatorOnly && hold.accepted) {
    return `You declined this action${hold.earlierDeclineAt ? ` at ${hold.earlierDeclineAt}` : ' earlier'}, so it stays held and nothing ran.`;
  }
  if (hold.kind === 'ordinary' && hold.accepted && !interactive) {
    return 'It is held until a person approves it, and nothing ran. Rerun this command in an interactive terminal to approve it there; that run picks up this hold.';
  }
  return 'It stays held until the account owner approves it, and nothing ran. Rerun this command to check; a later run picks up this hold.';
}

// Resolves one hold in this run. Returns { approved: true, ... } only when Marrow recorded an
// approval: the operator's typed "y" at an interactive terminal (reported as the operator's
// answer, client-attested), or the account owner's approval. Otherwise the command does not
// run, and the hold is remembered so the next run of this command picks it up.
async function resolveHold(options, hold, context) {
  const io = context.io || {};
  const err = io.stderr || process.stderr;
  const say = (text) => err.write(`${text}\n`);
  const records = context.records;
  const state = { linkRequests: 0, channel: null, expiresAt: null, source: null };
  const decisionIds = context.decisionIds;
  const summary = (extra = {}) => ({
    gate_receipt_id: hold.gateReceiptId,
    link_requests: state.linkRequests,
    ...(state.channel ? { channel: state.channel, expires_at: state.expiresAt } : {}),
    ...(state.source ? { source: state.source } : {}),
    ...extra,
  });
  const recordBase = () => ({
    kind: hold.kind,
    gate_receipt_id: hold.gateReceiptId,
    decision_id: decisionIds.decisionId,
    runtime_decision_id: decisionIds.runtimeDecisionId,
    arbitration_receipt_id: hold.arbitrationReceiptId,
    session_id: options.sessionId,
    receipt_expires_at: hold.expiresAt,
    approvable_here: hold.kind === 'ordinary' && hold.accepted && !hold.operatorOnly,
    link_reason: hold.linkReason,
  });
  const remember = (extra = {}) => records?.write(context.holdKey, { ...recordBase(), state: 'waiting', ...extra });
  const refused = (message, extra = {}) => ({ approved: false, exitCode: 12, message, approval: summary(extra) });
  const held = (message, extra = {}) => {
    remember(state.channel ? { link_sent_at: new Date().toISOString(), link_expires_at: state.expiresAt } : {});
    return refused(message, { state: 'held', ...extra });
  };
  const denial = async (message, outcome, declinedBy, extra) => {
    const commitState = await commitHoldDenial(options, decisionIds, hold.gateReceiptId, outcome);
    records?.write(context.holdKey, { ...recordBase(), state: 'declined', declined_by: declinedBy, declined_at: new Date().toISOString(), denial_committed: commitState === 'committed' ? 'yes' : undefined });
    return refused(message, { ...extra, denial_commit: commitState });
  };

  if (hold.refusal === 'approval_state_unavailable') return refused(holdNextText(hold), { state: 'state_unavailable' });
  const interactive = approvalPromptAvailable(options, io);
  say(heldText(hold, interactive));

  let asked = Boolean(options.requestOwnerLink);
  let ownerOnly = hold.kind === 'arbitration' || !hold.accepted || hold.operatorOnly;
  let linkAvailable = hold.linkAvailable;

  // 1. The operator answers here, at an interactive terminal, when Marrow lets the operator
  // approve: not after an earlier operator decline (Marrow then accepts only a marked answer in
  // a host's own dialog, which this prompt is not), and not for owner-only holds.
  if (hold.kind === 'ordinary' && !ownerOnly && interactive) {
    const askedAt = new Date().toISOString();
    const raw = await askLine(`${hold.operatorNotice ? `${hold.operatorNotice} ` : ''}Approve and run it now? [y/N] `, io);
    const answer = parseAnswer(raw);
    const times = { askedAt, answeredAt: new Date().toISOString() };
    state.source = 'operator_prompt';
    if (answer === null) {
      remember();
      return refused('No answer was given, so nothing ran and nothing was recorded. Rerun this command to answer; it picks up this hold.', { state: 'no_answer' });
    }
    const report = await reportRunnerVerdict(options, hold.gateReceiptId, answer === 'yes' ? 'approved' : 'declined', times, decisionIds, io);
    if (answer === 'no') {
      if (report.verdict !== 'declined') {
        remember();
        return refused(`Marrow could not record the decline (${report.code || 'not recorded'}). Nothing ran.`, { state: 'declined_unrecorded' });
      }
      return denial('Declined. The action did not run.', 'Denied by Marrow pre-action gate: the operator declined in the governed runner.', 'operator', { state: 'declined' });
    }
    if (report.verdict === 'declined') {
      return denial('This action was already declined. It did not run.', 'Denied by Marrow pre-action gate: the approval was declined.', 'account_owner', { state: 'declined' });
    }
    if (report.verdict === 'approved') {
      say('Marrow recorded your approval (client-attested).');
      return { approved: true, approval: summary({ state: 'approved', answered_by: report.answeredBy }) };
    }
    if (report.code === 'MARROW_VERIFIED_OWNER_APPROVAL_REQUIRED') {
      ownerOnly = true;
      linkAvailable = true;
      hold = { ...hold, linkReason: 'owner_locked' };
      say('Only the account owner can approve this action.');
    } else if (report.code === 'MARROW_OWNER_DECLINE_STANDS') {
      ownerOnly = true;
      linkAvailable = true;
      asked = true;
      hold = { ...hold, refusal: 'owner_decline_stands', linkReason: 'owner_decline_stands' };
      say('The account owner declined this action; only the owner can reverse that.');
    } else {
      remember();
      return refused(`Marrow could not record your approval (${report.code || 'not recorded'}). Nothing ran.`, { state: 'not_recorded' });
    }
  }

  // 2. Only the owner reverses the owner's own decline, and Marrow asks them only on request.
  if (hold.kind === 'ordinary' && hold.refusal === 'owner_decline_stands' && !asked) {
    asked = interactive
      ? parseAnswer(await askLine(`The account owner declined this action${hold.ownerDeclinedAt ? ` at ${hold.ownerDeclinedAt}` : ''}; only the owner can reverse that. Ask the owner now with a one-tap approval link? [y/N] `, io)) === 'yes'
      : false;
    if (!asked) {
      records?.write(context.holdKey, { ...recordBase(), state: 'declined', declined_by: 'account_owner', declined_at: hold.ownerDeclinedAt || new Date().toISOString() });
      return refused(holdNextText(hold), { state: 'owner_decline_stands' });
    }
  }

  // 3. The owner's one-tap link, only where Marrow says it would be sent.
  let linkSent = false;
  if (linkAvailable) {
    state.source = 'owner_link';
    const link = await requestOwnerLink(options, hold.gateReceiptId, decisionIds.decisionId, state, io);
    if (link.sent) {
      linkSent = true;
      say(`An approval link was sent to the account owner (${state.channel}). It works once${state.expiresAt ? `, until ${state.expiresAt}` : ''}.`);
    } else if (!link.quiet) {
      remember();
      return refused(`No approval link was sent: ${LINK_FAILURE_TEXT[link.code] || `Marrow answered ${link.code}`}. Nothing ran.`, { state: 'link_not_sent', code: link.code });
    }
  }

  // 4. Wait while a person is here for the owner's link, or when asked to (--approval-wait);
  // otherwise hold quietly. A later run of this command picks the answer up on this receipt.
  const waitSeconds = options.approvalWaitSeconds;
  const linkDeadline = linkSent && state.expiresAt ? Date.parse(state.expiresAt) : linkSent ? Date.now() + 10 * 60_000 : null;
  const wait = waitSeconds == null
    ? (interactive && linkSent ? linkDeadline - Date.now() : 0)
    : linkSent ? Math.min(waitSeconds * 1000, linkDeadline - Date.now()) : waitSeconds * 1000;
  if (wait <= 0) {
    return held(linkSent
      ? 'It is held until the owner approves it, and nothing ran. Rerun this command after they answer; it picks up this hold.'
      : quietHoldText(hold, interactive), linkAvailable && !linkSent ? { link: 'not_sent' } : {});
  }
  say(linkSent
    ? 'Waiting for the owner\'s answer. Ctrl+C stops waiting; a later run of this command picks up the answer.'
    : 'Waiting for a person to approve it. Ctrl+C stops waiting; a later run of this command picks up the answer.');
  const answer = await waitForOwnerAnswer(options, hold.gateReceiptId, hold.pollAfterMs, Date.now() + wait, io);
  return finishOwnerAnswer(answer, { hold, say, summary, refused, held, denial, records, holdKey: context.holdKey, linkDeadline });
}

// What the runner does with the owner's answer (in this run, or picked up by a later run).
async function finishOwnerAnswer(answer, ctx) {
  const { hold, say, summary, refused, held, denial, records, holdKey } = ctx;
  if (answer.state === 'approved') {
    if (hold.kind === 'arbitration' && !answer.ownerApprovalReceiptId) {
      return refused('Marrow reported the arbitration as approved without an owner approval receipt, so nothing ran.', { state: 'approval_incomplete' });
    }
    say(hold.kind === 'arbitration' ? 'The account owner approved a proposal. Checking that it is this one.' : 'The action was approved. Running it.');
    return {
      approved: true,
      approval: summary({ state: 'approved', approved_via: answer.source, answered_by: answer.answeredBy }),
      commitExtras: hold.kind === 'arbitration'
        ? { arbitration_receipt_id: hold.arbitrationReceiptId, owner_approval_receipt_id: answer.ownerApprovalReceiptId }
        : {},
    };
  }
  if (answer.state === 'declined') {
    return denial(hold.kind === 'arbitration' ? 'The account owner approved none of the proposals. The action did not run.' : 'The approval was declined. The action did not run.',
      hold.kind === 'arbitration' ? 'Denied by Marrow pre-action gate: the account owner approved none of the proposals.' : 'Denied by Marrow pre-action gate: the account owner declined.',
      answer.answeredBy === 'account_owner' || hold.kind === 'arbitration' ? 'account_owner' : 'operator', { state: 'declined' });
  }
  if (answer.state === 'timeout') {
    return held(ctx.linkDeadline && Date.now() >= ctx.linkDeadline - 1000
      ? 'The approval link expired before anyone answered. Nothing ran; rerun the command to check or ask again.'
      : 'Stopped waiting before the owner answered. Nothing ran; a later run of this command picks up their answer.', { state: 'timeout' });
  }
  records?.remove(holdKey);
  return refused(answer.state === 'expired'
    ? 'The gate receipt expired before it was approved. Nothing ran; rerun the command for a fresh gate.'
    : `Marrow reports this hold as ${answer.state}. Nothing ran.`, { state: answer.state });
}

// A hold an earlier run of this exact command left behind. Its answer decides, on the same gate
// receipt: no new receipt and no new email. Returns { state: 'none' } when there is nothing to
// pick up (or it ran out), { state: 'blocked', ... } when the command must not run, or
// { state: 'approved', ... } to run it on that receipt.
async function resumeRecordedHold(options, records, holdKey, io = {}) {
  const record = records.read(holdKey);
  if (!record) return { state: 'none' };
  const err = io.stderr || process.stderr;
  const say = (text) => err.write(`${text}\n`);
  const now = Date.now();
  const hold = {
    kind: record.kind,
    gateReceiptId: record.gate_receipt_id,
    arbitrationReceiptId: record.arbitration_receipt_id || '',
    accepted: record.approvable_here === true,
    operatorOnly: false,
    refusal: null,
    linkAvailable: Boolean(record.link_reason),
    linkReason: record.link_reason || null,
    expiresAt: record.receipt_expires_at || null,
    pollAfterMs: 3_000,
  };
  const decisionIds = { decisionId: record.decision_id || '', runtimeDecisionId: record.runtime_decision_id || '' };
  const holdOptions = { ...options, sessionId: record.session_id };
  const base = { gateReceiptId: record.gate_receipt_id, decisionId: decisionIds.decisionId || decisionIds.runtimeDecisionId };
  const blocked = (message, approval = {}) => ({ state: 'blocked', exitCode: 12, message, ...base, approval: { gate_receipt_id: record.gate_receipt_id, resumed: true, ...approval } });

  if (record.state === 'declined') {
    const declinedAt = Date.parse(record.declined_at);
    if (!Number.isFinite(declinedAt) || now - declinedAt > DECLINE_STANDS_MS) {
      records.remove(holdKey);
      return { state: 'none' };
    }
    if (record.declined_by === 'account_owner') {
      if (options.requestOwnerLink) {
        // A new hold in the decline's own session, where Marrow sees the decline and sends the
        // owner the link to reverse it.
        records.remove(holdKey);
        return { state: 'none', sessionId: record.session_id };
      }
      return blocked(`The account owner declined this action at ${new Date(declinedAt).toISOString()}, and only the owner can reverse that. Nothing ran. To ask the owner with a one-tap approval link, rerun with --request-owner-link.`, { state: 'owner_decline_stands' });
    }
    return blocked(`You declined this action at ${new Date(declinedAt).toISOString()}. That answer stands until ${new Date(declinedAt + DECLINE_STANDS_MS).toISOString()}, and nothing ran.`, { state: 'declined' });
  }

  if (hold.expiresAt && Date.parse(hold.expiresAt) <= now) {
    records.remove(holdKey);
    return { state: 'none' };
  }
  const status = await readHoldStatus(holdOptions, record.gate_receipt_id);
  if (status.state === 'unavailable') {
    return blocked(`Marrow holds this action (gate receipt ${record.gate_receipt_id}) and its approval state could not be read, so nothing ran. Retry in a moment.`, { state: 'state_unavailable' });
  }
  if (['unknown', 'expired', 'used', 'not_held'].includes(status.state)) {
    records.remove(holdKey);
    return { state: 'none' };
  }
  const state = { linkRequests: 0, channel: null, expiresAt: record.link_expires_at || null, source: null };
  const summary = (extra = {}) => ({ gate_receipt_id: record.gate_receipt_id, resumed: true, link_requests: state.linkRequests, ...(state.channel ? { channel: state.channel, expires_at: state.expiresAt } : {}), ...extra });
  const refusedHere = (message, extra = {}) => ({ approved: false, exitCode: 12, message, approval: summary(extra) });
  const keep = (extra = {}) => records.write(holdKey, { ...record, ...extra });
  const heldHere = (message, extra = {}) => {
    keep(state.channel ? { link_sent_at: new Date().toISOString(), link_expires_at: state.expiresAt } : {});
    return refusedHere(message, { state: 'held', ...extra });
  };
  const denialHere = async (message, outcome, declinedBy, extra) => {
    const commitState = record.denial_committed === 'yes' ? 'committed' : await commitHoldDenial(holdOptions, decisionIds, record.gate_receipt_id, outcome);
    records.write(holdKey, { ...record, state: 'declined', declined_by: declinedBy, declined_at: new Date().toISOString(), denial_committed: commitState === 'committed' ? 'yes' : undefined });
    return refusedHere(message, { ...extra, denial_commit: commitState });
  };
  const toResult = (resolved) => (resolved.approved
    ? { state: 'approved', hold, ...base, options: holdOptions, approval: resolved.approval, commitExtras: resolved.commitExtras || {} }
    : { state: 'blocked', exitCode: resolved.exitCode, message: resolved.message, ...base, approval: resolved.approval });
  const ctx = { hold, say, summary, refused: refusedHere, held: heldHere, denial: denialHere, records, holdKey, linkDeadline: state.expiresAt ? Date.parse(state.expiresAt) : null };

  if (status.state === 'approved' || status.state === 'declined') {
    say(`Picking up the earlier hold of this command (gate receipt ${record.gate_receipt_id}).`);
    return toResult(await finishOwnerAnswer(status, ctx));
  }

  // Still waiting.
  const interactive = approvalPromptAvailable(holdOptions, io);
  say(`This command is still held (gate receipt ${record.gate_receipt_id}).`);
  if (hold.kind === 'ordinary' && hold.accepted && interactive) {
    const askedAt = new Date().toISOString();
    const raw = await askLine('Approve and run it now? [y/N] ', io);
    const answer = parseAnswer(raw);
    const times = { askedAt, answeredAt: new Date().toISOString() };
    state.source = 'operator_prompt';
    if (answer === null) return toResult(refusedHere('No answer was given, so nothing ran and nothing was recorded.', { state: 'no_answer' }));
    const report = await reportRunnerVerdict(holdOptions, record.gate_receipt_id, answer === 'yes' ? 'approved' : 'declined', times, decisionIds, io);
    if (answer === 'no') {
      if (report.verdict !== 'declined') return toResult(refusedHere(`Marrow could not record the decline (${report.code || 'not recorded'}). Nothing ran.`, { state: 'declined_unrecorded' }));
      return toResult(await denialHere('Declined. The action did not run.', 'Denied by Marrow pre-action gate: the operator declined in the governed runner.', 'operator', { state: 'declined' }));
    }
    if (report.verdict === 'approved') {
      say('Marrow recorded your approval (client-attested).');
      return toResult({ approved: true, approval: summary({ state: 'approved', source: 'operator_prompt', answered_by: report.answeredBy }) });
    }
    if (report.verdict === 'declined') return toResult(await denialHere('This action was already declined. It did not run.', 'Denied by Marrow pre-action gate: the approval was declined.', 'account_owner', { state: 'declined' }));
    return toResult(refusedHere(`Marrow could not record your approval (${report.code || 'not recorded'}). Nothing ran.`, { state: 'not_recorded' }));
  }

  // Waiting on the owner. A link that expired is asked for again only where Marrow sends one.
  const linkExpired = !record.link_expires_at || Date.parse(record.link_expires_at) <= now;
  if (hold.linkAvailable && hold.linkReason !== 'unattended_owner_ping' && linkExpired) {
    state.source = 'owner_link';
    const link = await requestOwnerLink(holdOptions, record.gate_receipt_id, decisionIds.decisionId, state, io);
    if (link.sent) say(`An approval link was sent to the account owner (${state.channel}). It works once${state.expiresAt ? `, until ${state.expiresAt}` : ''}.`);
  }
  const deadlineAt = state.expiresAt ? Date.parse(state.expiresAt) : record.link_expires_at ? Date.parse(record.link_expires_at) : null;
  const waitSeconds = options.approvalWaitSeconds;
  const wait = waitSeconds == null
    ? (interactive && deadlineAt ? deadlineAt - Date.now() : 0)
    : Math.min(waitSeconds * 1000, deadlineAt ? deadlineAt - Date.now() : waitSeconds * 1000);
  if (wait <= 0) {
    return toResult(heldHere(hold.kind === 'ordinary' && hold.accepted
      ? 'It is held until a person approves it, and nothing ran. Rerun this command in an interactive terminal to approve it there.'
      : 'It stays held until the account owner approves it, and nothing ran. Rerun this command after they answer.'));
  }
  say('Waiting for the owner\'s answer. Ctrl+C stops waiting; a later run of this command picks up the answer.');
  const answer = await waitForOwnerAnswer(holdOptions, record.gate_receipt_id, 3_000, Date.now() + wait, io);
  ctx.linkDeadline = deadlineAt;
  return toResult(await finishOwnerAnswer(answer, ctx));
}

function gateModeText(decision) {
  const parts = [decision.enforced === true
    ? 'enforced'
    : decision.enforced === false
    ? 'advisory, not enforced on this plan'
    : 'enforcement not reported'];
  if (decision.riskLevel) parts.push(`risk ${decision.riskLevel}`);
  if (decision.required) parts.push('receipt required');
  if (decision.ownerApprovalRequired) parts.push('owner approval required');
  return parts.join('; ');
}

function printGate(decision, runtime, stream = process.stdout, { resolvesHolds = false } = {}) {
  stream.write(`Marrow gate: ${decision.decision} (${gateModeText(decision)})\n`);
  if (decision.beforeYouAct) stream.write(`Before you act: ${decision.beforeYouAct}\n`);
  // A hold's served text is written for agents; the runner states its own next step instead,
  // and `run` explains the hold itself while it resolves it.
  const hold = shouldBlock(decision, { policy: 'enforce' }) ? heldApproval(runtime, decision) : null;
  if (hold) {
    if (!resolvesHolds) stream.write(`Next: ${holdNextText(hold)}\n`);
  } else if (decision.exactNextAction) stream.write(`Next: ${decision.exactNextAction}\n`);
  if (decision.proofPack?.required) {
    const missing = decision.proofPack.missing?.length ? ` missing: ${decision.proofPack.missing.join(', ')}` : '';
    stream.write(`Proof pack: required${missing}\n`);
  }
  if (runtime?.value_proof?.owner_summary) stream.write(`Value: ${runtime.value_proof.owner_summary}\n`);
}

function runChild(command, env = process.env, stdout = process.stdout) {
  return new Promise((resolve) => {
    const usageCapture = createHostUsageCapture(command);
    const child = spawn(command[0], command.slice(1), {
      stdio: usageCapture.supported ? ['inherit', 'pipe', 'inherit'] : 'inherit',
      shell: false,
      env,
    });
    let closed = null;
    let pendingWrites = 0;
    let settled = false;
    const settle = () => {
      if (settled || !closed || pendingWrites > 0) return;
      settled = true;
      resolve({
        ...closed,
        usageCaptureSupported: usageCapture.supported,
        modelUsage: usageCapture.finish(),
      });
    };
    if (usageCapture.supported && child.stdout) {
      child.stdout.on('data', (chunk) => {
        usageCapture.write(chunk);
        pendingWrites += 1;
        const ready = stdout.write(chunk, () => {
          pendingWrites -= 1;
          settle();
        });
        if (!ready) {
          child.stdout.pause();
          stdout.once('drain', () => child.stdout?.resume());
        }
      });
    }
    child.on('error', (error) => {
      closed = { exitCode: 127, error };
      settle();
    });
    child.on('close', (code, signal) => {
      closed = { exitCode: code ?? 1, signal: signal || null };
      settle();
    });
  });
}

function scopedExecutionEnv(permit) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith('MARROW_') && !SAFE_MARROW_CHILD_METADATA.has(name)) continue;
    if (name.startsWith('ACTION_PERMIT_')) continue;
    env[name] = value;
  }
  if (permit?.permit) {
    env.MARROW_ACTION_PERMIT = permit.permit;
    env.MARROW_ACTION_PERMIT_ID = String(permit.permit_id || '');
    env.MARROW_GOVERNANCE_VERIFIED = 'true';
  }
  return env;
}

async function createDecision(options, action, type, target, surfaces) {
  const meta = sourceMeta(options, 'think', { action, action_type: type });
  const body = {
    action,
    type,
    target,
    surfaces,
    source_meta: meta,
    context: {
      runner: '@getmarrow/install run',
      profile: options.profile,
      governed: true,
      source_meta: meta,
    },
  };
  return durableRequestJson(options, '/v1/agent/think', body,
    durableIdempotencyKey(options, '/v1/agent/think', [JSON.stringify(body)]));
}

// `run` folds its invocation nonce into the commit key. `proof` keeps a stable key per
// decision, so repeating the same proof command replays instead of recording twice.
function commitIdempotencyKey(options, decisionId, { perInvocation = true } = {}) {
  const parts = [options.agentId, options.sessionId, decisionId, ...(perInvocation ? [options.invocationNonce] : [])];
  return `marrow-run-${crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex')}`;
}

async function commitOutcome(options, decisionId, success, outcome, proof, gateReceiptId, modelUsage = null, { perInvocation = true, extras = {} } = {}) {
  const body = {
    decision_id: decisionId,
    success,
    outcome,
    proof,
    source_meta: sourceMeta(options, 'commit', { action: outcome }),
  };
  if (gateReceiptId) body.gate_receipt_id = gateReceiptId;
  // An arbitration hold closes with its arbitration receipt and the owner's approval receipt.
  if (extras.arbitration_receipt_id) body.arbitration_receipt_id = extras.arbitration_receipt_id;
  if (extras.owner_approval_receipt_id) body.owner_approval_receipt_id = extras.owner_approval_receipt_id;
  if (modelUsage) body.model_usage = modelUsage;
  return durableRequestJson(options, '/v1/agent/commit', body, commitIdempotencyKey(options, decisionId, { perInvocation }));
}

async function decisionForAction(options, decision, action, type, target, surfaces) {
  if (decision?.runtimeDecisionId) return { decisionId: decision.runtimeDecisionId, source: 'runtime' };
  const think = await createDecision(options, action, type, target, surfaces);
  const decisionId = think.decision_id || think.id || think.decision?.id || '';
  return { decisionId, source: decisionId ? 'think' : null };
}

async function runGoverned(parsed, execution = {}) {
  const { childCommand } = parsed;
  let options = parsed.options;
  const commandText = redactedCommand(childCommand);
  const action = options.action ? redact(options.action) : commandText;
  const riskText = `${action} ${commandText} ${options.target || ''}`;
  const type = options.type || inferType(riskText);
  const risky = isRisky(riskText, type);
  let runtime = null;
  let decision = null;
  let decisionId = '';
  let decisionSource = null;
  let actionPermit = null;
  let permitVerified = false;
  let degraded = false;
  let advisory = false;
  let protectedAction = risky;
  let hold = null;
  let holdApproval = null;
  let approvedHold = false;
  let gateReceiptId = '';
  let commitExtras = {};
  let decisionResolved = false;
  let claimed = false;
  const surfaces = inferSurfaces(commandText || action);
  const target = options.target || commandText;
  const records = holdRecordStore(execution);
  const holdKey = runnerHoldKey(options, { action, type, target, commandText, surfaces });
  const blocked = (exitCode, message, extra = {}) => ({ ok: false, blocked: true, exitCode, action, type, risky, ...extra, message });

  let localControl;
  try { localControl = readLocalControlState(execution.controlStateOptions || {}); }
  catch (error) {
    if (protectedAction) return { ok: false, blocked: true, exitCode: 13, action, type, risky, message: error.message };
    localControl = { enabled: true, state: 'error' };
  }
  if (!localControl.enabled) {
    const bypass = protectedAction ? await recordGovernedBypass({ harness: options.client, agentId: options.agentId, surfaces, risk: risky ? 'high' : 'medium' }, { ...options, ...(execution.controlStateOptions || {}) }) : { bypass_recorded: false, remote_delivered: false };
    const child = await runChild(childCommand, scopedExecutionEnv(null), execution.stdout || process.stdout);
    return { ok: child.exitCode === 0, blocked: false, exitCode: child.exitCode, action, type, risky, local_control: 'owner_disabled', bypass_recorded: bypass.bypass_recorded, bypass_remote_delivered: bypass.remote_delivered, decision: null, decision_id: '', permit_id: null, permit_verified: false, permit_closed: false };
  }

  try {
    // 0. An earlier run of this exact command left a hold: its answer decides, on the same gate
    // receipt (no new receipt, no new email). Once a hold exists nothing may run it unapproved.
    const resumed = await resumeRecordedHold(options, records, holdKey, execution);
    if (resumed.state !== 'none') protectedAction = true;
    if (resumed.state === 'blocked') {
      return blocked(resumed.exitCode, resumed.message, { decision_id: resumed.decisionId || '', gate_receipt_id: resumed.gateReceiptId, approval: resumed.approval });
    }
    // Asking the owner to reverse their decline starts a new hold in the decline's session.
    if (resumed.state === 'none' && resumed.sessionId) options = { ...options, sessionId: resumed.sessionId };
    if (resumed.state === 'approved') {
      hold = resumed.hold;
      approvedHold = true;
      options = resumed.options;
      holdApproval = resumed.approval;
      gateReceiptId = resumed.gateReceiptId;
      decisionId = resumed.decisionId;
      decisionSource = 'earlier_hold';
      decisionResolved = true;
      commitExtras = resumed.commitExtras || {};
    } else {
      runtime = await preflightRuntime(options, action, type, commandText);
      decision = runnerGateDecision(runtime);
      protectedAction = risky
        || decision.required === true
        || decision.riskLevel === 'high'
        || decision.riskLevel === 'critical';
      if (!decision.recognized) {
        if (protectedAction) throw new Error('Marrow runtime returned no gate decision, so this protected action cannot be checked.');
        process.stderr.write('Marrow gate: no decision returned; continuing because this action is not protected.\n');
      } else {
        printGate(decision, runtime, execution.gateOutput || process.stdout, { resolvesHolds: true });
      }
      gateReceiptId = decision.receiptId || '';
      if (shouldBlock(decision, options)) {
        // Held or blocked: from here every failure blocks; nothing degrades into running it.
        protectedAction = true;
        hold = heldApproval(runtime, decision);
        if (!hold || hold.kind === 'legacy') {
          return blocked(12, blockMessage(decision, hold), { decision, gate_receipt_id: gateReceiptId || null });
        }
        // The decision is resolved first so the operator's answer and the owner's link name it.
        ({ decisionId, source: decisionSource } = await decisionForAction(options, decision, action, type, target, surfaces));
        decisionResolved = true;
        const resolved = await resolveHold(options, hold, {
          io: execution,
          records,
          holdKey,
          decisionIds: { decisionId, runtimeDecisionId: decision.runtimeDecisionId || hold.arbitrationDecisionId || '' },
        });
        holdApproval = resolved.approval;
        if (!resolved.approved) {
          return blocked(resolved.exitCode, resolved.message, { decision, decision_id: decisionId, gate_receipt_id: hold.gateReceiptId, approval: holdApproval });
        }
        approvedHold = true;
        commitExtras = resolved.commitExtras || {};
      }
    }
    if (approvedHold) {
      // One run per approval: an identical run already using it keeps this one from running.
      if (!records.claim(holdKey, gateReceiptId)) {
        return blocked(12, `An identical run is already using the approval of gate receipt ${gateReceiptId}, so this one did not run.`, { decision_id: decisionId, gate_receipt_id: gateReceiptId, approval: holdApproval });
      }
      claimed = true;
    }
    if (!decisionResolved) ({ decisionId, source: decisionSource } = await decisionForAction(options, decision, action, type, target, surfaces));
    // Permits exist only where the plan enforces the gate. An advisory plan shows its warning,
    // runs the command and still records the outcome; it never asks for a permit it cannot get.
    // An approved ordinary hold runs on its gate receipt, as the MCP hooks do, and the commit
    // closes that receipt. An approved arbitration hold needs the permit: Marrow issues it only
    // when the proposal the owner approved is this exact action.
    const arbitrationApproved = approvedHold && hold?.kind === 'arbitration';
    const permitRequired = arbitrationApproved || (protectedAction && !approvedHold && decision?.enforced !== false);
    if (protectedAction && !approvedHold && !permitRequired) {
      advisory = true;
      process.stderr.write(`Marrow advisory: this ${type} action is not enforced on this plan (gate ${decision?.decision}). Running it and recording the outcome.\n`);
    }
    if (permitRequired) {
      if (!gateReceiptId) throw new Error('Marrow runtime returned no gate receipt, so no action permit can be issued.');
      try {
        actionPermit = await issueActionPermit(requestJson, options, {
          action,
          type,
          target,
          surfaces,
          decisionId,
          gateReceiptId,
          ...(arbitrationApproved ? { ownerApproval: commitExtras.owner_approval_receipt_id } : {}),
          proofRequirements: decision?.proofPack?.required_fields || decision?.proofPack?.missing || [],
        });
      } catch (error) {
        if (arbitrationApproved) {
          throw new Error('Marrow issued no permit for this command on the owner\'s arbitration approval (the approved proposal is not this exact action), so it did not run.');
        }
        throw error;
      }
      if (!actionPermit?.permit || !actionPermit?.permit_id) {
        throw new Error('Marrow did not issue a valid action permit.');
      }
      const verified = await verifyActionPermit(requestJson, options, {
        action,
        type,
        target,
        surfaces,
        permit: actionPermit.permit,
        protocolVersion: actionPermit.protocol_version,
      });
      if (verified?.verified !== true) throw new Error('Marrow action permit verification failed.');
      permitVerified = true;
    }
  } catch (error) {
    const canDegrade = !protectedAction
      && (options.failOpen || !options.failClosed);
    if (canDegrade) {
      actionPermit = null;
      permitVerified = false;
      degraded = true;
      process.stderr.write(`Marrow degraded: ${error.message}. Continuing because this action is not protected${decisionId ? '' : '; its outcome will not be recorded'}.\n`);
    } else {
      if (claimed) records.remove(holdKey);
      return {
        ok: false,
        blocked: true,
        degraded: true,
        exitCode: 13,
        action,
        type,
        risky,
        ...(hold ? { gate_receipt_id: gateReceiptId || null, approval: holdApproval } : {}),
        message: error.message,
      };
    }
  }

  const childEnv = scopedExecutionEnv(permitVerified ? actionPermit : null);
  const child = await runChild(childCommand, childEnv, execution.stdout || process.stdout);
  const success = child.exitCode === 0;
  const proof = defaultProof({ options, action, childCommand, exitCode: child.exitCode, success });
  const outcome = success
    ? `Marrow governed command succeeded with exit code ${child.exitCode}.`
    : `Marrow governed command failed with exit code ${child.exitCode}.`;

  let commit = null;
  let commitState = decisionId ? 'failed' : 'not_recorded';
  if (decisionId) {
    try {
      commit = await commitOutcome(
        options,
        decisionId,
        success,
        outcome,
        proof,
        gateReceiptId,
        child.modelUsage,
        { extras: commitExtras },
      );
      commitState = commit?.committed === true ? 'committed' : 'not_committed';
      if (commitState === 'not_committed') {
        process.stderr.write(`Marrow recorded this outcome without trusted closure (committed:${String(commit?.committed ?? 'missing')}).\n`);
      }
    } catch (error) {
      process.stderr.write(`Marrow outcome commit failed: ${error.message}\n`);
    }
  } else if (!degraded) {
    process.stderr.write('Marrow outcome not recorded: no decision id was returned before the command ran.\n');
  }
  // The approval is spent: this command's hold is done.
  if (approvedHold) records.remove(holdKey);

  let permitClosed = null;
  if (actionPermit?.permit) {
    try {
      permitClosed = await closeActionPermit(requestJson, options, {
        permit: actionPermit.permit,
        permitId: actionPermit.permit_id,
        protocolVersion: actionPermit.protocol_version,
        decisionId,
        success,
        evidence: proof,
      });
    } catch (error) {
      process.stderr.write(`Marrow permit close failed: ${error.message}\n`);
    }
  }

  return {
    ok: success,
    blocked: false,
    exitCode: child.exitCode,
    action,
    type,
    risky,
    degraded,
    advisory,
    decision,
    decision_id: decisionId,
    decision_source: decisionSource,
    gate_receipt_id: gateReceiptId || null,
    ...(holdApproval ? { approval: holdApproval } : {}),
    outcome_committed: commitState === 'committed',
    outcome_commit_state: commitState,
    permit_id: actionPermit?.permit_id || null,
    permit_verified: permitVerified,
    permit_closed: Boolean(permitClosed),
    usage_capture: {
      supported: child.usageCaptureSupported === true,
      observed: Boolean(child.modelUsage),
      source: child.modelUsage?.source || null,
      evidence: child.modelUsage
        ? 'accepted_host_reported_usage'
        : child.usageCaptureSupported
        ? 'no_valid_host_reported_usage'
        : 'unsupported_child_command',
    },
  };
}

async function permitOnly(parsed) {
  const { options } = parsed;
  const action = redact(options.action);
  const type = options.type || inferType(action);
  const target = options.target || action;
  const surfaces = inferSurfaces(target);
  const runtime = await preflightRuntime(options, action, type, target);
  const decision = runnerGateDecision(runtime);
  if (!decision.recognized) {
    return { ok: false, blocked: true, exitCode: 13, decision, message: 'Marrow runtime returned no gate decision, so no permit was issued.' };
  }
  if (shouldBlock(decision, options)) {
    return { ok: false, blocked: true, exitCode: 12, decision, message: blockMessage(decision, heldApproval(runtime, decision)) };
  }
  const { decisionId } = await decisionForAction(options, decision, action, type, target, surfaces);
  if (decision.enforced === false) {
    return {
      ok: true,
      advisory: true,
      decision,
      decision_id: decisionId,
      gate_receipt_id: decision.receiptId || null,
      permit: null,
      permit_id: null,
      message: `This plan runs Marrow gates in advisory mode (gate ${decision.decision}), so no action permit is issued. Record the outcome with proof after the action.`,
    };
  }
  if (!decision.receiptId) {
    return { ok: false, blocked: true, exitCode: 13, decision, message: 'Marrow runtime returned no gate receipt, so no permit was issued.' };
  }
  const result = await issueActionPermit(requestJson, options, {
    action,
    type,
    target,
    surfaces,
    decisionId,
    gateReceiptId: decision.receiptId,
    proofRequirements: decision.proofPack?.required_fields || decision.proofPack?.missing || [],
  });
  return { ok: true, decision_id: decisionId, gate_receipt_id: decision.receiptId, ...result };
}

async function verifyPermitOnly(parsed) {
  const { options } = parsed;
  const action = redact(options.action);
  const type = options.type || inferType(action);
  const surfaces = inferSurfaces(options.target || action);
  const result = await verifyActionPermit(requestJson, options, {
    action,
    type,
    target: options.target || action,
    surfaces,
    permit: options.permit,
  });
  const verified = result?.verified === true;
  return { ...result, ok: verified, exitCode: verified ? 0 : 14 };
}

async function coverageOnly(parsed) {
  return readEnforcementCoverage(requestJson, parsed.options);
}

async function sidecarOnly(parsed) {
  const options = parsed.options;
  const root = path.resolve(process.env.MARROW_CONTROLLER_PROJECT_ROOT || process.cwd());
  const managedMode = process.env.MARROW_CONTROLLER_MANAGED_MODE || 'auto';
  let lastMaintenanceAt = 0;
  let lastMaintenance = null;
  const maintain = async () => {
    if (lastMaintenance && Date.now() - lastMaintenanceAt < 5 * 60_000) return lastMaintenance;
    const detection = detectEnvironment(root, process.env);
    // Maintenance re-applies the controller's own configured agent id and base URL. A different
    // value found in managed MCP config is replaced unless the owner allowlisted it, and the
    // divergence is reported. It never edits the owner's Hermes config.
    const plan = buildPlan(detection, {
      mode: managedMode,
      agentId: options.agentId,
      baseUrl: options.baseUrl,
      client: options.client,
      maintenance: true,
    });
    const changes = applyPlan(plan, { yes: true, dryRun: false, doctor: false });
    const repaired = changes.filter((change) => change.applied).map((change) => change.label);
    const remaining = changes.filter((change) => change.changed && !change.applied).map((change) => change.label);
    const identityDivergence = changes.flatMap((change) => (change.identity_divergence || [])
      .map((divergence) => ({ ...divergence, path: change.path })));
    lastMaintenanceAt = Date.now();
    lastMaintenance = {
      state: remaining.length > 0 || identityDivergence.length > 0 ? 'attention_required' : repaired.length > 0 ? 'repaired' : 'clear',
      checked_at: new Date(lastMaintenanceAt).toISOString(),
      repaired,
      ...(identityDivergence.length ? { identity_divergence: identityDivergence } : {}),
      exact_fix: remaining.length > 0
        ? 'Run npx @getmarrow/install --repair in the managed project.'
        : identityDivergence.length > 0
        ? `Marrow reset ${identityDivergence.map((divergence) => divergence.field).join(', ')} in managed MCP config to the controller's configured values. If the previous value was intended, add it to MARROW_ALLOWED_BASE_URLS or MARROW_ALLOWED_AGENT_IDS and rerun npx -y @getmarrow/install@latest update.`
        : null,
    };
    return lastMaintenance;
  };
  const sidecar = await startGovernanceSidecar(options, {
    permit: (input) => issueActionPermit(requestJson, options, input),
    verify: (input) => verifyActionPermit(requestJson, options, input),
    close: (input) => closeActionPermit(requestJson, options, input),
    coverage: () => readEnforcementCoverage(requestJson, options),
    heartbeat: (input) => recordEnforcementHeartbeat(requestJson, options, input),
    maintain,
  });
  process.stdout.write(`Marrow governance sidecar active on 127.0.0.1:${sidecar.port}. Press Ctrl+C to stop.\n`);
  await new Promise((resolve) => sidecar.server.once('close', resolve));
  return { ok: true };
}

async function controllerOnly(parsed) {
  // The controller CLI uses the same project root and local identity as install and update, so
  // `controller ensure|stop|status` act on the controller those commands started. The local
  // identity is never sent to Marrow.
  const detection = detectEnvironment(process.cwd(), process.env);
  const envClient = process.env.MARROW_CLIENT || process.env.MARROW_HARNESS || process.env.MARROW_AGENT_CLIENT;
  const client = parsed.options.clientExplicit || envClient ? parsed.options.client : detectedClient(detection);
  const identityAgentId = localControllerAgentId(detection.root, client, parsed.options.agentId);
  const options = { ...parsed.options, client, identityAgentId, root: detection.root, mode: 'auto' };
  let result;
  if (parsed.action === 'ensure') result = await ensureCurrentGovernanceController(options);
  else if (parsed.action === 'start') result = await startGovernanceController(options);
  else if (parsed.action === 'stop') result = await stopProjectControllers(options);
  else result = await controllerStatus(options);
  if (!options.json) {
    process.stdout.write(`Marrow controller: ${result.active ? 'active' : result.state}.\n`);
    if (result.installer_version) process.stdout.write(`Installer version: ${result.installer_version}\n`);
    if (result.restarted) process.stdout.write(`Restarted: ${result.restarted.from_versions.join(', ')} -> ${result.restarted.to_version}\n`);
    if (result.started_at) process.stdout.write(`Started: ${result.started_at}\n`);
    if (result.exact_fix) process.stdout.write(`Next: ${result.exact_fix}\n`);
  }
  return { ok: result.active || parsed.action === 'stop', controller: result };
}

async function gateOnly(parsed) {
  const { options } = parsed;
  const action = redact(options.action);
  const type = options.type || inferType(action);
  const protectedAction = isRisky(action, type);
  let localControl;
  try { localControl = readLocalControlState(); } catch (error) {
    if (protectedAction) return { ok: false, allowed: false, blocked: true, exitCode: 13, action, type, decision: null, message: error.message };
    localControl = { enabled: true };
  }
  if (!localControl.enabled) {
    const bypass = protectedAction ? await recordGovernedBypass({ harness: options.client, agentId: options.agentId, surfaces: inferSurfaces(action), risk: 'high' }, options) : { bypass_recorded: false, remote_delivered: false };
    return { ok: true, allowed: true, state: 'owner_disabled', action, type, bypass_recorded: bypass.bypass_recorded, bypass_remote_delivered: bypass.remote_delivered, decision: null, permit: null };
  }
  const runtime = await preflightRuntime(options, action, type, action);
  const decision = runnerGateDecision(runtime);
  if (!decision.recognized) {
    return {
      ok: false,
      allowed: false,
      blocked: true,
      exitCode: 13,
      action,
      type,
      decision,
      message: 'Marrow runtime returned no gate decision. Run npx -y @getmarrow/install@latest update, then retry.',
    };
  }
  printGate(decision, runtime);
  if (decision.runtimeDecisionId) {
    const receipt = decision.receiptId ? ` --gate-receipt ${shellQuote(decision.receiptId)}` : '';
    process.stdout.write(`Decision: ${decision.runtimeDecisionId}. After the action, record its outcome: npx @getmarrow/install proof --session ${shellQuote(options.sessionId)} --decision-id ${shellQuote(decision.runtimeDecisionId)}${receipt} --success|--failure --summary "<what happened>"\n`);
  }
  // A gate used as `gate ... && deploy` must fail the shell chain when Marrow blocks.
  const blocked = shouldBlock(decision, options);
  return {
    ok: !blocked,
    allowed: !blocked,
    blocked,
    exitCode: blocked ? 12 : 0,
    action,
    type,
    decision,
    decision_id: decision.runtimeDecisionId || null,
    gate_receipt_id: decision.receiptId || null,
    session_id: options.sessionId,
    ...(blocked ? {
      message: decision.observationOnly
        ? blockMessage(decision)
        : heldApproval(runtime, decision)
        ? blockMessage(decision, heldApproval(runtime, decision))
        : decision.exactNextAction || `Marrow gate ${decision.decision}: this action needs approval or a policy change before it runs.`,
    } : {}),
  };
}

async function proofOnly(parsed) {
  const { options } = parsed;
  const proof = defaultProof({
    options,
    action: options.summary || options.outcome || 'manual proof closeout',
    childCommand: [],
    exitCode: options.success ? 0 : 1,
    success: options.success,
  });
  const result = await commitOutcome(
    options,
    options.decisionId,
    options.success,
    options.outcome || options.summary || (options.success ? 'Manual proof closeout succeeded.' : 'Manual proof closeout failed.'),
    proof,
    options.gateReceiptId || '',
    null,
    { perInvocation: false },
  );
  // Only committed:true is trusted closure; an accepted observation is reported, not claimed.
  const committed = result?.committed === true;
  return {
    ok: committed,
    decision_id: options.decisionId,
    committed,
    exitCode: committed ? 0 : 1,
    result,
    ...(committed ? {} : {
      message: `Marrow did not commit this outcome as trusted closure (committed:${String(result?.committed ?? 'missing')}). Runtime-created decisions need --gate-receipt and the --session printed by gate.`,
    }),
  };
}

async function statusOnly(parsed) {
  return requestJson(parsed.options, 'GET', '/v1/agent/status');
}

function statusPanel(status = {}) {
  const update = status.client_update && typeof status.client_update === 'object'
    ? status.client_update
    : null;
  const lines = [
    'Marrow runtime status',
    `Health: ${displayText(firstDefined(status.health, status.status, status.ok === false ? 'degraded' : 'unknown'), 40)}`,
  ];
  const notification = update?.notification_state || update?.notification;
  const priority = notification === 'security_required' || notification === 'recommended'
    ? notification
    : update?.version_status === 'unknown' || notification === 'unknown' || notification === 'version_unknown'
    ? 'version_unknown'
    : update?.priority || 'recommended';
  if (update && (update.update_available === true || update.version_status === 'unknown' || notification === 'unknown' || notification === 'version_unknown' || priority === 'security_required')) {
    lines.push(`Client update: ${displayText(priority, 32)}; installed=${displayText(update.installed_version || update.current_version || 'unknown', 32)}; latest=${displayText(update.latest_version || 'unknown', 32)}`);
    lines.push('Automatic notification: yes; automatic local mutation: no; operator policy applies.');
    if (update.owner_notice) lines.push(`Tell owner: ${displayText(update.owner_notice, 240)}`);
    if (update.agent_instruction) lines.push(`Agent instruction: ${displayText(update.agent_instruction, 240)}`);
    if (update.auto_update_command || update.update_command || update.exact_update_command) {
      lines.push(`Update: ${displayText(update.auto_update_command || update.update_command || update.exact_update_command, 240)}`);
    }
    if (update.verification_command || update.exact_verification_command) lines.push(`Verify: ${displayText(update.verification_command || update.exact_verification_command, 240)}`);
  } else {
    lines.push('Client update: current or unavailable.');
  }
  return lines.join('\n');
}

async function optionalRequestJson(options, method, route, body) {
  try {
    return { ok: true, data: await requestJson(options, method, route, body) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      status: error?.status || 0,
      details: error?.details || null,
    };
  }
}

function firstDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function numberValue(value, fallback = null) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return fallback;
}

function listValue(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function statusLabel(value, fallback = 'unknown') {
  if (typeof value === 'string' && value.trim()) return displayText(value, 80);
  if (typeof value === 'boolean') return value ? 'ok' : 'warn';
  return fallback;
}

function normalizeRecentDecisions(status, report, fleet) {
  return listValue(
    fleet.recent_decisions,
    fleet.decisions,
    report.recent_decisions,
    report.decisions,
    status.recent_decisions,
    status.last_decisions,
  ).slice(0, 5).map((decision) => {
    if (typeof decision === 'string') return displayText(decision, 120);
    return displayText(
      firstDefined(
        decision?.summary,
        decision?.action,
        decision?.type,
        decision?.id,
        decision?.decision_id,
        JSON.stringify(decision || {}),
      ),
      120,
    );
  });
}

function normalizeAgents(report, fleet, status) {
  return listValue(
    fleet.agents,
    fleet.live_agents,
    fleet.active_agents,
    report.agents,
    report.active_agents,
    status.agents,
  ).slice(0, 20).map((agent) => {
    if (typeof agent === 'string') return { id: displayText(agent, 80), status: 'active', role: '' };
    return {
      id: displayText(firstDefined(agent?.id, agent?.agent_id, agent?.name, agent?.key, 'agent'), 80),
      status: displayText(firstDefined(agent?.status, agent?.health, agent?.state, 'active'), 40),
      role: displayText(firstDefined(agent?.role, agent?.type, ''), 60),
      last_seen_at: displayText(firstDefined(agent?.last_seen_at, agent?.last_event_at, agent?.updated_at, ''), 80),
    };
  });
}

function normalizeGates(status, report) {
  const gateSource = status.gates || report.gates || {};
  const gateValue = (name) => {
    const value = firstDefined(
      gateSource[name],
      status[`${name}_gate`],
      report[`${name}_gate`],
      status[`${name}_status`],
      report[`${name}_status`],
    );
    if (value && typeof value === 'object') {
      return statusLabel(firstDefined(value.status, value.decision, value.enforcement_decision, value.state), 'unknown');
    }
    return statusLabel(value, 'unknown');
  };
  return {
    deploy: gateValue('deploy'),
    publish: gateValue('publish'),
    merge: gateValue('merge'),
  };
}

function normalizeArbitrations(status, report, fleet) {
  const source = firstDefined(
    report.arbitrations,
    report.report?.arbitrations,
    fleet.arbitrations,
    status.arbitrations,
    {},
  ) || {};
  const receipts = listValue(
    source.receipts,
    source.items,
    report.recent_arbitrations,
    fleet.recent_arbitrations,
    status.recent_arbitrations,
  ).slice(0, 8).map((receipt) => ({
    id: displayText(firstDefined(receipt?.id, receipt?.receipt_id, 'arbitration'), 80),
    decision_id: displayText(firstDefined(receipt?.decision_id, ''), 80),
    resolution: statusLabel(receipt?.resolution, 'unknown'),
    conflict_type: displayText(firstDefined(receipt?.conflict_type, 'action_conflict'), 60),
    selected_proposal_id: displayText(firstDefined(receipt?.selected_proposal_id, ''), 80),
    requesting_agent_id: displayText(firstDefined(receipt?.requesting_agent_id, ''), 80),
    exact_next_action: displayText(firstDefined(receipt?.exact_next_action, ''), 180),
    owner_approval_required: Boolean(receipt?.owner_approval_required),
    created_at: displayText(firstDefined(receipt?.created_at, ''), 80),
  }));
  return {
    open_count: numberValue(firstDefined(source.open_count, source.open, receipts.filter((item) => item.resolution !== 'selected' && item.resolution !== 'synthesized').length), 0),
    review_required_count: numberValue(firstDefined(source.review_required_count, source.review_required, receipts.filter((item) => item.resolution === 'review_required').length), 0),
    receipts,
  };
}

function normalizeFixCommands(status, capacity) {
  const commands = [];
  const add = (value, commandOnly = false) => {
    const text = displayText(value || '', 240);
    if (commandOnly && !/^(?:npx|npm|pnpm|yarn|node|export|MARROW_|curl|bash|sh)\b/.test(text)) return;
    if (text && !commands.includes(text)) commands.push(text);
  };
  add(status.exact_fix);
  add(status.recommended_fix);
  add(status.next_action);
  add(status.route_contract?.exact_fix);
  add(status.auto_outcome_closure?.exact_fix);
  add(status.capture_coverage?.exact_fix);
  add(status.activation_coverage?.exact_fix);
  add(status.activation_coverage?.drift?.repair_command, true);
  add(status.passive_activation?.exact_fix);
  if (status.client_update?.update_available === true || status.client_update?.version_status === 'unknown' || status.client_update?.notification_state === 'unknown' || status.client_update?.notification === 'version_unknown') {
    add(status.client_update?.update_command || status.client_update?.exact_update_command, true);
  }
  add(capacity.exact_next_action, true);
  add(capacity.next_action, true);
  if (listValue(status.missed_hooks, status.degraded_hooks).length) add('npx @getmarrow/install --repair');
  if (status.auto_outcome_closure?.status === 'degraded') add('npx @getmarrow/install --repair');
  return commands.slice(0, 6);
}

function normalizeActivationCoverage(status, report, fleet) {
  const source = firstDefined(
    status.activation_coverage,
    status.passive_activation,
    report.activation_coverage,
    report.passive_activation,
    fleet.activation_coverage,
    {},
  ) || {};
  const activation = source.activation || {};
  const capture = source.capture_coverage || source.capture || source.coverage || {};
  const closure = source.outcome_closure || source.closure || {};
  const effectiveness = source.intervention_effectiveness || source.effectiveness || {};
  const drift = source.drift && typeof source.drift === 'object' ? source.drift : {};
  const available = source.available === true || capture.available === true;
  const driftAvailable = available && drift.available === true && typeof drift.detected === 'boolean';
  const percent = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.max(0, Math.min(100, number));
  };
  const ratio = (value) => {
    const number = Number(value);
    if (!Number.isFinite(number)) return null;
    return Math.max(0, Math.min(100, number * 100));
  };
  const metricPercent = (explicitPercent, rate, fallbackPercent) => {
    const explicit = firstDefined(explicitPercent, fallbackPercent);
    return explicit == null ? ratio(rate) : percent(explicit);
  };
  return {
    available,
    state: statusLabel(firstDefined(source.state, source.status), available ? 'active' : 'warming_up'),
    capability_level: displayText(firstDefined(activation.capability_level, source.capability_level, source.capability, 'unknown'), 40),
    capture_percent: metricPercent(capture.percent, capture.rate, source.capture_percent),
    closure_percent: metricPercent(closure.percent, closure.rate, source.closure_percent),
    effectiveness_percent: metricPercent(
      effectiveness.followed_percent,
      firstDefined(effectiveness.follow_through_rate, effectiveness.rate),
      source.effectiveness_percent,
    ),
    drift: driftAvailable ? drift.detected : null,
    exact_fix: displayText(firstDefined(drift.repair_command, source.exact_fix, source.repair_command, ''), 180),
  };
}

function normalizeFleetSnapshot(raw, options) {
  const status = raw.status?.data || {};
  const capacity = raw.capacity?.data || {};
  const report = raw.report?.data || {};
  const fleet = raw.fleet?.data || {};
  const agents = normalizeAgents(report, fleet, status);
  const liveAgents = numberValue(firstDefined(
    fleet.live_agent_count,
    fleet.active_agent_count,
    fleet.fleet?.active_agents,
    fleet.fleet?.total_agents,
    report.live_agent_count,
    report.active_agent_count,
    report.fleet?.active_agents,
    report.fleet?.total_agents,
    status.live_agent_count,
    status.active_agent_count,
    agents.length || undefined,
  ), agents.length || null);
  const activeWorkflows = numberValue(firstDefined(
    Array.isArray(fleet.active_workflows) ? fleet.active_workflows.length : undefined,
    fleet.active_workflows,
    fleet.active_workflow_count,
    Array.isArray(report.active_workflows) ? report.active_workflows.length : undefined,
    report.active_workflows,
    report.active_workflow_count,
    status.active_workflows,
    status.active_workflow_count,
    status.workflow_sessions?.active,
  ), null);
  const proofWaiting = numberValue(firstDefined(
    status.proof_packs?.waiting,
    status.proof_packs?.incomplete,
    status.proof_pack_hygiene?.incomplete,
    status.proof_pack_incomplete,
    report.proof_packs?.waiting,
    fleet.proof_packs?.waiting,
  ), 0);
  const failedStaleOutcomes = numberValue(firstDefined(
    status.failed_stale_outcomes,
    status.stale_outcomes,
    status.auto_outcome_closure?.stale,
    status.outcome_hygiene?.stale,
    report.failed_outcomes,
    fleet.failed_outcomes,
  ), 0);
  const missedHooks = listValue(status.missed_hooks, status.degraded_hooks, status.capture_coverage?.missed_hooks)
    .map((hook) => displayText(typeof hook === 'string' ? hook : firstDefined(hook?.name, hook?.hook, JSON.stringify(hook)), 80))
    .slice(0, 8);
  const backpressure = capacity.current_backpressure || capacity.backpressure || capacity.scale_slo?.backpressure || {};
  const backpressureStatus = statusLabel(firstDefined(
    backpressure.status,
    backpressure.level,
    capacity.status,
    capacity.scale_status,
    capacity.agent_capacity?.status,
  ), raw.capacity?.ok ? 'ok' : 'unknown');
  const recentDecisions = normalizeRecentDecisions(status, report, fleet);
  const gates = normalizeGates(status, report);
  const arbitrations = normalizeArbitrations(status, report, fleet);
  const activationCoverage = normalizeActivationCoverage(status, report, fleet);
  const fixCommands = normalizeFixCommands(status, capacity);
  const errors = Object.entries(raw)
    .filter(([, value]) => value && value.ok === false)
    .map(([name, value]) => `${name}: ${displayText(value.error, 120)}`);

  return {
    ok: raw.status?.ok !== false,
    generated_at: new Date().toISOString(),
    agent_id: displayText(options.agentId, 80),
    base_url: options.baseUrl,
    live_agents: liveAgents,
    active_workflows: activeWorkflows,
    proof_waiting: proofWaiting,
    failed_stale_outcomes: failedStaleOutcomes,
    backpressure_status: backpressureStatus,
    capacity_next_action: displayText(firstDefined(capacity.exact_next_action, capacity.next_action, capacity.failure_mode?.exact_next_action, ''), 180),
    recent_decisions: recentDecisions,
    degraded_hooks: missedHooks,
    gates,
    arbitrations,
    activation_coverage: activationCoverage,
    client_update: status.client_update || null,
    agents,
    fix_commands: fixCommands.length ? fixCommands : ['npx @getmarrow/install doctor'],
    source_errors: errors,
  };
}

async function fleetSnapshot(options) {
  if (!options.apiKey) {
    return normalizeFleetSnapshot({
      status: {
        ok: false,
        error: 'MARROW_API_KEY missing',
        data: {
          enabled: false,
          missed_hooks: ['api_key'],
          recommended_fix: 'export MARROW_API_KEY=mrw_live_... && npx @getmarrow/install fleet',
        },
      },
      capacity: { ok: false, error: 'MARROW_API_KEY missing', data: {} },
      report: { ok: false, error: 'MARROW_API_KEY missing', data: {} },
      fleet: { ok: false, error: 'MARROW_API_KEY missing', data: {} },
    }, options);
  }
  const [status, capacity, report, fleet] = await Promise.all([
    optionalRequestJson(options, 'GET', '/v1/agent/status?fast=1'),
    optionalRequestJson(options, 'GET', '/v1/agent/scale/capacity-contract'),
    optionalRequestJson(options, 'GET', '/v1/agent/report'),
    optionalRequestJson(options, 'GET', '/v1/fleet'),
  ]);
  return normalizeFleetSnapshot({ status, capacity, report, fleet }, options);
}

function fleetPanel(snapshot) {
  const degraded = snapshot.degraded_hooks.length ? snapshot.degraded_hooks.join(', ') : 'none';
  const recent = snapshot.recent_decisions.length ? snapshot.recent_decisions.map((item) => `  - ${item}`).join('\n') : '  - none reported yet';
  const agents = snapshot.agents.length
    ? snapshot.agents.slice(0, 5).map((agent) => `  - ${agent.id}${agent.role ? ` (${agent.role})` : ''}: ${agent.status}${agent.last_seen_at ? ` last_seen=${agent.last_seen_at}` : ''}`).join('\n')
    : '  - no agent roster returned yet';
  const fixes = snapshot.fix_commands.map((command) => `  - ${command}`).join('\n');
  const arbitration = snapshot.arbitrations.receipts[0];
  const arbitrationSummary = arbitration
    ? `${arbitration.resolution} (${arbitration.conflict_type})${arbitration.exact_next_action ? ` - ${arbitration.exact_next_action}` : ''}`
    : 'none reported yet';
  return [
    'Marrow Fleet Operator',
    '',
    `Agent: ${snapshot.agent_id || 'resolved by API key'}`,
    `Snapshot: ${snapshot.generated_at}`,
    '',
    `Live agents: ${snapshot.live_agents ?? 'unknown'}`,
    `Active workflows: ${snapshot.active_workflows ?? 'unknown'}`,
    `Passive activation: ${snapshot.activation_coverage.state} capability=${snapshot.activation_coverage.capability_level}`,
    `Passive coverage: ${snapshot.activation_coverage.capture_percent ?? 'insufficient data'}${snapshot.activation_coverage.capture_percent == null ? '' : '%'}; outcome closure=${snapshot.activation_coverage.closure_percent ?? 'insufficient data'}${snapshot.activation_coverage.closure_percent == null ? '' : '%'}; intervention follow-through=${snapshot.activation_coverage.effectiveness_percent ?? 'insufficient data'}${snapshot.activation_coverage.effectiveness_percent == null ? '' : '%'}`,
    `Agent disagreements: open=${snapshot.arbitrations.open_count} review_required=${snapshot.arbitrations.review_required_count}`,
    `Latest arbitration: ${arbitrationSummary}`,
    `Risky actions waiting for proof: ${snapshot.proof_waiting}`,
    `Failed/stale outcomes: ${snapshot.failed_stale_outcomes}`,
    `Backpressure/capacity status: ${snapshot.backpressure_status}${snapshot.capacity_next_action ? ` - ${snapshot.capacity_next_action}` : ''}`,
    `Degraded hooks: ${degraded}`,
    snapshot.client_update && (snapshot.client_update.update_available === true || snapshot.client_update.version_status === 'unknown' || snapshot.client_update.notification_state === 'unknown' || snapshot.client_update.notification === 'version_unknown')
      ? `Marrow client update: ${displayText(snapshot.client_update.notification_state === 'security_required' ? 'security_required' : snapshot.client_update.notification_state === 'recommended' ? 'recommended' : snapshot.client_update.version_status === 'unknown' || snapshot.client_update.notification_state === 'unknown' || snapshot.client_update.notification === 'version_unknown' ? 'version_unknown' : snapshot.client_update.priority || 'recommended', 32)}; installed=${displayText(snapshot.client_update.installed_version || snapshot.client_update.current_version || 'unknown', 32)}; latest=${displayText(snapshot.client_update.latest_version || 'unknown', 32)}; operator approval required`
      : 'Marrow client update: current or unavailable',
    `Deploy/publish/merge gates: deploy=${snapshot.gates.deploy} publish=${snapshot.gates.publish} merge=${snapshot.gates.merge}`,
    '',
    'Live agent roster:',
    agents,
    '',
    'Recent decisions:',
    recent,
    '',
    'Press Enter to inspect agent when run in an interactive terminal.',
    'Copy exact fix command:',
    fixes,
    snapshot.source_errors.length ? ['', 'Partial data:', ...snapshot.source_errors.map((error) => `  - ${error}`)].join('\n') : '',
  ].filter(Boolean).join('\n');
}

// Governed commands never name an invented agent id. MARROW_AGENT_ID, when set, is a registered
// agent; otherwise Marrow resolves the key's bound agent or the plan seat.
const GENERIC_GOVERNED_COMMAND = 'MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install run --profile production --policy warn -- <harness-command>';

function localSupportedHarnesses() {
  const harnesses = [
    { display_name: 'OpenAI Codex', client_label: 'codex', category: 'agent_harness', support_level: 'governed_runner', install_command: 'MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install run -- codex' },
    { display_name: 'Claude Code', client_label: 'claude-code', category: 'agent_harness', support_level: 'native_mcp_or_sdk', install_command: `MARROW_API_KEY=mrw_live_xxx ${MCP_SETUP_COMMAND}` },
    { display_name: 'Cursor', client_label: 'cursor', category: 'ide_agent', support_level: 'native_mcp_or_sdk', install_command: `MARROW_API_KEY=mrw_live_xxx ${MCP_SETUP_COMMAND}` },
    { display_name: 'Cursor Composer', client_label: 'composer', category: 'ide_agent', support_level: 'native_mcp_or_sdk', install_command: `MARROW_API_KEY=mrw_live_xxx ${MCP_SETUP_COMMAND}` },
    { display_name: 'Windsurf', client_label: 'windsurf', category: 'ide_agent', support_level: 'native_mcp_or_sdk', install_command: `MARROW_API_KEY=mrw_live_xxx ${MCP_SETUP_COMMAND}` },
    { display_name: 'Cline', client_label: 'cline', category: 'ide_agent', support_level: 'native_mcp_or_sdk', install_command: `MARROW_API_KEY=mrw_live_xxx ${MCP_SETUP_COMMAND}` },
    { display_name: 'OpenCode', client_label: 'opencode', category: 'agent_harness', support_level: 'governed_runner', install_command: 'MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install run -- opencode' },
    { display_name: 'Hermes Agent', client_label: 'hermes', category: 'agent_harness', support_level: 'first_class_addon', install_command: 'MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install hermes' },
    { display_name: 'OpenClaw', client_label: 'openclaw', category: 'agent_harness', support_level: 'first_class_addon', install_command: 'MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install openclaw' },
    { display_name: 'Gemini CLI', client_label: 'gemini', category: 'model_cli', support_level: 'governed_runner', install_command: GENERIC_GOVERNED_COMMAND },
    { display_name: 'Grok CLI', client_label: 'grok', category: 'model_cli', support_level: 'governed_runner', install_command: GENERIC_GOVERNED_COMMAND },
    { display_name: 'DeepSeek', client_label: 'deepseek', category: 'model_cli', support_level: 'governed_runner', install_command: GENERIC_GOVERNED_COMMAND },
    { display_name: 'Qwen', client_label: 'qwen', category: 'model_cli', support_level: 'governed_runner', install_command: GENERIC_GOVERNED_COMMAND },
    { display_name: 'Kimi', client_label: 'kimi', category: 'model_cli', support_level: 'governed_runner', install_command: GENERIC_GOVERNED_COMMAND },
    { display_name: 'MiniMax', client_label: 'minimax', category: 'model_cli', support_level: 'governed_runner', install_command: GENERIC_GOVERNED_COMMAND },
    { display_name: 'GLM', client_label: 'glm', category: 'model_cli', support_level: 'governed_runner', install_command: GENERIC_GOVERNED_COMMAND },
    { display_name: 'MCP-compatible clients', client_label: 'mcp', category: 'mcp_client', support_level: 'native_mcp_or_sdk', install_command: `MARROW_API_KEY=mrw_live_xxx ${MCP_SETUP_COMMAND}` },
    { display_name: 'CI scripts and deploy runners', client_label: 'ci', category: 'ci_runner', support_level: 'governed_runner', install_command: 'MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install run --profile production --policy enforce -- <ci-or-deploy-command>' },
    { display_name: 'Custom shell/API harness', client_label: 'custom', category: 'custom_runner', support_level: 'event_contract', install_command: 'POST /v1/agent/integrations/events with harness, event_type, agent_id, and action' },
  ];
  return harnesses.map((harness) => {
    const capability = HARNESS_CAPABILITY_REGISTRY.find((entry) => entry.client === harness.client_label)
      || HARNESS_CAPABILITY_REGISTRY.find((entry) => entry.client === 'custom');
    return { ...harness, capability_level: capability.capability_level };
  });
}

function integrationCoverageMatrix() {
  return HARNESS_CAPABILITY_REGISTRY.map((entry) => {
    const native = entry.capability_level === 'native_hooks';
    const wrapper = entry.capability_level === 'governed_wrapper';
    const routed = entry.capability_level === 'mcp';
    const sdk = entry.capability_level === 'sdk_passive_runtime';
    return {
      harness: entry.client,
      capability_level: entry.capability_level,
      install_surface: entry.install_surface,
      prompt_injection: native
        ? 'automatic_native_hook'
        : wrapper
          ? 'automatic_in_governed_runner'
          : sdk
            ? 'automatic_in_sdk_runtime'
            : routed
              ? 'mcp_routed'
              : 'adapter_required',
      pre_action: native
        ? 'automatic_native_hook'
        : wrapper
          ? 'automatic_in_governed_runner'
          : sdk
            ? 'automatic_in_sdk_runtime'
            : routed
              ? 'mcp_routed'
              : 'adapter_required',
      action_result: native
        ? 'automatic_native_hook'
        : wrapper
          ? 'automatic_in_governed_runner'
          : sdk
            ? 'automatic_in_sdk_runtime'
            : routed
              ? 'mcp_routed'
              : 'adapter_required',
      outcome_closure: wrapper || sdk
        ? 'automatic_when_result_is_known'
        : native
          ? 'correlated_when_determinable'
          : routed
            ? 'mcp_routed'
            : 'adapter_required',
      proof_enforcement: native || wrapper || sdk
        ? 'automatic_for_protected_actions'
        : routed
          ? 'explicit_or_governed_wrapper'
          : 'adapter_required',
      automatic_repair: native || routed || sdk || wrapper ? 'installer_managed_config_only' : 'adapter_owned',
      cached_brief: native || routed ? 'mcp_local_last_known' : wrapper || sdk ? 'server_cache_only' : 'adapter_owned',
      restart_survival: native || routed || sdk || wrapper ? 'installer_managed_credentials_and_hooks' : 'adapter_owned',
      evidence_adapter: native
        ? 'tool_result_and_explicit_verification'
        : routed
          ? 'mcp_tool_and_explicit_verification'
          : wrapper || sdk
            ? 'command_exit_and_verification_command'
            : 'adapter_owned',
      limitation: native
        ? 'A successful tool exit is not treated as a successful business outcome when the result cannot be proven.'
        : routed
          ? 'Only actions routed through the MCP client are visible automatically.'
          : wrapper
            ? 'Only commands launched through the governed wrapper receive full automatic coverage.'
            : 'The harness must emit the documented lifecycle event contract.',
    };
  });
}

function detectHarnesses(cwd = process.cwd()) {
  const candidates = [
    { name: 'Codex', command: 'codex', detected: fs.existsSync(path.join(cwd, 'AGENTS.md')) || fs.existsSync(path.join(os.homedir(), '.codex')) },
    { name: 'Claude Code', command: 'claude -p', detected: fs.existsSync(path.join(cwd, 'CLAUDE.md')) || fs.existsSync(path.join(os.homedir(), '.claude.json')) },
    { name: 'Cursor', command: 'cursor', detected: fs.existsSync(path.join(cwd, '.cursor')) || fs.existsSync(path.join(os.homedir(), '.cursor')) },
    { name: 'Cursor Composer', command: 'cursor composer', detected: fs.existsSync(path.join(cwd, '.cursor')) || fs.existsSync(path.join(os.homedir(), '.cursor')) },
    { name: 'Windsurf', command: 'windsurf', detected: fs.existsSync(path.join(cwd, '.windsurf')) || fs.existsSync(path.join(os.homedir(), '.windsurf')) },
    { name: 'Cline', command: 'cline', detected: fs.existsSync(path.join(cwd, '.cline')) || fs.existsSync(path.join(cwd, '.vscode')) },
    { name: 'OpenCode', command: 'opencode', detected: fs.existsSync(path.join(cwd, 'opencode.json')) || fs.existsSync(path.join(os.homedir(), '.opencode')) },
    { name: 'Hermes Agent', command: 'hermes', detected: fs.existsSync(path.join(cwd, 'hermes.json')) || fs.existsSync(path.join(cwd, '.hermes')) || fs.existsSync(path.join(os.homedir(), '.hermes')) || fs.existsSync(path.join(os.homedir(), '.hermes-agent')) },
    { name: 'OpenClaw', command: 'openclaw agent', detected: fs.existsSync(path.join(os.homedir(), '.openclaw')) },
    { name: 'Gemini CLI', command: 'gemini', detected: fs.existsSync(path.join(cwd, '.gemini')) || fs.existsSync(path.join(os.homedir(), '.gemini')) },
    { name: 'Grok CLI', command: 'grok', detected: fs.existsSync(path.join(cwd, '.grok')) || fs.existsSync(path.join(os.homedir(), '.grok')) },
    { name: 'DeepSeek', command: 'deepseek', detected: fs.existsSync(path.join(cwd, '.deepseek')) || fs.existsSync(path.join(os.homedir(), '.deepseek')) },
    { name: 'Qwen', command: 'qwen', detected: fs.existsSync(path.join(cwd, '.qwen')) || fs.existsSync(path.join(os.homedir(), '.qwen')) },
    { name: 'Kimi', command: 'kimi', detected: fs.existsSync(path.join(cwd, '.kimi')) || fs.existsSync(path.join(os.homedir(), '.kimi')) },
    { name: 'MiniMax', command: 'minimax', detected: fs.existsSync(path.join(cwd, '.minimax')) || fs.existsSync(path.join(os.homedir(), '.minimax')) },
    { name: 'GLM', command: 'glm', detected: fs.existsSync(path.join(cwd, '.glm')) || fs.existsSync(path.join(os.homedir(), '.glm')) },
    { name: 'MCP-compatible client', command: 'mcp client', detected: fs.existsSync(path.join(cwd, '.mcp.json')) || fs.existsSync(path.join(cwd, 'mcp.json')) },
    { name: 'CI script', command: 'npm test', detected: fs.existsSync(path.join(cwd, 'package.json')) },
    { name: 'Custom command', command: '<your-agent-command>', detected: true },
  ];
  return candidates;
}

function localIntegrationManifest(name) {
  const key = String(name || '').toLowerCase().replace(/\s+/g, '-');
  if (key === 'hermes' || key === 'hermes-agent') {
    return {
      integration: 'hermes-agent',
      title: 'Marrow + Hermes Agent',
      client_label: 'hermes',
      command: 'hermes',
      install_command: 'MARROW_API_KEY=mrw_live_xxx npx -y @getmarrow/install@latest update',
      governed_command: 'MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install run --profile production --policy enforce -- hermes',
      agent_identity: 'Leave MARROW_AGENT_ID unset: Marrow uses the API key\'s bound agent or the Free plan seat. On paid plans, register the agent with POST /v1/agents or bind the key to exactly one agent before setting MARROW_AGENT_ID.',
      capture_points: [
        '/goal -> Marrow completion contract',
        'verification evidence -> Marrow proof pack',
        '/learn -> outcome-ranked fleet lesson',
        '/journey -> governance timeline',
        'background subagents -> agent_id + source_meta.client=hermes',
      ],
      exact_next_action: 'Run the one-line update: it adds the pinned Marrow MCP server to ~/.hermes/config.yaml and runs the self-test. Restart Hermes, then call marrow_agent_runtime before deploy, merge, publish, migration, credential, or customer-facing work.',
    };
  }
  if (key === 'openclaw' || key === 'open-claw') {
    return {
      integration: 'openclaw',
      title: 'Marrow + OpenClaw',
      client_label: 'openclaw',
      command: 'openclaw agent',
      install_command: 'MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install openclaw',
      governed_command: 'MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install run --profile production --policy enforce -- openclaw agent',
      capture_points: [
        'agent sessions -> workflow sessions',
        'handoff/result files -> proof packs',
        'timeouts/silent quits -> failed or stale outcomes',
        'release supervisor results -> deploy proof',
        'watchdog checkpoints -> fleet handoff lessons',
      ],
      exact_next_action: 'Run the OpenClaw add-on, then wrap release and handoff commands with the Marrow governed runner.',
    };
  }
  return null;
}

async function integrationManifest(options, name) {
  const local = localIntegrationManifest(name);
  if (!local) throw new Error(`Unsupported integration: ${name}`);
  if (!options.apiKey) return { source: 'local', manifest: local };
  const route = name === 'openclaw' ? '/v1/agent/integrations/openclaw' : '/v1/agent/integrations/hermes';
  try {
    const remote = await requestJson(options, 'GET', route);
    return { source: 'api', manifest: remote };
  } catch (error) {
    return { source: 'local', manifest: { ...local, api_warning: error instanceof Error ? error.message : String(error) } };
  }
}

function renderIntegrationPanel(name, manifest, source = 'local', detectedHarnesses = detectHarnesses()) {
  const title = manifest.title || (manifest.integration === 'openclaw' ? 'Marrow + OpenClaw' : 'Marrow + Hermes Agent');
  const capturePoints = Array.isArray(manifest.capture_points)
    ? manifest.capture_points.map((point) => {
      if (typeof point === 'string') return point;
      return `${point.harness_surface || point.hermes_surface || 'harness event'} -> ${point.marrow_mapping || 'Marrow event'}`;
    })
    : [];
  const installCommands = Array.isArray(manifest.install_commands)
    ? manifest.install_commands
    : [manifest.install_command, manifest.governed_command].filter(Boolean);
  const detected = detectedHarnesses.find((harness) => harness.name.toLowerCase().includes(name === 'openclaw' ? 'openclaw' : 'hermes'))?.detected;
  const lines = [
    title,
    '',
    `Status: ${manifest.status || 'supported'} (${source})`,
    `Detected locally: ${detected ? 'yes' : 'not yet'}`,
    `Client label: ${manifest.client_label}`,
    '',
    'What Marrow captures:',
    ...capturePoints.map((point) => `  - ${displayText(point, 110)}`),
    '',
    'Install / run:',
    ...installCommands.map((command) => `  ${displayText(command, 140)}`),
    '',
    'Why this matters:',
    `  ${displayText(manifest.marrow_positioning || 'Keep the harness. Add Marrow governance, proof packs, outcomes, and buyer-grade fleet value.', 140)}`,
    '',
    `Next: ${displayText(manifest.exact_next_action, 140)}`,
  ];
  if (manifest.api_warning) lines.push('', `API warning: ${displayText(manifest.api_warning, 120)}`);
  return lines.join('\n');
}

async function integrationOnly(parsed, name) {
  const result = await integrationManifest(parsed.options, name);
  const panel = renderIntegrationPanel(name, result.manifest, result.source);
  if (parsed.options.json) {
    return {
      ok: true,
      source: result.source,
      integration: result.manifest,
      panel,
    };
  }
  process.stdout.write(`${panel}\n`);
  return { ok: true, source: result.source, integration: result.manifest };
}

async function integrationsOnly(parsed) {
  const local = {
    integration_registry_version: 'local.automatic-control-v3',
    first_class_addons: ['hermes', 'openclaw'].map((name) => localIntegrationManifest(name)),
    supported_harnesses: localSupportedHarnesses(),
    integration_coverage: integrationCoverageMatrix(),
    exact_next_action: 'Pick the harness your team already uses. Use the install_command shown here, or send compact events to /v1/agent/integrations/events.',
  };
  let registry = local;
  let source = 'local';
  if (parsed.options.apiKey) {
    try {
      const remote = await requestJson(parsed.options, 'GET', '/v1/agent/integrations');
      registry = {
        ...local,
        ...remote,
        integration_coverage: local.integration_coverage,
      };
      source = 'api';
    } catch (error) {
      registry = { ...local, api_warning: error instanceof Error ? error.message : String(error) };
    }
  }
  if (parsed.options.json) return { ok: true, source, registry };
  const harnesses = Array.isArray(registry.supported_harnesses) ? registry.supported_harnesses : [];
  const coverage = Array.isArray(registry.integration_coverage) ? registry.integration_coverage : [];
  process.stdout.write([
    'Marrow Harness Integrations',
    '',
    `Source: ${source}`,
    'Supported harnesses and model CLIs:',
    ...harnesses.map((harness) => `  - ${displayText(harness.display_name || harness.client_label || harness.integration || harness.title, 40)} [${displayText(harness.support_level || 'supported', 24)}]  ${displayText(harness.install_command || harness.install_commands?.[0] || '', 120)}`),
    '',
    'Automatic lifecycle coverage:',
    ...coverage.map((entry) => `  - ${displayText(entry.harness, 24)}: pre=${entry.pre_action}; result=${entry.action_result}; closure=${entry.outcome_closure}; proof=${entry.proof_enforcement}; repair=${entry.automatic_repair}`),
    '',
    'First-class add-on guides: hermes, openclaw',
    `Next: ${displayText(registry.exact_next_action, 140)}`,
    registry.api_warning ? `API warning: ${displayText(registry.api_warning, 120)}` : '',
  ].filter(Boolean).join('\n') + '\n');
  return { ok: true, source, registry };
}

function governPanel(options) {
  const rows = detectHarnesses();
  const project = detectProjectSignals();
  const agentId = displayText(options.agentId, 80) || 'resolved by API key';
  const profile = displayText(options.profile, 80);
  const policy = displayText(options.policy, 24);
  const lines = [
    'Marrow Governed Runner',
    '',
    `Agent:  ${agentId}`,
    `Profile: ${profile}`,
    `Policy:  ${policy}`,
    '',
    'Choose where your agent runs. Marrow governs the action before it executes.',
    '',
    'Detected harnesses:',
    ...rows.map((row, index) => `  ${index + 1}. ${row.detected ? '[x]' : '[ ]'} ${row.name}  ${row.command}`),
    '',
    'Detected project signals:',
    `  project=${project.name} type=${project.type}`,
    `  signals=${project.signals.length ? project.signals.join(', ') : 'none'}`,
    options.apiKey
      ? '  recommendation: run interactive TUI or use --json status for live mode recommendation.'
      : '  recommendation: export MARROW_API_KEY to get an account/fleet-backed mode recommendation.',
    '',
    'Recommended first commands:',
    `  npx @getmarrow/install run ${options.agentId ? `--agent ${shellQuoteDisplay(options.agentId)} ` : ''}--profile production --policy enforce -- codex`,
    `  npx @getmarrow/install run --type deploy --policy enforce -- wrangler deploy`,
    `  npx @getmarrow/install gate "deploy production worker after tests pass"`,
    '',
    'Protected by default: deploy, merge, publish, migrations, secrets, keys, production actions.',
  ];
  return lines.join('\n');
}

function governModes() {
  return [
    {
      id: 'passive',
      label: 'Passive setup',
      description: 'Install passive MCP/SDK/agent instructions, then run the installer self-test.',
      policy: 'warn',
    },
    {
      id: 'warn',
      label: 'Governed pilot',
      description: 'Wrap commands with Marrow, show gates, but do not block execution.',
      policy: 'warn',
    },
    {
      id: 'enforce',
      label: 'Governed enforce',
      description: 'Wrap risky commands and fail closed when Marrow blocks or requires owner approval.',
      policy: 'enforce',
    },
  ];
}

function selectedGovernanceMode(mode) {
  if (!mode) return 'pilot';
  if (mode.id === 'passive') return 'passive';
  if (mode.id === 'enforce') return 'enforce';
  return 'pilot';
}

function commandForSelection(state, options) {
  const harness = state.harnesses[state.harnessIndex] || state.harnesses[0];
  const mode = state.modes[state.modeIndex] || state.modes[0];
  if (mode.id === 'passive') {
    return 'MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install --yes';
  }
  const command = harness.command === '<your-agent-command>' ? '<your-command>' : harness.command;
  const renderedCommand = command.split(/\s+/).filter(Boolean).map(shellQuote).join(' ');
  return `MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install run ${options.agentId ? `--agent ${shellQuoteDisplay(options.agentId)} ` : ''}--profile ${shellQuoteDisplay(options.profile)} --policy ${shellQuoteDisplay(mode.policy)} -- ${renderedCommand}`;
}

function buildGovernState(options, cwd = process.cwd()) {
  const harnesses = detectHarnesses(cwd);
  const firstDetected = harnesses.findIndex((harness) => harness.detected);
  const project = detectProjectSignals(cwd);
  return {
    cursor: 0,
    harnesses,
    harnessIndex: firstDetected >= 0 ? firstDetected : 0,
    modes: governModes(),
    modeIndex: 0,
    project,
    recommendation: null,
    status: '',
    lastResult: '',
    confirmingSetup: false,
    running: false,
  };
}

function renderOptionBox(row, active) {
  const contentWidth = 86;
  const borderWidth = contentWidth + 2;
  const marker = active ? '>' : ' ';
  const borderChar = active ? '=' : '-';
  const labelText = `[${displayText(row.label, 36)}]`;
  const labelVisible = labelText.padEnd(38, ' ');
  const label = `\x1b[47m\x1b[30m${labelText}\x1b[0m${' '.repeat(Math.max(0, 38 - labelText.length))}`;
  const value = displayText(row.value, contentWidth - 39);
  const firstLineVisible = `${labelVisible}${value}`;
  const firstLine = `${label}${value}${' '.repeat(Math.max(0, contentWidth - firstLineVisible.length))}`;
  const hint = displayText(row.hint, contentWidth);
  return [
    `${marker} +${borderChar.repeat(borderWidth)}+`,
    `${marker} | ${firstLine} |`,
    `${marker} | ${hint.padEnd(contentWidth, ' ')} |`,
    `${marker} +${borderChar.repeat(borderWidth)}+`,
  ];
}

function renderGovernTui(state, options) {
  const harness = state.harnesses[state.harnessIndex] || state.harnesses[0];
  const mode = state.modes[state.modeIndex] || state.modes[0];
  const rows = [
    {
      label: 'Harness',
      value: `${harness.name}${harness.detected ? ' detected' : ' not detected'} (${harness.command})`,
      hint: 'Left/right changes the harness.',
    },
    {
      label: 'Mode',
      value: state.recommendation?.recommended_mode
        ? `${mode.label}  recommended: ${state.recommendation.recommended_mode}`
        : mode.label,
      hint: state.recommendation?.reasons?.length
        ? state.recommendation.reasons.slice(0, 2).join('; ')
        : mode.description,
    },
    {
      label: 'Run passive setup + self-test',
      value: state.confirmingSetup ? 'Press Enter again to run installer --yes' : 'writes local config after confirmation',
      hint: 'Uses the existing installer path and self-test.',
    },
    {
      label: 'Check Marrow status',
      value: options.apiKey ? 'ready' : 'needs MARROW_API_KEY',
      hint: 'Calls GET /v1/agent/status.',
    },
    {
      label: 'Test before-action gate',
      value: options.apiKey ? 'ready' : 'needs MARROW_API_KEY',
      hint: 'Calls POST /v1/agent/runtime for a deploy-like action.',
    },
    {
      label: 'Show command and exit',
      value: 'Print selected command',
      hint: 'Prints the command for this selection.',
    },
    {
      label: 'Exit',
      value: 'Return to shell',
      hint: 'Press Enter, q, Esc, or Ctrl+C to leave setup.',
    },
  ];
  const lines = [
    '\x1b[2J\x1b[H',
    '+------------------------------------------------------------+',
    '| Marrow Governed Setup                                      |',
    '| Passive agent governance for day-one use                   |',
    '+------------------------------------------------------------+',
    '',
    `Agent: ${displayText(options.agentId, 36) || 'resolved by API key'}   Profile: ${displayText(options.profile, 24)}   API key: ${options.apiKey ? 'present' : 'missing'}`,
    `Project: ${displayText(state.project?.name || 'workspace', 36)}   Signals: ${displayText((state.project?.signals || []).slice(0, 4).join(', ') || 'none', 52)}`,
    '',
    'Navigation: Up/Down move   Left/Right change   Enter select',
    'Exit: q, Esc, or Ctrl+C',
    '',
  ];
  rows.forEach((row, index) => {
    lines.push(...renderOptionBox(row, index === state.cursor), '');
  });
  lines.push('Recommended command:');
  lines.push(`  ${commandForSelection(state, options)}`);
  if (state.status) {
    lines.push('');
    lines.push(`Status: ${displayText(state.status, 120)}`);
  }
  if (state.lastResult) {
    lines.push('');
    lines.push(displayText(state.lastResult, 500));
  }
  if (state.recommendation?.recommended_mode) {
    lines.push('');
    lines.push(`Recommended mode: ${state.recommendation.recommended_mode}  confidence=${Math.round((state.recommendation.confidence || 0) * 100)}%`);
    for (const reason of (state.recommendation.reasons || []).slice(0, 5)) lines.push(`- ${displayText(reason, 110)}`);
    lines.push('Apply by selecting Mode or printing the command; Marrow does not auto-switch modes silently.');
  }
  return lines.join('\n');
}

function buildFleetState(snapshot) {
  return {
    cursor: 0,
    agentIndex: 0,
    snapshot,
    status: '',
    lastResult: '',
  };
}

function renderFleetTui(state) {
  const snapshot = state.snapshot;
  const selectedAgent = snapshot.agents[state.agentIndex] || { id: 'no agent returned', status: 'unknown', role: '' };
  const degraded = snapshot.degraded_hooks.length ? snapshot.degraded_hooks.join(', ') : 'none';
  const activation = snapshot.activation_coverage;
  const coverageValue = activation.available
    ? `${activation.state}; capture=${activation.capture_percent ?? 'n/a'}%; closure=${activation.closure_percent ?? 'n/a'}%`
    : `${activation.state}; insufficient data`;
  const gateSummary = `deploy=${snapshot.gates.deploy} publish=${snapshot.gates.publish} merge=${snapshot.gates.merge}`;
  const fixCommand = snapshot.fix_commands[0] || 'npx @getmarrow/install doctor';
  const recent = snapshot.recent_decisions[0] || 'none reported yet';
  const arbitration = snapshot.arbitrations.receipts[0];
  const rows = [
    {
      label: 'Live agents',
      value: `${snapshot.live_agents ?? 'unknown'} total; selected ${selectedAgent.id}`,
      hint: 'Left/right changes the selected agent. Enter shows agent detail.',
    },
    {
      label: 'Active workflows',
      value: String(snapshot.active_workflows ?? 'unknown'),
      hint: 'Current account-scoped workflow pressure from Marrow.',
    },
    {
      label: 'Agent disagreements',
      value: `open=${snapshot.arbitrations.open_count} review_required=${snapshot.arbitrations.review_required_count}`,
      hint: arbitration
        ? `${arbitration.resolution}: ${arbitration.exact_next_action || arbitration.conflict_type}`
        : 'No conflicting fleet proposals reported.',
    },
    {
      label: 'Risky actions waiting for proof',
      value: String(snapshot.proof_waiting),
      hint: 'Deploy, publish, merge, migration, or sensitive actions waiting on proof packs.',
    },
    {
      label: 'Failed/stale outcomes',
      value: String(snapshot.failed_stale_outcomes),
      hint: 'Outcome closure debt that can weaken fleet learning.',
    },
    {
      label: 'Backpressure / capacity',
      value: snapshot.backpressure_status,
      hint: snapshot.capacity_next_action || 'Capacity contract loaded when available.',
    },
    {
      label: 'Recent decisions',
      value: recent,
      hint: 'Latest fleet decision signal returned by Marrow.',
    },
    {
      label: 'Passive activation / coverage',
      value: coverageValue,
      hint: activation.drift
        ? `Configuration drift detected. ${activation.exact_fix || fixCommand}`
        : degraded === 'none'
        ? `Capability=${activation.capability_level}; no missing hooks reported.`
        : `Degraded hooks: ${degraded}. Repair before trusting passive coverage.`,
    },
    {
      label: 'Deploy/publish/merge gates',
      value: gateSummary,
      hint: 'High-risk release surfaces should remain gated.',
    },
    {
      label: 'Inspect agent',
      value: selectedAgent.id,
      hint: 'Press Enter to inspect agent.',
    },
    {
      label: 'Copy exact fix command',
      value: fixCommand,
      hint: 'Press Enter to print this command back to the shell.',
    },
    {
      label: 'Exit',
      value: 'Return to shell',
      hint: 'Press Enter, q, Esc, or Ctrl+C.',
    },
  ];
  const lines = [
    '\x1b[2J\x1b[H',
    '+------------------------------------------------------------+',
    '| Marrow Fleet Operator                                      |',
    '| Live fleet health, proof debt, gates, and exact fixes       |',
    '+------------------------------------------------------------+',
    '',
    `Agent: ${displayText(snapshot.agent_id, 36) || 'resolved by API key'}   Snapshot: ${displayText(snapshot.generated_at, 36)}`,
    `API: ${displayText(snapshot.base_url, 60)}`,
    '',
    'Navigation: Up/Down move   Left/Right select agent   Enter inspect/print',
    'Exit: q, Esc, or Ctrl+C',
    '',
  ];
  rows.forEach((row, index) => {
    lines.push(...renderOptionBox(row, index === state.cursor), '');
  });
  if (state.status) {
    lines.push(`Status: ${displayText(state.status, 120)}`);
  }
  if (state.lastResult) {
    lines.push('');
    lines.push(displayText(state.lastResult, 700));
  }
  if (snapshot.source_errors.length) {
    lines.push('');
    lines.push('Partial data:');
    for (const error of snapshot.source_errors.slice(0, 4)) lines.push(`- ${displayText(error, 120)}`);
  }
  return lines.join('\n');
}

function canUseInteractive(options, input = process.stdin, output = process.stdout) {
  if (options.interactive === false) return false;
  if (options.interactive === true) return Boolean(input.isTTY && output.isTTY);
  return Boolean(input.isTTY && output.isTTY);
}

function waitForAnyKey(input = process.stdin) {
  return new Promise((resolve) => {
    const onKey = () => {
      input.off('keypress', onKey);
      resolve();
    };
    input.on('keypress', onKey);
  });
}

async function runSetupSelfTest(options, input, output) {
  if (!options.apiKey) {
    return 'MARROW_API_KEY is missing. Create a key in your Marrow account, export it, then rerun setup.';
  }
  const binPath = path.resolve(__dirname, '..', 'bin', 'marrow-install.js');
  output.write('\x1b[2J\x1b[HRunning Marrow passive setup and self-test...\n\n');
  if (input.setRawMode) input.setRawMode(false);
  const result = await runChild([process.execPath, binPath, '--yes'], {
    ...process.env,
    MARROW_API_KEY: options.apiKey,
    MARROW_BASE_URL: options.baseUrl,
    MARROW_FLEET_AGENT_ID: options.agentId,
  });
  output.write('\nPress any key to return to Marrow Governed Setup.');
  if (input.setRawMode) input.setRawMode(true);
  await waitForAnyKey(input);
  return result.exitCode === 0
    ? 'Marrow passive setup completed. Self-test output above is the source of truth.'
    : `Marrow passive setup exited with code ${result.exitCode}. Review the output above.`;
}

async function runStatusCheck(options) {
  if (!options.apiKey) return 'MARROW_API_KEY is missing. Status check skipped.';
  const status = await statusOnly({ options });
  const coverage = status.capture_coverage || {};
  const closure = status.auto_outcome_closure || {};
  const active = status.enabled ?? status.active ?? true;
  const missed = Array.isArray(status.missed_hooks) && status.missed_hooks.length
    ? ` missed hooks: ${status.missed_hooks.join(', ')}`
    : '';
  return `Marrow status: ${active ? 'active' : 'inactive'}; coverage=${coverage.status || coverage.summary || 'reported'}; outcomes=${closure.status || closure.summary || 'reported'}${missed}`;
}

async function runGateCheck(options) {
  if (!options.apiKey) return 'MARROW_API_KEY is missing. Gate check skipped.';
  const runtime = await preflightRuntime(options, 'deploy production worker after tests pass', 'deploy', 'wrangler deploy');
  const decision = runnerGateDecision(runtime);
  const proof = decision.proofPack?.required
    ? ` Proof required${decision.proofPack.missing?.length ? `; missing ${decision.proofPack.missing.join(', ')}` : ''}.`
    : '';
  return `Gate: ${decision.decision}${decision.required ? ' required' : ''}.${decision.exactNextAction ? ` Next: ${decision.exactNextAction}` : ''}${proof}`;
}

async function runGovernInteractive(options, input = process.stdin, output = process.stdout) {
  if (!canUseInteractive(options, input, output)) {
    output.write(`${governPanel(options)}\n`);
    return;
  }

  const state = buildGovernState(options);
  try {
    const recommendation = await recommendGovernanceMode(options, state.project);
    if (recommendation?.recommended_mode) {
      state.recommendation = recommendation;
      const recommendationModeId = recommendation.recommended_mode === 'pilot' ? 'warn' : recommendation.recommended_mode;
      const modeIndex = state.modes.findIndex((mode) => mode.id === recommendationModeId);
      if (modeIndex >= 0) state.modeIndex = modeIndex;
      state.status = 'Governance recommendation loaded. Review before applying.';
    } else if (recommendation?.skipped) {
      state.status = `${recommendation.reason}. ${recommendation.exact_fix}`;
    }
  } catch (error) {
    state.status = `Recommendation unavailable: ${error instanceof Error ? error.message : String(error)}`;
  }
  readline.emitKeypressEvents(input);
  input.setRawMode(true);
  output.write('\x1b[?25l');

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (input.setRawMode) input.setRawMode(false);
    output.write('\x1b[?25h');
  };

  const render = () => {
    output.write(renderGovernTui(state, options));
  };

  render();
  let keyHandler;
  try {
    await new Promise((resolve) => {
      keyHandler = async (str, key = {}) => {
        if (state.running) return;
        if (key.ctrl && key.name === 'c') {
          cleanup();
          resolve();
          return;
        }
        if (key.name === 'q' || key.name === 'escape' || str === 'q') {
          cleanup();
          resolve();
          return;
        }
        if (key.name === 'up') {
          state.cursor = (state.cursor + GOVERN_TUI_ROW_COUNT - 1) % GOVERN_TUI_ROW_COUNT;
          state.confirmingSetup = false;
          render();
        } else if (key.name === 'down') {
          state.cursor = (state.cursor + 1) % GOVERN_TUI_ROW_COUNT;
          state.confirmingSetup = false;
          render();
        } else if (key.name === 'left' || key.name === 'right') {
          const direction = key.name === 'right' ? 1 : -1;
          if (state.cursor === 0) state.harnessIndex = (state.harnessIndex + direction + state.harnesses.length) % state.harnesses.length;
          if (state.cursor === 1) state.modeIndex = (state.modeIndex + direction + state.modes.length) % state.modes.length;
          state.confirmingSetup = false;
          render();
        } else if (key.name === 'return') {
          state.running = true;
          try {
            if (state.cursor === 0) {
              state.harnessIndex = (state.harnessIndex + 1) % state.harnesses.length;
              state.status = 'Harness selected.';
              state.confirmingSetup = false;
            } else if (state.cursor === 1) {
              state.modeIndex = (state.modeIndex + 1) % state.modes.length;
              state.status = 'Mode selected.';
              state.confirmingSetup = false;
            } else if (state.cursor === 2) {
              if (!state.confirmingSetup) {
                state.confirmingSetup = true;
                state.status = 'Confirm passive setup.';
              } else {
                state.lastResult = await runSetupSelfTest(options, input, output);
                state.status = 'Passive setup attempted.';
                state.confirmingSetup = false;
              }
            } else if (state.cursor === 3) {
              state.status = 'Checking Marrow status...';
              render();
              state.lastResult = await runStatusCheck(options);
              state.status = 'Status check complete.';
              state.confirmingSetup = false;
            } else if (state.cursor === 4) {
              state.status = 'Testing before-action gate...';
              render();
              state.lastResult = await runGateCheck(options);
              state.status = 'Gate check complete.';
              state.confirmingSetup = false;
            } else if (state.cursor === 5) {
              await recordGovernanceModeSelection(options, state).catch(() => null);
              cleanup();
              output.write(`\n${commandForSelection(state, options)}\n`);
              resolve();
              return;
            } else if (state.cursor === 6) {
              cleanup();
              resolve();
              return;
            }
          } catch (error) {
            state.lastResult = `Error: ${error instanceof Error ? error.message : String(error)}`;
            state.status = 'Action failed.';
            state.confirmingSetup = false;
          } finally {
            state.running = false;
            if (!cleaned) render();
          }
        }
      };
      input.on('keypress', keyHandler);
    });
  } finally {
    if (keyHandler) input.off('keypress', keyHandler);
    if (input.pause) input.pause();
    cleanup();
    output.write('\n');
  }
}

async function runFleetInteractive(options, input = process.stdin, output = process.stdout) {
  const snapshot = await fleetSnapshot(options);
  if (options.json) return snapshot;
  if (!canUseInteractive(options, input, output)) {
    output.write(`${fleetPanel(snapshot)}\n`);
    return snapshot;
  }

  const state = buildFleetState(snapshot);
  readline.emitKeypressEvents(input);
  input.setRawMode(true);
  output.write('\x1b[?25l');

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (input.setRawMode) input.setRawMode(false);
    output.write('\x1b[?25h');
  };
  const render = () => output.write(renderFleetTui(state));

  render();
  let keyHandler;
  try {
    await new Promise((resolve) => {
      keyHandler = (str, key = {}) => {
        if (key.ctrl && key.name === 'c') {
          cleanup();
          resolve();
          return;
        }
        if (key.name === 'q' || key.name === 'escape' || str === 'q') {
          cleanup();
          resolve();
          return;
        }
        if (key.name === 'up') {
          state.cursor = (state.cursor + FLEET_TUI_ROW_COUNT - 1) % FLEET_TUI_ROW_COUNT;
          render();
        } else if (key.name === 'down') {
          state.cursor = (state.cursor + 1) % FLEET_TUI_ROW_COUNT;
          render();
        } else if ((key.name === 'left' || key.name === 'right') && state.snapshot.agents.length) {
          const direction = key.name === 'right' ? 1 : -1;
          state.agentIndex = (state.agentIndex + direction + state.snapshot.agents.length) % state.snapshot.agents.length;
          state.status = 'Agent selection changed.';
          render();
        } else if (key.name === 'return') {
          if (state.cursor === 10) {
            cleanup();
            output.write(`\n${state.snapshot.fix_commands[0] || 'npx @getmarrow/install doctor'}\n`);
            resolve();
            return;
          }
          if (state.cursor === 11) {
            cleanup();
            resolve();
            return;
          }
          const selectedAgent = state.snapshot.agents[state.agentIndex];
          if (state.cursor === 0 || state.cursor === 9) {
            state.lastResult = selectedAgent
              ? `Agent ${selectedAgent.id}: status=${selectedAgent.status}${selectedAgent.role ? ` role=${selectedAgent.role}` : ''}${selectedAgent.last_seen_at ? ` last_seen=${selectedAgent.last_seen_at}` : ''}`
              : 'No live agent roster returned yet. Check API key scope or wait for agents to log activity.';
          } else if (state.cursor === 2) {
            const receipts = state.snapshot.arbitrations.receipts;
            state.lastResult = receipts.length
              ? receipts.map((receipt, index) => `${index + 1}. ${receipt.id}: ${receipt.resolution}${receipt.decision_id ? `; decision=${receipt.decision_id}` : ''}${receipt.selected_proposal_id ? `; selected=${receipt.selected_proposal_id}` : ''}; ${receipt.exact_next_action || receipt.conflict_type}${receipt.owner_approval_required ? ' Needs the account owner\'s approval; an agent cannot approve it.' : ''}`).join('  ')
              : 'No agent disagreements or arbitration receipts returned yet.';
          } else if (state.cursor === 6) {
            state.lastResult = state.snapshot.recent_decisions.length
              ? state.snapshot.recent_decisions.map((decision, index) => `${index + 1}. ${decision}`).join('  ')
              : 'No recent decisions returned yet.';
          } else if (state.cursor === 7) {
            const coverage = state.snapshot.activation_coverage;
            state.lastResult = `Passive activation=${coverage.state}; capability=${coverage.capability_level}; capture=${coverage.capture_percent ?? 'insufficient data'}; closure=${coverage.closure_percent ?? 'insufficient data'}; intervention follow-through=${coverage.effectiveness_percent ?? 'insufficient data'}${coverage.drift ? `. Drift detected. Fix: ${coverage.exact_fix || state.snapshot.fix_commands[0]}` : ''}`;
          } else if (state.cursor === 8) {
            state.lastResult = `Release gates: deploy=${state.snapshot.gates.deploy}, publish=${state.snapshot.gates.publish}, merge=${state.snapshot.gates.merge}.`;
          } else {
            state.lastResult = fleetPanel(state.snapshot).replace(/\n/g, '  ');
          }
          state.status = 'Inspection updated.';
          render();
        }
      };
      input.on('keypress', keyHandler);
    });
  } finally {
    if (keyHandler) input.off('keypress', keyHandler);
    if (input.pause) input.pause();
    cleanup();
    output.write('\n');
  }
  return snapshot;
}

async function runCli(argv) {
  const parsed = parseArgs(argv);
  if (parsed.command === 'help') {
    process.stdout.write(usage());
    return;
  }

  if (parsed.options?.keyFromArg) {
    process.stderr.write('Warning: prefer MARROW_API_KEY instead of --key because command-line args can be visible in process listings.\n');
  }
  if (parsed.options?.ownerApprovedFlagIgnored) {
    process.stderr.write(`Note: --owner-approved no longer does anything. ${OWNER_APPROVAL_NOTICE}\n`);
  }

  let result;
  if (parsed.command === 'run') result = await runGoverned(parsed);
  else if (parsed.command === 'gate') result = await gateOnly(parsed);
  else if (parsed.command === 'proof') result = await proofOnly(parsed);
  else if (parsed.command === 'status') result = await statusOnly(parsed);
  else if (parsed.command === 'permit') result = await permitOnly(parsed);
  else if (parsed.command === 'verify-permit') result = await verifyPermitOnly(parsed);
  else if (parsed.command === 'coverage') result = await coverageOnly(parsed);
  else if (parsed.command === 'sidecar') result = await sidecarOnly(parsed);
  else if (parsed.command === 'controller') result = await controllerOnly(parsed);
  else if (parsed.command === 'govern') {
    await runGovernInteractive(parsed.options);
    return;
  } else if (parsed.command === 'fleet') {
    result = await runFleetInteractive(parsed.options);
  } else if (parsed.command === 'hermes') {
    result = await integrationOnly(parsed, 'hermes');
  } else if (parsed.command === 'openclaw') {
    result = await integrationOnly(parsed, 'openclaw');
  } else if (parsed.command === 'integrations') {
    result = await integrationsOnly(parsed);
  }

  const exitCodeCommands = ['run', 'verify-permit', 'gate', 'permit', 'proof'];
  if (parsed.options?.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (result?.blocked) process.stderr.write(`BLOCKED: ${result.message || 'Marrow blocked this action.'}\n`);
  else if (result?.ok === false && result?.message && exitCodeCommands.includes(parsed.command)) process.stderr.write(`Marrow: ${result.message}\n`);
  else if (parsed.command === 'status') process.stdout.write(`${statusPanel(result)}\n`);
  else if (result?.advisory && result?.message) process.stdout.write(`${result.message}\n`);
  else if (!['run', 'fleet', 'hermes', 'openclaw', 'integrations'].includes(parsed.command)) process.stdout.write('Marrow command completed.\n');

  if (exitCodeCommands.includes(parsed.command) || result?.blocked) {
    process.exitCode = result?.exitCode ?? (result?.ok === false ? 1 : 0);
  }
}

module.exports = {
  parseArgs,
  redact,
  redactedCommand,
  normalizeClientLabel,
  sourceClient,
  sourceMeta,
  headers,
  inferType,
  inferSurfaces,
  isRisky,
  commandForSelection,
  buildGovernState,
  detectProjectSignals,
  defaultProof,
  recommendGovernanceMode,
  recordGovernanceModeSelection,
  gateDecision,
  shouldBlock,
  heldApproval,
  holdNextText,
  resolveHold,
  resumeRecordedHold,
  holdRecordStore,
  runnerHoldKey,
  defaultRunnerSession,
  agentHostDetected,
  agentHostAncestor,
  approvalPromptAvailable,
  withoutCallerApproval,
  governPanel,
  renderGovernTui,
  canUseInteractive,
  runGoverned,
  scopedExecutionEnv,
  permitOnly,
  verifyPermitOnly,
  coverageOnly,
  sidecarOnly,
  requestJson,
  controllerOnly,
  actionBinding,
  gateOnly,
  proofOnly,
  statusOnly,
  statusPanel,
  runStatusCheck,
  runGateCheck,
  runGovernInteractive,
  optionalRequestJson,
  normalizeFleetSnapshot,
  fleetSnapshot,
  fleetPanel,
  buildFleetState,
  renderFleetTui,
  runFleetInteractive,
  localSupportedHarnesses,
  integrationCoverageMatrix,
  localIntegrationManifest,
  renderIntegrationPanel,
  integrationOnly,
  integrationsOnly,
  runCli,
};

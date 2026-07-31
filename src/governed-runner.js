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

const DEFAULT_BASE_URL = 'https://api.getmarrow.ai';
const HIGH_RISK_TERMS = /\b(deploy|prod|production|publish|release|merge|migration|migrate|secret|token|key|cloudflare|wrangler|npm publish|gh pr merge|git push|terraform apply|kubectl apply|delete|destroy|drop)\b/i;
const GOVERN_TUI_ROW_COUNT = 7;
const FLEET_TUI_ROW_COUNT = 12;
function usage() {
  return `Usage:
  npx @getmarrow/install run --agent deploy-agent -- npm test
  npx @getmarrow/install run --agent deploy-agent --type deploy --policy enforce -- wrangler deploy
  npx @getmarrow/install gate "deploy production worker"
  npx @getmarrow/install proof --decision-id <id> --success --summary "smoke passed"
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
  govern    Interactive setup TUI when run in a terminal; text panel in CI/non-TTY
  fleet     Fleet operator TUI for live agents, workflows, gates, proof debt, and exact fixes
  integrations List Marrow-supported harness add-ons
  hermes    Show and verify the Marrow add-on path for Hermes Agent
  openclaw  Show and verify the Marrow add-on path for OpenClaw

Options:
  --agent <id>            Agent identity. Defaults to MARROW_FLEET_AGENT_ID, MARROW_AGENT_ID, or local user
  --session <id>          Session id. Defaults to marrow-run-<timestamp>
  --type <type>           Action type. Inferred from action/command when omitted
  --action <text>         Human-readable action. Defaults to the redacted command
  --profile <name>        Policy profile label, such as dev, staging, or production
  --policy <mode>         enforce, warn, or audit. Default: enforce
  --fail-open             If Marrow is unreachable, run anyway and mark telemetry degraded
  --fail-closed           If Marrow is unreachable, block the command
  --owner-approved <ref>  Owner approval reference for review-required gates
  --permit <token>        Short-lived action permit. Prefer MARROW_ACTION_PERMIT
  --target <text>         Protected target binding, such as repository/environment
  --sidecar-port <port>   Loopback sidecar port. Default: ephemeral
  --proof-file <path>     JSON proof to include on outcome commit
  --client <label>        Harness/client label. Defaults to MARROW_CLIENT, MARROW_HARNESS, or MARROW_AGENT_CLIENT
  --base-url <url>        Marrow API base URL
  --key <key>             Marrow API key. Prefer MARROW_API_KEY
  --json                  Print machine-readable result after completion
  --interactive           Force interactive govern TUI when possible
  --no-interactive        Print govern/fleet panel instead of opening the TUI
`;
}

function nowId(prefix) {
  return `${prefix}-${new Date().toISOString().replace(/[^0-9TZ]/g, '')}-${crypto.randomBytes(4).toString('hex')}`;
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
  if (/\b(deploy|wrangler|cloudflare|production|prod|release)\b/.test(value)) return 'deploy';
  if (/\b(publish|npm publish)\b/.test(value)) return 'publish';
  if (/\b(merge|gh pr merge)\b/.test(value)) return 'merge';
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

  return {
    name: packageJson?.name || path.basename(cwd),
    key: packageJson?.name || path.basename(cwd),
    type: packageJson ? 'node' : fs.existsSync(path.join(cwd, 'pyproject.toml')) ? 'python' : 'workspace',
    frameworks: [...frameworks],
    signals: [...signals],
    package_scripts: packageScripts.slice(0, 30),
    config_files: configFiles.slice(0, 30),
  };
}

function isRisky(text, type) {
  return HIGH_RISK_TERMS.test(`${type || ''} ${text || ''}`);
}

function parseBaseOptions(argv, startIndex = 0) {
  const options = {
    apiKey: process.env.MARROW_API_KEY || process.env.MARROW_KEY || '',
    baseUrl: process.env.MARROW_BASE_URL || DEFAULT_BASE_URL,
    agentId: process.env.MARROW_FLEET_AGENT_ID || process.env.MARROW_AGENT_ID || os.userInfo().username || 'agent',
    sessionId: process.env.MARROW_SESSION_ID || '',
    profile: process.env.MARROW_GOVERN_PROFILE || 'default',
    policy: process.env.MARROW_GOVERN_POLICY || 'enforce',
    failOpen: process.env.MARROW_FAIL_OPEN === 'true',
    failClosed: process.env.MARROW_FAIL_CLOSED === 'true',
    json: false,
    ownerApproval: '',
    proofFile: '',
    type: '',
    action: '',
    client: sourceClient(),
    interactive: null,
    permit: process.env.MARROW_ACTION_PERMIT || '',
    target: process.env.MARROW_ACTION_TARGET || '',
    sidecarPort: process.env.MARROW_SIDECAR_PORT || '0',
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
    } else if (arg === '--owner-approved') options.ownerApproval = argv[++i] || options.ownerApproval;
    else if (arg === '--permit') options.permit = argv[++i] || options.permit;
    else if (arg === '--target') options.target = argv[++i] || options.target;
    else if (arg === '--sidecar-port') options.sidecarPort = argv[++i] || options.sidecarPort;
    else if (arg === '--proof-file') options.proofFile = argv[++i] || options.proofFile;
    else if (arg === '--client' || arg === '--harness') options.client = sourceClient(argv[++i] || options.client);
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
  if (!options.sessionId) options.sessionId = nowId('marrow-run');
  return { options, index: i };
}

function parseArgs(argv) {
  const command = argv[0] || 'help';
  if (command === '--help' || command === '-h' || command === 'help') return { command: 'help' };

  if (command === 'run') {
    const parsed = parseBaseOptions(argv, 1);
    const separator = argv[parsed.index] === '--' ? parsed.index + 1 : parsed.index;
    const childCommand = argv.slice(separator);
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
    const parsed = parseBaseOptions(argv, 1);
    const options = { ...parsed.options, decisionId: '', success: true, summary: '', outcome: '' };
    for (let i = parsed.index; i < argv.length; i += 1) {
      const arg = argv[i];
      if (arg === '--decision-id') options.decisionId = argv[++i] || '';
      else if (arg === '--success') options.success = true;
      else if (arg === '--failure' || arg === '--failed') options.success = false;
      else if (arg === '--summary') options.summary = argv[++i] || '';
      else if (arg === '--outcome') options.outcome = argv[++i] || '';
      else if (arg === '--help' || arg === '-h') return { command: 'help' };
      else throw new Error(`Unknown proof option: ${arg}`);
    }
    if (!options.decisionId) throw new Error('marrow proof requires --decision-id');
    return { command, options };
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
    'X-Marrow-Agent-Id': options.agentId,
    'X-Marrow-Session-Id': options.sessionId,
    'X-Marrow-Client': sourceClient(options.client),
    'X-Marrow-Package': '@getmarrow/install',
    'X-Marrow-Package-Version': INSTALLER_PACKAGE_VERSION,
    'User-Agent': '@getmarrow/install governed-runner',
  };
  return h;
}

function sourceMeta(options, channel, extra = {}) {
  const client = sourceClient(options.client);
  return {
    channel,
    client,
    harness: client,
    runner: '@getmarrow/install',
    agent_id: options.agentId,
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

async function requestJson(options, method, route, body) {
  if (!options.apiKey) throw new Error('MARROW_API_KEY is required. Use --fail-open only for non-production local commands.');
  const response = await fetch(new URL(route, options.baseUrl.replace(/\/$/, '/')), {
    method,
    headers: headers(options),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = {};
  try { json = text ? JSON.parse(text) : {}; } catch { json = { error: text.slice(0, 500) }; }
  if (!response.ok) {
    const error = new Error(json.error || json.message || `Marrow ${route} returned HTTP ${response.status}`);
    error.status = response.status;
    error.details = json.details || json;
    throw error;
  }
  return dataOf(json);
}

function proofFromFile(filePath) {
  if (!filePath) return null;
  const raw = fs.readFileSync(path.resolve(filePath), 'utf8');
  return JSON.parse(raw);
}

function defaultProof(input) {
  const proof = proofFromFile(input.options.proofFile) || {};
  return {
    summary: proof.summary || `Marrow governed runner completed ${input.action}.`,
    checks: Array.isArray(proof.checks) ? proof.checks : ['marrow runtime gate', 'command exit captured'],
    outcome: proof.outcome || (input.success ? 'success' : 'failure'),
    blockers: Array.isArray(proof.blockers) ? proof.blockers : [],
    command: redactedCommand(input.childCommand || []),
    exit_code: input.exitCode,
    runner: '@getmarrow/install run',
    profile: input.options.profile,
    source_meta: sourceMeta(input.options, 'proof', { action: input.action }),
    ...(input.options.ownerApproval ? { owner_approval: { approved_by: 'owner', reference: input.options.ownerApproval } } : {}),
    ...proof,
  };
}

async function preflightRuntime(options, action, type, commandText) {
  const meta = sourceMeta(options, 'runtime', { action, command: commandText, action_type: type });
  return requestJson(options, 'POST', '/v1/agent/runtime', {
    action,
    type,
    surfaces: inferSurfaces(commandText || action),
    source_meta: meta,
    context: {
      runner: '@getmarrow/install run',
      profile: options.profile,
      command: commandText,
      policy: options.policy,
      governed: true,
      source_meta: meta,
    },
  });
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
      id: options.agentId,
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
      id: options.agentId,
      role: 'setup',
    },
    selected_mode: selected,
    selection_source: selected === state.recommendation.recommended_mode ? 'accepted' : 'overridden',
    source_meta: sourceMeta(options, 'mode_selection', { action: 'selected Marrow governance mode for this project' }),
  });
}

function gateDecision(runtime) {
  const gate = runtime?.risk_gate || {};
  const receipt = runtime?.gate_receipt || {};
  return {
    decision: gate.enforcement_decision || receipt.decision || gate.decision || 'unknown',
    allow: gate.allow !== false,
    required: Boolean(receipt.required || gate.gate_required),
    ownerApprovalRequired: Boolean(receipt.owner_approval_required || gate.owner_approval_required),
    receiptId: receipt.id || gate.gate_receipt_id || '',
    exactNextAction: runtime?.exact_next_action || receipt.exact_fix || gate.policy?.exact_fix || '',
    beforeYouAct: runtime?.before_you_act_injection?.message || runtime?.before_you_act || '',
    proofPack: runtime?.proof_pack || null,
  };
}

function shouldBlock(decision, options) {
  if (options.policy === 'audit') return false;
  if (decision.decision === 'block' || decision.allow === false) return true;
  if (options.policy === 'warn') return false;
  if (decision.ownerApprovalRequired && !options.ownerApproval) return true;
  if (decision.decision === 'owner_approval_required' && !options.ownerApproval) return true;
  return false;
}

function printGate(decision, runtime, stream = process.stdout) {
  stream.write(`Marrow gate: ${decision.decision}${decision.required ? ' (required)' : ''}\n`);
  if (decision.beforeYouAct) stream.write(`Before you act: ${decision.beforeYouAct}\n`);
  if (decision.exactNextAction) stream.write(`Next: ${decision.exactNextAction}\n`);
  if (decision.proofPack?.required) {
    const missing = decision.proofPack.missing?.length ? ` missing: ${decision.proofPack.missing.join(', ')}` : '';
    stream.write(`Proof pack: required${missing}\n`);
  }
  if (runtime?.value_proof?.owner_summary) stream.write(`Value: ${runtime.value_proof.owner_summary}\n`);
}

function runChild(command, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      stdio: 'inherit',
      shell: false,
      env,
    });
    child.on('error', (error) => resolve({ exitCode: 127, error }));
    child.on('close', (code, signal) => resolve({ exitCode: code ?? 1, signal: signal || null }));
  });
}

function scopedExecutionEnv(permit) {
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (/^MARROW_(?:API_KEY|KEY(?:_|$)|DASHBOARD|SESSION_TOKEN|SIDECAR_TOKEN|OWNER_APPROVAL)/.test(name)) continue;
    if (name === 'ACTION_PERMIT_SIGNING_KEY') continue;
    env[name] = value;
  }
  if (permit?.permit) {
    env.MARROW_ACTION_PERMIT = permit.permit;
    env.MARROW_ACTION_PERMIT_ID = String(permit.permit_id || '');
    env.MARROW_GOVERNANCE_VERIFIED = 'true';
  }
  return env;
}

async function createDecision(options, action, type) {
  const meta = sourceMeta(options, 'think', { action, action_type: type });
  return requestJson(options, 'POST', '/v1/agent/think', {
    action,
    type,
    source_meta: meta,
    context: {
      runner: '@getmarrow/install run',
      profile: options.profile,
      governed: true,
      source_meta: meta,
    },
  });
}

async function commitOutcome(options, decisionId, success, outcome, proof, gateReceiptId) {
  const body = {
    decision_id: decisionId,
    success,
    outcome,
    proof,
    source_meta: sourceMeta(options, 'commit', { action: outcome }),
  };
  if (gateReceiptId) body.gate_receipt_id = gateReceiptId;
  return requestJson(options, 'POST', '/v1/agent/commit', body);
}

async function runGoverned(parsed) {
  const { options, childCommand } = parsed;
  const commandText = redactedCommand(childCommand);
  const action = options.action ? redact(options.action) : commandText;
  const type = options.type || inferType(`${action} ${commandText}`);
  const risky = isRisky(`${action} ${commandText}`, type);
  let runtime = null;
  let decision = null;
  let decisionId = '';
  let actionPermit = null;
  const surfaces = inferSurfaces(commandText || action);

  try {
    runtime = await preflightRuntime(options, action, type, commandText);
    decision = gateDecision(runtime);
    printGate(decision, runtime);
    if (shouldBlock(decision, options)) {
      return {
        ok: false,
        blocked: true,
        exitCode: 12,
        action,
        type,
        risky,
        decision,
        message: decision.exactNextAction || 'Marrow blocked this action before execution.',
      };
    }
    const think = await createDecision(options, action, type);
    decisionId = think.decision_id || think.id || think.decision?.id || '';
    actionPermit = await issueActionPermit(requestJson, options, {
      action,
      type,
      target: options.target || commandText,
      surfaces,
      decisionId,
      gateReceiptId: decision?.receiptId || '',
      ownerApproval: options.ownerApproval,
      proofRequirements: decision?.proofPack?.required_fields || decision?.proofPack?.missing || [],
    });
    if (!actionPermit?.permit || !actionPermit?.permit_id) {
      throw new Error('Marrow did not issue a valid action permit.');
    }
    const verified = await verifyActionPermit(requestJson, options, {
      action,
      type,
      target: options.target || commandText,
      permit: actionPermit.permit,
    });
    if (!verified?.verified) throw new Error('Marrow action permit verification failed.');
  } catch (error) {
    if (options.failOpen || (!risky && !options.failClosed)) {
      process.stderr.write(`Marrow degraded: ${error.message}. Continuing because fail-open/non-risky policy allows it.\n`);
    } else {
      return {
        ok: false,
        blocked: true,
        degraded: true,
        exitCode: 13,
        action,
        type,
        risky,
        message: error.message,
      };
    }
  }

  const childEnv = scopedExecutionEnv(actionPermit);
  const child = await runChild(childCommand, childEnv);
  const success = child.exitCode === 0;
  const proof = defaultProof({ options, action, childCommand, exitCode: child.exitCode, success });
  const outcome = success
    ? `Marrow governed command succeeded with exit code ${child.exitCode}.`
    : `Marrow governed command failed with exit code ${child.exitCode}.`;

  let commit = null;
  if (decisionId) {
    try {
      commit = await commitOutcome(options, decisionId, success, outcome, proof, decision?.receiptId || '');
    } catch (error) {
      process.stderr.write(`Marrow outcome commit failed: ${error.message}\n`);
    }
  }

  let permitClosed = null;
  if (actionPermit?.permit) {
    try {
      permitClosed = await closeActionPermit(requestJson, options, {
        permit: actionPermit.permit,
        permitId: actionPermit.permit_id,
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
    decision,
    decision_id: decisionId,
    outcome_committed: Boolean(commit),
    permit_id: actionPermit?.permit_id || null,
    permit_verified: Boolean(actionPermit?.permit),
    permit_closed: Boolean(permitClosed),
  };
}

async function permitOnly(parsed) {
  const { options } = parsed;
  const action = redact(options.action);
  const type = options.type || inferType(action);
  const runtime = await preflightRuntime(options, action, type, options.target || action);
  const decision = gateDecision(runtime);
  if (shouldBlock(decision, options)) {
    return { ok: false, blocked: true, exitCode: 12, decision, message: decision.exactNextAction };
  }
  const think = await createDecision(options, action, type);
  const decisionId = think.decision_id || think.id || think.decision?.id || '';
  const result = await issueActionPermit(requestJson, options, {
    action,
    type,
    target: options.target || action,
    surfaces: inferSurfaces(options.target || action),
    decisionId,
    gateReceiptId: decision.receiptId,
    ownerApproval: options.ownerApproval,
    proofRequirements: decision?.proofPack?.required_fields || decision?.proofPack?.missing || [],
  });
  return { ok: true, decision_id: decisionId, ...result };
}

async function verifyPermitOnly(parsed) {
  const { options } = parsed;
  const action = redact(options.action);
  const type = options.type || inferType(action);
  const result = await verifyActionPermit(requestJson, options, {
    action,
    type,
    target: options.target || action,
    permit: options.permit,
  });
  return { ok: Boolean(result?.verified), ...result };
}

async function coverageOnly(parsed) {
  return readEnforcementCoverage(requestJson, parsed.options);
}

async function sidecarOnly(parsed) {
  const options = parsed.options;
  const sidecar = await startGovernanceSidecar(options, {
    permit: (input) => issueActionPermit(requestJson, options, input),
    verify: (input) => verifyActionPermit(requestJson, options, input),
    close: (input) => closeActionPermit(requestJson, options, input),
    coverage: () => readEnforcementCoverage(requestJson, options),
    heartbeat: (input) => recordEnforcementHeartbeat(requestJson, options, input),
  });
  process.stdout.write(`Marrow governance sidecar active on 127.0.0.1:${sidecar.port}. Press Ctrl+C to stop.\n`);
  await new Promise((resolve) => sidecar.server.once('close', resolve));
  return { ok: true };
}

async function gateOnly(parsed) {
  const { options } = parsed;
  const action = redact(options.action);
  const type = options.type || inferType(action);
  const runtime = await preflightRuntime(options, action, type, action);
  const decision = gateDecision(runtime);
  printGate(decision, runtime);
  return { ok: !shouldBlock(decision, options), action, type, decision };
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
    '',
  );
  return { ok: true, decision_id: options.decisionId, committed: true, result };
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
    if (update.update_command || update.exact_update_command) lines.push(`Update: ${displayText(update.update_command || update.exact_update_command, 240)}`);
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
    `Agent: ${snapshot.agent_id}`,
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

const GENERIC_GOVERNED_COMMAND = 'MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install run --agent <agent-id> --profile production --policy warn -- <harness-command>';

function localSupportedHarnesses() {
  return [
    { display_name: 'OpenAI Codex', client_label: 'codex', category: 'agent_harness', support_level: 'governed_runner', install_command: 'MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install run --agent codex-prod -- codex' },
    { display_name: 'Claude Code', client_label: 'claude-code', category: 'agent_harness', support_level: 'native_mcp_or_sdk', install_command: 'MARROW_API_KEY=mrw_live_xxx npx @getmarrow/mcp setup' },
    { display_name: 'Cursor', client_label: 'cursor', category: 'ide_agent', support_level: 'native_mcp_or_sdk', install_command: 'MARROW_API_KEY=mrw_live_xxx npx @getmarrow/mcp setup' },
    { display_name: 'Cursor Composer', client_label: 'composer', category: 'ide_agent', support_level: 'native_mcp_or_sdk', install_command: 'MARROW_API_KEY=mrw_live_xxx npx @getmarrow/mcp setup' },
    { display_name: 'Windsurf', client_label: 'windsurf', category: 'ide_agent', support_level: 'native_mcp_or_sdk', install_command: 'MARROW_API_KEY=mrw_live_xxx npx @getmarrow/mcp setup' },
    { display_name: 'Cline', client_label: 'cline', category: 'ide_agent', support_level: 'native_mcp_or_sdk', install_command: 'MARROW_API_KEY=mrw_live_xxx npx @getmarrow/mcp setup' },
    { display_name: 'OpenCode', client_label: 'opencode', category: 'agent_harness', support_level: 'governed_runner', install_command: 'MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install run --agent opencode-prod -- opencode' },
    { display_name: 'Hermes Agent', client_label: 'hermes', category: 'agent_harness', support_level: 'first_class_addon', install_command: 'MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install hermes' },
    { display_name: 'OpenClaw', client_label: 'openclaw', category: 'agent_harness', support_level: 'first_class_addon', install_command: 'MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install openclaw' },
    { display_name: 'Gemini CLI', client_label: 'gemini', category: 'model_cli', support_level: 'governed_runner', install_command: GENERIC_GOVERNED_COMMAND },
    { display_name: 'Grok CLI', client_label: 'grok', category: 'model_cli', support_level: 'governed_runner', install_command: GENERIC_GOVERNED_COMMAND },
    { display_name: 'DeepSeek', client_label: 'deepseek', category: 'model_cli', support_level: 'governed_runner', install_command: GENERIC_GOVERNED_COMMAND },
    { display_name: 'Qwen', client_label: 'qwen', category: 'model_cli', support_level: 'governed_runner', install_command: GENERIC_GOVERNED_COMMAND },
    { display_name: 'Kimi', client_label: 'kimi', category: 'model_cli', support_level: 'governed_runner', install_command: GENERIC_GOVERNED_COMMAND },
    { display_name: 'MiniMax', client_label: 'minimax', category: 'model_cli', support_level: 'governed_runner', install_command: GENERIC_GOVERNED_COMMAND },
    { display_name: 'GLM', client_label: 'glm', category: 'model_cli', support_level: 'governed_runner', install_command: GENERIC_GOVERNED_COMMAND },
    { display_name: 'MCP-compatible clients', client_label: 'mcp', category: 'mcp_client', support_level: 'native_mcp_or_sdk', install_command: 'MARROW_API_KEY=mrw_live_xxx npx @getmarrow/mcp setup' },
    { display_name: 'CI scripts and deploy runners', client_label: 'ci', category: 'ci_runner', support_level: 'governed_runner', install_command: 'MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install run --agent ci-release --profile production --policy enforce -- <ci-or-deploy-command>' },
    { display_name: 'Custom shell/API harness', client_label: 'custom', category: 'custom_runner', support_level: 'event_contract', install_command: 'POST /v1/agent/integrations/events with harness, event_type, agent_id, and action' },
  ];
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
      install_command: 'MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install hermes',
      governed_command: 'MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install run --agent hermes-prod --profile production --policy enforce -- hermes',
      capture_points: [
        '/goal -> Marrow completion contract',
        'verification evidence -> Marrow proof pack',
        '/learn -> outcome-ranked fleet lesson',
        '/journey -> governance timeline',
        'background subagents -> agent_id + source_meta.client=hermes',
      ],
      exact_next_action: 'Run the Hermes add-on, then call Marrow runtime before deploy, merge, publish, migration, credential, or customer-facing work.',
    };
  }
  if (key === 'openclaw' || key === 'open-claw') {
    return {
      integration: 'openclaw',
      title: 'Marrow + OpenClaw',
      client_label: 'openclaw',
      command: 'openclaw agent',
      install_command: 'MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install openclaw',
      governed_command: 'MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install run --agent openclaw-release --profile production --policy enforce -- openclaw agent',
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
    integration_registry_version: 'local.broad-harness-support-v2',
    first_class_addons: ['hermes', 'openclaw'].map((name) => localIntegrationManifest(name)),
    supported_harnesses: localSupportedHarnesses(),
    exact_next_action: 'Pick the harness your team already uses. Use the install_command shown here, or send compact events to /v1/agent/integrations/events.',
  };
  let registry = local;
  let source = 'local';
  if (parsed.options.apiKey) {
    try {
      registry = await requestJson(parsed.options, 'GET', '/v1/agent/integrations');
      source = 'api';
    } catch (error) {
      registry = { ...local, api_warning: error instanceof Error ? error.message : String(error) };
    }
  }
  if (parsed.options.json) return { ok: true, source, registry };
  const harnesses = Array.isArray(registry.supported_harnesses) ? registry.supported_harnesses : [];
  process.stdout.write([
    'Marrow Harness Integrations',
    '',
    `Source: ${source}`,
    'Supported harnesses and model CLIs:',
    ...harnesses.map((harness) => `  - ${displayText(harness.display_name || harness.client_label || harness.integration || harness.title, 40)} [${displayText(harness.support_level || 'supported', 24)}]  ${displayText(harness.install_command || harness.install_commands?.[0] || '', 120)}`),
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
  const agentId = displayText(options.agentId, 80);
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
    `  npx @getmarrow/install run --agent ${shellQuoteDisplay(options.agentId)} --profile production --policy enforce -- codex`,
    `  npx @getmarrow/install run --agent deploy-agent --type deploy --policy enforce -- wrangler deploy`,
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
  return `MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install run --agent ${shellQuoteDisplay(options.agentId)} --profile ${shellQuoteDisplay(options.profile)} --policy ${shellQuoteDisplay(mode.policy)} -- ${renderedCommand}`;
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
    `Agent: ${displayText(options.agentId, 36)}   Profile: ${displayText(options.profile, 24)}   API key: ${options.apiKey ? 'present' : 'missing'}`,
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
    `Agent: ${displayText(snapshot.agent_id, 36)}   Snapshot: ${displayText(snapshot.generated_at, 36)}`,
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
  const decision = gateDecision(runtime);
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
              ? receipts.map((receipt, index) => `${index + 1}. ${receipt.id}: ${receipt.resolution}${receipt.decision_id ? `; decision=${receipt.decision_id}` : ''}${receipt.selected_proposal_id ? `; selected=${receipt.selected_proposal_id}` : ''}; ${receipt.exact_next_action || receipt.conflict_type}${receipt.owner_approval_required ? ' Owner approval must be issued from an authenticated Marrow dashboard session.' : ''}`).join('  ')
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

  let result;
  if (parsed.command === 'run') result = await runGoverned(parsed);
  else if (parsed.command === 'gate') result = await gateOnly(parsed);
  else if (parsed.command === 'proof') result = await proofOnly(parsed);
  else if (parsed.command === 'status') result = await statusOnly(parsed);
  else if (parsed.command === 'permit') result = await permitOnly(parsed);
  else if (parsed.command === 'verify-permit') result = await verifyPermitOnly(parsed);
  else if (parsed.command === 'coverage') result = await coverageOnly(parsed);
  else if (parsed.command === 'sidecar') result = await sidecarOnly(parsed);
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

  if (parsed.options?.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (result?.blocked) process.stderr.write(`BLOCKED: ${result.message || 'Marrow blocked this action.'}\n`);
  else if (parsed.command === 'status') process.stdout.write(`${statusPanel(result)}\n`);
  else if (!['run', 'fleet', 'hermes', 'openclaw', 'integrations'].includes(parsed.command)) process.stdout.write('Marrow command completed.\n');

  if (parsed.command === 'run' || result?.blocked) process.exitCode = result?.exitCode ?? (result?.ok === false ? 1 : 0);
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
  commandForSelection,
  buildGovernState,
  detectProjectSignals,
  recommendGovernanceMode,
  recordGovernanceModeSelection,
  gateDecision,
  shouldBlock,
  governPanel,
  renderGovernTui,
  canUseInteractive,
  runGoverned,
  scopedExecutionEnv,
  permitOnly,
  verifyPermitOnly,
  coverageOnly,
  sidecarOnly,
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
  localIntegrationManifest,
  renderIntegrationPanel,
  integrationOnly,
  integrationsOnly,
  runCli,
};

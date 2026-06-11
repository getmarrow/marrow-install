const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_BASE_URL = 'https://api.getmarrow.ai';
const HIGH_RISK_TERMS = /\b(deploy|prod|production|publish|release|merge|migration|migrate|secret|token|key|cloudflare|wrangler|npm publish|gh pr merge|git push|terraform apply|kubectl apply|delete|destroy|drop)\b/i;
function usage() {
  return `Usage:
  npx @getmarrow/install run --agent deploy-agent -- npm test
  npx @getmarrow/install run --agent deploy-agent --type deploy --policy enforce -- wrangler deploy
  npx @getmarrow/install gate "deploy production worker"
  npx @getmarrow/install proof --decision-id <id> --success --summary "smoke passed"
  npx @getmarrow/install status
  npx @getmarrow/install govern

Commands:
  run       Run a command through Marrow pre-action gate and automatic outcome closure
  gate      Check Marrow runtime/gate for an action without running a command
  proof     Commit an outcome/proof for an existing decision
  status    Read /v1/agent/status
  govern    Print a TUI-style setup panel for configuring governed agent runs

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
  --proof-file <path>     JSON proof to include on outcome commit
  --base-url <url>        Marrow API base URL
  --key <key>             Marrow API key. Prefer MARROW_API_KEY
  --json                  Print machine-readable result after completion
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
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(text) ? text : JSON.stringify(text);
}

function redactedCommand(command) {
  return command.map((part) => shellQuote(redact(part))).join(' ');
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
    else if (arg === '--proof-file') options.proofFile = argv[++i] || options.proofFile;
    else if (arg === '--base-url') options.baseUrl = argv[++i] || options.baseUrl;
    else if (arg === '--key') {
      options.apiKey = argv[++i] || options.apiKey;
      options.keyFromArg = true;
    } else if (arg === '--json') options.json = true;
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

  if (command === 'status' || command === 'govern') {
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
    'User-Agent': '@getmarrow/install governed-runner',
  };
  return h;
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
    ...(input.options.ownerApproval ? { owner_approval: { approved_by: 'owner', reference: input.options.ownerApproval } } : {}),
    ...proof,
  };
}

async function preflightRuntime(options, action, type, commandText) {
  return requestJson(options, 'POST', '/v1/agent/runtime', {
    action,
    type,
    surfaces: inferSurfaces(commandText || action),
    context: {
      runner: '@getmarrow/install run',
      profile: options.profile,
      command: commandText,
      policy: options.policy,
      governed: true,
    },
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

async function createDecision(options, action, type) {
  return requestJson(options, 'POST', '/v1/agent/think', {
    action,
    type,
    context: {
      runner: '@getmarrow/install run',
      profile: options.profile,
      governed: true,
    },
  });
}

async function commitOutcome(options, decisionId, success, outcome, proof, gateReceiptId) {
  const body = {
    decision_id: decisionId,
    success,
    outcome,
    proof,
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

  const child = await runChild(childCommand);
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
  };
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

function detectHarnesses(cwd = process.cwd()) {
  const candidates = [
    { name: 'Codex', command: 'codex', detected: fs.existsSync(path.join(cwd, 'AGENTS.md')) || fs.existsSync(path.join(os.homedir(), '.codex')) },
    { name: 'Claude Code', command: 'claude -p', detected: fs.existsSync(path.join(cwd, 'CLAUDE.md')) || fs.existsSync(path.join(os.homedir(), '.claude.json')) },
    { name: 'OpenCode', command: 'opencode', detected: fs.existsSync(path.join(cwd, 'opencode.json')) || fs.existsSync(path.join(os.homedir(), '.opencode')) },
    { name: 'OpenClaw', command: 'openclaw agent', detected: fs.existsSync(path.join(os.homedir(), '.openclaw')) },
    { name: 'Custom command', command: '<your-agent-command>', detected: true },
  ];
  return candidates;
}

function governPanel(options) {
  const rows = detectHarnesses();
  const lines = [
    'Marrow Governed Runner',
    '',
    `Agent:  ${options.agentId}`,
    `Profile: ${options.profile}`,
    `Policy:  ${options.policy}`,
    '',
    'Choose where your agent runs. Marrow governs the action before it executes.',
    '',
    'Detected harnesses:',
    ...rows.map((row, index) => `  ${index + 1}. ${row.detected ? '[x]' : '[ ]'} ${row.name}  ${row.command}`),
    '',
    'Recommended first commands:',
    `  npx @getmarrow/install run --agent ${options.agentId} --profile production --policy enforce -- codex`,
    `  npx @getmarrow/install run --agent deploy-agent --type deploy --policy enforce -- wrangler deploy`,
    `  npx @getmarrow/install gate "deploy production worker after tests pass"`,
    '',
    'Protected by default: deploy, merge, publish, migrations, secrets, keys, production actions.',
  ];
  return lines.join('\n');
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
  else if (parsed.command === 'govern') {
    process.stdout.write(`${governPanel(parsed.options)}\n`);
    return;
  }

  if (parsed.options?.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else if (result?.blocked) process.stderr.write(`BLOCKED: ${result.message || 'Marrow blocked this action.'}\n`);
  else if (parsed.command !== 'run') process.stdout.write('Marrow command completed.\n');

  if (parsed.command === 'run' || result?.blocked) process.exitCode = result?.exitCode ?? (result?.ok === false ? 1 : 0);
}

module.exports = {
  parseArgs,
  redact,
  redactedCommand,
  inferType,
  inferSurfaces,
  gateDecision,
  shouldBlock,
  governPanel,
  runGoverned,
  gateOnly,
  proofOnly,
  statusOnly,
  runCli,
};

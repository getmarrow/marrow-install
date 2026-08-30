const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { version: INSTALLER_ADAPTER_VERSION } = require('../package.json');
const { controllerStatus, controllerSupportedPlatform, ensureGovernanceController } = require('./controller-manager');
const { firstCapturePath, harnessReloadPlan } = require('./first-hour');
const { evidence: localControlEvidence } = require('./control-state');

const DEFAULT_BASE_URL = 'https://api.getmarrow.ai';
const MARROW_BLOCK_START = '<!-- marrow:passive-start -->';
const MARROW_BLOCK_END = '<!-- marrow:passive-end -->';
const MCP_ADAPTER_VERSION = '3.9.79';
const MCP_ADAPTER_SOURCE_SHA = '45aa1a9042454e93aac0e7386ed90e56d74b3fde';
const MCP_ADAPTER_INTEGRITY = 'sha512-vLfZpfbCTYaPdOGgy74CrpYxyEXaDqXyR1Fo1pW6nMaDuk2AQWxEEkCO55qDybL5Kg0UESYvMcc8pf3Ya+JZrQ==';
const SDK_ADAPTER_VERSION = '3.7.62';
const SDK_ADAPTER_INTEGRITY = 'sha512-n1i6Be09TpAQ9BPNRKY7aCvA2iSUPpJfw8djw2MELwpNbBCtKiZ29Jji77BK/6EFLUpSIcTW/Gmdf/ccf0JRYQ==';
const SDK_ADAPTER_TARBALL = `https://registry.npmjs.org/@getmarrow/sdk/-/sdk-${SDK_ADAPTER_VERSION}.tgz`;
const MCP_PACKAGE_SPEC = `@getmarrow/mcp@${MCP_ADAPTER_VERSION}`;
const ADAPTER_PROVENANCE = Object.freeze({
  mcp: Object.freeze({
    package: '@getmarrow/mcp',
    version: MCP_ADAPTER_VERSION,
    source_sha: MCP_ADAPTER_SOURCE_SHA,
    integrity: MCP_ADAPTER_INTEGRITY,
    integrity_state: 'sealed_local_candidate',
  }),
  sdk: Object.freeze({
    package: '@getmarrow/sdk',
    version: SDK_ADAPTER_VERSION,
    integrity: SDK_ADAPTER_INTEGRITY,
  }),
});
const MCP_REGISTRY_LATEST_URL = 'https://registry.npmjs.org/%40getmarrow%2Fmcp/latest';
const MCP_STABLE_VERSION_RE = /^(\d{1,6})\.(\d{1,6})\.(\d{1,9})$/;
const SHA512_INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]+={0,2}$/;

function validSha512Integrity(value) {
  if (!SHA512_INTEGRITY_RE.test(value)) return false;
  const encoded = value.slice('sha512-'.length);
  try {
    const digest = Buffer.from(encoded, 'base64');
    return digest.length === 64 && digest.toString('base64') === encoded;
  } catch {
    return false;
  }
}

function parsedStableMcpVersion(value) {
  const match = String(value || '').match(MCP_STABLE_VERSION_RE);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compareMcpVersions(left, right) {
  const leftParts = parsedStableMcpVersion(left);
  const rightParts = parsedStableMcpVersion(right);
  if (!leftParts || !rightParts) return null;
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] !== rightParts[index]) return leftParts[index] - rightParts[index];
  }
  return 0;
}

function compatibleMcpTargetVersion(value) {
  const candidate = parsedStableMcpVersion(value);
  const sealed = parsedStableMcpVersion(MCP_ADAPTER_VERSION);
  return Boolean(candidate && sealed
    && candidate[0] === sealed[0]
    && candidate[1] === sealed[1]
    && compareMcpVersions(value, MCP_ADAPTER_VERSION) >= 0);
}

function verifiedMcpRegistryMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const version = typeof value.version === 'string' ? value.version : '';
  const integrity = typeof value.dist?.integrity === 'string' ? value.dist.integrity : '';
  const tarball = typeof value.dist?.tarball === 'string' ? value.dist.tarball : '';
  const expectedTarball = `https://registry.npmjs.org/@getmarrow/mcp/-/mcp-${version}.tgz`;
  if (value.name !== '@getmarrow/mcp'
    || !compatibleMcpTargetVersion(version)
    || !validSha512Integrity(integrity)
    || tarball !== expectedTarball) return null;
  return { version, integrity, tarball };
}

function resolveMcpTargetVersion(options = {}) {
  const candidates = new Map([[MCP_ADAPTER_VERSION, {
    version: MCP_ADAPTER_VERSION,
    source: 'sealed_installer',
    integrity: MCP_ADAPTER_INTEGRITY,
    source_sha: MCP_ADAPTER_SOURCE_SHA,
  }]]);
  for (const value of Array.isArray(options.currentVersions) ? options.currentVersions : []) {
    if (!compatibleMcpTargetVersion(value)) continue;
    candidates.set(value, {
      version: value,
      source: 'current_exact_configuration',
      integrity: null,
      source_sha: null,
    });
  }
  const registry = verifiedMcpRegistryMetadata(options.registryMetadata);
  if (registry) {
    candidates.set(registry.version, {
      version: registry.version,
      source: 'verified_npm_registry',
      integrity: registry.integrity,
      source_sha: null,
    });
  }
  return [...candidates.values()].sort((left, right) => compareMcpVersions(right.version, left.version))[0];
}

async function readMcpRegistryMetadata(options = {}) {
  if (Object.prototype.hasOwnProperty.call(options, 'mcpRegistryMetadata')) {
    return options.mcpRegistryMetadata;
  }
  if (options.resolveMcpRegistry !== true) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const fetcher = typeof options.registryFetch === 'function' ? options.registryFetch : fetch;
    const response = await fetcher(MCP_REGISTRY_LATEST_URL, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function adapterProvenanceForMcpTarget(target) {
  if (!target || target.version === MCP_ADAPTER_VERSION) return ADAPTER_PROVENANCE;
  return {
    mcp: {
      package: '@getmarrow/mcp',
      version: target.version,
      source_sha: target.source_sha,
      integrity: target.integrity,
      integrity_state: target.source === 'verified_npm_registry'
        ? 'verified_npm_registry_metadata'
        : 'exact_current_configuration',
    },
    sdk: ADAPTER_PROVENANCE.sdk,
  };
}

function retargetMcpPackageSpec(value, version) {
  const target = compatibleMcpTargetVersion(version) ? version : MCP_ADAPTER_VERSION;
  return String(value).split(MCP_PACKAGE_SPEC).join(`@getmarrow/mcp@${target}`);
}

function retargetMcpDowngradeRecommendation(value, targetVersion) {
  if (typeof value !== 'string' || !compatibleMcpTargetVersion(targetVersion)) return value;
  return value.replace(/@getmarrow\/mcp@(\d+\.\d+\.\d+)/g, (match, version) => (
    parsedStableMcpVersion(version) && compareMcpVersions(version, targetVersion) < 0
      ? `@getmarrow/mcp@${targetVersion}`
      : match
  ));
}

function alignMcpRecommendationVersions(value, targetVersion, key = '') {
  if (Array.isArray(value)) {
    return value.map((entry) => alignMcpRecommendationVersions(entry, targetVersion, key));
  }
  if (!value || typeof value !== 'object') {
    return /(?:command|fix|instruction|next_action|notice)$/i.test(key)
      ? retargetMcpDowngradeRecommendation(value, targetVersion)
      : value;
  }
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
    entryKey,
    alignMcpRecommendationVersions(entryValue, targetVersion, entryKey),
  ]));
}
const MCP_CONTEXT_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp context-hook`;
const MCP_PRE_ACTION_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp pre-action-hook`;
const MCP_ACTION_RESULT_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp hook`;
const MCP_SESSION_END_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp session-hook`;
const CODEX_CONTEXT_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp codex-context-hook`;
const CODEX_PRE_ACTION_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp codex-pre-action-hook`;
const CODEX_ACTION_RESULT_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp codex-hook`;
const CODEX_SESSION_END_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp codex-session-hook`;
const CURSOR_PRE_ACTION_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp cursor-pre-action-hook`;
const CURSOR_ACTION_RESULT_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp cursor-hook`;
const CURSOR_SESSION_END_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp cursor-session-hook`;
const CLINE_PRE_ACTION_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp cline-pre-action-hook`;
const CLINE_ACTION_RESULT_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp cline-hook`;
const CLINE_SESSION_END_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp cline-session-hook`;
const WINDSURF_PRE_ACTION_ENTRYPOINT = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp windsurf-pre-action-hook`;
const WINDSURF_ACTION_RESULT_ENTRYPOINT = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp windsurf-hook`;
const WINDSURF_SESSION_END_ENTRYPOINT = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp windsurf-session-hook`;
const WINDSURF_LAUNCH_FAILURE = 'Marrow governance adapter was unavailable; this action is blocked.';
const WINDSURF_PRE_ACTION_HOOK_COMMAND = `sh -c 'stderr="$(${WINDSURF_PRE_ACTION_ENTRYPOINT} 2>&1 >/dev/null)"; status=$?; if [ "$status" -eq 0 ]; then exit 0; fi; if [ "$status" -eq 2 ]; then printf "%s\\n" "$stderr" >&2; exit 2; fi; printf "%s\\n" "${WINDSURF_LAUNCH_FAILURE}" >&2; exit 2'`;
const WINDSURF_ACTION_RESULT_HOOK_COMMAND = `sh -c '${WINDSURF_ACTION_RESULT_ENTRYPOINT} >/dev/null 2>&1 || :; exit 0'`;
const WINDSURF_SESSION_END_HOOK_COMMAND = `sh -c '${WINDSURF_SESSION_END_ENTRYPOINT} >/dev/null 2>&1 || :; exit 0'`;
const GEMINI_PRE_ACTION_ENTRYPOINT = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp gemini-pre-action-hook`;
const GEMINI_ACTION_RESULT_ENTRYPOINT = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp gemini-hook`;
const GEMINI_SESSION_END_ENTRYPOINT = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp gemini-session-hook`;
const GEMINI_FIXED_DENIAL = 'Marrow blocked this action because required governance approval or proof is unavailable.';
const GEMINI_LAUNCH_FAILURE = 'Marrow governance adapter was unavailable; this action is blocked.';
const GEMINI_PRE_ACTION_HOOK_COMMAND = `sh -c 'output="$(${GEMINI_PRE_ACTION_ENTRYPOINT} 2>/dev/null)" && { case "$output" in "{\\"decision\\":\\"allow\\"}"|"{\\"decision\\":\\"deny\\",\\"reason\\":\\"${GEMINI_FIXED_DENIAL}\\"}") printf "%s\\n" "$output"; exit 0 ;; esac; }; printf "%s\\n" "${GEMINI_LAUNCH_FAILURE}" >&2; exit 2'`;
const GEMINI_ACTION_RESULT_HOOK_COMMAND = `sh -c '${GEMINI_ACTION_RESULT_ENTRYPOINT} >/dev/null 2>&1 || :; printf "%s\\n" "{}"; exit 0'`;
const GEMINI_SESSION_END_HOOK_COMMAND = `sh -c '${GEMINI_SESSION_END_ENTRYPOINT} >/dev/null 2>&1 || :; printf "%s\\n" "{}"; exit 0'`;
const GROK_CONTEXT_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp grok-context-hook`;
const GROK_ACTION_RESULT_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp grok-hook`;
const GROK_SESSION_END_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp grok-session-hook`;
const GROK_FIXED_DENIAL = 'Marrow blocked this protected action.';
const GROK_LAUNCH_FAILURE = 'Marrow governance adapter was unavailable; this action is blocked.';
const GROK_PRE_ACTION_GUARD_SOURCE = [
  'const {spawn}=require("node:child_process");',
  `const valid=new Set([${JSON.stringify('{"decision":"allow"}')},${JSON.stringify(`{"decision":"deny","reason":"${GROK_FIXED_DENIAL}"}`)}]);`,
  'let child=null,timer=null,done=false,input=[],inputBytes=0,output="",outputBytes=0;',
  `const fail=()=>{if(done)return;done=true;if(timer)clearTimeout(timer);if(child&&!child.killed)child.kill("SIGKILL");process.stderr.write(${JSON.stringify(`${GROK_LAUNCH_FAILURE}\n`)});process.exitCode=2;process.stdin.destroy();};`,
  'process.stdin.on("error",fail);',
  'process.stdin.on("data",chunk=>{const value=Buffer.from(chunk);inputBytes+=value.length;if(inputBytes>65536){fail();return;}input.push(value);});',
  'process.stdin.on("end",()=>{if(done)return;try{',
  `child=spawn(process.platform==="win32"?"npx.cmd":"npx",${JSON.stringify(['-y', `--package=${MCP_PACKAGE_SPEC}`, 'marrow-mcp', 'grok-pre-action-hook'])},{stdio:["pipe","pipe","ignore"]});`,
  'timer=setTimeout(fail,5000);',
  'child.stdout.on("data",chunk=>{if(done)return;outputBytes+=chunk.length;if(outputBytes>512){fail();return;}output+=chunk.toString("utf8");});',
  'child.on("error",fail);child.stdin.on("error",fail);',
  'child.on("close",code=>{if(done)return;if(code!==0||!valid.has(output)){fail();return;}done=true;if(timer)clearTimeout(timer);process.stdout.write(output);});',
  'child.stdin.end(Buffer.concat(input));}catch{fail();}});',
].join('');
const GROK_PRE_ACTION_HOOK_COMMAND = `node -e '${GROK_PRE_ACTION_GUARD_SOURCE}'`;
const NATIVE_HOOK_MATCHER = 'Bash|Edit|Write|MultiEdit|mcp__(?!marrow_).*';
const CODEX_NATIVE_HOOK_MATCHER = 'Bash|apply_patch|Edit|Write|MultiEdit|mcp__(?!marrow__marrow_).*|functions\\.(?!marrow_).*';
const CURSOR_NATIVE_HOOK_MATCHER = 'Shell|Write|Delete|Task|MCP:(?!marrow(?:_.*|:marrow_.*)$).*';
const GEMINI_NATIVE_HOOK_MATCHER = '^(?:run_shell_command|write_file|replace|edit_file|delete_file|mcp_(?!marrow_marrow_)[A-Za-z0-9_]{1,192})$';
const GROK_NATIVE_HOOK_MATCHER = 'run_terminal_command|search_replace|write|spawn_subagent|use_tool|workflow|image_gen|image_edit|image_to_video|reference_to_video';
const CODEX_HOOK_TIMEOUT_SECONDS = 5;
const CODEX_SESSION_TIMEOUT_SECONDS = 3;
const GEMINI_HOOK_TIMEOUT_MS = 5000;
const GEMINI_CLOSEOUT_TIMEOUT_MS = 3000;
const NATIVE_EXPECTED_HOOKS = ['prompt', 'pre_action', 'action_result', 'session_end'];
const SOURCE_CLIENTS = new Set(['claude-code', 'cursor', 'composer', 'windsurf', 'openclaw', 'codex', 'gemini', 'grok', 'deepseek', 'qwen', 'kimi', 'minimax', 'cline', 'opencode', 'hermes', 'glm', 'mcp', 'ci', 'custom', 'unknown']);
const TOOL_PROFILES = new Set(['primary', 'core', 'full']);
const TOOL_PROFILE_EXPECTED_COUNTS = Object.freeze({ primary: 17, core: 7, full: null });
const TOOL_PROFILE_EXACT_FIX = 'Unset MARROW_TOOL_PROFILE to use primary, or set MARROW_TOOL_PROFILE=core or MARROW_TOOL_PROFILE=full, then restart the owning harness and run npx @getmarrow/install@latest doctor --self-test.';
const PRIMARY_TOOL_NAMES = Object.freeze([
  'marrow_agent_runtime',
  'marrow_arbitrate',
  'marrow_coordinate',
  'marrow_replay_compare',
  'marrow_decision_brief',
  'marrow_think',
  'marrow_commit',
  'marrow_workflow_gate',
  'marrow_completion_contracts',
  'marrow_evaluate_completion_contract',
  'marrow_agent_status',
  'marrow_value_report',
  'marrow_buyer_proof',
  'marrow_governance_timeline',
  'marrow_decision_trace',
  'marrow_fleet_lessons',
  'marrow_model_usage',
]);
const HARNESS_CAPABILITY_REGISTRY = Object.freeze([
  { client: 'claude-code', capability_level: 'native_hooks', automatic: ['prompt', 'pre_action', 'action_result', 'session_end'], install_surface: 'mcp' },
  { client: 'cursor', capability_level: 'native_hooks', automatic: ['pre_action', 'action_result', 'outcome_closure'], install_surface: 'mcp' },
  { client: 'composer', capability_level: 'native_hooks', automatic: ['pre_action', 'action_result', 'outcome_closure'], install_surface: 'mcp' },
  { client: 'cline', capability_level: 'native_hooks', automatic: ['pre_action', 'action_result', 'cancel_closeout'], install_surface: 'mcp' },
  { client: 'windsurf', capability_level: 'native_hooks', automatic: ['pre_action', 'action_result', 'response_closeout'], install_surface: 'mcp' },
  { client: 'codex', capability_level: 'native_hooks', automatic: ['prompt', 'pre_action', 'action_result', 'session_end'], install_surface: 'mcp' },
  { client: 'opencode', capability_level: 'governed_wrapper', automatic: ['pre_action', 'action_result', 'outcome_closure'], install_surface: 'runner' },
  { client: 'hermes', capability_level: 'event_contract', automatic: [], install_surface: 'addon' },
  { client: 'openclaw', capability_level: 'event_contract', automatic: [], install_surface: 'addon' },
  { client: 'gemini', capability_level: 'native_hooks', automatic: ['pre_action', 'action_result', 'turn_closeout'], install_surface: 'mcp' },
  { client: 'grok', capability_level: 'native_hooks', automatic: ['pre_action', 'action_result', 'turn_closeout'], install_surface: 'mcp' },
  { client: 'deepseek', capability_level: 'governed_wrapper', automatic: ['pre_action', 'action_result', 'outcome_closure'], install_surface: 'runner' },
  { client: 'qwen', capability_level: 'governed_wrapper', automatic: ['pre_action', 'action_result', 'outcome_closure'], install_surface: 'runner' },
  { client: 'kimi', capability_level: 'governed_wrapper', automatic: ['pre_action', 'action_result', 'outcome_closure'], install_surface: 'runner' },
  { client: 'minimax', capability_level: 'governed_wrapper', automatic: ['pre_action', 'action_result', 'outcome_closure'], install_surface: 'runner' },
  { client: 'glm', capability_level: 'governed_wrapper', automatic: ['pre_action', 'action_result', 'outcome_closure'], install_surface: 'runner' },
  { client: 'mcp', capability_level: 'mcp', automatic: ['mcp_tool_calls'], install_surface: 'mcp' },
  { client: 'ci', capability_level: 'governed_wrapper', automatic: ['pre_action', 'action_result', 'outcome_closure'], install_surface: 'runner' },
  { client: 'custom', capability_level: 'event_contract', automatic: [], install_surface: 'event_contract' },
]);

function explicitMcpVersion(command) {
  const match = String(command || '').match(/@getmarrow\/mcp@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return match ? match[1] : null;
}

function resolveToolProfile(value) {
  const structured = value !== null && typeof value === 'object' && !Array.isArray(value);
  const candidate = structured
    ? value.configured_profile
    : value;
  const absent = !structured && candidate === undefined;
  const structuredUnset = structured && candidate === 'unset';
  const configuredProfile = absent || structuredUnset
    ? 'unset'
    : candidate;
  if (!absent && !structuredUnset && !TOOL_PROFILES.has(configuredProfile)) {
    throw new Error(`Invalid MARROW_TOOL_PROFILE. ${TOOL_PROFILE_EXACT_FIX}`);
  }
  const effectiveProfile = configuredProfile === 'unset' ? 'primary' : configuredProfile;
  return {
    configured_profile: configuredProfile,
    effective_profile: effectiveProfile,
    expected_visible_count: TOOL_PROFILE_EXPECTED_COUNTS[effectiveProfile],
  };
}

function normalizePrimaryToolAvailability(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.profile !== 'primary') return null;
  const evidence = value.entitlement_evidence;
  const counts = value.counts;
  const tools = Array.isArray(value.tools) ? value.tools : [];
  if (!evidence || typeof evidence !== 'object' || evidence.authorizing !== false) return null;
  if (!['available', 'unavailable'].includes(evidence.state)) return null;
  if (!counts || counts.total !== 17 || !Number.isInteger(counts.entitled) || !Number.isInteger(counts.upgrade_required)) return null;
  if (counts.entitled + counts.upgrade_required !== counts.total || tools.length !== counts.total) return null;
  const normalizedTools = [];
  const seen = new Set();
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object' || !PRIMARY_TOOL_NAMES.includes(tool.name) || seen.has(tool.name)) return null;
    if (!['entitled', 'upgrade_required'].includes(tool.state) || typeof tool.always_available !== 'boolean') return null;
    seen.add(tool.name);
    normalizedTools.push({
      name: tool.name,
      state: tool.state,
      always_available: tool.always_available,
      plan_feature: typeof tool.plan_feature === 'string' ? tool.plan_feature : null,
      minimum_plan: typeof tool.minimum_plan === 'string' ? tool.minimum_plan : null,
      owner_management_url: typeof tool.owner_management_url === 'string' ? tool.owner_management_url : '',
    });
  }
  if (PRIMARY_TOOL_NAMES.some((name) => !seen.has(name))) return null;
  const entitled = normalizedTools.filter((tool) => tool.state === 'entitled').length;
  const upgradeRequired = normalizedTools.filter((tool) => tool.state === 'upgrade_required').length;
  if (entitled !== counts.entitled || upgradeRequired !== counts.upgrade_required) return null;
  return {
    profile: 'primary',
    current_plan: typeof value.current_plan === 'string' ? value.current_plan : null,
    owner_management_url: typeof value.owner_management_url === 'string' ? value.owner_management_url : '',
    entitlement_evidence: {
      state: evidence.state,
      source: typeof evidence.source === 'string' ? evidence.source : 'entitlement_read_unavailable',
      authoritative: evidence.authoritative === true,
      authorizing: false,
    },
    counts: { total: 17, entitled, upgrade_required: upgradeRequired },
    tools: normalizedTools,
  };
}

function backendEntitlementProjection(statusProfile, contextProjection) {
  const freshProjection = normalizePrimaryToolAvailability(contextProjection);
  if (freshProjection) {
    return {
      evidence_state: freshProjection.entitlement_evidence.state,
      source: 'authenticated_backend',
      authorizes_calls: false,
      primary_tool_availability: freshProjection,
    };
  }
  const envelope = statusProfile?.backend_entitlement_projection;
  const projected = normalizePrimaryToolAvailability(envelope?.primary_tool_availability);
  const source = ['authenticated_backend', 'cached_or_stale_status', 'backend_projection_not_provided'].includes(envelope?.source)
    ? envelope.source
    : 'backend_projection_not_provided';
  const available = envelope?.authorizes_calls === false
    && envelope?.evidence_state === 'available'
    && source === 'authenticated_backend'
    && projected?.entitlement_evidence.state === 'available';
  return {
    evidence_state: available ? 'available' : 'unavailable',
    source,
    authorizes_calls: false,
    primary_tool_availability: projected,
  };
}

function buildMcpToolProfileReport(value, statusProfile = null, contextProjection = null, forceReload = false) {
  const expected = resolveToolProfile(value);
  const reportedNames = Array.isArray(statusProfile?.visible_tool_names)
    ? statusProfile.visible_tool_names.filter((name) => typeof name === 'string')
    : [];
  const reportedCount = statusProfile?.visible_tool_count;
  const reportedConfigured = statusProfile?.configured_profile;
  const reportedEffective = statusProfile?.effective_profile;
  const uniqueNames = new Set(reportedNames);
  const profileIdentityMatches = reportedConfigured === expected.configured_profile
    && reportedEffective === expected.effective_profile;
  const reportedCatalogIsConsistent = Number.isInteger(reportedCount)
    && reportedCount >= 0
    && reportedNames.length === reportedCount
    && uniqueNames.size === reportedCount;
  const expectedCount = expected.effective_profile === 'full'
    && profileIdentityMatches
    && reportedCatalogIsConsistent
    ? reportedCount
    : expected.expected_visible_count;
  const expectedPrimaryNames = expected.effective_profile !== 'primary'
    || (reportedNames.length === PRIMARY_TOOL_NAMES.length
      && PRIMARY_TOOL_NAMES.every((name) => uniqueNames.has(name)));
  const visibilityLive = !forceReload
    && profileIdentityMatches
    && statusProfile?.local_visibility_grants_entitlement === false
    && reportedCatalogIsConsistent
    && reportedCount === expectedCount
    && expectedPrimaryNames;
  return {
    configured_profile: expected.configured_profile,
    effective_profile: expected.effective_profile,
    expected_visible_count: expectedCount,
    visible_tool_count: visibilityLive ? reportedCount : null,
    actual_visible_count: visibilityLive ? reportedCount : null,
    visible_tool_names: visibilityLive ? reportedNames : [],
    local_visibility_grants_entitlement: false,
    visibility_live: visibilityLive,
    reload_required: !visibilityLive,
    reported_configured_profile: typeof reportedConfigured === 'string' ? reportedConfigured : null,
    reported_effective_profile: typeof reportedEffective === 'string' ? reportedEffective : null,
    backend_entitlement_projection: backendEntitlementProjection(statusProfile, contextProjection),
  };
}

function initialToolProfileReport(value) {
  return {
    ...buildMcpToolProfileReport(value),
  };
}

function readMcpPackageVersion(packageRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)
      ? pkg.version
      : null;
  } catch {
    return null;
  }
}

function packageMcpVersion(command) {
  const normalized = String(command || '').replace(/\0/g, ' ');
  const packageRoots = [];
  for (const match of normalized.matchAll(/(\/[^\s]+\/node_modules\/@getmarrow\/mcp)(?:\/|\s|$)/g)) {
    packageRoots.push(match[1]);
  }
  for (const match of normalized.matchAll(/(\/[^\s]+\/node_modules\/\.bin\/marrow-mcp)(?:\s|$)/g)) {
    const binPath = match[1];
    packageRoots.push(path.resolve(path.dirname(binPath), '..', '@getmarrow', 'mcp'));
    try {
      const resolved = fs.realpathSync(binPath);
      const marker = `${path.sep}node_modules${path.sep}@getmarrow${path.sep}mcp${path.sep}`;
      const markerIndex = resolved.indexOf(marker);
      if (markerIndex >= 0) packageRoots.push(resolved.slice(0, markerIndex + marker.length - 1));
    } catch {
      // The derived package root still gives a deterministic best-effort lookup.
    }
  }
  for (const packageRoot of [...new Set(packageRoots)]) {
    const version = readMcpPackageVersion(packageRoot);
    if (version) return version;
  }
  return null;
}

function isMcpProcessCommand(command) {
  const raw = String(command || '');
  const args = (raw.includes('\0') ? raw.split('\0') : raw.trim().split(/\s+/)).filter(Boolean);
  if (!args.length) return false;

  const executable = path.basename(args[0]);
  if (new Set(['bash', 'bwrap', 'dash', 'fish', 'sh', 'zsh']).has(executable)) return false;
  if (executable === 'marrow-mcp') return true;

  if (executable === 'node'
    && args[1]
    && /(?:^|\/)node_modules\/(?:@getmarrow\/mcp(?:\/|$)|\.bin\/marrow-mcp$)/.test(args[1])) {
    return true;
  }

  const packageManagers = new Set(['bun', 'bunx', 'npm', 'npm-cli.js', 'npx', 'npx-cli.js', 'pnpm', 'pnpx', 'yarn']);
  const runner = executable === 'node' && args[1] ? path.basename(args[1]) : executable;
  return packageManagers.has(runner)
    && args.some((arg) => /^(?:--package=)?@getmarrow\/mcp(?:@[^\s]+)?$/.test(arg));
}

function readLinuxProcessCommands(procRoot = '/proc') {
  if (process.platform !== 'linux') return [];
  try {
    return fs.readdirSync(procRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => {
        try {
          return fs.readFileSync(path.join(procRoot, entry.name, 'cmdline'), 'utf8');
        } catch {
          return '';
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function inspectMcpProcesses(options = {}) {
  const commands = Array.isArray(options.commands)
    ? options.commands.map(String)
    : readLinuxProcessCommands(options.procRoot);
  const active = commands
    .filter(isMcpProcessCommand)
    .map((command) => explicitMcpVersion(command) || packageMcpVersion(command) || 'unknown');
  const versions = [...new Set(active.filter((version) => version !== 'unknown'))].sort();
  const expectedVersion = compatibleMcpTargetVersion(options.expectedVersion)
    ? options.expectedVersion
    : resolveMcpTargetVersion({ currentVersions: versions }).version;
  const unknownVersionProcesses = active.filter((version) => version === 'unknown').length;
  const staleVersions = versions.filter((version) => version !== expectedVersion);
  const mixedVersions = versions.length > 1 || (versions.length > 0 && unknownVersionProcesses > 0);
  const stale = staleVersions.length > 0;
  const needsRepair = stale || mixedVersions || unknownVersionProcesses > 0;
  const repairCommand = `npx -y --package=@getmarrow/mcp@${expectedVersion} marrow-mcp setup`;
  return {
    available: process.platform === 'linux' || Array.isArray(options.commands),
    expected_version: expectedVersion,
    active_processes: active.length,
    active_versions: versions,
    unknown_version_processes: unknownVersionProcesses,
    stale_versions: staleVersions,
    mixed_versions: mixedVersions,
    healthy: !needsRepair,
    exact_fix: needsRepair ? repairCommand : null,
    restart_required: needsRepair,
    restart_instruction: needsRepair ? 'Restart every owning harness to replace its active Marrow MCP process.' : null,
    verification_command: needsRepair ? 'npx -y @getmarrow/install@latest doctor --self-test' : null,
  };
}

function inspectMcpConfigurations(detection, options = {}) {
  const home = options.home || process.env.HOME || process.env.USERPROFILE || os.homedir();
  const configuredPaths = Array.isArray(options.paths) ? options.paths : [
    detection?.paths?.claudeSettings,
    detection?.paths?.cursorMcp,
    detection?.paths?.mcpJson,
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.claude.json'),
    path.join(home, '.cursor', 'mcp.json'),
    path.join(home, '.mcp.json'),
  ];
  const versions = [];
  let filesChecked = 0;
  let configurationsFound = 0;
  let unknownVersionConfigurations = 0;
  for (const filePath of [...new Set(configuredPaths.filter(Boolean).map((entry) => path.resolve(String(entry))))]) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) continue;
      filesChecked += 1;
      const raw = fs.readFileSync(filePath, 'utf8');
      const specs = [...raw.matchAll(/@getmarrow\/mcp@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g)]
        .map((match) => match[1]);
      if (/@getmarrow\/mcp(?:@|["'\s])/.test(raw)) {
        configurationsFound += 1;
        if (specs.length === 0) unknownVersionConfigurations += 1;
      }
      versions.push(...specs);
    } catch {
      // Doctor remains read-only and ignores inaccessible or malformed owner configuration.
    }
  }
  const configuredVersions = [...new Set(versions)].sort();
  const expectedVersion = compatibleMcpTargetVersion(options.expectedVersion)
    ? options.expectedVersion
    : resolveMcpTargetVersion({ currentVersions: configuredVersions }).version;
  const staleVersions = configuredVersions.filter((version) => version !== expectedVersion);
  const mixedVersions = configuredVersions.length > 1
    || (configuredVersions.length > 0 && unknownVersionConfigurations > 0);
  const healthy = staleVersions.length === 0 && !mixedVersions && unknownVersionConfigurations === 0;
  return {
    expected_version: expectedVersion,
    files_checked: filesChecked,
    configurations_found: configurationsFound,
    configured_versions: configuredVersions,
    unknown_version_configurations: unknownVersionConfigurations,
    stale_versions: staleVersions,
    mixed_versions: mixedVersions,
    healthy,
    exact_fix: healthy ? null : `Run npx -y --package=@getmarrow/mcp@${expectedVersion} marrow-mcp setup in each owning workspace, update its MCP launch to npx -y --package=@getmarrow/mcp@${expectedVersion} marrow-mcp, then restart that harness.`,
    verification_command: healthy ? null : 'npx -y @getmarrow/install@latest doctor --self-test',
  };
}

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
    mcp: 'mcp',
    ci: 'ci',
    'github-actions': 'ci',
  };
  return aliases[raw] || (SOURCE_CLIENTS.has(raw) ? raw : 'custom');
}

function parseArgs(argv, env = process.env) {
  const options = {
    cwd: process.cwd(),
    yes: false,
    dryRun: false,
    doctor: false,
    repair: false,
    mode: 'auto',
    apiKey: env.MARROW_API_KEY || '',
    baseUrl: env.MARROW_BASE_URL || DEFAULT_BASE_URL,
    agentId: env.MARROW_FLEET_AGENT_ID || env.MARROW_AGENT_ID || '',
    toolProfile: resolveToolProfile(env.MARROW_TOOL_PROFILE),
    selfTest: true,
    selfTestExplicitlyDisabled: false,
    json: false,
    activate: false,
    controller: true,
  };
  let explicitOperation = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === 'activate' || arg === '--activate') {
      explicitOperation = true;
      options.activate = true;
      options.yes = true;
      options.selfTest = true;
    }
    else if (arg === '--yes' || arg === '-y') {
      explicitOperation = true;
      options.yes = true;
    }
    else if (arg === '--repair' || arg === 'repair' || arg === 'update' || arg === '--update') {
      explicitOperation = true;
      options.repair = true;
      options.yes = true;
      options.update = true;
    }
    else if (arg === '--dry-run') {
      explicitOperation = true;
      options.dryRun = true;
    }
    else if (arg === '--doctor' || arg === 'doctor' || arg === 'check') {
      explicitOperation = true;
      options.doctor = true;
    }
    else if (arg === '--json') options.json = true;
    else if (arg === '--no-self-test') {
      explicitOperation = true;
      options.selfTest = false;
      options.selfTestExplicitlyDisabled = true;
    }
    else if (arg === '--no-controller') options.controller = false;
    else if (arg === '--self-test') options.selfTest = true;
    else if (arg === '--cwd') options.cwd = path.resolve(argv[++i] || options.cwd);
    else if (arg === '--mode') {
      explicitOperation = true;
      options.mode = argv[++i] || options.mode;
    }
    else if (arg === '--key') {
      options.apiKey = argv[++i] || options.apiKey;
      options.keyFromArg = true;
    }
    else if (arg === '--base-url') options.baseUrl = argv[++i] || options.baseUrl;
    else if (arg === '--agent-id') options.agentId = argv[++i] || options.agentId;
    else if (arg === '--mcp') {
      explicitOperation = true;
      options.mode = 'mcp';
    }
    else if (arg === '--sdk') {
      explicitOperation = true;
      options.mode = 'sdk';
    }
    else if (arg === '--md' || arg === '--instructions') {
      explicitOperation = true;
      options.mode = 'md';
    }
    else if (arg === '--both') {
      explicitOperation = true;
      options.mode = 'both';
    }
    else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!['auto', 'mcp', 'sdk', 'both', 'md'].includes(options.mode)) {
    throw new Error('--mode must be one of auto, mcp, sdk, both, md');
  }
  if (!explicitOperation) {
    options.activate = true;
    options.yes = true;
    options.selfTest = true;
  }
  if (options.dryRun) options.selfTest = false;
  if (options.activate && options.selfTestExplicitlyDisabled) {
    throw new Error('activate cannot be combined with --no-self-test because server verification is required');
  }
  if (options.activate && options.dryRun) {
    throw new Error('activate cannot be combined with --dry-run; use --dry-run without activate to preview changes');
  }
  options.resolveMcpRegistry = Boolean(options.doctor || options.repair || options.update);

  return options;
}

function usage() {
  return `Usage:
  npx @getmarrow/install
  npx @getmarrow/install --dry-run
  npx @getmarrow/install activate
  npx @getmarrow/install --yes
  npx @getmarrow/install --repair
  npx @getmarrow/install update
  npx @getmarrow/install doctor
  npx @getmarrow/install --mcp --yes
  npx @getmarrow/install --sdk --yes

Options:
  (no command)       Detect, install, self-test, and start the supported persistent controller
  activate           Detect, install, self-test, and return a server-confirmed activation receipt
  --dry-run          Print planned changes without writing
  --doctor           Check install health without writing
  --repair           Write missing hooks/config, then run self-test and status check
  update             Same as --repair: refresh exact MCP/SDK/install package pins after owner approval
  --yes, -y          Write detected config files
  --mode <mode>      auto, mcp, sdk, both, or md
  --key <key>        Marrow API key for self-test. Prefer MARROW_API_KEY because CLI args can appear in process listings.
  --base-url <url>   Marrow API base URL
  --agent-id <id>    Agent/fleet id for self-test headers
  --no-controller    Do not start the local background controller during install/repair
  --no-self-test     Skip API smoke/self-test

Environment:
  MARROW_TOOL_PROFILE  Leave unset for primary (17 tools), or explicitly set primary, core, or full.
                       Visibility never grants entitlement; backend plans and permissions authorize calls.
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
  if (detection.cline) return 'cline';
  if (detection.windsurf) return 'windsurf';
  if (detection.gemini) return 'gemini';
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
    codexHooks: path.join(root, '.codex', 'hooks.json'),
    cursorHooks: path.join(root, '.cursor', 'hooks.json'),
    windsurfHooks: path.join(root, '.windsurf', 'hooks.json'),
    geminiSettings: path.join(root, '.gemini', 'settings.json'),
    grokHooks: path.join(home, '.grok', 'hooks', 'marrow.json'),
    clinePreToolUseHook: path.join(root, '.clinerules', 'hooks', 'PreToolUse'),
    clinePostToolUseHook: path.join(root, '.clinerules', 'hooks', 'PostToolUse'),
    clineTaskCancelHook: path.join(root, '.clinerules', 'hooks', 'TaskCancel'),
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
    cline: exists(path.join(root, '.clinerules')),
    windsurf: exists(path.join(root, '.windsurf')),
    gemini: exists(path.join(root, '.gemini')),
    grok: exists(path.join(home, '.grok')) || exists(path.join(root, '.grok')),
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
    home,
    openclawEnv: path.join(home, '.openclaw', '.env'),
    credentialFile: path.join(home, '.openclaw', 'credentials', 'npm-getmarrow-token.txt'),
    npmrc: path.join(home, '.npmrc'),
  };
}

function inspectNpmTokenConfig(env = process.env) {
  const paths = npmTokenPaths(env);
  const openclawToken = readEnvVar(paths.openclawEnv, 'NPM_TOKEN');
  const credentialToken = readFirstLineSecret(paths.credentialFile);
  let npmrcToken = '';
  let unsafeNpmrcPath = false;
  try {
    assertDirectOwnerFile(paths.home, paths.npmrc, { allowMissing: true });
    npmrcToken = readNpmrcToken(paths.npmrc);
  } catch {
    unsafeNpmrcPath = true;
  }
  const sourceToken = openclawToken || credentialToken;
  const mismatch = Boolean(sourceToken && npmrcToken && fingerprint(sourceToken) !== fingerprint(npmrcToken));
  const missingNpmrcToken = Boolean(sourceToken && !npmrcToken);

  return {
    safe: {
      npm_token: {
        checked: true,
        repairable: Boolean(sourceToken && (mismatch || missingNpmrcToken) && !unsafeNpmrcPath),
        mismatch,
        missing_npmrc_token: missingNpmrcToken,
        unsafe_path: unsafeNpmrcPath,
        sources: {
          openclaw_env: { path: paths.openclawEnv, present: Boolean(openclawToken), fingerprint: fingerprint(openclawToken) },
          credential_file: { path: paths.credentialFile, present: Boolean(credentialToken), fingerprint: fingerprint(credentialToken) },
          npmrc: { path: paths.npmrc, present: Boolean(npmrcToken), fingerprint: fingerprint(npmrcToken) },
        },
        recommended_fix: unsafeNpmrcPath
          ? 'Refusing automatic npm token repair because ~/.npmrc or its home directory is not a direct, regular owner path.'
          : mismatch || missingNpmrcToken
          ? 'Run npx @getmarrow/install --repair to sync ~/.npmrc from the active OpenClaw/getmarrow npm token source.'
          : null,
      },
    },
    raw: { paths, sourceToken, npmrcToken },
  };
}

function assertDirectOwnerFile(homePath, filePath, { allowMissing = false } = {}) {
  const home = path.resolve(homePath);
  const target = path.resolve(filePath);
  if (target !== path.join(home, '.npmrc')) throw new Error('npm token repair target must be the direct owner ~/.npmrc');
  if (!fs.existsSync(home)) throw new Error('npm token repair owner home does not exist');
  const homeStat = fs.lstatSync(home);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink() || fs.realpathSync(home) !== home) {
    throw new Error('npm token repair owner home must be a direct, non-symbolic directory');
  }
  if (!fs.existsSync(target)) {
    if (allowMissing) return;
    throw new Error('npm token repair target does not exist');
  }
  const targetStat = fs.lstatSync(target);
  if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
    throw new Error('npm token repair target must be a regular file, not a symbolic link');
  }
}

function atomicWriteOwnerFile(homePath, filePath, contents) {
  const home = path.resolve(homePath);
  const target = path.resolve(filePath);
  const allowMissing = !fs.existsSync(target);
  assertDirectOwnerFile(home, target, { allowMissing });
  const tempPath = path.join(home, `.npmrc.marrow-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, contents, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    assertDirectOwnerFile(home, target, { allowMissing });
    fs.renameSync(tempPath, target);
    fs.chmodSync(target, 0o600);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

function upsertNpmrcToken(homePath, filePath, token) {
  assertDirectOwnerFile(homePath, filePath, { allowMissing: true });
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
    if (before) {
      const backupPath = `${filePath}.marrow-backup`;
      if (fs.existsSync(backupPath) && fs.lstatSync(backupPath).isSymbolicLink()) {
        throw new Error('npm token repair backup must not be a symbolic link');
      }
      const backupTemp = path.join(path.resolve(homePath), `.npmrc.marrow-backup-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
      fs.writeFileSync(backupTemp, before, { mode: 0o600, flag: 'wx' });
      fs.renameSync(backupTemp, backupPath);
      fs.chmodSync(backupPath, 0o600);
    }
    atomicWriteOwnerFile(homePath, filePath, after);
  }
  return before !== after;
}

function repairConfigDiagnostics(diagnostics, env = process.env) {
  const inspection = inspectNpmTokenConfig(env);
  const npm = diagnostics.npm_token;
  const repairs = [];
  if (npm?.repairable && inspection.raw.sourceToken) {
    const changed = upsertNpmrcToken(inspection.raw.paths.home, inspection.raw.paths.npmrc, inspection.raw.sourceToken);
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

- Use MCP plus these instructions in every workspace: \`npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp setup\`.
- Leave \`MARROW_TOOL_PROFILE\` unset for the 17-tool primary surface. Set \`MARROW_TOOL_PROFILE=core\` or \`MARROW_TOOL_PROFILE=full\` only as an explicit opt-in; backend plans and permissions still enforce access to every visible tool.
- Use SDK passive runtime in owned Node processes: \`createPassiveRuntime().install()\`.
- Native Claude hooks install only when \`.claude\` is present. Codex native hooks install into \`.codex/hooks.json\`; Cursor and Composer use \`.cursor/hooks.json\`; Cline uses non-overwriting executable files under \`.clinerules/hooks/\`; Windsurf uses \`.windsurf/hooks.json\`; Gemini CLI uses \`.gemini/settings.json\`; Grok uses trusted global \`~/.grok/hooks/marrow.json\`. Restart the host, enable/review hooks, disable Windsurf Restricted Mode where native hooks are required, and trust the workspace before claiming runtime coverage. The governed wrapper remains an explicit bounded fallback. Hermes, OpenClaw, and custom hosts need a bounded event adapter.
- Keep passive token/model usage proof enabled. Empty savings stay zero until observed model usage lands. Do not invent token, cost, or time savings.
- Before risky work, use Marrow's decision brief or passive prompt hook.
- After activate writes MCP or hooks, restart this harness, then run \`npx @getmarrow/install@latest doctor --self-test\`. Do not claim Marrow is live in a process that has not reloaded.
- First turn: tell the owner the gate is live and empty savings are honest. The next deploy, merge, or publish must go through Marrow.
- Cursor and Composer use configured native hooks after restart and \`/hooks\` trust review. Cline uses its configured PreToolUse, PostToolUse, and TaskCancel hooks only after Enable Hooks, restart, executable trust, and workspace trust; TaskComplete is not claimed as current coverage. Windsurf uses configured native pre-action, success-result, and response-closeout hooks only after restart, trust review, and leaving Restricted Mode. Gemini CLI uses configured BeforeTool, AfterTool, and AfterAgent hooks only after restart and project fingerprint review and approval in \`/hooks panel\`; explicit user disablement is preserved. Grok uses global native PreToolUse, PostToolUse/PostToolUseFailure, and one nonblocking Stop closeout only after restart and \`/hooks\` inspection; Grok hooks remain user-toggleable. MCP tools remain on demand. Codex uses configured native hooks after restart and \`/hooks\` trust review. The governed wrapper remains an explicit bounded fallback.
- Before the session ends, close open work with session-end auto-commit or \`marrow_commit\`. Record model usage only when the host response includes counts.
- After meaningful work, record the outcome so future agents learn from it.
- After Marrow blocks, warns, or requires review, use the decision trace receipt to tell the operator what changed and which recorded workflow or proof is required. Stay quiet for routine low-risk work.
- Check health with \`marrow_agent_status\` or \`GET /v1/agent/status\`.
- When status/runtime returns a \`client_update\` notice, tell the operator and use its exact update and verification commands only when local change policy permits.

Required environment:

- \`MARROW_API_KEY\`
- Optional: \`MARROW_BASE_URL\`, \`MARROW_FLEET_AGENT_ID\`, \`MARROW_CLIENT\`
- Optional: \`MARROW_PASSIVE_TOKEN_USAGE=false\` disables compact provider usage capture when needed.
${MARROW_BLOCK_END}`;
}

function passiveRuntimeSource(options = {}) {
  const installedAgentId = String(options.agentId || '').trim();
  const installedBaseUrl = String(options.baseUrl || DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
  return `const apiKey = process.env.MARROW_API_KEY;
const installedAgentId = ${JSON.stringify(installedAgentId)};
const installedBaseUrl = ${JSON.stringify(installedBaseUrl)};
if (apiKey && !globalThis.__MARROW_PASSIVE_RUNTIME__) {
  try {
    const { MarrowClient } = await import('@getmarrow/sdk');
    const marrow = new MarrowClient(apiKey, {
      baseUrl: installedBaseUrl,
      agentId: process.env.MARROW_FLEET_AGENT_ID || process.env.MARROW_AGENT_ID || installedAgentId,
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

function envExample(options = {}) {
  const agentId = String(options.agentId || 'agent-or-fleet-id').trim() || 'agent-or-fleet-id';
  const client = String(options.client || 'custom').trim() || 'custom';
  const baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
  return `MARROW_API_KEY=mrw_live_replace_me
MARROW_BASE_URL=${JSON.stringify(baseUrl)}
MARROW_FLEET_AGENT_ID=${JSON.stringify(agentId)}
MARROW_CLIENT=${JSON.stringify(client)}
# MARROW_TOOL_PROFILE is intentionally unset: ordinary setup uses primary. Set core or full only as an explicit opt-in.
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

function marrowHookSubcommand(command) {
  if (typeof command !== 'string') return null;
  const match = command.trim().match(
    /^npx\s+(?:-y\s+)?(?:--package=@getmarrow\/mcp(?:@[^\s]+)?\s+marrow-mcp|@getmarrow\/mcp(?:@[^\s]+)?)\s+(?:(?:claude|codex|cursor|grok)-)?(context-hook|pre-action-hook|hook|session-hook)$/,
  );
  return match?.[1] || null;
}

function reconcileMarrowCommandHook(settings, eventName, subcommand, command, matcher, handlerOptions = {}) {
  const original = Array.isArray(settings?.hooks?.[eventName]) ? settings.hooks[eventName] : [];
  let preferredHandler = null;
  const retained = [];
  for (const entry of original) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Array.isArray(entry.hooks)) {
      retained.push(entry);
      continue;
    }
    const remaining = [];
    for (const hook of entry.hooks) {
      const detected = hook && typeof hook === 'object' && !Array.isArray(hook)
        && hook.type === 'command' ? marrowHookSubcommand(hook.command) : null;
      if (detected) {
        const exactMatcher = matcher == null ? entry.matcher === undefined : entry.matcher === matcher;
        if (detected === subcommand && (!preferredHandler || (hook.command === command && exactMatcher))) {
          preferredHandler = hook;
        }
        continue;
      }
      remaining.push(hook);
    }
    if (remaining.length > 0) retained.push({ ...entry, hooks: remaining });
  }
  const canonical = { hooks: [{ ...(preferredHandler || {}), ...handlerOptions, type: 'command', command }] };
  if (matcher != null) canonical.matcher = matcher;
  retained.push(canonical);
  return retained;
}

function marrowHookDescriptors(settings, eventName, subcommand) {
  const entries = settings?.hooks?.[eventName];
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Array.isArray(entry.hooks)) return [];
    return entry.hooks.flatMap((hook) => {
      if (!hook || typeof hook !== 'object' || Array.isArray(hook)
        || hook.type !== 'command') return [];
      const detected = marrowHookSubcommand(hook.command);
      if (!detected || (subcommand && detected !== subcommand)) return [];
      return [{
        matcher: typeof entry.matcher === 'string' ? entry.matcher : null,
        command: hook.command.trim(),
        timeout: typeof hook.timeout === 'number' && Number.isFinite(hook.timeout) ? hook.timeout : null,
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
    active_marrow_handlers: {
      prompt: marrowHookDescriptors(settings, 'UserPromptSubmit'),
      pre_action: marrowHookDescriptors(settings, 'PreToolUse'),
      action_result_success: marrowHookDescriptors(settings, 'PostToolUse'),
      action_result_failure: marrowHookDescriptors(settings, 'PostToolUseFailure'),
      session_end: marrowHookDescriptors(settings, 'Stop'),
    },
  };
  return crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

function upsertClaudeHooks(settingsPath) {
  const settings = parseJsonObject(settingsPath);
  const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? settings.hooks
    : {};
  const postToolUse = reconcileMarrowCommandHook(
    settings, 'PostToolUse', 'hook', MCP_ACTION_RESULT_HOOK_COMMAND, NATIVE_HOOK_MATCHER,
  );
  const postToolUseFailure = reconcileMarrowCommandHook(
    settings, 'PostToolUseFailure', 'hook', MCP_ACTION_RESULT_HOOK_COMMAND, NATIVE_HOOK_MATCHER,
  );
  const preToolUse = reconcileMarrowCommandHook(
    settings, 'PreToolUse', 'pre-action-hook', MCP_PRE_ACTION_HOOK_COMMAND, NATIVE_HOOK_MATCHER,
  );
  const userPromptSubmit = reconcileMarrowCommandHook(
    settings, 'UserPromptSubmit', 'context-hook', MCP_CONTEXT_HOOK_COMMAND,
  );
  const stop = reconcileMarrowCommandHook(
    settings, 'Stop', 'session-hook', MCP_SESSION_END_HOOK_COMMAND,
  );

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

function codexNativeHookFingerprint(settings) {
  const contract = {
    schema: 'marrow-codex-native-hooks.v1',
    adapter_version: MCP_ADAPTER_VERSION,
    expected_hooks: NATIVE_EXPECTED_HOOKS,
    configured: {
      prompt: exactHookConfigured(settings, 'UserPromptSubmit', CODEX_CONTEXT_HOOK_COMMAND),
      pre_action: exactHookConfigured(settings, 'PreToolUse', CODEX_PRE_ACTION_HOOK_COMMAND, CODEX_NATIVE_HOOK_MATCHER),
      action_result: exactHookConfigured(settings, 'PostToolUse', CODEX_ACTION_RESULT_HOOK_COMMAND, CODEX_NATIVE_HOOK_MATCHER),
      session_end: exactHookConfigured(settings, 'SessionEnd', CODEX_SESSION_END_HOOK_COMMAND),
    },
    descriptors: {
      prompt: exactHookDescriptors(settings, 'UserPromptSubmit', CODEX_CONTEXT_HOOK_COMMAND),
      pre_action: exactHookDescriptors(settings, 'PreToolUse', CODEX_PRE_ACTION_HOOK_COMMAND, CODEX_NATIVE_HOOK_MATCHER),
      action_result: exactHookDescriptors(settings, 'PostToolUse', CODEX_ACTION_RESULT_HOOK_COMMAND, CODEX_NATIVE_HOOK_MATCHER),
      session_end: exactHookDescriptors(settings, 'SessionEnd', CODEX_SESSION_END_HOOK_COMMAND),
    },
    active_marrow_handlers: {
      prompt: marrowHookDescriptors(settings, 'UserPromptSubmit'),
      pre_action: marrowHookDescriptors(settings, 'PreToolUse'),
      action_result: marrowHookDescriptors(settings, 'PostToolUse'),
      session_end: marrowHookDescriptors(settings, 'SessionEnd'),
    },
  };
  return crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

function upsertCodexHooks(hooksPath) {
  const settings = parseJsonObject(hooksPath);
  const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? settings.hooks
    : {};
  settings.hooks = {
    ...hooks,
    UserPromptSubmit: reconcileMarrowCommandHook(
      settings, 'UserPromptSubmit', 'context-hook', CODEX_CONTEXT_HOOK_COMMAND, undefined,
      { timeout: CODEX_HOOK_TIMEOUT_SECONDS },
    ),
    PreToolUse: reconcileMarrowCommandHook(
      settings, 'PreToolUse', 'pre-action-hook', CODEX_PRE_ACTION_HOOK_COMMAND, CODEX_NATIVE_HOOK_MATCHER,
      { timeout: CODEX_HOOK_TIMEOUT_SECONDS, async: false },
    ),
    PostToolUse: reconcileMarrowCommandHook(
      settings, 'PostToolUse', 'hook', CODEX_ACTION_RESULT_HOOK_COMMAND, CODEX_NATIVE_HOOK_MATCHER,
      { timeout: CODEX_HOOK_TIMEOUT_SECONDS },
    ),
    SessionEnd: reconcileMarrowCommandHook(
      settings, 'SessionEnd', 'session-hook', CODEX_SESSION_END_HOOK_COMMAND, undefined,
      { timeout: CODEX_SESSION_TIMEOUT_SECONDS },
    ),
  };
  return JSON.stringify(settings, null, 2) + '\n';
}

function reconcileCursorHook(settings, eventName, subcommand, canonical) {
  const original = Array.isArray(settings?.hooks?.[eventName]) ? settings.hooks[eventName] : [];
  const retained = original.filter((entry) => !(
    entry && typeof entry === 'object' && !Array.isArray(entry)
    && marrowHookSubcommand(entry.command)
  ));
  return [...retained, canonical];
}

function exactCursorHookConfigured(settings, eventName, command, matcher, required = {}) {
  const entries = settings?.hooks?.[eventName];
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => entry && typeof entry === 'object' && !Array.isArray(entry)
    && entry.command === command
    && (matcher === undefined ? entry.matcher === undefined : entry.matcher === matcher)
    && Object.entries(required).every(([key, value]) => entry[key] === value));
}

function cursorHookDescriptors(settings, eventName) {
  const entries = settings?.hooks?.[eventName];
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !marrowHookSubcommand(entry.command)) return [];
    return [{
      matcher: typeof entry.matcher === 'string' ? entry.matcher : null,
      command: String(entry.command).trim(),
      timeout: typeof entry.timeout === 'number' && Number.isFinite(entry.timeout) ? entry.timeout : null,
      failClosed: entry.failClosed === true,
      async: entry.async === false ? false : null,
    }];
  });
}

function cursorNativeHookFingerprint(settings) {
  const contract = {
    schema: 'marrow-cursor-native-hooks.v1',
    adapter_version: MCP_ADAPTER_VERSION,
    expected_hooks: ['pre_action', 'action_result', 'outcome_closure'],
    configured: {
      pre_action: exactCursorHookConfigured(settings, 'preToolUse', CURSOR_PRE_ACTION_HOOK_COMMAND, CURSOR_NATIVE_HOOK_MATCHER, {
        timeout: CODEX_HOOK_TIMEOUT_SECONDS,
        failClosed: true,
        async: false,
      }),
      action_result_success: exactCursorHookConfigured(settings, 'postToolUse', CURSOR_ACTION_RESULT_HOOK_COMMAND, CURSOR_NATIVE_HOOK_MATCHER, {
        timeout: CODEX_HOOK_TIMEOUT_SECONDS,
      }),
      action_result_failure: exactCursorHookConfigured(settings, 'postToolUseFailure', CURSOR_ACTION_RESULT_HOOK_COMMAND, CURSOR_NATIVE_HOOK_MATCHER, {
        timeout: CODEX_HOOK_TIMEOUT_SECONDS,
      }),
      outcome_closure: exactCursorHookConfigured(settings, 'stop', CURSOR_SESSION_END_HOOK_COMMAND, undefined, {
        timeout: CODEX_SESSION_TIMEOUT_SECONDS,
      }),
    },
    descriptors: {
      pre_action: cursorHookDescriptors(settings, 'preToolUse'),
      action_result_success: cursorHookDescriptors(settings, 'postToolUse'),
      action_result_failure: cursorHookDescriptors(settings, 'postToolUseFailure'),
      outcome_closure: cursorHookDescriptors(settings, 'stop'),
    },
  };
  return crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

function upsertCursorHooks(hooksPath) {
  const settings = parseJsonObject(hooksPath);
  const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? settings.hooks
    : {};
  settings.version = 1;
  settings.hooks = {
    ...hooks,
    preToolUse: reconcileCursorHook(settings, 'preToolUse', 'pre-action-hook', {
      command: CURSOR_PRE_ACTION_HOOK_COMMAND,
      matcher: CURSOR_NATIVE_HOOK_MATCHER,
      timeout: CODEX_HOOK_TIMEOUT_SECONDS,
      failClosed: true,
      async: false,
    }),
    postToolUse: reconcileCursorHook(settings, 'postToolUse', 'hook', {
      command: CURSOR_ACTION_RESULT_HOOK_COMMAND,
      matcher: CURSOR_NATIVE_HOOK_MATCHER,
      timeout: CODEX_HOOK_TIMEOUT_SECONDS,
    }),
    postToolUseFailure: reconcileCursorHook(settings, 'postToolUseFailure', 'hook', {
      command: CURSOR_ACTION_RESULT_HOOK_COMMAND,
      matcher: CURSOR_NATIVE_HOOK_MATCHER,
      timeout: CODEX_HOOK_TIMEOUT_SECONDS,
    }),
    stop: reconcileCursorHook(settings, 'stop', 'session-hook', {
      command: CURSOR_SESSION_END_HOOK_COMMAND,
      timeout: CODEX_SESSION_TIMEOUT_SECONDS,
    }),
  };
  return JSON.stringify(settings, null, 2) + '\n';
}

const WINDSURF_PRE_EVENTS = ['pre_write_code', 'pre_run_command', 'pre_mcp_tool_use'];
const WINDSURF_POST_EVENTS = ['post_write_code', 'post_run_command', 'post_mcp_tool_use'];

function windsurfMarrowHookEntrypoint(command) {
  if (typeof command !== 'string') return null;
  const match = command.match(/@getmarrow\/mcp(?:@[^\s]+)?\s+marrow-mcp\s+windsurf-(pre-action-hook|hook|session-hook)(?:\s|['"]|$)/);
  return match?.[1] || null;
}

function reconcileWindsurfHook(settings, eventName, command) {
  const original = Array.isArray(settings?.hooks?.[eventName]) ? settings.hooks[eventName] : [];
  const retained = original.filter((entry) => !(
    entry && typeof entry === 'object' && !Array.isArray(entry)
    && windsurfMarrowHookEntrypoint(entry.command)
  ));
  return [...retained, { command, show_output: false }];
}

function exactWindsurfHookConfigured(settings, eventName, command) {
  const entries = settings?.hooks?.[eventName];
  return Array.isArray(entries) && entries.some((entry) => (
    entry && typeof entry === 'object' && !Array.isArray(entry)
    && entry.command === command
    && entry.show_output === false
  ));
}

function windsurfNativeHookFingerprint(settings) {
  const configured = Object.fromEntries([
    ...WINDSURF_PRE_EVENTS.map((event) => [event, exactWindsurfHookConfigured(settings, event, WINDSURF_PRE_ACTION_HOOK_COMMAND)]),
    ...WINDSURF_POST_EVENTS.map((event) => [event, exactWindsurfHookConfigured(settings, event, WINDSURF_ACTION_RESULT_HOOK_COMMAND)]),
    ['post_cascade_response', exactWindsurfHookConfigured(settings, 'post_cascade_response', WINDSURF_SESSION_END_HOOK_COMMAND)],
  ]);
  return crypto.createHash('sha256').update(JSON.stringify({
    schema: 'marrow-windsurf-native-hooks.v1',
    adapter_version: MCP_ADAPTER_VERSION,
    expected_hooks: ['pre_action', 'action_result', 'response_closeout'],
    restricted_mode_disables_hooks: true,
    configured,
  })).digest('hex');
}

function upsertWindsurfHooks(hooksPath) {
  const settings = parseJsonObject(hooksPath);
  const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? settings.hooks
    : {};
  settings.hooks = { ...hooks };
  for (const eventName of WINDSURF_PRE_EVENTS) {
    settings.hooks[eventName] = reconcileWindsurfHook(
      settings, eventName, WINDSURF_PRE_ACTION_HOOK_COMMAND,
    );
  }
  for (const eventName of WINDSURF_POST_EVENTS) {
    settings.hooks[eventName] = reconcileWindsurfHook(
      settings, eventName, WINDSURF_ACTION_RESULT_HOOK_COMMAND,
    );
  }
  settings.hooks.post_cascade_response = reconcileWindsurfHook(
    settings, 'post_cascade_response', WINDSURF_SESSION_END_HOOK_COMMAND,
  );
  return JSON.stringify(settings, null, 2) + '\n';
}

function geminiMarrowHookEntrypoint(command) {
  if (typeof command !== 'string') return null;
  const match = command.match(/@getmarrow\/mcp(?:@[^\s]+)?\s+marrow-mcp\s+gemini-(pre-action-hook|hook|session-hook)(?:\s|['"]|$)/);
  return match?.[1] || null;
}

function reconcileGeminiHook(settings, eventName, canonical) {
  const original = Array.isArray(settings?.hooks?.[eventName]) ? settings.hooks[eventName] : [];
  const retained = [];
  for (const group of original) {
    if (!group || typeof group !== 'object' || Array.isArray(group) || !Array.isArray(group.hooks)) {
      retained.push(group);
      continue;
    }
    const hooks = group.hooks.filter((handler) => !(
      handler && typeof handler === 'object' && !Array.isArray(handler)
      && (String(handler.name || '').startsWith('marrow-') || geminiMarrowHookEntrypoint(handler.command))
    ));
    if (hooks.length > 0) retained.push({ ...group, hooks });
  }
  return [...retained, canonical];
}

function exactGeminiHookConfigured(settings, eventName, name, command, matcher, timeout) {
  const groups = settings?.hooks?.[eventName];
  if (!Array.isArray(groups)) return false;
  return groups.some((group) => (
    group && typeof group === 'object' && !Array.isArray(group)
    && (matcher === undefined ? group.matcher === undefined : group.matcher === matcher)
    && Array.isArray(group.hooks)
    && group.hooks.some((handler) => (
      handler && typeof handler === 'object' && !Array.isArray(handler)
      && handler.name === name
      && handler.type === 'command'
      && handler.command === command
      && handler.timeout === timeout
    ))
  ));
}

function geminiHooksExplicitlyDisabled(settings) {
  return settings?.hooksConfig?.enabled === false;
}

function geminiNativeHookFingerprint(settings) {
  return crypto.createHash('sha256').update(JSON.stringify({
    schema: 'marrow-gemini-native-hooks.v1',
    adapter_version: MCP_ADAPTER_VERSION,
    expected_hooks: ['pre_action', 'action_result', 'turn_closeout'],
    explicitly_enabled: settings?.hooksConfig?.enabled === true,
    explicitly_disabled: geminiHooksExplicitlyDisabled(settings),
    configured: {
      pre_action: exactGeminiHookConfigured(
        settings, 'BeforeTool', 'marrow-before-tool', GEMINI_PRE_ACTION_HOOK_COMMAND,
        GEMINI_NATIVE_HOOK_MATCHER, GEMINI_HOOK_TIMEOUT_MS,
      ),
      action_result: exactGeminiHookConfigured(
        settings, 'AfterTool', 'marrow-after-tool', GEMINI_ACTION_RESULT_HOOK_COMMAND,
        GEMINI_NATIVE_HOOK_MATCHER, GEMINI_HOOK_TIMEOUT_MS,
      ),
      turn_closeout: exactGeminiHookConfigured(
        settings, 'AfterAgent', 'marrow-after-agent', GEMINI_SESSION_END_HOOK_COMMAND,
        undefined, GEMINI_CLOSEOUT_TIMEOUT_MS,
      ),
    },
    session_end_claimed: false,
  })).digest('hex');
}

function exactGrokHookConfigured(settings, eventName, command, matcher, timeout) {
  const entries = settings?.hooks?.[eventName];
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => (
    entry && typeof entry === 'object' && !Array.isArray(entry)
    && (matcher === undefined ? entry.matcher === undefined : entry.matcher === matcher)
    && Array.isArray(entry.hooks)
    && entry.hooks.some((handler) => (
      handler && typeof handler === 'object' && !Array.isArray(handler)
      && handler.type === 'command'
      && handler.command === command
      && handler.timeout === timeout
    ))
  ));
}

function grokHasDuplicateSessionEnd(settings) {
  const entries = settings?.hooks?.SessionEnd;
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => Array.isArray(entry?.hooks) && entry.hooks.some((handler) => (
    handler && typeof handler === 'object' && !Array.isArray(handler)
    && typeof handler.command === 'string'
    && /marrow-mcp\s+grok-session-hook(?:\s|['"]|$)/.test(handler.command)
  )));
}

function grokNativeHookFingerprint(settings) {
  return crypto.createHash('sha256').update(JSON.stringify({
    schema: 'marrow-grok-native-hooks.v1',
    adapter_version: MCP_ADAPTER_VERSION,
    expected_hooks: ['pre_action', 'action_result', 'turn_closeout'],
    configured: {
      context: exactGrokHookConfigured(settings, 'UserPromptSubmit', GROK_CONTEXT_HOOK_COMMAND, undefined, 5),
      pre_action: exactGrokHookConfigured(settings, 'PreToolUse', GROK_PRE_ACTION_HOOK_COMMAND, GROK_NATIVE_HOOK_MATCHER, 7),
      action_result_success: exactGrokHookConfigured(settings, 'PostToolUse', GROK_ACTION_RESULT_HOOK_COMMAND, GROK_NATIVE_HOOK_MATCHER, 5),
      action_result_failure: exactGrokHookConfigured(settings, 'PostToolUseFailure', GROK_ACTION_RESULT_HOOK_COMMAND, GROK_NATIVE_HOOK_MATCHER, 5),
      turn_closeout: exactGrokHookConfigured(settings, 'Stop', GROK_SESSION_END_HOOK_COMMAND, undefined, 3),
      duplicate_session_end: grokHasDuplicateSessionEnd(settings),
    },
  })).digest('hex');
}

function upsertGeminiHooks(settingsPath) {
  const settings = parseJsonObject(settingsPath);
  const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? settings.hooks
    : {};
  settings.hooks = {
    ...hooks,
    BeforeTool: reconcileGeminiHook(settings, 'BeforeTool', {
      matcher: GEMINI_NATIVE_HOOK_MATCHER,
      hooks: [{
        name: 'marrow-before-tool',
        type: 'command',
        command: GEMINI_PRE_ACTION_HOOK_COMMAND,
        timeout: GEMINI_HOOK_TIMEOUT_MS,
      }],
    }),
    AfterTool: reconcileGeminiHook(settings, 'AfterTool', {
      matcher: GEMINI_NATIVE_HOOK_MATCHER,
      hooks: [{
        name: 'marrow-after-tool',
        type: 'command',
        command: GEMINI_ACTION_RESULT_HOOK_COMMAND,
        timeout: GEMINI_HOOK_TIMEOUT_MS,
      }],
    }),
    AfterAgent: reconcileGeminiHook(settings, 'AfterAgent', {
      hooks: [{
        name: 'marrow-after-agent',
        type: 'command',
        command: GEMINI_SESSION_END_HOOK_COMMAND,
        timeout: GEMINI_CLOSEOUT_TIMEOUT_MS,
      }],
    }),
  };
  return JSON.stringify(settings, null, 2) + '\n';
}

function clinePreToolUseHookSource() {
  return `#!/bin/sh
output="$(npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp cline-pre-action-hook 2>/dev/null)" || output=""
if [ -n "$output" ]; then
  validated="$(printf '%s' "$output" | NODE_OPTIONS= node -e 'let s="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const v=JSON.parse(s);const keys=Object.keys(v).sort();const allow=v.cancel===false&&keys.length===1&&keys[0]==="cancel";const deny=v.cancel===true&&typeof v.errorMessage==="string"&&v.errorMessage.length>0&&v.errorMessage.length<=500&&keys.length===2&&keys[0]==="cancel"&&keys[1]==="errorMessage";if(!allow&&!deny)process.exit(1);process.stdout.write(JSON.stringify(v));}catch{process.exit(1);}});' 2>/dev/null)" || validated=""
  if [ -n "$validated" ]; then
    printf '%s\n' "$validated"
    exit 0
  fi
fi
printf '%s\n' '{"cancel":true,"errorMessage":"Marrow governance did not return a valid decision. Restore trusted configuration and retry."}'
exit 0
`;
}

function clineTelemetryHookSource(entrypoint) {
  return `#!/bin/sh
npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp ${entrypoint} >/dev/null 2>&1 || :
exit 0
`;
}

function clineHookContract(detection) {
  return [
    {
      stage: 'pre_action',
      path: detection.paths.clinePreToolUseHook,
      label: 'Cline PreToolUse native hook',
      content: clinePreToolUseHookSource(),
    },
    {
      stage: 'action_result',
      path: detection.paths.clinePostToolUseHook,
      label: 'Cline PostToolUse native hook',
      content: clineTelemetryHookSource('cline-hook'),
    },
    {
      stage: 'cancel_closeout',
      path: detection.paths.clineTaskCancelHook,
      label: 'Cline TaskCancel native hook',
      content: clineTelemetryHookSource('cline-session-hook'),
    },
  ];
}

function exactExecutableFile(filePath, content) {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o111) !== 0 && safeRead(filePath) === content;
  } catch {
    return false;
  }
}

function clineNativeHookFingerprint(detection) {
  const hooks = clineHookContract(detection).map((hook) => ({
    stage: hook.stage,
    configured: exactExecutableFile(hook.path, hook.content),
    content_sha256: exactExecutableFile(hook.path, hook.content)
      ? crypto.createHash('sha256').update(hook.content).digest('hex')
      : null,
  }));
  return crypto.createHash('sha256').update(JSON.stringify({
    schema: 'marrow-cline-native-hooks.v1',
    adapter_version: MCP_ADAPTER_VERSION,
    task_complete_support: 'coming_soon_not_configured',
    hooks,
  })).digest('hex');
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
  const mcpTargetVersion = compatibleMcpTargetVersion(plan.mcp_target_version)
    ? plan.mcp_target_version
    : MCP_ADAPTER_VERSION;
  const targetCommand = (command) => retargetMcpPackageSpec(command, mcpTargetVersion);
  const adapterVersion = capabilityLevel === 'native_hooks' || capabilityLevel === 'mcp'
    ? mcpTargetVersion
    : capabilityLevel === 'sdk_passive_runtime'
    ? SDK_ADAPTER_VERSION
    : INSTALLER_ADAPTER_VERSION;
  const observedHooks = [];
  const claudeSettings = safeJsonObject(detection.paths.claudeSettings);
  const codexSettings = safeJsonObject(detection.paths.codexHooks);
  const cursorSettings = safeJsonObject(detection.paths.cursorHooks);
  const windsurfSettings = safeJsonObject(detection.paths.windsurfHooks);
  const geminiSettings = safeJsonObject(detection.paths.geminiSettings);
  const grokSettings = safeJsonObject(detection.paths.grokHooks);
  if (client === 'codex') {
    if (exactHookConfigured(codexSettings, 'UserPromptSubmit', targetCommand(CODEX_CONTEXT_HOOK_COMMAND))) observedHooks.push('prompt');
    if (exactHookConfigured(codexSettings, 'PreToolUse', targetCommand(CODEX_PRE_ACTION_HOOK_COMMAND), CODEX_NATIVE_HOOK_MATCHER)) observedHooks.push('pre_action');
    if (exactHookConfigured(codexSettings, 'PostToolUse', targetCommand(CODEX_ACTION_RESULT_HOOK_COMMAND), CODEX_NATIVE_HOOK_MATCHER)) observedHooks.push('action_result');
    if (exactHookConfigured(codexSettings, 'SessionEnd', targetCommand(CODEX_SESSION_END_HOOK_COMMAND))) observedHooks.push('session_end');
  } else if (client === 'cursor' || client === 'composer') {
    if (exactCursorHookConfigured(cursorSettings, 'preToolUse', targetCommand(CURSOR_PRE_ACTION_HOOK_COMMAND), CURSOR_NATIVE_HOOK_MATCHER, {
      timeout: CODEX_HOOK_TIMEOUT_SECONDS, failClosed: true, async: false,
    })) observedHooks.push('pre_action');
    if (exactCursorHookConfigured(cursorSettings, 'postToolUse', targetCommand(CURSOR_ACTION_RESULT_HOOK_COMMAND), CURSOR_NATIVE_HOOK_MATCHER, {
      timeout: CODEX_HOOK_TIMEOUT_SECONDS,
    }) && exactCursorHookConfigured(cursorSettings, 'postToolUseFailure', targetCommand(CURSOR_ACTION_RESULT_HOOK_COMMAND), CURSOR_NATIVE_HOOK_MATCHER, {
      timeout: CODEX_HOOK_TIMEOUT_SECONDS,
    })) observedHooks.push('action_result');
    if (exactCursorHookConfigured(cursorSettings, 'stop', targetCommand(CURSOR_SESSION_END_HOOK_COMMAND), undefined, {
      timeout: CODEX_SESSION_TIMEOUT_SECONDS,
    })) observedHooks.push('outcome_closure');
  } else if (client === 'cline') {
    for (const hook of clineHookContract(detection)) {
      if (exactExecutableFile(hook.path, targetCommand(hook.content))) observedHooks.push(hook.stage);
    }
  } else if (client === 'windsurf') {
    if (WINDSURF_PRE_EVENTS.every((event) => exactWindsurfHookConfigured(
      windsurfSettings, event, targetCommand(WINDSURF_PRE_ACTION_HOOK_COMMAND),
    ))) observedHooks.push('pre_action');
    if (WINDSURF_POST_EVENTS.every((event) => exactWindsurfHookConfigured(
      windsurfSettings, event, targetCommand(WINDSURF_ACTION_RESULT_HOOK_COMMAND),
    ))) observedHooks.push('action_result');
    if (exactWindsurfHookConfigured(
      windsurfSettings, 'post_cascade_response', targetCommand(WINDSURF_SESSION_END_HOOK_COMMAND),
    )) observedHooks.push('response_closeout');
  } else if (client === 'gemini' && !geminiHooksExplicitlyDisabled(geminiSettings)) {
    if (exactGeminiHookConfigured(
      geminiSettings, 'BeforeTool', 'marrow-before-tool', targetCommand(GEMINI_PRE_ACTION_HOOK_COMMAND),
      GEMINI_NATIVE_HOOK_MATCHER, GEMINI_HOOK_TIMEOUT_MS,
    )) observedHooks.push('pre_action');
    if (exactGeminiHookConfigured(
      geminiSettings, 'AfterTool', 'marrow-after-tool', targetCommand(GEMINI_ACTION_RESULT_HOOK_COMMAND),
      GEMINI_NATIVE_HOOK_MATCHER, GEMINI_HOOK_TIMEOUT_MS,
    )) observedHooks.push('action_result');
    if (exactGeminiHookConfigured(
      geminiSettings, 'AfterAgent', 'marrow-after-agent', targetCommand(GEMINI_SESSION_END_HOOK_COMMAND),
      undefined, GEMINI_CLOSEOUT_TIMEOUT_MS,
    )) observedHooks.push('turn_closeout');
  } else if (client === 'grok') {
    if (exactGrokHookConfigured(
      grokSettings, 'PreToolUse', targetCommand(GROK_PRE_ACTION_HOOK_COMMAND), GROK_NATIVE_HOOK_MATCHER, 7,
    )) observedHooks.push('pre_action');
    if (exactGrokHookConfigured(
      grokSettings, 'PostToolUse', targetCommand(GROK_ACTION_RESULT_HOOK_COMMAND), GROK_NATIVE_HOOK_MATCHER, 5,
    ) && exactGrokHookConfigured(
      grokSettings, 'PostToolUseFailure', targetCommand(GROK_ACTION_RESULT_HOOK_COMMAND), GROK_NATIVE_HOOK_MATCHER, 5,
    )) observedHooks.push('action_result');
    if (exactGrokHookConfigured(
      grokSettings, 'Stop', targetCommand(GROK_SESSION_END_HOOK_COMMAND), undefined, 3,
    ) && !grokHasDuplicateSessionEnd(grokSettings)) observedHooks.push('turn_closeout');
  } else {
    if (capabilityLevel === 'native_hooks'
      && exactHookConfigured(claudeSettings, 'UserPromptSubmit', targetCommand(MCP_CONTEXT_HOOK_COMMAND))) observedHooks.push('prompt');
    if (capabilityLevel === 'native_hooks'
      && exactHookConfigured(claudeSettings, 'PreToolUse', targetCommand(MCP_PRE_ACTION_HOOK_COMMAND), NATIVE_HOOK_MATCHER)) observedHooks.push('pre_action');
    if (capabilityLevel === 'native_hooks'
      && exactHookConfigured(claudeSettings, 'PostToolUse', targetCommand(MCP_ACTION_RESULT_HOOK_COMMAND), NATIVE_HOOK_MATCHER)
      && exactHookConfigured(claudeSettings, 'PostToolUseFailure', targetCommand(MCP_ACTION_RESULT_HOOK_COMMAND), NATIVE_HOOK_MATCHER)) observedHooks.push('action_result');
    if (capabilityLevel === 'native_hooks'
      && exactHookConfigured(claudeSettings, 'Stop', targetCommand(MCP_SESSION_END_HOOK_COMMAND))) observedHooks.push('session_end');
  }
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
    && config.mcpServers.marrow.args.join(' ') === `-y --package=@getmarrow/mcp@${mcpTargetVersion} marrow-mcp`
  ))) observedHooks.push('mcp_tool_calls');
  const fingerprintMaterial = changes
    .filter((change) => change.applied || change.already_present)
    .map((change) => `${change.label}:${crypto.createHash('sha256').update(safeRead(change.path)).digest('hex')}`)
    .sort()
    .join('|');
  const configFingerprint = capabilityLevel === 'native_hooks'
    ? client === 'codex' ? codexNativeHookFingerprint(codexSettings)
      : client === 'cursor' || client === 'composer' ? cursorNativeHookFingerprint(cursorSettings)
      : client === 'cline' ? clineNativeHookFingerprint(detection)
      : client === 'windsurf' ? windsurfNativeHookFingerprint(windsurfSettings)
      : client === 'gemini' ? geminiNativeHookFingerprint(geminiSettings)
      : client === 'grok' ? grokNativeHookFingerprint(grokSettings)
      : claudeNativeHookFingerprint(claudeSettings)
    : crypto.createHash('sha256')
      .update(`${client}:${capabilityLevel}:${expectedHooks.join(',')}:${fingerprintMaterial}`)
      .digest('hex');
  const complete = expectedHooks.length > 0 && expectedHooks.every((hook) => observedHooks.includes(hook));
  const clineConflicts = changes
    .filter((change) => change.hook_conflict)
    .map((change) => change.label);
  const exactFix = complete
    ? client === 'cline'
      ? 'Enable Hooks in Cline, trust the project hook executables and workspace, then restart Cline. TaskComplete remains unverified and is not configured.'
      : client === 'windsurf'
      ? 'Restart Windsurf, trust the workspace hook configuration, and leave Restricted Mode before expecting hooks to run. MCP tools remain on demand.'
      : client === 'gemini'
      ? 'Restart Gemini CLI, open /hooks panel, and review and approve the project hook fingerprints. MCP tools remain on demand.'
      : client === 'grok'
      ? 'Restart Grok, inspect the installed global hooks with /hooks, and confirm they are enabled. Configuration remains client-self-reported and does not verify observed coverage.'
      : null
    : capabilityLevel === 'sdk_passive_runtime' && !sdkDependency.present
    ? `${sdkDependency.install_command} && npx @getmarrow/install --repair`
    : capabilityLevel === 'governed_wrapper'
    ? `npx @getmarrow/install run --agent <agent-id> -- ${client}`
    : client === 'cline' && clineConflicts.length > 0
    ? 'Move or remove the conflicting owner-managed Cline hook file after owner review, then run npx @getmarrow/install --repair. Marrow will never overwrite or compose it.'
    : client === 'gemini' && geminiHooksExplicitlyDisabled(geminiSettings)
    ? 'Hooks are explicitly disabled. After owner review, run /hooks enable-all, open /hooks panel, review and approve the project hook fingerprints, then restart Gemini CLI.'
    : client === 'grok'
    ? `Run npx -y --package=@getmarrow/mcp@${mcpTargetVersion} marrow-mcp setup, restart Grok, then inspect /hooks and confirm the global hooks are enabled.`
    : 'npx @getmarrow/install --repair';
  return {
    adapter_version: adapterVersion,
    capability_level: capabilityLevel,
    config_fingerprint: configFingerprint,
    expected_hooks: expectedHooks,
    observed_hooks: observedHooks,
    evidence_authority: 'client_self_reported',
    coverage_verified: false,
    passive_live: false,
    configuration_complete: complete,
    complete,
    exact_fix: exactFix,
    ...(client === 'cline' ? {
      hook_conflicts: clineConflicts,
      task_complete_support: 'coming_soon_not_configured',
      task_completion_closure_verified: false,
      enable_hooks_required: true,
      executable_trust_required: true,
    } : {}),
    ...(client === 'windsurf' ? {
      restricted_mode_disables_hooks: true,
      restart_required: true,
      workspace_trust_required: true,
      mcp_tools: 'on_demand',
    } : {}),
    ...(client === 'gemini' ? {
      hooks_enabled: !geminiHooksExplicitlyDisabled(geminiSettings),
      explicit_disable_preserved: geminiHooksExplicitlyDisabled(geminiSettings),
      trust_review_required: true,
      restart_required: true,
      mcp_tools: 'on_demand',
      session_end_delivery_claimed: false,
      deterministic_closeout: 'AfterAgent',
    } : {}),
    ...(client === 'grok' ? {
      hooks_user_toggleable: true,
      hook_review_required: true,
      restart_required: true,
      global_hook_path: detection.paths.grokHooks,
      mcp_tools: 'on_demand',
      duplicate_session_end_configured: grokHasDuplicateSessionEnd(grokSettings),
      deterministic_closeout: 'Stop',
      governed_wrapper_fallback: 'explicit_bounded_only',
    } : {}),
  };
}

function upsertMcpServerConfig(filePath, options = {}) {
  const agentId = String(options.agentId || '').trim();
  if (!agentId) throw new Error('Refusing to generate Marrow MCP config without an agent identity');
  const baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
  const config = parseJsonObject(filePath);
  const servers = config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
    ? config.mcpServers
    : {};
  const existingProfile = resolveToolProfile(servers.marrow?.env?.MARROW_TOOL_PROFILE).configured_profile;
  const requestedProfile = resolveToolProfile(options.toolProfile).configured_profile;
  const configuredProfile = requestedProfile === 'unset' ? existingProfile : requestedProfile;
  const env = {
    MARROW_BASE_URL: baseUrl,
    MARROW_FLEET_AGENT_ID: agentId,
  };
  if (configuredProfile !== 'unset') env.MARROW_TOOL_PROFILE = configuredProfile;
  servers.marrow = {
    command: 'npx',
    args: ['-y', `--package=${MCP_PACKAGE_SPEC}`, 'marrow-mcp'],
    env,
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
  const objectTargetsSdk = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.entries(value).some(([key, nested]) => (
      key.includes('@getmarrow/sdk') || objectTargetsSdk(nested)
    ));
  };
  const overrideDetected = objectTargetsSdk(packageJson.overrides)
    || objectTargetsSdk(packageJson.resolutions)
    || objectTargetsSdk(packageJson.pnpm?.overrides);
  let lockVerified = false;
  try {
    const lock = JSON.parse(safeRead(path.join(detection.root, 'package-lock.json')) || '{}');
    const rootLock = lock?.packages?.[''];
    const lockedSdk = lock?.packages?.['node_modules/@getmarrow/sdk'];
    const lockedDeclaration = [
      rootLock?.dependencies,
      rootLock?.devDependencies,
      rootLock?.optionalDependencies,
      rootLock?.peerDependencies,
    ].map((deps) => deps && typeof deps['@getmarrow/sdk'] === 'string' ? deps['@getmarrow/sdk'] : null)
      .find(Boolean) || null;
    lockVerified = [2, 3].includes(lock?.lockfileVersion)
      && lockedDeclaration === declaredSpec
      && lockedSdk?.version === SDK_ADAPTER_VERSION
      && lockedSdk?.resolved === SDK_ADAPTER_TARBALL
      && lockedSdk?.integrity === SDK_ADAPTER_INTEGRITY;
  } catch {
    lockVerified = false;
  }
  const installedPackagePath = findUp(
    detection.root,
    [path.join('node_modules', '@getmarrow', 'sdk', 'package.json')],
  );
  let installedVersion = null;
  let installedName = null;
  try {
    const installedPackage = installedPackagePath ? JSON.parse(safeRead(installedPackagePath)) : null;
    installedVersion = typeof installedPackage?.version === 'string' ? installedPackage.version : null;
    installedName = typeof installedPackage?.name === 'string' ? installedPackage.name : null;
  } catch {
    installedVersion = null;
    installedName = null;
  }
  const declarationTrusted = typeof declaredSpec === 'string'
    && declaredSpec.trim().length > 0
    && /^[v0-9xX*<>=~^|.\s-]+$/.test(declaredSpec.trim());
  const present = declarationTrusted
    && !overrideDetected
    && lockVerified
    && installedName === '@getmarrow/sdk'
    && installedVersion === SDK_ADAPTER_VERSION;
  return {
    required: true,
    present,
    declared: declaredSpec != null,
    declared_spec: declaredSpec,
    declaration_trusted: declarationTrusted,
    override_detected: overrideDetected,
    lock_verified: lockVerified,
    installed_name: installedName,
    installed_version: installedVersion,
    expected_version: SDK_ADAPTER_VERSION,
    install_command: present ? null : `npm install @getmarrow/sdk@${SDK_ADAPTER_VERSION}`,
  };
}

function defaultHarnessInstallMatrix(detection = detectEnvironment(process.cwd())) {
  const node = Boolean(detection.node);
  return HARNESS_CAPABILITY_REGISTRY.map((entry) => {
    const detected = detectedClient(detection) === entry.client
      || (entry.client === 'claude-code' && detection.claudeCode)
      || (entry.client === 'cursor' && detection.cursor)
      || (entry.client === 'cline' && detection.cline)
      || (entry.client === 'windsurf' && detection.windsurf)
      || (entry.client === 'gemini' && detection.gemini)
      || (entry.client === 'grok' && detection.grok)
      || (entry.client === 'codex' && detection.codex);
    const codexSettings = entry.client === 'codex' ? safeJsonObject(detection.paths.codexHooks) : null;
    const codexConfigured = Boolean(codexSettings
      && exactHookConfigured(codexSettings, 'UserPromptSubmit', CODEX_CONTEXT_HOOK_COMMAND)
      && exactHookConfigured(codexSettings, 'PreToolUse', CODEX_PRE_ACTION_HOOK_COMMAND, CODEX_NATIVE_HOOK_MATCHER)
      && exactHookConfigured(codexSettings, 'PostToolUse', CODEX_ACTION_RESULT_HOOK_COMMAND, CODEX_NATIVE_HOOK_MATCHER)
      && exactHookConfigured(codexSettings, 'SessionEnd', CODEX_SESSION_END_HOOK_COMMAND));
    const cursorSettings = ['cursor', 'composer'].includes(entry.client) ? safeJsonObject(detection.paths.cursorHooks) : null;
    const cursorConfigured = Boolean(cursorSettings
      && exactCursorHookConfigured(cursorSettings, 'preToolUse', CURSOR_PRE_ACTION_HOOK_COMMAND, CURSOR_NATIVE_HOOK_MATCHER, {
        timeout: CODEX_HOOK_TIMEOUT_SECONDS, failClosed: true, async: false,
      })
      && exactCursorHookConfigured(cursorSettings, 'postToolUse', CURSOR_ACTION_RESULT_HOOK_COMMAND, CURSOR_NATIVE_HOOK_MATCHER, {
        timeout: CODEX_HOOK_TIMEOUT_SECONDS,
      })
      && exactCursorHookConfigured(cursorSettings, 'postToolUseFailure', CURSOR_ACTION_RESULT_HOOK_COMMAND, CURSOR_NATIVE_HOOK_MATCHER, {
        timeout: CODEX_HOOK_TIMEOUT_SECONDS,
      })
      && exactCursorHookConfigured(cursorSettings, 'stop', CURSOR_SESSION_END_HOOK_COMMAND, undefined, {
        timeout: CODEX_SESSION_TIMEOUT_SECONDS,
      }));
    const clineConfigured = entry.client === 'cline'
      && clineHookContract(detection).every((hook) => exactExecutableFile(hook.path, hook.content));
    const windsurfSettings = entry.client === 'windsurf' ? safeJsonObject(detection.paths.windsurfHooks) : null;
    const windsurfConfigured = Boolean(windsurfSettings
      && WINDSURF_PRE_EVENTS.every((event) => exactWindsurfHookConfigured(
        windsurfSettings, event, WINDSURF_PRE_ACTION_HOOK_COMMAND,
      ))
      && WINDSURF_POST_EVENTS.every((event) => exactWindsurfHookConfigured(
        windsurfSettings, event, WINDSURF_ACTION_RESULT_HOOK_COMMAND,
      ))
      && exactWindsurfHookConfigured(
        windsurfSettings, 'post_cascade_response', WINDSURF_SESSION_END_HOOK_COMMAND,
      ));
    const geminiSettings = entry.client === 'gemini' ? safeJsonObject(detection.paths.geminiSettings) : null;
    const geminiConfigured = Boolean(geminiSettings
      && !geminiHooksExplicitlyDisabled(geminiSettings)
      && exactGeminiHookConfigured(
        geminiSettings, 'BeforeTool', 'marrow-before-tool', GEMINI_PRE_ACTION_HOOK_COMMAND,
        GEMINI_NATIVE_HOOK_MATCHER, GEMINI_HOOK_TIMEOUT_MS,
      )
      && exactGeminiHookConfigured(
        geminiSettings, 'AfterTool', 'marrow-after-tool', GEMINI_ACTION_RESULT_HOOK_COMMAND,
        GEMINI_NATIVE_HOOK_MATCHER, GEMINI_HOOK_TIMEOUT_MS,
      )
      && exactGeminiHookConfigured(
        geminiSettings, 'AfterAgent', 'marrow-after-agent', GEMINI_SESSION_END_HOOK_COMMAND,
        undefined, GEMINI_CLOSEOUT_TIMEOUT_MS,
      ));
    const grokSettings = entry.client === 'grok' ? safeJsonObject(detection.paths.grokHooks) : null;
    const grokConfigured = Boolean(grokSettings
      && exactGrokHookConfigured(
        grokSettings, 'PreToolUse', GROK_PRE_ACTION_HOOK_COMMAND, GROK_NATIVE_HOOK_MATCHER, 7,
      )
      && exactGrokHookConfigured(
        grokSettings, 'PostToolUse', GROK_ACTION_RESULT_HOOK_COMMAND, GROK_NATIVE_HOOK_MATCHER, 5,
      )
      && exactGrokHookConfigured(
        grokSettings, 'PostToolUseFailure', GROK_ACTION_RESULT_HOOK_COMMAND, GROK_NATIVE_HOOK_MATCHER, 5,
      )
      && exactGrokHookConfigured(
        grokSettings, 'Stop', GROK_SESSION_END_HOOK_COMMAND, undefined, 3,
      )
      && !grokHasDuplicateSessionEnd(grokSettings));
    return {
      client: entry.client,
      capability_level: entry.capability_level,
      automatic: entry.automatic,
      install_surface: entry.install_surface,
      default_install: {
        mcp: true,
        instructions: true,
        sdk_passive_runtime: node,
        native_hooks: entry.capability_level === 'native_hooks' && Boolean(
          entry.client === 'claude-code' ? detection.claudeCode
            : entry.client === 'codex' ? detection.codex
            : ['cursor', 'composer'].includes(entry.client) ? detection.cursor
            : entry.client === 'cline' ? detection.cline
            : entry.client === 'windsurf' ? detection.windsurf
            : entry.client === 'gemini' ? detection.gemini
            : entry.client === 'grok' ? detection.grok
            : false,
        ),
        governed_wrapper: entry.capability_level === 'governed_wrapper',
      },
      configured_locally: entry.client === 'codex' ? codexConfigured
        : ['cursor', 'composer'].includes(entry.client) ? cursorConfigured
        : entry.client === 'cline' ? clineConfigured
        : entry.client === 'windsurf' ? windsurfConfigured
        : entry.client === 'gemini' ? geminiConfigured
        : entry.client === 'grok' ? grokConfigured
        : detected && entry.automatic.length > 0,
      verified_passive: false,
      unsupported_claim: entry.client === 'cline'
        ? 'TaskComplete is documented as coming soon and is not configured or counted as observed coverage.'
        : entry.client === 'windsurf'
        ? 'Restricted Mode disables hooks; configuration requires restart and trust review and never verifies passive coverage.'
        : entry.client === 'gemini'
        ? 'Project hooks require restart and project fingerprint review and approval in /hooks panel; explicit hooksConfig.enabled=false is preserved and SessionEnd delivery is not claimed.'
        : entry.client === 'grok'
        ? 'Global hooks are user-toggleable; restart and /hooks inspection are required, configuration remains client-self-reported, and duplicate SessionEnd closeout is forbidden.'
        : entry.capability_level === 'event_contract'
        ? 'Needs a bounded event adapter. MCP tools remain on demand.'
        : null,
    };
  });
}

function buildPlan(detection, options) {
  const client = options.client || detectedClient(detection);
  const agentId = String(options.agentId || '').trim() || stableAgentId(detection.root, client);
  const baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
  const mcpTargetVersion = compatibleMcpTargetVersion(options.mcpTargetVersion)
    ? options.mcpTargetVersion
    : MCP_ADAPTER_VERSION;
  const retarget = (value) => retargetMcpPackageSpec(value, mcpTargetVersion);
  const mode = options.mode === 'auto'
    ? detection.node ? 'both' : 'mcp'
    : options.mode;
  const writes = [];

  if (mode === 'sdk' || mode === 'both') {
    writes.push({
      type: 'file',
      path: detection.paths.passiveRuntime,
      label: 'SDK passive runtime preload',
      content: passiveRuntimeSource({ agentId, baseUrl }),
    });
    writes.push({
      type: 'file',
      path: detection.paths.passiveEnv,
      label: 'Marrow passive env example',
      content: envExample({ agentId, baseUrl, client }),
      overwrite: false,
    });
  }

  if (mode === 'mcp' || mode === 'both') {
    if (detection.claudeCode) {
      writes.push({
        type: 'json-transform',
        path: detection.paths.claudeSettings,
        label: 'Claude Code MCP passive hooks',
        transform: (filePath) => retarget(upsertClaudeHooks(filePath)),
      });
    }
    if (detection.codex) {
      writes.push({
        type: 'json-transform',
        path: detection.paths.codexHooks,
        label: 'Codex native hooks',
        transform: (filePath) => retarget(upsertCodexHooks(filePath)),
      });
    }
    if (detection.cline) {
      for (const hook of clineHookContract(detection)) {
        writes.push({
          type: 'owned-executable',
          path: hook.path,
          label: hook.label,
          content: retarget(hook.content),
          mode: 0o755,
          conflict_fix: 'Move or remove the existing owner-managed Cline hook after owner review, then run npx @getmarrow/install --repair.',
        });
      }
    }
    if (detection.windsurf) {
      writes.push({
        type: 'json-transform',
        path: detection.paths.windsurfHooks,
        label: 'Windsurf native hooks',
        transform: (filePath) => retarget(upsertWindsurfHooks(filePath)),
      });
    }
    if (detection.gemini) {
      writes.push({
        type: 'json-transform',
        path: detection.paths.geminiSettings,
        label: 'Gemini CLI native hooks',
        transform: (filePath) => retarget(upsertGeminiHooks(filePath)),
      });
    }
    writes.push({
      type: 'json-transform',
      path: detection.paths.mcpJson,
      label: 'Project MCP server config',
      transform: (filePath) => retarget(upsertMcpServerConfig(filePath, { agentId, baseUrl, toolProfile: options.toolProfile })),
    });
    if (detection.cursor) {
      writes.push({
        type: 'json-transform',
        path: detection.paths.cursorHooks,
        label: 'Cursor native hooks',
        transform: (filePath) => retarget(upsertCursorHooks(filePath)),
      });
      writes.push({
        type: 'json-transform',
        path: detection.paths.cursorMcp,
        label: 'Cursor MCP server config',
        transform: (filePath) => retarget(upsertMcpServerConfig(filePath, { agentId, baseUrl, toolProfile: options.toolProfile })),
      });
    }
  }

  if (mode === 'md' || mode === 'both' || mode === 'mcp') {
    writes.push({
      type: 'md-block',
      path: detection.paths.agentsMd,
      label: 'Agent instructions',
      block: retarget(passiveInstructions()),
    });
  }

  if (detection.cursor && (mode === 'md' || mode === 'both' || mode === 'mcp')) {
    writes.push({
      type: 'file',
      path: detection.paths.cursorRules,
      label: 'Cursor Marrow rule',
      content: retarget(passiveInstructions()).replace(/<!--[^>]+-->/g, '').trim() + '\n',
    });
  }

  return { mode, root: detection.root, writes, mcp_target_version: mcpTargetVersion };
}

function assertContainedManagedTarget(root, targetPath) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(targetPath);
  if (resolvedTarget === resolvedRoot || !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Refusing installer write outside project root: ${resolvedTarget}`);
  }
  if (!fs.existsSync(resolvedRoot)) throw new Error(`Project root does not exist: ${resolvedRoot}`);
  const rootStat = fs.lstatSync(resolvedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Refusing installer write through unsafe project root: ${resolvedRoot}`);
  }
  const realRoot = fs.realpathSync(resolvedRoot);
  const relativeParent = path.relative(resolvedRoot, path.dirname(resolvedTarget));
  let current = resolvedRoot;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Refusing installer write through unsafe path component: ${current}`);
    }
    const realCurrent = fs.realpathSync(current);
    if (realCurrent !== realRoot && !realCurrent.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error(`Refusing installer write outside resolved project root: ${current}`);
    }
  }
  if (fs.existsSync(resolvedTarget)) {
    const targetStat = fs.lstatSync(resolvedTarget);
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
      throw new Error(`Refusing installer write to unsafe managed target: ${resolvedTarget}`);
    }
  }
  return { resolvedRoot, resolvedTarget };
}

function atomicWriteManagedFile(root, targetPath, contents) {
  const { resolvedTarget } = assertContainedManagedTarget(root, targetPath);
  const parent = path.dirname(resolvedTarget);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertContainedManagedTarget(root, resolvedTarget);
  const existingMode = fs.existsSync(resolvedTarget)
    ? fs.lstatSync(resolvedTarget).mode & 0o777
    : 0o600;
  const tempPath = path.join(
    parent,
    `.${path.basename(resolvedTarget)}.marrow-${process.pid}-${crypto.randomBytes(6).toString('hex')}`,
  );
  try {
    fs.writeFileSync(tempPath, contents, { flag: 'wx', mode: existingMode });
    assertContainedManagedTarget(root, resolvedTarget);
    fs.renameSync(tempPath, resolvedTarget);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

function applyPlan(plan, options) {
  if (!Array.isArray(plan?.writes) || plan.writes.length === 0) return [];
  const root = path.resolve(plan.root || path.dirname(plan.writes[0].path));
  for (const write of plan.writes) assertContainedManagedTarget(root, write.path);
  const prepared = plan.writes.map((write) => {
    const fileExists = exists(write.path);
    const before = safeRead(write.path);
    let after;
    let hookConflict = false;
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
    } else if (write.type === 'owned-executable') {
      if (fileExists && before !== write.content) {
        after = before;
        hookConflict = true;
      } else {
        after = write.content;
      }
    } else {
      throw new Error(`Unknown write type: ${write.type}`);
    }

    const beforeMode = fileExists ? fs.lstatSync(write.path).mode & 0o777 : null;
    const modeChanged = !hookConflict && typeof write.mode === 'number' && beforeMode !== write.mode;
    return { write, before, after, hookConflict, modeChanged };
  });

  const changes = [];
  for (const { write, before, after, hookConflict, modeChanged } of prepared) {
    const contentChanged = before !== after;
    const changed = !hookConflict && (contentChanged || modeChanged);
    const writeApplied = Boolean(options.yes && !options.dryRun && !options.doctor && !hookConflict);
    changes.push({
      path: write.path,
      label: write.label,
      changed,
      applied: changed && writeApplied,
      already_present: !changed && !hookConflict,
      hook_conflict: hookConflict,
      ...(hookConflict ? { exact_fix: write.conflict_fix } : {}),
    });
    if (contentChanged && writeApplied) {
      atomicWriteManagedFile(root, write.path, after);
    }
    if (modeChanged && writeApplied) {
      assertContainedManagedTarget(root, write.path);
      fs.chmodSync(write.path, write.mode);
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
  const gate = runtime.risk_gate;
  if (!gate || typeof gate !== 'object') return false;
  if (typeof gate.allow === 'boolean' || typeof gate.allowed === 'boolean') return true;
  const decision = typeof gate.decision === 'string' ? gate.decision.toLowerCase() : '';
  return ['allow', 'warn', 'review_required', 'block'].includes(decision);
}

async function runSelfTest(options) {
  const initialProfile = initialToolProfileReport(options.toolProfile);
  if (!options.selfTest) return { skipped: true, reason: 'disabled', mcp_tool_profile: initialProfile };
  if (!options.apiKey) {
    return {
      skipped: true,
      reason: 'missing MARROW_API_KEY',
      exact_fix: 'export MARROW_API_KEY=mrw_live_... && npx @getmarrow/install --repair',
      mcp_tool_profile: initialProfile,
    };
  }

  const headers = {
    authorization: `Bearer ${options.apiKey}`,
    'content-type': 'application/json',
    'x-marrow-session-id': `install-${Date.now()}`,
    'x-marrow-client': options.client || sourceClient(),
    'x-marrow-package': '@getmarrow/install',
    'x-marrow-package-version': INSTALLER_ADAPTER_VERSION,
    'x-marrow-install-version': INSTALLER_ADAPTER_VERSION,
    'x-marrow-sdk-version': SDK_ADAPTER_VERSION,
    'x-marrow-mcp-version': compatibleMcpTargetVersion(options.mcpTargetVersion)
      ? options.mcpTargetVersion
      : MCP_ADAPTER_VERSION,
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
  const context = await requestJson(`${baseUrl}/v1/agent/context`, { headers })
    .catch(() => null);
  const toolProfile = buildMcpToolProfileReport(
    options.toolProfile,
    status.mcp_tool_profile,
    context?.primary_tool_availability,
    Boolean(options.activation),
  );
  const runtime = await requestJson(`${baseUrl}/v1/agent/runtime`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      action: 'Marrow passive install self-test: verify one-call agent runtime and outcome closure',
      type: 'process',
      role: 'general',
      response_mode: 'expanded',
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
    let activationTelemetry;
    try {
      activationTelemetry = await requestJson(`${baseUrl}/v1/agent/integrations/events`, {
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
          action: 'integration activation profile registered as client self-reported telemetry',
          occurred_at: new Date().toISOString(),
        }),
      });
    } catch {
      throw new Error('activation telemetry delivery failed; retry activate after the integration-events endpoint accepts authenticated client_self_reported telemetry');
    }
    const telemetryAccepted = Boolean(
      activationTelemetry?.accepted === true
      && activationTelemetry?.evidence_authority === 'client_self_reported'
    );
    if (!telemetryAccepted) {
      throw new Error('activation telemetry was not acknowledged as authenticated client_self_reported delivery; update the backend/client compatibility pair, then retry activate');
    }
    // Never project response-supplied coverage or profile receipts into the install
    // result. This endpoint acknowledges bounded, authenticated client telemetry;
    // it does not certify that hooks, wrappers, or adapters continuously ran.
    activationProfileReceipt = {
      accepted: true,
      evidence_authority: 'client_self_reported',
      certified_coverage: false,
    };
    const activationPrerequisites = {
      first_value_active: firstValue?.active === true,
      runtime_gate_verified: runtimeGateVerified(runtime),
      status_enabled: (status.enabled ?? status.ok) === true,
      telemetry_accepted: telemetryAccepted,
    };
    activationVerified = Object.values(activationPrerequisites).every(Boolean);
    if (!activationVerified) {
      const missing = Object.entries(activationPrerequisites)
        .filter(([, verified]) => !verified)
        .map(([name]) => name)
        .join(',');
      throw new Error(`activation self-test prerequisites were not all verified by the server (${missing})`);
    }
  }
  return {
    skipped: false,
    mcp_tool_profile: toolProfile,
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
    activation_scope: options.activation ? 'server_self_test_only' : null,
    coverage_verified: false,
    passive_live: false,
    reload_required: Boolean(options.activation),
    activation_next_action: options.activation
      ? 'Restart the owning harness, then run npx @getmarrow/install@latest doctor --self-test.'
      : null,
    activation_receipt: activationReceipt,
    activation_profile_receipt: activationProfileReceipt,
    activation_coverage: null,
    first_value: firstValue && firstValue.ok !== false ? firstValue : null,
    first_value_signal: firstValueSignal,
    install_value_moment: installValueMoment,
    token_value_proof: tokenValueProof,
    client_update: status.client_update || runtime.client_update || runtime.status?.client_update || null,
    performance_proof: performance && performance.ok !== false ? {
      avoided_mistakes: performance.avoided_mistakes ?? performance.avoided_repeated_mistakes ?? 0,
      reused_winning_decisions: performance.reused_winning_decisions ?? 0,
      prevented_bad_actions: performance.prevented_bad_actions ?? 0,
      estimated_tokens_saved: tokenValueProof?.savings?.estimated_tokens_saved ?? null,
      estimated_minutes_saved: tokenValueProof?.savings?.estimated_minutes_saved ?? null,
      token_savings_available: Number(tokenValueProof?.observed?.model_calls || 0) > 0
        && Number(tokenValueProof?.savings?.estimated_tokens_saved || 0) > 0,
      token_savings_source: 'agent_model_usage_events',
      token_savings_method: tokenValueProof?.savings?.method || 'warming_up',
      token_savings_confidence: tokenValueProof?.savings?.confidence || 'none',
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

function tokenValueProofLine(tokenValueProof) {
  const calls = Number(tokenValueProof?.observed?.model_calls || 0);
  const saved = Number(tokenValueProof?.savings?.estimated_tokens_saved || 0);
  if (calls > 0 && saved > 0) {
    const method = tokenValueProof.savings?.method || 'unspecified';
    const confidence = tokenValueProof.savings?.confidence || 'unknown';
    return `Marrow observed ${calls} model call${calls === 1 ? '' : 's'} and estimates ~${saved} tokens saved (${method}, ${confidence} confidence)`;
  }
  return tokenValueProof?.proof_line || null;
}

function buildInstallValueMoment(firstValueSignal = {}, status = {}, runtime = {}, performance = {}, firstValue = {}, tokenValueProof = null) {
  if (firstValue && firstValue.ok !== false && firstValue.first_value) {
    const proof = Array.isArray(firstValue.first_value.proof) ? [...firstValue.first_value.proof] : [];
    const tokenProofLine = tokenValueProofLine(tokenValueProof);
    if (tokenProofLine && !proof.includes(tokenProofLine)) proof.push(tokenProofLine);
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
      tokenValueProofLine(tokenValueProof) || 'Token usage proof is active and warming up after the first model call',
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
    const tokenProofLine = tokenValueProofLine(tokenValueProof);
    if (tokenProofLine) proofBits.push(tokenProofLine);
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
  const tokenProofLine = tokenValueProofLine(tokenValueProof);
  if (tokenProofLine) proofBits.push(tokenProofLine);

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
    process.stdout.write(`- self-test server confirmed: ${report.activation.server_confirmed ? 'yes' : 'no'}\n`);
    process.stdout.write(`- scope: ${report.activation.activation_scope}\n`);
    process.stdout.write(`- coverage verified: ${report.activation.coverage_verified ? 'yes' : 'no'}\n`);
    process.stdout.write(`- passive live in this process: ${report.activation.passive_live ? 'yes' : 'no'}\n`);
    process.stdout.write(`- reload required: ${report.activation.reload_required ? 'yes' : 'no'}\n`);
    if (report.activation.next_action) process.stdout.write(`- next action: ${report.activation.next_action}\n`);
    process.stdout.write('\n');
  }

  process.stdout.write('Detected:\n');
  for (const [key, value] of Object.entries(report.detected)) {
    process.stdout.write(`- ${key}: ${value ? 'yes' : 'no'}\n`);
  }

  process.stdout.write('\nPlanned changes:\n');
  for (const change of report.changes) {
    const marker = change.applied ? 'wrote' : change.changed ? 'would write' : 'unchanged';
    process.stdout.write(`- ${marker}: ${change.label} (${change.path})\n`);
  }

  process.stdout.write('\nSelf-test:\n');
  const toolProfile = report.selfTest.mcp_tool_profile || report.toolProfile;
  if (toolProfile) {
    process.stdout.write(`- configured tool profile: ${toolProfile.configured_profile}\n`);
    process.stdout.write(`- effective tool profile: ${toolProfile.effective_profile}\n`);
    process.stdout.write(`- expected visible tools: ${toolProfile.expected_visible_count == null ? 'complete catalog (awaiting reloaded MCP count)' : toolProfile.expected_visible_count}\n`);
    process.stdout.write(`- actual visible tools: ${toolProfile.actual_visible_count == null ? 'unavailable until process reload' : toolProfile.actual_visible_count}\n`);
    process.stdout.write(`- visible tool names: ${toolProfile.visibility_live ? toolProfile.visible_tool_names.join(', ') : 'unavailable until process reload'}\n`);
    process.stdout.write(`- profile live: ${toolProfile.visibility_live ? 'yes' : 'no'}\n`);
    const projection = toolProfile.backend_entitlement_projection;
    const availability = projection?.primary_tool_availability;
    if (projection?.evidence_state === 'available' && availability?.entitlement_evidence?.state === 'available') {
      process.stdout.write(`- backend-projected entitled tools: ${availability.counts.entitled}\n`);
      process.stdout.write(`- backend-projected upgrade-required tools: ${availability.counts.upgrade_required}\n`);
      process.stdout.write(`- backend projection source: ${projection.source}; authorizes calls: no\n`);
    } else {
      process.stdout.write(`- backend-projected entitlements: unavailable (source: ${projection?.source || 'backend_projection_not_provided'}; non-authorizing)\n`);
    }
  }
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
    const update = report.selfTest.client_update;
    const notification = update?.notification_state || update?.notification;
    if (update && (update.update_available === true || update.version_status === 'unknown' || notification === 'unknown' || notification === 'version_unknown' || notification === 'security_required')) {
      process.stdout.write('\nMarrow client update:\n');
      process.stdout.write(`- priority: ${notification === 'security_required' ? 'security_required' : notification === 'recommended' ? 'recommended' : update.version_status === 'unknown' || notification === 'unknown' || notification === 'version_unknown' ? 'version_unknown' : update.priority || 'recommended'}\n`);
      process.stdout.write(`- installed: ${update.installed_version || update.current_version || 'unknown'}\n`);
      process.stdout.write(`- latest: ${update.latest_version || 'unknown'}\n`);
      process.stdout.write('- automatic notification: yes\n');
      process.stdout.write('- automatic local mutation: no; operator policy applies\n');
      if (update.owner_notice) process.stdout.write(`- tell owner: ${update.owner_notice}\n`);
      if (update.agent_instruction) process.stdout.write(`- agent instruction: ${update.agent_instruction}\n`);
      if (update.update_command || update.exact_update_command || update.auto_update_command) {
        process.stdout.write(`- update: ${update.auto_update_command || update.update_command || update.exact_update_command}\n`);
      }
      if (update.verification_command || update.exact_verification_command) process.stdout.write(`- verify: ${update.verification_command || update.exact_verification_command}\n`);
    }
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

  if (report.harnessReload) {
    process.stdout.write('\nHarness reload:\n');
    process.stdout.write(`- required: ${report.harnessReload.required ? 'yes' : 'no'}\n`);
    process.stdout.write(`- live in this process: ${report.harnessReload.live_in_this_process ? 'yes' : 'no'}\n`);
    if (report.harnessReload.instruction) process.stdout.write(`- restart: ${report.harnessReload.instruction}\n`);
    if (report.harnessReload.prove_command) process.stdout.write(`- prove after restart: ${report.harnessReload.prove_command}\n`);
  }
  if (report.firstCapture) {
    process.stdout.write('\nFirst capture:\n');
    process.stdout.write(`- client: ${report.firstCapture.client}\n`);
    process.stdout.write(`- capability: ${report.firstCapture.capability_level}\n`);
    if (report.firstCapture.command) process.stdout.write(`- command: ${report.firstCapture.command}\n`);
    process.stdout.write(`- ${report.firstCapture.instruction}\n`);
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

  process.stdout.write('\nAutomatic controller:\n');
  process.stdout.write(`- state: ${report.controller?.active ? 'active' : report.controller?.state || 'unavailable'}\n`);
  if (report.controller?.started_at) process.stdout.write(`- started: ${report.controller.started_at}\n`);
  if (report.controller?.exact_fix) process.stdout.write(`- exact fix: ${report.controller.exact_fix}\n`);

  if (report.writeMode === 'doctor') {
    const liveHere = !report.harnessReload?.required;
    const activeLabel = report.doctor.active && liveHere
      ? 'yes'
      : report.doctor.active
        ? 'server confirmed, restart required'
        : 'no';
    process.stdout.write('\nDoctor:\n');
    process.stdout.write(`- Marrow active: ${activeLabel}\n`);
    process.stdout.write(`- missing env: ${report.doctor.missingEnv.length ? report.doctor.missingEnv.join(', ') : 'none'}\n`);
    if (report.doctor.envHints.length) process.stdout.write(`- possible env files: ${report.doctor.envHints.join(', ')}\n`);
    process.stdout.write(`- missing hooks/config: ${report.doctor.missingHooks.length ? report.doctor.missingHooks.join('; ') : 'none'}\n`);
    if (report.doctor.mcpProcesses?.available) {
      const processes = report.doctor.mcpProcesses;
      process.stdout.write(`- MCP process versions: ${processes.active_versions.length ? processes.active_versions.join(', ') : processes.active_processes ? 'unknown' : 'none'}\n`);
      process.stdout.write(`- stale/mixed/version-unknown MCP clients: ${processes.healthy ? 'no' : 'yes'}\n`);
      if (processes.restart_instruction) process.stdout.write(`- restart required: ${processes.restart_instruction}\n`);
      if (processes.verification_command) process.stdout.write(`- verify repair: ${processes.verification_command}\n`);
    }
    if (report.doctor.mcpConfigurations) {
      const configurations = report.doctor.mcpConfigurations;
      process.stdout.write(`- configured MCP versions: ${configurations.configured_versions.length ? configurations.configured_versions.join(', ') : 'none pinned'}\n`);
      process.stdout.write(`- stale/mixed/version-unknown MCP configuration: ${configurations.healthy ? 'no' : 'yes'}\n`);
    }
    if (report.doctor.recommendedFix) process.stdout.write(`- recommended fix: ${report.doctor.recommendedFix}\n`);
    process.stdout.write(`- live health: ${report.doctor.healthCommand}\n`);
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
  if (options.activate && !String(options.apiKey || '').trim()) {
    throw new Error('activation requires MARROW_API_KEY from the process environment or trusted secret storage');
  }
  if (options.repair && options.yes !== true && !options.dryRun && !options.doctor) {
    throw new Error('repair requires explicit write authorization (--yes)');
  }
  options.toolProfile = resolveToolProfile(options.toolProfile === undefined
    ? process.env.MARROW_TOOL_PROFILE
    : options.toolProfile);
  const detection = detectEnvironment(options.cwd);
  const client = detectedClient(detection);
  options.client = client;
  options.agentId = String(options.agentId || '').trim() || stableAgentId(detection.root, client);
  const observedMcpProcesses = inspectMcpProcesses({ commands: options.processCommands });
  const observedMcpConfigurations = inspectMcpConfigurations(detection, { paths: options.mcpConfigPaths });
  const registryMetadata = await readMcpRegistryMetadata(options);
  const latestTargetOperation = Boolean(options.doctor || options.repair || options.update);
  const mcpTarget = resolveMcpTargetVersion({
    currentVersions: latestTargetOperation ? [
      ...observedMcpProcesses.active_versions,
      ...observedMcpConfigurations.configured_versions,
    ] : [],
    registryMetadata: latestTargetOperation ? registryMetadata : null,
  });
  options.mcpTargetVersion = mcpTarget.version;
  const plan = buildPlan(detection, options);
  const writeMode = options.doctor ? 'doctor' : options.dryRun ? 'dry-run' : options.repair ? 'repair' : options.yes ? 'write' : 'dry-run';
  const changes = applyPlan(plan, options);
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
    capture_verified: false,
    configuration_complete: changes.every((change) => change.applied || change.already_present),
    evidence_authority: 'client_self_reported',
    coverage_verified: false,
    passive_live: false,
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
  const configRepairs = options.repair && options.yes && !options.dryRun && !options.doctor
    ? repairConfigDiagnostics(configDiagnostics)
    : [];
  const envHints = options.apiKey ? [] : findLikelyEnvFiles(detection);
  const mcpProcesses = inspectMcpProcesses({
    commands: options.processCommands,
    expectedVersion: mcpTarget.version,
  });
  const mcpConfigurations = inspectMcpConfigurations(detection, {
    paths: options.mcpConfigPaths,
    expectedVersion: mcpTarget.version,
  });
  let selfTest;
  try {
    selfTest = await runSelfTest(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.activate) throw new Error(`Marrow activation failed: ${message}`);
    selfTest = {
      skipped: false,
      active: false,
      error: message,
      mcp_tool_profile: initialToolProfileReport(options.toolProfile),
    };
  }
  selfTest = alignMcpRecommendationVersions(selfTest, mcpTarget.version);
  if (options.activate && !selfTest.activation_verified) {
    throw new Error('Marrow activation failed: server confirmation was not returned');
  }
  const harnessReload = harnessReloadPlan(detection, changes);
  if (harnessReload.required && selfTest.mcp_tool_profile) {
    selfTest.mcp_tool_profile = {
      ...selfTest.mcp_tool_profile,
      visible_tool_count: null,
      actual_visible_count: null,
      visible_tool_names: [],
      visibility_live: false,
      reload_required: true,
    };
  }
  const changedConfig = changes.some((change) => change.applied) || configRepairs.some((repair) => repair.changed);
  const selfTestPassed = Boolean(!selfTest.skipped && selfTest.active && !selfTest.error);
  const controllerPlatform = options.controllerPlatform || process.platform;
  const localControl = localControlEvidence({ apiKey: options.apiKey, home: options.controlHome });
  let controller = await controllerStatus({
    root: detection.root,
    agentId: options.agentId,
    platform: controllerPlatform,
  });
  const shouldEnsureController = options.controller !== false
    && localControl.enabled
    && controllerSupportedPlatform(controllerPlatform)
    && Boolean(options.apiKey)
    && selfTestPassed
    && !options.dryRun
    && !options.doctor
    && (options.yes || options.activate || options.repair);
  if (shouldEnsureController) {
    try {
      controller = await ensureGovernanceController({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        agentId: options.agentId,
        client,
        root: detection.root,
        mode: plan.mode,
        profile: options.governanceMode || 'default',
        policy: options.governancePolicy || 'warn',
        platform: controllerPlatform,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      controller = {
        active: false,
        state: 'error',
        exact_fix: 'Run npx @getmarrow/install controller ensure after correcting the reported local controller error.',
        error: message,
      };
      if (options.activate) throw new Error(`Marrow activation failed: local controller did not start: ${message}`);
    }
  }
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
    adapterProvenance: adapterProvenanceForMcpTarget(mcpTarget),
    mode: plan.mode,
    writeMode,
    toolProfile: selfTest.mcp_tool_profile || initialToolProfileReport(options.toolProfile),
    detected: {
      node: detection.node,
      python: detection.python,
      claudeCode: detection.claudeCode,
      cursor: detection.cursor,
      grok: detection.grok,
      codex: detection.codex,
      openclaw: detection.openclaw,
      mcpConfig: detection.mcpConfig,
    },
    activation: {
      requested: options.activate,
      agent_id: options.agentId,
      server_confirmed: Boolean(selfTest.activation_verified),
      activation_scope: selfTest.activation_scope || null,
      coverage_verified: false,
      passive_live: false,
      reload_required: Boolean(options.activate),
      next_action: selfTest.activation_next_action || null,
      receipt: selfTest.activation_receipt || null,
      profile,
    },
    harnessReload,
    firstCapture: firstCapturePath(detection, options.agentId),
    changes,
    doctor: {
      active: Boolean(!selfTest.skipped && selfTest.active),
      missingEnv: options.apiKey ? [] : ['MARROW_API_KEY'],
      envHints,
      missingHooks: changes.filter((change) => change.changed).map((change) => change.label),
      mcpProcesses,
      mcpConfigurations,
      recommendedFix: mcpProcesses.exact_fix || mcpConfigurations.exact_fix || configDiagnostics.npm_token.recommended_fix || (!options.apiKey
        ? envHints.length
          ? `MARROW_API_KEY was found in a likely env file at ${envHints[0]}. Load that key from trusted secret storage, export only MARROW_API_KEY, then run npx @getmarrow/install --repair.`
          : 'Set MARROW_API_KEY, then run npx @getmarrow/install --repair.'
        : controller.exact_fix || selfTest.recommended_fix || null),
      healthCommand: 'npx -y --package=@getmarrow/mcp@latest marrow-mcp ping',
    },
    remediation,
    configDiagnostics,
    configRepairs,
    sdkDependency,
    controller,
    local_control: localControl,
    selfTest,
    warnings: [
      ...(options.keyFromArg
        ? ['Avoid --key in shared shells because command-line arguments can be visible in process listings. Prefer MARROW_API_KEY in your environment or secret manager.']
        : []),
      ...(!mcpProcesses.healthy
        ? ['Stale, mixed, or version-unknown Marrow MCP clients are active. Run the exact repair command, then restart every owning harness.']
        : []),
      ...(!mcpConfigurations.healthy
        ? ['Stale, mixed, or version-unknown Marrow MCP versions remain in owner configuration. Repair each owning workspace and restart its harness.']
        : []),
    ],
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
  inspectMcpProcesses,
  inspectMcpConfigurations,
  buildInstallValueMoment,
  buildTokenValueProof,
  stableAgentId,
  activationProfile,
  claudeNativeHookFingerprint,
  codexNativeHookFingerprint,
  cursorNativeHookFingerprint,
  clineNativeHookFingerprint,
  windsurfNativeHookFingerprint,
  geminiNativeHookFingerprint,
  grokNativeHookFingerprint,
  GROK_CONTEXT_HOOK_COMMAND,
  GROK_PRE_ACTION_HOOK_COMMAND,
  GROK_ACTION_RESULT_HOOK_COMMAND,
  GROK_SESSION_END_HOOK_COMMAND,
  GROK_NATIVE_HOOK_MATCHER,
  printReport,
  buildMcpToolProfileReport,
  resolveMcpTargetVersion,
  resolveToolProfile,
  PRIMARY_TOOL_NAMES,
  ADAPTER_PROVENANCE,
  HARNESS_CAPABILITY_REGISTRY,
  defaultHarnessInstallMatrix,
  harnessReloadPlan,
  firstCapturePath,
};

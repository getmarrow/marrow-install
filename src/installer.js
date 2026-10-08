const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { version: INSTALLER_ADAPTER_VERSION } = require('../package.json');
const {
  controllerStatus,
  controllerSupportedPlatform,
  ensureCurrentGovernanceController,
  stopProjectControllers,
} = require('./controller-manager');
const { firstCapturePath, harnessReloadPlan } = require('./first-hour');
const { evidence: localControlEvidence } = require('./control-state');
const {
  hermesEnvHasKey,
  hermesPaths,
  manualBlock: hermesManualBlock,
  marrowEnvKeyNames: hermesMarrowEnvKeyNames,
  planHermesMcpConfig,
} = require('./hermes-config');
const { ensureOwnerApiKey, readOwnerApiKey } = require('./owner-env');
const {
  delocalizeHookCommand,
  ensureMcpRuntime,
  localizeHookSettingsText,
  mapHookCommands,
  removeMcpRuntime,
  verifyMcpRuntime,
} = require('./mcp-runtime');
const {
  MCP_ADAPTER_VERSION,
  MCP_ADAPTER_SOURCE_SHA,
  MCP_ADAPTER_INTEGRITY,
  MCP_HOST_APPROVAL_HOOKS_SINCE,
  SDK_ADAPTER_VERSION,
  SDK_ADAPTER_INTEGRITY,
} = require('./pins');

const DEFAULT_BASE_URL = 'https://api.getmarrow.ai';
const MARROW_BLOCK_START = '<!-- marrow:passive-start -->';
const MARROW_BLOCK_END = '<!-- marrow:passive-end -->';
const SDK_ADAPTER_TARBALL = `https://registry.npmjs.org/@getmarrow/sdk/-/sdk-${SDK_ADAPTER_VERSION}.tgz`;
const MCP_PACKAGE_SPEC = `@getmarrow/mcp@${MCP_ADAPTER_VERSION}`;
const ADAPTER_PROVENANCE = Object.freeze({
  mcp: Object.freeze({
    package: '@getmarrow/mcp',
    version: MCP_ADAPTER_VERSION,
    source_sha: MCP_ADAPTER_SOURCE_SHA,
    integrity: MCP_ADAPTER_INTEGRITY,
    integrity_state: 'verified_npm_registry_metadata',
  }),
  sdk: Object.freeze({
    package: '@getmarrow/sdk',
    version: SDK_ADAPTER_VERSION,
    integrity: SDK_ADAPTER_INTEGRITY,
  }),
});
const MCP_REGISTRY_LATEST_URL = 'https://registry.npmjs.org/%40getmarrow%2Fmcp/latest';
const MCP_REGISTRY_VERIFICATION_COMMAND = 'npm view @getmarrow/mcp@latest name version dist.integrity dist.tarball --json --registry=https://registry.npmjs.org';
const INSTALLER_UPDATE_COMMAND = 'npx -y @getmarrow/install@latest update';
const INSTALLER_DOCTOR_COMMAND = 'npx -y @getmarrow/install@latest doctor --self-test';
const INSTALLER_RESTART_INSTRUCTION = 'After the update completes, restart the detected owning harnesses once. Running Marrow MCP processes remain unchanged until that restart.';
const MCP_STABLE_VERSION_RE = /^(\d{1,6})\.(\d{1,6})\.(\d{1,9})$/;
const SHA512_INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const VERIFIED_MCP_EXECUTABLE_TARGET = Symbol('verified_mcp_executable_target');

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

function declaredStableSdkLowerBound(spec) {
  if (typeof spec !== 'string') return null;
  const match = spec.trim().match(/^(v|\^|~|>=|>)?(\d{1,6}\.\d{1,6}\.\d{1,9})$/);
  if (!match || !parsedStableMcpVersion(match[2])) return null;
  return { version: match[2], exclusive: match[1] === '>' };
}

function compatibleMcpTargetVersion(value) {
  const candidate = parsedStableMcpVersion(value);
  const sealed = parsedStableMcpVersion(MCP_ADAPTER_VERSION);
  return Boolean(candidate && sealed
    && candidate[0] === sealed[0]
    && candidate[1] === sealed[1]
    && compareMcpVersions(value, MCP_ADAPTER_VERSION) >= 0);
}

// Whether an MCP version answers the host-approval hooks (see MCP_HOST_APPROVAL_HOOKS_SINCE).
function hostApprovalHooksSupported(version = MCP_ADAPTER_VERSION) {
  const comparison = compareMcpVersions(version, MCP_HOST_APPROVAL_HOOKS_SINCE);
  return comparison !== null && comparison >= 0;
}

function mcpVersionsInText(value) {
  return [...String(value || '').matchAll(/@getmarrow\/mcp@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g)]
    .map((match) => match[1]);
}

function marrowManagedBlockInText(value) {
  const content = String(value || '');
  const start = content.indexOf(MARROW_BLOCK_START);
  if (start < 0) return '';
  const end = content.indexOf(MARROW_BLOCK_END, start + MARROW_BLOCK_START.length);
  if (end < 0) return '';
  return content.slice(start, end + MARROW_BLOCK_END.length);
}

function unverifiedAheadMcpVersions(versions, targetVersion = MCP_ADAPTER_VERSION) {
  if (!parsedStableMcpVersion(targetVersion)) return [];
  return [...new Set((Array.isArray(versions) ? versions : [])
    .filter((version) => parsedStableMcpVersion(version)
      && compareMcpVersions(version, targetVersion) > 0))].sort((left, right) => compareMcpVersions(left, right));
}

function mcpRegistryVerificationAction(versions) {
  const ahead = [...new Set(Array.isArray(versions) ? versions : [])].sort((left, right) => compareMcpVersions(left, right));
  const targets = ahead.map((version) => `@getmarrow/mcp@${version}`).join(', ');
  return `Run ${MCP_REGISTRY_VERIFICATION_COMMAND} with official npm registry access, then rerun npx -y @getmarrow/install@latest doctor --self-test. Automatic repair is suppressed${targets ? ` for ${targets}` : ''}; preserve each existing surface until registry metadata verifies it or the owner chooses the sealed or verified version.`;
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
  const registry = verifiedMcpRegistryMetadata(options.registryMetadata);
  if (registry) {
    const target = {
      version: registry.version,
      source: 'verified_npm_registry',
      integrity: registry.integrity,
      source_sha: null,
    };
    Object.defineProperty(target, VERIFIED_MCP_EXECUTABLE_TARGET, { value: true });
    return target;
  }
  return {
    version: MCP_ADAPTER_VERSION,
    source: 'sealed_installer',
    integrity: MCP_ADAPTER_INTEGRITY,
    source_sha: MCP_ADAPTER_SOURCE_SHA,
  };
}

function executableMcpTarget(options = {}) {
  const target = options.mcpTarget;
  if (target?.[VERIFIED_MCP_EXECUTABLE_TARGET] === true
    && target.source === 'verified_npm_registry'
    && compatibleMcpTargetVersion(target.version)
    && validSha512Integrity(target.integrity)
    && target.source_sha === null) return target;
  return resolveMcpTargetVersion();
}

function expectedMcpInspectionVersion(options = {}) {
  if (options.expectedVersion === MCP_ADAPTER_VERSION) return MCP_ADAPTER_VERSION;
  return executableMcpTarget({ mcpTarget: options.expectedTarget }).version;
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
    parsedStableMcpVersion(version) && version !== targetVersion
      ? `@getmarrow/mcp@${targetVersion}`
      : match
  ));
}

function alignMcpRecommendationVersions(value, targetVersion, key = '', verificationAction = null) {
  if (Array.isArray(value)) {
    return value.map((entry) => alignMcpRecommendationVersions(entry, targetVersion, key, verificationAction));
  }
  if (!value || typeof value !== 'object') {
    return /(?:command|fix|instruction|next_action|notice)$/i.test(key)
      ? verificationAction && typeof value === 'string' && /@getmarrow\/mcp@\d+\.\d+\.\d+/.test(value)
        ? verificationAction
        : retargetMcpDowngradeRecommendation(value, targetVersion)
      : value;
  }
  return Object.fromEntries(Object.entries(value).map(([entryKey, entryValue]) => [
    entryKey,
    alignMcpRecommendationVersions(entryValue, targetVersion, entryKey, verificationAction),
  ]));
}
// Claude Code hooks use the Claude-specific entrypoints that MCP setup also writes. MCP labels a
// hook by its entrypoint, and the bare spellings resolve to the generic mcp-client harness.
// Writing the same spelling as `marrow-mcp setup` means neither writer rewrites the other.
const MCP_CONTEXT_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp claude-context-hook`;
const MCP_PRE_ACTION_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp claude-pre-action-hook`;
const MCP_ACTION_RESULT_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp claude-hook`;
const MCP_SESSION_END_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp claude-session-hook`;
// Host approvals: a pass-through PermissionRequest hook (installed async) that only notes that
// Claude Code is about to show its own permission dialog for a held call, and PostToolBatch
// (async, the result entrypoint) that settles a declined dialog. Same spelling and fields as
// `marrow-mcp setup` writes, so neither writer rewrites the other.
const MCP_PERMISSION_REQUEST_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp claude-permission-request-hook`;
const CODEX_CONTEXT_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp codex-context-hook`;
const CODEX_PRE_ACTION_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp codex-pre-action-hook`;
const CODEX_ACTION_RESULT_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp codex-hook`;
const CODEX_SESSION_END_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp codex-session-hook`;
const CURSOR_PRE_ACTION_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp cursor-pre-action-hook`;
const CURSOR_ACTION_RESULT_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp cursor-hook`;
const CURSOR_SESSION_END_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp cursor-session-hook`;
const CURSOR_CONTEXT_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp cursor-context-hook`;
// Cursor's beforeMCPExecution takes no matcher, so this guard answers allow at once for
// Marrow's own tools (server "marrow", tools marrow_*), as the old preToolUse matcher exempted
// them, without starting npx. Every other call goes to the MCP entrypoint with its input
// unchanged; a crash, a non-zero exit or output that is not a JSON object blocks (exit 2).
const CURSOR_MCP_GUARD_FAILURE = 'Marrow governance adapter was unavailable; this MCP call is blocked.';
const CURSOR_MCP_PRE_ACTION_GUARD_SOURCE = [
  'const {spawn}=require("node:child_process");',
  'const chunks=[];let size=0,over=false,done=false;',
  `const fail=()=>{if(done)return;done=true;process.exitCode=2;process.stderr.write(${JSON.stringify(`${CURSOR_MCP_GUARD_FAILURE}\n`)},()=>process.exit(2));};`,
  'process.stdin.on("error",fail);',
  'process.stdin.on("data",c=>{size+=c.length;if(size>16777216){over=true;return;}chunks.push(c);});',
  'process.stdin.on("end",()=>{if(over){fail();return;}const raw=Buffer.concat(chunks);let ev=null;try{ev=JSON.parse(raw.toString("utf8"));}catch{ev=null;}',
  'if(ev&&typeof ev==="object"&&ev.mcp_server_name==="marrow"&&typeof ev.tool_name==="string"&&/^marrow_[a-z0-9_]{1,64}$/.test(ev.tool_name)){done=true;process.stdout.write("{\\"permission\\":\\"allow\\"}\\n");return;}',
  'let child;try{',
  `child=spawn(process.platform==="win32"?"npx.cmd":"npx",${JSON.stringify(['-y', `--package=${MCP_PACKAGE_SPEC}`, 'marrow-mcp', 'cursor-pre-action-hook'])},{stdio:["pipe","pipe","ignore"]});`,
  '}catch{fail();return;}',
  'let out="",bytes=0;child.stdout.on("data",c=>{bytes+=c.length;if(bytes<=65536)out+=c.toString("utf8");});',
  'child.on("error",fail);child.stdin.on("error",()=>{});',
  'child.on("close",code=>{if(done)return;let p=null;try{p=JSON.parse(out);}catch{p=null;}if(code!==0||bytes>65536||!p||typeof p!=="object"||Array.isArray(p)){fail();return;}done=true;process.stdout.write(JSON.stringify(p)+"\\n");});',
  'child.stdin.end(raw);});',
].join('');
const CURSOR_MCP_PRE_ACTION_GUARD_COMMAND = `node -e '${CURSOR_MCP_PRE_ACTION_GUARD_SOURCE}'`;
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
// Host approvals: the BeforeTool guard also passes the hold denial that carries a typed-reply
// code for the user only (`systemMessage`), so it checks the JSON shape instead of two fixed
// strings. Anything else (a crash, a timeout before Gemini's own, invalid or oversized output)
// still blocks with the fixed launch-failure text. stdin goes straight to the MCP entrypoint.
const GEMINI_HOOK_GUARD_TIMEOUT_MS = 4500;
const GEMINI_PRE_ACTION_GUARD_SOURCE = [
  'const {spawn}=require("node:child_process");',
  'const valid=value=>{try{const p=JSON.parse(value);if(!p||typeof p!=="object"||Array.isArray(p)||JSON.stringify(p)!==value)return false;const keys=Object.keys(p);',
  'if(p.decision==="allow")return keys.length===1;',
  'if(p.decision!=="deny"||typeof p.reason!=="string"||p.reason.length<1||p.reason.length>500)return false;',
  'if(keys.length===2)return keys.includes("reason");',
  'return keys.length===3&&keys.includes("systemMessage")&&typeof p.systemMessage==="string"&&p.systemMessage.length>0&&p.systemMessage.length<=600;}catch{return false;}};',
  'let child=null,timer=null,done=false,output="",bytes=0;',
  // Exits at once: a grandchild still holding the pipe must not keep the hook alive until the
  // host's own timeout, which Gemini treats as a non-blocking failure.
  `const fail=()=>{if(done)return;done=true;if(timer)clearTimeout(timer);try{if(child){if(child.stdout)child.stdout.destroy();if(!child.killed)child.kill("SIGKILL");}}catch{}process.exitCode=2;process.stderr.write(${JSON.stringify(`${GEMINI_LAUNCH_FAILURE}\n`)},()=>process.exit(2));};`,
  'try{',
  `child=spawn(process.platform==="win32"?"npx.cmd":"npx",${JSON.stringify(['-y', `--package=${MCP_PACKAGE_SPEC}`, 'marrow-mcp', 'gemini-pre-action-hook'])},{stdio:["inherit","pipe","ignore"]});`,
  `timer=setTimeout(fail,${GEMINI_HOOK_GUARD_TIMEOUT_MS});`,
  'child.stdout.on("data",chunk=>{if(done)return;bytes+=chunk.length;if(bytes>4096){fail();return;}output+=chunk.toString("utf8");});',
  'child.on("error",fail);',
  'child.on("close",code=>{if(done)return;const out=output.replace(/\\n+$/,"");if(code!==0||!valid(out)){fail();return;}done=true;clearTimeout(timer);process.stdout.write(out+"\\n");});',
  '}catch{fail();}',
].join('');
const GEMINI_PRE_ACTION_GUARD_COMMAND = `node -e '${GEMINI_PRE_ACTION_GUARD_SOURCE}'`;
// BeforeAgent records a typed reply ("marrow approve CODE") in a local interactive session. It
// never blocks the prompt: only a confirmation for the user (`systemMessage`) and a retry note
// for the agent pass; any failure prints `{}` and the prompt continues. A held action stays
// denied at BeforeTool until Marrow has the answer, so this hook cannot let one run.
const GEMINI_CONTEXT_GUARD_SOURCE = [
  'const {spawn}=require("node:child_process");',
  'const text=(v)=>typeof v==="string"&&v.length<=1000;',
  'const valid=value=>{try{const p=JSON.parse(value);if(!p||typeof p!=="object"||Array.isArray(p)||JSON.stringify(p)!==value)return false;',
  'for(const key of Object.keys(p)){if(key==="systemMessage"){if(!text(p.systemMessage))return false;}',
  'else if(key==="hookSpecificOutput"){const h=p.hookSpecificOutput;if(!h||typeof h!=="object"||Array.isArray(h)||Object.keys(h).sort().join()!=="additionalContext,hookEventName"||h.hookEventName!=="BeforeAgent"||!text(h.additionalContext))return false;}',
  'else return false;}return true;}catch{return false;}};',
  'let child=null,timer=null,done=false,output="",bytes=0;',
  'const neutral=()=>{if(done)return;done=true;if(timer)clearTimeout(timer);try{if(child){if(child.stdout)child.stdout.destroy();if(!child.killed)child.kill("SIGKILL");}}catch{}process.exitCode=0;process.stdout.write("{}\\n",()=>process.exit(0));};',
  'try{',
  `child=spawn(process.platform==="win32"?"npx.cmd":"npx",${JSON.stringify(['-y', `--package=${MCP_PACKAGE_SPEC}`, 'marrow-mcp', 'gemini-context-hook'])},{stdio:["inherit","pipe","ignore"]});`,
  `timer=setTimeout(neutral,${GEMINI_HOOK_GUARD_TIMEOUT_MS});`,
  'child.stdout.on("data",chunk=>{if(done)return;bytes+=chunk.length;if(bytes>4096){neutral();return;}output+=chunk.toString("utf8");});',
  'child.on("error",neutral);',
  'child.on("close",code=>{if(done)return;const out=output.replace(/\\n+$/,"");if(code!==0||!valid(out)){neutral();return;}done=true;clearTimeout(timer);process.stdout.write(out+"\\n");});',
  '}catch{neutral();}',
].join('');
const GEMINI_CONTEXT_HOOK_COMMAND = `node -e '${GEMINI_CONTEXT_GUARD_SOURCE}'`;
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
const NATIVE_HOOK_MATCHER = 'Bash|Edit|Write|MultiEdit|Read|Glob|Grep|Search|WebSearch|Task|functions\\.(?!mcp__marrow__marrow_).*|mcp__(?!marrow__marrow_).*';
const CODEX_NATIVE_HOOK_MATCHER = 'Bash|apply_patch|Edit|Write|MultiEdit|mcp__(?!marrow__marrow_).*|functions\\.(?!marrow_).*';
const CURSOR_NATIVE_HOOK_MATCHER = 'Shell|Write|Delete|Task|Read|Glob|Grep|Search|WebSearch|List|MCP:(?!marrow(?:_.*|:marrow_.*)$).*';
// Host approvals: Cursor enforces an "ask" only on beforeShellExecution and beforeMCPExecution,
// never on preToolUse. Shell calls move to beforeShellExecution (it runs in cloud agents too).
// MCP calls stay in preToolUse as well, because cloud agents never run beforeMCPExecution: the
// MCP hook defers there to beforeMCPExecution only in a local interactive session (sessionStart
// evidence) and holds in cloud and background agents. The result hooks keep the full matcher.
const CURSOR_PRE_TOOL_USE_HOST_APPROVAL_MATCHER = 'Write|Delete|Task|Read|Glob|Grep|Search|WebSearch|List|MCP:(?!marrow(?:_.*|:marrow_.*)$).*';
// Cursor's gating hooks are failClosed: a cold npx start on a slow network must not block a
// call, so they get room beyond the MCP hook's own 4-second budget.
const CURSOR_GATE_HOOK_TIMEOUT_SECONDS = 15;
const CURSOR_EXECUTION_PRE_EVENTS = Object.freeze(['beforeShellExecution', 'beforeMCPExecution']);
const CURSOR_EXECUTION_POST_EVENTS = Object.freeze(['afterShellExecution', 'afterMCPExecution']);
const GEMINI_NATIVE_HOOK_MATCHER = '^(?:run_shell_command|write_file|replace|edit_file|delete_file|read_file|read_many_files|glob|grep_search|list_directory|get_file_info|web_search|google_web_search|mcp_(?!marrow_marrow_)[A-Za-z0-9_]{1,192})$';
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
  const expectedVersion = expectedMcpInspectionVersion(options);
  const unknownVersionProcesses = active.filter((version) => version === 'unknown').length;
  const aheadUnverifiedVersions = unverifiedAheadMcpVersions(versions, expectedVersion);
  const staleVersions = versions.filter((version) => version !== expectedVersion
    && !aheadUnverifiedVersions.includes(version));
  const mixedVersions = versions.length > 1 || (versions.length > 0 && unknownVersionProcesses > 0);
  const stale = staleVersions.length > 0;
  const aheadUnverified = aheadUnverifiedVersions.length > 0;
  const needsRepair = stale || mixedVersions || unknownVersionProcesses > 0 || aheadUnverified;
  const automaticRepairSuppressed = aheadUnverified;
  return {
    available: process.platform === 'linux' || Array.isArray(options.commands),
    expected_version: expectedVersion,
    active_processes: active.length,
    active_versions: versions,
    unknown_version_processes: unknownVersionProcesses,
    stale_versions: staleVersions,
    ahead_unverified: aheadUnverified,
    ahead_unverified_versions: aheadUnverifiedVersions,
    mixed_versions: mixedVersions,
    healthy: !needsRepair,
    automatic_repair_suppressed: automaticRepairSuppressed,
    registry_verification_required: aheadUnverified,
    exact_fix: automaticRepairSuppressed
      ? mcpRegistryVerificationAction(aheadUnverifiedVersions)
      : needsRepair ? INSTALLER_UPDATE_COMMAND : null,
    restart_required: needsRepair && !automaticRepairSuppressed,
    restart_instruction: needsRepair && !automaticRepairSuppressed
      ? INSTALLER_RESTART_INSTRUCTION
      : null,
    verification_command: needsRepair && !automaticRepairSuppressed ? INSTALLER_DOCTOR_COMMAND : null,
  };
}

function inspectMcpConfigurations(detection, options = {}) {
  const home = options.home || process.env.HOME || process.env.USERPROFILE || os.homedir();
  const configuredPaths = Array.isArray(options.paths) ? options.paths : [
    detection?.paths?.agentsMd,
    detection?.paths?.mcpJson,
    detection?.paths?.claudeSettings,
    detection?.paths?.codexHooks,
    detection?.paths?.cursorHooks,
    detection?.paths?.cursorMcp,
    detection?.paths?.clinePreToolUseHook,
    detection?.paths?.clinePostToolUseHook,
    detection?.paths?.clineTaskCancelHook,
    detection?.paths?.windsurfHooks,
    detection?.paths?.geminiSettings,
    detection?.paths?.grokHooks,
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
      const inspected = path.basename(filePath) === 'AGENTS.md'
        ? marrowManagedBlockInText(raw)
        : raw;
      const specs = mcpVersionsInText(inspected);
      if (/@getmarrow\/mcp(?:@|["'\s])/.test(inspected)) {
        configurationsFound += 1;
        if (specs.length === 0) unknownVersionConfigurations += 1;
      }
      versions.push(...specs);
    } catch {
      // Doctor remains read-only and ignores inaccessible or malformed owner configuration.
    }
  }
  const configuredVersions = [...new Set(versions)].sort();
  const expectedVersion = expectedMcpInspectionVersion(options);
  const aheadUnverifiedVersions = unverifiedAheadMcpVersions(configuredVersions, expectedVersion);
  const staleVersions = configuredVersions.filter((version) => version !== expectedVersion
    && !aheadUnverifiedVersions.includes(version));
  const mixedVersions = configuredVersions.length > 1
    || (configuredVersions.length > 0 && unknownVersionConfigurations > 0);
  const aheadUnverified = aheadUnverifiedVersions.length > 0;
  const healthy = staleVersions.length === 0 && !mixedVersions
    && unknownVersionConfigurations === 0 && !aheadUnverified;
  return {
    expected_version: expectedVersion,
    files_checked: filesChecked,
    configurations_found: configurationsFound,
    configured_versions: configuredVersions,
    unknown_version_configurations: unknownVersionConfigurations,
    stale_versions: staleVersions,
    ahead_unverified: aheadUnverified,
    ahead_unverified_versions: aheadUnverifiedVersions,
    mixed_versions: mixedVersions,
    healthy,
    automatic_repair_suppressed: aheadUnverified,
    registry_verification_required: aheadUnverified,
    exact_fix: healthy
      ? null
      : aheadUnverified
        ? mcpRegistryVerificationAction(aheadUnverifiedVersions)
        : INSTALLER_UPDATE_COMMAND,
    restart_required: !healthy && !aheadUnverified,
    restart_instruction: !healthy && !aheadUnverified ? INSTALLER_RESTART_INSTRUCTION : null,
    verification_command: !healthy && !aheadUnverified ? INSTALLER_DOCTOR_COMMAND : null,
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

// What an error may print of an argument it does not know: an option's name (the text before
// `=`, never its value), or a short plain word. Anything else may be a pasted key and is not shown.
function argumentLabel(arg) {
  const text = String(arg ?? '');
  if (text.startsWith('-')) return text.split('=')[0].slice(0, 64);
  return /^[a-z][a-z-]{0,23}$/.test(text) ? text : '(a value that is not an option; not shown)';
}

function parseArgs(argv, env = process.env) {
  const options = {
    cwd: process.cwd(),
    home: env.HOME || env.USERPROFILE || os.homedir(),
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
    loopGuardSelfTest: true,
    selfTestExplicitlyDisabled: false,
    json: false,
    activate: false,
    controller: true,
    // Hooks start a verified local copy of the pinned MCP (installed on write runs) instead of
    // npx. MARROW_LOCAL_RUNTIME=0 or --no-local-runtime keeps them on npx.
    mcpLocalRuntime: env.MARROW_LOCAL_RUNTIME !== '0',
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
    else if (arg === 'uninstall' || arg === '--uninstall') {
      explicitOperation = true;
      options.uninstall = true;
    }
    else if (arg === '--doctor' || arg === 'doctor' || arg === 'check') {
      explicitOperation = true;
      options.doctor = true;
    }
    else if (arg === '--json') options.json = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--no-self-test') {
      explicitOperation = true;
      options.selfTest = false;
      options.selfTestExplicitlyDisabled = true;
    }
    else if (arg === '--no-controller') options.controller = false;
    else if (arg === '--no-local-runtime') options.mcpLocalRuntime = false;
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
      throw new Error(`Unknown argument: ${argumentLabel(arg)}`);
    }
  }

  if (options.uninstall && (options.activate || options.repair || options.doctor)) {
    throw new Error('uninstall cannot be combined with activate, update, repair, or doctor');
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
  npx @getmarrow/install uninstall [--yes]

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
  --no-local-runtime Keep hooks on npx instead of the verified local MCP copy in ~/.marrow/runtime
  --no-self-test     Skip API smoke/self-test
  --verbose          Print the full report instead of the one-line summary and log file
  uninstall          Preview removing only Marrow's own hooks, MCP server entries, instructions and
                     the local MCP runtime; add --yes to remove them. Your own hooks and settings
                     are kept.

The API key comes from MARROW_API_KEY, or from the owner-only ~/.marrow/env when unset.

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
  if (detection.claudeCodeProject ?? detection.claudeCode) return 'claude-code';
  if (detection.cursor) return 'cursor';
  if (detection.cline) return 'cline';
  if (detection.windsurf) return 'windsurf';
  if (detection.gemini) return 'gemini';
  if (detection.codexProject) return 'codex';
  // Home-level harnesses rank below project markers; a shared AGENTS.md is a weaker signal.
  if (detection.claudeCode) return 'claude-code';
  if (detection.hermes) return 'hermes';
  if (detection.codex) return 'codex';
  return 'custom';
}

function executableOnPath(name, env = process.env) {
  const extensions = process.platform === 'win32' ? ['.cmd', '.exe', ''] : [''];
  for (const directory of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      try {
        const stat = fs.statSync(path.join(directory, `${name}${extension}`));
        if (stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111) !== 0)) return true;
      } catch {
        // Missing or unreadable PATH entries are not a detection signal.
      }
    }
  }
  return false;
}

// Harnesses installed for the user rather than in the project. Each detector is one bounded
// check; the list is extended one harness at a time. MARROW_CLIENT still overrides detection.
const HOME_HARNESS_DETECTORS = Object.freeze([
  Object.freeze({
    client: 'hermes',
    detect: ({ home, env }) => exists(hermesPaths(home, env).config) || executableOnPath('hermes', env),
  }),
]);

function detectHomeHarnesses(home, env) {
  return Object.fromEntries(HOME_HARNESS_DETECTORS.map((detector) => {
    try {
      return [detector.client, Boolean(detector.detect({ home, env }))];
    } catch {
      return [detector.client, false];
    }
  }));
}

// AGENTS.md is shared by many agents, and earlier installers created it with only the Marrow
// block, which then made every later run treat the project as Codex. Only owner content or a
// .codex directory holding more than Marrow's own hooks file is a Codex signal.
function agentsMdHasOwnerContent(filePath) {
  const raw = safeRead(filePath);
  if (!raw.trim()) return false;
  const block = marrowManagedBlockInText(raw);
  return (block ? raw.replace(block, '') : raw).trim().length > 0;
}

function codexDirectoryIsOwnerConfigured(directory) {
  let entries;
  try {
    entries = fs.readdirSync(directory);
  } catch {
    return false;
  }
  // Marrow only ever creates .codex/hooks.json, so any other content, or an empty directory the
  // owner or Codex created, is an owner signal.
  if (entries.length === 0 || entries.some((entry) => entry !== 'hooks.json')) return true;
  const settings = safeJsonObject(path.join(directory, 'hooks.json'));
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? Object.values(settings.hooks) : [];
  return hooks.some((entries) => Array.isArray(entries) && entries.some((entry) => (
    Array.isArray(entry?.hooks) && entry.hooks.some((hook) => !marrowHookSubcommand(hook?.command))
  )));
}

function exists(filePath) {
  return fs.existsSync(filePath);
}

function safeRead(filePath) {
  return exists(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function assertSafeGrokHookTarget(homePath, targetPath) {
  const home = path.resolve(homePath);
  const target = path.resolve(targetPath);
  const expected = path.join(home, '.grok', 'hooks', 'marrow.json');
  if (target !== expected) throw new Error('Refusing Grok hook write outside the direct owner hook path');
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  const checkDirectory = (directory) => {
    if (!exists(directory)) return;
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (uid !== null && stat.uid !== uid) || (stat.mode & 0o022) !== 0) {
      throw new Error(`Refusing Grok hook write through unsafe owner path: ${directory}`);
    }
  };
  checkDirectory(home);
  checkDirectory(path.join(home, '.grok'));
  checkDirectory(path.join(home, '.grok', 'hooks'));
  if (exists(target)) {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()
      || (uid !== null && stat.uid !== uid) || (stat.mode & 0o022) !== 0) {
      throw new Error('Refusing Grok hook write to unsafe owner file');
    }
  }
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
    hermesHome: hermesPaths(home, env).home,
    hermesConfig: hermesPaths(home, env).config,
    hermesEnv: hermesPaths(home, env).env,
  };
  const homeHarnesses = detectHomeHarnesses(home, env);
  const codexProject = codexDirectoryIsOwnerConfigured(path.join(root, '.codex'));
  // Claude Code is detected from the project (CLAUDE.md, .claude/settings.json) or, for a repo
  // that has neither yet, from the user's installation: ~/.claude/, ~/.claude.json or `claude`
  // on PATH. Either way the project gets .claude/settings.json.
  const claudeCodeProject = exists(paths.claudeSettings) || exists(paths.claudeMd);
  const claudeCodeSource = claudeCodeProject ? 'project'
    : exists(path.join(home, '.claude')) || exists(path.join(home, '.claude.json')) ? 'home'
    : executableOnPath('claude', env) ? 'path'
    : null;

  return {
    root,
    home,
    paths,
    node: exists(paths.packageJson),
    python: exists(paths.pyproject) || exists(paths.requirements) || exists(paths.setupPy),
    claudeCode: Boolean(claudeCodeSource),
    claudeCodeProject,
    claudeCodeSource,
    cursor: exists(path.join(root, '.cursor')),
    cline: exists(path.join(root, '.clinerules')),
    windsurf: exists(path.join(root, '.windsurf')),
    gemini: exists(path.join(root, '.gemini')),
    grok: exists(path.join(home, '.grok')) || exists(path.join(root, '.grok')),
    codexProject,
    codex: codexProject || agentsMdHasOwnerContent(paths.agentsMd),
    hermes: homeHarnesses.hermes === true,
    hermesConfig: exists(paths.hermesConfig),
    mcpConfig: exists(paths.mcpJson) || exists(paths.cursorMcp) || exists(paths.claudeSettings),
    openclaw: exists(paths.openclawJson) || Boolean(env.OPENCLAW_HOME || env.OPENCLAW_AGENT_ID),
  };
}

const MARROW_MANAGED_ROOT_FILES = Object.freeze([
  'AGENTS.md',
  'CLAUDE.md',
  '.mcp.json',
  path.join('.claude', 'settings.json'),
  path.join('.codex', 'hooks.json'),
  path.join('.cursor', 'hooks.json'),
  path.join('.cursor', 'mcp.json'),
  path.join('.cursor', 'rules', 'marrow.mdc'),
  path.join('.windsurf', 'hooks.json'),
  path.join('.gemini', 'settings.json'),
  path.join('.clinerules', 'hooks', 'PreToolUse'),
  path.join('.clinerules', 'hooks', 'PostToolUse'),
  path.join('.clinerules', 'hooks', 'TaskCancel'),
  path.join('.marrow', 'passive-runtime.mjs'),
]);
const MARROW_MANAGED_TEXT_RE = /@getmarrow\/mcp|marrow-mcp|<!-- marrow:passive-start -->/;

function marrowManagedRootFiles(root) {
  return MARROW_MANAGED_ROOT_FILES.filter((relative) => {
    try {
      const filePath = path.join(path.resolve(root), relative);
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) return false;
      return relative === path.join('.marrow', 'passive-runtime.mjs')
        || MARROW_MANAGED_TEXT_RE.test(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return false;
    }
  });
}

function shellArgument(value) {
  return /^[A-Za-z0-9_./:@%+=-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function assertUpdateTargetsManagedRoot(detection) {
  const root = path.resolve(detection.root);
  const home = path.resolve(detection.home);
  if (root === home || marrowManagedRootFiles(root).length > 0) return;
  if (marrowManagedRootFiles(home).length === 0) return;
  throw new Error([
    `Refusing to update ${root}: it has no Marrow-managed files, and update never creates new Marrow project files in an unmanaged directory.`,
    `Marrow-managed configuration was found at ${home}. To update it, run: ${INSTALLER_UPDATE_COMMAND} --cwd ${shellArgument(home)}`,
    `To install Marrow into ${root} deliberately, run the install command from that directory instead: npx -y @getmarrow/install@latest`,
  ].join('\n'));
}

function findLikelyEnvFiles(detection, env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const candidates = [
    path.join(detection.root, '.env'),
    path.join(detection.root, '.env.local'),
    path.join(detection.root, '.marrow', 'env'),
    path.join(detection.root, '.marrow', 'env.local'),
    path.join(home, '.marrow', 'env'),
  ];
  return candidates.filter((filePath) => {
    if (!exists(filePath)) return false;
    const raw = safeRead(filePath);
    return /\bMARROW_API_KEY\s*=/.test(raw) || /\bMARROW_KEY(_[A-Z0-9]+)?\s*=/.test(raw);
  });
}

function passiveInstructions(options = {}) {
  const hostApprovals = options.hostApprovals === true;
  const geminiHooks = hostApprovals ? 'BeforeTool, AfterTool, AfterAgent, and BeforeAgent' : 'BeforeTool, AfterTool, and AfterAgent';
  const approvals = hostApprovals
    ? '\n- When Marrow holds an action for approval, the operator approves it in the host\'s own permission prompt, or with the typed reply the hook shows them. With nobody at the prompt, the action waits quietly: do not run it, carry on with other work, and tell the person it is waiting. Marrow sends the account owner a one-tap link only for actions the owner approves personally, to reverse the owner\'s own decline when asked, or when the owner turned on unattended pings. Never ask anyone to log in to a dashboard to approve, and never report, write, or claim an approval yourself. Retry the held action only after the approval or when the operator asks.'
    : '';
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
- Cursor and Composer use configured native hooks after restart and \`/hooks\` trust review. Cline uses its configured PreToolUse, PostToolUse, and TaskCancel hooks only after Enable Hooks, restart, executable trust, and workspace trust; TaskComplete is not claimed as current coverage. Windsurf uses configured native pre-action, success-result, and response-closeout hooks only after restart, trust review, and leaving Restricted Mode. Gemini CLI uses configured ${geminiHooks} hooks only after restart and project fingerprint review and approval in \`/hooks panel\`; explicit user disablement is preserved. Grok uses global native PreToolUse, PostToolUse/PostToolUseFailure, and one nonblocking Stop closeout only after restart and \`/hooks\` inspection; Grok hooks remain user-toggleable. MCP tools remain on demand. Codex uses configured native hooks after restart and \`/hooks\` trust review. The governed wrapper remains an explicit bounded fallback.
- Before the session ends, close open work with session-end auto-commit or \`marrow_commit\`. Record model usage only when the host response includes counts.
- After meaningful work, record the outcome so future agents learn from it.
- After Marrow blocks, warns, or requires review, use the decision trace receipt to tell the operator what changed and which recorded workflow or proof is required. Stay quiet for routine low-risk work.${approvals}
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
      agentId: process.env.MARROW_FLEET_AGENT_ID || process.env.MARROW_AGENT_ID || installedAgentId || undefined,
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
  const agentId = String(options.agentId || '').trim();
  const client = String(options.client || 'custom').trim() || 'custom';
  const baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
  const agentLine = agentId
    ? `MARROW_FLEET_AGENT_ID=${JSON.stringify(agentId)}`
    : '# MARROW_FLEET_AGENT_ID is optional. Unset, Marrow uses the key\'s bound agent or the plan seat.';
  return `MARROW_API_KEY=mrw_live_replace_me
MARROW_BASE_URL=${JSON.stringify(baseUrl)}
${agentLine}
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

// Hook files are read with Marrow's hook commands in their canonical (npx) form, whether they
// start through npx or the local runtime, so every check and merge sees one spelling; writes
// switch them to the local runtime again when it is verified.
function parseJsonObject(filePath) {
  const raw = safeRead(filePath).trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in ${filePath}`);
  }
  return mapHookCommands(parsed, delocalizeHookCommand);
}

function canonicalJsonValue(value) {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJsonValue(value[key])]));
}

function sameJsonDocument(left, right) {
  try {
    return JSON.stringify(canonicalJsonValue(JSON.parse(left.trim())))
      === JSON.stringify(canonicalJsonValue(JSON.parse(right.trim())));
  } catch {
    return false;
  }
}

// JSON.parse keeps the last duplicate key, so equal documents keep their bytes only when the
// raw text also pins the same MCP versions; otherwise a stale earlier duplicate is never repaired.
function equivalentManagedJson(before, after) {
  const pinnedVersions = (text) => [...new Set(mcpVersionsInText(text))].sort().join(',');
  return sameJsonDocument(before, after) && pinnedVersions(before) === pinnedVersions(after);
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
    /^npx\s+(?:-y\s+)?(?:--package=@getmarrow\/mcp(?:@[^\s]+)?\s+marrow-mcp|@getmarrow\/mcp(?:@[^\s]+)?)\s+(?:(?:claude|cline|codex|cursor|gemini|grok|windsurf)-)?(context-hook|pre-action-hook|hook|session-hook|permission-request-hook)$/,
  );
  return match?.[1] || null;
}

// Which existing Marrow handler keeps its owner options (such as a timeout) when entries are
// merged: the exact canonical entry, then a pinned entry with the same matcher (an earlier
// version or entrypoint spelling of the canonical one), then the first Marrow handler.
function marrowHandlerRank(hook, command, exactMatcher) {
  if (hook.command === command && exactMatcher) return 3;
  if (exactMatcher && /^npx\s+-y\s+--package=@getmarrow\/mcp@[^\s]+\s+marrow-mcp\s+/.test(String(hook.command || '').trim())) return 2;
  return 1;
}

function reconcileMarrowCommandHook(settings, eventName, subcommand, command, matcher, handlerOptions = {}) {
  const original = Array.isArray(settings?.hooks?.[eventName]) ? settings.hooks[eventName] : [];
  let preferredHandler = null;
  let preferredRank = 0;
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
        const rank = detected === subcommand ? marrowHandlerRank(hook, command, exactMatcher) : 0;
        if (rank > preferredRank) {
          preferredHandler = hook;
          preferredRank = rank;
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

// The host-approval hooks Claude Code needs besides the core five (see upsertClaudeHooks).
function claudeHostApprovalHooksConfigured(settings, targetCommand = (command) => command) {
  return {
    permission_request: exactHookConfigured(settings, 'PermissionRequest', targetCommand(MCP_PERMISSION_REQUEST_HOOK_COMMAND), NATIVE_HOOK_MATCHER),
    post_tool_batch: exactHookConfigured(settings, 'PostToolBatch', targetCommand(MCP_ACTION_RESULT_HOOK_COMMAND)),
  };
}

function claudeNativeHookFingerprint(settings, options = {}) {
  const hostApprovals = options.hostApprovals ?? hostApprovalHooksSupported();
  const contract = {
    schema: 'marrow-claude-native-hooks.v3',
    adapter_version: MCP_ADAPTER_VERSION,
    expected_hooks: NATIVE_EXPECTED_HOOKS,
    ...(hostApprovals ? {
      host_approvals: {
        configured: claudeHostApprovalHooksConfigured(settings),
        descriptors: {
          permission_request: exactHookDescriptors(settings, 'PermissionRequest', MCP_PERMISSION_REQUEST_HOOK_COMMAND, NATIVE_HOOK_MATCHER),
          post_tool_batch: exactHookDescriptors(settings, 'PostToolBatch', MCP_ACTION_RESULT_HOOK_COMMAND),
        },
        active_marrow_handlers: {
          permission_request: marrowHookDescriptors(settings, 'PermissionRequest'),
          post_tool_batch: marrowHookDescriptors(settings, 'PostToolBatch'),
        },
      },
    } : {}),
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

function upsertClaudeHooks(settingsPath, options = {}) {
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
  if (options.hostApprovals) {
    // Both async, exactly as `marrow-mcp setup` writes them: the marker never delays or answers
    // the dialog, and PostToolBatch settles a declined dialog in the background.
    settings.hooks.PermissionRequest = reconcileMarrowCommandHook(
      settings, 'PermissionRequest', 'permission-request-hook', MCP_PERMISSION_REQUEST_HOOK_COMMAND, NATIVE_HOOK_MATCHER,
      { async: true },
    );
    settings.hooks.PostToolBatch = reconcileMarrowCommandHook(
      settings, 'PostToolBatch', 'hook', MCP_ACTION_RESULT_HOOK_COMMAND, undefined,
      { async: true },
    );
  }

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

// A Marrow Cursor entry: the npx entrypoint, or the node guard that names it as JSON items.
function cursorMarrowHookSubcommand(command) {
  const direct = marrowHookSubcommand(command);
  if (direct) return direct;
  if (typeof command !== 'string') return null;
  const guarded = command.match(/@getmarrow\/mcp@[^\s"',]+["'],["']marrow-mcp["'],["']cursor-(pre-action-hook|context-hook|hook|session-hook)["']/);
  return guarded?.[1] || null;
}

function reconcileCursorHook(settings, eventName, subcommand, canonical) {
  const original = Array.isArray(settings?.hooks?.[eventName]) ? settings.hooks[eventName] : [];
  const retained = original.filter((entry) => !(
    entry && typeof entry === 'object' && !Array.isArray(entry)
    && cursorMarrowHookSubcommand(entry.command)
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
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !cursorMarrowHookSubcommand(entry.command)) return [];
    return [{
      matcher: typeof entry.matcher === 'string' ? entry.matcher : null,
      command: String(entry.command).trim(),
      timeout: typeof entry.timeout === 'number' && Number.isFinite(entry.timeout) ? entry.timeout : null,
      failClosed: entry.failClosed === true,
      async: entry.async === false ? false : null,
    }];
  });
}

// The Cursor hooks that host approvals add (see upsertCursorHooks), as configured checks.
function cursorHostApprovalHooksConfigured(settings, targetCommand = (command) => command) {
  const pre = targetCommand(CURSOR_PRE_ACTION_HOOK_COMMAND);
  const post = targetCommand(CURSOR_ACTION_RESULT_HOOK_COMMAND);
  const gate = { timeout: CURSOR_GATE_HOOK_TIMEOUT_SECONDS, failClosed: true, async: false };
  return {
    pre_tool_use: exactCursorHookConfigured(settings, 'preToolUse', pre, CURSOR_PRE_TOOL_USE_HOST_APPROVAL_MATCHER, gate),
    beforeShellExecution: exactCursorHookConfigured(settings, 'beforeShellExecution', pre, undefined, gate),
    beforeMCPExecution: exactCursorHookConfigured(settings, 'beforeMCPExecution', targetCommand(CURSOR_MCP_PRE_ACTION_GUARD_COMMAND), undefined, gate),
    ...Object.fromEntries(CURSOR_EXECUTION_POST_EVENTS.map((event) => [event, exactCursorHookConfigured(settings, event, post, undefined, {
      timeout: CODEX_HOOK_TIMEOUT_SECONDS,
    })])),
    sessionStart: exactCursorHookConfigured(settings, 'sessionStart', targetCommand(CURSOR_SESSION_END_HOOK_COMMAND), undefined, {
      timeout: CODEX_HOOK_TIMEOUT_SECONDS,
    }),
    beforeSubmitPrompt: exactCursorHookConfigured(settings, 'beforeSubmitPrompt', targetCommand(CURSOR_CONTEXT_HOOK_COMMAND), undefined, {
      timeout: CODEX_HOOK_TIMEOUT_SECONDS,
    }),
  };
}

function cursorNativeHookFingerprint(settings, options = {}) {
  const hostApprovals = options.hostApprovals ?? hostApprovalHooksSupported();
  const contract = {
    schema: 'marrow-cursor-native-hooks.v1',
    adapter_version: MCP_ADAPTER_VERSION,
    expected_hooks: ['pre_action', 'action_result', 'outcome_closure'],
    ...(hostApprovals ? {
      host_approvals: {
        configured: cursorHostApprovalHooksConfigured(settings),
        descriptors: Object.fromEntries([...CURSOR_EXECUTION_PRE_EVENTS, ...CURSOR_EXECUTION_POST_EVENTS, 'sessionStart', 'beforeSubmitPrompt']
          .map((event) => [event, cursorHookDescriptors(settings, event)])),
      },
    } : {}),
    configured: {
      pre_action: exactCursorHookConfigured(settings, 'preToolUse', CURSOR_PRE_ACTION_HOOK_COMMAND, hostApprovals ? CURSOR_PRE_TOOL_USE_HOST_APPROVAL_MATCHER : CURSOR_NATIVE_HOOK_MATCHER, {
        timeout: hostApprovals ? CURSOR_GATE_HOOK_TIMEOUT_SECONDS : CODEX_HOOK_TIMEOUT_SECONDS,
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

function upsertCursorHooks(hooksPath, options = {}) {
  const settings = parseJsonObject(hooksPath);
  const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? settings.hooks
    : {};
  settings.version = 1;
  const hostApprovals = options.hostApprovals === true;
  settings.hooks = {
    ...hooks,
    preToolUse: reconcileCursorHook(settings, 'preToolUse', 'pre-action-hook', {
      command: CURSOR_PRE_ACTION_HOOK_COMMAND,
      matcher: hostApprovals ? CURSOR_PRE_TOOL_USE_HOST_APPROVAL_MATCHER : CURSOR_NATIVE_HOOK_MATCHER,
      timeout: hostApprovals ? CURSOR_GATE_HOOK_TIMEOUT_SECONDS : CODEX_HOOK_TIMEOUT_SECONDS,
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
  if (hostApprovals) {
    // Cursor enforces "ask" only here. failClosed: a crash or timeout blocks the call instead
    // of letting it through (Cursor fails open by default).
    for (const eventName of CURSOR_EXECUTION_PRE_EVENTS) {
      settings.hooks[eventName] = reconcileCursorHook(settings, eventName, 'pre-action-hook', {
        command: eventName === 'beforeMCPExecution' ? CURSOR_MCP_PRE_ACTION_GUARD_COMMAND : CURSOR_PRE_ACTION_HOOK_COMMAND,
        timeout: CURSOR_GATE_HOOK_TIMEOUT_SECONDS,
        failClosed: true,
        async: false,
      });
    }
    for (const eventName of CURSOR_EXECUTION_POST_EVENTS) {
      settings.hooks[eventName] = reconcileCursorHook(settings, eventName, 'hook', {
        command: CURSOR_ACTION_RESULT_HOOK_COMMAND,
        timeout: CODEX_HOOK_TIMEOUT_SECONDS,
      });
    }
    // sessionStart tells the hooks whether the session is local and interactive (not a
    // background agent); without it Cursor holds are denied instead of asked.
    settings.hooks.sessionStart = reconcileCursorHook(settings, 'sessionStart', 'session-hook', {
      command: CURSOR_SESSION_END_HOOK_COMMAND,
      timeout: CODEX_HOOK_TIMEOUT_SECONDS,
    });
    // The typed reply ("marrow approve CODE") in a local interactive session. Never failClosed:
    // a failure must not block the operator's own prompts.
    settings.hooks.beforeSubmitPrompt = reconcileCursorHook(settings, 'beforeSubmitPrompt', 'context-hook', {
      command: CURSOR_CONTEXT_HOOK_COMMAND,
      timeout: CODEX_HOOK_TIMEOUT_SECONDS,
    });
  }
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
  const match = command.match(/@getmarrow\/mcp(?:@[^\s]+)?\s+marrow-mcp\s+gemini-(pre-action-hook|context-hook|hook|session-hook)(?:\s|['"]|$)/)
    // The node guards name the entrypoint as JSON array items.
    || command.match(/@getmarrow\/mcp@[^\s"',]+["'],["']marrow-mcp["'],["']gemini-(pre-action-hook|context-hook|hook|session-hook)["']/);
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

// The Gemini BeforeTool command: the JSON-checking guard with host approvals, otherwise the
// earlier fixed-string wrapper.
function geminiPreActionCommand(hostApprovals) {
  return hostApprovals ? GEMINI_PRE_ACTION_GUARD_COMMAND : GEMINI_PRE_ACTION_HOOK_COMMAND;
}

function geminiNativeHookFingerprint(settings, options = {}) {
  const hostApprovals = options.hostApprovals ?? hostApprovalHooksSupported();
  return crypto.createHash('sha256').update(JSON.stringify({
    schema: 'marrow-gemini-native-hooks.v1',
    adapter_version: MCP_ADAPTER_VERSION,
    expected_hooks: ['pre_action', 'action_result', 'turn_closeout'],
    explicitly_enabled: settings?.hooksConfig?.enabled === true,
    explicitly_disabled: geminiHooksExplicitlyDisabled(settings),
    configured: {
      pre_action: exactGeminiHookConfigured(
        settings, 'BeforeTool', 'marrow-before-tool', geminiPreActionCommand(hostApprovals),
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
      ...(hostApprovals ? {
        typed_reply: exactGeminiHookConfigured(
          settings, 'BeforeAgent', 'marrow-before-agent', GEMINI_CONTEXT_HOOK_COMMAND,
          undefined, GEMINI_HOOK_TIMEOUT_MS,
        ),
      } : {}),
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

function grokMarrowHookSubcommand(command) {
  const direct = marrowHookSubcommand(command);
  if (direct) return direct;
  if (typeof command !== 'string') return null;
  const guarded = command.match(
    /@getmarrow\/mcp@[^\s"',]+["'],["']marrow-mcp["'],["']grok-(pre-action-hook)["']/,
  );
  return guarded?.[1] || null;
}

function reconcileGrokHook(settings, eventName, subcommand, command, matcher, timeout) {
  const original = Array.isArray(settings?.hooks?.[eventName]) ? settings.hooks[eventName] : [];
  const retained = [];
  let preferredHandler = null;
  for (const entry of original) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Array.isArray(entry.hooks)) {
      retained.push(entry);
      continue;
    }
    const remaining = [];
    for (const handler of entry.hooks) {
      const detected = handler && typeof handler === 'object' && !Array.isArray(handler)
        && handler.type === 'command' ? grokMarrowHookSubcommand(handler.command) : null;
      if (detected) {
        if (detected === subcommand && !preferredHandler) preferredHandler = handler;
        continue;
      }
      remaining.push(handler);
    }
    if (remaining.length > 0) retained.push({ ...entry, hooks: remaining });
  }
  if (!command) return retained;
  const canonical = {
    ...(matcher === undefined ? {} : { matcher }),
    hooks: [{ ...preferredHandler, type: 'command', command, timeout }],
  };
  return [...retained, canonical];
}

function upsertGrokHooks(settingsPath) {
  const settings = parseJsonObject(settingsPath);
  const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? settings.hooks
    : {};
  settings.hooks = {
    ...hooks,
    UserPromptSubmit: reconcileGrokHook(settings, 'UserPromptSubmit', 'context-hook', GROK_CONTEXT_HOOK_COMMAND, undefined, 5),
    PreToolUse: reconcileGrokHook(settings, 'PreToolUse', 'pre-action-hook', GROK_PRE_ACTION_HOOK_COMMAND, GROK_NATIVE_HOOK_MATCHER, 7),
    PostToolUse: reconcileGrokHook(settings, 'PostToolUse', 'hook', GROK_ACTION_RESULT_HOOK_COMMAND, GROK_NATIVE_HOOK_MATCHER, 5),
    PostToolUseFailure: reconcileGrokHook(settings, 'PostToolUseFailure', 'hook', GROK_ACTION_RESULT_HOOK_COMMAND, GROK_NATIVE_HOOK_MATCHER, 5),
    Stop: reconcileGrokHook(settings, 'Stop', 'session-hook', GROK_SESSION_END_HOOK_COMMAND, undefined, 3),
    SessionEnd: reconcileGrokHook(settings, 'SessionEnd', 'session-hook', null, undefined, 3),
  };
  return JSON.stringify(settings, null, 2) + '\n';
}

function managedGrokHooksFile(filePath) {
  if (!exists(filePath)) return false;
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return true;
    if (stat.size > 2 * 1024 * 1024) return true;
    return /@getmarrow\/mcp@[^\s"']+[\s\S]{0,4096}marrow-mcp[\s\S]{0,512}grok-(?:context-hook|pre-action-hook|hook|session-hook)/
      .test(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return true;
  }
}

function upsertGeminiHooks(settingsPath, options = {}) {
  const settings = parseJsonObject(settingsPath);
  const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? settings.hooks
    : {};
  const hostApprovals = options.hostApprovals === true;
  settings.hooks = {
    ...hooks,
    BeforeTool: reconcileGeminiHook(settings, 'BeforeTool', {
      matcher: GEMINI_NATIVE_HOOK_MATCHER,
      hooks: [{
        name: 'marrow-before-tool',
        type: 'command',
        command: geminiPreActionCommand(hostApprovals),
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
  if (hostApprovals) {
    // The typed reply in a local interactive session (`gemini`, never `gemini -p`).
    settings.hooks.BeforeAgent = reconcileGeminiHook(settings, 'BeforeAgent', {
      hooks: [{
        name: 'marrow-before-agent',
        type: 'command',
        command: GEMINI_CONTEXT_HOOK_COMMAND,
        timeout: GEMINI_HOOK_TIMEOUT_MS,
      }],
    });
  }
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
  const sdkDependency = inspectSdkDependency(detection, { sdkMode: plan.mode === 'sdk' || plan.mode === 'both' });
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
  const hostApprovals = hostApprovalHooksSupported(mcpTargetVersion);
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
    const approvalHooks = hostApprovals ? cursorHostApprovalHooksConfigured(cursorSettings, targetCommand) : null;
    if ((hostApprovals
      ? approvalHooks.pre_tool_use && approvalHooks.beforeShellExecution && approvalHooks.beforeMCPExecution
        && approvalHooks.sessionStart && approvalHooks.beforeSubmitPrompt
      : exactCursorHookConfigured(cursorSettings, 'preToolUse', targetCommand(CURSOR_PRE_ACTION_HOOK_COMMAND), CURSOR_NATIVE_HOOK_MATCHER, {
        timeout: CODEX_HOOK_TIMEOUT_SECONDS, failClosed: true, async: false,
      }))) observedHooks.push('pre_action');
    if (exactCursorHookConfigured(cursorSettings, 'postToolUse', targetCommand(CURSOR_ACTION_RESULT_HOOK_COMMAND), CURSOR_NATIVE_HOOK_MATCHER, {
      timeout: CODEX_HOOK_TIMEOUT_SECONDS,
    }) && exactCursorHookConfigured(cursorSettings, 'postToolUseFailure', targetCommand(CURSOR_ACTION_RESULT_HOOK_COMMAND), CURSOR_NATIVE_HOOK_MATCHER, {
      timeout: CODEX_HOOK_TIMEOUT_SECONDS,
    }) && (!hostApprovals || (approvalHooks.afterShellExecution && approvalHooks.afterMCPExecution))) observedHooks.push('action_result');
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
      geminiSettings, 'BeforeTool', 'marrow-before-tool', targetCommand(geminiPreActionCommand(hostApprovals)),
      GEMINI_NATIVE_HOOK_MATCHER, GEMINI_HOOK_TIMEOUT_MS,
    ) && (!hostApprovals || exactGeminiHookConfigured(
      geminiSettings, 'BeforeAgent', 'marrow-before-agent', targetCommand(GEMINI_CONTEXT_HOOK_COMMAND),
      undefined, GEMINI_HOOK_TIMEOUT_MS,
    ))) observedHooks.push('pre_action');
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
    const claudeApprovalHooks = hostApprovals ? claudeHostApprovalHooksConfigured(claudeSettings, targetCommand) : null;
    if (capabilityLevel === 'native_hooks'
      && exactHookConfigured(claudeSettings, 'PreToolUse', targetCommand(MCP_PRE_ACTION_HOOK_COMMAND), NATIVE_HOOK_MATCHER)
      && (!hostApprovals || claudeApprovalHooks.permission_request)) observedHooks.push('pre_action');
    if (capabilityLevel === 'native_hooks'
      && exactHookConfigured(claudeSettings, 'PostToolUse', targetCommand(MCP_ACTION_RESULT_HOOK_COMMAND), NATIVE_HOOK_MATCHER)
      && exactHookConfigured(claudeSettings, 'PostToolUseFailure', targetCommand(MCP_ACTION_RESULT_HOOK_COMMAND), NATIVE_HOOK_MATCHER)
      && (!hostApprovals || claudeApprovalHooks.post_tool_batch)) observedHooks.push('action_result');
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
      : client === 'cursor' || client === 'composer' ? cursorNativeHookFingerprint(cursorSettings, { hostApprovals })
      : client === 'cline' ? clineNativeHookFingerprint(detection)
      : client === 'windsurf' ? windsurfNativeHookFingerprint(windsurfSettings)
      : client === 'gemini' ? geminiNativeHookFingerprint(geminiSettings, { hostApprovals })
      : client === 'grok' ? grokNativeHookFingerprint(grokSettings)
      : claudeNativeHookFingerprint(claudeSettings, { hostApprovals })
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
    ? sdkDependency.install_command
      ? `${sdkDependency.install_command} && npx @getmarrow/install --repair`
      : sdkDependency.warning
    : capabilityLevel === 'governed_wrapper'
    ? `npx @getmarrow/install run -- ${client}`
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
    loop_guard_configured: capabilityLevel === 'native_hooks' && complete,
    loop_guard_self_tested: false,
    loop_guard_observed: false,
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

const MCP_ENV_PLACEHOLDER_RE = /\$\{[^}]*\}/;
const AGENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

// Values in reports are identity labels, never secrets: a URL is reduced to its origin, so
// credentials embedded in it are never printed.
function safeIdentityValue(field, value) {
  if (field === 'MARROW_BASE_URL') {
    try {
      const url = new URL(value);
      return `${url.protocol}//${url.host}`;
    } catch {
      return '[unparseable URL]';
    }
  }
  return AGENT_ID_RE.test(value) ? value : '[invalid agent id]';
}

function identityAllowlist(env = process.env) {
  const list = (value) => new Set(String(value || '').split(',').map((entry) => entry.trim()).filter(Boolean));
  return {
    baseUrls: list(env.MARROW_ALLOWED_BASE_URLS),
    agentIds: list(env.MARROW_ALLOWED_AGENT_IDS),
  };
}

// The managed MCP entry always carries the configured identity: the base URL and agent id the
// installer or controller runs with. An existing concrete value is kept only when it is equal
// or on the owner's allowlist (MARROW_ALLOWED_BASE_URLS, MARROW_ALLOWED_AGENT_IDS); otherwise
// it is replaced and the divergence is reported. A <client>-<hash> id written by an earlier
// installer is removed without a report.
function upsertMcpServerConfig(filePath, options = {}) {
  const agentId = String(options.agentId || '').trim();
  const derivedAgentIds = new Set(Array.isArray(options.derivedAgentIds) ? options.derivedAgentIds : []);
  const allowlist = options.allowlist || identityAllowlist();
  const report = typeof options.onDivergence === 'function' ? options.onDivergence : () => {};
  const config = parseJsonObject(filePath);
  const servers = config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
    ? config.mcpServers
    : {};
  const existingEnv = servers.marrow?.env && typeof servers.marrow.env === 'object' && !Array.isArray(servers.marrow.env)
    ? servers.marrow.env
    : {};
  const concrete = (value) => {
    const text = typeof value === 'string' ? value.trim() : '';
    return text && !MCP_ENV_PLACEHOLDER_RE.test(text) ? text : '';
  };
  const configuredBaseUrl = String(options.baseUrl || DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
  const existingBaseUrl = concrete(existingEnv.MARROW_BASE_URL);
  let baseUrl = configuredBaseUrl;
  if (existingBaseUrl && existingBaseUrl !== configuredBaseUrl) {
    if (allowlist.baseUrls.has(existingBaseUrl)) baseUrl = existingBaseUrl;
    else {
      report({
        field: 'MARROW_BASE_URL',
        replaced: safeIdentityValue('MARROW_BASE_URL', existingBaseUrl),
        applied: safeIdentityValue('MARROW_BASE_URL', configuredBaseUrl),
      });
    }
  }
  const existingAgentId = concrete(existingEnv.MARROW_FLEET_AGENT_ID);
  let keptAgentId = agentId;
  if (existingAgentId && existingAgentId !== agentId && !derivedAgentIds.has(existingAgentId)) {
    if (allowlist.agentIds.has(existingAgentId)) keptAgentId = existingAgentId;
    else {
      report({
        field: 'MARROW_FLEET_AGENT_ID',
        replaced: safeIdentityValue('MARROW_FLEET_AGENT_ID', existingAgentId),
        applied: agentId ? safeIdentityValue('MARROW_FLEET_AGENT_ID', agentId) : 'unset (resolved by Marrow)',
      });
    }
  }
  const existingProfile = resolveToolProfile(servers.marrow?.env?.MARROW_TOOL_PROFILE).configured_profile;
  const requestedProfile = resolveToolProfile(options.toolProfile).configured_profile;
  const configuredProfile = requestedProfile === 'unset' ? existingProfile : requestedProfile;
  const env = { MARROW_BASE_URL: baseUrl };
  if (keptAgentId) env.MARROW_FLEET_AGENT_ID = keptAgentId;
  if (configuredProfile !== 'unset') env.MARROW_TOOL_PROFILE = configuredProfile;
  servers.marrow = {
    command: 'npx',
    args: ['-y', `--package=${MCP_PACKAGE_SPEC}`, 'marrow-mcp'],
    env,
  };
  config.mcpServers = servers;
  return JSON.stringify(config, null, 2) + '\n';
}

function inspectSdkDependency(detection, { sdkMode = false } = {}) {
  // No SDK advice unless this project uses the SDK or the owner asked for the SDK runtime.
  if (!sdkMode && !sdkUseDetected(detection)) {
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
  let lockedVersion = null;
  try {
    const lock = JSON.parse(safeRead(path.join(detection.root, 'package-lock.json')) || '{}');
    const rootLock = lock?.packages?.[''];
    const lockedSdk = lock?.packages?.['node_modules/@getmarrow/sdk'];
    lockedVersion = typeof lockedSdk?.version === 'string' ? lockedSdk.version : null;
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
  const declaredLowerBound = declaredStableSdkLowerBound(declaredSpec);
  const declarationTrusted = declaredLowerBound !== null;
  const unsupportedDeclaration = declaredSpec !== null && !declarationTrusted;
  const declaredComparison = declaredLowerBound
    ? compareMcpVersions(declaredLowerBound.version, SDK_ADAPTER_VERSION) : null;
  const declaredAhead = declaredComparison !== null
    && (declaredComparison > 0 || (declaredLowerBound.exclusive && declaredComparison === 0));
  const aheadVersions = [installedVersion, lockedVersion]
    .filter((version) => compareMcpVersions(version, SDK_ADAPTER_VERSION) > 0);
  const aheadUnverified = aheadVersions.length > 0 || declaredAhead;
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
    ahead_unverified: aheadUnverified,
    expected_version: SDK_ADAPTER_VERSION,
    install_command: present || aheadUnverified || unsupportedDeclaration
      ? null : `npm install @getmarrow/sdk@${SDK_ADAPTER_VERSION}`,
    ...(aheadUnverified ? {
      warning: 'A newer SDK version is configured or installed. Preserve it and verify its exact version and integrity against the official npm registry before changing it.',
    } : unsupportedDeclaration ? {
      warning: 'The configured SDK version range is unsupported or ambiguous. Preserve it and verify the intended version against the official npm registry before changing it.',
    } : {}),
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
    const hostApprovals = hostApprovalHooksSupported();
    const cursorSettings = ['cursor', 'composer'].includes(entry.client) ? safeJsonObject(detection.paths.cursorHooks) : null;
    const cursorApprovalHooks = cursorSettings && hostApprovals ? cursorHostApprovalHooksConfigured(cursorSettings) : null;
    const cursorConfigured = Boolean(cursorSettings
      && exactCursorHookConfigured(cursorSettings, 'preToolUse', CURSOR_PRE_ACTION_HOOK_COMMAND, hostApprovals ? CURSOR_PRE_TOOL_USE_HOST_APPROVAL_MATCHER : CURSOR_NATIVE_HOOK_MATCHER, {
        timeout: hostApprovals ? CURSOR_GATE_HOOK_TIMEOUT_SECONDS : CODEX_HOOK_TIMEOUT_SECONDS, failClosed: true, async: false,
      })
      && (!cursorApprovalHooks || Object.values(cursorApprovalHooks).every(Boolean))
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
        geminiSettings, 'BeforeTool', 'marrow-before-tool', geminiPreActionCommand(hostApprovals),
        GEMINI_NATIVE_HOOK_MATCHER, GEMINI_HOOK_TIMEOUT_MS,
      )
      && (!hostApprovals || exactGeminiHookConfigured(
        geminiSettings, 'BeforeAgent', 'marrow-before-agent', GEMINI_CONTEXT_HOOK_COMMAND,
        undefined, GEMINI_HOOK_TIMEOUT_MS,
      ))
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

const HERMES_WRITE_LABEL = 'Hermes MCP server (mcp_servers.marrow)';

function hermesTargetIsSafe(detection) {
  try {
    assertContainedManagedTarget(detection.paths.hermesHome, detection.paths.hermesConfig);
    return true;
  } catch {
    return false;
  }
}

function derivedAgentIdsFor(root) {
  return [...SOURCE_CLIENTS].map((candidate) => stableAgentId(root, candidate));
}

// SDK use in this project: the SDK is a declared or installed dependency, or an earlier install
// already wrote Marrow's passive runtime here. Without it, no SDK file or SDK advice is written.
function sdkUseDetected(detection) {
  if (exists(detection.paths.passiveRuntime)) return true;
  if (!detection.node) return false;
  if (findUp(detection.root, [path.join('node_modules', '@getmarrow', 'sdk', 'package.json')])) return true;
  const raw = safeRead(detection.paths.packageJson);
  if (!raw) return false;
  // A package.json Marrow cannot parse is checked by hand (the SDK check says so).
  try {
    JSON.parse(raw);
  } catch {
    return /@getmarrow\/sdk/.test(raw);
  }
  return /"@getmarrow\/sdk"/.test(raw) || /@getmarrow\/sdk@/.test(raw);
}

// Hosts that read AGENTS.md. Claude Code reads CLAUDE.md and Cursor gets its own rule file, so
// a project with only those gets no AGENTS.md unless it already holds Marrow's block.
const AGENTS_MD_READERS = Object.freeze(['codex', 'windsurf', 'gemini', 'cline', 'grok', 'hermes', 'openclaw']);

function agentsMdWanted(detection) {
  if (AGENTS_MD_READERS.some((name) => detection[name])) return true;
  return Boolean(marrowManagedBlockInText(safeRead(detection.paths.agentsMd)));
}

function buildPlan(detection, options) {
  const client = options.client || detectedClient(detection);
  // Server-facing configuration carries only a configured agent id. Without one, the MCP
  // server, SDK and hooks let Marrow resolve the key's bound agent or the plan seat.
  const agentId = String(options.agentId || '').trim();
  const derivedAgentIds = derivedAgentIdsFor(detection.root);
  const baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
  const mcpConfigOptions = {
    agentId,
    baseUrl,
    toolProfile: options.toolProfile,
    derivedAgentIds,
    allowlist: options.identityAllowlist || identityAllowlist(),
  };
  const mcpConfigWrite = (filePath, label) => {
    const write = { type: 'json-transform', path: filePath, label, identityDivergence: [] };
    write.transform = (target) => {
      write.identityDivergence = [];
      return retarget(upsertMcpServerConfig(target, {
        ...mcpConfigOptions,
        onDivergence: (divergence) => write.identityDivergence.push(divergence),
      }));
    };
    return write;
  };
  const mcpTargetVersion = executableMcpTarget(options).version;
  // Hooks start the verified local MCP runtime for this exact version when there is one.
  const runtimeVersion = options.mcpRuntime && options.mcpRuntime.version === mcpTargetVersion ? mcpTargetVersion : null;
  const localize = (text) => (runtimeVersion ? localizeHookSettingsText(text, runtimeVersion) : text);
  const retarget = (value) => retargetMcpPackageSpec(value, mcpTargetVersion);
  // The host-approval hook layout only for an MCP that answers those hooks.
  const hostApprovals = hostApprovalHooksSupported(mcpTargetVersion);
  const mode = options.mode === 'auto'
    ? sdkUseDetected(detection) ? 'both' : 'mcp'
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
        transform: (filePath) => localize(retarget(upsertClaudeHooks(filePath, { hostApprovals }))),
      });
    }
    if (detection.codex) {
      writes.push({
        type: 'json-transform',
        path: detection.paths.codexHooks,
        label: 'Codex native hooks',
        transform: (filePath) => localize(retarget(upsertCodexHooks(filePath))),
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
        transform: (filePath) => localize(retarget(upsertWindsurfHooks(filePath))),
      });
    }
    if (detection.gemini) {
      writes.push({
        type: 'json-transform',
        path: detection.paths.geminiSettings,
        label: 'Gemini CLI native hooks',
        transform: (filePath) => localize(retarget(upsertGeminiHooks(filePath, { hostApprovals }))),
      });
    }
    if (detection.grok) {
      writes.push({
        type: 'managed-json-transform',
        path: detection.paths.grokHooks,
        root: detection.home,
        label: 'Grok native hooks',
        isManaged: managedGrokHooksFile,
        conflict_fix: 'Preserve or move the unmanaged owner Grok hook file after owner review, then rerun npx @getmarrow/install update.',
        transform: (filePath) => localize(retarget(upsertGrokHooks(filePath))),
      });
    }
    writes.push(mcpConfigWrite(detection.paths.mcpJson, 'Project MCP server config'));
    // The owner's Hermes config changes only on an explicit install or update, never from the
    // controller's background maintenance pass.
    if (detection.hermesConfig && options.maintenance !== true && hermesTargetIsSafe(detection)) {
      writes.push({
        type: 'yaml-transform',
        path: detection.paths.hermesConfig,
        root: detection.paths.hermesHome,
        label: HERMES_WRITE_LABEL,
        transform: (before) => planHermesMcpConfig(before, {
          mcpPackageSpec: `@getmarrow/mcp@${mcpTargetVersion}`,
          keyReference: hermesEnvHasKey(detection.paths.hermesEnv),
        }),
        conflict_fix: (reason) => `Marrow left ${detection.paths.hermesConfig} unchanged because it could not be edited safely (${reason}). Add this block under mcp_servers by hand, then restart Hermes:\n${hermesManualBlock({ mcpPackageSpec: `@getmarrow/mcp@${mcpTargetVersion}`, keyReference: hermesEnvHasKey(detection.paths.hermesEnv) })}`,
      });
    }
    if (detection.cursor) {
      writes.push({
        type: 'json-transform',
        path: detection.paths.cursorHooks,
        label: 'Cursor native hooks',
        transform: (filePath) => localize(retarget(upsertCursorHooks(filePath, { hostApprovals }))),
      });
      writes.push(mcpConfigWrite(detection.paths.cursorMcp, 'Cursor MCP server config'));
    }
  }

  // AGENTS.md only for a host that reads it, an explicit --md or --both, or a file that already
  // carries Marrow's block (so its pins stay current).
  if (mode === 'md' || (options.mode === 'both') || ((mode === 'both' || mode === 'mcp') && agentsMdWanted(detection))) {
    writes.push({
      type: 'md-block',
      path: detection.paths.agentsMd,
      label: 'Agent instructions',
      block: retarget(passiveInstructions({ hostApprovals })),
    });
  }

  if (detection.cursor && (mode === 'md' || mode === 'both' || mode === 'mcp')) {
    writes.push({
      type: 'file',
      path: detection.paths.cursorRules,
      label: 'Cursor Marrow rule',
      content: retarget(passiveInstructions({ hostApprovals })).replace(/<!--[^>]+-->/g, '').trim() + '\n',
    });
  }

  return { mode, root: detection.root, writes, mcp_target_version: mcpTargetVersion, host_approval_hooks: hostApprovals };
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
  for (const write of plan.writes) {
    if (write.label === 'Grok native hooks') {
      assertSafeGrokHookTarget(path.resolve(write.root), write.path);
    }
    assertContainedManagedTarget(path.resolve(write.root || root), write.path);
  }
  const prepared = plan.writes.map((write) => {
    const fileExists = exists(write.path);
    const before = safeRead(write.path);
    const inspectedBefore = write.type === 'md-block'
      ? marrowManagedBlockInText(before)
      : before;
    const aheadUnverifiedVersions = unverifiedAheadMcpVersions(
      mcpVersionsInText(inspectedBefore),
      plan.mcp_target_version,
    );
    const automaticRepairSuppressed = aheadUnverifiedVersions.length > 0;
    let after;
    let hookConflict = false;
    let conflictReason = null;
    let hostedEntry = false;
    let undo = null;
    if (automaticRepairSuppressed) {
      after = before;
    } else if (write.type === 'file') {
      if (write.overwrite === false && before) {
        after = before;
      } else {
        after = write.content;
      }
    } else if (write.type === 'md-block') {
      after = upsertBlock(before, write.block);
    } else if (write.type === 'json-transform') {
      after = write.transform(write.path);
      if (equivalentManagedJson(before, after)) after = before;
    } else if (write.type === 'managed-json-transform') {
      if (fileExists && !write.isManaged(write.path)) {
        after = before;
        hookConflict = true;
      } else {
        after = write.transform(write.path);
        if (equivalentManagedJson(before, after)) after = before;
      }
    } else if (write.type === 'yaml-transform') {
      const planned = write.transform(before);
      if (planned.action === 'refuse') {
        after = before;
        hookConflict = true;
        conflictReason = planned.reason;
      } else {
        after = planned.action === 'update' ? planned.content : before;
        hostedEntry = planned.hosted === true;
        undo = planned.action === 'update' ? planned.undo || [] : null;
      }
    } else if (write.type === 'owned-executable') {
      // A file Marrow wrote for another pinned MCP version is still Marrow's and moves to this
      // pin; any other difference is the owner's edit and is never overwritten.
      if (fileExists && before !== write.content && !sameMarrowFile(before, [write.content])) {
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
    return {
      write,
      before,
      after,
      hookConflict,
      conflictReason,
      hostedEntry,
      undo,
      modeChanged,
      automaticRepairSuppressed,
      aheadUnverifiedVersions,
    };
  });

  const changes = [];
  for (const {
    write,
    before,
    after,
    hookConflict,
    conflictReason,
    hostedEntry,
    undo,
    modeChanged,
    automaticRepairSuppressed,
    aheadUnverifiedVersions,
  } of prepared) {
    const contentChanged = before !== after;
    const changed = !automaticRepairSuppressed && !hookConflict && (contentChanged || modeChanged);
    const writeApplied = Boolean(options.yes && !options.dryRun && !options.doctor
      && !hookConflict && !automaticRepairSuppressed);
    changes.push({
      path: write.path,
      label: write.label,
      changed,
      applied: changed && writeApplied,
      already_present: !changed && !hookConflict && !automaticRepairSuppressed,
      hook_conflict: hookConflict,
      automatic_repair_suppressed: automaticRepairSuppressed,
      ...(automaticRepairSuppressed ? {
        ahead_unverified_versions: aheadUnverifiedVersions,
        exact_fix: mcpRegistryVerificationAction(aheadUnverifiedVersions),
      } : {}),
      ...(hookConflict ? {
        exact_fix: typeof write.conflict_fix === 'function' ? write.conflict_fix(conflictReason) : write.conflict_fix,
        ...(conflictReason ? { conflict_reason: conflictReason } : {}),
      } : {}),
      ...(hostedEntry ? { hosted_entry_preserved: true } : {}),
      // Redacted marrow-entry lines only; the file itself is never copied.
      ...(undo && contentChanged ? { undo } : {}),
      ...(write.identityDivergence?.length && changed ? { identity_divergence: write.identityDivergence } : {}),
    });
    if (contentChanged && writeApplied) {
      atomicWriteManagedFile(path.resolve(write.root || root), write.path, after);
    }
    if (modeChanged && writeApplied) {
      assertContainedManagedTarget(path.resolve(write.root || root), write.path);
      fs.chmodSync(write.path, write.mode);
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Uninstall: removes only what Marrow wrote. Every other hook, server, setting and file is kept.
// Files are read in-process and never printed; the report names paths and counts only.
// ---------------------------------------------------------------------------

// Hook groups of the Claude Code, Codex, Grok and Gemini shape:
// hooks[event] = [{ matcher?, hooks: [handler, ...] }].
function withoutMarrowGroupedHandlers(settings, isMarrowHandler) {
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return { settings, removed: 0, kept: 0 };
  let removed = 0;
  let kept = 0;
  const next = {};
  for (const [eventName, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      next[eventName] = entries;
      continue;
    }
    const retained = [];
    let touched = false;
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Array.isArray(entry.hooks)) {
        retained.push(entry);
        kept += 1;
        continue;
      }
      const handlers = entry.hooks.filter((handler) => !isMarrowHandler(handler));
      kept += handlers.length;
      if (handlers.length === entry.hooks.length) {
        retained.push(entry);
        continue;
      }
      touched = true;
      removed += entry.hooks.length - handlers.length;
      if (handlers.length > 0) retained.push({ ...entry, hooks: handlers });
    }
    // An event that held only Marrow's entries goes away with them.
    if (touched && retained.length === 0) continue;
    next[eventName] = retained;
  }
  const result = { ...settings, hooks: next };
  if (removed > 0 && Object.keys(next).length === 0) delete result.hooks;
  return { settings: result, removed, kept };
}

// Flat hook lists of the Cursor and Windsurf shape: hooks[event] = [{ command, ... }].
function withoutMarrowFlatEntries(settings, isMarrowEntry) {
  const hooks = settings?.hooks;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return { settings, removed: 0, kept: 0 };
  let removed = 0;
  let kept = 0;
  const next = {};
  for (const [eventName, entries] of Object.entries(hooks)) {
    if (!Array.isArray(entries)) {
      next[eventName] = entries;
      continue;
    }
    const retained = entries.filter((entry) => !(entry && typeof entry === 'object' && !Array.isArray(entry) && isMarrowEntry(entry)));
    kept += retained.length;
    removed += entries.length - retained.length;
    if (retained.length === 0 && entries.length > 0) continue;
    next[eventName] = retained;
  }
  const result = { ...settings, hooks: next };
  if (removed > 0 && Object.keys(next).length === 0) delete result.hooks;
  return { settings: result, removed, kept };
}

const isMarrowCommandHandler = (handler) => Boolean(handler && typeof handler === 'object' && !Array.isArray(handler)
  && handler.type === 'command' && marrowHookSubcommand(handler.command));
const isMarrowGeminiHandler = (handler) => Boolean(handler && typeof handler === 'object' && !Array.isArray(handler)
  && (String(handler.name || '').startsWith('marrow-') || geminiMarrowHookEntrypoint(handler.command)));
const isMarrowGrokHandler = (handler) => Boolean(handler && typeof handler === 'object' && !Array.isArray(handler)
  && handler.type === 'command' && grokMarrowHookSubcommand(handler.command));

// The MCP server entry only when Marrow wrote it: npx running the published package.
function withoutMarrowMcpServer(config) {
  const servers = config?.mcpServers;
  const entry = servers && typeof servers === 'object' && !Array.isArray(servers) ? servers.marrow : null;
  if (!entry) return { config, removed: 0, kept: 0, custom: false };
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  const ours = entry.command === 'npx' && args.includes('marrow-mcp')
    && args.some((arg) => /^--package=@getmarrow\/mcp(?:@[^\s]+)?$/.test(arg));
  if (!ours) return { config, removed: 0, kept: 1, custom: true };
  const nextServers = { ...servers };
  delete nextServers.marrow;
  const result = { ...config, mcpServers: nextServers };
  if (Object.keys(nextServers).length === 0) delete result.mcpServers;
  return { config: result, removed: 1, kept: Object.keys(nextServers).length, custom: false };
}

function withoutMarrowInstructionBlock(content) {
  const block = marrowManagedBlockInText(content);
  if (!block) return { content, removed: 0 };
  const start = content.indexOf(block);
  const before = content.slice(0, start);
  const after = content.slice(start + block.length).replace(/^\n/, '');
  const head = before.trim() ? before.replace(/\n*$/, after.trim() ? '\n\n' : '\n') : '';
  return { content: `${head}${after}`, removed: 1 };
}

// Marrow-written files compare equal once the pinned MCP version is normalized.
function sameMarrowFile(actual, candidates) {
  const normalize = (value) => String(value).replace(/@getmarrow\/mcp@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g, '@getmarrow/mcp@<pinned>');
  const normalized = normalize(actual);
  return candidates.some((candidate) => normalize(candidate) === normalized);
}

function buildUninstallPlan(detection) {
  const steps = [];
  const json = (filePath, label, transform, extra = {}) => steps.push({ kind: 'json', path: filePath, label, transform, ...extra });
  const mcpServer = (value) => {
    const result = withoutMarrowMcpServer(value);
    return { settings: result.config, removed: result.removed, kept: result.kept, custom: result.custom };
  };
  json(detection.paths.claudeSettings, 'Claude Code hooks', (value) => withoutMarrowGroupedHandlers(value, isMarrowCommandHandler));
  json(detection.paths.codexHooks, 'Codex hooks', (value) => withoutMarrowGroupedHandlers(value, isMarrowCommandHandler));
  json(detection.paths.cursorHooks, 'Cursor hooks', (value) => withoutMarrowFlatEntries(value, (entry) => Boolean(cursorMarrowHookSubcommand(entry.command))));
  json(detection.paths.windsurfHooks, 'Windsurf hooks', (value) => withoutMarrowFlatEntries(value, (entry) => Boolean(windsurfMarrowHookEntrypoint(entry.command))));
  json(detection.paths.geminiSettings, 'Gemini CLI hooks', (value) => withoutMarrowGroupedHandlers(value, isMarrowGeminiHandler));
  json(detection.paths.grokHooks, 'Grok hooks', (value) => withoutMarrowGroupedHandlers(value, isMarrowGrokHandler), {
    root: detection.home,
    grok: true,
    // Marrow's own global file: deleted when nothing but Marrow's hooks was in it.
    removeWhenEmpty: true,
  });
  json(detection.paths.mcpJson, 'Project MCP server config', mcpServer);
  json(detection.paths.cursorMcp, 'Cursor MCP server config', mcpServer);
  steps.push({ kind: 'md-block', path: detection.paths.agentsMd, label: 'Agent instructions' });
  const instructionVariants = [false, true].map((hostApprovals) => passiveInstructions({ hostApprovals }).replace(/<!--[^>]+-->/g, '').trim() + '\n');
  steps.push({ kind: 'owned-file', path: detection.paths.cursorRules, label: 'Cursor Marrow rule', candidates: instructionVariants });
  for (const hook of clineHookContract(detection)) {
    steps.push({ kind: 'owned-file', path: hook.path, label: hook.label, candidates: [hook.content] });
  }
  return steps;
}

function uninstallFileState(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink() || !stat.isFile()) return 'unsafe';
    if (stat.size > 4 * 1024 * 1024) return 'too_large';
    return 'file';
  } catch {
    return 'missing';
  }
}

async function uninstall(options = {}) {
  const home = options.home || process.env.HOME || process.env.USERPROFILE || os.homedir();
  const detection = detectEnvironment(options.cwd || process.cwd(), { ...process.env, HOME: home, USERPROFILE: home });
  const apply = Boolean(options.yes && !options.dryRun);
  const root = path.resolve(detection.root);
  const changes = [];
  let controller = null;
  if (apply && options.controller !== false) {
    // A running controller restores missing managed hooks every five minutes; stop it first.
    try {
      const stopped = await stopProjectControllers({ root, client: detectedClient(detection), mode: 'auto' });
      controller = { stopped: stopped.stopped || 0, changed: Boolean(stopped.changed) };
    } catch {
      controller = { stopped: 0, changed: false, error: 'controller_stop_failed' };
    }
  }
  for (const step of buildUninstallPlan(detection)) {
    const state = uninstallFileState(step.path);
    if (state === 'missing') continue;
    const change = { path: step.path, label: step.label, removed_entries: 0, kept_entries: 0, action: 'unchanged', applied: false };
    if (state !== 'file') {
      changes.push({ ...change, action: 'skipped', reason: state === 'unsafe' ? 'not a regular file' : 'larger than 4 MB' });
      continue;
    }
    try {
      const writeRoot = step.root ? path.resolve(step.root) : root;
      if (step.grok) {
        if (!managedGrokHooksFile(step.path)) {
          changes.push({ ...change, action: 'skipped', reason: 'not managed by Marrow' });
          continue;
        }
        assertSafeGrokHookTarget(writeRoot, step.path);
      }
      assertContainedManagedTarget(writeRoot, step.path);
      const before = fs.readFileSync(step.path, 'utf8');
      if (step.kind === 'owned-file') {
        if (!sameMarrowFile(before, step.candidates)) {
          if (MARROW_MANAGED_TEXT_RE.test(before)) changes.push({ ...change, action: 'kept', reason: 'edited after Marrow wrote it' });
          continue;
        }
        change.removed_entries = 1;
        change.action = 'delete_file';
        if (apply) fs.unlinkSync(step.path);
      } else if (step.kind === 'md-block') {
        const result = withoutMarrowInstructionBlock(before);
        if (!result.removed) continue;
        change.removed_entries = 1;
        change.action = result.content.trim() ? 'update' : 'delete_file';
        if (change.action === 'delete_file') change.note = 'it held only the Marrow block';
        else change.note = 'block_only';
        if (apply) {
          if (change.action === 'delete_file') fs.unlinkSync(step.path);
          else atomicWriteManagedFile(writeRoot, step.path, result.content);
        }
      } else {
        let parsed;
        try {
          // Marrow's hook commands in their canonical form, whether they start through npx or
          // the local runtime, so both are recognized and removed.
          parsed = before.trim() ? mapHookCommands(JSON.parse(before), delocalizeHookCommand) : {};
        } catch {
          changes.push({ ...change, action: 'skipped', reason: 'invalid JSON' });
          continue;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          changes.push({ ...change, action: 'skipped', reason: 'root is not a JSON object' });
          continue;
        }
        const result = step.transform(parsed);
        change.kept_entries = result.kept;
        if (result.custom) {
          changes.push({ ...change, action: 'kept', reason: 'custom marrow server entry' });
          continue;
        }
        if (!result.removed) continue;
        change.removed_entries = result.removed;
        const emptied = step.removeWhenEmpty && result.kept === 0
          && Object.keys(result.settings).every((key) => key === 'hooks');
        change.action = emptied ? 'delete_file' : 'update';
        if (apply) {
          if (emptied) fs.unlinkSync(step.path);
          else atomicWriteManagedFile(writeRoot, step.path, JSON.stringify(result.settings, null, 2) + '\n');
        }
      }
      change.applied = apply;
      changes.push(change);
    } catch (error) {
      changes.push({ ...change, action: 'skipped', reason: error instanceof Error ? error.message.slice(0, 200) : 'unsafe target' });
    }
  }
  const kept = [];
  if (exists(detection.paths.passiveRuntime)) kept.push({ path: detection.paths.passiveRuntime, reason: 'your start command may import it; remove that import first, then delete the file' });
  if (exists(detection.paths.passiveEnv)) kept.push({ path: detection.paths.passiveEnv, reason: 'it may hold your own edits; delete it when no longer needed' });
  let hermesEntry = false;
  try {
    hermesEntry = Boolean(detection.hermesConfig)
      && /(?:^|\n)mcp_servers:[\s\S]*\n[ \t]+marrow:/.test(fs.readFileSync(detection.paths.hermesConfig, 'utf8'));
  } catch {
    hermesEntry = false;
  }
  if (hermesEntry) kept.push({ path: detection.paths.hermesConfig, reason: 'remove mcp_servers.marrow by hand; uninstall never rewrites the Hermes config, which holds other servers\' settings' });
  // The local MCP runtime (~/.marrow/runtime) goes too; hooks elsewhere then start through npx.
  const runtime = removeMcpRuntime(options.home || detection.home, { dryRun: !apply });
  const removedEntries = changes.reduce((sum, change) => sum + change.removed_entries, 0);
  return {
    uninstall: {
      applied: apply,
      dry_run: !apply,
      root,
      controller,
      changes,
      kept,
      runtime: runtime.removed || runtime.would_remove ? runtime : null,
      removed_entries: removedEntries,
      next_step: apply
        ? 'Restart the agent hosts so they stop loading the removed hooks and MCP server.'
        : removedEntries > 0 || runtime.would_remove
        ? 'Nothing was changed. Run npx @getmarrow/install uninstall --yes to remove these Marrow entries.'
        : 'Nothing to remove.',
    },
  };
}

function printUninstallReport(report, sink = (text) => process.stdout.write(text)) {
  const result = report.uninstall;
  const where = (filePath) => (filePath.startsWith(`${result.root}${path.sep}`) ? path.relative(result.root, filePath) : filePath);
  const entries = (count) => `${count} Marrow entr${count === 1 ? 'y' : 'ies'}`;
  sink(`Marrow uninstall${result.applied ? '' : ' (preview)'}: ${entries(result.removed_entries)} ${result.applied ? 'removed' : 'to remove'}.\n`);
  for (const change of result.changes) {
    if (change.action === 'update' && change.note) sink(`- ${where(change.path)}: ${result.applied ? 'removed' : 'would remove'} the Marrow block; your text is kept.\n`);
    else if (change.action === 'update') sink(`- ${where(change.path)}: ${result.applied ? 'removed' : 'would remove'} ${entries(change.removed_entries)}; kept ${change.kept_entries} of yours.\n`);
    else if (change.action === 'delete_file') sink(`- ${where(change.path)}: ${result.applied ? 'deleted' : 'would delete'} (${change.note || 'Marrow\'s own file'}).\n`);
    else if (change.action === 'kept' || change.action === 'skipped') sink(`- ${where(change.path)}: left unchanged (${change.reason}).\n`);
  }
  for (const entry of result.kept) sink(`- ${where(entry.path)}: left in place; ${entry.reason}.\n`);
  if (result.runtime) sink(`- ${result.runtime.path}: ${result.applied ? 'removed' : 'would remove'} Marrow's local MCP runtime (other projects' hooks start through npx until the next install there).\n`);
  if (result.controller?.stopped) sink(`Stopped ${result.controller.stopped} Marrow controller${result.controller.stopped === 1 ? '' : 's'} for this project.\n`);
  sink(`${result.next_step}\n`);
}

const SELF_TEST_READ_TIMEOUT_MS = 15_000;

async function requestJson(url, options) {
  const res = await fetch(url, { signal: AbortSignal.timeout(SELF_TEST_READ_TIMEOUT_MS), ...options });
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

const SELF_TEST_WRITE_ATTEMPTS = 3;
const SELF_TEST_RETRY_DELAY_MS = 1_000;
const SELF_TEST_MAX_RETRY_DELAY_MS = 2_000;
const SELF_TEST_TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);
const SELF_TEST_ATTEMPT_TIMEOUT_MS = 10_000;
const SELF_TEST_TOTAL_TIMEOUT_MS = 25_000;

function selfTestRetryDelayMs(response, data, override) {
  if (Number.isFinite(override) && override >= 0) return override;
  const hinted = Number(data?.retry_after_ms);
  const header = Number(response?.headers?.get?.('retry-after')) * 1000;
  const delay = hinted > 0 ? hinted : header > 0 ? header : SELF_TEST_RETRY_DELAY_MS;
  return Math.min(delay, SELF_TEST_MAX_RETRY_DELAY_MS);
}

// A first write can meet a transient 5xx, or a durable "pending" acknowledgement.
// Marrow's contract is to resend the identical request with the same Idempotency-Key,
// so a retry can never create a second record. As in the MCP client, a pending
// acknowledgement is never complete, even when it names a created decision: that id
// is pinned and the final response must carry the same one.
async function selfTestWrite(url, options, { idempotencyKey, complete, retryDelayMs, attemptTimeoutMs, deadlineMs }) {
  let lastState = 'no response';
  let pinnedDecisionId = null;
  const perAttempt = Number.isFinite(attemptTimeoutMs) ? attemptTimeoutMs : SELF_TEST_ATTEMPT_TIMEOUT_MS;
  const deadline = Date.now() + (Number.isFinite(deadlineMs) ? deadlineMs : SELF_TEST_TOTAL_TIMEOUT_MS);
  for (let attempt = 1; attempt <= SELF_TEST_WRITE_ATTEMPTS; attempt += 1) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { failed: `deadline reached (last: ${lastState})` };
    let res;
    try {
      // Each attempt is bounded, and all attempts share one deadline, so a stalled service
      // can never hold the install open.
      res = await fetch(url, {
        ...options,
        headers: { ...options.headers, 'idempotency-key': idempotencyKey },
        signal: AbortSignal.timeout(Math.max(1, Math.min(perAttempt, remaining))),
      });
    } catch (error) {
      if (error?.name !== 'TimeoutError' && error?.name !== 'AbortError') throw error;
      lastState = 'timed out';
      continue;
    }
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text.slice(0, 500) };
    }
    const data = json.data || json;
    if (res.ok) {
      if (data?.idempotency_key !== undefined && data.idempotency_key !== idempotencyKey) {
        throw new Error('self-test write returned a different idempotency key');
      }
      const decisionId = selfTestDecisionId(data);
      if (pinnedDecisionId && decisionId && decisionId !== pinnedDecisionId) {
        throw new Error('self-test write returned a different decision id than its pending acknowledgement');
      }
      if (data?.retryable !== true || data?.committed !== false) return complete(data);
      if (data.idempotency_key !== idempotencyKey) {
        throw new Error('self-test write returned a pending acknowledgement without its idempotency key');
      }
      if (decisionId && data.decision_state === 'created') pinnedDecisionId = decisionId;
      lastState = 'pending';
    } else if (SELF_TEST_TRANSIENT_STATUSES.has(res.status)) {
      const reason = String(json.error || json.message || '').slice(0, 200);
      lastState = reason ? `HTTP ${res.status}: ${reason}` : `HTTP ${res.status}`;
    } else {
      throw new Error(String(json.error || json.message || `HTTP ${res.status}`));
    }
    if (attempt < SELF_TEST_WRITE_ATTEMPTS) {
      const wait = Math.min(selfTestRetryDelayMs(res, data, retryDelayMs), Math.max(0, deadline - Date.now()));
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  return { failed: lastState };
}

function selfTestDecisionId(data) {
  const decisionId = data?.decision_id || data?.decisionId;
  return typeof decisionId === 'string' && decisionId ? decisionId : undefined;
}

function runLoopGuardSelfTest(options = {}) {
  const target = executableMcpTarget(options);
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-install-loop-guard-'));
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const args = ['-y', `--package=@getmarrow/mcp@${target.version}`, 'marrow-mcp', 'loop-guard-self-test'];
  try {
    const invocation = {
      command,
      args,
      cwd: isolatedHome,
      env: {
        ...process.env,
        HOME: isolatedHome,
        USERPROFILE: isolatedHome,
        MARROW_API_KEY: '',
        MARROW_KEY: '',
      },
      encoding: 'utf8',
      timeout: 15_000,
      maxBuffer: 16 * 1024,
    };
    const result = typeof options.loopGuardSelfTestRunner === 'function'
      ? options.loopGuardSelfTestRunner(invocation)
      : spawnSync(command, args, invocation);
    if (!result || result.error || result.status !== 0) {
      const reason = result?.error?.message || String(result?.stderr || '').trim() || `exit ${result?.status ?? 'unknown'}`;
      throw new Error(`MCP ${target.version} isolated loop-guard self-test failed: ${reason.slice(0, 300)}`);
    }
    let proof;
    try {
      proof = JSON.parse(String(result.stdout || ''));
    } catch {
      throw new Error(`MCP ${target.version} isolated loop-guard self-test returned invalid JSON`);
    }
    const valid = proof && !Array.isArray(proof)
      && proof.pass === true
      && proof.isolated === true
      && proof.live_hook_observed === false
      && proof.repeat_denied === true
      && proof.mutation_reset === true
      && proof.owner_disabled_bypass === true;
    if (!valid) throw new Error(`MCP ${target.version} isolated loop-guard self-test returned incomplete proof`);
    return {
      attempted: true,
      passed: true,
      isolated: true,
      mcp_version: target.version,
      repeat_denied: true,
      mutation_reset: true,
      owner_disabled_bypass: true,
      live_hook_observed: false,
    };
  } finally {
    fs.rmSync(isolatedHome, { recursive: true, force: true });
  }
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

// When Marrow refuses this machine's agent identity, the one command that fixes it. A key that
// is simply not bound to one agent needs nothing: Marrow resolves the agent on each call.
const IDENTITY_REFUSED_RE = /AGENT_NOT_REGISTERED|wrong_agent_id|MARROW_AGENT_SCOPE_MISMATCH|Agent-bound key cannot access another agent/i;
function identityRefusalFix(message, configuredAgentId = '') {
  if (!IDENTITY_REFUSED_RE.test(String(message || ''))) return null;
  return configuredAgentId
    ? 'unset MARROW_AGENT_ID MARROW_FLEET_AGENT_ID && npx -y @getmarrow/install@latest'
    : 'MARROW_API_KEY=your_agent_key npx -y @getmarrow/install@latest  (replace your_agent_key with a key for one agent from your Marrow account)';
}

// The agent Marrow resolved for this key: its single bound agent or the Free plan seat. An
// unbound key has no single agent, and a locally derived id is never substituted for it.
function serverAgentIdentity(status, runtime) {
  const identity = status?.identity && typeof status.identity === 'object' ? status.identity : {};
  const safe = (value) => (typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : '');
  const bound = Array.isArray(identity.bound_agent_ids) ? identity.bound_agent_ids.map(safe).filter(Boolean) : [];
  const fromStatus = safe(identity.agent_id) || (bound.length === 1 ? bound[0] : '');
  if (fromStatus) return { agent_id: fromStatus, source: 'server_status_identity', bound_agent_ids: bound };
  const fromRuntime = safe(runtime?.agent_id);
  if (fromRuntime) return { agent_id: fromRuntime, source: 'server_runtime', bound_agent_ids: bound };
  return { agent_id: null, source: 'unresolved', bound_agent_ids: bound };
}

// A runtime call that creates a decision leaves it open unless it is closed. The self-test
// closes its own runtime decision in the same session with the runtime authorization id as
// gate_receipt_id. A failed close is reported, never retried as a new decision.
async function closeSelfTestRuntimeDecision(baseUrl, headers, runtime, selfTestKey, options) {
  const authorization = runtime?.runtime_authorization && typeof runtime.runtime_authorization === 'object'
    ? runtime.runtime_authorization
    : {};
  const decisionId = typeof runtime?.decision_id === 'string' && runtime.decision_id
    ? runtime.decision_id
    : typeof authorization.decision_id === 'string' ? authorization.decision_id : '';
  if (!decisionId || authorization.decision_state === 'not_created') return { created: false, committed: null };
  const gateReceiptId = String(authorization.id || runtime?.gate_receipt?.id || runtime?.risk_gate?.gate_receipt_id || '');
  try {
    const closed = await selfTestWrite(`${baseUrl}/v1/agent/commit`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        decision_id: decisionId,
        success: true,
        outcome: 'Marrow installer self-test runtime check responded; no action was executed.',
        ...(gateReceiptId ? { gate_receipt_id: gateReceiptId } : {}),
        proof: {
          checks: ['installer self-test runtime responded'],
          outcome: 'self-test runtime decision closed',
        },
      }),
    }, {
      idempotencyKey: `${selfTestKey}:runtime-commit`,
      complete: (data) => data,
      retryDelayMs: options.selfTestRetryDelayMs,
    attemptTimeoutMs: options.selfTestAttemptTimeoutMs,
    deadlineMs: options.selfTestDeadlineMs,
    });
    if (closed?.failed) return { created: true, decision_id: decisionId, committed: false, error: closed.failed };
    return { created: true, decision_id: decisionId, committed: closed?.committed === true };
  } catch (error) {
    return { created: true, decision_id: decisionId, committed: false, error: error instanceof Error ? error.message : String(error) };
  }
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
    'x-marrow-mcp-version': executableMcpTarget(options).version,
  };
  // Only a configured id is sent. Without one, Marrow resolves the key's bound agent or the
  // plan seat, and the self-test reads that server answer back for activation.
  const configuredAgentId = String(options.agentId || '').trim();
  if (configuredAgentId) headers['x-marrow-agent-id'] = configuredAgentId;

  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const selfTestKey = `install-self-test:${crypto.randomUUID()}`;
  const think = await selfTestWrite(`${baseUrl}/v1/agent/think`, {
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
  }, {
    idempotencyKey: `${selfTestKey}:think`,
    complete: (data) => selfTestDecisionId(data),
    retryDelayMs: options.selfTestRetryDelayMs,
    attemptTimeoutMs: options.selfTestAttemptTimeoutMs,
    deadlineMs: options.selfTestDeadlineMs,
  });

  const decisionId = typeof think === 'string' ? think : undefined;
  if (!decisionId) {
    throw new Error(`self-test did not return decision_id${think?.failed ? ` after ${SELF_TEST_WRITE_ATTEMPTS} attempts (last: ${think.failed})` : ''}`);
  }

  const commit = await selfTestWrite(`${baseUrl}/v1/agent/commit`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      decision_id: decisionId,
      success: true,
      outcome: 'Marrow passive installer self-test completed successfully',
    }),
  }, {
    idempotencyKey: `${selfTestKey}:commit`,
    complete: (data) => data,
    retryDelayMs: options.selfTestRetryDelayMs,
    attemptTimeoutMs: options.selfTestAttemptTimeoutMs,
    deadlineMs: options.selfTestDeadlineMs,
  });
  if (commit?.failed) {
    throw new Error(`self-test commit did not complete after ${SELF_TEST_WRITE_ATTEMPTS} attempts (last: ${commit.failed})`);
  }

  const status = await requestJson(`${baseUrl}/v1/agent/status`, { headers });
  const context = await requestJson(`${baseUrl}/v1/agent/context`, { headers })
    .catch(() => null);
  const toolProfile = buildMcpToolProfileReport(
    options.toolProfile,
    status.mcp_tool_profile,
    context?.primary_tool_availability,
    Boolean(options.activation),
  );
  const runtime = await selfTestWrite(`${baseUrl}/v1/agent/runtime`, {
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
  }, {
    idempotencyKey: `${selfTestKey}:runtime`,
    complete: (data) => data,
    retryDelayMs: options.selfTestRetryDelayMs,
    attemptTimeoutMs: options.selfTestAttemptTimeoutMs,
    deadlineMs: options.selfTestDeadlineMs,
  });
  if (runtime?.failed) {
    throw new Error(`self-test runtime did not complete after ${SELF_TEST_WRITE_ATTEMPTS} attempts (last: ${runtime.failed})`);
  }
  const runtimeDecisionClosure = await closeSelfTestRuntimeDecision(baseUrl, headers, runtime, selfTestKey, options);
  const serverIdentity = serverAgentIdentity(status, runtime);
  const activationAgentId = configuredAgentId || serverIdentity.agent_id || '';
  const activationIdentityUnresolved = Boolean(options.activation && !activationAgentId);
  const performance = await requestJson(`${baseUrl}/v1/analytics/agent-performance?period=7`, { headers })
    .catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  const firstValueResult = await selfTestWrite(`${baseUrl}/v1/agent/first-value`, {
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
      agent_id: activationAgentId || undefined,
      activation: options.activation && activationAgentId ? {
        ...options.activation,
        agent_id: activationAgentId,
        intervention_verified: runtimeGateVerified(runtime),
        closure_verified: true,
      } : undefined,
    }),
  }, {
    idempotencyKey: `${selfTestKey}:first-value`,
    complete: (data) => data,
    retryDelayMs: options.selfTestRetryDelayMs,
    attemptTimeoutMs: options.selfTestAttemptTimeoutMs,
    deadlineMs: options.selfTestDeadlineMs,
  });
  if (firstValueResult?.failed) {
    throw new Error(`self-test first-value did not complete after ${SELF_TEST_WRITE_ATTEMPTS} attempts (last: ${firstValueResult.failed})`);
  }
  const firstValue = firstValueResult;
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
  if (options.activation && !activationIdentityUnresolved) {
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
      && activationReceipt.agent_id === activationAgentId
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
          // One registration per agent: two agents with the same hook configuration (a second
          // agent installed on the same project) are two events, so the second is not refused
          // as a conflicting reuse of the first agent's event id. Reruns by one agent repeat
          // the same id.
          event_id: `activation-${crypto.createHash('sha256').update(`${activationConfigFingerprint}\0${activationAgentId}`).digest('hex').slice(0, 32)}`,
          event_type: 'activation_profile_registered',
          harness: options.activation.harness,
          agent_id: activationAgentId,
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
    // Only committed:true is trusted closure; anything else is reported as such.
    decision_committed: commit?.committed === true,
    active: Boolean(status.enabled ?? status.ok),
    health: status.health || null,
    last_event_at: status.last_event_at || null,
    recommended_fix: status.recommended_fix || null,
    next_action: status.next_action || null,
    auto_outcome_closure: status.auto_outcome_closure || null,
    runtime_active: runtimeGateVerified(runtime),
    runtime_exact_next_action: runtime.exact_next_action || null,
    runtime_before_you_act: runtime.before_you_act || null,
    runtime_decision_closure: runtimeDecisionClosure,
    agent_id: activationAgentId || null,
    agent_id_source: configuredAgentId ? 'configured' : serverIdentity.source,
    bound_agent_ids: serverIdentity.bound_agent_ids,
    activation_verified: activationVerified,
    activation_identity_unresolved: activationIdentityUnresolved,
    // An unbound key is fine: Marrow resolves the agent on each call, so there is nothing to fix.
    activation_exact_fix: null,
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

function printReport(report, sink) {
  const out = typeof sink === 'function' ? sink : (text) => process.stdout.write(text);
  out(`Marrow passive installer\n`);
  out(`Root: ${report.root}\n`);
  out(`Mode: ${report.mode}\n`);
  out(`Write mode: ${report.writeMode}\n\n`);

  if (report.activation?.requested) {
    out('Activation:\n');
    out(`- agent: ${report.activation.agent_id || 'none resolved'}${report.activation.agent_id_source ? ` (${report.activation.agent_id_source})` : ''}\n`);
    if (report.activation.exact_fix) out(`- exact fix: ${report.activation.exact_fix}\n`);
    out(`- self-test server confirmed: ${report.activation.server_confirmed ? 'yes' : 'no'}\n`);
    out(`- scope: ${report.activation.activation_scope}\n`);
    out(`- coverage verified: ${report.activation.coverage_verified ? 'yes' : 'no'}\n`);
    out(`- passive live in this process: ${report.activation.passive_live ? 'yes' : 'no'}\n`);
    out(`- reload required: ${report.activation.reload_required ? 'yes' : 'no'}\n`);
    if (report.activation.next_action) out(`- next action: ${report.activation.next_action}\n`);
    out('\n');
  }

  out('Detected:\n');
  for (const [key, value] of Object.entries(report.detected)) {
    out(`- ${key}: ${value ? 'yes' : 'no'}\n`);
  }

  out('\nPlanned changes:\n');
  for (const change of report.changes) {
    const marker = change.automatic_repair_suppressed
      ? 'preserved unverified-ahead surface; repair suppressed'
      : change.hook_conflict ? 'preserved unmanaged owner file; review required'
      : change.applied ? 'wrote' : change.changed ? 'would write' : 'unchanged';
    out(`- ${marker}: ${change.label} (${change.path})\n`);
    if (change.automatic_repair_suppressed && change.exact_fix) {
      out(`  exact verification: ${change.exact_fix}\n`);
    }
    if (change.hook_conflict && change.exact_fix) out(`  exact fix: ${change.exact_fix}\n`);
    for (const divergence of change.identity_divergence || []) {
      out(`  identity reset: ${divergence.field} ${divergence.replaced} -> ${divergence.applied}. If the previous value was intended, add it to ${divergence.field === 'MARROW_BASE_URL' ? 'MARROW_ALLOWED_BASE_URLS' : 'MARROW_ALLOWED_AGENT_IDS'} and rerun.\n`);
    }
  }

  if (report.mcp_runtime) {
    const runtime = report.mcp_runtime;
    out('\nMCP local runtime:\n');
    out(`- hooks start: ${runtime.hooks_start === 'local_runtime' ? `the verified local copy of @getmarrow/mcp@${runtime.version} (${runtime.path})` : 'through npx'}\n`);
    out(`- state: ${runtime.state}${runtime.reason ? ` (${runtime.reason})` : ''}\n`);
    if (runtime.removed_versions?.length) out(`- removed older versions: ${runtime.removed_versions.join(', ')}\n`);
  }
  if (report.owner_key_storage) {
    out(`\nAPI key for hosts opened outside this terminal: ${report.owner_key_storage.state}${report.owner_key_storage.path ? ` (${report.owner_key_storage.path})` : ''}\n`);
  }
  out('\nLocal session loop guard:\n');
  out(`- configured: ${report.loop_guard_configured ? 'yes' : 'no'}\n`);
  out(`- isolated self-test passed: ${report.loop_guard_self_tested ? 'yes' : 'no'}\n`);
  out(`- observed in a reloaded host: ${report.loop_guard_observed ? 'yes' : 'no'}\n`);
  if (!report.loop_guard_observed) {
    out('- next: restart the host and complete its hook trust/review step before relying on live enforcement\n');
  }

  out('\nSelf-test:\n');
  const toolProfile = report.selfTest.mcp_tool_profile || report.toolProfile;
  if (toolProfile) {
    out(`- configured tool profile: ${toolProfile.configured_profile}\n`);
    out(`- effective tool profile: ${toolProfile.effective_profile}\n`);
    out(`- expected visible tools: ${toolProfile.expected_visible_count == null ? 'complete catalog (awaiting reloaded MCP count)' : toolProfile.expected_visible_count}\n`);
    out(`- actual visible tools: ${toolProfile.actual_visible_count == null ? 'unavailable until process reload' : toolProfile.actual_visible_count}\n`);
    out(`- visible tool names: ${toolProfile.visibility_live ? toolProfile.visible_tool_names.join(', ') : 'unavailable until process reload'}\n`);
    out(`- profile live: ${toolProfile.visibility_live ? 'yes' : 'no'}\n`);
    const projection = toolProfile.backend_entitlement_projection;
    const availability = projection?.primary_tool_availability;
    if (projection?.evidence_state === 'available' && availability?.entitlement_evidence?.state === 'available') {
      out(`- backend-projected entitled tools: ${availability.counts.entitled}\n`);
      out(`- backend-projected upgrade-required tools: ${availability.counts.upgrade_required}\n`);
      out(`- backend projection source: ${projection.source}; authorizes calls: no\n`);
    } else {
      out(`- backend-projected entitlements: unavailable (source: ${projection?.source || 'backend_projection_not_provided'}; non-authorizing)\n`);
    }
  }
  if (report.selfTest.skipped) {
    out(`- skipped: ${report.selfTest.reason}\n`);
    if (report.selfTest.exact_fix) out(`- exact fix: ${report.selfTest.exact_fix}\n`);
  } else {
    out(`- active: ${report.selfTest.active ? 'yes' : 'no'}\n`);
    out(`- decision_id: ${report.selfTest.decision_id}\n`);
    out(`- decision committed (trusted closure): ${report.selfTest.decision_committed ? 'yes' : 'no'}\n`);
    out(`- health: ${report.selfTest.health || 'unknown'}\n`);
    out(`- one-call runtime: ${report.selfTest.runtime_active ? 'active' : 'not verified'}\n`);
    if (report.selfTest.error) out(`- error: ${report.selfTest.error}\n`);
    if (report.selfTest.next_action) out(`- next action: ${report.selfTest.next_action}\n`);
    const update = report.selfTest.client_update;
    const notification = update?.notification_state || update?.notification;
    if (update && (update.update_available === true || update.version_status === 'unknown' || notification === 'unknown' || notification === 'version_unknown' || notification === 'security_required')) {
      out('\nMarrow client update:\n');
      out(`- priority: ${notification === 'security_required' ? 'security_required' : notification === 'recommended' ? 'recommended' : update.version_status === 'unknown' || notification === 'unknown' || notification === 'version_unknown' ? 'version_unknown' : update.priority || 'recommended'}\n`);
      out(`- installed: ${update.installed_version || update.current_version || 'unknown'}\n`);
      out(`- latest: ${update.latest_version || 'unknown'}\n`);
      out('- automatic notification: yes\n');
      out('- automatic local mutation: no; operator policy applies\n');
      if (update.owner_notice) out(`- tell owner: ${update.owner_notice}\n`);
      if (update.agent_instruction) out(`- agent instruction: ${update.agent_instruction}\n`);
      if (update.update_command || update.exact_update_command || update.auto_update_command) {
        out(`- update: ${update.auto_update_command || update.update_command || update.exact_update_command}\n`);
      }
      if (update.verification_command || update.exact_verification_command) out(`- verify: ${update.verification_command || update.exact_verification_command}\n`);
    }
    if (report.selfTest.first_value_signal) {
      out('\nFirst value:\n');
      const valueMoment = report.selfTest.install_value_moment;
      if (valueMoment) {
        out(`- ${valueMoment.headline}\n`);
        out('- First proof:\n');
        for (const proof of valueMoment.proof) out(`  - ${proof}\n`);
        out(`- ${valueMoment.fleet_signal}\n`);
        out(`- Try this now: ${valueMoment.try_this_now}\n`);
        out(`- Expected: ${valueMoment.expected_response}\n`);
      } else {
        out(`- ${report.selfTest.first_value_signal.headline}\n`);
        out(`- First useful lesson: ${report.selfTest.first_value_signal.first_lesson}\n`);
        if (report.selfTest.first_value_signal.value_proof.length) {
          out(`- Proof: ${report.selfTest.first_value_signal.value_proof.join('; ')}\n`);
        }
        out(`- Next: ${report.selfTest.first_value_signal.next_action}\n`);
      }
    }
    if (report.selfTest.token_value_proof) {
      const proof = report.selfTest.token_value_proof;
      const observed = proof.observed || {};
      const savings = proof.savings || {};
      const tokens = observed.tokens || {};
      out('\nToken value proof:\n');
      out(`- passive capture: ${proof.enabled ? 'on' : 'unknown'}\n`);
      out(`- model calls observed: ${observed.model_calls || 0}\n`);
      out(`- tokens observed: ${tokens.total || 0}\n`);
      out(`- estimated tokens saved: ${savings.estimated_tokens_saved || 0}\n`);
      if (savings.confidence) out(`- confidence: ${savings.confidence}\n`);
      if (proof.proof_line) out(`- proof: ${proof.proof_line}\n`);
      if (proof.exact_next_action) out(`- next: ${proof.exact_next_action}\n`);
    }
  }

  if (report.harnessReload && report.writeMode !== 'doctor') {
    out('\nHarness reload:\n');
    out(`- required: ${report.harnessReload.required ? 'yes' : 'no'}\n`);
    out(`- live in this process: ${report.harnessReload.live_in_this_process ? 'yes' : 'no'}\n`);
    if (report.harnessReload.required && report.harnessReload.instruction) out(`- restart: ${report.harnessReload.instruction}\n`);
    if (report.harnessReload.required && report.harnessReload.prove_command) out(`- prove after restart: ${report.harnessReload.prove_command}\n`);
  }
  if (report.firstCapture) {
    out('\nFirst capture:\n');
    out(`- client: ${report.firstCapture.client}\n`);
    out(`- capability: ${report.firstCapture.capability_level}\n`);
    if (report.firstCapture.command) out(`- command: ${report.firstCapture.command}\n`);
    out(`- ${report.firstCapture.instruction}\n`);
  }

  if (report.remediation) {
    out('\nRemediation:\n');
    out(`- attempted: ${report.remediation.attempted ? 'yes' : 'no'}\n`);
    out(`- fixed config: ${report.remediation.fixedConfig ? 'yes' : 'no'}\n`);
    out(`- self-test passed: ${report.remediation.selfTestPassed ? 'yes' : 'no'}\n`);
    if (report.remediation.message) out(`- result: ${report.remediation.message}\n`);
  }

  if (report.sdkDependency?.required) {
    out('\nSDK dependency:\n');
    out(`- @getmarrow/sdk: ${report.sdkDependency.present ? 'present' : report.sdkDependency.ahead_unverified ? 'newer version requires verification' : 'missing'}\n`);
    if (report.sdkDependency.install_command) out(`- exact fix: ${report.sdkDependency.install_command}\n`);
    if (report.sdkDependency.warning) out(`- warning: ${report.sdkDependency.warning}\n`);
  }

  if (report.hermes?.detected) {
    out('\nHermes:\n');
    out(`- MCP server entry: ${report.hermes.state}${report.hermes.config_path ? ` (${report.hermes.config_path})` : ''}\n`);
    if (report.hermes.undo?.length) {
      out(`- undo (no backup is kept because the file holds other servers' credentials; values redacted): in ${report.hermes.config_path} under mcp_servers.marrow\n`);
      for (const step of report.hermes.undo) {
        if (step.change === 'replaced') {
          out('  replace these lines:\n');
          for (const line of step.lines) out(`    ${line}\n`);
          out('  with the original lines:\n');
          for (const line of step.replaced) out(`    ${line}\n`);
        } else {
          out('  remove these added lines:\n');
          for (const line of step.lines) out(`    ${line}\n`);
        }
      }
    }
    if (report.hermes.key_source) out(`- API key source for the Hermes MCP server: ${report.hermes.key_source}\n`);
    if (report.hermes.owner_key_storage) out(`- ~/.marrow/env key storage: ${report.hermes.owner_key_storage.state}\n`);
    if (report.hermes.restart) out(`- restart: ${report.hermes.restart}\n`);
    if (report.hermes.exact_fix) out(`- exact fix: ${report.hermes.exact_fix}\n`);
  }

  out('\nAutomatic controller:\n');
  out(`- state: ${report.controller?.active ? 'active' : report.controller?.state || 'unavailable'}\n`);
  if (report.controller?.installer_version) out(`- installer version: ${report.controller.installer_version}\n`);
  if (report.controller?.restarted) out(`- restarted: ${report.controller.restarted.from_versions.join(', ')} -> ${report.controller.restarted.to_version}\n`);
  if (report.controller?.started_at) out(`- started: ${report.controller.started_at}\n`);
  if (report.controller?.reason) out(`- reason: ${report.controller.reason}\n`);
  if (report.controller?.exact_fix) out(`- exact fix: ${report.controller.exact_fix}\n`);

  if (report.writeMode === 'doctor') {
    const liveHere = !report.harnessReload?.required
      && report.doctor.mcpProcesses?.healthy !== false
      && report.doctor.mcpConfigurations?.healthy !== false;
    const activeLabel = report.doctor.active && liveHere
      ? 'yes'
      : report.doctor.active
        ? 'server confirmed, restart required'
        : 'no';
    out('\nDoctor:\n');
    out(`- Marrow active: ${activeLabel}\n`);
    out(`- missing env: ${report.doctor.missingEnv.length ? report.doctor.missingEnv.join(', ') : 'none'}\n`);
    if (report.doctor.envHints.length) out(`- possible env files: ${report.doctor.envHints.join(', ')}\n`);
    out(`- missing hooks/config: ${report.doctor.missingHooks.length ? report.doctor.missingHooks.join('; ') : 'none'}\n`);
    out(`- loop guard configured: ${report.doctor.loop_guard_configured ? 'yes' : 'no'}\n`);
    out(`- loop guard isolated self-test: ${report.doctor.loop_guard_self_tested ? 'passed' : 'not passed'}\n`);
    out(`- loop guard observed after reload/trust: ${report.doctor.loop_guard_observed ? 'yes' : 'no'}\n`);
    if (report.doctor.mcpProcesses?.available) {
      const processes = report.doctor.mcpProcesses;
      out(`- MCP process versions: ${processes.active_versions.length ? processes.active_versions.join(', ') : processes.active_processes ? 'unknown' : 'none'}\n`);
      out(`- stale/mixed/version-unknown MCP clients: ${processes.healthy ? 'no' : 'yes'}\n`);
      if (processes.ahead_unverified_versions.length) out(`- unverified-ahead MCP clients: ${processes.ahead_unverified_versions.join(', ')}\n`);
      if (processes.automatic_repair_suppressed) out('- automatic MCP process repair: suppressed pending official registry verification\n');
    }
    if (report.doctor.mcpConfigurations) {
      const configurations = report.doctor.mcpConfigurations;
      out(`- configured MCP versions: ${configurations.configured_versions.length ? configurations.configured_versions.join(', ') : 'none pinned'}\n`);
      out(`- stale/mixed/version-unknown MCP configuration: ${configurations.healthy ? 'no' : 'yes'}\n`);
      if (configurations.ahead_unverified_versions.length) out(`- unverified-ahead MCP configuration: ${configurations.ahead_unverified_versions.join(', ')}\n`);
      if (configurations.automatic_repair_suppressed) out('- automatic MCP configuration repair: suppressed pending official registry verification\n');
    }
    if (report.doctor.recommendedFix) out(`- recommended fix: ${report.doctor.recommendedFix}\n`);
    if (report.doctor.mcp_update_required) {
      out(`- restart once after update: ${report.doctor.restart_instruction}\n`);
      out(`- verify after restart: ${report.doctor.verification_command}\n`);
    }
    out(`- live health: ${report.doctor.healthCommand}\n`);
  }

  if (report.writeMode === 'dry-run') {
    out('\nRun with --yes to write these changes.\n');
  }

  if (report.warnings.length > 0) {
    out('\nWarnings:\n');
    for (const warning of report.warnings) {
      out(`- ${warning}\n`);
    }
  }
}

// The local controller directory is keyed by project and this id. It never leaves the machine.
// Hermes passes only PATH, HOME and locale variables to an MCP server, plus its env block.
// When neither the entry nor $HERMES_HOME/.env carries the key, the Marrow MCP server reads
// it from the owner-only ~/.marrow/env, which is written here (mode 600) only if absent.
function hermesWiringReport(detection, changes, options, planMode) {
  const paths = detection.paths || {};
  if (!detection.hermes) return { detected: false, state: 'not_detected' };
  if (planMode && !['mcp', 'both'].includes(planMode)) return { detected: true, state: 'skipped_for_mode', config_path: paths.hermesConfig };
  const mcpTargetVersion = options.mcpTargetVersion || MCP_ADAPTER_VERSION;
  const blockOptions = { mcpPackageSpec: `@getmarrow/mcp@${mcpTargetVersion}`, keyReference: hermesEnvHasKey(paths.hermesEnv) };
  if (!detection.hermesConfig) {
    return {
      detected: true,
      state: 'config_not_found',
      config_path: paths.hermesConfig,
      exact_fix: `Run Hermes once so it creates ${paths.hermesConfig}, then rerun this command, or add this block to it:\n${hermesManualBlock(blockOptions)}`,
    };
  }
  const change = (changes || []).find((entry) => entry.label === HERMES_WRITE_LABEL);
  if (!change) {
    return {
      detected: true,
      state: 'refused',
      config_path: paths.hermesConfig,
      exact_fix: `Marrow left ${paths.hermesConfig} unchanged because its path is not a direct, regular owner file. Add this block under mcp_servers by hand, then restart Hermes:\n${hermesManualBlock(blockOptions)}`,
    };
  }
  if (change.hook_conflict) {
    return { detected: true, state: 'refused', config_path: change.path, reason: change.conflict_reason || null, exact_fix: change.exact_fix };
  }
  if (change.automatic_repair_suppressed) {
    return { detected: true, state: 'preserved_unverified_ahead', config_path: change.path, exact_fix: change.exact_fix };
  }
  if (change.hosted_entry_preserved) {
    return { detected: true, state: 'hosted_entry_preserved', config_path: change.path };
  }
  const state = change.applied ? 'configured' : change.changed ? 'would_configure' : 'already_configured';
  let keySource = 'owner_env_file';
  let keyStorage = null;
  const current = safeRead(change.path);
  const entryKeys = hermesMarrowEnvKeyNames(current);
  if (entryKeys.includes('MARROW_API_KEY') || entryKeys.includes('MARROW_KEY')) {
    keySource = /MARROW_API_KEY:\s*["']?\$\{MARROW_API_KEY\}/.test(current) ? 'hermes_env_reference' : 'hermes_entry';
  } else if (state !== 'would_configure' && options.yes && !options.dryRun && !options.doctor) {
    keyStorage = ensureOwnerApiKey(options.home || detection.home, options.apiKey);
  }
  return {
    detected: true,
    state,
    config_path: change.path,
    undo: state === 'configured' ? change.undo || [] : null,
    key_source: keySource,
    ...(keyStorage ? { owner_key_storage: { state: keyStorage.state, path: keyStorage.path } } : {}),
    restart: state === 'configured' ? 'Restart Hermes so it loads the Marrow MCP server.' : null,
  };
}

// The local MCP runtime for the target version: installed (or kept) on a write run of the
// command, otherwise only an existing verified copy is used. `mcpLocalRuntime: false` (or
// MARROW_LOCAL_RUNTIME=0, --no-local-runtime) leaves every hook on npx, and a write run then
// removes the local copy, so the controller's maintenance cannot move hooks back onto it.
function resolveMcpRuntime(detection, options, mcpTarget) {
  const home = options.home || detection.home;
  if (options.mcpLocalRuntime === false) {
    const write = options.yes && !options.dryRun && !options.doctor && options.maintenance !== true;
    const removal = write && home ? removeMcpRuntime(home) : null;
    return { state: 'disabled', ...(removal?.removed ? { removed: true } : {}) };
  }
  const version = mcpTarget.version;
  const integrity = mcpTarget.integrity || (version === MCP_ADAPTER_VERSION ? MCP_ADAPTER_INTEGRITY : null);
  if (!integrity) return { state: 'skipped', reason: 'no_verified_integrity', version };
  const install = options.mcpLocalRuntime === true && options.yes && !options.dryRun && !options.doctor && options.maintenance !== true;
  if (install) {
    return ensureMcpRuntime({
      home,
      version,
      integrity,
      sdk: { version: SDK_ADAPTER_VERSION, integrity: SDK_ADAPTER_INTEGRITY },
      ...(typeof options.mcpRuntimeInstall === 'function' ? { npmInstall: options.mcpRuntimeInstall } : {}),
      ...(options.mcpRuntimeNode ? { nodePath: options.mcpRuntimeNode } : {}),
      // One line on stderr before npm runs, so the wait is never silent (stdout stays clean
      // for --json).
      onProgress: typeof options.mcpRuntimeProgress === 'function' ? options.mcpRuntimeProgress : (text) => process.stderr.write(text),
    });
  }
  return verifyMcpRuntime(home, version, integrity) || { state: 'absent', version };
}

// The controller's maintenance rewrites managed hooks for the pinned MCP. It uses the verified
// local runtime for that version when there is one (verify only: maintenance never installs),
// so it keeps hooks on the runtime instead of rewriting them back to npx.
function maintenanceMcpRuntime(detection, options = {}) {
  const runtime = resolveMcpRuntime(detection, { ...options, maintenance: true, yes: false }, executableMcpTarget(options));
  return runtime.version && ['present', 'installed', 'verified'].includes(runtime.state) ? runtime : null;
}

function mcpRuntimeReport(runtime) {
  if (!runtime) return null;
  return {
    state: runtime.state,
    version: runtime.version || null,
    path: runtime.directory || null,
    ...(runtime.reason ? { reason: runtime.reason } : {}),
    ...(runtime.removed_versions?.length ? { removed_versions: runtime.removed_versions } : {}),
    hooks_start: runtime.directory && ['present', 'installed', 'verified'].includes(runtime.state) ? 'local_runtime' : 'npx',
  };
}

function localControllerAgentId(root, client, configuredAgentId = '') {
  return String(configuredAgentId || '').trim() || stableAgentId(root, client);
}

async function install(options) {
  // Only a configured agent id is sent to Marrow. The controller keeps a local identity for its
  // state directory, which is never sent.
  const configuredAgentId = String(options.agentId || '').trim();
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
  const detection = detectEnvironment(options.cwd, {
    ...process.env,
    HOME: options.home || options.cwd,
    USERPROFILE: options.home || options.cwd,
  });
  if (options.repair || options.update) assertUpdateTargetsManagedRoot(detection);
  const client = detectedClient(detection);
  options.client = client;
  options.agentId = configuredAgentId;
  const controllerIdentityAgentId = localControllerAgentId(detection.root, client, configuredAgentId);
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
  options.mcpTarget = mcpTarget;
  options.mcpTargetVersion = mcpTarget.version;
  const mcpRuntime = resolveMcpRuntime(detection, options, mcpTarget);
  options.mcpRuntime = mcpRuntime.version && ['present', 'installed', 'verified'].includes(mcpRuntime.state) ? mcpRuntime : null;
  const plan = buildPlan(detection, options);
  const writeMode = options.doctor ? 'doctor' : options.dryRun ? 'dry-run' : options.repair ? 'repair' : options.yes ? 'write' : 'dry-run';
  const changes = applyPlan(plan, options);
  let profile = activationProfile(detection, plan, changes, client);
  const localControl = localControlEvidence({
    apiKey: options.apiKey,
    home: options.controlHome || options.home || detection.home,
  });
  const loopGuardConfigured = profile.capability_level === 'native_hooks'
    && profile.configuration_complete === true;
  const loopGuardSelfTest = options.loopGuardSelfTest === true && !options.dryRun
    ? runLoopGuardSelfTest(options)
    : {
      attempted: false,
      passed: false,
      isolated: true,
      mcp_version: mcpTarget.version,
      live_hook_observed: false,
    };
  profile = {
    ...profile,
    loop_guard_configured: loopGuardConfigured,
    loop_guard_self_tested: loopGuardSelfTest.passed === true,
    loop_guard_observed: false,
    loop_guard_enabled: localControl.enabled === true,
  };
  options.activation = options.activate ? {
    harness: client,
    agent_id: configuredAgentId || null,
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
  const sdkDependency = inspectSdkDependency(detection, { sdkMode: plan.mode === 'sdk' || plan.mode === 'both' });
  const envHints = options.apiKey ? [] : findLikelyEnvFiles(detection);
  const mcpProcesses = inspectMcpProcesses({
    commands: options.processCommands,
    expectedTarget: mcpTarget,
  });
  const mcpConfigurations = inspectMcpConfigurations(detection, {
    paths: options.mcpConfigPaths,
    expectedTarget: mcpTarget,
  });
  const aheadUnverifiedVersions = [...new Set([
    ...mcpProcesses.ahead_unverified_versions,
    ...mcpConfigurations.ahead_unverified_versions,
    ...changes.flatMap((change) => change.ahead_unverified_versions || []),
  ])].sort((left, right) => compareMcpVersions(left, right));
  const automaticMcpRepairSuppressed = aheadUnverifiedVersions.length > 0;
  const registryVerificationAction = automaticMcpRepairSuppressed
    ? mcpRegistryVerificationAction(aheadUnverifiedVersions)
    : null;
  const mcpUpdateRequired = !automaticMcpRepairSuppressed
    && (!mcpConfigurations.healthy || (!options.update && !mcpProcesses.healthy));
  if (automaticMcpRepairSuppressed) {
    profile = {
      ...profile,
      configuration_complete: false,
      complete: false,
      automatic_repair_suppressed: true,
      ahead_unverified_versions: aheadUnverifiedVersions,
      exact_fix: registryVerificationAction,
    };
  }
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
  selfTest = alignMcpRecommendationVersions(
    selfTest,
    mcpTarget.version,
    '',
    registryVerificationAction,
  );
  // An unbound key has no single agent to activate; the self-test still verified the account,
  // and the report carries the exact fix instead of failing the one-command install.
  if (options.activate && !selfTest.activation_verified && !selfTest.activation_identity_unresolved) {
    throw new Error('Marrow activation failed: server confirmation was not returned');
  }
  const hermes = hermesWiringReport(detection, changes, options, plan.mode);
  const plannedHarnessReload = harnessReloadPlan(detection, options.doctor ? [] : changes);
  const updateNeedsRestart = Boolean(options.update
    && !automaticMcpRepairSuppressed
    && (plannedHarnessReload.required || (mcpConfigurations.healthy && !mcpProcesses.healthy)));
  const harnessReload = options.doctor && mcpUpdateRequired
    ? {
      ...plannedHarnessReload,
      required: true,
      live_in_this_process: false,
      instruction: INSTALLER_RESTART_INSTRUCTION,
      prove_command: INSTALLER_DOCTOR_COMMAND,
    }
    : updateNeedsRestart
    ? {
      ...plannedHarnessReload,
      required: true,
      live_in_this_process: false,
      instruction: INSTALLER_RESTART_INSTRUCTION,
      prove_command: INSTALLER_DOCTOR_COMMAND,
    }
    : plannedHarnessReload;
  const updateAwaitingRestart = Boolean(options.update
    && updateNeedsRestart
    && mcpConfigurations.healthy
    && !mcpProcesses.healthy
    && !automaticMcpRepairSuppressed);
  const reportedMcpProcesses = updateAwaitingRestart
    ? {
      ...mcpProcesses,
      update_completed: true,
      awaiting_restart: true,
      exact_fix: null,
    }
    : mcpProcesses;
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
  const changedConfig = changes.some((change) => change.applied);
  const selfTestPassed = Boolean(!selfTest.skipped && selfTest.active && !selfTest.error);
  const controllerPlatform = options.controllerPlatform || process.platform;
  let controller = await controllerStatus({
    root: detection.root,
    identityAgentId: controllerIdentityAgentId,
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
      controller = await ensureCurrentGovernanceController({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        agentId: configuredAgentId,
        identityAgentId: controllerIdentityAgentId,
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
  // Only a controller that is simply not running is expected while the owner has disabled
  // local control. Unsafe state, an unverified or unresponsive process, and unsupported
  // platforms keep their exact fix.
  if (localControl.state === 'disabled'
    && controllerSupportedPlatform(controllerPlatform)
    && ['stopped', 'stale'].includes(controller.state)) {
    controller = {
      ...controller,
      required: false,
      exact_fix: null,
      reason: 'Local control is disabled by the owner, so the controller is intentionally not started. It starts again on the next install or update after npx @getmarrow/install control enable.',
    };
  }
  const remediation = options.repair
    ? {
      attempted: true,
      fixedConfig: changedConfig,
      selfTestPassed,
      automaticMcpRepairSuppressed,
      message: automaticMcpRepairSuppressed
        ? registryVerificationAction
        : options.update && harnessReload.required
        ? 'Managed Marrow configuration is synchronized. Running MCP processes are unchanged; complete the Harness reload steps below before treating the update as live.'
        : selfTestPassed
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
      agent_id: selfTest.agent_id || configuredAgentId || null,
      agent_id_source: configuredAgentId ? 'configured' : selfTest.agent_id_source || 'unresolved',
      server_confirmed: Boolean(selfTest.activation_verified),
      ...(selfTest.activation_identity_unresolved ? { exact_fix: selfTest.activation_exact_fix } : {}),
      activation_scope: selfTest.activation_scope || null,
      coverage_verified: false,
      passive_live: false,
      reload_required: Boolean(options.activate),
      next_action: selfTest.activation_next_action || null,
      receipt: selfTest.activation_receipt || null,
      profile,
    },
    loop_guard_configured: loopGuardConfigured,
    loop_guard_self_tested: loopGuardSelfTest.passed === true,
    loop_guard_observed: false,
    loop_guard: loopGuardSelfTest,
    harnessReload,
    firstCapture: firstCapturePath(detection),
    hermes,
    mcp_runtime: mcpRuntimeReport(mcpRuntime),
    changes,
    doctor: {
      active: Boolean(!selfTest.skipped && selfTest.active),
      missingEnv: options.apiKey ? [] : ['MARROW_API_KEY'],
      envHints,
      missingHooks: changes.filter((change) => change.changed).map((change) => change.label),
      mcpProcesses: reportedMcpProcesses,
      mcpConfigurations,
      ahead_unverified_versions: aheadUnverifiedVersions,
      automatic_mcp_repair_suppressed: automaticMcpRepairSuppressed,
      registry_verification_action: registryVerificationAction,
      mcp_update_required: mcpUpdateRequired,
      restart_required: mcpUpdateRequired || updateAwaitingRestart,
      restart_instruction: mcpUpdateRequired || updateAwaitingRestart ? INSTALLER_RESTART_INSTRUCTION : null,
      verification_command: mcpUpdateRequired || updateAwaitingRestart ? INSTALLER_DOCTOR_COMMAND : null,
      loop_guard_configured: loopGuardConfigured,
      loop_guard_self_tested: loopGuardSelfTest.passed === true,
      loop_guard_observed: false,
      recommendedFix: registryVerificationAction
        || (updateAwaitingRestart ? INSTALLER_RESTART_INSTRUCTION : null)
        || mcpProcesses.exact_fix || mcpConfigurations.exact_fix || (!options.apiKey
        ? envHints.length
          ? `MARROW_API_KEY was found in a likely env file at ${envHints[0]}. Load that key from trusted secret storage, export only MARROW_API_KEY, then run npx @getmarrow/install --repair.`
          : 'Set MARROW_API_KEY, then run npx @getmarrow/install --repair.'
        : controller.exact_fix || selfTest.recommended_fix || null),
      healthCommand: 'npx -y --package=@getmarrow/mcp@latest marrow-mcp ping',
    },
    remediation,
    sdkDependency,
    controller,
    local_control: localControl,
    selfTest,
    warnings: [
      ...(options.keyFromArg
        ? ['Avoid --key in shared shells because command-line arguments can be visible in process listings. Prefer MARROW_API_KEY in your environment or secret manager.']
        : []),
      ...(mcpProcesses.ahead_unverified
        ? ['Registry-unverified ahead Marrow MCP clients are active. Automatic repair is suppressed; run the exact registry verification action before owner-directed replacement.']
        : !mcpProcesses.healthy && !options.update && !options.doctor
        ? [`Stale, mixed, or version-unknown Marrow MCP clients are active. Run ${INSTALLER_UPDATE_COMMAND}; the installer will report the one required restart and later doctor verification.`]
        : []),
      ...(mcpConfigurations.ahead_unverified || changes.some((change) => change.automatic_repair_suppressed)
        ? ['Registry-unverified ahead Marrow MCP configuration was preserved. It was not copied into other managed targets, and automatic repair is suppressed for that surface.']
        : !mcpConfigurations.healthy && !options.update && !options.doctor
        ? [`Stale, mixed, or version-unknown Marrow MCP versions remain in the detected workspace. Run ${INSTALLER_UPDATE_COMMAND} once to synchronize its managed surfaces.`]
        : []),
    ],
  };
}

function activationFailureFix(message, configuredAgentId = '') {
  return identityRefusalFix(message, configuredAgentId) || INSTALLER_DOCTOR_COMMAND;
}

function installCommandFor(options) {
  return options.update ? INSTALLER_UPDATE_COMMAND : 'npx -y @getmarrow/install@latest';
}

// One summary for the one-command paths (first install and update). The full report goes to a
// private log file. Nothing here prints the API key.
// One verdict for the self-test, used by the summary and by key storage: it passed only when it
// ran, raised no error, found the account active and Marrow committed the closure.
function selfTestVerdict(selfTest = {}) {
  const untrusted = !selfTest.skipped && !selfTest.error && Boolean(selfTest.active) && selfTest.decision_committed !== true;
  const failed = !selfTest.skipped && (Boolean(selfTest.error) || !selfTest.active || untrusted);
  return { untrusted, failed, passed: !selfTest.skipped && !failed };
}

function installSummaryLines(report, options) {
  const selfTest = report.selfTest || {};
  const activation = report.activation || {};
  const lines = [];
  const { untrusted, failed: selfTestFailed } = selfTestVerdict(selfTest);
  if (selfTest.skipped) {
    lines.push(`Marrow ${INSTALLER_ADAPTER_VERSION}: configuration updated; self-test skipped (${selfTest.reason}).${selfTest.exact_fix ? ` Fix: ${selfTest.exact_fix}` : ''}`);
  } else if (untrusted) {
    lines.push(`Marrow ${INSTALLER_ADAPTER_VERSION}: self-test decision ${selfTest.decision_id} was recorded without trusted closure (committed was not true). Fix: ${INSTALLER_DOCTOR_COMMAND}`);
  } else if (selfTestFailed) {
    const fix = identityRefusalFix(selfTest.error, activation.agent_id_source === 'configured' ? activation.agent_id : '')
      || report.doctor?.recommendedFix || INSTALLER_DOCTOR_COMMAND;
    lines.push(`Marrow ${INSTALLER_ADAPTER_VERSION}: self-test failed: ${selfTest.error || 'Marrow reported this account as inactive'}. Fix: ${fix}`);
  } else {
    const agent = activation.agent_id
      ? `; agent ${activation.agent_id} (${activation.agent_id_source === 'configured' ? 'configured' : 'resolved by Marrow'})`
      : '';
    lines.push(`Marrow ${INSTALLER_ADAPTER_VERSION}: healthy. Self-test decision ${selfTest.decision_id} committed${agent}.`);
  }
  if (activation.exact_fix) lines.push(`Activation: ${activation.exact_fix}`);
  const apiKey = report.api_key || {};
  if (apiKey.source === 'owner_env_file' && apiKey.path) lines.push(`API key: read from ${apiKey.path}.`);
  if (apiKey.owner_files_disagree) {
    lines.push('Warning: ~/.marrow/env.local and ~/.marrow/env hold different Marrow keys. env.local takes precedence for the installer, hooks and the MCP server; keep only the intended key.');
  }
  const controller = report.controller || {};
  if (controller.restarted) {
    lines.push(`Controller restarted: ${controller.restarted.from_versions.join(', ')} -> ${controller.restarted.to_version}.`);
  } else if (controller.active && controller.changed) {
    lines.push('Controller started.');
  } else if (report.local_control?.state === 'disabled') {
    lines.push('Local control is disabled by the owner, so the controller was left stopped.');
  } else if (options.controller !== false && !controller.active && controller.exact_fix && controller.required !== false) {
    lines.push(`Controller: ${controller.state}. Fix: ${controller.exact_fix}`);
  }
  const hermes = report.hermes || {};
  if (hermes.state === 'configured') {
    lines.push(`Hermes: added the Marrow MCP server to ${hermes.config_path}; the undo steps are in the full report. Restart Hermes to load it.`);
  } else if (hermes.state === 'already_configured') {
    lines.push('Hermes: the Marrow MCP server is already configured.');
  } else if (hermes.state === 'refused' || hermes.state === 'config_not_found' || hermes.state === 'preserved_unverified_ahead') {
    lines.push(`Hermes: ${hermes.config_path || 'config.yaml'} was not changed. The exact block to add is in the full report.`);
  }
  const ownerKey = report.owner_key_storage || {};
  if (ownerKey.state === 'written') {
    lines.push(`Saved your API key in ${ownerKey.path} (only you can read it), so Claude Code finds it when opened from the desktop app, an IDE or a new terminal.`);
  } else if (ownerKey.state === 'different_key_present') {
    lines.push(`Note: ${ownerKey.path} holds a different Marrow key, and Claude Code uses that one when opened outside this terminal. To use this key there, remove that key from the file and run npx @getmarrow/install again.`);
  } else if (ownerKey.state && !['present', 'no_key'].includes(ownerKey.state)) {
    lines.push(`Note: your API key was not saved for Claude Code opened outside this terminal (${ownerKey.path || '~/.marrow/env'} is not a private owner-only file).`);
  }
  if (hermes.owner_key_storage?.state === 'written') {
    lines.push('Stored your API key in ~/.marrow/env (mode 600) so the Hermes MCP server can read it; Hermes passes no other environment to MCP servers.');
  } else if (hermes.owner_key_storage?.state === 'different_key_present') {
    lines.push('Note: ~/.marrow/env already holds a different Marrow key; the Hermes MCP server will use that one.');
  }
  const divergences = (report.changes || []).flatMap((change) => (change.identity_divergence || []).map((divergence) => ({ ...divergence, path: change.path })));
  if (divergences.length) {
    lines.push(`MCP config identity reset: ${divergences.map((divergence) => `${divergence.field} in ${divergence.path}`).join('; ')}. Details and the allowlist fix are in the full report.`);
  }
  const reload = report.harnessReload || {};
  if (reload.required && reload.instruction && hermes.state !== 'configured') lines.push(`Restart: ${reload.instruction}`);
  else if (reload.required && reload.clients?.some((entry) => entry.client !== 'hermes')) {
    lines.push(`Restart: ${reload.clients.filter((entry) => entry.client !== 'hermes').map((entry) => entry.restart).join(' ')}`);
  }
  return { lines, selfTestFailed };
}

function writeInstallLog(home, text) {
  const directory = path.join(home, '.marrow', 'logs');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe log directory');
  fs.chmodSync(directory, 0o700);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(directory, `install-${stamp}-${process.pid}.log`);
  fs.writeFileSync(filePath, text, { flag: 'wx', mode: 0o600 });
  return filePath;
}

async function runCli(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (options.uninstall) {
    const report = await uninstall(options);
    if (options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else printUninstallReport(report);
    return;
  }
  const stored = readOwnerApiKey(options.home);
  const keyInfo = { source: options.apiKey ? 'environment' : null, path: null, owner_files_disagree: stored.conflict };
  if (!options.apiKey && stored.apiKey) {
    options.apiKey = stored.apiKey;
    keyInfo.source = 'owner_env_file';
    keyInfo.path = stored.source;
  }
  const oneCommand = Boolean((options.activate || options.update) && !options.dryRun && !options.doctor);
  if (oneCommand && !options.apiKey) {
    // An update aimed at an unmanaged directory is refused first; it needs no key to answer.
    if (options.update) {
      assertUpdateTargetsManagedRoot(detectEnvironment(options.cwd, {
        ...process.env,
        HOME: options.home || options.cwd,
        USERPROFILE: options.home || options.cwd,
      }));
    }
    process.stdout.write(`Marrow needs your API key. Run: MARROW_API_KEY=your_key ${installCommandFor(options)}  (replace your_key with your key; create one at https://getmarrow.ai)\n`);
    process.exitCode = 2;
    return;
  }
  let report;
  try {
    report = await install(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!oneCommand || options.json || !/^Marrow activation failed/.test(message)) throw error;
    process.stderr.write(`Marrow ${INSTALLER_ADAPTER_VERSION}: ${message}. Fix: ${activationFailureFix(message, String(options.agentId || '').trim())}\n`);
    process.exitCode = 1;
    return;
  }
  // Claude Code opened from the desktop app, an IDE or a new terminal has no MARROW_API_KEY.
  // The MCP server and hooks read ~/.marrow/env, so a first install stores a key that came
  // from the environment there (owner-only), once the self-test passed by the same verdict the
  // summary prints (never on an untrusted closure), with --json and --verbose too.
  const keyWorked = report.selfTest ? selfTestVerdict(report.selfTest).passed : false;
  if (options.activate && !options.update && keyInfo.source === 'environment' && !options.keyFromArg && keyWorked) {
    try {
      const stored = ensureOwnerApiKey(options.home, options.apiKey);
      report.owner_key_storage = { state: stored.state, path: stored.path };
    } catch {
      report.owner_key_storage = { state: 'not_written', path: null };
    }
  }
  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }
  if (!oneCommand || options.verbose) {
    printReport(report);
    return;
  }
  report.api_key = keyInfo;
  const { lines, selfTestFailed } = installSummaryLines(report, options);
  let full = '';
  printReport(report, (text) => { full += text; });
  let logPath = null;
  try {
    logPath = writeInstallLog(options.home, full);
  } catch {
    logPath = null;
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  if (logPath) process.stdout.write(`Full report: ${logPath}\n`);
  else process.stdout.write(`\n${full}`);
  if (selfTestFailed) process.exitCode = 1;
}

module.exports = {
  argumentLabel,
  maintenanceMcpRuntime,
  parseArgs,
  detectEnvironment,
  buildPlan,
  applyPlan,
  install,
  runSelfTest,
  runLoopGuardSelfTest,
  runCli,
  passiveRuntimeSource,
  inspectSdkDependency,
  inspectMcpProcesses,
  inspectMcpConfigurations,
  buildInstallValueMoment,
  buildTokenValueProof,
  stableAgentId,
  detectedClient,
  localControllerAgentId,
  identityAllowlist,
  activationProfile,
  claudeNativeHookFingerprint,
  codexNativeHookFingerprint,
  hostApprovalHooksSupported,
  uninstall,
  printUninstallReport,
  CURSOR_PRE_TOOL_USE_HOST_APPROVAL_MATCHER,
  GEMINI_PRE_ACTION_GUARD_COMMAND,
  GEMINI_CONTEXT_HOOK_COMMAND,
  MCP_PERMISSION_REQUEST_HOOK_COMMAND,
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
  NATIVE_HOOK_MATCHER,
  CURSOR_NATIVE_HOOK_MATCHER,
  GEMINI_NATIVE_HOOK_MATCHER,
  printReport,
  installSummaryLines,
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

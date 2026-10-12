'use strict';

// Marrow's own MCP tools: the 58 names the `marrow` server registers (all profiles), in the
// order of @getmarrow/mcp src/tool-catalog.ts (fix/own-tool-exact 4311df21). Generated from
// test/fixtures/marrow-own-tool-names.json; a test keeps the two equal.
const MARROW_OWN_TOOL_NAMES = Object.freeze([
  'marrow_accept_detected',
  'marrow_agent_performance',
  'marrow_agent_runtime',
  'marrow_agent_status',
  'marrow_arbitrate',
  'marrow_ask',
  'marrow_assign_project_policy_profile',
  'marrow_auto',
  'marrow_buyer_proof',
  'marrow_commit',
  'marrow_completion_contracts',
  'marrow_coordinate',
  'marrow_create_handoff',
  'marrow_create_key',
  'marrow_create_policy_profile',
  'marrow_dashboard',
  'marrow_decision_brief',
  'marrow_decision_trace',
  'marrow_delete_memory',
  'marrow_digest',
  'marrow_evaluate_completion_contract',
  'marrow_export_memories',
  'marrow_first_value',
  'marrow_fleet_lessons',
  'marrow_get_key',
  'marrow_get_memory',
  'marrow_governance_control_plane',
  'marrow_governance_timeline',
  'marrow_handoff_status',
  'marrow_hermes_integration',
  'marrow_import_memories',
  'marrow_install_template',
  'marrow_list_keys',
  'marrow_list_memories',
  'marrow_list_templates',
  'marrow_mark_outdated',
  'marrow_mode_recommend',
  'marrow_model_usage',
  'marrow_orient',
  'marrow_policy_profiles',
  'marrow_policy_resolve',
  'marrow_record_deployment_memory',
  'marrow_replay_compare',
  'marrow_retrieve_memories',
  'marrow_revoke_key',
  'marrow_rotate_key',
  'marrow_run',
  'marrow_runtime_status',
  'marrow_session_end',
  'marrow_share_memory',
  'marrow_status',
  'marrow_supersede_memory',
  'marrow_think',
  'marrow_update_handoff',
  'marrow_update_memory',
  'marrow_value_report',
  'marrow_workflow',
  'marrow_workflow_gate',
]);

// A matcher or guard skips only these names on a server named exactly `marrow` (case-sensitive),
// and only where the host's label or payload proves that server. Any other tool, including an
// unregistered marrow_* name, a case variant or a padded name, still reaches the hook.
const MARROW_OWN_SERVER = 'marrow';

// The names go into regex sources unescaped, so each must be a plain identifier.
function checkedNames(names) {
  if (!Array.isArray(names) || names.length === 0) throw new Error('invalid Marrow tool name list');
  for (const name of names) {
    if (typeof name !== 'string' || !/^marrow_[a-z0-9_]+$/.test(name)) throw new Error(`invalid Marrow tool name: ${name}`);
  }
  return names;
}
checkedNames(MARROW_OWN_TOOL_NAMES);

// One helper builds every host's matcher. Claude Code, Cursor and Gemini test them as JavaScript
// regexes, unanchored and without the m flag, so `^` and `$` are the start and end of the label.
// Every consuming part is `[\s\S]*`, so a label padded with a line terminator, NUL or space
// anywhere still matches, under a search and a full match.
function buildOwnToolMatchers(names = MARROW_OWN_TOOL_NAMES) {
  const own = `(?:${checkedNames(names).join('|')})`;
  // Shared with @getmarrow/mcp NATIVE_HOOK_MATCHER (byte-identical). Claude Code names an MCP tool
  // `mcp__<server>__<tool>` and maps every other character to `_` without trimming, so the exact
  // label `mcp__marrow__<own>` comes only from server `marrow`: that whole label is skipped, and any
  // other label holding `mcp__` or `functions.` anywhere reaches the hook.
  const mcpTail = `^(?!mcp__${MARROW_OWN_SERVER}__${own}$)[\\s\\S]*(?:functions\\.|mcp__)[\\s\\S]*`;
  // Cursor preToolUse names an MCP tool `MCP:<tool>`, without its server, so no MCP label is
  // skipped; Marrow's own tools are told apart in the hook (beforeMCPExecution carries the server).
  const cursorMcp = '[\\s\\S]*MCP:[\\s\\S]*';
  return {
    claude: `Bash|Edit|Write|MultiEdit|Read|Glob|Grep|Search|WebSearch|Task|${mcpTail}`,
    // Codex compiles matchers with Rust `regex`, which has no look-around, and drops a hook whose
    // matcher fails to compile (codex-rs/hooks/src/engine/discovery.rs). `*` is Codex's match-all
    // (engine/matcher.rs), so every tool reaches the hook and the hook skips exactly
    // `mcp__marrow__<own>` itself (@getmarrow/mcp isOfficialMarrowMcpEvent).
    codex: '*',
    cursor: `Shell|Write|Delete|Task|Read|Glob|Grep|Search|WebSearch|List|${cursorMcp}`,
    cursorPreToolUseHostApproval: `Write|Delete|Task|Read|Glob|Grep|Search|WebSearch|List|${cursorMcp}`,
    // Gemini names an MCP tool `mcp_<server>_<tool>`, which other server/tool pairs can also
    // produce, so every `mcp_` label reaches the hook (its payload's mcp_context names the server).
    // Gemini tool names start with a letter: a label that does not (a padded one) reaches it too.
    gemini: '^(?:run_shell_command|write_file|replace|edit_file|delete_file|read_file|read_many_files|glob|grep_search|list_directory|get_file_info|web_search|google_web_search|mcp_[\\s\\S]*)$|^[^A-Za-z_][\\s\\S]*',
  };
}

// Cursor beforeMCPExecution has no matcher: its guard allows at once only when the server is
// exactly `marrow` and the tool is exactly one of the names (a Set, so no regex and no prototype
// keys). The source runs inside `node -e '...'`.
function cursorOwnToolGuardCondition(names = MARROW_OWN_TOOL_NAMES) {
  return `ev.mcp_server_name===${JSON.stringify(MARROW_OWN_SERVER)}&&typeof ev.tool_name==="string"&&new Set(${JSON.stringify(checkedNames(names))}).has(ev.tool_name)`;
}

module.exports = {
  MARROW_OWN_TOOL_NAMES,
  MARROW_OWN_SERVER,
  buildOwnToolMatchers,
  cursorOwnToolGuardCondition,
};

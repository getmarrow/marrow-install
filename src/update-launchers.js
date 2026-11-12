'use strict';

// The Marrow plugin hook launcher commands the published Claude Code plugin versions ship in hooks/hooks.json (plugin
// 0.2.7 and 0.2.8; the same command as src/agent-plugins.js, from plugins tools/check.cjs), each with the launcher file
// it names inside the installed plugin folder. A plugin hook counts only when its command is byte-equal to one of them.
const PLUGIN_PRE_ACTION_LAUNCHERS = Object.freeze([
  Object.freeze({ command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/marrow-launch.cjs" claude-pre-action-hook', launcher: ['scripts', 'marrow-launch.cjs'] }),
]);

// The PreToolUse matchers the installer and MCP setup have published for a Claude Code hook copy, with the release each
// came from (src/marrow-own-tools.js buildOwnToolMatchers().claude since commit e58d7c4, installer 0.1.72 through 0.1.78).
// A hook copy is removed only when its matcher is byte-equal to one of them.
const PUBLISHED_COPY_MATCHERS = Object.freeze([
  Object.freeze({ since: 'installer 0.1.72 (e58d7c4)', matcher: "^(?!(?:mcp__marrow__(?:marrow_accept_detected|marrow_agent_performance|marrow_agent_runtime|marrow_agent_status|marrow_arbitrate|marrow_ask|marrow_assign_project_policy_profile|marrow_auto|marrow_buyer_proof|marrow_commit|marrow_completion_contracts|marrow_coordinate|marrow_create_handoff|marrow_create_key|marrow_create_policy_profile|marrow_dashboard|marrow_decision_brief|marrow_decision_trace|marrow_delete_memory|marrow_digest|marrow_evaluate_completion_contract|marrow_export_memories|marrow_first_value|marrow_fleet_lessons|marrow_get_key|marrow_get_memory|marrow_governance_control_plane|marrow_governance_timeline|marrow_handoff_status|marrow_hermes_integration|marrow_import_memories|marrow_install_template|marrow_list_keys|marrow_list_memories|marrow_list_templates|marrow_mark_outdated|marrow_mode_recommend|marrow_model_usage|marrow_orient|marrow_policy_profiles|marrow_policy_resolve|marrow_record_deployment_memory|marrow_replay_compare|marrow_retrieve_memories|marrow_revoke_key|marrow_rotate_key|marrow_run|marrow_runtime_status|marrow_session_end|marrow_share_memory|marrow_status|marrow_supersede_memory|marrow_think|marrow_update_handoff|marrow_update_memory|marrow_value_report|marrow_workflow|marrow_workflow_gate)|LS|ListMcpResourcesTool)$)[\\s\\S]*" }),
]);

// The PreToolUse matchers the published Claude Code plugin versions ship in hooks/hooks.json (getmarrow/plugins
// plugins/marrow/hooks/hooks.json:28, from commit 3028355, plugin 0.2.2, through 0.2.8 at 1df86a89). A plugin hook counts
// only when its matcher is byte-equal to one of them; each one matches every tool name a pinned copy matcher can match,
// except the plugin's own Marrow tools (test/update-path-matchers.test.js).
const PUBLISHED_PLUGIN_MATCHERS = Object.freeze([
  Object.freeze({ since: 'plugin 0.2.2 (3028355)', matcher: "^(?!(?:mcp__plugin_marrow_marrow__(?:marrow_agent_runtime|marrow_agent_status|marrow_arbitrate|marrow_buyer_proof|marrow_commit|marrow_completion_contracts|marrow_coordinate|marrow_decision_brief|marrow_decision_trace|marrow_evaluate_completion_contract|marrow_fleet_lessons|marrow_governance_timeline|marrow_model_usage|marrow_replay_compare|marrow_think|marrow_value_report|marrow_workflow_gate)|LS|ListMcpResourcesTool)$)[\\s\\S]*" }),
]);

module.exports = { PLUGIN_PRE_ACTION_LAUNCHERS, PUBLISHED_COPY_MATCHERS, PUBLISHED_PLUGIN_MATCHERS };

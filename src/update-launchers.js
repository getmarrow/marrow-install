'use strict';

// The Marrow plugin hook launcher commands the published Claude Code plugin versions ship in hooks/hooks.json (plugin
// 0.2.7 and 0.2.8; the same command as src/agent-plugins.js, from plugins tools/check.cjs), each with the launcher file
// it names inside the installed plugin folder. A plugin hook counts only when its command is byte-equal to one of them.
const PLUGIN_PRE_ACTION_LAUNCHERS = Object.freeze([
  Object.freeze({ command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/marrow-launch.cjs" claude-pre-action-hook', launcher: ['scripts', 'marrow-launch.cjs'] }),
]);

module.exports = { PLUGIN_PRE_ACTION_LAUNCHERS };

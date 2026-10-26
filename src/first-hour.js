const { grokHooksSkipped } = require('./grok-platform');
const { windowsHookWriteSkipped } = require('./windows-hooks');

// Native Windows (F-2c): a hook host whose native hooks are not written has no hooks to restart, trust or capture with.
const hooked = (detection, flag, client) => Boolean(detection[flag]) && !windowsHookWriteSkipped(detection, client);

function wroteHarnessConfig(changes = []) {
  return (changes || []).some((change) => {
    if (!change || !(change.applied || change.changed)) return false;
    return /MCP|hook|Claude|Cursor|Agent instructions|SDK passive/i.test(String(change.label || ''));
  });
}

function harnessReloadPlan(detection = {}, changes = []) {
  const clients = [];
  if (hooked(detection, 'claudeCode', 'claude-code')) {
    clients.push({
      client: 'claude-code',
      restart: 'Restart Claude Code so native hooks and MCP load.',
    });
  }
  if (hooked(detection, 'cursor', 'cursor')) {
    clients.push({
      client: 'cursor',
      restart: 'Restart Cursor or Composer, then review the trusted workspace hooks with /hooks so native lifecycle hooks and project MCP load.',
    });
  }
  if (hooked(detection, 'cline', 'cline')) {
    clients.push({
      client: 'cline',
      restart: 'Enable Hooks in Cline, trust the project hook executables and workspace, then restart Cline. TaskComplete remains unverified.',
    });
  }
  if (hooked(detection, 'windsurf', 'windsurf')) {
    clients.push({
      client: 'windsurf',
      restart: 'Restart Windsurf, trust the workspace hook configuration, and leave Restricted Mode so native hooks can run.',
    });
  }
  if (hooked(detection, 'gemini', 'gemini')) {
    clients.push({
      client: 'gemini',
      restart: 'Restart Gemini CLI, open /hooks panel, and review and approve the project hook fingerprints before treating native hooks as live.',
    });
  }
  // Native Windows (F-2G): no Grok hooks are written, so there is nothing to restart or trust.
  if (detection.grok && !grokHooksSkipped(detection)) {
    clients.push({
      client: 'grok',
      restart: 'Restart Grok, inspect /hooks, and confirm the trusted global Marrow hooks are enabled before treating them as live.',
    });
  }
  if (hooked(detection, 'codex', 'codex')) {
    clients.push({
      client: 'codex',
      restart: 'Start a new Codex session, then review the repository hooks with /hooks before treating them as trusted or live.',
    });
  }
  if (detection.hermes && (changes || []).some((change) => change?.applied && /Hermes/.test(String(change.label || '')))) {
    clients.push({
      client: 'hermes',
      restart: 'Restart Hermes (the CLI session or `hermes gateway restart`) so it loads the Marrow MCP server from config.yaml.',
    });
  }
  if (clients.length === 0) {
    clients.push({
      client: 'mcp',
      restart: 'Restart the app your agent runs in so it loads Marrow.',
    });
  }
  const required = wroteHarnessConfig(changes);
  return {
    required,
    live_in_this_process: !required,
    prove_command: 'npx @getmarrow/install@latest doctor --self-test',
    clients,
    instruction: clients.map((entry) => entry.restart).join(' '),
  };
}

function firstCapturePath(detection = {}) {
  if (hooked(detection, 'claudeCode', 'claude-code')) {
    return {
      client: 'claude-code',
      capability_level: 'native_hooks',
      command: null,
      instruction: 'After restart, Claude native hooks capture the next prompt, tool, and session-end automatically.',
    };
  }
  if (hooked(detection, 'cursor', 'cursor')) {
    return {
      client: 'cursor',
      capability_level: 'native_hooks',
      command: null,
      instruction: 'After restart and trusted-workspace /hooks review, Cursor and Composer use the same native pre-action, action-result, and outcome-closeout hooks. MCP tools remain on demand. Configuration does not verify runtime coverage.',
    };
  }
  if (hooked(detection, 'cline', 'cline')) {
    return {
      client: 'cline',
      capability_level: 'native_hooks',
      command: null,
      instruction: 'After Enable Hooks, executable/workspace trust, and restart, Cline uses native PreToolUse, PostToolUse, and TaskCancel hooks. MCP remains on demand. TaskComplete is documented as coming soon and is not verified coverage; configuration does not prove passive runtime coverage.',
    };
  }
  if (hooked(detection, 'windsurf', 'windsurf')) {
    return {
      client: 'windsurf',
      capability_level: 'native_hooks',
      command: null,
      instruction: 'After restart, workspace trust review, and leaving Restricted Mode, Windsurf uses native pre-action, success-result, and response-closeout hooks. MCP tools remain on demand. Configuration does not verify runtime coverage.',
    };
  }
  if (hooked(detection, 'gemini', 'gemini')) {
    return {
      client: 'gemini',
      capability_level: 'native_hooks',
      command: null,
      instruction: 'After restart and project fingerprint review and approval in /hooks panel, Gemini CLI uses native BeforeTool, AfterTool, and AfterAgent hooks. MCP tools remain on demand. Explicit hook disablement is preserved, and configuration does not verify runtime coverage.',
    };
  }
  if (hooked(detection, 'codex', 'codex')) {
    return {
      client: 'codex',
      capability_level: 'native_hooks',
      command: null,
      instruction: 'After restart and owner /hooks trust review, Codex native hooks capture prompt, pre-action, action-result, and session-end events. Configuration alone does not verify runtime coverage.',
    };
  }
  if (detection.grok && !grokHooksSkipped(detection)) {
    return {
      client: 'grok',
      capability_level: 'native_hooks',
      command: null,
      instruction: 'After restart and /hooks inspection, Grok uses global native pre-action, result, failure-result, and one nonblocking Stop closeout hook. Hooks remain user-toggleable, MCP tools stay on demand, and configuration does not verify observed runtime coverage. The governed runner remains an explicit bounded fallback.',
    };
  }
  if (detection.hermes) {
    return {
      client: 'hermes',
      capability_level: 'mcp',
      command: null,
      instruction: 'After restarting Hermes, Marrow MCP tools are available on demand: call marrow_agent_runtime before deploy, merge or publish work, then marrow_commit with the returned decision and runtime authorization. Hermes has no native pre-action hook, so wrap CLI deploys with npx @getmarrow/install run -- <command>.',
    };
  }
  return {
    client: 'governed_wrapper',
    capability_level: 'governed_wrapper',
    // One separator: npx forwards it to the runner, and the runner drops a doubled one.
    command: 'npx @getmarrow/install run -- <command>',
    instruction: 'Wrap the next deploy, merge, or publish with the governed runner for hosts without a native gate. Before the session ends, call marrow_session_end or marrow_commit. Do not invent token counts.',
  };
}

module.exports = {
  harnessReloadPlan,
  firstCapturePath,
};

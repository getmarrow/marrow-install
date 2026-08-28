function wroteHarnessConfig(changes = []) {
  return (changes || []).some((change) => {
    if (!change || !(change.applied || change.changed)) return false;
    return /MCP|hook|Claude|Cursor|Agent instructions|SDK passive/i.test(String(change.label || ''));
  });
}

function harnessReloadPlan(detection = {}, changes = []) {
  const clients = [];
  if (detection.claudeCode) {
    clients.push({
      client: 'claude-code',
      restart: 'Restart Claude Code so native hooks and MCP load.',
    });
  }
  if (detection.cursor) {
    clients.push({
      client: 'cursor',
      restart: 'Restart Cursor or Composer, then review the trusted workspace hooks with /hooks so native lifecycle hooks and project MCP load.',
    });
  }
  if (detection.cline) {
    clients.push({
      client: 'cline',
      restart: 'Enable Hooks in Cline, trust the project hook executables and workspace, then restart Cline. TaskComplete remains unverified.',
    });
  }
  if (detection.windsurf) {
    clients.push({
      client: 'windsurf',
      restart: 'Restart Windsurf, trust the workspace hook configuration, and leave Restricted Mode so native hooks can run.',
    });
  }
  if (detection.gemini) {
    clients.push({
      client: 'gemini',
      restart: 'Restart Gemini CLI, open /hooks panel, and review and approve the project hook fingerprints before treating native hooks as live.',
    });
  }
  if (detection.codex) {
    clients.push({
      client: 'codex',
      restart: 'Start a new Codex session, then review the repository hooks with /hooks before treating them as trusted or live.',
    });
  }
  if (clients.length === 0) {
    clients.push({
      client: 'mcp',
      restart: 'Restart the owning MCP host so marrow-mcp loads.',
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

function firstCapturePath(detection = {}, agentId) {
  const id = String(agentId || '').trim() || '<agent-id>';
  if (detection.claudeCode) {
    return {
      client: 'claude-code',
      capability_level: 'native_hooks',
      command: null,
      instruction: 'After restart, Claude native hooks capture the next prompt, tool, and session-end automatically.',
    };
  }
  if (detection.cursor) {
    return {
      client: 'cursor',
      capability_level: 'native_hooks',
      command: null,
      instruction: 'After restart and trusted-workspace /hooks review, Cursor and Composer use the same native pre-action, action-result, and outcome-closeout hooks. MCP tools remain on demand. Configuration does not verify runtime coverage.',
    };
  }
  if (detection.cline) {
    return {
      client: 'cline',
      capability_level: 'native_hooks',
      command: null,
      instruction: 'After Enable Hooks, executable/workspace trust, and restart, Cline uses native PreToolUse, PostToolUse, and TaskCancel hooks. MCP remains on demand. TaskComplete is documented as coming soon and is not verified coverage; configuration does not prove passive runtime coverage.',
    };
  }
  if (detection.windsurf) {
    return {
      client: 'windsurf',
      capability_level: 'native_hooks',
      command: null,
      instruction: 'After restart, workspace trust review, and leaving Restricted Mode, Windsurf uses native pre-action, success-result, and response-closeout hooks. MCP tools remain on demand. Configuration does not verify runtime coverage.',
    };
  }
  if (detection.gemini) {
    return {
      client: 'gemini',
      capability_level: 'native_hooks',
      command: null,
      instruction: 'After restart and project fingerprint review and approval in /hooks panel, Gemini CLI uses native BeforeTool, AfterTool, and AfterAgent hooks. MCP tools remain on demand. Explicit hook disablement is preserved, and configuration does not verify runtime coverage.',
    };
  }
  if (detection.codex) {
    return {
      client: 'codex',
      capability_level: 'native_hooks',
      command: null,
      instruction: 'After restart and owner /hooks trust review, Codex native hooks capture prompt, pre-action, action-result, and session-end events. Configuration alone does not verify runtime coverage.',
    };
  }
  return {
    client: 'governed_wrapper',
    capability_level: 'governed_wrapper',
    command: `npx @getmarrow/install run --agent ${id} -- -- <command>`,
    instruction: 'Wrap the next deploy, merge, or publish with the governed runner. Grok and similar unsupported hosts do not intercept tools natively. Before the session ends, call marrow_session_end or marrow_commit. Do not invent token counts.',
  };
}

module.exports = {
  harnessReloadPlan,
  firstCapturePath,
};

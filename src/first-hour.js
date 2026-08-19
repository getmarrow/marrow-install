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
      restart: 'Restart Cursor so project MCP loads.',
    });
  }
  if (detection.codex) {
    clients.push({
      client: 'codex',
      restart: 'Start a new Codex or Grok session so AGENTS.md and MCP config load.',
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
      capability_level: 'mcp',
      command: 'marrow_agent_runtime',
      instruction: 'After restart, call marrow_agent_runtime before the next deploy, merge, or publish. Before the session ends, call marrow_session_end. Cursor MCP tools are on demand.',
    };
  }
  return {
    client: detection.codex ? 'codex' : 'governed_wrapper',
    capability_level: 'governed_wrapper',
    command: `npx @getmarrow/install run --agent ${id} -- -- <command>`,
    instruction: 'Wrap the next deploy, merge, or publish with the governed runner. Codex and Grok do not intercept tools natively. Before the session ends, call marrow_session_end or marrow_commit. Do not invent token counts.',
  };
}

module.exports = {
  harnessReloadPlan,
  firstCapturePath,
};

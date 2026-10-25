'use strict';

// Harness adapters: turn a harness's hook stdin into one normalized event, and render the
// daemon's decision back into that harness's exact output protocol. Phase 1 ships Claude Code
// and Codex; the other harnesses follow the same two-function contract (see the design).
//
// Normalized event:
//   { kind: 'pre'|'post'|'prompt'|'stop'|'session_end'|'other', harness, hook_event_name,
//     session_id, tool_use_id, turn_id, tool_name, tool_input, cwd, permission_mode,
//     success, prompt_chars }
//
// Decision (from the gate): { decision: 'allow'|'deny'|'ask', reason, notice }

const MAX_REASON = 500;
const ID_PATTERN = /[^A-Za-z0-9._:-]/g;

function pick(payload, ...names) {
  for (const name of names) {
    if (payload && payload[name] !== undefined && payload[name] !== null) return payload[name];
  }
  return undefined;
}

function safeId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).replace(ID_PATTERN, '').slice(0, 128);
  return text || null;
}

function boundedReason(reason) {
  return String(reason || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_REASON);
}

// Both Claude Code and Codex send snake_case; older Codex builds and some wrappers send
// camelCase, so both spellings are accepted.
function normalizeClaudeLike(harness, eventArg, payload) {
  const hookEvent = String(pick(payload, 'hook_event_name', 'hookEventName') || '');
  const kindByEvent = {
    PreToolUse: 'pre', PostToolUse: 'post', PostToolUseFailure: 'post', UserPromptSubmit: 'prompt',
    Stop: 'stop', SubagentStop: 'stop', SessionEnd: 'session_end', SessionStart: 'other', Notification: 'other', PreCompact: 'other',
  };
  const kindByArg = { pre: 'pre', post: 'post', 'post-failure': 'post', prompt: 'prompt', stop: 'stop', 'session-end': 'session_end' };
  // The event named in the hook command (fixed by the installer) wins over the payload, so a
  // payload cannot turn a pre-action check into a telemetry event.
  const kind = kindByArg[eventArg] || kindByEvent[hookEvent] || 'other';
  const toolInput = pick(payload, 'tool_input', 'toolInput');
  const response = pick(payload, 'tool_response', 'toolResponse', 'tool_result', 'toolResult');
  let success = null;
  if (kind === 'post') {
    if (eventArg === 'post-failure' || hookEvent === 'PostToolUseFailure') success = false;
    else if (response && typeof response === 'object' && (response.success === false || response.is_error === true || response.isError === true)) success = false;
    else success = true;
  }
  const prompt = pick(payload, 'prompt', 'user_prompt');
  return {
    kind,
    harness,
    hook_event_name: hookEvent.slice(0, 40) || null,
    session_id: safeId(pick(payload, 'session_id', 'sessionId')),
    tool_use_id: safeId(pick(payload, 'tool_use_id', 'toolUseId', 'call_id', 'callId')),
    turn_id: safeId(pick(payload, 'turn_id', 'turnId')),
    tool_name: typeof pick(payload, 'tool_name', 'toolName') === 'string' ? pick(payload, 'tool_name', 'toolName').slice(0, 200) : '',
    tool_input: toolInput && typeof toolInput === 'object' ? toolInput : (typeof toolInput === 'string' ? { input: toolInput } : {}),
    cwd: typeof pick(payload, 'cwd') === 'string' ? pick(payload, 'cwd') : null,
    permission_mode: typeof pick(payload, 'permission_mode', 'permissionMode') === 'string' ? pick(payload, 'permission_mode', 'permissionMode') : null,
    success,
    prompt_chars: typeof prompt === 'string' ? prompt.length : null,
  };
}

function renderClaudeLike(event, decision, { canAsk }) {
  if (event.kind !== 'pre') return { exit: 0, stdout: '{}', stderr: '' };
  if (decision.decision === 'allow') {
    if (!decision.notice) return { exit: 0, stdout: '{}', stderr: '' };
    return {
      exit: 0,
      stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: boundedReason(decision.notice) } }),
      stderr: '',
    };
  }
  const ask = decision.decision === 'ask' && canAsk;
  return {
    exit: 0,
    stdout: JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: ask ? 'ask' : 'deny',
        permissionDecisionReason: boundedReason(decision.reason || 'Marrow blocked this action.'),
      },
    }),
    stderr: '',
  };
}

const ASK_MODES = new Set(['default', 'acceptEdits', 'plan']);

const ADAPTERS = {
  'claude-code': {
    id: 'claude-code',
    canAsk: (event) => ASK_MODES.has(event.permission_mode || 'default'),
    normalize: (eventArg, payload) => normalizeClaudeLike('claude-code', eventArg, payload),
    render: (event, decision) => renderClaudeLike(event, decision, { canAsk: ADAPTERS['claude-code'].canAsk(event) }),
  },
  codex: {
    id: 'codex',
    // Codex hooks cannot prompt the owner; a review verdict is a deny with the approval link.
    canAsk: () => false,
    normalize: (eventArg, payload) => normalizeClaudeLike('codex', eventArg, payload),
    render: (event, decision) => renderClaudeLike(event, decision, { canAsk: false }),
  },
};

// Output when the hook input cannot be parsed. A pre-action check fails closed; everything
// else is a no-op so a broken telemetry event never disturbs the agent.
function renderUnreadable(adapter, eventArg, reason) {
  const event = { kind: eventArg === 'pre' ? 'pre' : 'other' };
  return adapter.render(event, { decision: 'deny', reason });
}

module.exports = { ADAPTERS, renderUnreadable, boundedReason, safeId };

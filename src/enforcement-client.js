const crypto = require('node:crypto');

// A background heartbeat must never hang on a stalled API response.
const HEARTBEAT_REQUEST_TIMEOUT_MS = 15_000;

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function actionBinding(input) {
  const action = String(input.action || '').trim();
  const actionType = String(input.type || 'general').trim().toLowerCase();
  const target = String(input.target || '').trim();
  return {
    action,
    action_type: actionType,
    target: target || action,
    action_hash: sha256(action),
    target_hash: sha256(target || action),
  };
}

// The server resolves the key-bound or seat agent when no agent id is configured.
function configuredAgentId(options) {
  return String(options.agentId || '').trim() || undefined;
}

// Verify and close must declare the protocol the permit was issued under (1 or 2).
function permitProtocolVersion(input) {
  const version = input.protocolVersion ?? input.protocol_version;
  return version === 1 || version === 2 ? version : 1;
}

async function enforcementRequest(requestJson, options, operation, input = {}, requestOptions = undefined) {
  const body = { operation, ...input };
  return requestOptions
    ? requestJson(options, 'POST', '/v1/agent/enforcement', body, {}, requestOptions)
    : requestJson(options, 'POST', '/v1/agent/enforcement', body);
}

async function issueActionPermit(requestJson, options, input) {
  const binding = actionBinding(input);
  return enforcementRequest(requestJson, options, 'issue', {
    ...binding,
    session_id: options.sessionId,
    agent_id: configuredAgentId(options),
    harness: options.client,
    policy_mode: options.policy,
    decision_id: input.decisionId || null,
    gate_receipt_id: input.gateReceiptId || null,
    owner_approval_receipt_id: input.ownerApproval || null,
    surfaces: Array.isArray(input.surfaces) ? input.surfaces : [],
    proof_requirements: Array.isArray(input.proofRequirements) ? input.proofRequirements : [],
  });
}

async function verifyActionPermit(requestJson, options, input) {
  const binding = actionBinding(input);
  return enforcementRequest(requestJson, options, 'verify', {
    ...binding,
    surfaces: Array.isArray(input.surfaces) ? input.surfaces : [],
    permit: input.permit,
    protocol_version: permitProtocolVersion(input),
    session_id: options.sessionId,
    agent_id: configuredAgentId(options),
    harness: options.client,
  });
}

async function closeActionPermit(requestJson, options, input) {
  return enforcementRequest(requestJson, options, 'close', {
    permit: input.permit,
    permit_id: input.permitId || null,
    decision_id: input.decisionId || null,
    session_id: options.sessionId,
    agent_id: configuredAgentId(options),
    success: Boolean(input.success),
    evidence: input.evidence || {},
    protocol_version: permitProtocolVersion(input),
  });
}

async function recordEnforcementHeartbeat(requestJson, options, input = {}) {
  return enforcementRequest(requestJson, options, 'heartbeat', {
    session_id: options.sessionId,
    agent_id: configuredAgentId(options),
    harness: options.client,
    sidecar_instance_id: input.sidecarInstanceId || null,
    config_fingerprint: input.configFingerprint || null,
    expected_hooks: input.expectedHooks || ['pre_action', 'action_result', 'outcome_closure'],
    observed_hooks: input.observedHooks || ['pre_action'],
  }, { timeoutMs: HEARTBEAT_REQUEST_TIMEOUT_MS });
}

async function readEnforcementCoverage(requestJson, options) {
  const query = new URLSearchParams();
  if (options.agentId) query.set('agent_id', options.agentId);
  return requestJson(options, 'GET', `/v1/agent/enforcement${query.size ? `?${query}` : ''}`);
}

module.exports = {
  HEARTBEAT_REQUEST_TIMEOUT_MS,
  actionBinding,
  sha256,
  permitProtocolVersion,
  enforcementRequest,
  issueActionPermit,
  verifyActionPermit,
  closeActionPermit,
  recordEnforcementHeartbeat,
  readEnforcementCoverage,
};

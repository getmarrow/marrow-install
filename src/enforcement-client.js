const crypto = require('node:crypto');

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

async function enforcementRequest(requestJson, options, operation, input = {}) {
  return requestJson(options, 'POST', '/v1/agent/enforcement', {
    operation,
    ...input,
  });
}

async function issueActionPermit(requestJson, options, input) {
  const binding = actionBinding(input);
  return enforcementRequest(requestJson, options, 'issue', {
    ...binding,
    session_id: options.sessionId,
    agent_id: options.agentId,
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
    permit: input.permit,
    session_id: options.sessionId,
    agent_id: options.agentId,
    harness: options.client,
  });
}

async function closeActionPermit(requestJson, options, input) {
  return enforcementRequest(requestJson, options, 'close', {
    permit: input.permit,
    permit_id: input.permitId || null,
    decision_id: input.decisionId || null,
    session_id: options.sessionId,
    agent_id: options.agentId,
    success: Boolean(input.success),
    evidence: input.evidence || {},
  });
}

async function recordEnforcementHeartbeat(requestJson, options, input = {}) {
  return enforcementRequest(requestJson, options, 'heartbeat', {
    session_id: options.sessionId,
    agent_id: options.agentId,
    harness: options.client,
    sidecar_instance_id: input.sidecarInstanceId || null,
    config_fingerprint: input.configFingerprint || null,
    expected_hooks: input.expectedHooks || ['pre_action', 'action_result', 'outcome_closure'],
    observed_hooks: input.observedHooks || ['pre_action'],
  });
}

async function readEnforcementCoverage(requestJson, options) {
  const query = new URLSearchParams();
  if (options.agentId) query.set('agent_id', options.agentId);
  return requestJson(options, 'GET', `/v1/agent/enforcement${query.size ? `?${query}` : ''}`);
}

module.exports = {
  actionBinding,
  sha256,
  enforcementRequest,
  issueActionPermit,
  verifyActionPermit,
  closeActionPermit,
  recordEnforcementHeartbeat,
  readEnforcementCoverage,
};

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  HEARTBEAT_REQUEST_TIMEOUT_MS,
  closeActionPermit,
  issueActionPermit,
  permitProtocolVersion,
  recordEnforcementHeartbeat,
  verifyActionPermit,
} = require('../src/enforcement-client');

function recorder() {
  const calls = [];
  const requestJson = async (options, method, route, body, extraHeaders, requestOptions) => {
    calls.push({ method, route, body: JSON.parse(JSON.stringify(body)), requestOptions });
    return {};
  };
  return { calls, requestJson };
}

test('verify and close declare the issued permit protocol version, defaulting to 1', async () => {
  const { calls, requestJson } = recorder();
  const options = { sessionId: 'session-1', agentId: 'registered-agent', client: 'codex' };
  const input = { action: 'deploy production', type: 'deploy', target: 'worker', surfaces: ['production'], permit: 'opaque' };

  await verifyActionPermit(requestJson, options, { ...input, protocolVersion: 2 });
  await closeActionPermit(requestJson, options, { permit: 'opaque', permitId: 'permit-1', protocolVersion: 2, success: true });
  await verifyActionPermit(requestJson, options, { ...input, protocol_version: 2 });
  await verifyActionPermit(requestJson, options, input);
  await closeActionPermit(requestJson, options, { permit: 'opaque', permitId: 'permit-1', success: false });
  await verifyActionPermit(requestJson, options, { ...input, protocolVersion: '2' });
  await closeActionPermit(requestJson, options, { permit: 'opaque', protocolVersion: 3, success: true });

  assert.deepEqual(calls.map((call) => [call.body.operation, call.body.protocol_version]), [
    ['verify', 2], ['close', 2], ['verify', 2], ['verify', 1], ['close', 1], ['verify', 1], ['close', 1],
  ]);
  assert.equal(calls[0].body.agent_id, 'registered-agent');
  assert.deepEqual([1, 2, undefined, null, 0, '1'].map((value) => permitProtocolVersion({ protocolVersion: value })), [1, 2, 1, 1, 1, 1]);
});

test('enforcement requests omit agent_id so the server resolves the key-bound or seat agent', async () => {
  const { calls, requestJson } = recorder();
  const options = { sessionId: 'session-1', agentId: '', client: 'codex', policy: 'enforce' };
  const input = { action: 'deploy production', type: 'deploy', target: 'worker', surfaces: [], permit: 'opaque' };

  await issueActionPermit(requestJson, options, { ...input, decisionId: 'decision-1', gateReceiptId: 'gate-1' });
  await verifyActionPermit(requestJson, options, input);
  await closeActionPermit(requestJson, options, { permit: 'opaque', success: true });
  await recordEnforcementHeartbeat(requestJson, options, { sidecarInstanceId: 'sidecar-1' });

  assert.deepEqual(calls.map((call) => call.body.operation), ['issue', 'verify', 'close', 'heartbeat']);
  for (const call of calls) assert.equal(Object.hasOwn(call.body, 'agent_id'), false, call.body.operation);
  assert.equal(Object.hasOwn(calls[0].body, 'protocol_version'), false);
  assert.equal(Object.hasOwn(calls[3].body, 'protocol_version'), false);
  assert.equal(HEARTBEAT_REQUEST_TIMEOUT_MS, 15_000);
  assert.deepEqual(calls.map((call) => call.requestOptions), [{ timeoutMs: 15_000 }, { timeoutMs: 15_000 }, { timeoutMs: 15_000 }, { timeoutMs: 15_000 }]);
});

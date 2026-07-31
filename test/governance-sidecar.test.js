const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { startGovernanceSidecar } = require('../src/governance-sidecar');

test('sidecar binds loopback, requires its private token, and does not persist the Marrow API key', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-sidecar-'));
  const prior = process.env.MARROW_SIDECAR_STATE_DIR;
  const apiKey = ['mrw', 'test', 'example', 'placeholder'].join('_');
  process.env.MARROW_SIDECAR_STATE_DIR = dir;
  const sidecar = await startGovernanceSidecar({
    apiKey,
    sidecarPort: 0,
  }, {
    permit: async () => ({ permit: 'opaque', permit_id: 'permit-1' }),
    verify: async () => ({ verified: true }),
    close: async () => ({ closed: true }),
    coverage: async () => ({ status: 'pass' }),
    heartbeat: async () => ({ accepted: true }),
  });

  try {
    const state = JSON.parse(fs.readFileSync(sidecar.stateFile, 'utf8'));
    assert.equal(state.host, '127.0.0.1');
    assert.equal(JSON.stringify(state).includes(apiKey), false);
    assert.equal(fs.statSync(sidecar.stateFile).mode & 0o777, 0o600);

    const denied = await fetch(`http://127.0.0.1:${sidecar.port}/health`);
    assert.equal(denied.status, 401);

    const allowed = await fetch(`http://127.0.0.1:${sidecar.port}/health`, {
      headers: { Authorization: `Bearer ${state.token}` },
    });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).ok, true);
  } finally {
    sidecar.close();
    if (prior === undefined) delete process.env.MARROW_SIDECAR_STATE_DIR;
    else process.env.MARROW_SIDECAR_STATE_DIR = prior;
  }
});

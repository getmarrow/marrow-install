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

test('sidecar rejects a symlinked active state file without overwriting its target', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-sidecar-symlink-'));
  const stateDir = path.join(root, 'state');
  const outside = path.join(root, 'outside.json');
  const prior = process.env.MARROW_SIDECAR_STATE_DIR;
  fs.mkdirSync(stateDir, { mode: 0o700 });
  fs.writeFileSync(outside, 'outside-is-unchanged\n', { mode: 0o600 });
  fs.symlinkSync(outside, path.join(stateDir, 'active.json'));
  process.env.MARROW_SIDECAR_STATE_DIR = stateDir;

  try {
    await assert.rejects(
      startGovernanceSidecar({
        apiKey: 'test-key',
        sidecarPort: 0,
      }, {
        permit: async () => ({ permit: 'opaque', permit_id: 'permit-1' }),
        verify: async () => ({ verified: true }),
        close: async () => ({ closed: true }),
        coverage: async () => ({ status: 'pass' }),
        heartbeat: async () => ({ accepted: true }),
      }),
      /state file must be a private regular file/,
    );
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside-is-unchanged\n');
    assert.equal(fs.lstatSync(path.join(stateDir, 'active.json')).isSymbolicLink(), true);
  } finally {
    if (prior === undefined) delete process.env.MARROW_SIDECAR_STATE_DIR;
    else process.env.MARROW_SIDECAR_STATE_DIR = prior;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

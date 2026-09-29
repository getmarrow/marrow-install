const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Tests never use the operator's home or Marrow credentials. Local control state, bypass
// receipts, controller state, npm tokens and harness configuration live under HOME, and an
// ambient MARROW_API_KEY would send test lifecycle events to the production API.
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-install-test-home-'));
for (const name of Object.keys(process.env)) {
  if (name.startsWith('MARROW_') || name.startsWith('OPENCLAW_')) delete process.env[name];
}
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.once('exit', () => fs.rmSync(isolatedHome, { recursive: true, force: true }));

module.exports = { isolatedHome };

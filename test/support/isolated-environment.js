const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Tests never use the operator's home or Marrow credentials. Local control state, bypass
// receipts, controller state and harness configuration live under HOME, and an
// ambient MARROW_API_KEY would send test lifecycle events to the production API.
const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-install-test-home-'));
for (const name of Object.keys(process.env)) {
  if (name.startsWith('MARROW_') || name.startsWith('OPENCLAW_') || name.startsWith('HERMES_')) delete process.env[name];
}
// An agent host's markers make the governed runner treat its terminal as unattended. Tests must
// not depend on whether they run inside one, so the markers are removed (CI too).
for (const name of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'GEMINI_CLI', 'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_MANAGED_BY_NPM', 'CODEX_THREAD_ID', 'CURSOR_AGENT', 'OPENCODE', 'CI']) {
  delete process.env[name];
}
// A harness executable on the operator's PATH (for example `hermes`) is a detection signal.
// Tests must not depend on what this machine has installed, so those PATH entries are removed.
const HARNESS_EXECUTABLES = ['hermes'];
process.env.PATH = String(process.env.PATH || '').split(path.delimiter).filter((directory) => (
  !HARNESS_EXECUTABLES.some((name) => fs.existsSync(path.join(directory, name)))
)).join(path.delimiter);
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.once('exit', () => fs.rmSync(isolatedHome, { recursive: true, force: true }));

module.exports = { isolatedHome };

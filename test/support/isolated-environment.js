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
// A harness executable on the operator's PATH (`hermes`, `claude`) is a detection signal. Tests
// must not depend on what this machine has installed. A PATH directory holding one is replaced
// by a directory of links to everything else in it, because node, npm and npx often live next
// to `claude`.
const HARNESS_EXECUTABLES = ['hermes', 'claude'];
const pathShimRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-install-test-path-'));
process.env.PATH = String(process.env.PATH || '').split(path.delimiter).map((directory, index) => {
  if (!directory || !HARNESS_EXECUTABLES.some((name) => fs.existsSync(path.join(directory, name)))) return directory;
  const shim = path.join(pathShimRoot, String(index));
  fs.mkdirSync(shim);
  let entries = [];
  try {
    entries = fs.readdirSync(directory);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (HARNESS_EXECUTABLES.includes(entry)) continue;
    try {
      fs.symlinkSync(path.join(directory, entry), path.join(shim, entry));
    } catch {
      // An entry that cannot be linked is left out.
    }
  }
  return shim;
}).join(path.delimiter);
process.once('exit', () => fs.rmSync(pathShimRoot, { recursive: true, force: true }));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.once('exit', () => fs.rmSync(isolatedHome, { recursive: true, force: true }));

module.exports = { isolatedHome };

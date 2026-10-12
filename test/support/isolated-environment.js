const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Tests get their own temp root, whatever TMPDIR the caller has. Marrow refuses private state
// under a symlinked folder or a non-sticky folder others can write (controller-manager.js
// ensurePrivateDirectory), so a TMPDIR below such a folder (a group-writable one from umask 002)
// made the controller tests fail and then stall. The root is under the caller's TMPDIR when that
// is safe and short, else under /tmp; children inherit it through TMPDIR.
function unsafeAncestor(directory) {
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return current;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory() || ((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)) return current;
  }
  return null;
}
const tempBase = [path.resolve(os.tmpdir()), '/tmp'].find((candidate) => candidate.length <= 64 && !unsafeAncestor(candidate));
if (!tempBase) throw new Error(`No safe temp folder for the tests: ${os.tmpdir()} is below ${unsafeAncestor(path.resolve(os.tmpdir()))}, and /tmp is not usable`);
const testTempRoot = fs.mkdtempSync(path.join(tempBase, 'marrow-install-tests-'));
fs.chmodSync(testTempRoot, 0o700);
process.env.TMPDIR = testTempRoot;
for (const name of ['TMP', 'TEMP']) delete process.env[name];
process.once('exit', () => fs.rmSync(testTempRoot, { recursive: true, force: true }));
// Files the tests and the installer create get the same modes under every caller's umask.
process.umask(0o022);

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
  'CODEX_SANDBOX_NETWORK_DISABLED', 'CODEX_MANAGED_BY_NPM', 'CODEX_THREAD_ID', 'CURSOR_AGENT', 'OPENCODE', 'CI',
  // Release-channel and environment names the installer reads.
  'NODE_ENV', 'GITHUB_REF_NAME', 'BRANCH_NAME',
  // Doctor reads the Codex plugin under CODEX_HOME; tests use their own home's .codex.
  'CODEX_HOME']) {
  delete process.env[name];
}
// `npm test` exports npm_config_* names (any case) to the process it starts. The installer's heal
// and the pinned MCP's own-tool identity check both read them as npm configuration (one makes
// the launch of `npx -y @getmarrow/mcp` unproven), so no test inherits one: a case that needs
// one sets it on the child or host fixture it builds (test/support/mcp-host.js withHost).
for (const name of Object.keys(process.env)) {
  if (/^npm_config_/i.test(name)) delete process.env[name];
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
// A hook whose verified runtime is missing installs it itself with the owner's own npm config
// (environment overrides are ignored). Tests never reach a real registry: npm here gets a dead
// one, with no retries, so a self-heal fails at once and the hook holds.
const DEAD_REGISTRY_NPMRC = 'registry=http://127.0.0.1:9/\nfetch-retries=0\nfetch-timeout=2000\n';
function deadRegistryHome(home) {
  fs.writeFileSync(path.join(home, '.npmrc'), DEAD_REGISTRY_NPMRC, { mode: 0o600 });
  return home;
}
deadRegistryHome(isolatedHome);
// A safety net for any hook a test runs under another HOME: npm's proxy settings (not npm_*
// variables, which the install removes) point at a dead port, except for local test registries.
for (const name of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) process.env[name] = 'http://127.0.0.1:9';
for (const name of ['NO_PROXY', 'no_proxy']) process.env[name] = '127.0.0.1,localhost';
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.once('exit', () => fs.rmSync(isolatedHome, { recursive: true, force: true }));

module.exports = { deadRegistryHome, isolatedHome, testTempRoot };

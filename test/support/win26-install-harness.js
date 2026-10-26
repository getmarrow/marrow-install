// Shared by test/win26-native-hooks.test.js: a project with every native hook host detected, a faked process.platform, the install
// options of the F-2c suites and a text snapshot of a folder. No key, token or network: the home has a dead registry.
const { deadRegistryHome } = require('./isolated-environment');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
}

function project() {
  const root = tempDir('marrow-nh-proj-');
  const home = deadRegistryHome(tempDir('marrow-nh-ihome-'));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Claude\n');
  fs.mkdirSync(path.join(root, '.codex'));
  fs.writeFileSync(path.join(root, '.codex', 'config.toml'), '# owner\n');
  for (const dir of ['.cursor', '.gemini', '.windsurf', '.clinerules']) fs.mkdirSync(path.join(root, dir));
  return {
    root,
    home,
    env: { HOME: home, PATH: process.env.PATH },
    cleanup() {
      for (const dir of [root, home]) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function withPlatform(platform, run) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

const installOptions = (p, extra = {}) => ({
  cwd: p.root, home: p.home, mode: 'mcp', yes: true, dryRun: false, selfTest: false, loopGuardSelfTest: false, controller: false,
  apiKey: '', baseUrl: 'https://api.getmarrow.ai', agentId: '', mcpLocalRuntime: true,
  mcpRuntimeInstall: () => false, mcpRuntimeProgress: () => {}, ...extra,
});

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (
  entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
const snapshot = (dir) => Object.fromEntries(walk(dir).map((file) => [path.relative(dir, file), fs.readFileSync(file, 'utf8')]));

module.exports = { installOptions, project, snapshot, withPlatform };

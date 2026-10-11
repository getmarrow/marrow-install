const { deadRegistryHome } = require('./support/isolated-environment');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');

const PINS = require('../src/pins');
const { HOLD_TEXT, localizeHookCommand, runtimeDir, verifyMcpRuntime } = require('../src/mcp-runtime');

const PIN = PINS.MCP_ADAPTER_VERSION;
const RUNTIME = path.join(__dirname, '..', 'src', 'mcp-runtime.js');

// One installer process: ensureMcpRuntime with a stand-in npm that takes a while, so several
// processes overlap in the install window.
const WORKER = `
const fs = require('fs'); const path = require('path');
const { ensureMcpRuntime } = require(process.argv[2]);
const [home, version, integrity, sdkVersion] = process.argv.slice(3);
const npmInstall = (stage, specs) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
  const mcp = path.join(stage, 'node_modules', '@getmarrow', 'mcp');
  fs.mkdirSync(path.join(mcp, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(mcp, 'package.json'), JSON.stringify({ name: '@getmarrow/mcp', version, bin: { 'marrow-mcp': 'dist/cli.js' } }));
  fs.writeFileSync(path.join(mcp, 'dist', 'cli.js'), 'let i="";process.stdin.on("data",c=>i+=c);process.stdin.on("end",()=>process.stdout.write("{\\\\"local\\\\":true}"));');
  fs.writeFileSync(path.join(stage, 'package-lock.json'), JSON.stringify({ packages: { '': {}, 'node_modules/@getmarrow/mcp': { version, integrity } } }));
  return true;
};
process.stdout.write(JSON.stringify(ensureMcpRuntime({ home, version, integrity, npmInstall })));
`;

test('concurrent first installs leave one verified copy and no stage; hooks started meanwhile hold or run that copy, never anything else', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-runtime-race-'));
  fs.chmodSync(home, 0o700);
  // A hook that finds no copy yet starts its own self-heal; it must never reach a real registry.
  deadRegistryHome(home);
  const worker = path.join(home, 'worker.js');
  fs.writeFileSync(worker, WORKER);
  const command = localizeHookCommand(`npx -y --package=@getmarrow/mcp@${PIN} marrow-mcp claude-pre-action-hook`, PIN);
  const env = { HOME: home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin` };
  try {
    const installs = Array.from({ length: 4 }, () => new Promise((resolve) => {
      const child = spawn(process.execPath, [worker, RUNTIME, home, PIN, PINS.MCP_ADAPTER_INTEGRITY], { stdio: ['ignore', 'pipe', 'inherit'] });
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.on('close', () => resolve(JSON.parse(out)));
    }));
    // Hook starts while the installs race: each one either holds (exit 2, fixed text) or runs the
    // verified copy; nothing else answers.
    const hooks = [];
    for (let i = 0; i < 6; i += 1) {
      hooks.push(new Promise((resolve) => {
        const child = spawn('/bin/sh', ['-c', command], { env, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.stdin.on('error', () => {});
        child.on('close', (status) => resolve({ status, stdout, stderr }));
        child.stdin.end('{}');
      }));
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    const results = await Promise.all(installs);
    for (const result of results) assert.ok(['installed', 'present'].includes(result.state), JSON.stringify(result));
    for (const hook of await Promise.all(hooks)) {
      if (hook.status === 2) assert.equal(hook.stderr, `${HOLD_TEXT}\n`);
      else {
        assert.equal(hook.status, 0, hook.stderr);
        assert.equal(hook.stdout, '{"local":true}');
      }
    }
    assert.ok(verifyMcpRuntime(home, PIN, PINS.MCP_ADAPTER_INTEGRITY));
    // A hook that found no copy started a self-heal (offline here); wait for it to finish. It may
    // leave its failure record, never a stage or its lock (see runtime-self-heal.test.js).
    const root = path.dirname(runtimeDir(home, PIN));
    for (const deadline = Date.now() + 60_000; Date.now() < deadline && fs.readdirSync(root).some((name) => name.endsWith('.lock'));) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.deepEqual(fs.readdirSync(path.dirname(runtimeDir(home, PIN))).filter((name) => !name.startsWith('.heal-')), [PIN], 'one copy, no stage left behind');
    const after = spawnSync('/bin/sh', ['-c', command], { env, input: '{}', encoding: 'utf8' });
    assert.equal(after.status, 0, after.stderr);
    assert.equal(after.stdout, '{"local":true}');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

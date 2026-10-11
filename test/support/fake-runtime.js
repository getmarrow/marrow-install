const fs = require('node:fs');
const path = require('node:path');
const PINS = require('../../src/pins');
const { delocalizeHookCommand, ensureMcpRuntime, mapHookCommands, runtimeDir } = require('../../src/mcp-runtime');

// Hook files hold Marrow's commands in the local runtime form (never npx); tests compare the
// canonical spelling every check and merge reads.
function canonicalHooks(text) {
  return mapHookCommands(JSON.parse(text), delocalizeHookCommand);
}

// A stand-in package whose entry runs `script` with /bin/sh, as `--package=@getmarrow/mcp@<version>
// marrow-mcp <entrypoint>` (where tests used to put a fake npx on PATH).
function fakePackageInstall(script, integrity = PINS.MCP_ADAPTER_INTEGRITY) {
  return (stage, specs) => {
    const version = specs.find((spec) => spec.startsWith('@getmarrow/mcp@')).slice('@getmarrow/mcp@'.length);
    const mcp = path.join(stage, 'node_modules', '@getmarrow', 'mcp');
    fs.mkdirSync(path.join(mcp, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(mcp, 'package.json'), JSON.stringify({ name: '@getmarrow/mcp', version, bin: { 'marrow-mcp': 'dist/cli.js' } }));
    fs.writeFileSync(path.join(mcp, 'dist', 'fake.sh'), script);
    fs.writeFileSync(path.join(mcp, 'dist', 'cli.js'), [
      "const r = require('child_process').spawnSync('/bin/sh', [require('path').join(__dirname, 'fake.sh'),",
      `  '--package=@getmarrow/mcp@${version}', 'marrow-mcp', ...process.argv.slice(2)], { stdio: 'inherit' });`,
      'process.exitCode = r.status === null ? 1 : r.status;',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(stage, 'package-lock.json'), JSON.stringify({
      lockfileVersion: 3,
      packages: { '': {}, 'node_modules/@getmarrow/mcp': { version, integrity } },
    }));
    return true;
  };
}

// A verified private runtime under `home` (pinned integrity) that runs the sh `script` for every
// entrypoint, through the same verification every hook's loader does.
function fakeRuntime(home, version, script) {
  fs.rmSync(runtimeDir(home, version), { recursive: true, force: true });
  const result = ensureMcpRuntime({ home, version, integrity: PINS.MCP_ADAPTER_INTEGRITY, npmInstall: fakePackageInstall(script) });
  if (result.state !== 'installed') throw new Error(`fake runtime: ${result.state} ${result.reason || ''}`);
  return result.directory;
}

module.exports = { canonicalHooks, fakePackageInstall, fakeRuntime };

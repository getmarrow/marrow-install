const fs = require('node:fs');
const path = require('node:path');
const { delocalizeHookCommand, mapHookCommands } = require('../../src/mcp-runtime');

// Hook files hold Marrow's commands in the local runtime form (never npx); tests compare the
// canonical spelling every check and merge reads.
function canonicalHooks(text) {
  return mapHookCommands(JSON.parse(text), delocalizeHookCommand);
}

// A stand-in private runtime under `home` that runs the sh `script` for every entrypoint (the
// arguments are `--package=@getmarrow/mcp@<version> marrow-mcp <entrypoint>`), where tests used
// to put a fake npx on PATH. Plain and wrapped hooks start `run`; node guards start launch.cjs.
function fakeRuntime(home, version, script) {
  const dir = path.join(home, '.marrow', 'runtime', 'mcp', version);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'run'), script, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'launch.cjs'), "const r=require('child_process').spawnSync('/bin/sh',[require('path').join(__dirname,'run'),...process.argv.slice(2)],{stdio:'inherit'});process.exit(r.status===null?1:r.status);\n");
  return dir;
}

module.exports = { canonicalHooks, fakeRuntime };

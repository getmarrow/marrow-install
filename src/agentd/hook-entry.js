#!/usr/bin/env node
'use strict';

// Node hook entry.
//   hook-entry.js [--home <abs>] <harness> <event>              portable shim (daemon, then fallback)
//   hook-entry.js [--home <abs>] --fallback <harness> <event>   fallback only (called by the native shim)
// The home directory comes from --home (baked into the hook command by the installer) or the
// passwd entry, never from $HOME, so the governed agent's environment cannot redirect it.

const os = require('node:os');
const path = require('node:path');
const { runFallback, runShim, readStdin } = require('./shim');
const { TOKEN } = require('./protocol');

async function main(argv) {
  let home = null;
  let fallbackOnly = false;
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--home') { home = argv[i + 1]; i += 1; continue; }
    if (argv[i] === '--fallback') { fallbackOnly = true; continue; }
    rest.push(argv[i]);
  }
  const [harness, event] = rest;
  if (!home || !path.isAbsolute(home)) home = os.userInfo().homedir;
  if (!TOKEN.test(harness || '') || !TOKEN.test(event || '')) {
    process.stderr.write('marrow-hook: usage: marrow-hook <harness> <event>\n');
    process.exitCode = event === 'pre' ? 2 : 0;
    return;
  }
  const input = await readStdin(process.stdin);
  const output = fallbackOnly
    ? runFallback({ harness, event, input, home, errorCode: 'native_shim_fallback' })
    : await runShim({ harness, event, input, home });
  if (output.stdout) process.stdout.write(output.stdout);
  if (output.stderr) process.stderr.write(output.stderr);
  process.exitCode = output.exit;
}

main(process.argv.slice(2)).catch(() => {
  process.stderr.write('Marrow hook failed; blocked for safety.\n');
  process.exitCode = 2;
});

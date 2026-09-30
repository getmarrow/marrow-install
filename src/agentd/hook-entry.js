#!/usr/bin/env node
'use strict';

// Node hook entry.
//   hook-entry.js [--home <abs>] <harness> <event>              portable shim (daemon, then fallback)
//   hook-entry.js [--home <abs>] --fallback <harness> <event>   fallback only (called by the native shim)
// The home directory comes from --home (baked into the hook command by the installer) or the
// passwd entry, never from $HOME, so the governed agent's environment cannot redirect it.
//
// Any failure on a pre-action event exits 2 (block): a module that fails to load, an uncaught
// exception or an unexpected rejection must never look like "allow" to the harness.

const argv = process.argv.slice(2);
const isPre = argv.includes('pre');

function failClosed() {
  if (isPre) {
    try { process.stderr.write('Marrow hook failed; blocked for safety.\n'); } catch { /* ignore */ }
    process.exit(2);
  }
  process.exit(0);
}
process.on('uncaughtException', failClosed);
process.on('unhandledRejection', failClosed);

let modules;
try {
  modules = {
    os: require('node:os'),
    path: require('node:path'),
    shim: require('./shim'),
    protocol: require('./protocol'),
  };
} catch {
  failClosed();
}

async function main() {
  const { os, path, shim, protocol } = modules;
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
  if (!protocol.TOKEN.test(harness || '') || !protocol.TOKEN.test(event || '')) {
    process.stderr.write('marrow-hook: usage: marrow-hook <harness> <event>\n');
    process.exitCode = event === 'pre' ? 2 : 0;
    return;
  }
  const input = await shim.readStdin(process.stdin);
  const output = fallbackOnly
    ? shim.runFallback({ harness, event, input, home, errorCode: 'native_shim_fallback' })
    : await shim.runShim({ harness, event, input, home });
  if (output.stdout) process.stdout.write(output.stdout);
  if (output.stderr) process.stderr.write(output.stderr);
  process.exitCode = output.exit;
}

main().catch(failClosed);

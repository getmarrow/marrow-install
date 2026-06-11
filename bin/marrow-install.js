#!/usr/bin/env node

const installer = require('../src/installer');
const governedRunner = require('../src/governed-runner');

const argv = process.argv.slice(2);
const governedCommands = new Set(['run', 'gate', 'proof', 'status', 'govern']);
const runCli = governedCommands.has(argv[0]) ? governedRunner.runCli : installer.runCli;

runCli(argv).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`marrow-install failed: ${message}\n`);
  process.exit(1);
});

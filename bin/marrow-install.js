#!/usr/bin/env node

const installer = require('../src/installer');
const governedRunner = require('../src/governed-runner');
const { runControlCli } = require('../src/control-state');

const argv = process.argv.slice(2);
const governedCommands = new Set(['run', 'gate', 'proof', 'status', 'govern', 'fleet', 'hermes', 'openclaw', 'integrations', 'permit', 'verify-permit', 'coverage', 'sidecar', 'controller']);
const runCli = argv[0] === 'control' ? runControlCli : governedCommands.has(argv[0]) ? governedRunner.runCli : installer.runCli;

runCli(argv).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`marrow-install failed: ${message}\n`);
  process.exit(1);
});

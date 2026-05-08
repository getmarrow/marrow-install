#!/usr/bin/env node

const { runCli } = require('../src/installer');

runCli(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`marrow-install failed: ${message}\n`);
  process.exit(1);
});

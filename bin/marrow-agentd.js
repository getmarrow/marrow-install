#!/usr/bin/env node

const { main } = require('../src/agentd/cli');

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`marrow-agentd failed: ${message}\n`);
  process.exit(1);
});

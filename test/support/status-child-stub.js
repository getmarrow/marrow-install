'use strict';
// Test-only preload. Doctor's seatbelt-status child is `process.execPath <npm's npx-cli.js> ... seatbelt-status`: it no longer looks
// npx up on PATH, so the PATH stand-ins that keep the CLI test runs offline cannot reach it. Here that one spawn is replaced by a
// process that exits 2 (what an npm without the command does), so a test run never starts the real npm: no registry traffic and no
// npm cache or log written under a test's home. Every other spawn is untouched. isolated-environment loads it for in-process runs;
// the CLI runners that run doctor pass it through NODE_OPTIONS.
const childProcess = require('node:child_process');

// The location checks the real spawn would pass (see status-host-fakes.js).
require('./status-host-fakes');

const realSpawn = childProcess.spawn;
childProcess.spawn = function spawn(file, args, ...rest) {
  if (Array.isArray(args) && args.includes('seatbelt-status') && args.some((arg) => /(^|[\\/])npx-cli\.js$/.test(String(arg)))) {
    return realSpawn.call(this, process.execPath, ['-e', 'process.exit(2)'], ...rest);
  }
  return realSpawn.apply(this, arguments);
};

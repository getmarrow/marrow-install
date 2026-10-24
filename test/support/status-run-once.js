'use strict';
// Test-only helper: one doctor status run (runSeatbeltStatus) in its own process, so the tests can run several at the same
// time against one passwd home. Started as `node --require status-host-fakes.js status-run-once.js <child script> <result file>`
// with STATUS_TEST_PASSWD_HOME naming the fake passwd home. The status child is `node <child script>` and gets only the three
// names below; the result file receives the status as JSON (null when nothing could be checked).
const fs = require('node:fs');
const { runSeatbeltStatus } = require('../../src/seatbelt-status');

const [script, out] = process.argv.slice(2);
const env = {};
for (const name of ['HOLD_DIR', 'HOLD_NAME', 'SLEEP_MS']) if (process.env[name] !== undefined) env[name] = process.env[name];
runSeatbeltStatus({ command: process.execPath, args: [script], env }).then((status) => {
  fs.writeFileSync(out, JSON.stringify(status));
});

'use strict';
// Test-only stand-in for the doctor's status child. With HOLD_DIR it records its working folder in <HOLD_NAME>.up and waits for
// <HOLD_NAME>.go (so a test can keep several runs alive at once and finish them in any order); otherwise it sleeps SLEEP_MS.
// Then it prints the status a keyless machine gets.
const fs = require('node:fs');
const path = require('node:path');

const done = () => process.stdout.write(JSON.stringify({ mode: 'seatbelt', reasons: [] }));
if (process.env.HOLD_DIR) {
  // Written whole and then renamed, so a test that sees <HOLD_NAME>.up never sees it empty.
  const up = path.join(process.env.HOLD_DIR, `${process.env.HOLD_NAME}.up`);
  fs.writeFileSync(`${up}.tmp`, process.cwd());
  fs.renameSync(`${up}.tmp`, up);
  const go = path.join(process.env.HOLD_DIR, `${process.env.HOLD_NAME}.go`);
  const wait = () => (fs.existsSync(go) ? done() : setTimeout(wait, 5));
  wait();
} else {
  setTimeout(done, Number(process.env.SLEEP_MS || 0));
}

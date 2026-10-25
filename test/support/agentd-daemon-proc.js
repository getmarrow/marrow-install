'use strict';

// Test launcher: runs marrow-agentd as its own process (as systemd would) against the loopback
// stub. Reads {home, stubUrl, kid, publicKeyPem, settings} as JSON on stdin, prints "ready".
// The API key is read by the daemon from <home>/.marrow/env; it is never passed here.

const { createDaemon } = require('../../src/agentd/daemon');

let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', async () => {
  const options = JSON.parse(input);
  const daemon = createDaemon({
    home: options.home,
    trustedKeys: { [options.kid]: options.publicKeyPem },
    allowedBaseUrls: [options.stubUrl],
    initialPolicyRefresh: false,
    settings: { flushIntervalMs: 3600e3, policyRefreshMs: 3600e3, integrityCheckMs: 3600e3, heartbeatMs: 3600e3, ...(options.settings || {}) },
  });
  try {
    await daemon.start();
  } catch (error) {
    process.stdout.write(`error ${error.message}\n`);
    process.exit(1);
  }
  process.stdout.write('ready\n');
  process.on('SIGTERM', async () => { await daemon.stop().catch(() => {}); process.exit(0); });
});

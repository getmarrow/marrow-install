'use strict';

const path = require('node:path');

// On-disk layout under ~/.marrow/agentd (all 0700 directories and 0600 files):
//   config.json        installer-written config (base URL, agent ids, shim hash, hook entries)
//   policy/current.json last verified signed policy bundle
//   queue/{high,normal}/seg-*.jsonl, queue/state.json   telemetry queue
//   bypass/            one file per decision taken by the shim fallback while the daemon was down
//   run/agentd.sock    the daemon socket (0600 in a 0700 directory)
//   bin/marrow-hook    the hook shim (native, hash-pinned in config.json)
//   lib/<version>/     the daemon code the installer placed
function agentdPaths(home) {
  const root = path.join(home, '.marrow', 'agentd');
  return {
    home,
    root,
    config: path.join(root, 'config.json'),
    policyDir: path.join(root, 'policy'),
    queueDir: path.join(root, 'queue'),
    bypassDir: path.join(root, 'bypass'),
    runDir: path.join(root, 'run'),
    socket: path.join(root, 'run', 'agentd.sock'),
    binDir: path.join(root, 'bin'),
    shim: path.join(root, 'bin', 'marrow-hook'),
    libDir: path.join(root, 'lib'),
  };
}

module.exports = { agentdPaths };

'use strict';

// Preloaded into a child installer run by test/update-path.test.js: appends every path the process opens, stats,
// reads, lists, writes or renames to UPDATE_PATH_SPY_LOG (one per line). Test-only; product code never reads it.
const fs = require('node:fs');

const log = process.env.UPDATE_PATH_SPY_LOG;
if (log) {
  const append = fs.appendFileSync;
  const record = (target) => {
    if (typeof target === 'string' && target !== log) append(log, `${target}\n`);
    else if (target instanceof URL) append(log, `${target.pathname}\n`);
  };
  for (const name of ['openSync', 'readFileSync', 'statSync', 'lstatSync', 'existsSync', 'accessSync', 'readdirSync', 'writeFileSync', 'renameSync', 'realpathSync', 'copyFileSync']) {
    const original = fs[name];
    fs[name] = function spied(target, ...rest) {
      record(target);
      return original.call(this, target, ...rest);
    };
    Object.assign(fs[name], original);
  }
}

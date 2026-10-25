// Control for git-push-swallow.cjs: the same shape of scratch test, but the push goes to a local bare repository. It must pass.
require('../support/isolated-environment');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

test('pushes to a local bare repository', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iso-control-'));
  const git = (cwd, ...args) => cp.spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t', ...args], { cwd, encoding: 'utf8' });
  const bare = path.join(root, 'bare.git');
  const work = path.join(root, 'work');
  assert.equal(git(root, 'init', '-q', '--bare', bare).status, 0);
  assert.equal(git(root, 'init', '-q', work).status, 0);
  assert.equal(git(work, 'commit', '-q', '--allow-empty', '-m', 'one').status, 0);
  assert.equal(git(work, 'push', '-q', bare, 'HEAD:refs/heads/main').status, 0);
});

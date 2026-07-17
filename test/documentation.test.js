const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const canonical = 'Marrow is the runtime control and proof layer for teams running AI agents.';

test('npm entry point matches the product positioning contract', () => {
  assert.match(pkg.description, /governed runner/i);
  assert.ok(readme.includes(canonical));
  assert.ok(readme.includes(`## What's New in v${pkg.version}`));
  assert.equal((readme.match(/^## What's New in v/gm) || []).length, 1);
  assert.ok(readme.indexOf('## First-Run Verification') < readme.indexOf('## Trust and Data Boundaries'));
});

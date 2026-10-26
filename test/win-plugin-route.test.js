// Owner ruling L-1 (21 Oct 2026) + owner item 21 (26 Oct 2026): on native Windows the installer writes no native
// hooks, and its skip text is the neutral item-21 line (no plugin route today: the Cursor plugin's win32 fix ships
// later). The line is asserted in the printed report, the `next:` line, the doctor text, the
// install summary and every skipped_hosts[].message, Grok's included. Skip reasons are unchanged and no
// host is counted as configured. POSIX output is untouched.
const { deadRegistryHome } = require('./support/isolated-environment');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { WINDOWS_PLUGIN_ROUTE, WINDOWS_HOOK_SKIP_REASON, windowsHookNotice } = require('../src/windows-hooks');
const { GROK_WINDOWS_SKIP_REASON } = require('../src/grok-platform');
const { install, installSummaryLines, printReport } = require('../src/installer');

const ROUTE = 'On Windows, this installer does not set up Marrow hooks yet. Windows hook support is coming in a later release.';
const OLD_ROUTE = /use the Marrow Claude Code plugin or Cursor plugin/;
const POSIX_ONLY = { skip: process.platform === 'win32' ? 'POSIX mode bits are not meaningful on Windows' : false };
const HOSTS = ['Claude Code', 'Codex', 'Cursor', 'Cline', 'Windsurf', 'Gemini CLI', 'Grok'];

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(dir, 0o700);
  return dir;
}

// Every native hook host detected in one project, plus Grok under the home folder.
function project() {
  const root = tempDir('marrow-plugin-route-proj-');
  const home = deadRegistryHome(tempDir('marrow-plugin-route-home-'));
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# Claude\n');
  fs.mkdirSync(path.join(root, '.codex'));
  fs.writeFileSync(path.join(root, '.codex', 'config.toml'), '# owner\n');
  for (const dir of ['.cursor', '.gemini', '.windsurf', '.clinerules']) fs.mkdirSync(path.join(root, dir));
  fs.mkdirSync(path.join(home, '.grok'), { mode: 0o700 });
  return {
    root,
    home,
    cleanup() {
      for (const dir of [root, home]) fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function withPlatform(platform, run) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

const installOptions = (p, extra = {}) => ({
  cwd: p.root, home: p.home, mode: 'mcp', yes: true, dryRun: false, selfTest: false, loopGuardSelfTest: false, controller: false,
  apiKey: '', baseUrl: 'https://api.getmarrow.ai', agentId: '', mcpLocalRuntime: true,
  mcpRuntimeInstall: () => false, mcpRuntimeProgress: () => {}, ...extra,
});

const printed = (report) => {
  let text = '';
  printReport(report, (chunk) => { text += chunk; });
  return text;
};
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (
  entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));

test('L-1 I-1: the route sentence is the ruled text, plain ASCII, one constant', () => {
  assert.equal(WINDOWS_PLUGIN_ROUTE, ROUTE);
  assert.match(WINDOWS_PLUGIN_ROUTE, /^[\x20-\x7e]+$/);
  assert.equal(windowsHookNotice('Codex').endsWith(` ${ROUTE}`), true);
  assert.match(windowsHookNotice('Codex'), /^Codex is not governed by native hooks on native Windows/);
});

test('L-1 I-1: on simulated win32 the printed report, next: line, doctor text, summary and every skipped_hosts[].message (Grok too) carry the neutral item-21 line and no plugin route', POSIX_ONLY, async () => {
  const p = project();
  try {
    for (const mode of ['mcp', 'both']) {
      const report = await withPlatform('win32', () => install(installOptions(p, { mode })));
      assert.deepEqual(report.skipped_hosts.map((entry) => entry.host), HOSTS, mode);
      for (const entry of [...report.skipped_hosts, ...report.doctor.skipped_hosts]) {
        assert.match(entry.message, /this installer does not set up Marrow hooks yet/, `${mode} ${entry.host}`);
        assert.doesNotMatch(entry.message, OLD_ROUTE, `${mode} ${entry.host}`);
        assert.equal(entry.message.endsWith(` ${ROUTE}`), true, `${mode} ${entry.host}`);
        assert.match(entry.message, /^[\x20-\x7e]+$/, `${mode} ${entry.host} is plain ASCII`);
        // Reasons and the not-configured claim are exactly what they were.
        assert.equal(entry.reason, entry.host === 'Grok' ? GROK_WINDOWS_SKIP_REASON : WINDOWS_HOOK_SKIP_REASON, `${mode} ${entry.host}`);
        assert.equal(entry.configured, false, `${mode} ${entry.host}`);
        assert.equal(entry.action, 'skipped', `${mode} ${entry.host}`);
      }
      assert.equal(report.loop_guard_configured, false, mode);
      const text = printed(report);
      assert.match(text, /this installer does not set up Marrow hooks yet/, mode);
      assert.doesNotMatch(text, OLD_ROUTE, mode);
      const next = text.split('\n').filter((line) => line.startsWith('- next:'));
      assert.equal(next.length, 1, mode);
      assert.match(next[0], /^- next: no native hooks were written on native Windows \(see skipped above\); wrap protected commands with npx @getmarrow\/install run -- <command>\./);
      assert.equal(next[0].endsWith(` ${ROUTE}`), true, mode);
      // Every skipped host line printed in the report carries the sentence (7 hosts, 7 sentences, plus the next: line).
      assert.equal(text.split(ROUTE).length - 1, HOSTS.length + 1, `${mode} printed route count`);
      const summary = installSummaryLines(report, {}).lines.filter((line) => line.startsWith('Skipped '));
      assert.equal(summary.length, HOSTS.length, mode);
      for (const line of summary) assert.equal(line.endsWith(` ${ROUTE}`), true, line.slice(0, 40));
    }
    const doctor = await withPlatform('win32', () => install(installOptions(p, { yes: false, doctor: true })));
    const doctorText = printed(doctor);
    for (const host of HOSTS) {
      const line = doctorText.split('\n').find((candidate) => candidate.startsWith(`- ${host} coverage: not configured`));
      assert.ok(line, `doctor names ${host}`);
      assert.equal(line.endsWith(` ${ROUTE}`), true, host);
    }
    const dry = await withPlatform('win32', () => install(installOptions(p, { yes: false, dryRun: true })));
    for (const entry of dry.skipped_hosts) assert.equal(entry.message.endsWith(` ${ROUTE}`), true, entry.host);
  } finally {
    p.cleanup();
  }
});

test('L-1 I-1: on linux and darwin nothing changes: no skipped_hosts, no route sentence in the report or in any written file, the 0.1.73 next: line is kept', POSIX_ONLY, async () => {
  for (const platform of ['linux', 'darwin']) {
    for (const mode of ['mcp', 'both']) {
      const p = project();
      try {
        const report = await withPlatform(platform, () => install(installOptions(p, { mode })));
        assert.equal('skipped_hosts' in report, false, `${platform} ${mode}`);
        assert.equal('skipped_hosts' in report.doctor, false, `${platform} ${mode}`);
        const text = printed(report);
        assert.doesNotMatch(text, /On Windows, use the Marrow/, `${platform} ${mode}`);
        assert.doesNotMatch(text, /Claude Code plugin|Cursor plugin/, `${platform} ${mode}`);
        assert.equal(text.includes(ROUTE), false, `${platform} ${mode} route`);
        assert.doesNotMatch(text, /windows_hook_shell_unverified|grok_hooks_unsupported_on_native_windows/, `${platform} ${mode}`);
        assert.match(text, /^- next: restart the host and complete its hook trust\/review step before relying on live enforcement$/m, `${platform} ${mode}`);
        for (const base of [p.root, p.home]) {
          for (const file of walk(base)) {
            const body = fs.readFileSync(file, 'latin1');
            assert.equal(body.includes('On Windows, use the Marrow'), false, `${platform} ${mode} ${path.relative(base, file)}`);
          }
        }
      } finally {
        p.cleanup();
      }
    }
  }
});

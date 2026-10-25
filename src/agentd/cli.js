#!/usr/bin/env node
'use strict';

// marrow-agentd command line.
//   run [--home <abs>] [--socket-activation]   start the daemon (systemd ExecStart)
//   status [--json]                             daemon status
//   doctor [--json]                             status plus local install checks
//   control request <enforce|observe|off> [--reason <text>]
//                                               files an owner-approval request; changes nothing locally
//   install --home <abs> [--harness <id>=<file>]... [--mcp-config <file>]... [--dry-run] [--no-compile]
//   hook <harness> <event>                      portable hook shim
//   version

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { adminCall } = require('./client');
const { AGENTD_VERSION, CONTROL_LEVELS } = require('./constants');
const { agentdPaths } = require('./paths');

function parseFlags(argv) {
  const flags = { _: [], harness: [], mcpConfig: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') flags.json = true;
    else if (arg === '--dry-run') flags.dryRun = true;
    else if (arg === '--no-compile') flags.noCompile = true;
    else if (arg === '--socket-activation') flags.socketActivation = true;
    else if (arg === '--yes') flags.yes = true;
    else if (arg === '--home') { flags.home = argv[i + 1]; i += 1; }
    else if (arg === '--reason') { flags.reason = argv[i + 1]; i += 1; }
    else if (arg === '--harness') { flags.harness.push(argv[i + 1]); i += 1; }
    else if (arg === '--mcp-config') { flags.mcpConfig.push(argv[i + 1]); i += 1; }
    else flags._.push(arg);
  }
  return flags;
}

function resolveHome(flags) {
  if (flags.home) {
    if (!path.isAbsolute(flags.home)) throw new Error('--home must be an absolute path');
    return flags.home;
  }
  return os.userInfo().homedir;
}

function print(flags, value, text) {
  process.stdout.write(flags.json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`);
}

async function commandRun(flags) {
  const { createDaemon } = require('./daemon');
  process.umask(0o077);
  const home = resolveHome(flags);
  let listenFd;
  if (flags.socketActivation && process.env.LISTEN_FDS === '1' && Number(process.env.LISTEN_PID) === process.pid) listenFd = 3;
  const daemon = createDaemon({ home, listenFd });
  await daemon.start();
  process.stderr.write(`marrow-agentd ${AGENTD_VERSION} listening (${listenFd === 3 ? 'socket activation' : daemon.socketPath})\n`);
  const shutdown = async () => {
    await daemon.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  await new Promise(() => {});
}

async function daemonStatus(home) {
  try {
    const response = await adminCall(agentdPaths(home).socket, 'status');
    return response.json;
  } catch (error) {
    return { ok: false, running: false, error: error.code || 'unreachable' };
  }
}

async function commandStatus(flags) {
  const status = await daemonStatus(resolveHome(flags));
  if (!status || status.ok === false) {
    print(flags, status, 'marrow-agentd: not running. Routine actions pass with recorded bypasses; risky actions are blocked until it runs. Fix: systemctl --user restart marrow-agentd');
    process.exitCode = 1;
    return;
  }
  const drops = status.queue.drops;
  print(flags, status, [
    `marrow-agentd ${status.version}: running (pid ${status.pid}, up ${status.uptime_s}s)`,
    `control: ${status.control.level} (${status.control.authority})${status.control.pending_request ? `; pending owner request: ${status.control.pending_request.requested_level}` : ''}`,
    `policy: ${status.policy.source} v${status.policy.version} (${status.policy.freshness})`,
    `credential: ${status.credential.state}; api: ${status.api.base_url}${status.api.base_url_rejected ? ' (config base URL refused)' : ''}`,
    `integrity: ${status.integrity.ok ? 'ok' : `degraded: ${status.integrity.violations.map((v) => v.code).join(', ')}`}`,
    `queue: ${status.queue.pending} pending; drops ${drops.total} (${drops.unreported} not yet reported); uploader ${status.uploader.state}`,
  ].join('\n'));
}

async function commandDoctor(flags) {
  const home = resolveHome(flags);
  const paths = agentdPaths(home);
  const status = await daemonStatus(home);
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });
  add('daemon_running', Boolean(status && status.ok), status && status.ok ? `pid ${status.pid}` : 'not reachable on its socket');
  add('config_present', fs.existsSync(paths.config), paths.config);
  add('shim_present', fs.existsSync(paths.shim), paths.shim);
  const unitDir = path.join(home, '.config', 'systemd', 'user');
  add('systemd_units', fs.existsSync(path.join(unitDir, 'marrow-agentd.service')) && fs.existsSync(path.join(unitDir, 'marrow-agentd.socket')), unitDir);
  if (status && status.ok) {
    add('credential', status.credential.state === 'present', status.credential.state);
    add('integrity', status.integrity.ok, status.integrity.ok ? 'ok' : status.integrity.violations.map((v) => v.code).join(', '));
    add('policy', status.policy.freshness !== 'expired', `${status.policy.source} v${status.policy.version} ${status.policy.freshness}`);
    add('telemetry', status.uploader.state !== 'auth_failed', `${status.uploader.state}; ${status.queue.pending} pending; ${status.queue.drops.total} dropped`);
  }
  const ok = checks.every((check) => check.ok);
  print(flags, { ok, checks, capabilities: status && status.capabilities }, checks.map((c) => `${c.ok ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`).join('\n'));
  process.exitCode = ok ? 0 : 1;
}

async function commandControl(flags) {
  const [, action, level] = flags._;
  if (action !== 'request') {
    const message = 'Marrow control changes need owner approval. Use: marrow-agentd control request <enforce|observe|off> --reason "<why>". Nothing was changed.';
    print(flags, { ok: false, changed_locally: false, error: message }, message);
    process.exitCode = 2;
    return;
  }
  if (!CONTROL_LEVELS.includes(level)) {
    print(flags, { ok: false, changed_locally: false, error: 'level must be enforce, observe or off' }, 'level must be enforce, observe or off');
    process.exitCode = 2;
    return;
  }
  try {
    const response = await adminCall(agentdPaths(resolveHome(flags)).socket, 'control-request', { level, reason: flags.reason || '' });
    const json = response.json || {};
    print(flags, json, json.ok ? `${json.message}${json.approval_url ? `\nApprove: ${json.approval_url}` : ''}` : `Request failed: ${json.message || json.error}`);
    process.exitCode = response.exit;
  } catch (error) {
    print(flags, { ok: false, changed_locally: false, error: error.code || 'unreachable' }, 'marrow-agentd is not running; nothing changed.');
    process.exitCode = 1;
  }
}

function commandInstall(flags) {
  const { applyPlan, buildPlan } = require('./install-plan');
  if (!flags.home && !flags.yes) throw new Error('install writes to a home directory: pass --home <abs> (or --yes for the current user)');
  const home = resolveHome(flags);
  const harnesses = flags.harness.map((spec) => {
    const [harness, file] = String(spec).split('=');
    if (!['claude-code', 'codex'].includes(harness) || !file || !path.isAbsolute(file)) throw new Error('--harness must be claude-code=<abs file> or codex=<abs file>');
    return { harness, file };
  });
  const plan = buildPlan({ home, harnesses, hostname: os.hostname() });
  const report = applyPlan(plan, { compile: !flags.noCompile, mcpConfigFiles: flags.mcpConfig, dryRun: flags.dryRun });
  print(flags, report, `marrow-agentd ${flags.dryRun ? 'install plan' : 'installed'}: shim ${report.shim ? report.shim.mode : 'n/a'}, ${report.hooks.length} hook entries, ${report.keys_removed} inline keys removed.`);
}

async function main(argv) {
  const flags = parseFlags(argv);
  const command = flags._[0];
  if (command === 'run') return commandRun(flags);
  if (command === 'status') return commandStatus(flags);
  if (command === 'doctor') return commandDoctor(flags);
  if (command === 'control') return commandControl(flags);
  if (command === 'install') return commandInstall(flags);
  if (command === 'version' || command === '--version') { process.stdout.write(`${AGENTD_VERSION}\n`); return undefined; }
  if (command === 'hook') {
    const { runShim, readStdin } = require('./shim');
    const [, harness, event] = flags._;
    const input = await readStdin(process.stdin);
    const output = await runShim({ harness, event, input, home: resolveHome(flags) });
    if (output.stdout) process.stdout.write(output.stdout);
    if (output.stderr) process.stderr.write(output.stderr);
    process.exitCode = output.exit;
    return undefined;
  }
  process.stderr.write('usage: marrow-agentd <run|status|doctor|control request|install|hook|version>\n');
  process.exitCode = 2;
  return undefined;
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`marrow-agentd: ${error && error.message ? error.message : String(error)}\n`);
    process.exit(1);
  });
}

module.exports = { main, parseFlags };

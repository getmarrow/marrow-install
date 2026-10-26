// F-2c (installer 0.1.74): native Windows hook hosts.
//
// A hook only governs when the host's shell runs it fail-closed: a pre-action hook that cannot start
// must end in exit 2, never in exit 1 or a shell error the host treats as non-blocking. On native
// Windows a host may run a hook command through cmd.exe (Node spawn shell:true), Git Bash, Windows
// PowerShell 5.1 or PowerShell 7, and no host's Windows hook shell has been verified:
//   - cmd.exe: limit 8191 characters; searches the current (project) folder before PATH; a missing
//     program exits 9009 or 3.
//   - Windows PowerShell 5.1 and PowerShell 7 (-Command): a quoted program path is an expression, so
//     `"C:\...\node.exe" -e ...` is a parse error (exit 1); a native exit code is reported as 1 unless
//     the command ends with `exit $LASTEXITCODE`, so even a working hook's hold (2) arrives as 1.
//     5.1 also rejects `||`.
//   - Git Bash: runs the command, but a missing program exits 127.
// No single command text is fail-closed in all four (a PowerShell-valid start, `& "<path>"`, is an
// error in cmd and a background job in bash). So no host gets native hooks on native Windows until
// its hook shell is proven on windows-latest; each is reported in skipped_hosts with
// windows_hook_shell_unverified (the F-2G Grok pattern). The table records, per host, the shells it
// may use and the form it would get; `form: null` means skipped. Grok keeps its own F-2G reason.
//
// The decision is keyed on the REAL platform (process.platform, read at call time). Nothing in the
// environment, argv or a flag can turn it off. A detection built with an injected platform (tests
// only, the third argument of detectEnvironment) can only ADD the skip; it can never remove it on a
// real win32 host.

const WINDOWS_HOOK_SKIP_REASON = 'windows_hook_shell_unverified';
const SHELLS = ['cmd.exe (spawn shell:true)', 'Git Bash', 'Windows PowerShell 5.1', 'PowerShell 7'];

// Owner ruling L-1 (21 Oct 2026): the installer's Windows skip text points users to the plugins, the
// supported Windows route. Plain ASCII; every skipped_hosts[].message and the report's `next:` line carry it.
const WINDOWS_PLUGIN_ROUTE = 'On Windows, use the Marrow Claude Code plugin or Cursor plugin for hook protection.';

const WINDOWS_HOOK_HOSTS = Object.freeze([
  { client: 'claude-code', host: 'Claude Code', label: 'Claude Code MCP passive hooks', detected: 'claudeCode', path: 'claudeSettings', shells: SHELLS, form: null },
  { client: 'codex', host: 'Codex', label: 'Codex native hooks', detected: 'codex', path: 'codexHooks', shells: SHELLS, form: null },
  { client: 'cursor', host: 'Cursor', label: 'Cursor native hooks', detected: 'cursor', path: 'cursorHooks', shells: SHELLS, form: null },
  { client: 'cline', host: 'Cline', label: 'Cline native hooks', detected: 'cline', path: 'clinePreToolUseHook', shells: SHELLS, form: null },
  { client: 'windsurf', host: 'Windsurf', label: 'Windsurf native hooks', detected: 'windsurf', path: 'windsurfHooks', shells: SHELLS, form: null },
  { client: 'gemini', host: 'Gemini CLI', label: 'Gemini CLI native hooks', detected: 'gemini', path: 'geminiSettings', shells: SHELLS, form: null },
].map((entry) => Object.freeze({ ...entry, shells: Object.freeze([...entry.shells]) })));

function windowsHooksSkipped(detection) {
  return process.platform === 'win32' || detection?.windowsHooksSkipped === true;
}

function windowsHookNotice(host) {
  return `${host} is not governed by native hooks on native Windows: Marrow cannot yet prove that the shell ${host} runs hooks with there (cmd.exe, Git Bash, Windows PowerShell 5.1 or PowerShell 7) blocks the action when the hook cannot start, so it did not write ${host}'s native hooks and does not count ${host} as covered. Hook entries already in that file were left unchanged and are not counted. The governed wrapper (npx @getmarrow/install run -- <command>) remains an explicit bounded fallback. ${WINDOWS_PLUGIN_ROUTE}`;
}

// The table entry for a host client whose native hooks are skipped here, or null.
function windowsHookHost(detection, client) {
  if (!windowsHooksSkipped(detection)) return null;
  const name = client === 'composer' ? 'cursor' : client;
  const entry = WINDOWS_HOOK_HOSTS.find((item) => item.client === name);
  return entry && entry.form === null ? entry : null;
}

// Whether the native hook write for one detected host is skipped (buildPlan, reload plan, first capture).
function windowsHookWriteSkipped(detection, client) {
  return Boolean(windowsHookHost(detection, client));
}

// What a skipped host is reported as (plan, install report, doctor). Never `configured`.
function windowsHookSkipEntries(detection) {
  if (!windowsHooksSkipped(detection)) return [];
  return WINDOWS_HOOK_HOSTS.filter((entry) => entry.form === null && detection[entry.detected]).map((entry) => ({
    host: entry.host,
    label: entry.label,
    path: detection.paths[entry.path],
    action: 'skipped',
    reason: WINDOWS_HOOK_SKIP_REASON,
    configured: false,
    message: windowsHookNotice(entry.host),
  }));
}

module.exports = {
  WINDOWS_HOOK_HOSTS,
  WINDOWS_HOOK_SKIP_REASON,
  WINDOWS_PLUGIN_ROUTE,
  windowsHookHost,
  windowsHookNotice,
  windowsHookSkipEntries,
  windowsHookWriteSkipped,
  windowsHooksSkipped,
};

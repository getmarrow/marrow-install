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
const SHELLS = Object.freeze(['cmd.exe (spawn shell:true)', 'Git Bash', 'Windows PowerShell 5.1', 'PowerShell 7']);

// Owner item 21 (26 Oct 2026): no plugin route on Windows today (the Cursor plugin's win32 fix ships in a later
// release), so the skip text is neutral. Plain ASCII; every skipped_hosts[].message and the report's `next:` line carry it.
const WINDOWS_PLUGIN_ROUTE = 'On Windows, this installer does not set up Marrow hooks yet. Windows hook support is coming in a later release.';

// NH (installer 0.1.76): the decision per host is DATA, not a switch. A host gets a native Windows hook only
// when ONE written form is usable AND fail-closed in every hook shell the host may run it with. FORM_MATRIX
// states what each written form does in each shell (src/mcp-runtime.js windowsHookCommand), for a pre-action
// entry:
//   works   the hook runs and its answer (0, 1, 2) arrives; node missing, a missing/edited launcher or a
//           runtime that cannot start end in exit 2
//   closed  nothing runs but every end is exit 2 (a bash syntax error): never allows, never usable
//   open    some failure ends in an exit code the host treats as non-blocking (a PowerShell parse error is 1,
//           a missing program is 9009 or 127)
// Cells marked works/closed are CLAIMS the rows of test/win26-native-hooks.test.js check against the real
// shell (bash on any host, cmd.exe and PowerShell on windows-latest); `open` is the assumption when a shell
// was not shown, never a measurement. A claim that a row refutes must be corrected here, which flips the host.
const FORM_MATRIX = Object.freeze({
  cmd: Object.freeze({ cmd: 'works', bash: 'closed', powershell: 'open' }),
  bash: Object.freeze({ cmd: 'open', bash: 'works', powershell: 'open' }),
  powershell: Object.freeze({ cmd: 'open', bash: 'closed', powershell: 'works' }),
});
const WINDOWS_SHELLS = Object.freeze(['cmd', 'bash', 'powershell']);

// Marrow cannot show which shell a host runs its hooks with (a host's documentation is not a measurement, and
// the shell can depend on what is installed: Claude Code uses Git Bash when it is present and PowerShell when not),
// so every host counts all three columns: a form must `work` in cmd.exe, Git Bash and PowerShell (5.1 and 7).
// candidate: the shape of the host's hook entries: `plain` is one `marrow-mcp <entrypoint>` command (the short
// forms can carry it); `guard` (a node script that spawns the entrypoint), `wrapper` (an `sh -c` script) and
// `script` (a hook file) have no short Windows form.
const HOST_FACTS = [
  { client: 'claude-code', host: 'Claude Code', label: 'Claude Code MCP passive hooks', detected: 'claudeCode', path: 'claudeSettings', candidate: 'plain' },
  { client: 'codex', host: 'Codex', label: 'Codex native hooks', detected: 'codex', path: 'codexHooks', candidate: 'plain' },
  { client: 'cursor', host: 'Cursor', label: 'Cursor native hooks', detected: 'cursor', path: 'cursorHooks', candidate: 'guard' },
  { client: 'cline', host: 'Cline', label: 'Cline native hooks', detected: 'cline', path: 'clinePreToolUseHook', candidate: 'script' },
  { client: 'windsurf', host: 'Windsurf', label: 'Windsurf native hooks', detected: 'windsurf', path: 'windsurfHooks', candidate: 'wrapper' },
  { client: 'gemini', host: 'Gemini CLI', label: 'Gemini CLI native hooks', detected: 'gemini', path: 'geminiSettings', candidate: 'wrapper' },
];

// The form a host gets, or null (the L-1 skip). A form is usable only when it `works` in every shell column;
// `closed` is safe but never usable, `open` is a failure path.
function decideForm(facts) {
  if (facts.candidate !== 'plain') return null;
  return Object.keys(FORM_MATRIX).find((form) => WINDOWS_SHELLS.every((shell) => FORM_MATRIX[form][shell] === 'works')) || null;
}

const WINDOWS_HOOK_HOSTS = Object.freeze(HOST_FACTS.map((entry) => Object.freeze({
  ...entry,
  shells: SHELLS,
  form: decideForm(entry),
})));

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
  FORM_MATRIX,
  WINDOWS_HOOK_HOSTS,
  WINDOWS_SHELLS,
  WINDOWS_HOOK_SKIP_REASON,
  WINDOWS_PLUGIN_ROUTE,
  decideForm,
  windowsHookHost,
  windowsHookNotice,
  windowsHookSkipEntries,
  windowsHookWriteSkipped,
  windowsHooksSkipped,
};

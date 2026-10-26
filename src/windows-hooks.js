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
// error in cmd and a background job in bash). So a host gets native hooks on native Windows only when its hook
// shell set is proven (HOST_SHELL_EVIDENCE) AND one written form is measured `works` on windows-latest in every
// shell of that set (FORM_MATRIX, CELL_LENGTH_BOUND); otherwise it is reported in skipped_hosts with
// windows_hook_shell_unverified (the F-2G Grok pattern). `form: null` means skipped. Grok keeps its own F-2G reason.
//
// The decision is keyed on the REAL platform (process.platform, read at call time). Nothing in the
// environment, argv or a flag can turn it off. A detection built with an injected platform (tests
// only, the third argument of detectEnvironment) can only ADD the skip; it can never remove it on a
// real win32 host.

const WINDOWS_HOOK_SKIP_REASON = 'windows_hook_shell_unverified';
const SHELLS = Object.freeze(['cmd.exe (spawn shell:true)', 'Git Bash', 'Windows PowerShell 5.1', 'PowerShell 7']);

// Owner ruling L-1 (21 Oct 2026): the installer's Windows skip text points users to the plugins, the
// supported Windows route. Plain ASCII; every skipped_hosts[].message and the report's `next:` line carry it.
const WINDOWS_PLUGIN_ROUTE = 'On Windows, use the Marrow Claude Code plugin or Cursor plugin for hook protection.';

// NH (installer 0.1.76): the decision per host is DATA, not a switch, and it is keyed on MEASUREMENTS and EVIDENCE only.
// A host gets a native Windows hook form only when ALL of these hold (decideHostWith):
//   1. the host's hook entry has a short Windows form (candidate `plain`);
//   2. HOST_SHELL_EVIDENCE has a record for the host: the shell set a Windows hook command runs in (one shell when the host
//      pins it or an exec form, else a fixed set), never "depends on user setup", with the host's deny path as exit 2;
//   3. ONE written form has a CI-measured `works` cell (FORM_MATRIX) in EVERY shell the evidence allows;
//   4. the measured length bound of that form in each of those shells (CELL_LENGTH_BOUND, from the 8190/8191/8192 rows) covers
//      the longest command line the generator can produce (WINDOWS_HOOK_MAX);
//   5. the measurement names the CI run that produced it (MEASURE_RUN);
//   6. the record is a live check, or a vendor document the owner accepted (`ownerAccepted`); a vendor document alone leaves the
//      host `ready_owner_decision`: still skipped.
// Anything else keeps the L-1 skip. Today FORM_MATRIX holds no measurement (every cell `unmeasured`), HOST_SHELL_EVIDENCE is empty,
// and no host is decided. A decided form is still not written until the installer has a writer for it (WINDOWS_FORM_WRITER_WIRED).
//
// FORM_MATRIX[form][shell] is what the windows-latest probe (ci/win26-nh-run.cjs, folded by ci/win26-nh-fold.cjs) measured for a
// pre-action entry:
//   works       the hook runs and its answer (0, 1, 2) arrives; node missing, a missing/edited launcher and a runtime that
//               cannot start end in exit 2
//   closed      nothing runs but every end is exit 2 (a bash syntax error): never allows, never usable
//   open        some end is a code the host treats as non-blocking (a PowerShell parse error is 1, a missing program 9009 or 127)
//   unmeasured  no measurement: never usable. A claim is not a measurement; the cells are filled from a CI run and nowhere else.
const WINDOWS_SHELLS = Object.freeze(['cmd', 'bash', 'powershell', 'pwsh']);
const WINDOWS_FORMS = Object.freeze(['cmd', 'bash', 'powershell']);
const MATRIX_VALUES = Object.freeze(['works', 'closed', 'open', 'unmeasured']);
const unmeasuredRow = () => Object.freeze(Object.fromEntries(WINDOWS_SHELLS.map((shell) => [shell, 'unmeasured'])));
const FORM_MATRIX = Object.freeze({
  cmd: unmeasuredRow(),
  bash: unmeasuredRow(),
  powershell: unmeasuredRow(),
});
// Largest cmd.exe-style command line (`cmd.exe /d /s /c "<text>"`) the length rows proved to run, per form and shell; 0 = not
// measured (or the 8190 row did not run).
const zeroRow = () => Object.freeze(Object.fromEntries(WINDOWS_SHELLS.map((shell) => [shell, 0])));
const CELL_LENGTH_BOUND = Object.freeze({
  cmd: zeroRow(),
  bash: zeroRow(),
  powershell: zeroRow(),
});
// The CI run (digits) whose output filled FORM_MATRIX and CELL_LENGTH_BOUND; null while nothing is measured.
const MEASURE_RUN = null;

// Per host, what is KNOWN about the shell that runs its hook command on native Windows. Supplied by the lead from
// in/HOST-SHELL-EVIDENCE.md and recorded here only after the owner's decision. Record shape (all fields required):
//   shells          the Windows hook shells the evidence allows, a non-empty subset of WINDOWS_SHELLS, no repeats
//   selection       'pinned' (a host setting or an exec form pins ONE shell: shells has one entry) or 'fixed-set' (the host's
//                   documented rule picks from `shells` with no input from user setup); 'user-setup' always skips
//   source          'vendor-doc' (URL + quoted sentence + date in `ref`) or 'live-check' (a recorded run on real Windows)
//   ref             the citation, plain text, 1..400 characters
//   ownerAccepted   true only when the owner accepted a vendor-doc record alone; ignored for a live-check
//   deny            how a block arrives on Windows: 'exit2' (what the written forms produce) or 'json' (they cannot: skipped)
//   denyRef         the citation for deny, plain text, 1..400 characters
// Empty today: no evidence is supplied, so every host stays skipped.
const HOST_SHELL_EVIDENCE = Object.freeze({});

const EVIDENCE_KEYS = Object.freeze(['shells', 'selection', 'source', 'ref', 'ownerAccepted', 'deny', 'denyRef']);
const SELECTIONS = Object.freeze(['pinned', 'fixed-set', 'user-setup']);
const SOURCES = Object.freeze(['vendor-doc', 'live-check']);
const DENY_VALUES = Object.freeze(['exit2', 'json']);

// Why a host is not decided (the `reason` of a decision; internal, the public skip text is windowsHookNotice).
const DECISION_STATUSES = Object.freeze(['skipped', 'ready_owner_decision', 'form_decided']);

// marrow-install writes no Windows form yet (src/installer.js has no path to windowsHookCommand): a decided form is not used, so a
// data change alone can never make the installer write the 0.1.73 inline form (over 8191 characters, open in cmd.exe) on win32.
// Wiring a writer is a separate, audited change that flips this with its own tests.
const WINDOWS_FORM_WRITER_WIRED = false;

// The longest cmd.exe-style command line windowsHookCommand can write (its WINDOWS_HOOK_MAX cap, wrapped as `cmd.exe /d /s /c "<text>"`).
function longestCommandLine() {
  const { WINDOWS_HOOK_MAX, windowsCmdLineLength } = require('./mcp-runtime');
  return windowsCmdLineLength('x'.repeat(WINDOWS_HOOK_MAX));
}

const own = (object, key) => object !== null && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key);
const plainText = (value) => typeof value === 'string' && value.length >= 1 && value.length <= 400 && /^[\x20-\x7e]+$/.test(value);

function evidenceProblem(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return 'evidence_invalid';
  const keys = Object.keys(record);
  if (keys.length !== EVIDENCE_KEYS.length || !EVIDENCE_KEYS.every((key) => own(record, key))) return 'evidence_invalid';
  if (!Array.isArray(record.shells) || record.shells.length === 0 || new Set(record.shells).size !== record.shells.length) return 'evidence_invalid';
  if (!record.shells.every((shell) => WINDOWS_SHELLS.includes(shell))) return 'evidence_invalid';
  if (!SELECTIONS.includes(record.selection) || !SOURCES.includes(record.source) || !DENY_VALUES.includes(record.deny)) return 'evidence_invalid';
  if (!plainText(record.ref) || !plainText(record.denyRef) || typeof record.ownerAccepted !== 'boolean') return 'evidence_invalid';
  if (record.selection === 'pinned' && record.shells.length !== 1) return 'evidence_invalid';
  return null;
}

function tablesProblem(tables) {
  if (tables === null || typeof tables !== 'object') return 'tables_invalid';
  const { matrix, bounds, run } = tables;
  if (matrix === null || typeof matrix !== 'object' || bounds === null || typeof bounds !== 'object') return 'tables_invalid';
  for (const form of WINDOWS_FORMS) {
    if (!own(matrix, form)) return 'tables_invalid';
    for (const shell of WINDOWS_SHELLS) if (!own(matrix[form], shell) || !MATRIX_VALUES.includes(matrix[form][shell])) return 'tables_invalid';
  }
  for (const form of WINDOWS_FORMS) {
    if (!own(bounds, form)) return 'tables_invalid';
    for (const shell of WINDOWS_SHELLS) if (!own(bounds[form], shell) || !Number.isInteger(bounds[form][shell]) || bounds[form][shell] < 0) return 'tables_invalid';
  }
  if (run !== null && !(typeof run === 'string' && /^[0-9]{6,20}$/.test(run))) return 'tables_invalid';
  return null;
}

// The decision for one host from its facts and the tables. Fail closed at every step: the first missing proof returns skipped.
// `facts` contributes only `client` and `candidate`; nothing in it (a `form`, `evidence`, `shells`, a platform) is read as proof.
function decideHostWith(facts, tables) {
  const skip = (reason) => Object.freeze({ form: null, status: 'skipped', reason });
  if (facts === null || typeof facts !== 'object' || tables === null || typeof tables !== 'object') return skip('facts_invalid');
  if (facts.candidate !== 'plain') return skip('no_short_entry');
  if (tablesProblem(tables)) return skip('tables_invalid');
  const evidence = typeof facts.client === 'string' && own(tables.evidence, facts.client) ? tables.evidence[facts.client] : undefined;
  if (evidence === undefined) return skip('no_host_shell_evidence');
  const problem = evidenceProblem(evidence);
  if (problem) return skip(problem);
  if (evidence.selection === 'user-setup') return skip('shell_chosen_by_user_setup');
  if (evidence.deny !== 'exit2') return skip('deny_path_unproven');
  const working = WINDOWS_FORMS.filter((name) => evidence.shells.every((shell) => tables.matrix[name][shell] === 'works'));
  if (working.length === 0) return skip('no_form_works_in_every_shell');
  const needed = longestCommandLine();
  const form = working.find((name) => evidence.shells.every((shell) => tables.bounds[name][shell] >= needed));
  if (form === undefined) return skip('length_bound_unproven');
  if (tables.run === null) return skip('measurement_run_unrecorded');
  if (evidence.source === 'vendor-doc' && evidence.ownerAccepted !== true) return Object.freeze({ form: null, status: 'ready_owner_decision', reason: 'vendor_doc_needs_owner_decision' });
  return Object.freeze({ form, status: 'form_decided', reason: 'proven' });
}

const DEFAULT_TABLES = Object.freeze({ matrix: FORM_MATRIX, bounds: CELL_LENGTH_BOUND, run: MEASURE_RUN, evidence: HOST_SHELL_EVIDENCE });

// Marrow does not trust the shell a host "probably" uses: HOST_SHELL_EVIDENCE decides it, and a host with no record counts as
// unknown. candidate: the shape of the host's hook entries: `plain` is one `marrow-mcp <entrypoint>` command (the short forms can
// carry it); `guard` (a node script that spawns the entrypoint), `wrapper` (an `sh -c` script) and `script` (a hook file) have no
// short Windows form, so those hosts need a short entry before evidence can matter.
const HOST_FACTS = [
  { client: 'claude-code', host: 'Claude Code', label: 'Claude Code MCP passive hooks', detected: 'claudeCode', path: 'claudeSettings', candidate: 'plain' },
  { client: 'codex', host: 'Codex', label: 'Codex native hooks', detected: 'codex', path: 'codexHooks', candidate: 'plain' },
  { client: 'cursor', host: 'Cursor', label: 'Cursor native hooks', detected: 'cursor', path: 'cursorHooks', candidate: 'guard' },
  { client: 'cline', host: 'Cline', label: 'Cline native hooks', detected: 'cline', path: 'clinePreToolUseHook', candidate: 'script' },
  { client: 'windsurf', host: 'Windsurf', label: 'Windsurf native hooks', detected: 'windsurf', path: 'windsurfHooks', candidate: 'wrapper' },
  { client: 'gemini', host: 'Gemini CLI', label: 'Gemini CLI native hooks', detected: 'gemini', path: 'geminiSettings', candidate: 'wrapper' },
];

// The decision with the module's own tables. A caller cannot pass tables here: only the frozen constants above are consulted.
function decideHost(facts) {
  return decideHostWith(facts, DEFAULT_TABLES);
}

// The form a host gets, or null (the L-1 skip).
function decideForm(facts) {
  return decideHost(facts).form;
}

// Whether the installer skips a decided entry: a null form always, and every form while no writer is wired.
function hostSkipped(entry, writerWired = WINDOWS_FORM_WRITER_WIRED) {
  return entry.form === null || writerWired !== true;
}

const WINDOWS_HOOK_HOSTS = Object.freeze(HOST_FACTS.map((entry) => {
  const decision = decideHost(entry);
  return Object.freeze({
    ...entry,
    shells: SHELLS,
    form: decision.form,
    status: decision.status,
    reason: decision.reason,
  });
}));

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
  return entry && hostSkipped(entry) ? entry : null;
}

// Whether the native hook write for one detected host is skipped (buildPlan, reload plan, first capture).
function windowsHookWriteSkipped(detection, client) {
  return Boolean(windowsHookHost(detection, client));
}

// What a skipped host is reported as (plan, install report, doctor). Never `configured`.
function windowsHookSkipEntries(detection) {
  if (!windowsHooksSkipped(detection)) return [];
  return WINDOWS_HOOK_HOSTS.filter((entry) => hostSkipped(entry) && detection[entry.detected]).map((entry) => ({
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
  CELL_LENGTH_BOUND,
  DECISION_STATUSES,
  FORM_MATRIX,
  HOST_SHELL_EVIDENCE,
  MEASURE_RUN,
  WINDOWS_FORMS,
  WINDOWS_FORM_WRITER_WIRED,
  WINDOWS_HOOK_HOSTS,
  WINDOWS_SHELLS,
  WINDOWS_HOOK_SKIP_REASON,
  WINDOWS_PLUGIN_ROUTE,
  decideForm,
  decideHost,
  decideHostWith,
  hostSkipped,
  longestCommandLine,
  windowsHookHost,
  windowsHookNotice,
  windowsHookSkipEntries,
  windowsHookWriteSkipped,
  windowsHooksSkipped,
};

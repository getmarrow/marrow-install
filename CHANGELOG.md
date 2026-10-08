# Changelog

Release notes for `@getmarrow/install`, newest first. The README keeps only the notes for the current version; older notes live here as they were written at the time. Package integrity values are public npm registry metadata.

## Unreleased (the version is not bumped yet)

- **Approvals in chat and terminal.** With MCP `3.9.99` or later, install and update add the approval hooks for Claude Code (`PermissionRequest`, `PostToolBatch`), Cursor (shell and MCP execution hooks with `failClosed` and a 15-second timeout, `sessionStart`, `beforeSubmitPrompt`; MCP calls stay gated in `preToolUse` for cloud agents, and Marrow's own tools pass a small guard at once) and Gemini CLI (`BeforeAgent`); Codex keeps its prompt hook. With MCP `3.9.98` the earlier layout stays as it was.
- **Governed runner holds.** A held `run` asks the operator once at an interactive terminal. With nobody present (no terminal, `CI`, `--no-interactive`, or an agent's own terminal) it holds quietly and sends nothing, unless Marrow says the owner's one-tap link would be sent (owner-locked categories, arbitration, the owner's decline on request, or unattended pings the owner turned on). Reruns of the same command pick the hold up on the same gate receipt, with no new email; an approval that arrived later runs once. The hold is recorded before any wait, so Ctrl+C or a kill stops only the wait (exit 12). Declines stand for 30 minutes. Arbitration asks the owner by one-tap link and runs only on a permit for this exact action; arbitration links tell the service `person_present: true` only when a person at this terminal runs it, and a live link is waited on instead of sent again. `--owner-approved` no longer does anything.
- **Local policy.** `--policy warn|audit` (and `MARROW_GOVERN_POLICY`) no longer loosen a gate Marrow enforces; only a gate Marrow marks advisory runs with a warning.
- **Day one.** A first install stores a key from `MARROW_API_KEY` in the owner-only `~/.marrow/env` once the self-test shows it works, so Claude Code opened from the desktop app, an IDE or a new terminal finds it; the runner reads it too, and without a key says "Marrow can't find your key: run `npx @getmarrow/install` once in this machine's terminal." Claude Code is detected from your installation as well as the project, and the restart line names the host. Only detected hosts get files: no `AGENTS.md` or SDK files in a Claude-Code-only repository, and no SDK advice without SDK use. "Healthy" is no longer followed by agent-identity homework.
- **Local MCP runtime.** Hooks start a verified local copy of the pinned MCP from `~/.marrow/runtime/mcp/<version>/` instead of `npx` (about 0.1 second per gated call instead of 0.7 to 1.3), falling back to `npx` when the copy is missing or changed. `update` refreshes it and removes older versions; `uninstall` removes it; `MARROW_LOCAL_RUNTIME=0` or `--no-local-runtime` keeps hooks on `npx`.
- **Uninstall.** `npx @getmarrow/install uninstall --yes` removes only Marrow's entries and the local MCP runtime.
- **Pins.** The MCP and SDK pins live in `src/pins.js`. The SDK pin moves to `3.7.65`.
- **Cline upgrades.** Marrow-written Cline hook files move to a new MCP pin instead of being reported as owner conflicts.

## v0.1.67

v0.1.67 installs MCP `3.9.98` (source `e40d3cb40479456fd937bce0b9488eb0c3f10863`, packed integrity `sha512-AmDT3afwdm7+Dc555zDs+yGIG4RyC/YbaQm+9O1mThlC6g/9EujTr7y7UvRMEtYDvVWAAaG6CFM7/u/ytjKhwQ==`), which makes `npx @getmarrow/mcp ...` commands work again. SDK `3.7.64` and everything else are unchanged.

## v0.1.66

v0.1.66 keeps MCP `3.9.97` (source `be607e1dffd4d9e6a3c40f01151e509c115fba3f`, packed integrity `sha512-wab1kvgec8WhDDrpkajauLu2QdADXudIxkic0BAgzV96FZVHY0ME45hrOyQmqfkI+OtKriYdgIFp90peWGh2mA==`) and SDK `3.7.64` unchanged. It fixes the governed runner's gate and permit path, makes updating one command, and removes internal publishing tooling from the public package.

### Update: one command

```bash
MARROW_API_KEY=mrw_live_... npx -y @getmarrow/install@latest update
```

First install is the same command without `update`. On its own, the command now:

- restarts a running controller that a different installer version started, so `controller stop` and `controller ensure` are no longer separate steps. Local control stays enabled or disabled as the owner left it;
- detects Hermes from `~/.hermes/config.yaml` (or `$HERMES_HOME`) or `hermes` on `PATH`, and adds or refreshes `mcp_servers.marrow` with the pinned MCP server and `MARROW_CLIENT: hermes`. The rest of the file, comments included, is kept. No copy of the file is made, because it holds other servers' credentials; the private log lists only the `mcp_servers.marrow` lines added or replaced, with values redacted, as undo steps. The edit is verified before it is written. If the file cannot be edited safely, or the existing `marrow` entry has a custom command or custom arguments, it is left untouched and the exact block to add is printed;
- needs no `MARROW_AGENT_ID`: Marrow uses the API key's bound agent or the plan's agent seat. `MARROW_AGENT_ID` still overrides;
- runs the self-test and prints a short summary: healthy with the committed decision id, or the failure (including a decision recorded without trusted closure) and one fix command, with a non-zero exit. The full report goes to `~/.marrow/logs/` (mode 600); `--verbose` prints it instead;
- reads the key from `MARROW_API_KEY`, or from the owner-only `~/.marrow/env.local` or `~/.marrow/env`, and names the file it used. It warns when those two files hold different keys. With no key it prints the command to run and stops before writing anything.

Restart the owning harness afterwards so new hooks and MCP configuration load; restart Hermes if its config changed.

### Fixes

- **Governed runner gate and permits.** `gate`, `run` and `permit` read Marrow's real gate decision. Previously the runtime's default package response lacked the fields the runner read, so `gate` printed `unknown`, and every protected `run` sent an empty gate receipt, got HTTP 400 and exited 13.
  - `gate` now prints the decision with its mode (enforced or advisory), and exits 12 when an enforced gate blocks or needs owner approval. It used to exit 0.
  - A protected `run` passes the gate receipt to permit issue and closes the runtime's own decision instead of opening a second one.
- **Advisory plans.** Where the plan's gate is advisory (`enforced: false`), a protected `run` shows the warning, runs the command and records the outcome; it no longer asks for a permit the plan cannot issue. Enforced plans keep the permit requirement.
- **Retries and time limits.** The runner's runtime, think and commit calls, and the self-test's runtime and first-value calls, retry HTTP 429/502/503/504, timed-out attempts and pending answers up to three times with the same `Idempotency-Key`. Each attempt has a 10-second limit, and all attempts share a 25-second deadline. Every `run`, `gate` and `permit` uses fresh keys, so a later command in the same session is never answered with an earlier command's stored result. Client errors are not retried.
- **Self-test cleanup.** The self-test closes the decision its runtime check creates, instead of leaving it open.
- **Claude Code hook identity.** Claude Code hooks use the Claude-specific entrypoints (`claude-pre-action-hook`, `claude-hook`, `claude-context-hook`, `claude-session-hook`), the same spelling `marrow-mcp setup` writes. Hook activity is labelled `claude-code` instead of the generic `mcp-client`, and the installer and MCP setup no longer rewrite each other's entries. Existing entries are migrated in place without duplicates.
- **Agent identity.** No generated `<client>-<hash>` agent id is sent or written to MCP configuration or the SDK preload; one written by an earlier version is removed from `.mcp.json`. With an unbound key, activation reports that no single agent can be confirmed and how to bind one, instead of failing the install.
- **`run -- -- <command>`.** The documented form now runs the command; one `--` is enough.
- **Codex detection.** An `AGENTS.md` that holds only the Marrow block no longer marks a project as Codex.
- **Controller maintenance.** The five-minute maintenance pass re-applies the controller's own agent id and base URL instead of the generated id and default URL. A different value found in managed MCP configuration is reset and reported as needing attention, unless the owner allowlisted it.
- **`proof`.** `proof --decision-id` works again: the shared option parser had rejected it. It exits non-zero unless Marrow returns `committed: true`, and accepts `--gate-receipt` and `--session` for decisions created by `gate`.
- **Controller commands.** `controller ensure|stop|status` act on the controller that install and update started.
- **Removed.** `--repair` and `update` no longer read an npm token from `~/.openclaw` or write `~/.npmrc`; that was internal publishing tooling. Two internal credential-file hints were removed with it. Installer output no longer suggests invented agent ids such as `--agent hermes-prod`.

Plan semantics are unchanged: where a plan's gate is advisory, it stays advisory.

## v0.1.65

v0.1.65 pins MCP `3.9.97` (source `be607e1dffd4d9e6a3c40f01151e509c115fba3f`, packed integrity `sha512-wab1kvgec8WhDDrpkajauLu2QdADXudIxkic0BAgzV96FZVHY0ME45hrOyQmqfkI+OtKriYdgIFp90peWGh2mA==`) while keeping SDK `3.7.64` unchanged. Changes:

- `doctor` no longer reports hooks as missing after a harness re-saves its settings file.
- `update` refuses to write into an unrelated folder and only touches Marrow-managed roots.
- The install self-test handles pending decisions and never commits one as a success.
- Controller reporting is clearer; a disabled controller stays quiet while exact fixes for non-benign states are still shown.
- Enforcement heartbeats back off after repeated failures and retry once an hour.
- The agent id is never derived from the OS username.
- Permit verification sends `protocol_version`.
- The test suite is isolated from the real HOME and Marrow credentials.

Restart the owning harness, review hook trust and run `doctor --self-test` after updating.

## v0.1.64

v0.1.64 pins MCP `3.9.96` (source `031c944936271fd6e8768ad2619ee0430b68e2c7`, packed integrity `sha512-kuBpuWaWAvusS+FbXXFw1fOEGja4T8ahj/vkmXTd/CWjz0t6teT6g9c1HfJhAK6KLzesZtcvUdZLn6pBErKP9Q==`) while keeping SDK `3.7.64` unchanged. The embedded MCP pin requires this installer patch to deliver the native pre-action hook permit fix: protected actions are no longer denied after an allowing runtime gate, and unprotected actions stop at the gate without creating a decision or permit. Policy decisions, proof requirements and fail-closed behavior are unchanged. `activate` and `doctor --self-test` now resend the identical self-test decision and commit with a stable `Idempotency-Key` after a transient 429/502/503/504 or a durable pending acknowledgement (at most three attempts, about one second apart), instead of failing with "self-test did not return decision_id"; client errors still fail immediately, and a final failure names the last state. Restart the owning harness, review hook trust and run `doctor --self-test` after updating.

## v0.1.63

v0.1.63 pins MCP `3.9.95` (source `967b17735b26534b7dc0536ec93c481a5dc07297`, packed integrity `sha512-Sw8RIyxHkjxllwwh+9za5ItoM9X0NwN4R8+Qdd7nvOuU6qAm9LotIC09GOJDim3o9jc9m8yTqxKciroRTS12EQ==`) while keeping SDK `3.7.64` unchanged. The embedded MCP pin requires this installer patch to deliver the stdin usage-loss correction and safe bounded native Codex capture. Supported transcript schema is Codex `0.157.1`; capture covers only the latest proven model-call delta. Unknown versions, missing model/turn or billing metadata, unsafe paths and unproven subagent bindings remain incomplete or unpriced. Capture does not prove a baseline, complete overhead or savings. Restart the owning harness and run `doctor --self-test` after updating.

## v0.1.62

v0.1.62 delivers the model-cost capture corrections in MCP `3.9.94` (source `9456bc63de4cc92f16726d996695516be9395f26`, packed integrity `sha512-gEQejUWkcuKd1p930TLsWCSMM4rjmr/Wzz0++qa69B6hj/e64lMdT9xO+jZP8+yl4WLKgcfo0raHANllUe96/A==`) and SDK `3.7.64` (source `40b68dee609e9351fa6c79aee629fc88869a3b4f`, packed integrity `sha512-8qJj/8ouHEz1NnZkmujtFxUm/fWldqR/rHv62/sqabaxT0H90xCCHxodLOkV0SVxDscAtnahioZakqkeGNUwyA==`). Published installer0.1.61 pins older bytes and cannot deliver these fixes. Only observed usage with sufficient host, model, token and pricing evidence becomes calculated cost; unobservable host usage, unsupported streams and mixed cache TTL writes stay incomplete. No baseline or net savings is invented. Update once, restart the owning harness and run `doctor --self-test` to verify actual active versions.

## v0.1.61

v0.1.61 pins MCP `3.9.93` from source `2174aa09c9bba2f38a15bef4d8020803d6d36073` with packed integrity `sha512-X3ccZUKJqQxiEWq5jJE3xQzcBZbMxEcYxIuU0aKNNo5U1iji9N99pPa2Awm0fdZaRzYOYtdVbWrAmfPDvuYaKQ==`. This corrects the full11 canary operation identity so valid numeric UUIDs reach Auto and terminal outcome closure without weakening privacy validation. SDK remains `3.7.63`. The published `0.1.60` installer cannot deliver this pin. Update once, restart the owning harness, then run `doctor --self-test` before relying on the new client.

## v0.1.60

v0.1.60 pins MCP `3.9.92` from source `d0d97d1b584c661d9a72696de7af02566fb317e3` with packed integrity `sha512-CAVbzDFanzI/b9EPennC1dUr8/Qq8wMiIl71/25puAfuW7CPSZ+qkhmMDIEnP50k3EgZHEdJo3sUTOJ1P7dzwA==`. This delivers the MCP reliability fix that keeps response-body reads inside the existing request deadline, preserves cancellation, and reports bounded, sanitized control-path errors. SDK remains `3.7.63`. The `0.1.59` installer cannot deliver this pin. Update once, restart the owning harness, then run `doctor --self-test` before relying on the new client.

## v0.1.59

v0.1.59 pins published MCP `3.9.91` from source `96b58c9e5ec0356d5672edbb89275e3fbb6d3233` with packed integrity `sha512-2xbKhq1LQ2TlOM4XBpoLcBQNS1fnjxZFbSFwC/lwCUppU1M5NQ6fFCxcLrvHTNt0FM16WlVzxUDBtG8OzoFbuA==`. SDK remains `3.7.63`. This stops a later install from rewriting managed hooks back to MCP `3.9.89`. Restart the owning harness after update before relying on the new pin. The published `0.1.58` installer cannot deliver this pin.

## v0.1.58

v0.1.58 pins MCP `3.9.89` from source `ff229e17419f65aeebd7fa7754dd61cbda61900d` with packed integrity `sha512-KC/P4dStzOOfZKxSwigQE4TWCt1TBgYINQzlXrnA5jpYHRrT2Jo73vaV4FiucVPOT+xyU1uCci+bmJoC35aZ0g==`; SDK remains `3.7.63`. Supported native hooks now include their host read, search, and status surfaces so MCP's private local session loop guard can stop unchanged successful checks, polls, and failed retries without adding routine backend writes. Install and update run `marrow-mcp loop-guard-self-test` against isolated temporary state and report configuration, isolated proof, and live host observation separately. Missing local control state stays enabled by default; an explicit owner disable is preserved byte-for-byte and prevents the controller from starting. Grok's trusted global hook file is created only at its direct owner-safe path, managed files are reconciled, and unmanaged files are preserved for owner review. Restart and complete each host's hook trust or review flow before relying on live enforcement.

## v0.1.57

v0.1.57 pins the npm-verified MCP `3.9.88` and SDK `3.7.63` packages. Doctor now recognizes an installed and lockfile-verified SDK `3.7.63` instead of suggesting `3.7.62`. If a workspace has a newer stable SDK version, doctor preserves it and asks for official registry verification before replacement. The generated MCP setup, hooks, and update instructions target `3.9.88`; restart the owning harness and run `npx @getmarrow/install@latest doctor --self-test` after activation.

## v0.1.56

v0.1.56 pins the officially verified MCP `3.9.80` release from source `ee1eda3f201965a6530256accbdf175660dd8ad6` with registry integrity `sha512-uou3X18pESV39EMmddDrYN7yd6MrZzosrnQ1eRtvK5j3yuBLAlupj5kQVrrKEWAL6xwuLebXq2isivK2O/2WrA==`; SDK remains `3.7.62`. Doctor now directs stale, mixed, or version-unknown MCP installations through one `npx -y @getmarrow/install@latest update`, followed by one owning-harness restart and one `doctor --self-test` verification. The update resolves one official target and applies it consistently across detected Marrow-managed instructions, MCP launch configuration, and supported native hooks without claiming that already-running processes changed.

## v0.1.55

v0.1.55 pins sealed MCP candidate `3.9.79` from source `11f00049043d0aba90704ecbf69f32d2278a4573` for ordinary setup, generated launch configuration, and native hooks. Doctor, update, and repair retain exact-version resolution and never propagate a newer local version unless official registry metadata verifies it; offline operation preserves unverified-ahead owner surfaces and uses the sealed candidate for new managed targets.

## v0.1.54

v0.1.54 pins sealed MCP candidate `3.9.77` from source `1e782d8ba6bbb54bfaa322f0300565c7176f1969` and makes ordinary setup use the primary tool surface without writing a profile variable. Explicit `core` and `full` selections remain preserved, invalid values fail closed with a bounded repair, and human/JSON self-test output distinguishes configured/effective profile, expected visibility, actual post-reload visibility, and backend-projected entitlement state. Backend projections are status evidence only and always report `authorizes_calls: false`.

## v0.1.53

v0.1.53 pins the native-gate MCP candidate `3.9.75` and reconciles only Marrow-owned native hook surfaces. Codex uses `.codex/hooks.json`; Cursor and Composer use `.cursor/hooks.json`; Cline uses bounded executables under `.clinerules/hooks/`; Windsurf uses `.windsurf/hooks.json`; Gemini CLI receives named BeforeTool, AfterTool, and AfterAgent groups in `.gemini/settings.json`; Grok receives trusted global hooks in `~/.grok/hooks/marrow.json`. Grok PreToolUse validates strict private allow/deny JSON and fails closed with exit `2` when the child cannot provide an exact decision; PostToolUse/PostToolUseFailure emit compact results; one nonblocking Stop hook closes the turn with no duplicate SessionEnd hook. Grok hooks remain user-toggleable, so restart plus `/hooks` inspection is required and configuration never proves observed coverage.

The integration boundary is explicit: native hooks remain cooperative/client-reported until authoritative server receipts exist; MCP tools are on demand; Codex requires restart plus owner `/hooks` trust review; Windsurf requires restart, workspace trust review, and Restricted Mode to be off; Gemini CLI requires restart and `/hooks panel` fingerprint review/approval, with `/hooks enable-all` reserved for an explicitly disabled configuration after owner review; Grok requires restart and `/hooks` inspection because its trusted global hooks remain user-toggleable; the governed wrapper remains an explicit bounded fallback; owned Node processes use the SDK passive runtime while installed; and custom hosts require a bounded event adapter. Exact package SHA/integrity can prove artifact provenance, not runtime coverage.

## v0.1.52

v0.1.52 keeps MCP `3.9.74` and SDK `3.7.62`, and makes generated passive runtime identity follow the current process: `MARROW_FLEET_AGENT_ID` first, then `MARROW_AGENT_ID`, with the installer-captured identity retained only as a fallback. This prevents a stale installed harness identity from overriding the current Codex, Bob, or other canonical process identity. Managed MCP config does not store an API key or shell-style credential placeholder; the owning harness inherits the key from trusted environment or secret-manager state.

The integration boundary is explicit: native Claude hooks are installed only where supported and remain cooperative/client-reported until authoritative server receipts exist; MCP tools are on demand; Codex, Grok, Gemini, and similar CLIs use the governed wrapper for consequential control; owned Node processes use the SDK passive runtime while installed; and custom hosts require a bounded event adapter. Exact package SHA/integrity can prove artifact provenance, not runtime coverage. Activation-profile delivery is authenticated `client_self_reported` telemetry with `certified_coverage: false`; it acknowledges delivery but cannot attest that a hook, wrapper, or adapter ran.

## v0.1.48

v0.1.48 pinned MCP `3.9.72` and SDK `3.7.61`. The SDK kept passive capture enabled without intercepting its own Marrow control-plane requests, while every generated MCP setup and repair command used the supported MCP release.

## v0.1.47

v0.1.47 makes activate honest about reload and the first capture path:

- after writing MCP or hooks, activate reports that this process is not live until harness restart and `doctor --self-test`;
- first capture is Claude native hooks, Cursor on-demand `marrow_agent_runtime`, or the Codex/Grok governed runner;
- generated MCP setup, launch, and certified hook commands pin the release current at that time;
- SDK detection and operator-approved upgrade rules pinned the release current at that time;
- empty token savings stay zero until observed model usage lands.

## v0.1.46

v0.1.46 makes default install cover every workspace honestly:

- auto mode now writes MCP plus agent instructions in every project, and the SDK passive runtime whenever Node is present;
- Claude native hooks still install only when `.claude` is present; detected Cursor workspaces get `.cursor/hooks.json` plus `.cursor/mcp.json`, and Composer uses that same Cursor-native lifecycle path;
- Hermes, OpenClaw, and custom hosts stay event-contract only and are not claimed as native interception;
- generated MCP setup, launch, and certified hook commands pin current MCP `3.9.64` from source `ed8293165247e89161045c7fbf68aeee4d51c6da`;
- SDK detection and operator-approved upgrade rules pin exact public `3.7.59`;
- empty token savings stay zero until observed model usage lands.

## v0.1.45

v0.1.45 pins the one-command setup path to the published receipt-safe MCP release:

- generated MCP setup, launch, and certified hook commands pin current MCP `3.9.62`;
- adapter provenance records exact MCP source `c025d720af8fe9b16702ba764ff85c822adc2a26` and the live public registry integrity;
- MCP versions older than `3.9.62` are treated as stale so new installs receive the fail-closed runtime authorization contract;
- `npx @getmarrow/install@latest update` is the owner-approved one-command refresh of certified install/SDK/MCP pins; doctor and status print an owner notice so agents can tell the user to update;
- self-test and governed-runner requests report install, SDK, and MCP versions together so the API can notify on any stale package;
- SDK `3.7.56` detection and operator-approved upgrade rules are unchanged.

## v0.1.44

v0.1.44 restores exact package-chain detection and current MCP setup truth:

- exact declared, locked, and installed SDK `3.7.56` dependencies are recognized using the live public registry integrity;
- generated MCP setup, launch, and certified hook commands pin current MCP `3.9.61`;
- the installer exposes the certified MCP source SHA and public registry integrity in its programmatic adapter provenance without changing credentials, policy, or unrelated configuration;
- regression coverage rejects stale SDK lock integrity and treats MCP versions older than `3.9.61` as stale.

## v0.1.43

v0.1.43 hardens the MCP control path and makes stale client recovery explicit:

- `doctor` detects active and configured stale, mixed, or version-unknown Marrow MCP clients without exposing command lines, file paths, configuration contents, or credentials;
- every generated MCP launch and hook uses the package-explicit `npx --package ... marrow-mcp` form so npm can resolve the executable reliably;
- when repair is needed, `doctor` reports the pinned setup command, the separate owning-harness restart requirement, and a self-test verification command; it does not terminate harness processes itself;
- certified hooks pinned MCP `3.9.59` and SDK `3.7.56` so the installed runtime matched that release's advertised control contract;
- existing harnesses retain their honest coverage level: native hooks where supported, MCP calls where available, and governed wrappers or event contracts elsewhere;
- package upgrades remain operator-approved and never rotate keys or rewrite unrelated configuration.

## v0.1.42

v0.1.42 added deterministic active-process detection, including direct `node_modules/.bin/marrow-mcp` launches, while keeping repair operator-approved.

## v0.1.40

v0.1.40 binds governed runs to a privacy-safe workspace fingerprint and separates observed execution from verified completion:

- ordinary prompts receive one compact context read; risky or mutating prompts receive one fresh runtime gate instead;
- passive prompt telemetry is buffered locally rather than delaying the agent turn;
- transient read failures can use clearly labeled owner-only last-known guidance, while authentication failures never use cache;
- `doctor` prints the exact `npx -y --package=@getmarrow/mcp@latest marrow-mcp ping` command for measured current/p50/p99 latency, last success, and backlog health;
- certified hook commands pin MCP `3.9.56` and SDK `3.7.55` so advertised behavior matches that release's deployed server contract;
- governed runtime requests attach a stable privacy-safe project fingerprint and harness label without sending the raw working-directory path;
- successful command exit remains observed execution, not verified business completion, unless a verification command or explicit proof file supplies evidence;
- the integration matrix now reports prompt injection, pre-action, action result, closure, proof, cached brief, restart survival, evidence adapter, and safe repair separately.

It preserves the intervention receipts introduced in v0.1.38.

## v0.1.38

v0.1.38 makes a meaningful Marrow intervention visible without adding manual work to routine agent sessions:

- generated instructions tell agents to retrieve and relay one factual intervention receipt after Marrow changes consequential work;
- Fleet Reports surface the same receipt for owners, including the required workflow, proof status, permit follow-through, and recorded outcome;
- agents remain quiet for routine low-risk work, and receipts exclude raw context, raw outcomes, proof values, credentials, and cross-tenant data.

It preserves the automatic local control lifecycle introduced in v0.1.37.

## v0.1.37

v0.1.37 adds the automatic local control lifecycle after explicit owner activation:

- a project-and-agent-scoped loopback controller survives individual agent sessions;
- installer-managed hooks are checked and safely restored without changing unrelated files;
- the governed runner automatically classifies consequential commands and requires fresh signed permits for protected actions;
- pre-action, execution, result, proof, and outcome receipts share stable correlation;
- integration coverage states exactly what is native, MCP-routed, governed-wrapper controlled, or adapter-required;
- in-session value messages use measured evidence only and report unavailable data instead of synthetic savings.

It preserves the update and permit controls introduced in v0.1.36.

## v0.1.36

v0.1.36 combines guided, operator-controlled client updates with a signed permit boundary for protected actions. Installer status, activation reports, and the Fleet Operator expose request-specific update advisories with exact update and verification commands while keeping local mutation explicit:

- official installer requests identify the installed `@getmarrow/install` version;
- status, self-test, and Fleet Operator output show recommended, unrecognized, and security-required update states without conflating them;
- generated agent instructions tell the agent to notify the operator and obey local change policy;
- certified activation pins the matching MCP and SDK releases, including exact SDK registry integrity;
- `activate`, `doctor`, and `--repair` remain explicit commands and preserve unrelated hooks and configuration.

The governed runner makes protected actions executable only through a short-lived, signed Marrow permit bound to the exact account, agent, session, action, target, canonical action surfaces, runtime gate, and decision before starting the child process. It then closes that permit with exact evidence and the real outcome:

- deploy, publish, merge, migration, credential, and other protected work fails closed when its permit cannot be verified;
- the child process receives only the scoped permit, never the Marrow API key through a new broker interface;
- permits are single-use, expire within minutes, and cannot be replayed for another agent, action, target, or session;
- `permit` and `verify-permit` provide deterministic CI choke points;
- the loopback `sidecar` keeps private state owner-only and reports hook/configuration drift;
- `coverage` reports permit closure, bypasses, stale sidecars, and hook health with exact repair steps;
- correlated result hooks can close evidence automatically, while incomplete protected work remains visible;
- controlled break-glass access requires an authenticated account owner, a current runtime gate, a reason, a short expiry, and evidence closure.

It preserves the measurable passive-governance coverage introduced in v0.1.34:

- Claude Code installation includes exact `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, and `Stop` hooks;
- matching pre-action/result receipts use one tool correlation, and activation fingerprints the exact hook contract without uploading configuration contents;
- the capability registry distinguishes native hooks, MCP, SDK passive runtime, governed wrappers, and custom event contracts;
- `activate` fails when the local integration is incomplete or the server does not accept the exact activation profile;
- `doctor` and `--repair` use the same configuration evidence without exposing configuration contents;
- the harness certification suite prevents support claims from overstating what is automatic;
- unavailable coverage remains “insufficient data” instead of a synthetic percentage.

It preserves agent-disagreement visibility from v0.1.33 and the server-confirmed first-run self-test introduced in v0.1.29:

- GitHub and npm now advertise separate signed discovery placements;
- package metadata identifies the installer as agent governance rather than a general memory utility;
- the README tells agents and operators when to use the installer and what public discovery will not collect;
- bounded positive and negative recommendation criteria stop agents from forcing Marrow into irrelevant workflows;
- current evidence, integration paths, and published references are linked from one review-dated contract;
- `npx @getmarrow/install activate` detects the current harness, writes supported passive controls, creates and closes a harmless decision, and asks Marrow to verify that exact outcome;
- activation succeeds only when the API returns a tenant-scoped receipt bound to the exact test decision, agent, runtime gate, and closed successful outcome;
- that receipt verifies only the install self-test; activation returns `activation_scope: server_self_test_only`, `coverage_verified: false`, `passive_live: false`, and `reload_required: true`;
- existing setup, governed runner, and TUI commands remain compatible.

Use `activate` when you want one command with an explicit success contract. Use `--yes` when an existing automation already handles setup prompts and verification output.

```bash
npx @getmarrow/install activate
```

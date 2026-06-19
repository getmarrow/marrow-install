# @getmarrow/install

Universal installer for Marrow passive agent setup.

Use it when you want Marrow to detect the local agent/runtime environment and wire the safest passive integration automatically.

```bash
npx @getmarrow/install --dry-run
npx @getmarrow/install --yes
npx @getmarrow/install --repair
npx @getmarrow/install doctor
```

## What's New in v0.1.16

v0.1.16 expands the Govern TUI harness addon coverage while preserving adaptive mode recommendations.

- `npx @getmarrow/install govern` now shows first-class rows for Codex, Claude Code, Cursor, Gemini CLI, Grok CLI, DeepSeek CLI, Hermes, GLM CLI, Qwen CLI, OpenCode, OpenClaw, MCP-compatible clients, CI scripts, and custom commands.
- Marrow remains a thin governance layer. It does not replace your model or harness; it wraps the command your agent already runs with pre-action risk gates, proof requirements, and automatic outcome closure.
- Detection stays recommendation-first. Marrow uses local config, instruction, CI, and MCP markers to suggest the safest path, then the user or owner accepts, overrides, or saves a policy profile.
- If a harness is not detected yet, use **Custom command** or `npx @getmarrow/install run -- <your-agent-command>` to govern it immediately.

Business value: teams can add Marrow to the agent stack they already use instead of migrating to a new agent host. Codex, Claude Code, Cursor, Gemini, Grok, DeepSeek, Hermes, GLM, Qwen, OpenClaw, OpenCode, MCP clients, and CI scripts can all be brought under the same governance loop.

## What's New in v0.1.14

v0.1.14 adds adaptive governance mode recommendations without silent auto-switching.

- `npx @getmarrow/install govern` now detects project signals such as `package.json`, deploy/publish scripts, platform config files, GitHub workflows, migrations, Cursor/Codex/Claude files, and MCP config.
- When `MARROW_API_KEY` is present, the TUI asks Marrow for a recommended mode: `passive`, `pilot`, or `enforce`.
- The TUI shows the exact reasons, confidence, and selected command before the user applies anything.
- User choice is explicit. Marrow logs whether the recommendation was accepted or overridden, but it does not silently switch modes.
- Policy profiles are supported by the backend/SDK/MCP so businesses can define rules like local=passive, staging=pilot, production deploys=enforce.

Example recommendation:

```text
Recommended mode: pilot
Reason:
- Node project detected
- Edge service detected
- GitHub workflow detected
- No owner approval policy configured yet
```

## What's New in v0.1.13

v0.1.13 turns `npx @getmarrow/install govern` into an interactive terminal setup flow when run in a real TTY.

- Select Codex, Claude Code, Cursor, OpenCode, OpenClaw, CI scripts, or a custom command with arrow keys.
- Choose passive setup, governed pilot mode, or governed enforce mode.
- Run passive setup + self-test from the TUI after explicit confirmation.
- Check Marrow status and test the before-action gate from the same screen.
- Print the exact command for the selected harness/mode so users know what to run next.
- Exit cleanly with `q`, `Esc`, or `Ctrl+C`.
- CI/non-TTY usage remains stable with `npx @getmarrow/install govern --no-interactive`.

This keeps Marrow passive-first: install once, verify Marrow is active, then let agents use the runtime/gate path automatically for risky work.

## What's New in v0.1.12

v0.1.12 adds the Marrow governed runner for businesses that want agent governance without replacing their existing harness.

- `npx @getmarrow/install govern` prints a setup panel for detected harnesses and recommended protected commands.
- `npx @getmarrow/install run --agent <agent-id> -- <command>` wraps existing agent, deploy, merge, publish, migration, and verification commands with Marrow's pre-action runtime gate.
- Risky actions can fail closed by default when Marrow requires owner approval, blocks an action, or requires missing proof.
- Successful and failed commands automatically close outcomes through `/v1/agent/commit` with a redacted proof pack.
- The runner sends action and command metadata only; it does not upload command stdout, stderr, full environment values, or plaintext API keys.
- This gives teams a thin governance path for Codex, Claude Code, OpenClaw, OpenCode, Cursor, CI scripts, and custom shell-based agents.

Business value: Marrow can sit in front of the commands that matter most, tell the agent what prior lesson or proof is required before action, and produce an audit-ready outcome trail after the command finishes.

### Governed Runner Quickstart

Preview the detected harnesses and protected command examples:

```bash
npx @getmarrow/install govern
```

In a real terminal, this opens the interactive setup flow. In CI or scripts, use:

```bash
npx @getmarrow/install govern --no-interactive
```

Run a harmless command through Marrow:

```bash
MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install run --agent codex-prod --profile production -- node -e "process.exit(0)"
```

Gate a production action before the agent executes it:

```bash
MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install gate "deploy production service after tests pass"
```

Wrap a real deploy, publish, merge, or migration command only after the agent has the required proof:

```bash
MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install run \
  --agent deploy-agent \
  --type deploy \
  --profile production \
  --policy enforce \
  -- npm run deploy
```

Use `--policy warn` for pilot mode and `--fail-open` only for non-production local workflows where Marrow should never block execution.

## What's New in v0.1.10

- First-run output now explains the value in agent/user language: your agent is no longer starting from zero.
- Self-test prints first proof: setup decision captured, outcome closed, runtime gate active, and risky work now gets a pre-action brief.
- Fresh accounts get a guided prompt to try immediately: "I am about to deploy to production. What should I check first?"
- Existing accounts/fleets show stronger proof when available: avoided mistakes, reused winning decisions, prevented risky actions, and token/time savings.
- Generated SDK passive runtime now fails soft if `@getmarrow/sdk` is missing and the installer prints the exact dependency fix.
- Docs now make the universal installer the default path; SDK and MCP are advanced/manual integration paths.

## Which Install Path Should I Use?

Start here unless you already know you need a lower-level integration:

```bash
npx @getmarrow/install --yes
```

The universal installer detects your local agent/runtime environment and wires the safest combination of MCP hooks, SDK passive runtime files, and agent instructions automatically. It also runs the self-test and prints first-run value proof.

Use the lower-level packages only when you need direct control:

- **SDK:** use `@getmarrow/sdk` when you are building a custom Node/TypeScript agent integration or wrapping your own tools, commands, deploys, and publishes in code.
- **MCP:** use `@getmarrow/mcp` when you want manual MCP server/hook setup for Claude Code, Claude Desktop, Cursor, or another MCP-compatible client.

The three packages are not three competing onboarding paths. `@getmarrow/install` is the front door; SDK and MCP are the implementation paths underneath it.

## Agent Value Proof Quickstart

One command should prove Marrow is active and useful:

```bash
MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install --yes
```

Expected result:

- Marrow writes the safest detected MCP/SDK/agent config.
- A harmless setup decision is created and its outcome is committed.
- `/v1/agent/status` confirms capture health and missing hooks.
- `/v1/agent/runtime` verifies the one-call runtime gate and returns the before-action intervention contract.
- `/v1/agent/first-value` returns the five-minute proof payload used by installer, SDK, and MCP clients.
- The installer prints: "Your agent is no longer starting from zero."
- Fresh accounts get a first useful action to try immediately.
- Accounts with history get proof such as avoided mistakes, reused winning decisions, prevented risky actions, or estimated time/token savings.

## First Five-Minute Proof

After install, ask the agent:

```text
I am about to deploy to production. What should I check first?
```

Marrow should answer with `proceed`, `warn`, `block`, or `owner_approval_required`, plus required proof and matching fleet lessons/playbooks before the agent acts. This is the first product moment: not just "hooks installed", but "the agent is being warned before risky work."

## What It Detects

- OpenClaw-style workspaces
- Codex/agent instruction files such as `AGENTS.md`
- Claude Code settings and hooks
- Cursor project folders
- Gemini, Grok, DeepSeek, Hermes, GLM, and Qwen project marker files when present
- MCP config files
- CI workflow/script markers
- Node projects
- Python projects

The detector is intentionally conservative. If Marrow cannot identify the harness from local files, it still supports the workflow through the custom command path:

```bash
MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install run --agent research-agent -- <your-agent-command>
```

## Install Modes

```bash
npx @getmarrow/install --mcp --dry-run
npx @getmarrow/install --sdk --dry-run
npx @getmarrow/install --both --dry-run
npx @getmarrow/install --md --dry-run
```

`--dry-run` is the default unless `--yes` is passed.

## What It Writes

- `.claude/settings.json` passive MCP hooks for tool outcomes and prompt context.
- `.mcp.json` with the Marrow MCP server entry.
- `.marrow/passive-runtime.mjs` for SDK passive runtime preload in Node processes.
- `.marrow/env.example` with required environment variables.
- `AGENTS.md` instructions for agents that rely on markdown/skills.
- `.cursor/rules/marrow.mdc` when a Cursor project is detected.

## Self-Test

When `MARROW_API_KEY` is present, the installer creates a harmless test decision, commits the outcome, reads `/v1/agent/status`, calls the one-call runtime, and prints the first useful Marrow signal.

```bash
MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install --yes
```

Skip self-test:

```bash
npx @getmarrow/install --yes --no-self-test
```

Doctor check:

```bash
MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install doctor
```

Repair missing hooks/config:

```bash
MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install --repair
```

## SDK Dependency

When the installer writes `.marrow/passive-runtime.mjs`, the project should have `@getmarrow/sdk` installed:

```bash
npm install @getmarrow/sdk
```

The generated runtime now fails soft with an explicit warning if the SDK package is missing, so onboarding does not crash a user process.


## Trust and Data Boundaries

Marrow is tenant-aware by design. Private account, fleet, memory, workflow, and proof-pack data stays scoped to the authenticated account and authorized agent-bound keys. Shared/hive learning uses visibility-controlled, sanitized aggregate signals; it is not raw cross-customer decision sharing.

For business pilots, review the live trust notes before production rollout: https://getmarrow.ai/docs#trust-boundaries

## Trust Model

This package is intended to be open source and auditable. It prints every file it will touch, requires `--yes` to write, does not store API keys in project files, and supports MCP-only, SDK-only, both, and markdown-only setups.

---

## Related Packages

- **[@getmarrow/sdk](https://www.npmjs.com/package/@getmarrow/sdk)** — TypeScript/Node.js SDK for custom agent integrations, passive runtime hooks, guarded actions, and direct API access.
- **[@getmarrow/mcp](https://www.npmjs.com/package/@getmarrow/mcp)** — MCP server for Claude Code, Claude Desktop, Cursor, and other MCP-compatible clients.

**Docs:** [https://getmarrow.ai/docs](https://getmarrow.ai/docs)

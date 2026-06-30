# @getmarrow/install

Universal installer for Marrow passive agent setup.

Use it when you want Marrow to detect the local agent/runtime environment and wire the safest passive integration automatically.

```bash
npx @getmarrow/install --dry-run
npx @getmarrow/install --yes
npx @getmarrow/install --repair
npx @getmarrow/install doctor
```

## What's New in v0.1.23

v0.1.23 improves attribution quality so Marrow can produce cleaner per-agent, per-harness, and per-workflow value reports.

- Installer self-tests and governed runner calls attach `source_meta.channel`, `source_meta.client`, and inferred workflow intent by default.
- Generated passive runtime keeps using SDK defaults for `agent_id`, harness/client, source channel, and user intent attribution.
- Set `MARROW_CLIENT`, `MARROW_HARNESS`, or `MARROW_AGENT_CLIENT` to labels such as `codex`, `claude-code`, `cursor`, `gemini`, `qwen`, `opencode`, `hermes`, `openclaw`, or `custom`.
- Invalid or unknown client labels fall back to `custom` instead of breaking onboarding.
- Marrow still does not store prompts, completions, tool stdout/stderr, plaintext API keys, or raw model output for this feature.

Business value: dashboards and reports can show which agents, harnesses, and workflow types are improving instead of grouping too much work into "unknown."

## Governed Runner

The Marrow governed runner is for businesses that want agent governance without replacing their existing harness.

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

Run a harmless command through Marrow:

```bash
MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install run --agent codex-prod --profile production -- node -e "process.exit(0)"
```

Gate a production action before the agent executes it:

```bash
MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install gate "deploy production worker after tests pass"
```

Wrap a real deploy, publish, merge, or migration command only after the agent has the required proof:

```bash
MARROW_API_KEY=mrw_live_xxx npx @getmarrow/install run \
  --agent deploy-agent \
  --type deploy \
  --profile production \
  --policy enforce \
  -- wrangler deploy
```

Use `--policy warn` for pilot mode and `--fail-open` only for non-production local workflows where Marrow should never block execution.

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

For cleaner attribution, set an agent id and optional client label before install:

```bash
export MARROW_FLEET_AGENT_ID=codex-deploy-agent
export MARROW_CLIENT=codex
npx @getmarrow/install --yes
```

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
- `/v1/agent/value/proof` returns token value proof from passive model-usage capture.
- The installer prints: "Your agent is no longer starting from zero."
- The installer prints: "Token value proof" with capture status, observed model calls, token totals, estimated savings, confidence, and exact next action.
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
- MCP config files
- Node projects
- Python projects

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

When `MARROW_API_KEY` is present, the installer creates a harmless test decision, commits the outcome, reads `/v1/agent/status`, calls the one-call runtime, reads `/v1/agent/value/proof`, and prints the first useful Marrow signal plus token value proof.

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

## Passive Token Value Proof

Token value proof is default-on when the installer writes `.marrow/passive-runtime.mjs`.

In supported Node/TypeScript agents, the SDK passive runtime wraps outbound model-provider `fetch` responses and captures compact `usage` blocks when providers return them. MCP and harness integrations can also attach `model_usage` to `marrow_commit` or call `marrow_model_usage` when the harness exposes usage metadata.

Captured fields are intentionally narrow:

- provider and model
- input, output, cached, and total token counts
- optional cost and latency estimates
- agent, workflow, session, and decision linkage
- Marrow intervention type, such as `runtime_gate`, `proof_pack`, or `before_you_act`

Marrow does not capture prompt text, completion text, raw tool output, command output, full environment values, or plaintext secrets for token value proof.

Disable capture only when a project requires it:

```bash
MARROW_PASSIVE_TOKEN_USAGE=false
```

Day-one behavior:

- Fresh install: `Token usage capture is ready; no model calls have been reported yet.`
- After observed usage: Marrow reports model calls, total tokens, estimated tokens saved, confidence, trend, and next action.
- After workflows complete: agents should show the returned `token_value_signal` or value proof in owner updates so users see savings without opening a dashboard.


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

# @getmarrow/install

Universal installer for Marrow passive agent setup.

Use it when you want Marrow to detect the local agent/runtime environment and wire the safest passive integration automatically.

```bash
npx @getmarrow/install --dry-run
npx @getmarrow/install --yes
npx @getmarrow/install doctor
```

## What's New in v0.1.1

- `doctor` / `--doctor` checks whether Marrow is active without writing files.
- Generated SDK passive runtime enables workflow gates and value summaries by default.
- Doctor output reports missing env, missing hooks/config, self-test state, and recommended fix.

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

When `MARROW_API_KEY` is present, the installer creates a harmless test decision, commits the outcome, and reads `/v1/agent/status`.

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

## Trust Model

This package is intended to be open source and auditable. It prints every file it will touch, requires `--yes` to write, does not store API keys in project files, and supports MCP-only, SDK-only, both, and markdown-only setups.

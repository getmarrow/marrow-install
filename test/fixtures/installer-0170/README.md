Files written by the published @getmarrow/install 0.1.70 (60535d61) into an empty `.codex` folder of a
project with no other host: `codex-hooks.json` (`.codex/hooks.json`, Marrow's own groups with the
look-ahead matcher Codex rejects) and `AGENTS.md` (only the Marrow block). That pair is the layout
a first install leaves, and the one 0.1.70 itself no longer detects as a Codex project.

`all-hosts-*` are the project files the published 0.1.70 wrote into a project that had `.claude`, `.codex`
and `.cursor` folders (`node bin/marrow-install.js --yes --no-self-test --no-controller` from 60535d61, a
dummy key made at run time in the child's environment only, default base URL, a temporary HOME):
`.claude/settings.json`, `.codex/hooks.json`, `.cursor/hooks.json`, `.cursor/mcp.json`, `.mcp.json` and
`AGENTS.md`. They hold the 0.1.70 Codex look-ahead matcher, the 0.1.70 Cursor guard that allows
server `marrow` plus an own name at once, and MCP 3.9.102 in every command. No file holds a key.

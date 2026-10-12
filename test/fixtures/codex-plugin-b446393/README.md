The six files the MCP pins (`@getmarrow/mcp` 3.9.103, `dist/codex-plugin-pins.js`) of the official Marrow
Codex plugin `marrow@0.1.1`, from getmarrow/plugins b446393 `codex/marrow`, byte for byte (the MCP's own
fixture `test/fixtures/codex-plugins-b446393`). `hooks/hooks.json` and `skills/` are unpinned and not
vendored. `test/own-tool-matchers.test.js` lays them out the way `codex plugin add` does under a
temporary CODEX_HOME to show what the real MCP decision does with the official plugin.

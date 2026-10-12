The own-tool decision of the pinned MCP, vendored so the Codex tests run the real hook logic.

`own-tool.js` and the three files it requires are `dist/` of `@getmarrow/mcp` 3.9.102 (marrow-mcp
`3a2bf85e22b6b9f7e266383ed2011b1c10ca5f97`; the packed tarball's integrity is `MCP_ADAPTER_INTEGRITY`
in `src/pins.js`), byte for byte. `test/own-tool-matchers.test.js` pins each file by sha256 and
fails when the MCP pin moves without these files being replaced.

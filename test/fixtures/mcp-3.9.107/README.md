The own-tool and server-identity decision of the pinned MCP, vendored so the tests run the real hook logic.

These eight files are `dist/` of `@getmarrow/mcp` 3.9.107 (marrow-mcp
`3e0bdb1d2023015c7c5816d813a87519c12f7f82`; the packed tarball's integrity is `MCP_ADAPTER_INTEGRITY`
in `src/pins.js`), byte for byte: `own-server-identity.js` (the Codex and Cursor server proof,
`isOfficialMarrowMcpEventOnHost`, the npm project-config rule, `INSTALLER_RUNTIME_CORE_SHA256`),
`own-tool.js` (the label rule) and what they require. `test/own-tool-matchers.test.js` pins each file
by sha256 and fails when the MCP pin moves without these files being replaced.

The release chain re-verifies the pin against the published tarball before the installer is published.

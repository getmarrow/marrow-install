The own-tool and server-identity decision of the pinned MCP, vendored so the tests run the real hook logic.

These eight files are `dist/` of `@getmarrow/mcp` 3.9.108 (marrow-mcp
`e3752f3baa511bb3071b73f521ba2b3bb526d0fd`; the packed tarball's integrity is `MCP_ADAPTER_INTEGRITY`
in `src/pins.js`), byte for byte: `own-server-identity.js` (the Codex and Cursor server proof,
`isOfficialMarrowMcpEventOnHost`, the npm project-config rule, `INSTALLER_RUNTIME_CORE_SHA256`),
`own-tool.js` (the label rule) and what they require. `test/own-tool-matchers.test.js` pins each file
by sha256 and fails when the MCP pin moves without these files being replaced.

The release chain re-verifies the pin against the published tarball before the installer is published.

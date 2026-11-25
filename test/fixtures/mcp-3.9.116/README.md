The own-tool and server-identity decision of the pinned MCP, vendored so the tests run the real hook logic.

These nine files are `dist/` of `@getmarrow/mcp` 3.9.116 (marrow-mcp
`2606372056876e7a210cebad3e3698a3414fb250`; the packed tarball's integrity is `MCP_ADAPTER_INTEGRITY`
in `src/pins.js`), byte for byte: `own-server-identity.js` (the Codex and Cursor server proof,
`isOfficialMarrowMcpEventOnHost`, the npm project-config rule, `INSTALLER_RUNTIME_CORE_SHA256`),
`own-tool.js` (the label rule) and what they require (`redact.js` requires `key-class.js`, new in 3.9.109). `test/own-tool-matchers.test.js` pins each file
by sha256 and fails when the MCP pin moves without these files being replaced.

The release chain re-verifies the pin against the published tarball before the installer is published.

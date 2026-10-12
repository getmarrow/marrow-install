The own-tool and server-identity decision of the pinned MCP, vendored so the tests run the real hook logic.

These eight files are `dist/` of `@getmarrow/mcp` 3.9.103 (marrow-mcp
`038cf8d9bdc580e486a3e2914d90b3078b9780f0`; the packed tarball's integrity is `MCP_ADAPTER_INTEGRITY`
in `src/pins.js`), byte for byte: `own-server-identity.js` (the Codex and Cursor server proof,
`isOfficialMarrowMcpEventOnHost`, the npm project-config rule, `INSTALLER_RUNTIME_CORE_SHA256`),
`own-tool.js` (the label rule) and what they require. `test/own-tool-matchers.test.js` pins each file
by sha256 and fails when the MCP pin moves without these files being replaced.

`@getmarrow/mcp` 3.9.103 is built from 038cf8d9 with the version set as the 3.9.102 release commit did;
none of these files changes with that version bump. The release chain re-verifies the pin against
the published tarball before the installer is published.

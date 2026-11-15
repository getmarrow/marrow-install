// The Marrow packages this installer pins into hooks, MCP configuration and request headers.
// This is the only place they are set: a release changes the MCP version, source SHA and
// integrity here together (and the SDK pair together), and the tests read them from here.
//
// The MCP pin is @getmarrow/mcp 3.9.114, the release commit marrow-mcp 48b1fbec. The integrity is the
// sha512 of that release's packed tarball (npm pack --ignore-scripts from a clean checkout, Node 22.23,
// npm 10.9), and the source SHA is the release commit. The nine files in test/fixtures/mcp-3.9.114 are
// dist/ of the same tarball, byte for byte, and MANIFEST.json there records them. The SDK pin is
// @getmarrow/sdk 3.7.67, whose packed tarball the MCP release's lockfile and exact dependency also name.
// THE RELEASE CHAIN MUST RE-VERIFY THIS PIN
// AGAINST THE PUBLISHED @getmarrow/mcp@3.9.114 TARBALL BEFORE THIS INSTALLER IS PUBLISHED, and
// change the source SHA and integrity here if the published tarball differs. The same goes for the
// published @getmarrow/sdk@3.7.67 tarball and SDK_ADAPTER_INTEGRITY.
module.exports = Object.freeze({
  MCP_ADAPTER_VERSION: '3.9.114',
  MCP_ADAPTER_SOURCE_SHA: '48b1fbec80ab3f7243126536b2de18fc82c6f1b7',
  MCP_ADAPTER_INTEGRITY: 'sha512-pufn9UVwx3mw7Dh0NOc5Oaq0jX/Vd0otYR0x1HzAYM92am9fkaPBf44C5YQVCxgB8fqTn+ABcptSosibIRvMjQ==',
  // The first MCP version that ships the host-approval hook entrypoints
  // (claude-permission-request-hook, cursor-context-hook, gemini-context-hook) and reads Cursor's
  // shell/MCP execution events and Gemini's BeforeAgent prompt. The installer writes the
  // host-approval hook layout only when the MCP version it pins (or a registry-verified newer
  // one) is at or above this; an older target keeps the earlier layout, because its MCP cannot
  // answer those hooks and Cursor shell and MCP calls would then go ungated. Set this to the
  // version the host-approvals MCP is published as when the release re-pins the MCP above.
  MCP_HOST_APPROVAL_HOOKS_SINCE: '3.9.99',
  // The SDK pin, at the backend's parity version. Change version and integrity together.
  SDK_ADAPTER_VERSION: '3.7.67',
  SDK_ADAPTER_INTEGRITY: 'sha512-0Lwg4XLxm9eXxMgQtFAH1y4mXi9CXg3poQlGbeK0AW+EHP+yfUWQUH4d1XYO03QNzwHLAYKfARDmnl5GpBnKUw==',
});

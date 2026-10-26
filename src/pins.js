// The Marrow packages this installer pins into hooks, MCP configuration and request headers.
// This is the only place they are set: a release changes the MCP version, source SHA and
// integrity here together (and the SDK pair together), and the tests read them from here.
//
// The MCP pin is @getmarrow/mcp 3.9.108, the release candidate marrow-mcp e3752f3b. The integrity is the
// sha512 of that candidate's packed tarball (npm pack, Node 22.23, npm 10.9), and the source SHA is the
// candidate commit. The eight files in test/fixtures/mcp-3.9.108 are dist/ of the same tarball, byte for
// byte, and MANIFEST.json there records them. The SDK pin is @getmarrow/sdk 3.7.67, whose packed tarball
// the MCP candidate's lockfile and exact dependency also name. One scripted re-pin set all of it together.
// THE RELEASE CHAIN MUST RE-VERIFY THIS PIN
// AGAINST THE PUBLISHED @getmarrow/mcp@3.9.108 TARBALL BEFORE THIS INSTALLER IS PUBLISHED, and
// change the source SHA and integrity here if the published tarball differs. The same goes for the
// published @getmarrow/sdk@3.7.67 tarball and SDK_ADAPTER_INTEGRITY.
module.exports = Object.freeze({
  MCP_ADAPTER_VERSION: '3.9.108',
  MCP_ADAPTER_SOURCE_SHA: 'e3752f3baa511bb3071b73f521ba2b3bb526d0fd',
  MCP_ADAPTER_INTEGRITY: 'sha512-tbgRVlydUbc1or+i68xOO3QprN4Vp9tV0LBGhxD4WhIHeycyS7TqGg2sn4epMajx/nHcO0txjpjOdgqFf/1eEw==',
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

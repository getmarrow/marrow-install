// The Marrow packages this installer pins into hooks, MCP configuration and request headers.
// This is the only place they are set: a release changes the MCP version, source SHA and
// integrity here together (and the SDK pair together), and the tests read them from here.
//
// The MCP pin is @getmarrow/mcp 3.9.103, the release candidate marrow-mcp 868a9c18. The integrity is the
// sha512 of that candidate's packed tarball (npm pack, Node 22.23, npm 10.9), and the source SHA is the
// candidate commit. The eight files in test/fixtures/mcp-3.9.103 are dist/ of the same tarball, byte for
// byte, and MANIFEST.json there records them. One scripted re-pin set all of it together.
// THE RELEASE CHAIN MUST RE-VERIFY THIS PIN
// AGAINST THE PUBLISHED @getmarrow/mcp@3.9.103 TARBALL BEFORE THIS INSTALLER IS PUBLISHED, and
// change the source SHA and integrity here if the published tarball differs.
module.exports = Object.freeze({
  MCP_ADAPTER_VERSION: '3.9.103',
  MCP_ADAPTER_SOURCE_SHA: '868a9c18530a75fcee5052441d0d3d2383511df4',
  MCP_ADAPTER_INTEGRITY: 'sha512-STXL6Zaiqv8Jh0wQpQpNut3bvj5ck0wNokwhy21Y7XuqNK55+MMgCkpYhFzIuVCiuGL2FR7NlytA3EmFlHdS6w==',
  // The first MCP version that ships the host-approval hook entrypoints
  // (claude-permission-request-hook, cursor-context-hook, gemini-context-hook) and reads Cursor's
  // shell/MCP execution events and Gemini's BeforeAgent prompt. The installer writes the
  // host-approval hook layout only when the MCP version it pins (or a registry-verified newer
  // one) is at or above this; an older target keeps the earlier layout, because its MCP cannot
  // answer those hooks and Cursor shell and MCP calls would then go ungated. Set this to the
  // version the host-approvals MCP is published as when the release re-pins the MCP above.
  MCP_HOST_APPROVAL_HOOKS_SINCE: '3.9.99',
  // The SDK pin, at the backend's parity version. Change version and integrity together.
  SDK_ADAPTER_VERSION: '3.7.65',
  SDK_ADAPTER_INTEGRITY: 'sha512-U+rxqEBs7uIHaGbx+ADGl09RvXSMeqxQZXTuJHxwx6P8EhOEB6SSLcot0OAhAu3gfGuZ+020ch0Y0WieqjxtYw==',
});

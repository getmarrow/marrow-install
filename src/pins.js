// The Marrow packages this installer pins into hooks, MCP configuration and request headers.
// This is the only place they are set: a release changes the MCP version, source SHA and
// integrity here together (and the SDK pair together), and the tests read them from here.
//
// The MCP pin is @getmarrow/mcp 3.9.103, built from marrow-mcp 038cf8d9 (fix/mcp-39103-candidate,
// audit PASS). The integrity was computed the way the MCP release does it: check out 038cf8d9, set
// 3.9.103 in package.json, package-lock.json (2), server.json (2) and src/hook-contract.ts exactly
// as the 3.9.102 release commit 3a2bf85e did, `npm ci --ignore-scripts`, `npm run build` (only
// dist/hook-contract.{js,d.ts} change), `npm pack` (npm 10.9.8, Node 22.23), sha512 of the tarball.
// README.md and CHANGELOG.md were left as they are on 038cf8d9: a release commit that edits README.md
// (it ships in the tarball) changes this integrity. THE RELEASE CHAIN MUST RE-VERIFY THIS PIN
// AGAINST THE PUBLISHED @getmarrow/mcp@3.9.103 TARBALL BEFORE THIS INSTALLER IS PUBLISHED, and
// change the source SHA and integrity here if the published tarball differs.
module.exports = Object.freeze({
  MCP_ADAPTER_VERSION: '3.9.103',
  MCP_ADAPTER_SOURCE_SHA: '038cf8d9bdc580e486a3e2914d90b3078b9780f0',
  MCP_ADAPTER_INTEGRITY: 'sha512-EYEgwRiZI0yC5+7GBedcl/fIZiV8doeCnbLcAb6JCISPD6v1+fj6F+EDr8pDAvIj4l6lXeqWPFTC3RzV6zvbbg==',
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

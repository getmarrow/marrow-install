// The Marrow packages this installer pins into hooks, MCP configuration and request headers.
// This is the only place they are set: a release changes the MCP version, source SHA and
// integrity here together (and the SDK pair together), and the tests read them from here.
module.exports = Object.freeze({
  MCP_ADAPTER_VERSION: '3.9.100',
  MCP_ADAPTER_SOURCE_SHA: 'dfe8ca59b7862c481443876f5b1d0f453d244a44',
  MCP_ADAPTER_INTEGRITY: 'sha512-6YfkDSrYhDwjTUBAo7toJ808R1pzxefjX5Dk3fq8hVfr8FrR+DMLbZTHOM0vU1uhPOp8H5GFIniTWTNh2/5Sig==',
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

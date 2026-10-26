// F-2G (installer 0.1.74): on native Windows the installer does not write Grok's native hooks and
// never reports Grok as configured, governed or native_hooks.
//
// Why: assertSafeGrokHookTarget (installer.js) proves the Grok hook path is private with POSIX
// owner and mode bits. Windows reports mode 0o666/0o777 for every path, so the proof can never
// pass there; before this change it threw, and the whole install aborted for every host.
// assertSafeGrokHookTarget itself is unchanged: a Grok write that is attempted anyway still throws.
//
// The decision is keyed on the REAL platform (process.platform, read at call time). Nothing in the
// environment, argv or a flag can turn it off. A detection built with an injected platform (tests
// only, the third argument of detectEnvironment) can only ADD the skip on another platform; it can
// never remove it on a real win32 host.

const GROK_WINDOWS_SKIP_REASON = 'grok_hooks_unsupported_on_native_windows';
const GROK_WINDOWS_SKIP_LABEL = 'Grok native hooks';
const GROK_WINDOWS_SKIP_NOTICE = 'Grok is not governed on native Windows: Marrow cannot prove that the Grok hook folder is private there, so it did not write the Grok native hooks and does not count Grok as covered. No other host is affected. The governed wrapper (npx @getmarrow/install run -- <command>) remains an explicit bounded fallback for Grok commands.';

function grokHooksSkipped(detection) {
  return process.platform === 'win32' || detection?.grokHooksSkipped === true;
}

module.exports = {
  GROK_WINDOWS_SKIP_LABEL,
  GROK_WINDOWS_SKIP_NOTICE,
  GROK_WINDOWS_SKIP_REASON,
  grokHooksSkipped,
};

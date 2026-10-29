const fs = require('node:fs');
const path = require('node:path');

// INS-6: warnings for risky local configurations, shown by setup and doctor. Everything here reports
// names, file labels and counts. It never returns or prints a rule, an env value, a hook command or any
// other settings text: allow rules and env blocks can hold tokens. The settings files are read only.

const SETTINGS_MAX_BYTES = 1024 * 1024;
const SETTINGS_FILES = [
  { scope: 'user', label: '~/.claude/settings.json' },
  { scope: 'project', label: '.claude/settings.json' },
  { scope: 'local', label: '.claude/settings.local.json' },
];
// Claude Code's three spellings of "every Bash command": the bare tool name, Bash(*) and the older Bash(:*).
const BLANKET_BASH_RULE = /^Bash\s*(?:\(\s*(?:\*{1,2}|:\*|\*:\*)?\s*\))?$/;
const HOOKS_OFF_VALUE = /^(?:false|0|off|no)$/i;
const SAFE_AGENT_ID = /^[A-Za-z0-9._:-]{1,128}$/;

const BLANKET_BASH_TEXT = 'Claude Code allows every Bash command without a dialog, so Marrow holds on Bash can never be approved on this host. Replace the blanket rule with narrow allow rules, or add ask rules for the commands Marrow holds.';

// Settings file states other than read/missing: Marrow could not check the file, so the answer is a warning that names
// the file and the state, never silence (a file Marrow cannot parse can still be read by Claude Code).
const UNCHECKED_STATE_WORDS = { invalid: 'not a JSON object', too_large: 'over 1 MiB, not read', unreadable: 'cannot be read' };

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const plain =(value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// One settings file: a regular file (a link to one is followed, read-only) of at most 1 MiB holding a JSON
// object. Anything else is a state name, never an exception and never content.
function readSettingsFile(file) {
  let stat;
  try { stat = fs.statSync(file); } catch (error) { return { state: error && (error.code === 'ENOENT' || error.code === 'ENOTDIR') ? 'missing' : 'unreadable' }; }
  if (!stat.isFile()) return { state: 'unreadable' };
  if (stat.size > SETTINGS_MAX_BYTES) return { state: 'too_large' };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { state: 'unreadable' }; }
  let value;
  try { value = JSON.parse(raw); } catch { return { state: 'invalid' }; }
  return plain(value) ? { state: 'read', value } : { state: 'invalid' };
}

function hasBlanketBashAllow(settings) {
  const permissions = own(settings, 'permissions') && plain(settings.permissions) ? settings.permissions : null;
  const allow = permissions && own(permissions, 'allow') ? permissions.allow : null;
  return Array.isArray(allow) && allow.some((rule) => typeof rule === 'string' && BLANKET_BASH_RULE.test(rule.trim()));
}

function turnsHooksOff(value) {
  return value === false || (typeof value === 'string' && HOOKS_OFF_VALUE.test(value.trim()));
}

function envBlockTurnsHooksOff(settings) {
  const env = own(settings, 'env') && plain(settings.env) ? settings.env : null;
  return Boolean(env && own(env, 'MARROW_AUTO_HOOK') && turnsHooksOff(env.MARROW_AUTO_HOOK));
}

// The facts doctor and setup report from the three Claude Code settings files. `userHooks` (optional) turns
// the parsed user-level settings into counts; the parsed settings themselves never leave this function.
function claudeSettingsFacts({ home, root, userHooks }) {
  const where = { user: path.join(home, '.claude', 'settings.json'), project: path.join(root, '.claude', 'settings.json'), local: path.join(root, '.claude', 'settings.local.json') };
  const files = [];
  const blanketBashAllow = [];
  const autoHookOffIn = [];
  let userHookCounts = null;
  for (const { scope, label } of SETTINGS_FILES) {
    const read = readSettingsFile(where[scope]);
    files.push({ label, state: read.state });
    if (scope === 'user' && typeof userHooks === 'function') userHookCounts = read.state === 'read' ? { state: 'read', ...userHooks(read.value) } : { state: read.state };
    if (read.state !== 'read') continue;
    if (hasBlanketBashAllow(read.value)) blanketBashAllow.push(label);
    if (envBlockTurnsHooksOff(read.value)) autoHookOffIn.push(label);
  }
  return { files, blanket_bash_allow: blanketBashAllow, auto_hook_off_in: autoHookOffIn, user_hooks: userHookCounts };
}

// `env` is the process environment (read for one name); `keyPresent` is the resolved key (shell or owner env
// files) as a yes/no; `localControl` is control-state's evidence(); `settings` is claudeSettingsFacts().
function riskWarnings({ settings, env, keyPresent, localControl, selfTest, agentId }) {
  const found = [];
  const add = (id, text) => found.push({ id, text });
  if (localControl && localControl.state === 'disabled') {
    add('control_off', `Marrow local control is off on this machine (since ${localControl.changed_at}): hooks let actions run without Marrow holds. Run npx @getmarrow/install control enable to turn it back on.`);
  } else if (localControl && localControl.state === 'error') {
    add('control_state_unsafe', 'The local Marrow control state (~/.marrow/control.json) is unsafe or invalid, so protected actions stay blocked. Inspect it, then run npx @getmarrow/install control status.');
  }
  if (!keyPresent) {
    add('keyless_hooks', 'No Marrow API key was found in this shell or in ~/.marrow/env or ~/.marrow/env.local. Hooks that start without a key skip silently: holds and approvals are not recorded, and only the local seatbelt applies. Save MARROW_API_KEY in the owner-only file ~/.marrow/env or start the host with it, then restart the host.');
  }
  const offIn = [];
  if (env && own(env, 'MARROW_AUTO_HOOK') && turnsHooksOff(env.MARROW_AUTO_HOOK)) offIn.push('in this shell');
  if (settings && settings.auto_hook_off_in.length) offIn.push(`in the env block of ${settings.auto_hook_off_in.join(', ')}`);
  if (offIn.length) {
    add('auto_hook_off', `MARROW_AUTO_HOOK is set to off ${offIn.join(' and ')}, so Marrow hooks started there exit without checking or recording anything. Remove MARROW_AUTO_HOOK to turn them back on.`);
  }
  if (settings && settings.blanket_bash_allow.length) {
    add('blanket_bash_allow', `${BLANKET_BASH_TEXT} Found in: ${settings.blanket_bash_allow.join(', ')}.`);
  }
  const unchecked = settings && Array.isArray(settings.files) ? settings.files.filter((file) => file.state !== 'read' && file.state !== 'missing') : [];
  if (unchecked.length) {
    const named = unchecked.map((file) => `${file.label} (${UNCHECKED_STATE_WORDS[file.state] || UNCHECKED_STATE_WORDS.unreadable})`).join(', ');
    add('settings_unreadable', `Marrow could not check ${named} for a blanket Bash allow or MARROW_AUTO_HOOK set to off, so a risky setting there would not show in this report, and Claude Code may still use ${unchecked.length > 1 ? 'those files' : 'that file'}. Make ${unchecked.length > 1 ? 'each' : 'the'} file a valid JSON object of at most 1 MiB, or remove it, then run npx @getmarrow/install doctor again.`);
  }
  if (selfTest && selfTest.key_binding === 'unbound') {
    const id = typeof agentId === 'string' && SAFE_AGENT_ID.test(agentId) ? `agent "${agentId}"` : 'this agent';
    add('key_unbound', `This Marrow key is not bound to ${id}: Marrow answered 409 with key_binding unbound. Use a key created for this agent in your Marrow account, or remove the agent id setting so Marrow resolves the agent on each call.`);
  }
  return found;
}

module.exports = { SETTINGS_MAX_BYTES, SETTINGS_FILES, BLANKET_BASH_TEXT, SAFE_AGENT_ID, readSettingsFile, claudeSettingsFacts, riskWarnings };

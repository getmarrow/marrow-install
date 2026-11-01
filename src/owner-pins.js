'use strict';

// F-H2: `update` never edits an owner's script. It says which owner script lines still pin a Marrow
// version, so the owner can change them by hand. The scripts looked at are only the absolute paths
// that a set-up host file's own commands name (the caller passes those command strings); no
// directory is listed and no other file is opened. A file is read in-process, never followed through a
// symbolic link, never read through a hard link, opened without blocking, size-capped, and only `path:line`
// and the version are kept: nothing else of its text leaves this module.

const fs = require('node:fs');
const path = require('node:path');

const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 40;
const MAX_COMMAND_CHARS = 20000;
const MAX_PIN_LINES = 200;
const MAX_NOT_SCANNED = 40;
const PIN_RE = /(?:@getmarrow\/mcp@|\.marrow\/runtime\/mcp\/)(\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?)/g;
const SCRIPT_NAME_RE = /(?:\.(?:sh|bash|zsh|js|mjs|cjs|py|rb|pl)$|marrow)/i;
// Places that hold the system's programs and devices, never an owner's launcher.
const SYSTEM_PREFIXES = ['/bin/', '/sbin/', '/usr/bin/', '/usr/sbin/', '/usr/lib/', '/lib/', '/dev/', '/proc/', '/sys/', '/usr/local/bin/', '/opt/homebrew/bin/'];

// Owner credential stores and key folders are never opened, whatever a command names: the pin report needs
// only scripts, and a key must not be read even in-process for it.
const CREDENTIAL_DIR_RE = /(?:^|\/)\.(?:marrow|hermes|ssh|aws|gnupg|docker|kube)(?:\/|$)|\/\.config\/(?:gh|gcloud)(?:\/|$)/;
const CREDENTIAL_NAME_RE = /^(?:[^/]*\.env(?:\..*)?|env|credentials|\.[a-z0-9_-]+rc|\.netrc|\.git-credentials|auth\.json|hosts\.yml|\.claude\.json|settings\.local\.json|id_[a-z0-9]+|[^/]*\.(?:pem|key|p12|pfx))$/i;

function isCredentialPath(target) {
  const normal = path.resolve(target);
  return CREDENTIAL_DIR_RE.test(normal) || CREDENTIAL_NAME_RE.test(path.basename(normal));
}

function printable(value) {
  return String(value).replace(/[^\x20-\x7e]/g, '?').slice(0, 300);
}

// The words of a command line, split on whitespace, quotes and shell separators, so a path inside
// `bash -c "..."`, after `&&`, `;`, `||` or a pipe is found like any other.
function words(command) {
  return String(command).slice(0, MAX_COMMAND_CHARS).split(/[\s"'`;&|()<>=,]+/).filter(Boolean);
}

// How a word names a file: an absolute path, a path under the user's home (`~/`, `$HOME/`,
// `${HOME}/`), or a relative/variable path that is reported and never looked for.
function classify(word, home) {
  if (word.startsWith('/')) return { kind: 'file', spelled: word };
  const homeForm = word.match(/^(?:~|\$HOME|\$\{HOME\})(\/.*)$/);
  if (homeForm) return { kind: 'file', spelled: path.join(home, homeForm[1]), display: word };
  if (/^\.{1,2}\//.test(word) || /^\$\{?[A-Za-z_][A-Za-z0-9_]*\}?\//.test(word)) return { kind: 'unresolved', spelled: word };
  return null;
}

function openCapped(file) {
  const before = fs.lstatSync(file);
  if (before.isSymbolicLink()) return { reason: 'a symbolic link' };
  if (before.isDirectory()) return { skip: true };
  if (!before.isFile()) return { reason: 'not a regular file' };
  // A second name for a file may be a credential store's: it is never opened.
  if (before.nlink > 1) return { reason: 'a hard link' };
  if (before.size > MAX_FILE_BYTES) return { reason: 'larger than the size limit' };
  let fd = null;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    if (stat.isFile() && stat.nlink > 1) return { reason: 'a hard link' };
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return { reason: stat.isFile() ? 'larger than the size limit' : 'not a regular file' };
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < buffer.length) {
      const read = fs.readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    return { text: buffer.subarray(0, offset).toString('utf8') };
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function pinLines(text) {
  const found = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length && found.length < MAX_PIN_LINES; index += 1) {
    const versions = [...new Set([...lines[index].matchAll(PIN_RE)].map((match) => match[1]))];
    if (versions.length) found.push({ line: index + 1, versions });
  }
  return found;
}

// `commands`: the strings of the owner's own (not Marrow-written) commands in set-up host files.
// Returns { pins: [{ path, line, versions }], notScanned: [{ path, reason }] }, each file once.
function scanOwnerPins(commands, { home } = {}) {
  const pins = [];
  const notScanned = [];
  const seen = new Set();
  let scanned = 0;
  for (const command of commands || []) {
    for (const word of words(command)) {
      const named = classify(word, home || '');
      if (!named) continue;
      const display = printable(named.display || named.spelled);
      if (named.kind === 'unresolved') {
        if (SCRIPT_NAME_RE.test(path.basename(word)) && !seen.has(`u:${word}`) && notScanned.length < MAX_NOT_SCANNED) {
          seen.add(`u:${word}`);
          notScanned.push({ path: display, reason: 'a relative or variable path; update does not search for it' });
        }
        continue;
      }
      const target = named.spelled;
      if (SYSTEM_PREFIXES.some((prefix) => target.startsWith(prefix))) continue;
      if (isCredentialPath(target)) continue;
      let key;
      try {
        key = path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
      } catch {
        continue;
      }
      // The folder the name goes through may itself be a link into a key folder.
      if (isCredentialPath(key)) continue;
      if (seen.has(key) || scanned >= MAX_FILES) continue;
      seen.add(key);
      scanned += 1;
      let result;
      try {
        result = openCapped(target);
      } catch (error) {
        result = error && error.code === 'ENOENT' ? { skip: true } : { reason: 'not readable' };
      }
      if (result.skip) continue;
      if (result.reason) {
        if (SCRIPT_NAME_RE.test(path.basename(target)) && notScanned.length < MAX_NOT_SCANNED) notScanned.push({ path: display, reason: result.reason });
        continue;
      }
      for (const found of pinLines(result.text)) pins.push({ path: display, line: found.line, versions: found.versions });
    }
  }
  return { pins, notScanned };
}

module.exports = { scanOwnerPins, MAX_FILE_BYTES };

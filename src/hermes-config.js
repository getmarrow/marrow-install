const fs = require('node:fs');
const path = require('node:path');

// Hermes reads MCP servers from mcp_servers in $HERMES_HOME/config.yaml (default ~/.hermes).
// Stdio servers get only PATH, HOME and a few locale variables plus their own env block, and
// ${VAR} values are resolved from the Hermes environment, including $HERMES_HOME/.env.
//
// This is a deliberately small line editor for one entry, mcp_servers.marrow. It keeps every
// other byte, comment and key in the file. Anything it cannot edit with certainty is refused
// and the caller prints the exact block to add by hand: a byte order mark, an indented or
// non-mapping root, tabs, anchors, aliases, tags, flow mappings, block scalars, duplicate keys,
// several documents, unterminated top-level quotes or flows, and a marrow entry with a custom
// command or custom arguments. The planned result is re-analyzed before it is returned: it
// must hold exactly one mcp_servers mapping, and every line outside the marrow entry must be
// unchanged. The config holds other servers' credentials, so no copy of it is ever written;
// the undo note lists only the marrow lines added or replaced, with values redacted.

const SERVER_NAME = 'marrow';
const KEY_REFERENCE = '"${MARROW_API_KEY}"';
const REDACTED = '[redacted]';
const MARROW_ARG_RE = /^(?:-y|--yes|marrow-mcp|(?:--package=)?@getmarrow\/mcp(?:@[0-9A-Za-z.+-]+)?)$/;
const SECRET_FLAG_RE = /^-{1,2}[A-Za-z0-9_.-]*(?:key|token|secret|passw(?:or)?d|auth|credential|bearer|cookie)[A-Za-z0-9_.-]*(?:=.*)?$/i;

function hermesHome(home, env = process.env) {
  const configured = String(env.HERMES_HOME || '').trim();
  return configured ? path.resolve(configured) : path.join(home, '.hermes');
}

function hermesPaths(home, env = process.env) {
  const directory = hermesHome(home, env);
  return {
    home: directory,
    config: path.join(directory, 'config.yaml'),
    env: path.join(directory, '.env'),
  };
}

function desiredArgs(mcpPackageSpec) {
  return ['-y', `--package=${mcpPackageSpec}`, 'marrow-mcp'];
}

function flowList(values) {
  return `[${values.map((value) => JSON.stringify(value)).join(', ')}]`;
}

function indentOf(line) {
  return line.match(/^ */)[0].length;
}

function isBlankOrComment(line) {
  return /^\s*(?:#.*)?$/.test(line);
}

function stripComment(value) {
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '#' && (index === 0 || /\s/.test(value[index - 1]))) {
      return value.slice(0, index).trimEnd();
    }
  }
  return value.trimEnd();
}

function scalarValue(raw) {
  const value = stripComment(String(raw || '')).trim();
  if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2)
    || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
    return value.slice(1, -1);
  }
  return value;
}

function keyLine(line) {
  const match = line.match(/^( *)(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*:(?:\s+(.*)|\s*)$/);
  if (!match) return null;
  return {
    indent: match[1].length,
    key: match[2] || match[3] || match[4],
    rest: match[5] === undefined ? '' : match[5],
  };
}

function unsafeValue(rest) {
  const value = stripComment(rest).trim();
  return /^[&*!|>]/.test(value) || value.startsWith('<<');
}

// Scans the text a node starts on (a key's value or a sequence item) and every following line
// until a quoted or flow scalar closes. Returns the lines it spans past the first, or null
// when the value closes on its own line.
function scalarSpan(lines, start, value) {
  const trimmed = value.trimStart();
  const opener = trimmed[0];
  if (!['"', "'", '[', '{'].includes(opener)) return 0;
  let quote = opener === '"' || opener === "'" ? opener : null;
  let depth = quote ? 0 : 1;
  let index = 1;
  let text = trimmed;
  for (let line = start; line < lines.length; line += 1) {
    if (line > start) {
      text = lines[line];
      index = 0;
    }
    for (; index < text.length; index += 1) {
      const char = text[index];
      if (quote === '"') {
        if (char === '\\') index += 1;
        else if (char === '"') quote = null;
      } else if (quote === "'") {
        if (char === "'" && text[index + 1] === "'") index += 1;
        else if (char === "'") quote = null;
      } else if (char === '"' || char === "'") {
        quote = char;
      } else if (char === '#' && (index === 0 || /\s/.test(text[index - 1]))) {
        break;
      } else if (char === '[' || char === '{') {
        depth += 1;
      } else if (char === ']' || char === '}') {
        depth -= 1;
      }
      if (!quote && depth === 0) return line - start;
    }
  }
  return -1;
}

function nodeValue(line) {
  const parsed = keyLine(line);
  if (parsed) return parsed.rest;
  const item = line.match(/^ *- +(.*)$/);
  if (!item) return '';
  const nested = keyLine(`${' '.repeat(indentOf(line) + 2)}${item[1]}`);
  return nested ? nested.rest : item[1];
}

// Marks every line that belongs to a multi-line quoted or flow scalar. Those lines are content,
// never structure, so a key-looking line inside a string can never be mistaken for a key.
function scanDocument(text) {
  if (text.charCodeAt(0) === 0xfeff) return { error: 'byte order mark' };
  const lines = text.split(/\r?\n/);
  if (/\t/.test(lines.map((line) => line.match(/^\s*/)[0]).join(''))) return { error: 'tab indentation' };
  const continuation = new Array(lines.length).fill(false);
  let documentStartAllowed = true;
  let rootChecked = false;
  let sequenceParent = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (continuation[index] || isBlankOrComment(line)) continue;
    const indent = indentOf(line);
    if (/^---\s*(?:#.*)?$/.test(line) && documentStartAllowed) {
      documentStartAllowed = false;
      continue;
    }
    documentStartAllowed = false;
    if (/^---(?:\s|$)/.test(line) || /^\.\.\.(?:\s|$)/.test(line)) return { error: 'multiple YAML documents' };
    if (!rootChecked) {
      rootChecked = true;
      if (indent > 0) return { error: 'indented top-level document' };
    }
    if (indent === 0) {
      const parsed = keyLine(line);
      if (parsed) {
        sequenceParent = !stripComment(parsed.rest).trim();
      } else if (!(sequenceParent && /^-(?:\s|$)/.test(line))) {
        return { error: 'unsupported top-level YAML syntax' };
      }
    }
    const span = scalarSpan(lines, index, nodeValue(line));
    if (span === -1) return { error: 'unterminated quoted or flow value' };
    if (span > 0) {
      if (indent === 0) return { error: 'unterminated top-level quote or flow' };
      for (let next = index + 1; next <= index + span; next += 1) continuation[next] = true;
    }
  }
  return { lines, continuation };
}

// Last line index (exclusive) of the block owned by the key at `start`: the next structural
// line indented at or below `parentIndent`. Trailing blank and comment lines are left outside.
function blockEnd(doc, start, parentIndent) {
  const { lines, continuation } = doc;
  const owner = keyLine(lines[start]);
  // PyYAML writes a sequence under a key at the key's own indent (`args:` then `- -y`).
  const sameIndentSequence = Boolean(owner && owner.indent === parentIndent && !stripComment(owner.rest).trim());
  let lastContent = start;
  for (let end = start + 1; end < lines.length; end += 1) {
    const line = lines[end];
    if (continuation[end]) {
      lastContent = end;
      continue;
    }
    if (isBlankOrComment(line)) continue;
    const indent = indentOf(line);
    if (indent < parentIndent) break;
    if (indent === parentIndent && !(sameIndentSequence && /^ *-(?:\s|$)/.test(line))) break;
    lastContent = end;
  }
  return lastContent + 1;
}

function childKeys(doc, start, end) {
  const { lines, continuation } = doc;
  let childIndent = null;
  const children = [];
  for (let index = start; index < end; index += 1) {
    const line = lines[index];
    if (continuation[index] || isBlankOrComment(line)) continue;
    const indent = indentOf(line);
    if (childIndent === null) childIndent = indent;
    if (indent < childIndent) return { error: 'inconsistent indentation' };
    if (indent === childIndent) {
      const previous = children[children.length - 1];
      if (/^ *-(?:\s|$)/.test(line) && previous && !stripComment(previous.rest).trim()) continue;
      const parsed = keyLine(line);
      if (!parsed) return { error: 'unsupported entry syntax' };
      children.push({ ...parsed, line: index });
    }
  }
  for (const child of children) child.end = Math.min(blockEnd(doc, child.line, childIndent), end);
  return { childIndent, children };
}

function readListValue(doc, child) {
  const { lines } = doc;
  const inline = stripComment(child.rest).trim();
  if (inline) {
    if (!inline.startsWith('[') || !inline.endsWith(']')) return null;
    const body = inline.slice(1, -1).trim();
    if (!body) return [];
    if (/[[\]{}]/.test(body)) return null;
    return body.split(',').map((item) => scalarValue(item));
  }
  const items = [];
  for (let index = child.line + 1; index < child.end; index += 1) {
    const line = lines[index];
    if (isBlankOrComment(line)) continue;
    const match = line.match(/^\s*-\s+(.*)$/);
    if (!match) return null;
    items.push(scalarValue(match[1]));
  }
  return items;
}

function sameList(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function analyzeConfig(text) {
  const doc = scanDocument(text);
  if (doc.error) return { error: doc.error };
  const { lines, continuation } = doc;
  const topLevel = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line, index }) => !continuation[index] && /^(?:"mcp_servers"|'mcp_servers'|mcp_servers)\s*:/.test(line));
  if (topLevel.length > 1) return { error: 'duplicate mcp_servers keys' };
  if (topLevel.length === 0) return { doc, lines, servers: null };
  const serversLine = topLevel[0].index;
  const serversKey = keyLine(lines[serversLine]);
  if (!serversKey) return { error: 'unsupported mcp_servers syntax' };
  const inline = stripComment(serversKey.rest).trim();
  if (inline && !['{}', 'null', '~'].includes(inline)) return { error: 'mcp_servers is not a block mapping' };
  const end = blockEnd(doc, serversLine, 0);
  const servers = { line: serversLine, end, emptyInline: Boolean(inline) };
  if (inline) return { doc, lines, servers, entry: null, childIndent: null };
  const parsed = childKeys(doc, serversLine + 1, end);
  if (parsed.error) return { error: `mcp_servers: ${parsed.error}` };
  const entries = parsed.children.filter((child) => child.key === SERVER_NAME);
  if (entries.length > 1) return { error: 'duplicate mcp_servers.marrow keys' };
  return { doc, lines, servers, entry: entries[0] || null, childIndent: parsed.childIndent };
}

function renderEntry(indent, unit, options) {
  const pad = ' '.repeat(indent);
  const inner = ' '.repeat(indent + unit);
  const envPad = ' '.repeat(indent + unit * 2);
  const lines = [
    `${pad}${SERVER_NAME}:`,
    `${inner}command: npx`,
    `${inner}args: ${flowList(desiredArgs(options.mcpPackageSpec))}`,
    `${inner}env:`,
    `${envPad}MARROW_CLIENT: hermes`,
  ];
  if (options.keyReference) lines.push(`${envPad}MARROW_API_KEY: ${KEY_REFERENCE}`);
  return lines;
}

function manualBlock(options) {
  return ['mcp_servers:', ...renderEntry(2, 2, options)].join('\n');
}

function redactArgs(items) {
  const out = [];
  let redactNext = false;
  for (const item of items) {
    if (redactNext) {
      out.push(REDACTED);
      redactNext = false;
    } else if (SECRET_FLAG_RE.test(item)) {
      if (item.includes('=')) out.push(`${item.slice(0, item.indexOf('='))}=${REDACTED}`);
      else {
        out.push(item);
        redactNext = true;
      }
    } else {
      out.push(item);
    }
  }
  return out;
}

// Undo lines keep structure only: every env value except MARROW_CLIENT is redacted, and so is
// every argument after a key- or token-like flag. Comments can hold anything, so trailing
// comments are dropped and comment-only lines are replaced with a marker.
function redactUndoLines(lines, startInEnv = false) {
  let envIndent = startInEnv ? -1 : null;
  let argsIndent = null;
  let argItems = [];
  const out = [];
  for (const raw of lines) {
    if (/^\s*#/.test(raw)) {
      out.push(`${' '.repeat(indentOf(raw))}# [comment redacted]`);
      continue;
    }
    const line = stripComment(raw);
    const indent = indentOf(line);
    if (envIndent !== null && indent <= envIndent && !isBlankOrComment(line)) envIndent = null;
    if (argsIndent !== null && !/^ *-(?:\s|$)/.test(line) && (indent <= argsIndent && !isBlankOrComment(line))) argsIndent = null;
    const parsed = keyLine(line);
    if (envIndent !== null && parsed) {
      out.push(parsed.key === 'MARROW_CLIENT' ? line : `${' '.repeat(parsed.indent)}${parsed.key}: ${REDACTED}`);
      continue;
    }
    if (argsIndent !== null) {
      const item = line.match(/^( *- +)(.*)$/);
      if (item) {
        argItems.push(scalarValue(item[2]));
        const redacted = redactArgs(argItems);
        out.push(`${item[1]}${JSON.stringify(redacted[redacted.length - 1])}`);
        continue;
      }
    }
    if (parsed && parsed.key === 'env') {
      envIndent = parsed.indent;
      out.push(stripComment(parsed.rest).trim() ? `${' '.repeat(parsed.indent)}env: ${REDACTED}` : line);
      continue;
    }
    if (parsed) {
      // Any list is treated like command arguments: items after a secret-like flag are redacted.
      const inline = stripComment(parsed.rest).trim();
      if (inline.startsWith('[') && inline.endsWith(']')) {
        const body = inline.slice(1, -1).trim();
        const items = body ? body.split(',').map((item) => scalarValue(item)) : [];
        out.push(`${' '.repeat(parsed.indent)}${parsed.key}: ${flowList(redactArgs(items))}`);
        continue;
      }
      if (!inline) {
        argsIndent = parsed.indent;
        argItems = [];
        out.push(line);
        continue;
      }
      out.push(['command', 'type', 'timeout', 'enabled'].includes(parsed.key) || ['{}', 'null', '~'].includes(inline)
        ? line
        : `${' '.repeat(parsed.indent)}${parsed.key}: ${REDACTED}`);
      continue;
    }
    out.push(line);
  }
  return out;
}

function splitLines(text) {
  const lines = text.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '' && /\r?\n$/.test(text)) lines.pop();
  return lines;
}

// Every line outside mcp_servers.marrow, with an empty inline mcp_servers written as a block key.
function linesOutsideEntry(text) {
  const analysis = analyzeConfig(text);
  if (analysis.error) return null;
  const lines = splitLines(text);
  return lines.flatMap((line, index) => {
    if (analysis.entry && index >= analysis.entry.line && index < analysis.entry.end) return [];
    if (analysis.servers && index === analysis.servers.line) return ['mcp_servers:'];
    return [line];
  });
}

function verifyPlanned(before, after, options) {
  const analysis = analyzeConfig(after);
  if (analysis.error || !analysis.servers || analysis.servers.emptyInline || !analysis.entry) return false;
  if (planHermesMcpConfig(after, { ...options, verify: false }).action !== 'unchanged') return false;
  const expected = linesOutsideEntry(before);
  let actual = linesOutsideEntry(after);
  if (!expected || !actual) return false;
  if (!analyzeConfig(before).servers) {
    const serversIndex = actual.lastIndexOf('mcp_servers:');
    if (serversIndex < 0) return false;
    actual = actual.filter((_, index) => index !== serversIndex);
    if (actual.length === expected.length + 1 && actual[actual.length - 1] === '') actual.pop();
  }
  return actual.length === expected.length && actual.every((line, index) => line === expected[index]);
}

// Returns { action: 'unchanged' | 'update' | 'refuse', content?, undo?, reason?, hosted? }.
function planHermesMcpConfig(text, options) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const analysis = analyzeConfig(text);
  if (analysis.error) return { action: 'refuse', reason: analysis.error };
  const { doc } = analysis;
  const lines = [...analysis.lines];
  const trailingNewline = text.length === 0 || /\r?\n$/.test(text);
  if (lines.length > 0 && lines[lines.length - 1] === '' && trailingNewline) lines.pop();
  const detectedUnit = (() => {
    const indented = lines.find((line) => !isBlankOrComment(line) && indentOf(line) > 0);
    return indented ? indentOf(indented) : 2;
  })();
  const undo = [];
  const finish = (next) => {
    const content = `${next.join(eol)}${trailingNewline || next.length !== lines.length ? eol : ''}`;
    if (content === text) return { action: 'unchanged' };
    if (options.verify !== false && !verifyPlanned(text, content, options)) {
      return { action: 'refuse', reason: 'the edited file did not verify' };
    }
    return { action: 'update', content, undo };
  };

  if (!analysis.servers) {
    const separator = lines.length && lines[lines.length - 1].trim() !== '' ? [''] : [];
    const added = ['mcp_servers:', ...renderEntry(detectedUnit, detectedUnit, options)];
    undo.push({ change: 'added', lines: redactUndoLines(added) });
    return finish([...lines, ...separator, ...added]);
  }
  const { servers } = analysis;
  if (servers.emptyInline) {
    const added = ['mcp_servers:', ...renderEntry(detectedUnit, detectedUnit, options)];
    undo.push({ change: 'replaced', replaced: redactUndoLines([lines[servers.line]]), lines: redactUndoLines(added) });
    const next = [...lines];
    next.splice(servers.line, 1, ...added);
    return finish(next);
  }
  const childIndent = analysis.childIndent ?? detectedUnit;
  if (!analysis.entry) {
    const added = renderEntry(childIndent, childIndent, options);
    undo.push({ change: 'added', lines: redactUndoLines(added) });
    const next = [...lines];
    next.splice(servers.end, 0, ...added);
    return finish(next);
  }

  const entry = analysis.entry;
  if (stripComment(entry.rest).trim()) return { action: 'refuse', reason: 'mcp_servers.marrow is not a block mapping' };
  for (let index = entry.line + 1; index < entry.end; index += 1) {
    if (doc.continuation[index]) continue;
    const parsed = keyLine(lines[index]);
    if ((parsed && unsafeValue(parsed.rest)) || /(?:^|\s)[&*][A-Za-z0-9_-]+(?:\s|$)/.test(stripComment(lines[index]))) {
      return { action: 'refuse', reason: 'mcp_servers.marrow uses anchors, aliases, tags or block scalars' };
    }
  }
  const fields = childKeys(doc, entry.line + 1, entry.end);
  if (fields.error) return { action: 'refuse', reason: `mcp_servers.marrow: ${fields.error}` };
  const fieldIndent = fields.childIndent ?? childIndent * 2;
  const unit = Math.max(1, fieldIndent - childIndent);
  const byKey = new Map();
  for (const field of fields.children) {
    if (byKey.has(field.key)) return { action: 'refuse', reason: `duplicate mcp_servers.marrow.${field.key}` };
    byKey.set(field.key, field);
  }
  if (byKey.has('url')) return { action: 'unchanged', hosted: true };

  const replacements = [];
  const inserts = [];
  const pad = ' '.repeat(fieldIndent);
  const command = byKey.get('command');
  if (command && (command.end !== command.line + 1 || scalarValue(command.rest) !== 'npx')) {
    return { action: 'refuse', reason: 'mcp_servers.marrow has a custom command' };
  }
  if (!command) inserts.push(`${pad}command: npx`);
  const args = byKey.get('args');
  const wanted = desiredArgs(options.mcpPackageSpec);
  if (!args) inserts.push(`${pad}args: ${flowList(wanted)}`);
  else {
    const current = readListValue(doc, args);
    if (!current || !current.every((item) => MARROW_ARG_RE.test(item))) {
      return { action: 'refuse', reason: 'mcp_servers.marrow has custom args' };
    }
    if (!sameList(current, wanted)) {
      replacements.push({ start: args.line, end: args.end, lines: [`${pad}args: ${flowList(wanted)}`] });
    }
  }
  const envField = byKey.get('env');
  const envPad = ' '.repeat(fieldIndent + unit);
  if (!envField) {
    inserts.push(`${pad}env:`, `${envPad}MARROW_CLIENT: hermes`);
    if (options.keyReference) inserts.push(`${envPad}MARROW_API_KEY: ${KEY_REFERENCE}`);
  } else {
    const inlineEnv = stripComment(envField.rest).trim();
    if (inlineEnv && inlineEnv !== '{}') return { action: 'refuse', reason: 'mcp_servers.marrow.env is not a block mapping' };
    const envKeys = inlineEnv ? { childIndent: null, children: [] } : childKeys(doc, envField.line + 1, envField.end);
    if (envKeys.error) return { action: 'refuse', reason: `mcp_servers.marrow.env: ${envKeys.error}` };
    for (const variable of envKeys.children) {
      if (variable.end !== variable.line + 1) return { action: 'refuse', reason: 'mcp_servers.marrow.env has multi-line values' };
    }
    const variablePad = ' '.repeat(envKeys.childIndent ?? fieldIndent + unit);
    const names = new Map(envKeys.children.map((variable) => [variable.key, variable]));
    const envLines = [];
    const client = names.get('MARROW_CLIENT');
    if (!client) envLines.push(`${variablePad}MARROW_CLIENT: hermes`);
    else if (scalarValue(client.rest) !== 'hermes') {
      replacements.push({ start: client.line, end: client.end, lines: [`${variablePad}MARROW_CLIENT: hermes`], env: true });
    }
    if (options.keyReference && !names.has('MARROW_API_KEY') && !names.has('MARROW_KEY')) {
      envLines.push(`${variablePad}MARROW_API_KEY: ${KEY_REFERENCE}`);
    }
    if (inlineEnv === '{}') {
      replacements.push({ start: envField.line, end: envField.end, lines: [`${pad}env:`, ...envLines] });
    } else if (envLines.length) {
      replacements.push({ start: envField.end, end: envField.end, lines: envLines, env: true });
    }
  }
  const next = [...lines];
  const ordered = [...replacements].sort((left, right) => right.start - left.start);
  if (inserts.length) ordered.unshift({ start: entry.end, end: entry.end, lines: inserts });
  ordered.sort((left, right) => right.start - left.start || right.end - left.end);
  for (const change of [...ordered].reverse()) {
    const replaced = lines.slice(change.start, change.end);
    undo.push(replaced.length
      ? { change: 'replaced', replaced: redactUndoLines(replaced, change.env === true), lines: redactUndoLines(change.lines, change.env === true) }
      : { change: 'added', lines: redactUndoLines(change.lines, change.env === true) });
  }
  for (const change of ordered) next.splice(change.start, change.end - change.start, ...change.lines);
  return finish(next);
}

// Names only: the owner's values are never read out of the entry.
function marrowEnvKeyNames(text) {
  const analysis = analyzeConfig(String(text || ''));
  if (analysis.error || !analysis.entry) return [];
  const fields = childKeys(analysis.doc, analysis.entry.line + 1, analysis.entry.end);
  const env = fields.error ? null : fields.children.find((field) => field.key === 'env');
  if (!env || stripComment(env.rest).trim()) return [];
  const variables = childKeys(analysis.doc, env.line + 1, env.end);
  return variables.error ? [] : variables.children.map((variable) => variable.key);
}

function hermesEnvHasKey(envPath) {
  try {
    return /^\s*(?:export\s+)?MARROW_API_KEY\s*=\s*\S/m.test(fs.readFileSync(envPath, 'utf8'));
  } catch {
    return false;
  }
}

module.exports = {
  hermesEnvHasKey,
  hermesHome,
  hermesPaths,
  manualBlock,
  marrowEnvKeyNames,
  planHermesMcpConfig,
  redactUndoLines,
};

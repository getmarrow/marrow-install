const fs = require('node:fs');
const path = require('node:path');

// Hermes reads MCP servers from mcp_servers in $HERMES_HOME/config.yaml (default ~/.hermes).
// Stdio servers get only PATH, HOME and a few locale variables plus their own env block, and
// ${VAR} values are resolved from the Hermes environment, including $HERMES_HOME/.env.
//
// This is a deliberately small line editor for one entry, mcp_servers.marrow. It keeps every
// other byte, comment and key in the file. Anything it cannot edit with certainty (tabs,
// anchors, aliases, flow mappings, block scalars, duplicate keys, several documents) is
// refused, and the caller prints the exact block to add by hand.

const SERVER_NAME = 'marrow';
const KEY_REFERENCE = '"${MARROW_API_KEY}"';

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

// Last line index (exclusive) of the block owned by the key at `start`: the next content line
// indented at or below `parentIndent`. Trailing blank and comment lines are left outside.
function blockEnd(lines, start, parentIndent) {
  const owner = keyLine(lines[start]);
  // PyYAML writes a sequence under a key at the key's own indent (`args:` then `- -y`).
  const sameIndentSequence = Boolean(owner && owner.indent === parentIndent && !stripComment(owner.rest).trim());
  let end = start + 1;
  let lastContent = start;
  for (; end < lines.length; end += 1) {
    const line = lines[end];
    if (isBlankOrComment(line)) continue;
    const indent = indentOf(line);
    if (indent < parentIndent) break;
    if (indent === parentIndent && !(sameIndentSequence && /^ *-(?:\s|$)/.test(line))) break;
    lastContent = end;
  }
  return lastContent + 1;
}

function childKeys(lines, start, end) {
  let childIndent = null;
  const children = [];
  for (let index = start; index < end; index += 1) {
    const line = lines[index];
    if (isBlankOrComment(line)) continue;
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
  for (const child of children) {
    child.end = Math.min(blockEnd(lines, child.line, childIndent), end);
  }
  return { childIndent, children };
}

function readListValue(lines, child) {
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
  if (/\t/.test(text.split(/\r?\n/).map((line) => line.match(/^\s*/)[0]).join(''))) {
    return { error: 'tab indentation' };
  }
  const lines = text.split(/\r?\n/);
  if (lines.some((line, index) => (index > 0 && /^---(?:\s|$)/.test(line)) || /^\.\.\.(?:\s|$)/.test(line))) {
    return { error: 'multiple YAML documents' };
  }
  const topLevel = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^(?:"mcp_servers"|'mcp_servers'|mcp_servers)\s*:/.test(line));
  if (topLevel.length > 1) return { error: 'duplicate mcp_servers keys' };
  if (topLevel.length === 0) return { lines, servers: null };
  const serversLine = topLevel[0].index;
  const serversKey = keyLine(lines[serversLine]);
  if (!serversKey) return { error: 'unsupported mcp_servers syntax' };
  const inline = stripComment(serversKey.rest).trim();
  if (inline && !['{}', 'null', '~'].includes(inline)) return { error: 'mcp_servers is not a block mapping' };
  const end = blockEnd(lines, serversLine, 0);
  const servers = { line: serversLine, end, emptyInline: Boolean(inline) };
  if (inline) return { lines, servers, entry: null, childIndent: null };
  const parsed = childKeys(lines, serversLine + 1, end);
  if (parsed.error) return { error: `mcp_servers: ${parsed.error}` };
  const entries = parsed.children.filter((child) => child.key === SERVER_NAME);
  if (entries.length > 1) return { error: 'duplicate mcp_servers.marrow keys' };
  return { lines, servers, entry: entries[0] || null, childIndent: parsed.childIndent };
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

// Returns { action: 'unchanged' | 'update' | 'refuse', content?, reason?, hosted? }.
function planHermesMcpConfig(text, options) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const analysis = analyzeConfig(text);
  if (analysis.error) return { action: 'refuse', reason: analysis.error };
  const lines = [...analysis.lines];
  const trailingNewline = text.length === 0 || /\r?\n$/.test(text);
  if (lines.length > 0 && lines[lines.length - 1] === '' && trailingNewline) lines.pop();
  const detectedUnit = (() => {
    const indented = lines.find((line) => !isBlankOrComment(line) && indentOf(line) > 0);
    return indented ? indentOf(indented) : 2;
  })();
  const finish = (next) => {
    const content = `${next.join(eol)}${trailingNewline || next.length !== lines.length ? eol : ''}`;
    return content === text ? { action: 'unchanged' } : { action: 'update', content };
  };

  if (!analysis.servers) {
    const separator = lines.length && lines[lines.length - 1].trim() !== '' ? [''] : [];
    return finish([...lines, ...separator, 'mcp_servers:', ...renderEntry(detectedUnit, detectedUnit, options)]);
  }
  const { servers } = analysis;
  if (servers.emptyInline) {
    const next = [...lines];
    next.splice(servers.line, 1, 'mcp_servers:', ...renderEntry(detectedUnit, detectedUnit, options));
    return finish(next);
  }
  const childIndent = analysis.childIndent ?? detectedUnit;
  if (!analysis.entry) {
    const next = [...lines];
    next.splice(servers.end, 0, ...renderEntry(childIndent, childIndent, options));
    return finish(next);
  }

  const entry = analysis.entry;
  if (stripComment(entry.rest).trim()) return { action: 'refuse', reason: 'mcp_servers.marrow is not a block mapping' };
  for (let index = entry.line + 1; index < entry.end; index += 1) {
    const parsed = keyLine(lines[index]);
    if ((parsed && unsafeValue(parsed.rest)) || /(?:^|\s)[&*][A-Za-z0-9_-]+(?:\s|$)/.test(stripComment(lines[index]))) {
      return { action: 'refuse', reason: 'mcp_servers.marrow uses anchors, aliases, tags or block scalars' };
    }
  }
  const fields = childKeys(lines, entry.line + 1, entry.end);
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
  if (!command) inserts.push(`${pad}command: npx`);
  else if (command.end !== command.line + 1 || scalarValue(command.rest) !== 'npx') {
    replacements.push({ start: command.line, end: command.end, lines: [`${pad}command: npx`] });
  }
  const args = byKey.get('args');
  const wanted = desiredArgs(options.mcpPackageSpec);
  if (!args) inserts.push(`${pad}args: ${flowList(wanted)}`);
  else if (!sameList(readListValue(lines, args), wanted)) {
    replacements.push({ start: args.line, end: args.end, lines: [`${pad}args: ${flowList(wanted)}`] });
  }
  const envField = byKey.get('env');
  const envPad = ' '.repeat(fieldIndent + unit);
  if (!envField) {
    inserts.push(`${pad}env:`, `${envPad}MARROW_CLIENT: hermes`);
    if (options.keyReference) inserts.push(`${envPad}MARROW_API_KEY: ${KEY_REFERENCE}`);
  } else {
    const inlineEnv = stripComment(envField.rest).trim();
    if (inlineEnv && inlineEnv !== '{}') return { action: 'refuse', reason: 'mcp_servers.marrow.env is not a block mapping' };
    const envKeys = inlineEnv ? { childIndent: null, children: [] } : childKeys(lines, envField.line + 1, envField.end);
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
      replacements.push({ start: client.line, end: client.end, lines: [`${variablePad}MARROW_CLIENT: hermes`] });
    }
    if (options.keyReference && !names.has('MARROW_API_KEY') && !names.has('MARROW_KEY')) {
      envLines.push(`${variablePad}MARROW_API_KEY: ${KEY_REFERENCE}`);
    }
    if (inlineEnv === '{}') {
      replacements.push({ start: envField.line, end: envField.end, lines: [`${pad}env:`, ...envLines] });
    } else if (envLines.length) {
      replacements.push({ start: envField.end, end: envField.end, lines: envLines });
    }
  }
  const next = [...lines];
  const ordered = [...replacements].sort((left, right) => right.start - left.start);
  if (inserts.length) ordered.unshift({ start: entry.end, end: entry.end, lines: inserts });
  ordered.sort((left, right) => right.start - left.start || right.end - left.end);
  for (const change of ordered) next.splice(change.start, change.end - change.start, ...change.lines);
  return finish(next);
}

function entryIsCurrent(text, options) {
  const analysis = analyzeConfig(text);
  if (analysis.error || !analysis.entry) return false;
  return planHermesMcpConfig(text, options).action === 'unchanged';
}

// Names only: the owner's values are never read out of the entry.
function marrowEnvKeyNames(text) {
  const analysis = analyzeConfig(String(text || ''));
  if (analysis.error || !analysis.entry) return [];
  const fields = childKeys(analysis.lines, analysis.entry.line + 1, analysis.entry.end);
  const env = fields.error ? null : fields.children.find((field) => field.key === 'env');
  if (!env || stripComment(env.rest).trim()) return [];
  const variables = childKeys(analysis.lines, env.line + 1, env.end);
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
  entryIsCurrent,
  hermesEnvHasKey,
  hermesHome,
  hermesPaths,
  manualBlock,
  marrowEnvKeyNames,
  planHermesMcpConfig,
};

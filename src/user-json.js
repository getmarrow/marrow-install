'use strict';

// Reading a JSON file the owner or the project owns (settings, hooks and MCP config, a proof file). V8's own SyntaxError
// message can quote about ten characters of the file ("Unexpected token '/', "// sk-abc"... is not valid JSON"), and these
// files hold tokens. A failure therefore reports a fixed sentence, the file path and the line and column of the first
// character V8 rejects, and nothing else: no file text, no V8 message, and the SyntaxError is not kept as a cause.

// V8 messages that give a position end with it; the number is V8's own and is never taken from the file.
const POSITION = / at position (\d+)(?: \(line \d+ column \d+\))?$/;
const CUT_SHORT = 'Unexpected end of JSON input';

// 'position' (a character offset), 'end' (the text is valid JSON that stops early), 'quoted' (V8 quotes the text instead of
// giving a position), or null when the text parses.
function failure(text) {
  try {
    JSON.parse(text);
    return null;
  } catch (error) {
    const reason = error instanceof Error ? String(error.message) : '';
    const at = POSITION.exec(reason);
    if (at) return { kind: 'position', offset: Math.min(Number(at[1]), text.length) };
    return { kind: reason === CUT_SHORT ? 'end' : 'quoted' };
  }
}

// True while no character of `text` has been rejected: it parses, or it is JSON cut short.
const accepted = (text) => {
  const found = failure(text);
  return found === null || found.kind === 'end' || (found.kind === 'position' && found.offset >= text.length);
};

function failureOffset(text) {
  const found = failure(text);
  if (found === null || found.kind === 'end') return text.length;
  if (found.kind === 'position') return found.offset;
  // V8 quoted the text: the shortest prefix it rejects ends with the offending character (every longer prefix is rejected too).
  let low = 1;
  let high = text.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (accepted(text.slice(0, middle))) low = middle + 1; else high = middle;
  }
  return low - 1;
}

// `text` is the whole file; leading and trailing white space and a byte-order mark are ignored, as before.
function parseUserJson(text, filePath) {
  const body = text.trim();
  try {
    return JSON.parse(body);
  } catch {
    const offset = (text.length - text.trimStart().length) + failureOffset(body);
    const before = text.slice(0, offset);
    const line = before.split('\n').length;
    const column = offset - (before.lastIndexOf('\n') + 1) + 1;
    throw new Error(`Invalid JSON in ${filePath} at line ${line}, column ${column} (file text not shown)`);
  }
}

module.exports = { parseUserJson };

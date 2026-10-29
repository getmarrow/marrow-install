require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const { install, printReport } = require('../src/installer');

// FU-4 (installer 0.1.77): a damaged settings, hooks or MCP config file never echoes file text. V8's own JSON.parse message
// can quote about ten characters of the file ("Unexpected token '/', "// zzfixt"... is not valid JSON"), and these files hold
// tokens. A failure reports a fixed sentence, the file path and the line and column, nothing else. Every file below is built
// from runtime dummies (a fixed non-key prefix plus runtime hex); the checks look for ANY six characters of the file text
// in stdout, stderr or the thrown message, also after NFKC folding and with zero-width characters removed.

const BIN = path.join(__dirname, '..', 'bin', 'marrow-install.js');
const NOT_LIVE = /(?:^|[^a-z0-9])(?:sk|pk|rk)_|ghp_|gho_|xox[a-z]-|AKIA|eyJ/;
const hex = (bytes = 16) => crypto.randomBytes(bytes).toString('hex');
const fullWidth = (text) => [...text].map((c) => (c >= '!' && c <= '~' ? String.fromCodePoint(c.codePointAt(0) + 0xFEE0) : c)).join('');
const HOMOGLYPH = { a: '\u0430', e: '\u0435', c: '\u0441', o: '\u043e', i: '\u0456' };
function dummies() {
  const ascii = `zzfixture-${hex()}`;
  const set = {
    ascii,
    fullwidth: fullWidth(`zzfixture-${hex()}`),
    zerowidth: `zzfixture-${hex()}`.replace(/(.{3})/g, '$1\u200b'),
    homoglyph: [...`zzfixture-${hex()}`].map((c) => HOMOGLYPH[c] || c).join(''),
    other: `\u65e5\u672c\u8a9e-\u{1F511}-zzfixture-${hex()}`,
  };
  for (const value of Object.values(set)) assert.doesNotMatch(value.normalize('NFKC'), NOT_LIVE);
  return set;
}
const fold = (text) => text.normalize('NFKC').replace(/[\u200b-\u200f\u2060\ufeff]/g, '');
// true when any six consecutive characters inside one word of `fileText` (a run between JSON punctuation and white space) are in
// `output`, plain, NFKC-folded or with format characters removed. JSON punctuation alone is not file text: a report is JSON too.
const WORDS = /[^\s{}[\]":,'/]+/gu;
function echoes(output, fileText) {
  for (const [out, file] of [[output, fileText], [fold(output), fold(fileText)]]) {
    for (const word of file.match(WORDS) || []) {
      for (let i = 0; i + 6 <= word.length; i += 1) if (out.includes(word.slice(i, i + 6))) return true;
    }
  }
  return false;
}

function workspace() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-noecho-')));
  const home = path.join(base, 'home');
  const project = path.join(base, 'project');
  fs.mkdirSync(home, { mode: 0o700 });
  fs.mkdirSync(project, { mode: 0o700 });
  return { base, home, project, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}
const FILES = {
  user: (ws) => path.join(ws.home, '.claude', 'settings.json'),
  project: (ws) => path.join(ws.project, '.claude', 'settings.json'),
  local: (ws) => path.join(ws.project, '.claude', ['settings', 'local', 'json'].join('.')),
};
function put(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 });
  fs.writeFileSync(file, body, { mode: 0o644 });
}
const options = (ws, extra = {}) => ({
  cwd: ws.project, home: ws.home, mode: 'mcp', selfTest: false, loopGuardSelfTest: false, apiKey: '', baseUrl: 'https://api.getmarrow.ai',
  agentId: 'noecho-agent', controller: false, processCommands: [], mcpRegistryMetadata: null, yes: false, dryRun: true, doctor: false,
  seatbeltStatus: true, seatbeltStatusTimeoutMs: 4000,
  seatbeltStatusCommand: { command: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(`${JSON.stringify({ mode: 'seatbelt', reasons: [] })}\n`)})`] },
  ...extra,
});
async function inProcess(ws, mode) {
  try {
    const report = await install(mode === 'doctor' ? options(ws, { doctor: true, dryRun: false }) : options(ws));
    let text = '';
    printReport(report, (chunk) => { text += chunk; });
    return { threw: null, text: `${text}\n${JSON.stringify(report)}` };
  } catch (error) {
    return { threw: error, text: `${error && error.message}\n${error && error.stack}` };
  }
}
function cli(ws, args) {
  const env = { PATH: process.env.PATH, HOME: ws.home, TMPDIR: process.env.TMPDIR };
  if (process.env.NODE_OPTIONS) env.NODE_OPTIONS = process.env.NODE_OPTIONS;
  const run = spawnSync(process.execPath, [BIN, ...args], { cwd: ws.project, env, encoding: 'utf8', timeout: 90000 });
  return { status: run.status, stdout: run.stdout || '', stderr: run.stderr || '' };
}
const DOCTOR = ['doctor', '--no-self-test', '--no-controller'];
const DRY = ['--dry-run', '--no-self-test', '--no-controller'];

// Independent line and column of a character offset (1-based, counting UTF-16 units, lines split at LF).
function lineColumn(text, offset) {
  const before = text.slice(0, offset);
  return { line: before.split('\n').length, column: offset - (before.lastIndexOf('\n') + 1) + 1 };
}
const message = (file, text, offset) => {
  const { line, column } = lineColumn(text, offset);
  return `Invalid JSON in ${file} at line ${line}, column ${column} (file text not shown)`;
};

// Each case: the file bytes and the offset (in the decoded text) of the first character V8 rejects.
const CASES = {
  'comment-lead': (d, k) => { const t = `// ${d}\n{"${k}":"${d}"}`; return { bytes: t, offset: 0 }; },
  truncated: (d, k) => { const t = `{"${k}":{"K":"${d}`; return { bytes: t, offset: t.length }; },
  'trailing-comma': (d, k) => { const t = `{"${k}":"${d}",}`; return { bytes: t, offset: t.length - 1 }; },
  'tail-garbage': (d, k) => { const t = `{"${k}":"${d}"}${d}`; return { bytes: t, offset: t.length - d.length }; },
  'single-quote': (d, k) => { const t = `{'${k}':'${d}'}`; return { bytes: t, offset: 1 }; },
  'bom-trailing-comma': (d, k) => { const t = `\ufeff{"${k}":"${d}",}`; return { bytes: t, offset: t.length - 1 }; },
  'third-line': (d, k) => { const t = `{\n  "${k}": "${d}",\n  "x": }\n`; return { bytes: t, offset: t.indexOf('}\n') }; },
  'cut-mid-sequence': (d, k) => {
    const head = `{"${k}":"${d}`;
    const bytes = Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from([0xe2, 0x82])]);
    return { bytes, offset: bytes.toString('utf8').length };
  },
};

for (const [name, make] of Object.entries(CASES)) {
  for (const [variant, d] of Object.entries(dummies())) {
    test(`FU-4 CLI, project settings, ${name} / ${variant} dummy: fixed message with path and position, no file text, exit 1`, () => {
      const ws = workspace();
      try {
        const k = `key${hex(6)}`;
        const { bytes, offset } = make(d, k);
        const file = FILES.project(ws);
        put(file, bytes);
        const text = fs.readFileSync(file, 'utf8');
        for (const args of [DOCTOR, DRY]) {
          const run = cli(ws, args);
          assert.equal(run.status, 1, `${args[0]}: exit code`);
          assert.equal(echoes(`${run.stdout}\n${run.stderr}`, text), false, `${args[0]}: file text in the output`);
          assert.equal(run.stdout, '', `${args[0]}: nothing on stdout before the failure`);
          assert.equal(run.stderr, `marrow-install failed: ${message(file, text, offset)}\n`, `${args[0]}: the whole stderr is the fixed message`);
        }
      } finally { ws.cleanup(); }
    });
  }
}

for (const scope of ['user', 'project', 'local']) {
  for (const [name, make] of Object.entries(CASES)) {
    test(`FU-4 in process, ${scope} settings, ${name}: doctor and setup print no file text`, async () => {
      const ws = workspace();
      try {
        const d = dummies().ascii;
        const k = `key${hex(6)}`;
        const { bytes, offset } = make(d, k);
        const file = FILES[scope](ws);
        put(file, bytes);
        const text = fs.readFileSync(file, 'utf8');
        for (const mode of ['doctor', 'setup']) {
          const result = await inProcess(ws, mode);
          assert.equal(echoes(result.text, text), false, `${mode}: file text in the report or error`);
          if (scope === 'project') {
            assert.ok(result.threw, `${mode}: a damaged project settings file still fails loudly`);
            assert.equal(result.threw.message, message(file, text, offset));
            assert.equal(result.threw.cause, undefined, 'the V8 error is not kept as a cause');
          } else {
            assert.equal(result.threw, null, `${mode}: ${scope} settings are read for warnings only`);
            assert.match(result.text, /settings_unreadable|not a JSON object/, `${mode}: the unreadable file is named as a warning`);
          }
        }
      } finally { ws.cleanup(); }
    });
  }
}

// Every settings-read early return: no path prints file text.
const STATES = {
  empty: () => '',
  whitespace: () => ' \n\t\n',
  'bom-only': () => '\ufeff',
  'bom-valid': (d, k) => `\ufeff{"${k}":"${d}"}`,
  array: (d) => `["${d}"]`,
  string: (d) => `"${d}"`,
  'valid-with-secret': (d, k) => `{"env":{"${k}":"${d}"}}`,
};
for (const scope of ['user', 'project', 'local']) {
  for (const [name, make] of Object.entries(STATES)) {
    test(`FU-4 state ${name}, ${scope} settings: no file text in the CLI output, doctor or setup`, async () => {
      const ws = workspace();
      try {
        const d = dummies().ascii;
        const k = `key${hex(6)}`;
        const body = make(d, k);
        put(FILES[scope](ws), body);
        const text = body.replace(/^\ufeff/, '');
        // The CLI runs as a dry run only: `doctor` also starts the isolated loop-guard self-test, which fetches the pinned MCP
        // from the registry. In-process, doctor and setup run with that self-test off.
        const run = cli(ws, DRY);
        assert.equal(echoes(`${run.stdout}\n${run.stderr}`, text), false, 'dry-run: file text in the output');
        if (name === 'array' && scope === 'project') {
          assert.equal(run.status, 1);
          assert.equal(run.stderr, `marrow-install failed: Expected JSON object in ${FILES.project(ws)}\n`);
        }
        for (const mode of ['doctor', 'setup']) assert.equal(echoes((await inProcess(ws, mode)).text, text), false, `${mode}: file text in the report or error`);
      } finally { ws.cleanup(); }
    });
  }
  test(`FU-4 state unreadable (mode 000) and directory, ${scope} settings: no file text in the CLI output, doctor or setup`, { skip: process.getuid() === 0 ? 'root reads mode 000' : false }, async () => {
    for (const shape of ['unreadable', 'directory']) {
      const ws = workspace();
      try {
        const d = dummies().ascii;
        const file = FILES[scope](ws);
        if (shape === 'unreadable') { put(file, `{"K":"${d}"}`); fs.chmodSync(file, 0o000); } else fs.mkdirSync(file, { recursive: true });
        const run = cli(ws, DRY);
        assert.equal(echoes(`${run.stdout}\n${run.stderr}`, `{"K":"${d}"}`), false, `${shape} dry-run`);
        for (const mode of ['doctor', 'setup']) assert.equal(echoes((await inProcess(ws, mode)).text, `{"K":"${d}"}`), false, `${shape} ${mode}`);
      } finally { ws.cleanup(); }
    }
  });
  test(`FU-4 state missing, ${scope} settings: nothing to echo, the dry-run runs`, () => {
    const ws = workspace();
    try {
      assert.equal(cli(ws, DRY).status, 0);
    } finally { ws.cleanup(); }
  });
}

// The position of the first rejected character, by form of V8 message: positional, quoted-token, cut-short.
test('FU-4 parseUserJson positions: positional, quoted-token and cut-short forms, leading space, BOM, multi-byte', () => {
  const { parseUserJson } = require('../src/user-json');
  const rows = [
    ['{"a":}', 5], ['{"a":1,}', 7], ['{', 1], ['', 0], ['nul', 3], ['{"a":"x', 7], ['[1,2', 4], ['{a:1}', 1], ['\u0000{}', 0],
    ['{"a":1}x', 7], ['  \n  {"a":}', 10], ['\ufeff{"a" 1}', 6], ['{"a":"\u00e9\u65e5\u{1F511}",}', 12], ['{"a":-}', 6], ['{"a":tru}', 8], ['[1 2]', 3],
  ];
  for (const [text, offset] of rows) {
    assert.throws(() => parseUserJson(text, '/f.json'), (error) => {
      assert.equal(error.message, message('/f.json', text, offset), JSON.stringify(text));
      assert.equal(error.cause, undefined);
      return true;
    });
  }
  assert.deepEqual(parseUserJson('  \ufeff{"a":[1]}\n', '/f.json'), { a: [1] });
});

test('FU-4 parseUserJson never puts the text or the V8 message in the error', () => {
  const { parseUserJson } = require('../src/user-json');
  const d = dummies();
  for (const value of Object.values(d)) {
    for (const text of [`// ${value}\n{}`, `{"k":"${value}"x`, `{'k':'${value}'}`, `${value}`, `{"k":"${value}`]) {
      try { parseUserJson(text, '/f.json'); assert.fail('parsed'); } catch (error) {
        assert.equal(echoes(`${error.message}\n${error.stack}`, text), false);
        assert.doesNotMatch(error.message, /Unexpected|Expected|Unterminated|not valid JSON/);
      }
    }
  }
});

// The other user-supplied JSON file the CLI reads: a proof file (--proof-file).
test('FU-4 a damaged --proof-file reports the path and the position only', () => {
  const { defaultProof } = require('../src/governed-runner');
  const ws = workspace();
  try {
    for (const [name, make] of Object.entries(CASES)) {
      const { bytes, offset } = make(dummies().ascii, `key${hex(6)}`);
      const file = path.join(ws.base, `proof-${name}.json`);
      fs.writeFileSync(file, bytes);
      const text = fs.readFileSync(file, 'utf8');
      assert.throws(
        () => defaultProof({ options: { proofFile: file, profile: 'default' }, childCommand: ['true'], exitCode: 0, success: true }),
        (error) => { assert.equal(error.message, message(file, text, offset), name); assert.equal(echoes(`${error.message}\n${error.stack}`, text), false); return true; },
      );
    }
  } finally { ws.cleanup(); }
});

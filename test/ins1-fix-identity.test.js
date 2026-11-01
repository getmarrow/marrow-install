require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { install, parseArgs, installSummaryLines } = require('../src/installer');
const {
  dummyKey, keyTag, world, quiet, hostLayout, setup, mcpPath, mcpEnv, readRecord, setEnvBlock, treeHashes, fakeApi,
  printedReport, fixture, statusBody,
} = require('./support/ins1');

// INS-1 T8-T12 (A-MM1..A-MM7) and M2 (G10): `update --fix-identity` reads the key's binding from the live status
// contract (test/fixtures/ins1/STATUS-CONTRACT.md) with the key THAT FILE's MCP server would use, never the runner's.

const RUNNER = 'codex-bob';

function ownerEnv(home, key, baseUrl) {
  fs.mkdirSync(path.join(home, '.marrow'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, '.marrow', 'env'), `MARROW_API_KEY=${key}\nMARROW_BASE_URL=${baseUrl}\n`, { mode: 0o600 });
}
// A home set up with the stale id `cliff` (recorded), the file key in ~/.marrow/env, and the server at `baseUrl`.
async function staleHome(ws, { fileKey, baseUrl, held = 'cliff' }) {
  hostLayout(ws.home);
  await setup(ws.home, { agentId: held, baseUrl });
  if (fileKey) ownerEnv(ws.home, fileKey, baseUrl);
}
function fixRun(home, { runnerKey, baseUrl, shellEnv = {}, extra = {}, argv = ['update', '--fix-identity'] }) {
  const parsed = parseArgs(argv, { HOME: home, PATH: process.env.PATH, MARROW_FLEET_AGENT_ID: RUNNER, ...shellEnv });
  return install({ ...parsed, ...quiet({ cwd: home, home, mode: 'mcp', apiKey: runnerKey || '', baseUrl, statusTimeoutMs: 2000 }), ...extra });
}
const textOf = (report) => (report.identity_stop
  ? `${JSON.stringify(report)}\n${report.identity_stop.lines.join('\n')}`
  : `${JSON.stringify(report)}\n${printedReport(report)}\n${installSummaryLines(report, {}).lines.join('\n')}`);

test('T9: --fix-identity, key bound to one agent (the recorded live fixture): the stale id is switched, recorded and printed old -> new', async () => {
  const ws = world();
  const fileKey = dummyKey();
  const runnerKey = dummyKey();
  const api = await fakeApi({ keys: { [keyTag(fileKey)]: ['cliff-agent'], [keyTag(runnerKey)]: [RUNNER] } });
  try {
    assert.deepEqual(statusBody(['cliff-agent']).data.identity, fixture('status-identity-bound-one.json').identity, 'the fake answers with the recorded shape');
    await staleHome(ws, { fileKey, baseUrl: api.url });
    const report = await fixRun(ws.home, { runnerKey, baseUrl: api.url, shellEnv: { MARROW_API_KEY: runnerKey } });
    assert.equal(report.identity_stop, undefined);
    assert.equal(mcpEnv(ws.home).MARROW_FLEET_AGENT_ID, 'cliff-agent');
    assert.equal(readRecord(ws.home)[mcpPath(ws.home)].MARROW_FLEET_AGENT_ID, 'cliff-agent');
    assert.match(printedReport(report), new RegExp(`reset MARROW_FLEET_AGENT_ID cliff -> cliff-agent in ${mcpPath(ws.home).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(--fix-identity\\)`));
    // M2: the call used the file's key, never the runner's, and carried no agent header.
    const calls = api.statusCalls();
    assert.ok(calls.length >= 1);
    assert.deepEqual([...new Set(calls.map((entry) => entry.tag))], [keyTag(fileKey)]);
    assert.ok(calls.every((entry) => entry.agent === null), 'the status call sent an agent id');
    assert.ok(!api.seen.some((entry) => entry.tag === keyTag(runnerKey)), 'a request carried the runner key');
    assert.ok(!textOf(report).includes(fileKey) && !textOf(report).includes(runnerKey));
    // A second run has nothing left to fix.
    const again = await fixRun(ws.home, { runnerKey, baseUrl: api.url });
    assert.equal(mcpEnv(ws.home).MARROW_FLEET_AGENT_ID, 'cliff-agent');
    assert.ok(!/--fix-identity\)/.test(printedReport(again)));
  } finally { await api.close(); ws.cleanup(); }
});

test('T9: a file with no id set is left alone (the server resolves the key\'s one agent)', async () => {
  const ws = world();
  const fileKey = dummyKey();
  const api = await fakeApi({ keys: { [keyTag(fileKey)]: ['cliff-agent'] } });
  try {
    hostLayout(ws.home);
    await setup(ws.home, { agentId: '', baseUrl: api.url });
    ownerEnv(ws.home, fileKey, api.url);
    await fixRun(ws.home, { baseUrl: api.url });
    assert.equal(mcpEnv(ws.home).MARROW_FLEET_AGENT_ID, undefined);
  } finally { await api.close(); ws.cleanup(); }
});

test('T10: a key bound to several agents: an id in the set is kept; one outside it is refused with the ids listed and nothing changes', async () => {
  const ws = world();
  const fileKey = dummyKey();
  const ids = ['cliff-agent', RUNNER, 'devon'];
  const api = await fakeApi({ keys: { [keyTag(fileKey)]: ids } });
  try {
    await staleHome(ws, { fileKey, baseUrl: api.url, held: 'cliff-agent' });
    const kept = await fixRun(ws.home, { baseUrl: api.url });
    assert.equal(kept.identity_stop, undefined);
    assert.equal(mcpEnv(ws.home).MARROW_FLEET_AGENT_ID, 'cliff-agent', 'an id in the set is kept');
    // C not in the set: refused, never guessed (the runner shell names codex-bob, which is in the set, and is not used).
    setEnvBlock(mcpPath(ws.home), { MARROW_FLEET_AGENT_ID: 'victim' });
    const before = treeHashes(ws.home);
    const refused = await fixRun(ws.home, { baseUrl: api.url });
    assert.equal(refused.identity_stop?.exitCode, 4);
    const line = refused.identity_stop.lines.join('\n');
    assert.match(line, /bound to several agents \(3\)/);
    for (const id of ids) assert.ok(line.includes(id), `${id} listed`);
    assert.match(line, /update --agent-id <id>/);
    assert.deepEqual(treeHashes(ws.home), before, 'a file changed');
    assert.equal(mcpEnv(ws.home).MARROW_FLEET_AGENT_ID, 'victim');
  } finally { await api.close(); ws.cleanup(); }
});

test('T11: an unbound key: nothing changes and the line says the key is not bound', async () => {
  const ws = world();
  const fileKey = dummyKey();
  const api = await fakeApi({ keys: { [keyTag(fileKey)]: [] } });
  try {
    await staleHome(ws, { fileKey, baseUrl: api.url });
    const report = await fixRun(ws.home, { baseUrl: api.url });
    assert.equal(report.identity_stop, undefined);
    assert.equal(mcpEnv(ws.home).MARROW_FLEET_AGENT_ID, 'cliff', 'the recorded id is kept');
    const text = textOf(report);
    assert.match(text, /This key is not bound to an agent; keeping cliff\./);
    assert.ok(!/--fix-identity\)/.test(text));
  } finally { await api.close(); ws.cleanup(); }
});

// ---- T12: every other answer changes nothing, exits 4 and echoes nothing from the body ---------------------------------

const SENTINEL = `echo-sentinel-${crypto.randomBytes(6).toString('hex')}`;
const recorded403 = fixture('status-variants-shape.json').cases.wrong_agent_header;
const ANSWERS = [
  ['401', ({ send }) => send(401, { error: SENTINEL })],
  ['403 (the recorded shape, which names the bound id in its body)', ({ send }) => send(403, { code: recorded403.error_code, error: recorded403.error_code, details: { bound_agent_ids: ['victim-id'], note: SENTINEL } })],
  ['500', ({ send }) => send(500, `boom ${SENTINEL}`)],
  ['timeout', () => {}],
  ['malformed JSON', ({ send }) => send(200, `{"data": ${SENTINEL}`)],
  ['empty body', ({ send }) => send(200, '')],
  ['empty object', ({ send }) => send(200, {})],
  ['data is a string', ({ send }) => send(200, { data: SENTINEL })],
  ['no identity', ({ send }) => send(200, { data: { note: SENTINEL } })],
  ['bound_agent_ids is a string', ({ send }) => send(200, { data: { identity: { bound_agent_ids: 'victim-id', note: SENTINEL } } })],
  ['bound_agent_ids is an object', ({ send }) => send(200, { data: { identity: { bound_agent_ids: { 0: 'victim-id' } } } })],
  ['an id with a space', ({ send }) => send(200, { data: { identity: { bound_agent_ids: ['victim id'] } } })],
  ['an id with shell text', ({ send }) => send(200, { data: { identity: { bound_agent_ids: ['victim;curl evil.example'] } } })],
  ['a Cyrillic look-alike id', ({ send }) => send(200, { data: { identity: { bound_agent_ids: ['сliff-agent'] } } })],
  ['a fullwidth look-alike id', ({ send }) => send(200, { data: { identity: { bound_agent_ids: ['ｃliff-agent'] } } })],
  ['a zero-width id', ({ send }) => send(200, { data: { identity: { bound_agent_ids: ['cliff-agent​'] } } })],
  ['an id over 128 characters', ({ send }) => send(200, { data: { identity: { bound_agent_ids: ['x'.repeat(129)] } } })],
  ['a good id beside a bad one', ({ send }) => send(200, { data: { identity: { bound_agent_ids: ['cliff-agent', 'bad id'] } } })],
  ['ids that are not strings', ({ send }) => send(200, { data: { identity: { bound_agent_ids: [1, null] } } })],
];

for (const [label, answer] of ANSWERS) {
  test(`T12: status answer "${label}": no change, exit 4, nothing from the body echoed`, async () => {
    const ws = world();
    const fileKey = dummyKey();
    const api = await fakeApi({ statusOverride: answer });
    try {
      await staleHome(ws, { fileKey, baseUrl: api.url });
      const before = treeHashes(ws.home);
      const report = await fixRun(ws.home, { baseUrl: api.url, extra: { statusTimeoutMs: 250 } });
      assert.equal(report.identity_stop?.exitCode, 4, label);
      assert.equal(report.identity_stop.lines.length, 1);
      assert.deepEqual(treeHashes(ws.home), before, 'a file changed');
      const text = textOf(report);
      for (const forbidden of [SENTINEL, 'victim', 'evil.example', 'liff-agent', 'cliff-agent', 'x'.repeat(20), fileKey]) {
        assert.ok(!text.includes(forbidden), `the output carried "${forbidden}"`);
      }
      assert.ok(api.statusCalls().every((entry) => entry.agent === null));
    } finally { await api.close(); ws.cleanup(); }
  });
}

// PI1 (audit B1): the redirect row used to send a 302 with no Location, so a followed redirect could not fail it. The 3xx
// now points at a SECOND server that answers a bound body to any request; following it would switch the id to victim-id.
for (const code of [301, 302, 303, 307, 308]) {
  test(`T12: status answer "a redirect" (${code}) to a second server that answers a bound body: no change, exit 4, the second server saw 0 requests`, async () => {
    const ws = world();
    const fileKey = dummyKey();
    const second = await fakeApi({ statusOverride: ({ send }) => send(200, statusBody(['victim-id'])) });
    const first = await fakeApi({ statusOverride: ({ send }) => send(code, '', { location: `${second.url}/v1/agent/status` }) });
    try {
      await staleHome(ws, { fileKey, baseUrl: first.url });
      const before = treeHashes(ws.home);
      const report = await fixRun(ws.home, { baseUrl: first.url });
      assert.equal(report.identity_stop?.exitCode, 4, `${code}`);
      assert.equal(report.identity_stop.lines.length, 1);
      assert.equal(first.statusCalls().length, 1, 'the first server was asked once');
      assert.equal(second.seen.length, 0, `the redirect was followed: ${JSON.stringify(second.seen)}`);
      assert.deepEqual(treeHashes(ws.home), before, 'a file changed');
      const text = textOf(report);
      for (const forbidden of ['victim-id', fileKey, second.url]) assert.ok(!text.includes(forbidden), `the output carried "${forbidden}"`);
    } finally { await first.close(); await second.close(); ws.cleanup(); }
  });
}

test('T12: an http:// or unlisted base URL is refused before the key leaves (no request is made with it)', async () => {
  for (const [label, block, ownerFile] of [
    ['owner key, http:// non-loopback address in the config', { MARROW_BASE_URL: 'http://203.0.113.9' }, true],
    ['owner key, http:// non-loopback URL in the config', { MARROW_BASE_URL: 'http://evil.example' }, true],
    ['owner key, https URL the owner file does not list', { MARROW_BASE_URL: 'https://evil.example' }, true],
    ['owner key, URL with a user name', { MARROW_BASE_URL: 'https://user:pw@api.getmarrow.ai' }, true],
  ]) {
    const ws = world();
    const calls = [];
    try {
      hostLayout(ws.home);
      await setup(ws.home, { agentId: 'cliff', baseUrl: 'https://api.getmarrow.ai' });
      if (ownerFile) ownerEnv(ws.home, dummyKey(), 'https://api.getmarrow.ai');
      setEnvBlock(mcpPath(ws.home), block);
      const before = treeHashes(ws.home);
      const report = await fixRun(ws.home, {
        baseUrl: 'https://api.getmarrow.ai',
        extra: { statusFetch: async (url, init) => { calls.push({ url: String(url), auth: Boolean(init?.headers?.authorization) }); return new Response('{}', { status: 401 }); } },
      });
      assert.equal(report.identity_stop?.exitCode, 4, label);
      assert.ok(calls.every((call) => new URL(call.url).origin === 'https://api.getmarrow.ai'), `${label}: a key went to ${calls.map((call) => call.url)}`);
      assert.ok(!calls.some((call) => /evil\.example/.test(call.url)));
      if (/http:\/\/|user name/.test(label)) assert.equal(calls.length, 0, `${label}: a request was made`);
      assert.deepEqual(treeHashes(ws.home), before);
      assert.ok(!textOf(report).includes('evil.example') || /http:\/\/evil/.test(label) === false);
    } finally { ws.cleanup(); }
  }
});

// ---- M2 (G10): the key each file's MCP server would use ----------------------------------------------------------------

test('M2: a key that can only come from the host environment: --fix-identity exits 4, changes nothing and sends no request (the runner key is never used)', async () => {
  for (const [label, block, line] of [
    ['no key anywhere', {}, /this host's key comes from its own environment/],
    ['a ${PLACEHOLDER} key in the block', { MARROW_API_KEY: '${MARROW_API_KEY}' }, /its MCP config names its own key/],
  ]) {
    const ws = world();
    const runnerKey = dummyKey();
    const api = await fakeApi({ keys: { [keyTag(runnerKey)]: [RUNNER] } });
    try {
      await staleHome(ws, { baseUrl: api.url });
      setEnvBlock(mcpPath(ws.home), block);
      const before = treeHashes(ws.home);
      const report = await fixRun(ws.home, { runnerKey, baseUrl: api.url, shellEnv: { MARROW_API_KEY: runnerKey, MARROW_KEY: runnerKey } });
      assert.equal(report.identity_stop?.exitCode, 4, label);
      assert.match(report.identity_stop.lines.join('\n'), line);
      assert.deepEqual(treeHashes(ws.home), before, 'a file changed');
      assert.equal(api.seen.length, 0, `${label}: a request was made (${JSON.stringify(api.seen)})`);
      assert.notEqual(mcpEnv(ws.home).MARROW_FLEET_AGENT_ID, RUNNER);
    } finally { await api.close(); ws.cleanup(); }
  }
});

test('M2 (PI2): only the owner-file key is checked; a block that names a key, a per-agent key or a per-agent id is not checked at all', async () => {
  const ws = world();
  const blockKey = dummyKey();
  const ownerKey = dummyKey();
  const perIdKey = dummyKey();
  const otherKey = dummyKey();
  const runnerKey = dummyKey();
  const api = await fakeApi({ keys: {
    [keyTag(blockKey)]: ['cliff-agent'], [keyTag(ownerKey)]: ['owner-agent'], [keyTag(perIdKey)]: ['per-id-agent'], [keyTag(otherKey)]: ['other-agent'], [keyTag(runnerKey)]: [RUNNER],
  } });
  try {
    await staleHome(ws, { fileKey: ownerKey, baseUrl: api.url });
    // a block that names no key: the owner-file key is the one the server uses, and the one sent
    await fixRun(ws.home, { runnerKey, baseUrl: api.url });
    assert.deepEqual([...new Set(api.statusCalls().map((entry) => entry.tag))], [keyTag(ownerKey)]);
    assert.equal(mcpEnv(ws.home).MARROW_FLEET_AGENT_ID, 'owner-agent');
    // each of these blocks names its own key or per-agent key: update drops them and the server picks among them by rules
    // this installer does not model, so nothing is sent and nothing changes
    for (const [label, patch] of [
      ['MARROW_API_KEY beside the owner file key', { MARROW_API_KEY: blockKey }],
      ['a per-agent key matched by the id the file names', { MARROW_FLEET_AGENT_ID: 'cliff', MARROW_KEY_CLIFF: perIdKey }],
      ['a per-agent key for another id', { MARROW_FLEET_AGENT_ID: 'cliff', MARROW_KEY_DEVON: otherKey }],
    ]) {
      setEnvBlock(mcpPath(ws.home), { MARROW_BASE_URL: api.url, ...patch });
      api.seen.length = 0;
      const before = treeHashes(ws.home);
      const report = await fixRun(ws.home, { runnerKey, baseUrl: api.url });
      assert.equal(report.identity_stop?.exitCode, 4, label);
      assert.equal(api.seen.length, 0, `${label}: a request was made`);
      assert.deepEqual(treeHashes(ws.home), before, `${label}: a file changed`);
    }
  } finally { await api.close(); ws.cleanup(); }
});

// ---- T8: no identity network without the flag --------------------------------------------------------------------------

test('T8: update does no network for identity unless --fix-identity (no status request without the flag)', async () => {
  const ws = world();
  const fileKey = dummyKey();
  const api = await fakeApi({ keys: { [keyTag(fileKey)]: ['cliff-agent'] } });
  try {
    await staleHome(ws, { fileKey, baseUrl: api.url });
    const parsed = parseArgs(['update'], { HOME: ws.home, PATH: process.env.PATH });
    assert.equal(parsed.fixIdentity, undefined);
    await install({ ...parsed, ...quiet({ cwd: ws.home, home: ws.home, mode: 'mcp', apiKey: dummyKey(), baseUrl: api.url }) });
    assert.equal(api.seen.length, 0, `requests: ${JSON.stringify(api.seen)}`);
    assert.equal(mcpEnv(ws.home).MARROW_FLEET_AGENT_ID, 'cliff', 'no switch without --fix-identity');
  } finally { await api.close(); ws.cleanup(); }
});

test('T-SEC: --fix-identity prints, records and writes no key', async () => {
  const ws = world();
  const fileKey = dummyKey();
  const runnerKey = dummyKey();
  const api = await fakeApi({ keys: { [keyTag(fileKey)]: ['cliff-agent'] } });
  try {
    await staleHome(ws, { fileKey, baseUrl: api.url });
    const before = treeHashes(ws.home);
    const report = await fixRun(ws.home, { runnerKey, baseUrl: api.url });
    const after = treeHashes(ws.home);
    const added = Object.keys(after).filter((name) => !(name in before) && after[name] !== 'dir');
    for (const name of added) {
      const bytes = fs.readFileSync(path.join(ws.home, name));
      assert.ok(!bytes.includes(fileKey) && !bytes.includes(runnerKey), `${name} holds a key`);
      assert.ok(!/\.(bak|orig|undo)$|~$/.test(name));
    }
    assert.ok(!textOf(report).includes(fileKey) && !textOf(report).includes(runnerKey));
    assert.equal(fs.readFileSync(path.join(ws.home, '.marrow', 'env'), 'utf8').includes(fileKey), true, 'the owner file keeps its key');
  } finally { await api.close(); ws.cleanup(); }
});

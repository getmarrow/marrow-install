require('./support/isolated-environment');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const test = require('node:test');
const runner = require('../src/governed-runner');
const { actionBinding } = require('../src/enforcement-client');

// The governed runner turns an action into three security inputs: the redacted text Marrow sees
// and the owner approves, the permit binding (action, type, target), and the local hold key.
// Dummy secrets are generated per run; assertions count them and never print them.
const BIN = path.join(__dirname, '..', 'bin', 'marrow-install.js');
const S1 = `s${crypto.randomBytes(10).toString('hex')}`;
const S2 = `s${crypto.randomBytes(10).toString('hex')}`;
const BASE = { baseUrl: 'http://127.0.0.1:9', agentId: '' };
const SALT = crypto.randomBytes(32);
const C = (...parts) => parts;

function shape(argv, extra = {}) {
  const options = runner.withRedactedInputs({ ...BASE, ...extra });
  const inputs = runner.governedInputs(options, argv);
  return {
    ...inputs,
    holdKey: runner.runnerHoldKey(options, inputs.holdMaterial, SALT),
    binding: actionBinding({ action: inputs.action, type: inputs.type, target: inputs.target }),
  };
}

function secretCount(text) {
  const value = String(text);
  return value.split(S1).length - 1 + value.split(S2).length - 1;
}

function sameBinding(a, b) {
  return a.binding.action_hash === b.binding.action_hash && a.binding.target_hash === b.binding.target_hash && a.binding.action_type === b.binding.action_type;
}

// Rows C1-C15 and M1-M3 are the round-3 audit's collision table; the rest add the forms the
// redaction now covers.
const DIFFERENT = [
  ['C1 query after token', C('curl', '-X', 'POST', `https://ops.example/deploy?token=${S1}&env=staging`), C('curl', '-X', 'POST', `https://ops.example/deploy?token=${S1}&env=production`)],
  ['C2 query after access_token', C('curl', '-X', 'POST', `https://k8s.example/scale?access_token=${S1}&replicas=0`), C('curl', '-X', 'POST', `https://k8s.example/scale?access_token=${S1}&replicas=5`)],
  ['C3 form body after api_key', C('curl', '-d', `api_key=${S1}&sql=DROP`, 'https://db.example/q'), C('curl', '-d', `api_key=${S1}&sql=SELECT`, 'https://db.example/q')],
  ['C4b fragment name= after token', C('curl', `https://ops.example/deploy?token=${S1}#env=prod`), C('curl', `https://ops.example/deploy?token=${S1}#env=staging`)],
  ['C5 comma list after password', C('tool', `--creds=password=${S1},env=production`), C('tool', `--creds=password=${S1},env=staging`)],
  ['C6 && after secret in bash -c', C('bash', '-c', `GH_TOKEN=${S1}&&gh release delete v1`), C('bash', '-c', `GH_TOKEN=${S1}&&gh release view v1`)],
  ['C7 ; after secret', C('bash', '-c', `API_KEY=${S1};kubectl delete ns prod`), C('bash', '-c', `API_KEY=${S1};kubectl get ns prod`)],
  ['C8 Authorization: Bearer header', C('curl', '-H', `Authorization: Bearer ${S1}`, 'https://ops.example/prod/deploy'), C('curl', '-H', `Authorization: Bearer ${S1}`, 'https://ops.example/staging/deploy')],
  ['C9 JSON body', C('curl', '-d', `{"token":"${S1}","env":"production"}`, 'https://ops.example/deploy'), C('curl', '-d', `{"token":"${S1}","env":"staging"}`, 'https://ops.example/deploy')],
  ['C10 env prefix words', C('env', `DEPLOY_TOKEN=${S1}`, 'ENV=production', 'wrangler', 'deploy'), C('env', `DEPLOY_TOKEN=${S1}`, 'ENV=staging', 'wrangler', 'deploy')],
  ['C11 flag after secret flag', C('deploy', `--token=${S1}`, '--env', 'production'), C('deploy', `--token=${S1}`, '--env', 'staging')],
  ['C12 repeated flags', C('deploy', '--env', 'staging', '--env', 'production'), C('deploy', '--env', 'staging')],
  ['C15 mrw_ key then flag', C('curl', `https://x.example/y?k=mrw_live_${S1}&env=production`), C('curl', `https://x.example/y?k=mrw_live_${S1}&env=staging`)],
  ['|| after secret', C('bash', '-c', `GH_TOKEN=${S1}||gh release delete v1`), C('bash', '-c', `GH_TOKEN=${S1}||gh release view v1`)],
  ['pipe after secret', C('bash', '-c', `SECRET=${S1}|kubectl delete -f prod.yaml`), C('bash', '-c', `SECRET=${S1}|kubectl delete -f dev.yaml`)],
  ['single-quoted value then text', C('bash', '-c', `TOKEN='${S1}' wrangler deploy --env production`), C('bash', '-c', `TOKEN='${S1}' wrangler deploy --env staging`)],
  ['YAML line after secret', C('tool', '--config', `password: ${S1}\nenv: production`), C('tool', '--config', `password: ${S1}\nenv: staging`)],
  ['URL userinfo then path', C('psql', `postgres://app:${S1}@db.example/prod`), C('psql', `postgres://app:${S1}@db.example/staging`)],
  ['URL userinfo user', C('psql', `postgres://admin:${S1}@db.example/prod`), C('psql', `postgres://app:${S1}@db.example/prod`)],
  ['X-Api-Key header then URL', C('curl', '-H', `X-Api-Key: ${S1}`, 'https://ops.example/prod'), C('curl', '-H', `X-Api-Key: ${S1}`, 'https://ops.example/staging')],
  ['Basic header then URL', C('curl', '-H', `Authorization: Basic ${S1}`, 'https://ops.example/prod'), C('curl', '-H', `Authorization: Basic ${S1}`, 'https://ops.example/staging')],
  ['--token VALUE then flag', C('deploy', '--token', S1, '--env', 'production'), C('deploy', '--token', S1, '--env', 'staging')],
  ['escaped JSON in bash -c', C('bash', '-c', `curl -d "{\\"token\\":\\"${S1}\\",\\"env\\":\\"prod\\"}" https://x.example`), C('bash', '-c', `curl -d "{\\"token\\":\\"${S1}\\",\\"env\\":\\"dev\\"}" https://x.example`)],
  ['argv split (same joined text)', C('echo', 'a b'), C('echo', 'a', 'b')],
];

test('collision: actions that differ anywhere outside a secret get different hold keys and permit bindings; no secret is sent or keyed', () => {
  for (const [name, a, b] of DIFFERENT) {
    const A = shape(a);
    const B = shape(b);
    assert.notEqual(A.holdKey, B.holdKey, `${name}: hold key`);
    assert.equal(sameBinding(A, B), false, `${name}: permit binding`);
    for (const value of [A.commandText, A.action, A.target, B.commandText, B.action, B.target, JSON.stringify(A.binding), JSON.stringify(B.binding), A.holdKey, B.holdKey]) {
      assert.equal(secretCount(value), 0, `${name}: a secret reached the redacted text, binding or key`);
    }
  }
});

// The value rule (security review, round 4): an unquoted value never ends at # unless `name=`
// follows, so `#prod` after a token is part of the redacted value. The hold key still tells the
// two commands apart (it is keyed on the raw argv); the permit binding does not. A URL fragment
// is never sent by the client, so the two requests are the same on the wire.
test('collision C4: a bare #fragment after a token is redacted with it; the hold key still differs', () => {
  const A = shape(C('curl', `https://ops.example/deploy?token=${S1}#prod`));
  const B = shape(C('curl', `https://ops.example/deploy?token=${S1}#staging`));
  assert.notEqual(A.holdKey, B.holdKey);
  assert.equal(A.commandText, "curl 'https://ops.example/deploy?token=[redacted]'");
  assert.equal(secretCount(JSON.stringify([A.commandText, A.action, A.target, A.binding, A.holdKey, B.commandText, B.action, B.target, B.binding, B.holdKey])), 0);
});

test('collision: --target, --action and --type are part of the hold key and the permit binding, redacted', () => {
  const rows = [
    ['C13 --target after secret', { target: `https://ops.example/deploy?token=${S1}&env=production` }, { target: `https://ops.example/deploy?token=${S1}&env=staging` }],
    ['C14 --action after secret', { action: `deploy with KEY=${S1}&env=production` }, { action: `deploy with KEY=${S1}&env=staging` }],
    ['--type', { type: 'deploy' }, { type: 'general' }],
    ['prose colon is not a secret', { action: 'rotate the key: production first' }, { action: 'rotate the key: staging first' }],
  ];
  for (const [name, a, b] of rows) {
    const A = shape(C('deploy'), a);
    const B = shape(C('deploy'), b);
    assert.notEqual(A.holdKey, B.holdKey, `${name}: hold key`);
    assert.equal(sameBinding(A, B), false, `${name}: permit binding`);
    assert.equal(secretCount(JSON.stringify([A.action, A.target, A.type, B.action, B.target, B.type])), 0, name);
  }
});

test('collision: actions that differ only in the secret value may share a permit binding, and never carry the secret', () => {
  const rows = [
    ['M1 query', C('curl', `https://ops.example/deploy?env=production&token=${S1}`), C('curl', `https://ops.example/deploy?env=production&token=${S2}`)],
    ['M2 env prefix', C('env', `DEPLOY_TOKEN=${S1}`, 'wrangler', 'deploy'), C('env', `DEPLOY_TOKEN=${S2}`, 'wrangler', 'deploy')],
    ['M3 Bearer header', C('curl', '-H', `Authorization: Bearer ${S1}`, 'https://ops.example/deploy'), C('curl', '-H', `Authorization: Bearer ${S2}`, 'https://ops.example/deploy')],
    ['JSON client_secret', C('curl', '-d', `{"client_secret":"${S1}"}`, 'https://x.example'), C('curl', '-d', `{"client_secret":"${S2}"}`, 'https://x.example')],
  ];
  for (const [name, a, b] of rows) {
    const A = shape(a);
    const B = shape(b);
    assert.equal(sameBinding(A, B), true, `${name}: the owner approved the same visible action`);
    assert.equal(A.commandText, B.commandText, name);
    assert.equal(secretCount(JSON.stringify([A.commandText, B.commandText, A.binding, B.binding, A.holdKey, B.holdKey])), 0, name);
  }
});

// Security review (round 4): credential names are matched by containment, with an explicit
// list of non-secret names; values end only before `name=` or a shell operator.
test('redaction: names that contain a credential word are credentials; the listed non-secret names are not', () => {
  for (const name of ['SECRET_KEY_BASE', 'GITHUB_TOKEN_V2', 'X_API_KEY_ID', 'MYTOKEN', 'DB_PASS', 'MYSQL_PWD', 'SLACK_WEBHOOK', 'apiKeyValue', 'OAUTH_TOKEN', 'basic_auth', 'client-secret', 'x.api_key', 'PGPASSWORD', 'Authorization']) {
    const out = runner.redact(`${name}=${S1} next=1`);
    assert.equal(out, `${name}=[redacted] next=1`, name);
  }
  for (const name of ['keyspace', 'max_tokens', 'maxTokens', 'tokenizer', 'monkey', 'author', 'oauth', 'token_count', 'auth_method', 'public_key', 'primary_key', 'env', 'replicas', 'DB_PASSWORD_FILE', '--key-file', 'AUTH_URL', 'KEY_VAULT_NAME', 'bypass', 'PWD']) {
    assert.equal(runner.redact(`${name}=prod-value next=1`), `${name}=prod-value next=1`, name);
  }
});

test('redaction: a secret containing # & , ; or | is redacted whole, and what follows it stays', () => {
  for (const separator of ['#', '&', ',', ';', '|', '#,&;|']) {
    const head = `q${crypto.randomBytes(6).toString('hex')}`;
    const tail = `9${crypto.randomBytes(6).toString('hex')}`;
    const secret = `${head}${separator}${tail}`;
    const cases = [
      [`PASSWORD=${secret} ENV=prod`, 'PASSWORD=[redacted] ENV=prod'],
      [`PASSWORD=${secret}`, 'PASSWORD=[redacted]'],
      [`https://ops.example/q?token=${secret}&env=prod`, 'https://ops.example/q?token=[redacted]&env=prod'],
      [`api_key=${secret}&sql=DROP`, 'api_key=[redacted]&sql=DROP'],
      [`--creds=password=${secret},env=production`, '--creds=password=[redacted],env=production'],
      [`TF_TOKEN=${secret}&&terraform apply`, 'TF_TOKEN=[redacted]&&terraform apply'],
      [`API_KEY=${secret};kubectl delete ns prod`, 'API_KEY=[redacted];kubectl delete ns prod'],
      [`SECRET=${secret}|kubectl delete -f prod.yaml`, 'SECRET=[redacted]|kubectl delete -f prod.yaml'],
      [`--password ${secret} --env prod`, '--password [redacted] --env prod'],
      [`{"password":"${secret}","env":"prod"}`, '{"password":"[redacted]","env":"prod"}'],
      [`password: ${secret}\nenv: prod`, 'password: [redacted]\nenv: prod'],
    ];
    for (const [input, expected] of cases) {
      const output = runner.redact(input);
      assert.equal(output.includes(head) || output.includes(tail), false, `a secret character survived (separator ${JSON.stringify(separator)})`);
      assert.equal(output, expected, `separator ${JSON.stringify(separator)}: ${expected}`);
    }
    // Pairs that differ after the secret keep different keys and bindings.
    const A = shape(C('curl', `https://ops.example/q?token=${secret}&env=staging`));
    const B = shape(C('curl', `https://ops.example/q?token=${secret}&env=production`));
    assert.notEqual(A.holdKey, B.holdKey);
    assert.equal(sameBinding(A, B), false);
  }
});

test('redaction: replaces only the secret value in headers, URLs, JSON, YAML, env and flags, and is stable', () => {
  const cases = [
    [`https://ops.example/deploy?token=${S1}&env=staging`, 'https://ops.example/deploy?token=[redacted]&env=staging'],
    [`Authorization: Bearer ${S1}`, 'Authorization: Bearer [redacted]'],
    [`Authorization: ${S1}`, 'Authorization: [redacted]'],
    [`authorization: Token ${S1} next`, 'authorization: Token [redacted] next'],
    [`curl -d "token=${S1}" https://ops.example/prod`, 'curl -d "token=[redacted]" https://ops.example/prod'],
    [`proxy-authorization: Basic ${S1}`, 'proxy-authorization: Basic [redacted]'],
    [`x Bearer ${S1} y`, 'x Bearer [redacted] y'],
    [`https://user:${S1}@host.example/x`, 'https://user:[redacted]@host.example/x'],
    [`{"password":"${S1}","refresh_token":"${S2}","env":"prod"}`, '{"password":"[redacted]","refresh_token":"[redacted]","env":"prod"}'],
    [`{"apiKey": "${S1}", "access_token": "${S2}"}`, '{"apiKey": "[redacted]", "access_token": "[redacted]"}'],
    [`private_key: ${S1}\nclient_secret: '${S2}'\nenv: prod`, "private_key: [redacted]\nclient_secret: '[redacted]'\nenv: prod"],
    [`authorization=${S1}&next=1`, 'authorization=[redacted]&next=1'],
    [`TF_TOKEN=${S1}&&terraform apply`, 'TF_TOKEN=[redacted]&&terraform apply'],
    [`--token ${S1} --env prod`, '--token [redacted] --env prod'],
    [`basic_auth=${S1}`, 'basic_auth=[redacted]'],
    [`token="${S1}`, 'token=[redacted]'],
    ['x?keyspace=prod&max_tokens=5&oauth=github', 'x?keyspace=prod&max_tokens=5&oauth=github'],
    ['rotate the key: production first', 'rotate the key: production first'],
    ['ssh://git@github.com/o/r', 'ssh://git@github.com/o/r'],
  ];
  for (const [input, expected] of cases) {
    const output = runner.redact(input);
    assert.equal(output, expected, `redact of case ${cases.findIndex((c) => c[0] === input)}`);
    assert.equal(secretCount(output), 0);
    assert.equal(runner.redact(output), output, 'redaction is idempotent');
  }
  assert.equal(runner.redactedCommand(['deploy', '--password', S1, '--env', 'production']), 'deploy --password [redacted] --env production');
});

// Risk is classified on the command as typed (locally) and on its redacted text; the stricter
// verdict wins, so no variant of a protected production command is judged less risky.
test('risk is never looser for production: chained, subshell, pipe, bash -c, variables, repeated and unknown flags, misleading words, secrets glued in front', () => {
  const groups = [
    [C('wrangler', 'deploy', '--env', 'production'), [
      C('bash', '-c', `CLOUDFLARE_API_TOKEN=${S1}&&wrangler deploy --env production`),
      C('bash', '-c', '(cd app && wrangler deploy --env production)'),
      C('bash', '-c', 'yes | wrangler deploy --env production'),
      C('bash', '-c', 'E=production; wrangler deploy --env $E'),
      C('wrangler', '--experimental-x', 'deploy', '--env', 'production'),
      C('bash', '-c', 'echo safe test only; wrangler deploy --env production'),
      C('wrangler', 'deploy', '--env', 'staging', '--env', 'production'),
    ]],
    [C('terraform', 'apply', '-auto-approve'), [
      C('bash', '-c', `TF_TOKEN=${S1}&&terraform apply -auto-approve`),
      C('env', `TF_TOKEN=${S1}`, 'terraform', 'apply', '-auto-approve'),
      C('bash', '-c', 'false || terraform apply -auto-approve'),
      C('bash', '-c', `TF_TOKEN="${S1} x"; terraform apply`),
      C('bash', '-c', `tool --token ${S1} && terraform apply`),
    ]],
    [C('git', 'push', '--force', 'origin', 'main'), [
      C('bash', '-c', `GIT_TOKEN=${S1}&&git push --force origin main`),
      C('bash', '-c', `KEY=${S1};git push --force origin main`),
      C('git', 'push', '--force', '--force', 'origin', 'main'),
      C('git', 'push', '--force', `https://x:${S1}@github.com/o/r`, 'main'),
    ]],
    [C('kubectl', 'apply', '-f', 'prod.yaml'), [
      C('bash', '-c', `KUBE_TOKEN=${S1}&&kubectl apply -f prod.yaml`),
      C('bash', '-c', `H="Authorization: Bearer ${S1}"; kubectl apply -f prod.yaml`),
    ]],
    [C('psql', '-c', 'DROP TABLE users'), [
      C('bash', '-c', `PGPASSWORD=${S1}&&psql -c "DROP TABLE users"`),
      C('curl', '-d', `api_key=${S1}&sql=DROP TABLE users`, 'https://db.example/q'),
    ]],
    [C('npm', 'publish'), [
      C('bash', '-c', `NPM_TOKEN=${S1}&&npm publish`),
      C('bash', '-c', `echo '{"token":"${S1}"}' > .x; npm publish`),
    ]],
  ];
  for (const [baseCommand, variants] of groups) {
    const base = shape(baseCommand);
    assert.equal(base.risky, true, baseCommand.join(' '));
    for (const variant of variants) {
      const v = shape(variant);
      assert.equal(v.risky, true, `looser than ${baseCommand.join(' ')}: ${runner.redactedCommand(variant)}`);
      assert.equal(secretCount(v.commandText), 0);
    }
  }
});

test('risk: a secret that hides the command from the redacted text is still classified on the command as typed', () => {
  // The quoted value runs to its closing quote, so only the raw text shows what follows; the
  // name (PASSWD) is not a risk word itself. Both the risk verdict and the type must hold.
  const removal = runner.governedInputs(runner.withRedactedInputs({ ...BASE, action: `PASSWD="${S1} && rm -rf /srv/data"` }), C('true'));
  assert.equal(secretCount(removal.action), 0);
  assert.equal(removal.action, 'PASSWD="[redacted]"');
  assert.equal(runner.isRisky(`${removal.action} ${removal.commandText}`, 'general'), false, 'the redacted text alone looks harmless');
  assert.equal(removal.risky, true);
  const publish = runner.governedInputs(runner.withRedactedInputs({ ...BASE, action: `PASSWD="${S1} && npm publish"` }), C('true'));
  assert.equal(publish.risky, true);
  assert.equal(publish.type, 'publish', 'the stricter type, from the command as typed');
});

test('hold records: keyed by an HMAC of the raw command, store only that key, and refuse pickup on any mismatch', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-binding-'));
  try {
    const records = runner.holdRecordStore({ home });
    const salt = records.salt();
    assert.equal(fs.existsSync(path.join(home, '.marrow')), false, 'reading the salt creates nothing');
    const optionsA = runner.withRedactedInputs({ ...BASE, target: `https://ops.example/deploy?token=${S1}&env=staging` });
    const optionsB = runner.withRedactedInputs({ ...BASE, target: `https://ops.example/deploy?token=${S1}&env=production` });
    const keyA = runner.runnerHoldKey(optionsA, runner.governedInputs(optionsA, C('deploy')).holdMaterial, salt);
    const keyB = runner.runnerHoldKey(optionsB, runner.governedInputs(optionsB, C('deploy')).holdMaterial, salt);
    assert.match(keyA, /^[0-9a-f]{64}$/);
    assert.notEqual(keyA, keyB);
    const record = { kind: 'ordinary', state: 'waiting', gate_receipt_id: 'gr_binding_0001', session_id: 'marrow-run-test' };
    assert.equal(records.write(keyA, record), true);
    const directory = path.join(home, '.marrow', 'runner-holds');
    const saltFile = path.join(directory, '.salt');
    assert.equal(fs.statSync(saltFile).mode & 0o777, 0o600);
    const stored = JSON.parse(fs.readFileSync(path.join(directory, `${keyA}.json`), 'utf8'));
    assert.equal(stored.version, 2);
    assert.equal(stored.binding, keyA);
    assert.equal(secretCount(fs.readFileSync(path.join(directory, `${keyA}.json`), 'utf8')), 0);
    assert.doesNotMatch(JSON.stringify(stored), /ops\.example|deploy|staging/, 'the record names no action text');
    assert.equal(records.read(keyA).gate_receipt_id, 'gr_binding_0001');
    assert.equal(records.read(keyB), null, 'a different command finds nothing');

    // A record copied under another command's key is refused: its binding names the first.
    fs.copyFileSync(path.join(directory, `${keyA}.json`), path.join(directory, `${keyB}.json`));
    fs.chmodSync(path.join(directory, `${keyB}.json`), 0o600);
    assert.equal(records.read(keyB), null);
    // A record without a binding (the round-3 format) is never picked up.
    const legacy = { ...stored, version: 1 };
    delete legacy.binding;
    fs.writeFileSync(path.join(directory, `${keyA}.json`), JSON.stringify(legacy), { mode: 0o600 });
    assert.equal(records.read(keyA), null);
    assert.equal(records.read('../x'), null);
    assert.equal(records.write('../x', record), false);
    assert.equal(records.claim('../x', 'gr_binding_0001'), false);

    // The same salt is used by the next run; a salt file others can read is replaced on the
    // next write, and a run that cannot keep its salt writes nothing.
    assert.equal(runner.holdRecordStore({ home }).salt().equals(salt), true);
    fs.chmodSync(saltFile, 0o644);
    const next = runner.holdRecordStore({ home });
    const fresh = next.salt();
    assert.equal(fresh.equals(salt), false);
    assert.equal(next.write(keyA, record), true);
    assert.equal(fs.statSync(saltFile).mode & 0o777, 0o600);
    assert.equal(runner.holdRecordStore({ home }).salt().equals(fresh), true);
    fs.rmSync(saltFile);
    const raced = runner.holdRecordStore({ home });
    raced.salt();
    fs.writeFileSync(saltFile, `${crypto.randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
    assert.equal(raced.write(keyB, record), false, 'another run saved a different salt first');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('hold key: the same command always gets the same key under one salt, and another salt gives another key', () => {
  const options = runner.withRedactedInputs({ ...BASE, action: 'deploy production' });
  const material = runner.governedInputs(options, C('wrangler', 'deploy')).holdMaterial;
  assert.equal(runner.runnerHoldKey(options, material, SALT), runner.runnerHoldKey(options, material, SALT));
  assert.notEqual(runner.runnerHoldKey(options, material, SALT), runner.runnerHoldKey(options, material, crypto.randomBytes(32)));
  assert.notEqual(runner.runnerHoldKey(options, material, SALT), runner.runnerHoldKey({ ...options, agentId: 'agent-two' }, material, SALT));
  assert.notEqual(runner.runnerHoldKey(options, material, SALT), runner.runnerHoldKey({ ...options, baseUrl: 'http://127.0.0.1:10' }, material, SALT));
  // Security review F8: the profile, the policy and the API key that runs it are part of it.
  const keyed = { ...options, apiKey: `mrw_test_${crypto.randomBytes(8).toString('hex')}`, profile: 'dev', policy: 'enforce' };
  const base = runner.runnerHoldKey(keyed, material, SALT);
  assert.notEqual(base, runner.runnerHoldKey({ ...keyed, profile: 'production' }, material, SALT));
  assert.notEqual(base, runner.runnerHoldKey({ ...keyed, policy: 'warn' }, material, SALT));
  assert.notEqual(base, runner.runnerHoldKey({ ...keyed, apiKey: `mrw_test_${crypto.randomBytes(8).toString('hex')}` }, material, SALT));
  assert.equal(base, runner.runnerHoldKey({ ...keyed }, material, SALT));
  assert.equal(base.includes(keyed.apiKey), false);
});

async function withServer(handler, fn) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    seen.push({ method: req.method, url: req.url, raw, headers: JSON.stringify(req.headers) });
    const reply = handler(req.url, raw ? JSON.parse(raw) : null, seen);
    res.writeHead(reply.status || 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.json));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, seen);
  } finally {
    server.close();
  }
}

function runCli(args, env, cwd) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.stdin.end();
    child.on('close', (code) => resolve({ code, output }));
  });
}

function filesUnder(directory) {
  const out = [];
  if (!fs.existsSync(directory)) return out;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...filesUnder(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

function heldRuntime(receipt) {
  return {
    risk_gate: { decision: 'review_required', enforced: true, allow: false, gate_required: true, risk_level: 'high', owner_approval_required: true },
    gate_receipt: { id: receipt, required: true, decision: 'review_required', owner_approval_required: true, expires_at: new Date(Date.now() + 30 * 60_000).toISOString() },
    runtime_authorization: { id: receipt, decision_id: `dec_${receipt}`, decision_state: 'created' },
    completion_contract: {
      decision_state: 'created',
      decision_id: `dec_${receipt}`,
      gate_receipt_id: receipt,
      owner_approval_required: true,
      owner_approval: {
        mode: 'ordinary_non_arbitrated',
        approval_status_poll_after_ms: 20,
        host_approval_endpoint: `/v1/agent/gate-receipts/${receipt}/host-approval`,
        host_approval_accepted: true,
        host_approval_refusal_reason: null,
        host_approval_operator_only: false,
        owner_declined_at: null,
        operator_notice: null,
        approval_link_available: false,
        approval_link_reason: null,
        unattended_owner_ping: false,
      },
    },
  };
}

// HIGH-1 end to end: the owner approved `...token=S&env=staging`; `...token=S&env=production`
// must not run on that approval. MEDIUM-2: no request, output or file carries the secret.
test('runner CLI: an approval for one command is never picked up by a command that differs after a secret, and the secret never leaves the process', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-binding-cli-'));
  fs.chmodSync(dir, 0o700);
  const key = `mrw_test_${crypto.randomBytes(16).toString('hex')}`;
  const approved = new Set();
  try {
    await withServer((url, body) => {
      if (url === '/v1/agent/runtime') {
        const receipt = String(body?.target || '').includes('env=production') ? 'gr_binding_prod' : 'gr_binding_stage';
        return { json: { data: heldRuntime(receipt) } };
      }
      const status = url.match(/^\/v1\/agent\/gate-receipts\/([^/]+)\/owner-approval$/);
      if (status) return { json: { data: { state: approved.has(status[1]) ? 'approved' : 'pending', approval_source: 'host_prompt', approval_answered_by: 'host_operator', poll_after_ms: 1000 } } };
      if (url === '/v1/agent/commit') return { json: { data: { committed: true } } };
      return { json: { data: {} } };
    }, async (baseUrl, seen) => {
      const env = { PATH: process.env.PATH, HOME: dir, MARROW_API_KEY: key, MARROW_BASE_URL: baseUrl };
      const command = (environment) => {
        const marker = path.join(dir, `ran-${environment}`);
        const url = `https://ops.example/deploy?token=${S1}&env=${environment}`;
        return {
          marker,
          args: ['run', '--type', 'deploy', '--target', url, '--action', `deploy with KEY=${S1}&env=${environment}`, '--',
            process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`, url],
        };
      };
      const staging = command('staging');
      const production = command('production');
      const runtimeCalls = () => seen.filter((call) => call.url === '/v1/agent/runtime').length;

      const first = await runCli(staging.args, env, dir);
      assert.equal(first.code, 12, first.output);
      assert.equal(runtimeCalls(), 1);
      approved.add('gr_binding_stage');

      const other = await runCli(production.args, env, dir);
      assert.equal(other.code, 12, other.output);
      assert.equal(fs.existsSync(production.marker), false, 'the production command did not run on the staging approval');
      assert.equal(runtimeCalls(), 2, 'the production command asked Marrow for its own decision');

      const again = await runCli(staging.args, env, dir);
      assert.equal(again.code, 0, again.output);
      assert.equal(fs.existsSync(staging.marker), true, 'the approved command picks its approval up');
      assert.equal(runtimeCalls(), 2);

      // The key is made with this machine's private salt: under another salt the same command
      // finds no record and asks Marrow again.
      approved.clear();
      fs.rmSync(staging.marker);
      assert.equal((await runCli(staging.args, env, dir)).code, 12);
      assert.equal(runtimeCalls(), 3);
      const saltFile = path.join(dir, '.marrow', 'runner-holds', '.salt');
      assert.equal(fs.statSync(saltFile).mode & 0o777, 0o600);
      fs.writeFileSync(saltFile, `${crypto.randomBytes(32).toString('hex')}\n`, { mode: 0o600 });
      assert.equal((await runCli(staging.args, env, dir)).code, 12);
      assert.equal(runtimeCalls(), 4, 'another salt, another key: the record is not picked up');

      // MARROW_ACTION_TARGET, gate and permit send redacted text too.
      await runCli(['gate', '--type', 'deploy', `deploy with token=${S1}&env=production`], { ...env, MARROW_ACTION_TARGET: `https://ops.example/x?api_key=${S2}&env=production` }, dir);
      await runCli(['permit', '--type', 'deploy', '--target', `https://user:${S2}@ops.example/x`, '--action', `deploy {"password":"${S1}"}`], env, dir);
      await runCli(['verify-permit', '--permit', 'opaque', '--target', `Authorization: Bearer ${S2}`, '--action', `deploy --token ${S1}`], env, dir);

      const sent = seen.map((call) => `${call.url}\n${call.raw}\n${call.headers}`).join('\n');
      assert.ok(seen.length >= 6);
      assert.equal(secretCount(sent), 0, 'no request carried a dummy secret');
      assert.ok(sent.includes('[redacted]'), 'requests carry the redacted text');
      for (const run of [first, other, again]) assert.equal(secretCount(run.output), 0, 'no output carried a dummy secret');
      for (const file of filesUnder(path.join(dir, '.marrow'))) assert.equal(secretCount(fs.readFileSync(file, 'utf8')), 0, 'no file carried a dummy secret');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// LOW-7: an unknown option is named without its value; a stray value is not echoed at all.
test('unknown arguments: errors print the option name only, never the value after =', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-binding-args-'));
  fs.chmodSync(dir, 0o700);
  try {
    const env = { PATH: process.env.PATH, HOME: dir, MARROW_BASE_URL: 'http://127.0.0.1:9' };
    const runs = [
      [['--tokn=' + S1], /Unknown argument: --tokn\b/],
      [[S2], /Unknown argument: \(a value that is not an option; not shown\)/],
      [['run', '--tokn=' + S1, '--', 'true'], /Unknown option: --tokn\b/],
      [['gate', '--api-kye=' + S2, 'deploy'], /Unknown option: --api-kye\b/],
    ];
    for (const [args, expected] of runs) {
      const result = await runCli(args, env, dir);
      assert.notEqual(result.code, 0);
      assert.match(result.output, expected);
      assert.equal(secretCount(result.output), 0, 'the value was not printed');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// Security review (round 4) F1-F9: glued shell quoting, operators after a secret, names that say
// where a secret is, quadratic regexes, quoted headers and indented YAML, more secret forms, and
// unknown single-dash options.
test('security review: shell quoting glued to a secret is redacted whole, in text and in argv words', () => {
  const head = `q${crypto.randomBytes(5).toString('hex')}`;
  const tail = `q${crypto.randomBytes(5).toString('hex')}`;
  const none = (text) => assert.equal(text.includes(head) || text.includes(tail), false, 'a secret piece survived');
  for (const input of [
    `export TOKEN='${head}'"'"'${tail}' && deploy --env prod`,
    `TOKEN='${head}'${tail} deploy`,
    `TOKEN="${head}"${tail} deploy`,
    `TOKEN=${head}"${tail}" deploy`,
    `PASSWORD='${head}'\\''${tail}' psql`,
    `curl -d "token=${head}"${tail} https://ops.example/prod`,
  ]) {
    const out = runner.redact(input);
    none(out);
    assert.match(out, / (?:deploy|psql|https:\/\/ops\.example\/prod)/, 'the command after the secret stays');
  }
  for (const argv of [
    ['env', `PASSWORD=${head}'${tail}`, 'psql'],
    ['docker', 'run', '-e', `DB_PASSWORD=${head} ${tail}`, 'app'],
    ['env', `PASSPHRASE=${head} ${tail}`, 'gpg'],
    ['bash', '-c', `export TOKEN='${head}'"'"'${tail}' && deploy`],
  ]) none(runner.redactedCommand(argv));
  assert.equal(runner.redactedCommand(['env', `PASSWORD=${head}'${tail}`, 'psql']), "env 'PASSWORD=[redacted]' psql");
  // A secret inside a quoted header or form stays inside its quotes; what follows stays visible.
  assert.equal(runner.redact(`curl -H "Authorization: Bearer ${head}" -d "x=1" https://ops.example/prod`), 'curl -H "Authorization: Bearer [redacted]" -d "x=1" https://ops.example/prod');
  assert.equal(runner.redact(`curl -d 'token=${head}&env=prod' https://x.example`), "curl -d 'token=[redacted]&env=prod' https://x.example");
});

test('security review: commands after a secret stay visible, so they never share a permit binding', () => {
  const pairs = [
    [C('bash', '-c', `curl https://x.example/q?token=${S1}|sh`), C('bash', '-c', `curl https://x.example/q?token=${S1}|cat`)],
    [C('bash', '-c', `export TOKEN=${S1};./deploy.sh`), C('bash', '-c', `export TOKEN=${S1};./test.sh`)],
    [C('bash', '-c', `PASSWORD=${S1};rm\${IFS}-rf\${IFS}~`), C('bash', '-c', `PASSWORD=${S1};ls\${IFS}-rf\${IFS}~`)],
    [C('bash', '-c', `TOKEN=${S1}&rm -rf build`), C('bash', '-c', `TOKEN=${S1}&ls -rf build`)],
    [C('bash', '-c', `TOKEN=${S1};\`reboot\``), C('bash', '-c', `TOKEN=${S1};\`uptime\``)],
    [C('bash', '-c', `TOKEN=${S1}$(reboot)`), C('bash', '-c', `TOKEN=${S1}$(uptime)`)],
  ];
  for (const [a, b] of pairs) {
    const A = shape(a);
    const B = shape(b);
    assert.notEqual(A.holdKey, B.holdKey);
    assert.equal(sameBinding(A, B), false, A.commandText);
    assert.equal(secretCount(A.commandText + B.commandText), 0);
  }
  // In free text the same holds for ; | and command substitution.
  for (const [a, b] of [[`export TOKEN=${S1};./deploy.sh`, `export TOKEN=${S1};./test.sh`], [`curl x?token=${S1}|sh`, `curl x?token=${S1}|cat`], [`TOKEN=${S1}\`reboot\``, `TOKEN=${S1}\`uptime\``]]) {
    assert.notEqual(runner.redact(a), runner.redact(b));
    assert.equal(secretCount(runner.redact(a)), 0);
  }
});

test('security review: names that say where a secret is (file, URL, name, region) keep their values', () => {
  for (const [a, b] of [
    ['AUTH_URL=https://auth.prod.example.com ./migrate.sh', 'AUTH_URL=https://auth.staging.example.com ./migrate.sh'],
    ['gcloud auth activate-service-account --key-file=/keys/prod.json', 'gcloud auth activate-service-account --key-file=/keys/dev.json'],
    ['KEY_VAULT_NAME=prod-vault az keyvault purge', 'KEY_VAULT_NAME=dev-vault az keyvault purge'],
    ['--token-file=/run/prod.token deploy', '--token-file=/run/dev.token deploy'],
  ]) assert.notEqual(runner.redact(a), runner.redact(b), a);
});

test('security review: URL and JWT redaction stays linear on large inputs', () => {
  for (const input of ['a.'.repeat(131072), '-eyJ'.repeat(65536), 'x=1&'.repeat(65536), `PASSWORD=${';a'.repeat(65536)}`, '"a" '.repeat(65536)]) {
    const started = process.hrtime.bigint();
    runner.redact(input);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 2000, `${input.slice(0, 8)}... took ${Math.round(ms)} ms`);
  }
});

test('security review: quoted headers, indented YAML and more secret forms are redacted', () => {
  const cases = [
    [`curl -H "apikey: ${S1}" https://x.example`, 'curl -H "apikey: [redacted]" https://x.example'],
    [`curl -H 'Token: ${S1}' https://x.example`, "curl -H 'Token: [redacted]' https://x.example"],
    [`db:\n  password: ${S1}\n  host: prod\n`, 'db:\n  password: [redacted]\n  host: prod\n'],
    [`tool --github-token ${S1} --env prod`, 'tool --github-token [redacted] --env prod'],
    [`tool --db-password ${S1} --env prod`, 'tool --db-password [redacted] --env prod'],
    [`tool --secret-key ${S1}`, 'tool --secret-key [redacted]'],
    [`curl --user deploy:${S1} https://x.example`, 'curl --user deploy:[redacted] https://x.example'],
    [`curl -u deploy:${S1} https://x.example`, 'curl -u deploy:[redacted] https://x.example'],
    [`openssl pkcs12 -passin pass:${S1} -in a.p12`, 'openssl pkcs12 -passin pass:[redacted] -in a.p12'],
    [`npm config set //registry.example/:_authToken ${S1}`, 'npm config set //registry.example/:_authToken [redacted]'],
    [`aws configure set aws_secret_access_key ${S1}`, 'aws configure set aws_secret_access_key [redacted]'],
    [`DB_PASS=${S1} MYSQL_PWD=${S2} run`, 'DB_PASS=[redacted] MYSQL_PWD=[redacted] run'],
    [`SLACK_WEBHOOK=https://hooks.example/services/${S1} notify`, 'SLACK_WEBHOOK=[redacted] notify'],
    [`curl -u sk_live_${S1}: https://x.example`, 'curl -u [redacted]: https://x.example'],
    [`PASSWORD={${S1}} run`, 'PASSWORD=[redacted] run'],
    [`{"tokens":["${S1}","${S2}"],"env":"prod"}`, '{"tokens":[redacted],"env":"prod"}'],
    [`https://u:${S1}@${S2}@host.example/x`, 'https://u:[redacted]@host.example/x'],
    [`docker login -u ci -p ${S1} registry.example`, 'docker login -u ci -p [redacted] registry.example'],
    [`redis-cli -h prod -a ${S1} FLUSHALL`, 'redis-cli -h prod -a [redacted] FLUSHALL'],
    [`gh secret set DEPLOY --body ${S1} --repo o/r`, 'gh secret set DEPLOY --body [redacted] --repo o/r'],
    [`mysql -u root -p${S1} prod`, 'mysql -u root -p[redacted] prod'],
    ['git push -u origin main', 'git push -u origin main'],
    ['ls -a -p /srv', 'ls -a -p /srv'],
    ['git config set user.name builder', 'git config set user.name builder'],
  ];
  for (const [input, expected] of cases) {
    const output = runner.redact(input);
    assert.equal(output, expected, expected);
    assert.equal(secretCount(output), 0);
    assert.equal(runner.redact(output), output, 'stable');
  }
  for (const [argv, expected] of [
    [['tool', '--github-token', S1, '--env', 'prod'], 'tool --github-token [redacted] --env prod'],
    [['curl', '-u', `deploy:${S1}`, 'https://x.example'], "curl -u 'deploy:[redacted]' https://x.example"],
    [['npm', 'config', 'set', '//registry.example/:_authToken', S1], 'npm config set //registry.example/:_authToken [redacted]'],
    [['npm', 'config', 'set', `//registry.example/:_authToken=${S1}`], "npm config set '//registry.example/:_authToken=[redacted]'"],
    [['openssl', 'pkcs12', '-passin', `pass:${S1}`], "openssl pkcs12 -passin 'pass:[redacted]'"],
    [['docker', 'login', '-u', 'ci', '-p', S1, 'registry.example'], 'docker login -u ci -p [redacted] registry.example'],
    [['redis-cli', '-h', 'prod', '-a', S1, 'FLUSHALL'], 'redis-cli -h prod -a [redacted] FLUSHALL'],
    [['gh', 'secret', 'set', 'DEPLOY', '--body', S1], 'gh secret set DEPLOY --body [redacted]'],
    [['mysql', '-u', 'root', `-p${S1}`, 'prod'], 'mysql -u root -p[redacted] prod'],
    [['ls', '-a', '-p', '/srv'], 'ls -a -p /srv'],
    [['git', 'push', '-u', 'origin', 'main'], 'git push -u origin main'],
  ]) assert.equal(runner.redactedCommand(argv), expected);
});

test('security review: a control sequence cannot hide a credential name, and none is sent', () => {
  const out = runner.redact(`TO\u001b[0mKEN=${S1} deploy`);
  assert.equal(out, 'TOKEN=[redacted] deploy');
  assert.equal(runner.redactedCommand(['env', `API_\u001b[1mKEY=${S1}`, 'deploy']), "env 'API_KEY=[redacted]' deploy");
});

test('security review: an unknown option is named only when it is a plain option name', () => {
  const { argumentLabel } = require('../src/installer');
  assert.equal(argumentLabel('--tokn=abc'), '--tokn');
  assert.equal(argumentLabel('-x'), '-x');
  assert.equal(argumentLabel(`-p${S1}`), '(an option that is not known; not shown)');
  assert.equal(argumentLabel(`-${S1}`), '(an option that is not known; not shown)');
  assert.equal(argumentLabel(`--${S1.toUpperCase()}`), '(an option that is not known; not shown)');
  assert.equal(argumentLabel(S1), '(a value that is not an option; not shown)');
});

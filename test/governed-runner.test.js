const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const test = require('node:test');

const {
  gateDecision,
  actionBinding,
  governPanel,
  buildGovernState,
  buildFleetState,
  canUseInteractive,
  commandForSelection,
  detectProjectSignals,
  fleetPanel,
  headers,
  inferSurfaces,
  inferType,
  isRisky,
  normalizeFleetSnapshot,
  parseArgs,
  redact,
  redactedCommand,
  renderFleetTui,
  renderIntegrationPanel,
  integrationCoverageMatrix,
  localSupportedHarnesses,
  localIntegrationManifest,
  renderGovernTui,
  runGoverned,
  runCli,
  scopedExecutionEnv,
  runGovernInteractive,
  shouldBlock,
  sourceClient,
  sourceMeta,
  statusPanel,
  verifyPermitOnly,
} = require('../src/governed-runner');

test('scoped execution environment replaces Marrow account credentials with the action permit', () => {
  const names = [
    'MARROW_API_KEY',
    'MARROW_KEY',
    'MARROW_KEY_BOB',
    'MARROW_FLEET_API_KEY',
    'MARROW_INTERNAL_KEY',
    'MARROW_TOKEN',
    'MARROW_ACCESS_TOKEN',
    'MARROW_DASHBOARD_TOKEN',
    'MARROW_SIDECAR_TOKEN',
    'MARROW_OWNER_APPROVAL_TOKEN',
    'MARROW_ACTION_PERMIT_SIGNING_KEY',
    'ACTION_PERMIT_SIGNING_KEY',
    'MARROW_AGENT_ID',
    'MARROW_SESSION_ID',
    'MARROW_CLIENT',
    'DEPLOY_TOKEN',
  ];
  const prior = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    MARROW_API_KEY: 'account-secret',
    MARROW_KEY: 'fallback-secret',
    MARROW_KEY_BOB: 'fleet-secret',
    MARROW_FLEET_API_KEY: 'fleet-api-secret',
    MARROW_INTERNAL_KEY: 'internal-secret',
    MARROW_TOKEN: 'token-secret',
    MARROW_ACCESS_TOKEN: 'access-token-secret',
    MARROW_DASHBOARD_TOKEN: 'dashboard-secret',
    MARROW_SIDECAR_TOKEN: 'sidecar-secret',
    MARROW_OWNER_APPROVAL_TOKEN: 'owner-approval-secret',
    MARROW_ACTION_PERMIT_SIGNING_KEY: 'marrow-signing-secret',
    ACTION_PERMIT_SIGNING_KEY: 'signing-secret',
    MARROW_AGENT_ID: 'child-agent',
    MARROW_SESSION_ID: 'child-session',
    MARROW_CLIENT: 'ci',
    DEPLOY_TOKEN: 'task-scoped-secret',
  });
  try {
    const env = scopedExecutionEnv({ permit: 'signed-permit', permit_id: 'permit-one' });
    assert.equal(env.MARROW_API_KEY, undefined);
    assert.equal(env.MARROW_KEY, undefined);
    assert.equal(env.MARROW_KEY_BOB, undefined);
    assert.equal(env.MARROW_FLEET_API_KEY, undefined);
    assert.equal(env.MARROW_INTERNAL_KEY, undefined);
    assert.equal(env.MARROW_TOKEN, undefined);
    assert.equal(env.MARROW_ACCESS_TOKEN, undefined);
    assert.equal(env.MARROW_DASHBOARD_TOKEN, undefined);
    assert.equal(env.MARROW_SIDECAR_TOKEN, undefined);
    assert.equal(env.MARROW_OWNER_APPROVAL_TOKEN, undefined);
    assert.equal(env.MARROW_ACTION_PERMIT_SIGNING_KEY, undefined);
    assert.equal(env.ACTION_PERMIT_SIGNING_KEY, undefined);
    assert.equal(env.MARROW_AGENT_ID, 'child-agent');
    assert.equal(env.MARROW_SESSION_ID, 'child-session');
    assert.equal(env.MARROW_CLIENT, 'ci');
    assert.equal(env.DEPLOY_TOKEN, 'task-scoped-secret');
    assert.equal(env.MARROW_ACTION_PERMIT, 'signed-permit');
    assert.equal(env.MARROW_ACTION_PERMIT_ID, 'permit-one');
    assert.equal(env.MARROW_GOVERNANCE_VERIFIED, 'true');
  } finally {
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('governed runner never starts a protected child when permit verification cannot complete', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-runner-permit-'));
  const marker = path.join(directory, 'executed');
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const pathname = new URL(String(url)).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : {};
    calls.push({ pathname, body });
    if (pathname === '/v1/agent/runtime') {
      return Response.json({ data: {
        risk_gate: { allow: true, decision: 'allow', risk_level: 'high' },
        gate_receipt: { id: 'gate-one', required: true },
        proof_pack: { required: true, required_fields: ['test'] },
      } });
    }
    if (pathname === '/v1/agent/think') {
      return Response.json({ data: { decision_id: 'decision-one' } });
    }
    if (pathname === '/v1/agent/enforcement' && body.operation === 'issue') {
      return Response.json({ error: 'permit service unavailable' }, { status: 503 });
    }
    return Response.json({ data: {} });
  };
  try {
    const parsed = parseArgs([
      'run', '--key', 'test-key', '--agent', 'deploy-agent', '--type', 'deploy',
      '--action', 'deploy production', '--policy', 'enforce', '--fail-open', '--',
      process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
    ]);
    const result = await runGoverned(parsed);
    assert.equal(result.blocked, true);
    assert.equal(result.exitCode, 13);
    assert.equal(fs.existsSync(marker), false);
    const runtime = calls.find((call) => call.pathname === '/v1/agent/runtime').body;
    const think = calls.find((call) => call.pathname === '/v1/agent/think').body;
    const issue = calls.find((call) => call.pathname === '/v1/agent/enforcement' && call.body.operation === 'issue').body;
    assert.equal(runtime.target, issue.target);
    assert.equal(think.target, issue.target);
    assert.deepEqual(runtime.surfaces, issue.surfaces);
    assert.deepEqual(think.surfaces, issue.surfaces);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('server-classified high-risk actions ignore fail-open before permit issuance', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-runner-high-risk-'));
  const marker = path.join(directory, 'executed');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const pathname = new URL(String(url)).pathname;
    if (pathname === '/v1/agent/runtime') {
      return Response.json({ data: {
        risk_gate: { allow: true, decision: 'allow', risk_level: 'high' },
        gate_receipt: { required: false },
      } });
    }
    if (pathname === '/v1/agent/think') {
      return Response.json({ error: 'decision service unavailable' }, { status: 503 });
    }
    return Response.json({ data: {} });
  };
  try {
    const parsed = parseArgs([
      'run', '--key', 'test-key', '--agent', 'general-agent', '--type', 'general',
      '--action', 'inspect current state', '--fail-open', '--',
      process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
    ]);
    const result = await runGoverned(parsed);
    assert.equal(result.blocked, true);
    assert.equal(result.exitCode, 13);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('server-classified low-risk actions remain non-blocking without an action permit', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-runner-low-risk-'));
  const marker = path.join(directory, 'executed');
  const originalFetch = globalThis.fetch;
  let permitCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const pathname = new URL(String(url)).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (pathname === '/v1/agent/runtime') {
      return Response.json({ data: {
        risk_gate: { allow: true, decision: 'allow', risk_level: 'low' },
        gate_receipt: { required: false },
      } });
    }
    if (pathname === '/v1/agent/think') {
      return Response.json({ data: { decision_id: 'decision-low-risk' } });
    }
    if (pathname === '/v1/agent/enforcement' && body.operation === 'issue') {
      permitCalls += 1;
      return Response.json({ error: 'permit service unavailable' }, { status: 503 });
    }
    if (pathname === '/v1/agent/commit') return Response.json({ data: { committed: true } });
    return Response.json({ data: {} });
  };
  try {
    const parsed = parseArgs([
      'run', '--key', 'test-key', '--agent', 'general-agent', '--type', 'general',
      '--action', 'inspect current state', '--fail-open', '--',
      process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
    ]);
    const result = await runGoverned(parsed);
    assert.equal(result.blocked, false);
    assert.equal(result.exitCode, 0);
    assert.equal(result.permit_id, null);
    assert.equal(result.permit_verified, false);
    assert.equal(permitCalls, 0);
    assert.equal(fs.existsSync(marker), true);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('governed runner never starts a protected child when permit verification is not exactly true', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-runner-verify-'));
  const marker = path.join(directory, 'executed');
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const pathname = new URL(String(url)).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : {};
    calls.push({ pathname, body });
    if (pathname === '/v1/agent/runtime') {
      return Response.json({ data: {
        risk_gate: { allow: true, decision: 'allow', risk_level: 'high' },
        gate_receipt: { id: 'gate-one', required: true },
      } });
    }
    if (pathname === '/v1/agent/think') {
      return Response.json({ data: { decision_id: 'decision-one' } });
    }
    if (pathname === '/v1/agent/enforcement' && body.operation === 'issue') {
      return Response.json({ data: { permit: 'opaque-permit', permit_id: 'permit-one' } });
    }
    if (pathname === '/v1/agent/enforcement' && body.operation === 'verify') {
      return Response.json({ data: { verified: 'true' } });
    }
    return Response.json({ data: {} });
  };
  try {
    const parsed = parseArgs([
      'run', '--key', 'test-key', '--agent', 'deploy-agent', '--type', 'deploy',
      '--action', 'deploy production', '--policy', 'enforce', '--fail-open', '--',
      process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
    ]);
    const result = await runGoverned(parsed);
    assert.equal(result.blocked, true);
    assert.equal(result.exitCode, 13);
    assert.equal(fs.existsSync(marker), false);
    const issue = calls.find((call) => call.pathname === '/v1/agent/enforcement' && call.body.operation === 'issue').body;
    const verify = calls.find((call) => call.pathname === '/v1/agent/enforcement' && call.body.operation === 'verify').body;
    assert.deepEqual(issue.surfaces, verify.surfaces);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('verify-permit fails unless the service returns verified exactly true', async () => {
  const originalFetch = globalThis.fetch;
  const originalExitCode = process.exitCode;
  let verifiedValue = 'true';
  globalThis.fetch = async () => Response.json({ data: { verified: verifiedValue } });
  try {
    const parsed = parseArgs([
      'verify-permit', '--key', 'test-key', '--permit', 'opaque-permit',
      '--type', 'deploy', '--action', 'deploy production',
    ]);
    const result = await verifyPermitOnly(parsed);
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 14);

    process.exitCode = 0;
    await runCli([
      'verify-permit', '--key', 'test-key', '--permit', 'opaque-permit',
      '--type', 'deploy', '--action', 'deploy production', '--json',
    ]);
    assert.equal(process.exitCode, 14);

    verifiedValue = true;
    const verifiedResult = await verifyPermitOnly(parsed);
    assert.equal(verifiedResult.ok, true);
    assert.equal(verifiedResult.exitCode, 0);
  } finally {
    globalThis.fetch = originalFetch;
    process.exitCode = originalExitCode;
  }
});

test('parseArgs supports governed command execution after --', () => {
  const parsed = parseArgs([
    'run',
    '--agent',
    'deploy-agent',
    '--type',
    'deploy',
    '--policy',
    'enforce',
    '--',
    'wrangler',
    'deploy',
  ]);

  assert.equal(parsed.command, 'run');
  assert.equal(parsed.options.agentId, 'deploy-agent');
  assert.equal(parsed.options.type, 'deploy');
  assert.equal(parsed.options.policy, 'enforce');
  assert.deepEqual(parsed.childCommand, ['wrangler', 'deploy']);
});

test('permit and verifier commands bind action, target, session, and agent without exposing credentials', () => {
  const permit = parseArgs([
    'permit',
    '--agent',
    'deploy-agent',
    '--session',
    'release-42',
    '--type',
    'deploy',
    '--target',
    'getmarrow/marrow:production',
    '--action',
    'deploy audited release',
  ]);
  assert.equal(permit.command, 'permit');
  assert.equal(permit.options.agentId, 'deploy-agent');
  assert.equal(permit.options.target, 'getmarrow/marrow:production');

  const verify = parseArgs([
    'verify-permit',
    '--permit',
    'opaque-short-lived-token',
    '--target',
    'getmarrow/marrow:production',
    '--action',
    'deploy audited release',
  ]);
  assert.equal(verify.command, 'verify-permit');
  assert.equal(verify.options.permit, 'opaque-short-lived-token');

  const binding = actionBinding({
    action: 'deploy audited release',
    type: 'deploy',
    target: 'getmarrow/marrow:production',
  });
  assert.match(binding.action_hash, /^[a-f0-9]{64}$/);
  assert.match(binding.target_hash, /^[a-f0-9]{64}$/);
  assert.equal(binding.target, 'getmarrow/marrow:production');
  assert.notEqual(binding.action_hash, binding.target_hash);
});

test('coverage, sidecar, and controller commands are first-class governed surfaces', () => {
  assert.equal(parseArgs(['coverage', '--agent', 'bob']).command, 'coverage');
  const sidecar = parseArgs(['sidecar', '--sidecar-port', '43821']);
  assert.equal(sidecar.command, 'sidecar');
  assert.equal(sidecar.options.sidecarPort, '43821');
  const controller = parseArgs(['controller', 'ensure', '--agent', 'bob', '--policy', 'warn']);
  assert.equal(controller.command, 'controller');
  assert.equal(controller.action, 'ensure');
  assert.equal(controller.options.agentId, 'bob');
  assert.equal(controller.options.policy, 'warn');
});

test('redacts API keys and tokens from command text', () => {
  const value = redact('MARROW_API_KEY=mrw_live_secret npm_token=npm_abcdef ghp_deadbeef sk-test');
  assert.doesNotMatch(value, /mrw_live_secret/);
  assert.doesNotMatch(value, /npm_abcdef/);
  assert.doesNotMatch(value, /ghp_deadbeef/);
  assert.doesNotMatch(value, /sk-test/);

  const command = redactedCommand(['curl', '-H', 'Authorization: Bearer mrw_live_secret', 'https://api.getmarrow.ai']);
  assert.doesNotMatch(command, /mrw_live_secret/);
  assert.match(command, /\[redacted\]/);
});

test('infers type and surfaces for common risky actions', () => {
  assert.equal(inferType('wrangler deploy production worker'), 'deploy');
  assert.equal(inferType('npm publish @getmarrow/sdk'), 'publish');
  assert.equal(inferType('gh pr merge 12'), 'merge');
  assert.deepEqual(inferSurfaces('wrangler deploy after gh pr merge'), ['github', 'cloudflare']);
});

test('global-option and infrastructure command forms remain protected', () => {
  const cases = [
    ['git -C /workspace push origin master', 'merge'],
    ['kubectl --context production apply -f deployment.yaml', 'deploy'],
    ['terraform -chdir=infra apply -auto-approve', 'deploy'],
    ['npm unpublish @example/package@1.0.0', 'publish'],
    ['wrangler d1 execute app --remote --file migration.sql', 'deploy'],
    ['curl -X DELETE https://api.github.com/repos/acme/app', 'general'],
    ['gh api repos/acme/app/hooks/1 --method DELETE', 'general'],
    ['psql "$DATABASE_URL" -c "DELETE FROM jobs"', 'general'],
    ['redis-cli -u "$REDIS_URL" FLUSHDB', 'general'],
    ['aws s3 rm s3://bucket/artifact.tar.gz', 'general'],
    ['kubectl drain node-1 --ignore-daemonsets', 'deploy'],
    ['vault kv put secret/app token=value', 'security'],
    ['cargo yank --vers 1.0.0 package', 'general'],
    ['npm token delete token-id', 'security'],
    ['npm access grant read-only scope:team package', 'general'],
    ['yarn npm tag add @example/package latest', 'general'],
    ['git branch -D stale-release', 'deploy'],
    ['git remote set-url origin https://example.invalid/repo.git', 'general'],
    ['gh pr close 42', 'general'],
    ['gh api repos/acme/app/hooks -f active=true', 'general'],
    ['kubectl --context ' + 'production-'.repeat(30) + ' apply -f deployment.yaml', 'deploy'],
    ['oc auth reconcile -f rbac.yaml', 'general'],
    ['terragrunt apply -auto-approve', 'general'],
    ['pulumi config set db.password secret', 'deploy'],
    ['curl -T artifact.tar.gz https://uploads.example.invalid/artifact', 'general'],
    ['wget --post-data key=value https://example.invalid/write', 'security'],
    ['http --auth-type bearer https://example.invalid/items name=value', 'general'],
    ['sqlite3 app.db < migration.sql', 'migration'],
    ['redis-cli UNLINK cache-key', 'security'],
    ['aws s3 cp artifact.tar.gz s3://bucket/artifact.tar.gz', 'general'],
    ['aws ssm put-parameter --name /app/key --value secret', 'security'],
    ['gcloud storage cp artifact.tar.gz gs://bucket/artifact.tar.gz', 'general'],
    ['az storage blob upload --file artifact.tar.gz --container-name releases', 'general'],
    ['rclone copy artifact.tar.gz remote:releases', 'general'],
    ['op item share production-credential', 'deploy'],
    ['rm -rf generated-release', 'deploy'],
    ['npm login', 'general'],
    ['git worktree remove scratch-copy', 'general'],
    ['gh run cancel 12345', 'general'],
    ['kubectl certificate approve agent-csr', 'deploy'],
    ['terraform state replace-provider old/provider new/provider', 'deploy'],
    ['curl --json {"enabled":true} https://example.invalid/items', 'general'],
    ['curl --data-ascii enabled=true https://example.invalid/items', 'general'],
    ["psql --command 'CALL rotate_cache()' appdb", 'general'],
    ['redis-cli EVALSHA abcdef123456 0', 'general'],
    ['gcloud storage rsync ./dist gs://example-bucket/releases', 'general'],
    ['op item move shared-item archive-vault', 'general'],
    ['/usr/bin/rm -rf generated-cache', 'general'],
    ['kubectl --context ' + 'ctxvalue-'.repeat(1200) + ' apply -f manifest.yaml', 'deploy'],
  ];
  for (const [command, expectedType] of cases) {
    assert.equal(inferType(command), expectedType);
    assert.equal(isRisky(command, inferType(command)), true);
  }
});

test('git global-option push fails closed before child execution when governance is unavailable', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-runner-git-options-'));
  const marker = path.join(directory, 'executed');
  const fakeGit = path.join(directory, 'git');
  const originalFetch = globalThis.fetch;
  fs.writeFileSync(fakeGit, `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`, { mode: 0o700 });
  globalThis.fetch = async () => { throw new Error('governance unavailable'); };
  try {
    const parsed = parseArgs([
      'run', '--key', 'test-key', '--agent', 'release-agent', '--policy', 'enforce', '--fail-open', '--',
      fakeGit, '-C', '/workspace', 'push', 'origin', 'master',
    ]);
    const result = await runGoverned(parsed);
    assert.equal(result.blocked, true);
    assert.equal(result.exitCode, 13);
    assert.equal(result.risky, true);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('adjacent protected command forms never start a child during a governance outage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-runner-adjacent-'));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('governance unavailable'); };
  const cases = [
    ['git', ['branch', '-D', 'stale-release']],
    ['curl', ['-T', 'artifact.tar.gz', 'https://uploads.example.invalid/artifact']],
    ['aws', ['s3', 'cp', 'artifact.tar.gz', 's3://bucket/artifact.tar.gz']],
    ['kubectl', ['--context', 'production-'.repeat(30), 'apply', '-f', 'deployment.yaml']],
    ['npm', ['login']],
    ['git', ['worktree', 'remove', 'scratch-copy']],
    ['gh', ['run', 'cancel', '12345']],
    ['kubectl', ['certificate', 'approve', 'agent-csr']],
    ['terraform', ['state', 'replace-provider', 'old/provider', 'new/provider']],
    ['curl', ['--json', '{"enabled":true}', 'https://example.invalid/items']],
    ['psql', ['--command', 'CALL rotate_cache()', 'appdb']],
    ['redis-cli', ['EVALSHA', 'abcdef123456', '0']],
    ['gcloud', ['storage', 'rsync', './dist', 'gs://example-bucket/releases']],
    ['op', ['item', 'move', 'shared-item', 'archive-vault']],
    ['rm', ['-rf', 'generated-cache']],
    ['kubectl', ['--context', 'ctxvalue-'.repeat(1200), 'apply', '-f', 'manifest.yaml']],
    ['npm', ['profile', 'enable-2fa', 'auth-only']],
    ['gh', ['repo', 'fork', 'acme/app', '--clone=false']],
    ['flux', ['reconcile', 'source', 'git', 'platform']],
    ['nomad', ['job', 'run', 'platform.nomad']],
    ['cdk', ['deploy', 'PlatformStack']],
    ['ansible-playbook', ['deploy.yml']],
    ['curl', ['--form-string', 'name=value', 'https://example.invalid/items']],
    ['wget', ['--body-data', 'enabled=true', 'https://example.invalid/items']],
    ['redis-cli', ['FUNCTION', 'LOAD', 'REPLACE', '#!lua name=lib']],
    ['gsutil', ['cp', 'artifact.tar.gz', 'gs://example-bucket/releases/']],
    ['mc', ['cp', 'artifact.tar.gz', 'production/releases/']],
    ['oci', ['os', 'object', 'put', '--bucket-name', 'releases', '--file', 'artifact.tar.gz']],
    ['pass', ['insert', 'production/token']],
    ['unlink', ['generated-cache/file']],
    ['xargs', ['/bin/rm']],
    ['dd', ['if=/dev/zero', 'of=generated-cache/image.bin', 'bs=1', 'count=1']],
    ['git', ['-c', 'credential.helper=x'.repeat(600), 'push', 'origin', 'master']],
  ];
  try {
    for (const [index, [name, args]] of cases.entries()) {
      const directory = path.join(root, `${index}-${name}`);
      fs.mkdirSync(directory);
      const marker = path.join(directory, 'executed');
      const executable = path.join(directory, name);
      fs.writeFileSync(
        executable,
        '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(' + JSON.stringify(marker) + ', "ran");\n',
        { mode: 0o700 },
      );
      const parsed = parseArgs([
        'run', '--key', 'test-key', '--agent', 'release-agent',
        '--policy', 'enforce', '--fail-open', '--', executable, ...args,
      ]);
      const result = await runGoverned(parsed);
      assert.equal(result.blocked, true, name);
      assert.equal(result.exitCode, 13, name);
      assert.equal(result.risky, true, name);
      assert.equal(fs.existsSync(marker), false, name);
    }
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('gateDecision extracts receipt and shouldBlock enforces owner approval', () => {
  const runtime = {
    risk_gate: {
      enforcement_decision: 'owner_approval_required',
      allow: true,
      gate_receipt_id: 'gate_123',
    },
    gate_receipt: {
      id: 'gate_123',
      required: true,
      owner_approval_required: true,
      exact_fix: 'Get owner approval before deploy.',
    },
  };
  const decision = gateDecision(runtime);
  assert.equal(decision.receiptId, 'gate_123');
  assert.equal(decision.ownerApprovalRequired, true);
  assert.equal(shouldBlock(decision, { policy: 'enforce', ownerApproval: '' }), true);
  assert.equal(shouldBlock(decision, { policy: 'enforce', ownerApproval: 'buu-approved' }), false);
  assert.equal(shouldBlock(decision, { policy: 'warn', ownerApproval: '' }), false);
});

test('governPanel presents harness selection without becoming a model host', () => {
  const panel = governPanel({ agentId: 'codex-bob', profile: 'production', policy: 'enforce' });
  assert.match(panel, /Marrow Governed Runner/);
  assert.match(panel, /Codex/);
  assert.match(panel, /Claude Code/);
  assert.match(panel, /Cursor/);
  assert.match(panel, /Cursor Composer/);
  assert.match(panel, /Windsurf/);
  assert.match(panel, /Gemini CLI/);
  assert.match(panel, /CI script/);
  assert.match(panel, /Custom command/);
  assert.match(panel, /Marrow governs the action before it executes/);
  assert.match(panel, /npx @getmarrow\/install run --agent codex-bob/);
});

test('local integration registry covers major harnesses and model CLIs', () => {
  const supported = localSupportedHarnesses();
  const labels = supported.map((item) => item.client_label);

  assert.ok(labels.includes('codex'));
  assert.ok(labels.includes('claude-code'));
  assert.ok(labels.includes('cursor'));
  assert.ok(labels.includes('composer'));
  assert.ok(labels.includes('windsurf'));
  assert.ok(labels.includes('cline'));
  assert.ok(labels.includes('hermes'));
  assert.ok(labels.includes('openclaw'));
  assert.ok(labels.includes('gemini'));
  assert.ok(labels.includes('grok'));
  assert.ok(labels.includes('deepseek'));
  assert.ok(labels.includes('qwen'));
  assert.ok(labels.includes('kimi'));
  assert.ok(labels.includes('minimax'));
  assert.ok(labels.includes('glm'));
  assert.ok(labels.includes('mcp'));
  assert.ok(labels.includes('ci'));
  assert.ok(labels.includes('custom'));
});

test('governed runner attaches stable client attribution from env and CLI', () => {
  const originalClient = process.env.MARROW_CLIENT;
  const originalHarness = process.env.MARROW_HARNESS;
  const originalAgentClient = process.env.MARROW_AGENT_CLIENT;
  try {
    delete process.env.MARROW_HARNESS;
    delete process.env.MARROW_AGENT_CLIENT;
    process.env.MARROW_CLIENT = 'Qwen CLI';
    const envParsed = parseArgs(['run', '--agent', 'qwen-agent', '--', 'qwen', 'chat']);
    assert.equal(envParsed.options.client, 'qwen');
    assert.equal(sourceClient(envParsed.options.client), 'qwen');
    assert.equal(headers(envParsed.options)['X-Marrow-Client'], 'qwen');
    assert.equal(headers(envParsed.options)['X-Marrow-Package'], '@getmarrow/install');
    assert.equal(headers(envParsed.options)['X-Marrow-Package-Version'], '0.1.37');

    const cliParsed = parseArgs(['run', '--client', 'Hermes', '--agent', 'hermes-agent', '--', 'hermes', '/goal']);
    const meta = sourceMeta(cliParsed.options, 'runtime', {
      action: 'run Hermes goal',
      command: 'hermes /goal',
    });
    assert.equal(cliParsed.options.client, 'hermes');
    assert.equal(meta.channel, 'runtime');
    assert.equal(meta.client, 'hermes');
    assert.equal(meta.harness, 'hermes');
    assert.equal(meta.agent_id, 'hermes-agent');
    assert.equal(meta.command, 'hermes /goal');
  } finally {
    if (originalClient === undefined) delete process.env.MARROW_CLIENT;
    else process.env.MARROW_CLIENT = originalClient;
    if (originalHarness === undefined) delete process.env.MARROW_HARNESS;
    else process.env.MARROW_HARNESS = originalHarness;
    if (originalAgentClient === undefined) delete process.env.MARROW_AGENT_CLIENT;
    else process.env.MARROW_AGENT_CLIENT = originalAgentClient;
  }
});

test('detectProjectSignals finds deploy and Cloudflare project evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-govern-signals-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'marrow-api',
    scripts: { deploy: 'wrangler deploy', test: 'vitest run' },
    devDependencies: { wrangler: '^4.0.0' },
  }));
  fs.writeFileSync(path.join(dir, 'wrangler.toml'), 'name = "marrow-api"\n');
  fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });

  const signals = detectProjectSignals(dir);
  assert.equal(signals.name, 'marrow-api');
  assert.equal(signals.type, 'node');
  assert.ok(signals.frameworks.includes('cloudflare-workers'));
  assert.ok(signals.signals.includes('package_json'));
  assert.ok(signals.signals.includes('wrangler_config'));
  assert.ok(signals.signals.includes('github_actions'));
  assert.ok(signals.signals.includes('script:deploy'));
});

test('govern interactive options are parsed and non-tty stays text-safe', () => {
  const interactive = parseArgs(['govern', '--interactive']);
  assert.equal(interactive.options.interactive, true);

  const nonInteractive = parseArgs(['govern', '--no-interactive']);
  assert.equal(nonInteractive.options.interactive, false);

  assert.equal(canUseInteractive({ interactive: false }, { isTTY: true }, { isTTY: true }), false);
  assert.equal(canUseInteractive({ interactive: true }, { isTTY: false }, { isTTY: true }), false);
  assert.equal(canUseInteractive({ interactive: null }, { isTTY: true }, { isTTY: true }), true);
});

test('fleet command parses operator TUI options', () => {
  const parsed = parseArgs(['fleet', '--no-interactive', '--json']);
  assert.equal(parsed.command, 'fleet');
  assert.equal(parsed.options.interactive, false);
  assert.equal(parsed.options.json, true);
});

test('Hermes and OpenClaw add-on commands parse through governed runner', () => {
  const hermes = parseArgs(['hermes', '--no-interactive']);
  const openclaw = parseArgs(['openclaw', '--json']);
  const integrations = parseArgs(['integrations']);

  assert.equal(hermes.command, 'hermes');
  assert.equal(openclaw.command, 'openclaw');
  assert.equal(openclaw.options.json, true);
  assert.equal(integrations.command, 'integrations');
});

test('integration coverage matrix names exact lifecycle and repair limits for every harness', () => {
  const matrix = integrationCoverageMatrix();
  assert.ok(matrix.length >= 16);
  const claude = matrix.find((entry) => entry.harness === 'claude-code');
  const cursor = matrix.find((entry) => entry.harness === 'cursor');
  const hermes = matrix.find((entry) => entry.harness === 'hermes');
  assert.equal(claude.pre_action, 'automatic_native_hook');
  assert.equal(claude.proof_enforcement, 'automatic_for_protected_actions');
  assert.equal(claude.automatic_repair, 'installer_managed_config_only');
  assert.equal(cursor.pre_action, 'mcp_routed');
  assert.equal(cursor.automatic_repair, 'installer_managed_config_only');
  assert.match(cursor.limitation, /MCP client/);
  assert.equal(hermes.outcome_closure, 'adapter_required');
  assert.equal(hermes.automatic_repair, 'adapter_owned');
  assert.equal(matrix.find((entry) => entry.harness === 'ci').pre_action, 'automatic_in_governed_runner');
  assert.equal(matrix.find((entry) => entry.harness === 'mcp').pre_action, 'mcp_routed');
  for (const entry of matrix) {
    for (const field of ['pre_action', 'action_result', 'outcome_closure', 'proof_enforcement', 'automatic_repair']) {
      assert.equal(typeof entry[field], 'string');
      assert.ok(entry[field].length > 0);
    }
    assert.equal(typeof entry.limitation, 'string');
  }
});

test('detectProjectSignals finds Hermes and OpenClaw config evidence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marrow-harness-signals-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'harness-project' }));
  fs.writeFileSync(path.join(dir, 'hermes.json'), '{}');
  fs.writeFileSync(path.join(dir, 'openclaw.json'), '{}');

  const signals = detectProjectSignals(dir);
  assert.ok(signals.signals.includes('hermes_config'));
  assert.ok(signals.signals.includes('openclaw_config'));
});

test('integration panels explain capture points and add-on commands', () => {
  const hermes = localIntegrationManifest('hermes');
  const openclaw = localIntegrationManifest('openclaw');
  const hermesPanel = renderIntegrationPanel('hermes', hermes, 'local', []);
  const openclawPanel = renderIntegrationPanel('openclaw', openclaw, 'local', []);

  assert.match(hermesPanel, /Marrow \+ Hermes Agent/);
  assert.match(hermesPanel, /\/goal -> Marrow completion contract/);
  assert.match(hermesPanel, /npx @getmarrow\/install hermes/);
  assert.match(openclawPanel, /Marrow \+ OpenClaw/);
  assert.match(openclawPanel, /handoff\/result files -> proof packs/);
  assert.match(openclawPanel, /npx @getmarrow\/install openclaw/);
});

test('fleet panel summarizes operator-critical account state', () => {
  const snapshot = normalizeFleetSnapshot({
    status: {
      ok: true,
      data: {
        active_workflow_count: 4,
        proof_pack_hygiene: { incomplete: 2 },
        auto_outcome_closure: { status: 'degraded', stale: 1, exact_fix: 'npx @getmarrow/install --repair' },
        missed_hooks: ['command_outcome'],
        deploy_gate: { status: 'enforce' },
        publish_gate: { status: 'warn' },
        merge_gate: { status: 'enforce' },
        client_update: {
          installed_version: '0.1.35',
          latest_version: '0.1.37',
          version_status: 'behind',
          update_available: true,
          notification_state: 'recommended',
          update_command: 'npx @getmarrow/install@latest --repair',
        },
        recent_decisions: [{ action: 'deploy worker after smoke test' }],
      },
    },
    capacity: {
      ok: true,
      data: {
        current_backpressure: { status: 'ok' },
        exact_next_action: 'Batch low-risk telemetry; keep high-risk gates live.',
      },
    },
    report: {
      ok: true,
      data: {
        arbitrations: {
          open_count: 1,
          review_required_count: 1,
          receipts: [{
            id: 'arb_release_1',
            decision_id: 'decision_release_1',
            resolution: 'review_required',
            conflict_type: 'evidence_conflict',
            selected_proposal_id: 'proposal_audit_first',
            owner_approval_required: true,
            exact_next_action: 'Ask the owner to approve the audited SHA.',
          }],
        },
        agents: [
          { id: 'jarvis', role: 'release', status: 'active', last_seen_at: '2026-06-21T00:00:00Z' },
          { id: 'barvis', role: 'security', status: 'active' },
        ],
      },
    },
    fleet: { ok: true, data: { live_agent_count: 2 } },
  }, {
    agentId: 'codex-bob',
    baseUrl: 'https://api.getmarrow.ai',
  });

  const panel = fleetPanel(snapshot);
  assert.match(panel, /Marrow Fleet Operator/);
  assert.match(panel, /Live agents: 2/);
  assert.match(panel, /Active workflows: 4/);
  assert.match(panel, /Agent disagreements: open=1 review_required=1/);
  assert.match(panel, /Latest arbitration: review_required \(evidence_conflict\)/);
  assert.match(panel, /Risky actions waiting for proof: 2/);
  assert.match(panel, /Failed\/stale outcomes: 1/);
  assert.match(panel, /Backpressure\/capacity status: ok/);
  assert.match(panel, /Recent decisions:/);
  assert.match(panel, /Degraded hooks: command_outcome/);
  assert.match(panel, /Marrow client update: recommended; installed=0\.1\.35; latest=0\.1\.37; operator approval required/);
  assert.match(panel, /Deploy\/publish\/merge gates: deploy=enforce publish=warn merge=enforce/);
  assert.match(panel, /Press Enter to inspect agent/);
  assert.match(panel, /Copy exact fix command:/);
  assert.match(panel, /npx @getmarrow\/install --repair/);
  assert.match(panel, /npx @getmarrow\/install@latest --repair/);
});

test('status panel makes an available update actionable without silently applying it', () => {
  const panel = statusPanel({
    health: 'healthy',
    client_update: {
      installed_version: '0.1.35',
      latest_version: '0.1.37',
      version_status: 'behind',
      update_available: true,
      notification_state: 'recommended',
      update_command: 'npx @getmarrow/install@latest --repair',
      verification_command: 'npx @getmarrow/install@latest doctor',
    },
  });

  assert.match(panel, /Client update: recommended; installed=0\.1\.35; latest=0\.1\.37/);
  assert.match(panel, /Automatic notification: yes; automatic local mutation: no/);
  assert.match(panel, /Update: npx @getmarrow\/install@latest --repair/);
  assert.match(panel, /Verify: npx @getmarrow\/install@latest doctor/);
});

test('status panel keeps unknown client versions non-alarming', () => {
  const panel = statusPanel({
    health: 'healthy',
    client_update: {
      installed_version: null,
      latest_version: null,
      version_status: 'unknown',
      update_available: null,
      notification_state: 'unknown',
      update_command: 'npx @getmarrow/install@latest --repair',
      verification_command: 'npx @getmarrow/install@latest doctor',
    },
  });

  assert.match(panel, /Client update: version_unknown; installed=unknown; latest=unknown/);
  assert.doesNotMatch(panel, /security_required/);
});

test('fleet snapshot reads certified activation coverage without inventing drift', () => {
  const snapshot = normalizeFleetSnapshot({
    status: {
      ok: true,
      data: {
        activation_coverage: {
          available: true,
          status: 'active',
          activation: { active: true, capability_level: 'native_hooks' },
          capture_coverage: { available: true, rate: 0.75 },
          outcome_closure: { available: true, rate: 0.5 },
          intervention_effectiveness: { available: true, follow_through_rate: 1 },
          drift: { available: true, detected: false, reasons: [], repair_command: null },
        },
      },
    },
    capacity: { ok: true, data: {} },
    report: { ok: true, data: {} },
    fleet: { ok: true, data: {} },
  }, { agentId: 'agent-one', baseUrl: 'https://api.getmarrow.ai' });

  assert.deepEqual(snapshot.activation_coverage, {
    available: true,
    state: 'active',
    capability_level: 'native_hooks',
    capture_percent: 75,
    closure_percent: 50,
    effectiveness_percent: 100,
    drift: false,
    exact_fix: '',
  });
});

test('fleet snapshot leaves drift unavailable when the API does not certify it', () => {
  const snapshot = normalizeFleetSnapshot({
    status: { ok: true, data: { activation_coverage: {
      available: true,
      capture_coverage: { available: true, rate: 0.5 },
      drift: { detected: false },
    } } },
    capacity: { ok: true, data: {} },
    report: { ok: true, data: {} },
    fleet: { ok: true, data: {} },
  }, { agentId: 'agent-one', baseUrl: 'https://api.getmarrow.ai' });

  assert.equal(snapshot.activation_coverage.drift, null);
});

test('fleet snapshot distinguishes explicit percent fields from ratio fields', () => {
  const explicit = normalizeFleetSnapshot({
    status: { ok: true, data: { activation_coverage: {
      available: true,
      capture_coverage: { available: true, percent: 1 },
      outcome_closure: { available: true, percent: 1 },
      intervention_effectiveness: { available: true, followed_percent: 1 },
    } } },
    capacity: { ok: true, data: {} },
    report: { ok: true, data: {} },
    fleet: { ok: true, data: {} },
  }, { agentId: 'agent-one', baseUrl: 'https://api.getmarrow.ai' });
  assert.equal(explicit.activation_coverage.capture_percent, 1);
  assert.equal(explicit.activation_coverage.closure_percent, 1);
  assert.equal(explicit.activation_coverage.effectiveness_percent, 1);

  const ratios = normalizeFleetSnapshot({
    status: { ok: true, data: { activation_coverage: {
      available: true,
      capture_coverage: { available: true, rate: 1 },
      outcome_closure: { available: true, rate: 1 },
      intervention_effectiveness: { available: true, follow_through_rate: 1 },
    } } },
    capacity: { ok: true, data: {} },
    report: { ok: true, data: {} },
    fleet: { ok: true, data: {} },
  }, { agentId: 'agent-one', baseUrl: 'https://api.getmarrow.ai' });
  assert.equal(ratios.activation_coverage.capture_percent, 100);
  assert.equal(ratios.activation_coverage.closure_percent, 100);
  assert.equal(ratios.activation_coverage.effectiveness_percent, 100);
});

test('fleet TUI render exposes inspection and fix-command rows', () => {
  const snapshot = normalizeFleetSnapshot({
    status: {
      ok: true,
      data: {
        active_workflow_count: 1,
        recent_decisions: ['blocked publish until npm proof was complete'],
        missed_hooks: [],
        deploy_gate: 'enforce',
        publish_gate: 'enforce',
        merge_gate: 'warn',
        activation_coverage: {
          available: true,
          state: 'active',
          capability_level: 'native_hooks',
          capture: { available: true, percent: 100 },
          outcome_closure: { available: true, percent: 92 },
          intervention_effectiveness: { available: true, followed_percent: 88 },
          drift_detected: false,
        },
      },
    },
    capacity: { ok: true, data: { backpressure: { status: 'ok' } } },
    report: { ok: true, data: { agents: [{ id: 'codex-bob', status: 'active' }] } },
    fleet: { ok: true, data: { live_agent_count: 1 } },
  }, {
    agentId: 'codex-bob',
    baseUrl: 'https://api.getmarrow.ai',
  });
  const state = buildFleetState(snapshot);
  const screen = renderFleetTui(state);

  assert.match(screen, /Marrow Fleet Operator/);
  assert.match(screen, /\[Live agents\]/);
  assert.match(screen, /\[Active workflows\]/);
  assert.match(screen, /\[Agent disagreements\]/);
  assert.match(screen, /\[Risky actions waiting for proof\]/);
  assert.match(screen, /\[Failed\/stale outcomes\]/);
  assert.match(screen, /\[Backpressure \/ capacity\]/);
  assert.match(screen, /\[Recent decisions\]/);
  assert.match(screen, /\[Passive activation \/ coverage\]/);
  assert.match(screen, /capture=100%; closure=92%/);
  assert.match(screen, /\[Deploy\/publish\/merge gates\]/);
  assert.match(screen, /\[Inspect agent\]/);
  assert.match(screen, /\[Copy exact fix command\]/);
  assert.match(screen, /Press Enter to inspect agent/);
});

test('govern TUI render shows passive and governed commands', () => {
  const options = {
    agentId: 'codex-bob',
    profile: 'production',
    policy: 'enforce',
    apiKey: 'mrw_live_placeholder',
  };
  const state = buildGovernState(options, process.cwd());
  state.recommendation = {
    recommended_mode: 'pilot',
    confidence: 0.82,
    reasons: ['Cloudflare Worker detected', 'No owner approval policy configured yet'],
  };
  const passiveCommand = commandForSelection(state, options);
  assert.match(passiveCommand, /npx @getmarrow\/install --yes/);

  state.modeIndex = 2;
  const governedCommand = commandForSelection(state, options);
  assert.match(governedCommand, /npx @getmarrow\/install run --agent codex-bob/);
  assert.match(governedCommand, /--policy enforce/);

  const screen = renderGovernTui(state, options);
  assert.match(screen, /Marrow Governed Setup/);
  assert.match(screen, /Exit: q, Esc, or Ctrl\+C/);
  assert.match(screen, /\[Run passive setup \+ self-test\]/);
  assert.match(screen, /\[Test before-action gate\]/);
  assert.match(screen, /\[Exit\]/);
  assert.match(screen, /Return to shell/);
  assert.match(screen, /Recommended command:/);
  assert.match(screen, /Recommended mode: pilot/);
  assert.match(screen, /Cloudflare Worker detected/);
});

test('govern generated commands shell-quote dynamic arguments', () => {
  const options = {
    agentId: 'codex; echo injected',
    profile: 'prod $(whoami)',
    policy: 'enforce',
    apiKey: '',
  };
  const state = buildGovernState(options, process.cwd());
  state.modeIndex = 2;

  const command = commandForSelection(state, options);
  assert.match(command, /--agent 'codex; echo injected'/);
  assert.match(command, /--profile 'prod \$\(whoami\)'/);
  assert.doesNotMatch(command, /--agent codex; echo injected --profile prod \$\(whoami\)/);

  state.harnessIndex = state.harnesses.findIndex((harness) => harness.name === 'Custom command');
  const customCommand = commandForSelection(state, options);
  assert.match(customCommand, /-- '<your-command>'$/);
});

test('govern generated commands strip terminal control characters from display args', () => {
  const options = {
    agentId: `codex${String.fromCharCode(27)}[31m-red\nnext${String.fromCharCode(0x9d)}0;c1${String.fromCharCode(0x9c)}`,
    profile: `prod\tstage${String.fromCharCode(27)}]0;bad${String.fromCharCode(7)}${String.fromCharCode(0x9d)}1;c1${String.fromCharCode(0x9c)}`,
    policy: 'enforce',
    apiKey: '',
  };
  const state = buildGovernState(options, process.cwd());
  state.modeIndex = 2;

  const command = commandForSelection(state, options);
  assert.doesNotMatch(command, /[\x00-\x1f\x7f-\x9f]/);
  assert.match(command, /--agent 'codex-red next'/);
  assert.match(command, /--profile 'prod stage'/);
});

test('govern rendered output strips terminal control characters', () => {
  const options = {
    agentId: `codex${String.fromCharCode(27)}[31m-red${String.fromCharCode(0x9d)}0;bad${String.fromCharCode(7)}`,
    profile: `prod${String.fromCharCode(27)}]0;bad${String.fromCharCode(7)}${String.fromCharCode(0x9d)}1;c1${String.fromCharCode(0x9c)}`,
    policy: 'enforce',
    apiKey: '',
  };
  const state = buildGovernState(options, process.cwd());
  state.modeIndex = 2;

  const interactive = renderGovernTui(state, options);
  const panel = governPanel(options);
  assert.doesNotMatch(interactive, /[\x07\x9c\x9d]/);
  assert.doesNotMatch(panel, /[\x1b\x07\x9b-\x9d]/);

  const recommended = interactive.split('Recommended command:')[1];
  assert.doesNotMatch(recommended, /[\x1b\x07\x9b-\x9d]/);
  assert.match(panel, /Agent:\s+codex-red/);
  assert.match(panel, /--agent codex-red/);
});

test('govern TUI exit row does not redraw after cleanup', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};

  let output = '';
  const stdout = new Writable({
    write(chunk, encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  stdout.isTTY = true;

  const run = runGovernInteractive({
    agentId: 'codex-bob',
    profile: 'production',
    policy: 'enforce',
    apiKey: '',
    interactive: true,
  }, input, stdout);

  await new Promise((resolve) => setImmediate(resolve));
  for (let i = 0; i < 6; i += 1) input.emit('keypress', '', { name: 'down' });
  input.emit('keypress', '', { name: 'return' });
  await run;

  const afterCursorRestore = output.slice(output.lastIndexOf('\x1b[?25h') + '\x1b[?25h'.length);
  assert.doesNotMatch(afterCursorRestore, /Marrow Governed Setup/);
});

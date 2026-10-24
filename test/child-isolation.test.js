const { childIsolation: iso, isolatedHome, passwdHome, testTempRoot } = require('./support/isolated-environment');
// Test isolation, part 2: the seam (private HOME, scratch passwd home, empty private git config) and the spawn guard
// (a git push, fetch, pull, clone or ls-remote to a non-local address is refused, on every child_process function, even
// when the test swallows the refusal). Every address here ends in .invalid, which never resolves, and every refusal
// happens before a process starts.
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const NODE = process.execPath;
const PATH = process.env.PATH;
const PROBE = path.join(__dirname, 'fixtures', 'isolation-probe.cjs');
const REPO_ROOT = path.resolve(__dirname, '..');
const HOST = 'example.invalid';
const SSH_USER = 'git@';
const quote = (word) => `'${String(word).replace(/'/g, "'\\''")}'`;
const textOf = (file, args) => [file, ...args].map(quote).join(' ');
const scratch = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
const git = (cwd, ...args) => cp.spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t', ...args], { cwd, encoding: 'utf8', env: { PATH } });
const OPTIONS = () => ({ env: { PATH }, stdio: 'pipe' });

const ARGV_FUNCTIONS = {
  spawn: (file, args, options) => cp.spawn(file, args, options),
  spawnSync: (file, args, options) => cp.spawnSync(file, args, options),
  execFile: (file, args, options) => cp.execFile(file, args, options, () => {}),
  execFileSync: (file, args, options) => cp.execFileSync(file, args, options),
  exec: (file, args, options) => cp.exec(textOf(file, args), options, () => {}),
  execSync: (file, args, options) => cp.execSync(textOf(file, args), options),
  'spawnSync with a shell': (file, args, options) => cp.spawnSync(file, args, { ...options, shell: true }),
  fork: (file, args, options) => cp.fork(PROBE, [file, ...args], options),
};
const TEXT_FUNCTIONS = {
  exec: (text, options) => cp.exec(text, options, () => {}),
  execSync: (text, options) => cp.execSync(text, options),
  'spawn with a shell': (text, options) => cp.spawn(text, [], { ...options, shell: true }),
  'spawnSync with a shell': (text, options) => cp.spawnSync(text, [], { ...options, shell: true }),
  'execFile sh -c': (text, options) => cp.execFile('sh', ['-c', text], options, () => {}),
  'execFileSync bash -lc': (text, options) => cp.execFileSync('bash', ['-lc', text], options),
};

function refused(run, what) {
  const error = iso.refuses(run);
  assert.ok(error, `${what}: the guard did not refuse`);
  assert.equal(error.code, 'ESPAWNGUARD', what);
  return error;
}
const gitRefused = (args, options, what) => {
  for (const [name, call] of Object.entries(ARGV_FUNCTIONS)) refused(() => call('git', args, { ...OPTIONS(), ...options }), `${what} / ${name}`);
};
const textRefused = (text, options, what) => {
  for (const [name, call] of Object.entries(TEXT_FUNCTIONS)) refused(() => call(text, { ...OPTIONS(), ...options }), `${what} / ${name}`);
};
const plan = (cwd, ...args) => iso.plan('spawnSync', 'git', args, { cwd, env: { PATH } });
function repoWith(config) {
  const root = scratch('iso-repo-');
  assert.equal(git(root, 'init', '-q').status, 0);
  fs.appendFileSync(path.join(root, '.git', 'config'), config);
  return root;
}
function collect(child) {
  return new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });
}

const URLS = {
  https: `https://${HOST}/o/r.git`,
  http: `http://${HOST}/o/r.git`,
  ssh: `ssh://${SSH_USER}${HOST}/o/r.git`,
  'git://': `git://${HOST}/o/r.git`,
  'scp-style': `${SSH_USER}${HOST}:o/r.git`,
  'host:path': `${HOST}:o/r.git`,
  'ext::': 'ext::sh -c true',
  'file:// with a host': `file://${HOST}/o/r.git`,
};

test('every node child gets a private HOME, the scratch passwd home and a --require on its command line, no NODE_OPTIONS and no GIT_ names', async () => {
  const expected = { homeUnderTemp: true, passwdHomeIsScratch: true, noNodeOptions: true, noGitNames: true, preloaded: true };
  const args = [PROBE, testTempRoot, passwdHome];
  const calls = {
    spawn: async () => collect(cp.spawn(NODE, args, { env: { PATH } })),
    spawnSync: async () => { const r = cp.spawnSync(NODE, args, { env: { PATH }, encoding: 'utf8' }); return { code: r.status, out: r.stdout }; },
    execFile: () => new Promise((resolve) => cp.execFile(NODE, args, { env: { PATH } }, (error, stdout) => resolve({ code: error ? error.code : 0, out: stdout }))),
    execFileSync: async () => ({ code: 0, out: cp.execFileSync(NODE, args, { env: { PATH }, encoding: 'utf8' }) }),
  };
  for (const [name, call] of Object.entries(calls)) {
    const { code, out } = await call();
    assert.equal(code, 0, name);
    assert.deepEqual(JSON.parse(out), expected, name);
  }
  const forked = await new Promise((resolve, reject) => {
    const child = cp.fork(PROBE, [testTempRoot, passwdHome], { env: { PATH } });
    child.once('message', resolve);
    child.once('error', reject);
  });
  assert.deepEqual(forked, { ...expected, preloaded: true }, 'fork');
  // With the child's own explicit home under the temp dir, that home is kept.
  const own = scratch('iso-own-home-');
  const kept = iso.plan('spawnSync', NODE, [PROBE], { env: { PATH, HOME: own } });
  assert.equal(kept.refused, null);
  assert.equal(kept.argv[2].env.HOME, own);
});

test('HOME: unset becomes the private home; outside the temp dir, relative, empty or the real passwd home is refused (all 7 functions)', () => {
  const asArgs = (name, options) => (name === 'exec' || name === 'execSync' ? [name, 'true', options] : [name, name === 'fork' ? PROBE : NODE, name === 'fork' ? [] : ['-e', ''], options]);
  const envOf = (name, argv) => (name === 'exec' || name === 'execSync' ? argv[1] : argv[2]).env;
  for (const name of Object.keys(ARGV_FUNCTIONS).filter((key) => !key.includes('shell') && key !== 'exec' && key !== 'execSync').concat(['exec', 'execSync'])) {
    const filled = iso.plan(...asArgs(name, { env: { PATH } }));
    assert.equal(filled.refused, null, name);
    assert.equal(envOf(name, filled.argv).HOME, isolatedHome, `${name}: HOME is filled with the private home`);
    const inherited = iso.plan(...asArgs(name, {}));
    assert.equal(envOf(name, inherited.argv).HOME, process.env.HOME, `${name}: the inherited home is under the temp dir and kept`);
    for (const [label, home, pattern] of [['outside', '/nonexistent-home', /HOME is outside the test temp dir/], ['relative', 'some/dir', /HOME is relative/], ['empty', '', /HOME is empty/], ['the real passwd home', iso.realPasswdHome(), /HOME is the real passwd home/]]) {
      const result = iso.plan(...asArgs(name, { env: { PATH, HOME: home } }));
      assert.match(String(result.refused), pattern, `${name} with HOME ${label}`);
    }
  }
});

test('a scratch passwd home that is relative or the real one is refused for a node child', () => {
  assert.match(String(iso.plan('spawnSync', NODE, ['-e', ''], { env: { PATH, SBT_PASSWD_HOME: 'relative' } }).refused), /SBT_PASSWD_HOME is not a scratch folder/);
  assert.match(String(iso.plan('spawnSync', NODE, ['-e', ''], { env: { PATH, SBT_PASSWD_HOME: iso.realPasswdHome() } }).refused), /SBT_PASSWD_HOME is not a scratch folder/);
  const own = scratch('iso-own-passwd-');
  assert.equal(iso.plan('spawnSync', NODE, ['-e', ''], { env: { PATH, SBT_PASSWD_HOME: own } }).argv[2].env.SBT_PASSWD_HOME, own);
});

test('a child that is not node gets empty private git config files, no credential helper, no prompt, only the file protocol, and no askpass or ssh names', () => {
  const probe = 'printf "%s\\n" "$GIT_CONFIG_GLOBAL" "$GIT_CONFIG_SYSTEM" "$GIT_CONFIG_NOSYSTEM" "$GIT_TERMINAL_PROMPT" "$GIT_ALLOW_PROTOCOL" "${GIT_ASKPASS-unset}" "${SSH_ASKPASS-unset}" "${GIT_SSH_COMMAND-unset}" "${GIT_CONFIG_COUNT-unset}" "$HOME"';
  const ambient = { GIT_ASKPASS: 'ambient-a', SSH_ASKPASS: 'ambient-b', GIT_SSH_COMMAND: 'ambient-c', GIT_CONFIG_COUNT: '0' };
  const saved = Object.fromEntries(Object.keys(ambient).map((name) => [name, process.env[name]]));
  Object.assign(process.env, ambient);
  try {
    const rows = {
      spawnSync: () => cp.spawnSync('sh', ['-c', probe], { env: { PATH }, encoding: 'utf8' }).stdout,
      'spawnSync, inherited environment': () => cp.spawnSync('sh', ['-c', probe], { encoding: 'utf8' }).stdout,
      'spawnSync, ambient names copied by the test': () => cp.spawnSync('sh', ['-c', probe], { env: { ...process.env }, encoding: 'utf8' }).stdout,
      execFileSync: () => cp.execFileSync('sh', ['-c', probe], { env: { PATH }, encoding: 'utf8' }),
      execSync: () => cp.execSync(probe, { env: { PATH }, encoding: 'utf8' }),
    };
    for (const [name, run] of Object.entries(rows)) {
      const lines = run().split('\n');
      for (const file of lines.slice(0, 2)) {
        assert.ok(file.startsWith(`${testTempRoot}/`), `${name}: a private file under the test temp dir`);
        const stat = fs.statSync(file);
        assert.equal(stat.size, 0, `${name}: empty`);
        assert.equal(stat.mode & 0o777, 0o600, `${name}: mode 600`);
      }
      assert.deepEqual(lines.slice(2, 9), ['1', '0', 'file', 'unset', 'unset', 'unset', 'unset'], name);
      assert.equal(lines[9], name.includes('inherited') ? process.env.HOME : isolatedHome, `${name}: HOME`);
    }
    const own = path.join(scratch('iso-own-config-'), 'gitconfig');
    fs.writeFileSync(own, '', { mode: 0o600 });
    assert.equal(iso.plan('spawnSync', 'git', ['status'], { env: { PATH, GIT_CONFIG_GLOBAL: own } }).argv[2].env.GIT_CONFIG_GLOBAL, own, 'a test\'s own config file under the temp dir is kept');
    assert.notEqual(iso.plan('spawnSync', 'git', ['status'], { env: { PATH, GIT_CONFIG_GLOBAL: '/nonexistent/config' } }).argv[2].env.GIT_CONFIG_GLOBAL, '/nonexistent/config', 'one outside it is replaced');
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('a git or sh child is refused when the test itself sets an ssh, askpass, proxy, exec-path or config-injection name; a node child is not given or refused any GIT_ name', () => {
  for (const name of ['GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_PROXY_COMMAND', 'GIT_EXEC_PATH', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0']) {
    const value = `dummy-${crypto.randomBytes(6).toString('hex')}`;
    for (const [fn, file, args] of [['spawnSync', 'git', ['status']], ['execFileSync', 'sh', ['-c', 'true']]]) {
      const error = refused(() => cp[fn](file, args, { env: { PATH, [name]: value } }), `${name} / ${fn}`);
      assert.ok(error.message.includes(name), `${name}: named`);
      assert.ok(!error.message.includes(value), `${name}: its value is never in the message`);
    }
  }
  refused(() => cp.spawnSync('git', ['status'], { env: { PATH, GIT_ALLOW_PROTOCOL: 'https:file' } }), 'GIT_ALLOW_PROTOCOL with more than file');
  // A node child (the shipped hook reads GIT_* names as the agent's environment) is left alone: nothing added, nothing refused.
  const planned = iso.plan('spawnSync', NODE, ['-e', ''], { env: { PATH, GIT_ASKPASS: 'x' } });
  assert.equal(planned.refused, null);
  assert.equal(planned.argv[2].env.GIT_ASKPASS, 'x');
  assert.deepEqual(Object.keys(planned.argv[2].env).filter((name) => name.startsWith('GIT_') && name !== 'GIT_ASKPASS'), []);
});

test('a planted global git config (credential helper, insteadOf rewrite, identity, XDG config) is invisible to a git child', () => {
  const home = scratch('iso-planted-home-');
  const xdg = path.join(scratch('iso-planted-xdg-'));
  fs.mkdirSync(path.join(xdg, 'git'));
  const planted = `[user]\n\tname = planted\n[credential]\n\thelper = store\n[url "https://${HOST}/"]\n\tinsteadOf = up:\n`;
  fs.writeFileSync(path.join(home, '.gitconfig'), planted);
  fs.writeFileSync(path.join(xdg, 'git', 'config'), planted);
  for (const key of ['user.name', 'credential.helper', 'url.https://example.invalid/.insteadof']) {
    const result = cp.spawnSync('git', ['config', '--get', key], { env: { PATH, HOME: home, XDG_CONFIG_HOME: xdg }, encoding: 'utf8' });
    assert.equal(result.status, 1, `${key} is not visible`);
    assert.equal(result.stdout, '');
  }
});

test('local work still passes: init, commit, log, status, branch/tag/message words like push, local push, fetch, pull, clone and ls-remote between temp repos, file://, npm in the private HOME', () => {
  const root = scratch('iso-local-');
  const bare = path.join(root, 'bare.git');
  const work = path.join(root, 'work');
  const other = path.join(root, 'other');
  for (const result of [
    git(root, 'init', '-q', '--bare', bare),
    git(root, 'init', '-q', work),
    git(work, 'commit', '-q', '--allow-empty', '-m', 'push the fetch and clone words'),
    git(work, 'branch', 'push'),
    git(work, 'tag', 'pull'),
    git(work, 'checkout', '-q', '-b', 'clone'),
    git(work, 'status'),
    git(work, '--no-pager', 'log', '-1'),
    git(root, '-C', work, 'log', '-1'),
    git(work, 'remote', 'add', 'origin', bare),
    git(work, 'push', '-q', 'origin', 'HEAD:refs/heads/push'),
    git(work, 'push', '-q', `file://${bare}`, 'HEAD:refs/heads/viafile'),
    git(work, 'push', '-q', bare, 'HEAD:refs/heads/master'),
    git(work, 'fetch', '-q', 'origin'),
    git(work, 'fetch', '-q', '--all'),
    git(work, 'ls-remote', 'origin'),
    git(work, 'ls-remote', bare),
    git(root, 'clone', '-q', bare, other),
    git(other, 'pull', '-q', 'origin', 'push'),
    git(work, 'remote', 'update'),
  ]) assert.equal(result.status, 0, result.stderr);
  assert.equal(cp.execSync(`cd ${quote(work)} && git status --short && git log -1 --format=%s`, { env: { PATH }, encoding: 'utf8' }).includes('push the fetch'), true);
  const npm = cp.spawnSync('npm', ['config', 'get', 'registry'], { env: { PATH }, encoding: 'utf8' });
  assert.equal(npm.status, 0, npm.stderr);
  assert.match(npm.stdout, /127\.0\.0\.1:9/, 'npm read the private HOME\'s dead-registry config, not the caller\'s');
  // Accepted by the guard when the remote is local, whatever the words around it.
  const local = repoWith(`[url "${bare}"]\n\tinsteadOf = up\n[remote "origin"]\n\turl = ${bare}\n`);
  for (const args of [['ls-remote', 'up'], ['push', 'origin'], ['fetch', 'origin'], ['push', '--', bare], ['-C', work, '--no-pager', 'fetch', bare], ['remote', 'add', 'x', URLS.https], ['commit', '-m', `push ${URLS.https}`], ['remote', '-v']]) {
    assert.equal(plan(local, ...args).refused, null, args.join(' ').replace(/https:\/\/\S+/, '<url>'));
  }
  assert.equal(iso.plan('execSync', `echo "git push ${URLS.https}"`, { cwd: local, env: { PATH } }).refused, null, 'quoted text that only mentions git');
});

test('abuse: every non-local address form x git push, fetch, pull, ls-remote, clone, push after -- (every child_process function)', () => {
  const commands = {
    push: (url) => ['push', url, 'HEAD:main'],
    fetch: (url) => ['fetch', url],
    pull: (url) => ['pull', url, 'main'],
    'ls-remote': (url) => ['ls-remote', url],
    clone: (url) => ['clone', url, 'dest'],
    'push after --': (url) => ['push', '--', url],
  };
  for (const [form, url] of Object.entries(URLS)) {
    for (const [command, build] of Object.entries(commands)) gitRefused(build(url), {}, `${command} ${form}`);
  }
});

test('abuse: config keys, unknown flags, misleading words and other network subcommands (every child_process function)', () => {
  const rows = {
    '-c remote.x.url': ['-c', `remote.x.url=${URLS.https}`, 'fetch', 'x'],
    '-c url insteadOf': ['-c', `url.https://${HOST}/.insteadOf=up:`, 'push', 'up:o/r.git'],
    '-c url pushInsteadOf': ['-c', `url.https://${HOST}/.pushInsteadOf=up:`, 'push', 'up:o/r'],
    'repeated -c insteadOf (last wins)': ['-c', 'url.a.insteadOf=x', '-c', `url.https://${HOST}/.insteadOf=x`, 'fetch', 'x'],
    '--config-env remote url': ['--config-env=remote.x.url=SOMEVAR', 'fetch', 'x'],
    '-c credential.helper on a local command': ['-c', 'credential.helper=store', 'status'],
    '-c core.sshCommand on a local command': ['-c', 'core.sshCommand=ssh -o X=1', 'status'],
    '-c alias to push': ['-c', 'alias.p=push', 'p', 'origin'],
    '-c http.proxy': ['-c', 'http.proxy=http://127.0.0.1:9', 'fetch', 'origin'],
    'unknown flag before push': ['-C', '.', '--frobnicate', 'push', URLS.https],
    'unknown flag before a remote by name': ['--frobnicate', 'fetch', 'origin'],
    '--exec-path with a value': ['--exec-path=/nowhere', 'status'],
    'a directory named push': ['-C', 'push', 'push', URLS.https],
    'a git-dir named fetch': ['--git-dir=fetch', 'fetch', URLS.https],
    'url after a value option': ['push', '-o', 'x', URLS.http],
    'upload-pack with an ssh url': ['fetch', '--upload-pack=x', URLS.ssh],
    'submodule recursion': ['fetch', '--recurse-submodules=yes', 'origin'],
    'submodule add': ['submodule', 'add', URLS.https, 'sub'],
    'archive --remote': ['archive', `--remote=${URLS.ssh}`, 'HEAD'],
    'remote add -f': ['remote', 'add', '-f', 'x', URLS.https],
    lfs: ['lfs', 'pull'],
    svn: ['svn', 'fetch'],
    'send-email': ['send-email', 'x.patch'],
    'an unknown subcommand (an alias or an external command)': ['frobnicate'],
  };
  for (const [name, args] of Object.entries(rows)) gitRefused(args, {}, name);
});

test('abuse: configured remotes, rewrites and branch remotes in the repository config (every child_process function)', () => {
  const bare = path.join(scratch('iso-bare-'), 'bare.git');
  const configs = {
    'origin is https': { text: `[remote "origin"]\n\turl = ${URLS.https}\n`, commands: [['push'], ['push', 'origin'], ['push', 'origin', 'HEAD:main'], ['fetch'], ['fetch', '--all'], ['pull'], ['remote', 'update'], ['ls-remote', 'origin'], ['push', '--mirror']] },
    'pushurl is https while url is local': { text: `[remote "origin"]\n\turl = ${bare}\n\tpushurl = ${URLS.https}\n`, commands: [['push', 'origin'], ['push']] },
    'insteadOf turns a plain word into https': { text: `[url "https://${HOST}/"]\n\tinsteadOf = up\n`, commands: [['push', 'up'], ['fetch', 'up']] },
    'pushInsteadOf turns a plain word into https': { text: `[url "https://${HOST}/"]\n\tpushInsteadOf = up\n`, commands: [['push', 'up']] },
    'insteadOf rewrites a local path prefix to https': { text: `[url "https://${HOST}/"]\n\tinsteadOf = ${os.tmpdir()}/\n`, commands: [['push', `${os.tmpdir()}/x.git`]] },
    'the branch remote is a url': { text: `[branch "main"]\n\tremote = ${URLS.https}\n`, commands: [['push'], ['pull']] },
    'a second remote is ssh': { text: `[remote "origin"]\n\turl = ${bare}\n[remote "mirror"]\n\turl = ${URLS['scp-style']}\n`, commands: [['push'], ['fetch', '--all'], ['remote', 'update']] },
    'a submodule url is https': { text: `[submodule "s"]\n\turl = ${URLS.https}\n`, commands: [['submodule', 'update', '--init']] },
    'an alias to push': { text: '[alias]\n\tp = push\n', commands: [['p', 'origin']] },
  };
  for (const [name, { text, commands }] of Object.entries(configs)) {
    const repo = repoWith(text);
    for (const args of commands) gitRefused(args, { cwd: repo }, `${name}: git ${args.join(' ')}`);
    for (const args of commands) gitRefused(['-C', repo, ...args], {}, `${name}: git -C ${args.join(' ')}`);
  }
  // A rewrite in the test's own global config file is read the way git will read it.
  const globalFile = path.join(scratch('iso-own-global-'), 'gitconfig');
  fs.writeFileSync(globalFile, `[url "https://${HOST}/"]\n\tinsteadOf = up\n`, { mode: 0o600 });
  gitRefused(['push', 'up'], { env: { PATH, GIT_CONFIG_GLOBAL: globalFile } }, 'a rewrite in the test\'s own GIT_CONFIG_GLOBAL');
  // The net: a child that reaches ChildProcess.spawn without a wrapped function is checked as it stands.
  refused(() => new cp.ChildProcess().spawn({ file: 'git', args: ['git', 'push', URLS.https], envPairs: [`PATH=${PATH}`] }), 'ChildProcess.spawn with a git push and no seam');
  refused(() => new cp.ChildProcess().spawn({ file: 'true', args: ['true'], envPairs: [`PATH=${PATH}`] }), 'ChildProcess.spawn without the seam');
  const onlyLocal = repoWith(`[remote "origin"]\n\turl = ${bare}\n[remote "mirror"]\n\turl = ${URLS['scp-style']}\n`);
  assert.equal(plan(onlyLocal, 'push', 'origin').refused, null, 'a named local remote is judged on its own addresses');
  assert.match(String(plan(onlyLocal, 'push', 'mirror').refused), /non-local/);
});

test('abuse: chaining and shell forms inside a child command (exec, execSync, spawn/spawnSync with a shell, sh -c, bash -lc)', () => {
  const U = URLS.https;
  const chains = {
    '&&': `true && git push ${U} HEAD:main`,
    ';': `git status; git push ${U}`,
    '||': `false || git fetch ${U}`,
    pipe: `echo x | git push ${U}`,
    subshell: `(git push ${U})`,
    '$( )': `echo $(git ls-remote ${U})`,
    backticks: `echo \`git ls-remote ${U}\``,
    'inside double quotes': `echo "$(git push ${U})"`,
    'sh -c': `sh -c 'git push ${U}'`,
    'nested bash -c': `bash -c "bash -c 'git push ${U}'"`,
    'absolute path': `/usr/bin/git push ${U}`,
    'env prefix': `env FOO=1 git push ${U}`,
    nohup: `nohup git push ${U}`,
    time: `time git push ${U}`,
    eval: `eval "git push ${U}"`,
    newline: `true\ngit push ${U}`,
    background: `git push ${U} &`,
    redirect: `git push ${U} > /dev/null 2>&1`,
    'brace group': `{ git push ${U}; }`,
    if: `if true; then git push ${U}; fi`,
    'a url in a variable': `U=${U}; git push $U`,
    'a variable in braces': 'git push ${U}',
    'a url from a command substitution': `git push $(echo ${U})`,
    'a url in -c remote.x.url': `git -c remote.x.url=${U} fetch x`,
    'an unknown flag before the subcommand': `git -C . --frobnicate push ${U}`,
    'after --': `git push -- ${U}`,
  };
  for (const [name, text] of Object.entries(chains)) textRefused(text, {}, name);
});

test('a url that a shell variable or a pipe hides from the guard is stopped by git itself: GIT_ALLOW_PROTOCOL=file refuses the https transport', () => {
  const result = cp.spawnSync('sh', ['-c', `G=git; U=${URLS.https}; $G ls-remote $U`], { env: { PATH }, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not allowed/, 'git refused the transport before any lookup');
});

test('refusal messages carry the subcommand and a reason, never a url, a credential or an environment value', () => {
  const secret = `tok_${crypto.randomBytes(12).toString('hex')}`;
  const urlWithCredential = `https://user:${secret}@${HOST}/o/r.git`;
  const repo = repoWith(`[remote "origin"]\n\turl = ${urlWithCredential}\n`);
  const errors = [
    refused(() => cp.spawnSync('git', ['push', urlWithCredential], OPTIONS()), 'url'),
    refused(() => cp.execSync(`git fetch ${urlWithCredential}`, OPTIONS()), 'text'),
    refused(() => cp.spawnSync('git', ['push', 'origin'], { ...OPTIONS(), cwd: repo }), 'configured remote'),
    refused(() => cp.spawnSync('git', ['-c', `remote.x.url=${urlWithCredential}`, 'fetch', 'x'], OPTIONS()), 'config key'),
    refused(() => cp.spawnSync('git', ['status'], { env: { PATH, GIT_SSH_COMMAND: secret } }), 'env name'),
    refused(() => cp.spawnSync('git', ['status'], { env: { PATH, HOME: `/outside/${secret}` } }), 'home'),
  ];
  for (const error of errors) {
    for (const text of [error.message, String(error.stack)]) {
      assert.ok(!text.includes(secret) && !text.includes(HOST) && !text.includes('user:'), 'no url, host or credential in the message or stack');
    }
    assert.match(error.message, /^ESPAWNGUARD at test\/child-isolation\.test\.js:\d+: /);
  }
});

test('a refusal that the test swallows still fails the test and the run (nested node --test); a local push in the same shape passes', () => {
  const nested = (fixture) => cp.spawnSync(NODE, ['--test', path.join(__dirname, 'fixtures', fixture)], { env: { PATH }, encoding: 'utf8' });
  const swallowed = nested('git-push-swallow.cjs');
  assert.notEqual(swallowed.status, 0, 'the nested run is red');
  assert.match(swallowed.stdout, /not ok/);
  assert.match(swallowed.stdout, /the spawn guard refused 1 child/);
  const control = nested('git-push-local-control.cjs');
  assert.equal(control.status, 0, control.stdout.slice(-600));
});

test('static: every test file loads the isolation first, nothing shipped names the helper, and the packed files are only bin, src and package files', () => {
  for (const file of fs.readdirSync(__dirname).filter((name) => name.endsWith('.test.js'))) {
    const first = fs.readFileSync(path.join(__dirname, file), 'utf8').split('\n').find((line) => line.trim() && !line.trim().startsWith('//'));
    assert.match(first, /require\('\.\/support\/isolated-environment'\)/, `${file} loads the isolation first`);
  }
  const names = ['child-isolation', 'SBT_', 'isolationKeepsArgv', 'SPAWN_GUARD', 'ESPAWNGUARD'];
  const walk = (directory) => fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)]));
  for (const file of ['bin', 'src', 'scripts'].flatMap((directory) => walk(path.join(REPO_ROOT, directory)))) {
    const text = fs.readFileSync(file, 'utf8');
    for (const name of names) assert.ok(!text.includes(name), `${path.relative(REPO_ROOT, file)} does not name ${name}`);
  }
  const packed = cp.spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: REPO_ROOT, env: { PATH }, encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const files = JSON.parse(packed.stdout)[0].files.map((entry) => entry.path);
  assert.ok(files.length > 10);
  for (const file of files) assert.match(file, /^(bin\/|src\/|package\.json$|README\.md$|LICENSE|CHANGELOG\.md$)/, `${file} is a shipped file`);
});

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { version: INSTALLER_ADAPTER_VERSION } = require('../package.json');
const { controllerStatus, controllerSupportedPlatform, ensureGovernanceController } = require('./controller-manager');
const { firstCapturePath, harnessReloadPlan } = require('./first-hour');

const DEFAULT_BASE_URL = 'https://api.getmarrow.ai';
const MARROW_BLOCK_START = '<!-- marrow:passive-start -->';
const MARROW_BLOCK_END = '<!-- marrow:passive-end -->';
const MCP_ADAPTER_VERSION = '3.9.74';
const MCP_ADAPTER_SOURCE_SHA = 'a34a87ee1d6ea16d8ebcc26aa0e66bf7dcb5e23f';
const SDK_ADAPTER_VERSION = '3.7.62';
const SDK_ADAPTER_INTEGRITY = 'sha512-n1i6Be09TpAQ9BPNRKY7aCvA2iSUPpJfw8djw2MELwpNbBCtKiZ29Jji77BK/6EFLUpSIcTW/Gmdf/ccf0JRYQ==';
const SDK_ADAPTER_TARBALL = `https://registry.npmjs.org/@getmarrow/sdk/-/sdk-${SDK_ADAPTER_VERSION}.tgz`;
const MCP_PACKAGE_SPEC = `@getmarrow/mcp@${MCP_ADAPTER_VERSION}`;
const ADAPTER_PROVENANCE = Object.freeze({
  mcp: Object.freeze({
    package: '@getmarrow/mcp',
    version: MCP_ADAPTER_VERSION,
    source_sha: MCP_ADAPTER_SOURCE_SHA,
    integrity: null,
    integrity_state: 'registry_unavailable_until_publish',
  }),
  sdk: Object.freeze({
    package: '@getmarrow/sdk',
    version: SDK_ADAPTER_VERSION,
    integrity: SDK_ADAPTER_INTEGRITY,
  }),
});
const MCP_CONTEXT_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp context-hook`;
const MCP_PRE_ACTION_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp pre-action-hook`;
const MCP_ACTION_RESULT_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp hook`;
const MCP_SESSION_END_HOOK_COMMAND = `npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp session-hook`;
const NATIVE_HOOK_MATCHER = 'Bash|Edit|Write|MultiEdit|mcp__(?!marrow_).*';
const NATIVE_EXPECTED_HOOKS = ['prompt', 'pre_action', 'action_result', 'session_end'];
const SOURCE_CLIENTS = new Set(['claude-code', 'cursor', 'composer', 'windsurf', 'openclaw', 'codex', 'gemini', 'grok', 'deepseek', 'qwen', 'kimi', 'minimax', 'cline', 'opencode', 'hermes', 'glm', 'mcp', 'ci', 'custom', 'unknown']);
const HARNESS_CAPABILITY_REGISTRY = Object.freeze([
  { client: 'claude-code', capability_level: 'native_hooks', automatic: ['prompt', 'pre_action', 'action_result', 'session_end'], install_surface: 'mcp' },
  { client: 'cursor', capability_level: 'mcp', automatic: ['mcp_tool_calls'], install_surface: 'mcp' },
  { client: 'composer', capability_level: 'mcp', automatic: ['mcp_tool_calls'], install_surface: 'mcp' },
  { client: 'cline', capability_level: 'mcp', automatic: ['mcp_tool_calls'], install_surface: 'mcp' },
  { client: 'windsurf', capability_level: 'mcp', automatic: ['mcp_tool_calls'], install_surface: 'mcp' },
  { client: 'codex', capability_level: 'governed_wrapper', automatic: ['pre_action', 'action_result', 'outcome_closure'], install_surface: 'runner' },
  { client: 'opencode', capability_level: 'governed_wrapper', automatic: ['pre_action', 'action_result', 'outcome_closure'], install_surface: 'runner' },
  { client: 'hermes', capability_level: 'event_contract', automatic: [], install_surface: 'addon' },
  { client: 'openclaw', capability_level: 'event_contract', automatic: [], install_surface: 'addon' },
  { client: 'gemini', capability_level: 'governed_wrapper', automatic: ['pre_action', 'action_result', 'outcome_closure'], install_surface: 'runner' },
  { client: 'grok', capability_level: 'governed_wrapper', automatic: ['pre_action', 'action_result', 'outcome_closure'], install_surface: 'runner' },
  { client: 'deepseek', capability_level: 'governed_wrapper', automatic: ['pre_action', 'action_result', 'outcome_closure'], install_surface: 'runner' },
  { client: 'qwen', capability_level: 'governed_wrapper', automatic: ['pre_action', 'action_result', 'outcome_closure'], install_surface: 'runner' },
  { client: 'kimi', capability_level: 'governed_wrapper', automatic: ['pre_action', 'action_result', 'outcome_closure'], install_surface: 'runner' },
  { client: 'minimax', capability_level: 'governed_wrapper', automatic: ['pre_action', 'action_result', 'outcome_closure'], install_surface: 'runner' },
  { client: 'glm', capability_level: 'governed_wrapper', automatic: ['pre_action', 'action_result', 'outcome_closure'], install_surface: 'runner' },
  { client: 'mcp', capability_level: 'mcp', automatic: ['mcp_tool_calls'], install_surface: 'mcp' },
  { client: 'ci', capability_level: 'governed_wrapper', automatic: ['pre_action', 'action_result', 'outcome_closure'], install_surface: 'runner' },
  { client: 'custom', capability_level: 'event_contract', automatic: [], install_surface: 'event_contract' },
]);

function explicitMcpVersion(command) {
  const match = String(command || '').match(/@getmarrow\/mcp@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return match ? match[1] : null;
}

function readMcpPackageVersion(packageRoot) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version)
      ? pkg.version
      : null;
  } catch {
    return null;
  }
}

function packageMcpVersion(command) {
  const normalized = String(command || '').replace(/\0/g, ' ');
  const packageRoots = [];
  for (const match of normalized.matchAll(/(\/[^\s]+\/node_modules\/@getmarrow\/mcp)(?:\/|\s|$)/g)) {
    packageRoots.push(match[1]);
  }
  for (const match of normalized.matchAll(/(\/[^\s]+\/node_modules\/\.bin\/marrow-mcp)(?:\s|$)/g)) {
    const binPath = match[1];
    packageRoots.push(path.resolve(path.dirname(binPath), '..', '@getmarrow', 'mcp'));
    try {
      const resolved = fs.realpathSync(binPath);
      const marker = `${path.sep}node_modules${path.sep}@getmarrow${path.sep}mcp${path.sep}`;
      const markerIndex = resolved.indexOf(marker);
      if (markerIndex >= 0) packageRoots.push(resolved.slice(0, markerIndex + marker.length - 1));
    } catch {
      // The derived package root still gives a deterministic best-effort lookup.
    }
  }
  for (const packageRoot of [...new Set(packageRoots)]) {
    const version = readMcpPackageVersion(packageRoot);
    if (version) return version;
  }
  return null;
}

function isMcpProcessCommand(command) {
  const raw = String(command || '');
  const args = (raw.includes('\0') ? raw.split('\0') : raw.trim().split(/\s+/)).filter(Boolean);
  if (!args.length) return false;

  const executable = path.basename(args[0]);
  if (new Set(['bash', 'bwrap', 'dash', 'fish', 'sh', 'zsh']).has(executable)) return false;
  if (executable === 'marrow-mcp') return true;

  if (executable === 'node'
    && args[1]
    && /(?:^|\/)node_modules\/(?:@getmarrow\/mcp(?:\/|$)|\.bin\/marrow-mcp$)/.test(args[1])) {
    return true;
  }

  const packageManagers = new Set(['bun', 'bunx', 'npm', 'npm-cli.js', 'npx', 'npx-cli.js', 'pnpm', 'pnpx', 'yarn']);
  const runner = executable === 'node' && args[1] ? path.basename(args[1]) : executable;
  return packageManagers.has(runner)
    && args.some((arg) => /^(?:--package=)?@getmarrow\/mcp(?:@[^\s]+)?$/.test(arg));
}

function readLinuxProcessCommands(procRoot = '/proc') {
  if (process.platform !== 'linux') return [];
  try {
    return fs.readdirSync(procRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => {
        try {
          return fs.readFileSync(path.join(procRoot, entry.name, 'cmdline'), 'utf8');
        } catch {
          return '';
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function inspectMcpProcesses(options = {}) {
  const commands = Array.isArray(options.commands)
    ? options.commands.map(String)
    : readLinuxProcessCommands(options.procRoot);
  const active = commands
    .filter(isMcpProcessCommand)
    .map((command) => explicitMcpVersion(command) || packageMcpVersion(command) || 'unknown');
  const versions = [...new Set(active.filter((version) => version !== 'unknown'))].sort();
  const unknownVersionProcesses = active.filter((version) => version === 'unknown').length;
  const staleVersions = versions.filter((version) => version !== MCP_ADAPTER_VERSION);
  const mixedVersions = versions.length > 1 || (versions.length > 0 && unknownVersionProcesses > 0);
  const stale = staleVersions.length > 0;
  const needsRepair = stale || mixedVersions || unknownVersionProcesses > 0;
  const repairCommand = `npx -y --package=@getmarrow/mcp@${MCP_ADAPTER_VERSION} marrow-mcp setup`;
  return {
    available: process.platform === 'linux' || Array.isArray(options.commands),
    expected_version: MCP_ADAPTER_VERSION,
    active_processes: active.length,
    active_versions: versions,
    unknown_version_processes: unknownVersionProcesses,
    stale_versions: staleVersions,
    mixed_versions: mixedVersions,
    healthy: !needsRepair,
    exact_fix: needsRepair ? repairCommand : null,
    restart_required: needsRepair,
    restart_instruction: needsRepair ? 'Restart every owning harness to replace its active Marrow MCP process.' : null,
    verification_command: needsRepair ? 'npx -y @getmarrow/install@latest doctor --self-test' : null,
  };
}

function inspectMcpConfigurations(detection, options = {}) {
  const home = options.home || process.env.HOME || process.env.USERPROFILE || os.homedir();
  const configuredPaths = Array.isArray(options.paths) ? options.paths : [
    detection?.paths?.claudeSettings,
    detection?.paths?.cursorMcp,
    detection?.paths?.mcpJson,
    path.join(home, '.claude', 'settings.json'),
    path.join(home, '.claude.json'),
    path.join(home, '.cursor', 'mcp.json'),
    path.join(home, '.mcp.json'),
  ];
  const versions = [];
  let filesChecked = 0;
  let configurationsFound = 0;
  let unknownVersionConfigurations = 0;
  for (const filePath of [...new Set(configuredPaths.filter(Boolean).map((entry) => path.resolve(String(entry))))]) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) continue;
      filesChecked += 1;
      const raw = fs.readFileSync(filePath, 'utf8');
      const specs = [...raw.matchAll(/@getmarrow\/mcp@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g)]
        .map((match) => match[1]);
      if (/@getmarrow\/mcp(?:@|["'\s])/.test(raw)) {
        configurationsFound += 1;
        if (specs.length === 0) unknownVersionConfigurations += 1;
      }
      versions.push(...specs);
    } catch {
      // Doctor remains read-only and ignores inaccessible or malformed owner configuration.
    }
  }
  const configuredVersions = [...new Set(versions)].sort();
  const staleVersions = configuredVersions.filter((version) => version !== MCP_ADAPTER_VERSION);
  const mixedVersions = configuredVersions.length > 1
    || (configuredVersions.length > 0 && unknownVersionConfigurations > 0);
  const healthy = staleVersions.length === 0 && !mixedVersions && unknownVersionConfigurations === 0;
  return {
    expected_version: MCP_ADAPTER_VERSION,
    files_checked: filesChecked,
    configurations_found: configurationsFound,
    configured_versions: configuredVersions,
    unknown_version_configurations: unknownVersionConfigurations,
    stale_versions: staleVersions,
    mixed_versions: mixedVersions,
    healthy,
    exact_fix: healthy ? null : `Run npx -y --package=@getmarrow/mcp@${MCP_ADAPTER_VERSION} marrow-mcp setup in each owning workspace, update its MCP launch to npx -y --package=@getmarrow/mcp@${MCP_ADAPTER_VERSION} marrow-mcp, then restart that harness.`,
    verification_command: healthy ? null : 'npx -y @getmarrow/install@latest doctor --self-test',
  };
}

function sourceClient() {
  const raw = String(process.env.MARROW_CLIENT || process.env.MARROW_HARNESS || process.env.MARROW_AGENT_CLIENT || '').trim().toLowerCase().replace(/\s+/g, '-').replace(/^@/, '');
  const aliases = {
    claude: 'claude-code',
    claude_code: 'claude-code',
    'claude-code': 'claude-code',
    cursor: 'cursor',
    composer: 'composer',
    windsurf: 'windsurf',
    openclaw: 'openclaw',
    codex: 'codex',
    'openai-codex': 'codex',
    gemini: 'gemini',
    google: 'gemini',
    grok: 'grok',
    deepseek: 'deepseek',
    qwen: 'qwen',
    kimi: 'kimi',
    minimax: 'minimax',
    cline: 'cline',
    opencode: 'opencode',
    'open-code': 'opencode',
    hermes: 'hermes',
    'hermes-agent': 'hermes',
    glm: 'glm',
    mcp: 'mcp',
    ci: 'ci',
    'github-actions': 'ci',
  };
  return aliases[raw] || (SOURCE_CLIENTS.has(raw) ? raw : 'custom');
}

function parseArgs(argv) {
  const options = {
    cwd: process.cwd(),
    yes: false,
    dryRun: false,
    doctor: false,
    repair: false,
    mode: 'auto',
    apiKey: process.env.MARROW_API_KEY || '',
    baseUrl: process.env.MARROW_BASE_URL || DEFAULT_BASE_URL,
    agentId: process.env.MARROW_FLEET_AGENT_ID || process.env.MARROW_AGENT_ID || '',
    selfTest: true,
    selfTestExplicitlyDisabled: false,
    json: false,
    activate: false,
    controller: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === 'activate' || arg === '--activate') {
      options.activate = true;
      options.yes = true;
      options.selfTest = true;
    }
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--repair' || arg === 'repair' || arg === 'update' || arg === '--update') {
      options.repair = true;
      options.yes = true;
      options.update = true;
    }
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--doctor' || arg === 'doctor' || arg === 'check') options.doctor = true;
    else if (arg === '--json') options.json = true;
    else if (arg === '--no-self-test') {
      options.selfTest = false;
      options.selfTestExplicitlyDisabled = true;
    }
    else if (arg === '--no-controller') options.controller = false;
    else if (arg === '--self-test') options.selfTest = true;
    else if (arg === '--cwd') options.cwd = path.resolve(argv[++i] || options.cwd);
    else if (arg === '--mode') options.mode = argv[++i] || options.mode;
    else if (arg === '--key') {
      options.apiKey = argv[++i] || options.apiKey;
      options.keyFromArg = true;
    }
    else if (arg === '--base-url') options.baseUrl = argv[++i] || options.baseUrl;
    else if (arg === '--agent-id') options.agentId = argv[++i] || options.agentId;
    else if (arg === '--mcp') options.mode = 'mcp';
    else if (arg === '--sdk') options.mode = 'sdk';
    else if (arg === '--md' || arg === '--instructions') options.mode = 'md';
    else if (arg === '--both') options.mode = 'both';
    else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!['auto', 'mcp', 'sdk', 'both', 'md'].includes(options.mode)) {
    throw new Error('--mode must be one of auto, mcp, sdk, both, md');
  }
  if (options.activate && options.selfTestExplicitlyDisabled) {
    throw new Error('activate cannot be combined with --no-self-test because server verification is required');
  }
  if (options.activate && options.dryRun) {
    throw new Error('activate cannot be combined with --dry-run; use --dry-run without activate to preview changes');
  }

  return options;
}

function usage() {
  return `Usage:
  npx @getmarrow/install --dry-run
  npx @getmarrow/install activate
  npx @getmarrow/install --yes
  npx @getmarrow/install --repair
  npx @getmarrow/install update
  npx @getmarrow/install doctor
  npx @getmarrow/install --mcp --yes
  npx @getmarrow/install --sdk --yes

Options:
  activate           Detect, install, self-test, and return a server-confirmed activation receipt
  --dry-run          Print planned changes without writing
  --doctor           Check install health without writing
  --repair           Write missing hooks/config, then run self-test and status check
  update             Same as --repair: refresh exact MCP/SDK/install package pins after owner approval
  --yes, -y          Write detected config files
  --mode <mode>      auto, mcp, sdk, both, or md
  --key <key>        Marrow API key for self-test. Prefer MARROW_API_KEY because CLI args can appear in process listings.
  --base-url <url>   Marrow API base URL
  --agent-id <id>    Agent/fleet id for self-test headers
  --no-controller    Do not start the local background controller during install/repair
  --no-self-test     Skip API smoke/self-test
`;
}

function stableAgentId(root, client = sourceClient()) {
  const identity = `${path.resolve(root)}:${os.hostname()}:${client}`;
  return `${client}-${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 12)}`;
}

function detectedClient(detection) {
  if (sourceClient() !== 'custom') return sourceClient();
  if (detection.openclaw) return 'openclaw';
  if (detection.claudeCode) return 'claude-code';
  if (detection.cursor) return 'cursor';
  if (detection.codex) return 'codex';
  return 'custom';
}

function exists(filePath) {
  return fs.existsSync(filePath);
}

function safeRead(filePath) {
  return exists(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
}

function findUp(startDir, names, maxDepth = 8) {
  let dir = path.resolve(startDir);
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (exists(candidate)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function projectRoot(startDir) {
  const marker = findUp(startDir, ['package.json', 'pyproject.toml', 'requirements.txt', '.git', 'AGENTS.md', 'CLAUDE.md']);
  return marker ? path.dirname(marker) : path.resolve(startDir);
}

function detectEnvironment(cwd = process.cwd(), env = process.env) {
  const root = projectRoot(cwd);
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const paths = {
    root,
    packageJson: path.join(root, 'package.json'),
    pyproject: path.join(root, 'pyproject.toml'),
    requirements: path.join(root, 'requirements.txt'),
    setupPy: path.join(root, 'setup.py'),
    claudeSettings: path.join(root, '.claude', 'settings.json'),
    claudeMd: path.join(root, 'CLAUDE.md'),
    agentsMd: path.join(root, 'AGENTS.md'),
    cursorRules: path.join(root, '.cursor', 'rules', 'marrow.mdc'),
    cursorMcp: path.join(root, '.cursor', 'mcp.json'),
    mcpJson: path.join(root, '.mcp.json'),
    marrowDir: path.join(root, '.marrow'),
    passiveRuntime: path.join(root, '.marrow', 'passive-runtime.mjs'),
    passiveEnv: path.join(root, '.marrow', 'env.example'),
    openclawJson: findUp(root, ['openclaw.json'], 4) || path.join(home, '.openclaw', 'openclaw.json'),
  };

  return {
    root,
    paths,
    node: exists(paths.packageJson),
    python: exists(paths.pyproject) || exists(paths.requirements) || exists(paths.setupPy),
    claudeCode: exists(paths.claudeSettings) || exists(paths.claudeMd),
    cursor: exists(path.join(root, '.cursor')),
    codex: exists(paths.agentsMd) || exists(path.join(root, '.codex')),
    mcpConfig: exists(paths.mcpJson) || exists(paths.cursorMcp) || exists(paths.claudeSettings),
    openclaw: exists(paths.openclawJson) || Boolean(env.OPENCLAW_HOME || env.OPENCLAW_AGENT_ID),
  };
}

function findLikelyEnvFiles(detection, env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  const candidates = [
    path.join(detection.root, '.env'),
    path.join(detection.root, '.env.local'),
    path.join(detection.root, '.marrow', 'env'),
    path.join(detection.root, '.marrow', 'env.local'),
    path.join(home, '.marrow', 'env'),
    path.join(home, '.openclaw', 'credentials', 'marrow-mcp.env'),
    path.join(home, '.openclaw', 'gateway.systemd.env'),
  ];
  return candidates.filter((filePath) => {
    if (!exists(filePath)) return false;
    const raw = safeRead(filePath);
    return /\bMARROW_API_KEY\s*=/.test(raw) || /\bMARROW_KEY(_[A-Z0-9]+)?\s*=/.test(raw);
  });
}

function stripQuotes(value) {
  const trimmed = String(value || '').trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readEnvVar(filePath, name) {
  if (!exists(filePath)) return '';
  const raw = safeRead(filePath);
  const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*([^\\n#]+)`, 'm');
  const match = raw.match(pattern);
  return match ? stripQuotes(match[1]) : '';
}

function readFirstLineSecret(filePath) {
  if (!exists(filePath)) return '';
  return safeRead(filePath).split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function readNpmrcToken(filePath) {
  if (!exists(filePath)) return '';
  const raw = safeRead(filePath);
  const match = raw.match(/\/\/registry\.npmjs\.org\/:_authToken\s*=\s*([^\s]+)/);
  return match ? stripQuotes(match[1]) : '';
}

function fingerprint(value) {
  const secret = String(value || '').trim();
  if (!secret) return null;
  return crypto.createHash('sha256').update(secret).digest('hex').slice(0, 12);
}

function npmTokenPaths(env = process.env) {
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return {
    home,
    openclawEnv: path.join(home, '.openclaw', '.env'),
    credentialFile: path.join(home, '.openclaw', 'credentials', 'npm-getmarrow-token.txt'),
    npmrc: path.join(home, '.npmrc'),
  };
}

function inspectNpmTokenConfig(env = process.env) {
  const paths = npmTokenPaths(env);
  const openclawToken = readEnvVar(paths.openclawEnv, 'NPM_TOKEN');
  const credentialToken = readFirstLineSecret(paths.credentialFile);
  let npmrcToken = '';
  let unsafeNpmrcPath = false;
  try {
    assertDirectOwnerFile(paths.home, paths.npmrc, { allowMissing: true });
    npmrcToken = readNpmrcToken(paths.npmrc);
  } catch {
    unsafeNpmrcPath = true;
  }
  const sourceToken = openclawToken || credentialToken;
  const mismatch = Boolean(sourceToken && npmrcToken && fingerprint(sourceToken) !== fingerprint(npmrcToken));
  const missingNpmrcToken = Boolean(sourceToken && !npmrcToken);

  return {
    safe: {
      npm_token: {
        checked: true,
        repairable: Boolean(sourceToken && (mismatch || missingNpmrcToken) && !unsafeNpmrcPath),
        mismatch,
        missing_npmrc_token: missingNpmrcToken,
        unsafe_path: unsafeNpmrcPath,
        sources: {
          openclaw_env: { path: paths.openclawEnv, present: Boolean(openclawToken), fingerprint: fingerprint(openclawToken) },
          credential_file: { path: paths.credentialFile, present: Boolean(credentialToken), fingerprint: fingerprint(credentialToken) },
          npmrc: { path: paths.npmrc, present: Boolean(npmrcToken), fingerprint: fingerprint(npmrcToken) },
        },
        recommended_fix: unsafeNpmrcPath
          ? 'Refusing automatic npm token repair because ~/.npmrc or its home directory is not a direct, regular owner path.'
          : mismatch || missingNpmrcToken
          ? 'Run npx @getmarrow/install --repair to sync ~/.npmrc from the active OpenClaw/getmarrow npm token source.'
          : null,
      },
    },
    raw: { paths, sourceToken, npmrcToken },
  };
}

function assertDirectOwnerFile(homePath, filePath, { allowMissing = false } = {}) {
  const home = path.resolve(homePath);
  const target = path.resolve(filePath);
  if (target !== path.join(home, '.npmrc')) throw new Error('npm token repair target must be the direct owner ~/.npmrc');
  if (!fs.existsSync(home)) throw new Error('npm token repair owner home does not exist');
  const homeStat = fs.lstatSync(home);
  if (!homeStat.isDirectory() || homeStat.isSymbolicLink() || fs.realpathSync(home) !== home) {
    throw new Error('npm token repair owner home must be a direct, non-symbolic directory');
  }
  if (!fs.existsSync(target)) {
    if (allowMissing) return;
    throw new Error('npm token repair target does not exist');
  }
  const targetStat = fs.lstatSync(target);
  if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
    throw new Error('npm token repair target must be a regular file, not a symbolic link');
  }
}

function atomicWriteOwnerFile(homePath, filePath, contents) {
  const home = path.resolve(homePath);
  const target = path.resolve(filePath);
  const allowMissing = !fs.existsSync(target);
  assertDirectOwnerFile(home, target, { allowMissing });
  const tempPath = path.join(home, `.npmrc.marrow-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(tempPath, 'wx', 0o600);
    fs.writeFileSync(descriptor, contents, { encoding: 'utf8' });
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    assertDirectOwnerFile(home, target, { allowMissing });
    fs.renameSync(tempPath, target);
    fs.chmodSync(target, 0o600);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

function upsertNpmrcToken(homePath, filePath, token) {
  assertDirectOwnerFile(homePath, filePath, { allowMissing: true });
  const before = safeRead(filePath);
  const tokenLine = `//registry.npmjs.org/:_authToken=${token}`;
  let after;
  if (/\/\/registry\.npmjs\.org\/:_authToken\s*=/.test(before)) {
    after = before.replace(/\/\/registry\.npmjs\.org\/:_authToken\s*=\s*[^\n\r]+/, tokenLine);
  } else {
    const separator = before && !before.endsWith('\n') ? '\n' : '';
    after = `${before}${separator}${tokenLine}\n`;
  }
  if (before !== after) {
    if (before) {
      const backupPath = `${filePath}.marrow-backup`;
      if (fs.existsSync(backupPath) && fs.lstatSync(backupPath).isSymbolicLink()) {
        throw new Error('npm token repair backup must not be a symbolic link');
      }
      const backupTemp = path.join(path.resolve(homePath), `.npmrc.marrow-backup-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
      fs.writeFileSync(backupTemp, before, { mode: 0o600, flag: 'wx' });
      fs.renameSync(backupTemp, backupPath);
      fs.chmodSync(backupPath, 0o600);
    }
    atomicWriteOwnerFile(homePath, filePath, after);
  }
  return before !== after;
}

function repairConfigDiagnostics(diagnostics, env = process.env) {
  const inspection = inspectNpmTokenConfig(env);
  const npm = diagnostics.npm_token;
  const repairs = [];
  if (npm?.repairable && inspection.raw.sourceToken) {
    const changed = upsertNpmrcToken(inspection.raw.paths.home, inspection.raw.paths.npmrc, inspection.raw.sourceToken);
    repairs.push({
      type: 'npm_token_npmrc_sync',
      changed,
      path: inspection.raw.paths.npmrc,
      message: changed
        ? 'Synced ~/.npmrc npm token from active OpenClaw/getmarrow token source.'
        : '~/.npmrc already matched the active OpenClaw/getmarrow token source.',
    });
  }
  return repairs;
}

function passiveInstructions() {
  return `${MARROW_BLOCK_START}
## Marrow Passive Agent Memory

Marrow should run passively after install:

- Use MCP plus these instructions in every workspace: \`npx -y --package=${MCP_PACKAGE_SPEC} marrow-mcp setup\`.
- Use SDK passive runtime in owned Node processes: \`createPassiveRuntime().install()\`.
- Native Claude hooks install only when \`.claude\` is present. Cursor, Composer, Cline, and Windsurf get MCP tools on demand. Codex, Grok, Gemini, and similar CLI harnesses use the governed wrapper. Hermes, OpenClaw, and custom hosts need a bounded event adapter.
- Keep passive token/model usage proof enabled. Empty savings stay zero until observed model usage lands. Do not invent token, cost, or time savings.
- Before risky work, use Marrow's decision brief or passive prompt hook.
- After activate writes MCP or hooks, restart this harness, then run \`npx @getmarrow/install@latest doctor --self-test\`. Do not claim Marrow is live in a process that has not reloaded.
- First turn: tell the owner the gate is live and empty savings are honest. The next deploy, merge, or publish must go through Marrow.
- Cursor, Composer, Cline, and Windsurf: call \`marrow_agent_runtime\` before those actions. Codex, Grok, Gemini, and similar CLIs: wrap them with \`npx @getmarrow/install run --agent <agent-id> -- -- <command>\`.
- Before the session ends, close open work with session-end auto-commit or \`marrow_commit\`. Record model usage only when the host response includes counts.
- After meaningful work, record the outcome so future agents learn from it.
- After Marrow blocks, warns, or requires review, use the decision trace receipt to tell the operator what changed and which recorded workflow or proof is required. Stay quiet for routine low-risk work.
- Check health with \`marrow_agent_status\` or \`GET /v1/agent/status\`.
- When status/runtime returns a \`client_update\` notice, tell the operator and use its exact update and verification commands only when local change policy permits.

Required environment:

- \`MARROW_API_KEY\`
- Optional: \`MARROW_BASE_URL\`, \`MARROW_FLEET_AGENT_ID\`, \`MARROW_CLIENT\`
- Optional: \`MARROW_PASSIVE_TOKEN_USAGE=false\` disables compact provider usage capture when needed.
${MARROW_BLOCK_END}`;
}

function passiveRuntimeSource(options = {}) {
  const installedAgentId = String(options.agentId || '').trim();
  const installedBaseUrl = String(options.baseUrl || DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
  return `const apiKey = process.env.MARROW_API_KEY;
const installedAgentId = ${JSON.stringify(installedAgentId)};
const installedBaseUrl = ${JSON.stringify(installedBaseUrl)};
if (apiKey && !globalThis.__MARROW_PASSIVE_RUNTIME__) {
  try {
    const { MarrowClient } = await import('@getmarrow/sdk');
    const marrow = new MarrowClient(apiKey, {
      baseUrl: installedBaseUrl,
      agentId: installedAgentId || process.env.MARROW_FLEET_AGENT_ID || process.env.MARROW_AGENT_ID,
      sessionId: process.env.MARROW_SESSION_ID,
      mode: process.env.MARROW_ENFORCEMENT_MODE || 'auto',
    });

    const runtime = marrow.createPassiveRuntime({
      includeValueReport: process.env.MARROW_PASSIVE_VALUE_REPORT !== 'false',
      valueReportPeriod: process.env.MARROW_VALUE_REPORT_PERIOD || '7d',
      useAgentRuntime: process.env.MARROW_AGENT_RUNTIME !== 'false',
      useWorkflowGate: process.env.MARROW_WORKFLOW_GATE !== 'false',
      requireOutcomeClosure: process.env.MARROW_REQUIRE_OUTCOME_CLOSURE !== 'false',
      captureModelUsage: process.env.MARROW_PASSIVE_TOKEN_USAGE !== 'false',
    });

    runtime.install();
    globalThis.__MARROW_PASSIVE_RUNTIME__ = runtime;
  } catch {
    console.warn('[Marrow] passive runtime skipped: install @getmarrow/sdk or verify SDK initialization. Run npm install @getmarrow/sdk, then rerun npx @getmarrow/install --repair.');
  }
}
`;
}

function envExample(options = {}) {
  const agentId = String(options.agentId || 'agent-or-fleet-id').trim() || 'agent-or-fleet-id';
  const client = String(options.client || 'custom').trim() || 'custom';
  const baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
  return `MARROW_API_KEY=mrw_live_replace_me
MARROW_BASE_URL=${JSON.stringify(baseUrl)}
MARROW_FLEET_AGENT_ID=${JSON.stringify(agentId)}
MARROW_CLIENT=${JSON.stringify(client)}
MARROW_ENFORCEMENT_MODE=auto
MARROW_PASSIVE_BRIEF=auto
MARROW_PASSIVE_VALUE_REPORT=true
MARROW_AGENT_RUNTIME=true
MARROW_WORKFLOW_GATE=true
MARROW_REQUIRE_OUTCOME_CLOSURE=true
MARROW_PASSIVE_TOKEN_USAGE=true
`;
}

function parseJsonObject(filePath) {
  const raw = safeRead(filePath).trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Expected JSON object in ${filePath}`);
  }
  return parsed;
}

function upsertBlock(content, block) {
  if (content.includes(MARROW_BLOCK_START) && content.includes(MARROW_BLOCK_END)) {
    const start = content.indexOf(MARROW_BLOCK_START);
    const end = content.indexOf(MARROW_BLOCK_END) + MARROW_BLOCK_END.length;
    return `${content.slice(0, start)}${block}${content.slice(end)}`;
  }
  const separator = content && !content.endsWith('\n') ? '\n\n' : content ? '\n' : '';
  return `${content}${separator}${block}\n`;
}

function exactHookConfigured(settings, eventName, command, matcher) {
  const entries = settings?.hooks?.[eventName];
  if (!Array.isArray(entries)) return false;
  return entries.some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
    if (matcher != null && entry.matcher !== matcher) return false;
    if (!Array.isArray(entry.hooks)) return false;
    return entry.hooks.some((hook) => (
      hook
      && typeof hook === 'object'
      && !Array.isArray(hook)
      && hook.type === 'command'
      && typeof hook.command === 'string'
      && hook.command.trim() === command
    ));
  });
}

function exactHookDescriptors(settings, eventName, command, matcher) {
  const entries = settings?.hooks?.[eventName];
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    if (matcher != null && entry.matcher !== matcher) return [];
    if (!Array.isArray(entry.hooks)) return [];
    return entry.hooks.flatMap((hook) => {
      if (!hook || typeof hook !== 'object' || Array.isArray(hook)
        || hook.type !== 'command' || typeof hook.command !== 'string'
        || hook.command.trim() !== command) return [];
      return [{
        matcher: typeof entry.matcher === 'string' ? entry.matcher : null,
        command,
        timeout: typeof hook.timeout === 'number' && Number.isFinite(hook.timeout)
          ? hook.timeout
          : null,
      }];
    });
  });
}

function marrowHookSubcommand(command) {
  if (typeof command !== 'string') return null;
  const match = command.trim().match(
    /^npx\s+(?:-y\s+)?(?:--package=@getmarrow\/mcp(?:@[^\s]+)?\s+marrow-mcp|@getmarrow\/mcp(?:@[^\s]+)?)\s+(context-hook|pre-action-hook|hook|session-hook)$/,
  );
  return match?.[1] || null;
}

function reconcileMarrowCommandHook(settings, eventName, subcommand, command, matcher) {
  const original = Array.isArray(settings?.hooks?.[eventName]) ? settings.hooks[eventName] : [];
  let preferredHandler = null;
  const retained = [];
  for (const entry of original) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Array.isArray(entry.hooks)) {
      retained.push(entry);
      continue;
    }
    const remaining = [];
    for (const hook of entry.hooks) {
      const detected = hook && typeof hook === 'object' && !Array.isArray(hook)
        && hook.type === 'command' ? marrowHookSubcommand(hook.command) : null;
      if (detected) {
        const exactMatcher = matcher == null ? entry.matcher === undefined : entry.matcher === matcher;
        if (detected === subcommand && (!preferredHandler || (hook.command === command && exactMatcher))) {
          preferredHandler = hook;
        }
        continue;
      }
      remaining.push(hook);
    }
    if (remaining.length > 0) retained.push({ ...entry, hooks: remaining });
  }
  const canonical = { hooks: [{ ...(preferredHandler || {}), type: 'command', command }] };
  if (matcher != null) canonical.matcher = matcher;
  retained.push(canonical);
  return retained;
}

function marrowHookDescriptors(settings, eventName, subcommand) {
  const entries = settings?.hooks?.[eventName];
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Array.isArray(entry.hooks)) return [];
    return entry.hooks.flatMap((hook) => {
      if (!hook || typeof hook !== 'object' || Array.isArray(hook)
        || hook.type !== 'command') return [];
      const detected = marrowHookSubcommand(hook.command);
      if (!detected || (subcommand && detected !== subcommand)) return [];
      return [{
        matcher: typeof entry.matcher === 'string' ? entry.matcher : null,
        command: hook.command.trim(),
        timeout: typeof hook.timeout === 'number' && Number.isFinite(hook.timeout) ? hook.timeout : null,
      }];
    });
  });
}

function safeJsonObject(filePath) {
  try {
    return parseJsonObject(filePath);
  } catch {
    return {};
  }
}

function claudeNativeHookFingerprint(settings) {
  const contract = {
    schema: 'marrow-claude-native-hooks.v3',
    adapter_version: MCP_ADAPTER_VERSION,
    expected_hooks: NATIVE_EXPECTED_HOOKS,
    configured: {
      prompt: exactHookConfigured(settings, 'UserPromptSubmit', MCP_CONTEXT_HOOK_COMMAND),
      pre_action: exactHookConfigured(settings, 'PreToolUse', MCP_PRE_ACTION_HOOK_COMMAND, NATIVE_HOOK_MATCHER),
      action_result_success: exactHookConfigured(settings, 'PostToolUse', MCP_ACTION_RESULT_HOOK_COMMAND, NATIVE_HOOK_MATCHER),
      action_result_failure: exactHookConfigured(settings, 'PostToolUseFailure', MCP_ACTION_RESULT_HOOK_COMMAND, NATIVE_HOOK_MATCHER),
      session_end: exactHookConfigured(settings, 'Stop', MCP_SESSION_END_HOOK_COMMAND),
    },
    descriptors: {
      prompt: exactHookDescriptors(settings, 'UserPromptSubmit', MCP_CONTEXT_HOOK_COMMAND),
      pre_action: exactHookDescriptors(settings, 'PreToolUse', MCP_PRE_ACTION_HOOK_COMMAND, NATIVE_HOOK_MATCHER),
      action_result_success: exactHookDescriptors(settings, 'PostToolUse', MCP_ACTION_RESULT_HOOK_COMMAND, NATIVE_HOOK_MATCHER),
      action_result_failure: exactHookDescriptors(settings, 'PostToolUseFailure', MCP_ACTION_RESULT_HOOK_COMMAND, NATIVE_HOOK_MATCHER),
      session_end: exactHookDescriptors(settings, 'Stop', MCP_SESSION_END_HOOK_COMMAND),
    },
    active_marrow_handlers: {
      prompt: marrowHookDescriptors(settings, 'UserPromptSubmit'),
      pre_action: marrowHookDescriptors(settings, 'PreToolUse'),
      action_result_success: marrowHookDescriptors(settings, 'PostToolUse'),
      action_result_failure: marrowHookDescriptors(settings, 'PostToolUseFailure'),
      session_end: marrowHookDescriptors(settings, 'Stop'),
    },
  };
  return crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

function upsertClaudeHooks(settingsPath) {
  const settings = parseJsonObject(settingsPath);
  const hooks = settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks)
    ? settings.hooks
    : {};
  const postToolUse = reconcileMarrowCommandHook(
    settings, 'PostToolUse', 'hook', MCP_ACTION_RESULT_HOOK_COMMAND, NATIVE_HOOK_MATCHER,
  );
  const postToolUseFailure = reconcileMarrowCommandHook(
    settings, 'PostToolUseFailure', 'hook', MCP_ACTION_RESULT_HOOK_COMMAND, NATIVE_HOOK_MATCHER,
  );
  const preToolUse = reconcileMarrowCommandHook(
    settings, 'PreToolUse', 'pre-action-hook', MCP_PRE_ACTION_HOOK_COMMAND, NATIVE_HOOK_MATCHER,
  );
  const userPromptSubmit = reconcileMarrowCommandHook(
    settings, 'UserPromptSubmit', 'context-hook', MCP_CONTEXT_HOOK_COMMAND,
  );
  const stop = reconcileMarrowCommandHook(
    settings, 'Stop', 'session-hook', MCP_SESSION_END_HOOK_COMMAND,
  );

  settings.hooks = {
    ...hooks,
    PreToolUse: preToolUse,
    PostToolUse: postToolUse,
    PostToolUseFailure: postToolUseFailure,
    UserPromptSubmit: userPromptSubmit,
    Stop: stop,
  };

  return JSON.stringify(settings, null, 2) + '\n';
}

function activationProfile(detection, plan, changes, client) {
  const registry = HARNESS_CAPABILITY_REGISTRY.find((entry) => entry.client === client)
    || HARNESS_CAPABILITY_REGISTRY.find((entry) => entry.client === 'custom');
  const sdkDependency = inspectSdkDependency(detection);
  const capabilityLevel = client === 'custom' && (plan.mode === 'sdk' || plan.mode === 'both')
    ? 'sdk_passive_runtime'
    : registry.capability_level;
  const expectedHooks = capabilityLevel === 'sdk_passive_runtime'
    ? ['pre_action', 'action_result', 'outcome_closure']
    : [...registry.automatic];
  const adapterVersion = capabilityLevel === 'native_hooks' || capabilityLevel === 'mcp'
    ? MCP_ADAPTER_VERSION
    : capabilityLevel === 'sdk_passive_runtime'
    ? SDK_ADAPTER_VERSION
    : INSTALLER_ADAPTER_VERSION;
  const observedHooks = [];
  const claudeSettings = safeJsonObject(detection.paths.claudeSettings);
  if (capabilityLevel === 'native_hooks'
    && exactHookConfigured(claudeSettings, 'UserPromptSubmit', MCP_CONTEXT_HOOK_COMMAND)) observedHooks.push('prompt');
  if (capabilityLevel === 'native_hooks'
    && exactHookConfigured(claudeSettings, 'PreToolUse', MCP_PRE_ACTION_HOOK_COMMAND, NATIVE_HOOK_MATCHER)) observedHooks.push('pre_action');
  if (capabilityLevel === 'native_hooks'
    && exactHookConfigured(claudeSettings, 'PostToolUse', MCP_ACTION_RESULT_HOOK_COMMAND, NATIVE_HOOK_MATCHER)
    && exactHookConfigured(claudeSettings, 'PostToolUseFailure', MCP_ACTION_RESULT_HOOK_COMMAND, NATIVE_HOOK_MATCHER)) observedHooks.push('action_result');
  if (capabilityLevel === 'native_hooks'
    && exactHookConfigured(claudeSettings, 'Stop', MCP_SESSION_END_HOOK_COMMAND)) observedHooks.push('session_end');
  const passiveRuntime = safeRead(detection.paths.passiveRuntime);
  if (capabilityLevel === 'sdk_passive_runtime'
    && sdkDependency.present
    && /await import\('@getmarrow\/sdk'\)/.test(passiveRuntime)
    && /runtime\.install\(\)/.test(passiveRuntime)) {
    for (const hook of ['pre_action', 'action_result', 'outcome_closure']) {
      if (!observedHooks.includes(hook)) observedHooks.push(hook);
    }
  }
  const mcpConfigs = [detection.paths.mcpJson, detection.paths.cursorMcp]
    .map((filePath) => safeJsonObject(filePath));
  if (capabilityLevel === 'mcp' && mcpConfigs.some((config) => (
    config?.mcpServers?.marrow?.command === 'npx'
    && Array.isArray(config.mcpServers.marrow.args)
    && config.mcpServers.marrow.args.join(' ') === `-y --package=${MCP_PACKAGE_SPEC} marrow-mcp`
  ))) observedHooks.push('mcp_tool_calls');
  const fingerprintMaterial = changes
    .filter((change) => change.applied || change.already_present)
    .map((change) => `${change.label}:${crypto.createHash('sha256').update(safeRead(change.path)).digest('hex')}`)
    .sort()
    .join('|');
  const configFingerprint = capabilityLevel === 'native_hooks'
    ? claudeNativeHookFingerprint(claudeSettings)
    : crypto.createHash('sha256')
      .update(`${client}:${capabilityLevel}:${expectedHooks.join(',')}:${fingerprintMaterial}`)
      .digest('hex');
  const complete = expectedHooks.length > 0 && expectedHooks.every((hook) => observedHooks.includes(hook));
  const exactFix = complete
    ? null
    : capabilityLevel === 'sdk_passive_runtime' && !sdkDependency.present
    ? `${sdkDependency.install_command} && npx @getmarrow/install --repair`
    : capabilityLevel === 'governed_wrapper'
    ? `npx @getmarrow/install run --agent <agent-id> -- ${client}`
    : 'npx @getmarrow/install --repair';
  return {
    adapter_version: adapterVersion,
    capability_level: capabilityLevel,
    config_fingerprint: configFingerprint,
    expected_hooks: expectedHooks,
    observed_hooks: observedHooks,
    evidence_authority: 'client_self_reported',
    coverage_verified: false,
    configuration_complete: complete,
    complete,
    exact_fix: exactFix,
  };
}

function upsertMcpServerConfig(filePath, options = {}) {
  const agentId = String(options.agentId || '').trim();
  if (!agentId) throw new Error('Refusing to generate Marrow MCP config without an agent identity');
  const baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
  const config = parseJsonObject(filePath);
  const servers = config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
    ? config.mcpServers
    : {};
  servers.marrow = {
    command: 'npx',
    args: ['-y', `--package=${MCP_PACKAGE_SPEC}`, 'marrow-mcp'],
    env: {
      MARROW_BASE_URL: baseUrl,
      MARROW_FLEET_AGENT_ID: agentId,
    },
  };
  config.mcpServers = servers;
  return JSON.stringify(config, null, 2) + '\n';
}

function inspectSdkDependency(detection) {
  if (!detection.node) {
    return { required: false, present: false, install_command: null };
  }

  const raw = safeRead(detection.paths.packageJson);
  let packageJson = {};
  try {
    packageJson = raw ? JSON.parse(raw) : {};
  } catch {
    return {
      required: true,
      present: false,
      install_command: `npm install @getmarrow/sdk@${SDK_ADAPTER_VERSION}`,
      warning: 'package.json could not be parsed; verify @getmarrow/sdk manually.',
    };
  }

  const dependencyBlocks = [
    packageJson.dependencies,
    packageJson.devDependencies,
    packageJson.optionalDependencies,
    packageJson.peerDependencies,
  ];
  const declaredSpec = dependencyBlocks
    .map((deps) => deps && typeof deps['@getmarrow/sdk'] === 'string' ? deps['@getmarrow/sdk'] : null)
    .find(Boolean) || null;
  const objectTargetsSdk = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return Object.entries(value).some(([key, nested]) => (
      key.includes('@getmarrow/sdk') || objectTargetsSdk(nested)
    ));
  };
  const overrideDetected = objectTargetsSdk(packageJson.overrides)
    || objectTargetsSdk(packageJson.resolutions)
    || objectTargetsSdk(packageJson.pnpm?.overrides);
  let lockVerified = false;
  try {
    const lock = JSON.parse(safeRead(path.join(detection.root, 'package-lock.json')) || '{}');
    const rootLock = lock?.packages?.[''];
    const lockedSdk = lock?.packages?.['node_modules/@getmarrow/sdk'];
    const lockedDeclaration = [
      rootLock?.dependencies,
      rootLock?.devDependencies,
      rootLock?.optionalDependencies,
      rootLock?.peerDependencies,
    ].map((deps) => deps && typeof deps['@getmarrow/sdk'] === 'string' ? deps['@getmarrow/sdk'] : null)
      .find(Boolean) || null;
    lockVerified = [2, 3].includes(lock?.lockfileVersion)
      && lockedDeclaration === declaredSpec
      && lockedSdk?.version === SDK_ADAPTER_VERSION
      && lockedSdk?.resolved === SDK_ADAPTER_TARBALL
      && lockedSdk?.integrity === SDK_ADAPTER_INTEGRITY;
  } catch {
    lockVerified = false;
  }
  const installedPackagePath = findUp(
    detection.root,
    [path.join('node_modules', '@getmarrow', 'sdk', 'package.json')],
  );
  let installedVersion = null;
  let installedName = null;
  try {
    const installedPackage = installedPackagePath ? JSON.parse(safeRead(installedPackagePath)) : null;
    installedVersion = typeof installedPackage?.version === 'string' ? installedPackage.version : null;
    installedName = typeof installedPackage?.name === 'string' ? installedPackage.name : null;
  } catch {
    installedVersion = null;
    installedName = null;
  }
  const declarationTrusted = typeof declaredSpec === 'string'
    && declaredSpec.trim().length > 0
    && /^[v0-9xX*<>=~^|.\s-]+$/.test(declaredSpec.trim());
  const present = declarationTrusted
    && !overrideDetected
    && lockVerified
    && installedName === '@getmarrow/sdk'
    && installedVersion === SDK_ADAPTER_VERSION;
  return {
    required: true,
    present,
    declared: declaredSpec != null,
    declared_spec: declaredSpec,
    declaration_trusted: declarationTrusted,
    override_detected: overrideDetected,
    lock_verified: lockVerified,
    installed_name: installedName,
    installed_version: installedVersion,
    expected_version: SDK_ADAPTER_VERSION,
    install_command: present ? null : `npm install @getmarrow/sdk@${SDK_ADAPTER_VERSION}`,
  };
}

function defaultHarnessInstallMatrix(detection = detectEnvironment(process.cwd())) {
  const node = Boolean(detection.node);
  return HARNESS_CAPABILITY_REGISTRY.map((entry) => {
    const detected = detectedClient(detection) === entry.client
      || (entry.client === 'claude-code' && detection.claudeCode)
      || (entry.client === 'cursor' && detection.cursor)
      || (entry.client === 'codex' && detection.codex);
    return {
      client: entry.client,
      capability_level: entry.capability_level,
      automatic: entry.automatic,
      install_surface: entry.install_surface,
      default_install: {
        mcp: true,
        instructions: true,
        sdk_passive_runtime: node,
        native_hooks: entry.capability_level === 'native_hooks' && Boolean(detection.claudeCode),
        governed_wrapper: entry.capability_level === 'governed_wrapper',
      },
      configured_locally: detected && entry.automatic.length > 0,
      verified_passive: false,
      unsupported_claim: entry.capability_level === 'event_contract'
        ? 'Needs a bounded event adapter. MCP tools remain on demand.'
        : null,
    };
  });
}

function buildPlan(detection, options) {
  const client = options.client || detectedClient(detection);
  const agentId = String(options.agentId || '').trim() || stableAgentId(detection.root, client);
  const baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).trim() || DEFAULT_BASE_URL;
  const mode = options.mode === 'auto'
    ? detection.node ? 'both' : 'mcp'
    : options.mode;
  const writes = [];

  if (mode === 'sdk' || mode === 'both') {
    writes.push({
      type: 'file',
      path: detection.paths.passiveRuntime,
      label: 'SDK passive runtime preload',
      content: passiveRuntimeSource({ agentId, baseUrl }),
    });
    writes.push({
      type: 'file',
      path: detection.paths.passiveEnv,
      label: 'Marrow passive env example',
      content: envExample({ agentId, baseUrl, client }),
      overwrite: false,
    });
  }

  if (mode === 'mcp' || mode === 'both') {
    if (detection.claudeCode) {
      writes.push({
        type: 'json-transform',
        path: detection.paths.claudeSettings,
        label: 'Claude Code MCP passive hooks',
        transform: upsertClaudeHooks,
      });
    }
    writes.push({
      type: 'json-transform',
      path: detection.paths.mcpJson,
      label: 'Project MCP server config',
      transform: (filePath) => upsertMcpServerConfig(filePath, { agentId, baseUrl }),
    });
    if (detection.cursor) {
      writes.push({
        type: 'json-transform',
        path: detection.paths.cursorMcp,
        label: 'Cursor MCP server config',
        transform: (filePath) => upsertMcpServerConfig(filePath, { agentId, baseUrl }),
      });
    }
  }

  if (mode === 'md' || mode === 'both' || mode === 'mcp') {
    writes.push({
      type: 'md-block',
      path: detection.paths.agentsMd,
      label: 'Agent instructions',
      block: passiveInstructions(),
    });
  }

  if (detection.cursor && (mode === 'md' || mode === 'both' || mode === 'mcp')) {
    writes.push({
      type: 'file',
      path: detection.paths.cursorRules,
      label: 'Cursor Marrow rule',
      content: passiveInstructions().replace(/<!--[^>]+-->/g, '').trim() + '\n',
    });
  }

  return { mode, root: detection.root, writes };
}

function assertContainedManagedTarget(root, targetPath) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(targetPath);
  if (resolvedTarget === resolvedRoot || !resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`Refusing installer write outside project root: ${resolvedTarget}`);
  }
  if (!fs.existsSync(resolvedRoot)) throw new Error(`Project root does not exist: ${resolvedRoot}`);
  const rootStat = fs.lstatSync(resolvedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`Refusing installer write through unsafe project root: ${resolvedRoot}`);
  }
  const realRoot = fs.realpathSync(resolvedRoot);
  const relativeParent = path.relative(resolvedRoot, path.dirname(resolvedTarget));
  let current = resolvedRoot;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Refusing installer write through unsafe path component: ${current}`);
    }
    const realCurrent = fs.realpathSync(current);
    if (realCurrent !== realRoot && !realCurrent.startsWith(`${realRoot}${path.sep}`)) {
      throw new Error(`Refusing installer write outside resolved project root: ${current}`);
    }
  }
  if (fs.existsSync(resolvedTarget)) {
    const targetStat = fs.lstatSync(resolvedTarget);
    if (targetStat.isSymbolicLink() || !targetStat.isFile()) {
      throw new Error(`Refusing installer write to unsafe managed target: ${resolvedTarget}`);
    }
  }
  return { resolvedRoot, resolvedTarget };
}

function atomicWriteManagedFile(root, targetPath, contents) {
  const { resolvedTarget } = assertContainedManagedTarget(root, targetPath);
  const parent = path.dirname(resolvedTarget);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  assertContainedManagedTarget(root, resolvedTarget);
  const existingMode = fs.existsSync(resolvedTarget)
    ? fs.lstatSync(resolvedTarget).mode & 0o777
    : 0o600;
  const tempPath = path.join(
    parent,
    `.${path.basename(resolvedTarget)}.marrow-${process.pid}-${crypto.randomBytes(6).toString('hex')}`,
  );
  try {
    fs.writeFileSync(tempPath, contents, { flag: 'wx', mode: existingMode });
    assertContainedManagedTarget(root, resolvedTarget);
    fs.renameSync(tempPath, resolvedTarget);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

function applyPlan(plan, options) {
  if (!Array.isArray(plan?.writes) || plan.writes.length === 0) return [];
  const root = path.resolve(plan.root || path.dirname(plan.writes[0].path));
  for (const write of plan.writes) assertContainedManagedTarget(root, write.path);
  const prepared = plan.writes.map((write) => {
    const before = safeRead(write.path);
    let after;
    if (write.type === 'file') {
      if (write.overwrite === false && before) {
        after = before;
      } else {
        after = write.content;
      }
    } else if (write.type === 'md-block') {
      after = upsertBlock(before, write.block);
    } else if (write.type === 'json-transform') {
      after = write.transform(write.path);
    } else {
      throw new Error(`Unknown write type: ${write.type}`);
    }

    return { write, before, after };
  });

  const changes = [];
  for (const { write, before, after } of prepared) {
    const changed = before !== after;
    const writeApplied = Boolean(options.yes && !options.dryRun && !options.doctor);
    changes.push({
      path: write.path,
      label: write.label,
      changed,
      applied: changed && writeApplied,
      already_present: !changed,
    });
    if (changed && writeApplied) {
      atomicWriteManagedFile(root, write.path, after);
    }
  }
  return changes;
}

async function requestJson(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  if (!res.ok) {
    const message = json.error || json.message || `HTTP ${res.status}`;
    throw new Error(String(message));
  }
  return json.data || json;
}

function isCanonicalTimestamp(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function runtimeGateVerified(runtime) {
  if (!runtime || typeof runtime !== 'object') return false;
  const gate = runtime.risk_gate;
  if (!gate || typeof gate !== 'object') return false;
  if (typeof gate.allow === 'boolean' || typeof gate.allowed === 'boolean') return true;
  const decision = typeof gate.decision === 'string' ? gate.decision.toLowerCase() : '';
  return ['allow', 'warn', 'review_required', 'block'].includes(decision);
}

async function runSelfTest(options) {
  if (!options.selfTest) return { skipped: true, reason: 'disabled' };
  if (!options.apiKey) {
    return {
      skipped: true,
      reason: 'missing MARROW_API_KEY',
      exact_fix: 'export MARROW_API_KEY=mrw_live_... && npx @getmarrow/install --repair',
    };
  }

  const headers = {
    authorization: `Bearer ${options.apiKey}`,
    'content-type': 'application/json',
    'x-marrow-session-id': `install-${Date.now()}`,
    'x-marrow-client': options.client || sourceClient(),
    'x-marrow-package': '@getmarrow/install',
    'x-marrow-package-version': INSTALLER_ADAPTER_VERSION,
    'x-marrow-install-version': INSTALLER_ADAPTER_VERSION,
    'x-marrow-sdk-version': SDK_ADAPTER_VERSION,
    'x-marrow-mcp-version': MCP_ADAPTER_VERSION,
  };
  if (options.agentId) headers['x-marrow-agent-id'] = options.agentId;

  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const think = await requestJson(`${baseUrl}/v1/agent/think`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: 'process',
      action: 'Marrow passive install self-test: verify SDK/MCP hooks can record a harmless setup event',
      source_meta: {
        channel: 'cli',
        client: options.client || sourceClient(),
        user_intent: 'operate',
      },
    }),
  });

  const decisionId = think.decision_id || think.decisionId;
  if (!decisionId) throw new Error('self-test did not return decision_id');

  await requestJson(`${baseUrl}/v1/agent/commit`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      decision_id: decisionId,
      success: true,
      outcome: 'Marrow passive installer self-test completed successfully',
    }),
  });

  const status = await requestJson(`${baseUrl}/v1/agent/status`, { headers });
  const runtime = await requestJson(`${baseUrl}/v1/agent/runtime`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      action: 'Marrow passive install self-test: verify one-call agent runtime and outcome closure',
      type: 'process',
      role: 'general',
      response_mode: 'expanded',
      surfaces: ['workspace'],
      proof: {
        checks: ['installer self-test'],
        outcome: 'self-test outcome committed',
      },
    }),
  });
  const performance = await requestJson(`${baseUrl}/v1/analytics/agent-performance?period=7`, { headers })
    .catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  const firstValue = await requestJson(`${baseUrl}/v1/agent/first-value`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      action: 'I am about to deploy to production. What should I check first?',
      type: 'deploy',
      role: 'deploy',
      surfaces: ['production', 'deploy'],
      proof: {
        checks: ['installer first-value self-test'],
        outcome: 'first-value endpoint reached',
      },
      decision_id: decisionId,
      agent_id: options.agentId,
      activation: options.activation ? {
        ...options.activation,
        intervention_verified: runtimeGateVerified(runtime),
        closure_verified: true,
      } : undefined,
    }),
  });
  const valueProof = await requestJson(`${baseUrl}/v1/agent/value/proof?period_days=30`, { headers })
    .catch((error) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
  const tokenValueProof = buildTokenValueProof(valueProof);
  const firstValueSignal = buildFirstValueSignal(status, runtime, performance, firstValue, tokenValueProof);
  const installValueMoment = buildInstallValueMoment(firstValueSignal, status, runtime, performance, firstValue, tokenValueProof);
  let activationReceipt = null;
  let activationVerified = false;
  let activationProfileReceipt = null;
  if (options.activation) {
    const activationAdapterVersion = options.activation.adapter_version || INSTALLER_ADAPTER_VERSION;
    const activationCapabilityLevel = options.activation.capability_level || 'event_contract';
    const activationExpectedHooks = Array.isArray(options.activation.expected_hooks) ? options.activation.expected_hooks : [];
    const activationConfigFingerprint = options.activation.config_fingerprint || crypto.createHash('sha256')
      .update(JSON.stringify({
        harness: options.activation.harness || options.client || 'custom',
        install_surface: options.activation.install_surface || 'unknown',
        adapter_version: activationAdapterVersion,
        expected_hooks: activationExpectedHooks,
      }))
      .digest('hex');
    activationReceipt = firstValue && firstValue.activation_receipt;
    const receiptValid = activationReceipt
      && typeof activationReceipt === 'object'
      && typeof activationReceipt.id === 'string'
      && activationReceipt.id.length > 0
      && activationReceipt.decision_id === decisionId
      && activationReceipt.agent_id === options.agentId
      && activationReceipt.outcome_success === true
      && isCanonicalTimestamp(activationReceipt.outcome_recorded_at)
      && activationReceipt.server_confirmed === true
      && activationReceipt.capture_verified === true
      && activationReceipt.intervention_verified === true
      && activationReceipt.closure_verified === true;
    if (!receiptValid) {
      throw new Error('activation receipt did not verify the exact self-test decision, agent, runtime gate, and closed successful outcome');
    }
    let activationTelemetry;
    try {
      activationTelemetry = await requestJson(`${baseUrl}/v1/agent/integrations/events`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          event_id: `activation-${activationConfigFingerprint.slice(0, 32)}`,
          event_type: 'activation_profile_registered',
          harness: options.activation.harness,
          agent_id: options.agentId,
          session_id: headers['x-marrow-session-id'],
          adapter_version: activationAdapterVersion,
          capability_level: activationCapabilityLevel,
          config_fingerprint: activationConfigFingerprint,
          expected_hooks: activationExpectedHooks,
          action: 'integration activation profile registered as client self-reported telemetry',
          occurred_at: new Date().toISOString(),
        }),
      });
    } catch {
      throw new Error('activation telemetry delivery failed; retry activate after the integration-events endpoint accepts authenticated client_self_reported telemetry');
    }
    const telemetryAccepted = Boolean(
      activationTelemetry?.accepted === true
      && activationTelemetry?.evidence_authority === 'client_self_reported'
    );
    if (!telemetryAccepted) {
      throw new Error('activation telemetry was not acknowledged as authenticated client_self_reported delivery; update the backend/client compatibility pair, then retry activate');
    }
    // Never project response-supplied coverage or profile receipts into the install
    // result. This endpoint acknowledges bounded, authenticated client telemetry;
    // it does not certify that hooks, wrappers, or adapters continuously ran.
    activationProfileReceipt = {
      accepted: true,
      evidence_authority: 'client_self_reported',
      certified_coverage: false,
    };
    const activationPrerequisites = {
      first_value_active: firstValue?.active === true,
      runtime_gate_verified: runtimeGateVerified(runtime),
      status_enabled: (status.enabled ?? status.ok) === true,
      telemetry_accepted: telemetryAccepted,
    };
    activationVerified = Object.values(activationPrerequisites).every(Boolean);
    if (!activationVerified) {
      const missing = Object.entries(activationPrerequisites)
        .filter(([, verified]) => !verified)
        .map(([name]) => name)
        .join(',');
      throw new Error(`activation self-test prerequisites were not all verified by the server (${missing})`);
    }
  }
  return {
    skipped: false,
    decision_id: decisionId,
    active: Boolean(status.enabled ?? status.ok),
    health: status.health || null,
    last_event_at: status.last_event_at || null,
    recommended_fix: status.recommended_fix || null,
    next_action: status.next_action || null,
    auto_outcome_closure: status.auto_outcome_closure || null,
    runtime_active: runtimeGateVerified(runtime),
    runtime_exact_next_action: runtime.exact_next_action || null,
    runtime_before_you_act: runtime.before_you_act || null,
    activation_verified: activationVerified,
    activation_scope: options.activation ? 'server_self_test_only' : null,
    coverage_verified: false,
    passive_live: false,
    reload_required: Boolean(options.activation),
    activation_next_action: options.activation
      ? 'Restart the owning harness, then run npx @getmarrow/install@latest doctor --self-test.'
      : null,
    activation_receipt: activationReceipt,
    activation_profile_receipt: activationProfileReceipt,
    activation_coverage: null,
    first_value: firstValue && firstValue.ok !== false ? firstValue : null,
    first_value_signal: firstValueSignal,
    install_value_moment: installValueMoment,
    token_value_proof: tokenValueProof,
    client_update: status.client_update || runtime.client_update || runtime.status?.client_update || null,
    performance_proof: performance && performance.ok !== false ? {
      avoided_mistakes: performance.avoided_mistakes ?? performance.avoided_repeated_mistakes ?? 0,
      reused_winning_decisions: performance.reused_winning_decisions ?? 0,
      prevented_bad_actions: performance.prevented_bad_actions ?? 0,
      estimated_tokens_saved: tokenValueProof?.savings?.estimated_tokens_saved ?? null,
      estimated_minutes_saved: tokenValueProof?.savings?.estimated_minutes_saved ?? null,
      token_savings_available: Number(tokenValueProof?.observed?.model_calls || 0) > 0
        && Number(tokenValueProof?.savings?.estimated_tokens_saved || 0) > 0,
      token_savings_source: 'agent_model_usage_events',
      token_savings_method: tokenValueProof?.savings?.method || 'warming_up',
      token_savings_confidence: tokenValueProof?.savings?.confidence || 'none',
      reliability_score: performance.agent_reliability_score ?? null,
    } : null,
  };
}

function buildTokenValueProof(valueProof = {}) {
  const modelUsage = valueProof && valueProof.ok !== false
    ? valueProof.model_usage || valueProof.token_value_signal || valueProof
    : null;
  if (!modelUsage || typeof modelUsage !== 'object') {
    return {
      enabled: true,
      capture_default: 'on_when_sdk_mcp_or_installer_hooks_available',
      observed: { model_calls: 0, tokens: { total: 0 } },
      savings: { estimated_tokens_saved: 0, estimated_minutes_saved: 0, confidence: 'none', method: 'warming_up' },
      proof_line: 'Token usage capture is ready; no model calls have been reported yet.',
      exact_next_action: 'Keep passive token capture enabled so Marrow can attach usage proof after real model calls complete.',
    };
  }
  return modelUsage;
}

function tokenValueProofLine(tokenValueProof) {
  const calls = Number(tokenValueProof?.observed?.model_calls || 0);
  const saved = Number(tokenValueProof?.savings?.estimated_tokens_saved || 0);
  if (calls > 0 && saved > 0) {
    const method = tokenValueProof.savings?.method || 'unspecified';
    const confidence = tokenValueProof.savings?.confidence || 'unknown';
    return `Marrow observed ${calls} model call${calls === 1 ? '' : 's'} and estimates ~${saved} tokens saved (${method}, ${confidence} confidence)`;
  }
  return tokenValueProof?.proof_line || null;
}

function buildInstallValueMoment(firstValueSignal = {}, status = {}, runtime = {}, performance = {}, firstValue = {}, tokenValueProof = null) {
  if (firstValue && firstValue.ok !== false && firstValue.first_value) {
    const proof = Array.isArray(firstValue.first_value.proof) ? [...firstValue.first_value.proof] : [];
    const tokenProofLine = tokenValueProofLine(tokenValueProof);
    if (tokenProofLine && !proof.includes(tokenProofLine)) proof.push(tokenProofLine);
    return {
      headline: firstValue.headline || firstValue.first_value.headline || 'Your agent is no longer starting from zero.',
      proof,
      fleet_signal: firstValue.history_signal?.summary || 'Fresh account: Marrow will build fleet memory from this first captured outcome.',
      try_this_now: firstValue.first_value.try_this_now || 'Ask your agent: "I am about to deploy to production. What should I check first?"',
      expected_response: firstValue.first_value.expected_response || 'Marrow should answer with a risk gate, required proof, and any matching fleet lessons before the agent acts.',
      first_lesson: firstValue.first_value.first_lesson || null,
    };
  }

  const proof = firstValueSignal.value_proof || [];
  const hasFleetSignal = proof.length > 0;
  const runtimeLesson = runtime.before_you_act
    || runtime.before_you_act_injection?.message
    || runtime.exact_next_action
    || firstValueSignal.first_lesson;

  return {
    headline: 'Your agent is no longer starting from zero.',
    proof: [
      'Captured this setup decision',
      'Closed the outcome successfully',
      'Runtime gate is ' + (firstValueSignal.active ? 'active' : 'installed'),
      runtimeLesson ? 'Future risky work now gets a pre-action brief' : 'Future risky work now gets checked before action',
      tokenValueProofLine(tokenValueProof) || 'Token usage proof is active and warming up after the first model call',
    ],
    fleet_signal: hasFleetSignal
      ? 'Marrow already found signal: ' + proof.join('; ') + '.'
      : 'Fresh account: Marrow will start building fleet memory from this first captured outcome.',
    try_this_now: 'Ask your agent: "I am about to deploy to production. What should I check first?"',
    expected_response: 'Marrow should answer with a risk gate, required proof, and any matching fleet lessons before the agent acts.',
    first_lesson: runtimeLesson || 'Marrow will surface prior lessons before risky or repeated work.',
  };
}

function buildFirstValueSignal(status, runtime, performance, firstValue = {}, tokenValueProof = null) {
  if (firstValue && firstValue.ok !== false && firstValue.first_value) {
    const capture = firstValue.capture || {};
    const proof = firstValue.value_proof || {};
    const proofBits = [];
    if (Number(proof.avoided_mistakes || 0) > 0) proofBits.push(`${proof.avoided_mistakes} avoided mistake(s)`);
    if (Number(proof.reused_winning_decisions || 0) > 0) proofBits.push(`${proof.reused_winning_decisions} reused winning decision(s)`);
    if (Number(proof.prevented_bad_actions || 0) > 0) proofBits.push(`${proof.prevented_bad_actions} prevented risky action(s)`);
    const tokenProofLine = tokenValueProofLine(tokenValueProof);
    if (tokenProofLine) proofBits.push(tokenProofLine);
    return {
      active: Boolean(firstValue.active),
      headline: `Marrow active: ${(capture.surfaces || ['decisions']).join(', ')} captured.`,
      captured: capture.surfaces || ['decisions'],
      first_lesson: firstValue.first_value.first_lesson,
      value_proof: proofBits,
      next_action: firstValue.next_action?.reason || 'Keep working; Marrow will capture outcomes and reuse lessons automatically.',
    };
  }

  const capture = status.capture_coverage || {};
  const closure = status.auto_outcome_closure || {};
  const captured = [];
  if (status.enabled || capture.decisions) captured.push('decisions');
  if (capture.tools === 'detected') captured.push('tools');
  if (capture.commands === 'detected') captured.push('commands');
  if (capture.deploys === 'detected') captured.push('deploys');
  if (capture.publishes === 'detected') captured.push('publishes');
  if (closure.state) captured.push(`outcomes:${closure.state}`);

  const proof = performance && performance.ok !== false ? performance : {};
  const proofBits = [];
  if (Number(proof.avoided_mistakes || proof.avoided_repeated_mistakes || 0) > 0) proofBits.push(`${proof.avoided_mistakes || proof.avoided_repeated_mistakes} avoided mistake(s)`);
  if (Number(proof.reused_winning_decisions || 0) > 0) proofBits.push(`${proof.reused_winning_decisions} reused winning decision(s)`);
  if (Number(proof.prevented_bad_actions || 0) > 0) proofBits.push(`${proof.prevented_bad_actions} prevented risky action(s)`);
  const tokenProofLine = tokenValueProofLine(tokenValueProof);
  if (tokenProofLine) proofBits.push(tokenProofLine);

  const firstLesson = runtime.before_you_act
    || runtime.before_you_act_injection?.message
    || runtime.exact_next_action
    || status.recommended_fix
    || 'Marrow will surface prior lessons before risky or repeated work.';

  return {
    active: Boolean(status.enabled ?? status.ok),
    headline: `Marrow active: ${captured.length ? captured.join(', ') : 'decisions'} captured.`,
    captured,
    first_lesson: firstLesson,
    value_proof: proofBits,
    next_action: runtime.exact_next_action || status.next_action || 'Keep working; Marrow will capture outcomes and reuse lessons automatically.',
  };
}

function printReport(report) {
  process.stdout.write(`Marrow passive installer\n`);
  process.stdout.write(`Root: ${report.root}\n`);
  process.stdout.write(`Mode: ${report.mode}\n`);
  process.stdout.write(`Write mode: ${report.writeMode}\n\n`);

  if (report.activation?.requested) {
    process.stdout.write('Activation:\n');
    process.stdout.write(`- agent: ${report.activation.agent_id}\n`);
    process.stdout.write(`- self-test server confirmed: ${report.activation.server_confirmed ? 'yes' : 'no'}\n`);
    process.stdout.write(`- scope: ${report.activation.activation_scope}\n`);
    process.stdout.write(`- coverage verified: ${report.activation.coverage_verified ? 'yes' : 'no'}\n`);
    process.stdout.write(`- passive live in this process: ${report.activation.passive_live ? 'yes' : 'no'}\n`);
    process.stdout.write(`- reload required: ${report.activation.reload_required ? 'yes' : 'no'}\n`);
    if (report.activation.next_action) process.stdout.write(`- next action: ${report.activation.next_action}\n`);
    process.stdout.write('\n');
  }

  process.stdout.write('Detected:\n');
  for (const [key, value] of Object.entries(report.detected)) {
    process.stdout.write(`- ${key}: ${value ? 'yes' : 'no'}\n`);
  }

  process.stdout.write('\nPlanned changes:\n');
  for (const change of report.changes) {
    const marker = change.applied ? 'wrote' : change.changed ? 'would write' : 'unchanged';
    process.stdout.write(`- ${marker}: ${change.label} (${change.path})\n`);
  }

  process.stdout.write('\nSelf-test:\n');
  if (report.selfTest.skipped) {
    process.stdout.write(`- skipped: ${report.selfTest.reason}\n`);
    if (report.selfTest.exact_fix) process.stdout.write(`- exact fix: ${report.selfTest.exact_fix}\n`);
  } else {
    process.stdout.write(`- active: ${report.selfTest.active ? 'yes' : 'no'}\n`);
    process.stdout.write(`- decision_id: ${report.selfTest.decision_id}\n`);
    process.stdout.write(`- health: ${report.selfTest.health || 'unknown'}\n`);
    process.stdout.write(`- one-call runtime: ${report.selfTest.runtime_active ? 'active' : 'not verified'}\n`);
    if (report.selfTest.error) process.stdout.write(`- error: ${report.selfTest.error}\n`);
    if (report.selfTest.next_action) process.stdout.write(`- next action: ${report.selfTest.next_action}\n`);
    const update = report.selfTest.client_update;
    const notification = update?.notification_state || update?.notification;
    if (update && (update.update_available === true || update.version_status === 'unknown' || notification === 'unknown' || notification === 'version_unknown' || notification === 'security_required')) {
      process.stdout.write('\nMarrow client update:\n');
      process.stdout.write(`- priority: ${notification === 'security_required' ? 'security_required' : notification === 'recommended' ? 'recommended' : update.version_status === 'unknown' || notification === 'unknown' || notification === 'version_unknown' ? 'version_unknown' : update.priority || 'recommended'}\n`);
      process.stdout.write(`- installed: ${update.installed_version || update.current_version || 'unknown'}\n`);
      process.stdout.write(`- latest: ${update.latest_version || 'unknown'}\n`);
      process.stdout.write('- automatic notification: yes\n');
      process.stdout.write('- automatic local mutation: no; operator policy applies\n');
      if (update.owner_notice) process.stdout.write(`- tell owner: ${update.owner_notice}\n`);
      if (update.agent_instruction) process.stdout.write(`- agent instruction: ${update.agent_instruction}\n`);
      if (update.update_command || update.exact_update_command || update.auto_update_command) {
        process.stdout.write(`- update: ${update.auto_update_command || update.update_command || update.exact_update_command}\n`);
      }
      if (update.verification_command || update.exact_verification_command) process.stdout.write(`- verify: ${update.verification_command || update.exact_verification_command}\n`);
    }
    if (report.selfTest.first_value_signal) {
      process.stdout.write('\nFirst value:\n');
      const valueMoment = report.selfTest.install_value_moment;
      if (valueMoment) {
        process.stdout.write(`- ${valueMoment.headline}\n`);
        process.stdout.write('- First proof:\n');
        for (const proof of valueMoment.proof) process.stdout.write(`  - ${proof}\n`);
        process.stdout.write(`- ${valueMoment.fleet_signal}\n`);
        process.stdout.write(`- Try this now: ${valueMoment.try_this_now}\n`);
        process.stdout.write(`- Expected: ${valueMoment.expected_response}\n`);
      } else {
        process.stdout.write(`- ${report.selfTest.first_value_signal.headline}\n`);
        process.stdout.write(`- First useful lesson: ${report.selfTest.first_value_signal.first_lesson}\n`);
        if (report.selfTest.first_value_signal.value_proof.length) {
          process.stdout.write(`- Proof: ${report.selfTest.first_value_signal.value_proof.join('; ')}\n`);
        }
        process.stdout.write(`- Next: ${report.selfTest.first_value_signal.next_action}\n`);
      }
    }
    if (report.selfTest.token_value_proof) {
      const proof = report.selfTest.token_value_proof;
      const observed = proof.observed || {};
      const savings = proof.savings || {};
      const tokens = observed.tokens || {};
      process.stdout.write('\nToken value proof:\n');
      process.stdout.write(`- passive capture: ${proof.enabled ? 'on' : 'unknown'}\n`);
      process.stdout.write(`- model calls observed: ${observed.model_calls || 0}\n`);
      process.stdout.write(`- tokens observed: ${tokens.total || 0}\n`);
      process.stdout.write(`- estimated tokens saved: ${savings.estimated_tokens_saved || 0}\n`);
      if (savings.confidence) process.stdout.write(`- confidence: ${savings.confidence}\n`);
      if (proof.proof_line) process.stdout.write(`- proof: ${proof.proof_line}\n`);
      if (proof.exact_next_action) process.stdout.write(`- next: ${proof.exact_next_action}\n`);
    }
  }

  if (report.harnessReload) {
    process.stdout.write('\nHarness reload:\n');
    process.stdout.write(`- required: ${report.harnessReload.required ? 'yes' : 'no'}\n`);
    process.stdout.write(`- live in this process: ${report.harnessReload.live_in_this_process ? 'yes' : 'no'}\n`);
    if (report.harnessReload.instruction) process.stdout.write(`- restart: ${report.harnessReload.instruction}\n`);
    if (report.harnessReload.prove_command) process.stdout.write(`- prove after restart: ${report.harnessReload.prove_command}\n`);
  }
  if (report.firstCapture) {
    process.stdout.write('\nFirst capture:\n');
    process.stdout.write(`- client: ${report.firstCapture.client}\n`);
    process.stdout.write(`- capability: ${report.firstCapture.capability_level}\n`);
    if (report.firstCapture.command) process.stdout.write(`- command: ${report.firstCapture.command}\n`);
    process.stdout.write(`- ${report.firstCapture.instruction}\n`);
  }

  if (report.remediation) {
    process.stdout.write('\nRemediation:\n');
    process.stdout.write(`- attempted: ${report.remediation.attempted ? 'yes' : 'no'}\n`);
    process.stdout.write(`- fixed config: ${report.remediation.fixedConfig ? 'yes' : 'no'}\n`);
    process.stdout.write(`- self-test passed: ${report.remediation.selfTestPassed ? 'yes' : 'no'}\n`);
    if (report.remediation.message) process.stdout.write(`- result: ${report.remediation.message}\n`);
  }

  if (report.configDiagnostics?.npm_token?.mismatch || report.configDiagnostics?.npm_token?.missing_npmrc_token) {
    const npm = report.configDiagnostics.npm_token;
    process.stdout.write('\nConfig diagnostics:\n');
    process.stdout.write(`- npm token mismatch: ${npm.mismatch ? 'yes' : 'no'}\n`);
    process.stdout.write(`- npmrc token missing: ${npm.missing_npmrc_token ? 'yes' : 'no'}\n`);
    process.stdout.write(`- repairable: ${npm.repairable ? 'yes' : 'no'}\n`);
    if (npm.recommended_fix) process.stdout.write(`- exact fix: ${npm.recommended_fix}\n`);
  }

  if (report.configRepairs?.length) {
    process.stdout.write('\nConfig repairs:\n');
    for (const repair of report.configRepairs) {
      process.stdout.write(`- ${repair.changed ? 'fixed' : 'checked'}: ${repair.message}\n`);
    }
  }

  if (report.sdkDependency?.required) {
    process.stdout.write('\nSDK dependency:\n');
    process.stdout.write(`- @getmarrow/sdk: ${report.sdkDependency.present ? 'present' : 'missing'}\n`);
    if (report.sdkDependency.install_command) process.stdout.write(`- exact fix: ${report.sdkDependency.install_command}\n`);
    if (report.sdkDependency.warning) process.stdout.write(`- warning: ${report.sdkDependency.warning}\n`);
  }

  process.stdout.write('\nAutomatic controller:\n');
  process.stdout.write(`- state: ${report.controller?.active ? 'active' : report.controller?.state || 'unavailable'}\n`);
  if (report.controller?.started_at) process.stdout.write(`- started: ${report.controller.started_at}\n`);
  if (report.controller?.exact_fix) process.stdout.write(`- exact fix: ${report.controller.exact_fix}\n`);

  if (report.writeMode === 'doctor') {
    const liveHere = !report.harnessReload?.required;
    const activeLabel = report.doctor.active && liveHere
      ? 'yes'
      : report.doctor.active
        ? 'server confirmed, restart required'
        : 'no';
    process.stdout.write('\nDoctor:\n');
    process.stdout.write(`- Marrow active: ${activeLabel}\n`);
    process.stdout.write(`- missing env: ${report.doctor.missingEnv.length ? report.doctor.missingEnv.join(', ') : 'none'}\n`);
    if (report.doctor.envHints.length) process.stdout.write(`- possible env files: ${report.doctor.envHints.join(', ')}\n`);
    process.stdout.write(`- missing hooks/config: ${report.doctor.missingHooks.length ? report.doctor.missingHooks.join('; ') : 'none'}\n`);
    if (report.doctor.mcpProcesses?.available) {
      const processes = report.doctor.mcpProcesses;
      process.stdout.write(`- MCP process versions: ${processes.active_versions.length ? processes.active_versions.join(', ') : processes.active_processes ? 'unknown' : 'none'}\n`);
      process.stdout.write(`- stale/mixed/version-unknown MCP clients: ${processes.healthy ? 'no' : 'yes'}\n`);
      if (processes.restart_instruction) process.stdout.write(`- restart required: ${processes.restart_instruction}\n`);
      if (processes.verification_command) process.stdout.write(`- verify repair: ${processes.verification_command}\n`);
    }
    if (report.doctor.mcpConfigurations) {
      const configurations = report.doctor.mcpConfigurations;
      process.stdout.write(`- configured MCP versions: ${configurations.configured_versions.length ? configurations.configured_versions.join(', ') : 'none pinned'}\n`);
      process.stdout.write(`- stale/mixed/version-unknown MCP configuration: ${configurations.healthy ? 'no' : 'yes'}\n`);
    }
    if (report.doctor.recommendedFix) process.stdout.write(`- recommended fix: ${report.doctor.recommendedFix}\n`);
    process.stdout.write(`- live health: ${report.doctor.healthCommand}\n`);
  }

  if (report.writeMode === 'dry-run') {
    process.stdout.write('\nRun with --yes to write these changes.\n');
  }

  if (report.warnings.length > 0) {
    process.stdout.write('\nWarnings:\n');
    for (const warning of report.warnings) {
      process.stdout.write(`- ${warning}\n`);
    }
  }
}

async function install(options) {
  if (options.activate && (options.yes !== true || options.dryRun || options.doctor)) {
    throw new Error('activate requires write mode (--yes) because hooks must be installed during this run');
  }
  if (options.activate && options.selfTest === false) {
    throw new Error('activate requires the server self-test');
  }
  if (options.repair && options.yes !== true && !options.dryRun && !options.doctor) {
    throw new Error('repair requires explicit write authorization (--yes)');
  }
  const detection = detectEnvironment(options.cwd);
  const client = detectedClient(detection);
  options.client = client;
  options.agentId = String(options.agentId || '').trim() || stableAgentId(detection.root, client);
  const plan = buildPlan(detection, options);
  const writeMode = options.doctor ? 'doctor' : options.dryRun ? 'dry-run' : options.repair ? 'repair' : options.yes ? 'write' : 'dry-run';
  const changes = applyPlan(plan, options);
  const profile = activationProfile(detection, plan, changes, client);
  options.activation = options.activate ? {
    harness: client,
    agent_id: options.agentId,
    install_surface: plan.mode,
    mode: options.governanceMode || 'passive',
    hooks_installed: changes
      .filter((change) => change.changed && change.applied && /hook|runtime|rule|instruction|config/i.test(change.label))
      .map((change) => change.label)
      .slice(0, 20),
    capture_verified: false,
    configuration_complete: changes.every((change) => change.applied || change.already_present),
    evidence_authority: 'client_self_reported',
    coverage_verified: false,
    adapter_version: profile.adapter_version,
    capability_level: profile.capability_level,
    config_fingerprint: profile.config_fingerprint,
    expected_hooks: profile.expected_hooks,
    observed_hooks: profile.observed_hooks,
    complete: profile.complete,
    intervention_verified: false,
    closure_verified: false,
  } : null;
  const configInspection = inspectNpmTokenConfig();
  const sdkDependency = inspectSdkDependency(detection);
  const configDiagnostics = configInspection.safe;
  const configRepairs = options.repair && options.yes && !options.dryRun && !options.doctor
    ? repairConfigDiagnostics(configDiagnostics)
    : [];
  const envHints = options.apiKey ? [] : findLikelyEnvFiles(detection);
  const mcpProcesses = inspectMcpProcesses({ commands: options.processCommands });
  const mcpConfigurations = inspectMcpConfigurations(detection, { paths: options.mcpConfigPaths });
  let selfTest;
  try {
    selfTest = await runSelfTest(options);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (options.activate) throw new Error(`Marrow activation failed: ${message}`);
    selfTest = { skipped: false, active: false, error: message };
  }
  if (options.activate && !selfTest.activation_verified) {
    throw new Error('Marrow activation failed: server confirmation was not returned');
  }
  const changedConfig = changes.some((change) => change.applied) || configRepairs.some((repair) => repair.changed);
  const selfTestPassed = Boolean(!selfTest.skipped && selfTest.active && !selfTest.error);
  const controllerPlatform = options.controllerPlatform || process.platform;
  let controller = await controllerStatus({
    root: detection.root,
    agentId: options.agentId,
    platform: controllerPlatform,
  });
  const shouldEnsureController = options.controller !== false
    && controllerSupportedPlatform(controllerPlatform)
    && Boolean(options.apiKey)
    && selfTestPassed
    && !options.dryRun
    && !options.doctor
    && (options.yes || options.activate || options.repair);
  if (shouldEnsureController) {
    try {
      controller = await ensureGovernanceController({
        apiKey: options.apiKey,
        baseUrl: options.baseUrl,
        agentId: options.agentId,
        client,
        root: detection.root,
        mode: plan.mode,
        profile: options.governanceMode || 'default',
        policy: options.governancePolicy || 'warn',
        platform: controllerPlatform,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      controller = {
        active: false,
        state: 'error',
        exact_fix: 'Run npx @getmarrow/install controller ensure after correcting the reported local controller error.',
        error: message,
      };
      if (options.activate) throw new Error(`Marrow activation failed: local controller did not start: ${message}`);
    }
  }
  const remediation = options.repair
    ? {
      attempted: true,
      fixedConfig: changedConfig,
      selfTestPassed,
      message: selfTestPassed
        ? selfTest.health === 'healthy'
          ? 'I fixed Marrow passive config, one-call runtime is active, and self-test passed.'
          : `I fixed Marrow passive config and self-test passed; status is ${selfTest.health || 'unknown'}${selfTest.next_action ? `. Next action: ${selfTest.next_action}` : ''}.`
        : selfTest.skipped
        ? `Config repair ran, but self-test skipped: ${selfTest.reason}.`
        : `Config repair ran, but self-test failed: ${selfTest.error || 'unknown error'}.`,
    }
    : null;

  return {
    root: detection.root,
    adapterProvenance: ADAPTER_PROVENANCE,
    mode: plan.mode,
    writeMode,
    detected: {
      node: detection.node,
      python: detection.python,
      claudeCode: detection.claudeCode,
      cursor: detection.cursor,
      codex: detection.codex,
      openclaw: detection.openclaw,
      mcpConfig: detection.mcpConfig,
    },
    activation: {
      requested: options.activate,
      agent_id: options.agentId,
      server_confirmed: Boolean(selfTest.activation_verified),
      activation_scope: selfTest.activation_scope || null,
      coverage_verified: false,
      passive_live: false,
      reload_required: Boolean(options.activate),
      next_action: selfTest.activation_next_action || null,
      receipt: selfTest.activation_receipt || null,
      profile,
    },
    harnessReload: harnessReloadPlan(detection, changes),
    firstCapture: firstCapturePath(detection, options.agentId),
    changes,
    doctor: {
      active: Boolean(!selfTest.skipped && selfTest.active),
      missingEnv: options.apiKey ? [] : ['MARROW_API_KEY'],
      envHints,
      missingHooks: changes.filter((change) => change.changed).map((change) => change.label),
      mcpProcesses,
      mcpConfigurations,
      recommendedFix: mcpProcesses.exact_fix || mcpConfigurations.exact_fix || configDiagnostics.npm_token.recommended_fix || (!options.apiKey
        ? envHints.length
          ? `MARROW_API_KEY was found in a likely env file at ${envHints[0]}. Load that key from trusted secret storage, export only MARROW_API_KEY, then run npx @getmarrow/install --repair.`
          : 'Set MARROW_API_KEY, then run npx @getmarrow/install --repair.'
        : controller.exact_fix || selfTest.recommended_fix || null),
      healthCommand: 'npx -y --package=@getmarrow/mcp@latest marrow-mcp ping',
    },
    remediation,
    configDiagnostics,
    configRepairs,
    sdkDependency,
    controller,
    selfTest,
    warnings: [
      ...(options.keyFromArg
        ? ['Avoid --key in shared shells because command-line arguments can be visible in process listings. Prefer MARROW_API_KEY in your environment or secret manager.']
        : []),
      ...(!mcpProcesses.healthy
        ? ['Stale, mixed, or version-unknown Marrow MCP clients are active. Run the exact repair command, then restart every owning harness.']
        : []),
      ...(!mcpConfigurations.healthy
        ? ['Stale, mixed, or version-unknown Marrow MCP versions remain in owner configuration. Repair each owning workspace and restart its harness.']
        : []),
    ],
  };
}

async function runCli(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  const report = await install(options);
  if (options.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    printReport(report);
  }
}

module.exports = {
  parseArgs,
  detectEnvironment,
  buildPlan,
  applyPlan,
  install,
  runSelfTest,
  runCli,
  passiveRuntimeSource,
  inspectNpmTokenConfig,
  inspectSdkDependency,
  inspectMcpProcesses,
  inspectMcpConfigurations,
  buildInstallValueMoment,
  buildTokenValueProof,
  stableAgentId,
  activationProfile,
  claudeNativeHookFingerprint,
  printReport,
  ADAPTER_PROVENANCE,
  HARNESS_CAPABILITY_REGISTRY,
  defaultHarnessInstallMatrix,
  harnessReloadPlan,
  firstCapturePath,
};

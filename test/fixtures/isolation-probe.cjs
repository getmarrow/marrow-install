// Reports, as booleans only, what a node child started by a test can see of the isolation (never a value).
// Started by test/child-isolation.test.js with argv: <test temp root> <scratch passwd home>.
const os = require('node:os');

const [root, passwd] = process.argv.slice(2);
const home = process.env.HOME;
const report = {
  homeUnderTemp: typeof home === 'string' && home.startsWith(`${root}/`),
  passwdHomeIsScratch: os.userInfo().homedir === passwd,
  noNodeOptions: process.env.NODE_OPTIONS === undefined,
  noGitNames: ['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT', 'GIT_ALLOW_PROTOCOL', 'GIT_ASKPASS', 'SSH_ASKPASS']
    .every((name) => process.env[name] === undefined),
  preloaded: process.execArgv.includes('--require'),
};
if (process.send) process.send(report);
else process.stdout.write(JSON.stringify(report));

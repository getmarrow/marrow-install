'use strict';

// Stands in for `@getmarrow/mcp cursor-pre-action-hook` on a beforeMCPExecution event, for the guard
// tests that put the MCP decision in the loop. The own-tool decision is the real one: the vendored
// dist/ of 3.9.107 (test/fixtures/mcp-3.9.107) run against the HOME and working directory of this
// process, which the guard inherited from the hook run. As in the MCP, an event is a Marrow own tool
// only when the server is exactly `marrow` and the tool is one of the registered names (its label is
// then `mcp__marrow__<tool>`); the answer is allow when the host's own configuration proves the
// server, and a hold (`ask`) for everything else.
const path = require('node:path');

const MCP = path.join(__dirname, '..', 'fixtures', 'mcp-3.9.107');
const identity = require(path.join(MCP, 'own-server-identity.js'));
const { MARROW_OWN_TOOL_NAMES } = require(path.join(MCP, 'own-tool.js'));
const names = new Set([...MARROW_OWN_TOOL_NAMES]);

// The hook the installer starts runs inside its loader, which leaves the decoded launcher in `global.MARROW_L`; the MCP's host proof
// accepts an installer launch only when it is exactly the launch of that loader (MCP 3.9.106).
const PINS = require('../../src/pins');
const mcpRuntime = require('../../src/mcp-runtime');
globalThis.MARROW_L = mcpRuntime.launcherSource(mcpRuntime.runtimeConfig(PINS.MCP_ADAPTER_VERSION));

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('end', () => {
  let event = {};
  try {
    event = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    event = {};
  }
  const own = event && event.mcp_server_name === 'marrow' && typeof event.tool_name === 'string' && names.has(event.tool_name);
  const allow = own && identity.isOfficialMarrowMcpEventOnHost('cursor', { tool_name: `mcp__marrow__${event.tool_name}` }, event);
  process.stdout.write(`${JSON.stringify(allow
    ? { permission: 'allow' }
    : { permission: 'ask', user_message: 'held by the MCP decision', agent_message: 'held' })}\n`);
});

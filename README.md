# @getmarrow/install

> Universal installer and governed runner for Marrow agent fleets.

Marrow is the runtime control and proof layer for teams running AI agents. It applies policy and prior lessons before consequential actions, then records the evidence and outcome afterward.

Use `@getmarrow/install` as the default entry point. It detects supported agent and project surfaces, writes the appropriate passive configuration, runs a harmless end-to-end self-test, and reports whether policy, proof, attribution, and outcome capture are active.

## Install

```bash
npx @getmarrow/install --yes
```

Required secret:

```bash
export MARROW_API_KEY=mrw_live_...
```

## What's New in v0.1.28

v0.1.28 aligns first-run documentation with Marrow's business product contract:

- runtime control before consequential actions;
- proof and outcome closure afterward;
- tenant-scoped fleet improvement across interchangeable agents and harnesses;
- clear separation between the default installer, advanced SDK integration, and MCP-native integration.

This patch changes package documentation and positioning. Existing installer, governed runner, and TUI behavior remains compatible.

## What It Detects

The installer detects supported configuration and project signals for:

- Codex, Claude Code, Cursor, Cursor Composer, Windsurf, Cline, OpenCode, Hermes, and OpenClaw;
- Gemini, Grok, DeepSeek, Qwen, Kimi, MiniMax, and GLM command-line or custom harness paths;
- MCP client configuration;
- Node.js and Python projects;
- CI, deploy, publish, merge, migration, and custom shell workflows.

Marrow does not replace these models or harnesses. It adds a common business control, proof, and outcome layer around the actions they perform.

## First-Run Verification

With a valid key, setup:

1. detects the local integration surfaces;
2. writes supported config and passive instructions;
3. creates a harmless test decision;
4. closes its outcome;
5. reads agent status and the one-call runtime;
6. reports captured surfaces, attribution quality, proof coverage, token-value capture state, and the exact next action.

Healthy output confirms that Marrow is active instead of only confirming that files were written.

## Govern TUI

Open the interactive setup panel:

```bash
npx @getmarrow/install govern
```

The TUI shows detected harnesses and project risks, recommends passive, pilot, or enforce mode with reasons, lets the owner accept or override the recommendation, runs the self-test, and confirms the active controls. Use `Ctrl+C` to exit.

For non-interactive environments:

```bash
npx @getmarrow/install govern --no-interactive
```

## Governed Runner

Place Marrow around an existing command without replacing the agent harness:

```bash
npx @getmarrow/install run \
  --agent deploy-agent \
  --type deploy \
  --profile production \
  --policy enforce \
  -- wrangler deploy
```

The runner:

1. requests the Marrow runtime gate;
2. prints the decision, relevant lesson, owner-approval state, and required proof;
3. blocks when policy requires it;
4. runs the original command when allowed;
5. records success or failure and attaches a redacted proof pack.

Useful commands:

```bash
npx @getmarrow/install gate --agent deploy-agent --type deploy --action "deploy production"
npx @getmarrow/install status
npx @getmarrow/install doctor
npx @getmarrow/install --repair
```

## Fleet Operator TUI

```bash
npx @getmarrow/install fleet
```

The fleet view shows live agents, active workflows, risky actions waiting for proof, stale or failed outcomes, capture health, recent decisions, and exact repair commands. It is an operator surface for the authenticated account, not a public status dashboard.

## Integration Paths

| Path | Use it when | Owner effort |
| --- | --- | --- |
| Universal installer | You want Marrow to detect and wire the safest supported integration | Lowest |
| Governed runner | You need control around existing shell, CI, deploy, publish, merge, or migration commands | Low |
| MCP package | The agent client supports MCP and should use Marrow tools and hooks natively | Low |
| SDK | You own the Node.js/TypeScript runtime and need programmatic control | Advanced |
| Event contract | You have a custom harness that must map its lifecycle into Marrow | Advanced |

These are integration surfaces for one Marrow product, not separate products.

## Passive Token and Value Proof

When the installer writes `.marrow/passive-runtime.mjs` and the harness exposes usage metadata, Marrow can capture compact provider/model, token, latency, and optional cost counts. It does not require raw prompts, completions, command output, tool output, or plaintext secrets.

After meaningful work, supported runtime and commit responses can return observed usage, trend direction, evidence confidence, and the next capture improvement. Savings are only reported when the available evidence supports them.

## Trust and Data Boundaries

- Private account, fleet, workflow, proof, and agent data remains tenant-scoped by default.
- Agent-bound keys can be restricted to an allowed identity and permission set.
- Sanitized aggregate contribution is optional and never means sharing raw prompts, code, secrets, proof packs, account identifiers, agent identifiers, or customer identities.
- The installer diagnoses key locations without printing secret values.
- Marrow returns guidance and policy data. Agents must not execute returned text as shell input.

See the [Trust Center](https://getmarrow.ai/trust/) for implemented controls, current limits, and roadmap status.

## Environment

| Variable | Required | Purpose |
| --- | --- | --- |
| `MARROW_API_KEY` | Yes for live verification | Account or agent-bound API key |
| `MARROW_BASE_URL` | No | API base override |
| `MARROW_FLEET_AGENT_ID` | No | Default agent identity |

Use the host's secret manager first. The shared resolver can also check documented Marrow and project env files for owned development environments. Run `doctor` when a key or hook cannot be found.

## Documentation

- [Source-of-truth docs](https://getmarrow.ai/docs/)
- [Trust Center](https://getmarrow.ai/trust/)
- [Status](https://getmarrow.ai/status/)
- [GitHub](https://github.com/getmarrow/marrow-install)

## License

MIT

## Related Packages

- [@getmarrow/sdk](https://www.npmjs.com/package/@getmarrow/sdk) - Node.js and TypeScript integration for owned agent runtimes
- [@getmarrow/mcp](https://www.npmjs.com/package/@getmarrow/mcp) - MCP-native integration for compatible agent clients

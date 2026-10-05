# Owner agent instructions

Keep changes small.

<!-- marrow:passive-start -->
## Marrow Passive Agent Memory

Marrow should run passively after install:

- Use MCP plus these instructions in every workspace: `npx -y --package=@getmarrow/mcp@3.9.98 marrow-mcp setup`.
- Leave `MARROW_TOOL_PROFILE` unset for the 17-tool primary surface. Set `MARROW_TOOL_PROFILE=core` or `MARROW_TOOL_PROFILE=full` only as an explicit opt-in; backend plans and permissions still enforce access to every visible tool.
- Use SDK passive runtime in owned Node processes: `createPassiveRuntime().install()`.
- Native Claude hooks install only when `.claude` is present. Codex native hooks install into `.codex/hooks.json`; Cursor and Composer use `.cursor/hooks.json`; Cline uses non-overwriting executable files under `.clinerules/hooks/`; Windsurf uses `.windsurf/hooks.json`; Gemini CLI uses `.gemini/settings.json`; Grok uses trusted global `~/.grok/hooks/marrow.json`. Restart the host, enable/review hooks, disable Windsurf Restricted Mode where native hooks are required, and trust the workspace before claiming runtime coverage. The governed wrapper remains an explicit bounded fallback. Hermes, OpenClaw, and custom hosts need a bounded event adapter.
- Keep passive token/model usage proof enabled. Empty savings stay zero until observed model usage lands. Do not invent token, cost, or time savings.
- Before risky work, use Marrow's decision brief or passive prompt hook.
- After activate writes MCP or hooks, restart this harness, then run `npx @getmarrow/install@latest doctor --self-test`. Do not claim Marrow is live in a process that has not reloaded.
- First turn: tell the owner the gate is live and empty savings are honest. The next deploy, merge, or publish must go through Marrow.
- Cursor and Composer use configured native hooks after restart and `/hooks` trust review. Cline uses its configured PreToolUse, PostToolUse, and TaskCancel hooks only after Enable Hooks, restart, executable trust, and workspace trust; TaskComplete is not claimed as current coverage. Windsurf uses configured native pre-action, success-result, and response-closeout hooks only after restart, trust review, and leaving Restricted Mode. Gemini CLI uses configured BeforeTool, AfterTool, and AfterAgent hooks only after restart and project fingerprint review and approval in `/hooks panel`; explicit user disablement is preserved. Grok uses global native PreToolUse, PostToolUse/PostToolUseFailure, and one nonblocking Stop closeout only after restart and `/hooks` inspection; Grok hooks remain user-toggleable. MCP tools remain on demand. Codex uses configured native hooks after restart and `/hooks` trust review. The governed wrapper remains an explicit bounded fallback.
- Before the session ends, close open work with session-end auto-commit or `marrow_commit`. Record model usage only when the host response includes counts.
- After meaningful work, record the outcome so future agents learn from it.
- After Marrow blocks, warns, or requires review, use the decision trace receipt to tell the operator what changed and which recorded workflow or proof is required. Stay quiet for routine low-risk work.
- Check health with `marrow_agent_status` or `GET /v1/agent/status`.
- When status/runtime returns a `client_update` notice, tell the operator and use its exact update and verification commands only when local change policy permits.

Required environment:

- `MARROW_API_KEY`
- Optional: `MARROW_BASE_URL`, `MARROW_FLEET_AGENT_ID`, `MARROW_CLIENT`
- Optional: `MARROW_PASSIVE_TOKEN_USAGE=false` disables compact provider usage capture when needed.
<!-- marrow:passive-end -->

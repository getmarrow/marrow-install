`claude-settings.json`: the `.claude/settings.json` that @getmarrow/install 0.1.72 (marrow-install
c03df1a3) writes into an empty project offline (`detectEnvironment` -> `buildPlan` -> `applyPlan`, the
`activate`/setup path), with the host-approval hooks of its pinned MCP 3.9.103. Its tool matcher is the
3.9.103 fixed list that skipped Monitor, PowerShell, WebFetch and Agent (PKG-H2). Commands name `$HOME`
literally; no path of the machine that generated it is in the file.

# @minions/platform-sdk

The publishable Minions Platform SDK. Installing this package gets an
external application:

- `McpServerCore` — the generic MCP session/transport/action-group mounting
  core (from `@minions/mcp-server-core`), for mounting your own type-safe
  `ActionGroupDef`s into your own server.
- The standard minion/mission/movement tool set (from
  `@minions/minions-runtime-core`) — minion spawn/list/history/kill,
  missions, and movement/git operations — ready to bind to that server.

Every `@minions/*` workspace dependency these two libs need is bundled into
this package's own `dist/index.js` at build time; nothing beyond real npm
packages (`@modelcontextprotocol/sdk`, `effect`, `eventemitter3`, `express`,
`@anthropic-ai/sdk`) is required at runtime, and no `apps/cabinet` or other
app-specific code is part of the bundle.

See `docs/getting-started/application-tool-sdk.md` in this repo for the full
install-and-mount walkthrough, and `starters/minimal-server` alongside this
package for a copyable starting point for the server half of a new
application.

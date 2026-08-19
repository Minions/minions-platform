# Getting Started: Building an Application on the Minions Platform SDK

This walks an external application author through installing the Minions
Platform SDK and mounting a first tool, without cloning this repo. It
assumes you've read `docs/design/application-tool-sdk.md`'s "Why this
exists" for the motivation; this doc is the practical how-to for the
packaging that design settled on.

## What you get

`@minions/platform-sdk` is one self-contained package bundling:

- `McpServerCore` (from `@minions/mcp-server-core`) — the generic MCP
  session/transport/action-group mounting core. You construct one instance
  and mount tools onto it; it handles the streamable-HTTP MCP protocol
  wiring.
- The generic action-group primitives (`ActionGroupDef`, `ActionContext`,
  `dispatchActionGroup`, etc.) you use to author your own tools.
- The standard-core bundle (from `@minions/minions-runtime-core`) — minion
  spawn/list/history/kill, missions, and movement/git operations — ready to
  mount alongside your own tools, for free.

No `apps/cabinet` code, and no dependency back into this repo, is part of
the package: everything it needs is bundled into its own `dist/index.js` at
build time.

## 1. Install

```sh
npm install @minions/platform-sdk
# or: pnpm add @minions/platform-sdk / yarn add @minions/platform-sdk
```

(The packaging mechanism is a standard npm-style package — see "Why an npm
package, not a git-based install" below for the reasoning, if you're
choosing how to distribute your own similarly-shaped SDK.)

## 2. Construct a server instance

```ts
import { McpServerCore } from '@minions/platform-sdk';

const core = new McpServerCore(
  { name: 'my-application', version: () => '0.1.0' },
  {
    // Build the base ActionContext passed to every mounted tool's dispatch.
    buildActionContext: () => ({ /* whatever your tools' ActionContext needs */ }),
    // Handle any tool name that isn't a mounted action group.
    handleOtherTool: async (name) => {
      throw new Error(`Unhandled tool: ${name}`);
    },
  },
);
```

## 3. Mount your own tool

An application tool is a plain `ActionGroupDef` — the same shape every
built-in Minions tool (`plan`, `movement`, ...) uses. Author the interface
once and share it between your server-side implementation and your UI's
prop types (see `docs/design/application-tool-sdk.md`, "Piece 3" for why
that pairing is type-safe with no new mechanism):

```ts
import type { ActionContext, ActionGroupDef } from '@minions/platform-sdk';

export const helloActionGroup: ActionGroupDef = {
  name: 'hello',
  description: 'Greet a user by name.',
  coreActions: {
    greet: {
      description: 'Greet the given name.',
      help: 'hello greet name=<string>',
      params: { name: { type: 'string' } },
      required: ['name'],
      execute: async (_ctx: ActionContext, params: Record<string, unknown>) => {
        const { name } = params as { name: string };
        return { message: `Hello, ${name}!` };
      },
    },
  },
};

core.mountActionGroup(helloActionGroup);
```

## 4. Optionally bind the standard-core bundle

Get minion/mission/movement tools for free, mounted the same way:

```ts
import { movementActionGroup } from '@minions/platform-sdk';

core.mountActionGroup(movementActionGroup);
```

`@minions/platform-sdk` also re-exports `MinionManager`, `spawnMinion`,
`listMinions`, `MissionService`, and the rest of the standard-core surface
for wiring your own action groups around them, the same way `apps/cabinet`
does internally.

## 5. Expose it over HTTP

`McpServerCore` speaks the same streamable-HTTP MCP transport `apps/cabinet`
does — wire it into any Express app:

```ts
import express from 'express';

const app = express();
app.use(express.json());

app.post('/mcp', (req, res) => {
  void core.handleRequest(req, res, 'all', {});
});
app.get('/mcp', (req, res) => {
  void core.handleRequest(req, res, 'all', {});
});
app.delete('/mcp', (req, res) => {
  void core.handleRequest(req, res, 'all', {});
});

app.listen(3100);
```

That's the whole server half of a from-scratch application. A copyable,
working version of exactly this (custom tool + standard-core bundle +
Express wiring, with its own test proving both tools dispatch) lives in
this repo at `libs/starter-minimal-server/src/server.ts` — copy it and its
`package.json` into your own repo as your starting point, swapping the
`workspace:*` dependency for the published SDK range (e.g.
`"@minions/platform-sdk": "^0.1.0"`).

The UI shell half (a throne-room-equivalent frontend) is intentionally out
of scope here — see `docs/design/application-tool-sdk.md`, "Explicitly out
of scope" — but nothing about this packaging forecloses building one; your
server above is a normal MCP endpoint any client, including a custom UI,
can call.

## Why an npm package, not a git-based install

`docs/design/application-tool-sdk.md` left the packaging mechanism as an
open question. This SDK build resolves it: a **publishable npm-style
package**, not a git-based install pointed at a subdirectory of this repo.

- This repo's libs use pnpm's `catalog:`/`workspace:*` dependency
  protocols, meaningless to a plain `npm`/`yarn` install outside this
  pnpm workspace. A git-based install of a subdirectory would hand an
  external application a `package.json` full of specifiers it can't
  resolve.
- `@minions/platform-sdk`'s own build (`libs/minions-platform-sdk/vite.config.ts`
  for the JS bundle, `scripts/bundle-dts.mjs` for the type declarations)
  bundles every transitive `@minions/*` dependency `mcp-server-core` and
  `minions-runtime-core` need into `dist/index.js` plus a `dist/vendor/`
  tree of declaration files, so the published artifact only lists real npm
  packages (`@modelcontextprotocol/sdk`, `express`, `effect`,
  `eventemitter3`, `@anthropic-ai/sdk`) as dependencies. The invariant that
  actually enforces this — no `@minions/*` bare specifier survives anywhere
  in `dist/index.d.ts` or `dist/vendor/**/*.d.ts` — is a build-time check in
  `scripts/bundle-dts.mjs` itself (its final grep over every emitted `.d.ts`
  file), which fails the build loudly if one leaks through; inspecting the
  packed tarball's own `package.json` confirms the same for
  `dependencies`/`devDependencies` (no `@minions/*` entries, since
  `pnpm pack` resolves `catalog:`/`workspace:*` specifiers to real semver).
  Consuming the packed tarball's `dist/index.d.ts` from an isolated
  `tsconfig.json` outside this workspace is a useful extra sanity check,
  but only if that tsconfig sets `skipLibCheck: false` — with the default
  `skipLibCheck: true`, `tsc` doesn't verify that a `.d.ts` file's own
  internal imports resolve, so it would pass even against a build with
  unresolved `@minions/*` specifiers still in it, proving nothing about
  this specific class of bug. A `skipLibCheck: false` run also surfaces
  unrelated pre-existing issues in other libs' own type output (missing
  `.js` extensions on relative imports, mainly) that aren't in scope here —
  expect that noise, and don't mistake it for a regression in this package.
- A git-based install would also hand the application a full monorepo
  checkout (or require one) to build from, dragging in dev tooling and
  every unrelated app/lib in this repo, exactly the "clone minions to reach
  it" problem this SDK exists to remove. An npm package's `files` field
  (`dist`, `README.md`) keeps the published artifact to exactly what an
  application needs.
- It's the one mechanism that stays fully symmetric with how the SDK's own
  dependencies (`express`, `@modelcontextprotocol/sdk`) are consumed —
  `npm install` is the standard an application author already knows, no
  special-cased install step to document or support.

Verify the packaging step itself with a dry-run pack from
`libs/minions-platform-sdk`:

```sh
pnpm --filter @minions/platform-sdk run pack:dry-run
```

This builds the package and produces the real tarball
(`dist/pack-dry-run/minions-platform-sdk-*.tgz`) without publishing it —
inspect its contents and its `package.json` to confirm no `@minions/*` bare
specifiers or `apps/cabinet` code leaked into the artifact.

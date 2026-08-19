# Application-Tool SDK: Design

Status: **draft**. Sibling design to
`docs/design/cross-repo-plan-navigation.md` (status approved), which this
doc depends on and does not duplicate: it defines the `-mcp`/`-impl`
costume split — a hand-authored plain-TS interface per costume
(`MovementApi`-style), a generic `createRemoteApi` client proxy, and a
`createApi(ctx)` server-side factory — for built-in tools authored inside
this repo. This doc extracts that same mechanism so an external application
can use it for its own tools, without minions ever depending on that
application's repo. Read the other doc first if you haven't; this one
assumes it.

No plan node owns this doc yet. It is meant to seed one (or several) via
`.meta/workflows/create-plan.md`, in a later phase, once a human has
reviewed and approved this content.

## Why this exists

An application built on top of the Minions Platform (e.g. "sharing-keystones")
wants to define its own gadgets/tools in its own repo and mount them into
its own cabinet instance, with the same compile-time type safety built-in
tools get. This is different from both existing added-tool mechanisms:

- It is not a **user tool** (dynamically installed per-lair costume,
  discovered at runtime, `libs/gadgets/src/CostumeExtensions.ts`, plan goal
  `3a59deec`). That mechanism is deliberately erased at the dispatch
  boundary because the cabinet cannot know a dynamically-installed costume's
  shape at its own compile time. An application's tools are the opposite:
  the application's cabinet, its tools, and its UI are all compiled
  together, at that application's own build time, everything is knowable
  statically, the same way minions' own built-ins are knowable to
  `apps/cabinet`.
- It is not a **built-in tool** either, because it doesn't live in this
  repo, and it must never be made to. A prior incident,
  `author-packets-mcp`, added a compile-time dependency from `apps/cabinet`
  into an external repo via a `link:../../../local/sharing-keystones/...`
  dependency and a direct `mountActionGroup()` call at the cabinet's own
  boot code. That broke `tsc`/vitest/dev-server for any checkout without an
  out-of-band sibling checkout of the application's repo, and was reverted
  in commit `934eaf76`. The dependency direction must stay one-way:
  application → platform, never platform → application.

**The conclusion this design starts from:** application tools need no new
type-safety mechanism. The `-mcp`/`-impl` costume split, the plain-TS
interface each costume hand-authors, `createRemoteApi`, and the
`createApi(ctx)` server factory (see the other doc) already generalize
perfectly — an application tool is structurally identical to a built-in
tool from the type system's point of view: its own `<tool>-mcp` package
holding a hand-written interface, its own `<tool>-impl` package
implementing it. The only reason application tools can't already get this
today is *packaging*: the pieces that make it work (`MCPServer`'s mounting
API, the dispatch loop that calls `createApi(ctx)` per request) are trapped
inside `apps/cabinet`, an app that isn't importable. This doc is about
closing that packaging gap, not inventing new type theory.

## Piece 1: extract an SDK boundary for MCPServer's mounting API

### The domain-focused-design framing

This repo's own `CLAUDE.md` states: "technical domains are discovered, not
planned", start with infrastructure owned by each domain, and only extract
a shared technical domain once duplication becomes real. That moment has
arrived for MCP transport/dispatch: it is currently infrastructure owned by
exactly one domain-shaped consumer, `apps/cabinet`, but a second, structurally
identical consumer (an application's own cabinet instance) now needs the
same infrastructure and cannot reach it, because it lives inside an app,
not a lib. That is precisely the "discovered technical domain" case, budding
it off is not premature.

### What's actually in `MCPServer` today (verified, not assumed)

`apps/cabinet/src/mcp/MCPServer.ts` is not a clean protocol/transport shim,
confirmed by reading it directly: its constructor and fields carry direct,
concrete references to `WingManager`, `MinionManager`, `ProductionHatchery`,
`MissionService`, `QuestionQueue`, `ClosetMissionLoader`, registry config,
and more. It mixes two things that are currently inseparable only because
nobody has had to separate them:

| Generic ("SDK core") | minions-specific ("reference application") |
|---|---|
| Per-session `StreamableHTTPServerTransport` management | Wing lifecycle (`createWing`, `deleteWing`, `syncWing`, ...) |
| `tools: Tool[]`, `registerTool`/`registerGadget` | Minion spawn/list/history/kill |
| `actionGroups`/`actionGroupEndpoints`/`actionGroupActionEndpoints` maps and `mountActionGroup(def, endpoints, actionEndpoints)` | Mission service, question queue |
| `dispatchActionGroup`, `buildActionGroupSchema`, `getToolsForEndpoint` per-endpoint filtering | Registry install/publish, closet costume loading |
| `ListToolsRequestSchema`/`CallToolRequestSchema` MCP protocol wiring | `McpProxy` for external-server accessories |

The left column is genuinely domain-agnostic, it doesn't know or care
whether a mounted `ActionGroupDef` is `plan`, `movement`, or an
application's own `sharing-keystones` group. The right column is exactly
the minions product, expressed as tool registrations. `apps/cabinet/src/server.ts`'s
`createServer()` already treats them as separable in practice, it wires
each domain in by calling `registerTool`/`mountActionGroup` explicitly,
one call per domain, in an app entrypoint file. There is no exported,
reusable "wire a domain into a cabinet" function today; the separability is
implicit in how the file is structured, not enforced by a package boundary.

Beyond the generic SDK core itself, every application built on the Minions
Platform is also going to want the same starting point: the tools that make
up minions itself (minion spawn/list/history/kill, missions, movement/git
operations), plus commonly needed infrastructure like `libs/file-store`.
The SDK should package that as a pre-packaged "base set", the common core
for any platform-based app, distinct from costumes the platform may export
later that not every app wants and that an app mounts itself, on its own
initiative, if it wants them. See "The standard-core runtime lib," below,
for how that base set is packaged.

### The extraction

Move the left column into a new, importable lib: `libs/mcp-server-core`. It exports:

- The session/transport-management class itself (today's `MCPServer`,
  minus every minions-domain-specific field and method).
- `registerTool`, `mountActionGroup(def, endpoints, actionEndpoints)`,
  `dispatchActionGroup`, `buildActionGroupSchema`,
  `buildActionGroupDescription`, `getToolsForEndpoint`, largely a move,
  not a rewrite, since `libs/mcp-types/src/action-group.ts`'s doc comment
  already frames these as domain-agnostic, and `mountActionGroup` already
  accepts any `ActionGroupDef`, built-in or not.
- The `ListToolsRequestSchema`/`CallToolRequestSchema` protocol wiring and
  per-endpoint tool filtering.

`apps/cabinet` stops being the only place this mechanism can run. It
becomes the **reference application**: it imports the new lib, constructs
an instance, and composes minions' own domains onto it exactly the way
`createServer()` does today (wing management, minion orchestration,
missions, registry) as consumers of the SDK, not as code baked into the
SDK itself. An external application does the same thing from its own boot
code: import the lib, construct its own instance, call
`mountActionGroup(myAppActionGroup, endpoints)`, same call, same types,
zero dependency from minions into the application's repo. The dependency
arrow is application → new lib → (nothing app-specific); minions'
`apps/cabinet` also depends on the new lib, as a sibling consumer, never the
other way around.

`apps/cabinet/package.json` has no `main`/`types`/`exports` fields today
(confirmed by reading it), because it's a deployable Express app, not
designed to be imported. That doesn't change: `apps/cabinet` stays
unimportable. `libs/mcp-server-core` and `libs/minions-runtime-core` (below)
are the things an application imports, and libs in this repo already ship
proper `exports` maps (see `libs/planner/package.json`,
`libs/mcp-types/package.json` for the pattern to copy).

### The standard-core runtime lib

Package the "base set" from "The domain-focused-design framing," above, as
a second importable lib, `libs/minions-runtime-core`, sitting one layer
above `libs/mcp-server-core`:

- It contains the tools that make up minions itself, the standard core:
  minion spawn/list/history/kill, missions, movement/git operations
  (`movement-mcp`/`movement-impl`), and the shared infrastructure those
  depend on (`libs/file-store` and similar).
- Dependencies stay clean and one-directional: `libs/minions-runtime-core`
  depends on each bundled costume's `-impl` package (for real behavior) and
  transitively its `-mcp` package (for the interface), each of which
  depends on `libs/mcp-types` (the generic framework — `ActionContext`,
  `ActionMetadata`, `createRemoteApi`) and `libs/minions-types` (the
  branded identity types) from the other doc. No app-specific code lives
  inside `minions-runtime-core` itself.
- `apps/cabinet` imports `minions-runtime-core` and binds it directly to its
  `MCPServer` instance, exactly as it does today, just via the packaged lib
  instead of inline wiring in `createServer()`.
- An external application imports the same `minions-runtime-core`, adds its
  own action groups and tools on top, and binds the combined set to its own
  `MCPServer` instance, getting the standard core for free plus room for
  anything specific to its own product.
- Costumes and libs the platform ships as optional (not part of the
  mandatory base set) stay outside `minions-runtime-core`; an application
  mounts those itself if it wants them, the same way it mounts its own
  action groups.

### A packaged SDK build target

The extraction above makes the mechanism importable inside this monorepo,
but an external application still has to clone and build minions to reach
it, the only supported workflow today. Add a real build target that
packages `libs/mcp-server-core`, `libs/minions-runtime-core`, and the other
consumer-facing libs into one publishable Minions Platform SDK artifact, so
an application depends on the SDK the way it depends on any other package,
without cloning this repo. The build/publish pipeline itself is
implementation-task-level detail; the design conclusion is that this
extraction should target that artifact from the start, not stop at
in-repo importability.

The SDK should also make it trivial for an application to stand up both
halves of a full product, a throne-room-equivalent UI shell and a
cabinet-equivalent server, wired together, so a from-scratch application
isn't left to reverse-engineer the wiring `apps/cabinet`/`apps/throne-room`
do today. Full design of a hosted UI shell stays out of scope here (see
"Explicitly out of scope," below), but the SDK's own packaging should still
be shaped so scaffolding both pieces is the simplest path, not an
afterthought.

### What this doc does not resolve

- The exact class/function boundary inside `MCPServer.ts` (which methods
  move verbatim, which need a small interface to stay pluggable, e.g. how
  wing-scoped `activeCostumes` gating, which the SDK core's
  `getToolsForEndpoint` currently calls into directly, gets to stay
  minions-specific without becoming a hard dependency of the SDK core).
  That's implementation-task-level detail, not a design blocker: the
  generic/specific split above is real and verified, and the "expose a
  narrow interface/callback for the wing-gating hook" resolution is a small
  follow-up decision, not a re-derivation of this section's conclusion.

## Piece 2: the generic `createRemoteApi` client proxy

Fully specified in `docs/design/cross-repo-plan-navigation.md`'s "Client
proxy is fully generic" section (edited alongside this doc, not duplicated
here). Summary of what it means for an application:

- `createRemoteApi<TApi>(call: ActionCaller): TApi` lives in `mcp-types`
  (or a client-side-only sibling package, if `mcp-types` ends up split
  further so a purely-browser bundle never needs to see anything
  server-shaped — resolve during implementation; `createRemoteApi` itself
  has zero server dependencies, so it's safe in either location).
- An application's own `<tool>-mcp` package calls it exactly the way
  `movement-mcp` does: `export function createMyToolClient(call: ActionCaller): MyToolApi { return createRemoteApi<MyToolApi>(call); }`.
  Nothing about this requires minions to know `MyToolApi` exists — the
  helper is generic over any interface shape; only the application's own
  `-mcp` package names its own interface type.
- An application that also wants typed calls into platform built-ins it
  reuses just depends on that built-in's own `-mcp` package directly (e.g.
  `@minions/movement-mcp`) and calls `createMovementClient` — the same way
  any other caller of `movement` does. There is no merged "all action
  groups" map to maintain anywhere; each `-mcp` package is independently
  importable, so an application picks up exactly the ones it needs.
- The one piece that *is* application-specific: the real `ActionCaller`
  transport (which endpoint, which auth, which HTTP client) — every
  application supplies its own, the same way throne-room's `cabinet.ts`
  supplies minions'.

## Piece 3: gadget+UI pairing for application tools

### The target shape: every costume as one domain, client and server together

The strongest version of gadget+UI pairing is not specific to application
tools. Every costume, including minions' own built-in ones, should define
its UI and its tool together as one domain, so a normal call (any call
between that costume's own client and server parts) is type-safe by
construction, the same way this doc's `-mcp`/`-impl` split already makes
server-side dispatch type-safe. Concretely: a costume's client half and
server half live inside the same domain-owned code and depend on each
other as needed, so the type
checker holds them to each other at the costume's own build time. Libraries
end up depending on each other across costumes as needed, and costume build
time resolves all the types.

Only at runtime does that resolution get type-washed, and only at one
boundary: cabinet's dynamic `import()`/dispatch for costume-provided tools,
and throne-room's dynamic `import()`/instantiate-and-call for
costume-provided UI controls. That washing never reaches back into the
semantic binding between a costume's own client and server code, it stays
confined to the one place the cabinet or throne-room genuinely cannot know
a dynamically-loaded costume's shape ahead of time.

The one genuine complexity is a costume extending another costume:
replacing or augmenting a UI component, writing new UI that connects to
another costume's tooling, or replacing tooling underneath an existing UI.
Each of those is its own design problem, not resolved here. The shape above
is the target to design toward as those cases get worked out, not a
complete answer for extension today.

### Where user and application tools sit today, against that target

For user tools (costume-provided), gadget+UI pairing is inherently
best-effort, the cabinet cannot statically know a dynamically-installed
costume's shape, so nothing enforces that a costume's UI component actually
matches its tool's params/result at compile time.

Application tools get a strictly better guarantee, and it costs nothing new
to state: an application tool is naturally two small packages (`my-tool-mcp`,
`my-tool-impl`, same convention as any built-in costume), and its UI can
just depend on `my-tool-mcp` directly to get fully-checked prop types with
no new mechanism:

```ts
// my-app/tools/my-tool-mcp/src/MyToolApi.ts
export interface MyToolApi {
  doThing(params: { id: string }): Promise<{ ok: boolean }>;
}
export const myToolActionMetadata: Record<keyof MyToolApi, ActionMetadata> = {
  doThing: { description: '...', help: '...', required: ['id'] },
};
export function createMyToolClient(call: ActionCaller): MyToolApi {
  return createRemoteApi<MyToolApi>(call);
}
```

```ts
// my-app/ui/MyToolPanel.vue (or .tsx) — imports only my-tool-mcp, never my-tool-impl
import type { MyToolApi } from 'my-tool-mcp';
// props typed directly off MyToolApi['doThing']'s params/result — no server code in the browser bundle
```

This is the one thing user tools structurally cannot offer with the same
strength: a dynamically-installed costume's UI has no compile-time bond to
its tool's params/result, while an application's own `-mcp` package is a
plain TS import its own build compiles, so the bond is real and checked.

## Piece 4: the dependency-cycle risk — resolved by construction, not just checked

`libs/planner/src/PlanActionGroup.ts` (and `libs/movement-branching`'s
`MovementActionGroup.ts`) carry a defensive comment along the lines of:

> No import from `@minions/mcp-types` to avoid potential circular deps.

and locally redeclare a minimal structural `ActionContext` instead of
importing the real one. This predates the `-mcp`/`-impl` split
(`cross-repo-plan-navigation.md`'s "The API is a plain TypeScript
interface") and was a real, if narrow, risk under the design it was written
against: that design inferred a group's type map from its own `execute()`
bodies (`InferActionMap<typeof actions>`), so a costume's implementation
file was the same file importing `ActionDef`/`ActionGroupDef` from
`mcp-types` — one misplaced future edit away from `mcp-types` needing
something back from that costume.

**The `-mcp`/`-impl` split removes this class of risk structurally, not
just by checking the graph once:**

- `@minions/mcp-types` depends on nothing (a leaf, by design — see "Package
  split and naming" in the other doc).
- Every costume's `@minions/<costume>-mcp` package (the interface,
  metadata, and client factory) depends on `mcp-types` and nothing
  costume-implementation-shaped.
- Every costume's `@minions/<costume>-impl` package depends on its own
  `-mcp` package (for the interface it implements) plus whatever
  domain-specific libs it needs (`file-store`, etc.) — never the reverse,
  and never another costume's `-impl` package.
- `mcp-types` therefore can never end up depending on a costume's
  implementation, because no costume's interface package ever needs
  anything beyond `mcp-types` itself. There is no future edit inside this
  shape that reintroduces the cycle the old comment was guarding against —
  it would require an `-mcp` package to import its own `-impl` package,
  which has no reason to ever happen.

**Concrete follow-up**, folded into each costume's own conversion node
(`dc25687a` for plan, `4785cdb8` for movement, `610c20b8` for the rest):
once a costume's `-mcp` package exists and its `-impl` package imports
`ActionContext` (and anything else it needs) from `mcp-types` through that
`-mcp` package or directly, delete that costume's locally-redeclared
structural `ActionContext` and the stale "avoid circular deps" comment
above it. Confirm with `pnpm install` (warns on cyclic workspace deps) and
`nx graph` as a second signal, the same verification steps as before — the
check itself doesn't change, only the reason it now reliably passes does.

## Explicitly out of scope

- **The detailed design of how an application hosts or serves its own UI
  shell** (a throne-room-equivalent frontend). That's a separate, much
  bigger "Minions Platform SDK" question with its own design needs, not
  attempted here in full, though "A packaged SDK build target" (above)
  still expects the SDK's packaging to make scaffolding both the UI shell
  and the cabinet server as simple as possible.
- **User tools** (`CostumeExtensions`, plan goal `3a59deec`). Settled,
  already built, unaffected by anything in this doc. It remains the
  correct mechanism for dynamically-installed, per-lair-toggled tools where
  the cabinet cannot know the tool's shape ahead of time, this doc's
  mechanism is not a replacement for it, and does not change its contract.
- **Which specific application adopts this first**, or any
  `sharing-keystones`-specific tool design. This doc designs the platform
  seam, not a consumer of it.

## Open questions for review

- Confirm or rename the target lib (`libs/mcp-server-core` proposed).
- Confirm whether the `callAction` factory (client-side) and the SDK core
  (server-side) belong in one lib or two.
- Confirm the wing-gating hook boundary noted under "What this doc does not
  resolve" gets its own follow-up task rather than being decided here.
- ~~Confirm the exact boundary between `libs/minions-runtime-core`'s
  mandatory base set and costumes the platform ships as optional.~~
  Resolved during implementation: the mandatory base set is exactly what
  "The standard-core runtime lib" section already names — minion
  spawn/list/history/kill (`MinionManager`/`MinionService`), missions
  (`MissionService`), and movement/git operations (re-exporting
  `movement-branching`'s `movementActionGroup`), plus each one's own direct
  infra dependency (`file-store`, `hatchery`, `conductor`, `mcp-types`).
  Everything else `apps/cabinet`'s `createServer()` wires up — wing/lair
  administration (`wings`, `experiments`, `archives`), the plan tool,
  costume/registry management (`wardrobe`), docs, ask/question-queue,
  quality-watcher status, and review — stays outside `minions-runtime-core`
  and inline in `apps/cabinet`, unchanged by this work: none of it is named
  in "The standard-core runtime lib" section, and it's specific to running
  *this* platform's own lair, not something a generic downstream
  application would want bundled by default. `minions`/`missions` keep
  their existing raw-`registerTool` + hook-dispatched shape (not yet
  converted to the `-mcp`/`-impl` `ActionGroupDef` pattern — that
  conversion is out of this node's scope, same as it is for every other
  built-in costume today); `libs/minions-runtime-core` packages their
  already-portable service implementations
  (`MinionManager`/`MinionService`/`MissionService`) so a consuming
  application's own dispatch hook can call them, without requiring the
  `-mcp`/`-impl` split as a prerequisite.
- Confirm the packaging mechanism for the SDK build target (a
  publishable npm package, a git-based install, or something else).

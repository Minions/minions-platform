# Minions Platform

Minions Platform is the open-source core of Minions: **Cabinet** (an
Express + MCP control-plane server) and **Throne Room** (its Vue UI), the
tools that run a *lair* — a workspace where AI agents (minions) do git-based
software and knowledge work through *missions* and *costumes* — plus
**Dominion**, the product that installs and manages lairs on a machine.

It also ships **`@minions/platform-sdk`**, an installable SDK: an external
application mounts its own tools into its own cabinet-equivalent server,
gets minions' own standard tool set (minion spawn/list/history/kill,
missions, movement/git operations) pre-packaged for free, and installs it
as a package without cloning this repo. `codewarp/creator` and
`codewarp/untangler` — Minions' own closed-source product portfolios — are
built on this SDK the same way any third-party application would be.

## Repo layout

```
apps/
  cabinet/          Express + MCP control-plane server (the core of a lair)
  throne-room/      Vue 3 UI shell, paired with cabinet
  dominion/         Installs and manages lairs on a machine
  registry-worker/  Cloudflare Worker backing the costume/domain registry ("Guildhall")
  quality-watcher-process/  Standalone build/test/lint/type signal watcher cabinet talks to

libs/
  mcp-server-core/        Generic MCP session/transport/action-group mounting core
  minions-runtime-core/   The standard minion/mission/movement tool set, packaged
  minions-platform-sdk/   Bundles the two above into the publishable @minions/platform-sdk
  starter-minimal-server/ Copyable starting point for an SDK-based application server
  costumes/, wardrobe/    Costume loading, packaging, and registry sync
  conductor/              Costume/Mission/Workbench orchestration engine
  planner/, planner-types/  The `plan` MCP tool
  movement-branching/     The `movement` MCP tool (git workflow)
  file-store/              Lair/wing/directory disk model
  hatchery/                Spawns and talks to AI minions
  lair-config/, lair-provisioner/  Lair configuration and provisioning
  repo-perspective/, scheduling/, session-context/, domain-types/, events/,
  gadgets/, mcp-types/, feature-flags/, ui/, quality-watcher/  supporting infrastructure

costumes/
  costume-management/     Meta-tool for authoring costumes

registries/
  official/                Publishes mcp-server-core and other Platform packages

docs/
  missions-runtime/        Architecture and contributor docs for the mission/costume system
  getting-started/         Practical how-to for building on the SDK
  design/                  Design docs for the SDK boundary itself

recipes/
  initial-setup.md         The Platform's own onboarding recipe

workflows/
  .meta/workflows content — how to work with this repo's movement/plan tooling
```

## Developing this repo

This is an nx + pnpm monorepo. Use pnpm, never npm/npx.

```sh
pnpm install
pnpm dev          # starts cabinet (:3000) and throne-room (:5173) together
```

Open http://localhost:5173 — it connects to the cabinet at :3000 automatically.

Run the full check suite:

```sh
pnpm exec nx run-many -t build test lint typecheck --all
```

or target a single project directly (faster in a loop):

```sh
pnpm --filter <pkg> exec vitest run <file>
pnpm exec oxlint <files>
pnpm exec eslint --config eslint.custom-rules.config.mjs <files>
pnpm --filter <pkg> exec tsc --noEmit
```

When invoking `nx` directly, keep the nx daemon disabled (`NX_DAEMON=false`)
— a cold daemon spawned by a piped command can hold its stdout pipe open
indefinitely, hanging commands like `nx ... | tail`. Redirect to a file
instead of piping into a reader if you need to inspect output.

## Building an application on the SDK

Install `@minions/platform-sdk`, construct a `McpServerCore`, mount your own
`ActionGroupDef`, and optionally bind the standard minion/mission/movement
tool set — see
[`docs/getting-started/application-tool-sdk.md`](./docs/getting-started/application-tool-sdk.md)
for the full walkthrough, and
[`libs/starter-minimal-server`](./libs/starter-minimal-server) for a
copyable working starting point. `docs/design/application-tool-sdk.md` has
the design rationale behind the split, if you want the "why" as well as the
"how".

## Installing and running a lair

- **Today**: build cabinet (`pnpm --filter @minions/cabinet build`), which
  produces a `new_lair.zip` package; hand-build a lair's contents from that
  zip.
- **Future (recommended)**:
  [Minions Quartermaster](https://github.com/Minions/quartermaster/releases)
  — a separate, external tool — installs a **Dominion**, which is then used
  to create and manage lairs. Each lair can hold any product's work target.
  Dominion is the local lair-management product this repo builds
  (`apps/dominion`); Quartermaster is what installs Dominion in the first
  place.

## Running tasks

```sh
nx run <task> <project-name>
nx run-many -t <task> --all
```

Tasks are either inferred automatically from each project's `package.json`
scripts, or defined explicitly in a `project.json`. See the
[Nx documentation](https://nx.dev/getting-started/intro) for more.

## License

Apache License 2.0 — see [LICENSE](./LICENSE).

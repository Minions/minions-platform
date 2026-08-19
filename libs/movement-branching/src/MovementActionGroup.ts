/**
 * Movement action group — the ActionGroupDef for the `movement` MCP tool.
 *
 * Exports a plain object satisfying ActionGroupDef<ActionContext> structurally,
 * without importing from @minions/mcp-types (avoids circular dep since
 * mcp-types currently imports from this lib).
 *
 * Each action resolves its own wing and worktree from the ActionContext.lair
 * sandbox and the ActionContext.wingName provided by the henchery route.
 */

import path from 'node:path';
import { createLair, asWingName, asRepoAlias, createWorkAreaFactoriesForSandbox, resolveMovementBase } from '@minions/file-store';
import type { Sandbox, Directory, WorkAreaFactories, Trunk } from '@minions/file-store';
import type { IQualityWatcher } from '@minions/quality-watcher';
import { WingPerspective } from '@minions/repo-perspective';
import { MovementSession } from './MovementSession.js';
import type { CommitType } from './MovementSession.js';
import type { CommitCoordinator } from './tools/CommitCoordinator.js';

// Minimal structural types — must match mcp-types ActionContext / ActionDef / ActionGroupDef
interface ActionContext {
  lair: Sandbox;
  /** Wing name injected from the URL path /mcp/henchery/:wingName */
  wingName?: string;
  /** Resolves (creating/starting if needed) the wing's live quality watcher. Absent in contexts (e.g. tests) with no cabinet-level watcher plumbing. */
  getQualityWatcher?: (wingName: string) => Promise<IQualityWatcher | undefined>;
  /**
   * Pauses/resumes the wing's quality watcher around a bulk worktree rewrite
   * (the rebase inside `start`/`merge`/`promote`) — see
   * docs/design/quality-watcher-process-redesign.md for why this is
   * cabinet-driven rather than watcher-polled. Absent in contexts (e.g.
   * tests) with no cabinet-level watcher plumbing, in which case these
   * actions simply don't pause anything (never a correctness issue — see
   * the same doc's coarse-granularity rationale). Never throws on the
   * cabinet side; always safe to call unconditionally when present.
   */
  pauseQualityWatcher?: (wingName: string) => Promise<void>;
  /** The `resumeQualityWatcher` counterpart to `pauseQualityWatcher` — see its doc comment. */
  resumeQualityWatcher?: (wingName: string) => Promise<void>;
  /**
   * The cabinet's own long-lived per-worktree commit-debounce state (see
   * `CommitCoordinator`) — absent in contexts (e.g. tests) with no
   * cabinet-level object graph, in which case `commit` falls back to the
   * package's process-wide default instance.
   */
  commitCoordinator?: CommitCoordinator;
  /**
   * Looks up the experiment (if any) whose variation trunk equals `trunk` —
   * used by `promote` to verify it's only run for a wing on a trunk that's
   * actually mid-promotion. Absent in contexts (e.g. tests) with no
   * experiments plumbing, in which case `promote` skips the precondition
   * check and relies entirely on the caller having verified eligibility.
   */
  findExperimentByTrunk?: (trunk: string) => Promise<{ id: string; status: string } | null>;
  /**
   * Called once `promote` successfully folds a trunk into `main` — resolves
   * that experiment (frees every member wing across every variation, winner
   * and losers alike, back to ordinary main-tracked behavior). Absent in
   * contexts with no experiments plumbing.
   */
  onExperimentPromoted?: (trunk: string) => Promise<void>;
}

/**
 * Context passed to every wing-scoped action's `atWing` hook: the resolved
 * `WingPerspective` plus the raw `ActionContext`, for the handful of
 * per-request fields (`getQualityWatcher`, tool-log/reasoning-log paths)
 * that are genuinely orthogonal to "which wing/repo" and not part of the
 * wing-vs-lair-repo conflation this shape exists to fix.
 */
interface MovementWingContext {
  perspective: WingPerspective;
  ctx: ActionContext;
  /**
   * The `WorkAreaFactories` `resolveMovementWingContext` used to build
   * `perspective`'s `Lair` — `promote` needs it directly to construct the
   * root `main` `Trunk` handle `DerivedTrunk.advance()`/`beginAdvance()`
   * fold onto (`workAreaFactories.createTrunk(workArea.repo, 'main')`),
   * since `WorkArea` itself only exposes a `CheckedOutMovement` factory, not
   * an arbitrary-branch `Trunk` one.
   */
  workAreaFactories: WorkAreaFactories;
}

/**
 * Gets-or-creates the scratch directory `WorkArea`'s `Trunk`/`CheckedOutMovement`
 * construction nests movement/merge scratch worktrees under (design doc §4.1's
 * `Trunk.scratchWorktree()`/`Movement.merge()`'s disposable merge worktree) —
 * same "under the cabinet directory" convention `LairRepoPerspective` already
 * uses for the plan-mirror worktree, so movement scratch worktrees live
 * alongside it rather than inside any wing's own working tree.
 */
async function resolveMovementScratchRoot(lair: Sandbox): Promise<Directory> {
  const lairObj = createLair(lair);
  const cabinetDir = await lairObj.cabinet();
  const existing = await cabinetDir.child('movement-scratch');
  if (existing.found && existing.node.is('directory')) return existing.node as Directory;
  return cabinetDir.createDirectory('movement-scratch');
}

/**
 * Resolves the wing name from `ctx.wingName` (henchery endpoint, URL path
 * /mcp/henchery/:wingName) when present, else from `params['wing']` (throne
 * endpoint — `diff` is the only action mounted there, and has no per-wing
 * URL to derive `ctx.wingName` from, so it declares its own `wing` param
 * instead). Every movement action is wing-scoped regardless of which
 * endpoint it's called from — this is still exactly one `WingPerspective`
 * resolution, just with two possible sources for which wing.
 *
 * The `Lair` this builds is constructed WITH `WorkAreaFactories` (design doc
 * §4.2 — see `createWorkAreaFactoriesForSandbox`'s own doc for why the
 * adapter-detection has to live in `@minions/file-store` itself) so
 * `perspective.wing.workAreaLocal()`/`workAreaNamed()` are usable by
 * `start`/`merge` — see `WingPerspective.workArea()`.
 */
async function resolveMovementWingContext(
  ctx: ActionContext,
  repoRaw: string | undefined,
  params: Record<string, unknown>,
): Promise<MovementWingContext> {
  const wingNameRaw = ctx.wingName ?? (params['wing'] as string | undefined);
  if (wingNameRaw === undefined) {
    throw new Error('wingName is required — connect via /mcp/henchery/<wing-name>, or pass wing explicitly');
  }
  const scratchRoot = await resolveMovementScratchRoot(ctx.lair);
  const workAreaFactories = createWorkAreaFactoriesForSandbox(ctx.lair, scratchRoot);
  const lair = createLair(ctx.lair, workAreaFactories);
  const perspective = await WingPerspective.resolve(lair, asWingName(wingNameRaw), asRepoAlias(repoRaw));
  return { perspective, ctx, workAreaFactories };
}

// ---- plan/main sync ----
//
// There is no "eagerly bootstrap or resync a plan/<trunk> mirror" helper
// here (no `setupPlanBranchForRepo`/`syncPlanBranch`/`setupPlanBranch`/
// `setupAllPlanBranches`): there is nothing left for one to do.
// `LairRepoPerspective.resolve()` (`@minions/repo-perspective`) constructs a
// fresh `Mirror` on every plan/movement action call, always fast-forwarded
// to the trunk's current tip at construction time — no separate "bootstrap"
// or "resync" step is ever needed first.

// ---- shared infrastructure helper ----

function resolveToolLogPath(ctx: ActionContext): string | undefined {
  const wingName = ctx.wingName;
  if (!wingName) return undefined;
  const lairRoot = ctx.lair.root.path;
  return path.join(lairRoot, 'wings', wingName, 'private', 'untracked', 'tool-log.jsonl');
}

function resolveReasoningLogPath(ctx: ActionContext): string | undefined {
  if (!ctx.lair.root.path) return undefined;
  return path.join(ctx.lair.root.path, 'private', 'global', 'movement', 'commit', 'reasoning.md');
}

// ---- action definitions ----

const startAction = {
  description: 'sync branch to origin/main before making changes',
  help: `**movement start** — Begin or resume a movement.

Ensures the movement branch is at or ahead of origin/main by fetching
from origin and rebasing if behind. Call this at the start of each
working session before making any changes.

If the rebase hits a conflict, the result names the files that need
attention — edit them so their contents are correct, then call start
again. Do not run any git commands and do not commit anything yourself;
start handles the git mechanics (staging, continuing the rebase) itself,
every time it's called.

Optional: branch — start on a specific wip branch instead of the current one.
Allowed patterns: "wip/<name>", "probably-wrong/<name>",
or "l/<any>/w/<current-wing>-sub/<name>".
The branch is checked out if it already exists, or created at current HEAD if not.

Optional: repo — which named work repo to operate on (default "local").

Wing name is taken from the session URL (/mcp/henchery/<wing-name>).
Returns: { success, branch, isMovementBranch, wasUpdated, isDirty }`,
  params: {
    branch: {
      type: 'string' as const,
      description: 'Optional wip branch to start on (wip/*, probably-wrong/*, or l/*/w/<wing>-sub/*). Created if it does not exist.',
    },
    repo: {
      type: 'string' as const,
      description: 'Which named work repo to operate on (default "local").',
    },
  },
  required: [] as string[],
  async atWing({ perspective, ctx }: MovementWingContext, params: Record<string, unknown>) {
    await ctx.pauseQualityWatcher?.(perspective.wingName);
    try {
      const workArea = await perspective.workArea();
      return await new MovementSession(perspective.worktree, undefined, undefined, undefined, undefined, workArea).start({
        branch: params['branch'] as string | undefined,
        wingName: perspective.wingName,
      });
    } finally {
      await ctx.resumeQualityWatcher?.(perspective.wingName);
    }
  },
};

const commitAction = {
  description: 'commit the current step with risk notation (stages and commits the entire worktree)',
  help: `**movement commit** — Commit the current step.

Commits ALL files in the worktree (tracked changes and untracked files
alike), with a "<risk> <type>" prefix computed automatically. This
ignores the staging area entirely — anything already staged via git
add is irrelevant, and anything left un-added is committed anyway. Do
NOT run git add first; there is no way to exclude files from this
commit.

Required: type, summary, testsRan, testsPassed
Optional: isComprehensive (tests cover adjacent invariants too, not
          just the change itself), repo (default "local"),
          options.allowLintErrors (default false — a failing lint signal
          blocks the commit just like tests/types/build; set true to
          downgrade it to advice-only, same as commit's old behavior)
Types: feature/feat | bug/fix | refactor | test | docs | chore | plan

The risk code or type you get may differ from what you'd expect. If
so, the result explains why: toolLog.mismatchNote for a type change,
risk.explanation for a "@"/"!" risk code (including what to do
differently next time for a lower one).

Idempotent: if the worktree is already clean (e.g. this is a retry of a
commit that already landed), this returns success with noop=true instead
of an error — commitHash is the existing HEAD, not a new commit. Calling
commit again while one is already running for this wing waits for that
call and returns its result, rather than starting a second one.

Wing-only — commits the calling wing's own worktree
(/mcp/henchery/<wing-name>). Plan edits made outside any wing
(add-children, update-item, move-node, etc. against plan/main) are
already committed and published atomically by the plan action itself;
there is nothing left for a separate commit step to do for those.

Returns: { success, commitHash, error?, risk?, toolLog?, reasoningLogWarning?, noop? }`,
  params: {
    type: {
      type: 'string' as const,
      enum: ['feature', 'feat', 'bug', 'fix', 'refactor', 'test', 'docs', 'chore', 'plan'],
      description: 'The nature of the change',
    },
    summary: {
      type: 'string' as const,
      description: 'Commit message (risk code prepended automatically)',
    },
    testsRan: {
      type: 'boolean' as const,
      description: 'Whether tests were run',
    },
    testsPassed: {
      type: 'boolean' as const,
      description: 'Whether tests passed',
    },
    isComprehensive: {
      type: 'boolean' as const,
      description: 'Whether tests cover all adjacent invariants (not just the change)',
    },
    repo: {
      type: 'string' as const,
      description: 'Which named work repo to operate on (default "local").',
    },
    options: {
      type: 'object' as const,
      description: 'Commit-only options. Not used by any other action in this group.',
      properties: {
        allowLintErrors: {
          type: 'boolean' as const,
          description: 'When true, a failing lint signal is advice-only instead of blocking the commit (default false — lint blocks like tests/types/build).',
        },
      },
    },
  },
  required: ['type', 'summary', 'testsRan', 'testsPassed'] as string[],
  async atWing({ perspective, ctx }: MovementWingContext, params: Record<string, unknown>) {
    const qualityWatcher = ctx.getQualityWatcher
      ? await ctx.getQualityWatcher(perspective.wingName)
      : undefined;
    const workArea = await perspective.workArea();
    return new MovementSession(
      perspective.worktree,
      resolveToolLogPath(ctx),
      resolveReasoningLogPath(ctx),
      qualityWatcher,
      ctx.commitCoordinator,
      workArea,
    ).commit({
      type: params['type'] as CommitType,
      summary: params['summary'] as string,
      testsRan: params['testsRan'] as boolean,
      testsPassed: params['testsPassed'] as boolean,
      isComprehensive: params['isComprehensive'] as boolean | undefined,
      allowLintErrors: (params['options'] as { allowLintErrors?: boolean } | undefined)?.allowLintErrors,
    });
  },
  // No atLair hook: every content-owning plan write (`add-children`,
  // `set-root-order`, `add-question`, `remove-question`, `update-item`,
  // `create-root`, `move-node`) plus `claim-node`/`unclaim-node`/`mark-demo`/
  // `delete-subtree`/`claim-leaf` self-commits and CAS-publishes atomically
  // via `Mirror.apply()` (design doc §4.5) — none of them ever leaves the
  // mirror worktree dirty. The throne room's "COMMIT" button
  // (`apps/throne-room/src/App.vue`'s `doCommit()`) never writes files
  // directly either — it only calls structured `plan` actions
  // (`update-item`, `delete-subtree`, …), all of which are already atomic,
  // so there is nothing for a plan-mirror atLair commit hook to do here.
  // `commit` is wing-only, same shape as every other action in this group
  // except `diff`.
};

const mergeAction = {
  description: 'merge the completed movement to main',
  help: `**movement merge** — Merge the completed movement to main.

Merges the movement branch into main with --no-ff, then fast-forwards
the movement branch. Only call after all steps are committed and verified.
Review all commits on the branch before calling — some may predate the
current conversation.

If the rebase onto main hits a conflict, the result names the files that
need attention — edit them so their contents are correct, then call merge
again. Do not run any git commands and do not commit anything yourself;
merge handles the git mechanics (staging, continuing the rebase) itself,
every time it's called.

Wing name is taken from the session URL (/mcp/henchery/<wing-name>).
Required: type, summary, description
Optional: coAuthoredBy (e.g. "Claude <noreply@anthropic.com>"), repo (default "local")

Types: feature/feat | bug/fix | refactor | test | docs | chore | plan
Returns: { success, mergeCommitHash }`,
  params: {
    type: {
      type: 'string' as const,
      enum: ['feature', 'feat', 'bug', 'fix', 'refactor', 'test', 'docs', 'chore', 'plan'],
      description: 'The nature of the change',
    },
    summary: {
      type: 'string' as const,
      description: 'One-line summary of the movement',
    },
    description: {
      type: 'string' as const,
      description: 'Full description of all changes in the movement',
    },
    coAuthoredBy: {
      type: 'string' as const,
      description: 'Optional co-authored-by trailer',
    },
    repo: {
      type: 'string' as const,
      description: 'Which named work repo to operate on (default "local").',
    },
  },
  required: ['type', 'summary', 'description'] as string[],
  async atWing({ perspective, ctx }: MovementWingContext, params: Record<string, unknown>) {
    await ctx.pauseQualityWatcher?.(perspective.wingName);
    try {
      const workArea = await perspective.workArea();
      // There is no post-merge plan-branch sync call here. `LairRepoPerspective`
      // (`@minions/repo-perspective`) constructs a fresh `Trunk.mirror()` per
      // call, and both `DiskMirrorImpl`/`InMemoryMirrorImpl` fast-forward that
      // mirror's worktree to the trunk's current tip eagerly, at construction/
      // first-access time (see `DiskMirror.ts`'s/`InMemoryMirror.ts`'s
      // `syncToTrunkTip()`) — so the very next `plan` action's
      // `LairRepoPerspective.resolve()` already sees this merge's content with
      // no explicit sync step needed.
      return await new MovementSession(perspective.worktree, undefined, undefined, undefined, undefined, workArea).merge({
        type: params['type'] as CommitType,
        summary: params['summary'] as string,
        description: params['description'] as string,
        coAuthoredBy: params['coAuthoredBy'] as string | undefined,
      });
    } finally {
      await ctx.resumeQualityWatcher?.(perspective.wingName);
    }
  },
};

const statusAction = {
  description: 'check branch status',
  help: `**movement status** — Check branch status.

Returns the current branch name, whether it is a movement branch,
and whether there are uncommitted changes. Useful for diagnosing
problems. Not required in the normal workflow.

Optional: repo — which named work repo to check (default "local").

Wing name is taken from the session URL (/mcp/henchery/<wing-name>).
Returns: { branch, isMovementBranch, isDirty }`,
  params: {
    repo: {
      type: 'string' as const,
      description: 'Which named work repo to check (default "local").',
    },
  },
  required: [] as string[],
  async atWing({ perspective }: MovementWingContext) {
    const workArea = await perspective.workArea();
    return new MovementSession(perspective.worktree, undefined, undefined, undefined, undefined, workArea).status();
  },
};

const diffAction = {
  description: 'get the diff of the current movement against its base branch',
  help: `**movement diff** — Get the movement's diff.

Returns the unified diff of changes introduced by the movement branch
since it diverged from its base branch (a three-dot diff against HEAD).

Mounted on the throne endpoint (/mcp/throne), which has no per-wing URL,
so — unlike the other movement actions — this one takes an explicit
wing param.

Required: wing — which wing to diff.
Optional: repo — which named work repo to diff (default "local").

Returns: { diff }`,
  params: {
    wing: {
      type: 'string' as const,
      description: 'Which wing to diff.',
    },
    repo: {
      type: 'string' as const,
      description: 'Which named work repo to diff (default "local").',
    },
  },
  required: ['wing'] as string[],
  // No atLair: diff has no lair-scoped meaning at all. It's mounted on the
  // throne endpoint (no per-wing URL), so ctx.wingName is unset there, but
  // it's still purely wing-scoped — just via its own explicit `wing` param
  // instead of the URL path. resolveMovementWingContext reads params['wing']
  // as a fallback for exactly this case, and the dispatcher always routes an
  // atWing-only action through resolveWingContext regardless of endpoint.
  async atWing({ perspective }: MovementWingContext) {
    const workArea = await perspective.workArea();
    return new MovementSession(perspective.worktree, undefined, undefined, undefined, undefined, workArea).diff();
  },
};

const promoteAction = {
  description: "fold a completing experiment's winning trunk into main",
  help: `**movement promote** — Fold an experiment trunk into main.

Only valid for a wing whose movement/plan trunk (see baseBranch()) is a
variation of an experiment currently in "completing" status (set by the
throne room via \`experiments select-winner\`).

Runs a real rebase of the trunk onto origin/main in THIS worktree, so any
conflict lands as real conflicted files instead of an opaque error. If there
are conflicts, the result names the files that need attention — edit them so
their contents are correct, then call promote again. Do not run any git
commands and do not commit anything yourself; promote handles the git
mechanics (staging, continuing the rebase) itself, every time it's called.

On success: main is fast-forwarded to the rebased trunk tip (no merge commit
— main's history reads as if every constituent movement targeted it
directly), and the whole experiment is resolved — every member wing across
every variation, winner and losers alike, returns to ordinary main-tracked
behavior.

Wing name is taken from the session URL (/mcp/henchery/<wing-name>).
Optional: repo — which named work repo to operate on (default "local")
Returns: { success, trunk?, needsResolution?, error? }`,
  params: {
    repo: {
      type: 'string' as const,
      description: 'Which named work repo to operate on (default "local").',
    },
  },
  required: [] as string[],
  async atWing({ perspective, ctx, workAreaFactories }: MovementWingContext) {
    await ctx.pauseQualityWatcher?.(perspective.wingName);
    try {
      const trunk = await resolveMovementBase(perspective.bareRepo, perspective.worktree);
      if (ctx.findExperimentByTrunk) {
        const experiment = await ctx.findExperimentByTrunk(trunk);
        if (!experiment || experiment.status !== 'completing') {
          throw new Error(
            `Wing "${perspective.wingName}" is not on a trunk ("${trunk}") belonging to an experiment ` +
            `that's currently completing. promote is only valid after the throne room selects a winner ` +
            `(experiments select-winner).`,
          );
        }
      }
      const workArea = await perspective.workArea();
      const mainTrunk: Trunk = workAreaFactories.createTrunk(workArea.repo, 'main');
      const result = await new MovementSession(perspective.worktree, undefined, undefined, undefined, undefined, workArea).promote(mainTrunk);
      if (result.success && ctx.onExperimentPromoted) {
        await ctx.onExperimentPromoted(trunk);
      }
      return result;
    } finally {
      await ctx.resumeQualityWatcher?.(perspective.wingName);
    }
  },
};

// ---- exported group ----

/**
 * ActionGroupDef for the `movement` MCP tool.
 * Satisfies ActionGroupDef from @minions/mcp-types structurally.
 * Pass to mcpServer.mountActionGroup() in the cabinet.
 *
 * The wing name is not a shared param for most actions — it is taken from
 * the session URL path (/mcp/henchery/:wingName) via ActionContext.wingName.
 * `diff` is the one exception: it is mounted on the throne endpoint instead
 * (which has no per-wing URL), so it declares its own explicit `wing` param
 * (see its own comment).
 *
 * Every action here is wing-only (no `atLair`) — calling one from a
 * non-wing endpoint is a clear runtime error. There is no lair-scoped
 * `atLair` for the throne room to commit plan/main edits made outside any
 * wing: every plan-mirror write is self-committing via `Mirror.apply()` —
 * see `commitAction`'s own comment.
 */
export const movementActionGroup = {
  name: 'movement',
  description:
    'Unified tool for movement-based git workflow. Every action operates on the whole worktree — there is no per-file or staged-subset scoping.',
  workflow: 'start → (make changes) → commit → (repeat) → merge',
  sharedParams: {},
  resolveWingContext: resolveMovementWingContext,
  coreActions: {
    start: startAction,
    commit: commitAction,
    merge: mergeAction,
    status: statusAction,
    diff: diffAction,
    promote: promoteAction,
  },
};

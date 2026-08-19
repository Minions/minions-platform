/**
 * Plan action group — the ActionGroupDef for the `plan` MCP tool.
 *
 * Every action resolves its working context via WingPerspective (at a
 * /mcp/henchery/:wingName endpoint) or LairRepoPerspective (elsewhere) —
 * see `@minions/repo-perspective` — instead of branching on raw
 * ctx.wingName/params.repo inside each action body. The framework
 * (dispatchActionGroup in @minions/mcp-types) picks which one to build,
 * via this group's resolveWingContext/resolveLairContext, before calling
 * an action's atWing/atLair hook.
 *
 * No import from @minions/mcp-types to avoid potential circular deps.
 */

import { createLair, asWingName, asRepoAlias, asLairRepoName, resolveMovementBase, createWorkAreaFactoriesForSandbox } from '@minions/file-store';
import type { Sandbox, Worktree, File, MutableDirectoryLike, Directory, WorkArea, Mirror } from '@minions/file-store';
import { MovementSession, MirrorCommit } from '@minions/movement-branching';
import type { AbsorbPlanResult } from '@minions/movement-branching';
import { QualityWatcher, GLOBAL_SIGNALS } from '@minions/quality-watcher';
import { WingPerspective, LairRepoPerspective, refreshTrunkFromOrigin } from '@minions/repo-perspective';
import type { KeyedQueue } from '@minions/scheduling';
import { WorktreePlanStore } from './adapters/worktree/WorktreePlanStore.js';
import { asNodeId } from '@minions/planner-types';
import type { IPlanStore, ItemType, NodePlacement, PlanItem, SubtreeIndex, NodeId } from '@minions/planner-types';
import { computeBlockCounts, computeChainLengths } from './blockCounts.js';

// Minimal structural type matching ActionContext from mcp-types
interface ActionContext {
  lair: Sandbox;
  /** Wing name injected from the URL path /mcp/henchery/:wingName */
  wingName?: string;
  /**
   * The cabinet's own long-lived lock serializing compound operations
   * against a lair-level plan mirror worktree — not read by anything in
   * this file. `claim-node`/`unclaim-node`/`mark-demo`/`delete-subtree`
   * (atLair) go through `Mirror.apply()`, which needs no external lock —
   * CAS-publish is safe under concurrency by construction. Kept on this
   * minimal structural type only because the real `ActionContext`
   * (mcp-types) still carries it. Neither `plan` nor `movement` reads
   * `ctx.mirrorOpLock` back off the context — see `MCPServer.ts`'s own doc
   * comment on `mirrorOpLock`, which confirms it's handed in but unread.
   */
  mirrorOpLock?: KeyedQueue;
}

// ---- wing/lair context resolution ----

/**
 * Context passed to every wing-scoped action's `atWing` hook: the resolved
 * `WingPerspective` plus the raw lair `Sandbox` (needed only for
 * `readOriginPlanPath`'s `cabinet.config.json` lookup — a lair-wide config
 * concern orthogonal to which perspective this is).
 */
interface PlanWingContext {
  perspective: WingPerspective;
  lair: Sandbox;
}

/** Context passed to every `atLair` hook — the lair-registered repo's plan/main perspective. */
interface PlanLairContext {
  perspective: LairRepoPerspective;
  lair: Sandbox;
}

/**
 * Gets-or-creates the scratch directory `WorkArea`'s `Trunk`/`CheckedOutMovement`
 * construction nests scratch worktrees under — same "under the cabinet
 * directory" convention `libs/movement-branching/src/MovementActionGroup.ts`'s
 * own `resolveMovementScratchRoot` already uses (and the same physical
 * location: both need `WorkAreaFactories` for the same wing/repo, so sharing
 * the convention, not inventing a second one, keeps them pointed at the same
 * scratch worktrees rather than silently forking).
 */
async function resolvePlanScratchRoot(lair: Sandbox): Promise<Directory> {
  const lairObj = createLair(lair);
  const cabinetDir = await lairObj.cabinet();
  const existing = await cabinetDir.child('movement-scratch');
  if (existing.found && existing.node.is('directory')) return existing.node as Directory;
  return cabinetDir.createDirectory('movement-scratch');
}

async function resolvePlanWingContext(ctx: ActionContext, repoRaw: string | undefined): Promise<PlanWingContext> {
  if (ctx.wingName === undefined) throw new Error('wingName is required — connect via /mcp/henchery/<wing-name>');
  // WITH WorkAreaFactories (design doc §4.2), not the bare `createLair(ctx.lair)`
  // used elsewhere in this file: `wingFiles()` (below) calls
  // `perspective.workArea()`, which needs `wing.workAreaLocal()`/
  // `workAreaNamed()` to be usable — see `MovementActionGroup.ts`'s
  // `resolveMovementWingContext` for the identical precedent this copies.
  const scratchRoot = await resolvePlanScratchRoot(ctx.lair);
  const workAreaFactories = createWorkAreaFactoriesForSandbox(ctx.lair, scratchRoot);
  const lair = createLair(ctx.lair, workAreaFactories);
  const perspective = await WingPerspective.resolve(lair, asWingName(ctx.wingName), asRepoAlias(repoRaw));
  return { perspective, lair: ctx.lair };
}

/**
 * In-flight-only coalescing for `LairRepoPerspective.resolve()`, keyed by
 * repo+trunk: concurrent calls that land while a resolve for the same key is
 * already running share its result (and so share one `Mirror` instance —
 * `Mirror.files` memoizes its worktree setup/sync per instance, see
 * `DiskMirrorImpl.ensureWorktree()`) instead of each independently paying
 * for worktree creation/branch-check/sparse-checkout/sync-to-tip. A plan-page
 * load fires `list-roots` then one `get-subtree` per root, all in parallel
 * (see `apps/throne-room/src/components/LivingCosmos.vue`) — without this,
 * every one of those calls built and set up its own `Mirror` from scratch.
 * Deliberately NOT cached beyond the in-flight window (evicted the instant
 * it settles): the next call after this burst still gets a brand-new
 * `Mirror`, preserving "every plan/movement action builds a fresh Mirror per
 * call, so it's always current relative to the local trunk ref" — see
 * `syncAction`'s own doc comment, which depends on that being true for `plan
 * sync` to have any visible effect on the very next read.
 */
const inFlightLairRepoPerspectives = new Map<string, Promise<LairRepoPerspective>>();

async function resolvePlanLairContext(ctx: ActionContext, repoRaw: string | undefined, params: Record<string, unknown>): Promise<PlanLairContext> {
  const lair = createLair(ctx.lair);
  const trunk = typeof params['trunk'] === 'string' ? (params['trunk'] as string) : undefined;
  const repoName = asLairRepoName(repoRaw);
  const cacheKey = `${repoName}::${trunk ?? 'main'}`;

  let perspectivePromise = inFlightLairRepoPerspectives.get(cacheKey);
  if (!perspectivePromise) {
    perspectivePromise = LairRepoPerspective.resolve(lair, repoName, trunk);
    inFlightLairRepoPerspectives.set(cacheKey, perspectivePromise);
    perspectivePromise.finally(() => {
      if (inFlightLairRepoPerspectives.get(cacheKey) === perspectivePromise) {
        inFlightLairRepoPerspectives.delete(cacheKey);
      }
    });
  }

  const perspective = await perspectivePromise;
  return { perspective, lair: ctx.lair };
}

/**
 * The design doc §4.2 `WorkArea`-based replacement for reading
 * `w.perspective.worktree` directly: `workArea().activeMovement()` is the
 * wing's own live movement, and `.files` is its `MutableDirectoryLike`
 * view — exactly what every `*Body` function above accepts. Every `atWing`
 * call site that needs plan content goes through this, matching
 * `closetUtils.ts`'s already-established
 * `wing.workAreaLocal().activeMovement().files` precedent.
 */
async function wingFiles(w: PlanWingContext): Promise<MutableDirectoryLike> {
  const workArea = await w.perspective.workArea();
  const movement = await workArea.activeMovement();
  return movement.files;
}

/**
 * The design doc §4.2 `WorkArea`-based replacement for
 * `w.perspective.worktree.currentBranch()` — `Worktree.currentBranch` is on
 * the design doc §5 cut list (raw `Worktree` mechanics no domain code should
 * reach for directly), and `WorkArea.activeMovement().branch` is the exact
 * same "which branch is this wing currently on" answer, read off the
 * `Movement` handle instead. Best-effort, same shape as the try/catch this
 * replaces: `workArea()`/`activeMovement()` can throw when the wing has no
 * work/local worktree set up, in which case callers get 'unknown' exactly
 * as before (informational field only — never load-bearing for the claim
 * itself, see `claimNodeBody`'s use of it).
 */
async function wingBranch(w: PlanWingContext): Promise<string> {
  try {
    const workArea = await w.perspective.workArea();
    const movement = await workArea.activeMovement();
    return movement.branch;
  } catch {
    return 'unknown';
  }
}

// ---- plan storage configuration ----

/**
 * originPlanPath — the path *inside a work repo* where plan data lives (e.g.
 * ".meta/plan"). This has two uses:
 *   • MovementActionGroup uses it to configure the git sparse-checkout so
 *     only that subtree is checked out into [lair-root]/plan/
 *   • PlanActionGroup navigates to it within both a plan/main worktree and
 *     a wing's full checkout
 * This convention applies uniformly to every named work repo's plan data:
 * each named work repo has its own plan data at this path — there is no
 * single lair-wide "the" plan repo.
 *
 * The lair-local plan directory is always [lair-root]/plan/ — it is a constant,
 * not configurable, and must never be derived from originPlanPath at runtime.
 * The sparse checkout does NOT remap paths: originPlanPath is still a subdir
 * within the plan/main worktree (e.g. [lair-root]/plan/.meta/plan/).
 */
const DEFAULT_ORIGIN_PLAN_PATH = '.meta/plan';

async function readOriginPlanPath(lair: Sandbox): Promise<string> {
  try {
    const result = await lair.root.child('cabinet.config.json');
    if (!result.found || !result.node.is('file')) return DEFAULT_ORIGIN_PLAN_PATH;
    const content = await (result.node as File).read();
    const config = JSON.parse(content) as Record<string, unknown>;
    // Accept both the new key and the legacy "planPath" key written by older cabinets.
    return typeof config['originPlanPath'] === 'string' ? config['originPlanPath']
      : typeof config['planPath'] === 'string'       ? config['planPath']
      : DEFAULT_ORIGIN_PLAN_PATH;
  } catch {
    return DEFAULT_ORIGIN_PLAN_PATH;
  }
}

// ---- shared infrastructure helpers ----

/**
 * Navigate through path segments within a worktree.
 * create=true: create missing intermediate directories.
 * create=false: return null if any segment is missing.
 */
async function navigatePlanPath(root: MutableDirectoryLike, planPath: string, create: false): Promise<MutableDirectoryLike | null>;
async function navigatePlanPath(root: MutableDirectoryLike, planPath: string, create: true): Promise<MutableDirectoryLike>;
async function navigatePlanPath(root: MutableDirectoryLike, planPath: string, create: boolean): Promise<MutableDirectoryLike | null> {
  const parts = planPath.replace(/^\/+/, '').split('/').filter(Boolean);
  let current: MutableDirectoryLike = root;
  for (const part of parts) {
    const result = await current.child(part);
    if (result.found && result.node.kind === 'worktree') {
      current = result.node as MutableDirectoryLike;
    } else if (create) {
      current = await current.createDirectory(part);
    } else {
      return null;
    }
  }
  return current;
}

/**
 * Resolve the plan storage *directory* (the originPlanPath worktree, e.g.
 * .meta/plan) within `worktree` — works uniformly for a wing's own full
 * checkout and a lair-registered repo's plan/main sparse checkout, since
 * the sparse checkout does not remap paths: originPlanPath is still a
 * subdirectory of the worktree root either way.
 */
export async function resolvePlanDir(worktree: MutableDirectoryLike, lair: Sandbox): Promise<MutableDirectoryLike | null> {
  const originPlanPath = await readOriginPlanPath(lair);
  return navigatePlanPath(worktree, originPlanPath, false);
}

async function resolvePlanStore(worktree: MutableDirectoryLike, lair: Sandbox): Promise<IPlanStore | null> {
  const storeDir = await resolvePlanDir(worktree, lair);
  return storeDir ? new WorktreePlanStore(storeDir) : null;
}

/**
 * Like resolvePlanStore but ensures the plan directory exists, creating it
 * if absent. Used by write actions that may be the first to write to a
 * tree (e.g. create-root).
 */
async function resolvePlanStoreCreating(worktree: MutableDirectoryLike, lair: Sandbox): Promise<IPlanStore> {
  const existing = await resolvePlanStore(worktree, lair);
  if (existing) return existing;
  const originPlanPath = await readOriginPlanPath(lair);
  const storeDir = await navigatePlanPath(worktree, originPlanPath, true);
  return new WorktreePlanStore(storeDir);
}

/**
 * The `keepIfDangling` callback for IPlanStore.pruneDanglingClaims: resolves
 * the claiming wing's own worktree and checks whether it still has the item
 * in its own content — distinguishing "pending merge, not actually stale"
 * (wing still has it locally, just hasn't merged to main yet — the
 * create-then-claim case) from "genuinely stale" (wing doesn't have it
 * either — it was completed/deleted before merging). Fails safe: any
 * ambiguity (wing lookup errors, worktree unreadable) keeps the entry
 * rather than risking a false prune — a wrongly-dropped claim would let a
 * second wing claim the same node, defeating claim-node's whole point. Only
 * a *confirmed* absence (wing doesn't exist, or exists but genuinely lacks
 * the node) returns false.
 */
async function wingStillHasNode(lair: Sandbox, wingName: string, itemId: NodeId): Promise<boolean> {
  try {
    // WITH WorkAreaFactories — `workAreaLocalIfExists()` needs them to build a
    // Trunk/CheckedOutMovement (same requirement `resolvePlanWingContext`
    // documents). Reuses `resolvePlanScratchRoot`'s own "under the cabinet
    // directory" convention so this doesn't fork a second scratch location.
    const scratchRoot = await resolvePlanScratchRoot(lair);
    const workAreaFactories = createWorkAreaFactoriesForSandbox(lair, scratchRoot);
    const lairHandle = createLair(lair, workAreaFactories);
    const allWings = await lairHandle.wings();
    const w = allWings.find((x) => x.name === wingName);
    if (!w) return false; // wing confirmed gone — nothing will ever merge this claim
    // `workAreaLocalIfExists()` (design doc §4.2 growth point, movement-
    // trunk-safety-redesign) — non-throwing, so "wing has no repo checkout"
    // (undefined) stays a real `false` here, distinct from this function's
    // own outer catch's `true` ("couldn't check, be safe, don't prune"). A
    // throwing `workAreaLocal()` would collapse those two outcomes into one.
    const workArea = await w.workAreaLocalIfExists();
    if (!workArea) return false; // wing has no repo checkout — abandoned
    const activeMovement = await workArea.activeMovement();
    const originPlanPath = await readOriginPlanPath(lair);
    const storeDir = await navigatePlanPath(activeMovement.files, originPlanPath, false);
    if (!storeDir) return true; // couldn't check — be safe, don't prune
    const wingStore = new WorktreePlanStore(storeDir);
    const item = await wingStore.getItem(itemId);
    return item !== undefined;
  } catch {
    return true; // any error — be safe, don't prune
  }
}

// ---- helpers ----

/**
 * Commit plan changes on a wing's own worktree. Used by atWing actions
 * (currently only delete-subtree) — never absorbed, since a wing's own
 * branch isn't shared history yet, so it goes through the normal `movement
 * commit`/`movement merge` path (and CI) like any other wing commit.
 */
async function autoCommitPlan(
  worktree: Worktree,
  summary: string,
  workArea?: WorkArea,
): Promise<{ commitResult: unknown }> {
  const commitResult = await new MovementSession(worktree, undefined, undefined, undefined, undefined, workArea).commit({
    type: 'plan',
    summary,
    testsRan: true,
    testsPassed: true,
  });
  return { commitResult };
}

/**
 * Every content-owning write action's atLair path (`add-children`/
 * `set-root-order`/`add-question`/`remove-question`/`update-item`/
 * `create-root`/`move-node`, design doc §4.5) folds into a single
 * `mirror.apply()` call: write + commit + CAS-publish, one atomic step.
 *
 * Reuses the existing `*Body` function UNCHANGED — it's already a small,
 * pure function of whatever worktree it's given (exactly invariant B's
 * shape) — just supplies it `mirror.files` (a fresh view, resynced on every
 * CAS-retry attempt) instead of a plain worktree, and lets `Mirror.apply()`
 * commit + CAS-publish afterward. The atWing path (writing into a wing's own
 * full checkout, relying on a later `movement commit`) is untouched — this
 * only wraps the atLair direct-to-mirror path.
 *
 * Each of these actions' result includes a `commitResult` field reporting
 * that atomic commit.
 */
/** Picks the most identifying field out of a plan action's params, for a commit message a human can act on without opening the diff. */
function describePlanActionParams(params: Record<string, unknown>): string {
  const identifier = ["itemId", "nodeId", "parentId", "goalId"].map((key) => params[key]).find((value) => typeof value === "string");
  const title = typeof params.title === "string" ? params.title : undefined;
  const parts = [identifier, title].filter((v): v is string => v !== undefined);
  return parts.length > 0 ? parts.join(" ") : "";
}

/**
 * One `QualityWatcher` per plan mirror worktree, running only
 * `GLOBAL_SIGNALS` (currently empty — see that constant's own doc) — the
 * cabinet's own docs/plan writes never run software-dev tooling
 * (tests/types/build/lint) the way a wing's own watcher does. Cached for the
 * process lifetime, keyed by the mirror's own worktree path (stable per
 * lair-registered repo) — mirrors `MCPServer.getOrCreateQualityWatcher`'s
 * per-wing caching, kept local to this module rather than threaded through
 * `ActionContext` since the mirror (and so its path) is already fully
 * resolved by the time `mirrorCommit()` runs, with nothing at the cabinet's
 * dispatch layer needing to know this watcher exists. Deliberately never
 * stopped on process shutdown, unlike `MCPServer.shutdown()`'s per-wing
 * teardown — plain process exit is enough here (global-category signals
 * aren't expected to spawn long-lived subprocesses the way tests/types/build
 * do), so there's nothing worth the extra lifecycle wiring.
 */
const cabinetQualityWatchers = new Map<string, QualityWatcher>();

/**
 * Returns `undefined` (never throws) when `mirror`'s worktree isn't a real
 * filesystem path `QualityWatcher.start()` can `fs.watch()` — e.g. an
 * in-memory sandbox, the only kind the in-memory-fixture tests in this file
 * use. `MirrorCommit` already treats a missing watcher as "nothing to gate
 * on," the same graceful degrade `WingQualityWatcher` gives one repo's
 * watcher failing to start without taking any other repo down with it.
 */
async function getCabinetQualityWatcher(mirror: Mirror): Promise<QualityWatcher | undefined> {
  const cwd = mirror.files.path;
  const cached = cabinetQualityWatchers.get(cwd);
  if (cached) {
    if (cached.isRunning()) return cached;
    try {
      await cached.start();
      return cached;
    } catch {
      return undefined;
    }
  }

  const watcher = new QualityWatcher('cabinet', cwd, undefined, { signals: GLOBAL_SIGNALS });
  try {
    await watcher.start();
  } catch {
    return undefined;
  }
  cabinetQualityWatchers.set(cwd, watcher);
  return watcher;
}

/** Shared by every atLair plan write below: runs `transform` through `MirrorCommit` (same quality-gate safety check + intentional `plan: <summary>` message every plan write uses), always tagged `skipCi` since these land straight on main and are too high-frequency (claim/unclaim/mark-demo/etc.) to trigger CI on every call, and throws on rejection instead of making each call site check `outcome.success` itself. */
async function mirrorCommit<R>(
  lairPerspective: LairRepoPerspective,
  summary: string,
  transform: (view: MutableDirectoryLike) => Promise<R>,
): Promise<{ result: R; committed: boolean; commitHash?: string; attempts: number }> {
  const qualityWatcher = await getCabinetQualityWatcher(lairPerspective.mirror);
  const outcome = await new MirrorCommit(lairPerspective.mirror, qualityWatcher).commit({ transform, type: 'plan', summary, skipCi: true });
  if (!outcome.success) throw new Error(outcome.error ?? `plan write "${summary}" was rejected`);
  return {
    result: outcome.result as R,
    committed: outcome.committed as boolean,
    commitHash: outcome.commitHash,
    attempts: outcome.attempts as number,
  };
}

async function applyAtLairWrite<R extends Record<string, unknown>>(
  lairPerspective: LairRepoPerspective,
  lair: Sandbox,
  params: Record<string, unknown>,
  actionName: string,
  body: (worktree: MutableDirectoryLike, lair: Sandbox, params: Record<string, unknown>) => Promise<R>,
): Promise<R & { commitResult: { committed: boolean; commitHash?: string; attempts: number } }> {
  const detail = describePlanActionParams(params);
  const summary = `${actionName}${detail ? `: ${detail}` : ""}`;
  const { result, committed, commitHash, attempts } = await mirrorCommit(lairPerspective, summary, (view) =>
    body(view, lair, params),
  );
  return { ...result, commitResult: { committed, commitHash, attempts } };
}

/**
 * Whether a full sync should be triggered after a compound action's absorb
 * attempt settles: not when it never attempted an absorb (`absorb`
 * undefined — the action failed before ever reaching `autoCommitPlan`), and
 * — HUMAN DECISION, do not change without explicit human approval — not
 * when the absorb failed specifically on a rebase conflict, because that
 * leaves the mirror worktree mid-conflicted-rebase; running a sync over it
 * risks destroying what a human needs to `git add` + `git rebase
 * --continue` to resolve. Every other absorb outcome (success, or a non-conflict failure —
 * e.g. a rogue out-of-band change) schedules an immediate resync.
 *
 * `claim-node`/`unclaim-node`/`mark-demo`/`delete-subtree`(atLair) and
 * `claim-leaf` all go through `Mirror.apply()`, which has no absorb step at
 * all, so none of them has anything to trigger a post-absorb full sync off
 * of. This function has no production caller; it's typed against
 * `movement-branching`'s `AbsorbPlanResult` shape purely as documentation
 * of the still-open policy question it encodes (see the HUMAN DECISION
 * above) — see `MovementManager.ts`'s own doc comment on `AbsorbPlanResult`
 * for why that type itself is still kept around.
 */
export function shouldTriggerFullSyncAfterAbsorb(absorb: AbsorbPlanResult | undefined): boolean {
  if (!absorb) return false;
  if (absorb.success === false && absorb.needsRebase) return false;
  return true;
}

/**
 * MCP tool callers pass booleans as strings ("true"/"false") when the JSON
 * schema has no explicit type annotation. Coerce so both forms are accepted.
 */
function coerceApproved(val: unknown): false | true | 'tentative' {
  if (val === true  || val === 'true')  return true;
  if (val === false || val === 'false') return false;
  if (val === 'tentative') return 'tentative';
  throw new Error("approved must be true, false, or 'tentative'");
}

/**
 * Search every root subtree in `store` for `itemId` and return the sub-subtree
 * rooted at it (itemId plus all its descendants, following `children` only —
 * NOT `requires`), or null if not found. Used by get-subtree, where "subtree"
 * means literal tree descendants for display purposes. get-leaves and
 * claim-leaf do NOT use this — see `findExpandedSubtree` below, which also
 * follows `requires` edges (including across root boundaries), since a leaf
 * reachable only via a `requires` chain can still be the actual blocking work
 * toward a goal.
 */
async function findItemSubtree(store: IPlanStore, itemId: string): Promise<SubtreeIndex | null> {
  // Fast path: itemId is itself a root (the common case — every initial
  // plan-page load resolves one get-subtree per root id returned by
  // list-roots). A single direct read instead of scanning every root.
  const direct = await store.getSubtree(asNodeId(itemId));
  if (direct) return direct;

  // Fallback: itemId is a mid-tree item. Read every root's subtree in
  // parallel (rather than one at a time, stopping only once found) so a
  // miss on early roots doesn't serialize the whole scan.
  const roots = await store.listRoots();
  const indexes = await Promise.all(roots.map((rootId) => store.getSubtree(rootId)));
  for (const fullIndex of indexes) {
    if (fullIndex?.items[itemId] === undefined) continue;

    const subItems: Record<string, PlanItem> = {};
    const collect = (id: string) => {
      const item = fullIndex.items[id];
      if (!item) return;
      subItems[id] = item;
      for (const childId of item.children) collect(childId);
    };
    collect(itemId);
    return { root: asNodeId(itemId), items: subItems };
  }
  return null;
}

/** All plan items across every root, plus which root each one structurally lives under (its own subtree's root — distinct from wherever a `findExpandedSubtree` walk started). Every root is fetched in full since a `requires` edge can point into any of them; there is no cheaper way to know in advance which roots a given expansion will touch. */
async function fetchAllItemsWithHomeRoots(store: IPlanStore): Promise<{ items: Record<string, PlanItem>; homeRoot: Record<string, NodeId> }> {
  const rootIds = await store.listRoots();
  const subtrees = await Promise.all(rootIds.map((id) => store.getSubtree(id)));
  const items: Record<string, PlanItem> = {};
  const homeRoot: Record<string, NodeId> = {};
  for (const subtree of subtrees) {
    if (!subtree) continue;
    for (const [id, item] of Object.entries(subtree.items)) {
      items[id] = item;
      homeRoot[id] = subtree.root;
    }
  }
  return { items, homeRoot };
}

/**
 * Expand outward from `itemId` following BOTH `children` and `requires`
 * edges, transitively, until fixpoint — the working set for claim-leaf and
 * get-leaves, which need every leaf that could ultimately gate progress
 * toward `itemId`, not just its literal tree descendants. A `requires` edge
 * commonly points into a completely different root; that item (and, through
 * further steps of the same walk, its own children and requires) is pulled
 * in too. Without this, a goal whose children all `requires` nodes living in
 * another root looks like it has no claimable leaves at all, even though
 * finishing those other-root nodes is exactly the blocking work.
 *
 * `reachedVia` records, for every discovered id, the id it was first reached
 * from (BFS — so the shortest such path) — a mix of parent-child and
 * requires hops. Callers use it to report a path back to `itemId` that
 * reflects how the item was actually reached, since a plain ancestor walk
 * (`item.parent`) breaks the moment the path crosses a `requires` edge into
 * another root.
 *
 * `homeRoot` (from `fetchAllItemsWithHomeRoots`) is passed through so callers
 * that write a claim can pass the claimed item's own real home root as
 * `rootIdHint`, not `itemId`'s root — those differ whenever the claimed leaf
 * was reached via a `requires` hop into another root.
 */
async function findExpandedSubtree(
  store: IPlanStore,
  itemId: string,
): Promise<{ root: NodeId; items: Record<string, PlanItem>; homeRoot: Record<string, NodeId>; reachedVia: Record<string, NodeId | null> } | null> {
  const rootId = asNodeId(itemId);
  const { items: allItems, homeRoot } = await fetchAllItemsWithHomeRoots(store);
  if (!allItems[rootId]) return null;

  const items: Record<string, PlanItem> = {};
  const reachedVia: Record<string, NodeId | null> = { [rootId]: null };
  const queue: NodeId[] = [rootId];

  while (queue.length > 0) {
    const id = queue.shift() as NodeId;
    if (items[id]) continue;
    const item = allItems[id];
    if (!item) continue;
    items[id] = item;
    for (const childId of item.children) {
      if (!(childId in reachedVia)) reachedVia[childId] = id;
      queue.push(childId);
    }
    for (const depId of item.requires) {
      if (!(depId in reachedVia)) reachedVia[depId] = id;
      queue.push(depId);
    }
  }

  return { root: rootId, items, homeRoot, reachedVia };
}

/**
 * Like `walkPathToGoal`, but walks `reachedVia` (a `findExpandedSubtree`
 * BFS-predecessor map covering both `children` and `requires` hops) instead
 * of plain `item.parent` ancestry — so it still finds a path back to
 * `goalId` when `nodeId` was only reached by crossing a `requires` edge into
 * another root, which is not an ancestor relationship `item.parent` can
 * express.
 */
function walkExpandedPathToGoal(reachedVia: Record<string, NodeId | null>, nodeId: NodeId, goalId: NodeId): NodeId[] {
  const path: NodeId[] = [];
  let current: NodeId | null = nodeId;
  while (current !== null) {
    path.push(current);
    if (current === goalId) break;
    if (!(current in reachedVia)) throw new Error(`Item missing during path traversal: ${current}`);
    current = reachedVia[current];
  }

  if (path[path.length - 1] !== goalId) {
    throw new Error(`goalId ${goalId} was not reached while expanding from nodeId ${nodeId}`);
  }

  return path;
}

// ---- action definitions ----

const listWingsAction = {
  description: 'list available wings for branch overlay view',
  help: `**plan list-wings** — List all wings and their current branches.

Returns every wing in the lair that has a plan store, with its current branch name.
Use wing names with list-roots and get-subtree (via /mcp/henchery/<wing-name>)
to read plan data from a specific wing's branch for comparison.

Returns: { action: 'list-wings', wings: Array<{ name, branch }> }`,
  params: {} as Record<string, never>,
  required: [] as string[],
  // Lists every wing regardless of which endpoint/wing this was called
  // from — there is no wing-vs-lair perspective distinction to make here,
  // so this uses the plain execute(ctx, params) shape instead of
  // atWing/atLair.
  async execute(ctx: ActionContext, _params: Record<string, unknown>) {
    // WITH WorkAreaFactories — `workAreaLocalIfExists()` needs them to build
    // a Trunk/CheckedOutMovement (same requirement `wingStillHasNode()` and
    // `resolvePlanWingContext()` document). A bare `createLair(ctx.lair)`
    // here would make `workAreaLocalIfExists()` throw for every wing, which
    // this loop's own catch would silently swallow as "wing not usable" —
    // not a behavior change to introduce quietly.
    const scratchRoot = await resolvePlanScratchRoot(ctx.lair);
    const workAreaFactories = createWorkAreaFactoriesForSandbox(ctx.lair, scratchRoot);
    const lair = createLair(ctx.lair, workAreaFactories);
    const allWings = await lair.wings();
    const originPlanPath = await readOriginPlanPath(ctx.lair);
    const wings: Array<{ name: string; branch: string }> = [];
    for (const w of allWings) {
      try {
        const workArea = await w.workAreaLocalIfExists();
        if (!workArea) continue;
        const activeMovement = await workArea.activeMovement();
        const storeDir = await navigatePlanPath(activeMovement.files, originPlanPath, false);
        if (!storeDir) continue;
        wings.push({ name: w.name, branch: activeMovement.branch });
      } catch { /* wing not usable */ }
    }
    return { action: 'list-wings', wings };
  },
};

async function listRootsBody(worktree: MutableDirectoryLike, lair: Sandbox) {
  const store = await resolvePlanStore(worktree, lair);
  if (!store) return { action: 'list-roots', roots: [] };
  const rootIds = await store.listRoots();
  // Reads each root directly via getSubtree (a single direct content.toml
  // read) rather than getItem, which would search every root's content.toml
  // to resolve a single id — O(n) per lookup, O(n^2) total across all roots.
  const roots = await Promise.all(
    rootIds.map(async (id) => {
      const subtree = await store.getSubtree(id);
      return { id, title: subtree?.items[id]?.title ?? id };
    }),
  );
  return { action: 'list-roots', roots };
}

const listRootsAction = {
  description: 'list top-level plans by ID and title',
  help: `**plan list-roots** — List all top-level plan items.

Returns every root-level plan item with its ID and title.
Use the returned IDs with get-subtree to read full plan details.

Reads contextually: when called via /mcp/henchery/<wing-name>, returns that wing's
plan store. When called from a non-wing endpoint, returns plan/main.

Optional: repo — when called via /mcp/henchery/<wing-name>, which of the wing's named
work repos to read from (default "local"); when called from a non-wing endpoint, which
lair-registered work repo's plan/main to read (required — no default).

Optional: trunk — non-wing endpoint only. Which trunk branch's plan mirror to read
(e.g. an experiment variation's trunkBranch) instead of plan/main. Ignored when called
via /mcp/henchery/<wing-name> (a wing's own trunk override already determines this).

Returns: { action: 'list-roots', roots: Array<{ id, title }> }`,
  params: {
    repo: {
      type: 'string' as const,
      description: 'Which work repo to read from — a wing\'s named repo when called via a wing session, or a lair-registered repo\'s plan/main otherwise. Defaults to "local" for a wing session; required otherwise.',
    },
    trunk: {
      type: 'string' as const,
      description: 'Non-wing endpoint only: which trunk branch\'s plan mirror to read (e.g. an experiment variation\'s trunkBranch) instead of plan/main. Ignored at a wing endpoint.',
    },
  },
  required: [] as string[],
  atWing: async (w: PlanWingContext) => listRootsBody(await wingFiles(w), w.lair),
  atLair: (l: PlanLairContext) => listRootsBody(l.perspective.mirror.files, l.lair),
};

async function getSubtreeBody(worktree: MutableDirectoryLike, lair: Sandbox, params: Record<string, unknown>) {
  const itemId = asNodeId(params['itemId'] as string);
  if (!itemId) throw new Error('get-subtree requires itemId');

  const store = await resolvePlanStore(worktree, lair);
  if (!store) return { action: 'get-subtree', subtree: null };

  const subtree = await findItemSubtree(store, itemId);
  if (!subtree) {
    return { action: 'get-subtree', subtree: null };
  }

  const [details, parentContext] = await Promise.all([
    store.getDetails(itemId),
    store.getParentContext(itemId),
  ]);

  if (params['includeDetails']) {
    const richItems: Record<string, PlanItem & { details?: string; parentContext?: string }> = {};
    await Promise.all(
      Object.entries(subtree.items).map(async ([id, item]) => {
        const [d, pc] = await Promise.all([store.getDetails(asNodeId(id)), store.getParentContext(asNodeId(id))]);
        richItems[id] = { ...item, ...(d && { details: d }), ...(pc && { parentContext: pc }) };
      }),
    );
    return { action: 'get-subtree', subtree: { root: subtree.root, items: richItems }, details, parentContext };
  }

  return { action: 'get-subtree', subtree, details, parentContext };
}

const getSubtreeAction = {
  description: 'read any plan item and all its descendants',
  help: `**plan get-subtree** — Read the full tree for any plan item by ID.

Searches all plan trees for the item, then returns:
- subtree: flat index of the item and every descendant, keyed by ID
- details: markdown details for the item
- parentContext: parent context markdown for the item

Works for root items and mid-tree items alike.

Reads contextually: when called via /mcp/henchery/<wing-name>, searches that wing's
plan store. When called from a non-wing endpoint, searches plan/main.

Optional: includeDetails (boolean) — when true, populates a details field on each
item in the subtree (for diff comparison). Requires one extra file read per item.
Optional: repo — which work repo to read from: a wing's named work repo (default
"local") when called via /mcp/henchery/<wing-name>, or a lair-registered repo's
plan/main (required — no default) when called from a non-wing endpoint.

Optional: trunk — non-wing endpoint only. Which trunk branch's plan mirror to read
(e.g. an experiment variation's trunkBranch) instead of plan/main. Ignored when called
via /mcp/henchery/<wing-name> (a wing's own trunk override already determines this).

Required: itemId
Returns: { action: 'get-subtree', subtree: SubtreeIndex, details: string, parentContext: string }
         or { action: 'get-subtree', subtree: null } if not found`,
  params: {
    itemId: {
      type: 'string' as const,
      description: 'Plan item ID to fetch',
    },
    includeDetails: {
      type: 'boolean' as const,
      description: 'When true, include details text for every item in the subtree',
    },
    repo: {
      type: 'string' as const,
      description: 'Which work repo to read from — a wing\'s named repo when called via a wing session, or a lair-registered repo\'s plan/main otherwise. Defaults to "local" for a wing session; required otherwise.',
    },
    trunk: {
      type: 'string' as const,
      description: 'Non-wing endpoint only: which trunk branch\'s plan mirror to read (e.g. an experiment variation\'s trunkBranch) instead of plan/main. Ignored at a wing endpoint.',
    },
  },
  required: ['itemId'] as string[],
  atWing: async (w: PlanWingContext, params: Record<string, unknown>) => getSubtreeBody(await wingFiles(w), w.lair, params),
  atLair: (l: PlanLairContext, params: Record<string, unknown>) => getSubtreeBody(l.perspective.mirror.files, l.lair, params),
};

async function getLeavesBody(worktree: MutableDirectoryLike, lair: Sandbox, params: Record<string, unknown>) {
  const itemId = asNodeId(params['itemId'] as string);
  if (!itemId) throw new Error('get-leaves requires itemId');

  type LeafItem = PlanItem & { directBlocks: number; indirectBlocks: number; details?: string; parentContext?: string };
  const emptyLeaves: Record<string, LeafItem> = {};

  const store = await resolvePlanStore(worktree, lair);
  if (!store) return { action: 'get-leaves', root: null, leaves: emptyLeaves };

  const subtree = await findExpandedSubtree(store, itemId);
  if (!subtree) {
    return { action: 'get-leaves', root: null, leaves: emptyLeaves };
  }

  const blockCounts = computeBlockCounts(subtree.items);
  const leafItems = Object.values(subtree.items).filter((item) => item.children.length === 0);

  const leaves: Record<string, LeafItem> = {};
  await Promise.all(
    leafItems.map(async (item) => {
      const counts = blockCounts[item.id] ?? { directBlocks: 0, indirectBlocks: 0 };
      if (params['includeDetails']) {
        const [d, pc] = await Promise.all([store.getDetails(item.id), store.getParentContext(item.id)]);
        leaves[item.id] = { ...item, ...counts, ...(d && { details: d }), ...(pc && { parentContext: pc }) };
      } else {
        leaves[item.id] = { ...item, ...counts };
      }
    }),
  );

  return { action: 'get-leaves', root: subtree.root, leaves };
}

const getLeavesAction = {
  description: 'read only the leaf items of a subtree, annotated with block counts',
  help: `**plan get-leaves** — Read a subtree's actionable leaves cheaply.

Like get-subtree, but returns only the leaf items (no children) in the subtree
rooted at itemId, instead of every item — for large trees this is a fraction of
the token cost of get-subtree. Each leaf is annotated with directBlocks (items
in the subtree that directly require it) and indirectBlocks (items that reach
it only transitively), computed by computeBlockCounts over the subtree.

The traversal follows \`requires\` links exactly like \`children\` links, at every
step — so a leaf reachable only by crossing a \`requires\` edge into a completely
different root is still found and returned. This matters whenever itemId's
descendants require work that lives elsewhere: without following those links,
a goal can look leaf-less even when the real blocking work is one requires-hop
away.

Works for root items and mid-tree items alike.

Reads contextually: when called via /mcp/henchery/<wing-name>, searches that wing's
plan store. When called from a non-wing endpoint, searches plan/main.

Optional: includeDetails (boolean) — when true, populates a details field on each
leaf (for diff comparison). Requires one extra file read per leaf.
Optional: repo — which work repo to read from: a wing's named work repo (default
"local") when called via /mcp/henchery/<wing-name>, or a lair-registered repo's
plan/main (required — no default) when called from a non-wing endpoint.

Optional: trunk — non-wing endpoint only. Which trunk branch's plan mirror to read
(e.g. an experiment variation's trunkBranch) instead of plan/main. Ignored when called
via /mcp/henchery/<wing-name> (a wing's own trunk override already determines this).

Required: itemId
Returns: { action: 'get-leaves', root: string, leaves: Record<id, PlanItem & { directBlocks, indirectBlocks }> }
         or { action: 'get-leaves', root: null, leaves: {} } if not found`,
  params: {
    itemId: {
      type: 'string' as const,
      description: 'Root item ID whose subtree leaves should be read',
    },
    includeDetails: {
      type: 'boolean' as const,
      description: 'When true, include details text for each leaf item',
    },
    repo: {
      type: 'string' as const,
      description: 'Which work repo to read from — a wing\'s named repo when called via a wing session, or a lair-registered repo\'s plan/main otherwise. Defaults to "local" for a wing session; required otherwise.',
    },
    trunk: {
      type: 'string' as const,
      description: 'Non-wing endpoint only: which trunk branch\'s plan mirror to read (e.g. an experiment variation\'s trunkBranch) instead of plan/main. Ignored at a wing endpoint.',
    },
  },
  required: ['itemId'] as string[],
  atWing: async (w: PlanWingContext, params: Record<string, unknown>) => getLeavesBody(await wingFiles(w), w.lair, params),
  atLair: (l: PlanLairContext, params: Record<string, unknown>) => getLeavesBody(l.perspective.mirror.files, l.lair, params),
};

/**
 * atWing only — writes to the wing's own worktree with a plain commit (no
 * absorb; that's what a wing's own branch is for).
 *
 * Deliberately NOT widened to `MutableDirectoryLike` like the other `*Body`
 * functions: it hands `worktree` to `autoCommitPlan`, which constructs a
 * real `MovementSession` — a genuine, currently-irreducible `Worktree`-only
 * need (`MovementSession`'s constructor requires `Worktree`, not the wider
 * union), not a leftover that widening could clean up. The call site casts
 * back to `Worktree` for exactly this reason — see its own comment.
 */
async function deleteSubtreeBody(worktree: Worktree, lair: Sandbox, params: Record<string, unknown>, workArea?: WorkArea) {
  const itemId = asNodeId(params['itemId'] as string);
  if (!itemId) throw new Error('delete-subtree requires itemId');
  const store = await resolvePlanStore(worktree, lair);
  if (!store) throw new Error(`Wing has no plans/planner directory`);
  await store.deleteItem(itemId);
  await store.cleanupRequiresReferences(itemId);
  const { commitResult } = await autoCommitPlan(worktree, `complete item ${itemId}`, workArea);
  return { action: 'delete-subtree', deleted: itemId, commitResult };
}

/**
 * atLair only — the ENTIRE mutation runs inside a single mirror.apply()
 * transform, re-run in full on every CAS retry. See claimNodeBody's own doc
 * comment for the full rationale (design doc §4.5).
 */
async function deleteSubtreeViaMirror(lairPerspective: LairRepoPerspective, lair: Sandbox, params: Record<string, unknown>) {
  const itemId = asNodeId(params['itemId'] as string);
  if (!itemId) throw new Error('delete-subtree requires itemId');

  const { committed, commitHash, attempts } = await mirrorCommit(lairPerspective, `complete item ${itemId}`, async (view) => {
    const store = await resolvePlanStore(view, lair);
    if (!store) throw new Error(`Wing has no plans/planner directory`);
    await store.deleteItem(itemId);
    await store.cleanupRequiresReferences(itemId);
  });

  return { action: 'delete-subtree', deleted: itemId, commitResult: { committed, commitHash, attempts } };
}

const deleteSubtreeAction = {
  description: '⚠️ DANGEROUS — mark an item done by permanently deleting it and its entire subtree',
  help: `**plan delete-subtree** — Mark a plan item as done by deleting it.

⚠️ DANGEROUS: deletes the item and ALL its descendants from the plan tree,
permanently. This is the only way to mark a plan item complete. In the
throne room UI this is exposed to the overlord as "Complete Item".

Atomic: auto-commits and, when operating on plan/main, absorbs to main
immediately so other agents see the completion without a separate
\`movement commit\` call.

Wing name is taken from the session URL (/mcp/henchery/<wing-name>).
Required: itemId
Optional: repo — which of the wing's named work repos to write to (default "local")
Returns: { action: 'delete-subtree', deleted: string, commitResult, absorb? }`,
  params: {
    itemId: {
      type: 'string' as const,
      description: 'Item ID to mark complete',
    },
    repo: {
      type: 'string' as const,
      description: 'Which of the wing\'s named work repos to write to (default "local"). Ignored outside a wing session.',
    },
  },
  required: ['itemId'] as string[],
  // deleteSubtreeBody deliberately keeps a narrow `Worktree` param (see its own
  // doc comment — `autoCommitPlan`/`MovementSession` need a real `Worktree`),
  // so this cast is required, not a leftover: `wingFiles(w)` is statically
  // `MutableDirectoryLike` but, like every other `activeMovement().files`
  // read in this codebase, is always a real `Worktree` at runtime (see
  // `closetUtils.ts`'s `getWorkLocalCostumes` for the same documented cast).
  atWing: async (w: PlanWingContext, params: Record<string, unknown>) => deleteSubtreeBody((await wingFiles(w)) as Worktree, w.lair, params, await w.perspective.workArea()),
  atLair: (l: PlanLairContext, params: Record<string, unknown>) => deleteSubtreeViaMirror(l.perspective, l.lair, params),
};

async function addChildrenBody(worktree: MutableDirectoryLike, lair: Sandbox, params: Record<string, unknown>) {
  const parentId = asNodeId(params['parentId'] as string);
  if (!parentId) throw new Error('add-children requires parentId');
  const children = params['children'] as Array<{ title: string; type?: ItemType; details: string; context: string }>;
  if (!Array.isArray(children) || children.length === 0) {
    throw new Error('add-children requires a non-empty children array');
  }
  for (const child of children) {
    if (!child.details || !child.details.trim()) {
      throw new Error(`add-children: child "${child.title}" must have non-empty details`);
    }
    if (!child.context || !child.context.trim()) {
      throw new Error(`add-children: child "${child.title}" must have non-empty context`);
    }
  }
  const store = await resolvePlanStore(worktree, lair);
  if (!store) throw new Error(`Wing has no plans/planner directory`);
  const created = [];
  for (const child of children) {
    const item = await store.addChild(parentId, child.title, child.type);
    await Promise.all([
      store.setDetails(item.id, child.details),
      store.setParentContext(item.id, child.context),
    ]);
    created.push(item);
  }
  return { action: 'add-children', created };
}

const addChildrenAction = {
  description: 'break an item into sub-items',
  help: `**plan add-children** — Add child items under a parent.

Creates one or more child items under the specified parent.
Use this to break a plan item into smaller sub-tasks.

Each child requires both a non-empty details (description/criteria/notes in markdown)
and a non-empty context (relevant contextual info distilled from ancestor nodes so an
implementor working only on this node has all they need).

Not auto-committed when called via a wing session (atWing) — follow a batch of plan
writes with a single \`movement commit\` (type=plan). Atomic (write + commit + publish
in one call, response includes commitResult) when called against a lair-registered
repo's plan/main directly (atLair, no wingName).

Wing name is taken from the session URL (/mcp/henchery/<wing-name>).
Required: parentId, children (non-empty array of { title, type?, details, context })
Item types: task | fork | option (defaults to task)
Optional: repo — which of the wing's named work repos to write to (default "local")
Returns: { action: 'add-children', created: PlanItem[], commitResult? }`,
  params: {
    parentId: {
      type: 'string' as const,
      description: 'Parent item ID',
    },
    repo: {
      type: 'string' as const,
      description: 'Which of the wing\'s named work repos to write to (default "local"). Ignored outside a wing session.',
    },
    children: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          title: { type: 'string' as const },
          type: { type: 'string' as const, enum: ['task', 'fork', 'option'] },
          details: { type: 'string' as const, description: 'Markdown description, criteria, and notes for this item (non-empty)' },
          context: { type: 'string' as const, description: 'Contextual markdown distilled from ancestor nodes — everything an implementor needs when working only on this node (non-empty)' },
        },
        required: ['title', 'details', 'context'],
      },
      description: 'Sub-items to create',
    },
  },
  required: ['parentId', 'children'] as string[],
  atWing: async (w: PlanWingContext, params: Record<string, unknown>) => addChildrenBody(await wingFiles(w), w.lair, params),
  atLair: (l: PlanLairContext, params: Record<string, unknown>) => applyAtLairWrite(l.perspective, l.lair, params, "add-children", addChildrenBody),
};

async function setRootOrderBody(worktree: MutableDirectoryLike, lair: Sandbox, params: Record<string, unknown>) {
  const orderedIds = (params['orderedIds'] as string[]).map(asNodeId);
  if (!Array.isArray(orderedIds)) throw new Error('set-root-order requires orderedIds array');
  const store = await resolvePlanStore(worktree, lair);
  if (!store) throw new Error('No plan/main store found');
  await store.setRootOrder(orderedIds);
  return { action: 'set-root-order' };
}

const setRootOrderAction = {
  description: 'set the priority order for root-level plan items',
  help: `**plan set-root-order** — Set the priority order for root-level plan items.

Accepts an ordered array of root item IDs. The first ID has highest priority.
Items not listed are appended after the ordered items (lowest priority).
Pass an empty array to clear explicit ordering.

Not auto-committed when called via a wing session (atWing). Atomic (write + commit +
publish in one call, response includes commitResult) when called against a
lair-registered repo's plan/main directly (atLair, no wingName).

Wing name is taken from the session URL (/mcp/henchery/<wing-name>).
Required: orderedIds
Optional: repo — which lair-registered work repo's plan/main to write to (default: resolved via the calling wing's own "local" alias when called via a wing session; required otherwise)
Returns: { action: 'set-root-order', commitResult? }`,
  params: {
    orderedIds: {
      type: 'array' as const,
      items: { type: 'string' as const },
      description: 'Root item IDs in priority order, highest priority first',
    },
    repo: {
      type: 'string' as const,
      description: 'Which lair-registered work repo\'s plan/main to write to. Defaults to "local".',
    },
  },
  required: ['orderedIds'] as string[],
  atWing: async (w: PlanWingContext, params: Record<string, unknown>) => setRootOrderBody(await wingFiles(w), w.lair, params),
  atLair: (l: PlanLairContext, params: Record<string, unknown>) => applyAtLairWrite(l.perspective, l.lair, params, "set-root-order", setRootOrderBody),
};

async function addQuestionBody(worktree: MutableDirectoryLike, lair: Sandbox, params: Record<string, unknown>) {
  const itemId = asNodeId(params['itemId'] as string);
  const questionId = params['questionId'] as string;
  if (!itemId) throw new Error('add-question requires itemId');
  if (!questionId) throw new Error('add-question requires questionId');
  const store = await resolvePlanStore(worktree, lair);
  if (!store) throw new Error('No plan/main store found');
  await store.addQuestion(itemId, questionId);
  return { action: 'add-question', itemId };
}

const addQuestionAction = {
  description: 'add a question ID to an item, blocking it on the answer',
  help: `**plan add-question** — Add a question ID to a plan item.

Links an ask-tool question instance to this item. The presence of question IDs
signals that the item is blocked pending those answers.
Idempotent — adding the same question ID twice has no effect.

Not auto-committed when called via a wing session (atWing). Atomic (write + commit +
publish in one call, response includes commitResult) when called against a
lair-registered repo's plan/main directly (atLair, no wingName).

Wing name is taken from the session URL (/mcp/henchery/<wing-name>).
Required: itemId, questionId
Optional: repo — which lair-registered work repo's plan/main to write to (default: resolved via the calling wing's own "local" alias when called via a wing session; required otherwise)
Returns: { action: 'add-question', itemId, commitResult? }`,
  params: {
    itemId: {
      type: 'string' as const,
      description: 'Plan item ID to add the question to',
    },
    questionId: {
      type: 'string' as const,
      description: 'Ask-tool question instance ID',
    },
    repo: {
      type: 'string' as const,
      description: 'Which lair-registered work repo\'s plan/main to write to. Defaults to "local".',
    },
  },
  required: ['itemId', 'questionId'] as string[],
  atWing: async (w: PlanWingContext, params: Record<string, unknown>) => addQuestionBody(await wingFiles(w), w.lair, params),
  atLair: (l: PlanLairContext, params: Record<string, unknown>) => applyAtLairWrite(l.perspective, l.lair, params, "add-question", addQuestionBody),
};

async function removeQuestionBody(worktree: MutableDirectoryLike, lair: Sandbox, params: Record<string, unknown>) {
  const itemId = asNodeId(params['itemId'] as string);
  const questionId = params['questionId'] as string;
  if (!itemId) throw new Error('remove-question requires itemId');
  if (!questionId) throw new Error('remove-question requires questionId');
  const store = await resolvePlanStore(worktree, lair);
  if (!store) throw new Error('No plan/main store found');
  await store.removeQuestion(itemId, questionId);
  return { action: 'remove-question', itemId };
}

const removeQuestionAction = {
  description: 'remove a question ID from an item',
  help: `**plan remove-question** — Remove a question ID from a plan item.

Unlinks an ask-tool question from this item (e.g. once answered).
Idempotent — removing a question ID that isn't present has no effect.

Not auto-committed when called via a wing session (atWing). Atomic (write + commit +
publish in one call, response includes commitResult) when called against a
lair-registered repo's plan/main directly (atLair, no wingName).

Wing name is taken from the session URL (/mcp/henchery/<wing-name>).
Required: itemId, questionId
Optional: repo — which lair-registered work repo's plan/main to write to (default: resolved via the calling wing's own "local" alias when called via a wing session; required otherwise)
Returns: { action: 'remove-question', itemId, commitResult? }`,
  params: {
    itemId: {
      type: 'string' as const,
      description: 'Plan item ID to remove the question from',
    },
    questionId: {
      type: 'string' as const,
      description: 'Ask-tool question instance ID to remove',
    },
    repo: {
      type: 'string' as const,
      description: 'Which lair-registered work repo\'s plan/main to write to. Defaults to "local".',
    },
  },
  required: ['itemId', 'questionId'] as string[],
  atWing: async (w: PlanWingContext, params: Record<string, unknown>) => removeQuestionBody(await wingFiles(w), w.lair, params),
  atLair: (l: PlanLairContext, params: Record<string, unknown>) => applyAtLairWrite(l.perspective, l.lair, params, "remove-question", removeQuestionBody),
};

async function updateItemBody(worktree: MutableDirectoryLike, lair: Sandbox, params: Record<string, unknown>) {
  const itemId = asNodeId(params['itemId'] as string);
  if (!itemId) throw new Error('update-item requires itemId');
  const store = await resolvePlanStore(worktree, lair);
  if (!store) throw new Error('Wing has no plans/planner directory');

  const updated: string[] = [];

  if ('title' in params) {
    const title = params['title'] as string;
    if (typeof title !== 'string' || !title.trim()) {
      throw new Error('title must be a non-empty string');
    }
    await store.setTitle(itemId, title);
    updated.push('title');
  }

  if ('type' in params) {
    const type = params['type'];
    if (type !== 'task' && type !== 'fork' && type !== 'option') {
      throw new Error("type must be 'task', 'fork', or 'option'");
    }
    await store.setType(itemId, type);
    updated.push('type');
  }

  if ('criteria' in params) {
    const criteria = params['criteria'];
    if (!Array.isArray(criteria) || !criteria.every((c) => typeof c === 'string')) {
      throw new Error('criteria must be an array of strings');
    }
    await store.setCriteria(itemId, criteria as string[]);
    updated.push('criteria');
  }

  if ('details' in params) {
    await store.setDetails(itemId, params['details'] as string);
    updated.push('details');
  }

  if ('parentContext' in params) {
    const parentContext = params['parentContext'] as string;
    const item = await store.getItem(itemId);
    if (item?.parent === null) {
      if (parentContext.trim() !== '') {
        throw new Error('Root items must have empty parentContext — context comes from ancestors, and roots have none');
      }
    } else {
      if (!parentContext || !parentContext.trim()) {
        throw new Error('Non-root items must have non-empty parentContext. Every implementor working on this node needs enough context to act without reading ancestor nodes. If context truly is not needed, set it to "N/A" with a brief explanation.');
      }
    }
    await store.setParentContext(itemId, parentContext);
    updated.push('parentContext');
  }

  if ('approved' in params) {
    const approved = coerceApproved(params['approved']);
    await store.setApproved(itemId, approved);
    updated.push('approved');
  }

  if ('requires' in params) {
    const requires = (params['requires'] as string[]).map(asNodeId);
    if (!Array.isArray(requires)) throw new Error('requires must be an array of strings');
    await store.setRequires(itemId, requires);
    updated.push('requires');
  }

  if ('ready' in params) {
    const ready = params['ready'] as boolean;
    if (typeof ready !== 'boolean') throw new Error('ready must be a boolean');
    await store.setReady(itemId, ready);
    updated.push('ready');
  }

  if ('places' in params) {
    const places = params['places'] === null ? undefined : (params['places'] as Record<string, NodePlacement> | undefined);
    if (places !== undefined) {
      if (typeof places !== 'object' || Array.isArray(places)) {
        throw new Error('places must be an object keyed by space kind');
      }
      for (const [kind, p] of Object.entries(places)) {
        if (!p || !Array.isArray((p as NodePlacement).locationIds)) {
          throw new Error(`places["${kind}"] must have a locationIds array`);
        }
      }
    }
    await store.setPlaces(itemId, places);
    updated.push('places');
  }

  return { action: 'update-item', itemId, updated };
}

const updateItemAction = {
  description: 'update any properties of a plan item',
  help: `**plan update-item** — Update any properties of a plan item.

Pass only the fields you want to change. Omitted fields are left unchanged.

Fields:
- title (string): the item's human-readable title. Must be non-empty.
- type ("task" | "fork" | "option"): the item's kind. task=normal work, fork=decision
  point, option=one branch of a fork.
- criteria (string[]): acceptance/verification criteria for the item. Replaces the entire list.
- details (string): freeform markdown — description, criteria, guesses, risks, acceptance
  notes, etc. Completely replaces existing content.
- parentContext (string): contextual markdown distilled from ancestor nodes so an implementor
  working only on this node has all the background they need. Must be empty for root items.
  Completely replaces existing content.
- approved (true | false | "tentative"): approval state. Applies recursively to all
  descendants. true=overlord-approved, false=unapproved, "tentative"=AI-created
  auto-approved. Also carries the "planning is done enough" meaning: approved !== false
  means planning is done enough.
- requires (string[]): IDs of items this item depends on. Replaces the entire existing requires list.
- ready (boolean): whether the overlord has explicitly queued this item for execution.
  Only meaningful when approved is non-false. Not recursive (single item only).
  Automatically cleared when approved is set to false.
- places (object | null): product-space placement, keyed by space kind ("user-flow" | "data-flow")
  → { locationIds: string[], flowIds?: string[] }. Records which stable locations/flows (defined in
  .meta/plan/.spaces/*.json) this node touches. Replaces the whole placement set; null clears it.

Note: started and onPath are read-only, computed fields (started = claimedBy !==
undefined; onPath = this node or a descendant has claimedBy or demoLink) — they
cannot be set here. Use claim-node/unclaim-node to change them.

Not auto-committed when called via a wing session (atWing). Atomic (write + commit +
publish in one call, response includes commitResult) when called against a
lair-registered repo's plan/main directly (atLair, no wingName).

Wing name is taken from the session URL (/mcp/henchery/<wing-name>).
Required: itemId
Optional: title, type, criteria, details, parentContext, approved, requires, ready, places, repo
Returns: { action: 'update-item', itemId, updated: string[], commitResult? }`,
  params: {
    itemId: {
      type: 'string' as const,
      description: 'Plan item ID to update',
    },
    repo: {
      type: 'string' as const,
      description: 'Which of the wing\'s named work repos to write to (default "local"). Ignored outside a wing session.',
    },
    title: {
      type: 'string' as const,
      description: "The item's human-readable title. Must be non-empty.",
    },
    type: {
      type: 'string' as const,
      enum: ['task', 'fork', 'option'],
      description: "The item's kind: task (normal work), fork (decision point), or option (one branch of a fork).",
    },
    criteria: {
      type: 'array' as const,
      items: { type: 'string' as const },
      description: 'Acceptance/verification criteria for the item. Replaces the entire existing list.',
    },
    details: {
      type: 'string' as const,
      description: 'Freeform markdown for the item. Replaces all existing content.',
    },
    parentContext: {
      type: 'string' as const,
      description: 'Contextual markdown from ancestor nodes for the implementor. Must be empty string for root items. Replaces all existing content.',
    },
    approved: {
      description: 'Approval state: true=approved, false=unapproved, "tentative"=AI-created auto-approved. Propagates to descendants. approved !== false also means planning is done enough.',
    },
    requires: {
      type: 'array' as const,
      items: { type: 'string' as const },
      description: 'IDs of items this item depends on. Replaces the entire existing requires list.',
    },
    ready: {
      type: 'boolean' as const,
      description: 'Whether the overlord has explicitly queued this item for execution. Only meaningful when approved is non-false. Not recursive.',
    },
    places: {
      type: 'object' as const,
      description: 'Product-space placement: object keyed by space kind ("user-flow" | "data-flow") → { locationIds: string[], flowIds?: string[] } — the stable locations/flows this node touches. Replaces the whole placement set; pass null to clear.',
    },
  },
  required: ['itemId'] as string[],
  atWing: async (w: PlanWingContext, params: Record<string, unknown>) => updateItemBody(await wingFiles(w), w.lair, params),
  atLair: (l: PlanLairContext, params: Record<string, unknown>) => applyAtLairWrite(l.perspective, l.lair, params, "update-item", updateItemBody),
};

// There is no set-approved or set-planning-done action: both would be pure
// duplicates of what update-item's approved param already does — approved
// carries the "planning is done enough" meaning itself. Use update-item.

async function createRootBody(worktree: MutableDirectoryLike, lair: Sandbox, params: Record<string, unknown>) {
  const title = params['title'] as string;
  if (!title) throw new Error('create-root requires title');
  const store = await resolvePlanStoreCreating(worktree, lair);
  const item = await store.createRoot(title);
  if ('details' in params && params['details']) {
    await store.setDetails(item.id, params['details'] as string);
  }
  return { action: 'create-root', item };
}

const createRootAction = {
  description: 'create a new top-level plan item',
  help: `**plan create-root** — Create a new root-level plan item.

Creates a new top-level item in the plan forest. Use this to start a new plan.
Then use add-children to break it into sub-tasks (prerequisites).

In Mikado order, children execute BEFORE their parent. So the walking skeleton
should be the deepest child — it executes first.

Root items always have empty parentContext (there are no ancestors to draw context from).
Provide details to describe the overall goal.

Not auto-committed when called via a wing session (atWing). Atomic (write + commit +
publish in one call, response includes commitResult) when called against a
lair-registered repo's plan/main directly (atLair, no wingName).

Wing name is taken from the session URL (/mcp/henchery/<wing-name>).
Required: title
Optional: details, repo — which of the wing's named work repos to write to (default "local")
Returns: { action: 'create-root', item: PlanItem, commitResult? }`,
  params: {
    title: {
      type: 'string' as const,
      description: 'Title of the new root plan item (the overall goal — done last)',
    },
    details: {
      type: 'string' as const,
      description: 'Markdown description of the overall goal and acceptance criteria.',
    },
    repo: {
      type: 'string' as const,
      description: 'Which of the wing\'s named work repos to write to (default "local"). Ignored outside a wing session.',
    },
  },
  required: ['title'] as string[],
  atWing: async (w: PlanWingContext, params: Record<string, unknown>) => createRootBody(await wingFiles(w), w.lair, params),
  atLair: (l: PlanLairContext, params: Record<string, unknown>) => applyAtLairWrite(l.perspective, l.lair, params, "create-root", createRootBody),
};

/** Walks the parent chain from nodeId up to goalId, throwing if goalId isn't an ancestor. */
function walkPathToGoal(items: Record<string, PlanItem>, nodeId: NodeId, goalId: NodeId): NodeId[] {
  const path: NodeId[] = [];
  let current: NodeId | null = nodeId;
  while (current !== null) {
    path.push(current);
    if (current === goalId) break;
    const item: PlanItem | undefined = items[current];
    if (!item) throw new Error(`Item missing during path traversal: ${current}`);
    current = item.parent;
  }

  if (path[path.length - 1] !== goalId) {
    throw new Error(`goalId ${goalId} is not an ancestor of nodeId ${nodeId}`);
  }

  return path;
}

/**
 * The `claim-node` action's real implementation (design doc §4.5): the
 * ENTIRE mutation — the "already claimed?" validation read, the write, and
 * `pruneDanglingClaims` — runs INSIDE a single `mirror.apply()` transform,
 * re-run in full on every CAS retry, not read-once before the first
 * attempt. `Mirror.apply()` already does read-fresh + commit +
 * CAS-publish-with-retry, so no separate commit/lock/full-sync/absorb
 * orchestration is needed here.
 *
 * Because the whole transform re-runs against fresh state on a lost race, a
 * retry that lands after someone else's claim already committed sees that
 * claim on its own fresh read and throws the exact same "already claimed"
 * error a first-attempt collision would — invariant B's "recompute purely
 * and retry" shape, not a special-cased failure path. Every already-claimed
 * outcome (first attempt or a retry) reads as "Node ... is already claimed
 * by wing ... on branch ...".
 *
 * NOTE: `claim-leaf` (`claimLeafBody`, below) does NOT call this function —
 * it has its own `mirror.apply()`-based flow, structured around claim-leaf's
 * own rules (self-heal of abandoned non-leaf claims, an "already holds a
 * leaf" short-circuit, candidate ranking) rather than the single-node
 * validate-then-claim shape this function implements. Both run their entire
 * mutation inside a `mirror.apply()` transform, re-run in full on every CAS
 * retry — see `claimLeafBody`'s own doc comment.
 */
async function claimNodeBody(
  lairPerspective: LairRepoPerspective,
  lair: Sandbox,
  wingName: string,
  branch: string,
  validationStore: IPlanStore,
  params: Record<string, unknown>,
) {
  const nodeId = asNodeId(params['nodeId'] as string);
  const goalId = asNodeId(params['goalId'] as string);
  if (!nodeId) throw new Error('claim-node requires nodeId');
  if (!goalId) throw new Error('claim-node requires goalId');

  // Validate node/path against validationStore — the calling wing's own
  // content when called atWing, so a node the wing just created locally
  // (not yet merged to main) can still be claimed; falls back to the lair
  // store itself atLair. Read-only, from a worktree entirely outside the
  // mirror being written to, so this doesn't need to be inside the
  // transform: nodeId/goalId's presence there doesn't depend on plan/main's
  // claim state, and doesn't change between apply() retries.
  const roots = await validationStore.listRoots();
  let subtree: SubtreeIndex | null = null;
  for (const rootId of roots) {
    const idx = await validationStore.getSubtree(rootId);
    if (idx?.items[nodeId] !== undefined) {
      subtree = idx;
      break;
    }
  }
  if (!subtree) throw new Error(`Node not found: ${nodeId}`);
  if (!subtree.items[goalId]) throw new Error(`Goal not found in same subtree: ${goalId}`);

  const path = walkPathToGoal(subtree.items, nodeId, goalId);

  const { result, committed, commitHash, attempts } = await mirrorCommit(lairPerspective, `claim node ${nodeId} toward goal ${goalId}`, async (view) => {
    const store = await resolvePlanStore(view, lair);
    if (!store) throw new Error('No plan/main store found');

    // Re-validated fresh on every attempt (invariant B) — see doc comment above.
    const current = await store.getItem(nodeId);
    if (current?.claimedBy) {
      const { wing: claimedWing, branch: claimedBranch } = current.claimedBy;
      throw new Error(`Node ${nodeId} is already claimed by wing "${claimedWing}" on branch "${claimedBranch}"`);
    }

    // Only the leaf gets a claims.toml entry — onPath/started are computed
    // from claimedBy presence at read time, nothing else to write.
    // rootIdHint (subtree.root, from the validating view) lets this land in
    // the right root even if nodeId itself isn't merged to the mirror's own
    // content yet.
    await store.setClaimedBy(nodeId, { wing: wingName, branch }, subtree.root);
    const { prunedIds } = await store.pruneDanglingClaims((id, claimedBy) =>
      wingStillHasNode(lair, claimedBy.wing, id),
    );
    return { prunedIds };
  });

  return {
    action: 'claim-node',
    nodeId,
    goalId,
    path,
    commitResult: { committed, commitHash, attempts },
    prunedClaims: result.prunedIds,
  };
}

const claimNodeAction = {
  description: 'claim a leaf node as WIP and mark the entire path back to the goal as actively worked towards',
  help: `**plan claim-node** — Claim a leaf node and mark its path to the goal.

Sets claimedBy={wing,branch} on nodeId. started (claimedBy !== undefined) and
onPath (this node or any descendant has claimedBy or a demoLink, walked up
through every ancestor) are computed at read time from that — nothing else is
written. goalId must be an ancestor of nodeId; the returned path is informational.

Only nodeId is "claimed". Ancestors merely read as onPath=true, meaning they're on
the path toward a claimed node — they are NOT themselves claimed and may be taken
by another agent if dependencies allow.

If nodeId was just created on the calling wing's own branch and hasn't merged to
main yet, this still succeeds — validated against the wing's own content — but the
claim is invisible to any other wing until that merge happens (it's a dangling
claims.toml entry there, by design, not an error).

Atomic: auto-commits and absorbs to main immediately so other agents see the
claim without a separate \`movement commit\` call. Also opportunistically sweeps stale
claims.toml entries left over from earlier claim/complete races (see prunedClaims).

Wing name is taken from the session URL (/mcp/henchery/<wing-name>).
Required: nodeId, goalId
Optional: repo — which lair-registered work repo's plan/main to claim in (default: resolved via the calling wing's own "local" alias when called via a wing session; required otherwise)
Returns: { action: 'claim-node', nodeId, goalId, path: string[], commitResult, absorb?, prunedClaims: string[] }`,
  params: {
    nodeId: {
      type: 'string' as const,
      description: 'The leaf node being claimed and worked on (will be marked started=true)',
    },
    goalId: {
      type: 'string' as const,
      description: 'The top-level goal or request node (must be an ancestor of nodeId)',
    },
    repo: {
      type: 'string' as const,
      description: 'Which lair-registered work repo\'s plan/main to claim in. Defaults to "local".',
    },
  },
  required: ['nodeId', 'goalId'] as string[],
  atWing: async (w: PlanWingContext, params: Record<string, unknown>) => {
    const branch = await wingBranch(w);
    const lairPerspective = await w.perspective.toLairRepo();
    // Validate against the wing's own content when possible — this is what
    // lets a wing claim a node it just created locally, before it merges.
    const wingStore = await resolvePlanStore(await wingFiles(w), w.lair);
    const validationStore = wingStore ?? (await resolvePlanStore(lairPerspective.mirror.files, w.lair));
    if (!validationStore) throw new Error('No plan store found to validate against');
    return claimNodeBody(lairPerspective, w.lair, w.perspective.wingName, branch, validationStore, params);
  },
  atLair: async (l: PlanLairContext, params: Record<string, unknown>) => {
    // `l.perspective.mirror.trunk.branch` (design doc §4.1's `Trunk.branch`)
    // replaces `l.perspective.worktree.currentBranch()` — a plain, non-
    // throwing property read (no try/catch needed, unlike the wing-side
    // `wingBranch()`) since there's no `Movement`/worktree checkout involved
    // at all here, only the `Mirror`'s own `Trunk` handle.
    const branch = l.perspective.mirror.trunk.branch;
    const validationStore = await resolvePlanStore(l.perspective.mirror.files, l.lair);
    if (!validationStore) throw new Error('No plan/main store found');
    return claimNodeBody(l.perspective, l.lair, 'unknown', branch, validationStore, params);
  },
};

/**
 * The `claim-leaf` action's implementation (design doc §4.5): the ENTIRE
 * flow — self-heal of abandoned non-leaf claims, the "does this wing
 * already hold a leaf" short-circuit, candidate ranking, and the claim
 * write itself — runs INSIDE a single `mirror.apply()` transform, re-run in
 * full on every CAS retry. Folding everything into one transform means
 * every attempt (first or retry) recomputes self-heal + selection + claim
 * fresh against that attempt's own synced view, so a CAS retry's worktree
 * resync can never discard a self-heal write made outside the transform —
 * there is no write outside the transform to discard. See `claimNodeBody`'s
 * own doc comment for the general rationale.
 *
 * Structural search — which nodes are reachable from goalId by following
 * BOTH `children` and `requires` edges, possibly crossing root boundaries
 * (`findExpandedSubtree`, same as get-leaves uses) — runs against
 * `validationStore`: the calling wing's own content when called atWing, so
 * a goal or leaf the wing just created locally, not yet merged to main, is
 * still visible — exactly like `claimNodeBody`'s `validationStore`. Claim
 * state itself (claimedBy) is NOT taken from `validationStore`: it always
 * lives on the canonical plan/main mirror, so it's read fresh from `store`
 * inside the transform on every attempt (invariant B), overlaid onto the
 * structurally-discovered items. A node that only exists in the wing's
 * local content has simply never been claimed by anyone yet.
 */
async function claimLeafBody(
  lairPerspective: LairRepoPerspective,
  lair: Sandbox,
  wingName: string,
  branch: string,
  validationStore: IPlanStore,
  params: Record<string, unknown>,
) {
  const goalId = asNodeId(params['goalId'] as string);
  if (!goalId) throw new Error('claim-leaf requires goalId');

  // Read once, outside the mirror transform: like claimNodeBody's own
  // subtree validation, this is a structural fact that doesn't depend on
  // plan/main's claim state and doesn't change between apply() retries.
  const structuralSubtree = await findExpandedSubtree(validationStore, goalId);
  if (!structuralSubtree) throw new Error(`Goal not found: ${goalId}`);

  const { result, committed, commitHash, attempts } = await mirrorCommit(lairPerspective, `claim-leaf toward goal ${goalId}`, async (view) => {
    const store = await resolvePlanStore(view, lair);
    if (!store) throw new Error('No plan/main store found');

    // Overlay the canonical claim state onto the wing-scoped structural
    // subtree — see this function's own doc comment above. Uses
    // fetchAllItemsWithHomeRoots (a full-mirror read, same cost as
    // findExpandedSubtree's own internal fetch) rather than per-id lookups,
    // since the structural subtree can span multiple roots.
    const { items: canonicalItems } = await fetchAllItemsWithHomeRoots(store);
    const subtreeItems: Record<string, PlanItem> = {};
    for (const item of Object.values(structuralSubtree.items)) {
      subtreeItems[item.id] = { ...item, claimedBy: canonicalItems[item.id]?.claimedBy };
    }

    const allItems = Object.values(subtreeItems);
    const leafItems = allItems.filter((item) => item.children.length === 0);

    // Self-heal: only leaves are ever supposed to carry a claim. A non-leaf
    // with claimedBy set (e.g. a leaf got reparented under a claim without
    // going through unclaim-node first) would otherwise force onPath=true
    // down a branch of the tree forever — clear those out unconditionally,
    // regardless of which wing they're claimed by.
    const abandonedNonLeafClaims = allItems.filter((item) => item.children.length > 0 && item.claimedBy);
    for (const item of abandonedNonLeafClaims) {
      await store.setClaimedBy(item.id, undefined, structuralSubtree.homeRoot[item.id] ?? structuralSubtree.root);
    }

    // If this wing already holds a claim on one of goalId's leaves, that
    // claim wins outright — no ranking, no "would it free up work" check.
    // If it somehow holds more than one (a retried claim-leaf racing another
    // caller, or a manual claim-node), keep exactly one and release the rest
    // so the wing isn't double-booked.
    const ownLeaves = leafItems.filter((item) => item.claimedBy?.wing === wingName).sort((a, b) =>
      a.id.localeCompare(b.id),
    );

    const blockCounts = computeBlockCounts(subtreeItems);
    const chainLengths = computeChainLengths(subtreeItems);

    let claimedNodeId: NodeId;
    let alreadyClaimed = false;
    let candidatesConsidered: number;
    let pickedScore = { directBlocks: 0, indirectBlocks: 0 };

    if (ownLeaves.length > 0) {
      const [kept, ...extraOwnLeaves] = ownLeaves;
      for (const item of extraOwnLeaves) {
        await store.setClaimedBy(item.id, undefined, structuralSubtree.homeRoot[item.id] ?? structuralSubtree.root);
      }
      claimedNodeId = kept.id;
      alreadyClaimed = true;
      candidatesConsidered = leafItems.filter((item) => !item.claimedBy && item.requires.length === 0).length;
      pickedScore = blockCounts[kept.id] ?? pickedScore;
    } else {
      const candidates = leafItems.filter((item) => !item.claimedBy && item.requires.length === 0);

      if (candidates.length === 0) {
        throw new Error(
          `No claimable work available right now in goal ${goalId} — every leaf is either already claimed or blocked on unmet requires. Stop and ask to be cleared and given a different task.`,
        );
      }

      // Rank by how much parallel work completing each candidate would free
      // up (total items blocked on it, direct + indirect), tiebreaking on
      // the longest serial chain behind it so a bottleneck node wins when
      // nothing frees up much in parallel. Final tiebreak on id, for
      // determinism.
      const ranked = [...candidates].sort((a, b) => {
        const scoreA = blockCounts[a.id] ?? { directBlocks: 0, indirectBlocks: 0 };
        const scoreB = blockCounts[b.id] ?? { directBlocks: 0, indirectBlocks: 0 };
        const totalA = scoreA.directBlocks + scoreA.indirectBlocks;
        const totalB = scoreB.directBlocks + scoreB.indirectBlocks;
        if (totalA !== totalB) return totalB - totalA;

        const chainA = chainLengths[a.id] ?? 0;
        const chainB = chainLengths[b.id] ?? 0;
        if (chainA !== chainB) return chainB - chainA;

        return a.id.localeCompare(b.id);
      });

      const picked = ranked[0];
      // The picked leaf's real home root — not `structuralSubtree.root`
      // (goalId's own root), which is only correct when the leaf was
      // reached without ever crossing a `requires` edge into another root.
      // `findExpandedSubtree` (run against validationStore) tracks each
      // item's actual home root precisely because those two can now differ.
      const pickedHomeRoot = structuralSubtree.homeRoot[picked.id] ?? structuralSubtree.root;
      await store.setClaimedBy(picked.id, { wing: wingName, branch }, pickedHomeRoot);

      claimedNodeId = picked.id;
      candidatesConsidered = candidates.length;
      pickedScore = blockCounts[picked.id] ?? pickedScore;
    }

    const { prunedIds } = await store.pruneDanglingClaims((id, claimedBy) =>
      wingStillHasNode(lair, claimedBy.wing, id),
    );

    const path = walkExpandedPathToGoal(structuralSubtree.reachedVia, claimedNodeId, goalId);

    return {
      nodeId: claimedNodeId,
      alreadyClaimed,
      path,
      candidatesConsidered,
      parallelismScore: pickedScore.directBlocks + pickedScore.indirectBlocks,
      chainLength: chainLengths[claimedNodeId] ?? 0,
      prunedIds,
    };
  });

  return {
    action: 'claim-leaf' as const,
    nodeId: result.nodeId,
    goalId,
    path: result.path,
    candidatesConsidered: result.candidatesConsidered,
    parallelismScore: result.parallelismScore,
    chainLength: result.chainLength,
    ...(result.alreadyClaimed ? { alreadyClaimed: true as const } : {}),
    commitResult: { committed, commitHash, attempts },
    prunedClaims: result.prunedIds,
  };
}

const claimLeafAction = {
  description: 'pick the leaf that frees up the most work under a goal, then claim it — combines get-leaves + claim-node; sticks with the calling wing\'s existing claim if it has one',
  help: `**plan claim-leaf** — Pick and claim the best available leaf under a goal.

If the calling wing already holds a claim on one of goalId's leaves, that claim
wins outright — no ranking, no "would it free up work" check. That leaf is
returned as-is (alreadyClaimed: true) without going through claim-node again.
If the wing somehow holds more than one leaf claim in this subtree, one is kept
(the lowest id) and the rest are released.

Every call also self-heals the subtree: any non-leaf item that has a claim set
(only leaves are ever supposed to carry one — this happens when a claimed leaf
gets reparented under it without going through unclaim-node first) has that
claim cleared, regardless of which wing holds it. This runs before the
"does this wing already have a leaf" check above.

Otherwise, looks at every leaf reachable from goalId by following BOTH
children and requires links, at every step of the traversal — so a leaf that
only becomes reachable by crossing a requires edge into a completely
different root is still found. This matters whenever goalId's own children
require work that lives elsewhere: without following those links, a goal can
look like it has no claimable leaves at all even though the real blocking
work is one requires-hop away. Filters to leaves that are unclaimed and have
no unmet requires of their own, then claims the one whose completion would
unblock the most other work: ranked by total block count
(computeBlockCounts's directBlocks + indirectBlocks — how many other items
are, directly or transitively, blocked behind it), breaking ties by the
longest chain of items serially blocked behind it (computeChainLengths). When
nothing frees up parallel work directly, this tiebreak naturally favors
starting the longest serial chain first, since everything on it stays blocked
until it's done.

Which nodes exist reachable from goalId is searched via the calling wing's
own content when called via a wing session (so a goal — or a leaf reachable
from it — the wing just created locally, not yet merged to main, is still
visible and claimable), falling back to plan/main directly outside a wing
session. Claim state itself (which leaves are already claimed, and by whom)
always comes from the canonical plan/main mirror, read fresh on every
attempt — a node that only exists in the wing's local content simply hasn't
been claimed by anyone yet. If the picked leaf was just created on the
calling wing's own branch and hasn't merged to main yet, the claim still
succeeds — it's a dangling claims.toml entry there, by design, not an error —
but it's invisible to any other wing until that merge happens.

Equivalent to get-leaves + manually choosing a leaf + claim-node, but the tool
does the choosing. The returned path traces the actual route the traversal
took back to goalId — a mix of parent and requires hops when the claimed leaf
lives in another root, not necessarily a plain ancestor chain.

If no leaf under goalId is currently claimable — every leaf is either already
claimed by another wing or has unmet requires — this throws. Read that as: STOP
and ask to be cleared and given a different task. Do not keep searching this
goal for work.

Wing name is taken from the session URL (/mcp/henchery/<wing-name>).
Required: goalId
Optional: repo — which lair-registered work repo's plan/main to claim in (default: resolved via the calling wing's own "local" alias when called via a wing session; required otherwise)
Returns: { action: 'claim-leaf', nodeId, goalId, path: string[], candidatesConsidered, parallelismScore, chainLength, commitResult, absorb?, prunedClaims: string[], alreadyClaimed?: true }`,
  params: {
    goalId: {
      type: 'string' as const,
      description: 'The top-level goal or request node whose leaves should be considered',
    },
    repo: {
      type: 'string' as const,
      description: 'Which lair-registered work repo\'s plan/main to claim in. Defaults to "local".',
    },
  },
  required: ['goalId'] as string[],
  atWing: async (w: PlanWingContext, params: Record<string, unknown>) => {
    const branch = await wingBranch(w);
    const lairPerspective = await w.perspective.toLairRepo();
    // Validate/search against the wing's own content when possible — this is
    // what lets a wing claim a leaf under a goal it just created locally,
    // before it merges (see claim-node's atWing above for the same pattern).
    const wingStore = await resolvePlanStore(await wingFiles(w), w.lair);
    const validationStore = wingStore ?? (await resolvePlanStore(lairPerspective.mirror.files, w.lair));
    if (!validationStore) throw new Error('No plan store found to validate against');
    return claimLeafBody(lairPerspective, w.lair, w.perspective.wingName, branch, validationStore, params);
  },
  atLair: async (l: PlanLairContext, params: Record<string, unknown>) => {
    // See claim-node's atLair above for why this is a plain property read.
    const branch = l.perspective.mirror.trunk.branch;
    const validationStore = await resolvePlanStore(l.perspective.mirror.files, l.lair);
    if (!validationStore) throw new Error('No plan/main store found');
    return claimLeafBody(l.perspective, l.lair, 'unknown', branch, validationStore, params);
  },
};

async function moveNodeBody(worktree: MutableDirectoryLike, lair: Sandbox, params: Record<string, unknown>) {
  const itemId = asNodeId(params['itemId'] as string);
  if (!itemId) throw new Error('move-node requires itemId');
  // newParentId is intentionally NOT in `required`: null (promote-to-root) is a
  // valid value that the framework's required-check would reject as "missing".
  if (!('newParentId' in params)) {
    throw new Error('move-node requires newParentId (a node ID, or null to promote to a root)');
  }
  const raw = params['newParentId'];
  if (raw !== null && typeof raw !== 'string') {
    throw new Error('newParentId must be a node ID string, or null to promote to a root');
  }
  const newParentId = raw === null ? null : asNodeId(raw as string);

  const store = await resolvePlanStore(worktree, lair);
  if (!store) throw new Error('Wing has no plans/planner directory');
  await store.moveItem(itemId, newParentId);
  return { action: 'move-node', itemId, newParentId };
}

const moveNodeAction = {
  description: 'move a node (with its subtree) to a new parent, or promote it to a root',
  help: `**plan move-node** — Re-parent a node, or convert between root and child.

Moves itemId — and its entire subtree — under newParentId. Pass newParentId=null to
promote itemId to a new top-level root. Moving an existing root under a parent demotes
it. Cross-root moves relocate the subtree's stored content (structure + markdown)
automatically.

Rejects moves that would create a cycle: newParentId may not be itemId itself or any of
its descendants. No-op when the item is already directly under newParentId.

This is a structural edit. When called via a wing session (atWing, writing to the wing's
own worktree), it is NOT auto-committed — follow a batch of plan writes with a single
\`movement commit\` (type=plan) describing the overall intent. When called against a
lair-registered repo's plan/main directly (atLair, no wingName), it IS atomic — write +
commit + publish happen as one call, and the response includes commitResult.

Wing name is taken from the session URL (/mcp/henchery/<wing-name>).
Required: itemId
Optional: newParentId — target parent node ID, or null to promote itemId to a top-level root
Optional: repo — which of the wing's named work repos to write to (default "local")
Returns: { action: 'move-node', itemId, newParentId, commitResult? }`,
  params: {
    itemId: {
      type: 'string' as const,
      description: 'Node to move (its whole subtree moves with it)',
    },
    newParentId: {
      description: 'Target parent node ID, or null to promote itemId to a top-level root',
    },
    repo: {
      type: 'string' as const,
      description: 'Which of the wing\'s named work repos to write to (default "local"). Ignored outside a wing session.',
    },
  },
  required: ['itemId'] as string[],
  atWing: async (w: PlanWingContext, params: Record<string, unknown>) => moveNodeBody(await wingFiles(w), w.lair, params),
  atLair: (l: PlanLairContext, params: Record<string, unknown>) => applyAtLairWrite(l.perspective, l.lair, params, "move-node", moveNodeBody),
};

async function unclaimNodeBody(lairPerspective: LairRepoPerspective, lair: Sandbox, wingName: string, params: Record<string, unknown>) {
  const nodeId = asNodeId(params['nodeId'] as string);
  if (!nodeId) throw new Error('unclaim-node requires nodeId');

  // The ENTIRE mutation (validation read + write + prune) runs inside a
  // single mirror.apply() transform, re-run in full on every CAS retry —
  // see claimNodeBody's own doc comment for the full rationale (design doc
  // §4.5).
  const { result, committed, commitHash, attempts } = await mirrorCommit(lairPerspective, `unclaim node ${nodeId}`, async (view) => {
    const store = await resolvePlanStore(view, lair);
    if (!store) throw new Error('No plan/main store found');

    const nodeItem = await store.getItem(nodeId);
    if (!nodeItem) throw new Error(`Node not found: ${nodeId}`);
    if (!nodeItem.claimedBy) {
      throw new Error(`Node ${nodeId} is not claimed`);
    }
    if (nodeItem.claimedBy.wing !== wingName) {
      throw new Error(
        `Node ${nodeId} is claimed by wing "${nodeItem.claimedBy.wing}", not "${wingName}" — you can only release your own claim`,
      );
    }

    // Release the claim on the node itself. onPath for it and every
    // ancestor recomputes automatically on the next read
    // (subtreeKeepsGoalPath over whatever's still claimed/demoable in the
    // subtree) — nothing else to write.
    await store.setClaimedBy(nodeId, undefined);
    const { prunedIds } = await store.pruneDanglingClaims((id, claimedBy) =>
      wingStillHasNode(lair, claimedBy.wing, id),
    );
    return { prunedIds };
  });

  return { action: 'unclaim-node', nodeId, commitResult: { committed, commitHash, attempts }, prunedClaims: result.prunedIds };
}

const unclaimNodeAction = {
  description: 'release a node this wing claimed, clearing the claim',
  help: `**plan unclaim-node** — Release a node this wing previously claimed.

Clears claimedBy on nodeId. started and onPath are computed at read time, not
stored, so nothing else needs writing: onPath along nodeId's ancestor chain
recomputes itself automatically — an ancestor still reads onPath=true if it
leads to some other claimed node, or to a node with a demoLink; otherwise it
reads false. Ancestors on a different claim's path are unaffected either way.

demoLink is NOT cleared by unclaim — releasing a node that has reached a demoable
state (see mark-demo) keeps the goal path reading onPath=true, signaling "this is
done enough to hand off, anyone may pick it up from here." Releasing a node with
no demoLink collapses the goal path back — that branch of work is being
abandoned, at least for now.

Only the wing that made the claim may release it. Unclaiming a node claimed by another
wing — or a node that is not claimed at all — is rejected. (There is no "steal"; to take
over an abandoned claim, coordinate with the owning wing.)

Atomic: auto-commits and absorbs to plan/main immediately (mirrors claim-node), so other
agents see the release without a separate \`movement commit\` call. Also opportunistically
sweeps stale claims.toml entries (see prunedClaims).

Wing name is taken from the session URL (/mcp/henchery/<wing-name>).
Required: nodeId
Optional: repo — which lair-registered work repo's plan/main to release the claim in (default: resolved via the calling wing's own "local" alias when called via a wing session; required otherwise)
Returns: { action: 'unclaim-node', nodeId, commitResult, absorb?, prunedClaims: string[] }`,
  params: {
    nodeId: {
      type: 'string' as const,
      description: 'The claimed node to release (must be claimed by this wing)',
    },
    repo: {
      type: 'string' as const,
      description: 'Which lair-registered work repo\'s plan/main to release the claim in. Defaults to "local".',
    },
  },
  required: ['nodeId'] as string[],
  atWing: async (w: PlanWingContext, params: Record<string, unknown>) => {
    const lairPerspective = await w.perspective.toLairRepo();
    return unclaimNodeBody(lairPerspective, w.lair, w.perspective.wingName, params);
  },
  atLair: (l: PlanLairContext, params: Record<string, unknown>) => unclaimNodeBody(l.perspective, l.lair, 'unknown', params),
};

async function markDemoBody(lairPerspective: LairRepoPerspective, lair: Sandbox, wingName: string, params: Record<string, unknown>) {
  const nodeId = asNodeId(params['nodeId'] as string);
  const demoLink = params['demoLink'] as string;
  if (!nodeId) throw new Error('mark-demo requires nodeId');
  if (!demoLink) throw new Error('mark-demo requires demoLink');

  // The ENTIRE mutation runs inside a single mirror.apply() transform,
  // re-run in full on every CAS retry — see claimNodeBody's own doc comment
  // for the full rationale (design doc §4.5).
  const { result, committed, commitHash, attempts } = await mirrorCommit(lairPerspective, `mark node ${nodeId} ready to demo: ${demoLink}`, async (view) => {
    const store = await resolvePlanStore(view, lair);
    if (!store) throw new Error('No plan/main store found');

    const nodeItem = await store.getItem(nodeId);
    if (!nodeItem) throw new Error(`Node not found: ${nodeId}`);
    if (!nodeItem.claimedBy) {
      throw new Error(`Node ${nodeId} is not claimed — claim it first with claim-node`);
    }
    if (nodeItem.claimedBy.wing !== wingName) {
      throw new Error(
        `Node ${nodeId} is claimed by wing "${nodeItem.claimedBy.wing}", not "${wingName}" — you can only mark your own claim as to-demo`,
      );
    }

    await store.setDemoLink(nodeId, demoLink);
    const { prunedIds } = await store.pruneDanglingClaims((id, claimedBy) =>
      wingStillHasNode(lair, claimedBy.wing, id),
    );
    return { prunedIds };
  });

  return { action: 'mark-demo', nodeId, demoLink, commitResult: { committed, commitHash, attempts }, prunedClaims: result.prunedIds };
}

const markDemoAction = {
  description: 'mark a claimed node as ready to demo, adding a demo URL without releasing the claim',
  help: `**plan mark-demo** — Attach a demo URL to a node this wing has claimed.

Sets demoLink on nodeId without touching claimedBy, started, or onPath — the claim
is preserved. Use this once implementation has reached a demonstrable state but you
are not ready to release the node yet.

Only the wing that claimed nodeId may mark it as to-demo.

Atomic: auto-commits and absorbs to plan/main immediately (mirrors claim-node and
unclaim-node), so other agents see the demo link without a separate \`movement commit\`
call.

Wing name is taken from the session URL (/mcp/henchery/<wing-name>).
Required: nodeId, demoLink
Optional: repo — which lair-registered work repo's plan/main the node was claimed in (default: resolved via the calling wing's own "local" alias when called via a wing session; required otherwise)
Returns: { action: 'mark-demo', nodeId, demoLink, commitResult, absorb? }`,
  params: {
    nodeId: {
      type: 'string' as const,
      description: 'The claimed node to attach a demo URL to',
    },
    demoLink: {
      type: 'string' as const,
      description: 'URL where the work can be demoed',
    },
    repo: {
      type: 'string' as const,
      description: 'Which lair-registered work repo\'s plan/main the node was claimed in. Defaults to "local".',
    },
  },
  required: ['nodeId', 'demoLink'] as string[],
  atWing: async (w: PlanWingContext, params: Record<string, unknown>) => {
    const lairPerspective = await w.perspective.toLairRepo();
    return markDemoBody(lairPerspective, w.lair, w.perspective.wingName, params);
  },
  atLair: (l: PlanLairContext, params: Record<string, unknown>) => markDemoBody(l.perspective, l.lair, 'unknown', params),
};

async function getSpacesBody(worktree: MutableDirectoryLike, lair: Sandbox) {
  const spaces: Record<string, unknown> = {};
  let planDir: MutableDirectoryLike | null = null;
  try {
    planDir = await resolvePlanDir(worktree, lair);
  } catch {
    planDir = null;
  }
  if (!planDir) return { action: 'get-spaces', spaces };

  const spacesRes = await planDir.child('.spaces');
  if (!spacesRes.found || spacesRes.node.kind !== 'worktree') return { action: 'get-spaces', spaces };
  const spacesDir = spacesRes.node;

  const children = await spacesDir.children();
  for (const child of children) {
    if (!child.name.endsWith('.json')) continue;
    const fileRes = await spacesDir.child(child.name);
    if (!fileRes.found || fileRes.node.kind !== 'file') continue;
    try {
      const parsed = JSON.parse(await fileRes.node.read());
      if (parsed && typeof parsed.kind === 'string') spaces[parsed.kind] = parsed;
    } catch {
      /* skip malformed space file */
    }
  }
  return { action: 'get-spaces', spaces };
}

const getSpacesAction = {
  description: 'read the product-space definitions (.meta/plan/.spaces/*.json)',
  help: `**plan get-spaces** — Read the product-space definitions for this wing.

Reads every .json file under <originPlanPath>/.spaces/ and returns them keyed by
each space's "kind" field (e.g. "user-flow", "data-flow"). Returns an empty map
if there is no .spaces directory yet.

Wing name is taken from the session URL (/mcp/henchery/<wing-name>).
Optional: repo — which of the wing's named work repos to read from (default "local")
Returns: { action: 'get-spaces', spaces: Record<kind, ProductSpaceData> }`,
  params: {
    repo: {
      type: 'string' as const,
      description: 'Which of the wing\'s named work repos to read from (default "local"). Ignored outside a wing session.',
    },
  },
  required: [] as string[],
  atWing: async (w: PlanWingContext) => getSpacesBody(await wingFiles(w), w.lair),
  atLair: (l: PlanLairContext) => getSpacesBody(l.perspective.mirror.files, l.lair),
};

const syncAction = {
  description: 'force-refresh a repo\'s local trunk ref from origin, on demand',
  help: `**plan sync** — Force-refresh a repo's local trunk ref from origin on demand.

Fetches origin, then fast-forwards the local trunk ref (e.g. \`main\`) to
\`origin/<trunk>\` — see \`refreshTrunkFromOrigin\` (\`@minions/repo-perspective\`).
Always safe (design doc §2 invariant A: this only ever moves the trunk toward
already-durable state, never away from it) — the same fast-forward
\`Mirror.apply()\` already performs internally, reactively, on a lost publish
race; this just exposes it as something callable explicitly instead of only
reactively. Never pushes anything.

Every plan/movement action already builds a brand-new \`Mirror\` per call, so
reads are always current relative to whatever the LOCAL trunk ref already is
— the only thing this action does that a plain read doesn't is make the
LOCAL trunk ref itself catch up to origin, picking up other wings'/repos'
already-published pushes this repo's own local cache hasn't seen yet. No
mirror worktree is touched directly here; the very next plan action's own
fresh \`Mirror\` construction sees the refreshed trunk automatically.

Optional: repo — a wing's named work repo (default "local") when called via a wing
session, or a lair-registered repo name (required) otherwise.
Optional: trunk — non-wing endpoint only. Refresh a trunk other than main (e.g. an
experiment variation's trunkBranch). Ignored at a wing endpoint (a wing's own
trunk override already determines this).
Returns: { action: 'sync', repo }`,
  params: {
    repo: {
      type: 'string' as const,
      description: 'Which repo\'s trunk to refresh. Defaults to "local" for a wing session; required otherwise.',
    },
    trunk: {
      type: 'string' as const,
      description: 'Non-wing endpoint only: refresh this trunk instead of main. Ignored at a wing endpoint.',
    },
  },
  required: [] as string[],
  async execute(ctx: { lair: Sandbox; wingName?: string }, params: Record<string, unknown>) {
    const lair = createLair(ctx.lair);

    if (ctx.wingName !== undefined) {
      const perspective = await WingPerspective.resolve(lair, asWingName(ctx.wingName), asRepoAlias(params['repo'] as string | undefined));
      const repoName = asLairRepoName(perspective.bareRepo.name.replace(/\.git$/, ''));
      const trunk = await resolveMovementBase(perspective.bareRepo, perspective.worktree);
      await refreshTrunkFromOrigin(perspective.bareRepo, trunk);
      return { action: 'sync', repo: repoName };
    }

    const repoName = asLairRepoName(params['repo'] as string | undefined);
    const workRepo = await lair.workRepo(repoName);
    if (!workRepo.exists) throw new Error(`Repo not registered in lair: ${repoName}`);
    const trunk = typeof params['trunk'] === 'string' ? (params['trunk'] as string) : 'main';
    await refreshTrunkFromOrigin(workRepo.repo, trunk);
    return { action: 'sync', repo: repoName };
  },
};

// ---- factory ----

/**
 * Create an ActionGroupDef for the `plan` MCP tool.
 * The wing name is taken from ActionContext.wingName (set by the henchery route
 * /mcp/henchery/:wingName) rather than as an explicit param.
 * Satisfies ActionGroupDef from @minions/mcp-types structurally.
 * Pass to mcpServer.mountActionGroup() in the cabinet.
 */
export function createPlanActionGroup() {
  return {
    name: 'plan',
    description:
      'The one and only way to read, edit, and mark plan items complete. ' +
      'Do NOT read plan files directly from disk. ' +
      'Wing name is taken from the session URL (/mcp/henchery/<wing-name>).',
    sharedParams: {},
    resolveWingContext: resolvePlanWingContext,
    resolveLairContext: resolvePlanLairContext,
    coreActions: {
      'list-wings': listWingsAction,
      'list-roots': listRootsAction,
      'get-subtree': getSubtreeAction,
      'delete-subtree': deleteSubtreeAction,
      'add-children': addChildrenAction,
      'create-root': createRootAction,
      'update-item': updateItemAction,
      'move-node': moveNodeAction,
      'claim-leaf': claimLeafAction,
      'unclaim-node': unclaimNodeAction,
      'mark-demo': markDemoAction,
    },
    secondaryActions: {
      'get-leaves': getLeavesAction,
      'claim-node': claimNodeAction,
      'set-root-order': setRootOrderAction,
      'add-question': addQuestionAction,
      'remove-question': removeQuestionAction,
      'get-spaces': getSpacesAction,
      sync: syncAction,
    },
  };
}

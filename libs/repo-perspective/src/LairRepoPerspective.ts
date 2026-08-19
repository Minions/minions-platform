import type { Lair, Worktree, BareRepository, LairRepoName, File, Directory, Mirror, Trunk } from '@minions/file-store';
import { createWorkAreaFactoriesForSandbox } from '@minions/file-store';
import { planBranchName } from './planWorktreePath.js';

const DEFAULT_ORIGIN_PLAN_PATH = '.meta/plan';

/**
 * Repository-relative path conductor state (`experiments.json`, etc.) lives
 * at — see `resolveConductorMirror` below. Fixed, unlike the plan mirror's
 * `originPlanPath`: there is no per-lair override for where conductor state
 * lives.
 */
const CONDUCTOR_STORE_PATH = '.meta/conductor';

/**
 * Duplicated, deliberately not consolidated, from
 * `libs/planner/src/PlanActionGroup.ts`'s own copy of the same lookup.
 */
async function readOriginPlanPath(lair: Lair): Promise<string> {
  try {
    const result = await lair.root.child('cabinet.config.json');
    if (!result.found || !result.node.is('file')) return DEFAULT_ORIGIN_PLAN_PATH;
    const content = await (result.node as File).read();
    const config = JSON.parse(content) as Record<string, unknown>;
    return typeof config['originPlanPath'] === 'string' ? config['originPlanPath']
      : typeof config['planPath'] === 'string'       ? config['planPath']
      : DEFAULT_ORIGIN_PLAN_PATH;
  } catch {
    return DEFAULT_ORIGIN_PLAN_PATH;
  }
}

async function ensureDirectory(dir: Directory, name: string): Promise<Directory> {
  const result = await dir.child(name);
  if (result.found && result.node.is('directory')) return result.node as Directory;
  return dir.createDirectory(name);
}

/**
 * Shared setup for both `LairRepoPerspective.resolve()` (plan) and
 * `resolveConductorMirror()` below: resolves the registered `BareRepository`
 * and builds a `Trunk` handle for it, using the SAME scratch directory
 * (`{cabinet}/planning`) both callers use. Deliberately shared, not
 * duplicated — see `resolveConductorMirror`'s own doc comment for why this
 * is what makes plan and conductor share one worktree.
 *
 * Does NOT itself realign `trunk` to `origin/<trunk>` when it isn't locally
 * resolvable yet. Realigning `trunk` here would be unsafe in general:
 * `Mirror`'s `syncToTrunkTip()` only resets a mirror worktree to match the
 * trunk when the trunk itself resolves (see `DiskMirror.ts`/
 * `InMemoryMirror.ts`'s `syncToTrunkTip()`), so forcing `trunk` to suddenly
 * resolve here could silently reset (and destroy the content of) an
 * ALREADY-EXISTING mirror worktree that was deliberately left ahead of an
 * unresolvable trunk (a real fixture shape — see
 * `libs/planner/src/PlanActionGroup.test.ts`'s `makeLockFixture`). On real
 * git (Disk adapter), a
 * root trunk's local branch is assumed to already exist (created by
 * `initBare`/`cloneBare` — see `DiskTrunk.ensureBranchExists()`'s own doc,
 * a no-op for a root trunk) because a real `git clone --bare` mirrors ALL
 * of origin's branches as local heads, not just remote-tracking refs — the
 * InMemory adapter's simulated clone deliberately does NOT (`cloneFrom()`
 * only ever seeds `origin/<branch>`) — a real, intentional fidelity gap
 * (some InMemory test fixtures, like the one above, deliberately need a
 * mirror worktree to exist AHEAD of an unresolvable trunk). A caller that
 * legitimately needs local `main` resolvable before it's ever been touched
 * (only relevant for InMemory-backed tests — real Disk production usage
 * never hits this) is responsible for realigning it itself before calling
 * `resolve()`/`resolveConductorMirror()` — see e.g. `ArchiveService.test.ts`/
 * `ExperimentsService.test.ts`'s own explicit `bareRepo.updateBranch('main',
 * 'origin/main')` setup.
 */
async function resolveTrunkHandle(lair: Lair, repoName: LairRepoName, trunk: string): Promise<{ bareRepo: BareRepository; trunkHandle: Trunk }> {
  const workRepo = await lair.workRepo(repoName);
  if (!workRepo.exists) throw new Error(`Repo not registered in lair: ${repoName}`);
  const bareRepo = workRepo.repo;

  const cabinetDir = await lair.cabinet();
  const scratchRoot = await ensureDirectory(cabinetDir, 'planning');
  const factories = createWorkAreaFactoriesForSandbox(lair.sandbox, scratchRoot);
  const trunkHandle = factories.createTrunk(bareRepo, trunk);

  return { bareRepo, trunkHandle };
}

export class LairRepoPerspective {
  private constructor(
    readonly repoName: LairRepoName,
    readonly bareRepo: BareRepository,
    readonly worktree: Worktree,
    /**
     * The underlying `Mirror` `.worktree` is backed by — exposed so
     * write-path callers (`libs/planner/src/PlanActionGroup.ts`'s
     * claim-shaped `atLair` mutations) can drive `apply()` directly rather
     * than a commit-then-absorb two-step. Read-only call sites should keep
     * using `.worktree`, not this.
     */
    readonly mirror: Mirror,
  ) {}

  /**
   * Resolves `trunk`'s (default `"main"`) plan mirror, backed by
   * `Trunk.mirror(planBranchName(trunk), originPlanPath)` (design doc
   * §4.1/§4.2's `Mirror` — "always-fresh" read semantics: the underlying
   * adapter fast-forwards the mirror worktree to the trunk's current tip at
   * construction/first-access time, so every fresh call to `resolve()` sees
   * current state with no explicit sync step).
   *
   * Uses the branch name literal `plan/<trunk>` (via `planBranchName`) as
   * the mirror's own branch — deliberately NOT the `Site<T>` convention's
   * bare `"plan"` branch name. `Mirror`'s own worktree-reuse logic finds an
   * existing worktree by BRANCH name, not path, so this transparently
   * reuses whatever mirror worktree already exists for `plan/<trunk>`
   * rather than forking plan content onto a second, disconnected local
   * branch.
   *
   * `resolve()` creates the mirror worktree on demand if it doesn't already
   * exist, because `Mirror` has no "locate only, never create" mode —
   * `DiskMirrorImpl`/`InMemoryMirrorImpl` always create-or-reuse on first
   * real access to `.files`. A caller never has to separately "bootstrap" a
   * mirror before reading/writing through it.
   */
  static async resolve(lair: Lair, repoName: LairRepoName, trunk = 'main'): Promise<LairRepoPerspective> {
    const { bareRepo, trunkHandle } = await resolveTrunkHandle(lair, repoName, trunk);

    const originPlanPath = await readOriginPlanPath(lair);
    const mirror = trunkHandle.mirror(planBranchName(trunk), originPlanPath);

    // `Mirror.files` is typed `MutableDirectoryLike` (`Directory | Worktree`)
    // on the port interface, but every adapter's mirror worktree is always
    // the `Worktree` half in practice — on Disk it's a lazy proxy that
    // structurally behaves like a full `Worktree` (every method delegates to
    // the real worktree once resolved; see `DiskMirror.ts`'s
    // `createLazyWorktree`), and on InMemory it's a real `Worktree`
    // synchronously. Safe to expose as `Worktree` directly.
    //
    // Most read/write call sites only need `MutableDirectoryLike` and use
    // `.mirror.files` directly (`list-roots`/`get-subtree`/`get-leaves`/
    // `get-spaces`/content-owning `atLair` writes). This constructor's
    // `worktree: Worktree` parameter (below) exists because a few real,
    // current consumers need more than `MutableDirectoryLike`: this same
    // file's own `claim-node`/`claim-leaf` `atLair` hooks
    // (`l.perspective.worktree.currentBranch()`),
    // `apps/cabinet/src/experiments/ExperimentsService.ts`'s
    // `trunkPerspective.worktree.children()`, and
    // `apps/cabinet/src/archives/ArchiveService.ts`'s
    // `perspective.worktree.children()`. Dropping this cast would need
    // widening or replacing those callers, which is real, separate,
    // undesigned work (mirroring `MovementSession`'s own already-documented
    // irreducible `Worktree` need).
    const worktree = mirror.files as Worktree;

    return new LairRepoPerspective(repoName, bareRepo, worktree, mirror);
  }
}

/**
 * Resolves `trunk`'s (default `"main"`) conductor-state `Mirror`.
 *
 * Conductor state has no branch or worktree of its own
 * (`conductor/<trunk>` does not exist, local or remote). Conductor doesn't
 * need its own branch: it needs the same thing `Plan` already has, "atomic
 * reads and atomic writes against current trunk state"
 * (`Mirror.apply()`-shaped). So this reuses the EXACT SAME mirror worktree
 * `LairRepoPerspective.resolve()` uses for plan
 * (`Trunk.mirror(planBranchName(trunk), ...)` — same branch name,
 * `plan/<trunk>`, which is what `Mirror`'s worktree-reuse-by-branch-name
 * logic keys on, not the subtree or the scratch root path), just narrowed to
 * `.meta/conductor` instead of `.meta/plan`.
 *
 * This is safe under concurrency for two independent reasons, both required:
 *
 * 1. `Mirror.apply()` has genuine WHOLE-ATTEMPT exclusivity per worktree
 *    (`GitCoordinationState.withMirrorApplySerialization` on Disk, the
 *    equivalent `InMemoryBareRepository.withMirrorApplySerialization` on
 *    InMemory — see those methods' doc comments) — a plan-shaped `apply()`
 *    and a conductor-shaped `apply()` sharing this worktree can never
 *    interleave their sync/transform/commit/publish sequences, only run
 *    strictly one after another. Sharing a worktree under concurrency would
 *    be genuinely unsafe without this: a real concurrent-`apply()` test
 *    proves the exclusivity holds.
 * 2. Each `apply()` call independently declares the subtree IT needs right
 *    before it runs (`Mirror`'s constructor idempotently re-narrows/widens
 *    the worktree's cone-mode sparse checkout via `setSparseCheckout` on
 *    every construction) — cone-mode narrowing only hides out-of-cone paths
 *    from the WORKING DIRECTORY view, it never drops them from the branch's
 *    committed tree/index, so a plan `apply()` narrowing the cone to
 *    `.meta/plan` can never lose or corrupt `.meta/conductor` content
 *    committed moments earlier by a conductor `apply()`, or vice versa.
 *
 * `Mirror.apply()`'s actual publish target is `trunk.branch` (e.g. `main`)
 * either way (design doc §2 invariant A) — conductor state ends up committed
 * directly on the SAME real, origin-pushed trunk plan state does, just under
 * `.meta/conductor/` instead of `.meta/plan/`, with the same atomic CAS/retry
 * discipline. There is no `conductor/<trunk>` branch, local or remote.
 */
export async function resolveConductorMirror(lair: Lair, repoName: LairRepoName, trunk = 'main'): Promise<Mirror> {
  const { trunkHandle } = await resolveTrunkHandle(lair, repoName, trunk);
  return trunkHandle.mirror(planBranchName(trunk), CONDUCTOR_STORE_PATH);
}

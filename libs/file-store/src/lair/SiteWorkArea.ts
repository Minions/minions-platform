/**
 * Adapter-agnostic implementation of `WorkArea`/`Scratchpad` (design doc
 * §4.2): built entirely on the generic
 * `Trunk`/`Movement`/`CheckedOutMovement`/`Worktree`/`BareRepository` port
 * interfaces, with adapter-specific pieces
 * (constructing a `Trunk`, constructing a `CheckedOutMovement`) supplied by
 * the caller as pre-bound closures — see `WorkAreaFactories` below and
 * `adapters/memory/index.ts`'s `createInMemoryWorkAreaFactories` /
 * `adapters/disk/index.ts`'s `createDiskWorkAreaFactories` for the two thin
 * adapter-specific wrappers.
 *
 * `Scratchpad` needs no adapter-specific factory at all — `commit`/`branch`/
 * `checkout`/`backtrack`/`reset` are expressible entirely in terms of the
 * generic `Worktree`/`BareRepository` surface, so `createScratchpad` works
 * identically for both adapters.
 */

import type { BareRepository, Trunk, Movement, CommitRef, CheckedOutMovement, Worktree } from "../port/types.js";
import type { WorkArea, Scratchpad } from "./work-area-types.js";

/** Constructs a `Trunk` for `branch` in `repo` — adapter-specific, pre-bound by the caller. */
export type TrunkFactory = (repo: BareRepository, branch: string) => Trunk;

/**
 * Constructs a `CheckedOutMovement` for `branch` off `base` — adapter-
 * specific, pre-bound by the caller. Both adapters' real factories
 * (`createDiskCheckedOutMovement`/`createInMemoryCheckedOutMovement`) already
 * reuse an existing worktree checked out on `branch` anywhere in the repo
 * before creating a new one — which is exactly what makes this safe to call
 * against a `WorkArea`'s own already-set-up worktree: once
 * `beginNewActiveMovement` has switched that worktree onto `branch`, this
 * factory finds and wraps THAT SAME worktree rather than creating a second,
 * redundant one.
 */
export type CheckedOutMovementFactory = (base: Trunk, branch: string) => Promise<CheckedOutMovement>;

/** The adapter-specific pieces a `WorkArea` needs — see `TrunkFactory`/`CheckedOutMovementFactory`. */
export interface WorkAreaFactories {
  readonly createTrunk: TrunkFactory;
  readonly createCheckedOutMovement: CheckedOutMovementFactory;
}

function refOf(target: Movement | CommitRef): string {
  return typeof target === "string" ? target : target.branch;
}

/**
 * Resolves `worktree`'s current branch's base trunk (design doc §4.2's
 * `Movement.base: Trunk` persistence) — a deliberately lighter-weight read,
 * for callers that need a wing/worktree's current base for display/routing
 * purposes and don't otherwise hold (or want to construct) a full
 * `Movement`/`WorkArea` handle (`apps/cabinet/src/mcp/MCPServer.ts`,
 * `libs/planner/src/PlanActionGroup.ts`,
 * `libs/repo-perspective/src/WingPerspective.ts`).
 *
 * Read order:
 * 1. `repo.getMovementBase(branch)` — the ordinary repo-level,
 *    branch-name-keyed mechanism. Used whenever present.
 * 2. `worktree.baseBranch()` — a compatibility fallback for a wing whose
 *    base was persisted through the `--worktree`-scoped mechanism and hasn't
 *    been through `WorkArea.beginNewActiveMovement()` again since (which
 *    would persist the base under the repo-level key instead — see that
 *    method's own doc comment). `worktree.baseBranch()` already falls
 *    further back to the remote's detected default branch when no override
 *    was ever set there either, so this single fallback call correctly
 *    covers both "the worktree-scoped mechanism has an override" and "no
 *    override anywhere, ever" without this function needing to know the
 *    difference.
 *
 * This is a deliberate, permanent part of the read surface, not a temporary
 * shim — `getMovementBase` returning null is an expected, ordinary outcome
 * (a wing whose base has never been set via the repo-level key), not an
 * error state to warn about or clean up.
 */
export async function resolveMovementBase(repo: BareRepository, worktree: Worktree): Promise<string> {
  const branch = await worktree.currentBranch();
  const override = await repo.getMovementBase(branch);
  if (override !== null) return override;
  return worktree.baseBranch();
}

/**
 * Clears `worktree`'s current branch's persisted base-trunk override — both
 * mechanisms `resolveMovementBase` can read from, not just the repo-level
 * one.
 *
 * This exists because `setMovementBase(branch, null)` alone is a trap: it
 * genuinely clears the repo-level key, but `resolveMovementBase`'s fallback
 * chain then falls through to `worktree.baseBranch()` (the
 * `--worktree`-scoped mechanism) whenever that worktree-scoped key still
 * holds a value — which it does for any wing whose override was ever set
 * through that mechanism (this cabinet's real, already-provisioned wings).
 * The clear silently "succeeds" but a subsequent read resurrects the stale
 * worktree-scoped value instead of falling through to the sane
 * remote-default behavior clearing is supposed to produce.
 *
 * All four production call sites that ever clear a movement's base
 * (`WingManager.setWingTrunk(name, null)`, `ExperimentsService.unassignWing`/
 * `.selectWinner`/`.resolveExperiment`) go through this single helper instead
 * of calling `repo.setMovementBase(branch, null)` directly, so it's
 * structurally impossible for a future clear-path call site to clear only
 * one of the two mechanisms.
 */
export async function clearMovementBase(worktree: Worktree): Promise<void> {
  const branch = await worktree.currentBranch();
  await worktree.repository.setMovementBase(branch, null);
  await worktree.setBaseBranch(null);
}

class SiteWorkArea implements WorkArea {
  constructor(
    readonly repo: BareRepository,
    private readonly worktree: Worktree,
    private readonly factories: WorkAreaFactories,
  ) {}

  async activeMovement(): Promise<CheckedOutMovement> {
    // `currentBranch()` is queried live rather than reading `worktree.branch`
    // directly — on the Disk adapter, `.branch` is a value captured at
    // worktree-construction time and does NOT update after a later
    // `switchBranch()` call (a pre-existing quirk of that adapter, not
    // something this chunk introduces), so only the live query is trustworthy
    // once `beginNewActiveMovement` has switched this worktree's branch.
    const branch = await this.worktree.currentBranch();
    const baseBranch = await resolveMovementBase(this.repo, this.worktree);
    const base = this.factories.createTrunk(this.repo, baseBranch);
    return this.factories.createCheckedOutMovement(base, branch);
  }

  async beginNewActiveMovement(
    branch: string,
    opts?: { from?: Movement | CommitRef; base?: Trunk },
  ): Promise<CheckedOutMovement> {
    const base = this.resolveBase(opts);
    const startPoint = opts?.from !== undefined ? refOf(opts.from) : base.branch;

    // Seed the branch at the right start point BEFORE switching — real git's
    // `switchBranch()` falls back to `checkout -b` (branching off whatever
    // this worktree's CURRENT HEAD is) when the branch doesn't exist yet,
    // which would silently ignore `startPoint` if the branch were left to be
    // created by the switch itself.
    await this.repo.createBranchIfMissing(branch, startPoint);
    // Persist the base BEFORE switching the worktree onto `branch` — avoids
    // an ordering race. `setMovementBase` needs no checkout — it's a plain
    // repo-level config write keyed by branch name — so nothing requires it
    // to happen after `switchBranch`. Writing it first closes the window
    // where a concurrent `resolveMovementBase` call for this branch (from
    // another worktree/session) could observe `getMovementBase() === null`
    // after the branch already exists/is checked out and fall through to the
    // wrong default. Via `BareRepository.setMovementBase` (design doc §4.2's
    // real, ordinary repo-level, branch-name-keyed mechanism), so a later
    // `activeMovement()` call reconstructs the SAME base instead of silently
    // defaulting back to the repo's root trunk. This is the one place that
    // writes a movement's base, and it only ever writes the repo-level key —
    // never the `--worktree`-scoped one: a wing whose base was persisted
    // through the worktree-scoped mechanism is picked up by
    // `resolveMovementBase`'s read-side fallback (see its own doc comment)
    // until the NEXT time this method runs for their branch.
    await this.repo.setMovementBase(branch, base.branch);
    await this.worktree.switchBranch(branch);

    return this.factories.createCheckedOutMovement(base, branch);
  }

  async clearActiveMovementBase(): Promise<void> {
    await clearMovementBase(this.worktree);
  }

  private resolveBase(opts?: { from?: Movement | CommitRef; base?: Trunk }): Trunk {
    if (opts?.base) return opts.base;
    if (opts?.from !== undefined && typeof opts.from !== "string") {
      // `opts.from` is a `Movement` — branching off a movement inherits the
      // SAME base the old movement had, not the old movement's own branch
      // (design doc §4.2).
      return opts.from.base;
    }
    throw new Error(
      "beginNewActiveMovement(): `opts.base` is required when `opts.from` is a bare CommitRef or omitted " +
        "entirely (design doc §4.2) — pass an explicit base Trunk, or pass a Movement for `from` so its own " +
        "base can be inherited.",
    );
  }
}

class SiteScratchpad implements Scratchpad {
  constructor(
    private readonly repo: BareRepository,
    private readonly worktree: Worktree,
  ) {}

  get files(): Worktree {
    return this.worktree;
  }

  async commit(message: string): Promise<string> {
    return this.worktree.commitAll(message);
  }

  async branch(name: string, opts?: { from?: string }): Promise<void> {
    const from = opts?.from ?? (await this.worktree.currentBranch());
    await this.repo.createBranchIfMissing(name, from);
  }

  async checkout(name: string): Promise<void> {
    // Verify `name` already exists BEFORE delegating to `switchBranch` —
    // its own implicit-create-on-missing fallback is adapter-inconsistent
    // (real git branches from the current checkout; the in-memory adapter's
    // `SimulatedGit.ensureBranch()` defaults from `"main"`, see this
    // interface's own doc comment on `checkout`), so silently falling
    // through to it would make `Scratchpad.checkout()` behave differently
    // per adapter for the exact same call. `branch()` is the one place that
    // creates a branch; `checkout()` only ever switches onto one that's
    // already there.
    const existing = await this.repo.resolveLocalRef(name);
    if (existing === null) {
      throw new Error(
        `Scratchpad.checkout(): branch "${name}" doesn't exist. Call branch("${name}") first to create it.`,
      );
    }
    await this.worktree.switchBranch(name);
  }

  async backtrack(ref: string): Promise<void> {
    await this.worktree.resetTo(ref);
  }

  async reset(): Promise<void> {
    const children = await this.worktree.children();
    for (const child of children) {
      await this.worktree.deleteChild(child.name, true);
    }
    if (await this.worktree.isDirty()) {
      await this.worktree.commitAll("scratchpad reset: clear content");
    }
    const branch = await this.worktree.currentBranch();
    const tip = await this.repo.resolveLocalRef(branch);
    if (tip !== null) {
      // A genuinely parentless commit with the same (now-empty) tree — the
      // prior commit(s) become unreachable from the branch tip, satisfying
      // "discard all history/content," not just "discard content."
      const orphan = await this.worktree.commitTree(tip, [], "scratchpad reset");
      await this.worktree.resetTo(orphan);
    }
  }
}

/** Constructs a `WorkArea` wrapping `worktree` — see `WorkAreaFactories`' doc comment. */
export function createWorkArea(repo: BareRepository, worktree: Worktree, factories: WorkAreaFactories): WorkArea {
  return new SiteWorkArea(repo, worktree, factories);
}

/** Constructs a `Scratchpad` wrapping `worktree` — no adapter-specific factory needed. */
export function createScratchpad(repo: BareRepository, worktree: Worktree): Scratchpad {
  return new SiteScratchpad(repo, worktree);
}

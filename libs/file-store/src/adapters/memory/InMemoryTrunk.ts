/**
 * In-Memory Trunk / DerivedTrunk (Movement/Trunk safety redesign, Sandbox layer)
 *
 * See docs/design/movement-trunk-safety-redesign.md §4.1. A `Trunk` is never
 * checked out — it's purely a `(repo, branch)` pair plus constructors for the
 * things that DO get checked out or committed against it (`Movement`,
 * `Mirror`, a derived `Trunk`). Everything here operates through a private,
 * synthetic "tool" worktree/branch (`__tool__/<trunk branch>`) used only to
 * invoke ref-based `Worktree` plumbing (`commitTree`, `log`, `diff`) — the
 * trunk's OWN branch is never the checked-out branch of any worktree this
 * code creates.
 */

import type {
  Trunk,
  DerivedTrunk,
  Movement,
  Mirror,
  AdvanceResult,
  AdvanceAttempt,
  CheckedOutMovement,
  Worktree,
} from "../../port/types.js";
import { randomUUID } from "node:crypto";
import type { InMemoryBareRepository } from "./InMemoryBareRepository.js";
import type { InMemoryWorktree } from "./InMemoryWorktree.js";
import { InMemoryMovementImpl } from "./InMemoryMovement.js";
import { InMemoryMirrorImpl } from "./InMemoryMirror.js";
import { publishWithRetry, PublishRejectedError } from "../disk/PublishRetry.js";

/** A fresh, collision-free scratch branch name for one `beginAdvance()`/recompute round against `trunkBranch`. */
function advanceScratchBranchName(trunkBranch: string): string {
  return `__advance__/${trunkBranch}/${randomUUID()}`;
}

/** Turns an arbitrary branch name into something safe to use as a worktree/directory name. */
export function sanitizeBranchForPath(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export class InMemoryTrunk implements Trunk {
  constructor(
    readonly repo: InMemoryBareRepository,
    readonly branch: string,
    /** Storage path worktrees created for this trunk's movements/mirrors/tools are nested under. */
    protected readonly scratchRootPath: string,
  ) {}

  mirror(branch: string, subtree?: string): Mirror {
    return new InMemoryMirrorImpl(this, branch, this.scratchRootPath, subtree);
  }

  movement(branch: string): Movement {
    return new InMemoryMovementImpl(this, branch);
  }

  derive(branch: string): DerivedTrunk {
    // Seeds the derived trunk's branch at this trunk's current tip, mirroring
    // `git branch <derived> <this.branch>` — a plain branch creation, never a
    // checkout.
    const git = this.repo.getGit();
    git.createBranchIfMissing(branch, this.branch);
    return new InMemoryDerivedTrunk(this.repo, branch, this, this.scratchRootPath);
  }

  async discard(): Promise<void> {
    // A Trunk handle owns no exclusive resource beyond the branch pointer
    // itself (never checked out anywhere) — nothing to release here. Matches
    // "handles are cheap and freely reconstructible" (design doc §4.1).
  }

  /**
   * Local CAS fast-forward — see the port interface's doc comment for the
   * full contract. `SimulatedGit` has no separate "origin" to diverge from
   * (unlike the Disk adapter), so `updateBranchIfUnchanged`'s local
   * compare-and-swap against this trunk's last-known tip IS the publish
   * step here, same as every other InMemory publish primitive
   * (`Movement.merge()`/`Mirror.apply()`). Doesn't independently verify
   * `target` is actually a fast-forward descendant of the current tip (real
   * git's server-side push check is what provides that guarantee on Disk —
   * `SimulatedGit` has no equivalent enforcement); callers (today, only
   * `MovementManager.promote()`'s `foldPromotedTrunk()`, which only calls
   * this after `advance()` has confirmed the derived trunk IS a descendant
   * of its parent) are trusted to only pass a genuine fast-forward target,
   * matching this adapter's existing trust boundary elsewhere (e.g.
   * `advance()`'s own `commitTree` calls are similarly not independently
   * re-verified).
   */
  async fastForwardPublish(target: string): Promise<boolean> {
    const git = this.repo.getGit();
    const currentTip = git.resolveLocalRef(this.branch);
    if (currentTip === target) return true;
    const expected = currentTip ?? "";
    return this.repo.updateBranchIfUnchanged(this.branch, target, expected);
  }

  /**
   * Gets or creates the private synthetic worktree used to invoke ref-based
   * `Worktree` plumbing (`commitTree`, `log`, `diff`) against this repo
   * without ever checking out `this.branch` itself. Idempotent: reuses the
   * same worktree across repeated calls (and across separate `Trunk` handles
   * for the same repo+branch, since handles are cheap/reconstructible and
   * must not each try to create their own).
   * @internal
   */
  async toolWorktree(): Promise<Worktree> {
    const name = `__tool__${sanitizeBranchForPath(this.branch)}`;
    const path = this.scratchRootPath ? `${this.scratchRootPath}/${name}` : name;
    const existing = this.repo.getWorktreeSync(path);
    if (existing) return existing;

    const toolBranch = `__tool__/${this.branch}`;
    const git = this.repo.getGit();
    git.createBranchIfMissing(toolBranch, this.branch);
    return this.repo.createWorktreeSync(this.scratchRootPath, name, toolBranch);
  }

  /**
   * Gets or creates the private synthetic worktree `Movement.merge()`/
   * `rebaseOnto()`/`cherryPick()` use to build landing commits.
   * Unlike `toolWorktree()`, this one's checked-out branch is repeatedly
   * `resetTo()` whatever tip an operation needs as its landing base, then
   * `merge()`d against a source ref — the overlay-onto-a-real-base-tree
   * trick that makes the resulting commit contain the target's *current*
   * content plus the source's changes, not just the source's tree wholesale
   * (which would silently drop anything the target has that the source
   * never touched). Never `this.branch` itself — same "never checked out"
   * guarantee as `toolWorktree()`.
   * @internal
   */
  async scratchWorktree(): Promise<Worktree> {
    const name = `__scratch__${sanitizeBranchForPath(this.branch)}`;
    const path = this.scratchRootPath ? `${this.scratchRootPath}/${name}` : name;
    const existing = this.repo.getWorktreeSync(path);
    if (existing) return existing;

    const scratchBranch = `__scratch__/${this.branch}`;
    const git = this.repo.getGit();
    git.createBranchIfMissing(scratchBranch, this.branch);
    return this.repo.createWorktreeSync(this.scratchRootPath, name, scratchBranch);
  }

}

export class InMemoryDerivedTrunk extends InMemoryTrunk implements DerivedTrunk {
  constructor(
    repo: InMemoryBareRepository,
    branch: string,
    readonly parent: Trunk,
    scratchRootPath: string,
  ) {
    super(repo, branch, scratchRootPath);
  }

  /**
   * Conflict-free fast path only (design doc §4.1/§4.4's `beginAdvance()`/
   * `AdvanceAttempt` attended path is not implemented on this adapter).
   *
   * NOTE on fidelity: `SimulatedGit` supports real multi-parent merge
   * commits (`Movement.merge()` relies on this), but this `advance()` path
   * doesn't do the merge-preserving replay `DerivedTrunk.advance()` is
   * meant to (design doc §4.1's "PRESERVING every merge commit already in
   * it" — a rebase-preserving-merges operation, not built here). This
   * implementation is an honest placeholder: fast-forward if the parent
   * already contains this trunk's tip, otherwise flatten this trunk's
   * current tree onto the parent's tip (the same commit-tree trick
   * `Movement.merge` uses) so `advance()` is at least callable and testable
   * end-to-end. The Disk adapter (`DiskDerivedTrunk.advance()`) implements
   * the real `git replay`/`rebase --rebase-merges` behavior; giving the
   * InMemory adapter equivalent fidelity would need its own reassessment of
   * what "preserve merge commits" means for a simulated git.
   *
   * `resolveIn` is required by the port interface (matching `beginAdvance()`
   * and the Disk adapter's `advance()`) but unused here — this placeholder
   * never needs a real checkout at all, unlike the Disk adapter's replay,
   * since `commitTree` builds the flattened landing commit directly against
   * the bare repo via `toolWorktree()`.
   */
  async advance(_resolveIn: CheckedOutMovement): Promise<AdvanceResult> {
    const git = this.repo.getGit();
    const myTip = git.resolveLocalRef(this.branch);
    if (myTip === undefined) {
      return {
        status: "conflict",
        failedCommit: "",
        message: `Derived trunk '${this.branch}' has no commits`,
      };
    }
    const parentTip = git.resolveLocalRef(this.parent.branch);
    if (parentTip !== undefined && myTip === parentTip) {
      return { status: "ok" };
    }

    const tool = await this.toolWorktree();
    const parents = parentTip !== undefined ? [this.parent.branch] : [];
    const newHash = await tool.commitTree(
      this.branch,
      parents,
      `Advance '${this.branch}' onto '${this.parent.branch}'`,
    );
    await this.repo.updateBranch(this.branch, newHash);
    return { status: "ok" };
  }

  /**
   * The attended path (design doc §4.4) — only meant to be called when
   * `advance()` reports a real content conflict. Creates a throwaway scratch
   * branch pinned to this trunk's snapshotted tip and checks THAT branch out
   * INTO `resolveIn`'s own worktree — never a newly-provisioned worktree, and
   * never `this.branch` itself (never checked out anywhere) — then runs
   * `Worktree.rebase()` onto the parent's snapshotted tip: the same
   * simulated-conflict/resumable-rebase mechanism
   * `CheckedOutMovement.start()`/`resolveConflict()` already use
   * (`SimulatedGit`'s `simulatedRebaseConflict` toggle + `pendingRebaseOnto`
   * — see `InMemoryWorktree.rebase()`/`continueRebase()`), rather than the
   * always-succeeding `commitTree` flatten `advance()`'s own placeholder
   * uses. This `advance()` placeholder still doesn't attempt a real
   * merge-preserving replay (see the note on `advance()` above), so
   * "extending the replay range" has no distinct meaning here beyond "check
   * out a fresh scratch branch at the current tip and rebase again" — no
   * separate upstream/range tracking needed the way the Disk adapter's real
   * `rebase --rebase-merges` requires.
   *
   * `resolveIn` is REQUIRED — see the port interface's doc comment for the
   * full rationale (every real caller already has a worktree of its own to
   * borrow). `resolveIn`'s worktree is restored to whatever branch it had
   * checked out before this call once the returned `AdvanceAttempt` reaches
   * a terminal state (`publish()` succeeding, or `abandon()`).
   *
   * Rejects upfront, before touching `resolveIn`'s worktree at all, if it's
   * dirty — see design doc §4.4 / progress log finding #14; mirrors the
   * identical check in `DiskTrunk.beginAdvance()`.
   */
  async beginAdvance(resolveIn: CheckedOutMovement): Promise<AdvanceAttempt> {
    if (await resolveIn.isDirty()) {
      throw new Error(
        "Cannot begin resolving an advance: the worktree has uncommitted changes — commit or discard them first",
      );
    }
    const git = this.repo.getGit();
    const myTip = git.resolveLocalRef(this.branch);
    if (myTip === undefined) {
      throw new Error(`Cannot begin resolving an advance of '${this.branch}': it has no commits`);
    }
    const parentTip = git.resolveLocalRef(this.parent.branch);
    if (parentTip === undefined) {
      throw new Error(`Cannot begin resolving an advance of '${this.branch}' onto '${this.parent.branch}': parent has no commits`);
    }

    const worktree = resolveIn.files as InMemoryWorktree;
    const originalBranch = await worktree.currentBranch();
    const scratchBranch = advanceScratchBranchName(this.branch);
    git.createBranchIfMissing(scratchBranch, myTip);
    await worktree.switchBranch(scratchBranch);
    const rebaseResult = await worktree.rebase(parentTip);

    return rebaseResult.status === "conflict"
      ? new InMemoryAdvanceAttemptImpl(this, worktree, originalBranch, myTip, parentTip, "conflict", rebaseResult.conflictedFiles)
      : new InMemoryAdvanceAttemptImpl(this, worktree, originalBranch, myTip, parentTip, "ready", []);
  }
}

/**
 * The `AdvanceAttempt` implementation backing
 * `InMemoryDerivedTrunk.beginAdvance()` (design doc §4.4). Owns exactly one
 * BORROWED worktree at a time — `resolveIn`'s own, passed to
 * `beginAdvance()` — never a worktree this class provisions itself. See that
 * method's doc comment for why checking out a fresh scratch branch into the
 * SAME borrowed worktree + `rebase()` again is sufficient for a recompute
 * here, unlike the Disk adapter's more involved upstream/mergeBase tracking.
 * `dispose()` (from `publish()` succeeding, or `abandon()`) always restores
 * the borrowed worktree to whatever branch it had checked out before
 * `beginAdvance()` was called.
 */
class InMemoryAdvanceAttemptImpl implements AdvanceAttempt {
  status: "conflict" | "ready";
  conflictedFiles: string[];
  files: Worktree;

  private disposed = false;

  constructor(
    private readonly derivedTrunk: InMemoryDerivedTrunk,
    /** `resolveIn`'s own worktree (see `beginAdvance()`), borrowed for the lifetime of this attempt — never a worktree this class provisions itself. */
    private readonly worktree: InMemoryWorktree,
    /** The branch `worktree` had checked out before `beginAdvance()` borrowed it — restored by `dispose()`. */
    private readonly originalBranch: string,
    /** The trunk tip this attempt's rebase currently starts from — updated when a `publish()` recompute detects the trunk itself moved. */
    private myTipSnapshot: string,
    /** The parent tip the scratch branch was last (re)rebased onto. */
    private parentTargetTip: string,
    initialStatus: "conflict" | "ready",
    initialConflictedFiles: string[],
  ) {
    this.files = worktree;
    this.status = initialStatus;
    this.conflictedFiles = initialConflictedFiles;
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error("This AdvanceAttempt has already been published or abandoned");
    }
  }

  async continueResolving(): Promise<AdvanceAttempt> {
    this.assertNotDisposed();
    if (this.status !== "conflict") {
      throw new Error("continueResolving() called but this AdvanceAttempt is not in conflict — nothing to resume");
    }
    const result = await this.worktree.continueRebase();
    if (result.status === "conflict") {
      this.status = "conflict";
      this.conflictedFiles = result.conflictedFiles;
    } else {
      this.status = "ready";
      this.conflictedFiles = [];
    }
    return this;
  }

  /**
   * Re-derives this attempt's scratch branch from `newBaseTip`, rebased onto
   * `newParentTip` — always via a FRESH scratch branch checked out into the
   * SAME borrowed worktree (never reuses the previous scratch branch in
   * place), so no leftover `pendingRebaseOnto` state from a previous round
   * can leak into the recomputation.
   */
  private async recompute(newBaseTip: string, newParentTip: string, trunkMoved: boolean): Promise<AdvanceResult> {
    const git = this.derivedTrunk.repo.getGit();
    const scratchBranch = advanceScratchBranchName(this.derivedTrunk.branch);
    git.createBranchIfMissing(scratchBranch, newBaseTip);
    await this.worktree.switchBranch(scratchBranch);
    const rebaseResult = await this.worktree.rebase(newParentTip);
    // Only update `myTipSnapshot` (compared against the trunk's real branch
    // tip to detect a genuine external move) when THIS recompute is handling
    // that case. The "parent moved" recompute's `newBaseTip` is this
    // attempt's own already-resolved WIP tip, unrelated to the trunk's real
    // branch value — mutating `myTipSnapshot` there would make every later
    // `attempt()` call wrongly believe the trunk moved.
    if (trunkMoved) {
      this.myTipSnapshot = newBaseTip;
    }
    this.parentTargetTip = newParentTip;

    if (rebaseResult.status === "conflict") {
      this.status = "conflict";
      this.conflictedFiles = rebaseResult.conflictedFiles;
      return {
        status: "conflict",
        failedCommit: newBaseTip,
        message: rebaseResult.message,
      };
    }
    this.status = "ready";
    this.conflictedFiles = [];
    return { status: "ok" };
  }

  async publish(): Promise<AdvanceResult> {
    this.assertNotDisposed();
    if (this.status !== "ready") {
      return {
        status: "conflict",
        failedCommit: "",
        message: `Cannot publish '${this.derivedTrunk.branch}': this AdvanceAttempt still has an unresolved conflict — call continueResolving() first`,
      };
    }

    const repo = this.derivedTrunk.repo;
    const git = repo.getGit();
    const branch = this.derivedTrunk.branch;
    const parentBranch = this.derivedTrunk.parent.branch;

    type AttemptOutcome = { kind: "ok" } | { kind: "conflict"; result: AdvanceResult };

    try {
      const outcome = await publishWithRetry<AttemptOutcome>({
        attempt: async () => {
          const currentTrunkTip = git.resolveLocalRef(branch);
          const currentParentTip = git.resolveLocalRef(parentBranch);
          if (currentTrunkTip === undefined) {
            return {
              kind: "conflict",
              result: { status: "conflict", failedCommit: "", message: `Derived trunk '${branch}' has no commits` },
            };
          }

          if (currentTrunkTip !== this.myTipSnapshot) {
            // The derived trunk itself moved since the snapshot (design doc
            // §4.4's more dangerous case) — recompute against its actual
            // current tip, which may reopen conflicts, correctly.
            const recomputed = await this.recompute(currentTrunkTip, currentParentTip ?? this.parentTargetTip, true);
            if (recomputed.status === "conflict") return { kind: "conflict", result: recomputed };
          } else if (currentParentTip !== undefined && currentParentTip !== this.parentTargetTip) {
            // The parent moved further — re-rebase the already-resolved tip
            // onto the parent's new tip.
            const resolvedTip = git.resolveLocalRef(this.worktree.branch);
            if (resolvedTip === undefined) {
              throw new Error(`Internal error: AdvanceAttempt's own scratch branch '${this.worktree.branch}' has no commits`);
            }
            const recomputed = await this.recompute(resolvedTip, currentParentTip, false);
            if (recomputed.status === "conflict") return { kind: "conflict", result: recomputed };
          }

          const newTip = git.resolveLocalRef(this.worktree.branch);
          if (newTip === undefined) {
            throw new Error(`Internal error: AdvanceAttempt's own scratch branch '${this.worktree.branch}' has no commits`);
          }
          const pushed = await repo.updateBranchIfUnchanged(branch, newTip, this.myTipSnapshot);
          if (!pushed) throw new PublishRejectedError();
          return { kind: "ok" };
        },
        // `SimulatedGit` has no separate origin to fetch from (same as
        // `InMemoryTrunk.fastForwardPublish`'s doc) — a lost race just means
        // some other concurrent call already moved the branch locally, which
        // the next `attempt()`'s fresh `resolveLocalRef` reads directly with
        // no fetch step needed. `fetchRef` here is a no-op that still
        // advances a nominal generation counter so `publishWithRetry`'s
        // bounded-retry/jittered-backoff shape (design doc §3) applies
        // uniformly across both adapters.
        fetchRef: (sinceGeneration) => Promise.resolve(sinceGeneration + 1),
        currentGeneration: () => 0,
      });

      if (outcome.kind === "conflict") {
        return outcome.result;
      }
      await this.dispose();
      return { status: "ok" };
    } catch (error) {
      if (error instanceof PublishRejectedError) {
        return {
          status: "conflict",
          failedCommit: "",
          message: `Publishing the resolved advance of '${branch}' onto '${parentBranch}' could not be confirmed after repeated retries — too much sustained concurrent activity (${error.message})`,
        };
      }
      throw error;
    }
  }

  async abandon(): Promise<void> {
    if (this.disposed) return;
    await this.dispose();
  }

  /**
   * Restores the borrowed `worktree` to whatever branch it had checked out
   * before `beginAdvance()` was called — the "worktree is restored" half of
   * design doc §4.4's `resolveIn` contract. If a rebase is still in progress
   * (i.e. `abandon()` was called while `status === "conflict"`), clears that
   * state first (mirrors real git's `rebase --abort`) so no stale
   * `pendingRebaseOnto` leaks into whatever this worktree gets checked out
   * on next.
   */
  private async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (await this.worktree.hasInProgressRebase()) {
      await this.worktree.abortRebase();
    }
    await this.worktree.switchBranch(this.originalBranch);
  }
}

/**
 * Constructs an in-memory `Trunk` for `branch` in `repo`. Ensures `branch`
 * exists (creating it off `main` if missing, matching `SimulatedGit`'s
 * default) so subsequent tool-worktree/movement/mirror operations always
 * have a resolvable ref to work against.
 *
 * @param scratchRootPath - Storage path prefix worktrees created for this
 *   trunk's movements/mirrors/tools are nested under (e.g. `""` for the
 *   sandbox root, or a dedicated subdirectory to keep them out of the way of
 *   test assertions that walk the whole tree).
 */
export function createInMemoryTrunk(
  repo: InMemoryBareRepository,
  branch: string,
  scratchRootPath = "",
): Trunk {
  repo.getGit().ensureBranch(branch);
  return new InMemoryTrunk(repo, branch, scratchRootPath);
}

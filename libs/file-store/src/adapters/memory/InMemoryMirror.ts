/**
 * In-Memory Mirror (Movement/Trunk safety redesign, Sandbox layer)
 *
 * See docs/design/movement-trunk-safety-redesign.md §4.1 and §2 invariant B.
 * `apply()` is invariant B made concrete: read the trunk's current tip,
 * run a pure `transform`, commit whatever changed, CAS-publish; on a lost
 * race, re-run the whole transform against the fresh tip.
 */

import type { Trunk, Mirror, MutableDirectoryLike } from "../../port/types.js";
import type { InMemoryBareRepository } from "./InMemoryBareRepository.js";
import type { InMemoryWorktree } from "./InMemoryWorktree.js";
import { sanitizeBranchForPath } from "./InMemoryTrunk.js";

const MAX_APPLY_ATTEMPTS_DEFAULT = 5;

export class InMemoryMirrorImpl<T extends Trunk = Trunk> implements Mirror<T> {
  readonly files: MutableDirectoryLike;
  private readonly worktree: InMemoryWorktree;
  private readonly repo: InMemoryBareRepository;

  constructor(
    readonly trunk: T,
    private readonly mirrorBranch: string,
    scratchRootPath: string,
    /**
     * When given, the worktree is narrowed via cone-mode sparse-checkout
     * simulation (`InMemoryWorktree.setSparseCheckout`) to just this subtree
     * — mirrors the disk adapter's real `git sparse-checkout` narrowing
     * (design doc §7's "Switchyard's conductor subtree" open item, now
     * resolved).
     */
    subtree?: string,
  ) {
    this.repo = trunk.repo as InMemoryBareRepository;

    // Eager, synchronous setup: get-or-create the mirror branch/worktree and
    // fast-forward it to the trunk's current tip right away, so `files` is a
    // plain, synchronously-readable field from the moment this object exists
    // (design doc: "always-fresh local cache view, safe to read any time").
    // Note this only guarantees freshness as of construction time — if the
    // trunk advances afterward and nobody calls `apply()` again, `files`
    // will not silently jump forward on its own (there is no way to express
    // "refresh on every synchronous property read" without also making the
    // read async, which the interface deliberately doesn't require).
    this.repo.getGit().createBranchIfMissing(mirrorBranch, trunk.branch);
    const name = `__mirror__${sanitizeBranchForPath(mirrorBranch)}`;
    const path = scratchRootPath ? `${scratchRootPath}/${name}` : name;
    // Reuse an existing worktree already checked out on `mirrorBranch`
    // ANYWHERE in the repo (not just at this convention's own path) before
    // creating a new one — matches `DiskMirrorImpl.ensureWorktree()`'s
    // by-branch search, and real git's one-worktree-per-branch constraint
    // (`createWorktreeSync` throws otherwise). See `getWorktreeByBranchSync`'s
    // own doc comment for why this matters.
    this.worktree =
      this.repo.getWorktreeSync(path) ??
      this.repo.getWorktreeByBranchSync(mirrorBranch) ??
      this.repo.createWorktreeSync(scratchRootPath, name, mirrorBranch);
    if (subtree !== undefined) {
      // `setSparseCheckout` is `async` only for interface parity with the
      // disk adapter — its body is synchronous (a single Map.set with no
      // `await`), so the cone is already in effect before this constructor
      // returns; the unused Promise is intentionally not awaited here since
      // constructors can't be async.
      void this.worktree.setSparseCheckout(subtree);
    }
    this.files = this.worktree;
    this.syncToTrunkTip();
  }

  /** Fast-forwards the mirror branch (a disposable cache, never a second source of truth) to the trunk's current tip, and resets the worktree's files to match. Safe from anywhere, at any time (design doc §2 invariant A). */
  private syncToTrunkTip(): string | undefined {
    const git = this.repo.getGit();
    const trunkTip = git.resolveLocalRef(this.trunk.branch);
    if (trunkTip === undefined) return undefined;
    if (git.resolveLocalRef(this.mirrorBranch) === trunkTip) return trunkTip;
    git.updateBranch(this.mirrorBranch, trunkTip);
    const tree = git.getTree(this.mirrorBranch);
    this.worktree.loadTreeFrom(tree);
    return trunkTip;
  }

  async apply<R>(
    transform: (view: MutableDirectoryLike) => Promise<R>,
    opts?: { retries?: number; message?: string },
  ): Promise<{ result: R; committed: boolean; commitHash?: string; attempts: number }> {
    // Whole-attempt exclusivity per mirror worktree — see
    // `InMemoryBareRepository.withMirrorApplySerialization`'s doc comment
    // (mirrors the Disk adapter's `GitCoordinationState.withMirrorApplySerialization`).
    // `this.worktree.path` is known synchronously (set up eagerly in the
    // constructor), so the lock can be acquired up front.
    return this.repo.withMirrorApplySerialization(this.worktree.path, () => this.runAttempts(transform, opts));
  }

  private async runAttempts<R>(
    transform: (view: MutableDirectoryLike) => Promise<R>,
    opts?: { retries?: number; message?: string },
  ): Promise<{ result: R; committed: boolean; commitHash?: string; attempts: number }> {
    const maxAttempts = (opts?.retries ?? MAX_APPLY_ATTEMPTS_DEFAULT) + 1;
    const commitMessage = opts?.message ?? `Mirror.apply on '${this.mirrorBranch}'`;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const trunkTipBefore = this.syncToTrunkTip() ?? "";

      const result = await transform(this.files);

      const dirty = await this.worktree.isDirty();
      if (!dirty) {
        return { result, committed: false, attempts: attempt };
      }

      const commitHash = await this.worktree.commitAll(commitMessage);
      const published = await this.trunk.repo.updateBranchIfUnchanged(
        this.trunk.branch,
        commitHash,
        trunkTipBefore,
      );
      if (published) {
        // Fast-forward the mirror branch itself to the commit that just
        // landed, so `files` reflects it without needing another apply().
        this.repo.getGit().updateBranch(this.mirrorBranch, commitHash);
        return { result, committed: true, commitHash, attempts: attempt };
      }
      // Lost the race — someone else advanced the trunk. Loop: `transform`
      // must be pure/re-computable (invariant B) — re-sync to the new tip
      // and run it again from scratch, not resume from partial state.
    }

    throw new Error(
      `Mirror.apply on '${this.mirrorBranch}' failed to publish after ${maxAttempts} attempts (persistent contention)`,
    );
  }
}

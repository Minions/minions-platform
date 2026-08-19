/**
 * Disk Movement / CheckedOutMovement (Movement/Trunk safety redesign, Sandbox layer)
 *
 * See docs/design/movement-trunk-safety-redesign.md §4.1, §4.3, and §2's two
 * invariants. A plain `Movement` (this file's `DiskMovementImpl`) is never
 * checked out and is read-only: `state`/`commitsSince`/`diffFrom`/`tipHash`/
 * `changedFiles`/`readFileAtRef` all run real git's `log`/`diff`/`merge-base`/
 * `rev-parse`/`show` directly against the bare repository
 * (`DiskBareRepository.getGit()`), no worktree needed. `merge`/`rebaseOnto`/
 * `cherryPick` — the operations that actually need a real checkout to build a
 * landing commit — live only on `CheckedOutMovement` (`DiskCheckedOutMovementImpl`
 * below), which reuses ITS OWN already-checked-out worktree (via a
 * detached-HEAD checkout — see `DiskCheckedOutMovementImpl.merge()`'s own doc
 * comment) rather than provisioning a disposable scratch worktree/branch.
 *
 * `merge()` publishes `Worktree.merge()`'s own two-parent commit unaltered —
 * first parent `baseTip`, second parent the movement branch's tip — never
 * rebuilt with `commitTree` to a single parent. `main`'s history must read as
 * a chain of merge commits, each with its landing movement's own linear
 * history intact and reachable as a side branch (design doc §4.1); rebuilding
 * the commit would squash that history away.
 *
 * `state()` uses `mergeBaseIsAncestor` (`git merge-base --is-ancestor`)
 * rather than a full history walk, and the actual publish step is
 * `pushRefCas` — a direct push to origin — never a local-only
 * `updateBranchIfUnchanged`: publishing (design doc §2 invariant A) means the
 * push to origin's ref is what makes-or-breaks the race, so the local
 * `main`/trunk cache is only fast-forwarded to match AFTER that push
 * confirms, never before.
 */

import type {
  Movement,
  CheckedOutMovement,
  Trunk,
  MovementState,
  MergeSpec,
  MergeResult,
  RebaseResult,
  CherryPickResult,
  CommitInfo,
  CommitRef,
  CommitSpec,
  CommitResult,
  StartResult,
  MutableDirectoryLike,
  Worktree,
  Directory,
} from "../../port/types.js";
import type { DiskTrunk } from "./DiskTrunk.js";
import { sanitizeBranchForPath } from "./DiskTrunk.js";
import type { DiskBareRepository } from "./DiskBareRepository.js";
import type { DiskWorktree } from "./DiskWorktree.js";
import { publishWithRetry, PublishRejectedError } from "./PublishRetry.js";

function refOf(target: Movement | CommitRef): string {
  return typeof target === "string" ? target : target.branch;
}

export class DiskMovementImpl implements Movement {
  constructor(
    readonly base: Trunk,
    readonly branch: string,
  ) {}

  protected repo(): DiskBareRepository {
    return this.base.repo as DiskBareRepository;
  }

  async state(): Promise<MovementState> {
    const repo = this.repo();
    const tip = await repo.resolveLocalRef(this.branch);
    if (tip === null) return "undefined";

    const baseTip = await repo.resolveLocalRef(this.base.branch);
    if (tip === baseTip) return "integrated";
    if (!baseTip) return "in-progress";

    // Real ancestry check — covers the "diverged, then cleanly merged" case
    // the same way the InMemory adapter's history walk did: `merge()` below
    // also fast-forwards the local movement branch to the commit it just
    // landed on base, so a merged movement's tip becomes either identical to
    // base's tip (handled above) or an ancestor of a base tip that has since
    // moved further.
    const isIntegrated = await repo.getGit().mergeBaseIsAncestor(tip, baseTip);
    return isIntegrated ? "integrated" : "in-progress";
  }

  async commitsSince(ref?: Movement | CommitRef): Promise<CommitInfo[]> {
    const fromRef = ref === undefined ? this.base.branch : refOf(ref);
    return this.repo().getGit().log(fromRef, this.branch);
  }

  async diffFrom(ref?: Movement | CommitRef): Promise<string> {
    const fromRef = ref === undefined ? this.base.branch : refOf(ref);
    return this.repo().getGit().diff(fromRef, this.branch);
  }

  async tipHash(): Promise<string | null> {
    // Plumbing-only (`git rev-parse <branch>`, via `resolveLocalRef`) — runs
    // directly against the bare repo, no worktree needed. `null` when the
    // branch doesn't exist locally yet, mirroring `resolveLocalRef`'s own
    // convention (design doc §4.1's `Movement.tipHash`).
    return this.repo().resolveLocalRef(this.branch);
  }

  async changedFiles(from?: Movement | CommitRef, to?: Movement | CommitRef): Promise<string[]> {
    const fromRef = from === undefined ? this.base.branch : refOf(from);
    const toRef = to === undefined ? this.branch : refOf(to);
    return this.repo().getGit().changedFiles(fromRef, toRef);
  }

  async readFileAtRef(ref: CommitRef, path: string): Promise<string | null> {
    // Plumbing-only (`git show <ref>:<path>`, via `GitOperations.readFileAtRef`)
    // — runs directly against the bare repo, no worktree needed, and no
    // dependency on `this.branch`/`base` at all (design doc §4.1's
    // `Movement.readFileAtRef`).
    return this.repo().getGit().readFileAtRef(ref, path);
  }

  async discard(): Promise<void> {
    const repo = this.repo();
    const worktrees = await repo.worktrees();
    for (const wt of worktrees) {
      if (wt.branch === this.branch) {
        await repo.removeWorktree(wt);
      }
    }
    // Branch deletion itself isn't exposed on the public `BareRepository`
    // surface today — best-effort, matching the InMemory adapter: remove any
    // checkout, leave the branch pointer in place.
  }
}

class DiskCheckedOutMovementImpl extends DiskMovementImpl implements CheckedOutMovement {
  constructor(
    base: Trunk,
    branch: string,
    readonly files: MutableDirectoryLike,
    private readonly worktree: Worktree,
  ) {
    super(base, branch);
  }

  async isDirty(): Promise<boolean> {
    return this.worktree.isDirty();
  }

  async commit(spec: CommitSpec): Promise<CommitResult> {
    const hash = await this.worktree.commitAll(spec.message, { noVerify: spec.noVerify });
    return { hash };
  }

  /**
   * A `CheckedOutMovement` already has a real worktree checked out on
   * `this.branch` (`this.worktree`), so there's no need to provision a
   * disposable scratch worktree (a brand-new `git worktree add` PLUS a
   * brand-new branch, per call, per retry) just to get somewhere to build
   * the landing commit — `merge`/`rebaseOnto`/`cherryPick` live only here,
   * not on the bare `Movement` interface (see this file's header doc).
   * This reuses `this.worktree` instead, via a **detached HEAD** checkout —
   * `git checkout --detach <baseTip>` — never `this.branch`'s own ref, so
   * the movement branch's history is untouched while the trial merge is
   * built, and never a new named branch either: nothing is left behind to
   * clean up (or, per `Trunk`/`Movement.discard()`'s existing caveat, to
   * accumulate forever — there's no branch-deletion primitive in this
   * adapter).
   *
   * Correctness is unaffected by building the commit here instead of a
   * scratch worktree: the actual compare-and-swap is `pushRefCas`'s plain
   * (non-force) `git push`, which git enforces as fast-forward-only against
   * origin's LIVE ref value at push time — not against any local cache, this
   * worktree's or otherwise. A losing race still throws
   * `PublishRejectedError`, still drives a full fresh `attempt()` (a new
   * `fetchRef`, a new `checkoutDetached` at the newly-fetched tip, a new
   * merge) exactly as before.
   *
   * The worktree is guaranteed clean on entry — `MovementManager
   * .mergeMovement()` already refuses to proceed on a dirty tree before ever
   * calling this — and a `finally` always lands it back on `this.branch`
   * (never left detached), on every exit path:
   * - already-up-to-date / real conflict: `Worktree.merge()` already runs
   *   `git merge --abort` on conflict (see `GitOperations.merge()`), so the
   *   worktree is already clean by the time the `finally` switches back —
   *   same "no conflict markers left for an agent to find here" contract the
   *   scratch-worktree version had (real conflicts only ever surface via
   *   `MovementManager.mergeMovement()`'s prior rebase step, in files, where
   *   they're actually resumable).
   * - lost publish race: nothing on disk needs cleanup either — the trial
   *   commit is simply abandoned (unreachable once HEAD moves off it,
   *   swept up by ordinary git GC) — the `finally` just restores the
   *   branch checkout before `publishWithRetry` tries again.
   */
  async merge(spec: MergeSpec = {}): Promise<MergeResult> {
    const repo = this.repo();
    const bareGit = repo.getGit();
    const movementTip = await repo.resolveLocalRef(this.branch);
    if (movementTip === null) {
      throw new Error(`Cannot merge movement '${this.branch}': branch does not exist`);
    }

    const message = spec.message ?? `Merge movement '${this.branch}'`;
    const trunk = this.base as DiskTrunk;
    const worktree = this.worktree as DiskWorktree;
    const coordination = repo.getCoordination();

    return publishWithRetry<MergeResult>({
      attempt: async () => {
        await trunk.ensureBranchExists();
        const baseTip = (await repo.resolveLocalRef(this.base.branch)) ?? "";
        if (movementTip === baseTip) {
          return { status: "already-up-to-date" };
        }

        await worktree.getGit().checkoutDetached(baseTip);
        try {
          const mergeOutcome = await worktree.merge(this.branch, { message });
          if (mergeOutcome.status === "conflict") return mergeOutcome;
          if (mergeOutcome.status === "already-up-to-date") {
            return { status: "already-up-to-date" };
          }

          const pushed = await bareGit.pushRefCas(this.base.branch, mergeOutcome.commit);
          if (!pushed) throw new PublishRejectedError();

          await repo.updateBranch(this.base.branch, mergeOutcome.commit);
          await bareGit.branchForceReset(this.branch, mergeOutcome.commit);

          return { status: "success", commit: mergeOutcome.commit };
        } finally {
          await worktree.switchBranch(this.branch);
        }
      },
      fetchRef: (sinceGeneration) =>
        coordination.fetchRefSinceGeneration(repo.path, this.base.branch, sinceGeneration, async () => {
          await bareGit.fetchRef(this.base.branch);
          await repo.updateBranch(this.base.branch, `origin/${this.base.branch}`);
        }),
      currentGeneration: () => coordination.refGeneration(repo.path, this.base.branch),
    });
  }

  /**
   * Same worktree-reuse shape as `merge()` above (see that method's own doc
   * comment for the full rationale) — builds the trial rebase commit via a
   * detached-HEAD checkout of `this.worktree`. No caller exists in
   * production today (only `DocSessionMovement`, which explicitly rejects
   * this call), so this is a one-shot operation with no retry loop to
   * preserve — a losing race isn't a concern here the way it is for
   * `merge()`'s CAS-published result, since nothing is published to a
   * shared ref; `this.branch` is purely local.
   */
  async rebaseOnto(target: Movement | CommitRef): Promise<RebaseResult> {
    const repo = this.repo();
    const targetRef = refOf(target);
    const movementTip = await repo.resolveLocalRef(this.branch);
    if (movementTip === null) {
      throw new Error(`Cannot rebase movement '${this.branch}': branch does not exist`);
    }
    const targetTip = (await repo.resolveLocalRef(targetRef)) ?? targetRef;
    if (movementTip === targetTip) {
      return { status: "success" };
    }

    const worktree = this.worktree as DiskWorktree;
    await worktree.getGit().checkoutDetached(targetTip);
    try {
      const outcome = await worktree.merge(this.branch, {
        message: `Rebase '${this.branch}' onto '${targetRef}'`,
      });
      if (outcome.status === "conflict") {
        return {
          status: "conflict",
          message: `Rebase of '${this.branch}' onto '${targetRef}' conflicted`,
          originalHead: movementTip,
          conflictedFiles: outcome.conflictedFiles,
        };
      }
      const newHash = outcome.status === "success" ? outcome.commit : targetTip;
      await repo.getGit().branchForceReset(this.branch, newHash);
      return { status: "success" };
    } finally {
      await worktree.switchBranch(this.branch);
    }
  }

  /**
   * Same worktree-reuse shape as `merge()`/`rebaseOnto()` above — each
   * commit in `commits` is built via a detached-HEAD checkout of
   * `this.worktree`. `this.branch` is force-reset (never checked out
   * mid-loop, since the worktree stays detached across the whole loop) after
   * each successful pick, so a later pick in the same call builds on the
   * previous one's result exactly as before.
   */
  async cherryPick(commits: CommitRef[]): Promise<CherryPickResult> {
    const repo = this.repo();
    let tip = await repo.resolveLocalRef(this.branch);
    if (tip === null) {
      throw new Error(`Cannot cherry-pick onto movement '${this.branch}': branch does not exist`);
    }
    const worktree = this.worktree as DiskWorktree;
    await worktree.getGit().checkoutDetached(tip);
    try {
      for (const commitRef of commits) {
        const outcome = await worktree.merge(commitRef, { message: `Cherry-pick ${commitRef}` });
        if (outcome.status === "conflict") {
          return {
            status: "conflict",
            message: `Cherry-pick of '${commitRef}' onto '${this.branch}' conflicted`,
            conflictedFiles: outcome.conflictedFiles,
          };
        }
        if (outcome.status === "success") {
          tip = outcome.commit;
          await repo.getGit().branchForceReset(this.branch, tip);
        }
        // "already-up-to-date" — commitRef introduces nothing new; tip unchanged.
      }
      return { status: "success" };
    } finally {
      await worktree.switchBranch(this.branch);
    }
  }

  async start(): Promise<StartResult> {
    // Sugar: fetch base (scoped to just this one ref, not a full multi-branch
    // fetch — design doc §3.3), rebase onto base's latest, autostash.
    const repo = this.base.repo as DiskBareRepository;
    await repo.getGit().fetchRef(this.base.branch);
    // A scoped fetch only updates `refs/remotes/origin/<branch>` — realign
    // the local cache too (fast-forward-only, always safe per design doc §2
    // invariant A), since `Trunk`s are never checked out anywhere so this
    // can never conflict with a real worktree the way a movement branch's
    // own fast-forward can.
    await repo.updateBranch(this.base.branch, `origin/${this.base.branch}`);
    return this.worktree.rebase(this.base.branch, { autostash: true });
  }

  async resolveConflict(): Promise<StartResult> {
    return this.worktree.continueRebase();
  }

  async push(): Promise<void> {
    // Movement branches are single-writer per-wing (see the interface doc on
    // `CheckedOutMovement.push`) — a plain force-push of this movement's own
    // branch, not a CAS-guarded publish like `Trunk`/`Mirror`.
    //
    // `forcePushBranch` (not the plain `Worktree.forcePush()`) deliberately:
    // a movement's very first commit has never been pushed before, so there
    // is no upstream tracking ref yet — `Worktree.forcePush()` is a bare
    // `git push --force`, which fails outright with "no upstream branch" in
    // that case. `forcePushBranch` sets `-u` every time, so both the
    // brand-new-branch first push and every push after it succeed the same
    // way.
    await this.worktree.forcePushBranch(this.branch);
  }
}

/**
 * Constructs a disk-based `CheckedOutMovement`: ensures `branch` exists
 * (created off `base.branch` if missing) and gets-or-creates a real worktree
 * checked out on it.
 */
export async function createDiskCheckedOutMovement(
  base: Trunk,
  branch: string,
  scratchRoot: Directory,
): Promise<CheckedOutMovement> {
  const repo = base.repo as DiskBareRepository;
  await (base as DiskTrunk).ensureBranchExists();
  await repo.createBranchIfMissing(branch, base.branch);

  const existing = (await repo.worktrees()).find((wt) => wt.branch === branch);
  const worktree = existing ?? (await repo.createWorktree(scratchRoot, `__movement__${sanitizeBranchForPath(branch)}`, branch));

  return new DiskCheckedOutMovementImpl(base, branch, worktree, worktree);
}

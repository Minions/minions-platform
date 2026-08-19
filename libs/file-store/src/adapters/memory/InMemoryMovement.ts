/**
 * In-Memory Movement / CheckedOutMovement (Movement/Trunk safety redesign, Sandbox layer)
 *
 * See docs/design/movement-trunk-safety-redesign.md §4.1 and §4.3. A plain
 * `Movement` (`InMemoryMovementImpl`) is never checked out and is read-only:
 * `state`/`commitsSince`/`diffFrom`/`tipHash`/`changedFiles`/`readFileAtRef`
 * all go through the owning `Trunk`'s private tool worktree (see
 * `InMemoryTrunk.toolWorktree`) using explicit refs, never `this.branch`'s
 * own checkout. `merge`/`rebaseOnto`/`cherryPick` — the operations that
 * actually build a landing commit — live only on `CheckedOutMovement`
 * (`InMemoryCheckedOutMovementImpl` below), which adds a real worktree
 * checked out on `this.branch` for attended work; they build their trial
 * commit via `InMemoryTrunk.scratchWorktree()` (a persistent, gets-or-created
 * private worktree per trunk — unlike the Disk adapter's per-call disposable
 * one, so there's no scratch-branch accumulation to worry about here).
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
} from "../../port/types.js";
import type { InMemoryTrunk } from "./InMemoryTrunk.js";
import { sanitizeBranchForPath } from "./InMemoryTrunk.js";
import type { InMemoryBareRepository } from "./InMemoryBareRepository.js";

function refOf(target: Movement | CommitRef): string {
  return typeof target === "string" ? target : target.branch;
}

/** Bounded retry count for the CAS-publish loops below — see design doc §2 invariant A/B. */
const MAX_PUBLISH_ATTEMPTS = 20;

export class InMemoryMovementImpl implements Movement {
  constructor(
    readonly base: Trunk,
    readonly branch: string,
  ) {}

  private tool(): Promise<Worktree> {
    return (this.base as InMemoryTrunk).toolWorktree();
  }

  async state(): Promise<MovementState> {
    const repo = this.base.repo;
    const tip = await repo.resolveLocalRef(this.branch);
    if (tip === null) return "undefined";

    const baseTip = await repo.resolveLocalRef(this.base.branch);
    if (tip === baseTip) return "integrated";
    if (!baseTip) return "in-progress";

    // Real multi-parent ancestry check (mirrors the Disk adapter's
    // `mergeBaseIsAncestor`) — covers the "diverged, then cleanly merged"
    // case: `merge()` below also fast-forwards the local movement branch to
    // the commit it just landed on base, so a merged movement's tip becomes
    // either identical to base's tip (handled above) or an ancestor of a
    // base tip that has since moved further. A plain first-parent `log()`
    // walk would miss this: the landing commit is a merge commit's SECOND
    // parent, never visited by a first-parent-only walk.
    const isIntegrated = (this.base.repo as InMemoryBareRepository).getGit().isAncestor(tip, baseTip);
    return isIntegrated ? "integrated" : "in-progress";
  }

  async commitsSince(ref?: Movement | CommitRef): Promise<CommitInfo[]> {
    const fromRef = ref === undefined ? this.base.branch : refOf(ref);
    const tool = await this.tool();
    return tool.log(fromRef, this.branch);
  }

  async diffFrom(ref?: Movement | CommitRef): Promise<string> {
    const fromRef = ref === undefined ? this.base.branch : refOf(ref);
    const tool = await this.tool();
    return tool.diff(fromRef, this.branch);
  }

  async tipHash(): Promise<string | null> {
    // Read-only, base-independent (design doc §4.1's `Movement.tipHash`) —
    // `null` when the branch doesn't exist locally, mirroring
    // `resolveLocalRef`'s own convention.
    return this.base.repo.resolveLocalRef(this.branch);
  }

  async changedFiles(from?: Movement | CommitRef, to?: Movement | CommitRef): Promise<string[]> {
    const fromRef = from === undefined ? this.base.branch : refOf(from);
    const toRef = to === undefined ? this.branch : refOf(to);
    const tool = await this.tool();
    return tool.changedFiles(fromRef, toRef);
  }

  async readFileAtRef(ref: CommitRef, path: string): Promise<string | null> {
    // Read-only, base-independent (design doc §4.1's `Movement.readFileAtRef`)
    // — routed through the trunk's own private tool worktree the same way
    // `commitsSince`/`diffFrom` are, never `this.branch`'s own checkout.
    const tool = await this.tool();
    return tool.readFileAtRef(ref, path);
  }

  async discard(): Promise<void> {
    const repo = this.base.repo;
    const worktrees = await repo.worktrees();
    for (const wt of worktrees) {
      if (wt.branch === this.branch) {
        await repo.removeWorktree(wt);
      }
    }
    // Branch deletion itself isn't exposed on the public `BareRepository`
    // surface today (no `deleteBranch`) — best-effort: remove any checkout,
    // leave the branch pointer in place. Nothing in this design depends on
    // the branch actually disappearing, only on no worktree remaining
    // checked out on it.
  }
}

class InMemoryCheckedOutMovementImpl extends InMemoryMovementImpl implements CheckedOutMovement {
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

  async merge(spec: MergeSpec = {}): Promise<MergeResult> {
    const repo = this.base.repo;
    const movementTip = await repo.resolveLocalRef(this.branch);
    if (movementTip === null) {
      throw new Error(`Cannot merge movement '${this.branch}': branch does not exist`);
    }

    const scratch = await (this.base as InMemoryTrunk).scratchWorktree();
    const message = spec.message ?? `Merge movement '${this.branch}'`;

    for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt++) {
      const baseTip = (await repo.resolveLocalRef(this.base.branch)) ?? "";
      if (movementTip === baseTip) {
        return { status: "already-up-to-date" };
      }

      // Reset the scratch worktree to base's CURRENT tree, then merge the
      // movement branch onto it — `SimulatedGit.merge()` mirrors real git's
      // `merge --no-ff` and always builds a genuine two-parent commit (first
      // parent base's tip, second the movement's own tip). That commit is
      // published unaltered below — never rebuilt with a single parent — so
      // main's history reads as a chain of merge commits with each landing
      // movement's incremental history intact as a reachable side branch
      // (design doc §4.1).
      await scratch.resetTo(baseTip);
      const outcome = await scratch.merge(this.branch, { message });
      if (outcome.status === "conflict") {
        return outcome;
      }
      if (outcome.status === "already-up-to-date") {
        return { status: "already-up-to-date" };
      }

      const published = await repo.updateBranchIfUnchanged(this.base.branch, outcome.commit, baseTip);
      if (published) {
        // Fast-forward the local movement branch to the commit that just
        // landed — see `state()`'s doc: this is what makes "diverged, then
        // cleanly merged" collapse into the same "integrated" state as
        // "never diverged" in the graph, with no separate bookkeeping.
        //
        // NOTE: if a SEPARATE `CheckedOutMovement` for this same branch has
        // an open worktree, its files won't reflect this move until it
        // re-syncs (e.g. via `start()`) — this in-memory adapter doesn't
        // attempt to push the new tree into another already-checked-out
        // worktree's files.
        await repo.updateBranch(this.branch, outcome.commit);
        return outcome;
      }
      // Lost the race — someone else advanced base. Loop: re-read the new
      // tip and recompute against it (invariant B).
    }
    throw new Error(
      `Movement '${this.branch}' failed to merge after ${MAX_PUBLISH_ATTEMPTS} attempts (persistent contention)`,
    );
  }

  async rebaseOnto(target: Movement | CommitRef): Promise<RebaseResult> {
    const repo = this.base.repo;
    const targetRef = refOf(target);
    const movementTip = await repo.resolveLocalRef(this.branch);
    if (movementTip === null) {
      throw new Error(`Cannot rebase movement '${this.branch}': branch does not exist`);
    }
    const targetTip = (await repo.resolveLocalRef(targetRef)) ?? targetRef;
    if (movementTip === targetTip) {
      return { status: "success" };
    }

    const scratch = await (this.base as InMemoryTrunk).scratchWorktree();
    await scratch.resetTo(targetTip);
    const outcome = await scratch.merge(this.branch, {
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
    await repo.updateBranch(this.branch, newHash);
    return { status: "success" };
  }

  async cherryPick(commits: CommitRef[]): Promise<CherryPickResult> {
    const repo = this.base.repo;
    let tip = await repo.resolveLocalRef(this.branch);
    if (tip === null) {
      throw new Error(`Cannot cherry-pick onto movement '${this.branch}': branch does not exist`);
    }
    const scratch = await (this.base as InMemoryTrunk).scratchWorktree();
    for (const commitRef of commits) {
      await scratch.resetTo(tip);
      const outcome = await scratch.merge(commitRef, { message: `Cherry-pick ${commitRef}` });
      if (outcome.status === "conflict") {
        return {
          status: "conflict",
          message: `Cherry-pick of '${commitRef}' onto '${this.branch}' conflicted`,
          conflictedFiles: outcome.conflictedFiles,
        };
      }
      if (outcome.status === "success") {
        tip = outcome.commit;
        await repo.updateBranch(this.branch, tip);
      }
      // "already-up-to-date" — commitRef introduces nothing new; tip unchanged.
    }
    return { status: "success" };
  }

  async start(): Promise<StartResult> {
    // Sugar: fetch base (best-effort — no-op unless a simulated remote is
    // registered for this repo's URL), rebase onto base's latest, autostash.
    await this.base.repo.fetch();
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
    // `forcePushBranch` (not the plain `Worktree.forcePush()`) deliberately,
    // matching the Disk adapter: a movement's very first commit has no
    // upstream tracking ref yet, and `forcePushBranch` sets `-u` every time,
    // so both the brand-new-branch first push and every push after it
    // succeed the same way. In-memory: still a no-op/simulated push,
    // matching the rest of this adapter's simulated-remote semantics.
    await this.worktree.forcePushBranch(this.branch);
  }
}

/**
 * Constructs an in-memory `CheckedOutMovement`: ensures `branch` exists
 * (created off `base.branch` if missing) and gets-or-creates a real worktree
 * checked out on it.
 */
export async function createInMemoryCheckedOutMovement(
  base: Trunk,
  branch: string,
  scratchRootPath = "",
): Promise<CheckedOutMovement> {
  const repo = base.repo as InMemoryBareRepository;
  repo.getGit().createBranchIfMissing(branch, base.branch);

  // Reuse ANY existing worktree already checked out on `branch`, anywhere in
  // the repo — not just one at this factory's own `__movement__<branch>`
  // scratch path. Without this, a `WorkArea`'s own already-set-up worktree
  // (e.g. a wing's work/local, checked out on `branch` at some unrelated
  // path) would be invisible to this lookup, and the fallback below would
  // then try to create a SECOND worktree on the same branch — which the
  // simulated registry (mirroring real git's "already used by worktree"
  // refusal) rejects outright. Matches the Disk adapter's
  // `createDiskCheckedOutMovement`, which already searches `repo.worktrees()`
  // by branch for the identical reason.
  const existing = (await repo.worktrees()).find((wt) => wt.branch === branch);
  const name = `__movement__${sanitizeBranchForPath(branch)}`;
  const path = scratchRootPath ? `${scratchRootPath}/${name}` : name;
  const worktree: Worktree =
    existing ?? repo.getWorktreeSync(path) ?? repo.createWorktreeSync(scratchRootPath, name, branch);

  return new InMemoryCheckedOutMovementImpl(base, branch, worktree, worktree);
}

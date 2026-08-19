/**
 * Disk Trunk / DerivedTrunk (Movement/Trunk safety redesign, Sandbox layer)
 *
 * See docs/design/movement-trunk-safety-redesign.md §4.1. A `Trunk` is never
 * checked out — it's purely a `(repo, branch)` pair plus constructors for the
 * things that DO get checked out or committed against it (`Movement`,
 * `Mirror`, a derived `Trunk`).
 *
 * Unlike the InMemory adapter (`InMemoryTrunk.ts`), this one needs no
 * "tool worktree" for read-only ref-based plumbing (`commitTree`, `log`,
 * `diff`, `merge-base --is-ancestor`) — real git can run all of those
 * directly against a bare repository with no checkout at all, via
 * `DiskBareRepository.getGit()`. The one operation that genuinely requires a
 * checkout — building a landing merge commit via `git merge --no-ff` — is
 * always built via the caller's OWN already-checked-out worktree
 * (`CheckedOutMovement`/`resolveIn`, a detached-HEAD checkout — see
 * `DiskMovement.ts`/`replayOnto()` below), never a worktree this trunk
 * provisions itself: every real caller already has one.
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
  Directory,
  BareRepository,
} from "../../port/types.js";
import { randomUUID } from "node:crypto";
import type { DiskBareRepository } from "./DiskBareRepository.js";
import type { DiskWorktree } from "./DiskWorktree.js";
import { DiskMovementImpl } from "./DiskMovement.js";
import { DiskMirrorImpl } from "./DiskMirror.js";
import { publishWithRetry, PublishRejectedError } from "./PublishRetry.js";
import type { GitOperations } from "./GitOperations.js";

/** Turns an arbitrary branch name into something safe to use as a worktree/directory name. */
export function sanitizeBranchForPath(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

export class DiskTrunk implements Trunk {
  constructor(
    readonly repo: BareRepository,
    readonly branch: string,
    /** Real filesystem directory worktrees created for this trunk's movements/mirrors/scratch work are nested under. */
    protected readonly scratchRoot: Directory,
  ) {}

  mirror(branch: string, subtree?: string): Mirror {
    return new DiskMirrorImpl(this, branch, this.scratchRoot, subtree);
  }

  movement(branch: string): Movement {
    return new DiskMovementImpl(this, branch);
  }

  derive(branch: string): DerivedTrunk {
    // Deliberately does NOT create `branch` here, unlike the InMemory
    // adapter's `derive()` (which can, since `SimulatedGit` is synchronous).
    // Real git branch creation is a subprocess call — inherently async — and
    // `Trunk.derive()` is a synchronous method on the port interface. The
    // derived branch is instead lazily seeded (at this trunk's tip, matching
    // what `derive()` would have done eagerly) the first time anything
    // actually needs to resolve it — see `ensureBranchExists()`.
    return new DiskDerivedTrunk(this.repo as DiskBareRepository, branch, this, this.scratchRoot);
  }

  async discard(): Promise<void> {
    const repo = this.repo as DiskBareRepository;
    const worktrees = await repo.worktrees();
    for (const wt of worktrees) {
      if (wt.branch === this.branch) {
        await repo.removeWorktree(wt);
      }
    }
    // Branch deletion itself has no public primitive on `BareRepository`
    // today — best-effort, same as the InMemory adapter: remove any
    // checkout, leave the branch pointer in place.
  }

  /**
   * Real push-based CAS fast-forward to origin (design doc §2 invariant A) —
   * see the port interface's doc comment for the full contract. Confirms
   * `target` is actually a descendant of this trunk's current LOCAL tip
   * before even attempting the push, purely as a cheap short-circuit (the
   * real safety comes from `pushRefCas`'s server-side fast-forward check
   * either way, not from this local pre-check).
   *
   * **On rejection, fetches and realigns this branch's local cache before
   * returning `false`** — the same gap `DerivedTrunk.advance()` guards
   * against, checked for here too for the same reason. `target` itself is
   * NOT retried here with a fresh value — a bare retry of the identical push
   * would fail identically, since `pushRefCas` is a deterministic
   * server-side check against origin's actual current state, not something
   * a local retry alone can route around. What DOES matter: `fastForwardPublish`
   * is `MovementManager.promote()`'s `foldPromotedTrunk()` FOLD step
   * (`libs/movement-branching`), called with a `target` that came from a
   * just-succeeded `derivedTrunk.advance()` built against this trunk's (the
   * PARENT's) local `parentTip` snapshot. If that snapshot was stale, the
   * fold's rejection here is real evidence the parent moved further than
   * `advance()` knew about — and without fetching this branch now, the NEXT
   * `advance()` call (which reads `parent.branch`'s local cache — literally
   * this same branch/repo) would keep recomputing against the SAME stale
   * parent tip forever, since `advance()`'s own successful path (this
   * trunk's push succeeding) never had a reason to fetch the parent.
   * Fetching here is what lets a caller's retry loop (`foldPromotedTrunk()`)
   * actually converge on a real cross-actor "parent moved" race, not just a
   * same-process mocked one.
   */
  async fastForwardPublish(target: string): Promise<boolean> {
    const repo = this.repo as DiskBareRepository;
    const bareGit = repo.getGit();
    const currentTip = await repo.resolveLocalRef(this.branch);
    if (currentTip !== null && currentTip !== target) {
      const isDescendant = await bareGit.mergeBaseIsAncestor(currentTip, target);
      if (!isDescendant) return false;
    }
    const pushed = await bareGit.pushRefCas(this.branch, target);
    if (pushed) {
      await repo.updateBranch(this.branch, target);
      return true;
    }
    // Lost the race: fetch this branch (scoped, single-ref — design doc
    // §3.3) and realign the local cache (fast-forward only, always safe —
    // §2 invariant A) so whoever recomputes next (typically another
    // `advance()` call reading this exact branch as its parent) sees the
    // real current state instead of the same stale value that led to this
    // rejection.
    const coordination = repo.getCoordination();
    await coordination.fetchRefSinceGeneration(
      repo.path,
      this.branch,
      await coordination.refGeneration(repo.path, this.branch),
      async () => {
        await bareGit.fetchRef(this.branch);
        await repo.updateBranch(this.branch, `origin/${this.branch}`);
      },
    );
    return false;
  }

  /**
   * Ensures this trunk's own branch exists before any real-git operation
   * needs to resolve it. A no-op for a root trunk — its branch (e.g. `main`)
   * is assumed to already exist (created by `initBare`/`cloneBare`).
   * Overridden by `DiskDerivedTrunk` to seed the branch off its parent's
   * current tip on first use.
   * @internal
   */
  async ensureBranchExists(): Promise<void> {
    // no-op for a root trunk
  }
}

export class DiskDerivedTrunk extends DiskTrunk implements DerivedTrunk {
  constructor(
    repo: DiskBareRepository,
    branch: string,
    readonly parent: Trunk,
    scratchRoot: Directory,
  ) {
    super(repo, branch, scratchRoot);
  }

  override async ensureBranchExists(): Promise<void> {
    const repo = this.repo as DiskBareRepository;
    await repo.createBranchIfMissing(this.branch, this.parent.branch);
  }

  /**
   * Conflict-free fast path (design doc §4.4). Real merge-preserving replay:
   * `git rebase --rebase-merges`, run non-interactively via a detached-HEAD
   * checkout borrowed from `resolveIn`'s own worktree (never `this.branch`
   * itself — a `Trunk` is never checked out, see `replayOnto()`'s own doc).
   * `git replay` (design doc §7's
   * open item) was confirmed UNAVAILABLE for this purpose in this
   * environment's git version (2.55.0, checked directly: `git replay
   * --onto ... <range>` against a real throwaway repo containing a merge
   * commit fails outright with `fatal: replaying merge commits is not
   * supported yet!`) — `rebase --rebase-merges` was chosen instead, per the
   * design doc's own documented fallback, and confirmed working against the
   * same throwaway scenario (a real merge commit, re-parented onto a moved
   * base, with the merge commit itself preserved in the result).
   *
   * **Fails clean on conflict, always — no attended fallback here.**
   * `rebaseMergesOntoOrAbort` (`GitOperations.ts`) runs `git rebase --abort`
   * itself before returning a conflict result, so a conflict never leaves
   * resumable state; `resolveIn`'s borrowed worktree is restored to
   * `resolveIn.branch` in a `finally` either way. `this.branch` (the trunk's
   * own ref) is NEVER written except
   * by the one CAS-push at the very end, and only once that push has
   * genuinely confirmed — matching `Movement.merge()`/`Mirror.apply()`'s
   * discipline (design doc §2 invariant A). The attended path (design doc
   * §4.4's `beginAdvance()`/`AdvanceAttempt`, for resolving a real content
   * conflict) is explicitly not implemented yet.
   *
   * **Fetches and retries (bounded) on a lost publish race — does NOT just
   * fail clean on the first collision.** This mirrors `Movement.merge()`/
   * `Mirror.apply()`'s own `publishWithRetry` shape (design doc §3): every
   * `pushRefCas` call below targets `this.branch`, so a rejected push always
   * means this trunk's own branch has a newer real tip on origin than this
   * attempt was built against. Simply returning `"conflict"` on that
   * rejection would leave the caller with only "call `advance()` again" as a
   * remedy — but `advance()` reads `this.branch`'s LOCAL cache, so calling it
   * again without an intervening fetch recomputes against the exact same
   * stale snapshot: a real cross-actor race (someone else pushing directly
   * to the derived trunk, or to the parent, between attempts) would make
   * zero progress no matter how many times a caller retried. So on
   * rejection, the ENTIRE computation (fresh `myTip`/`parentTip`, the
   * fast-forward/no-op shortcuts, and — if neither applies — a
   * freshly-recomputed merge-preserving replay against the new tips) is
   * re-derived from scratch inside `publishWithRetry`'s `attempt` closure,
   * not just the final push retried against stale state. Two refs are
   * fetched on every rejection, not just one: `this.branch` (the one whose
   * CAS actually rejected) AND `this.parent.branch` (design doc §4.4 frames
   * "the parent moved further" as equally real a race as "this trunk moved,"
   * and a stale local `parentTip` would otherwise keep producing a replay
   * built against outdated parent content on every retry, even once
   * `this.branch`'s own staleness is fixed) — both via the
   * generation-coalesced `fetchRefSinceGeneration` primitive, so a burst of
   * concurrent retrants still produces at most one or two real fetches per
   * ref, not one per caller. Bounded by `publishWithRetry`'s `maxAttempts`
   * (default 20, same as `Movement.merge()`); exhausting it — or a GENUINE
   * content conflict during the replay itself (a real `rebase
   * --rebase-merges` conflict, not a lost race) — both still return
   * `"conflict"`, since a real content conflict has no fetch-and-retry
   * answer (that's what `beginAdvance()`/`AdvanceAttempt`, design doc §4.4's
   * attended path, is for — still not implemented).
   */
  async advance(resolveIn: CheckedOutMovement): Promise<AdvanceResult> {
    await this.ensureBranchExists();
    const repo = this.repo as DiskBareRepository;
    const bareGit = repo.getGit();
    const coordination = repo.getCoordination();

    try {
      return await publishWithRetry<AdvanceResult>({
        attempt: async () => {
          const myTip = await repo.resolveLocalRef(this.branch);
          if (myTip === null) {
            return {
              status: "conflict",
              failedCommit: "",
              message: `Derived trunk '${this.branch}' has no commits`,
            };
          }
          const parentTip = await repo.resolveLocalRef(this.parent.branch);
          if (parentTip === null) {
            // Parent has no commits of its own yet — nothing to advance onto.
            return { status: "ok" };
          }
          if (myTip === parentTip || (await bareGit.mergeBaseIsAncestor(parentTip, myTip))) {
            // Already fully caught up with (or a descendant of) parent's tip
            // CONTENT-wise — nothing to replay. Still push (idempotent — git
            // no-ops a push of an already-current value): this trunk's tip
            // may never have been PUBLISHED to origin at all yet (e.g. a
            // variation whose only commits so far came from a local-only
            // `Movement.merge()` onto its own branch, never previously
            // advanced), and invariant A ("nothing is landed until origin
            // has it") applies here just as much as the real-replay path
            // below.
            const pushed = await bareGit.pushRefCas(this.branch, myTip);
            if (!pushed) throw new PublishRejectedError();
            await repo.updateBranch(this.branch, myTip);
            return { status: "ok" };
          }
          if (await bareGit.mergeBaseIsAncestor(myTip, parentTip)) {
            // This trunk has no commits of its own beyond what's already on
            // parent — a pure catch-up, no replay needed. Straight
            // fast-forward, still via a real push-CAS (design doc §2
            // invariant A).
            const pushed = await bareGit.pushRefCas(this.branch, parentTip);
            if (!pushed) throw new PublishRejectedError();
            await repo.updateBranch(this.branch, parentTip);
            return { status: "ok" };
          }

          // Real merge-preserving replay needed: find where this trunk's
          // own history diverged from parent (their merge-base), then
          // rebase exactly that range — `oldParentTip..myTip` — onto
          // parent's current tip, preserving every merge commit already in
          // it.
          const oldParentTip = await bareGit.mergeBase(myTip, parentTip);
          if (oldParentTip === null) {
            return {
              status: "conflict",
              failedCommit: myTip,
              message: `'${this.branch}' and '${this.parent.branch}' share no common history — cannot advance`,
            };
          }

          return this.replayOnto(resolveIn, myTip, parentTip, oldParentTip, bareGit, repo);
        },
        fetchRef: async (sinceGeneration) => {
          // A lost race here always means `this.branch`'s real origin tip
          // differs from what this attempt was built against — every
          // `pushRefCas` call above targets `this.branch`, never the parent
          // directly. Fetch it and realign the local cache (fast-forward
          // only, always safe — design doc §2 invariant A) so the next
          // attempt reads the ACTUAL current tip, not the same stale value.
          const ownGeneration = await coordination.fetchRefSinceGeneration(repo.path, this.branch, sinceGeneration, async () => {
            await bareGit.fetchRef(this.branch);
            await repo.updateBranch(this.branch, `origin/${this.branch}`);
          });
          // Also refresh the PARENT's local cache. `advance()`'s first
          // attempt deliberately never fetches (design doc §3.2's
          // optimistic-first-attempt principle — it reads whatever's
          // already cached), but a stale local `parentTip` is exactly what
          // design doc §4.4 calls "the more dangerous case" of the two-sided
          // race: without this, every retry would keep recomputing the
          // replay against the SAME outdated parent content, even after
          // `this.branch` itself is fixed up — a caller would still see no
          // progress if it was the PARENT that moved, not this trunk. `this`
          // being a `Trunk` is never checked out, so this fast-forward can
          // never conflict with a real worktree.
          await coordination.fetchRefSinceGeneration(
            repo.path,
            this.parent.branch,
            await coordination.refGeneration(repo.path, this.parent.branch),
            async () => {
              await bareGit.fetchRef(this.parent.branch);
              await repo.updateBranch(this.parent.branch, `origin/${this.parent.branch}`);
            },
          );
          return ownGeneration;
        },
        currentGeneration: () => coordination.refGeneration(repo.path, this.branch),
      });
    } catch (error) {
      if (error instanceof PublishRejectedError) {
        return {
          status: "conflict",
          failedCommit: "",
          message: `Advance of '${this.branch}' onto '${this.parent.branch}' could not be published after repeated retries — too much sustained concurrent activity (${error.message})`,
        };
      }
      throw error;
    }
  }

  /**
   * Builds and publishes `advance()`'s merge-preserving replay — factored
   * out of `advance()` itself for readability.
   *
   * Reuses `resolveIn`'s own worktree via a detached-HEAD checkout (`git
   * checkout --detach <myTip>`) — mirroring `CheckedOutMovement.merge()`
   * (`DiskMovement.ts`) — rather than provisioning a disposable scratch
   * worktree (`resolveIn` is required — see the port interface's own doc
   * comment). `this.branch` (a `Trunk`'s own ref) is never touched;
   * `resolveIn.branch` is simply not checked out anywhere while its worktree
   * is borrowed, so nothing here can conflict with it. The `finally` always
   * restores `resolveIn`'s worktree to `resolveIn.branch` — real conflict
   * (rebase already left clean by `rebaseMergesOntoOrAbort`'s own `--abort`)
   * or a lost publish race (the trial commits are simply abandoned, swept up
   * by ordinary git GC) — exactly the same two exit shapes `merge()`'s own
   * doc comment describes.
   */
  private async replayOnto(
    resolveIn: CheckedOutMovement,
    myTip: string,
    parentTip: string,
    oldParentTip: string,
    bareGit: GitOperations,
    repo: DiskBareRepository,
  ): Promise<AdvanceResult> {
    if (await resolveIn.isDirty()) {
      throw new Error("Cannot advance using a dirty worktree — commit or discard changes first");
    }
    const worktree = resolveIn.files as DiskWorktree;
    await worktree.getGit().checkoutDetached(myTip);
    try {
      const rebaseResult = await worktree.getGit().rebaseMergesOntoOrAbort(parentTip, oldParentTip);
      if (rebaseResult.status === "conflict") {
        return {
          status: "conflict",
          failedCommit: myTip,
          message:
            rebaseResult.message ??
            `Advancing '${this.branch}' onto '${this.parent.branch}' hit a real content conflict — attended resolution (beginAdvance()/AdvanceAttempt) is not implemented yet`,
        };
      }
      const newTip = await worktree.getGit().getLastCommitHash();

      // Publish: a direct CAS push to origin (design doc §2 invariant A),
      // never a local-only write. Two-tier, tried in order every attempt:
      //
      // 1. Plain ancestor-based `pushRefCas` first. Handles the legitimate
      //    case where `myTip` is locally AHEAD of whatever origin has
      //    actually published for this branch (e.g. local commits built
      //    directly, or a first-ever advance() with nothing on origin yet)
      //    — as long as origin's real current tip is still an ancestor of
      //    the replayed `newTip` (true whenever origin's published state
      //    was never itself part of the REPLAYED range — see
      //    `pushRefCasExpected`'s own doc for why that's not generally true
      //    of a rebase result), this succeeds and is exactly correct.
      // 2. `pushRefCasExpected` (design doc §4.4's expected-VALUE CAS,
      //    `updateRefIfUnchanged(branch, newTip, myTip)`) as a fallback.
      //    Needed for the case `pushRefCas` structurally cannot handle:
      //    origin's real tip for this branch IS `myTip` itself (the exact
      //    value this replay was computed from, true on any RETRY attempt —
      //    see `fetchRef` below, which realigns `myTip` to origin's real tip
      //    before every retry) but is NOT an ancestor of the rebased
      //    `newTip` (structural, not a race — `rebase --rebase-merges`
      //    gives every replayed commit a brand-new hash). A plain
      //    ancestor-based check would reject this every time, even though
      //    it's the exact correct, race-free continuation.
      //
      // Either succeeding means the push actually landed; either failing
      // (both origin's tip isn't an ancestor of `newTip` AND it doesn't
      // equal `myTip`) is a genuine rejection — throw so `publishWithRetry`
      // fetches (both refs — see `advance()`'s own `fetchRef`) and re-runs
      // this ENTIRE closure — including the replay itself, against the
      // newly fetched `myTip` — next attempt, rather than retrying the
      // identical doomed push.
      const pushed = (await bareGit.pushRefCas(this.branch, newTip)) || (await bareGit.pushRefCasExpected(this.branch, newTip, myTip));
      if (!pushed) throw new PublishRejectedError();
      await repo.updateBranch(this.branch, newTip);
      return { status: "ok" };
    } finally {
      await worktree.switchBranch(resolveIn.branch);
    }
  }

  /**
   * The attended path (design doc §4.4) — only meant to be called when
   * `advance()` reports a real content conflict. Snapshots both tips,
   * creates a throwaway scratch branch pointing at this trunk's current tip,
   * and checks THAT branch out INTO `resolveIn`'s own worktree — never a
   * newly-provisioned scratch worktree, and never `this.branch` itself
   * (which, being a `Trunk`, is never checked out anywhere). Every real
   * caller is an agent already operating from inside some wing's own
   * checkout, so `resolveIn` is always available — see this method's port
   * interface doc comment for the full rationale. Starts the identical
   * merge-preserving replay `advance()`'s fast path runs — except via
   * `rebaseMergesOnto` (not the `...OrAbort` variant), which LEAVES a
   * conflict resumable instead of aborting it, for the returned
   * `AdvanceAttempt` to drive to completion.
   *
   * Rejects upfront, before touching `resolveIn`'s worktree at all, if it's
   * dirty — see design doc §4.4 / progress log finding #14. Borrowing a
   * dirty worktree for the scratch-branch checkout would otherwise either
   * silently carry uncommitted changes onto the scratch branch (later swept
   * into the resolved commit by `continueResolving()`'s `git add -A`) or
   * produce a self-contradictory `status: "conflict"` with no real
   * conflicted files once the rebase itself refuses to start.
   */
  async beginAdvance(resolveIn: CheckedOutMovement): Promise<AdvanceAttempt> {
    if (await resolveIn.isDirty()) {
      throw new Error(
        "Cannot begin resolving an advance: the worktree has uncommitted changes — commit or discard them first",
      );
    }
    await this.ensureBranchExists();
    const repo = this.repo as DiskBareRepository;
    const bareGit = repo.getGit();

    const myTip = await repo.resolveLocalRef(this.branch);
    if (myTip === null) {
      throw new Error(`Cannot begin resolving an advance of '${this.branch}': it has no commits`);
    }
    const parentTip = await repo.resolveLocalRef(this.parent.branch);
    if (parentTip === null) {
      throw new Error(`Cannot begin resolving an advance of '${this.branch}' onto '${this.parent.branch}': parent has no commits`);
    }
    const oldParentTip = await bareGit.mergeBase(myTip, parentTip);
    if (oldParentTip === null) {
      throw new Error(`'${this.branch}' and '${this.parent.branch}' share no common history — cannot advance`);
    }

    const worktree = resolveIn.files as DiskWorktree;
    const originalBranch = await worktree.currentBranch();
    const scratchBranch = advanceScratchBranchName(this.branch);
    await repo.createBranchIfMissing(scratchBranch, myTip);
    await worktree.switchBranch(scratchBranch);
    const rebaseResult = await worktree.getGit().rebaseMergesOnto(parentTip, oldParentTip);

    return rebaseResult.status === "conflict"
      ? new DiskAdvanceAttemptImpl(this, repo, worktree, originalBranch, myTip, parentTip, "conflict", rebaseResult.conflictedFiles)
      : new DiskAdvanceAttemptImpl(this, repo, worktree, originalBranch, myTip, parentTip, "ready", []);
  }
}

/** A fresh, collision-free scratch branch name for one `beginAdvance()`/recompute round against `trunkBranch`. */
function advanceScratchBranchName(trunkBranch: string): string {
  return `__advance__/${trunkBranch}/${randomUUID()}`;
}

/**
 * The `AdvanceAttempt` implementation backing `DiskDerivedTrunk.beginAdvance()`
 * (design doc §4.4). Owns exactly one BORROWED worktree at a time —
 * `resolveIn`'s own, passed to `beginAdvance()` — never a worktree this
 * class provisions itself. `continueResolving()` resumes an in-progress
 * rebase IN PLACE (same worktree, same branch), while `publish()`'s
 * two-sided-CAS recomputation (see `recompute()`) always creates a FRESH
 * scratch branch and checks it out into the SAME borrowed worktree, so no
 * stale resumable-rebase state can leak across a recomputation. `dispose()`
 * (from `publish()` succeeding, or `abandon()`) always restores the borrowed
 * worktree to whatever branch it had checked out before `beginAdvance()` was
 * called.
 */
class DiskAdvanceAttemptImpl implements AdvanceAttempt {
  status: "conflict" | "ready";
  conflictedFiles: string[];
  files: Worktree;

  private disposed = false;

  constructor(
    private readonly derivedTrunk: DiskDerivedTrunk,
    private readonly repo: DiskBareRepository,
    /** `resolveIn`'s own worktree (see `beginAdvance()`), borrowed for the lifetime of this attempt — never a worktree this class provisions itself. */
    private readonly worktree: DiskWorktree,
    /** The branch `worktree` had checked out before `beginAdvance()` borrowed it — restored by `dispose()`. */
    private readonly originalBranch: string,
    /** The trunk tip this attempt's replay range currently starts from — updated when a `publish()` recompute detects the trunk itself moved. */
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

  private git(): GitOperations {
    return this.worktree.getGit();
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
    const result = await this.git().continueRebase();
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
   * `newParentTip`. Always creates a FRESH scratch branch and checks it out
   * into the SAME borrowed `worktree` (never reuses/resets the previous
   * scratch branch in place) so no leftover resumable-rebase state from a
   * previous round can leak into the recomputation. A conflict here is left
   * resumable (`rebaseMergesOnto`, not the aborting variant) and reflected
   * onto this attempt's own `status`/`conflictedFiles`, exactly like the
   * initial `beginAdvance()`.
   *
   * @param trunkMoved - When true, `oldParentTip` (the replay range's
   *   upstream boundary) is recomputed fresh via `mergeBase(newBaseTip,
   *   newParentTip)` — design doc §4.4's "extend the replay range" case, for
   *   when the derived trunk itself gained new commits mid-resolution. When
   *   false, the upstream boundary is this attempt's own previous
   *   `parentTargetTip` — re-parenting just the already-resolved delta onto
   *   a newer parent tip (the "parent moved further" case).
   */
  private async recompute(newBaseTip: string, newParentTip: string, trunkMoved: boolean): Promise<AdvanceResult> {
    const bareGit = this.repo.getGit();

    let upstream: string;
    if (trunkMoved) {
      const merged = await bareGit.mergeBase(newBaseTip, newParentTip);
      if (merged === null) {
        this.status = "conflict";
        this.conflictedFiles = [];
        return {
          status: "conflict",
          failedCommit: newBaseTip,
          message: `'${this.derivedTrunk.branch}' and '${this.derivedTrunk.parent.branch}' share no common history — cannot advance`,
        };
      }
      upstream = merged;
    } else {
      upstream = this.parentTargetTip;
    }

    const scratchBranch = advanceScratchBranchName(this.derivedTrunk.branch);
    await this.repo.createBranchIfMissing(scratchBranch, newBaseTip);
    await this.worktree.switchBranch(scratchBranch);
    const rebaseResult = await this.worktree.getGit().rebaseMergesOnto(newParentTip, upstream);
    // Only update `myTipSnapshot` — the value `currentTrunkTip` is compared
    // against to detect a genuine external move of the TRUNK's own branch —
    // when this recompute IS handling that case (`trunkMoved`). The
    // "parent moved" recompute's `newBaseTip` is the already-resolved WIP
    // tip (this attempt's own scratch branch), which has nothing to do with
    // the trunk's real branch value; mutating `myTipSnapshot` there would
    // make every later `attempt()` call wrongly believe the trunk moved
    // (since `currentTrunkTip`, read from the untouched real branch ref,
    // would then permanently differ from a `myTipSnapshot` that no longer
    // reflects that ref at all).
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

    const bareGit = this.repo.getGit();
    const coordination = this.repo.getCoordination();
    const branch = this.derivedTrunk.branch;
    const parentBranch = this.derivedTrunk.parent.branch;

    type AttemptOutcome = { kind: "ok" } | { kind: "conflict"; result: AdvanceResult };

    try {
      const outcome = await publishWithRetry<AttemptOutcome>({
        attempt: async () => {
          const currentTrunkTip = await this.repo.resolveLocalRef(branch);
          const currentParentTip = await this.repo.resolveLocalRef(parentBranch);
          if (currentTrunkTip === null) {
            return {
              kind: "conflict",
              result: { status: "conflict", failedCommit: "", message: `Derived trunk '${branch}' has no commits` },
            };
          }

          if (currentTrunkTip !== this.myTipSnapshot) {
            // The derived trunk itself moved since the snapshot — the more
            // dangerous case (design doc §4.4): this attempt's replayed
            // history doesn't include those new commits at all. Extend the
            // range and retry, which may reopen conflicts, correctly.
            const recomputed = await this.recompute(currentTrunkTip, currentParentTip ?? this.parentTargetTip, true);
            if (recomputed.status === "conflict") return { kind: "conflict", result: recomputed };
          } else if (currentParentTip !== null && currentParentTip !== this.parentTargetTip) {
            // The parent moved further (unrelated activity). Re-run the
            // replay using the just-resolved tip as the new starting point.
            const resolvedTip = await this.git().getLastCommitHash();
            const recomputed = await this.recompute(resolvedTip, currentParentTip, false);
            if (recomputed.status === "conflict") return { kind: "conflict", result: recomputed };
          }

          const newTip = await this.git().getLastCommitHash();
          // Same two-tier CAS `advance()`'s fast path uses (see that
          // method's own doc comment for why both tiers are needed): plain
          // ancestor-based `pushRefCas` first, expected-VALUE
          // `pushRefCasExpected` as the structural fallback a rebase result
          // always needs on a retry.
          const pushed = (await bareGit.pushRefCas(branch, newTip)) || (await bareGit.pushRefCasExpected(branch, newTip, this.myTipSnapshot));
          if (!pushed) throw new PublishRejectedError();
          await this.repo.updateBranch(branch, newTip);
          return { kind: "ok" };
        },
        fetchRef: async (sinceGeneration) => {
          const ownGeneration = await coordination.fetchRefSinceGeneration(this.repo.path, branch, sinceGeneration, async () => {
            await bareGit.fetchRef(branch);
            await this.repo.updateBranch(branch, `origin/${branch}`);
          });
          await coordination.fetchRefSinceGeneration(
            this.repo.path,
            parentBranch,
            await coordination.refGeneration(this.repo.path, parentBranch),
            async () => {
              await bareGit.fetchRef(parentBranch);
              await this.repo.updateBranch(parentBranch, `origin/${parentBranch}`);
            },
          );
          return ownGeneration;
        },
        currentGeneration: () => coordination.refGeneration(this.repo.path, branch),
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
   * (i.e. `abandon()` was called while `status === "conflict"`), aborts it
   * first — `git checkout <branch>` refuses to run with an in-progress
   * rebase or unresolved conflict markers left in the working tree, and
   * `git rebase --abort` is exactly what cleanly restores a rebasable-clean
   * tree in that state.
   */
  private async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (await this.git().hasInProgressRebase()) {
      await this.git().abortRebase();
    }
    await this.worktree.switchBranch(this.originalBranch);
  }
}

/**
 * Constructs a disk-based `Trunk` for `branch` in `repo`. Unlike
 * `createInMemoryTrunk`, this does NOT verify or create `branch` — doing so
 * would require an async git call, and this factory is deliberately kept
 * synchronous (matching the InMemory factory's shape) since a root trunk's
 * branch (e.g. `main`) is expected to already exist by the time a real bare
 * repository is available (created by `initBare`/`cloneBare`, or seeded by
 * `DiskDerivedTrunk.ensureBranchExists()` for a derived trunk). Operations
 * that actually need to resolve the branch (`advance()`,
 * `CheckedOutMovement.merge()`, ...) will surface a clear error if it turns
 * out not to exist.
 *
 * @param scratchRoot - Real filesystem directory worktrees created for this
 *   trunk's movements/mirrors/scratch work are nested under.
 */
export function createDiskTrunk(repo: BareRepository, branch: string, scratchRoot: Directory): Trunk {
  return new DiskTrunk(repo, branch, scratchRoot);
}

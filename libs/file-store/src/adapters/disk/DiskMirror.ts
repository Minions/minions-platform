/**
 * Disk Mirror (Movement/Trunk safety redesign, Sandbox layer)
 *
 * See docs/design/movement-trunk-safety-redesign.md §4.1 and §2 invariant B.
 * `apply()` is invariant B made concrete: read the trunk's current tip, run a
 * pure `transform`, commit whatever changed, CAS-publish. On a lost race,
 * re-run the whole transform against the fresh tip.
 *
 * The actual publish target is `trunk.branch` (e.g. `main`) — a real,
 * pushed-to-origin shared branch (design doc §2 invariant A) — NOT the
 * mirror's own branch (e.g. `plan`), which stays purely local, only ever
 * fast-forwarded to track the trunk after a successful publish (design doc
 * §4.2: "`plan` and `switchyard` branches are purely local — never pushed to
 * origin, never a second source of truth"). The publish step is a direct push
 * to origin (`GitOperations.pushRefCas`) as the actual CAS — never a
 * local-only `updateBranchIfUnchanged`, which would leave a "landed" write
 * that only origin's next fetch reveals was never actually shared; the local
 * trunk cache is fast-forwarded only after that push confirms.
 *
 * `Trunk.mirror()` is a SYNCHRONOUS method on the port interface, but real
 * git worktree creation is inherently async (a subprocess call) — unlike the
 * InMemory adapter, which can create its worktree synchronously in the
 * constructor. `files` is therefore backed by a lazy proxy
 * (`createLazyWorktree` below): every field known ahead of time (kind, name,
 * path, branch, repository) is available immediately and synchronously;
 * every actual git/filesystem operation transparently awaits the real
 * worktree's one-time creation first. Callers see an ordinary `Worktree`
 * either way.
 */

import { join } from "path";
import type { Trunk, Mirror, MutableDirectoryLike, Worktree, Directory, BareRepository } from "../../port/types.js";
import type { DiskBareRepository } from "./DiskBareRepository.js";
import type { DiskTrunk } from "./DiskTrunk.js";
import { sanitizeBranchForPath } from "./DiskTrunk.js";
import { PublishRejectedError, jitteredDelayMs } from "./PublishRetry.js";

const MAX_APPLY_ATTEMPTS_DEFAULT = 5;

/**
 * Process-lifetime record of the subtree each mirror worktree path was last
 * narrowed to (cone-mode sparse-checkout), so `createAndSyncWorktree` only
 * re-runs `setSparseCheckout` (three git subprocess spawns) when the
 * requested subtree actually differs from what's already checked out —
 * e.g. alternating between the plan mirror's `.meta/plan` view and
 * `resolveConductorMirror`'s `.meta/conductor` view of the SAME worktree
 * path. Keyed by worktree path, not by mirror instance, since a fresh
 * `DiskMirrorImpl` is constructed on every `Trunk.mirror()` call (see
 * `LairRepoPerspective.resolve`) — this cache is what lets those otherwise-
 * independent instances still skip redundant narrowing of the one real
 * on-disk worktree they share.
 */
const lastNarrowedSubtree = new Map<string, string | undefined>();

/**
 * Coalesces concurrent `setupWorktree()` calls for the same (repo, branch) —
 * see `createAndSyncWorktree`'s doc comment for why sharing this in-flight
 * promise (rather than each Mirror instance independently finding/creating
 * the worktree) is load-bearing for correctness, not just an optimization.
 */
const worktreeSetupCache = new Map<string, Promise<Worktree>>();

/** Coalesces concurrent `ensureNarrowed()` calls for the same (repo, branch, subtree). */
const narrowInFlight = new Map<string, Promise<void>>();

/**
 * Wraps a not-yet-created real `Worktree` behind a `Worktree`-shaped handle
 * that's available synchronously. `known` fields (all deterministic ahead of
 * actual creation — the path/branch this code chooses itself) are served
 * directly; every other property access is assumed to be a method and
 * returns an async thunk that awaits `ensure()` (memoized — runs at most
 * once) before delegating to the real worktree.
 * @internal
 */
function createLazyWorktree(
  known: { name: string; path: string; branch: string; repository: BareRepository },
  ensure: () => Promise<Worktree>,
): Worktree {
  let cached: Promise<Worktree> | undefined;
  const getReal = (): Promise<Worktree> => {
    if (!cached) cached = ensure();
    return cached;
  };

  const base = {
    kind: "worktree" as const,
    name: known.name,
    path: known.path,
    branch: known.branch,
    repository: known.repository,
    match<T2>(cases: { worktree: (w: Worktree) => T2 }): T2 {
      return cases.worktree(proxy);
    },
    is(kind: unknown): boolean {
      return kind === "worktree";
    },
    isDirectoryLike(): boolean {
      return true;
    },
  };

  const proxy = new Proxy(base, {
    get(target, prop, receiver) {
      if (Reflect.has(target, prop)) {
        return Reflect.get(target, prop, receiver);
      }
      return async (...args: unknown[]) => {
        const real = await getReal();
        const member = (real as unknown as Record<PropertyKey, unknown>)[prop];
        if (typeof member !== "function") {
          throw new TypeError(`Worktree has no method '${String(prop)}'`);
        }
        return (member as (...a: unknown[]) => unknown).apply(real, args);
      };
    },
  }) as unknown as Worktree;

  return proxy;
}

export class DiskMirrorImpl<T extends Trunk = Trunk> implements Mirror<T> {
  readonly files: MutableDirectoryLike;
  private readonly repo: DiskBareRepository;
  private readonly mirrorBranch: string;
  private readonly scratchRoot: Directory;
  private readonly subtree: string | undefined;

  constructor(
    readonly trunk: T,
    mirrorBranch: string,
    scratchRoot: Directory,
    /**
     * When given, the mirror's worktree is a real sparse (cone-mode) checkout
     * scoped to this subtree path — not a full-tree checkout. Ported from
     * `libs/repo-perspective/src/planMirror.ts`'s `checkOutFreshMirror`
     * (`BareRepository.createSparseWorktree`) / `DiskWorktree`'s
     * `setSparseCheckout`, the reference implementation for sparse checkouts
     * on real git in this codebase (design doc §7's "Switchyard's conductor
     * subtree" open item, now resolved).
     */
    subtree?: string,
  ) {
    this.repo = trunk.repo as DiskBareRepository;
    this.mirrorBranch = mirrorBranch;
    this.scratchRoot = scratchRoot;
    this.subtree = subtree;

    const name = `__mirror__${sanitizeBranchForPath(mirrorBranch)}`;
    this.files = createLazyWorktree(
      { name, path: join(scratchRoot.path, name), branch: mirrorBranch, repository: this.repo },
      () => this.ensureWorktree(),
    );
  }

  private worktreePromise: Promise<Worktree> | undefined;

  private ensureWorktree(): Promise<Worktree> {
    if (!this.worktreePromise) {
      this.worktreePromise = this.createAndSyncWorktree();
    }
    return this.worktreePromise;
  }

  private async createAndSyncWorktree(): Promise<Worktree> {
    // Finding/creating the mirror worktree (branch check, `git worktree
    // list`, create-if-missing) is coalesced per (repo, branch): a fresh
    // `DiskMirrorImpl` is constructed on every `Trunk.mirror()` call (see
    // `LairRepoPerspective.resolve`), so without this, N concurrent Mirror
    // instances for the same worktree (e.g. one `get-subtree` per plan root,
    // all firing in parallel) would each independently re-run this whole
    // subprocess sequence — and, worse, race each other's `git worktree add`
    // for the same branch, which git rejects outright (only one worktree may
    // check out a given branch at a time). Coalescing makes the FIRST caller
    // do the work and everyone else await its result, which is both correct
    // and fast.
    const setupKey = `${this.repo.path}::${this.mirrorBranch}`;
    let setupPromise = worktreeSetupCache.get(setupKey);
    if (!setupPromise) {
      setupPromise = this.setupWorktree();
      worktreeSetupCache.set(setupKey, setupPromise);
      setupPromise.catch(() => {
        if (worktreeSetupCache.get(setupKey) === setupPromise) worktreeSetupCache.delete(setupKey);
      });
    }
    const worktree = await setupPromise;

    await this.ensureNarrowed(worktree, setupKey);
    await this.syncToTrunkTip(worktree);
    return worktree;
  }

  /** Finds or creates the mirror worktree for this branch. Always called through
   *  `worktreeSetupCache` (see `createAndSyncWorktree`) — never races itself. */
  private async setupWorktree(): Promise<Worktree> {
    await (this.trunk as unknown as DiskTrunk).ensureBranchExists();

    // `createBranchIfMissing` always spawns a `git branch` subprocess, even
    // when the branch already exists (it just swallows the "already
    // exists" failure) — skip the spawn entirely once a plain ref-file read
    // shows the branch is already there (the common case: every call after
    // the mirror branch's first-ever creation).
    if ((await this.repo.resolveLocalRef(this.mirrorBranch)) === null) {
      await this.repo.createBranchIfMissing(this.mirrorBranch, this.trunk.branch);
    }

    // Must go through `worktrees()` (a real `git worktree list`), not a
    // guess at a deterministic path: a worktree for this branch can already
    // exist at a path this naming scheme wouldn't predict (e.g. one left
    // over from an older, differently-named code path) — `git worktree add`
    // for a branch already checked out elsewhere fails outright, so finding
    // the real existing one, wherever it is, is load-bearing, not optional.
    const existing = (await this.repo.worktrees()).find((wt) => wt.branch === this.mirrorBranch);
    if (existing) return existing;

    const name = `__mirror__${sanitizeBranchForPath(this.mirrorBranch)}`;
    if (this.subtree !== undefined) {
      const worktree = await this.repo.createSparseWorktree(this.scratchRoot, name, this.mirrorBranch, this.subtree);
      lastNarrowedSubtree.set(`${this.repo.path}::${this.mirrorBranch}`, this.subtree);
      return worktree;
    }
    return this.repo.createWorktree(this.scratchRoot, name, this.mirrorBranch);
  }

  /**
   * Idempotent realignment: a worktree created before this subtree was
   * configured (or by an older full-tree code path), or last narrowed to a
   * DIFFERENT subtree (this same worktree path is shared with
   * `resolveConductorMirror`'s `.meta/conductor` view — see that function's
   * doc comment on invariant 2), gets (re-)narrowed now. Skipped when the
   * last narrow already targeted this exact subtree — `setSparseCheckout`
   * spawns three git subprocesses, and re-running it for an unchanged
   * subtree on every read was the dominant cost of every plan/movement
   * mirror read before this cache. Concurrent requests for the SAME subtree
   * share one in-flight narrow instead of racing redundant spawns; requests
   * for genuinely different subtrees still race each other at the git level
   * exactly as before this cache (narrowing a shared worktree to two
   * different views at once was never atomic).
   */
  private async ensureNarrowed(worktree: Worktree, setupKey: string): Promise<void> {
    if (this.subtree === undefined) return;
    if (lastNarrowedSubtree.get(setupKey) === this.subtree) return;

    const narrowKey = `${setupKey}::${this.subtree}`;
    let promise = narrowInFlight.get(narrowKey);
    if (!promise) {
      promise = worktree.setSparseCheckout(this.subtree).then(() => {
        lastNarrowedSubtree.set(setupKey, this.subtree);
      });
      narrowInFlight.set(narrowKey, promise);
      promise.finally(() => {
        if (narrowInFlight.get(narrowKey) === promise) narrowInFlight.delete(narrowKey);
      });
    }
    await promise;
  }

  /**
   * Fast-forwards the mirror branch — a disposable local cache, never a
   * second source of truth — to the trunk's current tip, and resets the
   * worktree's files to match. Local-only; never pushed anywhere (design doc
   * §4.2). Safe from anywhere, at any time (design doc §2 invariant A).
   */
  private async syncToTrunkTip(worktree: Worktree): Promise<string | null> {
    const trunkTip = await this.repo.resolveLocalRef(this.trunk.branch);
    if (trunkTip === null) return null;
    const mirrorTip = await this.repo.resolveLocalRef(this.mirrorBranch);
    if (mirrorTip === trunkTip) return trunkTip;
    // `resetTo` already moves the mirror branch's own pointer (it's checked
    // out right here, in this worktree) — no separate `updateBranch` needed,
    // and real git would refuse one anyway (`branch -f` on a checked-out
    // branch fails; only a checkout-local reset can move it).
    await worktree.resetTo(trunkTip);
    return trunkTip;
  }

  async apply<R>(
    transform: (view: MutableDirectoryLike) => Promise<R>,
    opts?: { retries?: number; message?: string },
  ): Promise<{ result: R; committed: boolean; commitHash?: string; attempts: number }> {
    const coordination = this.repo.getCoordination();
    // Whole-attempt exclusivity per mirror worktree (see
    // `GitCoordinationState.withMirrorApplySerialization`'s doc comment) —
    // the ENTIRE sequence below (worktree creation, sync-to-tip, transform,
    // commit, CAS-publish, retry-on-loss) runs as one atomic unit relative to
    // any OTHER `apply()` attempt targeting the same worktree path, not just
    // the individual git subprocess calls inside it. `this.files.path` is
    // known synchronously (the lazy-worktree proxy's `known` fields), so the
    // lock can be acquired before the worktree is even created.
    return coordination.withMirrorApplySerialization(this.files.path, () => this.runAttempts(transform, opts));
  }

  private async runAttempts<R>(
    transform: (view: MutableDirectoryLike) => Promise<R>,
    opts?: { retries?: number; message?: string },
  ): Promise<{ result: R; committed: boolean; commitHash?: string; attempts: number }> {
    const maxAttempts = (opts?.retries ?? MAX_APPLY_ATTEMPTS_DEFAULT) + 1;
    const commitMessage = opts?.message ?? `Mirror.apply on '${this.mirrorBranch}'`;
    const bareGit = this.repo.getGit();
    const coordination = this.repo.getCoordination();
    const worktree = await this.ensureWorktree();

    let sinceGeneration = await coordination.refGeneration(this.repo.path, this.trunk.branch);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await this.syncToTrunkTip(worktree);

      const result = await transform(this.files);

      const dirty = await worktree.isDirty();
      if (!dirty) {
        return { result, committed: false, attempts: attempt };
      }

      const commitHash = await worktree.commitAll(commitMessage);

      // Publish: a direct CAS push to origin (design doc §2 invariant A),
      // not the local-only `updateBranchIfUnchanged` alone — see this file's
      // header doc.
      const pushed = await bareGit.pushRefCas(this.trunk.branch, commitHash);
      if (pushed) {
        // Only now — after the push confirmed on origin — fast-forward the
        // local trunk cache to match. The mirror branch itself is already at
        // `commitHash` (its own worktree just committed directly onto it);
        // trying to `updateBranch` it again would both be redundant and, on
        // real git, fail outright (`branch -f` refuses a checked-out branch).
        await this.repo.updateBranch(this.trunk.branch, commitHash);
        return { result, committed: true, commitHash, attempts: attempt };
      }

      // Lost the race — someone else advanced the trunk on origin. A scoped,
      // single-ref, generation-coalesced fetch (design doc §3.3/§3.4),
      // jittered backoff, then loop: `transform` must be pure/re-computable
      // (invariant B) — re-sync to the fresh tip and run it again from
      // scratch, not resume from partial state.
      if (attempt >= maxAttempts) {
        throw new PublishRejectedError(
          `Mirror.apply on '${this.mirrorBranch}' failed to publish after ${maxAttempts} attempts (persistent contention)`,
        );
      }
      sinceGeneration = await coordination.fetchRefSinceGeneration(this.repo.path, this.trunk.branch, sinceGeneration, async () => {
        await bareGit.fetchRef(this.trunk.branch);
        // Realign the local cache to what was just fetched — same
        // fast-forward-safe realignment `DiskMovement.merge()` does; without
        // it `syncToTrunkTip()`'s next read would keep seeing the same stale
        // local branch pointer (a scoped fetch only updates
        // `refs/remotes/origin/<branch>`, never the local branch itself).
        await this.repo.updateBranch(this.trunk.branch, `origin/${this.trunk.branch}`);
      });
      await new Promise((resolve) => setTimeout(resolve, jitteredDelayMs(attempt, 100, Math.random)));
    }

    throw new Error(
      `Mirror.apply on '${this.mirrorBranch}' failed to publish after ${maxAttempts} attempts (persistent contention)`,
    );
  }
}

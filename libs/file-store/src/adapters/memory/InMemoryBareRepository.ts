/**
 * In-Memory Bare Repository Implementation (OO Port)
 *
 * Implements the BareRepository interface for git operations.
 */

import type {
  BareRepository,
  Directory,
  Worktree,
  NodeKind,
} from "../../port/types.js";
import type { SandboxStorage, InMemorySandbox } from "./InMemorySandbox.js";
import type { InMemoryDirectory } from "./InMemoryDirectory.js";
import { InMemoryWorktree } from "./InMemoryWorktree.js";
import { SimulatedGit } from "./SimulatedGit.js";
import { KeyedQueue } from "@minions/scheduling";

/**
 * In-memory implementation of BareRepository.
 */
export class InMemoryBareRepository implements BareRepository {
  readonly kind = "bare-repository" as const;
  private git: SimulatedGit;
  private worktreeRegistry: Map<string, InMemoryWorktree> = new Map();
  /**
   * `movement.<branch>.base` equivalent (design doc §4.2) — repo-scoped (not
   * per-worktree) by construction, since this whole object already
   * represents the one bare repository, not any one worktree of it. See
   * `GitOperations.movementBaseKey`'s doc comment on the Disk adapter for the
   * real git-config shape this mirrors.
   */
  private movementBaseOverrides: Map<string, string> = new Map();
  /**
   * Whole-attempt exclusivity for `Mirror.apply()` against one mirror
   * worktree — mirrors `GitCoordinationState.withMirrorApplySerialization`
   * on the Disk adapter (see that method's doc comment for the full
   * rationale). Two separately-constructed `Mirror` handles for the SAME
   * mirror branch (`Trunk.mirror()` is not cached — design doc §4.1) resolve
   * to the same worktree and must run their full apply sequence
   * (sync-to-tip, transform, commit, CAS-publish, retry) as one atomic unit
   * relative to each other, not just have their individual git-shaped calls
   * (which, in this adapter, are synchronous anyway) happen to not overlap.
   */
  private readonly applyQueue = new KeyedQueue();

  constructor(
    readonly name: string,
    readonly path: string,
    readonly url: string | null,
    private storage: SandboxStorage,
    private sandbox: InMemorySandbox
  ) {
    this.git = new SimulatedGit();
  }

  // ========================================
  // Worktree Operations
  // ========================================

  async createWorktree(
    into: Directory,
    name: string,
    branch: string
  ): Promise<Worktree> {
    const intoDir = into as InMemoryDirectory;
    return this.createWorktreeSync(intoDir.path, name, branch);
  }

  /**
   * Synchronous core of {@link createWorktree}. All InMemory storage
   * mutation is synchronous under the hood regardless — `createWorktree`
   * just wraps this in an async signature to satisfy the public
   * `BareRepository` interface. Exposed (internal-only, not part of any
   * public interface) for the Movement/Trunk/Mirror sandbox-layer adapter
   * classes (see docs/design/movement-trunk-safety-redesign.md §4.1), which
   * need worktree creation to happen eagerly at construction time — their
   * `files`-like properties are plain, synchronously-readable fields, not
   * promises, so the underlying worktree must already exist by the time
   * those fields are read.
   * @internal
   */
  createWorktreeSync(intoPath: string, name: string, branch: string): InMemoryWorktree {
    const worktreePath = intoPath ? `${intoPath}/${name}` : name;

    // Real git refuses to check out a branch that's already checked out in
    // another worktree of the same repo ("cannot force update the branch ...
    // used by worktree"). Mirror that so callers relying on the rejection
    // (e.g. best-effort plan/main sync) see the same failure in-memory.
    for (const existing of this.worktreeRegistry.values()) {
      if (existing.branch === branch && existing.path !== worktreePath) {
        throw new Error(`'${branch}' is already used by worktree at '${existing.path}'`);
      }
    }

    // Ensure the branch exists
    this.git.ensureBranch(branch);

    const worktree = new InMemoryWorktree(
      name,
      worktreePath,
      branch,
      this,
      this.git,
      this.storage,
      this.sandbox
    );

    this.worktreeRegistry.set(worktreePath, worktree);
    this.storage.directories.add(worktreePath);
    this.storage.worktrees.set(worktreePath, worktree);

    // Mirror real git's "worktree add" checkout: if the branch already has
    // committed content, the new worktree starts with that content rather
    // than empty (matching DiskBareRepository.createWorktree, where `git
    // worktree add` performs a real checkout).
    const tree = this.git.getTree(branch);
    if (tree) {
      for (const [relPath, content] of tree) {
        this.storage.files.set(`${worktreePath}/${relPath}`, content);
      }
    }

    return worktree;
  }

  async createSparseWorktree(
    into: Directory,
    name: string,
    branch: string,
    subdir: string
  ): Promise<Worktree> {
    const worktree = await this.createWorktree(into, name, branch) as InMemoryWorktree;
    await worktree.setSparseCheckout(subdir);
    return worktree;
  }

  async worktrees(): Promise<Worktree[]> {
    return Array.from(this.worktreeRegistry.values());
  }

  async removeWorktree(worktree: Worktree): Promise<void> {
    const wt = worktree as InMemoryWorktree;
    this.worktreeRegistry.delete(wt.path);
    this.storage.worktrees.delete(wt.path);
    // Clean up the worktree's files and directories
    const prefix = wt.path ? `${wt.path}/` : "";
    for (const filePath of this.storage.files.keys()) {
      if (filePath.startsWith(prefix)) {
        this.storage.files.delete(filePath);
      }
    }
    for (const dirPath of this.storage.directories) {
      if (dirPath.startsWith(prefix) || dirPath === wt.path) {
        this.storage.directories.delete(dirPath);
      }
    }
  }

  async pruneWorktrees(): Promise<void> {
    // In-memory implementation doesn't have stale worktrees
    // No-op for simplicity
  }

  async branches(): Promise<string[]> {
    return this.git.getBranches();
  }

  async createBranchIfMissing(name: string, ref: string): Promise<void> {
    this.git.createBranchIfMissing(name, ref);
  }

  async updateBranch(name: string, target: string): Promise<void> {
    this.git.updateBranch(name, target);
  }

  async updateBranchIfUnchanged(name: string, target: string, expected: string): Promise<boolean> {
    return this.git.updateBranchIfUnchanged(name, target, expected);
  }

  async resolveLocalRef(name: string): Promise<string | null> {
    return this.git.resolveLocalRef(name) ?? null;
  }

  async fetch(_force = false): Promise<void> {
    if (!this.url) return;
    const remote = this.storage.remotes.get(this.url);
    if (!remote) return; // no simulated remote registered for this URL — nothing to sync
    this.git.cloneFrom(remote.getGit());
  }

  async pushBranch(name: string): Promise<void> {
    this.pushOneBranch(name);
  }

  /**
   * Publishes a single branch to origin: sets the local remote-tracking
   * ref, and — if a simulated remote is registered for this repo's URL —
   * publishes this repo's history and force-sets the remote's own local
   * branch.
   */
  private pushOneBranch(name: string): void {
    this.git.setRemoteRefFromBranch(`origin/${name}`, name);

    if (!this.url) return;
    const remote = this.storage.remotes.get(this.url);
    if (!remote) return; // no simulated remote registered for this URL — nothing further to publish to
    const hash = this.git.getBranchHash(name);
    if (!hash) return;
    remote.getGit().cloneFrom(this.git); // publish this repo's full history so the remote (and later fetchers) see it
    remote.getGit().forceSetLocalBranch(name, hash);
  }

  async normalizeLocalBranches(): Promise<string[]> {
    // The in-memory simulation never produces clone --bare branch litter.
    return [];
  }

  async getMovementBase(branch: string): Promise<string | null> {
    return this.movementBaseOverrides.get(branch) ?? null;
  }

  async setMovementBase(branch: string, base: string | null): Promise<void> {
    if (base === null) {
      this.movementBaseOverrides.delete(branch);
    } else {
      this.movementBaseOverrides.set(branch, base);
    }
  }

  async delete(): Promise<void> {
    // Remove all worktrees first
    for (const worktree of this.worktreeRegistry.values()) {
      await this.removeWorktree(worktree);
    }
    // Remove from storage
    this.storage.bareRepositories.delete(this.path);
    this.storage.directories.delete(this.path);
  }

  // ========================================
  // Internal - Git Access
  // ========================================

  /**
   * Get the simulated git instance.
   * @internal
   */
  getGit(): SimulatedGit {
    return this.git;
  }

  /**
   * See the `applyQueue` field's doc comment. Keyed by the mirror's own
   * worktree path (not this repo's own path), matching the Disk adapter's
   * `GitCoordinationState.withMirrorApplySerialization` key shape.
   * @internal
   */
  withMirrorApplySerialization<T>(worktreePath: string, run: () => Promise<T>): Promise<T> {
    return this.applyQueue.run(worktreePath, run);
  }

  /**
   * Synchronous worktree lookup by its full storage path (as computed by
   * {@link createWorktreeSync}: `${intoPath}/${name}`). Lets the
   * Movement/Trunk/Mirror sandbox-layer adapter classes do idempotent
   * "reuse if it already exists, else create" worktree setup without an
   * async round trip through the public `worktrees()` method.
   * @internal
   */
  getWorktreeSync(path: string): InMemoryWorktree | undefined {
    return this.worktreeRegistry.get(path);
  }

  /**
   * Synchronous worktree lookup by BRANCH name, anywhere in the repo — not
   * just at one specific conventional path. Mirrors the Disk adapter's
   * `DiskMirrorImpl.ensureWorktree()`, which searches `(await
   * this.repo.worktrees()).find((wt) => wt.branch === this.mirrorBranch)`
   * before creating a new one, so an already-existing worktree checked out
   * on the target branch (e.g. one created by the `bootstrapPlanMirror`/
   * `checkOutFreshMirror` convention, which uses a different path than
   * `Mirror`'s own `__mirror__<branch>` convention) is transparently reused
   * instead of colliding with real git's one-worktree-per-branch constraint
   * (see the loop right above, in `createWorktreeSync`). Without this,
   * `InMemoryMirrorImpl`'s constructor — unlike `DiskMirrorImpl`'s
   * `ensureWorktree()` — only ever looks up by PATH (`getWorktreeSync(path)`),
   * so it would try to create a SECOND worktree on the same branch and hit
   * that exact collision instead of reusing the first one; a real,
   * adapter-inconsistent gap, not a hypothetical one.
   * @internal
   */
  getWorktreeByBranchSync(branch: string): InMemoryWorktree | undefined {
    for (const worktree of this.worktreeRegistry.values()) {
      if (worktree.branch === branch) return worktree;
    }
    return undefined;
  }

  // ========================================
  // Pattern Matching
  // ========================================

  match<T>(cases: { bareRepository: (r: BareRepository) => T }): T {
    return cases.bareRepository(this);
  }

  is(kind: "bare-repository"): this is BareRepository;
  is(kind: NodeKind): boolean;
  is(kind: NodeKind): boolean {
    return kind === "bare-repository";
  }

  isDirectoryLike(): boolean {
    return false;
  }
}

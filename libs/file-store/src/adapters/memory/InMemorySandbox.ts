/**
 * In-Memory Sandbox Implementation
 *
 * The OO entry point for the in-memory file store.
 * Provides a Sandbox interface with typed directory objects and git operations.
 */

import type { Sandbox } from "../../port/Sandbox.js";
import type {
  Directory,
  BareRepository,
  ReadOnlyClone,
  CloneAuth,
} from "../../port/types.js";
import { InMemoryDirectory } from "./InMemoryDirectory.js";
import { InMemoryBareRepository } from "./InMemoryBareRepository.js";
import { InMemoryReadOnlyClone } from "./InMemoryReadOnlyClone.js";
import type { InMemoryWorktree } from "./InMemoryWorktree.js";

/**
 * Shared storage context for all nodes in the sandbox.
 * This allows all nodes to share the same in-memory state.
 */
export interface SandboxStorage {
  /** File content storage: path -> content */
  files: Map<string, string>;
  /** Directory tracking: set of directory paths */
  directories: Set<string>;
  /** Junction tracking: path -> target path */
  junctions: Map<string, string>;
  /** Bare repository tracking: path -> repository */
  bareRepositories: Map<string, InMemoryBareRepository>;
  /** Read-only clone tracking: path -> clone */
  readOnlyClones?: Map<string, InMemoryReadOnlyClone>;
  /**
   * Worktree root tracking: path -> worktree. Lets a plain Directory's
   * child()/children()/glob() recognize a path as a worktree root (kind
   * "worktree") instead of a generic directory — mirroring how the disk
   * adapter detects a worktree root by inspecting its `.git` file. Keyed
   * globally (not per-BareRepository) so navigation from any directory in
   * the sandbox can discover a worktree created elsewhere via
   * `BareRepository.createWorktree()`.
   */
  worktrees: Map<string, InMemoryWorktree>;
  /**
   * Sparse-checkout cone per worktree root: worktreeRoot path -> cone subdir
   * (normalized, no leading/trailing slash). A worktree absent from this map
   * is fully checked out (no filtering) — mirrors a real git worktree before
   * `git sparse-checkout set` has ever run.
   */
  sparseCones: Map<string, string>;
  /**
   * Simulated remotes, keyed by clone URL: url -> a bare repository standing
   * in for "origin" (see `InMemorySandbox.simulateRemote`). `cloneBare()`
   * seeds a new clone's remote-tracking refs from here when a remote is
   * registered for that URL; `fetch()`/`pushBranch()` sync against it too.
   * Absent entirely for URLs no test has registered a remote for — those
   * clones behave as before (empty, no remote-tracking refs).
   */
  remotes: Map<string, InMemoryBareRepository>;
  /**
   * Fake modification-time clock, advanced by 1000ms on every file
   * write/append/create (see fakeClock.ts). A mutable box (not a plain
   * number) so all nodes sharing this storage see the same advancing clock.
   */
  clock: { value: number };
  /** File modification times: path -> mtimeMs (fake clock value at last write). */
  fileMtimes: Map<string, number>;
}

/**
 * In-memory implementation of the Sandbox interface.
 *
 * All data is stored in Map/Set data structures, making this
 * implementation fast and isolated - perfect for testing.
 */
export class InMemorySandbox implements Sandbox {
  readonly root: Directory;
  private storage: SandboxStorage;

  /**
   * Creates an in-memory sandbox.
   *
   * @param name - Name for the root directory (default: "sandbox")
   */
  constructor(name = "sandbox") {
    this.storage = {
      files: new Map(),
      directories: new Set([""]), // Root always exists
      junctions: new Map(),
      bareRepositories: new Map(),
      readOnlyClones: new Map(),
      worktrees: new Map(),
      sparseCones: new Map(),
      remotes: new Map(),
      clock: { value: 0 },
      fileMtimes: new Map(),
    };
    this.root = new InMemoryDirectory(name, "", this.storage, this);
  }

  /**
   * Get the storage context (for internal use by node implementations).
   * @internal
   */
  getStorage(): SandboxStorage {
    return this.storage;
  }

  /**
   * Current value of the fake modification-time clock (see fakeClock.ts).
   * Tests can read this before/after a file operation to compute the exact
   * mtimeMs a subsequent File.stat() call should return.
   */
  now(): number {
    return this.storage.clock.value;
  }

  async cloneBare(
    url: string,
    into: Directory,
    name: string,
    _auth?: CloneAuth
  ): Promise<BareRepository> {
    // For in-memory simulation, we simulate a clone by creating
    // an empty bare repository with the URL stored
    // Note: auth is accepted for interface consistency but not used in simulation
    const intoDir = into as InMemoryDirectory;
    const repoPath = intoDir.path ? `${intoDir.path}/${name}` : name;

    const repo = new InMemoryBareRepository(
      name,
      repoPath,
      url,
      this.storage,
      this
    );
    this.storage.bareRepositories.set(repoPath, repo);
    this.storage.directories.add(repoPath);

    // Seed remote-tracking refs from a simulated remote registered for this
    // URL (see simulateRemote), mirroring what a real `git clone` populates.
    // Most tests never call simulateRemote — this is then a no-op, and the
    // clone starts with no remote-tracking refs, as before.
    const remote = this.storage.remotes.get(url);
    if (remote) repo.getGit().cloneFrom(remote.getGit());

    return repo;
  }

  /**
   * Registers (or returns the already-registered) simulated "origin" for
   * `url` — a full bare repository tests can create worktrees on and commit
   * to directly, exactly like any other. Any `cloneBare(url, ...)` call
   * (including via `Lair.addWorkRepo`) for the same URL, called before or
   * after, seeds its remote-tracking refs from this remote's current state;
   * `fetch()` re-syncs later commits, and `pushBranch()` publishes back to
   * it — enabling tests of behavior that depends on origin having state a
   * local clone doesn't yet (or no longer) have, without any real network
   * or a second physical sandbox.
   */
  simulateRemote(url: string): BareRepository {
    let remote = this.storage.remotes.get(url);
    if (!remote) {
      remote = new InMemoryBareRepository(url, `\0remote:${url}`, url, this.storage, this);
      this.storage.remotes.set(url, remote);
    }
    return remote;
  }

  async cloneReadOnly(
    url: string,
    into: Directory,
    name: string,
    branch?: string,
    _auth?: CloneAuth
  ): Promise<ReadOnlyClone> {
    // Note: auth is accepted for interface consistency but not used in simulation
    const intoDir = into as InMemoryDirectory;
    const clonePath = intoDir.path ? `${intoDir.path}/${name}` : name;
    const actualBranch = branch ?? "main";

    const clone = new InMemoryReadOnlyClone(
      name,
      clonePath,
      url,
      actualBranch,
      this.storage,
      this
    );
    (this.storage.readOnlyClones ??= new Map()).set(clonePath, clone);
    this.storage.directories.add(clonePath);

    return clone;
  }

  async initBare(into: Directory, name: string): Promise<BareRepository> {
    const intoDir = into as InMemoryDirectory;
    const repoPath = intoDir.path ? `${intoDir.path}/${name}` : name;

    const repo = new InMemoryBareRepository(
      name,
      repoPath,
      null, // No remote URL for locally initialized repos
      this.storage,
      this
    );
    this.storage.bareRepositories.set(repoPath, repo);
    this.storage.directories.add(repoPath);

    return repo;
  }
}

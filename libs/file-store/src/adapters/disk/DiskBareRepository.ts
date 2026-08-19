/**
 * Disk Bare Repository Implementation
 *
 * Implements the BareRepository interface using real git operations.
 */

import { promises as fs } from "fs";
import { join, basename } from "path";
import type {
  BareRepository,
  Directory,
  Worktree,
  NodeKind,
} from "../../port/types.js";
import { GitOperations, type GitCoordinationState } from "./GitOperations.js";
import { DiskWorktree } from "./DiskWorktree.js";
import type { DiskDirectory } from "./DiskDirectory.js";
import type { DiskSandbox } from "./DiskSandbox.js";

/**
 * Disk-based implementation of BareRepository.
 */
export class DiskBareRepository implements BareRepository {
  readonly kind = "bare-repository" as const;
  private git: GitOperations;

  constructor(
    readonly name: string,
    readonly path: string,
    readonly url: string | null,
    private sandbox: DiskSandbox
  ) {
    this.git = new GitOperations(path, sandbox.gitCoordination);
  }

  // ========================================
  // Worktree Operations
  // ========================================

  async createWorktree(
    into: Directory,
    name: string,
    branch: string
  ): Promise<Worktree> {
    const intoDir = into as DiskDirectory;
    const worktreePath = join(intoDir.path, name);

    await this.git.worktreeAdd(worktreePath, branch);

    return new DiskWorktree(
      name,
      worktreePath,
      branch,
      this,
      this.sandbox
    );
  }

  async createSparseWorktree(
    into: Directory,
    name: string,
    branch: string,
    subdir: string
  ): Promise<Worktree> {
    const intoDir = into as DiskDirectory;
    const worktreePath = join(intoDir.path, name);

    // Add the worktree without checking out any files
    await this.git.worktreeAddNoCheckout(worktreePath, branch);

    // Configure sparse-checkout inside the new worktree
    const wtGit = new GitOperations(worktreePath, this.sandbox.gitCoordination);
    await wtGit.sparseCheckoutSet(subdir);

    return new DiskWorktree(
      name,
      worktreePath,
      branch,
      this,
      this.sandbox
    );
  }

  async worktrees(): Promise<Worktree[]> {
    const worktreeList = await this.git.worktreeList();
    return worktreeList.map(({ path, branch }) => {
      const name = basename(path);
      return new DiskWorktree(name, path, branch, this, this.sandbox);
    });
  }

  async removeWorktree(worktree: Worktree): Promise<void> {
    const wt = worktree as DiskWorktree;
    await this.git.worktreeRemove(wt.path);
  }

  async pruneWorktrees(): Promise<void> {
    await this.git.worktreePrune();
  }

  async branches(): Promise<string[]> {
    return this.git.branches();
  }

  async createBranchIfMissing(name: string, ref: string): Promise<void> {
    await this.git.createBranchIfMissing(name, ref);
  }

  async updateBranch(name: string, target: string): Promise<void> {
    await this.git.branchForceReset(name, target);
  }

  async updateBranchIfUnchanged(name: string, target: string, expected: string): Promise<boolean> {
    return this.git.updateRefIfUnchanged(name, target, expected);
  }

  async resolveLocalRef(name: string): Promise<string | null> {
    const loose = await this.readLooseRef(name);
    if (loose !== null) return loose;
    return this.readPackedRef(name);
  }

  private async readLooseRef(name: string): Promise<string | null> {
    for (const prefix of ["refs/heads/", "refs/remotes/"]) {
      try {
        const content = await fs.readFile(join(this.path, prefix + name), "utf8");
        const hash = content.trim();
        if (hash) return hash;
      } catch {
        // Not present under this prefix — try the next one.
      }
    }
    return null;
  }

  private async readPackedRef(name: string): Promise<string | null> {
    let content: string;
    try {
      content = await fs.readFile(join(this.path, "packed-refs"), "utf8");
    } catch {
      return null;
    }

    const candidates = [`refs/heads/${name}`, `refs/remotes/${name}`];
    for (const line of content.split("\n")) {
      if (!line || line.startsWith("#") || line.startsWith("^")) continue;
      const spaceIndex = line.indexOf(" ");
      if (spaceIndex === -1) continue;
      const hash = line.slice(0, spaceIndex);
      const ref = line.slice(spaceIndex + 1).trim();
      if (candidates.includes(ref)) return hash;
    }
    return null;
  }

  async fetch(force = false): Promise<void> {
    await this.git.fetch(force);
  }

  async pushBranch(name: string): Promise<void> {
    await this.git.pushBranch(name);
  }

  async normalizeLocalBranches(): Promise<string[]> {
    return this.git.normalizeLocalBranches();
  }

  async getMovementBase(branch: string): Promise<string | null> {
    return this.git.getMovementBase(branch);
  }

  async setMovementBase(branch: string, base: string | null): Promise<void> {
    await this.git.setMovementBase(branch, base);
  }

  /**
   * Exposes the `GitOperations` instance rooted at this bare repository's own
   * path — used by the Disk `Trunk`/`Movement`/`Mirror` sandbox-layer
   * adapters (see docs/design/movement-trunk-safety-redesign.md §4.1) for
   * plumbing-only operations that don't need any worktree (`commitTree`,
   * `mergeBaseIsAncestor`, `pushRefCas`, `fetchRef`). Not part of the public
   * `BareRepository` interface — internal to the disk adapter package.
   * @internal
   */
  getGit(): GitOperations {
    return this.git;
  }

  /**
   * Exposes the shared `GitCoordinationState` this repo's `GitOperations`
   * instances were constructed with — used by the Disk `Movement.merge()`/
   * `Mirror.apply()` implementations to drive `publishWithRetry`'s
   * generation-coalesced fetch-on-rejection loop (design doc §3).
   * @internal
   */
  getCoordination(): GitCoordinationState {
    return this.sandbox.gitCoordination;
  }

  async delete(): Promise<void> {
    // Remove all worktrees first
    const worktreeList = await this.worktrees();
    for (const worktree of worktreeList) {
      await this.removeWorktree(worktree);
    }
    // Remove the bare repository
    await fs.rm(this.path, { recursive: true, force: true });
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

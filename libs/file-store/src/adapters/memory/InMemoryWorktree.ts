/**
 * In-Memory Worktree Implementation (OO Port)
 *
 * Implements the Worktree interface with narrowed child types.
 * Directories within a worktree are also Worktree objects.
 */

import type {
  Worktree,
  WorktreeChild,
  WorktreeChildResult,
  DirectoryLike,
  File,
  Junction,
  BareRepository,
  MergeResult,
  MergeOptions,
  RebaseResult,
  RebaseOptions,
  NodeKind,
  CommitInfo,
  GitRef,
} from "../../port/types.js";
import type { SandboxStorage, InMemorySandbox } from "./InMemorySandbox.js";
import type { InMemoryBareRepository } from "./InMemoryBareRepository.js";
import type { SimulatedGit } from "./SimulatedGit.js";
import { InMemoryFile } from "./InMemoryFile.js";
import { InMemoryJunction } from "./InMemoryJunction.js";
import { globMatch } from "../../utils/globMatch.js";
import { touchFile } from "./fakeClock.js";

function normalizeCone(subdir: string): string {
  return subdir.replace(/^\/+|\/+$/g, "");
}

/**
 * Cone-mode sparse-checkout visibility for a file, given its path relative
 * to the worktree root. Mirrors `git sparse-checkout set --cone <cone>`:
 * top-level files are always checked out; everything else must be inside
 * (or equal to) the cone.
 */
function isFileVisibleInCone(relPath: string, cone: string): boolean {
  if (!relPath.includes("/")) return true;
  return relPath === cone || relPath.startsWith(`${cone}/`);
}

/**
 * Cone-mode sparse-checkout visibility for a directory: visible if it IS
 * the cone, is an ancestor directory on the path down to the cone (needed
 * for traversal), or is nested inside the cone.
 */
function isDirVisibleInCone(relPath: string, cone: string): boolean {
  return relPath === cone || cone.startsWith(`${relPath}/`) || relPath.startsWith(`${cone}/`);
}

/**
 * In-memory implementation of Worktree.
 *
 * Key differences from Directory:
 * - createDirectory() returns Worktree, not Directory
 * - children() returns only WorktreeChild types (File | Worktree | Junction)
 * - Has git operations (commitAll, push, pull, etc.)
 */
export class InMemoryWorktree implements Worktree {
  readonly kind = "worktree" as const;
  readonly repository: BareRepository;
  private worktreeRoot: string;
  private relativePath: string;
  /**
   * The branch this worktree is checked out to. Mutable (unlike the
   * constructor param it starts from) because `switchBranch()` can change it
   * at runtime — `currentBranch`/`workingTree` in `SimulatedGit` are shared
   * per bare repo across every worktree built on it (unlike real git, where
   * each worktree has its own independent HEAD), so operations like
   * `isDirty()` that need *this* worktree's own branch (not whichever
   * worktree last touched the shared state) read this field instead.
   */
  branch: string;
  /** Per-worktree trunk override — mirrors the real adapter's `git config --worktree` persistence. */
  private baseBranchOverride: string | null = null;
  /** Tracks a rebase left in progress by a conflicting rebase()/continueRebase() call, and what it was rebasing onto (for continueRebase() to retry). */
  private pendingRebaseOnto: string | null = null;

  constructor(
    readonly name: string,
    worktreeRoot: string,
    initialBranch: string,
    private bareRepo: InMemoryBareRepository,
    private git: SimulatedGit,
    private storage: SandboxStorage,
    private sandbox: InMemorySandbox,
    relativePath = "" // Relative path within the worktree
  ) {
    this.branch = initialBranch;
    this.repository = bareRepo;
    this.worktreeRoot = worktreeRoot;
    this.relativePath = relativePath;
  }

  /**
   * The full path of this worktree or subdirectory.
   */
  get path(): string {
    return this.relativePath
      ? `${this.worktreeRoot}/${this.relativePath}`
      : this.worktreeRoot;
  }

  // ========================================
  // Directory Operations (Narrowed to WorktreeChild)
  // ========================================

  async child(name: string): Promise<WorktreeChildResult> {
    const childRelPath = this.relativePath
      ? `${this.relativePath}/${name}`
      : name;
    const childFullPath = `${this.worktreeRoot}/${childRelPath}`;
    const cone = this.storage.sparseCones.get(this.worktreeRoot);

    // Check if it's in the sandbox storage (this worktree's actual files —
    // committed or not; `storage.files` is the single source of truth, see
    // the class doc)
    if (this.storage.files.has(childFullPath) && (!cone || isFileVisibleInCone(childRelPath, cone))) {
      return {
        found: true,
        node: new InMemoryFile(name, childFullPath, this.storage),
      };
    }

    // Check if it's a junction
    const junctionTarget = this.storage.junctions.get(childFullPath);
    if (junctionTarget !== undefined) {
      const targetPath = junctionTarget;
      return {
        found: true,
        node: new InMemoryJunction(
          name,
          childFullPath,
          targetPath,
          this.storage,
          this.sandbox
        ),
      };
    }

    // Check if it's a subdirectory (also a Worktree)
    if (this.storage.directories.has(childFullPath) && (!cone || isDirVisibleInCone(childRelPath, cone))) {
      return {
        found: true,
        node: new InMemoryWorktree(
          name,
          this.worktreeRoot,
          this.branch,
          this.bareRepo,
          this.git,
          this.storage,
          this.sandbox,
          childRelPath
        ),
      };
    }

    // Check if we have any files or subdirs starting with this path
    const prefix = childFullPath + "/";
    if (!cone || isDirVisibleInCone(childRelPath, cone)) {
      for (const path of this.storage.files.keys()) {
        if (path.startsWith(prefix)) {
          // Virtual directory exists
          this.storage.directories.add(childFullPath);
          return {
            found: true,
            node: new InMemoryWorktree(
              name,
              this.worktreeRoot,
              this.branch,
              this.bareRepo,
              this.git,
              this.storage,
              this.sandbox,
              childRelPath
            ),
          };
        }
      }
    }

    return {
      found: false,
      name,
      parent: this,
    };
  }

  async children(): Promise<WorktreeChild[]> {
    const results: WorktreeChild[] = [];
    const fullPrefix = this.path ? `${this.path}/` : `${this.worktreeRoot}/`;
    const prefixLen = fullPrefix.length;
    const seen = new Set<string>();
    const cone = this.storage.sparseCones.get(this.worktreeRoot);
    const relFromRoot = (name: string) => this.relativePath ? `${this.relativePath}/${name}` : name;

    // Find direct child files from storage, and direct child directories
    // that exist only through deeper file paths (a checkout copies files
    // without registering intermediate directories, matching how git
    // materializes them implicitly)
    for (const filePath of this.storage.files.keys()) {
      if (filePath.startsWith(fullPrefix)) {
        const remaining = filePath.slice(prefixLen);
        const name = remaining.split("/")[0];
        if (seen.has(name)) continue;
        if (!remaining.includes("/")) {
          if (!cone || isFileVisibleInCone(relFromRoot(name), cone)) {
            seen.add(name);
            results.push(new InMemoryFile(name, filePath, this.storage));
          }
        } else if (!cone || isDirVisibleInCone(relFromRoot(name), cone)) {
          seen.add(name);
          this.storage.directories.add(`${fullPrefix}${name}`);
          results.push(
            new InMemoryWorktree(
              name,
              this.worktreeRoot,
              this.branch,
              this.bareRepo,
              this.git,
              this.storage,
              this.sandbox,
              relFromRoot(name)
            )
          );
        }
      }
    }

    // Find direct child junctions
    for (const [junctionPath, targetPath] of this.storage.junctions) {
      if (junctionPath.startsWith(fullPrefix)) {
        const remaining = junctionPath.slice(prefixLen);
        if (!remaining.includes("/") && !seen.has(remaining)) {
          seen.add(remaining);
          results.push(
            new InMemoryJunction(
              remaining,
              junctionPath,
              targetPath,
              this.storage,
              this.sandbox
            )
          );
        }
      }
    }

    // Find direct child subdirectories (as Worktree)
    for (const dirPath of this.storage.directories) {
      if (dirPath.startsWith(fullPrefix) && dirPath !== this.path) {
        const remaining = dirPath.slice(prefixLen);
        const name = remaining.split("/")[0];
        if (
          !remaining.includes("/") &&
          !seen.has(name) &&
          (!cone || isDirVisibleInCone(relFromRoot(name), cone))
        ) {
          seen.add(name);
          const childRelPath = relFromRoot(name);
          results.push(
            new InMemoryWorktree(
              name,
              this.worktreeRoot,
              this.branch,
              this.bareRepo,
              this.git,
              this.storage,
              this.sandbox,
              childRelPath
            )
          );
        }
      }
    }

    return results;
  }

  async glob(pattern: string, exclude: string[] = []): Promise<WorktreeChild[]> {
    const results: WorktreeChild[] = [];
    const fullPrefix = this.path ? `${this.path}/` : `${this.worktreeRoot}/`;
    const cone = this.storage.sparseCones.get(this.worktreeRoot);
    const excludeSet = new Set(exclude);
    // A path is pruned if any of its directory segments (excluding the
    // final component itself) is in the exclude set, or if it's the
    // .git directory — mirrors not descending into an excluded directory.
    const isPruned = (relativePath: string): boolean => {
      const segments = relativePath.split("/");
      if (segments[0] === ".git") return true;
      if (excludeSet.size === 0) return false;
      return segments.slice(0, -1).some((segment) => excludeSet.has(segment));
    };

    // Match files
    for (const filePath of this.storage.files.keys()) {
      if (filePath.startsWith(fullPrefix)) {
        const relativePath = filePath.slice(fullPrefix.length);
        const relFromRoot = this.relativePath ? `${this.relativePath}/${relativePath}` : relativePath;
        if (
          !isPruned(relativePath) &&
          (!cone || isFileVisibleInCone(relFromRoot, cone)) &&
          globMatch(pattern, relativePath)
        ) {
          results.push(new InMemoryFile(relativePath, filePath, this.storage));
        }
      }
    }

    return results;
  }

  async exists(): Promise<boolean> {
    return this.storage.directories.has(this.path);
  }

  // ========================================
  // Creation Operations
  // ========================================

  async createFile(name: string, content?: string): Promise<File> {
    const childRelPath = this.relativePath
      ? `${this.relativePath}/${name}`
      : name;
    const filePath = `${this.worktreeRoot}/${childRelPath}`;

    // Handle deep paths
    const parts = name.split("/");
    if (parts.length > 1) {
      let currentPath = this.path;
      for (let i = 0; i < parts.length - 1; i++) {
        currentPath = `${currentPath}/${parts[i]}`;
        this.storage.directories.add(currentPath);
      }
    }

    this.storage.files.set(filePath, content ?? "");
    touchFile(this.storage, filePath);

    return new InMemoryFile(name, filePath, this.storage);
  }

  async createDirectory(name: string): Promise<Worktree> {
    const childRelPath = this.relativePath
      ? `${this.relativePath}/${name}`
      : name;
    const dirPath = `${this.worktreeRoot}/${childRelPath}`;

    this.storage.directories.add(dirPath);

    return new InMemoryWorktree(
      name,
      this.worktreeRoot,
      this.branch,
      this.bareRepo,
      this.git,
      this.storage,
      this.sandbox,
      childRelPath
    );
  }

  async createJunction(name: string, target: DirectoryLike): Promise<Junction> {
    const junctionPath = `${this.path}/${name}`;
    // Cast to access the path property which exists on all our implementations
    const targetPath = (target as unknown as { path: string }).path;
    this.storage.junctions.set(junctionPath, targetPath);
    return new InMemoryJunction(
      name,
      junctionPath,
      targetPath,
      this.storage,
      this.sandbox
    );
  }

  async deleteChild(name: string, recursive = false): Promise<void> {
    const childPath = `${this.path}/${name}`;

    // Delete file
    if (this.storage.files.has(childPath)) {
      this.storage.files.delete(childPath);
      return;
    }

    // Delete junction
    if (this.storage.junctions.has(childPath)) {
      this.storage.junctions.delete(childPath);
      return;
    }

    // Delete directory
    if (this.storage.directories.has(childPath)) {
      if (recursive) {
        const prefix = `${childPath}/`;
        for (const filePath of this.storage.files.keys()) {
          if (filePath.startsWith(prefix)) {
            this.storage.files.delete(filePath);
          }
        }
        for (const dirPath of this.storage.directories) {
          if (dirPath.startsWith(prefix) || dirPath === childPath) {
            this.storage.directories.delete(dirPath);
          }
        }
      } else {
        this.storage.directories.delete(childPath);
      }
    }
  }

  // ========================================
  // Git Operations
  // ========================================

  async commitAll(message: string, _options?: { noVerify?: boolean }): Promise<string> {
    // Simulated git has no hook concept — noVerify is a no-op here, accepted
    // only so callers can pass the same options to either Worktree adapter.
    return this.git.commitAll(this.branch, this.computeWorkingTree(), message);
  }

  async push(): Promise<void> {
    this.git.push();
  }

  async pushWithTracking(setUpstream = false): Promise<void> {
    this.git.pushWithSetUpstream(setUpstream);
  }

  async forcePush(): Promise<void> {
    this.git.forcePush();
  }

  async pull(): Promise<void> {
    this.git.pull();
  }

  async fetch(_force = false): Promise<void> {
    this.git.fetch();
  }

  async currentBranch(): Promise<string> {
    return this.branch;
  }

  async switchBranch(branch: string): Promise<void> {
    this.git.ensureBranch(branch);
    this.branch = branch;
    this.loadTreeFrom(this.git.getTree(branch));
  }

  async branches(): Promise<string[]> {
    return this.git.getBranches();
  }

  async baseBranch(): Promise<string> {
    if (this.baseBranchOverride) return this.baseBranchOverride;
    // The in-memory simulation initializes its default branch as "main".
    return "main";
  }

  async setBaseBranch(branch: string | null): Promise<void> {
    this.baseBranchOverride = branch;
  }

  async merge(branch: string, options?: MergeOptions): Promise<MergeResult> {
    const outcome = this.git.merge(this.branch, this.computeWorkingTree(), branch, options?.message);
    if (outcome.result.status === "success") {
      this.loadTreeFrom(outcome.tree);
    }
    return outcome.result;
  }

  async rebase(onto: string, options?: RebaseOptions): Promise<RebaseResult> {
    if (options?.autostash) {
      // Save working tree files before rebase (simulates git stash)
      const savedFiles = new Map<string, string>();
      const prefix = `${this.worktreeRoot}/`;
      for (const [filePath, content] of this.storage.files) {
        if (filePath.startsWith(prefix)) {
          savedFiles.set(filePath, content);
        }
      }

      const outcome = this.git.rebase(this.branch, onto);
      this.pendingRebaseOnto = outcome.result.status === "conflict" ? onto : null;
      if (outcome.result.status === "success") {
        if (outcome.tree) this.loadTreeFrom(outcome.tree);
        // Re-apply saved files (simulates git stash pop)
        for (const [filePath, content] of savedFiles) {
          this.storage.files.set(filePath, content);
        }
      }
      return outcome.result;
    }

    const outcome = this.git.rebase(this.branch, onto);
    this.pendingRebaseOnto = outcome.result.status === "conflict" ? onto : null;
    if (outcome.result.status === "success" && outcome.tree) {
      this.loadTreeFrom(outcome.tree);
    }
    return outcome.result;
  }

  async hasInProgressRebase(): Promise<boolean> {
    return this.pendingRebaseOnto !== null;
  }

  /**
   * Clears any in-progress rebase state without resolving it — mirrors real
   * git's `rebase --abort` (see the `Worktree.abortRebase()` port doc for
   * the production recovery path this backs: `MovementManager.mergeMovement`
   * aborting and restarting a rebase whose halt is neither a real conflict
   * nor a known-safe retryable one). Also used internally by
   * `InMemoryDerivedTrunk.beginAdvance()`'s `AdvanceAttempt.abandon()`/
   * `dispose()` (design doc §4.4) so a borrowed `resolveIn` worktree doesn't
   * carry stale `pendingRebaseOnto` state into whatever it's checked out on
   * next.
   */
  async abortRebase(): Promise<void> {
    this.pendingRebaseOnto = null;
  }

  /**
   * Simulated continue: re-attempts the rebase against the same `onto`
   * remembered from the conflicting call. Tests simulate "the agent fixed
   * the conflict" by calling `SimulatedGit.setSimulatedRebaseConflict(false)`
   * (or similar) between the conflicting rebase() and this call.
   */
  async continueRebase(): Promise<RebaseResult> {
    if (this.pendingRebaseOnto === null) return { status: "success" };
    const onto = this.pendingRebaseOnto;
    const outcome = this.git.rebase(this.branch, onto);
    this.pendingRebaseOnto = outcome.result.status === "conflict" ? onto : null;
    if (outcome.result.status === "success" && outcome.tree) {
      this.loadTreeFrom(outcome.tree);
    }
    return outcome.result;
  }

  async resetTo(ref: string): Promise<void> {
    const tree = this.git.resetTo(this.branch, ref);
    this.loadTreeFrom(tree);
  }

  async setSparseCheckout(subdir: string): Promise<void> {
    // Cone-mode sparse-checkout, simulated by filtering child()/children()/
    // glob() to the cone (see isFileVisibleInCone/isDirVisibleInCone). The
    // underlying storage keeps all files regardless — only visibility
    // through this worktree's navigation methods is restricted, matching
    // how git keeps everything in the object database but only checks out
    // the cone into the working directory.
    this.storage.sparseCones.set(this.worktreeRoot, normalizeCone(subdir));
  }

  async updateBranch(name: string, target: string): Promise<void> {
    this.git.updateBranch(name, target);
  }

  async pushBranch(name: string): Promise<void> {
    // Real git has no worktree-vs-bare-repo distinction for push — it always
    // affects the remote. Delegate to the repository-level push (which does
    // simulate a remote) so worktree-driven publish flows are actually
    // observable by a later fetch, matching the disk adapter's behavior.
    await this.repository.pushBranch(name);
  }

  async forcePushBranch(name: string): Promise<void> {
    // BareRepository.pushBranch is already unconditional (no fast-forward
    // check) in this simulation, so force-push has the same effect here.
    await this.repository.pushBranch(name);
  }

  async commitTree(treeSource: string, parents: string[], message: string): Promise<string> {
    return this.git.commitTree(treeSource, parents, message);
  }

  async log(from: string, to: string): Promise<CommitInfo[]> {
    return this.git.log(this.resolveHead(from), this.resolveHead(to));
  }

  async diff(from: string, to: string): Promise<string> {
    return this.git.diff(this.resolveHead(from), this.resolveHead(to));
  }

  async changedFiles(from: string, to: string): Promise<string[]> {
    return this.git.changedFiles(this.resolveHead(from), this.resolveHead(to));
  }

  async readFileAtRef(ref: GitRef, path: string): Promise<string | null> {
    const relPath = this.relativePath ? `${this.relativePath}/${path}` : path;
    return this.git.readFileAtRef(this.resolveHead(ref) as GitRef, relPath);
  }

  async isDirty(): Promise<boolean> {
    return this.git.isDirty(this.branch, this.computeWorkingTree());
  }

  async hasGitDirectory(): Promise<boolean> {
    const gitPath = `${this.path}/.git`;
    // In memory worktrees, .git can be a directory or represented as a file path
    return this.storage.directories.has(gitPath) || this.storage.files.has(gitPath);
  }

  // ========================================
  // Pattern Matching
  // ========================================

  match<T>(cases: { worktree: (w: Worktree) => T }): T {
    return cases.worktree(this);
  }

  is(kind: "worktree"): this is Worktree;
  is(kind: NodeKind): boolean;
  is(kind: NodeKind): boolean {
    return kind === "worktree";
  }

  isDirectoryLike(): boolean {
    return true;
  }

  // ========================================
  // Internal Helpers
  // ========================================

  /**
   * Replaces this worktree's checked-out files with exactly `tree` (or
   * empties it, if `tree` is undefined) — used whenever this worktree's
   * files need to reflect a branch's committed content: after
   * `switchBranch`/`resetTo`/a successful `merge`/`rebase`. Mirrors how the
   * disk adapter's equivalent cases run a real git checkout/reset in that
   * worktree, which updates its files directly.
   * @internal
   */
  loadTreeFrom(tree: ReadonlyMap<string, string> | undefined): void {
    const prefix = `${this.worktreeRoot}/`;
    for (const filePath of this.storage.files.keys()) {
      if (filePath.startsWith(prefix)) {
        this.storage.files.delete(filePath);
      }
    }
    if (tree) {
      for (const [relPath, content] of tree) {
        this.storage.files.set(`${this.worktreeRoot}/${relPath}`, content);
      }
    }
  }

  /**
   * This worktree's current file state as a relative-path map — what
   * `SimulatedGit`'s worktree-scoped operations (`commitAll`, `isDirty`,
   * `merge`) need as their explicit "working tree" input, computed fresh
   * from `storage.files` (the single source of truth for this worktree's
   * actual files) rather than read from any state shared with other
   * worktrees. See the `SimulatedGit` class doc for why it takes this as a
   * parameter instead of owning it.
   */
  private computeWorkingTree(): Map<string, string> {
    const prefix = `${this.worktreeRoot}/`;
    const tree = new Map<string, string>();
    for (const [filePath, content] of this.storage.files) {
      if (filePath.startsWith(prefix)) {
        tree.set(filePath.slice(prefix.length), content);
      }
    }
    return tree;
  }

  /**
   * Resolves the literal ref `"HEAD"` to this worktree's own current branch
   * — `SimulatedGit` has no notion of HEAD (see its class doc), since real
   * git's HEAD is per-worktree; every other ref passes through unchanged.
   */
  private resolveHead(ref: string): string {
    return ref === "HEAD" ? this.branch : ref;
  }
}

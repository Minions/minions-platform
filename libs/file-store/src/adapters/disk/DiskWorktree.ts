/**
 * Disk Worktree Implementation
 *
 * Implements the Worktree interface using real filesystem and git operations.
 * Directories within a worktree are also Worktree objects.
 */

import { promises as fs } from "fs";
import { join } from "path";
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
import { GitOperations } from "./GitOperations.js";
import { DiskFile } from "./DiskFile.js";
import type { DiskBareRepository } from "./DiskBareRepository.js";
import type { DiskSandbox } from "./DiskSandbox.js";

// Forward declaration for DiskJunction
let DiskJunction: typeof import("./DiskJunction.js").DiskJunction;

async function getDiskJunction() {
  if (!DiskJunction) {
    const mod = await import("./DiskJunction.js");
    DiskJunction = mod.DiskJunction;
  }
  return DiskJunction;
}

/**
 * Disk-based implementation of Worktree.
 *
 * Key differences from Directory:
 * - createDirectory() returns Worktree, not Directory
 * - children() returns only WorktreeChild types (File | Worktree | Junction)
 * - Has git operations (commitAll, push, pull, etc.)
 */
export class DiskWorktree implements Worktree {
  readonly kind = "worktree" as const;
  readonly repository: BareRepository;
  private git: GitOperations;
  private worktreeRoot: string;

  constructor(
    readonly name: string,
    readonly path: string,
    readonly branch: string,
    private bareRepo: DiskBareRepository,
    private sandbox: DiskSandbox,
    worktreeRoot?: string // The root of the worktree for git operations
  ) {
    this.repository = bareRepo;
    this.worktreeRoot = worktreeRoot ?? path;
    // Git operations always run from the worktree root
    this.git = new GitOperations(this.worktreeRoot, sandbox.gitCoordination);
  }

  /**
   * Exposes this worktree's own `GitOperations` instance — used by the Disk
   * `DerivedTrunk.advance()` implementation (design doc §4.4) to run a
   * merge-preserving `rebase --rebase-merges` non-interactively via a
   * detached-HEAD checkout in the caller's borrowed (`resolveIn`) worktree.
   * Not part of the public `Worktree` interface; internal to the disk
   * adapter package, same pattern as `DiskBareRepository.getGit()`.
   * @internal
   */
  getGit(): GitOperations {
    return this.git;
  }

  // ========================================
  // Directory Operations (Narrowed to WorktreeChild)
  // ========================================

  async child(name: string): Promise<WorktreeChildResult> {
    const childPath = join(this.path, name);

    try {
      const stat = await fs.lstat(childPath);

      if (stat.isSymbolicLink()) {
        const targetPath = await fs.readlink(childPath);
        const Junction = await getDiskJunction();
        return {
          found: true,
          node: new Junction(name, childPath, targetPath, this.sandbox),
        };
      }

      if (stat.isDirectory()) {
        // Skip .git directory
        if (name === ".git") {
          return { found: false, name, parent: this };
        }
        return {
          found: true,
          node: new DiskWorktree(
            name,
            childPath,
            this.branch,
            this.bareRepo,
            this.sandbox,
            this.worktreeRoot
          ),
        };
      }

      if (stat.isFile()) {
        return {
          found: true,
          node: new DiskFile(name, childPath),
        };
      }

      return { found: false, name, parent: this };
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return { found: false, name, parent: this };
      }
      throw e;
    }
  }

  async children(): Promise<WorktreeChild[]> {
    const results: WorktreeChild[] = [];

    try {
      const entries = await fs.readdir(this.path, { withFileTypes: true });

      for (const entry of entries) {
        // Skip .git directory
        if (entry.name === ".git") continue;

        const childPath = join(this.path, entry.name);

        if (entry.isSymbolicLink()) {
          const targetPath = await fs.readlink(childPath);
          const Junction = await getDiskJunction();
          results.push(new Junction(entry.name, childPath, targetPath, this.sandbox));
        } else if (entry.isDirectory()) {
          results.push(
            new DiskWorktree(
              entry.name,
              childPath,
              this.branch,
              this.bareRepo,
              this.sandbox,
              this.worktreeRoot
            )
          );
        } else if (entry.isFile()) {
          results.push(new DiskFile(entry.name, childPath));
        }
      }
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw e;
      }
    }

    return results;
  }

  async glob(pattern: string, exclude: string[] = []): Promise<WorktreeChild[]> {
    const { globMatch } = await import("../../utils/globMatch.js");
    const excludeSet = new Set(exclude);
    const results: WorktreeChild[] = [];

    const walkDir = async (dir: string, relativePath: string): Promise<void> => {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          // Skip .git directory
          if (entry.name === ".git") continue;
          if (excludeSet.has(entry.name)) continue;

          const entryPath = join(dir, entry.name);
          const entryRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;

          if (entry.isSymbolicLink()) {
            if (globMatch(pattern, entryRelative)) {
              const targetPath = await fs.readlink(entryPath);
              const Junction = await getDiskJunction();
              results.push(new Junction(entryRelative, entryPath, targetPath, this.sandbox));
            }
          } else if (entry.isDirectory()) {
            if (globMatch(pattern, entryRelative)) {
              results.push(
                new DiskWorktree(
                  entryRelative,
                  entryPath,
                  this.branch,
                  this.bareRepo,
                  this.sandbox,
                  this.worktreeRoot
                )
              );
            }
            // Recurse for ** patterns
            if (pattern.includes("**")) {
              await walkDir(entryPath, entryRelative);
            }
          } else if (entry.isFile()) {
            if (globMatch(pattern, entryRelative)) {
              results.push(new DiskFile(entryRelative, entryPath));
            }
          }
        }
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          throw e;
        }
      }
    };

    await walkDir(this.path, "");
    return results;
  }

  async exists(): Promise<boolean> {
    try {
      const stat = await fs.stat(this.path);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  // ========================================
  // Creation Operations
  // ========================================

  async createFile(name: string, content?: string): Promise<File> {
    const filePath = join(this.path, name);
    const file = new DiskFile(name, filePath);
    await file.write(content ?? "");
    return file;
  }

  async createDirectory(name: string): Promise<Worktree> {
    const dirPath = join(this.path, name);
    await fs.mkdir(dirPath, { recursive: true });
    return new DiskWorktree(
      name,
      dirPath,
      this.branch,
      this.bareRepo,
      this.sandbox,
      this.worktreeRoot
    );
  }

  async createJunction(name: string, target: DirectoryLike): Promise<Junction> {
    const junctionPath = join(this.path, name);
    const targetDir = target as unknown as { path: string };

    if (process.platform === "win32") {
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
      const execAsync = promisify(exec);
      await execAsync(`mklink /J "${junctionPath}" "${targetDir.path}"`);
    } else {
      await fs.symlink(targetDir.path, junctionPath, "dir");
    }

    const Junction = await getDiskJunction();
    return new Junction(name, junctionPath, targetDir.path, this.sandbox);
  }

  async deleteChild(name: string, recursive = false): Promise<void> {
    const childPath = join(this.path, name);

    try {
      const stat = await fs.lstat(childPath);

      if (stat.isSymbolicLink()) {
        if (process.platform === "win32") {
          await fs.rmdir(childPath);
        } else {
          await fs.unlink(childPath);
        }
      } else if (stat.isDirectory()) {
        if (recursive) {
          await fs.rm(childPath, { recursive: true, force: true });
        } else {
          await fs.rmdir(childPath);
        }
      } else if (stat.isFile()) {
        await fs.unlink(childPath);
      }
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw e;
      }
    }
  }

  // ========================================
  // Git Operations
  // ========================================

  async commitAll(message: string, options?: { noVerify?: boolean }): Promise<string> {
    return this.git.commitAll(message, options);
  }

  async push(): Promise<void> {
    await this.git.push();
  }

  async pushWithTracking(setUpstream = false): Promise<void> {
    await this.git.pushWithSetUpstream(setUpstream);
  }

  async forcePush(): Promise<void> {
    await this.git.forcePush();
  }

  async pull(): Promise<void> {
    await this.git.pull();
  }

  async fetch(force = false): Promise<void> {
    await this.git.fetch(force);
  }

  async currentBranch(): Promise<string> {
    return this.git.currentBranch();
  }

  async switchBranch(branch: string): Promise<void> {
    await this.git.switchBranch(branch);
  }

  async branches(): Promise<string[]> {
    return this.git.branches();
  }

  async baseBranch(): Promise<string> {
    return this.git.baseBranch();
  }

  async setBaseBranch(branch: string | null): Promise<void> {
    await this.git.setBaseBranch(branch);
  }

  async merge(branch: string, options?: MergeOptions): Promise<MergeResult> {
    return this.git.merge(branch, options?.message);
  }

  async rebase(onto: string, options?: RebaseOptions): Promise<RebaseResult> {
    return this.git.rebase(onto, options);
  }

  async hasInProgressRebase(): Promise<boolean> {
    return this.git.hasInProgressRebase();
  }

  async continueRebase(): Promise<RebaseResult> {
    return this.git.continueRebase();
  }

  async abortRebase(): Promise<void> {
    await this.git.abortRebase();
  }

  async resetTo(ref: string): Promise<void> {
    await this.git.resetTo(ref);
  }

  async setSparseCheckout(subdir: string): Promise<void> {
    await this.git.sparseCheckoutSet(subdir);
  }

  async updateBranch(name: string, target: string): Promise<void> {
    await this.git.branchForceReset(name, target);
  }

  async pushBranch(name: string): Promise<void> {
    await this.git.pushBranch(name);
  }

  async forcePushBranch(name: string): Promise<void> {
    await this.git.forcePushBranch(name);
  }

  async commitTree(treeSource: string, parents: string[], message: string): Promise<string> {
    return this.git.commitTree(treeSource, parents, message);
  }

  async log(from: string, to: string): Promise<CommitInfo[]> {
    return this.git.log(from, to);
  }

  async diff(from: string, to: string): Promise<string> {
    return this.git.diff(from, to);
  }

  async changedFiles(from: string, to: string): Promise<string[]> {
    return this.git.changedFiles(from, to);
  }

  async readFileAtRef(ref: GitRef, path: string): Promise<string | null> {
    return this.git.readFileAtRef(ref, path);
  }

  async isDirty(): Promise<boolean> {
    return this.git.isDirty();
  }

  async hasGitDirectory(): Promise<boolean> {
    try {
      const gitPath = join(this.path, ".git");
      const stat = await fs.stat(gitPath);
      // Worktrees have a .git file (not directory) pointing to the main repo
      // Return true if it's either a file or directory
      return stat.isDirectory() || stat.isFile();
    } catch {
      return false;
    }
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
}

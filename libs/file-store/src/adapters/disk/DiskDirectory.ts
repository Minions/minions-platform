/**
 * Disk Directory Implementation
 *
 * Implements the Directory interface using real filesystem operations.
 */

import { promises as fs } from "fs";
import { join, basename } from "path";
import type {
  Directory,
  DirectoryChild,
  DirectoryChildResult,
  DirectoryLike,
  File,
  Junction,
  NodeKind,
} from "../../port/types.js";
import { DiskFile } from "./DiskFile.js";
import type { DiskSandbox } from "./DiskSandbox.js";

// Forward declarations to avoid circular dependencies
let DiskJunction: typeof import("./DiskJunction.js").DiskJunction;
let DiskBareRepository: typeof import("./DiskBareRepository.js").DiskBareRepository;
let DiskWorktree: typeof import("./DiskWorktree.js").DiskWorktree;
let DiskReadOnlyClone: typeof import("./DiskReadOnlyClone.js").DiskReadOnlyClone;

async function getDiskJunction() {
  if (!DiskJunction) {
    const mod = await import("./DiskJunction.js");
    DiskJunction = mod.DiskJunction;
  }
  return DiskJunction;
}

async function getDiskBareRepository() {
  if (!DiskBareRepository) {
    const mod = await import("./DiskBareRepository.js");
    DiskBareRepository = mod.DiskBareRepository;
  }
  return DiskBareRepository;
}

async function getDiskWorktree() {
  if (!DiskWorktree) {
    const mod = await import("./DiskWorktree.js");
    DiskWorktree = mod.DiskWorktree;
  }
  return DiskWorktree;
}

async function getDiskReadOnlyClone() {
  if (!DiskReadOnlyClone) {
    const mod = await import("./DiskReadOnlyClone.js");
    DiskReadOnlyClone = mod.DiskReadOnlyClone;
  }
  return DiskReadOnlyClone;
}

/**
 * Disk-based implementation of Directory.
 */
export class DiskDirectory implements Directory {
  readonly kind = "directory" as const;

  constructor(
    readonly name: string,
    readonly path: string,
    protected sandbox: DiskSandbox
  ) {}

  // ========================================
  // Directory Operations
  // ========================================

  async child(name: string): Promise<DirectoryChildResult> {
    const childPath = join(this.path, name);

    try {
      const stat = await fs.lstat(childPath);

      if (stat.isSymbolicLink()) {
        // It's a junction/symlink
        const targetPath = await fs.readlink(childPath);
        const Junction = await getDiskJunction();
        return {
          found: true,
          node: new Junction(name, childPath, targetPath, this.sandbox),
        };
      }

      if (stat.isDirectory()) {
        // On Windows, NTFS junctions appear as directories to lstat(), not symlinks.
        // Try readlink to detect them before the other directory-type checks.
        if (process.platform === "win32") {
          try {
            const targetPath = await fs.readlink(childPath);
            const Junction = await getDiskJunction();
            return {
              found: true,
              node: new Junction(name, childPath, targetPath, this.sandbox),
            };
          } catch {
            // EINVAL = not a junction/symlink; fall through to other checks
          }
        }

        // Check if it's a bare repository (has HEAD file and objects/ directory)
        const isBareRepo = await this.isBareRepository(childPath);
        if (isBareRepo) {
          const BareRepo = await getDiskBareRepository();
          const remoteUrl = await this.getBareRepoRemoteUrl(childPath);
          return {
            found: true,
            node: new BareRepo(name, childPath, remoteUrl, this.sandbox),
          };
        }

        // Check if it's a worktree (has .git file pointing elsewhere)
        const worktreeInfo = await this.getWorktreeInfo(childPath);
        if (worktreeInfo) {
          const Worktree = await getDiskWorktree();
          const BareRepo = await getDiskBareRepository();
          const bareRepoRemoteUrl = await this.getBareRepoRemoteUrl(worktreeInfo.gitDir);
          const bareRepo = new BareRepo(
            basename(worktreeInfo.gitDir),
            worktreeInfo.gitDir,
            bareRepoRemoteUrl,
            this.sandbox
          );
          return {
            found: true,
            node: new Worktree(
              name,
              childPath,
              worktreeInfo.branch,
              bareRepo,
              this.sandbox
            ),
          };
        }

        // Check if it's a read-only clone (has .git directory with remote URL)
        const cloneInfo = await this.getReadOnlyCloneInfo(childPath);
        if (cloneInfo) {
          const ReadOnlyClone = await getDiskReadOnlyClone();
          return {
            found: true,
            node: new ReadOnlyClone(
              name,
              childPath,
              cloneInfo.url,
              cloneInfo.branch,
              this.sandbox
            ),
          };
        }

        return {
          found: true,
          node: new DiskDirectory(name, childPath, this.sandbox),
        };
      }

      if (stat.isFile()) {
        return {
          found: true,
          node: new DiskFile(name, childPath),
        };
      }

      // Unknown type - treat as not found
      return {
        found: false,
        name,
        parent: this,
      };
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          found: false,
          name,
          parent: this,
        };
      }
      throw e;
    }
  }

  async children(): Promise<DirectoryChild[]> {
    const results: DirectoryChild[] = [];

    try {
      const entries = await fs.readdir(this.path, { withFileTypes: true });

      for (const entry of entries) {
        const childPath = join(this.path, entry.name);

        if (entry.isSymbolicLink()) {
          const targetPath = await fs.readlink(childPath);
          const Junction = await getDiskJunction();
          results.push(new Junction(entry.name, childPath, targetPath, this.sandbox));
        } else if (entry.isDirectory()) {
          // On Windows, NTFS junctions appear as directories to readdir(), not symlinks.
          let handledAsJunction = false;
          if (process.platform === "win32") {
            try {
              const targetPath = await fs.readlink(childPath);
              const Junction = await getDiskJunction();
              results.push(new Junction(entry.name, childPath, targetPath, this.sandbox));
              handledAsJunction = true;
            } catch {
              // EINVAL = not a junction/symlink; fall through
            }
          }

          if (!handledAsJunction) {
            // Check if it's a bare repository
            const isBareRepo = await this.isBareRepository(childPath);
            if (isBareRepo) {
              const BareRepo = await getDiskBareRepository();
              const remoteUrl = await this.getBareRepoRemoteUrl(childPath);
              results.push(new BareRepo(entry.name, childPath, remoteUrl, this.sandbox));
            } else {
              // Check if it's a worktree
              const worktreeInfo = await this.getWorktreeInfo(childPath);
              if (worktreeInfo) {
                const Worktree = await getDiskWorktree();
                const BareRepo = await getDiskBareRepository();
                const bareRepoRemoteUrl = await this.getBareRepoRemoteUrl(worktreeInfo.gitDir);
                const bareRepo = new BareRepo(
                  basename(worktreeInfo.gitDir),
                  worktreeInfo.gitDir,
                  bareRepoRemoteUrl,
                  this.sandbox
                );
                results.push(
                  new Worktree(
                    entry.name,
                    childPath,
                    worktreeInfo.branch,
                    bareRepo,
                    this.sandbox
                  )
                );
              } else {
                // Check if it's a read-only clone
                const cloneInfo = await this.getReadOnlyCloneInfo(childPath);
                if (cloneInfo) {
                  const ReadOnlyClone = await getDiskReadOnlyClone();
                  results.push(
                    new ReadOnlyClone(
                      entry.name,
                      childPath,
                      cloneInfo.url,
                      cloneInfo.branch,
                      this.sandbox
                    )
                  );
                } else {
                  results.push(new DiskDirectory(entry.name, childPath, this.sandbox));
                }
              }
            }
          }
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

  async glob(pattern: string, exclude: string[] = []): Promise<DirectoryChild[]> {
    // Import glob matching from memory adapter
    const { globMatch } = await import("../../utils/globMatch.js");
    const excludeSet = new Set(exclude);
    const results: DirectoryChild[] = [];

    const walkDir = async (dir: string, relativePath: string): Promise<void> => {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
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
              results.push(new DiskDirectory(entryRelative, entryPath, this.sandbox));
            }
            // Recurse into subdirectories for ** patterns
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

  async createFile(name: string, content?: string): Promise<File> {
    const filePath = join(this.path, name);
    const file = new DiskFile(name, filePath);
    await file.write(content ?? "");
    return file;
  }

  async createDirectory(name: string): Promise<Directory> {
    const dirPath = join(this.path, name);
    await fs.mkdir(dirPath, { recursive: true });
    return new DiskDirectory(name, dirPath, this.sandbox);
  }

  async createJunction(name: string, target: DirectoryLike): Promise<Junction> {
    const junctionPath = join(this.path, name);
    const targetDir = target as DiskDirectory;

    // Use platform-specific junction creation
    if (process.platform === "win32") {
      // On Windows, use junction
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
      const execAsync = promisify(exec);
      await execAsync(`mklink /J "${junctionPath}" "${targetDir.path}"`);
    } else {
      // On POSIX, use symlink
      await fs.symlink(targetDir.path, junctionPath, "dir");
    }

    const Junction = await getDiskJunction();
    return new Junction(name, junctionPath, targetDir.path, this.sandbox);
  }

  async delete(recursive = false): Promise<void> {
    if (recursive) {
      await fs.rm(this.path, { recursive: true, force: true });
    } else {
      await fs.rmdir(this.path);
    }
  }

  async hasGitDirectory(): Promise<boolean> {
    try {
      const gitPath = join(this.path, ".git");
      const stat = await fs.stat(gitPath);
      return stat.isDirectory();
    } catch {
      return false;
    }
  }

  // ========================================
  // Pattern Matching
  // ========================================

  match<T>(cases: { directory: (d: Directory) => T }): T {
    return cases.directory(this);
  }

  is(kind: "directory"): this is Directory;
  is(kind: NodeKind): boolean;
  is(kind: NodeKind): boolean {
    return kind === "directory";
  }

  isDirectoryLike(): boolean {
    return true;
  }

  // ========================================
  // Internal Helpers
  // ========================================

  private async isBareRepository(path: string): Promise<boolean> {
    try {
      // Bare repos have HEAD file and objects directory at root level
      const headPath = join(path, "HEAD");
      const objectsPath = join(path, "objects");
      const [headStat, objectsStat] = await Promise.all([
        fs.stat(headPath).catch(() => null),
        fs.stat(objectsPath).catch(() => null),
      ]);
      return headStat?.isFile() === true && objectsStat?.isDirectory() === true;
    } catch {
      return false;
    }
  }

  /**
   * Gets worktree information if the path is a worktree.
   * Worktrees have a .git file (not directory) that points to the main repo.
   *
   * @returns Worktree info (gitDir and branch) or null if not a worktree
   */
  private async getWorktreeInfo(
    path: string
  ): Promise<{ gitDir: string; branch: string } | null> {
    try {
      const gitPath = join(path, ".git");
      const stat = await fs.stat(gitPath);

      if (!stat.isFile()) {
        return null;
      }

      // Read the .git file to get the gitdir path
      const gitFileContent = await fs.readFile(gitPath, "utf-8");
      const match = gitFileContent.match(/^gitdir:\s*(.+)$/m);
      if (!match) {
        return null;
      }

      // The gitdir points to .git/worktrees/<name> in the bare repo
      // We need the bare repo path (two directories up from worktrees/<name>)
      const worktreeGitDir = match[1].trim();

      // Resolve relative path if needed
      let gitDir: string;
      if (worktreeGitDir.startsWith("..")) {
        gitDir = join(path, worktreeGitDir);
      } else {
        gitDir = worktreeGitDir;
      }

      // Navigate from .git/worktrees/<name> to the bare repo
      // gitDir is like /path/to/repo.git/worktrees/workname
      // We want /path/to/repo.git
      const worktreesDir = join(gitDir, "..", "..");
      const bareRepoPath = join(worktreesDir);

      // Validate the bare repo path exists. If not (e.g. the .git file contains a stale
      // path from another machine or OS), treat this as an unresolvable worktree.
      try {
        await fs.stat(bareRepoPath);
      } catch {
        return null;
      }

      // Try to read the HEAD file to get the branch
      let branch = "main";
      try {
        const headPath = join(gitDir, "HEAD");
        const headContent = await fs.readFile(headPath, "utf-8");
        const branchMatch = headContent.match(/^ref:\s*refs\/heads\/(.+)$/m);
        if (branchMatch) {
          branch = branchMatch[1].trim();
        }
      } catch {
        // If we can't read HEAD, default to "main"
      }

      return { gitDir: bareRepoPath, branch };
    } catch {
      return null;
    }
  }

  /**
   * Gets the remote "origin" URL from a bare repository's config file.
   *
   * @param path - Path to the bare repository
   * @returns The remote URL or null if not found
   */
  private async getBareRepoRemoteUrl(path: string): Promise<string | null> {
    try {
      const configPath = join(path, "config");
      const configContent = await fs.readFile(configPath, "utf-8");
      // Look for [remote "origin"] section and extract url
      const urlMatch = configContent.match(
        /\[remote\s+"origin"\][^[]*url\s*=\s*(.+)/m
      );
      if (urlMatch) {
        return urlMatch[1].trim();
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Gets read-only clone information if the path is a regular git clone.
   * Regular clones have a .git directory (not file) with remote URL.
   *
   * @returns Clone info (url and branch) or null if not a git clone
   */
  private async getReadOnlyCloneInfo(
    path: string
  ): Promise<{ url: string; branch: string } | null> {
    try {
      const gitPath = join(path, ".git");
      const stat = await fs.stat(gitPath);

      // Must be a directory, not a file (files indicate worktrees)
      if (!stat.isDirectory()) {
        return null;
      }

      // Read the remote URL from .git/config
      let url: string | null = null;
      try {
        const configPath = join(gitPath, "config");
        const configContent = await fs.readFile(configPath, "utf-8");
        // Look for [remote "origin"] section and extract url
        const urlMatch = configContent.match(
          /\[remote\s+"origin"\][^[]*url\s*=\s*(.+)/m
        );
        if (urlMatch) {
          url = urlMatch[1].trim();
        }
      } catch {
        // Can't read config
      }

      // URL is required for read-only clones
      if (!url) {
        return null;
      }

      // Read the current branch from .git/HEAD
      let branch = "main";
      try {
        const headPath = join(gitPath, "HEAD");
        const headContent = await fs.readFile(headPath, "utf-8");
        const branchMatch = headContent.match(/^ref:\s*refs\/heads\/(.+)$/m);
        if (branchMatch) {
          branch = branchMatch[1].trim();
        }
      } catch {
        // If we can't read HEAD, default to "main"
      }

      return { url, branch };
    } catch {
      return null;
    }
  }
}

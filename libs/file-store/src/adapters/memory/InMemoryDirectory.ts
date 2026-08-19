/**
 * In-Memory Directory Implementation (OO Port)
 *
 * Implements the Directory interface with pattern matching and narrowed child types.
 */

import type {
  Directory,
  DirectoryChild,
  DirectoryChildResult,
  DirectoryLike,
  File,
  Junction,
  NodeKind,
} from "../../port/types.js";
import type { SandboxStorage, InMemorySandbox } from "./InMemorySandbox.js";
import { InMemoryFile } from "./InMemoryFile.js";
import { InMemoryJunction } from "./InMemoryJunction.js";
import { globMatch } from "../../utils/globMatch.js";
import { touchFile } from "./fakeClock.js";

/**
 * In-memory implementation of Directory.
 */
export class InMemoryDirectory implements Directory {
  readonly kind = "directory" as const;

  constructor(
    readonly name: string,
    readonly path: string,
    protected storage: SandboxStorage,
    protected sandbox: InMemorySandbox
  ) {}

  // ========================================
  // Directory Operations
  // ========================================

  async child(name: string): Promise<DirectoryChildResult> {
    const childPath = this.path ? `${this.path}/${name}` : name;

    // Check if it's a file
    if (this.storage.files.has(childPath)) {
      return {
        found: true,
        node: new InMemoryFile(name, childPath, this.storage),
      };
    }

    // Check if it's a bare repository
    const bareRepo = this.storage.bareRepositories.get(childPath);
    if (bareRepo) {
      return {
        found: true,
        node: bareRepo,
      };
    }

    // Check if it's a worktree root (created via BareRepository.createWorktree()).
    // Must be checked before the generic "directory" case below, since a
    // worktree's path is also tracked in storage.directories.
    const worktree = this.storage.worktrees.get(childPath);
    if (worktree) {
      return {
        found: true,
        node: worktree,
      };
    }

    // Check if it's a read-only clone
    const readOnlyClone = this.storage.readOnlyClones?.get(childPath);
    if (readOnlyClone) {
      return {
        found: true,
        node: readOnlyClone,
      };
    }

    // Check if it's a junction
    const junctionTarget = this.storage.junctions.get(childPath);
    if (junctionTarget !== undefined) {
      const targetPath = junctionTarget;
      return {
        found: true,
        node: new InMemoryJunction(
          name,
          childPath,
          targetPath,
          this.storage,
          this.sandbox
        ),
      };
    }

    // Check if it's a directory
    if (this.storage.directories.has(childPath)) {
      return {
        found: true,
        node: new InMemoryDirectory(
          name,
          childPath,
          this.storage,
          this.sandbox
        ),
      };
    }

    // Not found
    return {
      found: false,
      name,
      parent: this,
    };
  }

  async children(): Promise<DirectoryChild[]> {
    const results: DirectoryChild[] = [];
    const prefix = this.path ? `${this.path}/` : "";
    const prefixLen = prefix.length;

    // Find direct child files
    for (const filePath of this.storage.files.keys()) {
      if (filePath.startsWith(prefix)) {
        const remaining = filePath.slice(prefixLen);
        if (!remaining.includes("/")) {
          results.push(
            new InMemoryFile(remaining, filePath, this.storage)
          );
        }
      }
    }

    // Find direct child bare repositories
    for (const [repoPath, repo] of this.storage.bareRepositories) {
      if (repoPath.startsWith(prefix)) {
        const remaining = repoPath.slice(prefixLen);
        if (!remaining.includes("/")) {
          results.push(repo);
        }
      }
    }

    // Find direct child read-only clones
    if (this.storage.readOnlyClones) {
      for (const [clonePath, clone] of this.storage.readOnlyClones) {
        if (clonePath.startsWith(prefix)) {
          const remaining = clonePath.slice(prefixLen);
          if (!remaining.includes("/")) {
            results.push(clone);
          }
        }
      }
    }

    // Find direct child worktree roots
    for (const [worktreePath, worktree] of this.storage.worktrees) {
      if (worktreePath.startsWith(prefix)) {
        const remaining = worktreePath.slice(prefixLen);
        if (!remaining.includes("/")) {
          results.push(worktree);
        }
      }
    }

    // Find direct child junctions
    for (const [junctionPath, targetPath] of this.storage.junctions) {
      if (junctionPath.startsWith(prefix)) {
        const remaining = junctionPath.slice(prefixLen);
        if (!remaining.includes("/")) {
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

    // Find direct child directories (excluding those already handled as special types)
    for (const dirPath of this.storage.directories) {
      if (
        dirPath.startsWith(prefix) &&
        dirPath !== this.path &&
        !this.storage.bareRepositories.has(dirPath) &&
        !this.storage.readOnlyClones?.has(dirPath) &&
        !this.storage.worktrees.has(dirPath)
      ) {
        const remaining = dirPath.slice(prefixLen);
        if (!remaining.includes("/")) {
          results.push(
            new InMemoryDirectory(
              remaining,
              dirPath,
              this.storage,
              this.sandbox
            )
          );
        }
      }
    }

    return results;
  }

  async glob(pattern: string, exclude: string[] = []): Promise<DirectoryChild[]> {
    const results: DirectoryChild[] = [];
    const prefix = this.path ? `${this.path}/` : "";
    const excludeSet = new Set(exclude);
    // A path is pruned if any of its directory segments (excluding the
    // final component itself) is in the exclude set — mirrors not
    // descending into an excluded directory during a real walk.
    const isPruned = (relativePath: string): boolean => {
      if (excludeSet.size === 0) return false;
      const segments = relativePath.split("/");
      return segments.slice(0, -1).some((segment) => excludeSet.has(segment));
    };

    // Match files
    for (const filePath of this.storage.files.keys()) {
      if (filePath.startsWith(prefix) || this.path === "") {
        const relativePath = this.path ? filePath.slice(prefix.length) : filePath;
        if (!isPruned(relativePath) && globMatch(pattern, relativePath)) {
          results.push(new InMemoryFile(relativePath, filePath, this.storage));
        }
      }
    }

    // Match directories (excluding special types)
    for (const dirPath of this.storage.directories) {
      if (
        (dirPath.startsWith(prefix) || this.path === "") &&
        dirPath !== this.path &&
        !this.storage.bareRepositories.has(dirPath) &&
        !this.storage.worktrees.has(dirPath)
      ) {
        const relativePath = this.path ? dirPath.slice(prefix.length) : dirPath;
        const segments = relativePath.split("/");
        const name = segments[segments.length - 1];
        if (excludeSet.has(name)) continue;
        if (!isPruned(relativePath) && globMatch(pattern, relativePath)) {
          results.push(
            new InMemoryDirectory(relativePath, dirPath, this.storage, this.sandbox)
          );
        }
      }
    }

    return results;
  }

  async exists(): Promise<boolean> {
    if (this.path === "") {
      return true; // Root always exists
    }
    return this.storage.directories.has(this.path);
  }

  async createFile(name: string, content?: string): Promise<File> {
    const filePath = this.path ? `${this.path}/${name}` : name;
    // Handle deep paths - create parent directories
    const parts = name.split("/");
    if (parts.length > 1) {
      let currentPath = this.path;
      for (let i = 0; i < parts.length - 1; i++) {
        currentPath = currentPath ? `${currentPath}/${parts[i]}` : parts[i];
        this.storage.directories.add(currentPath);
      }
    }
    this.storage.files.set(filePath, content ?? "");
    touchFile(this.storage, filePath);
    return new InMemoryFile(name, filePath, this.storage);
  }

  async createDirectory(name: string): Promise<Directory> {
    const dirPath = this.path ? `${this.path}/${name}` : name;
    this.storage.directories.add(dirPath);
    return new InMemoryDirectory(name, dirPath, this.storage, this.sandbox);
  }

  async createJunction(name: string, target: DirectoryLike): Promise<Junction> {
    const junctionPath = this.path ? `${this.path}/${name}` : name;
    const targetDir = target as InMemoryDirectory;
    this.storage.junctions.set(junctionPath, targetDir.path);
    return new InMemoryJunction(
      name,
      junctionPath,
      targetDir.path,
      this.storage,
      this.sandbox
    );
  }

  async delete(recursive = false): Promise<void> {
    if (recursive) {
      const prefix = this.path ? `${this.path}/` : "";
      // Delete all files in this directory and subdirectories
      for (const filePath of this.storage.files.keys()) {
        if (filePath.startsWith(prefix) || filePath === this.path) {
          this.storage.files.delete(filePath);
        }
      }
      // Delete all subdirectories
      for (const dirPath of this.storage.directories) {
        if (dirPath.startsWith(prefix) || dirPath === this.path) {
          this.storage.directories.delete(dirPath);
        }
      }
      // Delete junctions
      for (const junctionPath of this.storage.junctions.keys()) {
        if (junctionPath.startsWith(prefix)) {
          this.storage.junctions.delete(junctionPath);
        }
      }
    } else {
      // Check if directory is empty
      const prefix = this.path ? `${this.path}/` : "";
      for (const filePath of this.storage.files.keys()) {
        if (filePath.startsWith(prefix)) {
          throw new Error(`Directory not empty: ${this.path}`);
        }
      }
      for (const dirPath of this.storage.directories) {
        if (dirPath !== this.path && dirPath.startsWith(prefix)) {
          throw new Error(`Directory not empty: ${this.path}`);
        }
      }
      this.storage.directories.delete(this.path);
    }
  }

  async hasGitDirectory(): Promise<boolean> {
    const gitPath = this.path ? `${this.path}/.git` : ".git";
    return this.storage.directories.has(gitPath);
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
}

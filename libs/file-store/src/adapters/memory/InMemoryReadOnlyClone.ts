/**
 * In-Memory Read-Only Clone Implementation
 *
 * Implements the ReadOnlyClone interface for simulated git clones.
 */

import type {
  ReadOnlyClone,
  ReadOnlyChild,
  ReadOnlyChildResult,
  NodeKind,
} from "../../port/types.js";
import type { SandboxStorage, InMemorySandbox } from "./InMemorySandbox.js";
import { InMemoryFile } from "./InMemoryFile.js";
import { InMemoryReadOnlyDirectory } from "./InMemoryReadOnlyDirectory.js";
import { globMatch } from "../../utils/globMatch.js";

/**
 * In-memory implementation of ReadOnlyClone.
 *
 * Simulates a read-only git clone for testing purposes.
 */
export class InMemoryReadOnlyClone implements ReadOnlyClone {
  readonly kind = "read-only-clone" as const;
  private _branch: string;
  private _branches: string[];

  constructor(
    readonly name: string,
    readonly path: string,
    readonly url: string,
    branch: string,
    private storage: SandboxStorage,
    private sandbox: InMemorySandbox
  ) {
    this._branch = branch;
    this._branches = [branch];
  }

  get branch(): string {
    return this._branch;
  }

  // ========================================
  // Directory Operations (Read-Only)
  // ========================================

  async child(name: string): Promise<ReadOnlyChildResult> {
    const childPath = this.path ? `${this.path}/${name}` : name;

    // Check if it's a file
    if (this.storage.files.has(childPath)) {
      return {
        found: true,
        node: new InMemoryFile(name, childPath, this.storage),
      };
    }

    // Check if it's a directory
    if (this.storage.directories.has(childPath)) {
      return {
        found: true,
        node: new InMemoryReadOnlyDirectory(
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

  async children(): Promise<ReadOnlyChild[]> {
    const results: ReadOnlyChild[] = [];
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

    // Find direct child directories (excluding bare repositories)
    for (const dirPath of this.storage.directories) {
      if (
        dirPath.startsWith(prefix) &&
        dirPath !== this.path &&
        !this.storage.bareRepositories.has(dirPath)
      ) {
        const remaining = dirPath.slice(prefixLen);
        if (!remaining.includes("/")) {
          results.push(
            new InMemoryReadOnlyDirectory(
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

  async glob(pattern: string): Promise<ReadOnlyChild[]> {
    const results: ReadOnlyChild[] = [];
    const prefix = this.path ? `${this.path}/` : "";

    // Match files
    for (const filePath of this.storage.files.keys()) {
      if (filePath.startsWith(prefix) || this.path === "") {
        const relativePath = this.path ? filePath.slice(prefix.length) : filePath;
        if (globMatch(pattern, relativePath)) {
          results.push(new InMemoryFile(relativePath, filePath, this.storage));
        }
      }
    }

    // Match directories
    for (const dirPath of this.storage.directories) {
      if (
        (dirPath.startsWith(prefix) || this.path === "") &&
        dirPath !== this.path &&
        !this.storage.bareRepositories.has(dirPath)
      ) {
        const relativePath = this.path ? dirPath.slice(prefix.length) : dirPath;
        if (globMatch(pattern, relativePath)) {
          results.push(
            new InMemoryReadOnlyDirectory(relativePath, dirPath, this.storage, this.sandbox)
          );
        }
      }
    }

    return results;
  }

  async exists(): Promise<boolean> {
    return this.storage.directories.has(this.path);
  }

  // ========================================
  // Git Operations (Simulated)
  // ========================================

  async pullAndReset(): Promise<void> {
    // In-memory simulation - no actual network operations
    // Just a no-op for testing purposes
  }

  async switchBranch(branch: string): Promise<void> {
    // In simulation, just update the branch
    if (!this._branches.includes(branch)) {
      this._branches.push(branch);
    }
    this._branch = branch;
  }

  async branches(): Promise<string[]> {
    return [...this._branches];
  }

  // ========================================
  // Deletion
  // ========================================

  async delete(): Promise<void> {
    const prefix = this.path ? `${this.path}/` : "";

    // Delete all files in this clone
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

    // Remove from read-only clones registry
    this.storage.readOnlyClones?.delete(this.path);
  }

  async hasGitDirectory(): Promise<boolean> {
    const gitPath = this.path ? `${this.path}/.git` : ".git";
    return this.storage.directories.has(gitPath);
  }

  // ========================================
  // Pattern Matching
  // ========================================

  match<T>(cases: { readOnlyClone: (c: ReadOnlyClone) => T }): T {
    return cases.readOnlyClone(this);
  }

  is(kind: "read-only-clone"): this is ReadOnlyClone;
  is(kind: NodeKind): boolean;
  is(kind: NodeKind): boolean {
    return kind === "read-only-clone";
  }

  isDirectoryLike(): boolean {
    return true;
  }
}

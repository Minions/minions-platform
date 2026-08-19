/**
 * In-Memory Read-Only Directory Implementation
 *
 * Implements the ReadOnlyDirectory interface for directories within a ReadOnlyClone.
 * These directories only allow read operations.
 */

import type {
  ReadOnlyDirectory,
  ReadOnlyChild,
  ReadOnlyChildResult,
  NodeKind,
} from "../../port/types.js";
import type { SandboxStorage, InMemorySandbox } from "./InMemorySandbox.js";
import { InMemoryFile } from "./InMemoryFile.js";
import { globMatch } from "../../utils/globMatch.js";

/**
 * In-memory implementation of ReadOnlyDirectory.
 *
 * Key differences from Directory:
 * - No creation operations (createFile, createDirectory, createJunction)
 * - No delete operations
 * - children() returns only ReadOnlyChild types (File | ReadOnlyDirectory)
 */
export class InMemoryReadOnlyDirectory implements ReadOnlyDirectory {
  readonly kind = "read-only-directory" as const;

  constructor(
    readonly name: string,
    readonly path: string,
    private storage: SandboxStorage,
    private sandbox: InMemorySandbox
  ) {}

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

    // Find direct child directories
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
    if (this.path === "") {
      return true;
    }
    return this.storage.directories.has(this.path);
  }

  async hasGitDirectory(): Promise<boolean> {
    const gitPath = this.path ? `${this.path}/.git` : ".git";
    return this.storage.directories.has(gitPath);
  }

  // ========================================
  // Pattern Matching
  // ========================================

  match<T>(cases: { readOnlyDirectory: (d: ReadOnlyDirectory) => T }): T {
    return cases.readOnlyDirectory(this);
  }

  is(kind: "read-only-directory"): this is ReadOnlyDirectory;
  is(kind: NodeKind): boolean;
  is(kind: NodeKind): boolean {
    return kind === "read-only-directory";
  }

  isDirectoryLike(): boolean {
    return true;
  }
}

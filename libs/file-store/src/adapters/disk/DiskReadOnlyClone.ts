/**
 * Disk Read-Only Clone Implementation
 *
 * Implements the ReadOnlyClone interface using real git operations.
 * This is a regular git clone with read-only access patterns.
 */

import { promises as fs } from "fs";
import { join } from "path";
import type {
  ReadOnlyClone,
  ReadOnlyChild,
  ReadOnlyChildResult,
  NodeKind,
} from "../../port/types.js";
import { GitOperations } from "./GitOperations.js";
import { DiskReadOnlyDirectory } from "./DiskReadOnlyDirectory.js";
import { DiskFile } from "./DiskFile.js";
import type { DiskSandbox } from "./DiskSandbox.js";

/**
 * Disk-based implementation of ReadOnlyClone.
 *
 * Key features:
 * - Regular git clone (not bare)
 * - Read-only directory operations
 * - Git operations for fetch, reset, and branch switching
 */
export class DiskReadOnlyClone implements ReadOnlyClone {
  readonly kind = "read-only-clone" as const;
  private git: GitOperations;
  private _branch: string;

  constructor(
    readonly name: string,
    readonly path: string,
    readonly url: string,
    branch: string,
    private sandbox: DiskSandbox
  ) {
    this._branch = branch;
    this.git = new GitOperations(path, sandbox.gitCoordination);
  }

  get branch(): string {
    return this._branch;
  }

  // ========================================
  // Directory Operations (Read-Only)
  // ========================================

  async child(name: string): Promise<ReadOnlyChildResult> {
    const childPath = join(this.path, name);

    try {
      const stat = await fs.lstat(childPath);

      if (stat.isDirectory()) {
        // Skip .git directory
        if (name === ".git") {
          return { found: false, name, parent: this };
        }
        return {
          found: true,
          node: new DiskReadOnlyDirectory(name, childPath, this.sandbox),
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

  async children(): Promise<ReadOnlyChild[]> {
    const results: ReadOnlyChild[] = [];

    try {
      const entries = await fs.readdir(this.path, { withFileTypes: true });

      for (const entry of entries) {
        // Skip .git directory
        if (entry.name === ".git") continue;

        const childPath = join(this.path, entry.name);

        if (entry.isDirectory()) {
          results.push(
            new DiskReadOnlyDirectory(entry.name, childPath, this.sandbox)
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

  async glob(pattern: string): Promise<ReadOnlyChild[]> {
    const { globMatch } = await import("../../utils/globMatch.js");
    const results: ReadOnlyChild[] = [];

    const walkDir = async (dir: string, relativePath: string): Promise<void> => {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          // Skip .git directory
          if (entry.name === ".git") continue;

          const entryPath = join(dir, entry.name);
          const entryRelative = relativePath
            ? `${relativePath}/${entry.name}`
            : entry.name;

          if (entry.isDirectory()) {
            if (globMatch(pattern, entryRelative)) {
              results.push(
                new DiskReadOnlyDirectory(entryRelative, entryPath, this.sandbox)
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
  // Git Operations
  // ========================================

  async pullAndReset(): Promise<void> {
    // Fetch latest from remote and reset to origin/<branch>
    await this.git.fetch();
    await this.git.resetTo(`origin/${this._branch}`);
  }

  async switchBranch(branch: string): Promise<void> {
    await this.git.switchBranch(branch);
    this._branch = branch;
  }

  async branches(): Promise<string[]> {
    return this.git.branches();
  }

  // ========================================
  // Deletion
  // ========================================

  async delete(): Promise<void> {
    await fs.rm(this.path, { recursive: true, force: true });
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

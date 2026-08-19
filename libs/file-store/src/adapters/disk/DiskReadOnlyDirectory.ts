/**
 * Disk Read-Only Directory Implementation
 *
 * Implements the ReadOnlyDirectory interface for directories within a ReadOnlyClone.
 * These directories only allow read operations - no file creation, modification, or deletion.
 */

import { promises as fs } from "fs";
import { join } from "path";
import type {
  ReadOnlyDirectory,
  ReadOnlyChild,
  ReadOnlyChildResult,
  NodeKind,
} from "../../port/types.js";
import { DiskFile } from "./DiskFile.js";
import type { DiskSandbox } from "./DiskSandbox.js";

/**
 * Disk-based implementation of ReadOnlyDirectory.
 *
 * Key differences from Directory:
 * - No creation operations (createFile, createDirectory, createJunction)
 * - No delete operations
 * - children() returns only ReadOnlyChild types (File | ReadOnlyDirectory)
 */
export class DiskReadOnlyDirectory implements ReadOnlyDirectory {
  readonly kind = "read-only-directory" as const;

  constructor(
    readonly name: string,
    readonly path: string,
    private sandbox: DiskSandbox
  ) {}

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

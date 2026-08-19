/**
 * Disk Junction Implementation
 *
 * Implements the Junction interface (directory symlink) using real filesystem operations.
 */

import { promises as fs } from "fs";
import type {
  Junction,
  DirectoryChild,
  DirectoryChildResult,
  DirectoryLike,
  NodeKind,
} from "../../port/types.js";
import { DiskDirectory } from "./DiskDirectory.js";
import type { DiskSandbox } from "./DiskSandbox.js";

/**
 * Disk-based implementation of Junction.
 *
 * Junctions delegate all directory operations to their target.
 */
export class DiskJunction implements Junction {
  readonly kind = "junction" as const;
  readonly target: DirectoryLike;
  private targetDir: DiskDirectory;

  constructor(
    readonly name: string,
    readonly path: string,
    targetPath: string,
    sandbox: DiskSandbox
  ) {
    // Resolve target to a DiskDirectory
    const targetName = targetPath.split(/[/\\]/).pop() || "";
    this.targetDir = new DiskDirectory(targetName, targetPath, sandbox);
    this.target = this.targetDir;
  }

  // ========================================
  // Junction Operations (delegates to target)
  // ========================================

  async child(name: string): Promise<DirectoryChildResult> {
    return this.targetDir.child(name);
  }

  async children(): Promise<DirectoryChild[]> {
    return this.targetDir.children();
  }

  async glob(pattern: string): Promise<DirectoryChild[]> {
    return this.targetDir.glob(pattern);
  }

  async exists(): Promise<boolean> {
    try {
      const stat = await fs.lstat(this.path);
      if (stat.isSymbolicLink()) return true;
      // On Windows, NTFS junctions appear as directories to lstat().
      // Use readlink to confirm the entry is actually a junction.
      if (process.platform === "win32" && stat.isDirectory()) {
        try {
          await fs.readlink(this.path);
          return true;
        } catch {
          return false;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  async unlink(): Promise<void> {
    try {
      // On Windows, junctions are removed with rmdir
      // On POSIX, symlinks are removed with unlink
      if (process.platform === "win32") {
        await fs.rmdir(this.path);
      } else {
        await fs.unlink(this.path);
      }
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw e;
      }
    }
  }

  async hasGitDirectory(): Promise<boolean> {
    return this.targetDir.hasGitDirectory();
  }

  // ========================================
  // Pattern Matching
  // ========================================

  match<T>(cases: { junction: (j: Junction) => T }): T {
    return cases.junction(this);
  }

  is(kind: "junction"): this is Junction;
  is(kind: NodeKind): boolean;
  is(kind: NodeKind): boolean {
    return kind === "junction";
  }

  isDirectoryLike(): boolean {
    return true;
  }
}

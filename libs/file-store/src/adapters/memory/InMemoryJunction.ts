/**
 * In-Memory Junction Implementation (OO Port)
 *
 * Implements the Junction interface (directory symlink) with delegation to target.
 */

import type {
  Junction,
  DirectoryChild,
  DirectoryChildResult,
  DirectoryLike,
  NodeKind,
} from "../../port/types.js";
import type { SandboxStorage, InMemorySandbox } from "./InMemorySandbox.js";
import { InMemoryDirectory } from "./InMemoryDirectory.js";

/**
 * In-memory implementation of Junction.
 *
 * Junctions delegate all directory operations to their target.
 * For simplicity, the in-memory implementation only supports Directory targets.
 */
export class InMemoryJunction implements Junction {
  readonly kind = "junction" as const;
  readonly target: DirectoryLike;
  private targetDir: InMemoryDirectory;

  constructor(
    readonly name: string,
    readonly path: string,
    targetPath: string,
    private storage: SandboxStorage,
    sandbox: InMemorySandbox
  ) {
    // Resolve target - for in-memory, we only support directory targets
    const targetName = targetPath.split("/").pop() || "";
    this.targetDir = new InMemoryDirectory(
      targetName,
      targetPath,
      storage,
      sandbox
    );
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
    return this.storage.junctions.has(this.path);
  }

  async unlink(): Promise<void> {
    this.storage.junctions.delete(this.path);
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

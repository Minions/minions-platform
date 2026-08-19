/**
 * In-Memory File Implementation (OO Port)
 *
 * Implements the File interface with pattern matching support.
 */

import type { File, FileStat, NodeKind } from "../../port/types.js";
import type { SandboxStorage } from "./InMemorySandbox.js";
import { touchFile } from "./fakeClock.js";

/**
 * In-memory implementation of File.
 */
export class InMemoryFile implements File {
  readonly kind = "file" as const;

  constructor(
    readonly name: string,
    readonly path: string,
    private storage: SandboxStorage
  ) {}

  // ========================================
  // File Operations
  // ========================================

  async read(): Promise<string> {
    return this.storage.files.get(this.path) ?? "";
  }

  async readLines(offset = 0, limit?: number): Promise<string[]> {
    const content = await this.read();
    if (content === "") {
      return [];
    }
    const lines = content.split("\n");
    if (offset >= lines.length) {
      return [];
    }
    if (limit !== undefined) {
      return lines.slice(offset, offset + limit);
    }
    return lines.slice(offset);
  }

  async exists(): Promise<boolean> {
    return this.storage.files.has(this.path);
  }

  async stat(): Promise<FileStat> {
    return { mtimeMs: this.storage.fileMtimes.get(this.path) ?? 0 };
  }

  async write(content: string): Promise<void> {
    // Create parent directories automatically
    this.ensureParentDirs();
    this.storage.files.set(this.path, content);
    touchFile(this.storage, this.path);
  }

  async append(content: string): Promise<void> {
    const existing = this.storage.files.get(this.path) ?? "";
    this.storage.files.set(this.path, existing + content);
    touchFile(this.storage, this.path);
  }

  async delete(): Promise<void> {
    this.storage.files.delete(this.path);
  }

  // ========================================
  // Navigation (files cannot have children)
  // ========================================

  async child(name: string): Promise<{ found: false; name: string }> {
    return { found: false, name };
  }

  // ========================================
  // Pattern Matching
  // ========================================

  match<T>(cases: { file: (f: File) => T }): T {
    return cases.file(this);
  }

  is(kind: "file"): this is File;
  is(kind: NodeKind): boolean;
  is(kind: NodeKind): boolean {
    return kind === "file";
  }

  isDirectoryLike(): boolean {
    return false;
  }

  // ========================================
  // Internal Helpers
  // ========================================

  /**
   * Ensures all parent directories exist for this file.
   */
  private ensureParentDirs(): void {
    const parts = this.path.split("/");
    let current = "";
    for (let i = 0; i < parts.length - 1; i++) {
      current = current ? `${current}/${parts[i]}` : parts[i];
      this.storage.directories.add(current);
    }
  }
}

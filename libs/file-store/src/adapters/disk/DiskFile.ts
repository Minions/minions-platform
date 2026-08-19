/**
 * Disk File Implementation
 *
 * Implements the File interface using real filesystem operations.
 */

import { promises as fs } from "fs";
import { dirname } from "path";
import type { File, FileStat, NodeKind } from "../../port/types.js";

/**
 * Disk-based implementation of File.
 */
export class DiskFile implements File {
  readonly kind = "file" as const;

  constructor(
    readonly name: string,
    readonly path: string
  ) {}

  // ========================================
  // File Operations
  // ========================================

  async read(): Promise<string> {
    try {
      return await fs.readFile(this.path, "utf-8");
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        return "";
      }
      throw e;
    }
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
    try {
      await fs.access(this.path);
      return true;
    } catch {
      return false;
    }
  }

  async stat(): Promise<FileStat> {
    const stats = await fs.stat(this.path);
    return { mtimeMs: stats.mtimeMs };
  }

  async write(content: string): Promise<void> {
    // Create parent directories automatically
    await fs.mkdir(dirname(this.path), { recursive: true });
    await fs.writeFile(this.path, content, "utf-8");
  }

  async append(content: string): Promise<void> {
    await fs.appendFile(this.path, content, "utf-8");
  }

  async delete(): Promise<void> {
    try {
      await fs.unlink(this.path);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        throw e;
      }
    }
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
}

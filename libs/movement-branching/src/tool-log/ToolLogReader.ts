import { dirname, basename } from 'node:path';
import { createDiskSandbox, type Directory, type File } from '@minions/file-store';
import type { ToolLogEntry } from './ToolLogEntry.js';

export class ToolLogReader {
  private readonly fileName: string;
  private readonly dir: Directory;

  constructor(logPath: string, dir?: Directory) {
    this.fileName = basename(logPath);
    this.dir = dir ?? createDiskSandbox(dirname(logPath)).root;
  }

  async read(): Promise<ToolLogEntry[]> {
    const result = await this.dir.child(this.fileName);
    if (!result.found) return [];

    const text = await (result.node as File).read();
    const entries: ToolLogEntry[] = [];

    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed) as ToolLogEntry);
      } catch {
        // skip malformed lines
      }
    }

    return entries;
  }

  async clear(): Promise<void> {
    const result = await this.dir.child(this.fileName);
    if (!result.found) return;
    await (result.node as File).write('');
  }
}

import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemorySandbox, type Directory } from '@minions/file-store';
import { ToolLogReader } from './ToolLogReader.js';
import type { ToolLogEntry } from './ToolLogEntry.js';

function makeEntry(overrides: Partial<ToolLogEntry> = {}): ToolLogEntry {
  return { timestamp: Date.now(), tool: 'Read', ...overrides };
}

describe('ToolLogReader', () => {
  let dir: Directory;
  let logPath: string;

  beforeEach(() => {
    dir = createInMemorySandbox().root;
    logPath = '/tool-log.jsonl';
  });

  describe('read()', () => {
    it('returns empty array when log file does not exist', async () => {
      const reader = new ToolLogReader(logPath, dir);
      expect(await reader.read()).toEqual([]);
    });

    it('returns empty array for empty file', async () => {
      await dir.createFile('tool-log.jsonl', '');
      const reader = new ToolLogReader(logPath, dir);
      expect(await reader.read()).toEqual([]);
    });

    it('parses single entry', async () => {
      const entry = makeEntry({ tool: 'Edit', filePath: 'src/foo.ts' });
      await dir.createFile('tool-log.jsonl', JSON.stringify(entry) + '\n');

      const reader = new ToolLogReader(logPath, dir);
      const entries = await reader.read();

      expect(entries).toHaveLength(1);
      expect(entries[0].tool).toBe('Edit');
      expect(entries[0].filePath).toBe('src/foo.ts');
    });

    it('parses multiple entries', async () => {
      const lines = [
        makeEntry({ tool: 'Edit', filePath: 'src/a.ts' }),
        makeEntry({ tool: 'Bash', command: 'pnpm test' }),
        makeEntry({ tool: 'mcp__cabinet__plan', mcpAction: 'delete-subtree' }),
      ].map((e) => JSON.stringify(e)).join('\n') + '\n';

      await dir.createFile('tool-log.jsonl', lines);

      const reader = new ToolLogReader(logPath, dir);
      const entries = await reader.read();

      expect(entries).toHaveLength(3);
      expect(entries[0].tool).toBe('Edit');
      expect(entries[1].tool).toBe('Bash');
      expect(entries[2].tool).toBe('mcp__cabinet__plan');
    });

    it('skips blank lines', async () => {
      const entry = makeEntry({ tool: 'Edit' });
      await dir.createFile('tool-log.jsonl', '\n' + JSON.stringify(entry) + '\n\n');

      const reader = new ToolLogReader(logPath, dir);
      const entries = await reader.read();
      expect(entries).toHaveLength(1);
    });

    it('skips malformed lines', async () => {
      await dir.createFile('tool-log.jsonl', 'not-json\n' + JSON.stringify(makeEntry({ tool: 'Edit' })) + '\n');

      const reader = new ToolLogReader(logPath, dir);
      const entries = await reader.read();
      expect(entries).toHaveLength(1);
      expect(entries[0].tool).toBe('Edit');
    });
  });

  describe('clear()', () => {
    it('truncates the log file', async () => {
      await dir.createFile('tool-log.jsonl', JSON.stringify(makeEntry()) + '\n');

      const reader = new ToolLogReader(logPath, dir);
      await reader.clear();

      const result = await dir.child('tool-log.jsonl');
      expect(result.found).toBe(true);
      const entries = await reader.read();
      expect(entries).toHaveLength(0);
    });

    it('does nothing when file does not exist', async () => {
      const reader = new ToolLogReader(logPath, dir);
      await expect(reader.clear()).resolves.not.toThrow();
    });
  });
});

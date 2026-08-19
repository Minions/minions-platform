import { describe, it, expect, beforeEach } from 'vitest';
import { ToolTracker } from './ToolTracker.js';

describe('ToolTracker', () => {
  let tracker: ToolTracker;

  beforeEach(() => {
    tracker = new ToolTracker();
  });

  describe('recording tools', () => {
    it('records a tool usage with file parameter', () => {
      tracker.recordTool('Edit', { file: 'src/app.ts' });

      const tools = tracker.getToolsSinceLastCommit();
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({
        tool: 'Edit',
        params: { file: 'src/app.ts' },
      });
    });

    it('records multiple tool usages', () => {
      tracker.recordTool('Read', { file: 'src/config.ts' });
      tracker.recordTool('Edit', { file: 'src/app.ts' });
      tracker.recordTool('Edit', { file: 'src/utils.ts' });

      const tools = tracker.getToolsSinceLastCommit();
      expect(tools).toHaveLength(3);
    });

    it('preserves tool order', () => {
      tracker.recordTool('Read', { file: 'src/first.ts' });
      tracker.recordTool('Edit', { file: 'src/second.ts' });
      tracker.recordTool('Write', { file: 'src/third.ts' });

      const tools = tracker.getToolsSinceLastCommit();
      expect(tools[0].tool).toBe('Read');
      expect(tools[1].tool).toBe('Edit');
      expect(tools[2].tool).toBe('Write');
    });

    it('records timestamp for each tool usage', () => {
      const before = Date.now();
      tracker.recordTool('Edit', { file: 'src/app.ts' });
      const after = Date.now();

      const tools = tracker.getToolsSinceLastCommit();
      expect(tools[0].timestamp).toBeGreaterThanOrEqual(before);
      expect(tools[0].timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('resetting on commit', () => {
    it('clears recorded tools when reset is called', () => {
      tracker.recordTool('Edit', { file: 'src/app.ts' });
      tracker.recordTool('Edit', { file: 'src/utils.ts' });

      tracker.reset();

      const tools = tracker.getToolsSinceLastCommit();
      expect(tools).toHaveLength(0);
    });

    it('allows recording new tools after reset', () => {
      tracker.recordTool('Edit', { file: 'src/old.ts' });
      tracker.reset();
      tracker.recordTool('Edit', { file: 'src/new.ts' });

      const tools = tracker.getToolsSinceLastCommit();
      expect(tools).toHaveLength(1);
      expect(tools[0].params.file).toBe('src/new.ts');
    });
  });

  describe('querying edited files', () => {
    it('returns empty array when no edits recorded', () => {
      const files = tracker.getEditedFiles();
      expect(files).toEqual([]);
    });

    it('returns files edited by Edit tool', () => {
      tracker.recordTool('Edit', { file: 'src/app.ts' });
      tracker.recordTool('Edit', { file: 'src/utils.ts' });

      const files = tracker.getEditedFiles();
      expect(files).toContain('src/app.ts');
      expect(files).toContain('src/utils.ts');
    });

    it('returns files created by Write tool', () => {
      tracker.recordTool('Write', { file: 'src/new-file.ts' });

      const files = tracker.getEditedFiles();
      expect(files).toContain('src/new-file.ts');
    });

    it('does not include files from read-only tools', () => {
      tracker.recordTool('Read', { file: 'src/config.ts' });
      tracker.recordTool('Glob', { pattern: '**/*.ts' });
      tracker.recordTool('Grep', { pattern: 'TODO', file: 'src/search.ts' });

      const files = tracker.getEditedFiles();
      expect(files).toHaveLength(0);
    });

    it('deduplicates files edited multiple times', () => {
      tracker.recordTool('Edit', { file: 'src/app.ts' });
      tracker.recordTool('Edit', { file: 'src/app.ts' });
      tracker.recordTool('Edit', { file: 'src/app.ts' });

      const files = tracker.getEditedFiles();
      expect(files).toEqual(['src/app.ts']);
    });

    it('handles mixed read and write operations', () => {
      tracker.recordTool('Read', { file: 'src/config.ts' });
      tracker.recordTool('Edit', { file: 'src/app.ts' });
      tracker.recordTool('Read', { file: 'src/types.ts' });
      tracker.recordTool('Write', { file: 'src/new.ts' });

      const files = tracker.getEditedFiles();
      expect(files).toHaveLength(2);
      expect(files).toContain('src/app.ts');
      expect(files).toContain('src/new.ts');
    });
  });

  describe('state serialization', () => {
    it('exports state for persistence', () => {
      tracker.recordTool('Edit', { file: 'src/app.ts' });

      const state = tracker.exportState();

      expect(state.tools).toHaveLength(1);
      expect(state.tools[0].tool).toBe('Edit');
    });

    it('imports state from persistence', () => {
      const state = {
        tools: [
          { tool: 'Edit', params: { file: 'src/app.ts' }, timestamp: Date.now() },
        ],
      };

      tracker.importState(state);

      const tools = tracker.getToolsSinceLastCommit();
      expect(tools).toHaveLength(1);
    });

    it('replaces existing state on import', () => {
      tracker.recordTool('Edit', { file: 'src/old.ts' });

      const state = {
        tools: [
          { tool: 'Edit', params: { file: 'src/new.ts' }, timestamp: Date.now() },
        ],
      };
      tracker.importState(state);

      const tools = tracker.getToolsSinceLastCommit();
      expect(tools).toHaveLength(1);
      expect(tools[0].params.file).toBe('src/new.ts');
    });
  });

  describe('identifying tool types', () => {
    it('identifies read-only tools', () => {
      expect(tracker.isReadOnlyTool('Read')).toBe(true);
      expect(tracker.isReadOnlyTool('Glob')).toBe(true);
      expect(tracker.isReadOnlyTool('Grep')).toBe(true);
      expect(tracker.isReadOnlyTool('Bash')).toBe(true);
    });

    it('identifies write tools', () => {
      expect(tracker.isWriteTool('Edit')).toBe(true);
      expect(tracker.isWriteTool('Write')).toBe(true);
    });

    it('does not classify write tools as read-only', () => {
      expect(tracker.isReadOnlyTool('Edit')).toBe(false);
      expect(tracker.isReadOnlyTool('Write')).toBe(false);
    });
  });

  describe('hasWriteOperations', () => {
    it('returns false when no tools recorded', () => {
      expect(tracker.hasWriteOperations()).toBe(false);
    });

    it('returns false when only read-only tools recorded', () => {
      tracker.recordTool('Read', { file: 'src/app.ts' });
      tracker.recordTool('Glob', { pattern: '*.ts' });

      expect(tracker.hasWriteOperations()).toBe(false);
    });

    it('returns true when write tool recorded', () => {
      tracker.recordTool('Edit', { file: 'src/app.ts' });

      expect(tracker.hasWriteOperations()).toBe(true);
    });
  });
});

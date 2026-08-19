import { describe, it, expect, beforeEach } from 'vitest';
import { workbenchToSyntheticHistory } from './WorkbenchInjection';
import { Workbench } from './Workbench';
import { Effect } from 'effect';
import { createInMemorySandbox } from '@minions/file-store';
import type { MinionMessage } from '@minions/domain-types';

describe('workbenchToSyntheticHistory', () => {
  let workbench: Workbench;

  beforeEach(() => {
    workbench = new Workbench(createInMemorySandbox());
  });

  describe('File Conversion', () => {
    it('should convert single file to tool_use and tool_result messages', async () => {
      await Effect.runPromise(
        workbench.addFile('src/index.ts', 'export const x = 1;', 'source')
      );

      const messages = workbenchToSyntheticHistory(workbench);

      expect(messages).toHaveLength(2);

      // Check tool_use message
      expect(messages[0]).toMatchObject({
        type: 'tool_use',
        id: 'synthetic-read-0',
        name: 'Read',
        input: {
          file_path: 'src/index.ts',
        },
        metadata: {
          synthetic: true,
          category: 'source',
        },
      });
      expect(messages[0].timestamp).toBeGreaterThan(0);

      // Check tool_result message
      expect(messages[1]).toMatchObject({
        type: 'tool_result',
        tool_use_id: 'synthetic-read-0',
        content: 'export const x = 1;',
        is_error: false,
        metadata: {
          synthetic: true,
          category: 'source',
        },
      });
      expect(messages[1].timestamp).toBe(messages[0].timestamp + 1);
    });

    it('should convert multiple files with unique IDs', async () => {
      await Effect.runPromise(
        workbench.addFile('file1.ts', 'content1', 'source')
      );
      await Effect.runPromise(
        workbench.addFile('file2.ts', 'content2', 'test')
      );
      await Effect.runPromise(
        workbench.addFile('file3.ts', 'content3', 'config')
      );

      const messages = workbenchToSyntheticHistory(workbench);

      expect(messages).toHaveLength(6); // 3 files * 2 messages each

      // Check IDs are unique
      const toolUseIds = messages
        .filter(
          (m): m is Extract<MinionMessage, { type: 'tool_use' }> =>
            m.type === 'tool_use'
        )
        .map((m) => m.id);
      expect(toolUseIds).toEqual([
        'synthetic-read-0',
        'synthetic-read-1',
        'synthetic-read-2',
      ]);

      // Check tool_result references correct tool_use
      expect(messages[1]).toMatchObject({
        type: 'tool_result',
        tool_use_id: 'synthetic-read-0',
      });
      expect(messages[3]).toMatchObject({
        type: 'tool_result',
        tool_use_id: 'synthetic-read-1',
      });
      expect(messages[5]).toMatchObject({
        type: 'tool_result',
        tool_use_id: 'synthetic-read-2',
      });
    });

    it('should preserve file categories in metadata', async () => {
      await Effect.runPromise(
        workbench.addFile('src/code.ts', 'code', 'source')
      );
      await Effect.runPromise(
        workbench.addFile('test/spec.ts', 'test', 'test')
      );
      await Effect.runPromise(
        workbench.addFile('config.json', '{}', 'config')
      );

      const messages = workbenchToSyntheticHistory(workbench);

      expect(messages[0].metadata?.category).toBe('source');
      expect(messages[1].metadata?.category).toBe('source');
      expect(messages[2].metadata?.category).toBe('test');
      expect(messages[3].metadata?.category).toBe('test');
      expect(messages[4].metadata?.category).toBe('config');
      expect(messages[5].metadata?.category).toBe('config');
    });

    it('should use file lastRead timestamps for ordering', async () => {
      // Add files with small delays to ensure different lastRead times
      await Effect.runPromise(
        workbench.addFile('first.ts', 'content', 'source')
      );
      await new Promise((resolve) => setTimeout(resolve, 5));

      await Effect.runPromise(
        workbench.addFile('second.ts', 'content', 'source')
      );
      await new Promise((resolve) => setTimeout(resolve, 5));

      await Effect.runPromise(
        workbench.addFile('third.ts', 'content', 'source')
      );

      const messages = workbenchToSyntheticHistory(workbench);

      // Messages should be ordered by lastRead timestamp
      expect(messages[0].timestamp).toBeLessThan(messages[2].timestamp);
      expect(messages[2].timestamp).toBeLessThan(messages[4].timestamp);

      // tool_result should be 1ms after tool_use
      expect(messages[1].timestamp).toBe(messages[0].timestamp + 1);
      expect(messages[3].timestamp).toBe(messages[2].timestamp + 1);
      expect(messages[5].timestamp).toBe(messages[4].timestamp + 1);
    });

    it('should handle empty file content', async () => {
      await Effect.runPromise(workbench.addFile('empty.ts', '', 'source'));

      const messages = workbenchToSyntheticHistory(workbench);

      expect(messages[1]).toMatchObject({
        type: 'tool_result',
        content: '',
      });
    });

    it('should handle special characters in file paths', async () => {
      await Effect.runPromise(
        workbench.addFile('path/with spaces/file.ts', 'content', 'source')
      );

      const messages = workbenchToSyntheticHistory(workbench);

      expect(messages[0]).toMatchObject({
        type: 'tool_use',
        input: {
          file_path: 'path/with spaces/file.ts',
        },
      });
    });
  });

  describe('Fact Conversion', () => {
    it('should convert facts to text messages grouped by category', () => {
      workbench.addFact('build', 'Build command: pnpm build', 'confirmed', 'analyst');
      workbench.addFact('build', 'Build outputs to dist/', 'inferred', 'analyst');
      workbench.addFact('test', 'Uses Vitest', 'confirmed', 'tester');

      const messages = workbenchToSyntheticHistory(workbench, ['build', 'test']);

      // Should have 2 text messages (one per category)
      const textMessages = messages.filter((m) => m.type === 'text');
      expect(textMessages).toHaveLength(2);

      // Check build facts message
      const buildMessage = textMessages.find((m) =>
        m.content.includes('Project Facts (build)')
      );
      expect(buildMessage).toBeDefined();
      expect(buildMessage?.content).toBe(
        'Project Facts (build):\n- Build command: pnpm build\n- Build outputs to dist/'
      );
      expect(buildMessage?.metadata?.synthetic).toBe(true);
      expect(buildMessage?.metadata?.factCategory).toBe('build');
      expect(buildMessage?.metadata?.factCount).toBe(2);
      expect(buildMessage?.metadata?.discoveredBy).toEqual(['analyst']);

      // Check test facts message
      const testMessage = textMessages.find((m) =>
        m.content.includes('Project Facts (test)')
      );
      expect(testMessage).toBeDefined();
      expect(testMessage?.content).toBe(
        'Project Facts (test):\n- Uses Vitest'
      );
      expect(testMessage?.metadata?.factCategory).toBe('test');
      expect(testMessage?.metadata?.factCount).toBe(1);
      expect(testMessage?.metadata?.discoveredBy).toEqual(['tester']);
    });

    it('should collect unique discoverers in metadata', () => {
      workbench.addFact('build', 'Fact 1', 'confirmed', 'agent1');
      workbench.addFact('build', 'Fact 2', 'confirmed', 'agent2');
      workbench.addFact('build', 'Fact 3', 'confirmed', 'agent1'); // Duplicate

      const messages = workbenchToSyntheticHistory(workbench, ['build']);

      const buildMessage = messages.find((m) => m.type === 'text');
      expect(buildMessage?.metadata?.discoveredBy).toHaveLength(2);
      expect(buildMessage?.metadata?.discoveredBy).toContain('agent1');
      expect(buildMessage?.metadata?.discoveredBy).toContain('agent2');
    });

    it('should use current timestamp for fact messages', () => {
      const beforeTimestamp = Date.now();

      workbench.addFact('build', 'Fact 1', 'confirmed');

      const messages = workbenchToSyntheticHistory(workbench, ['build']);
      const afterTimestamp = Date.now();

      const factMessage = messages.find((m) => m.type === 'text');
      expect(factMessage?.timestamp).toBeGreaterThanOrEqual(beforeTimestamp);
      expect(factMessage?.timestamp).toBeLessThanOrEqual(afterTimestamp);
    });
  });

  describe('Fact Filtering', () => {
    beforeEach(() => {
      workbench.addFact('build', 'Build fact', 'confirmed');
      workbench.addFact('test', 'Test fact', 'confirmed');
      workbench.addFact('structure', 'Structure fact', 'confirmed');
      workbench.addFact('deployment', 'Deployment fact', 'confirmed');
    });

    it('should only include facts matching injectFacts categories', () => {
      const messages = workbenchToSyntheticHistory(workbench, [
        'build',
        'structure',
      ]);

      const textMessages = messages.filter((m) => m.type === 'text');
      expect(textMessages).toHaveLength(2);

      const categories = textMessages.map((m) => m.metadata?.factCategory);
      expect(categories).toContain('build');
      expect(categories).toContain('structure');
      expect(categories).not.toContain('test');
      expect(categories).not.toContain('deployment');
    });

    it('should exclude all facts when injectFacts is undefined', () => {
      const messages = workbenchToSyntheticHistory(workbench, undefined);

      const textMessages = messages.filter((m) => m.type === 'text');
      expect(textMessages).toHaveLength(0);
    });

    it('should exclude all facts when injectFacts is empty array', () => {
      const messages = workbenchToSyntheticHistory(workbench, []);

      const textMessages = messages.filter((m) => m.type === 'text');
      expect(textMessages).toHaveLength(0);
    });

    it('should handle case where no facts match injectFacts', () => {
      const messages = workbenchToSyntheticHistory(workbench, [
        'nonexistent-category',
      ]);

      const textMessages = messages.filter((m) => m.type === 'text');
      expect(textMessages).toHaveLength(0);
    });

    it('should include all matching facts when all categories specified', () => {
      const messages = workbenchToSyntheticHistory(workbench, [
        'build',
        'test',
        'structure',
        'deployment',
      ]);

      const textMessages = messages.filter((m) => m.type === 'text');
      expect(textMessages).toHaveLength(4);
    });
  });

  describe('Chronological Ordering', () => {
    it('should order messages chronologically by timestamp', async () => {
      // Add file with early timestamp
      await Effect.runPromise(
        workbench.addFile('early.ts', 'content', 'source')
      );
      const earlyFile = workbench.files.get('early.ts');
      if (!earlyFile) throw new Error('expected early.ts to be in workbench');
      const earlyTimestamp = earlyFile.lastRead;

      await new Promise((resolve) => setTimeout(resolve, 10));

      // Add file with later timestamp
      await Effect.runPromise(
        workbench.addFile('later.ts', 'content', 'source')
      );
      const laterFile = workbench.files.get('later.ts');
      if (!laterFile) throw new Error('expected later.ts to be in workbench');
      const laterTimestamp = laterFile.lastRead;

      // Add facts (will have current timestamp, which should be after files)
      workbench.addFact('build', 'Build fact', 'confirmed');

      const messages = workbenchToSyntheticHistory(workbench, ['build']);

      // Verify chronological order
      expect(messages[0].timestamp).toBe(earlyTimestamp);
      expect(messages[1].timestamp).toBe(earlyTimestamp + 1);
      expect(messages[2].timestamp).toBe(laterTimestamp);
      expect(messages[3].timestamp).toBe(laterTimestamp + 1);
      expect(messages[4].timestamp).toBeGreaterThan(laterTimestamp + 1);
    });

    it('should maintain stable sort for equal timestamps', () => {
      workbench.addFact('build', 'First', 'confirmed');
      workbench.addFact('test', 'Second', 'confirmed');
      workbench.addFact('structure', 'Third', 'confirmed');

      const messages = workbenchToSyntheticHistory(workbench, [
        'build',
        'test',
        'structure',
      ]);

      // All fact messages will have same timestamp (current time)
      // They should maintain insertion order
      const textMessages = messages.filter((m) => m.type === 'text');
      const categories = textMessages.map((m) => m.metadata?.factCategory);

      // Order should be stable (by insertion order of categories in the Map)
      expect(categories).toEqual(['build', 'test', 'structure']);
    });
  });

  describe('Edge Cases', () => {
    it('should return empty array for empty workbench', () => {
      const messages = workbenchToSyntheticHistory(workbench);

      expect(messages).toEqual([]);
    });

    it('should return only file messages when no facts injected', async () => {
      await Effect.runPromise(
        workbench.addFile('file.ts', 'content', 'source')
      );
      workbench.addFact('build', 'Build fact', 'confirmed');

      const messages = workbenchToSyntheticHistory(workbench, []);

      expect(messages).toHaveLength(2); // Only tool_use and tool_result
      expect(messages[0].type).toBe('tool_use');
      expect(messages[1].type).toBe('tool_result');
    });

    it('should return only fact messages when no files present', () => {
      workbench.addFact('build', 'Build fact', 'confirmed');

      const messages = workbenchToSyntheticHistory(workbench, ['build']);

      expect(messages).toHaveLength(1);
      expect(messages[0].type).toBe('text');
    });

    it('should handle very long fact statements', () => {
      const longFact = 'x'.repeat(10000);
      workbench.addFact('build', longFact, 'confirmed');

      const messages = workbenchToSyntheticHistory(workbench, ['build']);

      const textMessage = messages.find((m) => m.type === 'text');
      expect(textMessage?.content).toContain(longFact);
    });

    it('should handle special characters in fact statements', () => {
      workbench.addFact(
        'build',
        'Command: pnpm build --filter="@scope/package"',
        'confirmed'
      );

      const messages = workbenchToSyntheticHistory(workbench, ['build']);

      const textMessage = messages.find((m) => m.type === 'text');
      expect(textMessage?.content).toContain('--filter="@scope/package"');
    });
  });

  describe('Integration', () => {
    it('should combine files and facts in chronological order', async () => {
      // Add files with early timestamps
      await Effect.runPromise(
        workbench.addFile('file1.ts', 'content1', 'source')
      );
      await new Promise((resolve) => setTimeout(resolve, 5));

      await Effect.runPromise(
        workbench.addFile('file2.ts', 'content2', 'source')
      );

      // Add facts (will have later timestamp)
      workbench.addFact('build', 'Build fact', 'confirmed');
      workbench.addFact('test', 'Test fact', 'confirmed');

      const messages = workbenchToSyntheticHistory(workbench, ['build', 'test']);

      expect(messages).toHaveLength(6); // 4 file messages + 2 fact messages

      // First 4 should be file messages
      expect(messages[0].type).toBe('tool_use');
      expect(messages[1].type).toBe('tool_result');
      expect(messages[2].type).toBe('tool_use');
      expect(messages[3].type).toBe('tool_result');

      // Last 2 should be fact messages
      expect(messages[4].type).toBe('text');
      expect(messages[5].type).toBe('text');
    });

    it('should produce believable synthetic history', async () => {
      // Add realistic workbench contents
      await Effect.runPromise(
        workbench.addFile('package.json', '{"name": "project"}', 'config')
      );
      await new Promise((resolve) => setTimeout(resolve, 5));

      await Effect.runPromise(
        workbench.addFile('src/index.ts', 'export const main = () => {}', 'source')
      );

      workbench.addFact('build', 'Build command: pnpm build', 'confirmed', 'analyst');
      workbench.addFact('test', 'Test framework: Vitest', 'confirmed', 'analyst');
      workbench.addFact(
        'structure',
        'Monorepo using nx',
        'inferred',
        'analyst'
      );

      const messages = workbenchToSyntheticHistory(workbench, [
        'build',
        'structure',
      ]);

      // Verify all messages have required fields
      for (const message of messages) {
        expect(message.type).toBeDefined();
        expect(message.timestamp).toBeGreaterThan(0);
        expect(message.metadata?.synthetic).toBe(true);
      }

      // Verify chronological ordering
      for (let i = 1; i < messages.length; i++) {
        expect(messages[i].timestamp).toBeGreaterThanOrEqual(
          messages[i - 1].timestamp
        );
      }

      // Verify file pairs are adjacent
      const toolUseIndices = messages
        .map((m, i) => (m.type === 'tool_use' ? i : -1))
        .filter((i) => i !== -1);

      for (const idx of toolUseIndices) {
        const toolUse = messages[idx];
        const toolResult = messages[idx + 1];
        expect(toolResult.type).toBe('tool_result');
        if (toolUse.type !== 'tool_use' || toolResult.type !== 'tool_result') {
          throw new Error('expected a tool_use/tool_result pair');
        }
        expect(toolResult.tool_use_id).toBe(toolUse.id);
      }
    });
  });
});

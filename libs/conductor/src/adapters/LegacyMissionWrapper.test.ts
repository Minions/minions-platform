import { describe, it, expect, vi } from 'vitest';
import { Effect } from 'effect';
import { LegacyMissionWrapper } from './LegacyMissionWrapper';
import type { MissionContext } from '../domain/MissionContext';
import { isMission } from '../domain/Mission';

const SAMPLE_MARKDOWN = `# Mission: Detect Duplicate Code

## Reference

See movement-workflow.md for details.

## Objective

Detect duplicate code and create an actionable plan.

## Arguments

- \`target-directory\`: Path to analyze (relative to work/local)
- \`output-path\`: Where to write plan files

## Process

### 1. Scope

Analyze \`<target-directory>\` for duplications.
Write output to \`<output-path>/duplication-plan.md\`.

## Completion Checklist

- [ ] All duplications documented
`;

describe('LegacyMissionWrapper', () => {
  describe('extractName', () => {
    it('extracts name from Mission header', () => {
      const name = LegacyMissionWrapper.extractName(SAMPLE_MARKDOWN, 'detect-and-plan.md');
      expect(name).toBe('detect-duplicate-code');
    });

    it('falls back to filename when no header', () => {
      const markdown = '# Some Other Title\n\nContent here.';
      const name = LegacyMissionWrapper.extractName(markdown, 'my-mission.md');
      expect(name).toBe('my-mission');
    });

    it('handles various Mission header formats', () => {
      const variations = [
        ['# Mission: Simple Name', 'simple-name'],
        ['# Mission: Name With Spaces', 'name-with-spaces'],
        ['#  Mission:  Extra Spaces  ', 'extra-spaces'],
      ];
      for (const [header, expected] of variations) {
        const name = LegacyMissionWrapper.extractName(header + '\n\nContent', 'fallback.md');
        expect(name).toBe(expected);
      }
    });
  });

  describe('extractDescription', () => {
    it('extracts first line from Objective section', () => {
      const desc = LegacyMissionWrapper.extractDescription(SAMPLE_MARKDOWN);
      expect(desc).toBe('Detect duplicate code and create an actionable plan.');
    });

    it('returns default when no Objective section', () => {
      const markdown = '# Mission: Test\n\n## Process\n\nDo stuff.';
      const desc = LegacyMissionWrapper.extractDescription(markdown);
      expect(desc).toBe('Legacy markdown mission');
    });

    it('handles multi-line objectives', () => {
      const markdown = `# Mission: Test

## Objective

First line of objective.
Second line should be ignored.

## Arguments
`;
      const desc = LegacyMissionWrapper.extractDescription(markdown);
      expect(desc).toBe('First line of objective.');
    });
  });

  describe('extractArgsSchema', () => {
    it('extracts arguments from Arguments section', () => {
      const schema = LegacyMissionWrapper.extractArgsSchema(SAMPLE_MARKDOWN);

      expect(schema.type).toBe('object');
      expect(schema.properties['target-directory']).toEqual({
        type: 'string',
        description: 'Path to analyze (relative to work/local)',
      });
      expect(schema.properties['output-path']).toEqual({
        type: 'string',
        description: 'Where to write plan files',
      });
      expect(schema.required).toEqual(['target-directory', 'output-path']);
    });

    it('returns empty schema when no Arguments section', () => {
      const markdown = '# Mission: Test\n\n## Process\n\nDo stuff.';
      const schema = LegacyMissionWrapper.extractArgsSchema(markdown);

      expect(schema.type).toBe('object');
      expect(schema.properties).toEqual({});
      expect(schema.required).toEqual([]);
    });

    it('handles arguments with complex descriptions', () => {
      const markdown = `## Arguments

- \`api-id\`: API boundary ID to consolidate (e.g., "API-001")
- \`plan-path\`: Path to consolidation plan (relative to work/local)
`;
      const schema = LegacyMissionWrapper.extractArgsSchema(markdown);

      expect(schema.properties['api-id']).toEqual({
        type: 'string',
        description: 'API boundary ID to consolidate (e.g., "API-001")',
      });
    });
  });

  describe('wrap', () => {
    it('creates a valid Mission object', () => {
      const mission = LegacyMissionWrapper.wrap(SAMPLE_MARKDOWN, 'detect-and-plan.md');

      expect(isMission(mission)).toBe(true);
      expect(mission.name).toBe('detect-duplicate-code');
      expect(mission.description).toBe('Detect duplicate code and create an actionable plan.');
      expect(mission.args.properties['target-directory']).toBeDefined();
      expect(mission.args.properties['output-path']).toBeDefined();
    });

    it('run function substitutes template variables', async () => {
      const markdown = `# Mission: Test

## Objective

Test mission.

## Arguments

- \`target\`: Target directory

## Process

Analyze <target> for issues.
`;

      const mission = LegacyMissionWrapper.wrap(markdown, 'test.md');

      // Create mock context
      const mockMinion = {
        id: 'minion-1',
        send: vi.fn().mockResolvedValue(undefined),
        receive: vi.fn().mockImplementation(async function* () {
          yield { type: 'text', content: 'Done!', timestamp: Date.now() };
        }),
        kill: vi.fn(),
      };

      const ctx = {
        wing: '/test/wing',
        lair: '/test/lair',
        missionRunId: 'run-1',
        isCancelled: false,
        emit: vi.fn(),
        spawn: vi.fn().mockReturnValue(Effect.succeed(mockMinion)),
        ask: vi.fn(),
        events: {},
        createWorkbench: vi.fn(),
      } as unknown as MissionContext;

      await Effect.runPromise(mission.run(ctx, { target: 'src/components' }));

      // Verify spawn was called
      expect(ctx.spawn).toHaveBeenCalledWith({ client: 'claude-code' });

      // Verify send was called with substituted content
      expect(mockMinion.send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'user',
          content: expect.stringContaining('Analyze src/components for issues.'),
        })
      );

      // Verify events were emitted
      expect(ctx.emit).toHaveBeenCalledWith('started', expect.any(Object));
      expect(ctx.emit).toHaveBeenCalledWith('minion-spawned', { minionId: 'minion-1' });
      expect(ctx.emit).toHaveBeenCalledWith('completed', expect.any(Object));
    });

    it('handles cancellation', async () => {
      const markdown = `# Mission: Test

## Objective

Test mission.

## Arguments

## Process

Do stuff.
`;

      const mission = LegacyMissionWrapper.wrap(markdown, 'test.md');

      const mockMinion = {
        id: 'minion-1',
        send: vi.fn().mockResolvedValue(undefined),
        receive: vi.fn().mockImplementation(async function* () {
          yield { type: 'text', content: 'Working...', timestamp: Date.now() };
          yield { type: 'text', content: 'More work...', timestamp: Date.now() };
        }),
        kill: vi.fn(),
      };

      let messageCount = 0;
      const ctx = {
        wing: '/test/wing',
        lair: '/test/lair',
        missionRunId: 'run-1',
        get isCancelled() {
          // Cancel after first message
          return messageCount > 0;
        },
        emit: vi.fn().mockImplementation((type) => {
          if (type === 'minion-message') {
            messageCount++;
          }
        }),
        spawn: vi.fn().mockReturnValue(Effect.succeed(mockMinion)),
        ask: vi.fn(),
        events: {},
        createWorkbench: vi.fn(),
      } as unknown as MissionContext;

      await Effect.runPromise(mission.run(ctx, {}));

      // Should not emit 'completed' when cancelled
      expect(ctx.emit).not.toHaveBeenCalledWith('completed', expect.any(Object));
    });
  });
});

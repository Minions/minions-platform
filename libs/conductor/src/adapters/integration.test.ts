/**
 * Integration tests for Conductor
 *
 * These tests verify the complete flow: load mission → run → verify events.
 * They use real implementations with mocked external dependencies.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';
import { join } from 'path';
import { ClosetMissionLoader } from './ClosetMissionLoader';
import { DefaultMissionRunner } from './DefaultMissionRunner';
import { DefaultMissionContextFactory } from './DefaultMissionContext';
import type { IHatchery } from '@minions/hatchery';
import type { IMinion, MinionSpec, MinionMessage } from '@minions/domain-types';
import type { IQuestionBridge } from '../ports/IQuestionBridge';
import { createMockQuestionBridge } from '../test-utils/mockFactories';
import { createDiskSandbox, createLair, asWingName, type Wing } from '@minions/file-store';

// Use test fixtures with proper wing structure
const TEST_WING_ROOT = join(__dirname, '__fixtures__', 'test-wing');

describe('Integration: Loader + Runner', () => {
  let loader: ClosetMissionLoader;
  let runner: DefaultMissionRunner;
  let mockHatchery: IHatchery;
  let mockQuestionBridge: IQuestionBridge;
  let wing: Wing;

  beforeAll(async () => {
    // Create Wing object from test fixtures
    const sandbox = createDiskSandbox(TEST_WING_ROOT);
    const lair = createLair(sandbox);
    wing = {
      name: asWingName('test-wing'),
      root: sandbox.root,
      lair,
      closet: async () => {
        const result = await sandbox.root.child('closet');
        if (result.found && result.node.kind === 'directory') {
          return result.node;
        }
        throw new Error('Closet not found');
      },
      workLocal: async () => ({ exists: false }),
      workGlobal: async () => ({ exists: false }),
      privateLocal: async () => ({ exists: false }),
      privateGlobal: async () => ({ exists: false }),
      info: async () => { throw new Error('Not implemented'); },
      setupWorkLocal: async () => { throw new Error('Not implemented'); },
      setupWorkGlobal: async () => { throw new Error('Not implemented'); },
      setupPrivateLocal: async () => { throw new Error('Not implemented'); },
      setupPrivateGlobal: async () => { throw new Error('Not implemented'); },
      workNamed: async () => { throw new Error('Not implemented'); },
      namedWorkNames: async () => [],
      addWorkNamed: async () => { throw new Error('Not implemented'); },
      removeWorkNamed: async () => { throw new Error('Not implemented'); },
      claudeMd: async () => { throw new Error('Not implemented'); },
      setupInfoLink: async () => { throw new Error('Not implemented'); },
      setupClosetLink: async () => { throw new Error('Not implemented'); },
      // WorkArea/Scratchpad accessors (design doc §4.2). Not exercised here.
      workAreaLocal: async () => { throw new Error('Not implemented'); },
      workAreaLocalIfExists: async () => undefined,
      workAreaGlobal: async () => { throw new Error('Not implemented'); },
      workAreaNamed: async () => { throw new Error('Not implemented'); },
      namedWorkPath: async () => undefined,
      privateWorkAreaGlobal: async () => { throw new Error('Not implemented'); },
      scratchpad: async () => { throw new Error('Not implemented'); },
      discardWorkAreas: async () => { throw new Error('Not implemented'); },
    } as Wing;
  });

  beforeEach(() => {
    loader = new ClosetMissionLoader({ wing });

    // Create mock minion that sends a text response
    const createMockMinion = (): IMinion => {
      return {
        id: `minion-${Date.now()}`,
        spec: {} as MinionSpec,
        send: vi.fn().mockResolvedValue(undefined),
        receive: vi.fn().mockImplementation(async function* () {
          // Yield a text response
          yield {
            type: 'text',
            content: 'Hello! This is a test response.',
            timestamp: Date.now(),
          } as MinionMessage;
        }),
        kill: vi.fn(),
        interrupt: vi.fn(),
        reconfigure: vi.fn(),
        status: 'waiting' as const,
      };
    };

    mockHatchery = {
      spawn: vi.fn().mockImplementation(async () => createMockMinion()),
    };

    mockQuestionBridge = createMockQuestionBridge({ answers: ['user answer'] });

    const contextFactory = new DefaultMissionContextFactory(mockHatchery, mockQuestionBridge);
    runner = new DefaultMissionRunner({ contextFactory });
  });

  describe('simple mission', () => {
    it('loads and runs successfully', async () => {
      // Load the simple mission
      const loaded = await loader.load('test-costume', 'simple');
      expect(loaded.mission.name).toBe('simple');

      // Run the mission and wait for completion
      const handle = await runner.start(loaded.mission, {
        wing,
        args: { value: 'Hello, Integration Test!' },
      });

      // Wait for completion
      await handle.completion;

      // Verify mission completed (handle ID format)
      expect(handle.id).toMatch(/^mission-/);
      expect(handle.missionName).toBe('simple');
    });

    it('completes without error', async () => {
      const loaded = await loader.load('test-costume', 'simple');

      const handle = await runner.start(loaded.mission, {
        wing,
        args: { value: 'Test message' },
      });

      // Should complete without throwing
      await expect(handle.completion).resolves.toBeUndefined();
    });
  });

  describe('mission discovery and loading', () => {
    it('discovers both test missions', async () => {
      const missions = await loader.discoverByCostume('test-costume');

      const names = missions.map((m) => m.name);
      expect(names).toContain('simple');
      expect(names).toContain('greet');
    });

    it('loads greet mission with correct schema', async () => {
      const loaded = await loader.load('test-costume', 'greet');

      expect(loaded.mission.name).toBe('greet');
      expect(loaded.mission.args.properties).toHaveProperty('name');
      expect(loaded.mission.args.required).toContain('name');
    });
  });

  describe('runner lifecycle', () => {
    it('tracks running missions', async () => {
      const loaded = await loader.load('test-costume', 'simple');

      // Start mission
      const handle = await runner.start(loaded.mission, {
        wing,
        args: { value: 'test' },
      });

      // Should be tracked while running (race condition safe check)
      const running = runner.listRunning();
      // Mission might complete immediately, so just verify listRunning works
      if (running.length > 0) {
        expect(running).toContain(handle);
      }

      await handle.completion;

      // Cleanup happens asynchronously after completion resolves,
      // so wait a tick for the runner's finally block to execute
      await new Promise((resolve) => setImmediate(resolve));

      // Should be removed after completion
      expect(runner.get(handle.id)).toBeUndefined();
    });
  });

  describe('legacy markdown missions', () => {
    it('loads and identifies legacy missions', async () => {
      const loaded = await loader.load('test-costume', 'legacy-test');

      expect(loaded.isLegacy).toBe(true);
      expect(loaded.mission.name).toBe('legacy-test-mission');
      expect(loaded.mission.description).toBe('Test legacy markdown mission loading.');
    });

    it('extracts correct args schema from markdown', async () => {
      const loaded = await loader.load('test-costume', 'legacy-test');

      expect(loaded.mission.args.type).toBe('object');
      expect(loaded.mission.args.properties).toHaveProperty('target-dir');
      expect(loaded.mission.args.properties).toHaveProperty('output-file');
      expect(loaded.mission.args.required).toContain('target-dir');
      expect(loaded.mission.args.required).toContain('output-file');
    });

    it('runs legacy mission successfully', async () => {
      const loaded = await loader.load('test-costume', 'legacy-test');

      const handle = await runner.start(loaded.mission, {
        wing,
        args: { 'target-dir': 'src/components', 'output-file': 'output.txt' },
      });

      // Should complete without throwing
      await expect(handle.completion).resolves.toBeUndefined();

      // Verify the mission spawned a minion (via hatchery)
      expect(mockHatchery.spawn).toHaveBeenCalled();
    });

    it('substitutes template variables in markdown', async () => {
      const loaded = await loader.load('test-costume', 'legacy-test');

      let sentContent = '';
      const customMockMinion: IMinion = {
        id: 'test-minion',
        spec: {} as MinionSpec,
        send: vi.fn().mockImplementation(async (msg: MinionMessage) => {
          if (msg.type === 'user') {
            sentContent = msg.content as string;
          }
        }),
        receive: vi.fn().mockImplementation(async function* () {
          yield {
            type: 'text',
            content: 'Done!',
            timestamp: Date.now(),
          } as MinionMessage;
        }),
        kill: vi.fn(),
        interrupt: vi.fn(),
        reconfigure: vi.fn(),
        status: 'waiting' as const,
      };

      mockHatchery.spawn = vi.fn().mockResolvedValue(customMockMinion);

      const handle = await runner.start(loaded.mission, {
        wing,
        args: { 'target-dir': 'my/directory', 'output-file': 'result.json' },
      });

      await handle.completion;

      // Verify template variables were substituted
      expect(sentContent).toContain('my/directory');
      expect(sentContent).toContain('result.json');
      expect(sentContent).not.toContain('<target-dir>');
      expect(sentContent).not.toContain('<output-file>');
    });

    it('discovers legacy missions alongside TypeScript missions', async () => {
      const missions = await loader.discoverByCostume('test-costume');

      const tsMissions = missions.filter((m) => !m.isLegacy);
      const legacyMissions = missions.filter((m) => m.isLegacy);

      expect(tsMissions.length).toBeGreaterThan(0);
      expect(legacyMissions.length).toBeGreaterThan(0);
      expect(legacyMissions.some((m) => m.name === 'legacy-test')).toBe(true);
    });
  });
});

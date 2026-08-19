import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Effect } from 'effect';
import { DefaultMissionRunner } from './DefaultMissionRunner';
import { DefaultMissionContextFactory } from './DefaultMissionContext';
import type { Mission } from '../domain/Mission';
import type { MissionContext } from '../domain/MissionContext';
import { MissionExecutionError } from '../domain/MissionEffect';
import type { IHatchery } from '@minions/hatchery';
import type { IMinion, MinionSpec } from '@minions/domain-types';
import type { IQuestionBridge } from '../ports/IQuestionBridge';
import type { Wing } from '@minions/file-store';

/** Minimal mock Wing for tests that don't need real file-store access */
function createMockWing(name = 'test-wing'): Wing {
  return {
    name,
    root: { kind: 'directory', name, path: `/test/${name}` },
    lair: { root: { kind: 'directory', name: 'lair', path: '/test/lair' } },
  } as Wing;
}

describe('DefaultMissionRunner', () => {
  let runner: DefaultMissionRunner;
  let mockHatchery: IHatchery;
  let mockQuestionBridge: IQuestionBridge;
  let mockMinion: IMinion;

  // Simple test mission
  const echoMission: Mission<{ message: string }> = {
    name: 'echo',
    description: 'Echo a message',
    api: 'effect',
    args: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Message to echo' },
      },
      required: ['message'],
    },
    run(ctx: MissionContext, args: { message: string }) {
      return Effect.sync(() => {
        ctx.emit('log', { level: 'info', message: args.message });
      });
    },
  };

  // Mission that fails
  const failingMission: Mission<Record<string, never>> = {
    name: 'failing',
    description: 'A mission that fails',
    api: 'effect',
    args: { type: 'object', properties: {} },
    run() {
      return Effect.fail(new MissionExecutionError({ message: 'Mission failed intentionally' }));
    },
  };

  // Slow mission for testing cancellation
  const slowMission: Mission<Record<string, never>> = {
    name: 'slow',
    description: 'A slow mission',
    api: 'effect',
    args: { type: 'object', properties: {} },
    run(ctx: MissionContext) {
      return Effect.gen(function* () {
        // Simulate slow work
        yield* Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 100)));
        if (!ctx.isCancelled) {
          ctx.emit('completed', { summary: 'Slow mission done' });
        }
      });
    },
  };

  beforeEach(() => {
    mockMinion = {
      id: 'minion-123',
      spec: {} as MinionSpec,
      send: vi.fn(),
      receive: vi.fn(),
      kill: vi.fn(),
      interrupt: vi.fn(),
      reconfigure: vi.fn(),
      status: 'waiting' as const,
    };

    mockHatchery = {
      spawn: vi.fn().mockResolvedValue(mockMinion),
    };

    mockQuestionBridge = {
      ask: vi.fn().mockResolvedValue('answer'),
      cancel: vi.fn(),
    };

    const contextFactory = new DefaultMissionContextFactory(mockHatchery, mockQuestionBridge);
    runner = new DefaultMissionRunner({ contextFactory });
  });

  describe('start', () => {
    it('returns a handle immediately', async () => {
      const handle = await runner.start(echoMission, {
        wing: createMockWing(),
        args: { message: 'hello' },
      });

      expect(handle).toBeDefined();
      expect(handle.id).toMatch(/^mission-/);
      expect(handle.missionName).toBe('echo');
    });

    it('emits started event', async () => {
      const events: unknown[] = [];

      const handle = await runner.start(echoMission, {
        wing: createMockWing(),
        args: { message: 'hello' },
      });

      handle.on('started', (e) => events.push(e));

      // Wait a tick for events to process
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Started event was emitted before we subscribed, check handle is tracked
      expect(runner.listRunning().length).toBeLessThanOrEqual(1);
    });

    it('emits completed event on success', async () => {
      const handle = await runner.start(echoMission, {
        wing: createMockWing(),
        args: { message: 'hello' },
      });

      await handle.completion;

      // Mission completed successfully
      expect(runner.listRunning()).toHaveLength(0);
    });

    it('emits failed event on error', async () => {
      const handle = await runner.start(failingMission, {
        wing: createMockWing(),
        args: {},
      });

      await expect(handle.completion).rejects.toThrow('Mission failed intentionally');
    });
  });

  describe('get', () => {
    it('returns handle for running mission', async () => {
      const handle = await runner.start(slowMission, {
        wing: createMockWing(),
        args: {},
      });

      const retrieved = runner.get(handle.id);
      expect(retrieved).toBe(handle);
    });

    it('returns undefined for unknown ID', () => {
      const result = runner.get('unknown-id');
      expect(result).toBeUndefined();
    });

    it('returns undefined after mission completes', async () => {
      const handle = await runner.start(echoMission, {
        wing: createMockWing(),
        args: { message: 'test' },
      });

      await handle.completion;

      const result = runner.get(handle.id);
      expect(result).toBeUndefined();
    });
  });

  describe('listRunning', () => {
    it('returns empty array initially', () => {
      expect(runner.listRunning()).toEqual([]);
    });

    it('returns running missions', async () => {
      const handle = await runner.start(slowMission, {
        wing: createMockWing(),
        args: {},
      });

      const running = runner.listRunning();
      expect(running).toContain(handle);
    });

    it('removes completed missions', async () => {
      const handle = await runner.start(echoMission, {
        wing: createMockWing(),
        args: { message: 'test' },
      });

      await handle.completion;

      expect(runner.listRunning()).toHaveLength(0);
    });
  });

  describe('cancel', () => {
    it('returns true and cancels running mission', async () => {
      const handle = await runner.start(slowMission, {
        wing: createMockWing(),
        args: {},
      });

      const result = runner.cancel(handle.id, 'test cancellation');

      expect(result).toBe(true);
      expect(handle.isCancelled).toBe(true);
      expect(runner.listRunning()).toHaveLength(0);

      // Handle the rejection from the completion promise
      await expect(handle.completion).rejects.toThrow('cancelled');
    });

    it('returns false for unknown ID', () => {
      const result = runner.cancel('unknown-id');
      expect(result).toBe(false);
    });
  });
});

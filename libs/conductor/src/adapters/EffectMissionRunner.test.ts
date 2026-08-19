import { describe, it, expect, vi } from 'vitest';
import { Effect } from 'effect';
import { EffectMissionRunner } from './EffectMissionRunner';
import {
  defineMission,
  runMission,
  createTestContext,
  type Mission,
  SpawnError,
  AskError,
  MissionExecutionError,
} from '../domain/MissionEffect';
import type { IHatchery } from '@minions/hatchery';
import type { IMinion } from '@minions/domain-types';
import type { IQuestionBridge } from '../ports/IQuestionBridge';
import type { IWorkbench } from '../domain/Workbench';
import type {
  MissionEvent,
  MinionSpawnedEvent,
  MissionFailedEvent,
  MissionCancelledEvent,
} from '../domain/MissionEvents';
import type { Wing } from '@minions/file-store';
import type { IEventBus } from '@minions/events';
import { createInMemorySandbox } from '@minions/file-store';
import {
  createMockMinion,
  createMockHatchery,
  createMockQuestionBridge,
} from '../test-utils/mockFactories';

/** Shape captured from ctx.wing/ctx.lair/ctx.missionRunId in tests below */
interface CapturedMissionContext {
  wing: string;
  lair: string;
  missionRunId: string;
}

/** Minimal mock Wing for runner tests */
function createMockWing(name = 'test-wing', wingPath = '/test/wing', lairPath = '/test/lair'): Wing {
  return {
    name,
    root: { kind: 'directory', name, path: wingPath },
    lair: {
      root: { kind: 'directory', name: 'lair', path: lairPath },
      sandbox: createInMemorySandbox(),
    },
  } as Wing;
}

describe('EffectMissionRunner', () => {
  describe('Basic Effect Execution', () => {
    it('executes a simple Effect mission using defineMission', async () => {
      const hatchery = createMockHatchery();
      const questionBridge = createMockQuestionBridge();
      const runner = new EffectMissionRunner({ hatchery, questionBridge });

      // Simple mission that emits a completion event
      const mission: Mission<void> = defineMission(function* (ctx) {
        yield* ctx.emit('progress', { message: 'Starting work' });
        yield* ctx.emit('completed', { summary: 'Done' });
      });

      const handle = await runner.start(mission, {
        wing: createMockWing(),
        args: {},
      });

      // Collect events
      const events: MissionEvent[] = [];
      handle.on('started', (e) => events.push(e));
      handle.on('progress', (e) => events.push(e));
      handle.on('completed', (e) => events.push(e));

      await handle.completion;

      // Verify events were emitted
      expect(events).toHaveLength(3);
      expect(events[0].type).toBe('started');

      const progressEvent = events[1];
      expect(progressEvent.type).toBe('progress');
      if (progressEvent.type !== 'progress') throw new Error('expected progress event');
      expect(progressEvent.message).toBe('Starting work');

      const completedEvent = events[2];
      expect(completedEvent.type).toBe('completed');
      if (completedEvent.type !== 'completed') throw new Error('expected completed event');
      expect(completedEvent.summary).toBe('Done');
    });

    it('provides MissionContext with wing, lair, and missionRunId', async () => {
      const hatchery = createMockHatchery();
      const questionBridge = createMockQuestionBridge();
      const runner = new EffectMissionRunner({ hatchery, questionBridge });

      let capturedContext: CapturedMissionContext | undefined;

      const mission: Mission<void> = defineMission(function* (ctx) {
        yield* Effect.void;
        capturedContext = {
          wing: ctx.wing,
          lair: ctx.lair,
          missionRunId: ctx.missionRunId,
        };
      });

      const mockWing = createMockWing('my-wing', '/path/to/wing', '/path/to/lair');
      const handle = await runner.start(mission, {
        wing: mockWing,
        args: {},
      });

      await handle.completion;

      // EffectMissionRunner's internal MissionContextImpl uses string paths
      expect(capturedContext).toEqual({
        wing: '/path/to/wing',
        lair: '/path/to/lair',
        missionRunId: handle.id,
      });
    });
  });

  describe('Minion Spawning', () => {
    it('spawns minions via ctx.spawn()', async () => {
      const mockMinion = createMockMinion('minion-1');
      const hatchery = createMockHatchery([mockMinion]);
      const questionBridge = createMockQuestionBridge();
      const runner = new EffectMissionRunner({ hatchery, questionBridge });

      let spawnedMinion: IMinion | null = null;

      const mission: Mission<void> = defineMission(function* (ctx) {
        spawnedMinion = yield* ctx.spawn({ client: 'claude-code' });
      });

      const handle = await runner.start(mission, {
        wing: createMockWing(),
        args: {},
      });

      await handle.completion;

      expect(spawnedMinion).toBe(mockMinion);
      expect(hatchery.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          client: 'claude-code',
          wing: '/test/wing',
        })
      );
    });

    it('handles spawn errors with SpawnError', async () => {
      const hatchery: IHatchery = {
        spawn: vi.fn().mockRejectedValue(new Error('Spawn failed')),
      };
      const questionBridge = createMockQuestionBridge();
      const runner = new EffectMissionRunner({ hatchery, questionBridge });

      const caught: { error: SpawnError | null } = { error: null };

      const mission: Mission<void> = defineMission(function* (ctx) {
        const result = yield* Effect.either(ctx.spawn());
        if (result._tag === 'Left') {
          caught.error = result.left as SpawnError;
        }
      });

      const handle = await runner.start(mission, {
        wing: createMockWing(),
        args: {},
      });

      await handle.completion;

      expect(caught.error).toBeInstanceOf(SpawnError);
      if (!(caught.error instanceof SpawnError)) throw new Error('expected SpawnError');
      expect(caught.error.reason).toBe('Spawn failed');
    });

    it('emits minion-spawned event when spawning', async () => {
      const mockMinion = createMockMinion('minion-1');
      const hatchery = createMockHatchery([mockMinion]);
      const questionBridge = createMockQuestionBridge();
      const runner = new EffectMissionRunner({ hatchery, questionBridge });

      const mission: Mission<void> = defineMission(function* (ctx) {
        yield* ctx.spawn();
      });

      const handle = await runner.start(mission, {
        wing: createMockWing(),
        args: {},
      });

      const minionSpawnedEvents: MinionSpawnedEvent[] = [];
      handle.on('minion-spawned', (e) => minionSpawnedEvents.push(e));

      await handle.completion;

      expect(minionSpawnedEvents).toHaveLength(1);
      expect(minionSpawnedEvents[0].minionId).toBe('minion-1');
    });

    it('kills all spawned minions on completion', async () => {
      const minion1 = createMockMinion('minion-1');
      const minion2 = createMockMinion('minion-2');
      const hatchery = createMockHatchery([minion1, minion2]);
      const questionBridge = createMockQuestionBridge();
      const runner = new EffectMissionRunner({ hatchery, questionBridge });

      const mission: Mission<void> = defineMission(function* (ctx) {
        yield* ctx.spawn();
        yield* ctx.spawn();
      });

      const handle = await runner.start(mission, {
        wing: createMockWing(),
        args: {},
      });

      await handle.completion;

      expect(minion1.kill).toHaveBeenCalled();
      expect(minion2.kill).toHaveBeenCalled();
    });
  });

  describe('Human Questions', () => {
    it('asks humans via ctx.ask()', async () => {
      const hatchery = createMockHatchery();
      const questionBridge = createMockQuestionBridge({ answers: ['Yes'] });
      const runner = new EffectMissionRunner({ hatchery, questionBridge });

      let answer: string | null = null;

      const mission: Mission<void> = defineMission(function* (ctx) {
        answer = yield* ctx.ask({ question: 'Continue?', content: { type: 'markdown', content: '' }, options: [], optionsMode: 'exclusive' });
      });

      const handle = await runner.start(mission, {
        wing: createMockWing(),
        args: {},
      });

      await handle.completion;

      expect(answer).toBe('Yes');
      expect(questionBridge.ask).toHaveBeenCalledWith(
        { question: 'Continue?', content: { type: 'markdown', content: '' }, options: [], optionsMode: 'exclusive' },
        handle.id,
        '/test/wing'
      );
    });

    it('handles ask errors with AskError', async () => {
      const hatchery = createMockHatchery();
      const questionBridge: IQuestionBridge = {
        ask: vi.fn().mockRejectedValue(new Error('Question timeout')),
        cancel: vi.fn(),
      };
      const runner = new EffectMissionRunner({ hatchery, questionBridge });

      const caught: { error: AskError | null } = { error: null };

      const mission: Mission<void> = defineMission(function* (ctx) {
        const result = yield* Effect.either(ctx.ask({ question: 'Test?', content: { type: 'markdown', content: '' }, options: [], optionsMode: 'exclusive' }));
        if (result._tag === 'Left') {
          caught.error = result.left as AskError;
        }
      });

      const handle = await runner.start(mission, {
        wing: createMockWing(),
        args: {},
      });

      await handle.completion;

      expect(caught.error).toBeInstanceOf(AskError);
      if (!(caught.error instanceof AskError)) throw new Error('expected AskError');
      expect(caught.error.question).toBe('Test?');
      expect(caught.error.reason).toBe('Question timeout');
    });
  });

  describe('Workbench', () => {
    it('creates workbenches via ctx.createWorkbench()', async () => {
      const hatchery = createMockHatchery();
      const questionBridge = createMockQuestionBridge();
      const runner = new EffectMissionRunner({ hatchery, questionBridge });

      let workbenchCreated = false;

      const mission: Mission<void> = defineMission(function* (ctx) {
        const workbench = yield* ctx.createWorkbench();
        workbenchCreated = workbench !== null;
      });

      const handle = await runner.start(mission, {
        wing: createMockWing(),
        args: {},
      });

      await handle.completion;

      expect(workbenchCreated).toBe(true);
    });
  });

  describe('Cancellation', () => {
    it('checks cancellation status via ctx.checkCancelled()', async () => {
      const hatchery = createMockHatchery();
      const questionBridge = createMockQuestionBridge();
      const runner = new EffectMissionRunner({ hatchery, questionBridge });

      let wasInitiallyCancelled = true;

      const mission: Mission<void> = defineMission(function* (ctx) {
        wasInitiallyCancelled = yield* ctx.checkCancelled();
        yield* Effect.sleep('100 millis');
      });

      const handle = await runner.start(mission, {
        wing: createMockWing(),
        args: {},
      });

      // Check initial state before cancel
      await Effect.runPromise(Effect.sleep('10 millis'));
      expect(wasInitiallyCancelled).toBe(false);

      // Cancel the mission
      runner.cancel(handle.id, 'Test cancellation');

      // Wait for cancellation to propagate
      await handle.completion.catch(() => {
        // Expected to be cancelled
      });
    });
  });

  describe('Error Handling', () => {
    it('emits failed event when mission throws', async () => {
      const hatchery = createMockHatchery();
      const questionBridge = createMockQuestionBridge();
      const runner = new EffectMissionRunner({ hatchery, questionBridge });

      const mission: Mission<void> = defineMission(function* (_ctx) {
        yield* Effect.fail(new MissionExecutionError({ message: 'Mission failed' }));
      });

      const handle = await runner.start(mission, {
        wing: createMockWing(),
        args: {},
      });

      const failedEvents: MissionFailedEvent[] = [];
      handle.on('failed', (e) => failedEvents.push(e));

      await handle.completion.catch(() => {
        // Expected to fail
      });

      expect(failedEvents).toHaveLength(1);
      expect(failedEvents[0].error.message).toContain('Mission failed');
    });
  });

  describe('Runner Management', () => {
    it('tracks running missions', async () => {
      const hatchery = createMockHatchery();
      const questionBridge = createMockQuestionBridge();
      const runner = new EffectMissionRunner({ hatchery, questionBridge });

      const mission: Mission<void> = defineMission(function* (_ctx) {
        yield* Effect.sleep('50 millis');
      });

      const handle = await runner.start(mission, {
        wing: createMockWing(),
        args: {},
      });

      // Should be running
      expect(runner.get(handle.id)).toBe(handle);
      expect(runner.listRunning()).toContain(handle);

      await handle.completion;

      // Should be cleaned up
      expect(runner.get(handle.id)).toBeUndefined();
      expect(runner.listRunning()).not.toContain(handle);
    });

    it('cancels running missions', async () => {
      const hatchery = createMockHatchery();
      const questionBridge = createMockQuestionBridge();
      const runner = new EffectMissionRunner({ hatchery, questionBridge });

      const mission: Mission<void> = defineMission(function* (_ctx) {
        yield* Effect.sleep('1000 millis');
      });

      const handle = await runner.start(mission, {
        wing: createMockWing(),
        args: {},
      });

      const cancelledEvents: MissionCancelledEvent[] = [];
      handle.on('cancelled', (e) => cancelledEvents.push(e));

      // Catch the completion promise to prevent unhandled rejection
      handle.completion.catch(() => {
        // Expected cancellation
      });

      const cancelled = runner.cancel(handle.id, 'Test cancel');

      expect(cancelled).toBe(true);
      expect(cancelledEvents).toHaveLength(1);
      expect(cancelledEvents[0].reason).toBe('Test cancel');
    });
  });

  describe('Direct Context Pattern (Story 10)', () => {
    describe('createTestContext Helper', () => {
      it('provides test context with default values', async () => {
        const testContext = createTestContext({});

        let capturedContext: CapturedMissionContext | undefined;

        const mission: Mission<void> = defineMission(function* (ctx) {
          yield* Effect.void;
          capturedContext = {
            wing: ctx.wing,
            lair: ctx.lair,
            missionRunId: ctx.missionRunId,
          };
        });

        await runMission(mission, testContext);

        expect(capturedContext).toEqual({
          wing: '/test/wing',
          lair: '/test/lair',
          missionRunId: 'test-mission-123',
        });
      });

      it('allows overriding wing, lair, and missionRunId', async () => {
        const testContext = createTestContext({
          wing: '/custom/wing',
          lair: '/custom/lair',
          missionRunId: 'custom-mission-456',
        });

        let capturedContext: CapturedMissionContext | undefined;

        const mission: Mission<void> = defineMission(function* (ctx) {
          yield* Effect.void;
          capturedContext = {
            wing: ctx.wing,
            lair: ctx.lair,
            missionRunId: ctx.missionRunId,
          };
        });

        await runMission(mission, testContext);

        expect(capturedContext).toEqual({
          wing: '/custom/wing',
          lair: '/custom/lair',
          missionRunId: 'custom-mission-456',
        });
      });

      it('provides test spawn function', async () => {
        const mockMinion = createMockMinion('test-minion');
        const testContext = createTestContext({
          spawnMinion: async () => mockMinion,
        });

        let spawnedMinion: IMinion | null = null;

        const mission: Mission<void> = defineMission(function* (ctx) {
          spawnedMinion = yield* ctx.spawn({ client: 'claude-code' });
        });

        await runMission(mission, testContext);

        expect(spawnedMinion).toBe(mockMinion);
      });

      it('spawn fails with SpawnError when no spawn function provided', async () => {
        const testContext = createTestContext({});

        const caught: { error: SpawnError | null } = { error: null };

        const mission: Mission<void> = defineMission(function* (ctx) {
          const result = yield* Effect.either(ctx.spawn());
          if (result._tag === 'Left') {
            caught.error = result.left as SpawnError;
          }
        });

        await runMission(mission, testContext);

        expect(caught.error).toBeInstanceOf(SpawnError);
        if (!(caught.error instanceof SpawnError)) throw new Error('expected SpawnError');
        expect(caught.error.reason).toBe('No spawn function provided in test context');
      });

      it('provides test ask function', async () => {
        const testContext = createTestContext({
          askHuman: async (options: { question: string }) => `Answer to: ${options.question}`,
        });

        let answer: string | null = null;

        const mission: Mission<void> = defineMission(function* (ctx) {
          answer = yield* ctx.ask({ question: 'What is the meaning of life?', content: { type: 'markdown', content: '' }, options: [], optionsMode: 'exclusive' });
        });

        await runMission(mission, testContext);

        expect(answer).toBe('Answer to: What is the meaning of life?');
      });

      it('ask fails with AskError when no ask function provided', async () => {
        const testContext = createTestContext({});

        const caught: { error: AskError | null } = { error: null };

        const mission: Mission<void> = defineMission(function* (ctx) {
          const result = yield* Effect.either(ctx.ask({ question: 'Test?', content: { type: 'markdown', content: '' }, options: [], optionsMode: 'exclusive' }));
          if (result._tag === 'Left') {
            caught.error = result.left as AskError;
          }
        });

        await runMission(mission, testContext);

        expect(caught.error).toBeInstanceOf(AskError);
        if (!(caught.error instanceof AskError)) throw new Error('expected AskError');
        expect(caught.error.question).toBe('Test?');
        expect(caught.error.reason).toBe('No ask function provided in test context');
      });

      it('provides test emit function', async () => {
        const emittedEvents: Array<{ type: string; data?: Record<string, unknown> }> = [];
        const testContext = createTestContext({
          emitEvent: (type: string, data?: Record<string, unknown>) => emittedEvents.push({ type, data }),
        });

        const mission: Mission<void> = defineMission(function* (ctx) {
          yield* ctx.emit('progress', { message: 'Working' });
          yield* ctx.emit('completed', { summary: 'Done' });
        });

        await runMission(mission, testContext);

        expect(emittedEvents).toHaveLength(2);
        expect(emittedEvents[0]).toEqual({ type: 'progress', data: { message: 'Working' } });
        expect(emittedEvents[1]).toEqual({ type: 'completed', data: { summary: 'Done' } });
      });

      it('provides test cancellation check', async () => {
        let checkCount = 0;
        const testContext = createTestContext({
          isCancelled: () => {
            checkCount++;
            return checkCount > 2; // Cancelled after 2 checks
          },
        });

        let wasCancelled = false;

        const mission: Mission<void> = defineMission(function* (ctx) {
          yield* ctx.checkCancelled(); // 1st check - false
          yield* ctx.checkCancelled(); // 2nd check - false
          wasCancelled = yield* ctx.checkCancelled(); // 3rd check - true
        });

        await runMission(mission, testContext);

        expect(wasCancelled).toBe(true);
        expect(checkCount).toBe(3);
      });

      it('provides test workbench factory', async () => {
        const mockWorkbench: IWorkbench = {
          files: new Map(),
          facts: [],
          addFile: vi.fn(),
          addFact: vi.fn(),
          refreshFile: vi.fn(),
          refreshDirtyFiles: vi.fn(),
          isDirty: vi.fn(),
          writeFile: vi.fn(),
          onFileChange: vi.fn(),
          fileChanges: vi.fn(),
        };

        const testContext = createTestContext({
          createWorkbenchFn: () => mockWorkbench,
        });

        let createdWorkbench: IWorkbench | null = null;

        const mission: Mission<void> = defineMission(function* (ctx) {
          createdWorkbench = yield* ctx.createWorkbench();
        });

        await runMission(mission, testContext);

        expect(createdWorkbench).toBe(mockWorkbench);
      });

      it('creates default workbench when no factory provided', async () => {
        const testContext = createTestContext({});

        const created: { workbench: IWorkbench | null } = { workbench: null };

        const mission: Mission<void> = defineMission(function* (ctx) {
          created.workbench = (yield* ctx.createWorkbench()) as IWorkbench;
        });

        await runMission(mission, testContext);

        expect(created.workbench).toBeTruthy();
        if (!created.workbench) throw new Error('expected workbench to be created');
        expect(created.workbench.files).toBeInstanceOf(Map);
        expect(created.workbench.facts).toBeInstanceOf(Array);
      });

      it('provides test event bus', async () => {
        const testEventBus: IEventBus = {
          on: vi.fn(),
          once: vi.fn(),
          emit: vi.fn(),
          emitFrom: vi.fn(),
          subscribe: vi.fn(),
          emitEffect: vi.fn(),
          emitFromEffect: vi.fn(),
          getActiveListeners: vi.fn(),
        };

        const testContext = createTestContext({
          events: testEventBus,
        });

        let capturedEventBus: IEventBus | undefined;

        const mission: Mission<void> = defineMission(function* (ctx) {
          yield* Effect.void;
          capturedEventBus = ctx.events;
        });

        await runMission(mission, testContext);

        expect(capturedEventBus).toBe(testEventBus);
      });
    });

    describe('Integration: Direct Context Testing', () => {
      it('enables pure mission testing without runner', async () => {
        // This test demonstrates the power of direct context injection:
        // We can test missions directly without needing a mission runner

        const mockMinion = createMockMinion('test-minion');
        const emittedEvents: Array<{ type: string } & Record<string, unknown>> = [];

        const testContext = createTestContext({
          wing: '/test/wing',
          spawnMinion: async () => mockMinion,
          emitEvent: (type: string, data?: Record<string, unknown>) => emittedEvents.push({ type, ...data }),
        });

        // Define a mission
        const mission: Mission<void> = defineMission(function* (ctx) {
          yield* ctx.emit('progress', { message: 'Starting' });
          const minion = yield* ctx.spawn({ client: 'claude-code' });
          yield* ctx.emit('completed', { summary: `Spawned ${minion.id}` });
        });

        // Run mission with test context - no runner needed!
        await runMission(mission, testContext);

        expect(emittedEvents).toHaveLength(2);
        expect(emittedEvents[0].message).toBe('Starting');
        expect(emittedEvents[1].summary).toBe('Spawned test-minion');
      });

      it('enables testing error paths cleanly', async () => {
        const testContext = createTestContext({
          spawnMinion: async () => {
            throw new Error('Spawn failed due to network error');
          },
        });

        const caught: { error: SpawnError | null } = { error: null };

        const mission: Mission<void> = defineMission(function* (ctx) {
          const result = yield* Effect.either(ctx.spawn());
          if (result._tag === 'Left') {
            caught.error = result.left as SpawnError;
          }
        });

        await runMission(mission, testContext);

        expect(caught.error).toBeInstanceOf(SpawnError);
        if (!(caught.error instanceof SpawnError)) throw new Error('expected SpawnError');
        expect(caught.error.reason).toBe('Spawn failed due to network error');
      });

      it('enables testing complex interactions', async () => {
        const mockMinion1 = createMockMinion('minion-1');
        const mockMinion2 = createMockMinion('minion-2');
        let spawnCount = 0;

        const testContext = createTestContext({
          spawnMinion: async () => {
            spawnCount++;
            return spawnCount === 1 ? mockMinion1 : mockMinion2;
          },
          askHuman: async (options: { question: string }) => {
            if (options.question.includes('Continue')) {
              return 'Yes';
            }
            return 'No';
          },
        });

        let result: string | null = null;

        const mission: Mission<void> = defineMission(function* (ctx) {
          // Spawn first minion
          const minion1 = yield* ctx.spawn();

          // Ask if we should spawn another
          const answer = yield* ctx.ask({ question: 'Continue with second minion?', content: { type: 'markdown', content: '' }, options: [], optionsMode: 'exclusive' });

          if (answer === 'Yes') {
            const minion2 = yield* ctx.spawn();
            result = `Spawned ${minion1.id} and ${minion2.id}`;
          } else {
            result = `Only spawned ${minion1.id}`;
          }
        });

        await runMission(mission, testContext);

        expect(result).toBe('Spawned minion-1 and minion-2');
        expect(spawnCount).toBe(2);
      });
    });
  });
});

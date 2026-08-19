import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { join } from 'path';
import { Effect } from 'effect';
import { DefaultMissionContext } from './DefaultMissionContext';
import { MissionHandle } from '../domain/MissionHandle';
import type { IHatchery } from '@minions/hatchery';
import type { IMinion, MinionSpec } from '@minions/domain-types';
import type { IQuestionBridge } from '../ports/IQuestionBridge';
import type { AskOptions } from '../domain/MissionContext';
import type { IWorkbench, FileKnowledge, ProjectFact } from '../domain/Workbench';
import type { ExtendedMinionSpec } from '../domain/CostumeSpec';
import { createDiskSandbox, createLair, type Wing } from '@minions/file-store';
import { createTestWing } from '../test-utils/wingTestHelpers';

// Use test fixtures with proper wing structure
const TEST_WING_ROOT = join(__dirname, '__fixtures__', 'test-wing');

describe('DefaultMissionContext', () => {
  let context: DefaultMissionContext;
  let mockHandle: MissionHandle;
  let mockHatchery: IHatchery;
  let spawnMock: Mock<(spec: ExtendedMinionSpec) => Promise<IMinion>>;
  let mockQuestionBridge: IQuestionBridge;
  let mockMinion: IMinion;
  let testWing: Wing;

  beforeEach(() => {
    mockHandle = new MissionHandle('test-run-123', 'test-mission');

    mockMinion = {
      id: 'minion-456',
      spec: {} as MinionSpec,
      send: vi.fn(),
      receive: vi.fn(),
      kill: vi.fn(),
      interrupt: vi.fn(),
      reconfigure: vi.fn(),
      status: 'waiting' as const,
    };

    spawnMock = vi.fn<(spec: ExtendedMinionSpec) => Promise<IMinion>>().mockResolvedValue(mockMinion);
    mockHatchery = {
      spawn: spawnMock,
    };

    mockQuestionBridge = {
      ask: vi.fn().mockResolvedValue('user answer'),
      cancel: vi.fn(),
    };

    const sandbox = createDiskSandbox(TEST_WING_ROOT);
    const lair = createLair(sandbox);
    testWing = createTestWing({ name: 'test-wing', root: sandbox.root, lair });

    context = new DefaultMissionContext({
      hatchery: mockHatchery,
      questionBridge: mockQuestionBridge,
      handle: mockHandle,
      wing: testWing,
    });
  });

  describe('properties', () => {
    it('exposes wing object', () => {
      expect(context.wing).toBe(testWing);
      expect(context.wing.root.path).toBe(TEST_WING_ROOT);
    });

    it('exposes wing name', () => {
      expect(context.wing.name).toBe('test-wing');
    });

    it('exposes mission run ID from handle', () => {
      expect(context.missionRunId).toBe('test-run-123');
    });

    it('provides a mission-scoped event bus', () => {
      expect(context.events).toBeDefined();
      expect(typeof context.events.on).toBe('function');
      expect(typeof context.events.once).toBe('function');
      expect(typeof context.events.emit).toBe('function');
    });

    it('creates a fresh event bus for each mission run', () => {
      const context2 = new DefaultMissionContext({
        hatchery: mockHatchery,
        questionBridge: mockQuestionBridge,
        handle: new MissionHandle('test-run-789', 'test-mission'),
        wing: testWing,
      });

      expect(context.events).not.toBe(context2.events);
    });

    it('reflects cancelled state from handle', async () => {
      expect(context.isCancelled).toBe(false);

      mockHandle.cancel('test reason');

      expect(context.isCancelled).toBe(true);

      // Handle the rejection from the completion promise
      await expect(mockHandle.completion).rejects.toThrow('cancelled');
    });
  });

  describe('emit', () => {
    it('forwards events to handle', () => {
      const events: unknown[] = [];
      mockHandle.on('progress', (e) => events.push(e));

      context.emit('progress', { message: 'Step 1' });

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'progress',
        message: 'Step 1',
      });
    });

    it('adds timestamp to events', () => {
      const events: unknown[] = [];
      mockHandle.on('log', (e) => events.push(e));

      const before = Date.now();
      context.emit('log', { level: 'info', message: 'test' });
      const after = Date.now();

      const event = events[0] as { timestamp: number };
      expect(event.timestamp).toBeGreaterThanOrEqual(before);
      expect(event.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('spawn', () => {
    it('creates minion via hatchery', async () => {
      const minion = await Effect.runPromise(context.spawn({ client: 'claude-code' }));

      expect(mockHatchery.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          client: 'claude-code',
          wing: TEST_WING_ROOT,
        })
      );
      expect(minion).toBe(mockMinion);
    });

    it('uses default client if not specified', async () => {
      await Effect.runPromise(context.spawn());

      expect(mockHatchery.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          client: 'claude-code',
        })
      );
    });

    it('emits minion-spawned event', async () => {
      const events: unknown[] = [];
      mockHandle.on('minion-spawned', (e) => events.push(e));

      await Effect.runPromise(context.spawn());

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'minion-spawned',
        minionId: 'minion-456',
      });
    });

    it('tracks spawned minions', async () => {
      expect(context.spawnedMinionCount).toBe(0);

      await Effect.runPromise(context.spawn());
      expect(context.spawnedMinionCount).toBe(1);

      await Effect.runPromise(context.spawn());
      expect(context.spawnedMinionCount).toBe(2);
    });

    describe('with costume', () => {
      it('resolves costume by name and builds spec', async () => {
        await Effect.runPromise(context.spawn({ costume: 'test-costume', client: 'claude-code' }));

        expect(mockHatchery.spawn).toHaveBeenCalledWith(
          expect.objectContaining({
            client: 'claude-code',
            wing: TEST_WING_ROOT,
            model: 'claude-sonnet-4-20250514', // from test-costume
            agentPrompt: expect.stringContaining('Test Agent System Prompt'), // from prompt.md
          })
        );
      });

      it('costume defaults can be overridden', async () => {
        await Effect.runPromise(context.spawn({
          costume: 'test-costume',
          client: 'claude-code',
          model: 'claude-opus-4-20250514', // override costume model
          agentPrompt: 'Custom prompt', // override costume systemPrompt
        }));

        expect(mockHatchery.spawn).toHaveBeenCalledWith(
          expect.objectContaining({
            client: 'claude-code',
            wing: TEST_WING_ROOT,
            model: 'claude-opus-4-20250514', // overridden
            agentPrompt: 'Custom prompt', // overridden
          })
        );
      });

      it('hatchery receives only MinionSpec, never costume name', async () => {
        await Effect.runPromise(context.spawn({ costume: 'test-costume', name: 'test-minion' }));

        const spec = spawnMock.mock.calls[0][0];

        // Verify no "costume" property is passed to hatchery
        expect(spec).not.toHaveProperty('costume');

        // Verify it's a complete MinionSpec
        expect(spec).toHaveProperty('client');
        expect(spec).toHaveProperty('wing');
        expect(spec).toHaveProperty('model');
        expect(spec).toHaveProperty('useBuiltInSystemPrompt');
      });

      it('propagates costume load errors', async () => {
        await expect(
          Effect.runPromise(context.spawn({ costume: 'nonexistent-costume' }))
        ).rejects.toThrow();
      });

      it('applies costume gadgets to spec tools', async () => {
        await Effect.runPromise(context.spawn({ costume: 'test-costume' }));

        const spec = spawnMock.mock.calls[0][0];

        // test-costume defines gadgets
        expect(spec.tools).toBeDefined();
        expect(Array.isArray(spec.tools)).toBe(true);
      });
    });

    describe('backward compatibility', () => {
      it('spawns without costume using options directly', async () => {
        await Effect.runPromise(context.spawn({
          client: 'anthropic-agentic',
          model: 'claude-opus-4-20250514',
          agentPrompt: 'Direct prompt',
          name: 'direct-minion',
        }));

        expect(mockHatchery.spawn).toHaveBeenCalledWith(
          expect.objectContaining({
            client: 'anthropic-agentic',
            model: 'claude-opus-4-20250514',
            agentPrompt: 'Direct prompt',
            name: 'direct-minion',
          })
        );
      });

      it('spawns with no options at all', async () => {
        await Effect.runPromise(context.spawn());

        expect(mockHatchery.spawn).toHaveBeenCalledWith(
          expect.objectContaining({
            client: 'claude-code',
            wing: TEST_WING_ROOT,
            model: 'claude-sonnet-4-20250514',
          })
        );
      });

      it('spawns with empty options object', async () => {
        await Effect.runPromise(context.spawn({}));

        expect(mockHatchery.spawn).toHaveBeenCalledWith(
          expect.objectContaining({
            client: 'claude-code',
            wing: TEST_WING_ROOT,
          })
        );
      });
    });

    describe('rollback semantics (Story 11)', () => {
      it('spawn failure before hatchery.spawn leaves context unchanged', async () => {
        const initialCount = context.spawnedMinionCount;

        // Costume loading failure
        await expect(
          Effect.runPromise(context.spawn({ costume: 'nonexistent-costume' }))
        ).rejects.toThrow();

        // Verify no minions tracked
        expect(context.spawnedMinionCount).toBe(initialCount);

        // Verify hatchery.spawn never called
        expect(mockHatchery.spawn).not.toHaveBeenCalled();
      });

      it('spawn failure in hatchery.spawn leaves context unchanged', async () => {
        const initialCount = context.spawnedMinionCount;

        // Mock hatchery.spawn to fail
        mockHatchery.spawn = vi.fn().mockRejectedValue(new Error('Spawn failed'));

        await expect(
          Effect.runPromise(context.spawn({ client: 'claude-code' }))
        ).rejects.toThrow();

        // Verify no minions tracked
        expect(context.spawnedMinionCount).toBe(initialCount);
      });

      it('spawn failure after hatchery.spawn cleans up the minion', async () => {
        const initialCount = context.spawnedMinionCount;

        // Mock emit to throw after successful spawn
        const originalEmit = context.emit.bind(context);
        context.emit = vi.fn().mockImplementation(() => {
          throw new Error('Emit failed');
        });

        // Restore original implementation
        const restoreEmit = () => {
          context.emit = originalEmit;
        };

        const exit = await Effect.runPromiseExit(context.spawn({ client: 'claude-code' }));

        expect(exit._tag).toBe('Failure');
        if (exit._tag === 'Failure' && exit.cause._tag === 'Fail') {
          expect(exit.cause.error.reason).toContain('Emit failed');
        }

        restoreEmit();

        // Verify minion was killed (cleanup happened)
        expect(mockMinion.kill).toHaveBeenCalled();

        // Verify no minions tracked
        expect(context.spawnedMinionCount).toBe(initialCount);
      });

      it('costume load failure does not create partial state', async () => {
        const events: unknown[] = [];
        mockHandle.on('minion-spawned', (e) => events.push(e));

        await expect(
          Effect.runPromise(context.spawn({ costume: 'nonexistent-costume' }))
        ).rejects.toThrow();

        // Verify no events emitted
        expect(events).toHaveLength(0);

        // Verify hatchery not called
        expect(mockHatchery.spawn).not.toHaveBeenCalled();
      });
    });
  });

  describe('ask', () => {
    it('delegates to question bridge', async () => {
      const options: AskOptions = {
        question: 'What should I do?',
        content: { type: 'markdown', content: 'We have two options' },
        options: [{ value: 'Option A', label: 'Option A' }, { value: 'Option B', label: 'Option B' }],
        optionsMode: 'exclusive',
      };

      const answer = await Effect.runPromise(context.ask(options));

      expect(mockQuestionBridge.ask).toHaveBeenCalledWith(
        options,
        'test-run-123',
        'test-wing'
      );
      expect(answer).toBe('user answer');
    });

    it('emits question_asked event before asking', async () => {
      const events: unknown[] = [];
      mockHandle.on('question_asked', (e) => events.push(e));

      await Effect.runPromise(context.ask({ question: 'Ready?', content: { type: 'markdown', content: '' }, options: [], optionsMode: 'exclusive' }));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'question_asked',
        question: 'Ready?',
      });
    });

    it('emits question_answered event after answer received', async () => {
      const events: unknown[] = [];
      mockHandle.on('question_answered', (e) => events.push(e));

      await Effect.runPromise(context.ask({ question: 'Ready?', content: { type: 'markdown', content: '' }, options: [], optionsMode: 'exclusive' }));

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        type: 'question_answered',
        question: 'Ready?',
        answer: 'user answer',
      });
    });

    it('emits events in order: question_asked then question_answered', async () => {
      const events: string[] = [];
      mockHandle.on('question_asked', () => events.push('question_asked'));
      mockHandle.on('question_answered', () => events.push('question_answered'));

      await Effect.runPromise(context.ask({ question: 'Ready?', content: { type: 'markdown', content: '' }, options: [], optionsMode: 'exclusive' }));

      expect(events).toEqual(['question_asked', 'question_answered']);
    });

    it('does not emit question_answered if bridge throws', async () => {
      mockQuestionBridge.ask = vi.fn().mockRejectedValue(new Error('Timeout'));
      const events: unknown[] = [];
      mockHandle.on('question_answered', (e) => events.push(e));

      await expect(Effect.runPromise(context.ask({ question: 'Ready?', content: { type: 'markdown', content: '' }, options: [], optionsMode: 'exclusive' }))).rejects.toThrow();

      expect(events).toHaveLength(0);
    });
  });

  describe('killAllMinions', () => {
    it('kills all spawned minions', async () => {
      await Effect.runPromise(context.spawn());
      await Effect.runPromise(context.spawn());

      context.killAllMinions();

      expect(mockMinion.kill).toHaveBeenCalledTimes(2);
      expect(context.spawnedMinionCount).toBe(0);
    });

    it('ignores errors during kill', async () => {
      mockMinion.kill = vi.fn().mockImplementation(() => {
        throw new Error('Kill failed');
      });

      await Effect.runPromise(context.spawn());

      // Should not throw
      expect(() => context.killAllMinions()).not.toThrow();
    });
  });

  describe('createWorkbench', () => {
    it('creates a new Workbench instance', () => {
      const workbench = context.createWorkbench();

      expect(workbench).toBeDefined();
      expect(workbench.files).toBeDefined();
      expect(workbench.facts).toBeDefined();
      expect(typeof workbench.addFile).toBe('function');
      expect(typeof workbench.addFact).toBe('function');
    });

    it('creates independent Workbench instances', () => {
      const workbench1 = context.createWorkbench();
      const workbench2 = context.createWorkbench();

      expect(workbench1).not.toBe(workbench2);
      expect(workbench1.files).not.toBe(workbench2.files);
      expect(workbench1.facts).not.toBe(workbench2.facts);
    });

    it('creates functional Workbench that can store files', async () => {
      const workbench = context.createWorkbench();

      await Effect.runPromise(workbench.addFile('test.ts', 'content'));

      expect(workbench.files.size).toBe(1);
      expect(workbench.files.get('test.ts')?.content).toBe('content');
    });

    it('creates functional Workbench that can store facts', () => {
      const workbench = context.createWorkbench();

      workbench.addFact('build', 'Uses pnpm', 'confirmed');

      expect(workbench.facts.length).toBe(1);
      expect(workbench.facts[0].fact).toBe('Uses pnpm');
    });
  });

  describe('loadCostume', () => {
    it('returns an Effect that resolves to a Costume', async () => {
      const effect = context.loadCostume('test-costume');

      expect(effect).toBeDefined();
      expect(typeof effect).toBe('object');

      // The effect should be runnable
      const result = await Effect.runPromise(effect);
      expect(result).toBeDefined();
      expect(result.model).toBe('claude-sonnet-4-20250514');
      expect(result.systemPrompt).toContain('Test Agent System Prompt');
    });

    it('loads costume with prompt.md when present', async () => {
      const costume = await Effect.runPromise(context.loadCostume('test-costume'));

      // test-costume has a prompt.md file
      expect(costume.systemPrompt).toContain('Test Agent System Prompt');
      expect(costume.systemPrompt).toContain('You are a test agent');
    });

    it('loads costume without prompt.md', async () => {
      const costume = await Effect.runPromise(context.loadCostume('simple-costume'));

      // simple-costume doesn't have a prompt.md file
      expect(costume.systemPrompt).toBe('You are a simple agent without external prompt file.');
      expect(costume.model).toBe('claude-opus-4-20250514');
    });

    it('propagates LoadError for missing costume', async () => {
      const effect = context.loadCostume('nonexistent-costume');

      await expect(Effect.runPromise(effect)).rejects.toThrow();
    });

    it('propagates LoadError for invalid costume export', async () => {
      const effect = context.loadCostume('invalid-costume');

      await expect(Effect.runPromise(effect)).rejects.toThrow();
    });

    it('uses wing path for closet location', async () => {
      // The context was initialized with TEST_WING_ROOT
      // The costumeLoader should use that path for loading
      const costume = await Effect.runPromise(context.loadCostume('test-costume'));

      expect(costume).toBeDefined();
      // If the loader was using a different path, this would fail
    });
  });

  describe('spawn with events (Story 5A)', () => {
    describe('costume.events validation', () => {
      it('validates that events have schema', async () => {
        const exit = await Effect.runPromiseExit(context.spawn({ costume: 'invalid-events-no-schema' }));

        expect(exit._tag).toBe('Failure');
        if (exit._tag === 'Failure' && exit.cause._tag === 'Fail') {
          expect(exit.cause.error.reason).toMatch(/Missing schema/);
        }
      });

      it('validates that events have non-empty guidance', async () => {
        const exit = await Effect.runPromiseExit(context.spawn({ costume: 'invalid-events-no-guidance' }));

        expect(exit._tag).toBe('Failure');
        if (exit._tag === 'Failure' && exit.cause._tag === 'Fail') {
          expect(exit.cause.error.reason).toMatch(/Missing or empty 'guidance' string/);
        }
      });
    });

    describe('tool name collision validation', () => {
      it('throws error when costume tools use reserved gadget names', async () => {
        const exit = await Effect.runPromiseExit(context.spawn({ costume: 'collision-costume' }));

        expect(exit._tag).toBe('Failure');
        if (exit._tag === 'Failure' && exit.cause._tag === 'Fail') {
          expect(exit.cause.error.reason).toMatch(/Tool name collision.*get_event_schema.*reserved/);
        }
      });
    });

    describe('gadget creation and spec attachment', () => {
      it('creates and attaches gadgets when costume has events', async () => {
        await Effect.runPromise(context.spawn({ costume: 'events-costume' }));

        const spec = spawnMock.mock.calls[0][0];

        // Verify spec has executableGadgets
        expect(spec.executableGadgets).toBeDefined();
        if (!spec.executableGadgets) throw new Error('expected executableGadgets to be defined');
        expect(Array.isArray(spec.executableGadgets)).toBe(true);
        expect(spec.executableGadgets.length).toBe(2); // get_event_schema, emit_event

        // Verify gadget Tool definitions added to spec.tools
        expect(spec.tools).toBeDefined();
        if (!spec.tools) throw new Error('expected tools to be defined');
        const toolNames = spec.tools.map((t) => t.name);
        expect(toolNames).toContain('get_event_schema');
        expect(toolNames).toContain('emit_event');
      });

      it('appends gadget tools to existing costume tools', async () => {
        await Effect.runPromise(context.spawn({ costume: 'events-costume' }));

        const spec = spawnMock.mock.calls[0][0];
        if (!spec.tools) throw new Error('expected tools to be defined');

        // events-costume has 1 existing tool ('test-tool')
        // Should have 3 total: test-tool + get_event_schema + emit_event
        expect(spec.tools.length).toBe(3);

        const toolNames = spec.tools.map((t) => t.name);
        expect(toolNames).toContain('test-tool'); // Original tool
        expect(toolNames).toContain('get_event_schema'); // Gadget
        expect(toolNames).toContain('emit_event'); // Gadget
      });

      it('does not add gadgets when costume.events is undefined', async () => {
        await Effect.runPromise(context.spawn({ costume: 'test-costume' }));

        const spec = spawnMock.mock.calls[0][0];

        // test-costume has no events, so no gadgets
        expect(spec.executableGadgets).toBeUndefined();

        // Should only have original tools, no event gadgets
        const toolNames = spec.tools?.map((t) => t.name) ?? [];
        expect(toolNames).not.toContain('get_event_schema');
        expect(toolNames).not.toContain('emit_event');
      });

      it('does not add gadgets when costume.events is empty array', async () => {
        await Effect.runPromise(context.spawn({ costume: 'simple-costume' }));

        const spec = spawnMock.mock.calls[0][0];

        // simple-costume has empty events array
        expect(spec.executableGadgets).toBeUndefined();
      });

      it('passes spec with executableGadgets to hatchery.spawn', async () => {
        await Effect.runPromise(context.spawn({ costume: 'events-costume' }));

        expect(mockHatchery.spawn).toHaveBeenCalledWith(
          expect.objectContaining({
            executableGadgets: expect.arrayContaining([
              expect.objectContaining({
                tool: expect.objectContaining({ name: 'get_event_schema' }),
                execute: expect.any(Function),
              }),
              expect.objectContaining({
                tool: expect.objectContaining({ name: 'emit_event' }),
                execute: expect.any(Function),
              }),
            ]),
          })
        );
      });

      it('preserves existing explicit tools in spawn options', async () => {
        await Effect.runPromise(context.spawn({
          costume: 'events-costume',
          // Note: In current implementation, options.tools would override costume tools
          // This test verifies the costume tools path
        }));

        const spec = spawnMock.mock.calls[0][0];
        if (!spec.tools) throw new Error('expected tools to be defined');

        // Verify original costume tools are preserved
        const toolNames = spec.tools.map((t) => t.name);
        expect(toolNames).toContain('test-tool'); // From costume
      });
    });
  });

  describe('getWing', () => {
    it('returns the wing directly', async () => {
      const wing = await context.getWing();
      expect(wing).toBe(testWing);
    });
  });

  describe('spawn with workbench (Story 3)', () => {
    let mockWorkbench: IWorkbench;

    beforeEach(() => {
      mockWorkbench = {
        files: new Map(),
        facts: [],
        addFile: vi.fn(),
        addFact: vi.fn(),
        getFile: vi.fn(),
      } as unknown as IWorkbench;
    });

    describe('workbench flows through spawn chain', () => {
      it('stores workbench on spec when provided with costume', async () => {
        await Effect.runPromise(context.spawn({
          costume: 'test-costume',
          workbench: mockWorkbench,
        }));

        const spec = spawnMock.mock.calls[0][0];

        expect(spec.workbench).toBe(mockWorkbench);
      });

      it('stores workbench on spec when provided without costume', async () => {
        await Effect.runPromise(context.spawn({
          client: 'claude-code',
          workbench: mockWorkbench,
        }));

        const spec = spawnMock.mock.calls[0][0];

        expect(spec.workbench).toBe(mockWorkbench);
      });

      it('does not store workbench when not provided', async () => {
        await Effect.runPromise(context.spawn({ costume: 'test-costume' }));

        const spec = spawnMock.mock.calls[0][0];

        expect(spec.workbench).toBeUndefined();
      });
    });

    describe('syntheticHistory generation', () => {
      it('generates syntheticHistory when workbench and injectFacts both present', async () => {
        // Add some files to workbench
        (mockWorkbench.files as Map<string, FileKnowledge>).set('test.ts', {
          path: 'test.ts',
          content: 'test content',
          category: 'test',
          lastRead: Date.now(),
          modified: false,
        });

        // Add some facts
        (mockWorkbench.facts as ProjectFact[]).push({
          fact: 'Uses pnpm',
          category: 'build',
          confidence: 'confirmed',
          discoveredBy: 'test-minion',
        });

        await Effect.runPromise(context.spawn({
          costume: 'test-costume', // has injectFacts: ['test', 'build']
          workbench: mockWorkbench,
        }));

        const spec = spawnMock.mock.calls[0][0];

        expect(spec.syntheticHistory).toBeDefined();
        if (!spec.syntheticHistory) throw new Error('expected syntheticHistory to be defined');
        expect(Array.isArray(spec.syntheticHistory)).toBe(true);
        expect(spec.syntheticHistory.length).toBeGreaterThan(0);

        // Verify it contains messages
        const hasToolUse = spec.syntheticHistory.some((m) => m.type === 'tool_use');
        const hasToolResult = spec.syntheticHistory.some((m) => m.type === 'tool_result');
        const hasTextFacts = spec.syntheticHistory.some((m) => m.type === 'text');

        expect(hasToolUse).toBe(true);
        expect(hasToolResult).toBe(true);
        expect(hasTextFacts).toBe(true);
      });

      it('does not generate syntheticHistory when workbench missing', async () => {
        await Effect.runPromise(context.spawn({
          costume: 'test-costume', // has injectFacts
          // no workbench
        }));

        const spec = spawnMock.mock.calls[0][0];

        expect(spec.syntheticHistory).toBeUndefined();
      });

      it('does not generate syntheticHistory when injectFacts empty', async () => {
        await Effect.runPromise(context.spawn({
          costume: 'simple-costume', // has empty injectFacts array
          workbench: mockWorkbench,
        }));

        const spec = spawnMock.mock.calls[0][0];

        expect(spec.syntheticHistory).toBeUndefined();
      });

      it('does not generate syntheticHistory when injectFacts undefined', async () => {
        // Create a minimal workbench with data
        (mockWorkbench.files as Map<string, FileKnowledge>).set('test.ts', {
          path: 'test.ts',
          content: 'test content',
          category: 'test',
          lastRead: Date.now(),
          modified: false,
        });

        await Effect.runPromise(context.spawn({
          costume: 'events-costume', // has undefined injectFacts
          workbench: mockWorkbench,
        }));

        const spec = spawnMock.mock.calls[0][0];

        // Workbench stored but no syntheticHistory
        expect(spec.workbench).toBe(mockWorkbench);
        expect(spec.syntheticHistory).toBeUndefined();
      });

      it('does not generate syntheticHistory in non-costume path', async () => {
        await Effect.runPromise(context.spawn({
          client: 'claude-code',
          workbench: mockWorkbench,
          // no costume, so no injectFacts
        }));

        const spec = spawnMock.mock.calls[0][0];

        // Workbench stored but no syntheticHistory (no injectFacts in non-costume path)
        expect(spec.workbench).toBe(mockWorkbench);
        expect(spec.syntheticHistory).toBeUndefined();
      });

      it('passes both workbench and syntheticHistory to hatchery', async () => {
        (mockWorkbench.files as Map<string, FileKnowledge>).set('test.ts', {
          path: 'test.ts',
          content: 'test content',
          category: 'test',
          lastRead: Date.now(),
          modified: false,
        });

        await Effect.runPromise(context.spawn({
          costume: 'test-costume',
          workbench: mockWorkbench,
        }));

        expect(mockHatchery.spawn).toHaveBeenCalledWith(
          expect.objectContaining({
            workbench: mockWorkbench,
            syntheticHistory: expect.arrayContaining([
              expect.objectContaining({ type: 'tool_use' }),
            ]),
          })
        );
      });
    });
  });
});

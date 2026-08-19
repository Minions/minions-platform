import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Effect } from 'effect';
import type { IMinion } from '../../src/ports/IMinion';
import type { Costume, Tool } from '../../src/domain';
import { TEST_PROMPTS } from '../../src/domain';
import type { IWorkbench } from '@minions/domain-types';

/**
 * Parameterized contract tests for IMinion implementations
 *
 * These tests define the vertical slices that ALL minion implementations must satisfy.
 * Both BrainlessMinion (Phase 1) and RealMinion (Phase 3) must pass these tests.
 *
 * Note: Only behaviors that work with real AI clients (like Claude) are tested here.
 * BrainlessMinion-specific test commands (like /think, /error, /status) are not part
 * of the contract and should be tested separately in brainless-minion.spec.ts.
 *
 * Minions are always running from construction until they die. There is no lifecycle
 * to manage - they simply exist and communicate via send() and receive().
 *
 * Usage:
 * ```typescript
 * // In brainless-minion.spec.ts (with fake timers):
 * testMinionContract('BrainlessMinion', () => new BrainlessMinion(spec), killFn, true);
 *
 * // In real-minion.spec.ts (with real timers):
 * testMinionContract('RealMinion', () => new RealMinion(spec, client), killFn, false);
 * ```
 *
 * @param name - Name of the minion implementation being tested
 * @param createMinion - Factory function that creates a minion instance (optionally accepts costume and workbench)
 * @param killMinion - Function to stop the minion after tests (test-only, not part of IMinion)
 * @param useFakeTimers - Whether to use fake timers (true for BrainlessMinion, false for real minions)
 */
export function testMinionContract(
  name: string,
  createMinion: (costume?: Costume, workbench?: IWorkbench) => IMinion,
  killMinion: (minion: IMinion) => void,
  useFakeTimers = false
) {
  describe(`Minion Contract: ${name}`, () => {
    if (useFakeTimers) {
      beforeEach(() => {
        vi.useFakeTimers();
      });

      afterEach(() => {
        vi.useRealTimers();
      });
    }

    it('SLICE 1: implements IMinion interface', () => {
      const minion = createMinion();

      expect(minion.id).toBeDefined();
      expect(typeof minion.id).toBe('string');
      expect(minion.spec).toBeDefined();
      expect(minion.send).toBeInstanceOf(Function);
      expect(minion.receive).toBeInstanceOf(Function);

      killMinion(minion);
    });

    it('SLICE 2: supports bidirectional communication', async () => {
      const minion = createMinion();

      // Verify methods exist and are callable
      expect(minion.send).toBeInstanceOf(Function);
      expect(minion.receive).toBeInstanceOf(Function);
      expect(minion.kill).toBeInstanceOf(Function);
      expect(minion.interrupt).toBeInstanceOf(Function);

      killMinion(minion);
    });

    it('SLICE 3: responds to /help prompt with text message', async () => {
      const minion = createMinion();

      // Send help prompt
      await minion.send({ type: 'user', content: TEST_PROMPTS.HELP, timestamp: Date.now() });

      // Collect response
      const responsePromise = minion.receive().next();
      if (useFakeTimers) {
        await vi.advanceTimersByTimeAsync(20);
      }
      const response = await responsePromise;

      killMinion(minion);

      // Verify we got a text response
      expect(response.value).toBeDefined();
      expect(response.value.type).toBe('text');
    });

    it('SLICE 4: responds to exact echo request with exact text', async () => {
      const minion = createMinion();

      // Send exact echo prompt
      await minion.send({ type: 'user', content: TEST_PROMPTS.ECHO_HI, timestamp: Date.now() });

      // Collect response
      const responsePromise = minion.receive().next();
      if (useFakeTimers) {
        await vi.advanceTimersByTimeAsync(20);
      }
      const response = await responsePromise;

      killMinion(minion);

      // Verify we got exactly "hi"
      expect(response.value).toBeDefined();
      expect(response.value.type).toBe('text');
      if (response.value.type === 'text') {
        expect(response.value.content).toBe('hi');
      }
    });

    it('SLICE 5: kill() terminates the minion', async () => {
      const minion = createMinion();

      // Verify minion is working
      await minion.send({ type: 'user', content: TEST_PROMPTS.HELP, timestamp: Date.now() });

      // Kill it
      minion.kill();

      // receive() iterator should complete
      const iterator = minion.receive();
      const result = await iterator.next();

      expect(result.done).toBe(true);
    });

    it('SLICE 6: interrupt() signals the minion', async () => {
      const minion = createMinion();

      // Interrupt should be callable without throwing
      expect(() => minion.interrupt()).not.toThrow();

      // Minion should still be alive after interrupt
      await minion.send({ type: 'user', content: TEST_PROMPTS.HELP, timestamp: Date.now() });

      const responsePromise = minion.receive().next();
      if (useFakeTimers) {
        await vi.advanceTimersByTimeAsync(20);
      }
      const response = await responsePromise;

      killMinion(minion);

      expect(response.value).toBeDefined();
      expect(response.value.type).toBe('text');
    });

    it('SLICE 7: costume property is undefined when spawned without costume', () => {
      const minion = createMinion();

      expect(minion.costume).toBeUndefined();

      killMinion(minion);
    });

    it('SLICE 8: costume property returns current costume when spawned with costume', () => {
      const costume = {
        model: 'test-model',
        systemPrompt: 'You are a test minion',
        gadgets: [{ name: 'test-tool', description: 'A test tool', input_schema: {} }],
        skills: [],
        events: [],
        injectFacts: ['build', 'test']
      };

      const minion = createMinion(costume);

      expect(minion.costume).toBeDefined();
      expect(minion.costume?.model).toBe('test-model');
      expect(minion.costume?.systemPrompt).toBe('You are a test minion');
      expect(minion.costume?.gadgets).toHaveLength(1);
      expect(minion.costume?.injectFacts).toEqual(['build', 'test']);

      killMinion(minion);
    });

    it('SLICE 9: status property starts as waiting', () => {
      const minion = createMinion();

      expect(minion.status).toBe('waiting');

      killMinion(minion);
    });

    it('SLICE 10: status transitions to processing when send() is called', async () => {
      const minion = createMinion();

      expect(minion.status).toBe('waiting');

      await minion.send({ type: 'user', content: 'Hello', timestamp: Date.now() });

      expect(minion.status).toBe('processing');

      killMinion(minion);
    });

    it('SLICE 11: status transitions to dead when kill() is called', () => {
      const minion = createMinion();

      expect(minion.status).toBe('waiting');

      minion.kill();

      expect(minion.status).toBe('dead');
    });

    it('SLICE 12: reconfigure() updates costume properties (full replacement)', async () => {
      const originalCostume = {
        model: 'test-model',
        systemPrompt: 'Original prompt',
        gadgets: [{ name: 'tool1', description: 'Tool 1', input_schema: {} }],
        skills: ['skill1'],
        events: [],
        injectFacts: ['fact1']
      };

      const minion = createMinion(originalCostume);

      // Reconfigure with completely new costume
      const newCostume = {
        model: 'test-model', // Must match
        systemPrompt: 'New prompt',
        gadgets: [{ name: 'tool2', description: 'Tool 2', input_schema: {} }],
        skills: ['skill2'],
        events: [],
        injectFacts: ['fact2']
      };

      const result = minion.reconfigure(newCostume);

      const exitResult = await result.pipe(Effect.runPromiseExit);

      expect(exitResult._tag).toBe('Success');

      // Verify full replacement - no old properties remain
      expect(minion.costume?.systemPrompt).toBe('New prompt');
      expect(minion.costume?.gadgets).toHaveLength(1);
      expect(minion.costume?.gadgets?.[0].name).toBe('tool2');
      expect(minion.costume?.skills).toEqual(['skill2']);
      expect(minion.costume?.injectFacts).toEqual(['fact2']);

      // Verify no blending with old costume
      expect(minion.costume?.gadgets?.find((g: Tool) => g.name === 'tool1')).toBeUndefined();
      expect(minion.costume?.skills).not.toContain('skill1');
      expect(minion.costume?.injectFacts).not.toContain('fact1');

      killMinion(minion);
    });

    it('SLICE 13: reconfigure() allows model changes', async () => {
      const originalCostume = {
        model: 'original-model',
        systemPrompt: 'Test prompt',
        gadgets: [],
        skills: [],
        events: [],
        injectFacts: []
      };

      const minion = createMinion(originalCostume);

      // Change to different model
      const newCostume = {
        model: 'different-model', // Model changes are allowed
        systemPrompt: 'Test prompt',
        gadgets: [],
        skills: [],
        events: [],
        injectFacts: []
      };

      const result = minion.reconfigure(newCostume);

      const exitResult = await result.pipe(Effect.runPromiseExit);

      // Should succeed
      expect(exitResult._tag).toBe('Success');

      // Verify model was changed
      expect(minion.costume?.model).toBe('different-model');

      killMinion(minion);
    });

    it('SLICE 14: reconfigure() fails when minion has no initial costume', async () => {
      const minion = createMinion(); // No costume

      // Attempt to reconfigure without initial costume
      const newCostume = {
        model: 'test-model',
        systemPrompt: 'New prompt',
        gadgets: [],
        skills: [],
        events: [],
        injectFacts: []
      };

      const result = minion.reconfigure(newCostume);

      const exitResult = await result.pipe(Effect.runPromiseExit);

      // Should fail with ReconfigureError
      expect(exitResult._tag).toBe('Failure');
      if (exitResult._tag === 'Failure') {
        expect(exitResult.cause._tag).toBe('Fail');
        if (exitResult.cause._tag === 'Fail') {
          const error = exitResult.cause.error;
          expect(error._tag).toBe('ReconfigureError');
          expect(error.reason).toContain('without initial costume');
        }
      }

      killMinion(minion);
    });

    it('SLICE 15: minion ID remains unchanged after reconfigure', async () => {
      const originalCostume = {
        model: 'test-model',
        systemPrompt: 'Original prompt',
        gadgets: [],
        skills: [],
        events: [],
        injectFacts: []
      };

      const minion = createMinion(originalCostume);
      const originalId = minion.id;

      // Reconfigure with new costume
      const newCostume = {
        model: 'test-model',
        systemPrompt: 'New prompt',
        gadgets: [],
        skills: [],
        events: [],
        injectFacts: []
      };

      const result = minion.reconfigure(newCostume);

      const exitResult = await result.pipe(Effect.runPromiseExit);

      expect(exitResult._tag).toBe('Success');

      // Verify ID unchanged
      expect(minion.id).toBe(originalId);

      killMinion(minion);
    });

    it('SLICE 16: minion remains operational after successful model change reconfigure', async () => {
      const originalCostume = {
        model: 'original-model',
        systemPrompt: 'Original prompt',
        gadgets: [],
        skills: [],
        events: [],
        injectFacts: []
      };

      const minion = createMinion(originalCostume);
      const originalId = minion.id;

      // Reconfigure with model change (now allowed)
      const newCostume = {
        model: 'different-model',
        systemPrompt: 'New prompt',
        gadgets: [],
        skills: [],
        events: [],
        injectFacts: []
      };

      const result = minion.reconfigure(newCostume);
      const exitResult = await result.pipe(Effect.runPromiseExit);

      // Should succeed
      expect(exitResult._tag).toBe('Success');

      // Verify minion is still operational with new costume
      expect(minion.id).toBe(originalId);
      expect(minion.status).toBe('waiting');
      expect(minion.costume?.model).toBe('different-model');
      expect(minion.costume?.systemPrompt).toBe('New prompt');

      // Verify minion can still send messages
      await minion.send({ type: 'user', content: 'test', timestamp: Date.now() });
      expect(minion.status).toBe('processing');

      killMinion(minion);
    });

    it('SLICE 17: workbench property is undefined when spawned without workbench', () => {
      const minion = createMinion();

      expect(minion.workbench).toBeUndefined();

      killMinion(minion);
    });

    it('SLICE 18: workbench property exposes workbench when provided', () => {
      // Create a mock workbench
      const mockWorkbench = {
        files: new Map(),
        facts: [],
        addFile: vi.fn(),
        addFact: vi.fn(),
        refreshFile: vi.fn(),
        refreshDirtyFiles: vi.fn(),
        isDirty: vi.fn(),
        fileChanges: vi.fn(),
        onFileChange: vi.fn(),
        writeFile: vi.fn()
      };

      const minion = createMinion(undefined, mockWorkbench);

      expect(minion.workbench).toBeDefined();
      expect(minion.workbench).toBe(mockWorkbench);

      killMinion(minion);
    });

    it('SLICE 19: reconfigure() preserves workbench reference', async () => {
      const originalCostume = {
        model: 'test-model',
        systemPrompt: 'Original prompt',
        gadgets: [],
        skills: [],
        events: [],
        injectFacts: ['fact1']
      };

      const mockWorkbench = {
        files: new Map(),
        facts: [],
        addFile: vi.fn(),
        addFact: vi.fn(),
        refreshFile: vi.fn(),
        refreshDirtyFiles: vi.fn(),
        isDirty: vi.fn(),
        fileChanges: vi.fn(),
        onFileChange: vi.fn(),
        writeFile: vi.fn()
      };

      const minion = createMinion(originalCostume, mockWorkbench);

      // Verify workbench is set initially
      expect(minion.workbench).toBe(mockWorkbench);

      // Reconfigure with new costume
      const newCostume = {
        model: 'test-model',
        systemPrompt: 'New prompt',
        gadgets: [],
        skills: [],
        events: [],
        injectFacts: ['fact2']
      };

      const result = minion.reconfigure(newCostume);
      const exitResult = await result.pipe(Effect.runPromiseExit);

      expect(exitResult._tag).toBe('Success');

      // Verify workbench is still the same reference
      expect(minion.workbench).toBe(mockWorkbench);

      killMinion(minion);
    });

    it('SLICE 20: reconfigure() updates fact filtering (different injectFacts)', async () => {
      const originalCostume = {
        model: 'test-model',
        systemPrompt: 'Original prompt',
        gadgets: [],
        skills: [],
        events: [],
        injectFacts: ['category-a']
      };

      const mockWorkbench = {
        files: new Map(),
        facts: [
          { fact: 'fact A', category: 'category-a', discoveredBy: 'test' },
          { fact: 'fact B', category: 'category-b', discoveredBy: 'test' }
        ],
        addFile: vi.fn(),
        addFact: vi.fn(),
        refreshFile: vi.fn(),
        refreshDirtyFiles: vi.fn(),
        isDirty: vi.fn(),
        fileChanges: vi.fn(),
        onFileChange: vi.fn(),
        writeFile: vi.fn()
      };

      const minion = createMinion(originalCostume, mockWorkbench);

      // Reconfigure with different injectFacts
      const newCostume = {
        model: 'test-model',
        systemPrompt: 'New prompt',
        gadgets: [],
        skills: [],
        events: [],
        injectFacts: ['category-b'] // Different fact filtering
      };

      const result = minion.reconfigure(newCostume);
      const exitResult = await result.pipe(Effect.runPromiseExit);

      expect(exitResult._tag).toBe('Success');

      // Verify costume was updated
      expect(minion.costume?.injectFacts).toEqual(['category-b']);

      killMinion(minion);
    });
  });
}

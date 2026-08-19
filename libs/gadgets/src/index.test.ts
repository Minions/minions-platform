/**
 * Tests for @minions/gadgets interface contracts
 *
 * These tests validate that the type definitions work as expected and
 * establish the contract for how gadgets should behave.
 */

import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import type { ExecutableGadget, ToolResult, GadgetFactory, Tool } from './index';

describe('@minions/gadgets', () => {
  describe('Tool interface', () => {
    it('validates tool structure', () => {
      const tool: Tool = {
        name: 'test_tool',
        description: 'A test tool',
        input_schema: {
          type: 'object',
          properties: {
            value: { type: 'string' }
          }
        }
      };

      expect(tool.name).toBe('test_tool');
      expect(tool.description).toBe('A test tool');
      expect(tool.input_schema).toBeDefined();
    });

    it('allows tool without input_schema', () => {
      const tool: Tool = {
        name: 'simple_tool',
        description: 'A simple tool'
      };

      expect(tool.input_schema).toBeUndefined();
    });
  });

  describe('ToolResult type', () => {
    it('validates success result', () => {
      const result: ToolResult = {
        success: true,
        result: { message: 'Operation successful' }
      };

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({ message: 'Operation successful' });
      }
    });

    it('validates failure result', () => {
      const result: ToolResult = {
        success: false,
        error: 'Operation failed'
      };

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Operation failed');
      }
    });

    it('supports unknown result types', () => {
      const results: ToolResult[] = [
        { success: true, result: 'string result' },
        { success: true, result: 42 },
        { success: true, result: { complex: 'object' } },
        { success: true, result: ['array', 'of', 'values'] },
        { success: true, result: null },
        { success: true, result: undefined }
      ];

      results.forEach(result => {
        expect(result.success).toBe(true);
      });
    });
  });

  describe('ExecutableGadget interface', () => {
    it('creates a gadget that succeeds', async () => {
      const gadget: ExecutableGadget = {
        tool: {
          name: 'success_gadget',
          description: 'Always succeeds'
        },
        execute: (_input: unknown) => Effect.succeed({
          success: true,
          result: 'Success!'
        })
      };

      const result = await Effect.runPromise(gadget.execute({}));

      expect(result).toEqual({
        success: true,
        result: 'Success!'
      });
    });

    it('creates a gadget that fails', async () => {
      const gadget: ExecutableGadget = {
        tool: {
          name: 'failing_gadget',
          description: 'Always fails'
        },
        execute: (_input: unknown) => Effect.succeed({
          success: false,
          error: 'Operation not supported'
        })
      };

      const result = await Effect.runPromise(gadget.execute({}));

      expect(result).toEqual({
        success: false,
        error: 'Operation not supported'
      });
    });

    it('creates a gadget that catches errors', async () => {
      const gadget: ExecutableGadget = {
        tool: {
          name: 'error_catching_gadget',
          description: 'Catches errors and returns them'
        },
        execute: (_input: unknown) =>
          Effect.gen(function* () {
            // Simulate an error
            yield* Effect.fail(new Error('Something went wrong'));
            return { success: true, result: 'unreachable' } as ToolResult;
          }).pipe(
            Effect.catchAll((error) =>
              Effect.succeed({
                success: false,
                error: error instanceof Error ? error.message : String(error)
              } as ToolResult)
            )
          )
      };

      const result = await Effect.runPromise(gadget.execute({})) as ToolResult;

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Something went wrong');
      }
    });

    it('creates a gadget that uses input', async () => {
      const gadget: ExecutableGadget = {
        tool: {
          name: 'echo_gadget',
          description: 'Echoes input back'
        },
        execute: (input: unknown) => Effect.succeed({
          success: true,
          result: input
        })
      };

      const testInput = { message: 'Hello, gadget!' };
      const result = await Effect.runPromise(gadget.execute(testInput));

      expect(result).toEqual({
        success: true,
        result: testInput
      });
    });

    it('creates a gadget with captured context', async () => {
      // Simulate mission context
      const capturedContext = {
        minionId: 'minion-123',
        taskId: 'task-456'
      };

      const gadget: ExecutableGadget = {
        tool: {
          name: 'context_aware_gadget',
          description: 'Uses captured context'
        },
        execute: (input: unknown) => Effect.succeed({
          success: true,
          result: {
            input,
            minionId: capturedContext.minionId,
            taskId: capturedContext.taskId
          }
        })
      };

      const result = await Effect.runPromise(gadget.execute({ action: 'test' })) as ToolResult;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toEqual({
          input: { action: 'test' },
          minionId: 'minion-123',
          taskId: 'task-456'
        });
      }
    });
  });

  describe('GadgetFactory type', () => {
    it('creates a factory that returns gadgets', () => {
      interface TestContext {
        prefix: string;
        suffix: string;
      }

      const createTestGadgets: GadgetFactory<TestContext> = (context) => [
        {
          tool: {
            name: 'prefix_gadget',
            description: 'Adds prefix to input'
          },
          execute: (input: unknown) => Effect.succeed({
            success: true,
            result: `${context.prefix}${input}`
          })
        },
        {
          tool: {
            name: 'suffix_gadget',
            description: 'Adds suffix to input'
          },
          execute: (input: unknown) => Effect.succeed({
            success: true,
            result: `${input}${context.suffix}`
          })
        }
      ];

      const gadgets = createTestGadgets({ prefix: '[', suffix: ']' });

      expect(gadgets).toHaveLength(2);
      expect(gadgets[0].tool.name).toBe('prefix_gadget');
      expect(gadgets[1].tool.name).toBe('suffix_gadget');
    });

    it('uses factory-created gadgets with context', async () => {
      interface EventContext {
        eventBusId: string;
      }

      const createEventGadgets: GadgetFactory<EventContext> = (context) => [
        {
          tool: {
            name: 'emit_event',
            description: 'Emits an event'
          },
          execute: (input: unknown) => Effect.succeed({
            success: true,
            result: `Event emitted to bus ${context.eventBusId}: ${JSON.stringify(input)}`
          })
        }
      ];

      const gadgets = createEventGadgets({ eventBusId: 'bus-789' });
      const result = await Effect.runPromise(
        gadgets[0].execute({ type: 'test-event', payload: { data: 'test' } })
      ) as ToolResult;

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toContain('bus-789');
        expect(result.result).toContain('test-event');
      }
    });
  });

  describe('Effect composition', () => {
    it('composes multiple gadget executions', async () => {
      const gadget1: ExecutableGadget = {
        tool: { name: 'gadget1', description: 'First gadget' },
        execute: (input: unknown) => Effect.succeed({
          success: true,
          result: `Step 1: ${input}`
        })
      };

      const gadget2: ExecutableGadget = {
        tool: { name: 'gadget2', description: 'Second gadget' },
        execute: (input: unknown) => Effect.succeed({
          success: true,
          result: `Step 2: ${input}`
        })
      };

      const composed: Effect.Effect<ToolResult, never, never> = Effect.gen(function* () {
        const result1 = yield* gadget1.execute('start');
        if (!result1.success) {
          return result1;
        }

        const result2 = yield* gadget2.execute(result1.result);
        return result2;
      });

      const result = await Effect.runPromise(composed);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.result).toContain('Step 2');
        expect(result.result).toContain('Step 1');
      }
    });

    it('handles failure in composition chain', async () => {
      const successGadget: ExecutableGadget = {
        tool: { name: 'success', description: 'Succeeds' },
        execute: (_input: unknown) => Effect.succeed({
          success: true,
          result: 'Success'
        })
      };

      const failureGadget: ExecutableGadget = {
        tool: { name: 'failure', description: 'Fails' },
        execute: (_input: unknown) => Effect.succeed({
          success: false,
          error: 'Failed'
        })
      };

      const composed: Effect.Effect<ToolResult, never, never> = Effect.gen(function* () {
        const result1 = yield* successGadget.execute('input');
        if (!result1.success) {
          return result1;
        }

        const result2 = yield* failureGadget.execute(result1.result);
        if (!result2.success) {
          return result2;
        }

        return { success: true, result: 'unreachable' } as ToolResult;
      });

      const result = await Effect.runPromise(composed);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Failed');
      }
    });
  });

  describe('Type safety', () => {
    it('enforces Effect return type', () => {
      // This test validates that the type system works correctly
      // If this compiles, the types are correct

      const gadget: ExecutableGadget = {
        tool: { name: 'typed_gadget', description: 'Type-safe gadget' },
        execute: (_input: unknown) => Effect.succeed({
          success: true,
          result: { typed: 'value' }
        } as ToolResult)
      };

      // Verify the execute signature
      const executeFunc: (input: unknown) => Effect.Effect<ToolResult, never, never> = gadget.execute;
      expect(executeFunc).toBeDefined();
    });

    it('validates ToolResult discriminated union', () => {
      const successResult: ToolResult = { success: true, result: 'data' };
      const failureResult: ToolResult = { success: false, error: 'error' };

      // Type narrowing should work
      if (successResult.success) {
        expect(successResult.result).toBe('data');
      }

      if (!failureResult.success) {
        expect(failureResult.error).toBe('error');
      }
    });
  });
});

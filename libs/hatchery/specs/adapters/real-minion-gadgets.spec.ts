import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import { RealMinion } from '../../src/adapters/minions/RealMinion';
import type { MinionSpec, MinionMessage } from '../../src/domain';
import type { IMinionClient } from '../../src/ports/IMinionClient';

/**
 * Stub client for testing RealMinion
 *
 * This is a minimal stub that implements IMinionClient interface
 * but doesn't actually do anything. We only need it to construct
 * RealMinion for testing executeGadget method.
 */
class StubClient implements IMinionClient {
  readonly type = 'brainless';

  async start(_spec: MinionSpec): Promise<void> {
    // Stub - does nothing
  }

  async stop(): Promise<void> {
    // Stub - does nothing
  }

  async send(_message: MinionMessage): Promise<void> {
    // Stub - does nothing
  }

  async *receive(): AsyncIterableIterator<MinionMessage> {
    // Stub - yields nothing
  }

  kill(): void {
    // Stub - does nothing
  }

  interrupt(): void {
    // Stub - does nothing
  }
}

function createTestSpec(): MinionSpec {
  return {
    client: 'claude-code',
    wing: '/test',
    model: 'test-model',
    useBuiltInSystemPrompt: true
  };
}

describe('RealMinion Executable Gadgets', () => {
  it('executeGadget returns result when gadget is found', async () => {
    const testGadget = {
      tool: {
        name: 'test_gadget',
        description: 'A test gadget',
        input_schema: { type: 'object' }
      },
      execute: (input: unknown) => Effect.succeed({
        success: true as const,
        result: { echo: input }
      })
    };

    const client = new StubClient();
    const minion = new RealMinion(createTestSpec(), client, [testGadget]);

    const result = await Effect.runPromise(
      minion.executeGadget('test_gadget', { message: 'hello' })
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.result).toEqual({ echo: { message: 'hello' } });
    }
  });

  it('executeGadget returns error when gadget execution fails', async () => {
    const failingGadget = {
      tool: {
        name: 'failing_gadget',
        description: 'A gadget that fails',
        input_schema: { type: 'object' }
      },
      execute: (_input: unknown) => Effect.succeed({
        success: false as const,
        error: 'Gadget execution failed'
      })
    };

    const client = new StubClient();
    const minion = new RealMinion(createTestSpec(), client, [failingGadget]);

    const result = await Effect.runPromise(
      minion.executeGadget('failing_gadget', {})
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('Gadget execution failed');
    }
  });

  it('executeGadget returns error when gadget not found', async () => {
    const testGadget = {
      tool: {
        name: 'test_gadget',
        description: 'A test gadget',
        input_schema: { type: 'object' }
      },
      execute: (input: unknown) => Effect.succeed({
        success: true as const,
        result: input
      })
    };

    const client = new StubClient();
    const minion = new RealMinion(createTestSpec(), client, [testGadget]);

    const result = await Effect.runPromise(
      minion.executeGadget('nonexistent_gadget', {})
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('No executable gadget found');
      expect(result.error).toContain('nonexistent_gadget');
    }
  });

  it('executeGadget works without executable gadgets', async () => {
    const client = new StubClient();
    const minion = new RealMinion(createTestSpec(), client);

    const result = await Effect.runPromise(
      minion.executeGadget('any_tool', {})
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('No executable gadget found');
    }
  });

  it('executeGadget finds correct gadget by name', async () => {
    const gadget1 = {
      tool: {
        name: 'gadget_1',
        description: 'First gadget',
        input_schema: { type: 'object' }
      },
      execute: (_input: unknown) => Effect.succeed({
        success: true as const,
        result: 'result_1'
      })
    };

    const gadget2 = {
      tool: {
        name: 'gadget_2',
        description: 'Second gadget',
        input_schema: { type: 'object' }
      },
      execute: (_input: unknown) => Effect.succeed({
        success: true as const,
        result: 'result_2'
      })
    };

    const client = new StubClient();
    const minion = new RealMinion(createTestSpec(), client, [gadget1, gadget2]);

    const result1 = await Effect.runPromise(
      minion.executeGadget('gadget_1', {})
    );
    expect(result1.success).toBe(true);
    if (result1.success) {
      expect(result1.result).toBe('result_1');
    }

    const result2 = await Effect.runPromise(
      minion.executeGadget('gadget_2', {})
    );
    expect(result2.success).toBe(true);
    if (result2.success) {
      expect(result2.result).toBe('result_2');
    }
  });
});

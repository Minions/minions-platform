import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Effect } from 'effect';
import { testMinionContract } from '../contracts/minion-contract';
import { BrainlessMinion } from '../../src/adapters/minions/BrainlessMinion';
import type { MinionSpec, Costume } from '../../src/domain';
import { promptForText, promptForThinking, promptForToolUse, promptForError, promptForStatus, createToolResult } from '../../src/domain';
import type { IWorkbench } from '@minions/domain-types';

// STEP 1: Run contract tests (vertical slices)
// Note: Spec requests 'claude-code' but BrainlessMinion is returned (via ZombieHatchery pattern)
testMinionContract(
  'BrainlessMinion',
  (costume?: Costume, workbench?: IWorkbench) => {
    const spec: MinionSpec & { workbench?: IWorkbench } = {
      client: 'claude-code', // Request real client type
      wing: '/test',
      model: 'test-model',
      useBuiltInSystemPrompt: true,
      costume,
      workbench
    };
    return new BrainlessMinion(spec);
  },
  (minion) => {
    // Cast to BrainlessMinion to access kill()
    (minion as BrainlessMinion).kill();
  },
  true // Use fake timers for BrainlessMinion tests
);

// STEP 2: BrainlessMinion-specific tests (dual co-routine)
describe('Spec S1.7: BrainlessMinion Dual Co-routine Features', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('implements IMinion interface', () => {
    const minion = new BrainlessMinion(createTestSpec());

    expect(minion.id).toBeDefined();
    expect(typeof minion.id).toBe('string');
    expect(minion.spec).toBeDefined();
    expect(minion.send).toBeInstanceOf(Function);
    expect(minion.receive).toBeInstanceOf(Function);

    minion.kill();
  });

  it('is alive on construction', () => {
    const minion = new BrainlessMinion(createTestSpec());

    expect(minion.isAlive()).toBe(true);

    minion.kill();
  });

  it('dies when killed', () => {
    const minion = new BrainlessMinion(createTestSpec());

    expect(minion.isAlive()).toBe(true);

    minion.kill();

    expect(minion.isAlive()).toBe(false);
  });

  it('supports production send and test receive', async () => {
    const minion = new BrainlessMinion(createTestSpec());

    // Production code sends
    await minion.send({
      type: 'user',
      content: 'Hello',
      timestamp: Date.now()
    });

    // Test receives
    const receivedPromise = minion.testReceive().next();
    await vi.advanceTimersByTimeAsync(20);
    const received = await receivedPromise;
    expect(received.value.content).toBe('Hello');

    minion.kill();
  });

  it('supports test send and production receive', async () => {
    const minion = new BrainlessMinion(createTestSpec());

    // Test sends
    await minion.testSend({
      type: 'text',
      content: 'Response',
      timestamp: Date.now()
    });

    // Production receives
    const receivedPromise = minion.receive().next();
    await vi.advanceTimersByTimeAsync(20);
    const received = await receivedPromise;
    expect(received.value.content).toBe('Response');

    minion.kill();
  });

  it('supports bidirectional communication', async () => {
    const minion = new BrainlessMinion(createTestSpec());

    // Production asks question
    await minion.send({
      type: 'user',
      content: 'What is 2+2?',
      timestamp: Date.now()
    });

    // Test receives question
    const questionPromise = minion.testReceive().next();
    await vi.advanceTimersByTimeAsync(20);
    const question = await questionPromise;
    expect(question.value.content).toBe('What is 2+2?');

    // Test sends answer
    await minion.testSend({
      type: 'text',
      content: '4',
      timestamp: Date.now()
    });

    // Production receives answer
    const answerPromise = minion.receive().next();
    await vi.advanceTimersByTimeAsync(20);
    const answer = await answerPromise;
    expect(answer.value.content).toBe('4');

    minion.kill();
  });

  it.skip('buffers messages when not consuming', async () => {
    const minion = new BrainlessMinion(createTestSpec());

    // Send multiple messages
    await minion.send({ type: 'user', content: 'Msg 1', timestamp: Date.now() });
    await minion.send({ type: 'user', content: 'Msg 2', timestamp: Date.now() });
    await minion.send({ type: 'user', content: 'Msg 3', timestamp: Date.now() });

    // Create one iterator and receive all
    const iterator = minion.testReceive();

    const msg1Promise = iterator.next();
    await vi.advanceTimersByTimeAsync(20);
    const msg1 = await msg1Promise;

    const msg2Promise = iterator.next();
    await vi.advanceTimersByTimeAsync(20);
    const msg2 = await msg2Promise;

    const msg3Promise = iterator.next();
    await vi.advanceTimersByTimeAsync(20);
    const msg3 = await msg3Promise;

    expect(msg1.value.content).toBe('Msg 1');
    expect(msg2.value.content).toBe('Msg 2');
    expect(msg3.value.content).toBe('Msg 3');

    minion.kill();
  });
});

function createTestSpec(): MinionSpec {
  return {
    client: 'claude-code', // Request real client type (as tests would)
    wing: '/test',
    model: 'test-model',
    useBuiltInSystemPrompt: true
  };
}

// STEP 3: BrainlessMinion default back-side co-routine tests
describe('BrainlessMinion Default Back-side Co-routine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('responds to promptForText with text message', async () => {
    const minion = new BrainlessMinion(createTestSpec());

    // Send prompt
    await minion.send(promptForText('Hello world'));

    // Advance timers and get response
    const responsePromise = minion.receive().next();
    await vi.advanceTimersByTimeAsync(20);
    const response = await responsePromise;

    expect(response.value.type).toBe('text');
    if (response.value.type === 'text') {
      expect(response.value.content).toBe('Hello world');
    }

    minion.kill();
  });

  it('responds to promptForThinking with thinking message', async () => {
    const minion = new BrainlessMinion(createTestSpec());

    // Send prompt
    await minion.send(promptForThinking('Let me analyze this'));

    // Get response
    const responsePromise = minion.receive().next();
    await vi.advanceTimersByTimeAsync(20);
    const response = await responsePromise;

    expect(response.value.type).toBe('thinking');
    if (response.value.type === 'thinking') {
      expect(response.value.content).toBe('Let me analyze this');
    }

    minion.kill();
  });

  it('responds to promptForToolUse with tool_use message', async () => {
    const minion = new BrainlessMinion(createTestSpec());

    // Send prompt
    await minion.send(promptForToolUse('read_file', { path: '/test.txt' }));

    // Get response
    const responsePromise = minion.receive().next();
    await vi.advanceTimersByTimeAsync(20);
    const response = await responsePromise;

    expect(response.value.type).toBe('tool_use');
    if (response.value.type === 'tool_use') {
      expect(response.value.name).toBe('read_file');
      expect(response.value.input).toEqual({ path: '/test.txt' });
      expect(response.value.id).toBeDefined();
    }

    minion.kill();
  });

  it('responds to promptForError with error message', async () => {
    const minion = new BrainlessMinion(createTestSpec());

    // Send prompt
    await minion.send(promptForError('Something went wrong', 'test_error'));

    // Get response
    const responsePromise = minion.receive().next();
    await vi.advanceTimersByTimeAsync(20);
    const response = await responsePromise;

    expect(response.value.type).toBe('error');
    if (response.value.type === 'error') {
      expect(response.value.error.message).toBe('Something went wrong');
      expect(response.value.error.code).toBe('test_error');
    }

    minion.kill();
  });

  it('responds to promptForStatus with status message', async () => {
    const minion = new BrainlessMinion(createTestSpec());

    // Send prompt
    await minion.send(promptForStatus('working on it'));

    // Get response
    const responsePromise = minion.receive().next();
    await vi.advanceTimersByTimeAsync(20);
    const response = await responsePromise;

    expect(response.value.type).toBe('status');
    if (response.value.type === 'status') {
      expect(response.value.status).toBe('working on it');
    }

    minion.kill();
  });

  it('createToolResult generates correct tool_result message', () => {
    const result = createToolResult('tool_123', { data: 'test' }, false);

    expect(result.type).toBe('tool_result');
    expect(result.tool_use_id).toBe('tool_123');
    expect(result.content).toEqual({ data: 'test' });
    expect(result.is_error).toBe(false);
    expect(result.timestamp).toBeDefined();
  });

  it('allows replacing back-side co-routine for custom behavior', async () => {
    // Custom back-side that always responds with "custom"
    const customBackSide = async (minion: BrainlessMinion) => {
      for await (const _message of minion.testReceive()) {
        await minion.testSend({
          type: 'text',
          content: 'custom response',
          timestamp: Date.now()
        });
      }
    };

    const minion = new BrainlessMinion(createTestSpec(), customBackSide);

    // Send any message
    await minion.send({ type: 'user', content: 'anything', timestamp: Date.now() });

    // Get custom response
    const responsePromise = minion.receive().next();
    await vi.advanceTimersByTimeAsync(20);
    const response = await responsePromise;

    expect(response.value.type).toBe('text');
    if (response.value.type === 'text') {
      expect(response.value.content).toBe('custom response');
    }

    minion.kill();
  });

  it('responds to /exit by stopping gracefully', async () => {
    const minion = new BrainlessMinion(createTestSpec());

    expect(minion.isAlive()).toBe(true);

    // Send /exit command
    await minion.send({ type: 'user', content: '/exit', timestamp: Date.now() });

    // Advance timers to process the command
    await vi.advanceTimersByTimeAsync(50);

    // Minion should be dead
    expect(minion.isAlive()).toBe(false);
  });

  it('interrupt() sets interrupt flag', async () => {
    const minion = new BrainlessMinion(createTestSpec());

    expect(minion.wasInterrupted()).toBe(false);

    // Interrupt the minion
    minion.interrupt();

    // Flag should be set
    expect(minion.wasInterrupted()).toBe(true);

    // After timeout, flag should clear
    await vi.advanceTimersByTimeAsync(150);
    expect(minion.wasInterrupted()).toBe(false);

    minion.kill();
  });

  it('kill() stops the minion', async () => {
    const minion = new BrainlessMinion(createTestSpec());

    expect(minion.isAlive()).toBe(true);

    minion.kill();

    expect(minion.isAlive()).toBe(false);
  });
});

// STEP 5: BrainlessMinion StatusChange event tests (Story 8 - test helper feature)
describe('Story 8: BrainlessMinion StatusChange Events', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('status transitions to waiting when completeTurn() is called', async () => {
    const minion = new BrainlessMinion(createTestSpec());

    // Send message to transition to processing
    await minion.send({ type: 'user', content: 'Hello', timestamp: Date.now() });
    expect(minion.status).toBe('processing');

    // Complete turn
    minion.completeTurn();

    expect(minion.status).toBe('waiting');

    minion.kill();
  });

  it('emits StatusChange event on waiting -> processing transition', async () => {
    const statusChanges: Array<{ oldStatus: string; newStatus: string }> = [];
    const onStatusChange = (_minionId: string, oldStatus: 'processing' | 'waiting' | 'dead', newStatus: 'processing' | 'waiting' | 'dead') => {
      statusChanges.push({ oldStatus, newStatus });
    };

    const minion = new BrainlessMinion(createTestSpec(), undefined, { onStatusChange });

    await minion.send({ type: 'user', content: 'Hello', timestamp: Date.now() });

    expect(statusChanges).toHaveLength(1);
    expect(statusChanges[0]).toEqual({ oldStatus: 'waiting', newStatus: 'processing' });

    minion.kill();
  });

  it('emits StatusChange event on processing -> waiting transition', async () => {
    const statusChanges: Array<{ oldStatus: string; newStatus: string }> = [];
    const onStatusChange = (_minionId: string, oldStatus: 'processing' | 'waiting' | 'dead', newStatus: 'processing' | 'waiting' | 'dead') => {
      statusChanges.push({ oldStatus, newStatus });
    };

    const minion = new BrainlessMinion(createTestSpec(), undefined, { onStatusChange });

    await minion.send({ type: 'user', content: 'Hello', timestamp: Date.now() });
    minion.completeTurn();

    expect(statusChanges).toHaveLength(2);
    expect(statusChanges[0]).toEqual({ oldStatus: 'waiting', newStatus: 'processing' });
    expect(statusChanges[1]).toEqual({ oldStatus: 'processing', newStatus: 'waiting' });

    minion.kill();
  });

  it('emits StatusChange event on any -> dead transition', () => {
    const statusChanges: Array<{ oldStatus: string; newStatus: string }> = [];
    const onStatusChange = (_minionId: string, oldStatus: 'processing' | 'waiting' | 'dead', newStatus: 'processing' | 'waiting' | 'dead') => {
      statusChanges.push({ oldStatus, newStatus });
    };

    const minion = new BrainlessMinion(createTestSpec(), undefined, { onStatusChange });

    minion.kill();

    expect(statusChanges).toHaveLength(1);
    expect(statusChanges[0]).toEqual({ oldStatus: 'waiting', newStatus: 'dead' });
  });

  it('StatusChange callback receives minionId', async () => {
    let receivedMinionId = '';
    const onStatusChange = (minionId: string) => {
      receivedMinionId = minionId;
    };

    const minion = new BrainlessMinion(createTestSpec(), undefined, { onStatusChange });

    await minion.send({ type: 'user', content: 'Hello', timestamp: Date.now() });

    expect(receivedMinionId).toBe(minion.id);

    minion.kill();
  });

  it('does not emit StatusChange event when status does not change', async () => {
    const statusChanges: Array<{ oldStatus: string; newStatus: string }> = [];
    const onStatusChange = (_minionId: string, oldStatus: 'processing' | 'waiting' | 'dead', newStatus: 'processing' | 'waiting' | 'dead') => {
      statusChanges.push({ oldStatus, newStatus });
    };

    const minion = new BrainlessMinion(createTestSpec(), undefined, { onStatusChange });

    // Send multiple messages - should only transition once
    await minion.send({ type: 'user', content: 'Hello', timestamp: Date.now() });
    await minion.send({ type: 'user', content: 'World', timestamp: Date.now() });

    // Should only have one transition (waiting -> processing)
    expect(statusChanges).toHaveLength(1);
    expect(statusChanges[0]).toEqual({ oldStatus: 'waiting', newStatus: 'processing' });

    minion.kill();
  });

  it('StatusChange callback is optional', async () => {
    // Should not throw when no callback provided
    const minion = new BrainlessMinion(createTestSpec());

    await minion.send({ type: 'user', content: 'Hello', timestamp: Date.now() });
    minion.completeTurn();
    minion.kill();

    // If we reach here without error, the test passes
    expect(minion.status).toBe('dead');
  });
});

describe('Story 4: Synthetic History Injection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts syntheticHistory in spec and includes in receive()', async () => {
    const syntheticHistory = [
      { type: 'tool_result' as const, tool_use_id: 'file1', content: 'file contents', is_error: false, timestamp: 1000 },
      { type: 'tool_result' as const, tool_use_id: 'fact1', content: 'fact contents', is_error: false, timestamp: 2000 },
    ];

    const spec = {
      ...createTestSpec(),
      syntheticHistory,
    };

    const minion = new BrainlessMinion(spec);

    // Receive synthetic messages
    const iterator = minion.receive();

    const msg1Promise = iterator.next();
    await vi.advanceTimersByTimeAsync(20);
    const msg1 = await msg1Promise;

    const msg2Promise = iterator.next();
    await vi.advanceTimersByTimeAsync(20);
    const msg2 = await msg2Promise;

    expect(msg1.value).toEqual(syntheticHistory[0]);
    expect(msg2.value).toEqual(syntheticHistory[1]);

    minion.kill();
  });

  it('synthetic messages appear in receive() before live messages', async () => {
    const syntheticHistory = [
      { type: 'tool_result' as const, tool_use_id: 'synthetic1', content: 'synthetic', is_error: false, timestamp: 1000 },
    ];

    const spec = {
      ...createTestSpec(),
      syntheticHistory,
    };

    const minion = new BrainlessMinion(spec);

    // Send a live message
    await minion.testSend({ type: 'text', content: 'live message', timestamp: 3000 });

    // Receive messages - synthetic should come first
    const iterator = minion.receive();

    const msg1Promise = iterator.next();
    await vi.advanceTimersByTimeAsync(20);
    const msg1 = await msg1Promise;

    const msg2Promise = iterator.next();
    await vi.advanceTimersByTimeAsync(20);
    const msg2 = await msg2Promise;

    expect(msg1.value.type).toBe('tool_result');
    if (msg1.value.type === 'tool_result') {
      expect(msg1.value.tool_use_id).toBe('synthetic1');
    }

    expect(msg2.value.type).toBe('text');
    if (msg2.value.type === 'text') {
      expect(msg2.value.content).toBe('live message');
    }

    minion.kill();
  });

  it('receive() filter works with synthetic messages', async () => {
    const syntheticHistory = [
      { type: 'tool_result' as const, tool_use_id: 'file1', content: 'file contents', is_error: false, timestamp: 1000 },
      { type: 'text' as const, content: 'synthetic text', timestamp: 2000 },
      { type: 'tool_result' as const, tool_use_id: 'fact1', content: 'fact contents', is_error: false, timestamp: 3000 },
    ];

    const spec = {
      ...createTestSpec(),
      syntheticHistory,
    };

    const minion = new BrainlessMinion(spec);

    // Filter for only tool_result messages
    const iterator = minion.receive({ type: 'tool_result' });

    const msg1Promise = iterator.next();
    await vi.advanceTimersByTimeAsync(20);
    const msg1 = await msg1Promise;

    const msg2Promise = iterator.next();
    await vi.advanceTimersByTimeAsync(20);
    const msg2 = await msg2Promise;

    // Should only receive tool_result messages
    expect(msg1.value.type).toBe('tool_result');
    if (msg1.value.type === 'tool_result') {
      expect(msg1.value.tool_use_id).toBe('file1');
    }

    expect(msg2.value.type).toBe('tool_result');
    if (msg2.value.type === 'tool_result') {
      expect(msg2.value.tool_use_id).toBe('fact1');
    }

    minion.kill();
  });

  it('synthetic messages do not appear in testReceive() (they are for production)', async () => {
    const syntheticHistory = [
      { type: 'tool_result' as const, tool_use_id: 'file1', content: 'file contents', is_error: false, timestamp: 1000 },
    ];

    const spec = {
      ...createTestSpec(),
      syntheticHistory,
    };

    const minion = new BrainlessMinion(spec);

    // Send a production message
    await minion.send({ type: 'user', content: 'Hello', timestamp: Date.now() });

    // Test observes production messages via testReceive(), not synthetic
    const iterator = minion.testReceive();

    const msg1Promise = iterator.next();
    await vi.advanceTimersByTimeAsync(20);
    const msg1 = await msg1Promise;

    expect(msg1.value.type).toBe('user');
    if (msg1.value.type === 'user') {
      expect(msg1.value.content).toBe('Hello');
    }

    minion.kill();
  });

  it('works without syntheticHistory (backwards compatibility)', async () => {
    const spec = createTestSpec();
    const minion = new BrainlessMinion(spec);

    // Send a live message
    await minion.testSend({ type: 'text', content: 'live message', timestamp: 3000 });

    // Receive should work normally
    const iterator = minion.receive();

    const msgPromise = iterator.next();
    await vi.advanceTimersByTimeAsync(20);
    const msg = await msgPromise;

    expect(msg.value.type).toBe('text');
    if (msg.value.type === 'text') {
      expect(msg.value.content).toBe('live message');
    }

    minion.kill();
  });

  it('handles empty syntheticHistory array', async () => {
    const spec = {
      ...createTestSpec(),
      syntheticHistory: [],
    };

    const minion = new BrainlessMinion(spec);

    // Send a live message
    await minion.testSend({ type: 'text', content: 'live message', timestamp: 3000 });

    // Receive should work normally
    const iterator = minion.receive();

    const msgPromise = iterator.next();
    await vi.advanceTimersByTimeAsync(20);
    const msg = await msgPromise;

    expect(msg.value.type).toBe('text');
    if (msg.value.type === 'text') {
      expect(msg.value.content).toBe('live message');
    }

    minion.kill();
  });

  it('synthetic messages have appropriate timestamps', async () => {
    const syntheticHistory = [
      { type: 'tool_result' as const, tool_use_id: 'file1', content: 'file contents', is_error: false, timestamp: 1000 },
      { type: 'tool_result' as const, tool_use_id: 'fact1', content: 'fact contents', is_error: false, timestamp: 2000 },
    ];

    const spec = {
      ...createTestSpec(),
      syntheticHistory,
    };

    const minion = new BrainlessMinion(spec);

    // Receive synthetic messages
    const iterator = minion.receive();

    const msg1Promise = iterator.next();
    await vi.advanceTimersByTimeAsync(20);
    const msg1 = await msg1Promise;

    const msg2Promise = iterator.next();
    await vi.advanceTimersByTimeAsync(20);
    const msg2 = await msg2Promise;

    expect(msg1.value.timestamp).toBe(1000);
    expect(msg2.value.timestamp).toBe(2000);

    minion.kill();
  });
});

describe('Executable Gadgets', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('executes gadgets when /use tool command matches gadget name', async () => {
    // Create a test gadget
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

    const minion = new BrainlessMinion(createTestSpec(), undefined, {
      executableGadgets: [testGadget]
    });

    // Send /use tool command
    await minion.send({
      type: 'user',
      content: '/use tool test_gadget with {"message": "hello"}',
      timestamp: Date.now()
    });

    // Receive response
    const responsePromise = minion.receive().next();
    await vi.advanceTimersByTimeAsync(20);
    const response = await responsePromise;

    // Should execute gadget and return result as tool_result message
    expect(response.value.type).toBe('tool_result');
    if (response.value.type === 'tool_result') {
      expect(response.value.is_error).toBe(false);
      // Success result content is the result value from ToolResult
      expect(response.value.content).toEqual({ echo: { message: 'hello' } });
    }

    minion.kill();
  });

  it('returns error when gadget execution fails', async () => {
    // Create a failing gadget
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

    const minion = new BrainlessMinion(createTestSpec(), undefined, {
      executableGadgets: [failingGadget]
    });

    // Send /use tool command
    await minion.send({
      type: 'user',
      content: '/use tool failing_gadget with {}',
      timestamp: Date.now()
    });

    // Receive response
    const responsePromise = minion.receive().next();
    await vi.advanceTimersByTimeAsync(20);
    const response = await responsePromise;

    // Should return tool_result with is_error: true
    expect(response.value.type).toBe('tool_result');
    if (response.value.type === 'tool_result') {
      expect(response.value.is_error).toBe(true);
      // Error result content is the error string from ToolResult
      expect(response.value.content).toBe('Gadget execution failed');
    }

    minion.kill();
  });

  it('falls back to tool_use message when no matching gadget found', async () => {
    // Create minion with one gadget
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

    const minion = new BrainlessMinion(createTestSpec(), undefined, {
      executableGadgets: [testGadget]
    });

    // Send /use tool command for non-existent gadget
    await minion.send({
      type: 'user',
      content: '/use tool other_tool with {"data": "test"}',
      timestamp: Date.now()
    });

    // Receive response
    const responsePromise = minion.receive().next();
    await vi.advanceTimersByTimeAsync(20);
    const response = await responsePromise;

    // Should generate tool_use message for regular tool
    expect(response.value.type).toBe('tool_use');
    if (response.value.type === 'tool_use') {
      expect(response.value.name).toBe('other_tool');
      expect(response.value.input).toEqual({ data: 'test' });
    }

    minion.kill();
  });

  it('works without executable gadgets', async () => {
    // Create minion without gadgets
    const minion = new BrainlessMinion(createTestSpec());

    // Send /use tool command
    await minion.send({
      type: 'user',
      content: '/use tool some_tool with {"data": "test"}',
      timestamp: Date.now()
    });

    // Receive response
    const responsePromise = minion.receive().next();
    await vi.advanceTimersByTimeAsync(20);
    const response = await responsePromise;

    // Should generate tool_use message
    expect(response.value.type).toBe('tool_use');
    if (response.value.type === 'tool_use') {
      expect(response.value.name).toBe('some_tool');
      expect(response.value.input).toEqual({ data: 'test' });
    }

    minion.kill();
  });
});

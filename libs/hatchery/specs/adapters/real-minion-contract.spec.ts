import { describe, it, expect } from 'vitest';
import { testMinionContract } from '../contracts/minion-contract';
import { RealMinion } from '../../src/adapters/minions/RealMinion';
import { TestMinionClient } from './test-minion-client';
import type { MinionSpec, IWorkbench } from '@minions/domain-types';
import type { Costume } from '../../src/domain';
import { TEST_PROMPTS } from '../../src/domain';
import { AutoResponder } from '../test-utils';
import type { MinionSpecWithExtensions } from '../../src/domain/MinionSpecExtensions';

/**
 * RealMinion instance with the AutoResponder stashed for later cleanup by
 * killMinion(). This is test-only bookkeeping, not part of IMinion.
 */
type MinionWithAutoResponder = RealMinion & { _autoResponder?: AutoResponder };

/**
 * Contract tests for RealMinion
 *
 * RealMinion must pass the same contract tests as BrainlessMinion.
 * This test suite runs the shared contract tests using a TestMinionClient
 * to simulate AI client behavior.
 *
 * Expected initial state (Story 5):
 * - Tests will run but many will fail
 * - costume property is not properly initialized
 * - status property is hardcoded to 'waiting'
 * - reconfigure() always fails
 *
 * After Stories 6-8 are implemented, all tests should pass.
 */

testMinionContract(
  'RealMinion',
  (costume?: Costume, workbench?: IWorkbench) => {
    const spec: MinionSpecWithExtensions = {
      client: 'brainless',
      wing: '/test',
      model: 'test-model',
      useBuiltInSystemPrompt: true,
      costume,
      workbench
    };

    // Create test client
    const client = new TestMinionClient();

    // Start client synchronously (in real usage this would be async)
    client.start(spec).catch(err => {
      console.error('Failed to start test client:', err);
    });

    // Create RealMinion with test client
    const minion = new RealMinion(spec, client);

    // Set up automatic response behavior for contract tests
    // This simulates what a real AI client would do
    const responder = new AutoResponder(
      client,
      new Map([
        [TEST_PROMPTS.HELP, { type: 'text', content: 'Help information', timestamp: Date.now() }],
        [TEST_PROMPTS.ECHO_HI, { type: 'text', content: 'hi', timestamp: Date.now() }]
      ]),
      // Default response for other messages
      { type: 'text', content: 'Response', timestamp: Date.now() }
    );
    responder.start();

    // Store responder on minion for cleanup
    (minion as MinionWithAutoResponder)._autoResponder = responder;

    return minion;
  },
  (minion) => {
    // Stop the auto responder
    const responder = (minion as MinionWithAutoResponder)._autoResponder;
    if (responder) {
      responder.stop();
    }

    // Kill the minion (which will kill the client)
    minion.kill();
  },
  false // Use real timers for RealMinion tests
);

/**
 * Integration tests for RealMinion synthetic history
 *
 * These tests verify that RealMinion correctly passes synthetic history to the client
 * and that the client makes it available in the conversation context.
 */
describe('RealMinion Synthetic History', () => {
  it('receives synthetic history from spec at spawn time', async () => {
    const syntheticHistory = [
      { type: 'tool_result' as const, tool_use_id: 'file1', content: 'file contents', is_error: false, timestamp: 1000 },
      { type: 'tool_result' as const, tool_use_id: 'fact1', content: 'fact contents', is_error: false, timestamp: 2000 },
    ];

    const spec: MinionSpecWithExtensions = {
      client: 'brainless',
      wing: '/test',
      model: 'test-model',
      useBuiltInSystemPrompt: true,
      syntheticHistory,
    };

    const client = new TestMinionClient();
    await client.start(spec);

    const minion = new RealMinion(spec, client);

    // Receive synthetic messages - they should appear first
    const iterator = minion.receive();

    const msg1 = await iterator.next();
    const msg2 = await iterator.next();

    expect(msg1.value).toEqual(syntheticHistory[0]);
    expect(msg2.value).toEqual(syntheticHistory[1]);

    minion.kill();
  });

  it('synthetic messages appear before first user message', async () => {
    const syntheticHistory = [
      { type: 'tool_result' as const, tool_use_id: 'synthetic1', content: 'synthetic', is_error: false, timestamp: 1000 },
    ];

    const spec: MinionSpecWithExtensions = {
      client: 'brainless',
      wing: '/test',
      model: 'test-model',
      useBuiltInSystemPrompt: true,
      syntheticHistory,
    };

    const client = new TestMinionClient();
    await client.start(spec);

    const minion = new RealMinion(spec, client);

    // Send a user message
    await minion.send({ type: 'user', content: 'Hello', timestamp: Date.now() });

    // Simulate response
    client.simulateMessage({ type: 'text', content: 'Response', timestamp: Date.now() });

    // Receive messages - synthetic should come first
    const iterator = minion.receive();

    const msg1 = await iterator.next();
    expect(msg1.value).toEqual(syntheticHistory[0]);
    expect(msg1.value.type).toBe('tool_result');

    const msg2 = await iterator.next();
    expect(msg2.value.type).toBe('text');
    expect(msg2.value).toHaveProperty('content', 'Response');

    minion.kill();
  });

  it('works without synthetic history (backwards compatibility)', async () => {
    const spec: MinionSpec = {
      client: 'brainless',
      wing: '/test',
      model: 'test-model',
      useBuiltInSystemPrompt: true,
    };

    const client = new TestMinionClient();
    await client.start(spec);

    const minion = new RealMinion(spec, client);

    // Send a message
    await minion.send({ type: 'user', content: 'Hello', timestamp: Date.now() });

    // Simulate response
    client.simulateMessage({ type: 'text', content: 'Response', timestamp: Date.now() });

    // Receive message
    const iterator = minion.receive();
    const msg = await iterator.next();

    expect(msg.value.type).toBe('text');
    expect(msg.value).toHaveProperty('content', 'Response');

    minion.kill();
  });

  it('handles empty synthetic history array', async () => {
    const spec: MinionSpecWithExtensions = {
      client: 'brainless',
      wing: '/test',
      model: 'test-model',
      useBuiltInSystemPrompt: true,
      syntheticHistory: [],
    };

    const client = new TestMinionClient();
    await client.start(spec);

    const minion = new RealMinion(spec, client);

    // Send a message
    await minion.send({ type: 'user', content: 'Hello', timestamp: Date.now() });

    // Simulate response
    client.simulateMessage({ type: 'text', content: 'Response', timestamp: Date.now() });

    // Receive message
    const iterator = minion.receive();
    const msg = await iterator.next();

    expect(msg.value.type).toBe('text');
    expect(msg.value).toHaveProperty('content', 'Response');

    minion.kill();
  });
});


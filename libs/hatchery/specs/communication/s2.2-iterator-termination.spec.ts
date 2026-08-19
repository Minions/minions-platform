/**
 * Spec S2.2: Async Iterator with Proper Termination
 *
 * Goal: Ensure async iterators terminate properly when minion dies
 *
 * Tests:
 * - Terminates iterator when minion is killed
 * - Returns remaining buffered messages before terminating
 */

import { describe, it, expect } from 'vitest';
import { BrainlessMinion } from '../../src/adapters/minions/BrainlessMinion';
import type { MinionSpec, MinionMessage } from '../../src/domain';

function createTestSpec(): MinionSpec {
  return {
    client: 'claude-code',
    wing: '/test',
    model: 'test-model',
    useBuiltInSystemPrompt: true
  };
}

describe('Spec S2.2: Async Iterator Termination', () => {
  it('terminates iterator when minion is killed', async () => {
    const minion = new BrainlessMinion(createTestSpec());

    const messages: MinionMessage[] = [];

    // Start consuming
    const receivePromise = (async () => {
      for await (const msg of minion.receive()) {
        messages.push(msg);
      }
    })();

    // Send some messages via back-side
    await minion.testSend({ type: 'text', content: '1', timestamp: Date.now() });
    await minion.testSend({ type: 'text', content: '2', timestamp: Date.now() });

    // Wait a bit for consumption
    await new Promise(resolve => setTimeout(resolve, 50));

    // Kill minion
    minion.kill();

    // Iterator should terminate
    await expect(receivePromise).resolves.toBeUndefined();
    expect(messages.length).toBeGreaterThanOrEqual(2);
  });

  it('returns remaining buffered messages before terminating', async () => {
    const minion = new BrainlessMinion(createTestSpec());

    // Buffer messages from back-side
    await minion.testSend({ type: 'text', content: '1', timestamp: Date.now() });
    await minion.testSend({ type: 'text', content: '2', timestamp: Date.now() });
    await minion.testSend({ type: 'text', content: '3', timestamp: Date.now() });

    // Kill immediately
    minion.kill();

    // Should still get buffered messages
    const messages: MinionMessage[] = [];
    for await (const msg of minion.receive()) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(3);
    expect((messages[0] as { content: string }).content).toBe('1');
    expect((messages[1] as { content: string }).content).toBe('2');
    expect((messages[2] as { content: string }).content).toBe('3');
  });

  it('testReceive also terminates when minion is killed', async () => {
    // Create minion without back-side co-routine to avoid competition for testReceive()
    const minion = new BrainlessMinion(createTestSpec(), async () => {
      // No-op back-side - let test control testReceive()
    });

    const messages: MinionMessage[] = [];

    // Start consuming from test side
    const receivePromise = (async () => {
      for await (const msg of minion.testReceive()) {
        messages.push(msg);
      }
    })();

    // Send some messages from production side
    await minion.send({ type: 'user', content: '1', timestamp: Date.now() });
    await minion.send({ type: 'user', content: '2', timestamp: Date.now() });

    // Wait a bit for consumption
    await new Promise(resolve => setTimeout(resolve, 50));

    // Kill minion
    minion.kill();

    // Iterator should terminate
    await expect(receivePromise).resolves.toBeUndefined();
    expect(messages.length).toBeGreaterThanOrEqual(2);
  });

  it('testReceive returns remaining buffered messages before terminating', async () => {
    // Create minion without back-side co-routine to avoid competition for testReceive()
    const minion = new BrainlessMinion(createTestSpec(), async () => {
      // No-op back-side - let test control testReceive()
    });

    // Buffer messages from production side
    await minion.send({ type: 'user', content: '1', timestamp: Date.now() });
    await minion.send({ type: 'user', content: '2', timestamp: Date.now() });
    await minion.send({ type: 'user', content: '3', timestamp: Date.now() });

    // Kill immediately
    minion.kill();

    // Should still get buffered messages
    const messages: MinionMessage[] = [];
    for await (const msg of minion.testReceive()) {
      messages.push(msg);
    }

    expect(messages).toHaveLength(3);
    expect((messages[0] as { content: string }).content).toBe('1');
    expect((messages[1] as { content: string }).content).toBe('2');
    expect((messages[2] as { content: string }).content).toBe('3');
  });
});

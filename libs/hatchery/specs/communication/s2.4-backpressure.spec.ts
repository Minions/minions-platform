/**
 * Spec S2.4: Backpressure Handling
 *
 * Goal: Add backpressure when buffer grows too large
 *
 * Tests:
 * - Applies backpressure when buffer is full
 * - Send blocks until buffer space is available
 */

import { describe, it, expect } from 'vitest';
import { BrainlessMinion } from '../../src/adapters/minions/BrainlessMinion';
import type { MinionSpec } from '../../src/domain';

function createTestSpec(): MinionSpec {
  return {
    client: 'claude-code',
    wing: '/test',
    model: 'test-model',
    useBuiltInSystemPrompt: true
  };
}

describe('Spec S2.4: Backpressure Handling', () => {
  it('applies backpressure when buffer full', async () => {
    // Create minion with no-op back-side to prevent automatic consumption
    const minion = new BrainlessMinion(
      createTestSpec(),
      async () => {
        // No-op back-side - don't consume messages
      },
      { maxBufferSize: 10 }
    );

    // Fill buffer
    for (let i = 0; i < 10; i++) {
      await minion.send({ type: 'user', content: `${i}`, timestamp: Date.now() });
    }

    // Next send should block
    const startTime = Date.now();
    const sendPromise = minion.send({
      type: 'user',
      content: 'blocked',
      timestamp: Date.now()
    });

    // Start consuming after a delay to relieve pressure
    setTimeout(async () => {
      for await (const _msg of minion.testReceive()) {
        break; // Consume one message to free space
      }
    }, 50);

    await sendPromise;
    const elapsed = Date.now() - startTime;

    // Send should have been blocked for at least 40ms
    expect(elapsed).toBeGreaterThanOrEqual(40);

    minion.kill();
  });

  it('continues to work normally when buffer is not full', async () => {
    const minion = new BrainlessMinion(createTestSpec(), undefined, { maxBufferSize: 100 });

    // Send some messages (well below buffer size)
    const startTime = Date.now();
    for (let i = 0; i < 10; i++) {
      await minion.send({ type: 'user', content: `${i}`, timestamp: Date.now() });
    }
    const elapsed = Date.now() - startTime;

    // Should complete quickly (no blocking)
    expect(elapsed).toBeLessThan(50);

    // Verify messages were queued
    const messages: string[] = [];
    for await (const msg of minion.testReceive()) {
      messages.push((msg as { content: string }).content);
      if (messages.length === 10) break;
    }

    expect(messages).toHaveLength(10);
    minion.kill();
  });

  it('default buffer size is unlimited', async () => {
    // Create minion with default buffer (no limit)
    const minion = new BrainlessMinion(createTestSpec());

    // Send many messages
    const startTime = Date.now();
    for (let i = 0; i < 1000; i++) {
      await minion.send({ type: 'user', content: `${i}`, timestamp: Date.now() });
    }
    const elapsed = Date.now() - startTime;

    // Should complete quickly (no blocking)
    expect(elapsed).toBeLessThan(100);

    minion.kill();
  });
});

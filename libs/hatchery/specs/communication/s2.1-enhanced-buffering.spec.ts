/**
 * Spec S2.1: Enhanced Message Buffering
 *
 * Goal: Improve BrainlessMinion buffering to handle rapid message streams
 *
 * Tests:
 * - Buffers many messages without loss
 * - Handles concurrent sends safely
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

describe('Spec S2.1: Enhanced Message Buffering', () => {
  it('buffers many messages without loss', async () => {
    const minion = new BrainlessMinion(createTestSpec());

    const count = 1000;
    for (let i = 0; i < count; i++) {
      await minion.send({
        type: 'user',
        content: `Message ${i}`,
        timestamp: Date.now()
      });
    }

    const received: MinionMessage[] = [];
    for await (const msg of minion.testReceive()) {
      received.push(msg);
      if (received.length === count) break;
    }

    expect(received).toHaveLength(count);
    expect((received[0] as { content: string }).content).toBe('Message 0');
    expect((received[999] as { content: string }).content).toBe('Message 999');

    minion.kill();
  });

  it('handles concurrent sends safely', async () => {
    const minion = new BrainlessMinion(createTestSpec());

    await Promise.all([
      minion.send({ type: 'user', content: 'A', timestamp: Date.now() }),
      minion.send({ type: 'user', content: 'B', timestamp: Date.now() }),
      minion.send({ type: 'user', content: 'C', timestamp: Date.now() })
    ]);

    const received: string[] = [];
    for await (const msg of minion.testReceive()) {
      received.push((msg as { content: string }).content);
      if (received.length === 3) break;
    }

    expect(received).toHaveLength(3);
    expect(received).toContain('A');
    expect(received).toContain('B');
    expect(received).toContain('C');

    minion.kill();
  });
});

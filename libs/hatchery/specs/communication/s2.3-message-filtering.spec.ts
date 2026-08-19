/**
 * Spec S2.3: Message Type Filtering
 *
 * Goal: Add ability to filter received messages by type
 *
 * Tests:
 * - Can filter by single message type
 * - Can filter by multiple message types
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

describe('Spec S2.3: Message Type Filtering', () => {
  it('can filter by single message type', async () => {
    const minion = new BrainlessMinion(createTestSpec());

    // Send messages from back-side (minion → production)
    await minion.testSend({ type: 'text', content: 'A', timestamp: Date.now() });
    await minion.testSend({ type: 'tool_use', id: 'tool1', name: 'test', input: {}, timestamp: Date.now() });
    await minion.testSend({ type: 'text', content: 'B', timestamp: Date.now() });

    // Filter to only receive 'text' messages
    const textMessages: string[] = [];
    for await (const msg of minion.receive({ type: 'text' })) {
      textMessages.push((msg as { content: string }).content);
      if (textMessages.length === 2) break;
    }

    expect(textMessages).toHaveLength(2);
    expect(textMessages[0]).toBe('A');
    expect(textMessages[1]).toBe('B');

    minion.kill();
  });

  it('can filter by multiple message types', async () => {
    const minion = new BrainlessMinion(createTestSpec());

    // Send various message types from back-side
    await minion.testSend({ type: 'text', content: 'A', timestamp: Date.now() });
    await minion.testSend({ type: 'status', status: 'processing', timestamp: Date.now() });
    await minion.testSend({ type: 'tool_use', id: 'tool1', name: 'test', input: {}, timestamp: Date.now() });
    await minion.testSend({ type: 'thinking', content: 'hmm', timestamp: Date.now() });

    // Filter to only receive 'text' and 'status' messages
    const messages: { type: string; content?: string; status?: string }[] = [];
    for await (const msg of minion.receive({ types: ['text', 'status'] })) {
      messages.push(msg);
      if (messages.length === 2) break;
    }

    expect(messages).toHaveLength(2);
    expect(messages[0].type).toBe('text');
    expect(messages[1].type).toBe('status');

    minion.kill();
  });

  it('returns all messages when no filter is provided', async () => {
    const minion = new BrainlessMinion(createTestSpec());

    // Send various message types from back-side
    await minion.testSend({ type: 'text', content: 'A', timestamp: Date.now() });
    await minion.testSend({ type: 'thinking', content: 'B', timestamp: Date.now() });
    await minion.testSend({ type: 'status', status: 'C', timestamp: Date.now() });

    // No filter - should receive all messages
    const messages: string[] = [];
    for await (const msg of minion.receive()) {
      messages.push(msg.type);
      if (messages.length === 3) break;
    }

    expect(messages).toHaveLength(3);
    expect(messages).toContain('text');
    expect(messages).toContain('thinking');
    expect(messages).toContain('status');

    minion.kill();
  });

  it('testReceive also supports filtering', async () => {
    // Create minion without back-side to control testReceive
    const minion = new BrainlessMinion(createTestSpec(), async () => {
      // No-op back-side
    });

    // Send various message types from production
    await minion.send({ type: 'user', content: 'A', timestamp: Date.now() });
    await minion.send({ type: 'tool_result', tool_use_id: 'tool1', content: 'result', timestamp: Date.now() });
    await minion.send({ type: 'user', content: 'B', timestamp: Date.now() });

    // Filter to only receive 'user' messages
    const userMessages: string[] = [];
    for await (const msg of minion.testReceive({ type: 'user' })) {
      userMessages.push((msg as { content: string }).content);
      if (userMessages.length === 2) break;
    }

    expect(userMessages).toHaveLength(2);
    expect(userMessages[0]).toBe('A');
    expect(userMessages[1]).toBe('B');

    minion.kill();
  });
});

import { describe, it, expect } from 'vitest';
import { ProductionHatchery } from '../../src/adapters/hatcheries/ProductionHatchery';
import type { MinionSpec } from '../../src/domain/MinionSpec';
import type { UserMessage } from '../../src/domain/MinionMessage';

/**
 * Multi-turn conversation test
 *
 * Demonstrates that ONE Claude process handles multiple messages
 * and maintains conversational context.
 */

describe('Claude Multi-Turn Conversation', () => {
  it('should maintain context across multiple messages', async () => {
    const hatchery = new ProductionHatchery();

    const spec: MinionSpec = {
      client: 'claude-code',
      wing: process.cwd(),
      model: 'claude-sonnet-4-5-20250929',
      useBuiltInSystemPrompt: true,
    };

    // Spawn ONCE
    const minion = await hatchery.spawn(spec);
    console.log('[TEST] Minion spawned - one long-running Claude process');

    try {
      // TURN 1: Ask Claude to remember a number
      console.log('\n[TURN 1] Asking Claude to remember number 42...');
      await minion.send({
        type: 'user',
        content: 'Remember this number: 42. Respond with exactly "remembered 42"',
        timestamp: Date.now(),
      } as UserMessage);

      // Wait a bit for Claude to process
      await new Promise((resolve) => setTimeout(resolve, 500));

      let response1 = '';
      for await (const msg of minion.receive()) {
        if (msg.type === 'text') {
          response1 = msg.content;
          console.log('[TURN 1 Response]', response1);
          break;
        }
      }

      expect(response1.toLowerCase()).toMatch(/remember|42/);

      // Wait before next turn
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // TURN 2: Ask Claude what number it remembers
      console.log('\n[TURN 2] Asking what number Claude remembers...');
      await minion.send({
        type: 'user',
        content: 'What number did I tell you to remember? Respond with just the number.',
        timestamp: Date.now(),
      } as UserMessage);

      // Wait for response
      await new Promise((resolve) => setTimeout(resolve, 500));

      let response2 = '';
      for await (const msg of minion.receive()) {
        if (msg.type === 'text') {
          response2 = msg.content;
          console.log('[TURN 2 Response]', response2);
          break;
        }
      }

      // Claude should remember 42 from the previous turn!
      expect(response2).toContain('42');

      console.log('\n✅ SUCCESS: Claude remembered context across turns!');
      console.log('This proves we have ONE long-running process maintaining conversation state.');
    } finally {
      // Clean up the SINGLE process
      minion.kill();
      console.log('[TEST] Killed the one long-running Claude process');
    }
  }, 60000); // 60 second timeout for multi-turn
});

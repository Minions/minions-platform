import { describe, it, expect } from 'vitest';
import { ProductionHatchery } from '../../src/adapters/hatcheries/ProductionHatchery';
import type { MinionSpec } from '../../src/domain/MinionSpec';
import type { UserMessage } from '../../src/domain/MinionMessage';

/**
 * Real integration tests for Claude Code Client
 *
 * These tests spawn REAL Claude Code processes using stream-json protocol
 * and verify actual communication. They are slower and require Claude to be
 * installed and authenticated.
 */

describe('Real Claude Code Integration', () => {
  it('should spawn real claude and get a text response for "say hi"', async () => {
    const hatchery = new ProductionHatchery();

    const spec: MinionSpec = {
      client: 'claude-code',
      wing: process.cwd(),
      model: 'claude-sonnet-4-5-20250929',
      useBuiltInSystemPrompt: true,
    };

    const minion = await hatchery.spawn(spec);

    try {
      // Send simple prompt
      const userMessage: UserMessage = {
        type: 'user',
        content: 'say hi',
        timestamp: Date.now(),
      };

      await minion.send(userMessage);

      // Wait for response
      const messages = [];
      for await (const msg of minion.receive()) {
        messages.push(msg);

        // Stop after we get a text message
        if (msg.type === 'text') {
          break;
        }

        // Safety timeout
        if (messages.length >= 20) {
          break;
        }
      }

      // Verify we got at least one text message
      const textMessages = messages.filter((m) => m.type === 'text');
      expect(textMessages.length).toBeGreaterThan(0);

      const responseText = textMessages[0].content.toLowerCase();
      expect(responseText).toContain('hi');

      console.log('[TEST] Response:', textMessages[0].content);
    } finally {
      // Clean up
      minion.kill();
    }
  }, 30000); // 30 second timeout
});

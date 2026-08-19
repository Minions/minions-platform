import { describe, it, expect } from 'vitest';
import { OpenCodeClient } from '../../src/adapters/clients/OpenCodeClient';
import type { MinionSpec } from '../../src/domain/MinionSpec';
import type { UserMessage } from '../../src/domain/MinionMessage';
import { createDiskSandbox, createLair } from '@minions/file-store';

/**
 * OpenCode Client Integration Tests
 *
 * These are integration tests that require:
 * 1. Running inside a wing directory (for wing resolution)
 * 2. OpenCode to be installed (npm install -g opencode-ai@latest)
 *
 * Excluded from the default test run via vitest.config.ts.
 * Run explicitly with: vitest run specs/clients/opencode.spec.ts
 */

describe('OpenCodeClient', () => {
  // Helper to create lair for tests with a wing
  async function createTestLair() {
    const sandbox = createDiskSandbox(process.cwd());
    return createLair(sandbox);
  }

  describe('Basic Interface', () => {
    it('should implement IMinionClient interface', async () => {
      const lair = await createTestLair();
      const client = new OpenCodeClient(lair);
      expect(client.type).toBe('opencode');
      expect(typeof client.start).toBe('function');
      expect(typeof client.stop).toBe('function');
      expect(typeof client.send).toBe('function');
      expect(typeof client.receive).toBe('function');
      expect(typeof client.kill).toBe('function');
      expect(typeof client.interrupt).toBe('function');
    });

    it('should have correct type property', async () => {
      const lair = await createTestLair();
      const client = new OpenCodeClient(lair);
      expect(client.type).toBe('opencode');
    });
  });

  describe('Lifecycle', () => {
    it('should throw error if started twice', async () => {
      const lair = await createTestLair();
      const client = new OpenCodeClient(lair);
      const spec: MinionSpec = {
        client: 'opencode',
        wing: process.cwd(),
        model: 'opencode/gpt-5-nano', // Free model
        useBuiltInSystemPrompt: true,
      };

      try {
        await client.start(spec);
        await expect(client.start(spec)).rejects.toThrow('Client already started');
      } finally {
        client.kill();
      }
    }, 15000);

    it('should start and stop cleanly', async () => {
      const lair = await createTestLair();
      const client = new OpenCodeClient(lair);
      const spec: MinionSpec = {
        client: 'opencode',
        wing: process.cwd(),
        model: 'opencode/gpt-5-nano', // Free model
        useBuiltInSystemPrompt: true,
      };

      try {
        await client.start(spec);
        // If we got here, start succeeded
        expect(true).toBe(true);
      } finally {
        await client.stop();
      }
    }, 15000);

    it('should handle kill() method', async () => {
      const lair = await createTestLair();
      const client = new OpenCodeClient(lair);
      const spec: MinionSpec = {
        client: 'opencode',
        wing: process.cwd(),
        model: 'opencode/gpt-5-nano', // Free model
        useBuiltInSystemPrompt: true,
      };

      await client.start(spec);
      client.kill();

      // After kill, should not be able to send
      const message: UserMessage = {
        type: 'user',
        content: 'test',
        timestamp: Date.now(),
      };

      await expect(client.send(message)).rejects.toThrow();
    }, 15000);
  });

  describe('Communication', () => {
    it('should send and receive messages', async () => {
      const lair = await createTestLair();
      const client = new OpenCodeClient(lair);
      const spec: MinionSpec = {
        client: 'opencode',
        wing: process.cwd(),
        model: 'opencode/gpt-5-nano', // Free model
        useBuiltInSystemPrompt: true,
      };

      try {
        await client.start(spec);

        const userMessage: UserMessage = {
          type: 'user',
          content: 'Say exactly "test response" and nothing else',
          timestamp: Date.now(),
        };

        await client.send(userMessage);

        // Collect messages
        const messages = [];
        for await (const msg of client.receive()) {
          messages.push(msg);

          if (msg.type === 'text') {
            break;
          }

          // Safety limit
          if (messages.length >= 10) {
            break;
          }
        }

        // Should have received at least one message
        expect(messages.length).toBeGreaterThan(0);

        const textMessages = messages.filter((m) => m.type === 'text');
        expect(textMessages.length).toBeGreaterThan(0);

        console.log('[TEST] OpenCode response:', textMessages[0].content);
      } finally {
        client.kill();
      }
    }, 30000);

    it('should handle multi-turn conversations', async () => {
      const lair = await createTestLair();
      const client = new OpenCodeClient(lair);
      const spec: MinionSpec = {
        client: 'opencode',
        wing: process.cwd(),
        model: 'opencode/gpt-5-nano', // Free model
        useBuiltInSystemPrompt: true,
      };

      try {
        await client.start(spec);

        // First turn
        await client.send({
          type: 'user',
          content: 'Remember this number: 42',
          timestamp: Date.now(),
        });

        let messages = [];
        for await (const msg of client.receive()) {
          messages.push(msg);
          if (msg.type === 'text') break;
          if (messages.length >= 10) break;
        }

        expect(messages.length).toBeGreaterThan(0);

        // Second turn
        await client.send({
          type: 'user',
          content: 'What number did I just tell you?',
          timestamp: Date.now(),
        });

        messages = [];
        for await (const msg of client.receive()) {
          messages.push(msg);
          if (msg.type === 'text') break;
          if (messages.length >= 10) break;
        }

        const textMessages = messages.filter((m) => m.type === 'text');
        expect(textMessages.length).toBeGreaterThan(0);

        // Response should mention 42
        const responseText = textMessages[0].content;
        expect(responseText).toContain('42');

        console.log('[TEST] Multi-turn response:', responseText);
      } finally {
        client.kill();
      }
    }, 45000);
  });

  describe('Error Handling', () => {
    it('should throw error when sending without starting', async () => {
      const lair = await createTestLair();
      const client = new OpenCodeClient(lair);
      const message: UserMessage = {
        type: 'user',
        content: 'test',
        timestamp: Date.now(),
      };

      await expect(client.send(message)).rejects.toThrow('Client not running');
    });
  });

  describe('ProductionHatchery Integration', () => {
    it('should work with ProductionHatchery', async () => {
      const { ProductionHatchery } = await import('../../src/adapters/hatcheries/ProductionHatchery');
      const lair = await createTestLair();
      const hatchery = new ProductionHatchery(lair);

      const spec: MinionSpec = {
        client: 'opencode',
        wing: process.cwd(),
        model: 'opencode/gpt-5-nano', // Free model
        useBuiltInSystemPrompt: true,
      };

      let minion;
      try {
        minion = await hatchery.spawn(spec);

        // Send a simple message
        await minion.send({
          type: 'user',
          content: 'Say "integration test passed"',
          timestamp: Date.now(),
        });

        // Receive response
        const messages = [];
        for await (const msg of minion.receive()) {
          messages.push(msg);
          if (msg.type === 'text') break;
          if (messages.length >= 10) break;
        }

        expect(messages.length).toBeGreaterThan(0);
        console.log('[TEST] ProductionHatchery integration response:', messages[0]);
      } finally {
        if (minion) {
          minion.kill();
        }
      }
    }, 30000);
  });
});

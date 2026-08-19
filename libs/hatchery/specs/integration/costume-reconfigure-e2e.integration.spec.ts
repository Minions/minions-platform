/**
 * End-to-End Costume Reconfiguration Integration Test
 *
 * Verifies that reconfigure() with a REAL AI client actually works end-to-end.
 * Unlike costume-reconfigure.integration.spec.ts which uses TestMinionClient,
 * this test uses a real OpenCodeClient to verify:
 *
 * 1. The minion can communicate with real AI through a costume
 * 2. Reconfigure() successfully restarts the client
 * 3. The minion can communicate with real AI after reconfiguration
 * 4. Conversation history is PRESERVED after reconfiguration
 *
 * Note: Uses OpenCode with free model (gpt-5-nano) for testing.
 * Test is marked as slow and may be skipped if service unavailable.
 *
 * Limitation: OpenCode's built-in system prompts are very strong and
 * may override custom prompts completely. This test focuses on verifying
 * the reconfiguration mechanism works, not that system prompts affect behavior
 * (that would require a more controllable AI model/client).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Effect, Exit } from 'effect';
import { RealMinion } from '../../src/adapters/minions/RealMinion';
import { OpenCodeClient } from '../../src/adapters/clients/OpenCodeClient';
import type { MinionSpec } from '@minions/domain-types';
import type { Costume } from '../../src/domain';
import type { UserMessage } from '../../src/domain/MinionMessage';
import { createDiskSandbox, createLair } from '@minions/file-store';

describe('Costume Reconfiguration E2E with Real Client', () => {
  let client: OpenCodeClient;
  let minion: RealMinion;

  beforeEach(async () => {
    const sandbox = createDiskSandbox(process.cwd());
    const lair = createLair(sandbox);
    client = new OpenCodeClient(lair);
  });

  afterEach(async () => {
    if (minion) {
      minion.kill();
    }
  });

  it(
    'should successfully reconfigure and preserve conversation history',
    async () => {
      // Costume A: First configuration
      const costumeA: Costume = {
        model: 'opencode/gpt-5-nano', // Free model
        systemPrompt: 'You are a helpful assistant. Be concise.',
        gadgets: [],
      };

      // Costume B: Second configuration
      const costumeB: Costume = {
        model: 'opencode/gpt-5-nano', // Same model
        systemPrompt: 'You are a different helpful assistant. Also be concise.',
        gadgets: [],
      };

      // Create initial spec with costume A
      const spec: MinionSpec = {
        client: 'opencode',
        wing: process.cwd(),
        model: costumeA.model,
        useBuiltInSystemPrompt: false,
        agentPrompt: costumeA.systemPrompt,
        tools: costumeA.gadgets,
        costume: costumeA,
      };

      // Start client and create minion
      await client.start(spec);
      minion = new RealMinion(spec, client);

      // Verify initial costume
      expect(minion.costume).toEqual(costumeA);

      // ===== PHASE 1: Send message with costume A =====
      console.log('[TEST] Phase 1: Communicating with costume A...');

      const firstMessage: UserMessage = {
        type: 'user',
        content: 'Remember this secret number: 42',
        timestamp: Date.now(),
      };

      await minion.send(firstMessage);

      // Collect response
      let firstResponse = '';
      for await (const msg of minion.receive()) {
        if (msg.type === 'text') {
          firstResponse += msg.content;
          break;
        }
        // Safety limit
        if (firstResponse.length >= 10) break;
      }

      console.log('[TEST] First response:', firstResponse);
      // Verify we got a response
      expect(firstResponse.length).toBeGreaterThan(0);

      // ===== PHASE 2: Reconfigure to costume B =====
      console.log('[TEST] Phase 2: Reconfiguring to costume B...');

      const reconfigResult = await Effect.runPromiseExit(minion.reconfigure(costumeB));
      expect(Exit.isSuccess(reconfigResult)).toBe(true);

      // Verify costume changed
      expect(minion.costume).toEqual(costumeB);
      expect(minion.costume?.systemPrompt).not.toBe(costumeA.systemPrompt);

      // ===== PHASE 3: Send message with costume B =====
      // This verifies the client was restarted and can communicate
      console.log('[TEST] Phase 3: Communicating with costume B...');

      const secondMessage: UserMessage = {
        type: 'user',
        content: 'What secret number did I tell you?',
        timestamp: Date.now(),
      };

      await minion.send(secondMessage);

      // Collect response
      let secondResponse = '';
      for await (const msg of minion.receive()) {
        if (msg.type === 'text') {
          secondResponse += msg.content;
          break;
        }
        // Safety limit
        if (secondResponse.length >= 10) break;
      }

      console.log('[TEST] Second response:', secondResponse);

      // Verify we got a response
      expect(secondResponse.length).toBeGreaterThan(0);

      // Verify conversation history was preserved (SHOULD remember 42)
      // The AI should recall the secret number from before reconfigure
      const remembers42 = /42/.test(secondResponse);
      console.log('[TEST] AI remembers 42?', remembers42);

      // Assert that history is preserved
      expect(remembers42).toBe(true);

      console.log('[TEST] ✓ Costume reconfiguration succeeded with history preservation');
    },
    60000 // 60 second timeout for real API calls
  );
});

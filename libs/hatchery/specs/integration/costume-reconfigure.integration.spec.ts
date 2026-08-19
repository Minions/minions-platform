/**
 * Integration test for costume reconfiguration
 *
 * Verifies that reconfigure() actually changes AI behavior by:
 * 1. Starting a minion with costume A
 * 2. Asking about its configuration
 * 3. Reconfiguring to costume B
 * 4. Asking the same question
 * 5. Verifying the response reflects costume B
 *
 * This test uses BrainlessMinion to simulate the behavior without
 * requiring actual AI calls. The test verifies the infrastructure
 * is correctly passing costume changes to the client.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Effect, Exit } from 'effect';
import { BrainlessMinion } from '../../src/adapters/minions/BrainlessMinion';
import { RealMinion } from '../../src/adapters/minions/RealMinion';
import type { MinionSpec } from '@minions/domain-types';
import type { Costume } from '../../src/domain';
import { TestMinionClient } from '../adapters/test-minion-client';

describe('Costume Reconfiguration Integration', () => {
  describe('BrainlessMinion (simulated)', () => {
    it('should track costume changes through reconfigure()', async () => {
      // Costume A: Developer persona
      const costumeA: Costume = {
        model: 'claude-sonnet-4-20250514',
        systemPrompt: 'You are a helpful developer assistant.',
        gadgets: [
          { name: 'read_file', description: 'Read a file' },
          { name: 'write_file', description: 'Write a file' },
        ],
      };

      // Costume B: Reviewer persona (same model, different prompt/tools)
      const costumeB: Costume = {
        model: 'claude-sonnet-4-20250514', // Same model (required)
        systemPrompt: 'You are a strict code reviewer. Find bugs and issues.',
        gadgets: [
          { name: 'review_code', description: 'Review code for issues' },
          { name: 'suggest_fix', description: 'Suggest a fix' },
        ],
      };

      const spec: MinionSpec = {
        client: 'brainless',
        wing: '/test/wing',
        model: costumeA.model,
        useBuiltInSystemPrompt: false,
        agentPrompt: costumeA.systemPrompt,
        tools: costumeA.gadgets,
        costume: costumeA,
      };

      const minion = new BrainlessMinion(spec);

      // Verify initial costume
      expect(minion.costume).toEqual(costumeA);
      expect(minion.costume?.systemPrompt).toBe('You are a helpful developer assistant.');
      expect(minion.costume?.gadgets).toHaveLength(2);
      expect(minion.costume?.gadgets?.[0].name).toBe('read_file');

      // Reconfigure to costume B
      const result = await Effect.runPromiseExit(minion.reconfigure(costumeB));
      expect(Exit.isSuccess(result)).toBe(true);

      // Verify costume changed
      expect(minion.costume).toEqual(costumeB);
      expect(minion.costume?.systemPrompt).toBe('You are a strict code reviewer. Find bugs and issues.');
      expect(minion.costume?.gadgets).toHaveLength(2);
      expect(minion.costume?.gadgets?.[0].name).toBe('review_code');

      minion.kill();
    });
  });

  describe('RealMinion with TestMinionClient', () => {
    let client: TestMinionClient;
    let minion: RealMinion;

    beforeEach(async () => {
      client = new TestMinionClient();
    });

    afterEach(async () => {
      if (minion) {
        minion.kill();
      }
    });

    it('should restart client with new spec on reconfigure()', async () => {
      // Costume A
      const costumeA: Costume = {
        model: 'test-model',
        systemPrompt: 'You are Assistant A.',
        gadgets: [{ name: 'tool_a', description: 'Tool A' }],
      };

      // Costume B (same model)
      const costumeB: Costume = {
        model: 'test-model',
        systemPrompt: 'You are Assistant B.',
        gadgets: [{ name: 'tool_b', description: 'Tool B' }],
      };

      const spec: MinionSpec = {
        client: 'brainless', // Type doesn't matter for TestMinionClient
        wing: '/test/wing',
        model: costumeA.model,
        useBuiltInSystemPrompt: false,
        agentPrompt: costumeA.systemPrompt,
        tools: costumeA.gadgets,
        costume: costumeA,
      };

      await client.start(spec);
      minion = new RealMinion(spec, client);

      // Verify initial costume
      expect(minion.costume?.systemPrompt).toBe('You are Assistant A.');

      // Track client restarts
      let startCount = 1; // Already started once
      const originalStart = client.start.bind(client);

      // Monkey-patch to count restarts
      let lastSpec: MinionSpec | null = null;
      client.start = async (newSpec: MinionSpec) => {
        startCount++;
        lastSpec = newSpec;
        return originalStart(newSpec);
      };

      // Reconfigure to costume B
      const result = await Effect.runPromiseExit(minion.reconfigure(costumeB));
      expect(Exit.isSuccess(result)).toBe(true);

      // Verify costume changed
      expect(minion.costume?.systemPrompt).toBe('You are Assistant B.');

      // Verify client was restarted
      expect(startCount).toBe(2);

      // Verify new spec was passed to client
      if (!lastSpec) {
        throw new Error('Expected client.start() to be called with a new spec during reconfigure()');
      }
      expect(lastSpec.agentPrompt).toBe('You are Assistant B.');
      expect(lastSpec.tools).toEqual([{ name: 'tool_b', description: 'Tool B' }]);
    });

    it('should pass model to client spec on initial start and reconfigure', async () => {
      const costume: Costume = {
        model: 'claude-opus-4-20250514',
        systemPrompt: 'Test prompt',
        gadgets: [],
      };

      const spec: MinionSpec = {
        client: 'brainless',
        wing: '/test/wing',
        model: costume.model,
        useBuiltInSystemPrompt: false,
        agentPrompt: costume.systemPrompt,
        tools: costume.gadgets,
        costume: costume,
      };

      await client.start(spec);
      minion = new RealMinion(spec, client);

      // Verify model in spec
      expect(minion.spec.model).toBe('claude-opus-4-20250514');

      // New costume with same model
      const newCostume: Costume = {
        model: 'claude-opus-4-20250514',
        systemPrompt: 'New prompt',
        gadgets: [{ name: 'new_tool', description: 'New tool' }],
      };

      // Track what spec is passed on restart
      let restartSpec: MinionSpec | null = null;
      const originalStart = client.start.bind(client);
      client.start = async (newSpec: MinionSpec) => {
        restartSpec = newSpec;
        return originalStart(newSpec);
      };

      await Effect.runPromise(minion.reconfigure(newCostume));

      // Verify model was preserved in restart spec
      if (!restartSpec) {
        throw new Error('Expected client.start() to be called with a new spec during reconfigure()');
      }
      expect(restartSpec.model).toBe('claude-opus-4-20250514');
    });
  });
});

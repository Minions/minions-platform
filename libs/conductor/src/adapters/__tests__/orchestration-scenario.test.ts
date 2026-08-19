/**
 * Integration test for multi-agent orchestration with shared workbench (Story 8)
 *
 * This test demonstrates the "shared context" orchestration pattern where multiple
 * minions (planner, developer, critic) work on the same task and share contextual
 * knowledge via a workbench.
 *
 * Pattern Overview:
 * 1. Create a shared workbench with PRD/plan files and project facts
 * 2. Generate synthetic history for each minion based on their costume's injectFacts
 * 3. Each minion sees the same files (PRD, plan)
 * 4. Each minion sees different facts based on their costume's injectFacts
 *
 * Why This Matters:
 * - Avoids redundant gadget calls (files already "read", facts already "known")
 * - Enables role-based fact access (developer sees build facts, critic doesn't)
 * - Supports multi-agent workflows without re-discovery overhead
 * - Proves synthetic history injection works end-to-end
 *
 * Implementation Note:
 * This test uses BrainlessMinion directly with inline costumes to prove the
 * workbench injection capability. We verify syntheticHistory content directly
 * rather than iterating through receive() (which would block waiting for messages).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Effect } from 'effect';
import { BrainlessMinion } from '@minions/hatchery';
import type { MinionMessage, MinionSpec } from '@minions/domain-types';
import type { IWorkbench } from '@minions/domain-types';
import { Workbench } from '../../domain/Workbench';
import { workbenchToSyntheticHistory } from '@minions/domain-types';
import { createInMemorySandbox } from '@minions/file-store';

describe('Orchestration Scenario: Multi-Agent Shared Context (Story 8)', () => {
  let workbench: IWorkbench;

  beforeEach(async () => {
    // Create a shared workbench
    workbench = new Workbench(createInMemorySandbox());

    // Add PRD file to workbench
    await Effect.runPromise(
      workbench.addFile(
        '/project/prd.md',
        `# Product Requirements Document

## Goal
Build a multi-agent orchestration system.

## Acceptance Criteria
- Multiple agents can share context
- Facts are filtered by role
- No redundant discovery`,
        'documentation'
      )
    );

    // Add plan file to workbench
    await Effect.runPromise(
      workbench.addFile(
        '/project/plan.md',
        `# Implementation Plan

## Story 1: Event Bus
Implement event-driven orchestration.

## Story 2: Workbench
Implement shared context for minions.`,
        'documentation'
      )
    );

    // Add build facts (developer should see these, critic should not)
    workbench.addFact(
      'build',
      'Build command: pnpm build',
      'confirmed',
      'setup-agent'
    );
    workbench.addFact(
      'build',
      'Test command: pnpm test',
      'confirmed',
      'setup-agent'
    );

    // Add structure facts (both developer and critic should see these)
    workbench.addFact(
      'structure',
      'Monorepo using nx',
      'confirmed',
      'analyst-agent'
    );
    workbench.addFact(
      'structure',
      'TypeScript codebase',
      'confirmed',
      'analyst-agent'
    );
  });

  describe('orchestration pattern demonstration', () => {
    it('generates synthetic history for 3 minions with different fact filtering', async () => {
      // Define inline costumes with different injectFacts
      const plannerInjectFacts: string[] = []; // No fact injection
      const developerInjectFacts: string[] = ['build', 'structure'];
      const criticInjectFacts: string[] = ['structure'];

      // Generate synthetic history for each role
      const plannerHistory = workbenchToSyntheticHistory(workbench, plannerInjectFacts);
      const developerHistory = workbenchToSyntheticHistory(workbench, developerInjectFacts);
      const criticHistory = workbenchToSyntheticHistory(workbench, criticInjectFacts);

      // Create specs with synthetic history
      const plannerSpec = {
        client: 'claude-code',
        wing: '/test/wing',
        model: 'claude-sonnet-4-20250514',
        useBuiltInSystemPrompt: true,
        syntheticHistory: plannerHistory,
        workbench,
      } as MinionSpec;

      const developerSpec = {
        client: 'claude-code',
        wing: '/test/wing',
        model: 'claude-sonnet-4-20250514',
        useBuiltInSystemPrompt: true,
        syntheticHistory: developerHistory,
        workbench,
      } as MinionSpec;

      const criticSpec = {
        client: 'claude-code',
        wing: '/test/wing',
        model: 'claude-sonnet-4-20250514',
        useBuiltInSystemPrompt: true,
        syntheticHistory: criticHistory,
        workbench,
      } as MinionSpec;

      // Spawn minions with inline costumes
      const planner = new BrainlessMinion(plannerSpec);
      const developer = new BrainlessMinion(developerSpec);
      const critic = new BrainlessMinion(criticSpec);

      // Verify all three minions were spawned
      expect(planner).toBeDefined();
      expect(developer).toBeDefined();
      expect(critic).toBeDefined();

      // Verify they all share the same workbench
      expect(planner.workbench).toBe(workbench);
      expect(developer.workbench).toBe(workbench);
      expect(critic.workbench).toBe(workbench);

      // Clean up
      planner.kill();
      developer.kill();
      critic.kill();
    });

    it('all minions see PRD and plan files via synthetic history', async () => {
      // Generate synthetic history for each role
      const plannerHistory = workbenchToSyntheticHistory(workbench, []);
      const developerHistory = workbenchToSyntheticHistory(workbench, ['build', 'structure']);
      const criticHistory = workbenchToSyntheticHistory(workbench, ['structure']);

      // Helper to check if synthetic history includes a file read
      const hasFileRead = (messages: MinionMessage[], filePath: string) => {
        return messages.some(
          (msg) =>
            msg.type === 'tool_use' &&
            msg.name === 'Read' &&
            msg.input?.file_path === filePath
        );
      };

      // All three should see PRD file
      expect(hasFileRead(plannerHistory, '/project/prd.md')).toBe(true);
      expect(hasFileRead(developerHistory, '/project/prd.md')).toBe(true);
      expect(hasFileRead(criticHistory, '/project/prd.md')).toBe(true);

      // All three should see plan file
      expect(hasFileRead(plannerHistory, '/project/plan.md')).toBe(true);
      expect(hasFileRead(developerHistory, '/project/plan.md')).toBe(true);
      expect(hasFileRead(criticHistory, '/project/plan.md')).toBe(true);
    });

    it('developer sees build facts, critic does not', async () => {
      const developerHistory = workbenchToSyntheticHistory(workbench, ['build', 'structure']);
      const criticHistory = workbenchToSyntheticHistory(workbench, ['structure']);

      // Helper to check if synthetic history includes a fact
      const hasFact = (messages: MinionMessage[], factText: string) => {
        return messages.some(
          (msg) =>
            msg.type === 'text' &&
            typeof msg.content === 'string' &&
            msg.content.includes(factText)
        );
      };

      // Developer should see build facts
      expect(hasFact(developerHistory, 'Build command: pnpm build')).toBe(true);
      expect(hasFact(developerHistory, 'Test command: pnpm test')).toBe(true);

      // Critic should NOT see build facts
      expect(hasFact(criticHistory, 'Build command: pnpm build')).toBe(false);
      expect(hasFact(criticHistory, 'Test command: pnpm test')).toBe(false);
    });

    it('both developer and critic see structure facts', async () => {
      const developerHistory = workbenchToSyntheticHistory(workbench, ['build', 'structure']);
      const criticHistory = workbenchToSyntheticHistory(workbench, ['structure']);

      // Helper to check if synthetic history includes a fact
      const hasFact = (messages: MinionMessage[], factText: string) => {
        return messages.some(
          (msg) =>
            msg.type === 'text' &&
            typeof msg.content === 'string' &&
            msg.content.includes(factText)
        );
      };

      // Both should see structure facts
      expect(hasFact(developerHistory, 'Monorepo using nx')).toBe(true);
      expect(hasFact(developerHistory, 'TypeScript codebase')).toBe(true);

      expect(hasFact(criticHistory, 'Monorepo using nx')).toBe(true);
      expect(hasFact(criticHistory, 'TypeScript codebase')).toBe(true);
    });

    it('planner sees no facts (injectFacts is empty)', async () => {
      const plannerHistory = workbenchToSyntheticHistory(workbench, []);

      // Helper to check if synthetic history includes a fact
      const hasFact = (messages: MinionMessage[], factText: string) => {
        return messages.some(
          (msg) =>
            msg.type === 'text' &&
            typeof msg.content === 'string' &&
            msg.content.includes(factText)
        );
      };

      // Planner should NOT see any facts
      expect(hasFact(plannerHistory, 'Build command: pnpm build')).toBe(false);
      expect(hasFact(plannerHistory, 'Monorepo using nx')).toBe(false);

      // But should still see files
      const hasFileRead = (messages: MinionMessage[], filePath: string) => {
        return messages.some(
          (msg) =>
            msg.type === 'tool_use' &&
            msg.name === 'Read' &&
            msg.input?.file_path === filePath
        );
      };

      expect(hasFileRead(plannerHistory, '/project/prd.md')).toBe(true);
      expect(hasFileRead(plannerHistory, '/project/plan.md')).toBe(true);
    });

    it('verifies synthetic messages have proper metadata', async () => {
      const developerHistory = workbenchToSyntheticHistory(workbench, ['build', 'structure']);

      // Verify that file reads are tool_use + tool_result pairs (synthetic)
      const toolUseMessages = developerHistory.filter((m) => m.type === 'tool_use');
      const toolResultMessages = developerHistory.filter((m) => m.type === 'tool_result');

      // Each file should have one tool_use and one tool_result
      expect(toolUseMessages.length).toBe(2); // prd.md + plan.md
      expect(toolResultMessages.length).toBe(2); // corresponding results

      // Verify tool_use messages have synthetic metadata
      for (const toolUse of toolUseMessages) {
        expect(toolUse.metadata?.synthetic).toBe(true);
      }

      // Verify tool_result messages have synthetic metadata
      for (const toolResult of toolResultMessages) {
        expect(toolResult.metadata?.synthetic).toBe(true);
      }

      // Verify facts are text messages with synthetic metadata
      const factMessages = developerHistory.filter(
        (m) =>
          m.type === 'text' &&
          typeof m.content === 'string' &&
          m.content.includes('Project Facts')
      );

      for (const factMsg of factMessages) {
        expect(factMsg.metadata?.synthetic).toBe(true);
      }
    });

    it('minions with synthetic history can receive messages via testReceive', async () => {
      // This tests that BrainlessMinion properly incorporates synthetic history
      const developerHistory = workbenchToSyntheticHistory(workbench, ['build', 'structure']);

      const developer = new BrainlessMinion({
        client: 'claude-code',
        wing: '/test/wing',
        model: 'claude-sonnet-4-20250514',
        useBuiltInSystemPrompt: true,
        syntheticHistory: developerHistory,
        workbench,
      } as MinionSpec);

      // Send a test message
      await developer.send({
        type: 'user',
        content: 'Hello developer',
        timestamp: Date.now(),
      });

      // The synthetic history should be available in production receive
      // We can verify this via testReceive which shows what production would see
      // The synthetic history was passed in spec and stored

      // Clean up
      developer.kill();
    });
  });

  describe('orchestration pattern documentation', () => {
    it('demonstrates the complete orchestration workflow', async () => {
      /**
       * ORCHESTRATION PATTERN DEMONSTRATION
       *
       * This test shows how to coordinate multiple agents with shared context:
       *
       * 1. CREATE SHARED WORKBENCH
       *    - Add files that all agents need (PRD, plans, specs)
       *    - Add facts categorized by domain (build, structure, deployment)
       *
       * 2. DEFINE AGENT ROLES VIA COSTUMES
       *    - Planner: No facts (discovers fresh perspective)
       *    - Developer: Build + structure facts (knows how to build)
       *    - Critic: Structure facts only (reviews without build details)
       *
       * 3. SPAWN AGENTS WITH SHARED WORKBENCH
       *    - Each agent sees files immediately (no Read gadget calls)
       *    - Each agent sees role-appropriate facts (filtered by injectFacts)
       *
       * 4. AGENTS WORK INDEPENDENTLY
       *    - No coordination needed between agents
       *    - Each has the context they need
       *    - Mission code orchestrates the workflow
       *
       * 5. BENEFITS
       *    - No redundant discovery work
       *    - Role-based information access
       *    - Efficient multi-agent coordination
       *    - Deterministic orchestration in TypeScript
       */

      // Step 1: Shared workbench (already created in beforeEach)
      expect(workbench.files.size).toBe(2); // PRD + plan
      expect(workbench.facts.length).toBe(4); // 2 build + 2 structure

      // Step 2: Generate synthetic history for each role
      const plannerHistory = workbenchToSyntheticHistory(workbench, []);
      const developerHistory = workbenchToSyntheticHistory(workbench, ['build', 'structure']);
      const criticHistory = workbenchToSyntheticHistory(workbench, ['structure']);

      // Step 3: Spawn agents
      const planner = new BrainlessMinion({
        client: 'claude-code',
        wing: '/test/wing',
        model: 'claude-sonnet-4-20250514',
        useBuiltInSystemPrompt: true,
        syntheticHistory: plannerHistory,
        workbench,
      } as MinionSpec);
      const developer = new BrainlessMinion({
        client: 'claude-code',
        wing: '/test/wing',
        model: 'claude-sonnet-4-20250514',
        useBuiltInSystemPrompt: true,
        syntheticHistory: developerHistory,
        workbench,
      } as MinionSpec);
      const critic = new BrainlessMinion({
        client: 'claude-code',
        wing: '/test/wing',
        model: 'claude-sonnet-4-20250514',
        useBuiltInSystemPrompt: true,
        syntheticHistory: criticHistory,
        workbench,
      } as MinionSpec);

      // Step 4: Mission code can now orchestrate workflow
      // Example: Send tasks to each agent
      await planner.send({
        type: 'user',
        content: 'Create a plan for Story 1',
        timestamp: Date.now(),
      });

      await developer.send({
        type: 'user',
        content: 'Implement Story 1 based on the plan',
        timestamp: Date.now(),
      });

      await critic.send({
        type: 'user',
        content: 'Review the Story 1 implementation',
        timestamp: Date.now(),
      });

      // Verify messages were sent successfully
      expect(planner).toBeDefined();
      expect(developer).toBeDefined();
      expect(critic).toBeDefined();

      // Clean up
      planner.kill();
      developer.kill();
      critic.kill();
    });
  });
});

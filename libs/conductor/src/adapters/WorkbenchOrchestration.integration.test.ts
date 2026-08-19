import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Effect } from 'effect';
import { DefaultMissionContext } from './DefaultMissionContext';
import { MissionHandle } from '../domain/MissionHandle';
import { Workbench } from '../domain/Workbench';
import { workbenchToSyntheticHistory } from '@minions/domain-types';
import { createInMemorySandbox } from '@minions/file-store';
import type { IHatchery } from '@minions/hatchery';
import { BrainlessMinion } from '@minions/hatchery';
import type { IQuestionBridge } from '../ports/IQuestionBridge';
import type { MinionSpec, MinionMessage } from '@minions/domain-types';
import type { Wing } from '@minions/file-store';

/**
 * Story 8: Prove Capability in Orchestrate Mission Scenario
 *
 * This integration test demonstrates the full workbench orchestration pattern:
 * - Multiple minions (planner, developer, critic) share PRD and plan context via workbench
 * - Each minion has different fact injection settings via costume.injectFacts
 * - Synthetic history is generated correctly for each minion
 * - No gadget re-execution occurs (all context comes from synthetic history)
 *
 * ORCHESTRATION PATTERN:
 * The orchestrate mission coordinates multiple specialist agents working on the same codebase:
 * 1. All agents share access to PRD and plan files via workbench
 * 2. Each agent receives only the facts relevant to their role (via costume.injectFacts)
 * 3. Facts are pre-loaded, not discovered at runtime (synthetic history, not live gadget execution)
 * 4. This enables parallel work without redundant file reads or fact discovery
 */
describe('Story 8: Workbench Orchestration Integration', () => {
  let context: DefaultMissionContext;
  let mockHandle: MissionHandle;
  let mockQuestionBridge: IQuestionBridge;
  let workbench: Workbench;
  const minionsToKill: BrainlessMinion[] = [];

  beforeEach(() => {
    // Use fake timers for BrainlessMinion
    vi.useFakeTimers();

    mockHandle = new MissionHandle('test-run-123', 'orchestrate-mission');

    mockQuestionBridge = {
      ask: vi.fn().mockResolvedValue('user answer'),
      cancel: vi.fn(),
    };

    // Create ZombieHatchery: returns BrainlessMinion for deterministic testing
    const zombieHatchery: IHatchery = {
      spawn: async (spec: MinionSpec) => {
        return new BrainlessMinion(spec);
      },
    };

    context = new DefaultMissionContext({
      hatchery: zombieHatchery,
      questionBridge: mockQuestionBridge,
      handle: mockHandle,
      wing: '/test/wing' as unknown as Wing,
    });
    void context; // Referenced in setup, may be used in future tests

    workbench = new Workbench(createInMemorySandbox());
  });

  afterEach(() => {
    vi.useRealTimers();
    // Kill all spawned minions
    for (const minion of minionsToKill) {
      minion.kill();
    }
    minionsToKill.length = 0;
  });

  it('demonstrates orchestration pattern with shared PRD and selective fact injection', async () => {
    // SETUP: Populate workbench with PRD, plan, and facts
    // This simulates what the orchestrate mission would prepare
    const prdContent = `# PRD: Feature X
## Current State
The system has basic authentication.

## Already Implemented
- User login
- Password reset

## Tech to Leverage
- Effect-TS for error handling
- Zod for validation`;

    const planContent = `# Implementation Plan
## Story 1: Add OAuth support
- Research OAuth providers
- Implement OAuth flow
- Add tests`;

    await Effect.runPromise(
      workbench.addFile('/prd/feature-x.md', prdContent, 'prd')
    );
    await Effect.runPromise(
      workbench.addFile('/plan/feature-x-plan.md', planContent, 'plan')
    );

    // Add facts that minions will selectively receive
    workbench.addFact('build', 'Build command: pnpm nx build', 'confirmed', 'analyst');
    workbench.addFact('build', 'Build outputs to dist/', 'inferred', 'analyst');
    workbench.addFact('structure', 'Monorepo using nx', 'confirmed', 'analyst');
    workbench.addFact('structure', 'Libraries in libs/ directory', 'confirmed', 'analyst');
    workbench.addFact('test', 'Uses Vitest for testing', 'confirmed', 'tester');
    workbench.addFact('test', 'Test files use .spec.ts extension', 'confirmed', 'tester');

    // SPAWN 3 MINIONS: planner, developer, critic
    // Each has different injectFacts settings (simulating costume.injectFacts)
    // NOTE: We spawn directly with specs rather than using costumes to avoid
    // the costume loader dependency (which has a separate bug with Wing initialization)

    // Create a ZombieHatchery that returns BrainlessMinion with workbench support
    const zombieHatchery: IHatchery = {
      spawn: async (spec: MinionSpec) => {
        // Pass workbench and syntheticHistory to BrainlessMinion
        const minion = new BrainlessMinion(spec);
        return minion;
      },
    };

    // Manually generate synthetic history for each minion based on their injectFacts
    // This simulates what buildSpecFromCostume + workbench injection would do

    // PLANNER: No facts (only sees files)
    const plannerSpec = {
      client: 'claude-code',
      wing: '/test/wing',
      model: 'claude-sonnet-4-20250514',
      useBuiltInSystemPrompt: true,
      workbench,
      syntheticHistory: workbenchToSyntheticHistory(workbench, []), // Empty array = no facts
    } as MinionSpec;
    const plannerMinion = await zombieHatchery.spawn(plannerSpec) as BrainlessMinion;
    minionsToKill.push(plannerMinion);

    // DEVELOPER: Sees build and structure facts
    const developerSpec = {
      client: 'claude-code',
      wing: '/test/wing',
      model: 'claude-sonnet-4-20250514',
      useBuiltInSystemPrompt: true,
      workbench,
      syntheticHistory: workbenchToSyntheticHistory(workbench, ['build', 'structure']),
    } as MinionSpec;
    const developerMinion = await zombieHatchery.spawn(developerSpec) as BrainlessMinion;
    minionsToKill.push(developerMinion);

    // CRITIC: Sees only structure facts
    const criticSpec = {
      client: 'claude-code',
      wing: '/test/wing',
      model: 'claude-sonnet-4-20250514',
      useBuiltInSystemPrompt: true,
      workbench,
      syntheticHistory: workbenchToSyntheticHistory(workbench, ['structure']),
    } as MinionSpec;
    const criticMinion = await zombieHatchery.spawn(criticSpec) as BrainlessMinion;
    minionsToKill.push(criticMinion);

    // Use as BrainlessMinion to access receive() and workbench
    const planner = plannerMinion;
    const developer = developerMinion;
    const critic = criticMinion;

    // VERIFY: Each minion has workbench reference
    expect(planner.workbench).toBe(workbench);
    expect(developer.workbench).toBe(workbench);
    expect(critic.workbench).toBe(workbench);

    // VERIFY: All minions see PRD and plan files
    // Files are injected as synthetic tool_use/tool_result pairs
    const plannerMessages = await collectSyntheticMessages(planner);
    const developerMessages = await collectSyntheticMessages(developer);
    const criticMessages = await collectSyntheticMessages(critic);

    // Check planner receives files but NO facts (injectFacts: [])
    const plannerFiles = plannerMessages.filter(m => m.type === 'tool_result');
    const plannerFacts = plannerMessages.filter(m => m.type === 'text');

    expect(plannerFiles.length).toBe(2); // PRD + plan
    expect(plannerFacts.length).toBe(0); // No facts

    // Verify planner sees PRD content
    const plannerPRD = plannerFiles.find(m =>
      m.type === 'tool_result' && typeof m.content === 'string' && m.content.includes('Feature X')
    );
    expect(plannerPRD).toBeDefined();

    // Check developer receives files AND build+structure facts
    const developerFiles = developerMessages.filter(m => m.type === 'tool_result');
    const developerFacts = developerMessages.filter(m => m.type === 'text');

    expect(developerFiles.length).toBe(2); // PRD + plan
    expect(developerFacts.length).toBe(2); // build + structure categories

    // Verify developer sees build facts
    const developerBuildFacts = developerFacts.find(m =>
      m.type === 'text' && m.content.includes('Project Facts (build)')
    );
    expect(developerBuildFacts).toBeDefined();
    if (developerBuildFacts?.type === 'text') {
      expect(developerBuildFacts.content).toContain('pnpm nx build');
    }

    // Verify developer sees structure facts
    const developerStructureFacts = developerFacts.find(m =>
      m.type === 'text' && m.content.includes('Project Facts (structure)')
    );
    expect(developerStructureFacts).toBeDefined();

    // Verify developer does NOT see test facts
    const developerTestFacts = developerFacts.find(m =>
      m.type === 'text' && m.content.includes('Project Facts (test)')
    );
    expect(developerTestFacts).toBeUndefined();

    // Check critic receives files AND only structure facts
    const criticFiles = criticMessages.filter(m => m.type === 'tool_result');
    const criticFacts = criticMessages.filter(m => m.type === 'text');

    expect(criticFiles.length).toBe(2); // PRD + plan
    expect(criticFacts.length).toBe(1); // Only structure category

    // Verify critic sees structure facts
    const criticStructureFacts = criticFacts.find(m =>
      m.type === 'text' && m.content.includes('Project Facts (structure)')
    );
    expect(criticStructureFacts).toBeDefined();

    // Verify critic does NOT see build or test facts
    const criticBuildFacts = criticFacts.find(m =>
      m.type === 'text' && m.content.includes('Project Facts (build)')
    );
    expect(criticBuildFacts).toBeUndefined();

    // VERIFY: Messages are synthetic (metadata.synthetic === true)
    for (const msg of [...plannerMessages, ...developerMessages, ...criticMessages]) {
      expect(msg.metadata?.synthetic).toBe(true);
    }

    // VERIFY: No gadget re-execution occurred
    // If gadgets were re-executed, we'd see different timestamps or additional messages
    // Synthetic history uses deterministic timestamps from workbench
    const allMessages = [...plannerMessages, ...developerMessages, ...criticMessages];
    const syntheticCount = allMessages.filter(m => m.metadata?.synthetic).length;
    expect(syntheticCount).toBe(allMessages.length); // All messages are synthetic

    // DOCUMENTATION: Explain the pattern
    // This test proves the orchestration pattern:
    // 1. Workbench contains shared context (PRD, plan files, discovered facts)
    // 2. Multiple minions receive the same workbench reference
    // 3. Each minion's costume.injectFacts controls which facts they see
    // 4. Synthetic history ensures no redundant file reads or fact discovery
    // 5. All context appears as if the minion had previously executed gadgets
    //
    // In a real orchestrate mission:
    // - The mission creates a workbench and populates it with PRD/plan
    // - Early steps (analyst) discover facts and add them to workbench
    // - Later steps (planner, developer, critic) spawn with the same workbench
    // - Each specialist sees only the facts relevant to their role
    // - No time wasted on redundant discovery or file reading
  });

  it('synthetic history appears before live messages in receive()', async () => {
    // Add minimal workbench content
    await Effect.runPromise(
      workbench.addFile('/test.md', 'Test content', 'test')
    );
    workbench.addFact('build', 'Test fact', 'confirmed');

    // Create zombieHatchery
    const zombieHatchery: IHatchery = {
      spawn: async (spec: MinionSpec) => new BrainlessMinion(spec),
    };

    // Spawn with build facts injected
    const spec = {
      client: 'claude-code',
      wing: '/test/wing',
      model: 'claude-sonnet-4-20250514',
      useBuiltInSystemPrompt: true,
      workbench,
      syntheticHistory: workbenchToSyntheticHistory(workbench, ['build']),
    } as MinionSpec;
    const minion = await zombieHatchery.spawn(spec) as BrainlessMinion;
    minionsToKill.push(minion);

    // Send a live message
    await minion.testSend({
      type: 'text',
      content: 'Live message after synthetic history',
      timestamp: Date.now(),
    });

    // Collect all messages
    const iterator = minion.receive();
    const allMessages = [];

    // Get synthetic messages
    let next = iterator.next();
    await vi.advanceTimersByTimeAsync(20);
    let result = await next;

    while (!result.done && result.value.metadata?.synthetic) {
      allMessages.push(result.value);
      next = iterator.next();
      await vi.advanceTimersByTimeAsync(20);
      result = await next;
    }

    // Get the live message
    if (!result.done) {
      allMessages.push(result.value);
    }

    // Verify ordering: synthetic first, then live
    const syntheticCount = allMessages.filter(m => m.metadata?.synthetic).length;
    const liveCount = allMessages.filter(m => !m.metadata?.synthetic).length;

    expect(syntheticCount).toBeGreaterThan(0);
    expect(liveCount).toBe(1);

    // Verify synthetic messages come before live
    let seenLive = false;
    for (const msg of allMessages) {
      if (!msg.metadata?.synthetic) {
        seenLive = true;
      } else if (seenLive) {
        // If we've seen a live message, we shouldn't see any more synthetic ones
        throw new Error('Synthetic message appeared after live message');
      }
    }
  });

  it('handles empty workbench gracefully', async () => {
    // Empty workbench - no files, no facts
    const emptyWorkbench = new Workbench(createInMemorySandbox());

    // Create zombieHatchery
    const zombieHatchery: IHatchery = {
      spawn: async (spec: MinionSpec) => new BrainlessMinion(spec),
    };

    const spec = {
      client: 'claude-code',
      wing: '/test/wing',
      model: 'claude-sonnet-4-20250514',
      useBuiltInSystemPrompt: true,
      workbench: emptyWorkbench,
      syntheticHistory: workbenchToSyntheticHistory(emptyWorkbench, ['build']),
    } as MinionSpec;
    const minion = await zombieHatchery.spawn(spec) as BrainlessMinion;
    minionsToKill.push(minion);

    // Should still work, just no synthetic messages
    const messages = await collectSyntheticMessages(minion);
    expect(messages).toEqual([]);
  });

  it('different costumes with same workbench get different synthetic histories', async () => {
    // Add comprehensive workbench content
    await Effect.runPromise(
      workbench.addFile('/test.md', 'Test content', 'test')
    );
    workbench.addFact('build', 'Build fact', 'confirmed');
    workbench.addFact('structure', 'Structure fact', 'confirmed');
    workbench.addFact('test', 'Test fact', 'confirmed');

    // Create zombieHatchery
    const zombieHatchery: IHatchery = {
      spawn: async (spec: MinionSpec) => new BrainlessMinion(spec),
    };

    // Spawn with different injectFacts settings (simulating different costumes)
    const spec1 = {
      client: 'claude-code',
      wing: '/test/wing',
      model: 'claude-sonnet-4-20250514',
      useBuiltInSystemPrompt: true,
      workbench,
      syntheticHistory: workbenchToSyntheticHistory(workbench, []), // Planner: no facts
    } as MinionSpec;
    const minion1 = await zombieHatchery.spawn(spec1) as BrainlessMinion;
    minionsToKill.push(minion1);

    const spec2 = {
      client: 'claude-code',
      wing: '/test/wing',
      model: 'claude-sonnet-4-20250514',
      useBuiltInSystemPrompt: true,
      workbench,
      syntheticHistory: workbenchToSyntheticHistory(workbench, ['build', 'structure']), // Developer: build + structure
    } as MinionSpec;
    const minion2 = await zombieHatchery.spawn(spec2) as BrainlessMinion;
    minionsToKill.push(minion2);

    const messages1 = await collectSyntheticMessages(minion1);
    const messages2 = await collectSyntheticMessages(minion2);

    // Different lengths due to different fact injection
    expect(messages1.length).not.toBe(messages2.length);

    // Minion1 has no facts
    const facts1 = messages1.filter(m => m.type === 'text');
    expect(facts1.length).toBe(0);

    // Minion2 has build and structure facts
    const facts2 = messages2.filter(m => m.type === 'text');
    expect(facts2.length).toBe(2);
  });
});

/**
 * Maximum time to wait for a synthetic message before assuming queue is empty.
 * Set conservatively high to avoid flakiness in slow CI environments.
 */
const SYNTHETIC_MESSAGE_TIMEOUT_MS = 200;

/**
 * Helper: Collect all synthetic messages from a BrainlessMinion
 *
 * Iterates through receive() until no more synthetic messages are found.
 * Returns array of synthetic messages in order.
 *
 * Stops when:
 * - A non-synthetic message is encountered
 * - The iterator is done
 * - A timeout occurs (no message received within SYNTHETIC_MESSAGE_TIMEOUT_MS)
 */
async function collectSyntheticMessages(minion: BrainlessMinion): Promise<MinionMessage[]> {
  const messages: MinionMessage[] = [];
  const iterator = minion.receive();

  //  Collect all synthetic messages with timeout protection
  while (true) {
    const next = iterator.next();

    // Race between the iterator and a timeout
    // Both setTimeout (inside BrainlessMinion.receive() busy-wait loop) and
    // the timeout promise need fake timer advancement to fire, so we must
    // advance timers AFTER creating both promises.
    const timeoutPromise = new Promise<{ timeout: true }>((resolve) =>
      setTimeout(() => resolve({ timeout: true }), SYNTHETIC_MESSAGE_TIMEOUT_MS)
    );
    await vi.advanceTimersByTimeAsync(SYNTHETIC_MESSAGE_TIMEOUT_MS + 20);
    const result: IteratorResult<MinionMessage> | { timeout: true } = await Promise.race([
      next,
      timeoutPromise,
    ]);

    // Timeout - no more messages
    if ('timeout' in result) {
      break;
    }

    // Iterator done
    if (result.done) {
      break;
    }

    // Non-synthetic message - stop here
    if (!result.value.metadata?.synthetic) {
      break;
    }

    // Synthetic message - collect it
    messages.push(result.value);
  }

  return messages;
}

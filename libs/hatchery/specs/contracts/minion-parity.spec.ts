/**
 * Minion Parity Verification
 *
 * This test ensures that ALL IMinion functionality tested on BrainlessMinion
 * is also verified via contract tests. This prevents BrainlessMinion from
 * accumulating features that regular minion implementations don't support.
 *
 * PRINCIPLE: All changes to BrainlessMinion MUST be TDDed, and those tests
 * MUST be part of the contract test suite, ensuring that all Minion
 * implementations remain in sync.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'path';
import { createDiskSandbox } from '@minions/file-store';
import type { IMinion } from '../../src/ports/IMinion';

/**
 * IMinion interface members that MUST be tested via contract tests.
 *
 * This list is derived from the IMinion interface definition in domain-types.
 * When you add a new member to IMinion, you MUST:
 * 1. Add it to this list
 * 2. Add contract tests in minion-contract.ts
 * 3. Implement it in all minion implementations
 */
const IMINION_INTERFACE_MEMBERS = [
  // Properties
  'id',
  'spec',
  'costume',
  'status',
  // Methods
  'send',
  'receive',
  'reconfigure',
  'kill',
  'interrupt',
] as const;

/**
 * IMinion members currently covered by contract tests.
 *
 * UPDATE THIS LIST when you add contract tests for IMinion functionality.
 * The test below will fail if this doesn't match IMINION_INTERFACE_MEMBERS.
 */
const CONTRACT_TESTED_MEMBERS = [
  'id',
  'spec',
  'costume',
  'status',
  'send',
  'receive',
  'reconfigure',
  'kill',
  'interrupt',
] as const;

/**
 * BrainlessMinion-specific members that are NOT part of IMinion.
 *
 * These are legitimate test-only features that help with testing but
 * should never be expected on real minion implementations.
 */
const BRAINLESS_ONLY_MEMBERS = [
  // Test-side co-routine
  'testSend',
  'testReceive',
  // Test-only state inspection
  'isAlive',
  'wasInterrupted',
  'getExecutableGadgets',
  // Test-only actions
  'completeTurn',
  // Constructor options (not members but documented for clarity)
  // - backSideCoRoutine
  // - maxBufferSize
  // - onTurnComplete
  // - onStatusChange
  // - executableGadgets
] as const;

describe('Minion Parity Verification', () => {
  // This test verifies that all IMinion interface members are covered by contract tests.
  // It will fail if any IMinion members are not in CONTRACT_TESTED_MEMBERS.
  it('all IMinion interface members must be covered by contract tests', () => {
    const contractTestedMembers: readonly string[] = CONTRACT_TESTED_MEMBERS;
    const missingFromContract = IMINION_INTERFACE_MEMBERS.filter(
      member => !contractTestedMembers.includes(member)
    );

    if (missingFromContract.length > 0) {
      throw new Error(
        `CONTRACT PARITY VIOLATION\n\n` +
        `The following IMinion interface members are NOT covered by contract tests:\n` +
        `  - ${missingFromContract.join('\n  - ')}\n\n` +
        `All changes to BrainlessMinion must be TDDed, and those tests must be part ` +
        `of the contract test suite, ensuring that all Minion implementations will ` +
        `remain in sync.\n\n` +
        `To fix:\n` +
        `1. Add contract tests for these members in minion-contract.ts\n` +
        `2. Update CONTRACT_TESTED_MEMBERS in this file\n` +
        `3. Ensure all minion implementations pass the new contract tests`
      );
    }

    expect(missingFromContract).toHaveLength(0);
  });

  it('BrainlessMinion test-only members are not accidentally in IMinion', () => {
    // This is a compile-time check - if any BRAINLESS_ONLY_MEMBERS
    // were added to IMinion, we'd get a TypeScript error when trying
    // to access them on a plain IMinion
    const verifyNotInInterface = (minion: IMinion) => {
      // These should NOT exist on IMinion (TypeScript would error if they did)
      // @ts-expect-error - testSend should not be on IMinion
      void minion.testSend;
      // @ts-expect-error - testReceive should not be on IMinion
      void minion.testReceive;
      // @ts-expect-error - isAlive should not be on IMinion
      void minion.isAlive;
      // @ts-expect-error - wasInterrupted should not be on IMinion
      void minion.wasInterrupted;
      // @ts-expect-error - completeTurn should not be on IMinion
      void minion.completeTurn;
      // @ts-expect-error - getExecutableGadgets should not be on IMinion
      void minion.getExecutableGadgets;
    };
    void verifyNotInInterface; // compile-time check only - function is intentionally not called

    // If this test runs without TypeScript errors, the members are correctly
    // isolated to BrainlessMinion
    expect(BRAINLESS_ONLY_MEMBERS.length).toBeGreaterThan(0);
  });

  it('CONTRACT_TESTED_MEMBERS only contains valid IMinion members', () => {
    const iminionInterfaceMembers: readonly string[] = IMINION_INTERFACE_MEMBERS;
    const invalidMembers = CONTRACT_TESTED_MEMBERS.filter(
      member => !iminionInterfaceMembers.includes(member)
    );

    if (invalidMembers.length > 0) {
      throw new Error(
        `CONTRACT_TESTED_MEMBERS contains invalid entries:\n` +
        `  - ${invalidMembers.join('\n  - ')}\n\n` +
        `These are not IMinion interface members. Remove them from CONTRACT_TESTED_MEMBERS.`
      );
    }

    expect(invalidMembers).toHaveLength(0);
  });

  /**
   * BEST-EFFORTS TEST: Detect new BrainlessMinion tests that aren't in contract tests
   *
   * This test scans brainless-minion.spec.ts for test descriptions and flags any
   * that look like they're testing IMinion behavior but aren't acknowledged.
   *
   * When this test fails:
   * 1. If your test is for IMinion behavior:
   *    - Add the contract test in minion-contract.ts
   *    - REMOVE the test from brainless-minion.spec.ts (don't duplicate)
   * 2. If your test is BrainlessMinion-specific (test helper, not IMinion behavior):
   *    - Add to ACKNOWLEDGED_BRAINLESS_TESTS with a comment explaining why
   */
  it('new BrainlessMinion tests must be acknowledged or added to contract tests', async () => {
    // Read brainless-minion.spec.ts to extract test descriptions
    // Use file-store to read the file
    const specPath = path.join(__dirname, '../adapters/brainless-minion.spec.ts');
    const sandbox = createDiskSandbox(path.dirname(specPath));
    const fileResult = await sandbox.root.child(path.basename(specPath));

    if (!fileResult.found || fileResult.node.kind !== 'file') {
      throw new Error(`Could not find brainless-minion.spec.ts at ${specPath}`);
    }

    const specContent = await fileResult.node.read();

    // Extract it() and it.skip() test descriptions using regex
    const testPattern = /it(?:\.skip)?\s*\(\s*['"`]([^'"`]+)['"`]/g;
    const foundTests: string[] = [];
    let match;
    while ((match = testPattern.exec(specContent)) !== null) {
      foundTests.push(match[1]);
    }

    // Known patterns that indicate IMinion behavior (should be in contract tests)
    const IMINION_BEHAVIOR_PATTERNS = [
      /^(status|costume|reconfigure|send|receive|kill|interrupt)\s/i,
      /implements\s+IMinion/i,
      /IMinion\s+interface/i,
      /status\s+(property|starts|transitions)/i,
      /costume\s+property/i,
      /reconfigure\s*\(\)/i,
    ];

    // Tests that are acknowledged as either:
    // - Already covered by contract tests (via testMinionContract)
    // - Legitimately BrainlessMinion-specific (with documented reason)
    const ACKNOWLEDGED_BRAINLESS_TESTS = [
      // Via testMinionContract (contract coverage)
      'implements IMinion interface',

      // BrainlessMinion-specific: Test double co-routine features
      'is alive on construction',
      'dies when killed',
      'supports production send and test receive',
      'supports test send and production receive',
      'supports bidirectional communication',
      'buffers messages when not consuming',

      // BrainlessMinion-specific: Default back-side co-routine (test helper)
      'responds to promptForText with text message',
      'responds to promptForThinking with thinking message',
      'responds to promptForToolUse with tool_use message',
      'responds to promptForError with error message',
      'responds to promptForStatus with status message',
      'createToolResult generates correct tool_result message',
      'allows replacing back-side co-routine for custom behavior',
      'responds to /exit by stopping gracefully',
      'interrupt() sets interrupt flag',
      'kill() stops the minion',

      // BrainlessMinion-specific: StatusChange event callbacks (test helper feature)
      // These use onStatusChange constructor option which is not part of IMinion
      'status transitions to waiting when completeTurn() is called',
      'emits StatusChange event on waiting -> processing transition',
      'emits StatusChange event on processing -> waiting transition',
      'emits StatusChange event on any -> dead transition',
      'StatusChange callback receives minionId',
      'does not emit StatusChange event when status does not change',
      'StatusChange callback is optional',

      // Executable gadgets (test helper feature)
      'executes gadgets when /use tool command matches gadget name',
      'returns error when gadget execution fails',
      'falls back to tool_use message when no matching gadget found',
      'works without executable gadgets',
    ];

    // Find tests that look like IMinion behavior but aren't acknowledged
    const unacknowledgedTests = foundTests.filter(test => {
      // Skip if already acknowledged
      if (ACKNOWLEDGED_BRAINLESS_TESTS.includes(test)) {
        return false;
      }

      // Check if it matches any IMinion behavior pattern
      return IMINION_BEHAVIOR_PATTERNS.some(pattern => pattern.test(test));
    });

    // Also find tests that aren't acknowledged at all (stricter check)
    const unknownTests = foundTests.filter(test =>
      !ACKNOWLEDGED_BRAINLESS_TESTS.includes(test)
    );

    if (unacknowledgedTests.length > 0) {
      throw new Error(
        `UNACKNOWLEDGED BRAINLESS TESTS DETECTED\n\n` +
        `The following tests in brainless-minion.spec.ts appear to test IMinion behavior ` +
        `but are not acknowledged:\n` +
        `  - ${unacknowledgedTests.join('\n  - ')}\n\n` +
        `All changes to BrainlessMinion must be TDDed, and those tests must be part ` +
        `of the contract test suite, ensuring that all Minion implementations will ` +
        `remain in sync.\n\n` +
        `To fix:\n` +
        `1. If testing IMinion behavior:\n` +
        `   a. Add the contract test in minion-contract.ts\n` +
        `   b. REMOVE the test from brainless-minion.spec.ts (don't duplicate)\n` +
        `2. If BrainlessMinion-specific (test helper, not IMinion behavior):\n` +
        `   a. Add to ACKNOWLEDGED_BRAINLESS_TESTS with a comment explaining why\n`
      );
    }

    // Note: We don't fail on unknownTests - just log for visibility
    // This allows new test-helper tests without requiring immediate acknowledgment
    if (unknownTests.length > 0) {
      console.log(
        `INFO: ${unknownTests.length} tests in brainless-minion.spec.ts are not in ` +
        `ACKNOWLEDGED_BRAINLESS_TESTS. Consider adding them to maintain parity documentation.`
      );
    }

    expect(unacknowledgedTests).toHaveLength(0);
  });
});

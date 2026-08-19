import { describe, it, expect } from 'vitest';
import type { IHatchery } from '../../src/ports/IHatchery';
import type { MinionSpec } from '../../src/domain';

/**
 * Helper function to create a test spec
 *
 * Always requests a real client type (claude-code).
 * - ZombieHatchery will ignore the client type and return BrainlessMinion
 * - ProductionHatchery will honor the client type and return real minion
 */
function createTestSpec(): MinionSpec {
  return {
    client: 'claude-code',
    wing: process.cwd(),
    model: 'claude-sonnet-4',
    useBuiltInSystemPrompt: true
  };
}

/**
 * Parameterized contract tests for IHatchery implementations
 *
 * These tests define the vertical slices that ALL hatchery implementations must satisfy.
 * Both ZombieHatchery (Phase 1) and ProductionHatchery (Phase 3) must pass these tests.
 *
 * Important: Tests always request real client types (e.g., 'claude-code').
 * - ZombieHatchery ignores the client type and always returns BrainlessMinion (test double pattern)
 * - ProductionHatchery honors the client type and returns the appropriate real minion
 *
 * Usage:
 * ```typescript
 * // In zombie-hatchery.spec.ts:
 * testHatcheryContract('ZombieHatchery', () => new ZombieHatchery());
 *
 * // In production-hatchery.spec.ts:
 * testHatcheryContract('ProductionHatchery', () => new ProductionHatchery());
 * ```
 *
 * @param name - Name of the hatchery implementation being tested
 * @param createHatchery - Factory function that creates a hatchery instance
 */
export function testHatcheryContract(
  name: string,
  createHatchery: () => IHatchery
) {
  describe(`Hatchery Contract: ${name}`, () => {
    it('SLICE 1: can spawn minions from spec', async () => {
      const hatchery = createHatchery();
      const spec: MinionSpec = {
        client: 'claude-code',
        wing: process.cwd(),
        model: 'claude-sonnet-4',
        useBuiltInSystemPrompt: true
      };

      const minion = await hatchery.spawn(spec);

      expect(minion).toBeDefined();
      expect(minion.spec).toBe(spec);
      expect(minion.id).toBeDefined();
      expect(typeof minion.id).toBe('string');
    });

    it('SLICE 2: spawns multiple minions independently', async () => {
      const hatchery = createHatchery();
      const spec = createTestSpec();

      const minion1 = await hatchery.spawn(spec);
      const minion2 = await hatchery.spawn(spec);

      expect(minion1.id).not.toBe(minion2.id);
      expect(minion1).not.toBe(minion2);
    });

    it('SLICE 3: spawned minions are alive and ready', async () => {
      const hatchery = createHatchery();
      const spec = createTestSpec();

      const minion = await hatchery.spawn(spec);

      // Minion is always running from spawn until it dies
      expect(minion.send).toBeInstanceOf(Function);
      expect(minion.receive).toBeInstanceOf(Function);
      expect(minion.spec).toBe(spec);
    });
  });
}

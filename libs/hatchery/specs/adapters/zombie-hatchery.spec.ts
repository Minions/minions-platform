import { describe, it, expect } from 'vitest';
import { testHatcheryContract } from '../contracts/hatchery-contract';
import { ZombieHatchery } from '../../src/adapters/hatcheries/ZombieHatchery';
import { BrainlessMinion } from '../../src/adapters/minions/BrainlessMinion';
import type { IMinion } from '../../src/ports/IMinion';
import type { MinionSpec } from '../../src/domain';

// STEP 1: Run contract tests (vertical slices)
// Note: Contract tests request 'claude-code', but ZombieHatchery ignores client type
testHatcheryContract('ZombieHatchery', () => new ZombieHatchery());

// STEP 2: ZombieHatchery-specific tests (spawn events)
describe('Spec S1.8: ZombieHatchery Spawn Event Features', () => {
  it('implements IHatchery interface', () => {
    const hatchery = new ZombieHatchery();
    expect(hatchery.spawn).toBeDefined();
  });

  it('implements ISpawnEventEmitter interface', () => {
    const hatchery = new ZombieHatchery();
    expect(hatchery.on).toBeDefined();
    expect(hatchery.off).toBeDefined();
  });

  it('always returns brainless minions regardless of requested client type', async () => {
    const hatchery = new ZombieHatchery();
    const spec: MinionSpec = {
      client: 'claude-code', // Request real client
      wing: '/test',
      model: 'test',
      useBuiltInSystemPrompt: true
    };

    const minion = await hatchery.spawn(spec);

    // ZombieHatchery ignores client type and returns BrainlessMinion (test double pattern)
    expect(minion).toBeInstanceOf(BrainlessMinion);
    expect(minion.spec).toBe(spec);
  });

  it('emits spawn event when minion created', async () => {
    const hatchery = new ZombieHatchery();
    let spawnedMinion: IMinion | null = null;
    let spawnedSpec: MinionSpec | null = null;

    hatchery.on('spawn', (minion, spec) => {
      spawnedMinion = minion;
      spawnedSpec = spec;
    });

    const spec: MinionSpec = createTestSpec();
    const minion = await hatchery.spawn(spec);

    expect(spawnedMinion).toBe(minion);
    expect(spawnedSpec).toBe(spec);
  });

  it('emits spawn events for multiple minions', async () => {
    const hatchery = new ZombieHatchery();
    const spawned: Array<{ minion: IMinion, spec: MinionSpec }> = [];

    hatchery.on('spawn', (minion, spec) => {
      spawned.push({ minion, spec });
    });

    const spec1 = { ...createTestSpec(), name: 'Minion1' };
    const spec2 = { ...createTestSpec(), name: 'Minion2' };

    await hatchery.spawn(spec1);
    await hatchery.spawn(spec2);

    expect(spawned).toHaveLength(2);
    expect(spawned[0].spec.name).toBe('Minion1');
    expect(spawned[1].spec.name).toBe('Minion2');
  });

  it('can remove spawn event listeners', async () => {
    const hatchery = new ZombieHatchery();
    let callCount = 0;

    const handler = () => { callCount++; };

    hatchery.on('spawn', handler);
    await hatchery.spawn(createTestSpec());
    expect(callCount).toBe(1);

    hatchery.off('spawn', handler);
    await hatchery.spawn(createTestSpec());
    expect(callCount).toBe(1); // Still 1, not 2
  });
});

function createTestSpec(): MinionSpec {
  return {
    client: 'claude-code', // Always request real client type
    wing: '/test',
    model: 'test-model',
    useBuiltInSystemPrompt: true
  };
}

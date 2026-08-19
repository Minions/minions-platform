import { describe, it, expect } from 'vitest';
import type { ISpawnEventEmitter } from '../../src/ports/ISpawnEventEmitter';
import type { IMinion } from '../../src/ports/IMinion';
import type { MinionSpec } from '../../src/domain';

describe('Spec S1.4: ISpawnEventEmitter Interface', () => {
  it('can be implemented', () => {
    class TestEmitter implements ISpawnEventEmitter {
      on(_event: 'spawn', _handler: (minion: IMinion, spec: MinionSpec) => void): void { /* no-op */ }
      off(_event: 'spawn', _handler: (...args: unknown[]) => void): void { /* no-op */ }
    }

    const emitter = new TestEmitter();
    expect(emitter.on).toBeDefined();
    expect(emitter.off).toBeDefined();
  });

  it('type-checks spawn event handler', () => {
    const handler = (minion: IMinion, spec: MinionSpec) => {
      expect(minion).toBeDefined();
      expect(spec).toBeDefined();
    };

    // Should compile without errors
    const emitter: ISpawnEventEmitter = {
      on: (_event, _h) => { /* no-op */ },
      off: (_event, _h) => { /* no-op */ }
    };

    emitter.on('spawn', handler);
  });
});

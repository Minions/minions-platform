import type { IMinion, MinionSpec } from '@minions/domain-types';

/**
 * Event emitter interface for test observability
 *
 * ISpawnEventEmitter provides a way for test code to observe when minions
 * are spawned from a hatchery. This is particularly useful for ZombieHatchery
 * in test scenarios where you want to:
 *
 * - Intercept spawned minions and configure their behavior
 * - Verify that minions are being spawned correctly
 * - Track which minions are created during mission execution
 *
 * Example usage in tests:
 * ```typescript
 * const hatchery = new ZombieHatchery();
 *
 * hatchery.on('spawn', (minion, spec) => {
 *   console.log(`Minion ${minion.id} spawned with client ${spec.client}`);
 *   // Configure minion behavior for test
 * });
 * ```
 */
export interface ISpawnEventEmitter {
  /**
   * Subscribe to spawn events
   *
   * @param event - Event name (always 'spawn')
   * @param handler - Event handler that receives (minion, spec)
   */
  on(event: 'spawn', handler: (minion: IMinion, spec: MinionSpec) => void): void;

  /**
   * Unsubscribe from spawn events
   *
   * @param event - Event name (always 'spawn')
   * @param handler - Event handler to remove
   */
  off(event: 'spawn', handler: (...args: unknown[]) => void): void;
}

import EventEmitter from 'eventemitter3';
import type { IHatchery } from '../../ports/IHatchery';
import type { ISpawnEventEmitter } from '../../ports/ISpawnEventEmitter';
import type { IMinion, MinionSpec } from '@minions/domain-types';
import { BrainlessMinion } from '../minions/BrainlessMinion';
import { extractExecutableGadgets } from './helpers';

/**
 * Test fake hatchery that spawns brainless minions with spawn event notifications
 *
 * ZombieHatchery is a test double that implements both IHatchery and ISpawnEventEmitter.
 * It creates BrainlessMinion instances and emits 'spawn' events for test observability.
 *
 * Key features:
 * - Spawns BrainlessMinion instances (test fakes)
 * - Emits 'spawn' event after each minion is created
 * - Enables tests to intercept and configure spawned minions
 * - Useful for testing mission coordination and minion management
 *
 * @example
 * ```typescript
 * const hatchery = new ZombieHatchery();
 *
 * // Intercept spawned minions
 * hatchery.on('spawn', (minion, spec) => {
 *   console.log(`Spawned ${minion.id} with client ${spec.client}`);
 *   // Configure minion behavior for test
 * });
 *
 * const spec = {
 *   client: 'claude-code',
 *   wing: '/test',
 *   model: 'test-model',
 *   useBuiltInSystemPrompt: true
 * };
 *
 * const minion = await hatchery.spawn(spec);
 * // spawn event fired with (minion, spec)
 * ```
 */
export class ZombieHatchery implements IHatchery, ISpawnEventEmitter {
  private emitter = new EventEmitter();

  /**
   * Spawn a new brainless minion
   *
   * Creates a BrainlessMinion instance and emits a 'spawn' event
   * for test observability.
   *
   * @param spec - Minion specification
   * @returns Promise that resolves to the created minion
   */
  async spawn(spec: MinionSpec): Promise<IMinion> {
    // Extract executable gadgets from spec (if it's an ExtendedMinionSpec)
    const executableGadgets = extractExecutableGadgets(spec);

    // Create BrainlessMinion with executable gadgets
    const minion = new BrainlessMinion(spec, undefined, {
      executableGadgets
    });

    this.emitter.emit('spawn', minion, spec);
    return minion;
  }

  /**
   * Subscribe to spawn events
   *
   * @param event - Event name (always 'spawn')
   * @param handler - Event handler that receives (minion, spec)
   */
  on(event: 'spawn', handler: (minion: IMinion, spec: MinionSpec) => void): void {
    this.emitter.on(event, handler);
  }

  /**
   * Unsubscribe from spawn events
   *
   * @param event - Event name (always 'spawn')
   * @param handler - Event handler to remove
   */
  off(event: 'spawn', handler: (minion: IMinion, spec: MinionSpec) => void): void {
    this.emitter.off(event, handler);
  }
}

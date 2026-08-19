import type { MinionSpec, IMinion } from '@minions/domain-types';

/**
 * Factory interface for creating minions
 *
 * IHatchery is the primary abstraction for spawning minions. Different implementations
 * can create different types of minions:
 * - ProductionHatchery: Creates real minions with actual AI clients
 * - ZombieHatchery: Creates test fake minions for testing
 */
export interface IHatchery {
  /**
   * Create a new minion from a specification
   *
   * @param spec - Declarative specification describing the minion to create
   * @returns A promise that resolves to a minion instance
   */
  spawn(spec: MinionSpec): Promise<IMinion>;
}

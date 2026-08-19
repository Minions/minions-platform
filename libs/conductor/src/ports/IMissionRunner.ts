import type { Mission } from '../domain/Mission';
import type { IMissionHandle } from '../domain/MissionHandle';
import type { Wing } from '@minions/file-store';

/**
 * Options for starting a mission
 */
export interface StartMissionOptions {
  /** The Wing where the mission runs */
  wing: Wing;

  /** Mission arguments (validated against mission's args schema) */
  args: Record<string, unknown>;
}

/**
 * Port for executing mission scripts
 *
 * IMissionRunner abstracts the execution of missions, handling:
 * - Context creation (emit, spawn, ask)
 * - Lifecycle management (start, completion, cancellation)
 * - Event emission to the invoker
 * - Minion lifecycle (killing spawned minions on completion)
 *
 * Different implementations can provide different execution environments:
 * - DefaultMissionRunner: Full implementation with Hatchery integration
 * - TestMissionRunner: Controlled execution for testing
 *
 * @example
 * ```typescript
 * const runner: IMissionRunner = new DefaultMissionRunner({ contextFactory });
 *
 * const handle = await runner.start(mission, {
 *   wing: myWing,
 *   args: { goal: 'Refactor auth', files: ['src/auth.ts'] }
 * });
 *
 * handle.on('progress', (e) => console.log(e.message));
 * await handle.completion;
 * ```
 */
export interface IMissionRunner {
  /**
   * Start executing a mission
   *
   * Creates a mission context, validates arguments, and begins execution.
   * Returns immediately with a handle for subscribing to events and
   * awaiting completion.
   *
   * @param mission - The mission to execute
   * @param options - Execution options (wing, args)
   * @returns A handle for interacting with the running mission
   */
  start(mission: Mission, options: StartMissionOptions): Promise<IMissionHandle>;

  /**
   * Get a running mission by its ID
   *
   * @param missionRunId - The unique ID from the mission handle
   * @returns The mission handle, or undefined if not found/completed
   */
  get(missionRunId: string): IMissionHandle | undefined;

  /**
   * List all currently running missions
   *
   * @returns Array of handles for running missions
   */
  listRunning(): IMissionHandle[];

  /**
   * Cancel a running mission
   *
   * Convenience method equivalent to calling handle.cancel().
   *
   * @param missionRunId - The unique ID of the mission to cancel
   * @param reason - Optional cancellation reason
   * @returns True if the mission was found and cancelled
   */
  cancel(missionRunId: string, reason?: string): boolean;
}

import type { Effect } from 'effect';
import type { MissionContext } from './MissionContext';
import type { MissionError } from './MissionEffect';

/**
 * JSON Schema type for mission arguments
 *
 * Follows the JSON Schema specification (subset used by MCP inputSchema).
 * This enables validation, UI form generation, and documentation.
 */
export interface MissionArgsSchema {
  type: 'object';
  properties: Record<string, MissionPropertySchema>;
  required?: string[];
  description?: string;
}

/**
 * Schema for a single property in the mission arguments
 */
export interface MissionPropertySchema {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'file-path';
  description?: string;
  items?: MissionPropertySchema;
  properties?: Record<string, MissionPropertySchema>;
  required?: string[];
  enum?: string[];
  default?: unknown;
}

/**
 * Mission definition with typed arguments
 *
 * A Mission is a deterministic script that orchestrates non-deterministic AI agents.
 * Missions use Effect for async and error handling — never exceptions, except to
 * catch them at boundaries with third-party libraries that throw.
 *
 * Missions:
 * - Have typed argument schemas (like MCP tools)
 * - Emit events to their invoker (no return values)
 * - Spawn minions via the Hatchery
 * - Make deterministic decisions based on received events
 * - Return Effects, not Promises
 *
 * @template TArgs - Type of the mission arguments
 *
 * @example
 * ```typescript
 * import { Effect } from 'effect';
 *
 * export const mission: Mission<{ goal: string }> = {
 *   name: 'refactor',
 *   description: 'Execute safe, incremental refactoring',
 *   api: 'effect',
 *   args: {
 *     type: 'object',
 *     properties: {
 *       goal: { type: 'string', description: 'What to refactor' },
 *     },
 *     required: ['goal']
 *   },
 *   run(ctx, args) {
 *     return Effect.gen(function* () {
 *       ctx.emit('started', { goal: args.goal });
 *       const minion = yield* ctx.spawn({ client: 'claude-code' });
 *       ctx.emit('completed', { summary: 'Done' });
 *     });
 *   }
 * };
 * ```
 */
export interface Mission<TArgs extends Record<string, unknown> = Record<string, unknown>> {
  /** Unique name identifying this mission */
  name: string;

  /** Human-readable description of what this mission does */
  description: string;

  /** API version marker — must be 'effect' for runnable missions */
  readonly api: 'effect';

  /** JSON Schema for validating and documenting arguments */
  args: MissionArgsSchema;

  /**
   * Execute the mission
   *
   * The run function receives a context for interacting with the system
   * and typed arguments. It returns an Effect that the runner executes.
   *
   * @param ctx - Mission context with emit(), spawn(), ask() methods
   * @param args - Typed mission arguments
   * @returns Effect that produces void or fails with MissionError
   */
  run(ctx: MissionContext, args: TArgs): Effect.Effect<void, MissionError>;
}

/**
 * Type guard to check if a value is a valid Effect-based Mission
 *
 * Checks for the 'api: effect' marker that distinguishes Effect-based
 * missions from legacy Promise-based ones.
 */
export function isMission(value: unknown): value is Mission {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.name === 'string' &&
    typeof obj.description === 'string' &&
    typeof obj.args === 'object' &&
    obj.args !== null &&
    typeof obj.run === 'function' &&
    obj.api === 'effect'
  );
}

/**
 * Check if a value looks like a legacy Promise-based mission
 *
 * Used by the loader to detect old-style missions that need to be
 * migrated to the Effect API. These missions appear in the Throne Room
 * as un-runnable with a migration message.
 */
export function isPromiseMission(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.name === 'string' &&
    typeof obj.description === 'string' &&
    typeof obj.args === 'object' &&
    obj.args !== null &&
    typeof obj.run === 'function' &&
    obj.api !== 'effect'
  );
}

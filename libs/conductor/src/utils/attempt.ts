import { Effect } from 'effect';
import { MissionExecutionError } from '../domain/MissionEffect.js';

/**
 * Wrap a Promise-returning function as a mission Effect that fails with
 * MissionExecutionError if the promise rejects or throws.
 *
 * The original error is preserved as `cause` so that `extractErrorReason`
 * in the mission runner can surface its stack trace without any per-mission
 * formatting code.
 *
 * ## When to use
 *
 * Use `attempt` for operations that should simply fail the mission when they
 * throw — the runner's global error formatter handles display:
 *
 * ```ts
 * const closet = yield* attempt(() => ctx.wing.closet());
 * const result = yield* attempt(() => closet.child('ui-generation'));
 * ```
 *
 * ## When NOT to use
 *
 * Use `Effect.tryPromise` directly when you need custom error-handling
 * (retries, repair, alternative paths, context-enriched messages):
 *
 * ```ts
 * const result = yield* Effect.tryPromise({
 *   try: () => riskyOp(),
 *   catch: (e) => new MissionExecutionError({
 *     message: `riskyOp failed for input ${input}: ${e instanceof Error ? e.message : String(e)}`,
 *     cause: e,
 *   }),
 * });
 * ```
 */
export function attempt<A>(fn: () => Promise<A>): Effect.Effect<A, MissionExecutionError> {
  return Effect.tryPromise({
    try: fn,
    catch: (e) =>
      new MissionExecutionError({
        message: e instanceof Error ? e.message : String(e),
        cause: e,
      }),
  });
}

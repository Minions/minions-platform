import { Cause } from 'effect';

/**
 * Extract a human-readable error reason with stack trace.
 *
 * This is the SINGLE display formatter for all mission failures. It is called
 * by every mission runner to populate `MissionFailedEvent.reason`.
 *
 * Missions need zero awareness of this. Any error that reaches the runner —
 * whether thrown as a raw exception or propagated as a typed Effect failure —
 * gets a full, readable stack trace here automatically.
 *
 * For Effect FiberFailure: delegates to `Cause.pretty()`, Effect's own
 * renderer, which surfaces the full cause chain including any Error stacks.
 * Missions that store `cause: e` in a MissionExecutionError (e.g. via
 * `attempt()`) get the original throw-site stack; others get the catch-handler
 * stack from the MissionExecutionError construction site. Both are useful.
 *
 * For regular Error: returns message + stack.
 * For non-Error values: String conversion.
 */
export function extractErrorReason(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  // Check for Effect FiberFailure — it has _id: 'FiberFailure' and a Cause
  const raw = error as unknown as Record<string, unknown>;
  if (raw['_id'] === 'FiberFailure') {
    const cause = raw['cause'] as Cause.Cause<unknown> | undefined;
    if (cause !== undefined && cause !== null) {
      // Cause.pretty() renders the full error chain with stack traces.
      // It works for Fail, Die, Both, Sequential, and All cause shapes
      // without any special-casing on our part.
      const pretty = Cause.pretty(cause);
      if (pretty) return pretty;
    }

    // Fallback if cause is missing
    return error.message || String(error);
  }

  // Regular Error — include stack if present
  return error.stack ?? error.message;
}

/**
 * The generic "optimistic-first-attempt, scoped-fetch-on-rejection,
 * generation-coalesced, jittered-backoff" retry shape described in
 * docs/design/movement-trunk-safety-redesign.md §3. This is deliberately a
 * standalone primitive with no dependency on `Movement`/`Mirror`/`Trunk`
 * (none of which have a Disk implementation yet — that's checklist chunk 4)
 * or even on `GitOperations`' exec plumbing directly: it's parameterized
 * entirely by caller-supplied functions, so chunk 4's `Movement.merge()`/
 * `Mirror.apply()` Disk implementations can each supply their own "build a
 * commit and try to CAS-publish it" logic and get the retry strategy for
 * free, without this module needing to know what a `Movement` or a `Trunk`
 * is.
 *
 * The five requirements from design doc §3, and where each lives:
 * 1. No public `fetch()` — this module never exposes a bare "fetch now" to
 *    its own callers either; `fetchRef` is only ever invoked reactively,
 *    from inside the retry loop, after an actual rejection.
 * 2. Optimistic first attempt — `publishWithRetry` calls `attempt()` once,
 *    unconditionally, before ever consulting `fetchRef`.
 * 3. Scoped, single-ref fetch on rejection — enforced by the caller-supplied
 *    `fetchRef`'s contract (see `PublishRetryOptions.fetchRef`'s doc); this
 *    module never fetches anything itself, so it can't broaden the scope by
 *    accident. `GitCoordinationState.fetchRefSinceGeneration` (see
 *    `GitOperations.ts`) is the intended real implementation.
 * 4. Generation-coalesced — also `GitCoordinationState.fetchRefSinceGeneration`'s
 *    job; this module just threads the generation number through attempt to
 *    attempt so concurrent retrants naturally coalesce there.
 * 5. Jittered backoff — `jitteredDelayMs` below, applied between every
 *    rejected attempt and the next.
 */

/** Thrown by `PublishRetryOptions.attempt` to signal a losing CAS race (the
 *  target ref advanced past what this attempt was built against) — the one
 *  condition `publishWithRetry` treats as retryable. Any other error thrown
 *  by `attempt` is not a "someone else won the race" situation and propagates
 *  immediately, aborting the loop. */
export class PublishRejectedError extends Error {
  constructor(message = "publish rejected: the target ref advanced since this attempt was built") {
    super(message);
    this.name = "PublishRejectedError";
  }
}

export interface PublishRetryOptions<T> {
  /**
   * One attempt: build a commit against whatever's currently in the local
   * cache and try to publish it (a CAS push/ref-update). Must throw
   * `PublishRejectedError` on a losing race. The very first call happens
   * with no fetch having run at all (design doc §3.2) — build against
   * whatever's already there.
   */
  attempt: () => Promise<T>;
  /**
   * Performs a scoped, single-ref fetch (`git fetch origin <ref>`, never a
   * full multi-branch fetch — design doc §3.3) and returns the resulting
   * generation number, coalesced with any other concurrent caller asking
   * for at least `sinceGeneration` (design doc §3.4) — typically backed by
   * `GitCoordinationState.fetchRefSinceGeneration`. Called only after a
   * `PublishRejectedError`, never before the first attempt.
   */
  fetchRef: (sinceGeneration: number) => Promise<number>;
  /**
   * The generation this attempt was (or will be) built against — usually 0
   * on a cold start, or whatever a previous `fetchRef` call resolved to.
   * Read once, before the first attempt; not re-read afterward (the loop
   * tracks it internally from each `fetchRef` result).
   */
  currentGeneration: () => Promise<number> | number;
  /** Bounds the number of attempts — a backstop against pathological
   *  contention storms, not a normal path. Mirrors the existing
   *  `MAX_PUBLISH_ATTEMPTS` pattern in `MovementManager`. */
  maxAttempts?: number;
  /** Base delay (ms) for the jittered backoff between retries. */
  baseDelayMs?: number;
  /** Injectable randomness source, for deterministic tests. */
  random?: () => number;
  /** Injectable delay function, for deterministic/fast tests. */
  delay?: (ms: number) => Promise<void>;
}

const DEFAULT_MAX_ATTEMPTS = 20;
const DEFAULT_BASE_DELAY_MS = 100;
/** Caps the exponential growth of the jitter window so a long contention
 *  storm's backoff doesn't grow unboundedly — 2^6 * baseDelayMs is already a
 *  multi-second ceiling at the default base delay. */
const MAX_BACKOFF_EXPONENT = 6;

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Full jitter (as opposed to a fixed or purely-exponential backoff): a
 * uniform random delay between 0 and `baseDelayMs * 2^attemptNumber`
 * (capped). This is what staggers a burst of simultaneous retrants instead
 * of letting them tight-loop in lockstep, re-colliding on every retry
 * (design doc §3.5).
 */
export function jitteredDelayMs(attemptNumber: number, baseDelayMs: number, random: () => number): number {
  const exponent = Math.min(attemptNumber, MAX_BACKOFF_EXPONENT);
  const window = baseDelayMs * 2 ** exponent;
  return Math.floor(random() * window);
}

/**
 * Runs `attempt` once, optimistically — no fetch beforehand. On a
 * `PublishRejectedError`, does a scoped single-ref fetch (coalesced via
 * `fetchRef`), waits a jittered backoff, and retries with the newly-learned
 * generation — up to `maxAttempts`. Any other error `attempt` throws aborts
 * immediately, uncaught. Exceeding `maxAttempts` rethrows the last
 * `PublishRejectedError`.
 */
export async function publishWithRetry<T>(opts: PublishRetryOptions<T>): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const random = opts.random ?? Math.random;
  const delay = opts.delay ?? defaultDelay;

  let sinceGeneration = await opts.currentGeneration();
  for (let attemptNumber = 1; ; attemptNumber++) {
    try {
      return await opts.attempt();
    } catch (error) {
      if (!(error instanceof PublishRejectedError) || attemptNumber >= maxAttempts) {
        throw error;
      }
      sinceGeneration = await opts.fetchRef(sinceGeneration);
      await delay(jitteredDelayMs(attemptNumber, baseDelayMs, random));
    }
  }
}

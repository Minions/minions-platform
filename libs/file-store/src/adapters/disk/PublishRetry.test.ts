/**
 * Unit coverage for `publishWithRetry` — the design doc §3 fetch-strategy
 * primitive (optimistic first attempt, scoped fetch on rejection, jittered
 * backoff). Generation-coalescing itself is `GitCoordinationState`'s job and
 * is covered in `GitOperations.test.ts`; the tests here also verify real
 * integration against that class, not just against a fake `fetchRef`.
 */

import { describe, it, expect, vi } from "vitest";
import { publishWithRetry, PublishRejectedError, jitteredDelayMs } from "./PublishRetry.js";
import { GitCoordinationState } from "./GitOperations.js";

/** No-op delay for tests that don't care about backoff timing. */
const noDelay = async () => {
  // Intentionally empty — tests injecting this don't care about backoff timing.
};

describe("publishWithRetry", () => {
  it("calls attempt exactly once, with no fetch at all, when the first attempt succeeds", async () => {
    let attempts = 0;
    let fetches = 0;
    const result = await publishWithRetry({
      attempt: async () => {
        attempts++;
        return "landed";
      },
      fetchRef: async (sinceGeneration) => {
        fetches++;
        return sinceGeneration + 1;
      },
      currentGeneration: () => 0,
      delay: noDelay,
    });

    expect(result).toBe("landed");
    expect(attempts).toBe(1);
    expect(fetches).toBe(0);
  });

  it("fetches and retries after a rejection, succeeding on the next attempt", async () => {
    let attempts = 0;
    let fetches = 0;
    const seenGenerations: number[] = [];
    const result = await publishWithRetry({
      attempt: async () => {
        attempts++;
        if (attempts === 1) throw new PublishRejectedError();
        return "landed";
      },
      fetchRef: async (sinceGeneration) => {
        fetches++;
        seenGenerations.push(sinceGeneration);
        return sinceGeneration + 1;
      },
      currentGeneration: () => 0,
      delay: noDelay,
    });

    expect(result).toBe("landed");
    expect(attempts).toBe(2);
    expect(fetches).toBe(1);
    expect(seenGenerations).toEqual([0]);
  });

  it("propagates a non-rejection error immediately, without fetching or retrying", async () => {
    let attempts = 0;
    let fetches = 0;

    await expect(
      publishWithRetry({
        attempt: async () => {
          attempts++;
          throw new Error("disk full");
        },
        fetchRef: async (sinceGeneration) => {
          fetches++;
          return sinceGeneration + 1;
        },
        currentGeneration: () => 0,
        delay: noDelay,
      }),
    ).rejects.toThrow("disk full");

    expect(attempts).toBe(1);
    expect(fetches).toBe(0);
  });

  it("gives up after maxAttempts, rethrowing the last rejection", async () => {
    let attempts = 0;

    await expect(
      publishWithRetry({
        attempt: async () => {
          attempts++;
          throw new PublishRejectedError(`attempt ${attempts} rejected`);
        },
        fetchRef: async (sinceGeneration) => sinceGeneration + 1,
        currentGeneration: () => 0,
        maxAttempts: 3,
        delay: noDelay,
      }),
    ).rejects.toThrow("attempt 3 rejected");

    expect(attempts).toBe(3);
  });

  it("threads the generation returned by fetchRef into the next fetchRef call", async () => {
    let attempts = 0;
    const seenGenerations: number[] = [];

    await publishWithRetry({
      attempt: async () => {
        attempts++;
        if (attempts <= 2) throw new PublishRejectedError();
        return "landed";
      },
      fetchRef: async (sinceGeneration) => {
        seenGenerations.push(sinceGeneration);
        return sinceGeneration + 5; // arbitrary jump, to prove it's threaded not recomputed
      },
      currentGeneration: () => 10,
      delay: noDelay,
    });

    expect(attempts).toBe(3);
    // First fetch asked for "newer than 10" (currentGeneration); second
    // asked for "newer than 15" (what the first fetch resolved to) — not
    // "newer than 10" again.
    expect(seenGenerations).toEqual([10, 15]);
  });

  it("reads currentGeneration only once, before the first attempt", async () => {
    let attempts = 0;
    let currentGenerationCalls = 0;

    await publishWithRetry({
      attempt: async () => {
        attempts++;
        if (attempts === 1) throw new PublishRejectedError();
        return "landed";
      },
      fetchRef: async (sinceGeneration) => sinceGeneration + 1,
      currentGeneration: () => {
        currentGenerationCalls++;
        return 0;
      },
      delay: noDelay,
    });

    expect(currentGenerationCalls).toBe(1);
  });

  it("waits a jittered delay (bounded by the backoff window) between a rejection and the next attempt", async () => {
    let attempts = 0;
    const delays: number[] = [];

    await publishWithRetry({
      attempt: async () => {
        attempts++;
        if (attempts === 1) throw new PublishRejectedError();
        return "landed";
      },
      fetchRef: async (sinceGeneration) => sinceGeneration + 1,
      currentGeneration: () => 0,
      baseDelayMs: 10,
      random: () => 0.5, // deterministic midpoint
      delay: async (ms) => {
        delays.push(ms);
      },
    });

    expect(delays).toHaveLength(1);
    // attemptNumber 1 -> window = 10 * 2^1 = 20 -> delay = floor(0.5 * 20) = 10
    expect(delays[0]).toBe(10);
  });

  it("a burst of concurrent retrants coalesces into few real fetches via GitCoordinationState", async () => {
    const coordination = new GitCoordinationState();
    let realFetches = 0;
    const doFetch = async () => {
      realFetches++;
    };

    // Every retrant starts optimistically (attempt 1 rejects for all of
    // them, simulating a lost race against the same winner), then all fall
    // into the fetch step at roughly the same time.
    const runOne = () =>
      publishWithRetry({
        attempt: (() => {
          let calls = 0;
          return async () => {
            calls++;
            if (calls === 1) throw new PublishRejectedError();
            return "landed";
          };
        })(),
        fetchRef: (sinceGeneration) =>
          coordination.fetchRefSinceGeneration("/fake/repo", "main", sinceGeneration, doFetch),
        currentGeneration: () => coordination.refGeneration("/fake/repo", "main"),
        delay: noDelay,
      });

    const results = await Promise.all([runOne(), runOne(), runOne(), runOne(), runOne()]);

    expect(results).toEqual(["landed", "landed", "landed", "landed", "landed"]);
    // Design doc §3.4: "a burst of N callers losing a race in the same
    // window produces at most one or two real fetches total, not N."
    expect(realFetches).toBeLessThanOrEqual(2);
  });
});

describe("jitteredDelayMs", () => {
  it("stays within [0, baseDelayMs * 2^attemptNumber) for random() in [0, 1)", () => {
    for (const attemptNumber of [1, 2, 3, 10]) {
      for (const r of [0, 0.25, 0.5, 0.75, 0.999]) {
        const window = 10 * 2 ** Math.min(attemptNumber, 6);
        const delay = jitteredDelayMs(attemptNumber, 10, () => r);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThan(window);
      }
    }
  });

  it("caps the exponential growth of the window past MAX_BACKOFF_EXPONENT (6)", () => {
    const windowAt6 = jitteredDelayMs(6, 10, () => 0.999);
    const windowAt100 = jitteredDelayMs(100, 10, () => 0.999);
    expect(windowAt100).toBeLessThanOrEqual(10 * 2 ** 6);
    expect(windowAt100).toBe(windowAt6); // same random(), same capped window
  });

  it("is deterministic given a fixed random source", () => {
    const spy = vi.fn(() => 0.3);
    const a = jitteredDelayMs(2, 100, spy);
    const b = jitteredDelayMs(2, 100, spy);
    expect(a).toBe(b);
  });
});

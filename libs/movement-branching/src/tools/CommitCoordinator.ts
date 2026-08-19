/**
 * One in-flight `commit()` per worktree, across every `GitCommit` instance —
 * a fresh `GitCommit` (and `MovementSession`) is constructed per MCP call
 * (see `MovementActionGroup.commitAction`), so this state can't live on
 * either of those instances. Keyed by `Worktree.path` (a stable absolute
 * filesystem path shared by every wrapper object resolved for the same
 * wing+repo).
 *
 * Why this exists: `movement commit`'s check pipeline can legitimately take
 * tens of seconds, which is close enough to a client-side MCP timeout that a
 * timed-out-but-still-running commit is a real, observed failure mode. A
 * caller that retries after a timeout must NOT start a second, fully
 * independent commit attempt against the same worktree — it should get the
 * result of whichever attempt is already running. Two callers with
 * genuinely different, simultaneous changes to commit for the same worktree
 * is not a real scenario (there is exactly one working tree; only one
 * logical "commit what's here now" can be in flight at a time) — the second
 * caller's own distinct changes, if any, are picked up by ITS OWN later
 * commit call once this one finishes, not lost.
 *
 * Deliberately a real object, not module-scope state — a long-lived host
 * process (the cabinet) constructs and owns exactly one instance as a
 * first-class part of its own object graph (see `defaultCommitCoordinator`
 * for the fallback every other caller — tests, scripts — implicitly shares).
 */
export class CommitCoordinator {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  /**
   * Runs `run()` for `key`, unless a call for the same `key` is already in
   * flight — in which case this returns THAT call's result instead of
   * starting a second one. Once `run()` settles (success or failure), `key`
   * is cleared, so the next call for it runs fresh.
   */
  async coalesce<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = run().finally(() => {
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }
}

/**
 * Process-wide default, used by every `GitCommit`/`MovementSession` that
 * isn't explicitly handed a `CommitCoordinator` — see that class's doc for
 * why a host process (the cabinet) would want to construct and thread
 * through its own instance instead.
 */
export const defaultCommitCoordinator = new CommitCoordinator();

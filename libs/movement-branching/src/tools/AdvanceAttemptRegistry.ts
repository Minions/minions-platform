import type { AdvanceAttempt } from '@minions/file-store';

/**
 * One in-flight `DerivedTrunk.beginAdvance()`/`AdvanceAttempt` session per
 * worktree, across every `MovementManager.promote()` call — a fresh
 * `MovementManager` (and `MovementSession`) is constructed per MCP call (see
 * `MovementActionGroup.promoteAction`), so an `AdvanceAttempt` object itself
 * can't live on either of those instances. `beginAdvance()`'s own doc
 * comment (design doc §4.4) frames `AdvanceAttempt` as "a resolution session
 * ... that a client drives to completion" — the "client" here is effectively
 * this long-lived host process (the cabinet), which is what makes an
 * in-memory, process-wide registry the right shape: the SAME `AdvanceAttempt`
 * object is resumed across `continueResolving()`/`publish()` calls spanning
 * multiple separate MCP round trips, exactly as the design intends, with no
 * need for worktree-scoped git-config bookkeeping to reconstruct equivalent
 * state.
 *
 * Keyed by `Worktree.path` (a stable absolute filesystem path shared by
 * every wrapper object resolved for the same wing+repo) — mirrors
 * `CommitCoordinator`'s own keying and its doc comment's rationale for why
 * this can't be per-instance state.
 *
 * Deliberately a real object, not module-scope state — a long-lived host
 * process (the cabinet) constructs and owns exactly one instance as a
 * first-class part of its own object graph (see `defaultAdvanceAttemptRegistry`
 * for the fallback every other caller — tests, scripts — implicitly shares).
 */
export class AdvanceAttemptRegistry {
  private readonly attempts = new Map<string, AdvanceAttempt>();

  /** The open `AdvanceAttempt` for `worktreePath`, if `promote()` left one unresolved on a previous call. */
  get(worktreePath: string): AdvanceAttempt | undefined {
    return this.attempts.get(worktreePath);
  }

  /** Records (or replaces) the open `AdvanceAttempt` for `worktreePath` — called whenever a `promote()` call ends with `status === "conflict"`. */
  set(worktreePath: string, attempt: AdvanceAttempt): void {
    this.attempts.set(worktreePath, attempt);
  }

  /** Clears the open `AdvanceAttempt` for `worktreePath` — called once it reaches a terminal state (`publish()` succeeding, or via the caller's own `abandon()`). */
  delete(worktreePath: string): void {
    this.attempts.delete(worktreePath);
  }
}

/**
 * Process-wide default, used by every `MovementManager`/`MovementSession`
 * that isn't explicitly handed an `AdvanceAttemptRegistry` — see that
 * class's doc for why a host process (the cabinet) would want to construct
 * and thread through its own instance instead.
 */
export const defaultAdvanceAttemptRegistry = new AdvanceAttemptRegistry();

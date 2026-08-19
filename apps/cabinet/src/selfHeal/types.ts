import type { Sandbox } from '@minions/file-store';

/**
 * A self-heal: checks whether some condition already holds across the lair's
 * actual state, and — only if it doesn't — makes it hold. No separate ledger
 * of "have I run this before" is kept; the lair's own data is the record.
 * This deliberately avoids adding new coordination state to a lair (which
 * would itself be git-tracked, cross-machine, and subject to exactly the
 * kind of divergence/rebase problems the plan-store TOML format is designed
 * to avoid) in favor of checking ground truth every time.
 *
 * Requirements for a well-behaved self-heal:
 * - `check` must be cheap enough to run unconditionally at every cabinet
 *   startup (a self-heal with an expensive check should gate itself on a
 *   lower-frequency trigger instead of always running here).
 * - `heal` must be idempotent: running it again on already-healed state
 *   (e.g. a heal that failed partway through last time) must be harmless.
 *   The cleanest way to guarantee this is for `heal`'s own output to be
 *   exactly what `check` looks for — no separate signal needed.
 * - A self-heal has no way to represent a one-time *external* side effect
 *   (e.g. "send this webhook exactly once") — it only ever reconciles state
 *   that actually lives in the lair. That's a real boundary of this
 *   mechanism, not a bug; anything needing that shape needs something else.
 */
export interface SelfHeal {
  /** Stable identifier, used only in logs. */
  id: string;
  /** One-line human-readable description of what this keeps true. */
  description: string;
  /** Returns true when the condition already holds — nothing to do. */
  check(lair: Sandbox): Promise<boolean>;
  /** Makes the condition true. Only ever called when check() returned false. */
  heal(lair: Sandbox): Promise<void>;
}

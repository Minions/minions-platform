import type { BareRepository } from '@minions/file-store';

/**
 * Fetches origin, then fast-forwards `trunk`'s LOCAL ref to `origin/<trunk>`
 * — always safe under design doc §2 invariant A, since it only ever moves
 * `trunk` toward already-durable state, never away from it. This is exactly
 * the operation `Mirror.apply()` already performs internally, reactively, on
 * a lost publish race (see `DiskMirror.ts`'s `apply()`) — this just exposes
 * it as something a caller can trigger explicitly instead of only
 * reactively.
 *
 * Deliberately does NOT touch any mirror worktree directly: a mirror is
 * always fresh at construction (`LairRepoPerspective.resolve()` builds a
 * brand-new `Mirror` on every plan/movement action call, and
 * `Mirror.files`'s first access fast-forwards the mirror worktree to
 * whatever the LOCAL trunk ref currently is) — so the only thing worth
 * refreshing explicitly is the local trunk ref itself. Once that's done, the
 * very next `resolve()`/mirror access anywhere picks up the new content on
 * its own, with no separate mirror-touch step needed.
 *
 * Best-effort, not an error, for a trunk that has no `origin/<trunk>` yet (a
 * brand new repo with nothing pushed).
 */
export async function refreshTrunkFromOrigin(bareRepo: BareRepository, trunk: string): Promise<void> {
  try {
    await bareRepo.fetch();
  } catch { /* best-effort — a failed fetch shouldn't block the fast-forward attempt below */ }
  try {
    await bareRepo.updateBranch(trunk, `origin/${trunk}`);
  } catch { /* origin/<trunk> doesn't exist yet — nothing to fast-forward to */ }
}

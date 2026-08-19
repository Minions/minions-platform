/**
 * Detects a git rebase/merge/cherry-pick/revert in progress in `cwd`, so a
 * caller can skip work that would otherwise run against a transiently
 * invalid working tree (mid-rebase, files can contain unresolved conflict
 * markers — a guaranteed-wasted oxlint/lint run, not a real signal) at
 * exactly the moment git itself is busiest writing to the repo (see
 * GitOperations.ts in @minions/file-store for the write-contention this
 * adds to).
 *
 * Resolves the worktree's own gitdir directly from its `.git` file (a
 * linked worktree's rebase/merge state lives under
 * `<bare>.git/worktrees/<name>/`, not shared with other worktrees) rather
 * than shelling out to git — this is meant to be checked on every
 * debounced file-change event, so it needs to be cheap and never itself
 * spawn a process.
 */

import { promises as fs } from 'node:fs';
import { join, isAbsolute } from 'node:path';

const IN_PROGRESS_MARKERS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'];

async function resolveGitDir(cwd: string): Promise<string> {
  try {
    const content = await fs.readFile(join(cwd, '.git'), 'utf-8');
    const match = content.match(/^gitdir:\s*(.+)$/m);
    if (match) {
      const dir = match[1].trim();
      return isAbsolute(dir) ? dir : join(cwd, dir);
    }
  } catch {
    // Not a linked worktree (or no .git at all) — fall through to the
    // plain-repo default below.
  }
  return join(cwd, '.git');
}

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export async function isGitOperationInProgress(cwd: string): Promise<boolean> {
  const gitDir = await resolveGitDir(cwd);
  for (const marker of IN_PROGRESS_MARKERS) {
    if (await exists(join(gitDir, marker))) return true;
  }
  return false;
}

/**
 * Written by git's rebase sequencer (merge backend — the only backend this
 * codebase's `GitOperations.rebase()` drives) into `rebase-merge/`
 * specifically, and only, when a step has genuinely HALTED (a real conflict,
 * or an empty-patch confirmation) — never present while it's still
 * cherry-picking commits through automatically. Confirmed empirically
 * against real git: absent throughout a clean multi-commit rebase; present
 * (with the halted commit's sha as its content) the instant a step halts;
 * rewritten to a NEW value — not left stale — the moment a resolved `git
 * rebase --continue` halts again at a later commit; removed along with the
 * rest of `rebase-merge/` the instant the whole rebase finishes. This makes
 * it a precise, non-heuristic signal for "genuinely stopped and waiting,"
 * as opposed to a timing-based guess (e.g. "no writes for N seconds") that
 * would either misfire on an ordinary inter-commit gap under load (falsely
 * reporting "stable" mid-churn) or require a window wide enough to risk
 * matching a real per-commit cadence — see `getGitOperationStatus`'s use of
 * this.
 */
const REBASE_MERGE_STOP_MARKER = 'stopped-sha';

/**
 * Richer version of {@link isGitOperationInProgress} for a caller that needs
 * to tell "git is actively churning through commits automatically right
 * now" apart from "an operation is still in progress but has genuinely
 * halted" (a real conflict, or the rarer empty-patch confirmation — waiting
 * on a human/agent either way) — see `QualityWatcher.pollGitOperationState`'s
 * doc comment for why that distinction matters: pausing reactive watch-mode
 * tooling for git's own write bursts is the point, but it must resume the
 * moment a rebase settles into a real halt, even though the `rebase-merge`
 * marker itself is still present, so an agent fixing conflicted files gets a
 * real quality read back — and must NOT resume-then-immediately-repause on
 * every ordinary inter-commit gap, which a full multi-commit rebase can have
 * many of.
 *
 * `stable` is `true` whenever nothing is in progress at all, or whenever
 * every in-progress marker present represents an already-atomic, already-
 * halted state the moment it exists: for `MERGE_HEAD`/`CHERRY_PICK_HEAD`/
 * `REVERT_HEAD`/`rebase-apply`, this codebase never drives an automatic
 * multi-step sequence through them (a plain `git merge --no-ff` conflict is
 * already the terminal halted state the instant `MERGE_HEAD` appears; this
 * codebase's own cherry-pick loop — `DiskMovementImpl.cherryPick` — issues
 * one `git merge` per commit itself rather than a multi-commit `git
 * cherry-pick <range>`, so `CHERRY_PICK_HEAD`/`REVERT_HEAD` are kept only as
 * a defensive backstop for git operations run outside this codebase's own
 * git-operation wrappers), so bare presence already means "stopped, waiting
 * on a human." Only `rebase-merge` needs the extra check, since it alone
 * represents a sequence this codebase drives straight through multiple
 * commits automatically when nothing conflicts.
 */
export async function getGitOperationStatus(cwd: string): Promise<{ inProgress: boolean; stable: boolean }> {
  const gitDir = await resolveGitDir(cwd);
  let inProgress = false;
  let stable = true;
  for (const marker of IN_PROGRESS_MARKERS) {
    const markerPath = join(gitDir, marker);
    if (!(await exists(markerPath))) continue;
    inProgress = true;
    if (marker === 'rebase-merge' && !(await exists(join(markerPath, REBASE_MERGE_STOP_MARKER)))) {
      stable = false;
    }
  }
  return { inProgress, stable };
}

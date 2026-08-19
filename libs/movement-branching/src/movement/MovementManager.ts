import { asGitRef, resolveMovementBase } from '@minions/file-store';
import type { Worktree, WorkArea, CheckedOutMovement, Trunk, DerivedTrunk, AdvanceAttempt } from '@minions/file-store';
import { AdvanceAttemptRegistry, defaultAdvanceAttemptRegistry } from '../tools/AdvanceAttemptRegistry.js';

/**
 * Unified commit type for both step commits and merge commits.
 * Accepts either the long form (feature, bug) or the CC short form (feat, fix).
 */
export type CommitType =
  | 'feature' | 'feat'
  | 'bug' | 'fix'
  | 'refactor'
  | 'test'
  | 'docs'
  | 'chore'
  | 'plan';

/**
 * Maps any CommitType value to its Conventional Commits short form.
 */
export const TO_CC_SHORT: Record<CommitType, string> = {
  feature: 'feat',
  feat: 'feat',
  bug: 'fix',
  fix: 'fix',
  refactor: 'refactor',
  test: 'test',
  docs: 'docs',
  chore: 'chore',
  plan: 'chore',
};

/**
 * Options for merging a movement
 */
export interface MergeMovementOptions {
  /** Commit type — long or short form */
  type: CommitType;
  /** One-line summary of the movement */
  summary: string;
  /** Detailed description of what was done */
  description: string;
  /** Optional co-authored-by trailer */
  coAuthoredBy?: string;
}

/**
 * Result of starting a movement
 */
export interface StartResult {
  /** Whether the start was successful */
  success: boolean;
  /** Whether the branch was updated (rebased onto origin/main) */
  wasUpdated: boolean;
  /** Whether there are uncommitted changes */
  isDirty: boolean;
  /** Error message if start failed */
  error?: string;
}

/**
 * Options for starting a movement
 */
export interface StartMovementOptions {
  // Branch to start on. Must start with "wip/", "probably-wrong/", or "l/<any>/w/<wing>-sub/".
  // Checked out if it exists, or created at current HEAD if it does not.
  branch?: string;
  // Wing name — used to validate the l/<any>/w/<wing>-sub/ pattern.
  wingName?: string;
}

/**
 * Result of a merge operation
 */
export interface MergeResult {
  /** Whether the merge was successful */
  success: boolean;
  /** Error message if merge failed */
  error?: string;
  /**
   * True when git is left in a mid-rebase state due to conflicts.
   * Recovery: resolve conflicts in the listed files, then run
   * `git add <files>` and `git rebase --continue`, then call merge again.
   */
  needsRebase?: boolean;
}

/**
 * Result of a promote() call — folding an experiment trunk into `main`.
 */
export interface PromoteResult {
  /** Whether this call finished the promotion (main was fast-forwarded and pushed) */
  success: boolean;
  /**
   * The trunk branch that was (or is being) promoted, e.g.
   * `experiment/faster-cache/redis` — read from the worktree's base-branch
   * override at the start of the call, before anything else changes. Present
   * on both success and a conflict return, absent only on an unrelated error
   * (e.g. push failure) where promotion never really started.
   */
  trunk?: string;
  /**
   * True when conflicting files are waiting in the worktree for the caller
   * to fix. See `error` for the exact (deliberately git-mechanics-free)
   * instructions — call `promote` again once the files are correct.
   */
  needsResolution?: boolean;
  /** Error / instructions message. Present whenever success is false. */
  error?: string;
}

/**
 * This type exists only because `libs/planner/src/PlanActionGroup.ts`'s
 * `shouldTriggerFullSyncAfterAbsorb` still types against it — that function
 * itself has no remaining production caller. Neither `absorbPlanBranch` nor
 * `MovementSession.absorbPlan` (the functions that would have produced this
 * shape) exist anymore, so this interface is now only load-bearing for that
 * one type signature.
 */
export interface AbsorbPlanResult {
  success: boolean;
  /** Number of commits absorbed from plan/main; 0 means already in sync */
  absorbed?: number;
  /** Error message if absorption failed */
  error?: string;
  /** True when git is left in a mid-rebase state due to conflicts */
  needsRebase?: boolean;
}

/**
 * Bound on how many times `mergeMovement`/`promote` will
 * re-rebase and retry publishing after losing a compare-and-swap race on a
 * shared branch (`main`, a trunk) to a concurrent
 * call from another wing. Real contention resolves in one or two attempts;
 * this is a backstop against a pathological storm, not a normal path.
 */
const MAX_PUBLISH_ATTEMPTS = 20;

/**
 * Movement branch name patterns
 */
const MOVEMENT_BRANCH_PATTERNS = [
  /^movement\//,
  /^l\/[^/]+\/w\//,
  /^wip\//,
];

// Returns true when branch is an allowed wip branch for movement start.
// Allowed prefixes: wip/, probably-wrong/, l/<any>/w/<wingName>-sub/
function isAllowedWipBranch(branch: string, wingName?: string): boolean {
  if (branch.startsWith('wip/')) return true;
  if (branch.startsWith('probably-wrong/')) return true;
  if (wingName) {
    const escaped = wingName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^l/[^/]+/w/${escaped}-sub/`).test(branch);
  }
  return false;
}

/**
 * Builds the "call this exact tool again" clause used in every
 * rebase-conflict message (see `MovementManager.rebaseConflictMessage`) —
 * generated from the calling tool's own name/action, not hand-typed prose at
 * each call site, so the two can never drift out of sync, and so the caller
 * is always pointed at the ONE specific tool call that will actually resume
 * things, never a generic "retry the action that failed" that lists several
 * possibilities. `action` is omitted for tools invoked bare (e.g. `promote`,
 * with no sub-action). Exported standalone (not a method) so callers outside
 * this lib — every plan action, the experiments/conductor mirror — can build
 * the exact same phrasing for whatever retry instruction they need to surface.
 */
export function retryInstructionFor(tool: string, action?: string): string {
  return action ? `call ${tool} ${action} again` : `call ${tool} again`;
}

/**
 * Manages movement-based git workflow.
 *
 * A movement is a merge to main representing a goal shift. The MovementManager
 * handles the merge workflow including:
 * - Verifying we're on a movement branch
 * - Creating merge commits with custom messages (--no-ff is used by default)
 * - Fast-forwarding the movement branch after merge using resetTo
 */
export class MovementManager {
  constructor(
    private readonly worktree: Worktree,
    /**
     * The design doc §4.2 `WorkArea` for `worktree` — required by
     * `startMovement`/`mergeMovement`/`promote`, which delegate to
     * `WorkArea.activeMovement()`/`beginNewActiveMovement()` +
     * `CheckedOutMovement.start()`/`Movement.merge()`/`DerivedTrunk
     * .beginAdvance()` (design doc §4.3/§4.4) instead of hand-rolling
     * rebase/CAS/retry against the raw `Worktree`. Optional here — only
     * those methods need it — but each throws a clear error if it's missing
     * rather than silently falling back to a second, parallel
     * implementation.
     */
    private readonly workArea?: WorkArea,
    /**
     * See `AdvanceAttemptRegistry`'s own doc comment for why `promote()`
     * needs a process-wide, in-memory registry (not per-instance state) to
     * resume an open `AdvanceAttempt` across separate MCP calls. Defaults to
     * the package-wide singleton — pass an explicit instance only if a host
     * process wants its own (mirrors `CommitCoordinator`'s identical
     * optional-with-a-default-singleton shape).
     */
    private readonly advanceAttemptRegistry: AdvanceAttemptRegistry = defaultAdvanceAttemptRegistry,
  ) {}

  private requireWorkArea(caller: string): WorkArea {
    if (!this.workArea) {
      throw new Error(
        `MovementManager.${caller}() requires a WorkArea — construct with new MovementManager(worktree, workArea).`,
      );
    }
    return this.workArea;
  }

  /**
   * Resolves the worktree's current branch name — via `WorkArea.activeMovement()`
   * (design doc §4.1: `Movement.branch`) when a `WorkArea` was supplied to this
   * instance, falling back to the raw `Worktree.currentBranch()` only when it
   * wasn't — same optional-`workArea` fallback shape `GitCommit`/`GitStatus`
   * already use. `activeMovement()` resolves for ANY currently-checked-out
   * branch, not just movement-shaped ones (see `SiteWorkArea.activeMovement()`),
   * so this is a safe substitution for a plain branch-name read regardless of
   * what pattern the branch does or doesn't match.
   */
  private async currentBranchName(): Promise<string> {
    if (this.workArea) {
      return (await this.workArea.activeMovement()).branch;
    }
    return this.worktree.currentBranch();
  }

  /**
   * Check if currently on a movement branch
   */
  async isOnMovementBranch(): Promise<boolean> {
    const branch = await this.currentBranchName();
    return MOVEMENT_BRANCH_PATTERNS.some((pattern) => pattern.test(branch));
  }

  /**
   * Get the current movement branch name
   */
  async getMovementBranchName(): Promise<string | null> {
    const branch = await this.currentBranchName();
    if (MOVEMENT_BRANCH_PATTERNS.some((pattern) => pattern.test(branch))) {
      return branch;
    }
    return null;
  }

  /**
   * Builds the rebase-conflict message shared by every method that puts the
   * worktree through a rebase (startMovement, mergeMovement, promote).
   *
   * Two genuinely different shapes, deliberately worded differently:
   *
   * - **Real conflict** (`conflictedFiles` non-empty): deliberately
   *   git-mechanics-free — never names the underlying git mechanism
   *   (rebase, git add, git rebase --continue). See `promote`'s doc comment:
   *   naming it invites a shortcut (abort + plain merge, a squash commit)
   *   that would destroy incremental history. The caller is told only which
   *   files need fixing and what to call again; the next call detects the
   *   in-progress rebase itself (the `resuming` check at the top of each of
   *   these methods) and continues it rather than starting over. The file
   *   list is already fully actionable on its own, so no raw git output is
   *   appended here — doing so would reintroduce exactly the "just run this
   *   git command" temptation this wording exists to avoid.
   * - **No conflicted files to fix** (`pushThroughEmptyHalt` already ruled
   *   out every automatic recovery it knows — see its own doc comment):
   *   there is nothing for a file edit to accomplish, so telling the caller
   *   to "edit files, remove conflict markers" here would be actively wrong
   *   advice, not just unhelpful — confirmed live as a production incident
   *   where exactly this generic wording sent an agent looking for conflict
   *   markers that didn't exist. This case instead surfaces
   *   `rebaseResult.message` in full — everything git actually reported —
   *   since that's the one thing that can make the real cause investigable.
   */
  private rebaseConflictMessage(
    rebaseResult: { conflictedFiles: string[]; message?: string },
    retryInstruction: string,
  ): string {
    if (rebaseResult.conflictedFiles.length > 0) {
      return `These files have conflicts and need your attention: ${rebaseResult.conflictedFiles.join(', ')}. ` +
        `Edit them so their contents are correct — remove any conflict markers — then ` +
        `${retryInstruction}. Do not run any git commands and do not commit anything; just fix ` +
        `the files and try again.`;
    }
    const detail = rebaseResult.message ? ` Everything git reported: ${rebaseResult.message}` : '';
    return `The rebase could not complete automatically and there are no conflicted files to edit — ` +
      `this needs investigation, not a file edit.${detail} Once the underlying issue is addressed, ` +
      `${retryInstruction}; if it keeps recurring, escalate to a human instead of retrying repeatedly.`;
  }

  /**
   * Start a movement by ensuring the branch is at or ahead of its base trunk.
   *
   * Design doc §4.3/§4.2: instead of hand-rolling fetch/compare/rebase
   * against the raw `Worktree`, this resolves (or creates) a
   * `CheckedOutMovement` via `WorkArea.activeMovement()`/
   * `beginNewActiveMovement()` and delegates the actual "fetch base, rebase
   * onto its latest, autostash" work to `CheckedOutMovement.start()`, which
   * already implements this safely (scoped single-ref fetch, design doc §3).
   *
   * Workflow:
   * 1. If options.branch is given, validate it and switch/create it (via
   *    `beginNewActiveMovement`, inheriting the CURRENT movement's base —
   *    the worktree's persisted base override is never touched)
   * 2. Otherwise verify we're already on a movement branch
   * 3. Delegate to `CheckedOutMovement.start()` on a fresh call. On resume,
   *    HEAD is detached mid-rebase — `currentBranch()` reports empty, which
   *    `WorkArea.activeMovement()` can't resolve into a `CheckedOutMovement`
   *    at all — so resuming drives `Worktree.continueRebase()` directly
   *    instead, and only re-resolves a `CheckedOutMovement` once HEAD is
   *    guaranteed back on a real branch.
   * 4. Return status, computed from whether the branch's tip actually moved
   */
  async startMovement(options: StartMovementOptions = {}): Promise<StartResult> {
    const workArea = this.requireWorkArea('startMovement');
    const { branch: targetBranch, wingName } = options;

    // If a previous call left a conflict for the agent to fix, finish that
    // rebase first — git won't let us switch branches or fetch mid-rebase
    // anyway, so this takes priority over every other option. On resume we
    // already know which branch we settled on and that there was something
    // to do, so none of the fresh-start branch-switch/verify steps below
    // apply — same shape as absorbPlanBranch's own `!resuming` gate.
    const resuming = await this.worktree.hasInProgressRebase();

    // While resuming, HEAD is detached mid-rebase — `currentBranch()` returns
    // empty in that state, which `WorkArea.activeMovement()` can't resolve
    // into a `CheckedOutMovement` at all (there's no branch name to build
    // one for). So the resume path below is handled entirely separately,
    // driving the raw `Worktree.continueRebase()` directly instead of going
    // through a `Movement` handle for the resume step itself —
    // `WorkArea.activeMovement()` is only called once HEAD is guaranteed
    // back on a real branch (i.e. after the rebase settles).
    if (resuming) {
      try {
        // Shares settleRebaseAttempt with mergeMovement — see that method's
        // own doc comment: this used to skip the unexplained-halt recovery
        // entirely, so a stale, orphaned rebase session (see
        // recoverFromUnexplainedHalt) hit while resuming a `movement start`
        // reported the same unresolvable "conflict" on every retry forever.
        const settledAttempt = await this.settleRebaseAttempt(
          workArea,
          await this.worktree.continueRebase(),
          undefined,
        );
        const rebaseResult = settledAttempt.rebaseResult;
        if (rebaseResult.status === 'conflict') {
          const isDirty = await this.worktree.isDirty();
          return {
            success: false,
            wasUpdated: false,
            isDirty,
            error: this.rebaseConflictMessage(rebaseResult, retryInstructionFor('movement', 'start')),
          };
        }

        // On resume, there's necessarily something that just got finished
        // (that's what "resuming" means), so `wasUpdated: true` is reported
        // unconditionally for this path — there's no meaningful pre-resume
        // tip to diff against.
        const settled = settledAttempt.movement ?? await workArea.activeMovement();
        try {
          await settled.push();
        } catch {
          // Best-effort: push may fail if no remote — continue for local-only workflows
        }

        const isDirty = await settled.isDirty();
        return { success: true, wasUpdated: true, isDirty };
      } catch (error) {
        const isDirty = await this.worktree.isDirty();
        return {
          success: false,
          wasUpdated: false,
          isDirty,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }

    let movement: CheckedOutMovement;
    if (targetBranch !== undefined) {
      if (!isAllowedWipBranch(targetBranch, wingName)) {
        const isDirty = await this.worktree.isDirty();
        const subPattern = wingName ? `l/<any>/w/${wingName}-sub/` : 'l/<any>/w/<wing>-sub/';
        return {
          success: false,
          wasUpdated: false,
          isDirty,
          error: `Branch "${targetBranch}" is not an allowed wip branch. ` +
            `Must start with "wip/", "probably-wrong/", or "${subPattern}".`,
        };
      }
      try {
        // A brand-new branch is created at the worktree's CURRENT
        // HEAD (not the base trunk's tip) and inherits whatever base was
        // already configured for this worktree — never a hardcoded trunk.
        const current = await workArea.activeMovement();
        const headSha = await current.tipHash();
        movement = await workArea.beginNewActiveMovement(targetBranch, {
          base: current.base,
          ...(headSha !== null ? { from: asGitRef(headSha) } : {}),
        });
      } catch (switchError) {
        const isDirty = await this.worktree.isDirty();
        return {
          success: false,
          wasUpdated: false,
          isDirty,
          error: `Failed to switch to branch "${targetBranch}": ${switchError instanceof Error ? switchError.message : String(switchError)}`,
        };
      }
    } else {
      // Resolve the movement handle first (works for ANY currently-checked-out
      // branch, movement-shaped or not — see `SiteWorkArea.activeMovement()`),
      // then pattern-check `.branch` — avoids a separate raw
      // `worktree.currentBranch()` read just to decide whether to proceed.
      const candidate = await workArea.activeMovement();
      const isMovementBranch = MOVEMENT_BRANCH_PATTERNS.some((pattern) => pattern.test(candidate.branch));
      if (!isMovementBranch) {
        const isDirty = await candidate.isDirty();
        return {
          success: false,
          wasUpdated: false,
          isDirty,
          error: `Not on a movement branch (current: "${candidate.branch}"). Switch to a movement/* or l/*/w/* branch first.`,
        };
      }
      movement = candidate;
    }

    try {
      const tipBefore = await movement.tipHash();

      // Shares settleRebaseAttempt with mergeMovement/startMovement's own
      // resume branch — `movement.start()` rebases via `worktree.rebase()`
      // internally, which can land in the same "stale, orphaned rebase
      // session" shape (status 'conflict', no conflicted files) on its very
      // first attempt, not just on a later resume.
      const settled = await this.settleRebaseAttempt(workArea, await movement.start(), movement);
      const rebaseResult = settled.rebaseResult;
      movement = settled.movement ?? movement;

      if (rebaseResult.status === 'conflict') {
        const isDirty = await movement.isDirty();
        return {
          success: false,
          wasUpdated: false,
          isDirty,
          error: this.rebaseConflictMessage(rebaseResult, retryInstructionFor('movement', 'start')),
        };
      }

      const tipAfter = await movement.tipHash();
      const wasUpdated = tipBefore !== tipAfter;

      // Push the rebased branch to origin (rebase rewrites history) — best
      // effort, same as before. `CheckedOutMovement.push()` (design doc §4.3)
      // is a best-effort force-push of this single-writer movement branch —
      // not a CAS-guarded publish like `Trunk.merge()`/`Mirror.apply()`, since
      // invariant A doesn't apply to a per-wing branch the way it applies to
      // shared refs — kept as a convenience, not a correctness requirement.
      if (wasUpdated) {
        try {
          await movement.push();
        } catch {
          // Best-effort: push may fail if no remote — continue for local-only workflows
        }
      }

      const isDirty = await movement.isDirty();
      return { success: true, wasUpdated, isDirty };
    } catch (error) {
      const isDirty = await this.worktree.isDirty();
      return {
        success: false,
        wasUpdated: false,
        isDirty,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Merge the movement branch to its base trunk WITHOUT checking out the
   * trunk.
   *
   * Design doc §4.3: instead of hand-rolling the rebase/flatten/CAS/retry
   * sequence against the raw `Worktree`, this resolves the movement's
   * `CheckedOutMovement` via `WorkArea`, rebases it onto its base with
   * `CheckedOutMovement.start()` (same resumable-conflict contract as
   * `startMovement`, with real conflicted files an agent can fix in place),
   * then publishes with `Movement.merge()`, which already implements the
   * flatten-via-commit-tree + push-based CAS + fetch-and-retry loop safely
   * (design doc §2 invariants A/B, §3's fetch strategy).
   *
   * Workflow:
   * 1. Rebase the movement branch onto its base (`CheckedOutMovement.start()`)
   * 2. If that conflicts, fail and report — real files in the worktree, agent
   *    resolves and calls merge again (`Worktree.continueRebase()` directly
   *    on retry — see this method's own comment on why: HEAD is detached
   *    mid-rebase, and `WorkArea.activeMovement()` needs a real branch name)
   * 3. If the movement adds no commits, no-op success (no empty merge commit)
   * 4. `Movement.merge()`: build the flattened landing commit and CAS-publish
   *    it to the base trunk, retrying on lost races
   * 5. Best-effort: force-push the movement branch to keep origin's copy in
   *    sync (the trunk publish is the actual source of truth)
   */
  /**
   * Recovery step for an "unexplained" rebase halt: `status: 'conflict'`
   * with an EMPTY `conflictedFiles` list. `GitOperations
   * .pushThroughEmptyHalt` only ever returns that shape once it has already
   * ruled out a real conflict (non-empty `conflictedFiles`) AND its own two
   * known-safe automatic-retry patterns (an empty-patch halt, or a
   * confirmed Windows transient-write/lock error — see that method's own
   * doc comment) — so by the time this is called, nothing about the halt
   * itself can be fixed by editing files, and nothing about it is
   * self-resolving through more retries of the identical call.
   *
   * Confirmed live in production what this shape actually was: a STALE
   * `rebase-merge` session left behind by an earlier, unrelated
   * interruption (a crashed/restarted host process, a connection dropped
   * mid-operation) — its own bookkeeping (`onto`, `orig-head`, ...) no
   * longer describes a resolvable state, and no amount of retrying
   * `continueRebase()` against it will ever change that. A human unblocked
   * it manually with `git rebase --abort` followed by a fresh merge
   * attempt; this is that exact recovery, automated. Nothing is lost by it
   * — `abortRebase()` only resets the CURRENT rebase attempt, never the
   * movement branch's real commit history (see `Worktree.abortRebase()`'s
   * own doc) — so re-running `start()` just re-attempts the identical
   * logical operation from a clean slate.
   *
   * Tried exactly once per `mergeMovement()` call, never looped: if the
   * fresh attempt ALSO lands in this same "unexplained" bucket, staleness
   * is no longer a plausible explanation (a session this method itself just
   * created from scratch cannot already be orphaned) and it needs a human,
   * not another automatic retry.
   */
  private async recoverFromUnexplainedHalt(workArea: WorkArea): Promise<{
    rebaseResult: Awaited<ReturnType<CheckedOutMovement['start']>>;
    movement: CheckedOutMovement;
  }> {
    console.error(
      '[MovementManager] mergeMovement hit a rebase halt with no conflicted files to fix — ' +
        'treating it as a stale, orphaned rebase session and recovering via abort + fresh start.'
    );
    await this.worktree.abortRebase();
    const movement = await workArea.activeMovement();
    const rebaseResult = await movement.start();
    return { rebaseResult, movement };
  }

  /**
   * Shared rebase-attempt settling, used identically by startMovement's
   * resume path and mergeMovement (both its resume and fresh paths) — the
   * ONE place that decides whether a halt with no conflicted files gets the
   * `recoverFromUnexplainedHalt` treatment. Previously duplicated (and, on
   * startMovement's resume path, simply missing) — a resumed `movement
   * start` that hit this exact "stale, orphaned rebase session" shape had no
   * recovery at all and would report the same unresolvable "conflict" on
   * every retry forever, while `mergeMovement` already handled it correctly.
   * Unified on `mergeMovement`'s (better) behavior rather than duplicating
   * either copy.
   *
   * `currentMovement` is the `CheckedOutMovement` handle already known
   * (`mergeMovement`'s fresh path resolved one before rebasing it), or
   * `undefined` when none is available yet (every resume path: HEAD is
   * detached mid-rebase until the rebase actually settles, so there is
   * nothing a handle could be built from beforehand).
   */
  private async settleRebaseAttempt(
    workArea: WorkArea,
    rebaseResult: Awaited<ReturnType<CheckedOutMovement['start']>>,
    currentMovement: CheckedOutMovement | undefined,
  ): Promise<{
    rebaseResult: Awaited<ReturnType<CheckedOutMovement['start']>>;
    movement: CheckedOutMovement | undefined;
  }> {
    if (rebaseResult.status === 'conflict' && rebaseResult.conflictedFiles.length === 0) {
      const recovered = await this.recoverFromUnexplainedHalt(workArea);
      return { rebaseResult: recovered.rebaseResult, movement: recovered.movement };
    }
    return { rebaseResult, movement: currentMovement };
  }

  async mergeMovement(options: MergeMovementOptions): Promise<MergeResult> {
    const workArea = this.requireWorkArea('mergeMovement');

    // If a previous call left a conflict for the agent to fix, HEAD is
    // detached mid-rebase — `currentBranch()` (and so `getMovementBranchName()`)
    // returns empty in that state, so this precondition check only applies
    // on a fresh start, same as startMovement's own `!resuming` gate.
    const resuming = await this.worktree.hasInProgressRebase();
    if (!resuming) {
      const movementBranch = await this.getMovementBranchName();
      if (!movementBranch) {
        return {
          success: false,
          error: 'Not on a movement branch. Must be on a movement/* or l/*/w/* branch.',
        };
      }
    }

    try {
      // While resuming, HEAD is detached mid-rebase — `currentBranch()`
      // returns empty in that state, which `WorkArea.activeMovement()` can't
      // resolve into a `CheckedOutMovement` at all (there's no branch name
      // to build one for). So the resume step drives the raw `Worktree.
      // continueRebase()` directly instead — `WorkArea.activeMovement()` is
      // only resolved on a fresh (non-resuming) call, once here, and reused
      // below for both the dirty check and `start()` rather than
      // re-resolving it a second time.
      let rebaseResult: Awaited<ReturnType<CheckedOutMovement['start']>>;
      let settledMovement: CheckedOutMovement | undefined;
      if (resuming) {
        rebaseResult = await this.worktree.continueRebase();
      } else {
        const freshMovement = await workArea.activeMovement();

        // If a previous call left a conflict for the agent to fix, this
        // call's job is just to continue that rebase — never re-fetch or
        // re-rebase from scratch, and never require a clean tree (conflict
        // markers make isDirty() true).
        if (await freshMovement.isDirty()) {
          return {
            success: false,
            error: 'There are uncommitted changes. Commit or stash them before merging.',
          };
        }

        rebaseResult = await freshMovement.start();
        // Already the settled handle (`start()` rebased it in place, same
        // `Movement` identity — design doc §4.1: a movement's identity is
        // just `(branch, base)`, so there's nothing to re-resolve).
        settledMovement = freshMovement;
      }

      // No real conflict to fix (GitOperations.pushThroughEmptyHalt already
      // ruled that out, along with its own known-safe retry tiers, before
      // ever surfacing this) — see settleRebaseAttempt/recoverFromUnexplainedHalt's
      // own doc comments for why this shape means a stale, orphaned rebase
      // session, not something retrying the identical call again could ever
      // resolve.
      const settled = await this.settleRebaseAttempt(workArea, rebaseResult, settledMovement);
      rebaseResult = settled.rebaseResult;
      settledMovement = settled.movement;

      if (rebaseResult.status === 'conflict') {
        return {
          success: false,
          needsRebase: true,
          error: this.rebaseConflictMessage(rebaseResult, retryInstructionFor('movement', 'merge')),
        };
      }

      // On the resume path, HEAD only just landed back on a real branch, so
      // this is the first point a handle can be built at all.
      const movement = settledMovement ?? await workArea.activeMovement();
      const mergeMessage = this.buildMergeMessage(options);
      const mergeResult = await movement.merge({ message: mergeMessage });

      if (mergeResult.status === 'conflict') {
        // `Movement.merge()`'s own publish step runs in a disposable scratch
        // worktree (design doc §4.3), never the checked-out one — by the
        // time this returns there are no conflicted files left on disk for
        // an agent to fix. This only happens if the base trunk advanced
        // again in the narrow window between the rebase above and this
        // publish attempt; retrying re-runs `start()`'s rebase against the
        // trunk's new tip, in the REAL checked-out worktree, where a genuine
        // conflict (if any) is fixable the normal way.
        return {
          success: false,
          error: `"${movement.base.branch}" changed while merging — call movement merge again to retry.`,
        };
      }

      if (mergeResult.status === 'already-up-to-date') {
        return { success: true };
      }

      // Best-effort: keep origin's copy of the movement branch in sync — the
      // trunk publish above (already confirmed on origin) is the actual
      // source of truth; this is convenience, not correctness.
      try {
        await movement.push();
      } catch {
        // Force push may fail - continue anyway, the trunk was already published.
      }

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Folds this worktree's experiment trunk (its `Movement.base: Trunk`
   * override — see `resolveMovementBase`) into `mainTrunk`, with clean, unsquashed
   * history — `mainTrunk` ends up fast-forwarded to the (possibly replayed)
   * trunk tip, so its log reads as if every constituent movement had
   * targeted it directly, no synthetic merge commit.
   *
   * Design doc §4.4: this is now a thin delegation onto
   * `DerivedTrunk.advance()`/`beginAdvance()`/`AdvanceAttempt` — the
   * "experiment folding into main" case §4.4/§5's cut list always said this
   * was, not a separate bespoke implementation. `advance()`'s conflict-free
   * fast path handles the common case with no checkout at all; on a real
   * content conflict, `beginAdvance(resolveIn)` borrows THIS worktree
   * (`workArea.activeMovement()`) — the same worktree `mergeMovement`'s own
   * conflicts already land real files in — so a rebase conflict here is
   * exactly the same "fix files in place, call promote again" UX callers
   * already know, not a new location or contract. Once the conflict is
   * resolved, the fold onto `mainTrunk` is `Trunk.fastForwardPublish()`,
   * retried below (`foldPromotedTrunk`) the same way any CAS-publish retry
   * loop in this codebase is.
   *
   * MUST run in the worktree of a wing that's actually a member of the
   * experiment being promoted (checked by the caller, not here — this class
   * has no knowledge of experiments).
   *
   * Conflict contract (deliberately minimal — see `PromoteResult.error`):
   * the caller is told only that some files need fixing and to call
   * `promote` again — same as every other rebase-conflict message this
   * class builds (`rebaseConflictMessage`).
   *
   * Cross-call resumption: an open `AdvanceAttempt` (while a real conflict
   * is being resolved across multiple separate `promote` MCP calls) is held
   * in `this.advanceAttemptRegistry`, keyed by this worktree's path — see
   * that registry's own doc comment for why an in-memory, process-wide
   * registry is the right shape here (a fresh `MovementManager` is
   * constructed per call, so the `AdvanceAttempt` object itself can't live
   * on this instance).
   */
  async promote(mainTrunk: Trunk): Promise<PromoteResult> {
    const workArea = this.requireWorkArea('promote');
    const trunkBranch = await resolveMovementBase(this.worktree.repository, this.worktree);
    const derivedTrunk = mainTrunk.derive(trunkBranch);
    const worktreePath = this.worktree.path;

    // Resolved once and reused for every `advance()` call this `promote()`
    // makes (below, and inside `foldPromotedTrunk`'s retry loop): `advance()`
    // reuses THIS worktree (a detached-HEAD checkout, `DiskDerivedTrunk
    // .replayOnto()`) to build its replay commit instead of provisioning a
    // disposable scratch worktree/branch — see `DerivedTrunk.advance()`'s
    // own doc comment. Safe to borrow: `activeMovement()` resolves the same
    // checkout `escalatePromoteConflict()` already borrows via
    // `beginAdvance()` on a real conflict, and `advance()` itself refuses
    // (throws) if it's dirty.
    const resolveIn = await workArea.activeMovement();

    const pending = this.advanceAttemptRegistry.get(worktreePath);
    if (pending) {
      const resumed = await pending.continueResolving();
      const stillOpen = await this.settleAdvanceAttempt(derivedTrunk, resumed, worktreePath);
      if (stillOpen) return stillOpen;
      return this.foldPromotedTrunk(derivedTrunk, mainTrunk, workArea, worktreePath, resolveIn);
    }

    const fast = await derivedTrunk.advance(resolveIn);
    if (fast.status === 'conflict') {
      const escalated = await this.escalatePromoteConflict(derivedTrunk, workArea, worktreePath);
      if (escalated) return escalated;
    }

    return this.foldPromotedTrunk(derivedTrunk, mainTrunk, workArea, worktreePath, resolveIn);
  }

  /**
   * Begins the attended path for a `promote()` conflict `advance()` (or a
   * re-`advance()` inside `foldPromotedTrunk`'s retry loop) couldn't resolve
   * on its own — borrows THIS worktree via `workArea.activeMovement()` and
   * `DerivedTrunk.beginAdvance()` (design doc §4.4). Returns `null` once the
   * attempt reaches "ok" (caller should proceed to fold the result onto
   * `mainTrunk`), or a `PromoteResult` when another resolution round is
   * needed (already registered in `advanceAttemptRegistry`).
   */
  private async escalatePromoteConflict(
    derivedTrunk: DerivedTrunk,
    workArea: WorkArea,
    worktreePath: string,
  ): Promise<PromoteResult | null> {
    const resolveIn = await workArea.activeMovement();
    const attempt = await derivedTrunk.beginAdvance(resolveIn);
    return this.settleAdvanceAttempt(derivedTrunk, attempt, worktreePath);
  }

  /**
   * Shared by the fresh-conflict and resumed-conflict paths: reflects
   * `attempt`'s current state into the registry and a `PromoteResult`, or
   * (once `status === "ready"`) calls `publish()` and does the same for
   * whatever that returns. Returns `null` only once `publish()` has
   * genuinely succeeded — clearing the registry entry — signaling the
   * caller to proceed to the fold.
   */
  private async settleAdvanceAttempt(
    derivedTrunk: DerivedTrunk,
    attempt: AdvanceAttempt,
    worktreePath: string,
  ): Promise<PromoteResult | null> {
    if (attempt.status === 'conflict') {
      this.advanceAttemptRegistry.set(worktreePath, attempt);
      return this.needsResolutionResult(derivedTrunk, attempt);
    }
    const publishResult = await attempt.publish();
    if (publishResult.status === 'conflict') {
      this.advanceAttemptRegistry.set(worktreePath, attempt);
      return this.needsResolutionResult(derivedTrunk, attempt);
    }
    this.advanceAttemptRegistry.delete(worktreePath);
    return null;
  }

  private needsResolutionResult(derivedTrunk: DerivedTrunk, attempt: AdvanceAttempt): PromoteResult {
    return {
      success: false,
      trunk: derivedTrunk.branch,
      needsResolution: true,
      error: this.rebaseConflictMessage(attempt, retryInstructionFor('promote')),
    };
  }

  /**
   * Folds `derivedTrunk` (now confirmed a linear descendant of `mainTrunk`
   * thanks to a just-succeeded `advance()`/`AdvanceAttempt.publish()`) onto
   * `mainTrunk` via `Trunk.fastForwardPublish()` — retrying, including
   * re-running `advance()`/escalating to `beginAdvance()` again, if
   * `mainTrunk` moved further before this fold's own CAS landed.
   */
  private async foldPromotedTrunk(
    derivedTrunk: DerivedTrunk,
    mainTrunk: Trunk,
    workArea: WorkArea,
    worktreePath: string,
    resolveIn: CheckedOutMovement,
  ): Promise<PromoteResult> {
    for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt++) {
      const newTip = await this.worktree.repository.resolveLocalRef(derivedTrunk.branch);
      if (newTip === null) {
        return {
          success: false,
          trunk: derivedTrunk.branch,
          error: `'${derivedTrunk.branch}' has no commits after a successful advance — this should not happen.`,
        };
      }

      const folded = await mainTrunk.fastForwardPublish(newTip);
      if (folded) {
        return { success: true, trunk: derivedTrunk.branch };
      }

      // Lost the fold's race — `mainTrunk` moved since we read it. Re-run
      // advance() against its fresh tip and retry; a genuine new conflict
      // escalates to attended resolution exactly like the first attempt did.
      const reAdvanced = await derivedTrunk.advance(resolveIn);
      if (reAdvanced.status === 'conflict') {
        const escalated = await this.escalatePromoteConflict(derivedTrunk, workArea, worktreePath);
        if (escalated) return escalated;
      }
    }
    return {
      success: false,
      trunk: derivedTrunk.branch,
      error: `Too much concurrent activity on "${mainTrunk.branch}" to land this promotion — another wing's merge/absorb/promote keeps landing first. Retry.`,
    };
  }

  /**
   * Builds a merge commit message from the options.
   */
  private buildMergeMessage(options: MergeMovementOptions): string {
    const parts: string[] = [];

    // First line: type: summary — always use CC short form
    parts.push(`${TO_CC_SHORT[options.type]}: ${options.summary}`);

    // Blank line + description
    if (options.description) {
      parts.push('');
      parts.push(options.description);
    }

    // Co-authored-by trailer
    if (options.coAuthoredBy) {
      parts.push('');
      parts.push(`Co-Authored-By: ${options.coAuthoredBy}`);
    }

    return parts.join('\n');
  }
}

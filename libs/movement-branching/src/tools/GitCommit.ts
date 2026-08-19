import type { Worktree, WorkArea, CheckedOutMovement } from '@minions/file-store';
import type { IQualityWatcher } from '@minions/quality-watcher';
import { ToolTracker } from '../risk/ToolTracker.js';
import { RiskFactorTracker } from '../risk/RiskFactorTracker.js';
import { RiskCode, type RiskAssessment } from '../risk/RiskComputer.js';
import { runCommitPipeline } from '../pipeline/runCommitPipeline.js';
import { MOVEMENT_COMMIT_HOOK_POINT } from '../pipeline/types.js';
import type { PipelineContext } from '../pipeline/types.js';
import { defaultCommitPipelineRegistry } from '../pipeline/defaultRegistry.js';
import type { PipelineRegistry } from '../pipeline/CommitPipelineRegistry.js';
import { CommitCoordinator, defaultCommitCoordinator } from './CommitCoordinator.js';

/**
 * Intention codes from Arlo's Commit Notation
 */
export enum IntentionCode {
  Feature = 'feature',
  Bug = 'bug',
  Refactor = 'refactor',
  Test = 'test',
  Docs = 'docs',
  Chore = 'chore',
  Plan = 'plan',
  /** Multiple conflicting intentions detected — commit should be split */
  Unknown = 'unknown',
}

/**
 * Mapping from intention enum to short code
 */
const INTENTION_CODES: Record<IntentionCode, string> = {
  [IntentionCode.Feature]: 'f',
  [IntentionCode.Bug]: 'b',
  [IntentionCode.Refactor]: 'r',
  [IntentionCode.Test]: 't',
  [IntentionCode.Docs]: 'd',
  [IntentionCode.Chore]: 'e',
  [IntentionCode.Plan]: 'p',
  [IntentionCode.Unknown]: '?',
};

/**
 * Options for creating a commit
 */
export interface GitCommitOptions {
  /** The intention of the commit */
  intention: IntentionCode;
  /** One-line summary of the change (risk code will be prepended) */
  summary: string;
  /** Optional longer description of the change */
  description?: string;
  /** Optional co-authored-by trailer (e.g. "Claude <noreply@anthropic.com>") */
  coAuthoredBy?: string;
  /**
   * Appends a `[skip ci]` line to the commit message, recognized by GitHub
   * Actions and most other CI providers as a signal to skip running on this
   * commit/push. Use for high-frequency automated commits (e.g. plan
   * claim/release bookkeeping) that don't need CI and would otherwise burn
   * through runner time.
   */
  skipCi?: boolean;
  /** Whether tests were run */
  testsRan: boolean;
  /** Whether tests passed */
  testsPassed: boolean;
  /** Whether the test coverage is comprehensive */
  isComprehensive?: boolean;
  /** When true, a failing lint signal is advice-only instead of blocking the commit — see QualityGateRecognizer. */
  allowLintErrors?: boolean;
}

/**
 * Result of a commit operation
 */
export interface GitCommitResult {
  success: boolean;
  commitHash?: string;
  error?: string;
  commitMessage?: string;
  riskAssessment?: RiskAssessment;
  /** Advice surfaced by the commit pipeline — e.g. what a check changed and why. */
  advice?: string[];
  /**
   * True when this call did no work because the worktree was already clean
   * — idempotent success, not a failure. `commitHash` is the existing HEAD,
   * not a new commit. A caller retrying a commit it already made (e.g. after
   * a client-side timeout whose server-side commit actually landed) sees
   * success here instead of a confusing "nothing to commit" error.
   */
  noop?: boolean;
}

const RISK_CHAR = '[.^!@]';
const INTENTION_CHAR = '[fbrtdep?]';

const LEADING_CODE_PATTERNS = [
  new RegExp(`^${RISK_CHAR} ${INTENTION_CHAR} `), // risk space intention space
  new RegExp(`^${RISK_CHAR}${INTENTION_CHAR} `),  // risk intention space (compact)
  new RegExp(`^${RISK_CHAR} `),                   // risk space only
  new RegExp(`^${INTENTION_CHAR} `),              // intention space only
];

/**
 * Strips any leading risk/intention code prefix an agent may have accidentally
 * included in the summary (e.g. "d some message" → "some message").
 * The tool already prepends these codes, so a duplicate prefix must be removed.
 */
export function stripLeadingCodes(summary: string): string {
  for (const pattern of LEADING_CODE_PATTERNS) {
    if (pattern.test(summary)) {
      return summary.replace(pattern, '');
    }
  }
  return summary;
}

/**
 * Creates git commits with automatic risk computation.
 *
 * GitCommit integrates with ToolTracker and RiskFactorTracker to automatically
 * compute the risk level of a commit based on:
 * - Which tools were used (file edits, etc.)
 * - Which files were modified
 * - Whether tests exist and pass
 * - Any manually added risk factors
 *
 * The commit message is formatted as: `<risk> <intention> <message>`
 * Example: `^ f Add user authentication`
 *
 * Note: All changes in the worktree are committed. There is no staging;
 * the tool always commits everything.
 */
export class GitCommit {
  constructor(
    private readonly worktree: Worktree,
    private readonly toolTracker: ToolTracker,
    private readonly riskFactorTracker: RiskFactorTracker,
    private readonly pipelineRegistry: PipelineRegistry = defaultCommitPipelineRegistry,
    private readonly qualityWatcher?: IQualityWatcher,
    private readonly commitCoordinator: CommitCoordinator = defaultCommitCoordinator,
    /**
     * The design doc §4.3 `WorkArea` for this worktree, mirroring
     * `MovementSession`'s own optional-`workArea` constructor param — when
     * present, `commit()` composes its raw git-mechanic calls
     * (`isDirty`/branch/tip-hash/commit) through `WorkArea.activeMovement()`'s
     * `CheckedOutMovement` instead of hand-rolling them against the raw
     * `Worktree` (design doc §4.1/§4.3).
     *
     * Optional, not required, because not every legitimate `GitCommit`
     * caller has a wing-shaped `WorkArea` to give it — this stays a
     * genuinely generic switch ("does this caller have a wing-shaped
     * `WorkArea` or not"), not machinery tied to any particular caller.
     * When `workArea` is absent, `commit()` falls back to the raw-`Worktree`
     * calls unchanged.
     */
    private readonly workArea?: WorkArea,
  ) {}

  /**
   * Create a commit with automatic risk computation.
   * Commits all changes in the worktree (no partial staging).
   *
   * Idempotent and debounced: a clean worktree returns success immediately
   * (see `noop` on the result) instead of scheduling any pipeline/git work,
   * and a call made while another commit is already in flight for this same
   * worktree joins that call's result instead of starting a second one —
   * see `CommitCoordinator`.
   */
  async commit(options: GitCommitOptions): Promise<GitCommitResult> {
    let movement: CheckedOutMovement | undefined;
    try {
      movement = await this.resolveMovement();
      // Fast path: nothing to do. Checked before touching the coordinator at
      // all, so a clean worktree never even queues behind a same-worktree
      // commit that happens to be running (there is genuinely nothing this
      // call needs from that other attempt). This is still just an
      // optimization, not the only place "nothing to commit" is handled —
      // see commitDirty()'s own catch for the race where the worktree was
      // dirty here but a concurrent commit lands before this one reaches
      // `commitAll`.
      const isDirty = movement ? await movement.isDirty() : await this.worktree.isDirty();
      if (!isDirty) {
        return await this.noopSuccess(movement);
      }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }

    return this.commitCoordinator.coalesce(this.worktree.path, () => this.commitDirty(options, movement));
  }

  /**
   * Resolves this call's `CheckedOutMovement` handle via `workArea`, if one
   * was supplied — `undefined` when `workArea` is absent (see the
   * constructor doc). Movement handles are cheap and freely reconstructible
   * (design doc §4.1), so re-resolving per `commit()` call, rather than
   * caching one on `this`, is deliberate: it always reflects the worktree's
   * actual current branch/base rather than whatever was true when `GitCommit`
   * was constructed.
   */
  private async resolveMovement(): Promise<CheckedOutMovement | undefined> {
    return this.workArea ? await this.workArea.activeMovement() : undefined;
  }

  /** Success result for a worktree that was already clean — see `commit()`'s fast path. */
  private async noopSuccess(movement?: CheckedOutMovement): Promise<GitCommitResult> {
    try {
      if (movement) {
        const commitHash = (await movement.tipHash()) ?? undefined;
        return { success: true, noop: true, commitHash };
      }
      const branch = await this.worktree.currentBranch();
      const commitHash = (await this.worktree.repository.resolveLocalRef(branch)) ?? undefined;
      return { success: true, noop: true, commitHash };
    } catch {
      // Resolving HEAD is best-effort context, not the point of this result.
      return { success: true, noop: true };
    }
  }

  private async commitDirty(options: GitCommitOptions, movement?: CheckedOutMovement): Promise<GitCommitResult> {
    try {
      const manualFactors = this.riskFactorTracker.getRiskFactors().map((f) => ({
        code: f.code,
        reason: f.reason,
        details: f.details,
      }));

      const ctx: PipelineContext = {
        hookPointId: MOVEMENT_COMMIT_HOOK_POINT.id,
        worktree: this.worktree,
        toolTracker: this.toolTracker,
        changedFiles: this.toolTracker.getEditedFiles(),
        testsRan: options.testsRan,
        testsPassed: options.testsPassed,
        isComprehensive: options.isComprehensive,
        manualRiskFactors: manualFactors,
        qualityWatcher: this.qualityWatcher,
        allowLintErrors: options.allowLintErrors,
      };

      const outcome = await runCommitPipeline(ctx, this.pipelineRegistry);

      if (!outcome.accept) {
        return {
          success: false,
          error: outcome.rejectReasons.join('; ') || 'commit rejected by check pipeline',
          advice: outcome.advice,
        };
      }

      // A mandatory RiskAnnotation registration should always produce this;
      // fail safe to the highest risk code if a broken registry somehow omits it.
      const riskAssessment: RiskAssessment = outcome.riskAssessment ?? {
        code: RiskCode.Risky,
        reason: 'Risk assessment unavailable',
        automated: { code: RiskCode.Risky, reason: 'Risk assessment unavailable' },
        manualFactors: [],
        suggestions: [],
      };

      // Format commit message
      const intentionCode = INTENTION_CODES[options.intention];
      const lines = [`${riskAssessment.code} ${intentionCode} ${stripLeadingCodes(options.summary)}`];
      if (options.description) {
        lines.push('', options.description);
      }
      if (options.coAuthoredBy) {
        lines.push('', `Co-Authored-By: ${options.coAuthoredBy}`);
      }
      if (options.skipCi) {
        lines.push('', '[skip ci]');
      }
      const commitMessage = lines.join('\n');

      // Create the commit (commits all changes, including any file patches
      // the pipeline already applied above).
      let commitHash: string;
      try {
        // The quality gate already verified tests/types/lint/build clean
        // this run — a pre-commit hook re-running the same checks is
        // redundant work, not an extra safety net. Only skip hooks when
        // that verification genuinely happened (never merely "wasn't
        // rejected" — see qualityGateVerifiedClean's own contract).
        commitHash = movement
          ? (await movement.commit({ message: commitMessage, noVerify: outcome.qualityGateVerifiedClean })).hash
          : await this.worktree.commitAll(commitMessage, { noVerify: outcome.qualityGateVerifiedClean });
      } catch (commitError) {
        // The worktree was dirty when this call started, but a concurrent
        // commit for the same worktree (see inFlightCommits — this can only
        // race in from an older, still-running attempt this call didn't
        // know about, e.g. a pre-idempotency caller, or another process
        // entirely) can land in between, leaving nothing left to add/commit
        // by the time we get here. That's success, not failure — the
        // worktree is clean because the intended state (everything
        // committed) already holds.
        const message = commitError instanceof Error ? commitError.message : String(commitError);
        if (/nothing to commit/i.test(message)) {
          return await this.noopSuccess(movement);
        }
        throw commitError;
      }

      // Reset trackers after successful commit
      this.toolTracker.reset();
      this.riskFactorTracker.reset();

      return {
        success: true,
        commitHash,
        commitMessage,
        riskAssessment,
        advice: outcome.advice,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

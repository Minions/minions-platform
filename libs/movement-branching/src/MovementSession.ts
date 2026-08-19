import type { Worktree, CommitInfo, WorkArea, Trunk } from '@minions/file-store';
import type { IQualityWatcher } from '@minions/quality-watcher';

type MovementCommit = Omit<CommitInfo, 'body'>;
import { ToolTracker } from './risk/ToolTracker.js';
import { RiskFactorTracker } from './risk/RiskFactorTracker.js';
import { RiskCode } from './risk/RiskComputer.js';
import type { RiskAssessment } from './risk/RiskComputer.js';
import { GitStatus } from './tools/GitStatus.js';
import { GitCommit, IntentionCode } from './tools/GitCommit.js';
import type { CommitCoordinator } from './tools/CommitCoordinator.js';
import { MovementManager } from './movement/MovementManager.js';
import type { CommitType, AbsorbPlanResult, PromoteResult } from './movement/MovementManager.js';
import { ToolLogReader } from './tool-log/ToolLogReader.js';
import { ToolLogAnalyzer } from './tool-log/ToolLogAnalyzer.js';
import { mergeIntentions } from './tool-log/IntentionMerger.js';
import type { IntentionClassification, RiskClassification } from './tool-log/ToolLogAnalyzer.js';
import type { ToolLogEntry } from './tool-log/ToolLogEntry.js';
import { CommitReasoningLogger } from './tool-log/CommitReasoningLogger.js';

export type { CommitType, AbsorbPlanResult, PromoteResult };

/**
 * Risk levels (maps to Arlo's notation)
 */
export type Risk = 'provable' | 'thorough' | 'covered' | 'risky';

/**
 * Status result
 */
export interface StatusResult {
  branch: string;
  isMovementBranch: boolean;
  isDirty: boolean;
  modifiedFiles: string[];
  /** Commits in the movement (from main to HEAD), only populated when on movement branch */
  movementCommits: MovementCommit[];
}

/**
 * Commit options
 */
export interface CommitOptions {
  type: CommitType;
  summary: string;
  description?: string;
  coAuthoredBy?: string;
  /** See `GitCommitOptions.skipCi` — appends a `[skip ci]` line to the commit message. */
  skipCi?: boolean;
  testsRan: boolean;
  testsPassed: boolean;
  isComprehensive?: boolean;
  /** When true, a failing lint signal is advice-only instead of blocking the commit. */
  allowLintErrors?: boolean;
}

/**
 * Tool log analysis included in commit results when a log path is configured.
 */
export interface ToolLogCommitAnalysis {
  /** Analyzer's raw intention classification */
  analyzedIntention: IntentionClassification;
  /** Analyzer's raw risk classification */
  analyzedRisk: RiskClassification;
  /** Merged intention (agent + analyzer) used in commit message */
  mergedIntention: IntentionClassification;
  /** Number of log entries read */
  entriesRead: number;
  /**
   * Explains a mismatch, present only when the intention glyph actually used in the
   * commit message differs from the caller's declared `type` — e.g. it rendered `?`
   * (Unknown) or was overridden to a different type by the tool-log analysis.
   */
  mismatchNote?: string;
}

/**
 * Commit result
 */
/** The risk glyph plus, for '@'/'!' only, why and how to do better next time. */
export interface CommitRiskResult {
  code: RiskCode;
  /** Present only for '@' (Risky) or '!' (Covered) — why, and how to reach a lower code next time. */
  explanation?: string;
}

export interface CommitResult {
  success: boolean;
  commitHash?: string;
  error?: string;
  risk?: CommitRiskResult;
  /** Present when a tool log path is configured */
  toolLog?: ToolLogCommitAnalysis;
  /**
   * Present when a reasoning log path was configured but the write failed.
   * The commit itself still succeeds — this never blocks a commit — but a
   * missing reasoning.md is otherwise indistinguishable from "never attempted".
   */
  reasoningLogWarning?: string;
  /** Advice from the commit check pipeline — e.g. what a check changed and why. */
  advice?: string[];
  /**
   * True when this call did no work because the worktree was already clean
   * — idempotent success, not a failure. `commitHash` (if present) is the
   * existing HEAD, not a new commit.
   */
  noop?: boolean;
}

/**
 * Diff result
 */
export interface DiffResult {
  /** Unified diff of changes introduced by the movement branch since it diverged from its base */
  diff: string;
}

/**
 * Merge options
 */
export interface MergeOptions {
  type: CommitType;
  summary: string;
  description: string;
  coAuthoredBy?: string;
}

/**
 * Merge result
 */
export interface MergeResult {
  success: boolean;
  error?: string;
  /** True when git is mid-rebase due to conflicts — see error for recovery steps */
  needsRebase?: boolean;
}

/**
 * Start result
 */
export interface StartResult {
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
export interface StartOptions {
  // Branch to start on. See MovementManager.StartMovementOptions for allowed patterns.
  branch?: string;
  // Wing name — used to validate the l/<any>/w/<wing>-sub/ pattern.
  wingName?: string;
}

/**
 * Serializable state for persistence across context loss
 */
export interface MovementSessionState {
  toolTracker: { tools: Array<{ tool: string; params: Record<string, unknown>; timestamp: number }> };
  riskFactors: { factors: Array<{ code: string; reason: string; details?: string; timestamp: number }> };
}

const INTENTION_MAP: Record<CommitType, IntentionCode> = {
  feature: IntentionCode.Feature,
  feat: IntentionCode.Feature,
  bug: IntentionCode.Bug,
  fix: IntentionCode.Bug,
  refactor: IntentionCode.Refactor,
  test: IntentionCode.Test,
  docs: IntentionCode.Docs,
  chore: IntentionCode.Chore,
  plan: IntentionCode.Plan,
};

const RISK_MAP: Record<Risk, RiskCode> = {
  provable: RiskCode.Provable,
  thorough: RiskCode.Thorough,
  covered: RiskCode.Covered,
  risky: RiskCode.Risky,
};

/** Internal — includes raw entries for the reasoning logger */
interface ToolLogAnalysisInternal {
  entries: readonly ToolLogEntry[];
  analyzedIntention: IntentionClassification;
  analyzedRisk: RiskClassification;
  mergedIntention: IntentionClassification;
  entriesRead: number;
}

export class MovementSession {
  private readonly toolTracker: ToolTracker;
  private readonly riskFactorTracker: RiskFactorTracker;
  private readonly gitStatus: GitStatus;
  private readonly gitCommit: GitCommit;
  private readonly movementManager: MovementManager;

  constructor(
    private readonly worktree: Worktree,
    private readonly toolLogPath?: string,
    private readonly reasoningLogPath?: string,
    qualityWatcher?: IQualityWatcher,
    commitCoordinator?: CommitCoordinator,
    /**
     * The design doc §4.2 `WorkArea` for this worktree — required for
     * `start()`/`merge()`/`promote()`, which delegate to
     * `WorkArea.activeMovement()`/`beginNewActiveMovement()` +
     * `CheckedOutMovement.start()`/`Movement.merge()`/`DerivedTrunk
     * .beginAdvance()` (design doc §4.3/§4.4) instead of hand-rolling
     * rebase/CAS/retry against the raw `Worktree`; also required for
     * `status()` (only when currently on a movement branch) and `diff()`
     * (always), which build a `Movement` via `WorkArea.activeMovement()` to
     * call `Movement.commitsSince()`/`diffFrom()` instead of hand-rolling
     * `resolveMovementBase` + raw `Worktree.log`/`diff`. Optional here (not
     * on every `MovementSession` construction — `commit`/`absorbPlan` don't
     * need it) but every method that needs it throws a clear error if it's
     * missing rather than falling back to a second, parallel implementation.
     */
    private readonly workArea?: WorkArea,
  ) {
    this.toolTracker = new ToolTracker();
    this.riskFactorTracker = new RiskFactorTracker();
    this.gitStatus = new GitStatus(worktree, this.toolTracker, workArea);
    this.gitCommit = new GitCommit(
      worktree,
      this.toolTracker,
      this.riskFactorTracker,
      undefined,
      qualityWatcher,
      commitCoordinator,
      workArea,
    );
    this.movementManager = new MovementManager(worktree, workArea);
  }

  /**
   * `status()`/`diff()` need a `Movement` handle (`WorkArea.activeMovement()`)
   * to call `Movement.commitsSince()`/`diffFrom()` (design doc §4.1) instead
   * of hand-rolling `resolveMovementBase` + raw `Worktree.log`/`diff`. Same
   * "throw a clear error if missing" shape as `MovementManager.requireWorkArea`.
   */
  private requireWorkArea(caller: string): WorkArea {
    if (!this.workArea) {
      throw new Error(
        `MovementSession.${caller}() requires a WorkArea — construct with new MovementSession(worktree, ..., workArea).`,
      );
    }
    return this.workArea;
  }

  /**
   * Record that a file was edited.
   * Call this after each file modification.
   */
  recordFileEdit(filePath: string): void {
    this.toolTracker.recordTool('Edit', { file: filePath });
  }

  /**
   * Add a manual risk factor.
   * Use when you know something is risky that automated detection can't see.
   */
  addRiskFactor(risk: Risk, reason: string): void {
    this.riskFactorTracker.addRiskFactor(RISK_MAP[risk], reason);
  }

  /**
   * Get current git status.
   */
  async status(): Promise<StatusResult> {
    const status = await this.gitStatus.getStatus();
    const isMovementBranch = await this.movementManager.isOnMovementBranch();

    // Get commits in the movement (from the base branch to HEAD) if on movement branch
    let movementCommits: MovementCommit[] = [];
    if (isMovementBranch) {
      const movement = await this.requireWorkArea('status').activeMovement();
      movementCommits = (await movement.commitsSince()).map(
        ({ body: _body, ...rest }) => rest,
      );
    }

    return {
      branch: status.branch,
      isMovementBranch,
      isDirty: status.isDirty,
      modifiedFiles: status.modifiedFiles,
      movementCommits,
    };
  }

  /**
   * Start a movement by ensuring the branch is at or ahead of origin/main.
   * Call this before beginning work on a movement.
   */
  async start(options?: StartOptions): Promise<StartResult> {
    return this.movementManager.startMovement(options);
  }

  /**
   * Get the unified diff of changes introduced by this movement so far
   * (base branch to HEAD).
   */
  async diff(): Promise<DiffResult> {
    const movement = await this.requireWorkArea('diff').activeMovement();
    const diff = await movement.diffFrom();
    return { diff };
  }

  /**
   * Create a commit with automatic risk notation.
   */
  async commit(options: CommitOptions): Promise<CommitResult> {
    const toolLogInternal = await this.analyzeToolLogInternal(options.type);

    const declaredIntention = INTENTION_MAP[options.type];
    const usedIntention = toolLogInternal
      ? this.resolveIntention(toolLogInternal.mergedIntention, options.type)
      : declaredIntention;

    const result = await this.gitCommit.commit({
      intention: usedIntention,
      summary: options.summary,
      description: options.description,
      coAuthoredBy: options.coAuthoredBy,
      skipCi: options.skipCi,
      testsRan: options.testsRan,
      testsPassed: options.testsPassed,
      isComprehensive: options.isComprehensive,
      allowLintErrors: options.allowLintErrors,
    });

    if (result.success) {
      if (this.toolLogPath) {
        await new ToolLogReader(this.toolLogPath).clear();
      }
      // Push the movement branch after every commit so all machines stay in sync.
      // Force-push in case the branch was rebased or reset during the session.
      // Prefer `CheckedOutMovement.push()` (design doc §4.3) when a `WorkArea`
      // is available — same "movement handles are cheap, reconstruct as
      // needed" reasoning `GitCommit.resolveMovement()` uses. Falls back to
      // the raw `Worktree.forcePush()` for callers with no `WorkArea` (e.g.
      // the conductor mirror path — see `GitCommit`'s constructor doc), which
      // keeps behaving exactly as before.
      try {
        if (this.workArea) {
          await (await this.workArea.activeMovement()).push();
        } else {
          await this.worktree.forcePush();
        }
      } catch {
        // Best-effort — commit already succeeded; push failure is surfaced by the next start()
      }
    }

    const reasoningLogWarning = await this.logReasoning(options, toolLogInternal, result);

    const toolLog: ToolLogCommitAnalysis | undefined = toolLogInternal
      ? {
          analyzedIntention: toolLogInternal.analyzedIntention,
          analyzedRisk: toolLogInternal.analyzedRisk,
          mergedIntention: toolLogInternal.mergedIntention,
          entriesRead: toolLogInternal.entriesRead,
          mismatchNote:
            usedIntention !== declaredIntention
              ? this.describeMismatch(options.type, toolLogInternal, usedIntention)
              : undefined,
        }
      : undefined;

    const risk: CommitRiskResult | undefined = result.riskAssessment
      ? {
          code: result.riskAssessment.code,
          explanation:
            result.riskAssessment.code === RiskCode.Risky || result.riskAssessment.code === RiskCode.Covered
              ? this.describeRisk(result.riskAssessment)
              : undefined,
        }
      : undefined;

    return {
      success: result.success,
      commitHash: result.commitHash,
      error: result.error,
      risk,
      toolLog,
      reasoningLogWarning,
      advice: result.advice && result.advice.length > 0 ? result.advice : undefined,
      noop: result.noop,
    };
  }

  /**
   * Merge the movement branch to main.
   * Creates a merge commit and fast-forwards the movement branch.
   */
  async merge(options: MergeOptions): Promise<MergeResult> {
    const result = await this.movementManager.mergeMovement({
      type: options.type,
      summary: options.summary,
      description: options.description,
      coAuthoredBy: options.coAuthoredBy,
    });

    return {
      success: result.success,
      error: result.error,
      needsRebase: result.needsRebase,
    };
  }

  /**
   * Folds this worktree's experiment trunk into `mainTrunk`. See
   * `MovementManager.promote` for the full contract (conflict handling,
   * call-again-after-fixing-files semantics, etc.).
   */
  async promote(mainTrunk: Trunk): Promise<PromoteResult> {
    return this.movementManager.promote(mainTrunk);
  }

  /**
   * Export state for persistence.
   * Use to save state across context loss.
   */
  exportState(): MovementSessionState {
    return {
      toolTracker: this.toolTracker.exportState(),
      riskFactors: this.riskFactorTracker.exportState() as MovementSessionState['riskFactors'],
    };
  }

  /**
   * Import state from persistence.
   * Use to restore state after context loss.
   */
  importState(state: MovementSessionState): void {
    this.toolTracker.importState(state.toolTracker);
    this.riskFactorTracker.importState(state.riskFactors as { factors: Array<{ code: RiskCode; reason: string; details?: string; timestamp: number }> });
  }

  private async analyzeToolLogInternal(agentType: CommitType): Promise<ToolLogAnalysisInternal | null> {
    if (!this.toolLogPath) return null;

    const reader = new ToolLogReader(this.toolLogPath);
    const entries = await reader.read();
    if (entries.length === 0) return null;

    const analysis = new ToolLogAnalyzer(entries).analyze();
    const agentIntention = INTENTION_MAP[agentType];
    const mergedIntention = mergeIntentions(agentIntention, analysis.intention);

    // Elevate risk if analyzer observed higher risk than agent
    if (analysis.risk !== 'not_classified') {
      this.riskFactorTracker.addRiskFactor(analysis.risk as RiskCode, 'Tool log analysis');
    }

    return {
      entries,
      analyzedIntention: analysis.intention,
      analyzedRisk: analysis.risk,
      mergedIntention,
      entriesRead: entries.length,
    };
  }

  private async logReasoning(
    options: CommitOptions,
    toolLog: ToolLogAnalysisInternal | null,
    result: { success: boolean; commitHash?: string; commitMessage?: string; error?: string; riskAssessment?: import('./risk/RiskComputer.js').RiskAssessment },
  ): Promise<string | undefined> {
    if (!this.reasoningLogPath) return undefined;
    try {
      await new CommitReasoningLogger(this.reasoningLogPath).append({
        timestamp: new Date(),
        agentInput: {
          type: options.type,
          summary: options.summary,
          testsRan: options.testsRan,
          testsPassed: options.testsPassed,
          isComprehensive: options.isComprehensive,
        },
        toolEntries: toolLog?.entries ?? [],
        analyzedIntention: toolLog?.analyzedIntention ?? null,
        analyzedRisk: toolLog?.analyzedRisk ?? null,
        mergedIntention: toolLog?.mergedIntention ?? null,
        riskAssessment: result.riskAssessment ?? null,
        finalCommitMessage: result.commitMessage ?? null,
        commitHash: result.commitHash ?? null,
        success: result.success,
        error: result.error,
      });
      return undefined;
    } catch (error) {
      // Never block a commit due to logging failure — but the caller should be
      // able to tell "reasoning.md wasn't written" apart from "nothing to see here".
      const message = error instanceof Error ? error.message : String(error);
      return `Failed to write commit reasoning log to ${this.reasoningLogPath}: ${message}`;
    }
  }

  private resolveIntention(merged: IntentionClassification, fallbackType: CommitType): IntentionCode {
    if (merged === 'multiple') return IntentionCode.Unknown;
    if (merged === 'not_classified' || merged === 'code') return INTENTION_MAP[fallbackType];
    return merged;
  }

  /**
   * One-line, first-person note for why the committed intention differs from what
   * was declared. Full detail lives in the reasoning log, not here.
   */
  private describeMismatch(
    declaredType: CommitType,
    toolLog: ToolLogAnalysisInternal,
    usedIntention: IntentionCode,
  ): string {
    return `I've changed intention to "${usedIntention}" because the tool log shows ` +
      `"${toolLog.analyzedIntention}" edits, not "${declaredType}".`;
  }

  /**
   * One-line, actionable explanation for a '@'/'!' risk code: what to do
   * differently next time to earn a lower one. Undefined when there's nothing
   * concrete to suggest (e.g. the code was escalated by a manual risk factor
   * rather than the automated assessment) — silence over a bare restatement
   * of the risk code the caller can already see.
   */
  private describeRisk(assessment: RiskAssessment): string | undefined {
    if (assessment.suggestions.length === 0) return undefined;
    return `${assessment.reason}. Next time: ${assessment.suggestions.join('; ')}.`;
  }
}

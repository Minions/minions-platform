import type { Mirror, MutableDirectoryLike, Worktree } from '@minions/file-store';
import type { IQualityWatcher } from '@minions/quality-watcher';
import { ToolTracker } from '../risk/ToolTracker.js';
import { QualitySignalReader } from '../pipeline/detectors/QualitySignalReader.js';
import { QualityGateRecognizer } from '../pipeline/recognizers/QualityGateRecognizer.js';
import { MOVEMENT_COMMIT_HOOK_POINT } from '../pipeline/types.js';
import type { OutcomeChange, PipelineContext } from '../pipeline/types.js';
import { TO_CC_SHORT } from '../movement/MovementManager.js';
import type { CommitType } from '../movement/MovementManager.js';

export interface MirrorCommitOptions<R> {
  transform: (view: MutableDirectoryLike) => Promise<R>;
  /** The nature of the change — same vocabulary as `movement commit`/`movement merge`. */
  type: CommitType;
  /** One-line summary of the change. Required: a `Mirror.apply()` write IS a commit, landed directly on the trunk's own history — it needs a real message, not a placeholder. */
  summary: string;
  description?: string;
  coAuthoredBy?: string;
  /**
   * Appends a `[skip ci]` line to the commit message — see
   * `GitCommitOptions.skipCi`. A `Mirror.apply()` commit lands directly on
   * the trunk, so this is the one place that matters most: high-frequency
   * plan bookkeeping (claim/unclaim/mark-demo/etc.) pushed straight to main
   * would otherwise trigger a full CI run on every call.
   */
  skipCi?: boolean;
  /** Same opt-out as `GitCommitOptions.allowLintErrors` — a failing lint signal is advice-only instead of blocking, when true. Default: blocking. */
  allowLintErrors?: boolean;
  retries?: number;
}

export interface MirrorCommitResult<R> {
  success: boolean;
  error?: string;
  result?: R;
  committed?: boolean;
  commitHash?: string;
  attempts?: number;
}

/**
 * Commits a `Mirror.apply()` write with the same live quality-watcher gate
 * `GitCommit` enforces for a movement commit (tests/types/build always
 * block; lint blocks by default, opt-out via `allowLintErrors`) and an
 * intentional-commit message in the SAME `type: summary` form
 * `MovementManager.buildMergeMessage` builds for a movement merge — but with
 * no risk code: a `Mirror.apply()` commit lands single-parent, directly on
 * the trunk's own history, never on a reviewable side branch a later
 * movement merge carries a risk code for.
 */
export class MirrorCommit {
  constructor(
    private readonly mirror: Mirror,
    private readonly qualityWatcher?: IQualityWatcher,
  ) {}

  async commit<R>(options: MirrorCommitOptions<R>): Promise<MirrorCommitResult<R>> {
    const gate = await this.checkQualityGate(options.allowLintErrors);
    if (!gate.accept) {
      return { success: false, error: gate.reason };
    }

    const message = this.buildMessage(options);
    const { result, committed, commitHash, attempts } = await this.mirror.apply(options.transform, {
      message,
      retries: options.retries,
    });
    return { success: true, result, committed, commitHash, attempts };
  }

  private buildMessage(options: MirrorCommitOptions<unknown>): string {
    const parts = [`${TO_CC_SHORT[options.type]}: ${options.summary}`];
    if (options.description) {
      parts.push('', options.description);
    }
    if (options.coAuthoredBy) {
      parts.push('', `Co-Authored-By: ${options.coAuthoredBy}`);
    }
    if (options.skipCi) {
      parts.push('', '[skip ci]');
    }
    return parts.join('\n');
  }

  private async checkQualityGate(allowLintErrors?: boolean): Promise<{ accept: boolean; reason?: string }> {
    if (!this.qualityWatcher) return { accept: true };

    // `Mirror.apply()` writes against `MutableDirectoryLike`, with no
    // `Worktree` of its own on the public interface — but both real `Mirror`
    // adapters back `files` with a genuine `Worktree` underneath (see
    // DiskMirrorImpl's lazy-worktree proxy / InMemoryMirrorImpl's own
    // worktree field), so this cast is safe in practice — the same
    // currently-irreducible cast PlanActionGroup.ts's deleteSubtreeBody
    // already uses for the identical reason. Never actually dereferenced
    // here: only `QualitySignalReader`/`QualityGateRecognizer` run below,
    // neither of which reads `ctx.worktree` — it's required only by
    // `PipelineContext`'s type, satisfied for a possible future handler that
    // does.
    const worktree = this.mirror.files as unknown as Worktree;

    const ctx: PipelineContext = {
      hookPointId: MOVEMENT_COMMIT_HOOK_POINT.id,
      worktree,
      toolTracker: new ToolTracker(),
      changedFiles: [],
      testsRan: false,
      testsPassed: false,
      manualRiskFactors: [],
      qualityWatcher: this.qualityWatcher,
      allowLintErrors,
    };

    const evidence = await new QualitySignalReader().detect(ctx, []);
    const verdict = await new QualityGateRecognizer().recognize(ctx, evidence);
    const outcomes = verdict.changes.filter((c): c is OutcomeChange => c.kind === 'outcome');
    const rejection = outcomes.find((c) => !c.value.accept);
    return rejection ? { accept: false, reason: rejection.value.reason } : { accept: true };
  }
}

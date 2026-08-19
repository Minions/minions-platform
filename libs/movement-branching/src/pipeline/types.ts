import type { Worktree } from '@minions/file-store';
import type { IQualityWatcher } from '@minions/quality-watcher';
import type { ToolTracker } from '../risk/ToolTracker.js';
import type { ManualRiskFactor, RiskAssessment } from '../risk/RiskComputer.js';

/**
 * A fact surfaced by a Detector. Evidence is a set, not an algebra — detectors
 * only ever add to it, optionally reading what earlier detectors produced.
 */
export interface Evidence<TPayload = unknown> {
  producer: string;
  kind: string;
  payload: TPayload;
}

/**
 * Narrow context handed to every Detector/Recognizer. Deliberately excludes
 * raw cabinet internals — only what the built-in handlers in this pipeline
 * need, even though they run in-process.
 */
export interface PipelineContext {
  hookPointId: string;
  worktree: Worktree;
  toolTracker: ToolTracker;
  /** Files considered changed this commit — today's tool-log heuristic. */
  changedFiles: string[];
  testsRan: boolean;
  testsPassed: boolean;
  isComprehensive?: boolean;
  manualRiskFactors: ManualRiskFactor[];
  /** Read-only handle onto the wing's live tests/types/lint/build signals. Undefined when unavailable — handlers must degrade gracefully. */
  qualityWatcher?: IQualityWatcher;
  /**
   * When true, a failing lint signal is reported as advice only (today's
   * default behavior) instead of hard-gating the commit — see
   * `QualityGateRecognizer`'s `BLOCKING_KEYS`. Absent/false blocks the
   * commit on a lint failure just like tests/types/build.
   */
  allowLintErrors?: boolean;
}

export interface Detector {
  id: string;
  detect(ctx: PipelineContext, evidenceSoFar: Evidence[]): Promise<Evidence[]>;
}

export interface Verdict {
  changes: Change[];
}

export interface Recognizer {
  id: string;
  kind: 'deterministic' | 'ai';
  recognize(ctx: PipelineContext, evidence: Evidence[]): Promise<Verdict>;
}

export type CharPos = number;

export interface Change<TKind extends string = string, TValue = unknown> {
  kind: TKind;
  /** File path, or omitted for change-wide kinds (risk, advice, outcome). */
  target?: string;
  value: TValue;
  producer: string;
}

export type TextChange = Change<'text', {
  file: string;
  baseContentHash: string;
  range: [CharPos, CharPos];
  replacement: string;
}>;

/** Value carries the full RiskAssessment so callers keep today's rich shape. */
export type RiskChange = Change<'risk', RiskAssessment>;

export type AdviceChange = Change<'advice', { message: string; priority: number }>;

export type OutcomeChange = Change<'outcome', { accept: boolean; reason: string }>;

export type AnyChange = TextChange | RiskChange | AdviceChange | OutcomeChange;

/**
 * A named place a change passes through. Handlers connect via a
 * HandlerRegistration — hook-point wiring is a property of the registration,
 * not of the Detector/Recognizer itself.
 */
export interface HookPoint {
  id: string;
  description: string;
  capabilities: { canApplyChanges: boolean; canRejectOperation: boolean };
}

export interface HandlerRegistration {
  handler: Detector | Recognizer;
  hookPoints: string[] | ((hp: HookPoint) => boolean);
  appliesWhen?: (ctx: PipelineContext) => boolean;
  mandatory: boolean;
  priority?: number;
}

export const MOVEMENT_COMMIT_HOOK_POINT: HookPoint = {
  id: 'movement.commit',
  description: 'Fires after staging, before the underlying git commit.',
  capabilities: { canApplyChanges: true, canRejectOperation: true },
};

function isRecognizer(handler: Detector | Recognizer): handler is Recognizer {
  return 'recognize' in handler;
}

export function isDetector(handler: Detector | Recognizer): handler is Detector {
  return !isRecognizer(handler);
}

export { isRecognizer };

import { RiskCode } from '../risk/RiskComputer.js';
import type { AnyChange, TextChange, RiskChange, AdviceChange, OutcomeChange } from './types.js';

const RISK_ORDER: Record<RiskCode, number> = {
  [RiskCode.Provable]: 0,
  [RiskCode.Thorough]: 1,
  [RiskCode.Covered]: 2,
  [RiskCode.Risky]: 3,
};

export interface TextMergeResult {
  /** Accepted edits per file, sorted by range start descending (safe to apply in order). */
  accepted: Map<string, TextChange[]>;
  /** Edits that overlapped an already-accepted edit this pass — deferred, never silently dropped. */
  conflicted: TextChange[];
}

/**
 * ESLint-`--fix`-style merge: sort each file's edits by range end descending,
 * accept each edit whose range doesn't overlap the previously-accepted one.
 * Anything that conflicts is deferred, never silently dropped or overwritten.
 */
export function mergeTextChanges(changes: TextChange[]): TextMergeResult {
  const byFile = new Map<string, TextChange[]>();
  for (const change of changes) {
    const list = byFile.get(change.value.file) ?? [];
    list.push(change);
    byFile.set(change.value.file, list);
  }

  const accepted = new Map<string, TextChange[]>();
  const conflicted: TextChange[] = [];

  for (const [file, fileChanges] of byFile) {
    const sorted = [...fileChanges].sort((a, b) => b.value.range[1] - a.value.range[1]);
    const acceptedForFile: TextChange[] = [];
    let lastAcceptedStart = Infinity;

    for (const change of sorted) {
      const [, end] = change.value.range;
      if (end <= lastAcceptedStart) {
        acceptedForFile.push(change);
        lastAcceptedStart = change.value.range[0];
      } else {
        conflicted.push(change);
      }
    }

    accepted.set(file, acceptedForFile);
  }

  return { accepted, conflicted };
}

/** Highest-wins — RiskComputer.maxRiskCode's rule, applied across every RiskChange contributor. */
export function reduceRisk(changes: RiskChange[]): RiskChange['value'] | undefined {
  if (changes.length === 0) return undefined;
  return changes.reduce((max, c) => (RISK_ORDER[c.value.code] > RISK_ORDER[max.value.code] ? c : max)).value;
}

/** Concatenate, ordered by each change's own priority (highest first). */
export function reduceAdvice(changes: AdviceChange[]): string[] {
  return [...changes].sort((a, b) => b.value.priority - a.value.priority).map((c) => c.value.message);
}

/** Any accept:false wins; multiple rejections concatenate their reasons. */
export function reduceOutcome(changes: OutcomeChange[]): { accept: boolean; reasons: string[] } {
  const rejections = changes.filter((c) => !c.value.accept);
  if (rejections.length > 0) {
    return { accept: false, reasons: rejections.map((c) => c.value.reason) };
  }
  return { accept: true, reasons: [] };
}

export interface CombinedChanges {
  text: TextMergeResult;
  risk?: RiskChange['value'];
  /** Advice actually surfaced — suppressed entirely when outcome rejects (cross-kind rule). */
  advice: string[];
  outcome: { accept: boolean; reasons: string[] };
}

/**
 * The Change algebra's one operation: folds every proposed Change by kind,
 * then applies the one cross-kind rule (advice suppressed when outcome
 * rejects).
 */
export function combine(changes: AnyChange[]): CombinedChanges {
  const text = mergeTextChanges(changes.filter((c): c is TextChange => c.kind === 'text'));
  const risk = reduceRisk(changes.filter((c): c is RiskChange => c.kind === 'risk'));
  const outcome = reduceOutcome(changes.filter((c): c is OutcomeChange => c.kind === 'outcome'));
  const advice = outcome.accept ? reduceAdvice(changes.filter((c): c is AdviceChange => c.kind === 'advice')) : [];

  return { text, risk, advice, outcome };
}

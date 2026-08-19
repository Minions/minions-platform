import type { PipelineRegistry } from './CommitPipelineRegistry.js';
import { MOVEMENT_COMMIT_HOOK_POINT, isDetector } from './types.js';
import type { AnyChange, Detector, Evidence, PipelineContext, Recognizer } from './types.js';
import { combine } from './combine.js';
import { applyTextChanges } from './apply.js';
import { evaluateQualitySignals } from './recognizers/QualityGateRecognizer.js';
import type { RiskAssessment } from '../risk/RiskComputer.js';

const HANDLER_TIMEOUT_MS = 45_000;

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface CommitPipelineOutcome {
  riskAssessment?: RiskAssessment;
  advice: string[];
  accept: boolean;
  rejectReasons: string[];
  patchedFiles: string[];
  /** Names of handlers that threw or timed out — surfaced, never silently swallowed. */
  brokenHandlers: string[];
  /**
   * True only when the live quality-watcher evidence was present and every
   * signal (tests/types/lint/build) settled to exactly `pass` this run — see
   * QualityGateRecognizer.evaluateQualitySignals. Never true when the
   * watcher was unavailable, or a signal was still `running`/`pending`
   * (awaitStatus's wait timed out before it settled). Callers use this to
   * decide whether the underlying `git commit` can skip redundant
   * pre-commit hooks — never as a proxy for "commit was accepted".
   */
  qualityGateVerifiedClean: boolean;
}

/**
 * Runs the movement.commit hook point: detect → recognize (deterministic,
 * then AI) → combine → apply. A handler that throws or times out degrades to
 * an advice entry naming it — infrastructure failure in a checker never
 * silently blocks or silently passes.
 */
export async function runCommitPipeline(ctx: PipelineContext, registry: PipelineRegistry): Promise<CommitPipelineOutcome> {
  const registrations = registry
    .registrationsFor(MOVEMENT_COMMIT_HOOK_POINT)
    .filter((r) => !r.appliesWhen || r.appliesWhen(ctx));

  const detectors = registrations.filter((r) => isDetector(r.handler)).map((r) => r.handler as Detector);
  const recognizers = registrations.filter((r) => !isDetector(r.handler)).map((r) => r.handler as Recognizer);

  const brokenHandlers: string[] = [];

  // Detectors are independent of each other in the shape actually shipped
  // today — no detector reads `evidenceSoFar` (the doc's multi-pass
  // regenerate-evidence loop, where a later pass's detectors would read a
  // prior pass's Change-patched content, isn't built yet — see
  // docs/design/commit-check-pipeline.md "Implementation notes"). Running
  // them concurrently rather than one at a time matters in practice: the
  // slowest detector here (QualitySignalReader, reading live test/type/
  // lint/build state) can take most of its own timeout budget on its own;
  // running them concurrently rather than stacking every other handler's
  // timeout serially on top of that keeps `movement commit` from running
  // close enough to a client-side timeout to make retries dangerous.
  const detectorResults = await Promise.all(
    detectors.map(async (detector): Promise<Evidence[]> => {
      try {
        return await withTimeout(detector.detect(ctx, []), HANDLER_TIMEOUT_MS, detector.id);
      } catch {
        brokenHandlers.push(detector.id);
        return [];
      }
    })
  );
  const evidence: Evidence[] = detectorResults.flat();

  const deterministic = recognizers.filter((r) => r.kind === 'deterministic');
  const ai = recognizers.filter((r) => r.kind === 'ai');

  // Deterministic recognizers still run before AI ones (cheap filters
  // first, matching the design doc), but a recognizer never sees another's
  // proposals — combining is entirely combine()'s job below — so recognizers
  // within each tier are independent of each other and run concurrently.
  const runTier = async (tier: Recognizer[]): Promise<AnyChange[]> => {
    const results = await Promise.all(
      tier.map(async (recognizer): Promise<AnyChange[]> => {
        try {
          const verdict = await withTimeout(recognizer.recognize(ctx, evidence), HANDLER_TIMEOUT_MS, recognizer.id);
          return verdict.changes as AnyChange[];
        } catch {
          brokenHandlers.push(recognizer.id);
          return [];
        }
      })
    );
    return results.flat();
  };

  const changes: AnyChange[] = [...(await runTier(deterministic)), ...(await runTier(ai))];

  const combined = combine(changes);
  const { patchedFiles, staleEdits } = combined.outcome.accept
    ? await applyTextChanges(ctx.worktree, combined.text.accepted)
    : { patchedFiles: [] as string[], staleEdits: [] as import('./types.js').TextChange[] };

  const advice = [
    ...combined.advice,
    ...brokenHandlers.map((id) => `Handler "${id}" failed and was skipped for this commit.`),
    ...staleEdits.map((e) => `Skipped a proposed edit to ${e.value.file} — file changed since the edit was computed.`),
    ...(combined.outcome.accept
      ? combined.text.conflicted.map((c) => `Skipped a conflicting proposed edit to ${c.value.file} from "${c.producer}".`)
      : []),
  ];

  return {
    riskAssessment: combined.risk,
    advice,
    accept: combined.outcome.accept,
    rejectReasons: combined.outcome.reasons,
    patchedFiles,
    brokenHandlers,
    qualityGateVerifiedClean: evaluateQualitySignals(evidence).allPass,
  };
}

import { AssessRisk } from '../../tools/AssessRisk.js';
import { type ManualRiskFactor, RiskCode } from '../../risk/RiskComputer.js';
import type { PipelineContext, Recognizer, Verdict, Evidence, RiskChange } from '../types.js';
import type { SignalStateEvidencePayload } from '../detectors/QualitySignalReader.js';

function readSignalState(evidence: Evidence[]): SignalStateEvidencePayload | undefined {
  const entry = evidence.find((e) => e.kind === 'signal-state');
  return entry?.payload as SignalStateEvidencePayload | undefined;
}

/**
 * Built-in Recognizer, absorbed from RiskComputer + TestCoverage (via
 * AssessRisk) — see docs/design/commit-check-pipeline.md "Relationship to
 * existing systems". Reuses AssessRisk verbatim so the risk-code semantics
 * this node's invariant requires ("same risk-code semantics ... unless a
 * newly-registered check genuinely changes the outcome") hold by construction.
 *
 * Also folds live tests/types/lint/build signal-state Evidence (from
 * QualitySignalReader, see docs/design/commit-check-pipeline.md's
 * `c93a2050` children) alongside the tool-log heuristic: a live-passing
 * tests signal can count as ctx.testsRan/testsPassed even when the caller
 * didn't declare a test run this session, and a live lint/types/build
 * failure escalates risk via the existing manual-risk-factor mechanism even
 * when no matching tool call was logged. No evidence present (no watcher,
 * or the watcher has nothing cached yet) leaves the heuristic untouched.
 */
export class RiskAnnotationRecognizer implements Recognizer {
  readonly id = 'risk-annotation';
  readonly kind = 'deterministic' as const;

  async recognize(ctx: PipelineContext, evidence: Evidence[]): Promise<Verdict> {
    const signalState = readSignalState(evidence);

    const liveTestsPass = signalState?.tests.state === 'pass';
    const effectiveTestsRan = ctx.testsRan || liveTestsPass === true;
    const effectiveTestsPassed = ctx.testsPassed || liveTestsPass === true;

    const manualRiskFactors: ManualRiskFactor[] = [...ctx.manualRiskFactors];
    if (signalState?.lint.state === 'fail') {
      manualRiskFactors.push({
        code: RiskCode.Risky,
        reason: 'Live lint signal reports failures (quality-watcher)',
      });
    }
    if (signalState?.types.state === 'fail') {
      manualRiskFactors.push({
        code: RiskCode.Risky,
        reason: 'Live type-check signal reports failures (quality-watcher)',
      });
    }
    if (signalState?.build.state === 'fail') {
      manualRiskFactors.push({
        code: RiskCode.Risky,
        reason: 'Live build signal reports failures (quality-watcher)',
      });
    }

    const assessment = await new AssessRisk(ctx.worktree, ctx.toolTracker).assess({
      testsRan: effectiveTestsRan,
      testsPassed: effectiveTestsPassed,
      isComprehensive: ctx.isComprehensive,
      manualRiskFactors,
    });

    // No separate advice entry for the risk explanation: CommitResult.risk.explanation
    // (MovementSession.commit, built the same way from this same assessment) already
    // carries this for Risky/Covered codes — duplicating it into `advice` doubled the
    // same text in every such commit's reply for no reason.
    const riskChange: RiskChange = { kind: 'risk', value: assessment, producer: this.id };
    return { changes: [riskChange] };
  }
}

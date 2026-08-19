import { SignalType, combineSignalStates, type SignalState } from '@minions/quality-watcher';
import type { Detector, Evidence, PipelineContext } from '../types.js';

/** Payload of the 'signal-state' Evidence this detector emits — tests/types/lint/build, all read from the watcher's live cache. */
export interface SignalStateEvidencePayload {
  tests: SignalState;
  types: SignalState;
  lint: SignalState;
  build: SignalState;
}

/**
 * Wraps `IQualityWatcher.awaitStatus()` (see docs/design/commit-check-pipeline.md
 * "Relationship to existing systems" -> `libs/quality-watcher`) to surface live
 * tests/types/lint/build signal state as Evidence for recognizers to fold into
 * risk. Emits no evidence when `ctx.qualityWatcher` is absent — never an error.
 *
 * `build` is read straight from the watcher's cache like every other
 * signal — there is no separate on-demand trigger to call here. Every
 * signal (`QualityWatcher` in `libs/quality-watcher`) is a genuine
 * continuously-running watch source now, build included, so `awaitStatus()`
 * already reflects a live build result the same way it does for tests.
 *
 * There is no standalone "lint" signal in quality-watcher any more — its
 * coverage is split between OxLint (everything oxlint can check) and
 * CustomLint (everything it can't, e.g. `@nx/enforce-module-boundaries` and
 * Vue template rules). `lint` here is those two combined "worst wins", so
 * recognizers downstream keep seeing one lint result regardless of which of
 * the two actually caught the problem.
 */
export class QualitySignalReader implements Detector {
  readonly id = 'quality-signal-reader';

  async detect(ctx: PipelineContext, _evidenceSoFar: Evidence[]): Promise<Evidence[]> {
    if (!ctx.qualityWatcher) return [];

    // Give the watcher most of this detector's HANDLER_TIMEOUT_MS budget in
    // runCommitPipeline (45s) to let running signals settle, with a margin
    // so that budget — not this wait — is the backstop on the normal path.
    const status = await ctx.qualityWatcher.awaitStatus(40_000);
    const payload: SignalStateEvidencePayload = {
      tests: status[SignalType.Tests],
      types: status[SignalType.Types],
      build: status[SignalType.Build],
      lint: combineSignalStates([
        ['oxlint', status[SignalType.OxLint]],
        ['customLint', status[SignalType.CustomLint]],
      ]),
    };

    return [{ producer: this.id, kind: 'signal-state', payload }];
  }
}

import type { PipelineContext, Recognizer, Verdict, Evidence, OutcomeChange, AdviceChange, AnyChange } from '../types.js';
import type { SignalStateEvidencePayload } from '../detectors/QualitySignalReader.js';

function readSignalState(evidence: Evidence[]): SignalStateEvidencePayload | undefined {
  const entry = evidence.find((e) => e.kind === 'signal-state');
  return entry?.payload as SignalStateEvidencePayload | undefined;
}

const SIGNAL_LABELS: Record<keyof SignalStateEvidencePayload, string> = {
  tests: 'Tests',
  types: 'Types',
  lint: 'Lint',
  build: 'Build',
};

/**
 * Keys whose failure always hard-gates the commit, regardless of
 * `ctx.allowLintErrors`. `lint` is handled separately below — it only joins
 * this set when the caller has not opted into `allowLintErrors`.
 */
const BLOCKING_KEYS: (keyof SignalStateEvidencePayload)[] = ['tests', 'types', 'build'];

/** Cap on how many individual failures get spelled out per signal, in either the blocking reason or the lint advice text. */
const MAX_ADVICE_FAILURES = 5;

/**
 * Renders up to `MAX_ADVICE_FAILURES` failures as bullet lines, with a
 * trailing "...and N more" note stating the exact count of whatever didn't
 * fit — never a silent truncation. Shared by the blocking-signal reason and
 * the lint advice message so both stay bounded regardless of how many raw
 * failures the evidence happens to carry.
 */
function formatCappedFailures(failures: string[]): string {
  const shown = failures.slice(0, MAX_ADVICE_FAILURES);
  const remaining = failures.length - shown.length;
  const lines = shown.length > 0 ? shown.map((f) => `  - ${f}`).join('\n') : '  (no detail reported)';
  const more = remaining > 0 ? `\n  ...and ${remaining} more` : '';
  return `${lines}${more}`;
}

/**
 * Single source of truth for "what did the live quality-watcher evidence
 * say", shared between this recognizer's own gating decision and
 * runCommitPipeline's `qualityGateVerifiedClean` (used to decide whether the
 * underlying `git commit` can skip pre-commit hooks — see GitCommit.ts).
 *
 * `stale` is reported separately from `failing`: a `stale` signal (see
 * SignalState) never observed an actual failure — its watcher stopped
 * producing fresh results, so its last real result is frozen and no longer
 * trustworthy. Both are treated as commit-blocking by `recognize` below, but
 * with distinct messaging: a `fail` means "here's what's broken", a `stale`
 * means "the checker itself is broken/wedged and the true state is unknown".
 *
 * `allPass` is deliberately narrower than "not failing": it's only true when
 * every signal was evidence and settled to exactly `pass`. A `running`/
 * `pending`/`stale` signal (the watcher timed out before it settled, or its
 * result can no longer be trusted — see QualityWatcher.awaitStatus's
 * maxWaitMs and its staleness guard) counts as neither failing nor
 * verified-clean, so it never blocks hook-skipping eligibility either way.
 */
export function evaluateQualitySignals(evidence: Evidence[]): {
  checked: boolean;
  failing: (keyof SignalStateEvidencePayload)[];
  stale: (keyof SignalStateEvidencePayload)[];
  allPass: boolean;
} {
  const signalState = readSignalState(evidence);
  if (!signalState) return { checked: false, failing: [], stale: [], allPass: false };

  const keys = Object.keys(SIGNAL_LABELS) as (keyof SignalStateEvidencePayload)[];
  const failing = keys.filter((key) => signalState[key].state === 'fail');
  const stale = keys.filter((key) => signalState[key].state === 'stale');
  const allPass = keys.every((key) => signalState[key].state === 'pass');

  return { checked: true, failing, stale, allPass };
}

/**
 * Where to look first for each signal's own underlying watch process/run,
 * when its `stale` reading needs a human (or an agent that's exhausted the
 * automatic recovery attempts) to dig further — see the `[STUCK WATCHER]`
 * block `recognize` builds below. Matches QualityWatcher's own runner
 * wiring (see libs/quality-watcher/src/adapters/QualityWatcher.ts) so this
 * stays a real starting point, not a guess.
 */
const STALE_INVESTIGATION_HINT: Record<keyof SignalStateEvidencePayload, string> = {
  tests: 'Look for a persistent Vitest watch instance (`startVitest({ watch: true, projects: [...] })`) — check whether it is still alive and reacting to file changes.',
  types: 'Look for a persistent `vue-tsc --watch --noEmit` subprocess — check whether it is still alive and reacting to file changes.',
  build: 'Look for a persistent Vite build watcher (`build()` with `build.watch` set) — check whether it is still alive and reacting to file changes.',
  lint: 'Lint (oxlint/custom-lint) reruns on demand when a file change invalidates its cached result — check whether that on-demand run is hung (e.g. a subprocess that never exited).',
};

/**
 * Built-in Recognizer: hard-gates the commit when the live quality-watcher
 * signal (tests/types/build, via QualitySignalReader) is reporting a
 * failure — a first-class `OutcomeChange`, per
 * docs/design/commit-check-pipeline.md "Decisions made" ("a hard gate is a
 * first-class OutcomeChange, not a special code path").
 *
 * `lint` blocks the same as tests/types/build by default. A caller can opt
 * out per-commit via `ctx.allowLintErrors` (movement commit's `options.
 * allowLintErrors`), in which case a lint failure instead surfaces as an
 * `AdviceChange` naming up to `MAX_ADVICE_FAILURES` individual failures, so
 * it's reported but doesn't block that commit. The blocking reason for
 * tests/types/build (and lint, when it's blocking) is capped the same way
 * (`formatCappedFailures`), so a signal with many failures can't blow up the
 * rejection message either.
 *
 * Distinct from RiskAnnotationRecognizer, which only escalates the risk
 * code on the same evidence: a signal already showing broken shouldn't be
 * committable at all, regardless of what risk code the tool-log heuristic
 * would otherwise assign. Runs independently of RiskAnnotationRecognizer so
 * that recognizer's risk-code semantics (including its own live-signal
 * escalation for the case where a signal recovers before the next commit)
 * are unaffected.
 *
 * No evidence present (no watcher, or nothing cached yet) never blocks —
 * matches QualitySignalReader's degrade-gracefully contract. `running`/
 * `pending` states never block either — only a settled `fail` or a `stale`
 * reading does.
 *
 * A `stale` signal (see SignalState, QualityWatcher's staleness guard)
 * blocks exactly like a `fail`, and — unlike a `fail` — does so
 * unconditionally, even for `lint` under `ctx.allowLintErrors`: that flag
 * means "I've seen the lint failures and choose to commit anyway", which
 * only makes sense when there's an actual result to accept. A `stale`
 * signal has no result to accept — its checker stopped producing fresh
 * output, so "pass" or "fail" from before the last relevant change is no
 * longer trustworthy either way. Trusting a frozen pass here is exactly the
 * silent hole this exists to close: a wedged watcher must never look
 * indistinguishable from a clean one.
 */
export class QualityGateRecognizer implements Recognizer {
  readonly id = 'quality-gate';
  readonly kind = 'deterministic' as const;

  async recognize(ctx: PipelineContext, evidence: Evidence[]): Promise<Verdict> {
    const signalState = readSignalState(evidence);
    const { failing, stale } = evaluateQualitySignals(evidence);

    if (!signalState || (failing.length === 0 && stale.length === 0)) return { changes: [] };

    const changes: AnyChange[] = [];

    const blockingKeys = ctx.allowLintErrors ? BLOCKING_KEYS : [...BLOCKING_KEYS, 'lint' as const];
    const blockingFailures = failing.filter((key) => blockingKeys.includes(key));
    // Every stale signal blocks, regardless of allowLintErrors — see the
    // class doc comment above for why lint's opt-out doesn't apply here.
    const blockingStale = stale;

    if (blockingFailures.length > 0 || blockingStale.length > 0) {
      const failureDetails = blockingFailures.map((key) => {
        const state = signalState[key];
        const failures = state.state === 'fail' ? state.failures : [];
        return `${SIGNAL_LABELS[key]}:\n${formatCappedFailures(failures)}`;
      });

      const staleDetails = blockingStale.map((key) => {
        const state = signalState[key];
        const message = state.state === 'stale' ? state.message : '(no detail reported)';
        return `${SIGNAL_LABELS[key]} [STUCK WATCHER — not a real failure, the true state is unknown]:\n  ${message}\n  Where to look: ${STALE_INVESTIGATION_HINT[key]}`;
      });

      const intro =
        blockingStale.length > 0
          ? 'Quality watcher gate failed. Some signals are broken and/or stuck — check the quality watcher (mcp__cabinet__quality_status) now. A signal marked [STUCK WATCHER] below is not a real code failure: its checker has stopped producing fresh results, so the actual pass/fail state is unknown. An automatic recovery attempt has been made — re-check quality_status in a bit; if it is still stale after a couple of retries, treat it as a broken tool (see "Where to look" for each stuck signal) rather than something you can fix by editing code, and escalate to a human if you cannot get it moving again. Any [FAILING] signals below still need their underlying issue fixed as usual.'
          : 'Quality watcher is reporting broken signals — check the quality watcher (mcp__cabinet__quality_status) and fix everything it is finding, then commit again.';

      const details = [
        ...failureDetails.map((d) => (blockingStale.length > 0 ? `[FAILING] ${d}` : d)),
        ...staleDetails,
      ].join('\n');

      const reason = [intro, details].join('\n\n');

      const outcome: OutcomeChange = { kind: 'outcome', producer: this.id, value: { accept: false, reason } };
      changes.push(outcome);
    }

    if (failing.includes('lint') && ctx.allowLintErrors) {
      const lintState = signalState.lint;
      const failures = lintState.state === 'fail' ? lintState.failures : [];

      const advice: AdviceChange = {
        kind: 'advice',
        producer: this.id,
        value: {
          message: `Lint is failing (not blocking this commit) — check the quality watcher (mcp__cabinet__quality_status) and fix it when you can:\n${formatCappedFailures(failures)}`,
          priority: 0,
        },
      };
      changes.push(advice);
    }

    return { changes };
  }
}

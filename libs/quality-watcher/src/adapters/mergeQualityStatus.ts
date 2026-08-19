/**
 * Merges QualityStatus results from multiple work repos in a wing into one.
 *
 * Per signal, priority is fail > running > pending > pass — the same
 * "worst wins" ordering QualityStatus.calculateOverallState already uses
 * for combining signals within one repo, applied here across repos:
 * - Any repo failing makes the merged signal fail (failures concatenated,
 *   each prefixed with its repo name for traceability).
 * - Otherwise, any repo still running/pending makes the merged signal that.
 * - Only pass if every repo passes.
 */

import { SignalType, type SignalState } from '../SignalState.js';
import type { QualityStatus } from '../QualityStatus.js';

export function mergeQualityStatuses(perRepo: Array<readonly [string, QualityStatus]>): QualityStatus {
  const states = Object.fromEntries(
    Object.values(SignalType).map((signalType) => [
      signalType,
      combineSignalStates(perRepo.map(([repoName, status]) => [repoName, status[signalType]] as const)),
    ])
  ) as Record<SignalType, SignalState>;

  return {
    ...states,
    aggregatedAt: new Date(),
    isPartial: Object.values(states).some((state) => state.state === 'running' || state.state === 'pending' || state.state === 'stale'),
  };
}

/** Cap on how many findings from any one source are folded into a combined SignalState (see combineSignalStates). */
const MAX_FINDINGS_PER_SOURCE = 5;

/**
 * Combines any number of labelled SignalStates into one, "worst wins":
 * fail > stale > running > pending > pass. Used both to merge one signal
 * across repos in a wing (above) and to fold multiple distinct signals into
 * one reported signal — e.g. a caller presenting OxLint + CustomLint
 * together as a single "lint" result, now that there's no standard-lint
 * signal of its own to report instead.
 *
 * The combined state reports every contributing source's own findings, not
 * just whichever source happens to be worst — e.g. if OxLint has already
 * failed while CustomLint is still mid-rerun with its own distinct partial
 * failures, both show up, not just OxLint's. Each source is capped to its
 * first 5 findings so one noisy source can't drown out another, and every
 * source that was cut off — by the cap, or because it simply hasn't
 * finished yet — gets a trailing note: an exact "+N more" count for a
 * source that has actually finished (`fail`, so its total is known), or a
 * "still running" note for one that hasn't (`running`, so there could be
 * more beyond what's visible so far) — never a silent truncation.
 *
 * `stale` sources never contribute to the failures list (they carry none by
 * design — see SignalState's doc) and are only reached when nothing is
 * failing or running: a real failure elsewhere is still worth surfacing
 * even while another source of the same combined signal is stuck, rather
 * than letting "one source is broken" hide "the other source found a real
 * problem".
 */
export function combineSignalStates(entries: Array<readonly [string, SignalState]>): SignalState {
  const latestTimestamp = entries.reduce(
    (latest, [, state]) => (state.timestamp > latest ? state.timestamp : latest),
    new Date(0)
  );

  const warnings = combineLabelled(entries, (state) => state.warnings ?? []);

  const contributing = entries.filter(
    (entry): entry is readonly [string, Extract<SignalState, { state: 'fail' | 'running' }>] =>
      entry[1].state === 'fail' || entry[1].state === 'running'
  );

  if (contributing.length > 0) {
    const overallState = contributing.some(([, state]) => state.state === 'fail') ? 'fail' : 'running';
    const failures = contributing.flatMap(([label, state]) => {
      if (state.failures.length === 0) return [];
      const shown = state.failures.slice(0, MAX_FINDINGS_PER_SOURCE).map((f) => `[${label}] ${f}`);
      if (state.state === 'running') {
        shown.push(`[${label}] still running — more findings may appear`);
      } else if (state.failures.length > MAX_FINDINGS_PER_SOURCE) {
        shown.push(`[${label}] +${state.failures.length - MAX_FINDINGS_PER_SOURCE} more finding(s)`);
      }
      return shown;
    });
    return { state: overallState, timestamp: latestTimestamp, failures, ...(warnings.length > 0 ? { warnings } : {}) };
  }

  const stale = entries.filter(
    (entry): entry is readonly [string, Extract<SignalState, { state: 'stale' }>] => entry[1].state === 'stale'
  );
  if (stale.length > 0) {
    const staleSince = stale.reduce((earliest, [, state]) => (state.staleSince < earliest ? state.staleSince : earliest), stale[0][1].staleSince);
    const message = stale.map(([label, state]) => `[${label}] ${state.message}`).join(' ');
    return { state: 'stale', timestamp: latestTimestamp, staleSince, message, ...(warnings.length > 0 ? { warnings } : {}) };
  }

  const allPass = entries.every(([, state]) => state.state === 'pass');
  if (allPass) {
    return { state: 'pass', timestamp: latestTimestamp, ...(warnings.length > 0 ? { warnings } : {}) };
  }

  return { state: 'pending', timestamp: latestTimestamp, ...(warnings.length > 0 ? { warnings } : {}) };
}

/** Same labelled, capped-per-source flattening as the failures list above, reused for warnings. */
function combineLabelled(entries: Array<readonly [string, SignalState]>, pick: (state: SignalState) => string[]): string[] {
  return entries.flatMap(([label, state]) => {
    const items = pick(state);
    if (items.length === 0) return [];
    const shown = items.slice(0, MAX_FINDINGS_PER_SOURCE).map((w) => `[${label}] ${w}`);
    if (items.length > MAX_FINDINGS_PER_SOURCE) {
      shown.push(`[${label}] +${items.length - MAX_FINDINGS_PER_SOURCE} more warning(s)`);
    }
    return shown;
  });
}

/**
 * Mirrors `WireQualityStatus`/`QualityStreamPayload` from
 * `libs/quality-watcher/src/QualityStatusWireFormat.ts` and
 * `QualityStreamPayload.ts` — the JSON shape the cabinet's
 * `/api/quality/stream` SSE endpoint pushes. Duplicated here (types only,
 * no behavior) rather than imported: `@minions/quality-watcher`'s barrel
 * pulls in node-only dependencies (`@minions/file-store`, `cross-spawn`)
 * that have no place in a browser bundle, and this package has no
 * per-module export path to pick just the wire types out of it.
 */

export type SignalType = 'tests' | 'types' | 'build' | 'oxlint' | 'customLint';

export const SIGNAL_TYPES: SignalType[] = ['tests', 'types', 'build', 'oxlint', 'customLint'];

export const SIGNAL_LABELS: Record<SignalType, string> = {
  tests: 'Tests',
  types: 'Types',
  build: 'Build',
  oxlint: 'Lint (oxlint)',
  customLint: 'Lint (custom)',
};

export type WireSignalState =
  | { state: 'pass'; timestamp: string; warnings?: string[] }
  | { state: 'fail'; timestamp: string; failures: string[]; warnings?: string[] }
  | { state: 'running'; timestamp: string; failures: string[]; warnings?: string[] }
  | { state: 'pending'; timestamp: string; warnings?: string[] }
  | { state: 'stale'; timestamp: string; staleSince: string; message: string; warnings?: string[] };

export type WireQualityStatus = Record<SignalType, WireSignalState> & {
  aggregatedAt: string;
  isPartial: boolean;
};

/** A Tier 3 whole-process emergency respawn (see `QualityWatcherProcessClient` in cabinet) — the last time the whole quality-watcher-process crashed and was auto-replaced, not necessarily an ongoing problem. */
export type QualityStreamEmergency = {
  reason: string;
  at: string;
};

export type QualityStreamPayload = {
  disabled: boolean;
  wings: Record<string, WireQualityStatus>;
  emergency?: QualityStreamEmergency;
};

/**
 * Reduces a list of states down to the single "worst" one, in the same
 * priority order as `calculateOverallState` in
 * `libs/quality-watcher/src/QualityStatus.ts`: fail > stale > running >
 * pass > pending. Used both to roll up one wing's five signals into that
 * wing's overall state, and to roll up every watched wing's overall state
 * into the panel's header badge — same ladder, different list.
 */
export function worstState(states: WireSignalState['state'][]): WireSignalState['state'] {
  if (states.includes('fail')) return 'fail';
  if (states.includes('stale')) return 'stale';
  if (states.includes('running')) return 'running';
  if (states.length > 0 && states.every((s) => s === 'pass')) return 'pass';
  return 'pending';
}

export function overallState(status: WireQualityStatus): WireSignalState['state'] {
  return worstState(SIGNAL_TYPES.map((t) => status[t].state));
}

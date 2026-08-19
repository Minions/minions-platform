/**
 * Wire payload for the cabinet's `/api/quality/stream` SSE endpoint (see
 * qq001002 in the plan). One JSON object per pushed `data:` event: every
 * currently-watched wing's quality status, wire-formatted, plus whether
 * quality watching is globally disabled (`HACK_OFF_QUALITY_CHECKS`) — in
 * which case `wings` is always empty and the UI should say so rather than
 * reading an empty map as "no wings exist".
 */
import { toWireQualityStatus, type WireQualityStatus } from './QualityStatusWireFormat.js';
import type { QualityStatus } from './QualityStatus.js';

/** A Tier 3 whole-process emergency (see `QualityWatcherProcessClient`'s doc comment) worth surfacing to whoever's watching the stream, not just the logs. */
export type QualityStreamEmergency = {
  reason: string;
  at: string;
};

export type QualityStreamPayload = {
  disabled: boolean;
  wings: Record<string, WireQualityStatus>;
  /** The most recent Tier 3 emergency respawn, if any have happened since cabinet started. Present even after the respawn has succeeded — it's "the last time this happened," not "this is currently on fire." */
  emergency?: QualityStreamEmergency;
};

/** One wing's live status, as read from its `IQualityWatcher.getStatus()`. */
export type WingQualityEntry = {
  wingName: string;
  status: QualityStatus;
};

/**
 * Builds the SSE payload from the set of currently-watched wings. Pure and
 * synchronous — callers own polling/pushing/diffing; this just shapes one
 * snapshot. When `disabled`, `entries` is ignored and `wings` comes back
 * empty, matching `quality_status`'s own disabled-flag short-circuit.
 */
export function buildQualityStreamPayload(
  entries: WingQualityEntry[],
  disabled: boolean,
  emergency?: QualityStreamEmergency
): QualityStreamPayload {
  if (disabled) return { disabled: true, wings: {}, ...(emergency ? { emergency } : {}) };
  return {
    disabled: false,
    wings: Object.fromEntries(entries.map(({ wingName, status }) => [wingName, toWireQualityStatus(status)])),
    ...(emergency ? { emergency } : {}),
  };
}

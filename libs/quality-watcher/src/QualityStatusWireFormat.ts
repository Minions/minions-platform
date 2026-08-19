/**
 * JSON wire format for `QualityStatus`/`SignalState` — the contract between
 * the quality-watcher-process (server) and cabinet's `RemoteQualityWatcher`
 * client (see docs/design/quality-watcher-process-redesign.md). Both sides
 * import these functions from this one place rather than each hand-rolling
 * their own (de)serialization, so the contract can't drift between them.
 *
 * `Date` fields become ISO strings on the wire (plain JSON has no date
 * type) and are converted back to `Date` on receipt.
 */
import { SignalType, type SignalState } from './SignalState.js';
import type { QualityStatus } from './QualityStatus.js';

export type WireSignalState =
  | { state: 'pass'; timestamp: string; warnings?: string[] }
  | { state: 'fail'; timestamp: string; failures: string[]; warnings?: string[] }
  | { state: 'running'; timestamp: string; failures: string[]; warnings?: string[] }
  | { state: 'pending'; timestamp: string; warnings?: string[] }
  | { state: 'stale'; timestamp: string; staleSince: string; message: string; warnings?: string[] };

export type WireQualityStatus = {
  [SignalType.Tests]: WireSignalState;
  [SignalType.Types]: WireSignalState;
  [SignalType.Build]: WireSignalState;
  [SignalType.OxLint]: WireSignalState;
  [SignalType.CustomLint]: WireSignalState;
  aggregatedAt: string;
  isPartial: boolean;
};

function toWireSignalState(state: SignalState): WireSignalState {
  return state.state === 'stale'
    ? { ...state, timestamp: state.timestamp.toISOString(), staleSince: state.staleSince.toISOString() }
    : { ...state, timestamp: state.timestamp.toISOString() };
}

function fromWireSignalState(wire: WireSignalState): SignalState {
  return wire.state === 'stale'
    ? { ...wire, timestamp: new Date(wire.timestamp), staleSince: new Date(wire.staleSince) }
    : { ...wire, timestamp: new Date(wire.timestamp) };
}

export function toWireQualityStatus(status: QualityStatus): WireQualityStatus {
  return {
    [SignalType.Tests]: toWireSignalState(status[SignalType.Tests]),
    [SignalType.Types]: toWireSignalState(status[SignalType.Types]),
    [SignalType.Build]: toWireSignalState(status[SignalType.Build]),
    [SignalType.OxLint]: toWireSignalState(status[SignalType.OxLint]),
    [SignalType.CustomLint]: toWireSignalState(status[SignalType.CustomLint]),
    aggregatedAt: status.aggregatedAt.toISOString(),
    isPartial: status.isPartial,
  };
}

export function fromWireQualityStatus(wire: WireQualityStatus): QualityStatus {
  return {
    [SignalType.Tests]: fromWireSignalState(wire[SignalType.Tests]),
    [SignalType.Types]: fromWireSignalState(wire[SignalType.Types]),
    [SignalType.Build]: fromWireSignalState(wire[SignalType.Build]),
    [SignalType.OxLint]: fromWireSignalState(wire[SignalType.OxLint]),
    [SignalType.CustomLint]: fromWireSignalState(wire[SignalType.CustomLint]),
    aggregatedAt: new Date(wire.aggregatedAt),
    isPartial: wire.isPartial,
  };
}

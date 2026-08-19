import { describe, it, expect } from 'vitest';
import { SignalType } from './SignalState.js';
import type { QualityStatus } from './QualityStatus.js';
import { toWireQualityStatus, fromWireQualityStatus, type WireQualityStatus } from './QualityStatusWireFormat.js';

function buildStatus(overrides: Partial<QualityStatus> = {}): QualityStatus {
  const timestamp = new Date('2026-01-01T00:00:00.000Z');
  return {
    [SignalType.Tests]: { state: 'pass', timestamp },
    [SignalType.Types]: { state: 'pass', timestamp },
    [SignalType.Build]: { state: 'pass', timestamp },
    [SignalType.OxLint]: { state: 'pass', timestamp },
    [SignalType.CustomLint]: { state: 'pass', timestamp },
    aggregatedAt: timestamp,
    isPartial: false,
    ...overrides,
  };
}

describe('QualityStatusWireFormat', () => {
  it('serializes Date fields to ISO strings', () => {
    const status = buildStatus();
    const wire = toWireQualityStatus(status);

    expect(wire[SignalType.Tests].timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(wire.aggregatedAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('round-trips pass/fail/running/pending states through JSON', () => {
    const timestamp = new Date('2026-01-01T00:00:00.000Z');
    const status = buildStatus({
      [SignalType.Tests]: { state: 'fail', timestamp, failures: ['boom'] },
      [SignalType.Types]: { state: 'running', timestamp, failures: [] },
      [SignalType.Build]: { state: 'pending', timestamp },
    });

    const roundTripped = fromWireQualityStatus(
      JSON.parse(JSON.stringify(toWireQualityStatus(status))) as WireQualityStatus,
    );

    expect(roundTripped).toEqual(status);
  });

  it('round-trips the stale state, including staleSince', () => {
    const timestamp = new Date('2026-01-01T00:05:00.000Z');
    const staleSince = new Date('2026-01-01T00:00:00.000Z');
    const status = buildStatus({
      [SignalType.Tests]: { state: 'stale', timestamp, staleSince, message: 'watcher wedged' },
    });

    const roundTripped = fromWireQualityStatus(
      JSON.parse(JSON.stringify(toWireQualityStatus(status))) as WireQualityStatus,
    );

    expect(roundTripped).toEqual(status);
  });

  it('preserves optional warnings', () => {
    const timestamp = new Date('2026-01-01T00:00:00.000Z');
    const status = buildStatus({
      [SignalType.Tests]: { state: 'pass', timestamp, warnings: ['deprecated API'] },
    });

    const roundTripped = fromWireQualityStatus(
      JSON.parse(JSON.stringify(toWireQualityStatus(status))) as WireQualityStatus,
    );

    expect(roundTripped[SignalType.Tests]).toEqual(status[SignalType.Tests]);
  });
});

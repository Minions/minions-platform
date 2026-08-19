import { describe, it, expect } from 'vitest';
import { SignalType } from './SignalState.js';
import type { QualityStatus } from './QualityStatus.js';
import { buildQualityStreamPayload } from './QualityStreamPayload.js';

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

describe('buildQualityStreamPayload', () => {
  it('wire-formats every entry, keyed by wing name', () => {
    const status = buildStatus({ [SignalType.Tests]: { state: 'fail', timestamp: new Date('2026-01-01T00:00:00.000Z'), failures: ['boom'] } });

    const payload = buildQualityStreamPayload([{ wingName: 'wing-a', status }], false);

    expect(payload.disabled).toBe(false);
    expect(Object.keys(payload.wings)).toEqual(['wing-a']);
    expect(payload.wings['wing-a'][SignalType.Tests]).toEqual({ state: 'fail', timestamp: '2026-01-01T00:00:00.000Z', failures: ['boom'] });
  });

  it('returns an empty wings map with no entries', () => {
    expect(buildQualityStreamPayload([], false)).toEqual({ disabled: false, wings: {} });
  });

  it('ignores entries and reports disabled when quality watching is off', () => {
    const payload = buildQualityStreamPayload([{ wingName: 'wing-a', status: buildStatus() }], true);

    expect(payload).toEqual({ disabled: true, wings: {} });
  });

  it('omits emergency entirely when none was passed', () => {
    const payload = buildQualityStreamPayload([], false);
    expect(payload).not.toHaveProperty('emergency');
  });

  it('includes the emergency record when one is passed, alongside normal wing data', () => {
    const payload = buildQualityStreamPayload(
      [{ wingName: 'wing-a', status: buildStatus() }],
      false,
      { reason: 'crash', at: '2026-01-01T00:00:00.000Z' }
    );

    expect(payload.emergency).toEqual({ reason: 'crash', at: '2026-01-01T00:00:00.000Z' });
    expect(Object.keys(payload.wings)).toEqual(['wing-a']);
  });

  it('still includes the emergency record when quality watching is disabled', () => {
    const payload = buildQualityStreamPayload([], true, { reason: 'crash', at: '2026-01-01T00:00:00.000Z' });
    expect(payload).toEqual({ disabled: true, wings: {}, emergency: { reason: 'crash', at: '2026-01-01T00:00:00.000Z' } });
  });
});

import { describe, it, expect } from 'vitest';
import { overallState, type SignalType, type WireQualityStatus, type WireSignalState } from './quality';

function buildStatus(overrides: Partial<Record<SignalType, WireSignalState>> = {}): WireQualityStatus {
  const timestamp = '2026-01-01T00:00:00.000Z';
  const pass: WireSignalState = { state: 'pass', timestamp };
  return {
    tests: pass,
    types: pass,
    build: pass,
    oxlint: pass,
    customLint: pass,
    aggregatedAt: timestamp,
    isPartial: false,
    ...overrides,
  };
}

describe('overallState', () => {
  it('is pass when every signal passes', () => {
    expect(overallState(buildStatus())).toBe('pass');
  });

  it('is fail when any signal fails, even alongside a running one', () => {
    const status = buildStatus({
      tests: { state: 'fail', timestamp: '2026-01-01T00:00:00.000Z', failures: ['boom'] },
      types: { state: 'running', timestamp: '2026-01-01T00:00:00.000Z', failures: [] },
    });
    expect(overallState(status)).toBe('fail');
  });

  it('is stale when a signal is stale and none are failing', () => {
    const status = buildStatus({
      build: { state: 'stale', timestamp: '2026-01-01T00:00:00.000Z', staleSince: '2025-12-31T00:00:00.000Z', message: 'wedged' },
    });
    expect(overallState(status)).toBe('stale');
  });

  it('is running when a signal is running and none are failing or stale', () => {
    const status = buildStatus({
      oxlint: { state: 'running', timestamp: '2026-01-01T00:00:00.000Z', failures: [] },
    });
    expect(overallState(status)).toBe('running');
  });

  it('is pending when every signal is pending', () => {
    const pending: WireSignalState = { state: 'pending', timestamp: '2026-01-01T00:00:00.000Z' };
    const status = buildStatus({ tests: pending, types: pending, build: pending, oxlint: pending, customLint: pending });
    expect(overallState(status)).toBe('pending');
  });
});

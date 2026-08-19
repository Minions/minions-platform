import { describe, it, expect } from 'vitest';
import { mergeQualityStatuses, combineSignalStates } from './mergeQualityStatus.js';
import { SignalType } from '../SignalState.js';
import type { QualityStatus } from '../QualityStatus.js';

function statusWith(overrides: Partial<QualityStatus>): QualityStatus {
  const now = new Date();
  return {
    [SignalType.Tests]: { state: 'pass', timestamp: now },
    [SignalType.Types]: { state: 'pass', timestamp: now },
    [SignalType.Build]: { state: 'pending', timestamp: now },
    [SignalType.OxLint]: { state: 'pass', timestamp: now  },
    [SignalType.CustomLint]: { state: 'pass', timestamp: now  },
    aggregatedAt: now,
    isPartial: false,
    ...overrides,
  };
}

describe('mergeQualityStatuses', () => {
  it('merges a single repo status unchanged', () => {
    const now = new Date();
    const status = statusWith({ [SignalType.Build]: { state: 'pass', timestamp: now } });
    const merged = mergeQualityStatuses([['local', status]]);

    expect(merged[SignalType.Tests].state).toBe('pass');
    expect(merged[SignalType.Build].state).toBe('pass');
    expect(merged.isPartial).toBe(false);
  });

  it('fail beats everything: any repo failing makes the merged signal fail', () => {
    const now = new Date();
    const passing = statusWith({});
    const failing = statusWith({
      [SignalType.Tests]: { state: 'fail', timestamp: now, failures: ['broke'] },
    });

    const merged = mergeQualityStatuses([
      ['local', passing],
      ['other', failing],
    ]);

    expect(merged[SignalType.Tests].state).toBe('fail');
    if (merged[SignalType.Tests].state === 'fail') {
      expect(merged[SignalType.Tests].failures).toEqual(['[other] broke']);
    }
  });

  it('running beats pass/pending when nothing has failed', () => {
    const now = new Date();
    const passing = statusWith({});
    const running = statusWith({
      [SignalType.OxLint]: { state: 'running', timestamp: now, failures: [] },
    });

    const merged = mergeQualityStatuses([
      ['local', passing],
      ['other', running],
    ]);

    expect(merged[SignalType.OxLint].state).toBe('running');
    expect(merged.isPartial).toBe(true);
  });

  it('requires every repo to pass for the merged signal to be pass', () => {
    const now = new Date();
    const passing = statusWith({});
    const pending = statusWith({
      [SignalType.Types]: { state: 'pending', timestamp: now },
    });

    const merged = mergeQualityStatuses([
      ['local', passing],
      ['other', pending],
    ]);

    expect(merged[SignalType.Types].state).toBe('pending');
  });

  it('concatenates failures from multiple failing repos, prefixed by repo name', () => {
    const now = new Date();
    const a = statusWith({
      [SignalType.Build]: { state: 'fail', timestamp: now, failures: ['a broke'] },
      [SignalType.OxLint]: { state: 'pass', timestamp: now },
      [SignalType.CustomLint]: { state: 'pass', timestamp: now },
    });
    const b = statusWith({
      [SignalType.Build]: { state: 'fail', timestamp: now, failures: ['b broke 1', 'b broke 2'] },
      [SignalType.OxLint]: { state: 'pass', timestamp: now },
      [SignalType.CustomLint]: { state: 'pass', timestamp: now },
    });

    const merged = mergeQualityStatuses([
      ['repo-a', a],
      ['repo-b', b],
    ]);

    expect(merged[SignalType.Build].state).toBe('fail');
    if (merged[SignalType.Build].state === 'fail') {
      expect(merged[SignalType.Build].failures).toEqual(['[repo-a] a broke', '[repo-b] b broke 1', '[repo-b] b broke 2']);
    }
  });

  it('isPartial is true if any merged signal ends up running or pending', () => {
    const now = new Date();
    const merged = mergeQualityStatuses([
      ['local', statusWith({ [SignalType.Build]: { state: 'pass', timestamp: now } })],
      ['other', statusWith({ [SignalType.Types]: { state: 'running', timestamp: now, failures: [] }, [SignalType.Build]: { state: 'pass', timestamp: now } })],
    ]);

    expect(merged.isPartial).toBe(true);
  });

  it('isPartial is true if any merged signal ends up stale', () => {
    const now = new Date();
    const merged = mergeQualityStatuses([
      ['local', statusWith({ [SignalType.Build]: { state: 'pass', timestamp: now } })],
      [
        'other',
        statusWith({
          [SignalType.Types]: { state: 'stale', timestamp: now, staleSince: now, message: 'wedged' },
          [SignalType.Build]: { state: 'pass', timestamp: now },
        }),
      ],
    ]);

    expect(merged.isPartial).toBe(true);
  });
});

describe('combineSignalStates', () => {
  const now = new Date();

  it('reports findings from every failing source, not just one', () => {
    const combined = combineSignalStates([
      ['oxlint', { state: 'fail', timestamp: now, failures: ['unused var'] }],
      ['customLint', { state: 'fail', timestamp: now, failures: ['boundary violation'] }],
    ]);

    expect(combined.state).toBe('fail');
    if (combined.state === 'fail') {
      expect(combined.failures).toEqual(['[oxlint] unused var', '[customLint] boundary violation']);
    }
  });

  it('caps each source to its first 5 findings, with an exact +N-more count, so one noisy source cannot drown out another', () => {
    const manyFindings = Array.from({ length: 8 }, (_, i) => `finding ${i}`);
    const combined = combineSignalStates([
      ['oxlint', { state: 'fail', timestamp: now, failures: manyFindings }],
      ['customLint', { state: 'fail', timestamp: now, failures: ['boundary violation'] }],
    ]);

    expect(combined.state).toBe('fail');
    if (combined.state === 'fail') {
      expect(combined.failures).toEqual([
        '[oxlint] finding 0',
        '[oxlint] finding 1',
        '[oxlint] finding 2',
        '[oxlint] finding 3',
        '[oxlint] finding 4',
        '[oxlint] +3 more finding(s)',
        '[customLint] boundary violation',
      ]);
    }
  });

  it('notes a still-running source instead of a hard count, since its total is not known yet', () => {
    const combined = combineSignalStates([
      ['oxlint', { state: 'fail', timestamp: now, failures: ['boundary violation'] }],
      ['customLint', { state: 'running', timestamp: now, failures: ['partial finding'] }],
    ]);

    expect(combined.state).toBe('fail'); // fail still wins overall
    if (combined.state === 'fail') {
      expect(combined.failures).toEqual([
        '[oxlint] boundary violation',
        '[customLint] partial finding',
        '[customLint] still running — more findings may appear',
      ]);
    }
  });

  it('adds no trailer for a source with no findings at all, running or not', () => {
    const combined = combineSignalStates([
      ['oxlint', { state: 'fail', timestamp: now, failures: ['boundary violation'] }],
      ['customLint', { state: 'running', timestamp: now, failures: [] }],
    ]);

    if (combined.state === 'fail') {
      expect(combined.failures).toEqual(['[oxlint] boundary violation']);
    }
  });

  it('reports pass only when every source passes', () => {
    const combined = combineSignalStates([
      ['oxlint', { state: 'pass', timestamp: now }],
      ['customLint', { state: 'pass', timestamp: now }],
    ]);

    expect(combined.state).toBe('pass');
  });

  it('unions warnings from every source, labelled, even when every source passes', () => {
    const combined = combineSignalStates([
      ['libs/a', { state: 'pass', timestamp: now, warnings: ['deprecated option'] }],
      ['apps/b', { state: 'pass', timestamp: now, warnings: ['punycode deprecated'] }],
    ]);

    expect(combined.state).toBe('pass');
    expect(combined.warnings).toEqual(['[libs/a] deprecated option', '[apps/b] punycode deprecated']);
  });

  it('omits warnings entirely when no source reported any', () => {
    const combined = combineSignalStates([
      ['oxlint', { state: 'pass', timestamp: now }],
      ['customLint', { state: 'pass', timestamp: now }],
    ]);

    expect(combined.warnings).toBeUndefined();
  });

  it('reports stale when one source is stale and the other passes — a broken source is not hidden by a clean one', () => {
    const staleSince = new Date(now.getTime() - 60_000);
    const combined = combineSignalStates([
      ['oxlint', { state: 'pass', timestamp: now }],
      ['customLint', { state: 'stale', timestamp: now, staleSince, message: 'customLint is stuck' }],
    ]);

    expect(combined.state).toBe('stale');
    if (combined.state === 'stale') {
      expect(combined.staleSince).toEqual(staleSince);
      expect(combined.message).toContain('[customLint] customLint is stuck');
    }
  });

  it('still reports fail when one source fails, even while the other is stale — a real failure is never hidden by a broken sibling', () => {
    const combined = combineSignalStates([
      ['oxlint', { state: 'fail', timestamp: now, failures: ['unused var'] }],
      ['customLint', { state: 'stale', timestamp: now, staleSince: now, message: 'customLint is stuck' }],
    ]);

    expect(combined.state).toBe('fail');
    if (combined.state === 'fail') {
      expect(combined.failures).toEqual(['[oxlint] unused var']);
    }
  });

  it('picks the earliest staleSince across multiple stale sources', () => {
    const earlier = new Date(now.getTime() - 120_000);
    const later = new Date(now.getTime() - 30_000);
    const combined = combineSignalStates([
      ['a', { state: 'stale', timestamp: now, staleSince: later, message: 'a is stuck' }],
      ['b', { state: 'stale', timestamp: now, staleSince: earlier, message: 'b is stuck' }],
    ]);

    expect(combined.state).toBe('stale');
    if (combined.state === 'stale') {
      expect(combined.staleSince).toEqual(earlier);
    }
  });
});

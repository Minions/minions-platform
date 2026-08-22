import { describe, it, expect, vi } from 'vitest';
import { SignalType, allPendingQualityStatus, type QualityStatus, type IQualityWatcher } from '@minions/quality-watcher';
import { QualityWedgeBackstop, findStuckSignals } from './QualityWedgeBackstop.js';

function statusWith(overrides: Partial<Record<SignalType, QualityStatus[SignalType]>>, now: Date): QualityStatus {
  return { ...allPendingQualityStatus(now), ...overrides };
}

/**
 * A minimal `IQualityWatcher` that supports `pause`/`resume` — the
 * structural marker `QualityWedgeBackstop` uses to tell a watcher whose real
 * state lives in another process (what `RemoteQualityWatcher` is, in
 * production) apart from one that doesn't (the old in-process
 * `WingQualityWatcher`). `awaitStatus`/`getStatus` both just return whatever
 * `status` was constructed with, standing in for a real HTTP round trip.
 */
function makeRemoteLikeWatcher(wingName: string, status: QualityStatus): IQualityWatcher {
  return {
    wingName,
    start: async () => undefined,
    stop: async () => undefined,
    pause: async () => undefined,
    resume: async () => undefined,
    isRunning: () => true,
    getStatus: () => status,
    awaitStatus: async () => status,
  };
}

describe('findStuckSignals', () => {
  it('flags a running signal whose timestamp is older than the stale bound', () => {
    const now = new Date('2026-01-01T00:02:00Z');
    const status = statusWith({ [SignalType.Tests]: { state: 'running', timestamp: new Date('2026-01-01T00:00:00Z'), failures: [] } }, now);

    const stuck = findStuckSignals([['wing-a', status]], now, 60_000);

    expect(stuck).toEqual([{ wingName: 'wing-a', signalType: SignalType.Tests }]);
  });

  it('does not flag a running signal within the stale bound', () => {
    const now = new Date('2026-01-01T00:00:30Z');
    const status = statusWith({ [SignalType.Tests]: { state: 'running', timestamp: new Date('2026-01-01T00:00:00Z'), failures: [] } }, now);

    expect(findStuckSignals([['wing-a', status]], now, 60_000)).toEqual([]);
  });

  it('does not flag pass/fail/stale signals — only running/pending can look stuck this way', () => {
    const now = new Date('2026-01-01T01:00:00Z');
    const stale = new Date('2020-01-01T00:00:00Z');
    const status = statusWith(
      {
        [SignalType.Tests]: { state: 'pass', timestamp: stale },
        [SignalType.Types]: { state: 'fail', timestamp: stale, failures: ['x'] },
        [SignalType.Build]: { state: 'stale', timestamp: now, staleSince: stale, message: 'already wedged' },
      },
      now,
    );

    expect(findStuckSignals([['wing-a', status]], now, 60_000)).toEqual([]);
  });

  it('flags a pending signal that never got picked up', () => {
    const now = new Date('2026-01-01T00:05:00Z');
    const status = statusWith({ [SignalType.OxLint]: { state: 'pending', timestamp: new Date('2026-01-01T00:00:00Z') } }, now);

    expect(findStuckSignals([['wing-a', status]], now, 60_000)).toEqual([{ wingName: 'wing-a', signalType: SignalType.OxLint }]);
  });

  it('checks every wing independently', () => {
    const now = new Date('2026-01-01T00:02:00Z');
    const stuckStatus = statusWith({ [SignalType.Tests]: { state: 'running', timestamp: new Date('2026-01-01T00:00:00Z'), failures: [] } }, now);
    const healthyStatus = statusWith({ [SignalType.Tests]: { state: 'pass', timestamp: now } }, now);

    expect(findStuckSignals([['wing-a', stuckStatus], ['wing-b', healthyStatus]], now, 60_000)).toEqual([
      { wingName: 'wing-a', signalType: SignalType.Tests },
    ]);
  });
});

function fakeFetch(handler: (url: string, init?: RequestInit) => { ok: boolean; status: number; body: unknown }): typeof fetch {
  return vi.fn((url: string, init?: RequestInit) => {
    const { ok, status, body } = handler(url, init);
    return Promise.resolve({ ok, status, json: () => Promise.resolve(body) } as Response);
  }) as unknown as typeof fetch;
}

describe('QualityWedgeBackstop', () => {
  it('check() refreshes every running remote-like watcher and sends /unwedge for each stuck signal it finds', async () => {
    const now = new Date('2026-01-01T00:02:00Z');
    const stuckStatus = statusWith({ [SignalType.Tests]: { state: 'running', timestamp: new Date('2026-01-01T00:00:00Z'), failures: [] } }, now);
    const unwedgeCalls: Array<{ url: string; body: unknown }> = [];
    const watcher = makeRemoteLikeWatcher('wing-a', stuckStatus);
    const backstopFetch = fakeFetch((url, init) => {
      unwedgeCalls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      return { ok: true, status: 200, body: { ok: true, results: [] } };
    });
    const watchers = new Map<string, IQualityWatcher>([['wing-a', watcher]]);

    const backstop = new QualityWedgeBackstop(() => watchers, async () => 'http://127.0.0.1:2222', backstopFetch, 60_000);
    await backstop.check(now);

    expect(unwedgeCalls).toEqual([{ url: 'http://127.0.0.1:2222/unwedge', body: { wing: 'wing-a', signalType: SignalType.Tests } }]);
  });

  it('never calls /unwedge when nothing looks stuck — no wasted requests', async () => {
    const now = new Date('2026-01-01T00:00:05Z');
    const watcher = makeRemoteLikeWatcher('wing-a', allPendingQualityStatus(now));
    const getBaseUrl = vi.fn(async () => 'http://127.0.0.1:2222');
    const backstopFetch = vi.fn();
    const watchers = new Map<string, IQualityWatcher>([['wing-a', watcher]]);

    const backstop = new QualityWedgeBackstop(() => watchers, getBaseUrl, backstopFetch as unknown as typeof fetch, 60_000);
    await backstop.check(now);

    expect(backstopFetch).not.toHaveBeenCalled();
    // The base URL is only resolved (and the watcher process only spawned)
    // once there's actually something to report — no reason to wake it just
    // to find nothing wrong.
    expect(getBaseUrl).not.toHaveBeenCalled();
  });

  it('ignores watchers that are not a running RemoteQualityWatcher — the old in-process WingQualityWatcher, or a cooled-down wing', async () => {
    const notRemote: IQualityWatcher = {
      wingName: 'wing-b',
      start: async () => undefined,
      stop: async () => undefined,
      getStatus: () => allPendingQualityStatus(new Date()),
      isRunning: () => true,
      awaitStatus: async () => allPendingQualityStatus(new Date()),
    };
    const backstopFetch = vi.fn();
    const watchers = new Map<string, IQualityWatcher>([['wing-b', notRemote]]);

    const backstop = new QualityWedgeBackstop(() => watchers, async () => 'http://127.0.0.1:2222', backstopFetch as unknown as typeof fetch, 60_000);
    await backstop.check(new Date());

    expect(backstopFetch).not.toHaveBeenCalled();
  });
});

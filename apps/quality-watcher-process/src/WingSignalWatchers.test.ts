import { describe, it, expect, vi } from 'vitest';
import { EventBus, type IEventBus } from '@minions/events';
import { SignalType, SignalWedgeMonitor, type ISignalRunner, type SignalState } from '@minions/quality-watcher';
import { WingSignalWatchers, type RunnerFactory } from './WingSignalWatchers.js';
import { RepoFileChangeTracker } from './RepoFileChangeTracker.js';

/** A fake ISignalRunner whose state/pause/resume/start/stop/ensureFresh calls this test can inspect and control directly — no real Vitest involved. */
function fakeRunner(signalType: SignalType = SignalType.Tests): ISignalRunner & {
  setState: (state: SignalState) => void;
  startCalls: () => number;
  stopCalls: () => number;
  pauseCalls: () => number;
  resumeCalls: () => number;
  ensureFreshCalls: () => number;
} {
  let state: SignalState = { state: 'pending', timestamp: new Date() };
  let startCalls = 0;
  let stopCalls = 0;
  let pauseCalls = 0;
  let resumeCalls = 0;
  let ensureFreshCalls = 0;
  return {
    signalType,
    strategy: 'watch-mode',
    start: async () => { startCalls += 1; },
    stop: async () => { stopCalls += 1; },
    getState: () => state,
    pause: async () => { pauseCalls += 1; },
    resume: async () => { resumeCalls += 1; },
    ensureFresh: () => { ensureFreshCalls += 1; },
    setState: (s) => { state = s; },
    startCalls: () => startCalls,
    stopCalls: () => stopCalls,
    pauseCalls: () => pauseCalls,
    resumeCalls: () => resumeCalls,
    ensureFreshCalls: () => ensureFreshCalls,
  };
}

/** A fake Tests-signal runner with hasRunFile() support, for checkNewTestFileArrivals() tests. */
function fakeVitestLikeRunner(): ISignalRunner & {
  setState: (state: SignalState) => void;
  setRunFiles: (paths: string[]) => void;
  startCalls: () => number;
  stopCalls: () => number;
} {
  let state: SignalState = { state: 'pending', timestamp: new Date() };
  let runFiles = new Set<string>();
  let startCalls = 0;
  let stopCalls = 0;
  return {
    signalType: SignalType.Tests,
    strategy: 'watch-mode',
    start: async () => { startCalls += 1; },
    stop: async () => { stopCalls += 1; },
    getState: () => state,
    hasRunFile: (absPath: string) => runFiles.has(absPath),
    setState: (s) => { state = s; },
    setRunFiles: (paths: string[]) => { runFiles = new Set(paths); },
    startCalls: () => startCalls,
    stopCalls: () => stopCalls,
  };
}

/** A fake ISignalRunner with no pause/resume at all — exercises the "capability absent" skip path. */
function fakeRunnerWithoutPauseResume(signalType: SignalType): ISignalRunner {
  return {
    signalType,
    strategy: 'watch-mode',
    start: async () => undefined,
    stop: async () => undefined,
    getState: () => ({ state: 'pending', timestamp: new Date() }),
  };
}

/** A fake RepoFileChangeTracker whose `lastRelevantChangeAt()`/test-file arrivals a test controls directly — no real fs.watch involved. */
function fakeChangeTracker(): RepoFileChangeTracker & {
  setLastChangeAt: (d: Date | null) => void;
  setTestFileArrival: (absPath: string, seenAt: Date) => void;
} {
  let lastChangeAt: Date | null = null;
  const arrivals = new Map<string, Date>();
  return {
    lastRelevantChangeAt: () => lastChangeAt,
    close: () => undefined,
    pendingTestFileArrivals: () => arrivals,
    clearTestFileArrival: (absPath: string) => { arrivals.delete(absPath); },
    clearAllTestFileArrivals: () => { arrivals.clear(); },
    setLastChangeAt: (d: Date | null) => { lastChangeAt = d; },
    setTestFileArrival: (absPath: string, seenAt: Date) => { arrivals.set(absPath, seenAt); },
  } as unknown as RepoFileChangeTracker & { setLastChangeAt: (d: Date | null) => void; setTestFileArrival: (absPath: string, seenAt: Date) => void };
}

/** A fake SignalWedgeMonitor whose wedgeInfo() a test controls directly — no real check() timing involved. */
function fakeWedgeMonitor(): SignalWedgeMonitor & { setWedged: (signalType: SignalType, info: { wedgedSince: Date } | undefined) => void } {
  const wedged = new Map<SignalType, { wedgedSince: Date }>();
  return {
    check: async () => undefined,
    isWedged: (signalType: SignalType) => wedged.has(signalType),
    wedgedSignals: () => Array.from(wedged.keys()),
    wedgeInfo: (signalType: SignalType) => wedged.get(signalType),
    trendingWarning: () => undefined,
    setWedged: (signalType: SignalType, info: { wedgedSince: Date } | undefined) => {
      if (info) wedged.set(signalType, info); else wedged.delete(signalType);
    },
  } as unknown as SignalWedgeMonitor & { setWedged: (signalType: SignalType, info: { wedgedSince: Date } | undefined) => void };
}

function watchersWithFakeRunners(
  runnersByRepo: Record<string, ISignalRunner[]>,
  opts: {
    changeTrackersByRepo?: Record<string, RepoFileChangeTracker>;
    wedgeMonitor?: SignalWedgeMonitor;
    sleep?: (ms: number) => Promise<void>;
    testFileArrivalVerifyMs?: number;
  } = {}
): { watchers: WingSignalWatchers; factory: ReturnType<typeof vi.fn> } {
  const factory = vi.fn<RunnerFactory>((repoPath) => runnersByRepo[repoPath] ?? []);
  const createWedgeMonitor = (bus: IEventBus) => opts.wedgeMonitor ?? new SignalWedgeMonitor(bus);
  const createChangeTracker = (repoPath: string) => opts.changeTrackersByRepo?.[repoPath] ?? fakeChangeTracker();
  const args: ConstructorParameters<typeof WingSignalWatchers> = [new EventBus(), factory, createWedgeMonitor, createChangeTracker];
  if (opts.sleep || opts.testFileArrivalVerifyMs !== undefined) {
    args.push(opts.sleep ?? (() => Promise.resolve()));
  }
  if (opts.testFileArrivalVerifyMs !== undefined) args.push(opts.testFileArrivalVerifyMs);
  return { watchers: new WingSignalWatchers(...args), factory };
}

describe('WingSignalWatchers', () => {
  it('reports all-pending status before start()', () => {
    const { watchers } = watchersWithFakeRunners({});
    const status = watchers.getStatus();
    expect(status[SignalType.Tests].state).toBe('pending');
    expect(watchers.isRunning()).toBe(false);
  });

  it('start() creates and starts one runner set per repo path', async () => {
    const testsA = fakeRunner();
    const testsB = fakeRunner();
    const { watchers, factory } = watchersWithFakeRunners({
      '/repo/a': [testsA],
      '/repo/b': [testsB],
    });

    await watchers.start({ local: '/repo/a', global: '/repo/b' });

    expect(factory).toHaveBeenCalledWith('/repo/a', expect.anything());
    expect(factory).toHaveBeenCalledWith('/repo/b', expect.anything());
    expect(testsA.startCalls()).toBe(1);
    expect(testsB.startCalls()).toBe(1);
    expect(watchers.isRunning()).toBe(true);
  });

  it('start() is idempotent per repo alias — a second call with the same repoPaths does not re-create or re-start runners', async () => {
    const tests = fakeRunner();
    const { watchers, factory } = watchersWithFakeRunners({ '/repo/a': [tests] });

    await watchers.start({ local: '/repo/a' });
    await watchers.start({ local: '/repo/a' });

    expect(factory).toHaveBeenCalledTimes(1);
    expect(tests.startCalls()).toBe(1);
  });

  it('getStatus() reflects the worst Tests state across repos', async () => {
    const passing = fakeRunner();
    passing.setState({ state: 'pass', timestamp: new Date() });
    const failing = fakeRunner();
    failing.setState({ state: 'fail', timestamp: new Date(), failures: ['boom'] });
    const { watchers } = watchersWithFakeRunners({ '/repo/a': [passing], '/repo/b': [failing] });
    await watchers.start({ local: '/repo/a', global: '/repo/b' });

    const status = watchers.getStatus();

    expect(status[SignalType.Tests].state).toBe('fail');
    expect(status[SignalType.Types].state).toBe('pending');
  });

  it('getStatus() reports each signal a repo has a runner for, independently, when a repo has Tests, Types, and Build runners', async () => {
    const tests = fakeRunner(SignalType.Tests);
    tests.setState({ state: 'pass', timestamp: new Date() });
    const types = fakeRunner(SignalType.Types);
    types.setState({ state: 'fail', timestamp: new Date(), failures: ['type error'] });
    const build = fakeRunner(SignalType.Build);
    build.setState({ state: 'running', timestamp: new Date(), failures: [] });
    const { watchers } = watchersWithFakeRunners({ '/repo/a': [tests, types, build] });
    await watchers.start({ local: '/repo/a' });

    const status = watchers.getStatus();

    expect(status[SignalType.Tests].state).toBe('pass');
    expect(status[SignalType.Types].state).toBe('fail');
    expect(status[SignalType.Build].state).toBe('running');
    expect(status[SignalType.OxLint].state).toBe('pending');
  });

  it('getStatus() calls ensureFresh() on every runner, so a FileTriggeredSignalRunner (OxLint/CustomLint) actually launches', async () => {
    const oxlint = fakeRunner(SignalType.OxLint);
    const { watchers } = watchersWithFakeRunners({ '/repo/a': [oxlint] });
    await watchers.start({ local: '/repo/a' });

    expect(oxlint.ensureFreshCalls()).toBe(0);
    watchers.getStatus();
    expect(oxlint.ensureFreshCalls()).toBe(1);
    watchers.getStatus();
    expect(oxlint.ensureFreshCalls()).toBe(2);
  });

  it('getStatus() reports stale (not the runner\'s own frozen state) for a signal its repo\'s SignalWedgeMonitor currently considers wedged', async () => {
    const tests = fakeRunner(SignalType.Tests);
    tests.setState({ state: 'pass', timestamp: new Date('2020-01-01T00:00:00Z') });
    const monitor = fakeWedgeMonitor();
    const { watchers } = watchersWithFakeRunners({ '/repo/a': [tests] }, { wedgeMonitor: monitor });
    await watchers.start({ local: '/repo/a' });

    expect(watchers.getStatus()[SignalType.Tests].state).toBe('pass');

    const wedgedSince = new Date('2026-01-01T00:00:00Z');
    monitor.setWedged(SignalType.Tests, { wedgedSince });

    const status = watchers.getStatus();
    expect(status[SignalType.Tests].state).toBe('stale');
    if (status[SignalType.Tests].state === 'stale') {
      expect(status[SignalType.Tests].staleSince).toEqual(wedgedSince);
      expect(status[SignalType.Tests].message).toContain('tests');
    }

    monitor.setWedged(SignalType.Tests, undefined);
    expect(watchers.getStatus()[SignalType.Tests].state).toBe('pass');
  });

  it('getStatus() folds a trending-toward-wedged warning into a watch-mode signal\'s state, using the tightened staleGraceMs override', async () => {
    const changeAt = new Date('2026-01-01T00:00:00Z');
    const tests = fakeRunner(SignalType.Tests);
    tests.setState({ state: 'pass', timestamp: changeAt });
    const tracker = fakeChangeTracker();
    tracker.setLastChangeAt(changeAt);
    const { watchers } = watchersWithFakeRunners({ '/repo/a': [tests] }, { changeTrackersByRepo: { '/repo/a': tracker } });
    await watchers.start({ local: '/repo/a' });

    // 2s frozen — past 50% of the 3s watch-mode staleGraceMs override, but
    // not yet wedged (that needs checkForWedges() to actually run, and to
    // cross the full 3s).
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
    try {
      const status = watchers.getStatus();
      expect(status[SignalType.Tests].state).toBe('pass');
      expect(status[SignalType.Tests].warnings?.[0]).toContain('tests');
    } finally {
      vi.useRealTimers();
    }
  });

  it('pause()/resume() fan out to every repo\'s runners', async () => {
    const a = fakeRunner();
    const b = fakeRunner();
    const { watchers } = watchersWithFakeRunners({ '/repo/a': [a], '/repo/b': [b] });
    await watchers.start({ local: '/repo/a', global: '/repo/b' });

    await watchers.pause();
    expect(a.pauseCalls()).toBe(1);
    expect(b.pauseCalls()).toBe(1);

    await watchers.resume();
    expect(a.resumeCalls()).toBe(1);
    expect(b.resumeCalls()).toBe(1);
  });

  it('pause()/resume() silently skip a runner that does not support the capability', async () => {
    const noPause = fakeRunnerWithoutPauseResume(SignalType.Tests);
    const { watchers } = watchersWithFakeRunners({ '/repo/a': [noPause] });
    await watchers.start({ local: '/repo/a' });

    await expect(watchers.pause()).resolves.toBeUndefined();
    await expect(watchers.resume()).resolves.toBeUndefined();
  });

  it('stop() stops every runner and clears repo state, so a later start() re-creates fresh runners', async () => {
    const tests = fakeRunner();
    const { watchers, factory } = watchersWithFakeRunners({ '/repo/a': [tests] });
    await watchers.start({ local: '/repo/a' });

    await watchers.stop();

    expect(tests.stopCalls()).toBe(1);
    expect(watchers.isRunning()).toBe(false);

    await watchers.start({ local: '/repo/a' });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  /** All five signal types, each already 'pass' — the Tests one returned separately so a test can flip its own state without affecting the others. */
  function allPassRunners(): { tests: ReturnType<typeof fakeRunner>; all: ISignalRunner[] } {
    const tests = fakeRunner(SignalType.Tests);
    tests.setState({ state: 'pass', timestamp: new Date() });
    const others = [SignalType.Types, SignalType.Build, SignalType.OxLint, SignalType.CustomLint].map((signalType) => {
      const r = fakeRunner(signalType);
      r.setState({ state: 'pass', timestamp: new Date() });
      return r;
    });
    return { tests, all: [tests, ...others] };
  }

  describe('awaitStatus', () => {
    it('resolves immediately (no sleep) when nothing is partial', async () => {
      const { all } = allPassRunners();
      const sleep = vi.fn(async () => undefined);
      const { watchers } = watchersWithFakeRunners({ '/repo/a': all }, { sleep });
      await watchers.start({ local: '/repo/a' });

      const status = await watchers.awaitStatus(1000);

      expect(status[SignalType.Tests].state).toBe('pass');
      expect(sleep).not.toHaveBeenCalled();
    });

    it('polls until the signal settles, then returns the settled result', async () => {
      const { tests, all } = allPassRunners();
      tests.setState({ state: 'running', timestamp: new Date(), failures: [] });
      let pollCount = 0;
      const sleep = vi.fn(async () => {
        pollCount += 1;
        if (pollCount === 2) tests.setState({ state: 'pass', timestamp: new Date() });
      });
      const { watchers } = watchersWithFakeRunners({ '/repo/a': all }, { sleep });
      await watchers.start({ local: '/repo/a' });

      const status = await watchers.awaitStatus(1000);

      expect(status[SignalType.Tests].state).toBe('pass');
      expect(sleep).toHaveBeenCalledTimes(2);
    });

    it('gives up at the deadline and returns whatever the last read was, still partial', async () => {
      const tests = fakeRunner(SignalType.Tests);
      tests.setState({ state: 'running', timestamp: new Date(), failures: [] });
      // A real (short) sleep — the signal never settles, so this proves the
      // loop actually respects a real wall-clock deadline rather than
      // spinning forever.
      const { watchers } = watchersWithFakeRunners({ '/repo/a': [tests] });
      await watchers.start({ local: '/repo/a' });

      const status = await watchers.awaitStatus(30);

      expect(status.isPartial).toBe(true);
      expect(status[SignalType.Tests].state).toBe('running');
    });

    it('with no repos started, resolves immediately to the all-pending placeholder without ever sleeping', async () => {
      const sleep = vi.fn(async () => undefined);
      const { watchers } = watchersWithFakeRunners({}, { sleep });

      const status = await watchers.awaitStatus(1000);

      expect(status[SignalType.Tests].state).toBe('pending');
      expect(sleep).not.toHaveBeenCalled();
    });
  });

  describe('checkNewTestFileArrivals (via getStatus())', () => {
    it('does nothing when there are no pending arrivals', () => {
      const tests = fakeVitestLikeRunner();
      tests.setState({ state: 'pass', timestamp: new Date() });
      const { watchers } = watchersWithFakeRunners({ '/repo/a': [tests] });
      watchers.start({ local: '/repo/a' });

      watchers.getStatus();

      expect(tests.stopCalls()).toBe(0);
    });

    it('clears the arrival without restarting once a completed run confirms the file was exercised', async () => {
      const arrivedAt = new Date('2026-01-01T00:00:00Z');
      const tests = fakeVitestLikeRunner();
      const absPath = 'D:\\repo\\src\\new.spec.ts';
      tests.setRunFiles([absPath]);
      tests.setState({ state: 'pass', timestamp: new Date('2026-01-01T00:00:01Z') }); // settled AFTER the arrival
      const tracker = fakeChangeTracker();
      tracker.setTestFileArrival(absPath, arrivedAt);
      const { watchers } = watchersWithFakeRunners({ '/repo/a': [tests] }, { changeTrackersByRepo: { '/repo/a': tracker } });
      await watchers.start({ local: '/repo/a' });

      watchers.getStatus();

      expect(tests.stopCalls()).toBe(0);
      expect(tracker.pendingTestFileArrivals().size).toBe(0);
    });

    it('force-restarts once a completed run since the arrival demonstrably did not exercise the file', async () => {
      const arrivedAt = new Date('2026-01-01T00:00:00Z');
      const tests = fakeVitestLikeRunner();
      const absPath = 'D:\\repo\\src\\new.spec.ts';
      tests.setRunFiles([]); // completed, but doesn't include the new file
      tests.setState({ state: 'pass', timestamp: new Date('2026-01-01T00:00:01Z') });
      const tracker = fakeChangeTracker();
      tracker.setTestFileArrival(absPath, arrivedAt);
      const { watchers } = watchersWithFakeRunners({ '/repo/a': [tests] }, { changeTrackersByRepo: { '/repo/a': tracker } });
      await watchers.start({ local: '/repo/a' });

      watchers.getStatus();
      await new Promise((r) => setTimeout(r, 10));

      expect(tests.stopCalls()).toBe(1);
      expect(tracker.pendingTestFileArrivals().size).toBe(0);
    });

    it('does not restart while still within the verify window and no completed run has happened yet', async () => {
      const tests = fakeVitestLikeRunner();
      const absPath = 'D:\\repo\\src\\new.spec.ts';
      tests.setState({ state: 'running', timestamp: new Date(), failures: [] });
      const tracker = fakeChangeTracker();
      tracker.setTestFileArrival(absPath, new Date());
      const { watchers } = watchersWithFakeRunners(
        { '/repo/a': [tests] },
        { changeTrackersByRepo: { '/repo/a': tracker }, testFileArrivalVerifyMs: 5_000 }
      );
      await watchers.start({ local: '/repo/a' });

      watchers.getStatus();
      await new Promise((r) => setTimeout(r, 10));

      expect(tests.stopCalls()).toBe(0);
      expect(tracker.pendingTestFileArrivals().size).toBe(1);
    });

    it('force-restarts once the verify window elapses with no completed run at all since the arrival', async () => {
      const tests = fakeVitestLikeRunner();
      const absPath = 'D:\\repo\\src\\new.spec.ts';
      tests.setState({ state: 'pending', timestamp: new Date() }); // never settled
      const tracker = fakeChangeTracker();
      tracker.setTestFileArrival(absPath, new Date());
      const { watchers } = watchersWithFakeRunners(
        { '/repo/a': [tests] },
        { changeTrackersByRepo: { '/repo/a': tracker }, testFileArrivalVerifyMs: 5 }
      );
      await watchers.start({ local: '/repo/a' });

      await new Promise((r) => setTimeout(r, 10));
      watchers.getStatus();
      await new Promise((r) => setTimeout(r, 10));

      expect(tests.stopCalls()).toBe(1);
      expect(tracker.pendingTestFileArrivals().size).toBe(0);
    });

    it('does nothing for a runner with no hasRunFile() support (only Vitest has one)', () => {
      const notVitest = fakeRunner(SignalType.Types);
      notVitest.setState({ state: 'pass', timestamp: new Date() });
      const tracker = fakeChangeTracker();
      tracker.setTestFileArrival('D:\\repo\\src\\new.spec.ts', new Date());
      const { watchers } = watchersWithFakeRunners({ '/repo/a': [notVitest] }, { changeTrackersByRepo: { '/repo/a': tracker } });
      watchers.start({ local: '/repo/a' });

      watchers.getStatus();

      expect(tracker.pendingTestFileArrivals().size).toBe(1);
    });
  });

  describe('checkForWedges', () => {
    it('recovers a frozen watch-mode signal via pause()/resume(), and a frozen file-triggered signal via stop()/start() (no pause()/resume() of its own) — uniformly, no special-casing by strategy', async () => {
      const tests = fakeRunner(SignalType.Tests);
      tests.setState({ state: 'pass', timestamp: new Date('2026-01-01T00:00:00Z') });
      const oxlintStop = vi.fn(async () => undefined);
      const oxlintStart = vi.fn(async () => undefined);
      const oxlint: ISignalRunner = {
        signalType: SignalType.OxLint,
        strategy: 'file-triggered',
        start: oxlintStart,
        stop: oxlintStop,
        getState: () => ({ state: 'pass', timestamp: new Date('2026-01-01T00:00:00Z') }),
      };
      const tracker = fakeChangeTracker();
      tracker.setLastChangeAt(new Date('2026-01-01T00:00:00Z'));
      const { watchers } = watchersWithFakeRunners({ '/repo/a': [tests, oxlint] }, { changeTrackersByRepo: { '/repo/a': tracker } });
      await watchers.start({ local: '/repo/a' });

      await watchers.checkForWedges(new Date('2026-01-01T00:06:00Z'));

      expect(tests.pauseCalls()).toBe(1);
      expect(tests.resumeCalls()).toBe(1);
      expect(oxlintStop).toHaveBeenCalledTimes(1);
      // Called twice: once by watchers.start()'s initial runner.start(), once by this recovery's stop()/start() cycle.
      expect(oxlintStart).toHaveBeenCalledTimes(2);
    });

    it('applies the same tiny staleGraceMs to a watch-mode and a file-triggered signal alike, given the same frozen duration', async () => {
      const changeAt = new Date('2026-01-01T00:00:00Z');
      const fourSecondsLater = new Date('2026-01-01T00:00:04Z');
      const tests = fakeRunner(SignalType.Tests);
      tests.setState({ state: 'pass', timestamp: changeAt });
      const oxlintStop = vi.fn(async () => undefined);
      const oxlint: ISignalRunner = {
        signalType: SignalType.OxLint,
        strategy: 'file-triggered',
        start: async () => undefined,
        stop: oxlintStop,
        getState: () => ({ state: 'pass', timestamp: changeAt }),
      };
      const tracker = fakeChangeTracker();
      tracker.setLastChangeAt(changeAt);
      const { watchers } = watchersWithFakeRunners({ '/repo/a': [tests, oxlint] }, { changeTrackersByRepo: { '/repo/a': tracker } });
      await watchers.start({ local: '/repo/a' });

      // 4s frozen — past SignalWedgeMonitor's own tiny (3s) default. No
      // watch-mode-vs-file-triggered override for staleGraceMs anymore —
      // ensureFresh() being called on every check (see the next test) is
      // what keeps a genuinely-idle file-triggered signal safe instead.
      await watchers.checkForWedges(fourSecondsLater);

      expect(tests.pauseCalls()).toBe(1);
      expect(oxlintStop).toHaveBeenCalledTimes(1);
    });

    it('calls ensureFresh() on a file-triggered runner before judging it wedged, so a dirty-but-not-yet-asked signal gets a fair chance to react first', async () => {
      const changeAt = new Date('2026-01-01T00:00:00Z');
      const fourSecondsLater = new Date('2026-01-01T00:00:04Z');
      let state: SignalState = { state: 'pass', timestamp: changeAt };
      const oxlintStop = vi.fn(async () => undefined);
      const oxlint: ISignalRunner = {
        signalType: SignalType.OxLint,
        strategy: 'file-triggered',
        start: async () => undefined,
        stop: oxlintStop,
        getState: () => state,
        // Simulates FileTriggeredSignalRunner's real ensureFresh(): a dirty
        // signal transitions to 'running' with a FRESH timestamp the
        // instant it's asked, exactly as the real runCheck() does.
        ensureFresh: () => { state = { state: 'running', timestamp: fourSecondsLater, failures: [] }; },
      };
      const tracker = fakeChangeTracker();
      tracker.setLastChangeAt(changeAt);
      const { watchers } = watchersWithFakeRunners({ '/repo/a': [oxlint] }, { changeTrackersByRepo: { '/repo/a': tracker } });
      await watchers.start({ local: '/repo/a' });

      await watchers.checkForWedges(fourSecondsLater);

      // ensureFresh() moved it to 'running' with a fresh timestamp before
      // the wedge check ever looked at it — never flagged as a frozen
      // settled result at all.
      expect(oxlintStop).not.toHaveBeenCalled();
    });

    it('does not flag a signal that has been running a long time as long as its own lastActivityAt() keeps ticking', async () => {
      // No more per-signal idlePatienceMs override table (see
      // WingSignalWatchers.ts's doc comment) — a long-but-healthy run is
      // now told apart from a stuck one purely via lastActivityAt(), same
      // uniform tiny default for every signal. This is what lets
      // custom-lint's real, measured ~27s total runtime (see
      // runCustomLint.ts) stay safe without any signal-type-specific
      // knowledge here: it reports a real per-file tick well under the
      // default idlePatienceMs, same as this fake does.
      const startedAt = new Date('2026-01-01T00:00:00Z');
      let latestActivity = startedAt;
      const customLintStop = vi.fn(async () => undefined);
      const customLint: ISignalRunner = {
        signalType: SignalType.CustomLint,
        strategy: 'file-triggered',
        start: async () => undefined,
        stop: customLintStop,
        getState: () => ({ state: 'running', timestamp: startedAt, failures: [] }),
        lastActivityAt: () => latestActivity,
      };
      const { watchers } = watchersWithFakeRunners({ '/repo/a': [customLint] });
      await watchers.start({ local: '/repo/a' });

      // Simulate real per-file ticks arriving well inside the default
      // idlePatienceMs the whole way to 20s, exactly like runCustomLint's
      // real per-file loop would.
      for (let elapsedMs = 0; elapsedMs <= 20_000; elapsedMs += 200) {
        latestActivity = new Date(startedAt.getTime() + elapsedMs);
        await watchers.checkForWedges(new Date(startedAt.getTime() + elapsedMs));
      }

      expect(customLintStop).not.toHaveBeenCalled();
    });

    it('flags a signal stuck running with no lastActivityAt() ticks at all, even without any per-signal override', async () => {
      const startedAt = new Date('2026-01-01T00:00:00Z');
      const twentySecondsLater = new Date('2026-01-01T00:00:20Z');
      const customLintStop = vi.fn(async () => undefined);
      const customLint: ISignalRunner = {
        signalType: SignalType.CustomLint,
        strategy: 'file-triggered',
        start: async () => undefined,
        stop: customLintStop,
        getState: () => ({ state: 'running', timestamp: startedAt, failures: [] }),
        lastActivityAt: () => startedAt,
      };
      const { watchers } = watchersWithFakeRunners({ '/repo/a': [customLint] });
      await watchers.start({ local: '/repo/a' });

      await watchers.checkForWedges(twentySecondsLater);

      expect(customLintStop).toHaveBeenCalledTimes(1);
    });

    it('does nothing when no repo has been started', async () => {
      const { watchers } = watchersWithFakeRunners({});
      await expect(watchers.checkForWedges(new Date())).resolves.toBeUndefined();
    });

    it('treats a repo with no observed file change as having nothing to compare a frozen result against', async () => {
      const tests = fakeRunner(SignalType.Tests);
      tests.setState({ state: 'pass', timestamp: new Date('2020-01-01T00:00:00Z') });
      const { watchers } = watchersWithFakeRunners({ '/repo/a': [tests] });
      await watchers.start({ local: '/repo/a' });

      await watchers.checkForWedges(new Date('2026-01-01T00:00:00Z'));

      expect(tests.pauseCalls()).toBe(0);
      expect(tests.stopCalls()).toBe(0);
    });
  });

  describe('unwedge', () => {
    it('triggers the same recovery ladder as checkForWedges for a genuinely wedged signal', async () => {
      const changeAt = new Date('2026-01-01T00:00:00Z');
      const tests = fakeRunner(SignalType.Tests);
      tests.setState({ state: 'pass', timestamp: changeAt });
      const tracker = fakeChangeTracker();
      tracker.setLastChangeAt(changeAt);
      const { watchers } = watchersWithFakeRunners({ '/repo/a': [tests] }, { changeTrackersByRepo: { '/repo/a': tracker } });
      await watchers.start({ local: '/repo/a' });

      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:10Z'));
      try {
        const results = await watchers.unwedge(SignalType.Tests, 'local');
        expect(results).toEqual([{ repoAlias: 'local', wedged: true }]);
        expect(tests.pauseCalls()).toBe(1);
        expect(tests.resumeCalls()).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('is a safe no-op for a signal that is not actually wedged — idempotency for cabinet\'s Tier 2 backstop', async () => {
      const tests = fakeRunner(SignalType.Tests);
      tests.setState({ state: 'pass', timestamp: new Date() });
      const { watchers } = watchersWithFakeRunners({ '/repo/a': [tests] });
      await watchers.start({ local: '/repo/a' });

      const results = await watchers.unwedge(SignalType.Tests, 'local');

      expect(results).toEqual([{ repoAlias: 'local', wedged: false }]);
      expect(tests.pauseCalls()).toBe(0);
      expect(tests.stopCalls()).toBe(0);
    });

    it('checks every repo when repoAlias is omitted', async () => {
      const a = fakeRunner(SignalType.Tests);
      a.setState({ state: 'pass', timestamp: new Date() });
      const b = fakeRunner(SignalType.Tests);
      b.setState({ state: 'pass', timestamp: new Date() });
      const { watchers } = watchersWithFakeRunners({ '/repo/a': [a], '/repo/b': [b] });
      await watchers.start({ local: '/repo/a', global: '/repo/b' });

      const results = await watchers.unwedge(SignalType.Tests);

      expect(results).toEqual([
        { repoAlias: 'local', wedged: false },
        { repoAlias: 'global', wedged: false },
      ]);
    });

    it('returns an empty list for an unknown repoAlias or a signalType with no runner there', async () => {
      const tests = fakeRunner(SignalType.Tests);
      const { watchers } = watchersWithFakeRunners({ '/repo/a': [tests] });
      await watchers.start({ local: '/repo/a' });

      expect(await watchers.unwedge(SignalType.Tests, 'unknown-repo')).toEqual([]);
      expect(await watchers.unwedge(SignalType.Build, 'local')).toEqual([]);
    });
  });
});

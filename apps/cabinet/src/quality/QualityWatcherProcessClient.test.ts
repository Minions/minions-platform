import { describe, it, expect, vi } from 'vitest';
import {
  QualityWatcherProcessClient,
  parseListeningAnnouncement,
  resolveQualityWatcherProcessEntry,
  type SpawnedProcess,
} from './QualityWatcherProcessClient.js';

describe('resolveQualityWatcherProcessEntry', () => {
  it('resolves the built .cjs entry point under apps/quality-watcher-process/dist', () => {
    const entry = resolveQualityWatcherProcessEntry('/repo/apps');
    expect(entry.replaceAll('\\', '/')).toBe('/repo/apps/quality-watcher-process/dist/main.cjs');
  });
});

describe('parseListeningAnnouncement', () => {
  it('extracts the port from a well-formed announcement line', () => {
    expect(parseListeningAnnouncement('{"type":"listening","port":54321}')).toBe(54321);
  });

  it('returns undefined for non-JSON lines', () => {
    expect(parseListeningAnnouncement('some other log output')).toBeUndefined();
  });

  it('returns undefined for JSON that is not the announcement shape', () => {
    expect(parseListeningAnnouncement('{"type":"something-else","port":1}')).toBeUndefined();
    expect(parseListeningAnnouncement('{"type":"listening"}')).toBeUndefined();
    expect(parseListeningAnnouncement('42')).toBeUndefined();
    expect(parseListeningAnnouncement('null')).toBeUndefined();
  });
});

/** A fake spawned process whose 'data'/'exit' handlers this test can invoke directly — no real child process involved. */
function fakeSpawnedProcess(): {
  process: SpawnedProcess;
  emitStdout: (chunk: string) => void;
  emitStderr: (chunk: string) => void;
  emitExit: (code: number | null, signal: NodeJS.Signals | null) => void;
  killed: () => boolean;
} {
  const stdoutHandlers: Array<(chunk: Buffer | string) => void> = [];
  const stderrHandlers: Array<(chunk: Buffer | string) => void> = [];
  const exitHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  let killed = false;
  const process: SpawnedProcess = {
    stdout: { on: (_event, listener) => { stdoutHandlers.push(listener); } },
    stderr: { on: (_event, listener) => { stderrHandlers.push(listener); } },
    kill: () => { killed = true; },
    on: (event, listener) => { if (event === 'exit') exitHandlers.push(listener); },
  };
  return {
    process,
    emitStdout: (chunk) => stdoutHandlers.forEach((h) => h(chunk)),
    emitStderr: (chunk) => stderrHandlers.forEach((h) => h(chunk)),
    emitExit: (code, signal) => exitHandlers.forEach((h) => h(code, signal)),
    killed: () => killed,
  };
}

describe('QualityWatcherProcessClient', () => {
  it('resolves ensureStarted() with the base URL once the child announces its port', async () => {
    const fake = fakeSpawnedProcess();
    const client = new QualityWatcherProcessClient(() => fake.process);

    const startingPromise = client.ensureStarted();
    fake.emitStdout('{"type":"listening","port":9999}\n');

    expect(await startingPromise).toBe('http://127.0.0.1:9999');
  });

  it('ignores unrelated stdout lines before the announcement arrives', async () => {
    const fake = fakeSpawnedProcess();
    const client = new QualityWatcherProcessClient(() => fake.process);

    const startingPromise = client.ensureStarted();
    fake.emitStdout('some startup banner\n{"type":"listening","port":1234}\n');

    expect(await startingPromise).toBe('http://127.0.0.1:1234');
  });

  it('handles the announcement arriving split across multiple stdout chunks', async () => {
    const fake = fakeSpawnedProcess();
    const client = new QualityWatcherProcessClient(() => fake.process);

    const startingPromise = client.ensureStarted();
    fake.emitStdout('{"type":"listening",');
    fake.emitStdout('"port":4242}\n');

    expect(await startingPromise).toBe('http://127.0.0.1:4242');
  });

  it('only spawns once — concurrent ensureStarted() calls share the same in-flight promise', async () => {
    let spawnCount = 0;
    const fake = fakeSpawnedProcess();
    const client = new QualityWatcherProcessClient(() => { spawnCount += 1; return fake.process; });

    const first = client.ensureStarted();
    const second = client.ensureStarted();
    fake.emitStdout('{"type":"listening","port":1}\n');
    await Promise.all([first, second]);

    expect(spawnCount).toBe(1);
  });

  it('stop() kills the child and lets a later ensureStarted() spawn a fresh one', async () => {
    const first = fakeSpawnedProcess();
    const second = fakeSpawnedProcess();
    let spawnCount = 0;
    const client = new QualityWatcherProcessClient(() => {
      spawnCount += 1;
      return spawnCount === 1 ? first.process : second.process;
    });

    const firstStarting = client.ensureStarted();
    first.emitStdout('{"type":"listening","port":1}\n');
    await firstStarting;

    client.stop();
    expect(first.killed()).toBe(true);

    const secondStarting = client.ensureStarted();
    second.emitStdout('{"type":"listening","port":2}\n');
    expect(await secondStarting).toBe('http://127.0.0.1:2');

    // The real OS process behind `first` can take a moment to actually exit
    // after kill() — its exit event can arrive well after a replacement
    // child is already running. That stale event must not be misread as an
    // unexpected crash of the (unrelated, healthy) second child.
    const respawns: unknown[] = [];
    client.onRespawn((info) => respawns.push(info));
    first.emitExit(0, null);

    expect(respawns).toHaveLength(0);
    expect(client.getLastEmergency()).toBeUndefined();
    expect(second.killed()).toBe(false);
    expect(spawnCount).toBe(2); // no bogus third spawn triggered by the stale exit
  });

  describe('Tier 3: whole-process crash detection and automatic respawn', () => {
    it('respawns automatically and notifies onRespawn when the child exits unexpectedly', async () => {
      const first = fakeSpawnedProcess();
      const second = fakeSpawnedProcess();
      let spawnCount = 0;
      const client = new QualityWatcherProcessClient(() => {
        spawnCount += 1;
        return spawnCount === 1 ? first.process : second.process;
      });
      const respawns: Array<{ reason: string; baseUrl: string }> = [];
      client.onRespawn((info) => respawns.push(info));

      const firstStarting = client.ensureStarted();
      first.emitStdout('{"type":"listening","port":1}\n');
      await firstStarting;

      first.emitExit(1, null); // crash, not a deliberate stop()
      // The respawn is triggered synchronously off the exit event, but
      // resolving it (a fresh ensureStarted()) is async — give it a tick.
      second.emitStdout('{"type":"listening","port":2}\n');
      await vi.waitFor(() => expect(respawns).toHaveLength(1));

      expect(respawns[0]).toEqual({ reason: 'crash', baseUrl: 'http://127.0.0.1:2' });
      expect(spawnCount).toBe(2);
    });

    it('does not treat a deliberate stop() as a crash — no respawn, no emergency recorded', async () => {
      const first = fakeSpawnedProcess();
      let spawnCount = 0;
      const client = new QualityWatcherProcessClient(() => { spawnCount += 1; return first.process; });
      const respawns: unknown[] = [];
      const crashes: unknown[] = [];
      client.onRespawn((info) => respawns.push(info));
      client.onCrash((info) => crashes.push(info));

      const starting = client.ensureStarted();
      first.emitStdout('{"type":"listening","port":1}\n');
      await starting;

      client.stop();
      first.emitExit(0, null); // the kill() we just issued taking effect

      expect(respawns).toHaveLength(0);
      expect(crashes).toHaveLength(0);
      expect(client.getLastEmergency()).toBeUndefined();
      expect(spawnCount).toBe(1); // no automatic second spawn — stop() does not restart
    });

    it('notifies onCrash synchronously, before the respawn resolves', async () => {
      const first = fakeSpawnedProcess();
      const second = fakeSpawnedProcess();
      let spawnCount = 0;
      const client = new QualityWatcherProcessClient(() => {
        spawnCount += 1;
        return spawnCount === 1 ? first.process : second.process;
      });
      const events: string[] = [];
      client.onCrash(() => events.push('crash'));
      client.onRespawn(() => events.push('respawn'));

      const starting = client.ensureStarted();
      first.emitStdout('{"type":"listening","port":1}\n');
      await starting;

      first.emitExit(1, null);
      // onCrash must already have fired here, synchronously off the exit
      // event — a caller reacting to it (e.g. clearing a stale-URL cache)
      // needs that guarantee before a single more request can land.
      expect(events).toEqual(['crash']);

      second.emitStdout('{"type":"listening","port":2}\n');
      await vi.waitFor(() => expect(events).toEqual(['crash', 'respawn']));
    });

    it('records the last emergency with reason, timestamp, and recent output', async () => {
      const first = fakeSpawnedProcess();
      const second = fakeSpawnedProcess();
      let spawnCount = 0;
      const client = new QualityWatcherProcessClient(() => {
        spawnCount += 1;
        return spawnCount === 1 ? first.process : second.process;
      });

      const starting = client.ensureStarted();
      first.emitStdout('{"type":"listening","port":1}\n');
      await starting;
      first.emitStderr('about to fall over\n');

      first.emitExit(1, null);
      second.emitStdout('{"type":"listening","port":2}\n');
      await vi.waitFor(() => expect(client.getLastEmergency()).toBeDefined());

      const emergency = client.getLastEmergency();
      expect(emergency?.reason).toBe('crash');
      expect(emergency?.at).toBeInstanceOf(Date);
      expect(emergency?.recentOutput.join('')).toContain('about to fall over');
    });

    it('retains up to 50 recent stdout/stderr lines independent of any crash, evicting the oldest first', async () => {
      const fake = fakeSpawnedProcess();
      const client = new QualityWatcherProcessClient(() => fake.process);

      const starting = client.ensureStarted();
      fake.emitStdout('{"type":"listening","port":1}\n');
      await starting;

      for (let i = 0; i < 60; i++) fake.emitStderr(`line ${i}\n`);

      const recent = client.getRecentOutput();
      expect(recent.length).toBeLessThanOrEqual(50);
      expect(recent).toContain('line 59');
      expect(recent).toContain('line 10');
      expect(recent).not.toContain('line 9');
      expect(recent).not.toContain('line 0');
    });

    it('reconstructs a line even when it arrives split across multiple stdout/stderr chunks', async () => {
      const fake = fakeSpawnedProcess();
      const client = new QualityWatcherProcessClient(() => fake.process);

      const starting = client.ensureStarted();
      fake.emitStdout('{"type":"listening","port":1}\n');
      await starting;

      fake.emitStderr('half a line ');
      fake.emitStderr('completed here\n');

      expect(client.getRecentOutput()).toContain('half a line completed here');
    });
  });

  describe('Tier 3: heartbeat-based hang detection', () => {
    /** Always resolves `{ ok }`, regardless of the URL/options passed — tests control liveness by queuing responses, not by simulating a real timeout. */
    function fakeFetch(...responses: Array<'ok' | 'miss'>): { fetchImpl: typeof fetch; calls: string[] } {
      const calls: string[] = [];
      let i = 0;
      const fetchImpl = (async (url: string) => {
        calls.push(url);
        const next = responses[Math.min(i, responses.length - 1)];
        i += 1;
        if (next === 'ok') return { ok: true } as Response;
        throw new Error('simulated network failure');
      }) as typeof fetch;
      return { fetchImpl, calls };
    }

    /** A fetch whose resolution the test controls one call at a time — for racing a heartbeat tick's response against other events (a crash, a respawn) instead of letting it resolve immediately. */
    function deferredFetch(): { fetchImpl: typeof fetch; resolveNext: (ok: boolean) => void; calls: string[] } {
      const calls: string[] = [];
      const pending: Array<{ resolve: (r: Response) => void; reject: (e: unknown) => void }> = [];
      const fetchImpl = ((url: string) => {
        calls.push(url);
        return new Promise<Response>((resolve, reject) => { pending.push({ resolve, reject }); });
      }) as typeof fetch;
      return {
        fetchImpl,
        calls,
        resolveNext: (ok) => {
          const next = pending.shift();
          if (!next) throw new Error('resolveNext called with no pending fetch');
          next.resolve({ ok } as Response);
        },
      };
    }

    it('a stale heartbeat tick against an already-replaced process cannot poison the new process\'s miss counter', async () => {
      vi.useFakeTimers();
      try {
        const first = fakeSpawnedProcess();
        const second = fakeSpawnedProcess();
        let spawnCount = 0;
        const { fetchImpl, resolveNext, calls } = deferredFetch();
        const client = new QualityWatcherProcessClient(() => {
          spawnCount += 1;
          return spawnCount === 1 ? first.process : second.process;
        }, fetchImpl);
        const events: string[] = [];
        client.onCrash((info) => events.push(info.reason));

        const starting = client.ensureStarted();
        first.emitStdout('{"type":"listening","port":1}\n');
        await starting;

        // Tick 1 fires against A and starts awaiting fetchImpl — leave it
        // pending (this is the in-flight request the race depends on).
        await vi.advanceTimersByTimeAsync(15_000);
        expect(calls).toEqual(['http://127.0.0.1:1/health']);

        // A crashes while that tick is still in flight. Crash detection
        // (the exit listener) is independent of the heartbeat and reacts
        // immediately, respawning to B.
        first.emitExit(1, null);
        second.emitStdout('{"type":"listening","port":2}\n');
        await vi.waitFor(() => expect(events).toEqual(['crash']));
        expect(second.killed()).toBe(false);

        // *Now* the stale tick against dead A finally resolves — as a miss,
        // the worst case for poisoning B's fresh counter.
        resolveNext(false);
        await vi.advanceTimersByTimeAsync(0);

        // It must be discarded, not counted against B: no second emergency,
        // B (healthy, freshly respawned) is not killed.
        expect(events).toEqual(['crash']);
        expect(client.getLastEmergency()?.reason).toBe('crash');
        expect(second.killed()).toBe(false);

        // B's own heartbeat is live and independent — two genuine misses
        // against B (not the stale one above) still correctly declare it hung.
        await vi.advanceTimersByTimeAsync(15_000); // B's first real tick — queued as pending
        resolveNext(false);
        await vi.advanceTimersByTimeAsync(0);
        expect(events).toEqual(['crash']); // one miss alone still isn't enough

        await vi.advanceTimersByTimeAsync(15_000); // B's second real tick
        resolveNext(false);
        await vi.advanceTimersByTimeAsync(0);
        expect(events).toEqual(['crash', 'hang']);
        expect(second.killed()).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('polls GET /health at the configured interval once the process is listening', async () => {
      vi.useFakeTimers();
      try {
        const fake = fakeSpawnedProcess();
        const { fetchImpl, calls } = fakeFetch('ok', 'ok', 'ok');
        const client = new QualityWatcherProcessClient(() => fake.process, fetchImpl);

        const starting = client.ensureStarted();
        fake.emitStdout('{"type":"listening","port":1234}\n');
        await starting;

        await vi.advanceTimersByTimeAsync(15_000 * 2);

        expect(calls).toEqual(['http://127.0.0.1:1234/health', 'http://127.0.0.1:1234/health']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not trigger an emergency respawn on a single miss, only on consecutive misses reaching the threshold', async () => {
      vi.useFakeTimers();
      try {
        const fake = fakeSpawnedProcess();
        // miss, then a healthy tick resets the streak, then two consecutive misses trigger.
        const { fetchImpl } = fakeFetch('miss', 'ok', 'miss', 'miss');
        const client = new QualityWatcherProcessClient(() => fake.process, fetchImpl);
        const events: string[] = [];
        client.onCrash((info) => events.push(info.reason));

        const starting = client.ensureStarted();
        fake.emitStdout('{"type":"listening","port":1}\n');
        await starting;

        await vi.advanceTimersByTimeAsync(15_000); // tick 1: miss (1 consecutive)
        expect(events).toEqual([]);

        await vi.advanceTimersByTimeAsync(15_000); // tick 2: ok (resets to 0)
        expect(events).toEqual([]);

        await vi.advanceTimersByTimeAsync(15_000); // tick 3: miss (1 consecutive)
        expect(events).toEqual([]);

        await vi.advanceTimersByTimeAsync(15_000); // tick 4: miss (2 consecutive — threshold reached)
        expect(events).toEqual(['hang']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('kills the still-alive child and respawns when a hang is declared, recording reason "hang"', async () => {
      vi.useFakeTimers();
      try {
        const first = fakeSpawnedProcess();
        const second = fakeSpawnedProcess();
        let spawnCount = 0;
        const { fetchImpl } = fakeFetch('miss', 'miss');
        const client = new QualityWatcherProcessClient(() => {
          spawnCount += 1;
          return spawnCount === 1 ? first.process : second.process;
        }, fetchImpl);
        const respawns: Array<{ reason: string; baseUrl: string }> = [];
        client.onRespawn((info) => respawns.push(info));

        const starting = client.ensureStarted();
        first.emitStdout('{"type":"listening","port":1}\n');
        await starting;

        await vi.advanceTimersByTimeAsync(15_000 * 2); // two consecutive misses

        expect(first.killed()).toBe(true); // unlike a crash, a hung process is still alive — must be killed explicitly
        expect(client.getLastEmergency()?.reason).toBe('hang');

        second.emitStdout('{"type":"listening","port":2}\n');
        await vi.waitFor(() => expect(respawns).toEqual([{ reason: 'hang', baseUrl: 'http://127.0.0.1:2' }]));
      } finally {
        vi.useRealTimers();
      }
    });

    it('restarts the heartbeat against the new base URL once a respawn (crash or hang) completes', async () => {
      vi.useFakeTimers();
      try {
        const first = fakeSpawnedProcess();
        const second = fakeSpawnedProcess();
        let spawnCount = 0;
        const { fetchImpl, calls } = fakeFetch('ok');
        const client = new QualityWatcherProcessClient(() => {
          spawnCount += 1;
          return spawnCount === 1 ? first.process : second.process;
        }, fetchImpl);

        const starting = client.ensureStarted();
        first.emitStdout('{"type":"listening","port":1}\n');
        await starting;

        first.emitExit(1, null); // crash — triggers respawn
        second.emitStdout('{"type":"listening","port":2}\n');
        await vi.waitFor(() => expect(client.getLastEmergency()).toBeDefined());

        await vi.advanceTimersByTimeAsync(15_000);

        expect(calls).toEqual(['http://127.0.0.1:2/health']); // polling the NEW process, not the dead one
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops the heartbeat on a deliberate stop() — no more polling once the process is intentionally down', async () => {
      vi.useFakeTimers();
      try {
        const fake = fakeSpawnedProcess();
        const { fetchImpl, calls } = fakeFetch('ok');
        const client = new QualityWatcherProcessClient(() => fake.process, fetchImpl);

        const starting = client.ensureStarted();
        fake.emitStdout('{"type":"listening","port":1}\n');
        await starting;

        client.stop();
        await vi.advanceTimersByTimeAsync(15_000 * 3);

        expect(calls).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('rejects if the child never announces a listening port before the timeout', async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeSpawnedProcess();
      const client = new QualityWatcherProcessClient(() => fake.process);

      const startingPromise = client.ensureStarted();
      const assertion = expect(startingPromise).rejects.toThrow(/did not report a listening port/);
      await vi.advanceTimersByTimeAsync(30_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

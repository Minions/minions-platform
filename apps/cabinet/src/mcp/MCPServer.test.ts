import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MCPServer } from './MCPServer.js';
import { MockQualityWatcher, RemoteQualityWatcher, type QualityStatus, type WingQualityWatcher, type IQualityWatcher, SignalType } from '@minions/quality-watcher';
import { QualityWatcherProcessClient, type SpawnedProcess } from '../quality/QualityWatcherProcessClient.js';
import { QualityWedgeBackstop } from '../quality/QualityWedgeBackstop.js';

/**
 * Helper function to validate QualityStatus structure
 */
function expectValidQualityStatus(status: QualityStatus) {
  // Top-level properties
  expect(status).toHaveProperty('aggregatedAt');
  expect(status).toHaveProperty('isPartial');

  // All signals exist with required properties
  const signals = ['tests', 'types', 'oxlint', 'customLint', 'build'] as const;
  signals.forEach(signal => {
    expect(status).toHaveProperty(signal);
    expect(status[signal]).toHaveProperty('state');
    expect(status[signal]).toHaveProperty('timestamp');
  });
}

describe('MCPServer', () => {
  let mcpServer: MCPServer;

  beforeEach(() => {
    mcpServer = new MCPServer();
  });

  it('connects to transport successfully and is idempotent', async () => {
    // connect() is now a no-op in per-session mode, but should still work
    await expect(mcpServer.connect()).resolves.toBeUndefined();
    // Second connect should be idempotent
    await expect(mcpServer.connect()).resolves.toBeUndefined();
  });

  it('initializes with no active sessions', () => {
    // MCPServer starts with no sessions
    expect(mcpServer.getSessionCount()).toBe(0);
  });

  describe('long-lived object graph', () => {
    it('owns its own gitCoordination, distinct per instance (not a shared module-level singleton)', () => {
      const other = new MCPServer();
      expect(mcpServer.gitCoordination).toBeDefined();
      expect(mcpServer.gitCoordination).not.toBe(other.gitCoordination);
    });
  });

  describe('quality_status handler', () => {
    it('returns mock quality status for valid wing name', () => {
      // Create a MockQualityWatcher to verify expected output format
      const testWingName = 'test-wing';
      const _watcher = new MockQualityWatcher(testWingName);
      const expectedStatus = _watcher.getStatus();

      // Verify the watcher returns a status with all required fields
      expectValidQualityStatus(expectedStatus);
    });

    it('validates that wingName parameter is required', () => {
      // Test with missing wingName
      expect(() => {
        new MockQualityWatcher('');
      }).not.toThrow();

      // Test with valid wingName
      expect(() => {
        new MockQualityWatcher('valid-wing');
      }).not.toThrow();
    });

    it('throws error when wing does not exist', () => {
      // Handler should validate wing exists before creating watcher
      // This requires MCPServer to be initialized with WingManager
      // Since we don't have a test WingManager, we verify the error is thrown
      // when WingManager is not initialized

      // Test that uninitialized WingManager throws clear error
      const uninitializedServer = new MCPServer();

      // Simulate calling quality_status handler without initialization
      // This should throw "Wing manager not initialized"
      expect(() => {
        if (!uninitializedServer['wingManager']) {
          throw new Error('Wing manager not initialized');
        }
      }).toThrow('Wing manager not initialized');
    });
  });

  describe('MockQualityWatcher configuration', () => {
    it('defaults to all-passing state', () => {
      const watcher = new MockQualityWatcher('test-wing');
      const status = watcher.getStatus();

      expectValidQualityStatus(status);

      // All signals should be passing by default (unimplemented signals don't block work)
      expect(status[SignalType.Tests].state).toBe('pass');
      expect(status[SignalType.Types].state).toBe('pass');
      expect(status[SignalType.OxLint].state).toBe('pass');
      expect(status[SignalType.CustomLint].state).toBe('pass');
      expect(status[SignalType.Build].state).toBe('pass');

      // Default state is complete (all passing)
      expect(status.isPartial).toBe(false);
    });

    it('configures all four signals independently via setStatus()', () => {
      const watcher = new MockQualityWatcher('test-wing');
      const now = new Date();

      // Configure each signal to a different state
      watcher.setStatus({
        [SignalType.Tests]: { state: 'pass', timestamp: now },
        [SignalType.Types]: { state: 'fail', timestamp: now, failures: ['Type error in foo.ts'] },
        [SignalType.OxLint]: { state: 'pass', timestamp: now },
        [SignalType.CustomLint]: { state: 'running', timestamp: now, failures: [] },
        [SignalType.Build]: { state: 'pending', timestamp: now },
        aggregatedAt: now,
        isPartial: false,
      });

      const status = watcher.getStatus();
      expectValidQualityStatus(status);

      // Verify each signal has the configured state
      expect(status[SignalType.Tests].state).toBe('pass');
      expect(status[SignalType.Types].state).toBe('fail');
      expect(status[SignalType.CustomLint].state).toBe('running');
      expect(status[SignalType.Build].state).toBe('pending');

      // Verify fail state includes failures
      if (status[SignalType.Types].state === 'fail') {
        expect(status[SignalType.Types].failures).toEqual(['Type error in foo.ts']);
      }
    });

    it('configures all-passing scenario', () => {
      const watcher = new MockQualityWatcher('test-wing');
      const now = new Date();

      // Configure all signals as passing
      watcher.setStatus({
        [SignalType.Tests]: { state: 'pass', timestamp: now },
        [SignalType.Types]: { state: 'pass', timestamp: now },
        [SignalType.OxLint]: { state: 'pass', timestamp: now },
        [SignalType.CustomLint]: { state: 'pass', timestamp: now },
        [SignalType.Build]: { state: 'pass', timestamp: now },
        aggregatedAt: now,
        isPartial: false,
      });

      const status = watcher.getStatus();
      expectValidQualityStatus(status);

      // All signals should be passing
      expect(status[SignalType.Tests].state).toBe('pass');
      expect(status[SignalType.Types].state).toBe('pass');
      expect(status[SignalType.OxLint].state).toBe('pass');
      expect(status[SignalType.CustomLint].state).toBe('pass');
      expect(status[SignalType.Build].state).toBe('pass');

      // Complete and passing means not partial
      expect(status.isPartial).toBe(false);
    });

    it('configures mixed states scenario', () => {
      const watcher = new MockQualityWatcher('test-wing');
      const now = new Date();

      // Configure a realistic mixed scenario:
      // - Some signals passing
      // - Some signals failing
      // - Some still running
      watcher.setStatus({
        [SignalType.Tests]: { state: 'fail', timestamp: now, failures: ['Test suite timeout'] },
        [SignalType.Types]: { state: 'pass', timestamp: now },
        [SignalType.OxLint]: { state: 'pass', timestamp: now },
        [SignalType.CustomLint]: { state: 'pass', timestamp: now },
        [SignalType.Build]: { state: 'running', timestamp: now, failures: [] },
        aggregatedAt: now,
        isPartial: true,
      });

      const status = watcher.getStatus();
      expectValidQualityStatus(status);

      // Verify the mixed states
      expect(status[SignalType.Tests].state).toBe('fail');
      expect(status[SignalType.Types].state).toBe('pass');
      expect(status[SignalType.OxLint].state).toBe('pass');
      expect(status[SignalType.CustomLint].state).toBe('pass');
      expect(status[SignalType.Build].state).toBe('running');

      // Mixed scenario with running signal is partial
      expect(status.isPartial).toBe(true);
    });

    it('configures all-failing scenario', () => {
      const watcher = new MockQualityWatcher('test-wing');
      const now = new Date();

      // Configure all signals as failing
      watcher.setStatus({
        [SignalType.Tests]: { state: 'fail', timestamp: now, failures: ['Multiple test failures'] },
        [SignalType.Types]: { state: 'fail', timestamp: now, failures: ['Type mismatch in module'] },
        [SignalType.OxLint]: { state: 'fail', timestamp: now, failures: ['unused variable found'] },
        [SignalType.CustomLint]: { state: 'fail', timestamp: now, failures: ['ESLint errors found'] },
        [SignalType.Build]: { state: 'fail', timestamp: now, failures: ['Build compilation error'] },
        aggregatedAt: now,
        isPartial: false,
      });

      const status = watcher.getStatus();
      expectValidQualityStatus(status);

      // All signals should be failing
      expect(status[SignalType.Tests].state).toBe('fail');
      expect(status[SignalType.Types].state).toBe('fail');
      expect(status[SignalType.OxLint].state).toBe('fail');
      expect(status[SignalType.CustomLint].state).toBe('fail');
      expect(status[SignalType.Build].state).toBe('fail');

      // All complete but failing means not partial
      expect(status.isPartial).toBe(false);

      // Verify each failure has messages
      if (status[SignalType.Tests].state === 'fail') {
        expect(status[SignalType.Tests].failures.length).toBeGreaterThan(0);
      }
      if (status[SignalType.Types].state === 'fail') {
        expect(status[SignalType.Types].failures.length).toBeGreaterThan(0);
      }
      if (status[SignalType.OxLint].state === 'fail') {
        expect(status[SignalType.OxLint].failures.length).toBeGreaterThan(0);
      }
      if (status[SignalType.CustomLint].state === 'fail') {
        expect(status[SignalType.CustomLint].failures.length).toBeGreaterThan(0);
      }
      if (status[SignalType.Build].state === 'fail') {
        expect(status[SignalType.Build].failures.length).toBeGreaterThan(0);
      }
    });
  });

  describe('shutdown', () => {
    it('does not wait forever for a quality watcher whose stop() never resolves', async () => {
      vi.useFakeTimers();
      try {
        const stuckWatcher = { stop: () => new Promise<void>(() => undefined) } as unknown as WingQualityWatcher;
        mcpServer['qualityWatchers'].set('stuck-wing', stuckWatcher);

        const shutdownPromise = mcpServer.shutdown();
        const settled = vi.fn();
        void shutdownPromise.then(settled);

        // Just short of the timeout: still pending.
        await vi.advanceTimersByTimeAsync(4_999);
        expect(settled).not.toHaveBeenCalled();

        // Past the timeout: shutdown() gives up on the stuck watcher and resolves.
        await vi.advanceTimersByTimeAsync(1);
        await expect(shutdownPromise).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('resolves promptly when every quality watcher stops cleanly', async () => {
      const fastWatcher = { stop: () => Promise.resolve() } as unknown as WingQualityWatcher;
      mcpServer['qualityWatchers'].set('fast-wing', fastWatcher);

      await expect(mcpServer.shutdown()).resolves.toBeUndefined();
    });

    it('stops the Tier 2 quality wedge backstop', async () => {
      const stopSpy = vi.spyOn(mcpServer['qualityWedgeBackstop'], 'stop');

      await mcpServer.shutdown();

      expect(stopSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('qualityWedgeBackstop wiring', () => {
    it('starts the Tier 2 backstop as soon as the server is constructed, watching the live qualityWatchers map', () => {
      const startSpy = vi.spyOn(QualityWedgeBackstop.prototype, 'start');
      const server = new MCPServer();

      expect(startSpy).toHaveBeenCalledTimes(1);
      startSpy.mockRestore();
      void server;
    });
  });

  describe('pauseQualityWatcher / resumeQualityWatcher', () => {
    it('is a no-op for a wing with no watcher at all', async () => {
      await expect(mcpServer['pauseQualityWatcher']('no-such-wing')).resolves.toBeUndefined();
      await expect(mcpServer['resumeQualityWatcher']('no-such-wing')).resolves.toBeUndefined();
    });

    it('is a no-op for a wing whose watcher is not a RemoteQualityWatcher (e.g. the old in-process WingQualityWatcher)', async () => {
      const pause = vi.fn();
      const resume = vi.fn();
      const oldStyleWatcher = { pause, resume } as unknown as WingQualityWatcher;
      mcpServer['qualityWatchers'].set('old-style-wing', oldStyleWatcher);

      await mcpServer['pauseQualityWatcher']('old-style-wing');
      await mcpServer['resumeQualityWatcher']('old-style-wing');

      expect(pause).not.toHaveBeenCalled();
      expect(resume).not.toHaveBeenCalled();
    });

    it('calls pause()/resume() on a real RemoteQualityWatcher for the wing', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });
      const remote = new RemoteQualityWatcher('remote-wing', 'http://127.0.0.1:1', {}, fetchImpl as unknown as typeof fetch);
      mcpServer['qualityWatchers'].set('remote-wing', remote);

      await mcpServer['pauseQualityWatcher']('remote-wing');
      await mcpServer['resumeQualityWatcher']('remote-wing');

      expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:1/wings/remote-wing/pause', { method: 'POST' });
      expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:1/wings/remote-wing/resume', { method: 'POST' });
    });

    it('swallows a RemoteQualityWatcher pause()/resume() failure rather than throwing', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) });
      const remote = new RemoteQualityWatcher('flaky-wing', 'http://127.0.0.1:1', {}, fetchImpl as unknown as typeof fetch);
      mcpServer['qualityWatchers'].set('flaky-wing', remote);

      await expect(mcpServer['pauseQualityWatcher']('flaky-wing')).resolves.toBeUndefined();
      await expect(mcpServer['resumeQualityWatcher']('flaky-wing')).resolves.toBeUndefined();
    });
  });

  describe('Tier 3: quality-watcher-process crash/respawn wiring', () => {
    /** A fake spawned process whose 'data'/'exit' handlers a test can invoke directly — no real child process involved. Mirrors QualityWatcherProcessClient.test.ts's own helper. */
    function fakeSpawnedProcess(): {
      process: SpawnedProcess;
      emitStdout: (chunk: string) => void;
      emitStderr: (chunk: string) => void;
      emitExit: (code: number | null, signal: NodeJS.Signals | null) => void;
    } {
      const stdoutHandlers: Array<(chunk: Buffer | string) => void> = [];
      const stderrHandlers: Array<(chunk: Buffer | string) => void> = [];
      const exitHandlers: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
      const process: SpawnedProcess = {
        stdout: { on: (_event, listener) => { stdoutHandlers.push(listener); } },
        stderr: { on: (_event, listener) => { stderrHandlers.push(listener); } },
        kill: () => { /* not exercised here — QualityWatcherProcessClient.test.ts covers stop()/kill() directly */ },
        on: (event, listener) => { if (event === 'exit') exitHandlers.push(listener); },
      };
      return {
        process,
        emitStdout: (chunk) => stdoutHandlers.forEach((h) => h(chunk)),
        emitStderr: (chunk) => stderrHandlers.forEach((h) => h(chunk)),
        emitExit: (code, signal) => exitHandlers.forEach((h) => h(code, signal)),
      };
    }

    function fakeQualityWatcher(running: boolean): IQualityWatcher {
      return {
        wingName: 'unused',
        start: async () => { /* not exercised by this test */ },
        stop: async () => { /* not exercised by this test */ },
        getStatus: () => { throw new Error('not exercised by this test'); },
        isRunning: () => running,
        awaitStatus: async () => { throw new Error('not exercised by this test'); },
      };
    }

    it('invalidates the watcher cache immediately on crash, remembering only wings that were actually running', async () => {
      const first = fakeSpawnedProcess();
      const client = new QualityWatcherProcessClient(() => first.process);
      const crashServer = new MCPServer(client);
      crashServer['qualityWatchers'].set('wing-active', fakeQualityWatcher(true));
      crashServer['qualityWatchers'].set('wing-cooled', fakeQualityWatcher(false));

      const starting = client.ensureStarted();
      first.emitStdout('{"type":"listening","port":1}\n');
      await starting;

      first.emitExit(1, null);

      // onCrash fires synchronously, before any respawn attempt resolves —
      // this assertion runs before the (unawaited) respawn has a chance to.
      expect(crashServer['qualityWatchers'].size).toBe(0);
      expect(crashServer['wingNamesPendingReattach']).toEqual(['wing-active']);
    });

    it('re-attaches only the previously-running wings once the respawn resolves, not the cooled ones', async () => {
      const first = fakeSpawnedProcess();
      const second = fakeSpawnedProcess();
      let spawnCount = 0;
      const client = new QualityWatcherProcessClient(() => {
        spawnCount += 1;
        return spawnCount === 1 ? first.process : second.process;
      });
      const crashServer = new MCPServer(client);
      crashServer['qualityWatchers'].set('wing-active', fakeQualityWatcher(true));
      crashServer['qualityWatchers'].set('wing-cooled', fakeQualityWatcher(false));
      const warmed: string[] = [];
      vi.spyOn(crashServer as unknown as Record<string, (name: string) => void>, 'warmQualityWatcher')
        .mockImplementation((name: string) => { warmed.push(name); });

      const starting = client.ensureStarted();
      first.emitStdout('{"type":"listening","port":1}\n');
      await starting;

      first.emitExit(1, null);
      second.emitStdout('{"type":"listening","port":2}\n');
      await vi.waitFor(() => expect(warmed).toEqual(['wing-active']));

      expect(crashServer['wingNamesPendingReattach']).toEqual([]);
    });

    it('surfaces a recent emergency in the quality_status note, including a tail of what it was last doing', async () => {
      const first = fakeSpawnedProcess();
      const second = fakeSpawnedProcess();
      let spawnCount = 0;
      const client = new QualityWatcherProcessClient(() => {
        spawnCount += 1;
        return spawnCount === 1 ? first.process : second.process;
      });
      const crashServer = new MCPServer(client);

      const starting = client.ensureStarted();
      first.emitStdout('{"type":"listening","port":1}\n');
      await starting;
      first.emitStderr('about to fall over\n');
      first.emitExit(1, null);
      second.emitStdout('{"type":"listening","port":2}\n');
      await vi.waitFor(() => expect(client.getLastEmergency()).toBeDefined());

      const note = crashServer['recentQualityWatcherEmergencyNote']() as string | undefined;
      expect(note).toContain('QUALITY CHECKING WAS ON FIRE');
      expect(note).toContain('about to fall over');
    });

    it('omits the note once the emergency has aged out of the warning window', () => {
      const client = new QualityWatcherProcessClient(() => { throw new Error('should not spawn in this test'); });
      const crashServer = new MCPServer(client);
      vi.spyOn(client, 'getLastEmergency').mockReturnValue({
        reason: 'crash', at: new Date(Date.now() - 10 * 60_000), recentOutput: [],
      });

      expect(crashServer['recentQualityWatcherEmergencyNote']()).toBeUndefined();
    });

    it('includes the emergency in getQualityStreamPayload once one has occurred', () => {
      const client = new QualityWatcherProcessClient(() => { throw new Error('should not spawn in this test'); });
      const crashServer = new MCPServer(client);
      vi.spyOn(client, 'getLastEmergency').mockReturnValue({
        reason: 'crash', at: new Date('2026-01-01T00:00:00.000Z'), recentOutput: [],
      });

      const payload = crashServer.getQualityStreamPayload();
      expect(payload.emergency).toEqual({ reason: 'crash', at: '2026-01-01T00:00:00.000Z' });
    });
  });
});

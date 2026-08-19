import { describe, it, expect, vi } from 'vitest';
import { SignalType } from '../SignalState.js';
import { toWireQualityStatus } from '../QualityStatusWireFormat.js';
import { allPendingQualityStatus } from '../QualityStatus.js';
import { RemoteQualityWatcher, buildWingUrl, buildStatusUrl, parseStatusResponse, assertOkWingAction } from './RemoteQualityWatcher.js';

describe('buildWingUrl', () => {
  it('builds a per-wing action URL, encoding the wing name', () => {
    expect(buildWingUrl('http://127.0.0.1:5555', 'my wing/1', 'start')).toBe(
      'http://127.0.0.1:5555/wings/my%20wing%2F1/start',
    );
  });
});

describe('buildStatusUrl', () => {
  it('builds the per-wing status URL, encoding the wing name', () => {
    expect(buildStatusUrl('http://127.0.0.1:5555', 'my wing/1')).toBe(
      'http://127.0.0.1:5555/wings/my%20wing%2F1/status',
    );
  });

  it('appends ?maxWaitMs=N when a positive maxWaitMs is given', () => {
    expect(buildStatusUrl('http://127.0.0.1:5555', 'wing', 40_000)).toBe(
      'http://127.0.0.1:5555/wings/wing/status?maxWaitMs=40000',
    );
  });

  it('omits the query param for an absent, zero, or negative maxWaitMs', () => {
    expect(buildStatusUrl('http://127.0.0.1:5555', 'wing')).toBe('http://127.0.0.1:5555/wings/wing/status');
    expect(buildStatusUrl('http://127.0.0.1:5555', 'wing', 0)).toBe('http://127.0.0.1:5555/wings/wing/status');
    expect(buildStatusUrl('http://127.0.0.1:5555', 'wing', -5)).toBe('http://127.0.0.1:5555/wings/wing/status');
  });
});

describe('parseStatusResponse', () => {
  it('parses a wire-format QualityStatus from an OK response body', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const wire = toWireQualityStatus(allPendingQualityStatus(now));

    expect(parseStatusResponse(true, 200, wire)).toEqual(allPendingQualityStatus(now));
  });

  it('throws a descriptive error for a non-OK response', () => {
    expect(() => parseStatusResponse(false, 503, { error: 'unavailable' })).toThrow(/HTTP 503/);
  });
});

describe('assertOkWingAction', () => {
  it('does not throw for an OK response', () => {
    expect(() => assertOkWingAction('pause', true, 200)).not.toThrow();
  });

  it('throws a descriptive error naming the action for a non-OK response', () => {
    expect(() => assertOkWingAction('pause', false, 500)).toThrow(/pause.*HTTP 500/);
  });
});

function fakeFetch(response: { ok: boolean; status: number; body: unknown }): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    json: () => Promise.resolve(response.body),
  }) as unknown as typeof fetch;
}

const REPO_PATHS = { local: '/wing/work/local' };

describe('RemoteQualityWatcher', () => {
  it('starts not running, and getStatus() returns an all-pending placeholder before any awaitStatus() call', () => {
    const watcher = new RemoteQualityWatcher('my-wing', 'http://127.0.0.1:5555', REPO_PATHS, fakeFetch({ ok: true, status: 200, body: {} }));

    expect(watcher.isRunning()).toBe(false);
    expect(watcher.getStatus()[SignalType.Tests].state).toBe('pending');
  });

  it('start() POSTs repoPaths to the watcher process and flips isRunning() on success', async () => {
    const fetchImpl = fakeFetch({ ok: true, status: 200, body: { ok: true } });
    const watcher = new RemoteQualityWatcher('my-wing', 'http://127.0.0.1:5555', REPO_PATHS, fetchImpl);

    await watcher.start();

    expect(watcher.isRunning()).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:5555/wings/my-wing/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repoPaths: REPO_PATHS }),
    });
  });

  it('start() twice throws without a second HTTP call', async () => {
    const fetchImpl = fakeFetch({ ok: true, status: 200, body: { ok: true } });
    const watcher = new RemoteQualityWatcher('my-wing', 'http://127.0.0.1:5555', REPO_PATHS, fetchImpl);
    await watcher.start();

    await expect(watcher.start()).rejects.toThrow(/already running/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('start() rejects and leaves isRunning() false when the watcher process responds non-OK', async () => {
    const fetchImpl = fakeFetch({ ok: false, status: 500, body: { error: 'boom' } });
    const watcher = new RemoteQualityWatcher('my-wing', 'http://127.0.0.1:5555', REPO_PATHS, fetchImpl);

    await expect(watcher.start()).rejects.toThrow(/start.*HTTP 500/);
    expect(watcher.isRunning()).toBe(false);
  });

  it('stop() POSTs to the watcher process and flips isRunning() to false', async () => {
    const fetchImpl = fakeFetch({ ok: true, status: 200, body: { ok: true } });
    const watcher = new RemoteQualityWatcher('my-wing', 'http://127.0.0.1:5555', REPO_PATHS, fetchImpl);
    await watcher.start();

    await watcher.stop();

    expect(watcher.isRunning()).toBe(false);
    expect(fetchImpl).toHaveBeenLastCalledWith('http://127.0.0.1:5555/wings/my-wing/stop', { method: 'POST' });
  });

  it('pause()/resume() POST to their own endpoints', async () => {
    const fetchImpl = fakeFetch({ ok: true, status: 200, body: { ok: true } });
    const watcher = new RemoteQualityWatcher('my-wing', 'http://127.0.0.1:5555', REPO_PATHS, fetchImpl);

    await watcher.pause();
    expect(fetchImpl).toHaveBeenLastCalledWith('http://127.0.0.1:5555/wings/my-wing/pause', { method: 'POST' });

    await watcher.resume();
    expect(fetchImpl).toHaveBeenLastCalledWith('http://127.0.0.1:5555/wings/my-wing/resume', { method: 'POST' });
  });

  it('pause()/resume() reject on a non-OK response', async () => {
    const fetchImpl = fakeFetch({ ok: false, status: 503, body: { error: 'unavailable' } });
    const watcher = new RemoteQualityWatcher('my-wing', 'http://127.0.0.1:5555', REPO_PATHS, fetchImpl);

    await expect(watcher.pause()).rejects.toThrow(/pause.*HTTP 503/);
    await expect(watcher.resume()).rejects.toThrow(/resume.*HTTP 503/);
  });

  it('awaitStatus() fetches from the watcher process and caches the result for getStatus()', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const status = allPendingQualityStatus(now);
    status[SignalType.Tests] = { state: 'pass', timestamp: now };
    const fetchImpl = fakeFetch({ ok: true, status: 200, body: toWireQualityStatus(status) });
    const watcher = new RemoteQualityWatcher('my-wing', 'http://127.0.0.1:5555', REPO_PATHS, fetchImpl);

    const result = await watcher.awaitStatus();

    expect(result[SignalType.Tests]).toEqual({ state: 'pass', timestamp: now });
    expect(watcher.getStatus()[SignalType.Tests]).toEqual({ state: 'pass', timestamp: now });
    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:5555/wings/my-wing/status');
  });

  it('awaitStatus(maxWaitMs) forwards it to the server as a query param, so the server actually waits for a settled result', async () => {
    const status = allPendingQualityStatus(new Date('2026-01-01T00:00:00.000Z'));
    const fetchImpl = fakeFetch({ ok: true, status: 200, body: toWireQualityStatus(status) });
    const watcher = new RemoteQualityWatcher('my-wing', 'http://127.0.0.1:5555', REPO_PATHS, fetchImpl);

    await watcher.awaitStatus(40_000);

    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:5555/wings/my-wing/status?maxWaitMs=40000');
  });

  it('awaitStatus() rejects when the watcher process responds non-OK', async () => {
    const fetchImpl = fakeFetch({ ok: false, status: 500, body: { error: 'boom' } });
    const watcher = new RemoteQualityWatcher('my-wing', 'http://127.0.0.1:5555', REPO_PATHS, fetchImpl);

    await expect(watcher.awaitStatus()).rejects.toThrow(/HTTP 500/);
  });

  it('applies the warning policy to getStatus()/awaitStatus() the same way WingQualityWatcher does', async () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const status = allPendingQualityStatus(now);
    status[SignalType.Tests] = { state: 'pass', timestamp: now, warnings: ['deprecated API'] };
    const fetchImpl = fakeFetch({ ok: true, status: 200, body: toWireQualityStatus(status) });
    const watcher = new RemoteQualityWatcher('my-wing', 'http://127.0.0.1:5555', REPO_PATHS, fetchImpl);

    const strict = await watcher.awaitStatus(undefined, false);
    expect(strict[SignalType.Tests].state).toBe('fail');

    const lenient = watcher.getStatus(true);
    expect(lenient[SignalType.Tests].state).toBe('pass');
  });
});

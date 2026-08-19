/**
 * Tests for WingActivityTracker: the sole entry point for MCP session
 * connect/disconnect and the sole owner of the per-wing inactivity debounce
 * timer — needed so brief reconnects (e.g. switching which Minion is active
 * in a wing) don't trigger inactivity side effects like stopping a wing's
 * quality watcher, and so double-fired disconnect events (onsessionclosed +
 * onclose) don't double-notify guards. Keeps only sid -> wingName, nothing
 * else about a session, so callers just call sessionEnded(sid).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WingActivityTracker, type OnWingStateChange, type SessionContext } from './WingActivityTracker.js';

function fakeGuard(): Required<OnWingStateChange> & {
  connected: Array<[string, SessionContext]>;
  disconnected: string[];
  idle: string[];
} {
  const connected: Array<[string, SessionContext]> = [];
  const disconnected: string[] = [];
  const idle: string[] = [];
  return {
    connected,
    disconnected,
    idle,
    sessionConnected: (sid, ctx) => connected.push([sid, ctx]),
    sessionDisconnected: (sid) => disconnected.push(sid),
    wingIdle: (w) => idle.push(w),
  };
}

function fakeContext(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    endpoint: 'henchery',
    clientName: 'test-client',
    transport: {} as SessionContext['transport'],
    server: {} as SessionContext['server'],
    ...overrides,
  };
}

const GRACE_MS = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('WingActivityTracker', () => {
  it('notifies sessionConnected/sessionDisconnected on every connect/disconnect', () => {
    const guard = fakeGuard();
    const tracker = new WingActivityTracker([guard]);
    const ctx = fakeContext({ wingName: 'wing-a' });

    tracker.sessionStarted('sid-1', ctx);
    tracker.sessionEnded('sid-1');

    expect(guard.connected).toEqual([['sid-1', ctx]]);
    expect(guard.disconnected).toEqual(['sid-1']);
  });

  it('notifies sessionConnected/sessionDisconnected even for sessions with no wingName', () => {
    const guard = fakeGuard();
    const tracker = new WingActivityTracker([guard]);
    const ctx = fakeContext();

    tracker.sessionStarted('sid-1', ctx);
    tracker.sessionEnded('sid-1');

    expect(guard.connected).toEqual([['sid-1', ctx]]);
    expect(guard.disconnected).toEqual(['sid-1']);
    vi.advanceTimersByTime(GRACE_MS);
    expect(guard.idle).toEqual([]);
  });

  it('tolerates guards that only implement some hooks', () => {
    const partial: OnWingStateChange = { sessionConnected: vi.fn() };
    const tracker = new WingActivityTracker([partial]);

    expect(() => {
      tracker.sessionStarted('sid-1', fakeContext({ wingName: 'wing-a' }));
      tracker.sessionEnded('sid-1');
      vi.advanceTimersByTime(GRACE_MS);
    }).not.toThrow();
  });

  it('is idempotent — a second sessionEnded call for the same sid is a no-op', () => {
    const guard = fakeGuard();
    const tracker = new WingActivityTracker([guard]);

    tracker.sessionStarted('sid-1', fakeContext({ wingName: 'wing-a' }));
    tracker.sessionEnded('sid-1');
    tracker.sessionEnded('sid-1');

    expect(guard.disconnected).toHaveLength(1);
  });

  it('does nothing on sessionEnded for a sid that never started', () => {
    const guard = fakeGuard();
    const tracker = new WingActivityTracker([guard]);

    expect(() => tracker.sessionEnded('never-started')).not.toThrow();
    expect(guard.disconnected).toEqual([]);
  });

  it('remembers which wing a session belonged to, without the caller passing it back in', () => {
    const guard = fakeGuard();
    const tracker = new WingActivityTracker([guard]);

    tracker.sessionStarted('sid-1', fakeContext({ wingName: 'wing-a' }));
    tracker.sessionEnded('sid-1');
    vi.advanceTimersByTime(GRACE_MS);

    expect(guard.idle).toEqual(['wing-a']);
  });

  it('fires wingIdle once, exactly the grace period after the last session on a wing disconnects', () => {
    const guard = fakeGuard();
    const tracker = new WingActivityTracker([guard]);

    tracker.sessionStarted('sid-1', fakeContext({ wingName: 'wing-a' }));
    tracker.sessionEnded('sid-1');

    expect(guard.idle).toEqual([]);
    vi.advanceTimersByTime(GRACE_MS - 1);
    expect(guard.idle).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(guard.idle).toEqual(['wing-a']);
  });

  it('does not fire wingIdle while another session on the wing is still connected', () => {
    const guard = fakeGuard();
    const tracker = new WingActivityTracker([guard]);

    tracker.sessionStarted('sid-1', fakeContext({ wingName: 'wing-a' }));
    tracker.sessionStarted('sid-2', fakeContext({ wingName: 'wing-a' }));
    tracker.sessionEnded('sid-1');

    vi.advanceTimersByTime(GRACE_MS);
    expect(guard.idle).toEqual([]);
  });

  it('cancels the pending idle timer if a new session starts on the wing within the grace window', () => {
    const guard = fakeGuard();
    const tracker = new WingActivityTracker([guard]);

    tracker.sessionStarted('sid-1', fakeContext({ wingName: 'wing-a' }));
    tracker.sessionEnded('sid-1');
    vi.advanceTimersByTime(GRACE_MS / 2);

    tracker.sessionStarted('sid-2', fakeContext({ wingName: 'wing-a' }));
    vi.advanceTimersByTime(GRACE_MS);

    expect(guard.idle).toEqual([]);
  });

  it('tracks wings independently', () => {
    const guard = fakeGuard();
    const tracker = new WingActivityTracker([guard]);

    tracker.sessionStarted('sid-1', fakeContext({ wingName: 'wing-a' }));
    tracker.sessionStarted('sid-2', fakeContext({ wingName: 'wing-b' }));
    tracker.sessionEnded('sid-1');

    vi.advanceTimersByTime(GRACE_MS);

    expect(guard.idle).toEqual(['wing-a']);
  });

  it('notifies every registered guard independently, in registration order', () => {
    const guardA = fakeGuard();
    const guardB = fakeGuard();
    const tracker = new WingActivityTracker([guardA, guardB]);

    tracker.sessionStarted('sid-1', fakeContext({ wingName: 'wing-a' }));
    tracker.sessionEnded('sid-1');
    vi.advanceTimersByTime(GRACE_MS);

    expect(guardA.connected).toHaveLength(1);
    expect(guardB.connected).toHaveLength(1);
    expect(guardA.idle).toEqual(['wing-a']);
    expect(guardB.idle).toEqual(['wing-a']);
  });
});

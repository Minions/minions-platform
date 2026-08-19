/**
 * Tests for createWingActivityTracker: the one place that decides which
 * guards MCPServer's WingActivityTracker actually has — verifies it wires
 * in the quality-watcher warm/cool behavior correctly, without needing a
 * real MCPServer or a real quality watcher.
 */

import { describe, it, expect, vi } from 'vitest';
import { createWingActivityTracker } from './createWingActivityTracker.js';
import type { SessionContext } from './WingActivityTracker.js';

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

describe('createWingActivityTracker', () => {
  it('warms the quality watcher when a session connects to a wing', () => {
    const warm = vi.fn();
    const tracker = createWingActivityTracker({
      warmQualityWatcher: warm,
      coolQualityWatcher: vi.fn(),
    });

    tracker.sessionStarted('sid-1', fakeContext({ wingName: 'wing-a' }));

    expect(warm).toHaveBeenCalledWith('wing-a');
  });

  it('does not warm the quality watcher for a session with no wing', () => {
    const warm = vi.fn();
    const tracker = createWingActivityTracker({
      warmQualityWatcher: warm,
      coolQualityWatcher: vi.fn(),
    });

    tracker.sessionStarted('sid-1', fakeContext());

    expect(warm).not.toHaveBeenCalled();
  });

  it('cools the quality watcher once the wing goes idle', () => {
    vi.useFakeTimers();
    const cool = vi.fn();
    const tracker = createWingActivityTracker({
      warmQualityWatcher: vi.fn(),
      coolQualityWatcher: cool,
    });

    tracker.sessionStarted('sid-1', fakeContext({ wingName: 'wing-a' }));
    tracker.sessionEnded('sid-1');
    vi.advanceTimersByTime(GRACE_MS);

    expect(cool).toHaveBeenCalledWith('wing-a');
    vi.useRealTimers();
  });
});

import { WingActivityTracker } from './WingActivityTracker.js';

export interface WingActivityTrackerDeps {
  warmQualityWatcher(wingName: string): void;
  coolQualityWatcher(wingName: string): void;
}

/**
 * Builds the WingActivityTracker MCPServer actually uses, wiring in the
 * quality-watcher warm-up/cooldown guard. Kept separate from both
 * WingActivityTracker (which shouldn't know what guards exist) and
 * MCPServer, so the wiring itself is testable without a real MCPServer.
 */
export function createWingActivityTracker(deps: WingActivityTrackerDeps): WingActivityTracker {
  return new WingActivityTracker([
    {
      sessionConnected: (_sid, ctx) => {
        if (ctx.wingName) deps.warmQualityWatcher(ctx.wingName);
      },
      wingIdle: (wingName) => deps.coolQualityWatcher(wingName),
    },
  ]);
}

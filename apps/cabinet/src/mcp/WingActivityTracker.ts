import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { EndpointName } from './ToolRegistry.js';

/** Everything known about an MCP session at the moment it starts. */
export interface SessionContext {
  endpoint: EndpointName;
  clientName: string;
  wingName?: string;
  transport: StreamableHTTPServerTransport;
  server: Server;
}

/**
 * Something that reacts to sessions connecting/disconnecting and to a wing
 * going idle. All three hooks are optional — implement only what you care
 * about. WingActivityTracker treats a missing hook as a no-op, so a guard
 * that only cares about raw session bookkeeping isn't forced to stub out
 * the wing-level hook it has no opinion on.
 */
export interface OnWingStateChange {
  /** A session connected. Fires for every session — 2nd, 3rd, ... concurrent session on a wing too. */
  sessionConnected?(sid: string, ctx: SessionContext): void;
  /** That session disconnected. Fires immediately, once per session. */
  sessionDisconnected?(sid: string): void;
  /** Fires once INACTIVE_GRACE_MS after a wing's last session disconnected, unless a new session
   *  for that wing connected in the meantime. Only fires for sessions that had a wingName. */
  wingIdle?(wingName: string): void;
}

/**
 * The single place MCP session lifecycle is registered — the transport's
 * lifecycle callbacks call only this, and it's the sole owner of the
 * per-wing inactivity debounce timer. Guards just react to what it tells
 * them.
 *
 * It keeps only the minimum state needed to do that: which session ids are
 * currently connected and which wing (if any) each belongs to — nothing
 * else about a session is retained. That's enough to make a duplicate
 * disconnect notification (onsessionclosed and transport.onclose can both
 * fire for the same close) a no-op, and to know which wing's count to
 * adjust on disconnect without the caller having to remember and pass it
 * back in.
 */
export class WingActivityTracker {
  private static readonly INACTIVE_GRACE_MS = 60_000;

  private readonly connectedWings = new Map<string, string | undefined>();
  private readonly counts = new Map<string, number>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly guards: readonly OnWingStateChange[]) {}

  sessionStarted(sid: string, ctx: SessionContext): void {
    this.connectedWings.set(sid, ctx.wingName);
    for (const guard of this.guards) guard.sessionConnected?.(sid, ctx);

    if (!ctx.wingName) return;
    const wingName = ctx.wingName;
    const timer = this.timers.get(wingName);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(wingName);
    }
    this.counts.set(wingName, (this.counts.get(wingName) ?? 0) + 1);
  }

  sessionEnded(sid: string): void {
    if (!this.connectedWings.has(sid)) return; // already processed (double-fire) or never started
    const wingName = this.connectedWings.get(sid);
    this.connectedWings.delete(sid);
    for (const guard of this.guards) guard.sessionDisconnected?.(sid);

    if (!wingName) return;
    const count = Math.max(0, (this.counts.get(wingName) ?? 1) - 1);
    this.counts.set(wingName, count);
    if (count > 0) return;

    const timer = setTimeout(() => {
      this.timers.delete(wingName);
      if ((this.counts.get(wingName) ?? 0) === 0) {
        for (const guard of this.guards) guard.wingIdle?.(wingName);
      }
    }, WingActivityTracker.INACTIVE_GRACE_MS);
    this.timers.set(wingName, timer);
  }
}

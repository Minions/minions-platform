/**
 * Owns one `WingSignalWatchers` per wing, lazily created on first `start()`.
 * Every method is safe to call for a wing that was never started (a no-op
 * for `stop`/`pause`/`resume`, an all-pending status for `getStatus`) — the
 * HTTP layer never needs to distinguish "never started" from "started and
 * idle" before calling in.
 */
import { allPendingQualityStatus, type QualityStatus, type SignalType } from '@minions/quality-watcher';
import { WingSignalWatchers } from './WingSignalWatchers.js';

export type WingSignalWatchersFactory = () => WingSignalWatchers;

export class WingWatcherRegistry {
  private readonly wings = new Map<string, WingSignalWatchers>();

  constructor(private readonly createWatchers: WingSignalWatchersFactory = () => new WingSignalWatchers()) {}

  async start(wingName: string, repoPaths: Record<string, string>): Promise<void> {
    await this.getOrCreate(wingName).start(repoPaths);
  }

  async stop(wingName: string): Promise<void> {
    await this.wings.get(wingName)?.stop();
  }

  async pause(wingName: string): Promise<void> {
    await this.wings.get(wingName)?.pause();
  }

  async resume(wingName: string): Promise<void> {
    await this.wings.get(wingName)?.resume();
  }

  /** Tier 1 wedge check (see SignalWedgeMonitor) across every wing this process is currently watching — intended to be called on a periodic timer by server.ts. */
  async checkForWedges(now: Date): Promise<void> {
    await Promise.all(Array.from(this.wings.values()).map((watchers) => watchers.checkForWedges(now)));
  }

  /** Tier 2's on-demand entry point (see `WingSignalWatchers.unwedge`'s own doc comment) — a no-op returning no results for a wing this process isn't watching at all. */
  async unwedge(wingName: string, signalType: SignalType, repoAlias?: string): Promise<Array<{ repoAlias: string; wedged: boolean }>> {
    const watchers = this.wings.get(wingName);
    return watchers ? watchers.unwedge(signalType, repoAlias) : [];
  }

  getStatus(wingName: string): QualityStatus {
    return this.wings.get(wingName)?.getStatus() ?? allPendingQualityStatus(new Date());
  }

  /** See `WingSignalWatchers.awaitStatus`'s own doc comment. A never-started wing has nothing to wait for — same all-pending placeholder as `getStatus`, immediately. */
  async awaitStatus(wingName: string, maxWaitMs: number): Promise<QualityStatus> {
    const watchers = this.wings.get(wingName);
    return watchers ? watchers.awaitStatus(maxWaitMs) : allPendingQualityStatus(new Date());
  }

  private getOrCreate(wingName: string): WingSignalWatchers {
    let watchers = this.wings.get(wingName);
    if (!watchers) {
      watchers = this.createWatchers();
      this.wings.set(wingName, watchers);
    }
    return watchers;
  }
}

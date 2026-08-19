/**
 * Wing Quality Watcher
 *
 * Composes one QualityWatcher per work repo in a wing (work/local,
 * work/global, and any named extra work dirs) and unifies their results.
 * A wing may have more than one independently checked-out repo under
 * work/ — each gets its own watcher, scoped to that repo's own root, not
 * the wing root.
 */

import type { IEventBus } from '@minions/events';
import { EventBus } from '@minions/events';
import type { IQualityWatcher } from '../IQualityWatcher.js';
import type { QualityStatus } from '../QualityStatus.js';
import { QualityWatcher, type QualityWatcherOptions } from './QualityWatcher.js';
import { mergeQualityStatuses } from './mergeQualityStatus.js';

export class WingQualityWatcher implements IQualityWatcher {
  private running = false;
  private readonly repoWatchers: Map<string, QualityWatcher>;

  constructor(
    readonly wingName: string,
    workRepoPaths: Record<string, string>,
    eventBus: IEventBus = new EventBus(),
    options: QualityWatcherOptions = {}
  ) {
    this.repoWatchers = new Map(
      Object.entries(workRepoPaths).map(([repoName, path]) => [repoName, new QualityWatcher(wingName, path, eventBus, options)])
    );
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Watcher is already running');
    }
    this.running = true;
    // One repo's watcher failing to start must not stop this wing's other
    // repo watchers from starting, nor propagate past this wing — see
    // QualityWatcher.start()'s own per-signal isolation for the same reason
    // one level down.
    await Promise.all(
      Array.from(this.repoWatchers.entries()).map(([repoName, watcher]) =>
        watcher.start().catch((error) => {
          console.error(`[WingQualityWatcher] Failed to start repo watcher '${repoName}' for wing ${this.wingName}:`, error);
        })
      )
    );
  }

  async stop(): Promise<void> {
    this.running = false;
    await Promise.all(Array.from(this.repoWatchers.values()).map((watcher) => watcher.stop()));
  }

  getStatus(treatWarningsAsWarnings = false): QualityStatus {
    return mergeQualityStatuses(this.entriesWith((watcher) => watcher.getStatus(treatWarningsAsWarnings)));
  }

  async awaitStatus(maxWaitMs?: number, treatWarningsAsWarnings = false): Promise<QualityStatus> {
    const entries = await Promise.all(
      Array.from(this.repoWatchers.entries()).map(
        async ([repoName, watcher]) => [repoName, await watcher.awaitStatus(maxWaitMs, treatWarningsAsWarnings)] as const
      )
    );
    return mergeQualityStatuses(entries);
  }

  isRunning(): boolean {
    return this.running;
  }

  private entriesWith(stateFor: (watcher: QualityWatcher) => QualityStatus): Array<readonly [string, QualityStatus]> {
    return Array.from(this.repoWatchers.entries()).map(([repoName, watcher]) => [repoName, stateFor(watcher)] as const);
  }
}

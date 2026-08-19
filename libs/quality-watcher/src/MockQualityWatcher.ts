/**
 * Mock implementation of IQualityWatcher for testing
 *
 * This implementation demonstrates how to create a test double that satisfies
 * the IQualityWatcher interface. It uses simple in-memory state to simulate
 * a real watcher's behavior.
 */

import type { IQualityWatcher } from './IQualityWatcher.js';
import { SignalType } from './SignalState.js';
import type { QualityStatus } from './QualityStatus.js';

export class MockQualityWatcher implements IQualityWatcher {
  readonly wingName: string;
  private running = false;
  private status: QualityStatus;

  constructor(wingName: string) {
    this.wingName = wingName;
    this.status = this.createInitialStatus();
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Watcher is already running');
    }
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  getStatus(): QualityStatus {
    return this.status;
  }

  async awaitStatus(): Promise<QualityStatus> {
    return this.status;
  }

  isRunning(): boolean {
    return this.running;
  }

  // Test helper methods (not part of interface)

  /**
   * Test helper: Set the status that getStatus() will return
   *
   * **This method is for testing purposes only.** Use it in tests to configure
   * the mock to return specific quality states. This allows tests to verify
   * behavior under different quality conditions without running actual signal runners.
   *
   * @param status - The QualityStatus to return from getStatus()
   *
   * @example
   * ```typescript
   * const watcher = new MockQualityWatcher('test-wing');
   * watcher.setStatus({
   *   [SignalType.Tests]: { state: 'pass', timestamp: new Date() },
   *   [SignalType.Types]: { state: 'pass', timestamp: new Date() },
   *   [SignalType.Build]: { state: 'pass', timestamp: new Date() },
   *   aggregatedAt: new Date(),
   *   isPartial: false,
   * });
   * ```
   */
  setStatus(status: QualityStatus): void {
    this.status = status;
  }

  /**
   * Create initial status with all signals passing.
   *
   * Defaults to all-passing so unimplemented signals don't block work.
   * As real runners are added, they will report actual state.
   */
  private createInitialStatus(): QualityStatus {
    const now = new Date();
    return {
      [SignalType.Tests]: { state: 'pass', timestamp: now },
      [SignalType.Types]: { state: 'pass', timestamp: now },
      [SignalType.Build]: { state: 'pass', timestamp: now },
      [SignalType.OxLint]: { state: 'pass', timestamp: now },
      [SignalType.CustomLint]: { state: 'pass', timestamp: now },
      aggregatedAt: now,
      isPartial: false,
    };
  }
}

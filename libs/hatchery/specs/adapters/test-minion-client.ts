import type { IMinionClient } from '../../src/ports/IMinionClient';
import type { MinionSpec, MinionMessage } from '@minions/domain-types';
import type { MinionSpecWithExtensions } from '../../src/domain/MinionSpecExtensions';

/**
 * Test implementation of IMinionClient for contract testing
 *
 * This is a minimal client that provides controllable behavior for testing
 * RealMinion. Similar to BrainlessMinion's dual co-routine pattern, but
 * implements the IMinionClient interface instead of IMinion.
 *
 * Features:
 * - Async queue-based communication
 * - Controllable from test code
 * - Minimal implementation to satisfy IMinionClient contract
 */
export class TestMinionClient implements IMinionClient {
  readonly type = 'test-client';

  private incomingQueue: MinionMessage[] = [];
  private outgoingQueue: MinionMessage[] = [];
  private incomingResolvers: Array<(value: IteratorResult<MinionMessage>) => void> = [];
  private isRunning = false;
  async start(spec: MinionSpec): Promise<void> {
    if (this.isRunning) {
      throw new Error('Client already started');
    }
    this.isRunning = true;

    // Prepend synthetic history if provided in spec
    const extendedSpec = spec as MinionSpecWithExtensions;
    if (extendedSpec.syntheticHistory && Array.isArray(extendedSpec.syntheticHistory)) {
      this.incomingQueue.push(...extendedSpec.syntheticHistory);
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    // Resolve all pending promises with done
    while (this.incomingResolvers.length > 0) {
      const resolve = this.incomingResolvers.shift();
      if (resolve) {
        resolve({ done: true, value: undefined });
      }
    }
  }

  async send(message: MinionMessage): Promise<void> {
    if (!this.isRunning) {
      throw new Error('Client not running');
    }
    this.outgoingQueue.push(message);
  }

  async *receive(): AsyncIterableIterator<MinionMessage> {
    while (this.isRunning) {
      // If we have messages queued, yield them
      if (this.incomingQueue.length > 0) {
        const message = this.incomingQueue.shift();
        if (message) {
          yield message;
        }
      } else {
        // Wait for next message
        const message = await new Promise<MinionMessage | null>((resolve) => {
          if (!this.isRunning) {
            resolve(null);
            return;
          }
          this.incomingResolvers.push((result) => {
            resolve(result.done ? null : result.value);
          });
        });

        if (message) {
          yield message;
        } else {
          // Client stopped
          break;
        }
      }
    }
  }

  kill(): void {
    this.isRunning = false;
    // Resolve all pending promises with done
    while (this.incomingResolvers.length > 0) {
      const resolve = this.incomingResolvers.shift();
      if (resolve) {
        resolve({ done: true, value: undefined });
      }
    }
  }

  interrupt(): void {
    // No-op for test client
  }

  /**
   * Test helper: Simulate the client sending a message to production
   * (i.e., add to incoming queue for receive() to yield)
   */
  simulateMessage(message: MinionMessage): void {
    if (!this.isRunning) {
      throw new Error('Client not running - cannot simulate message');
    }

    if (this.incomingResolvers.length > 0) {
      // Someone is waiting, resolve immediately
      const resolve = this.incomingResolvers.shift();
      if (resolve) {
        resolve({ done: false, value: message });
      }
    } else {
      // Queue for later
      this.incomingQueue.push(message);
    }
  }

  /**
   * Test helper: Get messages sent to the client (from production via send())
   */
  getSentMessages(): MinionMessage[] {
    return [...this.outgoingQueue];
  }

  /**
   * Test helper: Clear outgoing message queue
   */
  clearSentMessages(): void {
    this.outgoingQueue = [];
  }
}

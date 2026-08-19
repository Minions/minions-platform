import type { TestMinionClient } from '../adapters/test-minion-client';
import type { MinionMessage } from '@minions/domain-types';

/**
 * AutoResponder - Automatic response behavior for test clients
 *
 * This utility sets up automatic response behavior for TestMinionClient instances.
 * It monitors messages sent to the client and automatically simulates responses
 * based on a configured response map.
 *
 * Features:
 * - Background polling of sent messages
 * - Message tracking to avoid duplicate responses
 * - Configurable response map
 * - Automatic cleanup on stop
 *
 * Usage:
 * ```typescript
 * const responder = new AutoResponder(client, new Map([
 *   ['/help', { type: 'text', content: 'Help information', timestamp: Date.now() }],
 *   ['echo hi', { type: 'text', content: 'hi', timestamp: Date.now() }]
 * ]));
 * responder.start();
 * // ... run tests ...
 * responder.stop();
 * ```
 */
export class AutoResponder {
  private checkInterval: NodeJS.Timeout | null = null;
  private processedCount = 0;
  private isStarted = false;

  /**
   * Create an AutoResponder
   *
   * @param client - The TestMinionClient to monitor and respond through
   * @param responseMap - Map of message content to response messages
   * @param defaultResponse - Optional default response for unmatched messages
   */
  constructor(
    private client: TestMinionClient,
    private responseMap: Map<string, MinionMessage>,
    private defaultResponse?: MinionMessage
  ) {}

  /**
   * Start monitoring and responding to messages
   *
   * This begins a background polling loop that checks for new messages
   * sent to the client and automatically simulates responses.
   */
  start(): void {
    if (this.isStarted) {
      throw new Error('AutoResponder already started');
    }

    this.isStarted = true;
    this.processedCount = 0;

    // Background task to respond to messages
    (async () => {
      try {
        // Give the minion a chance to set up its receive iterator
        await new Promise(resolve => setTimeout(resolve, 10));

        // Start polling for messages
        this.checkInterval = setInterval(() => {
          this.processNewMessages();
        }, 5);
      } catch {
        // Silently handle errors in background task
        this.stop();
      }
    })().catch(() => {
      // Prevent unhandled promise rejection
    });
  }

  /**
   * Stop monitoring and clean up
   */
  stop(): void {
    if (this.checkInterval !== null) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.isStarted = false;
  }

  /**
   * Process any new messages that have been sent to the client
   */
  private processNewMessages(): void {
    try {
      const messages = this.client.getSentMessages();

      // Only process new messages
      if (messages.length > this.processedCount) {
        const newMessages = messages.slice(this.processedCount);
        this.processedCount = messages.length;

        for (const message of newMessages) {
          this.respondToMessage(message);
        }
      }

      // Stop checking if client is no longer running
      if (!this.client['isRunning']) {
        this.stop();
      }
    } catch {
      // Silently handle errors in interval callback
      this.stop();
    }
  }

  /**
   * Generate and simulate a response for a given message
   */
  private respondToMessage(message: MinionMessage): void {
    if (message.type !== 'user') {
      return;
    }

    const content = message.content;

    // Check if we have a configured response for this message
    const response = this.responseMap.get(content);

    if (response) {
      this.client.simulateMessage(response);
    } else if (this.defaultResponse) {
      this.client.simulateMessage(this.defaultResponse);
    }
  }
}

import { EventEmitter } from 'events';
import type { IMinion, MinionMessage } from '@minions/hatchery';
import type { ContentBlock } from './events';
import { MessageCapture } from './MessageCapture';
import type { MinionExecutor } from './types';

/**
 * Adapter that bridges hatchery's IMinion to cabinet's event system.
 *
 * This adapter:
 * - Listens to messages from a hatchery minion via its receive() async iterator
 * - Translates hatchery messages to cabinet's content blocks
 * - Emits events that cabinet's server.ts expects ('turn_started', 'content', 'turn_ended', 'error')
 * - Provides a sendMessage() method compatible with cabinet's API
 * - Implements MinionExecutor interface for type-safe integration
 */
export class HatcheryMinionAdapter extends EventEmitter implements MinionExecutor {
  private minion: IMinion;
  private receiving = false;
  private receiveTask: Promise<void> | null = null;
  private messageCapture: MessageCapture;
  private currentInteractionId: string | null = null;

  constructor(minion: IMinion, messageCapture?: MessageCapture) {
    super();
    this.minion = minion;
    this.messageCapture = messageCapture ?? new MessageCapture();
  }

  /**
   * Start receiving messages from the minion
   */
  async start(): Promise<void> {
    if (this.receiving) {
      throw new Error('Already started');
    }

    this.receiving = true;
    this.receiveTask = this.receiveLoop();
  }

  /**
   * Send a message to the minion
   */
  async sendMessage(message: string): Promise<void> {
    // Start capturing this interaction
    const interaction = this.messageCapture.startInteraction(message, message);
    this.currentInteractionId = interaction.id;

    this.emit('turn_started');

    try {
      const userMessage: MinionMessage = {
        type: 'user',
        content: message,
        timestamp: Date.now()
      };

      // Capture the user message being sent
      if (this.currentInteractionId) {
        this.messageCapture.addResponseBlock(this.currentInteractionId, {
          type: 'user-message-sent',
          content: message,
          timestamp: Date.now()
        });
      }

      await this.minion.send(userMessage);
    } catch (error) {
      // Capture the error
      if (this.currentInteractionId) {
        this.messageCapture.completeInteraction(
          this.currentInteractionId,
          error instanceof Error ? error.message : String(error)
        );
        this.currentInteractionId = null;
      }

      this.emit('error', error);
      this.emit('turn_ended');
      throw error;
    }
  }

  /**
   * Stop receiving messages and kill the minion
   */
  stop(): void {
    this.receiving = false;
    this.minion.kill();

    // Wait for receive loop to finish
    if (this.receiveTask) {
      this.receiveTask.finally(() => {
        this.emit('session_ended');
      });
    } else {
      this.emit('session_ended');
    }
  }

  /**
   * Check if adapter is running
   */
  isRunning(): boolean {
    return this.receiving;
  }

  /**
   * Get the underlying hatchery minion
   */
  getMinion(): IMinion {
    return this.minion;
  }

  /**
   * Get the message capture instance for debugging/introspection
   */
  getMessageCapture(): MessageCapture {
    return this.messageCapture;
  }

  /**
   * Receive loop that translates hatchery messages to cabinet events
   */
  private async receiveLoop(): Promise<void> {
    try {
      for await (const message of this.minion.receive()) {
        if (!this.receiving) {
          break;
        }

        // Process each message with error handling so one bad message
        // doesn't kill the whole session
        try {
          // Capture the raw message
          if (this.currentInteractionId) {
            this.messageCapture.addResponseBlock(this.currentInteractionId, {
              type: 'hatchery-message',
              message: message,
              timestamp: message.timestamp || Date.now()
            });
          }

          const contentBlock = this.translateMessage(message);
          if (contentBlock) {
            this.emit('content', contentBlock);
          }

          // After receiving a complete response from the minion, emit turn_ended
          // For now, we'll emit turn_ended after any text message
          // This may need refinement based on actual message patterns
          if (message.type === 'text' || message.type === 'error') {
            // Complete the interaction capture
            if (this.currentInteractionId) {
              const errorMsg = message.type === 'error' && message.error?.message
                ? message.error.message
                : undefined;
              this.messageCapture.completeInteraction(
                this.currentInteractionId,
                errorMsg
              );
              this.currentInteractionId = null;
            }

            this.emit('turn_ended');
          }
        } catch (msgError) {
          // Log but don't crash on individual message processing errors
          console.error('[HatcheryMinionAdapter] Error processing message:', msgError);
          console.error('[HatcheryMinionAdapter] Problematic message:', JSON.stringify(message, null, 2));
        }
      }

      // Iterator completed - minion is dead
      if (this.receiving) {
        this.receiving = false;
        this.emit('session_ended');
      }
    } catch (error) {
      // Complete interaction with error
      if (this.currentInteractionId) {
        this.messageCapture.completeInteraction(
          this.currentInteractionId,
          error instanceof Error ? error.message : String(error)
        );
        this.currentInteractionId = null;
      }

      this.emit('error', error);
      this.receiving = false;
      this.emit('session_ended');
    }
  }

  /**
   * Translate a hatchery MinionMessage to a cabinet ContentBlock
   *
   * This method handles all known message types and gracefully handles
   * unknown types that might come from different client implementations.
   */
  private translateMessage(message: MinionMessage): ContentBlock | null {
    switch (message.type) {
      case 'text':
        return {
          type: 'message',
          content: message.content,
          role: 'assistant'
        };

      case 'thinking':
        return {
          type: 'reasoning',
          content: message.content
        };

      case 'tool_use':
        return {
          type: 'tool_use',
          name: message.name,
          input: message.input
        };

      case 'tool_result':
        return {
          type: 'tool_result',
          content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
          isError: message.is_error
        };

      case 'error': {
        // Extract error message safely - handle malformed error messages
        const errorMessage = message.error?.message ?? 'Unknown error';
        // Log the error but don't throw - just emit and continue
        console.warn('[HatcheryMinionAdapter] Error message received:', errorMessage);
        return null;
      }

      case 'status':
        // Status messages don't map directly to content blocks
        // Could be logged or handled differently
        return null;

      case 'user':
        // User messages sent from production to minion shouldn't come back
        return null;

      default: {
        // Handle unknown message types gracefully at runtime
        // TypeScript's exhaustive check is for compile time, but at runtime
        // we may receive message types that aren't in our union (from different clients)
        const unknownMessage = message as { type: string };
        console.warn('[HatcheryMinionAdapter] Unknown message type:', unknownMessage.type);
        return null;
      }
    }
  }
}

import { Effect } from 'effect';
import type { IMinion, MessageFilter, MinionSpec, MinionMessage, UserMessage, TextMessage, ThinkingMessage, ToolUseMessage, ErrorMessage, StatusMessage, ToolResultMessage } from '@minions/domain-types';
import { ReconfigureError } from '@minions/domain-types';
import type { ExecutableGadget, ToolResult } from '@minions/gadgets';
import type { Costume } from '../../domain';
import type { MinionSpecWithExtensions } from '../../domain/MinionSpecExtensions';

/**
 * Test fake minion with dual co-routine for testing
 *
 * BrainlessMinion is a test double that implements the IMinion interface
 * but provides complete control from the test side. It has two separate
 * communication channels:
 *
 * **Production Side** (what production code uses):
 * - send(message) - Send message from production to minion
 * - receive() - Receive messages from minion to production
 *
 * **Test Side** (what test code uses):
 * - testSend(message) - Send message from minion to production (simulate minion response)
 * - testReceive() - Receive messages from production to minion (observe what production sent)
 * - kill() - Stop the minion (causes receive() iterators to complete)
 * - interrupt() - Interrupt current operation (sets interrupt flag)
 *
 * The minion is always running from construction until kill() is called. The back-side
 * co-routine runs automatically from construction.
 *
 * This dual co-routine pattern allows tests to:
 * - Fully control minion behavior without mocking
 * - Observe what production code sends to the minion
 * - Simulate arbitrary minion responses
 * - Test complex interaction patterns
 *
 * @example
 * ```typescript
 * const minion = new BrainlessMinion(spec);
 *
 * // Production sends a question
 * await minion.send({ type: 'user', content: 'What is 2+2?' });
 *
 * // Test observes the question
 * const question = await minion.testReceive().next();
 * expect(question.value.content).toBe('What is 2+2?');
 *
 * // Test simulates minion answering
 * await minion.testSend({ type: 'text', content: '4' });
 *
 * // Production receives the answer
 * const answer = await minion.receive().next();
 * expect(answer.value.content).toBe('4');
 *
 * // When done, kill the minion
 * minion.kill();
 * ```
 */

/**
 * Type for back-side co-routine function that processes incoming messages
 * and generates responses automatically
 */
export type BackSideCoRoutine = (minion: BrainlessMinion) => Promise<void>;

/**
 * Callback for turn completion events
 */
export type TurnCompleteCallback = (minionId: string) => void;

/**
 * Callback for status change events
 */
export type StatusChangeCallback = (minionId: string, oldStatus: 'processing' | 'waiting' | 'dead', newStatus: 'processing' | 'waiting' | 'dead') => void;

/**
 * Options for configuring BrainlessMinion behavior
 */
export interface BrainlessMinionOptions {
  /** Maximum buffer size before applying backpressure. Undefined = unlimited. */
  maxBufferSize?: number;

  /** Callback to invoke when a turn completes */
  onTurnComplete?: TurnCompleteCallback;

  /** Callback to invoke when status changes */
  onStatusChange?: StatusChangeCallback;

  /** Executable gadgets with mission context */
  executableGadgets?: ExecutableGadget[];
}

export class BrainlessMinion implements IMinion {
  readonly id: string;
  readonly spec: MinionSpec;

  // Internal mutable costume reference
  private _costume?: Costume;

  // Production → Test channel
  private prodToTestQueue: MinionMessage[] = [];

  // Test → Production broadcast channel
  // Each receive() subscriber gets its own queue; testSend() fans out to all
  private receiveSubscribers: Array<{ queue: MinionMessage[]; notify: () => void }> = [];

  // Synthetic history: messages buffered before any subscriber connects
  private _syntheticHistory: MinionMessage[] = [];

  // Minion alive flag
  private alive = true;

  // Interrupt flag - can be checked by back-side co-routine
  private interrupted = false;

  // Status tracking - Effect Ref for reactive monitoring
  private _status: 'processing' | 'waiting' | 'dead' = 'waiting';

  // Buffer configuration
  private readonly maxBufferSize?: number;

  // Turn completion callback
  private readonly onTurnComplete?: TurnCompleteCallback;

  // Status change callback
  private readonly onStatusChange?: StatusChangeCallback;

  // Executable gadgets with mission context (package-private for back-side co-routine)
  readonly executableGadgets: ExecutableGadget[];

  constructor(spec: MinionSpec, backSideCoRoutine?: BackSideCoRoutine, options?: BrainlessMinionOptions) {
    this.id = `brainless-${Math.random().toString(36).slice(2, 11)}`;
    this.spec = spec;
    this._costume = spec.costume;
    this.maxBufferSize = options?.maxBufferSize;
    this.onTurnComplete = options?.onTurnComplete;
    this.onStatusChange = options?.onStatusChange;
    this.executableGadgets = options?.executableGadgets ?? [];

    // Prepend synthetic history if provided — will be delivered to first receive() subscriber
    const extendedSpec = spec as MinionSpecWithExtensions;
    if (extendedSpec.syntheticHistory && Array.isArray(extendedSpec.syntheticHistory)) {
      // Fan out to any already-connected subscribers (none yet at construction time)
      // or buffer for the first subscriber
      this._syntheticHistory = [...extendedSpec.syntheticHistory];
    }

    // Start back-side co-routine immediately
    const routine = backSideCoRoutine || defaultBackSideCoRoutine;
    routine(this).catch(err => {
      console.error('Back-side co-routine error:', err);
      this.alive = false;
    });
  }

  /**
   * Get current costume configuration
   */
  get costume(): Costume | undefined {
    return this._costume;
  }

  /**
   * Get workbench for shared context
   */
  get workbench() {
    return (this.spec as MinionSpecWithExtensions).workbench;
  }

  /**
   * Get current processing status
   */
  get status(): 'processing' | 'waiting' | 'dead' {
    return this._status;
  }

  /**
   * Production interface: Send message from production to minion
   *
   * This queues the message for the test side to receive via testReceive().
   * If maxBufferSize is set and the buffer is full, this will block until
   * space becomes available (backpressure).
   *
   * Status transition: 'waiting' -> 'processing'
   */
  async send(message: MinionMessage): Promise<void> {
    if (!this.alive) {
      throw new Error('Cannot send to dead minion');
    }

    // Transition to processing when message is sent
    this.transitionStatus('processing');

    // Apply backpressure if buffer is full
    if (this.maxBufferSize !== undefined) {
      while (this.prodToTestQueue.length >= this.maxBufferSize && this.alive) {
        // Wait for buffer to have space
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }

    this.prodToTestQueue.push(message);
  }

  /**
   * Production interface: Receive messages from minion to production
   *
   * Each call creates an independent subscriber that receives ALL messages
   * sent via testSend() from this point forward (broadcast pattern).
   * Multiple concurrent consumers (e.g. startTurnPump + test code) each
   * get their own copy of every message.
   *
   * Any messages that arrived before this subscriber connected (synthetic
   * history or messages sent before first subscriber) are delivered first.
   *
   * When the minion dies, this iterator drains remaining buffered messages
   * and then completes.
   *
   * @param filter - Optional filter to receive only specific message types
   */
  async *receive(filter?: MessageFilter): AsyncIterableIterator<MinionMessage> {
    // Each subscriber has its own private queue and a notify mechanism
    const queue: MinionMessage[] = [];
    let notifyResolve: (() => void) | null = null;
    const notify = () => {
      if (notifyResolve) {
        const r = notifyResolve;
        notifyResolve = null;
        r();
      }
    };
    const subscriber = { queue, notify };

    // Deliver buffered synthetic history to this subscriber
    if (this._syntheticHistory.length > 0) {
      queue.push(...this._syntheticHistory);
      this._syntheticHistory = [];
    }

    this.receiveSubscribers.push(subscriber);

    try {
      while (this.alive) {
        while (queue.length > 0) {
          const msg = queue.shift();
          if (msg && matchesFilter(msg, filter)) {
            yield msg;
          }
        }
        if (!this.alive) break;
        // Wait for next message notification or a periodic wake-up
        await new Promise<void>(resolve => {
          let timer: ReturnType<typeof setTimeout> | null = null;
          notifyResolve = () => {
            if (timer !== null) {
              clearTimeout(timer);
              timer = null;
            }
            resolve();
          };
          // Also wake up periodically in case minion dies without notify
          timer = setTimeout(() => {
            timer = null;
            if (notifyResolve) {
              notifyResolve = null;
              resolve();
            }
          }, 10);
        });
      }

      // Drain remaining buffered messages after minion dies
      while (queue.length > 0) {
        const msg = queue.shift();
        if (msg && matchesFilter(msg, filter)) {
          yield msg;
        }
      }
    } finally {
      // Unsubscribe when iterator is done or abandoned
      const idx = this.receiveSubscribers.indexOf(subscriber);
      if (idx !== -1) {
        this.receiveSubscribers.splice(idx, 1);
      }
    }
  }

  /**
   * Test interface: Send message from minion to production (simulate response)
   *
   * This fans out the message to all active receive() subscribers.
   * Each subscriber gets its own copy of the message so that multiple
   * concurrent consumers (e.g. startTurnPump + test code) all see it.
   */
  async testSend(message: MinionMessage): Promise<void> {
    if (this.receiveSubscribers.length === 0) {
      // No subscribers yet — buffer in synthetic history for future subscribers
      this._syntheticHistory.push(message);
    } else {
      // Fan out to all active subscribers
      for (const sub of this.receiveSubscribers) {
        sub.queue.push(message);
        sub.notify();
      }
    }
  }

  /**
   * Test interface: Receive messages from production to minion (observe production)
   *
   * This yields messages that production sent via send().
   * When the minion dies, this iterator drains remaining messages then completes.
   *
   * @param filter - Optional filter to receive only specific message types
   */
  async *testReceive(filter?: MessageFilter): AsyncIterableIterator<MinionMessage> {
    while (this.alive) {
      while (this.prodToTestQueue.length > 0) {
        const msg = this.prodToTestQueue.shift();
        if (msg && matchesFilter(msg, filter)) {
          yield msg;
        }
      }
      // Small delay to prevent busy-wait
      await new Promise(resolve => setTimeout(resolve, 10));
    }

    // Drain remaining buffered messages after minion dies
    while (this.prodToTestQueue.length > 0) {
      const msg = this.prodToTestQueue.shift();
      if (msg && matchesFilter(msg, filter)) {
        yield msg;
      }
    }
  }

  /**
   * IMinion interface: Reconfigure the minion with a new costume
   *
   * Completely replaces the current costume with the provided costume.
   * This is a complete replacement operation - no merging or blending.
   *
   * Validates that model is not changed (throws ReconfigureError if attempted).
   *
   * @param costume - Complete costume to replace the current costume with
   * @returns Effect that succeeds with void or fails with ReconfigureError
   */
  reconfigure(costume: Costume): Effect.Effect<void, ReconfigureError, never> {
    return Effect.gen(this, function* () {
      // If no costume exists yet, we can't reconfigure
      if (!this._costume) {
        return yield* Effect.fail(
          new ReconfigureError({
            reason: 'Cannot reconfigure minion without initial costume',
            minionId: this.id,
          })
        );
      }

      // Note: Model changes are allowed - for real minions, the client will be restarted with the new model
      // For brainless minions, the model field is stored but not used

      // Complete replacement - no merging
      this._costume = costume;

      return yield* Effect.succeed(undefined);
    });
  }

  /**
   * IMinion interface: Kill the minion
   *
   * This stops the minion, causing receive() and testReceive() iterators to complete.
   *
   * Status transition: any -> 'dead'
   */
  kill(): void {
    // Transition to dead before marking as not alive
    this.transitionStatus('dead');
    this.alive = false;

    // Wake up all receive() subscribers so they can drain and exit
    for (const sub of this.receiveSubscribers) {
      sub.notify();
    }
  }

  /**
   * IMinion interface: Interrupt the minion's current operation
   *
   * This sets an interrupt flag that the back-side co-routine can check.
   * The minion continues running, but may cancel its current task.
   * The flag is automatically cleared after being set.
   */
  interrupt(): void {
    this.interrupted = true;
    // Auto-clear after a short delay to allow back-side to process
    setTimeout(() => {
      this.interrupted = false;
    }, 100);
  }

  /**
   * Test interface: Check if minion is alive
   *
   * This is a test-only method not part of IMinion interface.
   */
  isAlive(): boolean {
    return this.alive;
  }

  /**
   * Test interface: Check if minion was interrupted
   *
   * This is a test-only method not part of IMinion interface.
   */
  wasInterrupted(): boolean {
    return this.interrupted;
  }

  /**
   * Test interface: Get executable gadgets
   *
   * This is a test-only method not part of IMinion interface.
   * Used by back-side co-routine to execute gadgets.
   */
  getExecutableGadgets(): ExecutableGadget[] {
    return this.executableGadgets;
  }

  /**
   * Test interface: Manually trigger turn completion
   *
   * This simulates the minion completing a turn (e.g., Claude API returning stop_reason: "end_turn").
   * Invokes the onTurnComplete callback if one was provided.
   *
   * Status transition: 'processing' -> 'waiting'
   *
   * This is a test-only method not part of IMinion interface.
   */
  completeTurn(): void {
    // Transition to waiting when turn completes
    this.transitionStatus('waiting');

    if (this.onTurnComplete) {
      this.onTurnComplete(this.id);
    }
  }

  /**
   * Internal helper: Transition status and emit StatusChange event
   *
   * @param newStatus - The new status to transition to
   */
  private transitionStatus(newStatus: 'processing' | 'waiting' | 'dead'): void {
    const oldStatus = this._status;
    if (oldStatus === newStatus) {
      return; // No transition needed
    }

    this._status = newStatus;

    // Emit StatusChange event via callback
    if (this.onStatusChange) {
      this.onStatusChange(this.id, oldStatus, newStatus);
    }
  }
}

/**
 * Helper function to check if a message matches a filter
 *
 * @param msg - Message to check
 * @param filter - Optional filter criteria
 * @returns true if message matches filter (or no filter), false otherwise
 */
function matchesFilter(msg: MinionMessage, filter?: MessageFilter): boolean {
  if (!filter) {
    return true; // No filter means accept all messages
  }

  if (filter.type) {
    return msg.type === filter.type;
  }

  if (filter.types && filter.types.length > 0) {
    return filter.types.includes(msg.type);
  }

  return true; // Empty filter means accept all
}

/**
 * Default back-side co-routine that responds to standard test prompts
 *
 * Processes incoming user messages and generates appropriate responses:
 * - /help → text message with help content
 * - respond with exactly "hi" → text message "hi"
 * - /exit → gracefully stops the minion
 * - /echo <text> → text message with <text>
 * - /think <content> → thinking message with content
 * - /use tool <name> with <params> → tool_use message
 * - /error <message> → error message
 * - /status <status> → status message
 * - /turn-complete → triggers turn completion event
 */
async function defaultBackSideCoRoutine(minion: BrainlessMinion): Promise<void> {
  for await (const message of minion.testReceive()) {
    if (message.type !== 'user') {
      continue;
    }

    const userMessage = message as UserMessage;
    const content = userMessage.content;

    let response: MinionMessage | null = null;

    // Handle /exit command - gracefully stop the minion
    if (content === '/exit') {
      minion.kill();
      return;
    }
    // Handle /turn-complete command
    else if (content === '/turn-complete') {
      minion.completeTurn();
      // Don't send a response - turn completion is a side effect
      continue;
    }
    // Handle /help command
    else if (content === '/help') {
      response = {
        type: 'text',
        content: 'Available commands:\n- /help: Show this help\n- /exit: Stop the minion\n- /echo <text>: Echo text back\n- /think <content>: Generate thinking message\n- /use tool <name> with <params>: Generate tool use\n- /error <message>: Generate error\n- /status <status>: Generate status update\n- /turn-complete: Trigger turn completion event',
        timestamp: Date.now()
      } as TextMessage;
    }
    // Handle exact echo request
    else if (content === 'respond with exactly "hi"') {
      response = {
        type: 'text',
        content: 'hi',
        timestamp: Date.now()
      } as TextMessage;
    }
    // Handle /echo command
    else if (content.startsWith('/echo ')) {
      const text = content.slice(6);
      response = {
        type: 'text',
        content: text,
        timestamp: Date.now()
      } as TextMessage;
    }
    // Handle /think command
    else if (content.startsWith('/think ')) {
      const thinkingContent = content.slice(7);
      response = {
        type: 'thinking',
        content: thinkingContent,
        timestamp: Date.now()
      } as ThinkingMessage;
    }
    // Handle /use tool command
    else if (content.startsWith('/use tool ')) {
      const rest = content.slice(10);
      const withIndex = rest.indexOf(' with ');
      if (withIndex !== -1) {
        const toolName = rest.slice(0, withIndex);
        const paramsJson = rest.slice(withIndex + 6);
        try {
          const input = JSON.parse(paramsJson);

          // Check if tool matches an executable gadget
          const gadget = minion.getExecutableGadgets().find(g => g.tool.name === toolName);

          if (gadget) {
            // Execute the gadget synchronously
            const toolUseId = `tool_${Math.random().toString(36).slice(2, 11)}`;
            try {
              const toolResult: ToolResult = await Effect.runPromise(gadget.execute(input));

              // Emit ToolResultMessage based on execution result
              response = {
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: toolResult.success ? toolResult.result : toolResult.error,
                is_error: !toolResult.success,
                timestamp: Date.now()
              } as ToolResultMessage;
            } catch (err) {
              // If Effect.runPromise throws, emit ToolResultMessage with error
              response = {
                type: 'tool_result',
                tool_use_id: toolUseId,
                content: `Gadget execution error: ${err}`,
                is_error: true,
                timestamp: Date.now()
              } as ToolResultMessage;
            }
          } else {
            // Fall back to existing behavior (create ToolUseMessage)
            response = {
              type: 'tool_use',
              id: `tool_${Math.random().toString(36).slice(2, 11)}`,
              name: toolName,
              input,
              timestamp: Date.now()
            } as ToolUseMessage;
          }
        } catch (err) {
          response = {
            type: 'error',
            error: {
              message: `Failed to parse tool input: ${err}`,
              code: 'invalid_tool_input'
            },
            timestamp: Date.now()
          } as ErrorMessage;
        }
      }
    }
    // Handle /error command
    else if (content.startsWith('/error ')) {
      const errorText = content.slice(7);
      const colonIndex = errorText.indexOf(': ');
      if (colonIndex !== -1) {
        const code = errorText.slice(0, colonIndex);
        const message = errorText.slice(colonIndex + 2);
        response = {
          type: 'error',
          error: { message, code },
          timestamp: Date.now()
        } as ErrorMessage;
      } else {
        response = {
          type: 'error',
          error: { message: errorText },
          timestamp: Date.now()
        } as ErrorMessage;
      }
    }
    // Handle /status command
    else if (content.startsWith('/status ')) {
      const status = content.slice(8);
      response = {
        type: 'status',
        status,
        timestamp: Date.now()
      } as StatusMessage;
    }

    // Send response if one was generated
    if (response) {
      await minion.testSend(response);
    }
  }
}

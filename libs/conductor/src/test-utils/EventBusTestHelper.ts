import type { EventBus, EventFilterOptions, AnyEventDeclaration, PayloadOf, TypedEvent } from '@minions/events';

/**
 * Helper for testing EventBus that handles timing concerns
 *
 * EventBus uses Effect fibers and PubSub which operate asynchronously.
 * This helper abstracts the timing delays needed for events to propagate
 * through the system during tests.
 *
 * @example
 * ```typescript
 * const bus = new EventBus();
 * const helper = new EventBusTestHelper(bus);
 * const TestEvent = defineEvent<{ message: string }>('test-event');
 *
 * const handler = vi.fn();
 * const unsubscribe = await helper.subscribeAndWait(TestEvent, handler);
 *
 * await helper.emitAndWait(TestEvent, { message: 'hello' });
 *
 * expect(handler).toHaveBeenCalledOnce();
 *
 * await helper.unsubscribeAndWait(unsubscribe);
 * ```
 */
export class EventBusTestHelper<Bus extends EventBus> {
  constructor(
    private readonly bus: Bus,
    private readonly startupDelayMs = 10,
    private readonly processingDelayMs = 10
  ) {}

  /**
   * Emit an event and wait for handlers to process it
   */
  async emitAndWait<E extends
AnyEventDeclaration>(
    event: E,
    payload: PayloadOf<E>
  ): Promise<void> {
    this.bus.emit(event, payload);
    await this.delay(this.processingDelayMs);
  }

  /**
   * Emit an event from a specific source and wait for handlers to process it
   */
  async emitFromAndWait<E extends
AnyEventDeclaration>(
    event: E,
    payload: PayloadOf<E>,
    source: string
  ): Promise<void> {
    this.bus.emitFrom(event, payload, source);
    await this.delay(this.processingDelayMs);
  }

  /**
   * Subscribe to an event and wait for the subscription to be ready
   */
  async subscribeAndWait<E extends
AnyEventDeclaration>(
    event: E,
    handler: (event: TypedEvent<E>) => void,
    options?: EventFilterOptions<TypedEvent<E>>
  ): Promise<() => void> {
    const unsubscribe = this.bus.on(event, handler, options);
    await this.delay(this.startupDelayMs);
    return unsubscribe;
  }

  /**
   * Set up a once() subscription and return the promise after waiting for setup
   *
   * Note: This method is SYNCHRONOUS and returns a promise immediately.
   * To use it, do NOT await the method call itself:
   *
   * CORRECT:
   *   const promise = helper.onceAndWait(TestEvent);  // Don't await this!
   *   await helper.wait();                             // Wait for setup separately
   *   bus.emit(TestEvent, { value: 42 });
   *   const event = await promise;                     // Await the promise
   *
   * INCORRECT:
   *   const promise = await helper.onceAndWait(TestEvent);  // DON'T DO THIS
   *
   * @param event - Event declaration
   * @param options - Filter options
   * @returns Promise that resolves when the event is emitted
   */
  onceAndWait<E extends
AnyEventDeclaration>(
    event: E,
    options?: EventFilterOptions<TypedEvent<E>>
  ): Promise<TypedEvent<E>> {
    // Start listening immediately
    const eventPromise = this.bus.once(event, options);

    // Schedule the "ready" notification after startup delay
    // This allows consumers to await wait() separately
    void this.delay(this.startupDelayMs);

    // Return the event promise directly
    return eventPromise;
  }

  /**
   * Unsubscribe and wait for cleanup
   */
  async unsubscribeAndWait(unsubscribe: () => void): Promise<void> {
    unsubscribe();
    await this.delay(this.processingDelayMs);
  }

  /**
   * Wait for a specified duration (exposed for edge cases)
   */
  async wait(ms: number = this.startupDelayMs): Promise<void> {
    await this.delay(ms);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

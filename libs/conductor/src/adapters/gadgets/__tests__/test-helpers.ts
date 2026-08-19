/**
 * Shared test helpers for gadget tests
 *
 * Consolidates common test setup, event declarations, costume factories,
 * and test doubles to reduce duplication across test files.
 */

import { Effect, Schema, Stream } from 'effect';
import { defineEvent } from '@minions/costumes';
import type { Costume } from '@minions/costumes';
import type { ParseResult } from 'effect';
import type { IEventBus, ActiveListener, AnyEventDeclaration } from '@minions/events';

/**
 * Standard test events used across multiple test files
 *
 * These are defined once to ensure consistency and reduce duplication.
 */
export const TestEvents = {
  /**
   * Event emitted when a test passes
   */
  TestPassed: defineEvent<{ testName: string; duration: number }>(
    'test-passed',
    Schema.Struct({
      testName: Schema.String,
      duration: Schema.Number,
    })
  ),

  /**
   * Event emitted when a build fails
   */
  BuildFailed: defineEvent<{ reason: string; exitCode: number }>(
    'build-failed',
    Schema.Struct({
      reason: Schema.String,
      exitCode: Schema.Number,
    })
  ),

  /**
   * Event without a schema (for testing schema-less events)
   */
  NoSchema: defineEvent<{ data: string }>('no-schema-event'),

  /**
   * Event with complex nested structure
   */
  Complex: defineEvent<{
    metadata: { timestamp: number; source: string };
    results: readonly { readonly name: string; readonly passed: boolean }[];
  }>(
    'complex-event',
    Schema.Struct({
      metadata: Schema.Struct({
        timestamp: Schema.Number,
        source: Schema.String,
      }),
      results: Schema.Array(
        Schema.Struct({
          name: Schema.String,
          passed: Schema.Boolean,
        })
      ),
    })
  ),
};

/**
 * Factory function for creating test costumes
 *
 * @param eventConfig - Optional configuration for events and model
 * @returns A costume suitable for testing
 */
export function createTestCostume(eventConfig?: {
  events?: Array<{ event: AnyEventDeclaration<unknown, string, never>; guidance: string }>;
  model?: string;
}): Costume {
  return {
    model: eventConfig?.model ?? 'test-model',
    events: eventConfig?.events,
  };
}

/**
 * Common costume configurations for testing
 *
 * Provides pre-configured costumes for common test scenarios.
 */
export const TestCostumes = {
  /**
   * Costume with a single TestPassed event
   */
  withTestEvent: () =>
    createTestCostume({
      events: [{ event: TestEvents.TestPassed, guidance: 'Emit when test passes' }],
    }),

  /**
   * Costume with multiple events
   */
  withMultipleEvents: () =>
    createTestCostume({
      events: [
        { event: TestEvents.TestPassed, guidance: 'Test guidance' },
        { event: TestEvents.BuildFailed, guidance: 'Build guidance' },
      ],
    }),

  /**
   * Costume with no events array (empty array)
   */
  withNoEvents: () => createTestCostume({ events: [] }),

  /**
   * Costume with undefined events
   */
  withUndefinedEvents: () => createTestCostume({ events: undefined }),
};

/**
 * Test double for IEventBus
 *
 * Provides a real implementation of IEventBus that records emitted events
 * for testing purposes. This is better than mocking because:
 * - It implements the full interface correctly
 * - It doesn't break if the interface changes
 * - It provides helpful assertion methods
 *
 * @example
 * ```typescript
 * const testEventBus = new TestEventBus();
 * const result = executeEmitEvent(costume, testEventBus, 'minion-123', input);
 * Effect.runSync(result);
 *
 * expect(testEventBus.wasEventEmitted('test-passed')).toBe(true);
 * const emitted = testEventBus.findEmittedEvent('test-passed');
 * expect(emitted?.payload).toEqual({ testName: 'auth-test', duration: 145 });
 * ```
 */
export class TestEventBus implements IEventBus {
  /**
   * Array of all events emitted to this bus
   */
  public emittedEvents: Array<{
    event: AnyEventDeclaration;
    payload: unknown;
    source: string;
  }> = [];

  /**
   * Emit an event from a specific source (primary method for gadget testing)
   *
   * Records the event for later assertion and always succeeds.
   */
  emitFromEffect<E extends AnyEventDeclaration>(
    event: E,
    payload: unknown,
    source: string
  ): Effect.Effect<void, ParseResult.ParseError, never> {
    this.emittedEvents.push({ event, payload, source });
    return Effect.succeed(undefined);
  }

  /**
   * Find the first emitted event of a given type
   *
   * @param eventType - The event type to search for
   * @returns The emitted event or undefined if not found
   */
  findEmittedEvent(eventType: string) {
    return this.emittedEvents.find((e) => e.event.type === eventType);
  }

  /**
   * Check if an event of a given type was emitted
   *
   * @param eventType - The event type to check
   * @returns True if the event was emitted
   */
  wasEventEmitted(eventType: string): boolean {
    return this.emittedEvents.some((e) => e.event.type === eventType);
  }

  /**
   * Clear all recorded events
   */
  clear() {
    this.emittedEvents = [];
  }

  // Stub implementations for IEventBus methods not used in gadget tests
  // These would need proper implementation if tests start using them

  on(): () => void {
    throw new Error('TestEventBus.on() not implemented - use real EventBus if needed');
  }

  subscribe(): Stream.Stream<never, never, never> {
    throw new Error('TestEventBus.subscribe() not implemented - use real EventBus if needed');
  }

  once(): Promise<never> {
    throw new Error('TestEventBus.once() not implemented - use real EventBus if needed');
  }

  emit(): void {
    throw new Error('TestEventBus.emit() not implemented - use real EventBus if needed');
  }

  emitEffect(): Effect.Effect<void, ParseResult.ParseError, never> {
    throw new Error('TestEventBus.emitEffect() not implemented - use real EventBus if needed');
  }

  emitFrom(): void {
    throw new Error('TestEventBus.emitFrom() not implemented - use real EventBus if needed');
  }

  getActiveListeners(): ActiveListener[] {
    return [];
  }
}

/**
 * Tests for ISignalRunner interface
 *
 * Verifies that the interface can be mocked for testing orchestrator behavior
 * and demonstrates usage patterns.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type {
  ISignalRunner,
  ExecutionStrategy,
  SignalRunnerEvent,
} from './ISignalRunner.js';
import { SignalType, type SignalState } from './SignalState.js';
import { SignalRunnerEvents } from './SignalRunnerEvents.js';
import { EventBus, type IEventBus } from '@minions/events';

/**
 * Helper to wait for async event handlers to complete
 * EventBus runs handlers asynchronously, so we need a small delay
 */
const waitForEvents = () => new Promise(resolve => setTimeout(resolve, 50));

/**
 * Mock implementation of ISignalRunner for testing orchestrators
 *
 * This implementation demonstrates how to create a test double that satisfies
 * the ISignalRunner interface. It allows manual control over state transitions
 * and event emission, making it easy to test orchestration logic.
 *
 * @example
 * ```typescript
 * // Create EventBus and mock runner
 * const eventBus = new EventBus();
 * const runner = new MockSignalRunner(SignalType.Tests, eventBus, {
 *   state: 'pending',
 *   timestamp: new Date(),
 * });
 *
 * // Subscribe to events
 * const events: Array<{ signalType: SignalType; state: SignalState }> = [];
 * eventBus.on(SignalRunnerEvents.StateChanged, (event) => {
 *   events.push(event);
 * });
 *
 * // Start the runner
 * await runner.start();
 *
 * // Manually transition to running state
 * runner.transitionTo({
 *   state: 'running',
 *   timestamp: new Date(),
 *   failures: [],
 * });
 *
 * // Manually transition to pass state
 * runner.transitionTo({
 *   state: 'pass',
 *   timestamp: new Date(),
 * });
 *
 * // Stop the runner
 * await runner.stop();
 * ```
 */
export class MockSignalRunner implements ISignalRunner {
  readonly signalType: SignalType;
  readonly strategy: ExecutionStrategy;

  private running = false;
  private state: SignalState;
  private eventBus: IEventBus;

  /**
   * Create a mock signal runner
   *
   * @param signalType - Type of signal this runner executes
   * @param eventBus - EventBus for emitting events
   * @param initialState - Initial state of the signal (defaults to pending)
   * @param strategy - Execution strategy (defaults to 'on-demand')
   */
  constructor(
    signalType: SignalType,
    eventBus: IEventBus,
    initialState?: SignalState,
    strategy: ExecutionStrategy = 'on-demand'
  ) {
    this.signalType = signalType;
    this.eventBus = eventBus;
    this.strategy = strategy;
    this.state = initialState ?? {
      state: 'pending',
      timestamp: new Date(),
    };
  }

  async start(): Promise<void> {
    if (this.running) {
      throw new Error('Runner is already running');
    }
    this.running = true;
    this.eventBus.emit(SignalRunnerEvents.Started, {
      signalType: this.signalType,
    });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.eventBus.emit(SignalRunnerEvents.Stopped, {
      signalType: this.signalType,
    });
  }

  getState(): SignalState {
    return this.state;
  }

  // Test helper methods (not part of interface)

  /**
   * Test helper: Check if the runner is currently running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Test helper: Manually transition to a new state and emit state-changed event
   *
   * This simulates a real runner's state progression, allowing tests to control
   * when and how state changes occur.
   */
  transitionTo(newState: SignalState): void {
    this.state = newState;
    this.eventBus.emit(SignalRunnerEvents.StateChanged, {
      signalType: this.signalType,
      state: newState,
    });
  }

  /**
   * Test helper: Emit an error event
   *
   * Simulates error conditions that might occur in real runners.
   */
  emitError(error: Error): void {
    this.eventBus.emit(SignalRunnerEvents.Error, {
      signalType: this.signalType,
      error,
    });
  }
}

/**
 * Test factory: Create a minimal ISignalRunner implementation
 *
 * This factory reduces duplication in interface contract tests by providing
 * a baseline implementation that can be customized via overrides.
 *
 * @param overrides - Partial ISignalRunner to override default properties
 * @returns A complete ISignalRunner implementation
 *
 * @example
 * ```typescript
 * // Create runner with defaults
 * const runner = createMinimalRunner();
 *
 * // Create runner with custom signalType
 * const runner = createMinimalRunner({
 *   signalType: SignalType.Build,
 * });
 *
 * // Create runner with custom behavior
 * const runner = createMinimalRunner({
 *   start: async () => { started = true; }
 * });
 * ```
 */
function createMinimalRunner(
  overrides?: Partial<ISignalRunner>
): ISignalRunner {
  return {
    signalType: SignalType.Tests,
    strategy: 'watch-mode',
    // oxlint-disable-next-line no-empty-function
    start: async () => {},
    // oxlint-disable-next-line no-empty-function
    stop: async () => {},
    getState: () => ({ state: 'pending', timestamp: new Date() }),
    ...overrides,
  };
}

describe('ISignalRunner', () => {
  describe('ExecutionStrategy', () => {
    it('accepts watch-mode strategy', () => {
      const strategy: ExecutionStrategy = 'watch-mode';
      expect(strategy).toBe('watch-mode');
    });

    it('accepts on-demand strategy', () => {
      const strategy: ExecutionStrategy = 'on-demand';
      expect(strategy).toBe('on-demand');
    });

    it('accepts file-triggered strategy', () => {
      const strategy: ExecutionStrategy = 'file-triggered';
      expect(strategy).toBe('file-triggered');
    });
  });

  describe('SignalRunnerEvent', () => {
    it('creates started event', () => {
      const event: SignalRunnerEvent = {
        type: 'started',
      };
      expect(event.type).toBe('started');
    });

    it('creates stopped event', () => {
      const event: SignalRunnerEvent = {
        type: 'stopped',
      };
      expect(event.type).toBe('stopped');
    });

    it('creates state-changed event with new state', () => {
      const newState: SignalState = {
        state: 'pass',
        timestamp: new Date(),
      };
      const event: SignalRunnerEvent = {
        type: 'state-changed',
        state: newState,
      };
      expect(event.type).toBe('state-changed');
      expect(event.state.state).toBe('pass');
    });

    it('creates state-changed event with fail state', () => {
      const newState: SignalState = {
        state: 'fail',
        timestamp: new Date(),
        failures: ['Test failed: expected true to be false'],
      };
      const event: SignalRunnerEvent = {
        type: 'state-changed',
        state: newState,
      };
      expect(event.type).toBe('state-changed');
      expect(event.state.state).toBe('fail');
      if (event.state.state === 'fail') {
        expect(event.state.failures).toHaveLength(1);
      }
    });

    it('creates state-changed event with running state', () => {
      const newState: SignalState = {
        state: 'running',
        timestamp: new Date(),
        failures: [],
      };
      const event: SignalRunnerEvent = {
        type: 'state-changed',
        state: newState,
      };
      expect(event.type).toBe('state-changed');
      expect(event.state.state).toBe('running');
    });

    it('creates error event with error details', () => {
      const error = new Error('Failed to start runner');
      const event: SignalRunnerEvent = {
        type: 'error',
        error,
      };
      expect(event.type).toBe('error');
      expect(event.error.message).toBe('Failed to start runner');
    });
  });

  describe('ISignalRunner interface', () => {
    it('defines required signalType property', () => {
      // This is a compile-time test - we're verifying the interface contract
      const runner = createMinimalRunner();
      expect(runner.signalType).toBe(SignalType.Tests);
    });

    it('defines required strategy property', () => {
      const runner = createMinimalRunner({
        signalType: SignalType.Types,
        strategy: 'on-demand',
      });
      expect(runner.strategy).toBe('on-demand');
    });

    it('can be used with EventBus for event notifications', async () => {
      const eventBus = new EventBus();
      // Create a runner to demonstrate EventBus integration (interface compliance)
      createMinimalRunner({
        signalType: SignalType.OxLint,
        strategy: 'file-triggered',
      });

      // Subscribe to events
      const events: Array<{ signalType: SignalType }> = [];
      eventBus.on(SignalRunnerEvents.Started, (event) => events.push(event));
      await waitForEvents(); // Wait for subscription to be ready

      // Simulate event emission
      eventBus.emit(SignalRunnerEvents.Started, { signalType: SignalType.OxLint });
      await waitForEvents();

      expect(events).toHaveLength(1);
      expect(events[0].signalType).toBe(SignalType.OxLint);
    });

    it('defines start method returning Promise<void>', async () => {
      let started = false;
      const runner = createMinimalRunner({
        signalType: SignalType.Build,
        start: async () => {
          started = true;
        },
      });

      await runner.start();
      expect(started).toBe(true);
    });

    it('defines stop method returning Promise<void>', async () => {
      let stopped = false;
      const runner = createMinimalRunner({
        stop: async () => {
          stopped = true;
        },
      });

      await runner.stop();
      expect(stopped).toBe(true);
    });

    it('defines getState method returning SignalState', () => {
      const state: SignalState = {
        state: 'pass',
        timestamp: new Date(),
      };
      const runner = createMinimalRunner({
        signalType: SignalType.Types,
        strategy: 'on-demand',
        getState: () => state,
      });

      const retrievedState = runner.getState();
      expect(retrievedState.state).toBe('pass');
    });

    it('demonstrates complete lifecycle with events', async () => {
      const eventBus = new EventBus();
      const allEvents: Array<{ type: string; signalType?: SignalType; state?: SignalState }> = [];

      // Subscribe to all event types
      eventBus.on(SignalRunnerEvents.Started, (event) =>
        allEvents.push({ type: 'started', signalType: event.signalType })
      );
      eventBus.on(SignalRunnerEvents.StateChanged, (event) =>
        allEvents.push({ type: 'state-changed', signalType: event.signalType, state: event.state })
      );
      eventBus.on(SignalRunnerEvents.Stopped, (event) =>
        allEvents.push({ type: 'stopped', signalType: event.signalType })
      );
      await waitForEvents(); // Wait for subscriptions to be ready

      const states: SignalState[] = [
        { state: 'pending', timestamp: new Date() },
        { state: 'running', timestamp: new Date(), failures: [] },
        { state: 'pass', timestamp: new Date() },
      ];
      let currentStateIndex = 0;

      const runner = createMinimalRunner({
        start: async () => {
          eventBus.emit(SignalRunnerEvents.Started, { signalType: SignalType.Tests });
          currentStateIndex = 1;
          eventBus.emit(SignalRunnerEvents.StateChanged, {
            signalType: SignalType.Tests,
            state: states[currentStateIndex]
          });
        },
        stop: async () => {
          eventBus.emit(SignalRunnerEvents.Stopped, { signalType: SignalType.Tests });
        },
        getState: () => states[currentStateIndex],
      });

      // Initial state
      expect(runner.getState().state).toBe('pending');

      // Start runner
      await runner.start();
      await waitForEvents();

      expect(allEvents).toHaveLength(2);
      expect(allEvents[0].type).toBe('started');
      expect(allEvents[1].type).toBe('state-changed');
      expect(runner.getState().state).toBe('running');

      // Simulate completion
      currentStateIndex = 2;
      eventBus.emit(SignalRunnerEvents.StateChanged, {
        signalType: SignalType.Tests,
        state: states[currentStateIndex],
      });
      await waitForEvents();

      expect(runner.getState().state).toBe('pass');

      // Stop runner
      await runner.stop();
      await waitForEvents();

      expect(allEvents[allEvents.length - 1].type).toBe('stopped');
    });

    it('supports all signal types', () => {
      const runners = [
        SignalType.Tests,
        SignalType.Types,
        SignalType.OxLint,
        SignalType.Build,
      ].map((signalType) => createMinimalRunner({ signalType }));

      expect(runners[0].signalType).toBe(SignalType.Tests);
      expect(runners[1].signalType).toBe(SignalType.Types);
      expect(runners[2].signalType).toBe(SignalType.OxLint);
      expect(runners[3].signalType).toBe(SignalType.Build);
    });

    it('supports all execution strategies', () => {
      const runners = [
        'watch-mode',
        'on-demand',
        'file-triggered',
      ].map((strategy) => createMinimalRunner({ strategy: strategy as ExecutionStrategy }));

      expect(runners[0].strategy).toBe('watch-mode');
      expect(runners[1].strategy).toBe('on-demand');
      expect(runners[2].strategy).toBe('file-triggered');
    });
  });

  describe('MockSignalRunner', () => {
    describe('interface compliance', () => {
      let runner: ISignalRunner;
      let eventBus: IEventBus;

      beforeEach(() => {
        eventBus = new EventBus();
        runner = new MockSignalRunner(SignalType.Tests, eventBus);
      });

      it('can be assigned to ISignalRunner', () => {
        expect(runner).toBeDefined();
        expect(runner.signalType).toBe(SignalType.Tests);
      });

      it('has signalType property', () => {
        expect(runner.signalType).toBe(SignalType.Tests);
      });

      it('has strategy property', () => {
        expect(runner.strategy).toBeDefined();
        expect(['watch-mode', 'on-demand', 'file-triggered']).toContain(runner.strategy);
      });

      it('has start() method that returns Promise', async () => {
        const result = runner.start();
        expect(result).toBeInstanceOf(Promise);
        await result;
      });

      it('has stop() method that returns Promise', async () => {
        await runner.start();
        const result = runner.stop();
        expect(result).toBeInstanceOf(Promise);
        await result;
      });

      it('has getState() method that returns SignalState', () => {
        const state = runner.getState();
        expect(state).toBeDefined();
        expect(state).toHaveProperty('state');
        expect(state).toHaveProperty('timestamp');
        expect(['pass', 'fail', 'running', 'pending']).toContain(state.state);
      });
    });

    describe('constructor', () => {
      let eventBus: IEventBus;

      beforeEach(() => {
        eventBus = new EventBus();
      });

      it('accepts SignalType in constructor', () => {
        const testsRunner = new MockSignalRunner(SignalType.Tests, eventBus);
        const typesRunner = new MockSignalRunner(SignalType.Types, eventBus);
        const lintRunner = new MockSignalRunner(SignalType.OxLint, eventBus);
        const buildRunner = new MockSignalRunner(SignalType.Build, eventBus);

        expect(testsRunner.signalType).toBe(SignalType.Tests);
        expect(typesRunner.signalType).toBe(SignalType.Types);
        expect(lintRunner.signalType).toBe(SignalType.OxLint);
        expect(buildRunner.signalType).toBe(SignalType.Build);
      });

      it('accepts initial state in constructor', () => {
        const customState: SignalState = {
          state: 'pass',
          timestamp: new Date('2025-01-01'),
        };
        const runner = new MockSignalRunner(SignalType.Tests, eventBus, customState);
        expect(runner.getState()).toEqual(customState);
      });

      it('defaults to pending state if no initial state provided', () => {
        const runner = new MockSignalRunner(SignalType.Tests, eventBus);
        const state = runner.getState();
        expect(state.state).toBe('pending');
      });

      it('accepts execution strategy in constructor', () => {
        const watchRunner = new MockSignalRunner(SignalType.Tests, eventBus, undefined, 'watch-mode');
        const demandRunner = new MockSignalRunner(SignalType.Tests, eventBus, undefined, 'on-demand');
        const fileRunner = new MockSignalRunner(SignalType.Tests, eventBus, undefined, 'file-triggered');

        expect(watchRunner.strategy).toBe('watch-mode');
        expect(demandRunner.strategy).toBe('on-demand');
        expect(fileRunner.strategy).toBe('file-triggered');
      });

      it('defaults to on-demand strategy if not specified', () => {
        const runner = new MockSignalRunner(SignalType.Tests, eventBus);
        expect(runner.strategy).toBe('on-demand');
      });
    });

    describe('lifecycle', () => {
      let runner: MockSignalRunner;
      let eventBus: IEventBus;

      beforeEach(() => {
        eventBus = new EventBus();
        runner = new MockSignalRunner(SignalType.Tests, eventBus);
      });

      it('starts in not-running state', () => {
        expect(runner.isRunning()).toBe(false);
      });

      it('becomes running after start()', async () => {
        await runner.start();
        expect(runner.isRunning()).toBe(true);
      });

      it('stops running after stop()', async () => {
        await runner.start();
        await runner.stop();
        expect(runner.isRunning()).toBe(false);
      });

      it('throws if started when already running', async () => {
        await runner.start();
        await expect(runner.start()).rejects.toThrow('already running');
      });

      it('getState() returns immediately without waiting', () => {
        // Demonstrate that getState is synchronous
        const start = Date.now();
        const state = runner.getState();
        const duration = Date.now() - start;

        expect(state).toBeDefined();
        expect(duration).toBeLessThan(10); // Should be nearly instant
      });

      it('state persists after stop', async () => {
        await runner.start();
        runner.transitionTo({ state: 'pass', timestamp: new Date() });
        await runner.stop();
        expect(runner.getState().state).toBe('pass');
      });
    });

    describe('event emission', () => {
      let runner: MockSignalRunner;
      let eventBus: IEventBus;
      let startedEvents: Array<{ signalType: SignalType }>;
      let stoppedEvents: Array<{ signalType: SignalType }>;
      let stateChangedEvents: Array<{ signalType: SignalType; state: SignalState }>;
      let errorEvents: Array<{ signalType: SignalType; error: Error }>;

      beforeEach(() => {
        eventBus = new EventBus();
        startedEvents = [];
        stoppedEvents = [];
        stateChangedEvents = [];
        errorEvents = [];

        eventBus.on(SignalRunnerEvents.Started, (event) => startedEvents.push(event));
        eventBus.on(SignalRunnerEvents.Stopped, (event) => stoppedEvents.push(event));
        eventBus.on(SignalRunnerEvents.StateChanged, (event) => stateChangedEvents.push(event));
        eventBus.on(SignalRunnerEvents.Error, (event) => errorEvents.push(event));

        runner = new MockSignalRunner(SignalType.Tests, eventBus);
      });

      it('emits started event when started', async () => {
        await runner.start();
        expect(startedEvents).toHaveLength(1);
        expect(startedEvents[0]).toEqual(expect.objectContaining({ signalType: SignalType.Tests }));
      });

      it('emits stopped event when stopped', async () => {
        await runner.start();
        await runner.stop();
        expect(stoppedEvents).toHaveLength(1);
        expect(stoppedEvents[0]).toEqual(expect.objectContaining({ signalType: SignalType.Tests }));
      });

      it('emits state-changed event when transitioned', async () => {
        await runner.start();

        const newState: SignalState = {
          state: 'running',
          timestamp: new Date(),
          failures: [],
        };
        runner.transitionTo(newState);
        await waitForEvents();

        expect(stateChangedEvents).toHaveLength(1);
        expect(stateChangedEvents[0]).toEqual(expect.objectContaining({
          signalType: SignalType.Tests,
          state: newState,
        }));
      });

      it('emits error event when error occurs', async () => {
        await runner.start();

        const error = new Error('Test failed');
        runner.emitError(error);
        await waitForEvents();

        expect(errorEvents).toHaveLength(1);
        expect(errorEvents[0]).toEqual(expect.objectContaining({
          signalType: SignalType.Tests,
          error,
        }));
      });

      it('emits multiple events in sequence', async () => {
        await runner.start();

        const runningState: SignalState = {
          state: 'running',
          timestamp: new Date(),
          failures: [],
        };
        runner.transitionTo(runningState);

        const passState: SignalState = {
          state: 'pass',
          timestamp: new Date(),
        };
        runner.transitionTo(passState);

        await runner.stop();

        expect(startedEvents).toHaveLength(1);
        expect(stateChangedEvents).toHaveLength(2);
        expect(stoppedEvents).toHaveLength(1);
      });

      it('emits events even without subscribers', async () => {
        const isolatedEventBus = new EventBus();
        const runnerWithoutSubscribers = new MockSignalRunner(SignalType.Tests, isolatedEventBus);

        await expect(runnerWithoutSubscribers.start()).resolves.not.toThrow();
        runnerWithoutSubscribers.transitionTo({
          state: 'pass',
          timestamp: new Date(),
        });
        await expect(runnerWithoutSubscribers.stop()).resolves.not.toThrow();
      });
    });

    describe('state transitions', () => {
      let runner: MockSignalRunner;
      let eventBus: IEventBus;

      beforeEach(() => {
        eventBus = new EventBus();
        runner = new MockSignalRunner(SignalType.Tests, eventBus);
      });

      it('transitions from pending to running', () => {
        const runningState: SignalState = {
          state: 'running',
          timestamp: new Date(),
          failures: [],
        };
        runner.transitionTo(runningState);
        expect(runner.getState()).toEqual(runningState);
      });

      it('transitions from running to pass', () => {
        runner.transitionTo({
          state: 'running',
          timestamp: new Date(),
          failures: [],
        });

        const passState: SignalState = {
          state: 'pass',
          timestamp: new Date(),
        };
        runner.transitionTo(passState);
        expect(runner.getState()).toEqual(passState);
      });

      it('transitions from running to fail with failures', () => {
        runner.transitionTo({
          state: 'running',
          timestamp: new Date(),
          failures: [],
        });

        const failState: SignalState = {
          state: 'fail',
          timestamp: new Date(),
          failures: ['Test 1 failed', 'Test 2 failed'],
        };
        runner.transitionTo(failState);
        expect(runner.getState()).toEqual(failState);
      });

      it('can accumulate failures in running state', () => {
        const runningWithFailures: SignalState = {
          state: 'running',
          timestamp: new Date(),
          failures: ['Early failure detected'],
        };
        runner.transitionTo(runningWithFailures);
        expect(runner.getState()).toEqual(runningWithFailures);
      });

      it('supports all signal types', () => {
        const testsRunner = new MockSignalRunner(SignalType.Tests, eventBus);
        const typesRunner = new MockSignalRunner(SignalType.Types, eventBus);
        const lintRunner = new MockSignalRunner(SignalType.OxLint, eventBus);
        const buildRunner = new MockSignalRunner(SignalType.Build, eventBus);

        const passState: SignalState = { state: 'pass', timestamp: new Date() };

        testsRunner.transitionTo(passState);
        typesRunner.transitionTo(passState);
        lintRunner.transitionTo(passState);
        buildRunner.transitionTo(passState);

        expect(testsRunner.getState().state).toBe('pass');
        expect(typesRunner.getState().state).toBe('pass');
        expect(lintRunner.getState().state).toBe('pass');
        expect(buildRunner.getState().state).toBe('pass');
      });
    });

    describe('execution strategies', () => {
      it('simulates watch-mode runner', async () => {
        const eventBus = new EventBus();
        const stateChangedEvents: Array<{ signalType: SignalType; state: SignalState }> = [];
        eventBus.on(SignalRunnerEvents.StateChanged, (event) => stateChangedEvents.push(event));

        const runner = new MockSignalRunner(SignalType.Tests, eventBus, undefined, 'watch-mode');

        await runner.start();

        // Watch mode would continuously monitor and re-run
        runner.transitionTo({ state: 'running', timestamp: new Date(), failures: [] });
        runner.transitionTo({ state: 'pass', timestamp: new Date() });

        // Simulate file change triggering re-run
        runner.transitionTo({ state: 'running', timestamp: new Date(), failures: [] });
        runner.transitionTo({ state: 'pass', timestamp: new Date() });

        await runner.stop();

        expect(runner.strategy).toBe('watch-mode');
        expect(stateChangedEvents).toHaveLength(4);
      });

      it('simulates on-demand runner', async () => {
        const eventBus = new EventBus();
        const stateChangedEvents: Array<{ signalType: SignalType; state: SignalState }> = [];
        eventBus.on(SignalRunnerEvents.StateChanged, (event) => stateChangedEvents.push(event));

        const runner = new MockSignalRunner(SignalType.Tests, eventBus, undefined, 'on-demand');

        // On-demand runs once when started
        await runner.start();
        runner.transitionTo({ state: 'running', timestamp: new Date(), failures: [] });
        runner.transitionTo({ state: 'pass', timestamp: new Date() });
        await runner.stop();

        expect(runner.strategy).toBe('on-demand');
        expect(stateChangedEvents).toHaveLength(2);
      });

      it('simulates file-triggered runner', async () => {
        const eventBus = new EventBus();
        const stateChangedEvents: Array<{ signalType: SignalType; state: SignalState }> = [];
        eventBus.on(SignalRunnerEvents.StateChanged, (event) => stateChangedEvents.push(event));

        const runner = new MockSignalRunner(SignalType.Tests, eventBus, undefined, 'file-triggered');

        await runner.start();

        // Simulate file change triggering execution
        runner.transitionTo({ state: 'running', timestamp: new Date(), failures: [] });
        runner.transitionTo({ state: 'pass', timestamp: new Date() });

        // Another file change
        runner.transitionTo({ state: 'running', timestamp: new Date(), failures: [] });
        runner.transitionTo({ state: 'fail', timestamp: new Date(), failures: ['Error'] });

        await runner.stop();

        expect(runner.strategy).toBe('file-triggered');
        expect(stateChangedEvents).toHaveLength(4);
      });
    });

    describe('usage patterns', () => {
      it('demonstrates typical orchestrator test pattern', async () => {
        const eventBus = new EventBus();
        const allEvents: Array<{ signal: SignalType; type: string }> = [];

        // Subscribe to events
        eventBus.on(SignalRunnerEvents.Started, (event) =>
          allEvents.push({ signal: event.signalType, type: 'started' })
        );
        eventBus.on(SignalRunnerEvents.StateChanged, (event) =>
          allEvents.push({ signal: event.signalType, type: 'state-changed' })
        );
        await waitForEvents(); // Wait for subscriptions to be ready

        // Create multiple runners for different signals
        const testRunner = new MockSignalRunner(SignalType.Tests, eventBus);
        const typeRunner = new MockSignalRunner(SignalType.Types, eventBus);

        // Start both runners
        await testRunner.start();
        await typeRunner.start();
        await waitForEvents();

        // Simulate tests completing first
        testRunner.transitionTo({ state: 'running', timestamp: new Date(), failures: [] });
        testRunner.transitionTo({ state: 'pass', timestamp: new Date() });

        // Simulate types completing with failure
        typeRunner.transitionTo({ state: 'running', timestamp: new Date(), failures: [] });
        typeRunner.transitionTo({
          state: 'fail',
          timestamp: new Date(),
          failures: ['Type error in module.ts'],
        });
        await waitForEvents();

        // Verify orchestrator received all events
        expect(allEvents.filter((e) => e.signal === SignalType.Tests)).toHaveLength(3); // started, 2 state changes
        expect(allEvents.filter((e) => e.signal === SignalType.Types)).toHaveLength(3);

        await testRunner.stop();
        await typeRunner.stop();
      });

      it('demonstrates error handling in orchestrator', async () => {
        const eventBus = new EventBus();
        const errorEvents: Array<{ signalType: SignalType; error: Error }> = [];
        eventBus.on(SignalRunnerEvents.Error, (event) => errorEvents.push(event));

        const runner = new MockSignalRunner(SignalType.Build, eventBus);

        await runner.start();

        // Simulate error during execution
        runner.transitionTo({ state: 'running', timestamp: new Date(), failures: [] });
        runner.emitError(new Error('Build process crashed'));

        // Runner might recover or fail
        runner.transitionTo({
          state: 'fail',
          timestamp: new Date(),
          failures: ['Build failed'],
        });

        await runner.stop();

        expect(errorEvents).toHaveLength(1);
        expect(errorEvents[0].error.message).toBe('Build process crashed');
      });

      it('demonstrates lifecycle pattern', async () => {
        const eventBus = new EventBus();
        const runner = new MockSignalRunner(
          SignalType.Tests,
          eventBus,
          { state: 'pending', timestamp: new Date() },
          'watch-mode'
        );

        // Start not running
        expect(runner.isRunning()).toBe(false);
        expect(runner.getState().state).toBe('pending');

        // Start the runner
        await runner.start();
        expect(runner.isRunning()).toBe(true);

        // Execute and complete
        runner.transitionTo({ state: 'running', timestamp: new Date(), failures: [] });
        runner.transitionTo({ state: 'pass', timestamp: new Date() });
        expect(runner.getState().state).toBe('pass');

        // Stop the runner
        await runner.stop();
        expect(runner.isRunning()).toBe(false);
        expect(runner.getState().state).toBe('pass'); // State persists after stop
      });

      it('demonstrates partial results pattern', async () => {
        const eventBus = new EventBus();
        const stateChangedEvents: Array<{ signalType: SignalType; state: SignalState }> = [];
        eventBus.on(SignalRunnerEvents.StateChanged, (event) => stateChangedEvents.push(event));

        const runner = new MockSignalRunner(SignalType.Tests, eventBus);

        await runner.start();

        // Start with no failures
        runner.transitionTo({ state: 'running', timestamp: new Date(), failures: [] });

        // Detect first failure while still running
        runner.transitionTo({
          state: 'running',
          timestamp: new Date(),
          failures: ['Test suite 1 failed'],
        });

        // Detect more failures
        runner.transitionTo({
          state: 'running',
          timestamp: new Date(),
          failures: ['Test suite 1 failed', 'Test suite 2 failed'],
        });

        // Complete with all failures
        runner.transitionTo({
          state: 'fail',
          timestamp: new Date(),
          failures: ['Test suite 1 failed', 'Test suite 2 failed'],
        });

        await runner.stop();

        // Orchestrator received incremental updates
        expect(stateChangedEvents).toHaveLength(4);
      });
    });
  });
});

import { Context, Data, Effect, Layer } from 'effect';
import type { IEventBus } from '@minions/events';
import { EventBus } from '@minions/events';
import type { IWorkbench } from './Workbench';
import { Workbench } from './Workbench';
import { createInMemorySandbox } from '@minions/file-store';
import type { IMinion, MinionClient } from '@minions/domain-types';
import { MissionEvents } from './MissionEvents';
import type { AskContent, AskOption, AskControl } from '@minions/mcp-types';

/**
 * Mission error types using Effect's Data module for tagged errors
 *
 * Effect's Data.TaggedError creates immutable error classes with proper
 * equality semantics and stack traces.
 */

/**
 * Mission was cancelled by user or system
 */
export class MissionCancelled extends Data.TaggedError('MissionCancelled')<{
  reason: string;
  missionRunId: string;
}> {}

/**
 * Minion spawn failed
 */
export class SpawnError extends Data.TaggedError('SpawnError')<{
  reason: string;
  client?: MinionClient;
}> {}

/**
 * Human question timed out or was not answered
 */
export class AskError extends Data.TaggedError('AskError')<{
  question: string;
  reason: string;
}> {}

/**
 * Generic mission execution error
 */
export class MissionExecutionError extends Data.TaggedError('MissionExecutionError')<{
  message: string;
  cause?: unknown;
}> {}

/**
 * Union of all mission error types
 */
export type MissionError =
  | MissionCancelled
  | SpawnError
  | AskError
  | MissionExecutionError;

/**
 * Options for spawning a minion from within a mission
 */
export interface SpawnOptions {
  /** Which AI client to use (defaults to 'claude-code') */
  client?: MinionClient;

  /** Model identifier (optional, uses client default) */
  model?: string;

  /** Custom agent prompt */
  agentPrompt?: string;

  /** Whether to use the client's built-in system prompt (default: true) */
  useBuiltInSystemPrompt?: boolean;

  /** Human-readable name for this minion */
  name?: string;

  /** Arbitrary metadata */
  metadata?: Record<string, unknown>;

  /** Optional workbench for shared contextual knowledge */
  workbench?: IWorkbench;
}

/**
 * Options for asking a human question
 */
export interface AskOptions {
  /** Question to ask the human */
  question: string;

  /** Rich content to display alongside the question (markdown, html, or vue) */
  content: AskContent;

  /** Options for the human to select from ([] = free-form only) */
  options: AskOption[];

  /** Whether options are mutually exclusive (radio) or multi-select (checkbox) */
  optionsMode: 'exclusive' | 'non-exclusive';

  /** Additional input controls (e.g. notes textarea) */
  controls?: AskControl[];
}

/**
 * MissionContext as an Effect Tag (Context.Tag) for dependency injection
 *
 * This enables:
 * - Layer-based dependency injection for testing
 * - Access to context via yield* MissionContext in Effect.gen
 * - Automatic propagation of context through Effect chains
 */
export interface MissionContextService {
  /** Path to the wing where this mission is executing */
  readonly wing: string;

  /** Path to the lair containing the wing */
  readonly lair: string;

  /** Unique ID of this mission run */
  readonly missionRunId: string;

  /** Mission-scoped event bus */
  readonly events: IEventBus;

  /**
   * Emit an event to the mission's invoker
   *
   * @param type - Event type name
   * @param data - Event data (type-dependent)
   */
  emit(type: string, data?: Record<string, unknown>): Effect.Effect<void, never, never>;

  /**
   * Spawn a minion for this mission
   *
   * Returns an Effect that produces a minion or fails with SpawnError.
   *
   * @param options - Spawn options (client, model, workbench, etc.)
   * @returns Effect that yields a minion instance
   */
  spawn(options?: SpawnOptions): Effect.Effect<IMinion, SpawnError, never>;

  /**
   * Ask a human a question
   *
   * Returns an Effect that produces the answer or fails with AskError.
   *
   * @param options - Question options
   * @returns Effect that yields the human's answer
   */
  ask(options: AskOptions): Effect.Effect<string, AskError, never>;

  /**
   * Check if the mission has been cancelled
   *
   * Returns an Effect that checks cancellation status.
   */
  checkCancelled(): Effect.Effect<boolean, never, never>;

  /**
   * Create a Workbench for shared contextual knowledge
   *
   * @returns Effect that yields a new Workbench instance
   */
  createWorkbench(): Effect.Effect<IWorkbench, never, never>;
}

/**
 * MissionContext Tag for dependency injection
 *
 * Usage in missions:
 * ```typescript
 * const myMission = Effect.gen(function* () {
 *   const ctx = yield* MissionContext
 *   const minion = yield* ctx.spawn({ client: 'claude-code' })
 *   // ...
 * })
 * ```
 *
 * To create Layers:
 * ```typescript
 * // Live Layer for production
 * const liveLayer = MissionContext.Live({ ... })
 *
 * // Test Layer for testing
 * const testLayer = MissionContext.Test({ ... })
 * ```
 */
export const MissionContext = Context.GenericTag<MissionContextService>('@minions/conductor/MissionContext');

/**
 * Type alias for Mission as an Effect
 *
 * A Mission is an Effect that:
 * - Produces a result of type A (typically void for event-based missions)
 * - Can fail with MissionError
 * - Requires MissionContext
 *
 * @template A - The success type (typically void)
 *
 * @example
 * ```typescript
 * const implementFeature: Mission<void> = defineMission(function* (ctx) {
 *   const dev = yield* ctx.spawn({ client: 'claude-code' })
 *   yield* ctx.emit('completed', { summary: 'Done' })
 * })
 * ```
 */
export type Mission<A = void> = Effect.Effect<A, MissionError, MissionContextService>;

/**
 * Define a mission with context passed as an argument
 *
 * This helper simplifies mission creation by:
 * - Automatically handling the MissionContext dependency injection
 * - Passing the context as a direct argument to your generator function
 * - Calling Effect.gen internally so mission authors don't need to
 * - Returning a properly-typed Mission<A>
 *
 * @template A - The success type (typically void)
 * @param fn - Generator function that takes context and yields Effects
 * @returns A Mission that can be run with runMission
 *
 * @example
 * ```typescript
 * const myMission = defineMission(function* (ctx) {
 *   const minion = yield* ctx.spawn({ client: 'claude-code' })
 *   yield* ctx.emit('completed', { summary: 'Done' })
 * })
 * ```
 */
export function defineMission<A = void>(
  fn: (ctx: MissionContextService) => Effect.fn.Return<A, MissionError, MissionContextService>
): Mission<A> {
  return Effect.gen(function* () {
    const ctx = yield* MissionContext;
    return yield* fn(ctx);
  }) as Mission<A>;
}

/**
 * Run a mission with a specific context
 *
 * This helper simplifies running missions by:
 * - Taking the mission and context directly
 * - Providing the context to the mission
 * - Running the mission and returning a Promise
 *
 * @template A - The success type
 * @param mission - The mission to run
 * @param context - The context to provide
 * @returns Promise that resolves with the mission result
 *
 * @example
 * ```typescript
 * // In production
 * const result = await runMission(myMission, liveContext)
 *
 * // In tests
 * const testContext = createTestContext({ ... })
 * const result = await runMission(myMission, testContext)
 * ```
 */
export function runMission<A>(
  mission: Mission<A>,
  context: MissionContextService
): Promise<A> {
  const layer = Layer.succeed(MissionContext, context);
  return Effect.runPromise(Effect.provide(mission, layer));
}

/**
 * Shared implementation of ctx.ask() with event emission
 *
 * Used by both live and test contexts to ensure consistent behavior.
 * Handles question ID generation, event emission, and error handling.
 *
 * @param options - Question options
 * @param askHuman - Function to ask the human
 * @param eventBus - Event bus for emitting events
 * @returns Effect that yields the human's answer
 */
function createAskEffect(
  options: AskOptions,
  askHuman: (options: AskOptions) => Promise<string>,
  eventBus: IEventBus
): Effect.Effect<string, AskError, never> {
  return Effect.gen(function* () {
    // Generate unique question ID
    const questionId = crypto.randomUUID();

    // Emit QuestionAsked event before asking
    eventBus.emit(MissionEvents.QuestionAsked, {
      questionId,
      question: options.question,
      content: options.content,
      options: options.options,
      optionsMode: options.optionsMode,
      controls: options.controls,
    });

    // Ask the human
    const answer = yield* Effect.tryPromise({
      try: () => askHuman(options),
      catch: (error) =>
        new AskError({
          question: options.question,
          reason: error instanceof Error ? error.message : String(error),
        }),
    });

    // Emit QuestionAnswered event after receiving answer
    eventBus.emit(MissionEvents.QuestionAnswered, {
      questionId,
      answer,
    });

    return answer;
  });
}

/**
 * Create a live MissionContext for direct use (not as a Layer)
 *
 * This is used by the mission runner to create a context instance with real dependencies.
 *
 * @param deps - Required runtime dependencies
 * @returns A live MissionContextService instance
 *
 * @example
 * ```typescript
 * const liveContext = createLiveContext({
 *   wing: '/path/to/wing',
 *   lair: '/path/to/lair',
 *   missionRunId: handle.id,
 *   events: eventBus,
 *   emitEvent: (type, data) => handle.emit({ type, ...data }),
 *   spawnMinion: (opts) => hatchery.spawn(opts),
 *   askHuman: (opts) => questionBridge.ask(opts),
 *   isCancelled: () => handle.isCancelled,
 *   createWorkbenchFn: () => new Workbench(sandbox),
 * })
 * ```
 */
export function createLiveContext(deps: LiveMissionContextDeps): MissionContextService {
  return {
    wing: deps.wing,
    lair: deps.lair,
    missionRunId: deps.missionRunId,
    events: deps.events,

    emit(type: string, data?: Record<string, unknown>): Effect.Effect<void, never, never> {
      return Effect.sync(() => deps.emitEvent(type, data));
    },

    spawn(options?: SpawnOptions): Effect.Effect<IMinion, SpawnError, never> {
      return Effect.tryPromise({
        try: () => deps.spawnMinion(options),
        catch: (error) =>
          new SpawnError({
            reason: error instanceof Error ? error.message : String(error),
            client: options?.client,
          }),
      });
    },

    ask(options: AskOptions): Effect.Effect<string, AskError, never> {
      return createAskEffect(options, deps.askHuman, deps.events);
    },

    checkCancelled(): Effect.Effect<boolean, never, never> {
      return Effect.sync(() => deps.isCancelled());
    },

    createWorkbench(): Effect.Effect<IWorkbench, never, never> {
      return Effect.sync(() => deps.createWorkbenchFn());
    },
  };
}

/**
 * Create a test MissionContext for direct use (not as a Layer)
 *
 * This is the preferred way to create test contexts when using defineMission/runMission.
 * It returns a plain MissionContextService object that can be passed directly to runMission.
 *
 * @param deps - Optional overrides for test context properties
 * @returns A test MissionContextService instance
 *
 * @example
 * ```typescript
 * const testContext = createTestContext({
 *   spawnMinion: async () => mockMinion,
 *   emitEvent: (type, data) => events.push({ type, data }),
 * })
 *
 * await runMission(myMission, testContext)
 * ```
 */
export function createTestContext(deps: TestMissionContextDeps = {}): MissionContextService {
  return {
    wing: deps.wing ?? '/test/wing',
    lair: deps.lair ?? '/test/lair',
    missionRunId: deps.missionRunId ?? 'test-mission-123',
    events: deps.events ?? new EventBus(),

    emit(type: string, data?: Record<string, unknown>): Effect.Effect<void, never, never> {
      return Effect.sync(() => deps.emitEvent?.(type, data));
    },

    spawn(options?: SpawnOptions): Effect.Effect<IMinion, SpawnError, never> {
      if (deps.spawnMinion) {
        const spawnMinion = deps.spawnMinion;
        return Effect.tryPromise({
          try: () => spawnMinion(options),
          catch: (error) =>
            new SpawnError({
              reason: error instanceof Error ? error.message : String(error),
              client: options?.client,
            }),
        });
      }
      return Effect.fail(
        new SpawnError({
          reason: 'No spawn function provided in test context',
          client: options?.client,
        })
      );
    },

    ask(options: AskOptions): Effect.Effect<string, AskError, never> {
      if (deps.askHuman) {
        const eventBus = deps.events ?? new EventBus();
        return createAskEffect(options, deps.askHuman, eventBus);
      }
      return Effect.fail(
        new AskError({
          question: options.question,
          reason: 'No ask function provided in test context',
        })
      );
    },

    checkCancelled(): Effect.Effect<boolean, never, never> {
      return Effect.sync(() => deps.isCancelled?.() ?? false);
    },

    createWorkbench(): Effect.Effect<IWorkbench, never, never> {
      return Effect.sync(() => deps.createWorkbenchFn?.() ?? new Workbench(createInMemorySandbox()));
    },
  };
}

/**
 * Dependencies required to create a live MissionContext
 *
 * Used by createLiveContext() to create a production context.
 */
export interface LiveMissionContextDeps {
  /** Path to the wing where this mission is executing */
  wing: string;

  /** Path to the lair containing the wing */
  lair: string;

  /** Unique ID of this mission run */
  missionRunId: string;

  /** Mission-scoped event bus */
  events: IEventBus;

  /** Function to emit events to the mission's invoker */
  emitEvent: (type: string, data?: Record<string, unknown>) => void;

  /** Function to spawn minions */
  spawnMinion: (options?: SpawnOptions) => Promise<IMinion>;

  /** Function to ask human questions */
  askHuman: (options: AskOptions) => Promise<string>;

  /** Function to check if mission is cancelled */
  isCancelled: () => boolean;

  /** Function to create workbenches */
  createWorkbenchFn: () => IWorkbench;
}


/**
 * Dependencies for creating a test MissionContext
 *
 * Used by createTestContext() to create a test context with optional overrides.
 */
export interface TestMissionContextDeps {
  /** Test wing path (defaults to '/test/wing') */
  wing?: string;

  /** Test lair path (defaults to '/test/lair') */
  lair?: string;

  /** Test mission run ID (defaults to 'test-mission-123') */
  missionRunId?: string;

  /** Test event bus (defaults to new EventBus()) */
  events?: IEventBus;

  /** Mock emit function (defaults to no-op) */
  emitEvent?: (type: string, data?: Record<string, unknown>) => void;

  /** Mock spawn function (defaults to reject with SpawnError) */
  spawnMinion?: (options?: SpawnOptions) => Promise<IMinion>;

  /** Mock ask function (defaults to reject with AskError) */
  askHuman?: (options: AskOptions) => Promise<string>;

  /** Mock cancellation check (defaults to false) */
  isCancelled?: () => boolean;

  /** Mock workbench factory (defaults to a Workbench backed by an in-memory sandbox) */
  createWorkbenchFn?: () => IWorkbench;
}


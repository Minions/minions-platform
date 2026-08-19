import type { IMinion, MinionClient } from '@minions/domain-types';
import type { Effect } from 'effect';
import type { IEventBus } from '@minions/events';
import type { IWorkbench } from './Workbench';
import type { Costume } from './Costume';
import type { LoadError } from '../adapters/ClosetCostumeLoader';
import type { Wing } from '@minions/file-store';
import type { LairApi } from './LairApi';
import type { SpawnError, AskError } from './MissionEffect';
import type { AskContent, AskOption, AskControl } from '@minions/mcp-types';

/**
 * Options for spawning a minion from within a mission
 *
 * A subset of MinionSpec that provides sensible defaults for the wing
 * and other common settings.
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

  /** Name of the costume to resolve and apply (optional) */
  costume?: string;

  /** Workbench instance for shared context (optional) */
  workbench?: IWorkbench;

  /**
   * Session ID for conversation history inheritance (clone support).
   *
   * When provided, the spawned minion starts with the Claude Code session
   * identified by this ID, giving it the full conversation history of the
   * originating minion. The caller must be paused (waiting for a result)
   * while the clone runs to avoid session conflicts.
   *
   * This is how the "clone" pattern works: the base minion calls a gadget,
   * passes its own session ID, and the spawned clone picks up from where
   * the base left off.
   */
  sessionId?: string;
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
 * Mission context for interacting with the system during execution
 *
 * MissionContext is passed to the mission's run() function and provides:
 * - events: Mission-scoped event bus for typed event subscriptions
 * - emit(): Send events to the invoker (progress, completion, etc.)
 * - spawn(): Create minions via the Hatchery
 * - ask(): Ask humans questions (blocks until answered)
 * - wing: File-store Wing object for the current wing
 *
 * Missions use context methods to orchestrate work without returning values.
 * All communication happens via events.
 *
 * @example
 * ```typescript
 * async run(ctx: MissionContext, args: MyArgs) {
 *   ctx.emit('started', { goal: args.goal });
 *
 *   const minion = await ctx.spawn({ client: 'claude-code' });
 *   await minion.send({ type: 'user', content: args.prompt });
 *
 *   // Await turn completion via event bus
 *   await ctx.events.once(MinionEvents.TurnComplete, { from: minion });
 *
 *   ctx.emit('completed', { summary: 'Done' });
 * }
 * ```
 */
export interface MissionContext {
  /** The Wing where this mission is executing */
  readonly wing: Wing;

  /** Unique ID of this mission run */
  readonly missionRunId: string;

  /**
   * Mission-scoped event bus
   *
   * Subscribe to and emit typed events. The event bus receives:
   * - Events from minions (tagged with minion ID)
   * - Mission-emitted events (tagged with 'mission')
   * - External process events (tagged with 'external:<name>')
   *
   * @example
   * ```typescript
   * // Subscribe to turn completions from a specific minion
   * ctx.events.on(MinionEvents.TurnComplete, handler, { from: minion });
   *
   * // Await any minion's turn completion
   * await ctx.events.once(MinionEvents.TurnComplete, { from: Src.AnyMinion });
   *
   * // Emit a custom event
   * ctx.events.emit(MyEvents.TaskComplete, { taskId: '123', result: 'done' });
   * ```
   */
  readonly events: IEventBus;

  /**
   * Emit an event to the mission's invoker
   *
   * Standard event types:
   * - 'started': Mission has begun (automatic, but can be emitted with data)
   * - 'progress': Progress update
   * - 'log': Log message
   * - 'minion-spawned': A minion was created
   * - 'minion-message': Message from a minion
   * - 'completed': Mission finished successfully
   * - 'failed': Mission failed with an error
   *
   * Custom events are also allowed.
   *
   * @param type - Event type name
   * @param data - Event data (type-dependent)
   */
  emit(type: string, data?: Record<string, unknown>): void;

  /**
   * Spawn a minion for this mission
   *
   * Uses the Hatchery to create a minion in the current wing.
   * The minion's lifecycle is tied to the mission - when the mission
   * completes, all spawned minions are killed.
   *
   * @param options - Spawn options (client, model, etc.)
   * @returns Effect that yields a minion instance
   */
  spawn(options?: SpawnOptions): Effect.Effect<IMinion, SpawnError>;

  /**
   * Ask a human a question
   *
   * Returns an Effect that blocks until the human provides an answer.
   * This is used for decisions that require human judgment or approval.
   *
   * @param options - Question options
   * @returns Effect that yields the human's answer
   */
  ask(options: AskOptions): Effect.Effect<string, AskError>;

  /**
   * Check if the mission has been cancelled
   *
   * Missions should check this periodically and clean up if true.
   */
  readonly isCancelled: boolean;

  /**
   * Typed facade over lair services for in-process access
   *
   * Provides direct access to cabinet operations (costume install, etc.)
   * without going through HTTP MCP. Minions in separate processes use
   * HTTP MCP instead; this is for deterministic mission code only.
   *
   * @example
   * ```typescript
   * const result = await ctx.lairApi.installCostume('workshop-00', 'costumes/dev-and-check', 'dev-and-check');
   * const costumes = await ctx.lairApi.listCostumes();
   * ```
   */
  readonly lairApi: LairApi;

  /**
   * Create a Workbench for shared contextual knowledge
   *
   * The Workbench stores files and facts that can be shared across minions.
   * Minions receive Workbench contents as synthetic gadget history so they
   * don't need to repeat discovery work.
   *
   * @returns A new Workbench instance
   */
  createWorkbench(): IWorkbench;

  /**
   * Get the file-store Wing for this mission
   *
   * @returns The Wing object (same as ctx.wing)
   * @deprecated Use ctx.wing directly instead
   */
  getWing(): Promise<Wing>;

  /**
   * Load a costume by name from the closet
   *
   * Resolves costume names to Costume definitions using the ClosetCostumeLoader.
   * Costumes define how minions operate, including model, system prompt, gadgets,
   * skills, events, and workbench fact injection preferences.
   *
   * @param name - Name of the costume to load
   * @returns Effect that resolves to the loaded Costume or fails with LoadError
   *
   * @example
   * ```typescript
   * const costume = await Effect.runPromise(ctx.loadCostume('developer'));
   * ```
   */
  loadCostume(name: string): Effect.Effect<Costume, LoadError, never>;
}


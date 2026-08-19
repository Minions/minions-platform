import type { IHatchery, StatusMessage } from '@minions/hatchery';
import { MinionEvents } from '@minions/hatchery';
import type { IMinion } from '@minions/domain-types';
import { Effect } from 'effect';
import type { MissionContext, SpawnOptions, AskOptions } from '../domain/MissionContext';
import type { MissionHandle } from '../domain/MissionHandle';
import type { MissionEvent } from '../domain/MissionEvents';
import type { IQuestionBridge } from '../ports/IQuestionBridge';
import type { IWorkbench } from '../domain/Workbench';
import type { Costume, CostumeEvent } from '../domain/Costume';
import type { LairApi } from '../domain/LairApi';
import { EventBus } from '@minions/events';
import { Workbench } from '../domain/Workbench';
import { ClosetCostumeLoader, LoadError } from './ClosetCostumeLoader';
import { SpawnError, AskError } from '../domain/MissionEffect';
import { buildSpecFromCostume, type ExtendedMinionSpec } from '../domain/CostumeSpec';
import { createEventGadgets } from './gadgets/factory';
import { workbenchToSyntheticHistory } from '../domain/WorkbenchInjection';
import type { Wing } from '@minions/file-store';
import { createLairApi } from '../domain/LairApi';

/**
 * Reserved gadget tool names that cannot be used by costume tools
 *
 * These names are reserved for auto-injected event gadgets.
 */
const RESERVED_GADGET_NAMES = ['get_event_schema', 'emit_event'] as const;

/**
 * Validate costume.events structure
 *
 * Ensures each CostumeEvent has:
 * - event property with schema
 * - guidance string
 *
 * @param events - The events array to validate
 * @throws Error if validation fails with descriptive message
 */
function validateCostumeEvents(events: CostumeEvent[]): void {
  for (let i = 0; i < events.length; i++) {
    const costumeEvent = events[i];

    if (!costumeEvent.event) {
      throw new Error(
        `costume.events[${i}]: Missing 'event' property. Each CostumeEvent must have an event declaration.`
      );
    }

    if (!costumeEvent.event.schema) {
      throw new Error(
        `costume.events[${i}] (type: "${costumeEvent.event.type}"): Missing schema. ` +
        `Per PRD lines 176-179, event declarations must include Effect Schema.`
      );
    }

    if (typeof costumeEvent.guidance !== 'string' || costumeEvent.guidance.length === 0) {
      throw new Error(
        `costume.events[${i}] (type: "${costumeEvent.event.type}"): Missing or empty 'guidance' string. ` +
        `Each CostumeEvent must have guidance about when to emit this event.`
      );
    }
  }
}

/**
 * Validate tool name collisions with reserved gadget names
 *
 * Checks if costume tools include any reserved gadget names.
 *
 * @param spec - The spec with tools to validate
 * @throws Error if any tool name collides with reserved names
 */
function validateToolNameCollisions(spec: ExtendedMinionSpec): void {
  if (!spec.tools || spec.tools.length === 0) {
    return;
  }

  for (const tool of spec.tools) {
    if ((RESERVED_GADGET_NAMES as readonly string[]).includes(tool.name)) {
      throw new Error(
        `Tool name collision: "${tool.name}" is a reserved gadget name and cannot be used in costume tools. ` +
        `Reserved names: ${RESERVED_GADGET_NAMES.join(', ')}`
      );
    }
  }
}

/**
 * Dependencies for creating a DefaultMissionContext
 */
export interface DefaultMissionContextDeps {
  /** Hatchery for spawning minions */
  hatchery: IHatchery;

  /** Bridge for asking human questions */
  questionBridge: IQuestionBridge;

  /** Handle for emitting events */
  handle: MissionHandle;

  /** The Wing where this mission executes */
  wing: Wing;
}

/**
 * Default implementation of MissionContext
 *
 * Provides the runtime context for mission execution:
 * - events: Mission-scoped event bus for typed subscriptions
 * - emit() forwards events to the mission handle
 * - spawn() creates minions via the hatchery
 * - ask() routes questions through the question bridge
 *
 * Each mission run gets its own isolated context instance with a fresh event bus.
 */
export class DefaultMissionContext implements MissionContext {
  readonly wing: Wing;
  readonly missionRunId: string;
  readonly events: EventBus;

  private readonly hatchery: IHatchery;
  private readonly questionBridge: IQuestionBridge;
  private readonly handle: MissionHandle;
  private readonly spawnedMinions: IMinion[] = [];
  private readonly costumeLoader: ClosetCostumeLoader;
  private _lairApi: LairApi | null = null;

  constructor(deps: DefaultMissionContextDeps) {
    this.hatchery = deps.hatchery;
    this.questionBridge = deps.questionBridge;
    this.handle = deps.handle;
    this.wing = deps.wing;
    this.missionRunId = deps.handle.id;
    this.events = new EventBus();
    this.costumeLoader = new ClosetCostumeLoader({ wing: deps.wing });
  }

  get isCancelled(): boolean {
    return this.handle.isCancelled;
  }

  get lairApi(): LairApi {
    if (!this._lairApi) {
      this._lairApi = createLairApi(this.wing.lair.root);
    }
    return this._lairApi;
  }

  emit(type: string, data?: Record<string, unknown>): void {
    // Build event with type and timestamp
    const event = {
      type,
      timestamp: Date.now(),
      ...data,
    };

    // Forward to handle (which emits to subscribers)
    // Note: MissionEvent is a strict union, but emit() supports custom events,
    // so this cast intentionally bridges the closed union to arbitrary event shapes.
    this.handle.emit(event as unknown as MissionEvent);
  }

  spawn(options: SpawnOptions = {}): Effect.Effect<IMinion, SpawnError> {
    return Effect.tryPromise({
      try: () => this.spawnImpl(options),
      catch: (error) =>
        new SpawnError({
          reason: error instanceof Error ? error.message : String(error),
          client: options.client,
        }),
    });
  }

  private async spawnImpl(options: SpawnOptions = {}): Promise<IMinion> {
    let spec: ExtendedMinionSpec;
    let costume: Costume | undefined;
    const wingPath = this.wing.root.path;

    if (options.costume) {
      // Resolve costume by name and build spec from it
      costume = await Effect.runPromise(this.loadCostume(options.costume));

      // Build spec from costume with overrides
      spec = buildSpecFromCostume(costume, {
        client: options.client,
        wing: wingPath,
        model: options.model,
        useBuiltInSystemPrompt: options.useBuiltInSystemPrompt,
        agentPrompt: options.agentPrompt,
        name: options.name,
        metadata: options.metadata,
        sessionId: options.sessionId,
      });

      // Validate tool name collisions before processing events
      validateToolNameCollisions(spec);

      // Handle workbench injection if workbench provided and injectFacts specified
      if (options.workbench && spec.injectFacts && spec.injectFacts.length > 0) {
        spec.workbench = options.workbench;
        spec.syntheticHistory = workbenchToSyntheticHistory(options.workbench, spec.injectFacts);
      } else if (options.workbench) {
        // Store workbench even without injectFacts
        spec.workbench = options.workbench;
      }

      // Check if costume.events is defined, non-empty, and valid
      if (costume.events && costume.events.length > 0) {
        // Validate events structure
        validateCostumeEvents(costume.events);

        // Create a mutable reference for the minion ID
        // This will be filled in after spawn completes
        let spawnedMinionId: string | undefined;

        // Create a getter function that will resolve to the actual minion ID
        const getMinionId = () => {
          if (!spawnedMinionId) {
            throw new Error('Minion ID not yet available - minion not spawned');
          }
          return spawnedMinionId;
        };

        // Create event gadgets with the getter function
        // The ID will be resolved at execution time, not creation time
        const executableGadgets = createEventGadgets(costume, this.events, getMinionId);

        // Add gadget Tool definitions to spec.tools (append to existing)
        const gadgetTools = executableGadgets.map(g => g.tool);
        spec.tools = spec.tools ? [...spec.tools, ...gadgetTools] : gadgetTools;

        // Store executable gadgets in spec
        spec.executableGadgets = executableGadgets;

        // Spawn minion with fully-resolved spec (hatchery never sees "costume")
        const minion = await this.hatchery.spawn(spec);

        // Fill in the minion ID now that spawn is complete
        spawnedMinionId = minion.id;

        // Atomic spawn with rollback: if tracking or event emission fails,
        // clean up the spawned minion to ensure no resource leaks
        try {
          // Track spawned minions for cleanup
          this.spawnedMinions.push(minion);

          // Emit minion-spawned event
          this.emit('minion-spawned', { minionId: minion.id });

          // Start background pump so TurnComplete fires when Claude finishes each turn
          this.startTurnPump(minion);

          return minion;
        } catch (error) {
          // Rollback: remove from tracking and kill the spawned minion
          const index = this.spawnedMinions.indexOf(minion);
          if (index !== -1) {
            this.spawnedMinions.splice(index, 1);
          }

          try {
            minion.kill();
          } catch {
            // Ignore errors during cleanup
          }
          // Re-throw the original error
          throw error;
        }
      }
    } else {
      // Backward compatible: build spec directly from options
      spec = {
        client: options.client ?? 'claude-code',
        wing: wingPath,
        model: options.model ?? 'claude-sonnet-4-20250514',
        useBuiltInSystemPrompt: options.useBuiltInSystemPrompt ?? true,
        agentPrompt: options.agentPrompt,
        name: options.name,
        metadata: options.metadata,
        sessionId: options.sessionId,
      };

      // Handle workbench injection for non-costume path
      // Note: Without injectFacts, we only store workbench, no syntheticHistory
      if (options.workbench) {
        spec.workbench = options.workbench;
      }
    }

    // Spawn minion with fully-resolved spec (hatchery never sees "costume")
    const minion = await this.hatchery.spawn(spec);

    // Atomic spawn with rollback: if tracking or event emission fails,
    // clean up the spawned minion to ensure no resource leaks
    try {
      // Track spawned minions for cleanup
      this.spawnedMinions.push(minion);

      // Emit minion-spawned event
      this.emit('minion-spawned', { minionId: minion.id });

      // Start background pump so TurnComplete fires when Claude finishes each turn
      this.startTurnPump(minion);

      return minion;
    } catch (error) {
      // Rollback: remove from tracking and kill the spawned minion
      const index = this.spawnedMinions.indexOf(minion);
      if (index !== -1) {
        this.spawnedMinions.splice(index, 1);
      }

      try {
        minion.kill();
      } catch {
        // Ignore errors during cleanup
      }
      // Re-throw the original error
      throw error;
    }
  }

  ask(options: AskOptions): Effect.Effect<string, AskError> {
    return Effect.tryPromise({
      try: async () => {
        this.emit('question_asked', { question: options.question });
        const answer = await this.questionBridge.ask(
          options,
          this.missionRunId,
          this.wing.name
        );
        this.emit('question_answered', { question: options.question, answer });
        return answer;
      },
      catch: (error) =>
        new AskError({
          question: options.question,
          reason: error instanceof Error ? error.message : String(error),
        }),
    });
  }

  createWorkbench(): IWorkbench {
    return new Workbench(this.wing.lair.sandbox);
  }

  async getWing(): Promise<Wing> {
    return this.wing;
  }

  loadCostume(name: string): Effect.Effect<Costume, LoadError, never> {
    return this.costumeLoader.load(name);
  }

  /**
   * Drain a minion's receive() stream in the background.
   *
   * The ClaudeCode client uses stream-json: Claude sends a {"type":"result",...} line
   * when its turn is complete but keeps the process alive for more input. This pump
   * watches for that signal and emits TurnComplete on the context event bus so that
   * missions can await ctx.events.once(MinionEvents.TurnComplete, { from: minion }).
   */
  private startTurnPump(minion: IMinion): void {
    const minionId = minion.id;
    void (async () => {
      try {
        for await (const message of minion.receive()) {
          if (message.type === 'status') {
            const parsed = (message as StatusMessage).metadata?.parsed as { type?: string; result?: string } | undefined;
            if (parsed?.type === 'result') {
              this.events.emitFrom(MinionEvents.TurnComplete, { minionId }, minionId);
              if (parsed.result) {
                this.emit('log', { level: 'debug', message: `[${minionId}] ${parsed.result}` });
              }
            }
          } else if (message.type === 'text') {
            this.emit('log', { level: 'debug', message: `[${minionId}] ${(message as { content: string }).content}` });
          } else if (message.type === 'error') {
            this.emit('log', { level: 'debug', message: `[${minionId}] stderr: ${(message as { error: { message: string } }).error.message}` });
          }
        }
      } catch {
        // Minion was killed or errored — normal termination, swallow
      }
    })();
  }

  /**
   * Kill all spawned minions
   *
   * Called by the runner when the mission completes or is cancelled.
   * @internal
   */
  killAllMinions(): void {
    for (const minion of this.spawnedMinions) {
      try {
        minion.kill();
      } catch {
        // Ignore errors during cleanup
      }
    }
    this.spawnedMinions.length = 0;
  }

  /**
   * Get the number of spawned minions (for testing)
   * @internal
   */
  get spawnedMinionCount(): number {
    return this.spawnedMinions.length;
  }
}

/**
 * Factory for creating DefaultMissionContext instances
 *
 * Captures shared dependencies (hatchery, questionBridge) at construction time.
 * The runner calls create() per mission start with the per-run values (handle, wing).
 *
 * This eliminates the need for the runner to know about context dependencies,
 * so adding a new capability to MissionContext only requires changing:
 * 1. The MissionContext interface (domain)
 * 2. DefaultMissionContext + this factory (adapter)
 */
export class DefaultMissionContextFactory {
  private readonly hatchery: IHatchery;
  private readonly questionBridge: IQuestionBridge;

  constructor(hatchery: IHatchery, questionBridge: IQuestionBridge) {
    this.hatchery = hatchery;
    this.questionBridge = questionBridge;
  }

  create(handle: MissionHandle, wing: Wing): DefaultMissionContext {
    return new DefaultMissionContext({
      hatchery: this.hatchery,
      questionBridge: this.questionBridge,
      handle,
      wing,
    });
  }
}

import { Effect } from 'effect';
import type { IHatchery } from '@minions/hatchery';
import type { IMinion } from '@minions/domain-types';
import type { Sandbox } from '@minions/file-store';
import type { IMissionHandle } from '../domain/MissionHandle';
import { MissionHandle } from '../domain/MissionHandle';
import type { MissionEvent } from '../domain/MissionEvents';
import { extractErrorReason } from '../utils/errorReason.js';
import type { IMissionRunner, StartMissionOptions } from '../ports/IMissionRunner';
import type { IQuestionBridge } from '../ports/IQuestionBridge';
import type { IWorkbench } from '../domain/Workbench';
import { EventBus } from '@minions/events';
import { Workbench } from '../domain/Workbench';
import {
  runMission,
  type MissionContextService,
  type Mission,
  type SpawnOptions,
  type AskOptions,
  SpawnError,
  AskError,
} from '../domain/MissionEffect';
import type { Mission as LegacyMission } from '../domain/Mission';

/**
 * Dependencies for creating an EffectMissionRunner
 */
export interface EffectMissionRunnerDeps {
  /** Hatchery for spawning minions */
  hatchery: IHatchery;

  /** Bridge for asking human questions */
  questionBridge: IQuestionBridge;
}

/**
 * Implementation of MissionContextService that wraps runtime state
 */
class MissionContextImpl implements MissionContextService {
  readonly wing: string;
  readonly lair: string;
  readonly missionRunId: string;
  readonly events: EventBus;

  private readonly hatchery: IHatchery;
  private readonly questionBridge: IQuestionBridge;
  private readonly handle: MissionHandle;
  private readonly spawnedMinions: IMinion[] = [];
  private readonly sandbox: Sandbox;

  constructor(
    deps: {
      hatchery: IHatchery;
      questionBridge: IQuestionBridge;
      handle: MissionHandle;
      wing: string;
      lair: string;
      sandbox: Sandbox;
    }
  ) {
    this.hatchery = deps.hatchery;
    this.questionBridge = deps.questionBridge;
    this.handle = deps.handle;
    this.wing = deps.wing;
    this.lair = deps.lair;
    this.sandbox = deps.sandbox;
    this.missionRunId = deps.handle.id;
    this.events = new EventBus();
  }

  emit(type: string, data?: Record<string, unknown>): Effect.Effect<void, never, never> {
    return Effect.sync(() => {
      const event = {
        type,
        timestamp: Date.now(),
        ...data,
      };
      // Mission authors can emit arbitrary custom event names/payloads via
      // ctx.emit(), which is intentionally broader than the closed
      // MissionEvent union that MissionHandle.emit() is typed for.
      this.handle.emit(event as unknown as MissionEvent);
    });
  }

  spawn(options: SpawnOptions = {}): Effect.Effect<IMinion, SpawnError, never> {
    return Effect.tryPromise({
      try: async () => {
        const minion = await this.hatchery.spawn({
          client: options.client ?? 'claude-code',
          wing: this.wing,
          model: options.model ?? 'claude-sonnet-4-20250514',
          useBuiltInSystemPrompt: options.useBuiltInSystemPrompt ?? true,
          agentPrompt: options.agentPrompt,
          name: options.name,
          metadata: options.metadata,
        });

        this.spawnedMinions.push(minion);

        // Emit minion-spawned event (synchronous)
        const event: MissionEvent = {
          type: 'minion-spawned',
          timestamp: Date.now(),
          minionId: minion.id,
        };
        this.handle.emit(event);

        return minion;
      },
      catch: (error) =>
        new SpawnError({
          reason: error instanceof Error ? error.message : String(error),
          client: options.client,
        }),
    });
  }

  ask(options: AskOptions): Effect.Effect<string, AskError, never> {
    return Effect.tryPromise({
      try: async () => {
        return await this.questionBridge.ask(options, this.missionRunId, this.wing);
      },
      catch: (error) =>
        new AskError({
          question: options.question,
          reason: error instanceof Error ? error.message : String(error),
        }),
    });
  }

  checkCancelled(): Effect.Effect<boolean, never, never> {
    return Effect.sync(() => this.handle.isCancelled);
  }

  createWorkbench(): Effect.Effect<IWorkbench, never, never> {
    return Effect.sync(() => new Workbench(this.sandbox));
  }

  /**
   * Kill all spawned minions (used during cleanup)
   */
  killAllMinions(): void {
    for (const minion of this.spawnedMinions) {
      minion.kill();
    }
    this.spawnedMinions.length = 0;
  }
}

/**
 * Effect-based mission runner
 *
 * Executes Effect-based missions (Mission<A> = Effect<A, MissionError, MissionContext>)
 * with full context and lifecycle management:
 * - Creates isolated MissionContext Layer for each mission run
 * - Emits lifecycle events (started, completed, failed)
 * - Tracks running missions for monitoring and cancellation
 * - Cleans up spawned minions on completion
 */
export class EffectMissionRunner implements IMissionRunner {
  private readonly hatchery: IHatchery;
  private readonly questionBridge: IQuestionBridge;
  private readonly runningMissions = new Map<string, {
    handle: MissionHandle;
    context: MissionContextImpl;
  }>();

  constructor(deps: EffectMissionRunnerDeps) {
    this.hatchery = deps.hatchery;
    this.questionBridge = deps.questionBridge;
  }

  /**
   * Start an Effect-based mission
   *
   * This accepts BOTH Mission<A> (Effect) and legacy Mission types.
   * - Legacy missions are wrapped and executed as before
   * - Effect missions are executed with proper Layer setup
   */
  async start(mission: Mission<unknown> | LegacyMission, options: StartMissionOptions): Promise<IMissionHandle> {
    // Check if this is a legacy mission (has .run property)
    const isLegacyMission = 'run' in mission && typeof mission.run === 'function';

    if (isLegacyMission) {
      // For now, legacy missions are not supported by EffectMissionRunner
      // This will be handled by a separate adapter or migration path
      throw new Error(
        'EffectMissionRunner does not support legacy missions. Use DefaultMissionRunner or migrate to Effect.'
      );
    }

    // Effect mission
    const effectMission = mission as Mission<unknown>;

    // Generate unique ID
    const id = `mission-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const handle = new MissionHandle(id, 'effect-mission');

    // Create isolated context for this run
    // MissionContextImpl still uses string paths internally (Effect-world interface)
    const contextImpl = new MissionContextImpl({
      hatchery: this.hatchery,
      questionBridge: this.questionBridge,
      handle,
      wing: options.wing.root.path,
      lair: options.wing.lair.root.path,
      sandbox: options.wing.lair.sandbox,
    });

    // Track running mission
    this.runningMissions.set(id, { handle, context: contextImpl });

    // Run mission in background
    setImmediate(() => {
      // Emit started event
      handle.emit({
        type: 'started',
        missionName: 'effect-mission',
        args: options.args,
        timestamp: Date.now(),
      });

      this.executeEffectMission(effectMission, handle, contextImpl).catch(() => {
        // Error already handled in executeEffectMission
      });
    });

    return handle;
  }

  private async executeEffectMission(
    mission: Mission<unknown>,
    handle: MissionHandle,
    contextImpl: MissionContextImpl
  ): Promise<void> {
    try {
      // Run the mission with direct context (no Layer needed)
      await runMission(mission, contextImpl);

      // If mission didn't emit completed/failed, emit completed
      if (this.runningMissions.has(handle.id)) {
        handle.emit({
          type: 'completed',
          summary: 'Mission completed',
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      // Emit failed event
      handle.emit({
        type: 'failed',
        error: error instanceof Error ? error : new Error(String(error)),
        reason: extractErrorReason(error),
        timestamp: Date.now(),
      });
    } finally {
      // Cleanup
      contextImpl.killAllMinions();
      this.runningMissions.delete(handle.id);
    }
  }

  get(missionRunId: string): IMissionHandle | undefined {
    return this.runningMissions.get(missionRunId)?.handle;
  }

  listRunning(): IMissionHandle[] {
    return Array.from(this.runningMissions.values()).map((m) => m.handle);
  }

  cancel(missionRunId: string, reason?: string): boolean {
    const running = this.runningMissions.get(missionRunId);
    if (!running) {
      return false;
    }

    running.handle.cancel(reason);
    running.context.killAllMinions();
    this.runningMissions.delete(missionRunId);
    return true;
  }
}

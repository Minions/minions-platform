import { Effect } from 'effect';
import type { Mission } from '../domain/Mission';
import type { IMissionHandle } from '../domain/MissionHandle';
import { MissionHandle } from '../domain/MissionHandle';
import type { IMissionRunner, StartMissionOptions } from '../ports/IMissionRunner';
import type { DefaultMissionContextFactory } from './DefaultMissionContext';
import { DefaultMissionContext } from './DefaultMissionContext';
import { extractErrorReason } from '../utils/errorReason.js';

/**
 * Dependencies for creating a DefaultMissionRunner
 *
 * Only requires a context factory — the factory captures all context-specific
 * dependencies (hatchery, questionBridge, etc.) so the runner doesn't need to
 * know about them.
 */
export interface DefaultMissionRunnerDeps {
  /** Factory for creating mission contexts */
  contextFactory: DefaultMissionContextFactory;
}

/**
 * Default implementation of IMissionRunner
 *
 * Executes Effect-based mission scripts with full context and lifecycle management:
 * - Creates isolated context for each mission run (via factory)
 * - Runs mission's Effect via Effect.runPromise
 * - Emits lifecycle events (started, completed, failed)
 * - Tracks running missions for monitoring and cancellation
 * - Cleans up spawned minions on completion
 */
export class DefaultMissionRunner implements IMissionRunner {
  private readonly contextFactory: DefaultMissionContextFactory;
  private readonly runningMissions = new Map<string, {
    handle: MissionHandle;
    context: DefaultMissionContext;
  }>();

  constructor(deps: DefaultMissionRunnerDeps) {
    this.contextFactory = deps.contextFactory;
  }

  async start(mission: Mission, options: StartMissionOptions): Promise<IMissionHandle> {
    // Generate unique ID
    const id = `mission-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const handle = new MissionHandle(id, mission.name);

    // Create isolated context for this run
    const context = this.contextFactory.create(handle, options.wing);

    // Track running mission
    this.runningMissions.set(id, { handle, context });

    // Run mission in background - use setImmediate to defer to next event loop iteration
    // This allows the caller to subscribe to events before any events are emitted
    setImmediate(() => {
      // Emit started event after caller has subscribed
      handle.emit({
        type: 'started',
        missionName: mission.name,
        args: options.args,
        timestamp: Date.now(),
      });

      this.executeMission(mission, context, options.args, handle).catch(() => {
        // Error already handled in executeMission
      });
    });

    return handle;
  }

  private async executeMission(
    mission: Mission,
    context: DefaultMissionContext,
    args: Record<string, unknown>,
    handle: MissionHandle
  ): Promise<void> {
    try {
      // Execute the mission's Effect
      const effect = mission.run(context, args);
      await Effect.runPromise(effect);

      // If mission didn't emit completed/failed, emit completed
      // (Check if handle is still in running state)
      if (this.runningMissions.has(handle.id)) {
        handle.emit({
          type: 'completed',
          summary: `Mission ${mission.name} completed`,
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
      context.killAllMinions();
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

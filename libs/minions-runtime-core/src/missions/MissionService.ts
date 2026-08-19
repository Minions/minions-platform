/**
 * Mission Service for Cabinet
 *
 * Manages running missions, event buffering, and the mission runner instance.
 */

import type { IHatchery } from '@minions/hatchery';
import type { Wing } from '@minions/file-store';
import {
  ClosetMissionLoader,
  DefaultMissionRunner,
  DefaultMissionContextFactory,
  type IMissionHandle,
  type IQuestionBridge,
  type MissionEvent,
} from '@minions/conductor';
import type { MissionRunStatus, MissionEventRecord } from '@minions/mcp-types';

/**
 * Tracked mission with event buffer
 */
interface TrackedMission {
  handle: IMissionHandle;
  costume: string;
  wingName: string;
  events: MissionEventRecord[];
  status: MissionRunStatus;
  lastPolledIndex: number;
}

/**
 * Broadcast callback type for pushing events to connected clients
 */
export type BroadcastFn = (data: unknown) => Promise<void>;

/**
 * Service for managing mission execution in Cabinet
 */
export class MissionService {
  private readonly missions = new Map<string, TrackedMission>();
  private readonly broadcast?: BroadcastFn;
  private readonly moduleLoader?: (url: string) => Promise<Record<string, unknown>>;
  private runner: DefaultMissionRunner | null = null;
  private readonly contextFactory: DefaultMissionContextFactory;

  constructor(
    hatchery: IHatchery,
    questionBridge: IQuestionBridge,
    broadcast?: BroadcastFn,
    moduleLoader?: (url: string) => Promise<Record<string, unknown>>
  ) {
    this.contextFactory = new DefaultMissionContextFactory(
      hatchery,
      questionBridge,
    );
    this.broadcast = broadcast;
    this.moduleLoader = moduleLoader;
  }

  /**
   * Get or create the mission runner
   */
  private getRunner(): DefaultMissionRunner {
    if (!this.runner) {
      this.runner = new DefaultMissionRunner({
        contextFactory: this.contextFactory,
      });
    }
    return this.runner;
  }

  /**
   * Start a mission
   */
  async start(
    wing: Wing,
    costume: string | undefined,
    missionName: string,
    args: Record<string, unknown> = {}
  ): Promise<{ missionRunId: string; missionName: string }> {
    // Load the mission
    const loader = new ClosetMissionLoader({ wing, loadModule: this.moduleLoader });
    const loaded = costume !== undefined
      ? await loader.load(costume, missionName)
      : await loader.findAndLoad(missionName);

    // Start the mission
    const runner = this.getRunner();
    const handle = await runner.start(loaded.mission, {
      args,
      wing,
    });

    // Track the mission
    const tracked: TrackedMission = {
      handle,
      costume: loaded.costume,
      wingName: wing.name,
      events: [],
      status: 'running',
      lastPolledIndex: 0,
    };

    // Subscribe to all events via the catch-all 'event' channel
    // The 'event' channel is emitted by MissionHandle.emit() for all events
    // but is not part of the typed IMissionHandle interface
    (handle as unknown as { on(event: string, listener: (event: MissionEvent) => void): void }).on('event', (event: MissionEvent) => {
      console.log(`[MissionService] Event received: ${event.type} for mission ${handle.id}`);

      const eventRecord: MissionEventRecord = {
        type: event.type,
        timestamp: event.timestamp,
        data: event as unknown as Record<string, unknown>,
      };

      // Buffer event for polling clients
      tracked.events.push(eventRecord);

      // Update status based on event type
      if (event.type === 'completed') {
        tracked.status = 'completed';
      } else if (event.type === 'failed') {
        tracked.status = 'failed';
      } else if (event.type === 'cancelled') {
        tracked.status = 'cancelled';
      }

      // Broadcast to connected session clients
      if (this.broadcast) {
        this.broadcast({
          type: 'mission_event',
          missionRunId: handle.id,
          missionName: loaded.mission.name,
          costume: loaded.costume,
          wingName: wing.name,
          event: eventRecord,
        }).catch((err) => {
          console.error('[MissionService] Broadcast error:', err);
        });
      }
    });

    this.missions.set(handle.id, tracked);

    return {
      missionRunId: handle.id,
      missionName: loaded.mission.name,
    };
  }

  /**
   * Start a mission and wait for it to complete, returning its summary.
   *
   * Blocks until the mission emits 'completed' or 'failed'.
   * The completed event's `summary` field is returned as the result.
   */
  async startAndWait(
    wing: Wing,
    costume: string | undefined,
    missionName: string,
    args: Record<string, unknown> = {}
  ): Promise<Record<string, unknown>> {
    const { missionRunId } = await this.start(wing, costume, missionName, args);
    const tracked = this.missions.get(missionRunId);
    if (!tracked) {
      throw new Error(`Mission run "${missionRunId}" was not tracked after starting`);
    }

    return new Promise<Record<string, unknown>>((resolve, reject) => {
      // Subscribe to all future events
      (tracked.handle as unknown as { on(event: string, listener: (event: MissionEvent) => void): void })
        .on('event', (event: MissionEvent) => {
          if (event.type === 'completed') {
            resolve(event as unknown as Record<string, unknown>);
          } else if (event.type === 'failed' || event.type === 'cancelled') {
            const reason = ((event as unknown as Record<string, unknown>).reason as string) ?? event.type;
            reject(new Error(reason));
          }
        });

      // Handle race: mission may already be done by the time we subscribe
      if (tracked.status === 'completed') {
        const ev = tracked.events.find(e => e.type === 'completed');
        resolve((ev?.data ?? {}) as Record<string, unknown>);
      } else if (tracked.status === 'failed' || tracked.status === 'cancelled') {
        const ev = tracked.events.find(e => e.type === 'failed' || e.type === 'cancelled');
        reject(new Error((ev?.data?.reason as string) ?? tracked.status));
      }
    });
  }

  /**
   * Get events for a mission (returns new events since last poll)
   */
  getEvents(missionRunId: string): {
    status: MissionRunStatus;
    events: MissionEventRecord[];
  } | null {
    const tracked = this.missions.get(missionRunId);
    if (!tracked) {
      return null;
    }

    // Get new events since last poll
    const newEvents = tracked.events.slice(tracked.lastPolledIndex);
    tracked.lastPolledIndex = tracked.events.length;

    return {
      status: tracked.status,
      events: newEvents,
    };
  }

  /**
   * Get all events for a mission (does not update poll index)
   */
  getAllEvents(missionRunId: string): {
    status: MissionRunStatus;
    events: MissionEventRecord[];
  } | null {
    const tracked = this.missions.get(missionRunId);
    if (!tracked) {
      return null;
    }

    return {
      status: tracked.status,
      events: [...tracked.events],
    };
  }

  /**
   * Cancel a running mission
   */
  cancel(missionRunId: string, reason?: string): boolean {
    const tracked = this.missions.get(missionRunId);
    if (!tracked || tracked.status !== 'running') {
      return false;
    }

    const runner = this.getRunner();
    return runner.cancel(missionRunId, reason);
  }

  /**
   * Check if a mission exists
   */
  exists(missionRunId: string): boolean {
    return this.missions.has(missionRunId);
  }

  /**
   * Get mission info
   */
  get(missionRunId: string): TrackedMission | undefined {
    return this.missions.get(missionRunId);
  }

  /**
   * List all tracked missions
   */
  list(wingName?: string): TrackedMission[] {
    const all = Array.from(this.missions.values());
    if (wingName) {
      return all.filter((m) => m.wingName === wingName);
    }
    return all;
  }
}

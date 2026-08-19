import { randomUUID } from 'crypto';
import {
  Minion,
  MinionStatus,
  CreateMinionOptions
} from './types.js';
import { MessageCapture } from './MessageCapture.js';

/**
 * Options for listing minions
 */
export interface ListMinionsOptions {
  wingName?: string;
}

/**
 * Minion event types
 */
export interface MinionEvent {
  type: 'minion_spawned' | 'minion_killed' | 'minion_status_changed';
  minionId: string;
  wingName: string;
  status: MinionStatus;
  client: string;
}

/**
 * Broadcast callback type for pushing minion events to connected clients
 */
export type MinionBroadcastFn = (event: MinionEvent) => Promise<void>;

/**
 * Manages minion lifecycle and registry
 */
export class MinionManager {
  private minions: Map<string, Minion> = new Map();
  private broadcast?: MinionBroadcastFn;

  /**
   * Set the broadcast function for pushing events to clients
   */
  setBroadcast(fn: MinionBroadcastFn): void {
    this.broadcast = fn;
  }

  /**
   * Emit a minion event to connected clients
   */
  private emit(event: MinionEvent): void {
    if (this.broadcast) {
      this.broadcast(event).catch((err) => {
        console.error('[MinionManager] Broadcast error:', err);
      });
    }
  }

  /**
   * Create a new minion
   */
  create(options: CreateMinionOptions): Minion {
    const minion: Minion = {
      id: randomUUID(),
      client: options.client,
      status: MinionStatus.Idle,
      wingName: options.wingName,
      messageHistory: [],
      created: Date.now(),
      agentPrompt: options.agentPrompt,
      sessionId: options.sessionId ?? randomUUID(),
      messageCapture: new MessageCapture(),
    };

    this.minions.set(minion.id, minion);

    this.emit({
      type: 'minion_spawned',
      minionId: minion.id,
      wingName: minion.wingName,
      status: minion.status,
      client: minion.client,
    });

    return minion;
  }

  /**
   * Get a minion by ID
   */
  get(id: string): Minion | undefined {
    return this.minions.get(id);
  }

  /**
   * List all minions, optionally filtered
   */
  list(options?: ListMinionsOptions): Minion[] {
    const all = Array.from(this.minions.values());

    if (!options) {
      return all;
    }

    return all.filter((minion) => {
      if (options.wingName && minion.wingName !== options.wingName) {
        return false;
      }
      return true;
    });
  }

  /**
   * Remove a minion from the registry
   */
  remove(id: string): void {
    const minion = this.minions.get(id);
    if (minion) {
      this.emit({
        type: 'minion_killed',
        minionId: minion.id,
        wingName: minion.wingName,
        status: minion.status,
        client: minion.client,
      });
    }
    this.minions.delete(id);
  }

  /**
   * Update minion status
   */
  updateStatus(id: string, status: MinionStatus): void {
    const minion = this.minions.get(id);
    if (minion) {
      const previousStatus = minion.status;
      minion.status = status;

      if (previousStatus !== status) {
        this.emit({
          type: 'minion_status_changed',
          minionId: minion.id,
          wingName: minion.wingName,
          status: minion.status,
          client: minion.client,
        });
      }
    }
  }
}

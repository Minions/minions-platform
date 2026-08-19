import type { IHatchery } from '@minions/hatchery';
import type { MinionMessage } from '@minions/domain-types';
import { MissionHandle } from '../domain/MissionHandle';
import { extractErrorReason } from '../utils/errorReason.js';

/**
 * Options for starting a trivial mission
 */
export interface TrivialMissionOptions {
  /** Name of the mission (will be sent as /mission-name) */
  missionName: string;

  /** Path to the wing where the mission runs */
  wing: string;

  /** Model to use (defaults to claude-sonnet-4-20250514) */
  model?: string;

  /** Optional custom agent prompt */
  agentPrompt?: string;
}

/**
 * Phase 0: Trivial Runner
 *
 * A minimal implementation that proves the concept with zero risk.
 * Takes a mission name, spawns Claude Code, sends `/mission-name`,
 * and streams minion output as events until complete.
 *
 * This runner:
 * - Uses existing markdown missions unchanged
 * - Streams all minion messages as events
 * - Detects completion when minion stops responding
 * - Supports cancellation via the handle
 */
export class TrivialRunner {
  private readonly hatchery: IHatchery;

  constructor(hatchery: IHatchery) {
    this.hatchery = hatchery;
  }

  /**
   * Start a mission by sending a slash command to a minion
   *
   * @param options - Mission options including name and wing
   * @returns A handle for subscribing to events and awaiting completion
   */
  async start(options: TrivialMissionOptions): Promise<MissionHandle> {
    const { missionName } = options;

    // Generate unique ID
    const id = `mission-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const handle = new MissionHandle(id, missionName);

    // Emit started event
    handle.emit({
      type: 'started',
      missionName,
      timestamp: Date.now(),
    });

    // Spawn minion and run in background
    this.runMission(handle, options).catch((error) => {
      handle.emit({
        type: 'failed',
        error: error instanceof Error ? error : new Error(String(error)),
        reason: extractErrorReason(error),
        timestamp: Date.now(),
      });
    });

    return handle;
  }

  private async runMission(
    handle: MissionHandle,
    options: TrivialMissionOptions
  ): Promise<void> {
    const { missionName, wing, model, agentPrompt } = options;

    // Spawn Claude Code minion
    handle.emit({
      type: 'log',
      level: 'info',
      message: `Spawning minion in ${wing}...`,
      timestamp: Date.now(),
    });

    const minion = await this.hatchery.spawn({
      client: 'claude-code',
      wing,
      model: model ?? 'claude-sonnet-4-20250514',
      useBuiltInSystemPrompt: true,
      agentPrompt,
    });

    handle.emit({
      type: 'minion-spawned',
      minionId: minion.id,
      timestamp: Date.now(),
    });

    // Handle cancellation
    const cancelHandler = () => {
      minion.kill();
    };
    handle.once('cancelled', cancelHandler);

    try {
      // Send the slash command to start the mission
      const slashCommand = `/${missionName}`;
      handle.emit({
        type: 'log',
        level: 'info',
        message: `Sending command: ${slashCommand}`,
        timestamp: Date.now(),
      });

      await minion.send({
        type: 'user',
        content: slashCommand,
        timestamp: Date.now(),
      });

      // Stream all messages from the minion
      for await (const message of minion.receive()) {
        if (handle.isCancelled) {
          break;
        }

        // Forward message as event
        handle.emit({
          type: 'minion-message',
          minionId: minion.id,
          messageType: message.type,
          content: this.extractContent(message),
          timestamp: message.timestamp,
        });

        // Log progress for text messages
        if (message.type === 'text') {
          const preview = message.content.slice(0, 100);
          handle.emit({
            type: 'progress',
            message: preview + (message.content.length > 100 ? '...' : ''),
            timestamp: Date.now(),
          });
        }
      }

      // Minion completed
      if (!handle.isCancelled) {
        handle.emit({
          type: 'minion-completed',
          minionId: minion.id,
          timestamp: Date.now(),
        });

        handle.emit({
          type: 'completed',
          summary: `Mission ${missionName} completed`,
          timestamp: Date.now(),
        });
      }
    } catch (error) {
      if (!handle.isCancelled) {
        throw error;
      }
    } finally {
      handle.off('cancelled', cancelHandler);
      minion.kill();
    }
  }

  /**
   * Extract content from a minion message for event payload
   */
  private extractContent(message: MinionMessage): unknown {
    switch (message.type) {
      case 'text':
      case 'thinking':
      case 'user':
        return message.content;
      case 'tool_use':
        return { id: message.id, name: message.name, input: message.input };
      case 'tool_result':
        return { tool_use_id: message.tool_use_id, content: message.content };
      case 'error':
        return message.error;
      case 'status':
        return message.status;
      default:
        return message;
    }
  }
}

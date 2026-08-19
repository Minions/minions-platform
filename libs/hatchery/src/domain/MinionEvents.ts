/**
 * Minion Domain Events
 *
 * Events related to minion lifecycle and behavior. These events are emitted
 * by minions and can be subscribed to by mission code via the event bus.
 *
 * All events include runtime validation via Effect Schema.
 */

import { Schema } from 'effect';
import { defineEvent } from '@minions/events';

/**
 * Minion domain events
 *
 * These events are emitted by minions during their lifecycle.
 */
export const MinionEvents = {
  /**
   * Emitted when a minion completes a turn
   *
   * A turn is complete when the AI model returns `stop_reason: "end_turn"`,
   * indicating it's waiting for user input. This does NOT include tool use
   * (`stop_reason: "tool_use"`).
   */
  TurnComplete: defineEvent<{ minionId: string }>(
    'turn-complete',
    Schema.Struct({
      minionId: Schema.String,
    })
  ),

  /**
   * Emitted when a minion uses a gadget (MCP tool)
   *
   * Includes the gadget name, input, and result.
   */
  GadgetUse: defineEvent<{
    minionId: string;
    gadgetName: string;
    input: unknown;
    result: unknown;
  }>(
    'gadget-use',
    Schema.Struct({
      minionId: Schema.String,
      gadgetName: Schema.String,
      input: Schema.Unknown,
      result: Schema.Unknown,
    })
  ),

  /**
   * Emitted when a minion's status changes
   *
   * Status can be: 'processing', 'waiting', or 'dead'
   */
  StatusChange: defineEvent<{
    minionId: string;
    oldStatus: 'processing' | 'waiting' | 'dead';
    newStatus: 'processing' | 'waiting' | 'dead';
  }>(
    'status-change',
    Schema.Struct({
      minionId: Schema.String,
      oldStatus: Schema.Literal('processing', 'waiting', 'dead'),
      newStatus: Schema.Literal('processing', 'waiting', 'dead'),
    })
  ),

  /**
   * Emitted when a minion dies
   *
   * Includes the reason for death (normal completion, error, or cancellation)
   */
  Died: defineEvent<{
    minionId: string;
    reason: string;
  }>(
    'died',
    Schema.Struct({
      minionId: Schema.String,
      reason: Schema.String,
    })
  ),
} as const;

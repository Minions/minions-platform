/**
 * Standard events that missions emit
 *
 * Missions communicate via events rather than return values,
 * enabling long-running async operations with real-time updates.
 */

/**
 * Mission started event
 */
export interface MissionStartedEvent {
  type: 'started';
  missionName: string;
  args?: Record<string, unknown>;
  timestamp: number;
}

/**
 * Mission completed event
 */
export interface MissionCompletedEvent {
  type: 'completed';
  summary?: string;
  timestamp: number;
}

/**
 * Mission failed event
 */
export interface MissionFailedEvent {
  type: 'failed';
  error: Error;
  /** Human-readable error description with stack trace, for easy debugging */
  reason: string;
  timestamp: number;
}

/**
 * Mission cancelled event
 */
export interface MissionCancelledEvent {
  type: 'cancelled';
  reason?: string;
  timestamp: number;
}

/**
 * Progress update event
 */
export interface MissionProgressEvent {
  type: 'progress';
  message: string;
  percent?: number;
  timestamp: number;
}

/**
 * Log event for mission activity
 */
export interface MissionLogEvent {
  type: 'log';
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  timestamp: number;
}

/**
 * Minion spawned event
 */
export interface MinionSpawnedEvent {
  type: 'minion-spawned';
  minionId: string;
  timestamp: number;
}

/**
 * Minion message event - forwards messages from minions
 */
export interface MinionMessageEvent {
  type: 'minion-message';
  minionId: string;
  messageType: string;
  content: unknown;
  timestamp: number;
}

/**
 * Minion completed event
 */
export interface MinionCompletedEvent {
  type: 'minion-completed';
  minionId: string;
  timestamp: number;
}

/**
 * Question asked event - emitted when a mission asks a human a question
 */
export interface QuestionAskedEvent {
  type: 'question_asked';
  question: string;
  timestamp: number;
}

/**
 * Question answered event - emitted when a human answers a question
 */
export interface QuestionAnsweredEvent {
  type: 'question_answered';
  question: string;
  answer: string;
  timestamp: number;
}

/**
 * Union of all mission event types
 */
export type MissionEvent =
  | MissionStartedEvent
  | MissionCompletedEvent
  | MissionFailedEvent
  | MissionCancelledEvent
  | MissionProgressEvent
  | MissionLogEvent
  | MinionSpawnedEvent
  | MinionMessageEvent
  | MinionCompletedEvent
  | QuestionAskedEvent
  | QuestionAnsweredEvent;

/**
 * Extract the data type for a specific event type
 */
export type MissionEventData<T extends MissionEvent['type']> = Extract<
  MissionEvent,
  { type: T }
>;

/**
 * Typed mission events using defineEvent pattern
 *
 * These events use the defineEvent<P>() pattern with Effect Schema validation.
 * They provide better type safety and runtime validation than the legacy
 * interface-based events above.
 */

import { Schema } from 'effect';
import { defineEvent } from '@minions/events';

/**
 * Mission domain events using typed event declarations
 *
 * These events are emitted by missions during their execution and can be
 * subscribed to via the event bus for observability and persistence.
 */
export const MissionEvents = {
  /**
   * Emitted when a mission asks a human a question
   *
   * This event is emitted before the question is presented to the human,
   * enabling observability and persistence of the question for later resume.
   */
  QuestionAsked: defineEvent<{
    questionId: string;
    question: string;
    content: { type: string; content: string };
    options: readonly { value: string; label: string; description?: string }[];
    optionsMode: 'exclusive' | 'non-exclusive';
    controls?: readonly { name: string; type: string; label: string }[];
  }>(
    'question-asked',
    Schema.Struct({
      questionId: Schema.String,
      question: Schema.String,
      content: Schema.Struct({
        type: Schema.String,
        content: Schema.String,
      }),
      options: Schema.Array(Schema.Struct({
        value: Schema.String,
        label: Schema.String,
        description: Schema.optional(Schema.String),
      })),
      optionsMode: Schema.Union(Schema.Literal('exclusive'), Schema.Literal('non-exclusive')),
      controls: Schema.optional(Schema.Array(Schema.Struct({
        name: Schema.String,
        type: Schema.String,
        label: Schema.String,
      }))),
    })
  ),

  /**
   * Emitted when a human answers a question
   *
   * This event is emitted after the answer is received from the human,
   * enabling persistence of the answer for later resume.
   */
  QuestionAnswered: defineEvent<{
    questionId: string;
    answer: string;
  }>(
    'question-answered',
    Schema.Struct({
      questionId: Schema.String,
      answer: Schema.String,
    })
  ),

  // ============================================================================
  // Orchestration State Events
  // ============================================================================
  // These events track workflow state transitions for the deterministic
  // orchestrator. They enable state reconstruction from event logs for
  // mission resumption across session boundaries.

  /**
   * Emitted when the orchestration phase changes
   *
   * Phases represent major workflow stages: planning, development, demo, review.
   * This event enables state reconstruction by tracking phase transitions.
   */
  PhaseChanged: defineEvent<{
    phase: 'planning' | 'development' | 'demo' | 'review';
    previousPhase: string;
  }>(
    'phase-changed',
    Schema.Struct({
      phase: Schema.Literal('planning', 'development', 'demo', 'review'),
      previousPhase: Schema.String,
    })
  ),

  /**
   * Emitted when a story begins execution
   *
   * Stories are the atomic units of work within a slice. This event
   * enables tracking which stories have been started for resumption.
   */
  StoryStarted: defineEvent<{
    storyIndex: number;
    title: string;
  }>(
    'story-started',
    Schema.Struct({
      storyIndex: Schema.Number,
      title: Schema.String,
    })
  ),

  /**
   * Emitted when a story completes (successfully or blocked)
   *
   * This event enables tracking which stories have completed and their
   * outcomes. Blocked stories may need user intervention or retries.
   */
  StoryCompleted: defineEvent<{
    storyIndex: number;
    status: 'success' | 'blocked';
  }>(
    'story-completed',
    Schema.Struct({
      storyIndex: Schema.Number,
      status: Schema.Literal('success', 'blocked'),
    })
  ),

  /**
   * Emitted when an agent is spawned by the orchestrator
   *
   * Tracks which agents have been created during orchestration, enabling
   * debugging and observability of the multi-agent workflow.
   */
  AgentSpawned: defineEvent<{
    agentType: string;
    minionId: string;
  }>(
    'agent-spawned',
    Schema.Struct({
      agentType: Schema.String,
      minionId: Schema.String,
    })
  ),
} as const;

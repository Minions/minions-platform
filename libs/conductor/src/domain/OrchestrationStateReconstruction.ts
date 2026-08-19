/**
 * Orchestration State Reconstruction
 *
 * Provides deterministic state reconstruction from event logs for mission resumption.
 * This is the core mechanism that enables orchestrate missions to resume from where
 * they left off after interruption or session boundaries.
 *
 * The key principle is determinism: given the same sequence of events, this function
 * will always produce the same state. This makes missions resumable by simply
 * replaying the event log.
 */

import type { SerializedEvent } from './EventSerialization';

/**
 * Orchestration state that can be reconstructed from events
 *
 * This represents the deterministic state that an orchestrate mission
 * can rebuild by replaying the event log. It tracks:
 * - Current workflow phase (planning, development, demo, review)
 * - Which stories have been completed, blocked, or are in progress
 * - Which agents have been spawned during the orchestration
 *
 * This state is sufficient to resume the mission from where it left off.
 */
export interface OrchestrationState {
  /**
   * The current workflow phase, or null if not yet started
   */
  currentPhase: 'planning' | 'development' | 'demo' | 'review' | null;

  /**
   * Story indices that completed successfully
   */
  completedStories: number[];

  /**
   * Story indices that were blocked (need retry or user intervention)
   */
  blockedStories: number[];

  /**
   * Story index currently in progress, or null if none
   */
  currentStory: number | null;

  /**
   * Agents that have been spawned during orchestration
   */
  spawnedAgents: Array<{ type: string; minionId: string }>;
}

/**
 * Event types that affect orchestration state
 *
 * These match the event type strings from MissionEvents.PhaseChanged,
 * StoryStarted, StoryCompleted, and AgentSpawned.
 */
type OrchestrationEventType =
  | 'phase-changed'
  | 'story-started'
  | 'story-completed'
  | 'agent-spawned';

/**
 * Create the initial (empty) orchestration state
 */
export function createInitialOrchestrationState(): OrchestrationState {
  return {
    currentPhase: null,
    completedStories: [],
    blockedStories: [],
    currentStory: null,
    spawnedAgents: [],
  };
}

/**
 * Deterministically reconstruct orchestration state from events
 *
 * This function demonstrates the key pattern for resumption: given a sequence
 * of events, we can deterministically rebuild the exact state of the mission.
 *
 * The function processes events in chronological order (as they were persisted)
 * and applies each event to the state. Because this is a pure function with
 * no side effects, the same events will always produce the same state.
 *
 * @param events - Array of serialized events in chronological order
 * @returns Reconstructed orchestration state
 *
 * @example
 * ```typescript
 * // Load events from persister
 * const events = await Effect.runPromise(loadEvents(persister));
 *
 * // Reconstruct state deterministically
 * const state = reconstructOrchestrationState(events);
 *
 * // Resume from the reconstructed state
 * if (state.currentStory !== null) {
 *   // Continue from incomplete story
 * } else if (state.completedStories.length > 0) {
 *   // Start next story
 * }
 * ```
 */
export function reconstructOrchestrationState(
  events: SerializedEvent[]
): OrchestrationState {
  const state = createInitialOrchestrationState();

  // Process events in chronological order (as persisted)
  for (const event of events) {
    applyEventToState(state, event);
  }

  return state;
}

/**
 * Apply a single event to the orchestration state
 *
 * This function mutates the state in place for efficiency when processing
 * many events. Use reconstructOrchestrationState() for the immutable API.
 *
 * @param state - The state to mutate
 * @param event - The event to apply
 */
export function applyEventToState(
  state: OrchestrationState,
  event: SerializedEvent
): void {
  switch (event.type as OrchestrationEventType) {
    case 'phase-changed':
      state.currentPhase = event.payload.phase as OrchestrationState['currentPhase'];
      break;

    case 'story-started':
      state.currentStory = event.payload.storyIndex as number;
      break;

    case 'story-completed':
      // Mark story as completed or blocked
      if (event.payload.status === 'success') {
        state.completedStories.push(event.payload.storyIndex as number);
      } else {
        state.blockedStories.push(event.payload.storyIndex as number);
      }
      // Clear current story (it's no longer in progress)
      state.currentStory = null;
      break;

    case 'agent-spawned':
      state.spawnedAgents.push({
        type: event.payload.agentType as string,
        minionId: event.payload.minionId as string,
      });
      break;

    // Ignore other event types - they don't affect orchestration state
  }
}

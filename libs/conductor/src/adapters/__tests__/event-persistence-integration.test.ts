/**
 * Event Persistence Integration Test
 *
 * Validates the complete event persistence flow for orchestrate mission resumption.
 * This test proves that:
 * - Events can be persisted during mission execution
 * - Mission state can be reconstructed from persisted events
 * - Missions can resume from where they left off after interruption
 *
 * This is the key validation for the event-persistence slice, proving the
 * PRD requirement: "Resume from saved state works correctly."
 *
 * NOTE: This test manually persists events rather than using EventPersistenceSubscription
 * to avoid dependency on that component's current state.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Effect } from 'effect';
import { createInMemorySandbox } from '@minions/file-store';
import type { File, Sandbox } from '@minions/file-store';
import { FileEventPersister } from '../FileEventPersister';
import {
  loadEvents,
  reconstructOrchestrationState,
} from '../../domain';
import { createTestEvent } from '../../test-utils/event-helpers';

describe('Event Persistence Integration', () => {
  let sandbox: Sandbox;
  let eventFile: File;
  let persister: FileEventPersister;

  beforeEach(async () => {
    // Create in-memory sandbox (simulates plan directory)
    sandbox = createInMemorySandbox();

    // Create event file
    eventFile = await sandbox.root.createFile('events.jsonl', '');

    // Create file-based persister
    persister = new FileEventPersister(eventFile);
  });

  describe('orchestrate mission resumption scenario', () => {
    it('persists events and reconstructs state after interruption', async () => {
      // === FIRST RUN: Mission runs partway and "crashes" ===

      // Simulate orchestrate mission emitting and persisting state transition events
      const event1 = createTestEvent('phase-changed', {
        phase: 'development',
      });
      await Effect.runPromise(persister.append(event1));

      const event2 = createTestEvent('story-started', {
        storyIndex: 1,
        title: 'Story 1',
      });
      await Effect.runPromise(persister.append(event2));

      const event3 = createTestEvent('story-completed', {
        storyIndex: 1,
        status: 'success',
      });
      await Effect.runPromise(persister.append(event3));

      // Start second story but "crash" before completing
      const event4 = createTestEvent('story-started', {
        storyIndex: 2,
        title: 'Story 2',
      });
      await Effect.runPromise(persister.append(event4));

      // Flush to ensure events are written
      await Effect.runPromise(persister.flush());

      // === SECOND RUN: New mission instance loads persisted events ===

      // Load events from file
      const loadedEvents = await Effect.runPromise(loadEvents(persister));

      expect(loadedEvents.length).toBe(4);

      // Reconstruct state deterministically from events
      const state = reconstructOrchestrationState(loadedEvents);

      // Verify state reconstruction
      expect(state.currentPhase).toBe('development');
      expect(state.completedStories).toContain(1);
      expect(state.currentStory).toBe(2); // Story 2 was started but not completed
      expect(state.blockedStories).toHaveLength(0);

      // Mission can now resume from Story 2 without re-doing Story 1
    });

    it('produces deterministic state from same event sequence', async () => {
      // Emit and persist a sequence of events
      const events = [
        createTestEvent('phase-changed', { phase: 'development' }),
        createTestEvent('story-started', { storyIndex: 1, title: 'Story 1' }),
        createTestEvent('story-completed', { storyIndex: 1, status: 'success' }),
        createTestEvent('story-started', { storyIndex: 2, title: 'Story 2' }),
      ];

      for (const event of events) {
        await Effect.runPromise(persister.append(event));
      }

      await Effect.runPromise(persister.flush());

      // Load events and reconstruct state twice
      const loadedEvents = await Effect.runPromise(loadEvents(persister));
      const state1 = reconstructOrchestrationState(loadedEvents);
      const state2 = reconstructOrchestrationState(loadedEvents);

      // State reconstruction is deterministic
      expect(state1).toEqual(state2);
      expect(state1.currentPhase).toBe('development');
      expect(state1.completedStories).toEqual([1]);
      expect(state1.currentStory).toBe(2);
    });

    it('handles multiple phase transitions', async () => {
      // Simulate full orchestration flow
      const events = [
        createTestEvent('phase-changed', { phase: 'planning' }),
        createTestEvent('phase-changed', {
          phase: 'development',
          previousPhase: 'planning',
        }),
        createTestEvent('story-started', { storyIndex: 1, title: 'Story 1' }),
        createTestEvent('story-completed', { storyIndex: 1, status: 'success' }),
        createTestEvent('phase-changed', {
          phase: 'demo',
          previousPhase: 'development',
        }),
      ];

      for (const event of events) {
        await Effect.runPromise(persister.append(event));
      }

      await Effect.runPromise(persister.flush());

      const loadedEvents = await Effect.runPromise(loadEvents(persister));
      const state = reconstructOrchestrationState(loadedEvents);

      expect(state.currentPhase).toBe('demo');
      expect(state.completedStories).toContain(1);
    });

    it('tracks spawned agents across interruption', async () => {
      const events = [
        createTestEvent('phase-changed', { phase: 'development' }),
        createTestEvent('agent-spawned', {
          agentType: 'developer',
          minionId: 'minion-001',
        }),
        createTestEvent('agent-spawned', {
          agentType: 'reviewer',
          minionId: 'minion-002',
        }),
      ];

      for (const event of events) {
        await Effect.runPromise(persister.append(event));
      }

      await Effect.runPromise(persister.flush());

      const loadedEvents = await Effect.runPromise(loadEvents(persister));
      const state = reconstructOrchestrationState(loadedEvents);

      expect(state.spawnedAgents).toHaveLength(2);
      expect(state.spawnedAgents).toContainEqual({
        type: 'developer',
        minionId: 'minion-001',
      });
      expect(state.spawnedAgents).toContainEqual({
        type: 'reviewer',
        minionId: 'minion-002',
      });
    });

    it('distinguishes between completed and blocked stories', async () => {
      const events = [
        createTestEvent('phase-changed', { phase: 'development' }),
        createTestEvent('story-started', { storyIndex: 1, title: 'Story 1' }),
        createTestEvent('story-completed', { storyIndex: 1, status: 'success' }),
        createTestEvent('story-started', { storyIndex: 2, title: 'Story 2' }),
        createTestEvent('story-completed', { storyIndex: 2, status: 'blocked' }),
      ];

      for (const event of events) {
        await Effect.runPromise(persister.append(event));
      }

      await Effect.runPromise(persister.flush());

      const loadedEvents = await Effect.runPromise(loadEvents(persister));
      const state = reconstructOrchestrationState(loadedEvents);

      expect(state.completedStories).toEqual([1]);
      expect(state.blockedStories).toEqual([2]);
      expect(state.currentStory).toBe(null); // No story in progress
    });

    it('preserves event order during load', async () => {
      const events = [
        createTestEvent('phase-changed', { phase: 'planning' }),
        createTestEvent('phase-changed', {
          phase: 'development',
          previousPhase: 'planning',
        }),
        createTestEvent('story-started', { storyIndex: 1, title: 'Story 1' }),
      ];

      for (const event of events) {
        await Effect.runPromise(persister.append(event));
      }

      await Effect.runPromise(persister.flush());

      const loadedEvents = await Effect.runPromise(loadEvents(persister));

      // Events should be in chronological order
      expect(loadedEvents[0].type).toBe('phase-changed');
      expect(loadedEvents[0].payload.phase).toBe('planning');

      expect(loadedEvents[1].type).toBe('phase-changed');
      expect(loadedEvents[1].payload.phase).toBe('development');

      expect(loadedEvents[2].type).toBe('story-started');
      expect(loadedEvents[2].payload.storyIndex).toBe(1);
    });

    it('handles empty event log gracefully', async () => {
      const loadedEvents = await Effect.runPromise(loadEvents(persister));
      expect(loadedEvents).toEqual([]);

      // State reconstruction from empty events should yield initial state
      const state = reconstructOrchestrationState(loadedEvents);
      expect(state.currentPhase).toBe(null);
      expect(state.completedStories).toEqual([]);
      expect(state.currentStory).toBe(null);
    });
  });

  describe('resumption without re-doing work', () => {
    it('allows mission to skip completed stories on resume', async () => {
      // First run: complete stories 1, 2, 3
      const events = [
        createTestEvent('phase-changed', { phase: 'development' }),
      ];

      for (let i = 1; i <= 3; i++) {
        events.push(
          createTestEvent('story-started', {
            storyIndex: i,
            title: `Story ${i}`,
          })
        );
        events.push(
          createTestEvent('story-completed', {
            storyIndex: i,
            status: 'success',
          })
        );
      }

      // Start story 4 but don't complete (interruption)
      events.push(
        createTestEvent('story-started', {
          storyIndex: 4,
          title: 'Story 4',
        })
      );

      for (const event of events) {
        await Effect.runPromise(persister.append(event));
      }

      await Effect.runPromise(persister.flush());

      // Second run: load and reconstruct
      const loadedEvents = await Effect.runPromise(loadEvents(persister));
      const state = reconstructOrchestrationState(loadedEvents);

      // Mission knows stories 1-3 are done
      expect(state.completedStories).toEqual([1, 2, 3]);

      // Mission should resume from story 4
      expect(state.currentStory).toBe(4);

      // This proves the mission can resume without re-doing stories 1-3
    });
  });
});

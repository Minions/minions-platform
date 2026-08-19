/**
 * Tests for OrchestrationStateReconstruction
 *
 * These tests verify that orchestration state can be deterministically
 * reconstructed from event logs, enabling mission resumption.
 */

import { describe, it, expect } from 'vitest';
import {
  reconstructOrchestrationState,
  createInitialOrchestrationState,
  applyEventToState,
} from './OrchestrationStateReconstruction';
import { createSerializedEvent } from '../test-utils/event-helpers';

describe('OrchestrationStateReconstruction', () => {
  describe('createInitialOrchestrationState', () => {
    it('creates empty state', () => {
      const state = createInitialOrchestrationState();

      expect(state).toEqual({
        currentPhase: null,
        completedStories: [],
        blockedStories: [],
        currentStory: null,
        spawnedAgents: [],
      });
    });
  });

  describe('reconstructOrchestrationState', () => {
    it('returns initial state for empty events', () => {
      const state = reconstructOrchestrationState([]);

      expect(state.currentPhase).toBe(null);
      expect(state.completedStories).toEqual([]);
      expect(state.currentStory).toBe(null);
    });

    it('tracks phase changes', () => {
      const events = [
        createSerializedEvent('phase-changed', { phase: 'planning' }),
        createSerializedEvent('phase-changed', {
          phase: 'development',
          previousPhase: 'planning',
        }),
      ];

      const state = reconstructOrchestrationState(events);

      expect(state.currentPhase).toBe('development');
    });

    it('tracks story progress', () => {
      const events = [
        createSerializedEvent('phase-changed', { phase: 'development' }),
        createSerializedEvent('story-started', {
          storyIndex: 1,
          title: 'Story 1',
        }),
        createSerializedEvent('story-completed', {
          storyIndex: 1,
          status: 'success',
        }),
        createSerializedEvent('story-started', {
          storyIndex: 2,
          title: 'Story 2',
        }),
      ];

      const state = reconstructOrchestrationState(events);

      expect(state.completedStories).toEqual([1]);
      expect(state.currentStory).toBe(2);
    });

    it('tracks blocked stories', () => {
      const events = [
        createSerializedEvent('phase-changed', { phase: 'development' }),
        createSerializedEvent('story-started', {
          storyIndex: 1,
          title: 'Story 1',
        }),
        createSerializedEvent('story-completed', {
          storyIndex: 1,
          status: 'blocked',
        }),
      ];

      const state = reconstructOrchestrationState(events);

      expect(state.completedStories).toEqual([]);
      expect(state.blockedStories).toEqual([1]);
      expect(state.currentStory).toBe(null);
    });

    it('tracks spawned agents', () => {
      const events = [
        createSerializedEvent('agent-spawned', {
          agentType: 'developer',
          minionId: 'minion-001',
        }),
        createSerializedEvent('agent-spawned', {
          agentType: 'reviewer',
          minionId: 'minion-002',
        }),
      ];

      const state = reconstructOrchestrationState(events);

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

    it('is deterministic - same events produce same state', () => {
      const events = [
        createSerializedEvent('phase-changed', { phase: 'development' }),
        createSerializedEvent('story-started', {
          storyIndex: 1,
          title: 'Story 1',
        }),
        createSerializedEvent('story-completed', {
          storyIndex: 1,
          status: 'success',
        }),
      ];

      const state1 = reconstructOrchestrationState(events);
      const state2 = reconstructOrchestrationState(events);

      expect(state1).toEqual(state2);
    });

    it('ignores unknown event types', () => {
      const events = [
        createSerializedEvent('phase-changed', { phase: 'development' }),
        createSerializedEvent('unknown-event', { data: 'test' }),
        createSerializedEvent('story-started', {
          storyIndex: 1,
          title: 'Story 1',
        }),
      ];

      const state = reconstructOrchestrationState(events);

      expect(state.currentPhase).toBe('development');
      expect(state.currentStory).toBe(1);
    });

    it('handles complete orchestration workflow', () => {
      const events = [
        createSerializedEvent('phase-changed', { phase: 'planning' }),
        createSerializedEvent('agent-spawned', {
          agentType: 'planner',
          minionId: 'minion-001',
        }),
        createSerializedEvent('phase-changed', {
          phase: 'development',
          previousPhase: 'planning',
        }),
        createSerializedEvent('story-started', {
          storyIndex: 1,
          title: 'Story 1',
        }),
        createSerializedEvent('agent-spawned', {
          agentType: 'developer',
          minionId: 'minion-002',
        }),
        createSerializedEvent('story-completed', {
          storyIndex: 1,
          status: 'success',
        }),
        createSerializedEvent('story-started', {
          storyIndex: 2,
          title: 'Story 2',
        }),
        createSerializedEvent('story-completed', {
          storyIndex: 2,
          status: 'success',
        }),
        createSerializedEvent('phase-changed', {
          phase: 'demo',
          previousPhase: 'development',
        }),
      ];

      const state = reconstructOrchestrationState(events);

      expect(state.currentPhase).toBe('demo');
      expect(state.completedStories).toEqual([1, 2]);
      expect(state.blockedStories).toEqual([]);
      expect(state.currentStory).toBe(null);
      expect(state.spawnedAgents).toHaveLength(2);
    });
  });

  describe('applyEventToState', () => {
    it('mutates state in place', () => {
      const state = createInitialOrchestrationState();
      const event = createSerializedEvent('phase-changed', {
        phase: 'development',
      });

      applyEventToState(state, event);

      expect(state.currentPhase).toBe('development');
    });

    it('can be used incrementally for streaming', () => {
      const state = createInitialOrchestrationState();

      // Apply events one at a time (as they arrive)
      applyEventToState(
        state,
        createSerializedEvent('phase-changed', { phase: 'development' })
      );
      expect(state.currentPhase).toBe('development');

      applyEventToState(
        state,
        createSerializedEvent('story-started', {
          storyIndex: 1,
          title: 'Story 1',
        })
      );
      expect(state.currentStory).toBe(1);

      applyEventToState(
        state,
        createSerializedEvent('story-completed', {
          storyIndex: 1,
          status: 'success',
        })
      );
      expect(state.completedStories).toEqual([1]);
      expect(state.currentStory).toBe(null);
    });
  });
});

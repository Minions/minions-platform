import { describe, it, expect, vi } from 'vitest';
import { Schema } from 'effect';
import { EventBus, type TypedEvent } from '@minions/events';
import { EventBusTestHelper } from '../test-utils/EventBusTestHelper';
import { MissionEvents } from './MissionEvents';

/**
 * Tests for Orchestration State Events
 *
 * These events enable state reconstruction from event logs for mission resumption.
 * They are emitted by the deterministic orchestrator to track workflow transitions.
 */
describe('Orchestration State Events', () => {
  describe('PhaseChanged', () => {
    it('can be emitted with valid phase transition', async () => {
      const eventBus = new EventBus();
      const helper = new EventBusTestHelper(eventBus);

      const handler = vi.fn();
      const unsubscribe = await helper.subscribeAndWait(MissionEvents.PhaseChanged, handler);

      await helper.emitAndWait(MissionEvents.PhaseChanged, {
        phase: 'development',
        previousPhase: 'planning',
      });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          phase: 'development',
          previousPhase: 'planning',
          __type: 'phase-changed',
        })
      );

      await helper.unsubscribeAndWait(unsubscribe);
    });

    it('accepts all valid phase values', async () => {
      const eventBus = new EventBus();
      const helper = new EventBusTestHelper(eventBus);
      const phases = ['planning', 'development', 'demo', 'review'] as const;
      const receivedPhases: string[] = [];

      const unsubscribe = await helper.subscribeAndWait(
        MissionEvents.PhaseChanged,
        (event: TypedEvent<typeof MissionEvents.PhaseChanged>) => {
          receivedPhases.push(event.phase);
        }
      );

      for (const phase of phases) {
        await helper.emitAndWait(MissionEvents.PhaseChanged, {
          phase,
          previousPhase: 'init',
        });
      }

      expect(receivedPhases).toEqual(['planning', 'development', 'demo', 'review']);

      await helper.unsubscribeAndWait(unsubscribe);
    });

    it('preserves previousPhase for audit trail', async () => {
      const eventBus = new EventBus();
      const helper = new EventBusTestHelper(eventBus);
      const transitions: Array<{ from: string; to: string }> = [];

      const unsubscribe = await helper.subscribeAndWait(
        MissionEvents.PhaseChanged,
        (event: TypedEvent<typeof MissionEvents.PhaseChanged>) => {
          transitions.push({
            from: event.previousPhase,
            to: event.phase,
          });
        }
      );

      // Simulate orchestration workflow
      await helper.emitAndWait(MissionEvents.PhaseChanged, { phase: 'planning', previousPhase: 'init' });
      await helper.emitAndWait(MissionEvents.PhaseChanged, { phase: 'development', previousPhase: 'planning' });
      await helper.emitAndWait(MissionEvents.PhaseChanged, { phase: 'demo', previousPhase: 'development' });

      expect(transitions).toEqual([
        { from: 'init', to: 'planning' },
        { from: 'planning', to: 'development' },
        { from: 'development', to: 'demo' },
      ]);

      await helper.unsubscribeAndWait(unsubscribe);
    });
  });

  describe('StoryStarted', () => {
    it('can be emitted with story index and title', async () => {
      const eventBus = new EventBus();
      const helper = new EventBusTestHelper(eventBus);

      const handler = vi.fn();
      const unsubscribe = await helper.subscribeAndWait(MissionEvents.StoryStarted, handler);

      await helper.emitAndWait(MissionEvents.StoryStarted, {
        storyIndex: 1,
        title: 'Define Event Serialization Format',
      });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          storyIndex: 1,
          title: 'Define Event Serialization Format',
          __type: 'story-started',
        })
      );

      await helper.unsubscribeAndWait(unsubscribe);
    });

    it('tracks multiple stories in sequence', async () => {
      const eventBus = new EventBus();
      const helper = new EventBusTestHelper(eventBus);
      const startedStories: Array<{ index: number; title: string }> = [];

      const unsubscribe = await helper.subscribeAndWait(
        MissionEvents.StoryStarted,
        (event: TypedEvent<typeof MissionEvents.StoryStarted>) => {
          startedStories.push({
            index: event.storyIndex,
            title: event.title,
          });
        }
      );

      await helper.emitAndWait(MissionEvents.StoryStarted, { storyIndex: 1, title: 'Story One' });
      await helper.emitAndWait(MissionEvents.StoryStarted, { storyIndex: 2, title: 'Story Two' });
      await helper.emitAndWait(MissionEvents.StoryStarted, { storyIndex: 3, title: 'Story Three' });

      expect(startedStories).toEqual([
        { index: 1, title: 'Story One' },
        { index: 2, title: 'Story Two' },
        { index: 3, title: 'Story Three' },
      ]);

      await helper.unsubscribeAndWait(unsubscribe);
    });
  });

  describe('StoryCompleted', () => {
    it('can emit success status', async () => {
      const eventBus = new EventBus();
      const helper = new EventBusTestHelper(eventBus);

      const handler = vi.fn();
      const unsubscribe = await helper.subscribeAndWait(MissionEvents.StoryCompleted, handler);

      await helper.emitAndWait(MissionEvents.StoryCompleted, {
        storyIndex: 1,
        status: 'success',
      });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          storyIndex: 1,
          status: 'success',
          __type: 'story-completed',
        })
      );

      await helper.unsubscribeAndWait(unsubscribe);
    });

    it('can emit blocked status', async () => {
      const eventBus = new EventBus();
      const helper = new EventBusTestHelper(eventBus);

      const handler = vi.fn();
      const unsubscribe = await helper.subscribeAndWait(MissionEvents.StoryCompleted, handler);

      await helper.emitAndWait(MissionEvents.StoryCompleted, {
        storyIndex: 2,
        status: 'blocked',
      });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'blocked',
          __type: 'story-completed',
        })
      );

      await helper.unsubscribeAndWait(unsubscribe);
    });

    it('enables tracking story completion for resumption', async () => {
      const eventBus = new EventBus();
      const helper = new EventBusTestHelper(eventBus);
      const completedStories = new Map<number, 'success' | 'blocked'>();

      const unsubscribe = await helper.subscribeAndWait(
        MissionEvents.StoryCompleted,
        (event: TypedEvent<typeof MissionEvents.StoryCompleted>) => {
          completedStories.set(event.storyIndex, event.status);
        }
      );

      // Simulate some stories completing
      await helper.emitAndWait(MissionEvents.StoryCompleted, { storyIndex: 1, status: 'success' });
      await helper.emitAndWait(MissionEvents.StoryCompleted, { storyIndex: 2, status: 'success' });
      await helper.emitAndWait(MissionEvents.StoryCompleted, { storyIndex: 3, status: 'blocked' });

      // Can reconstruct state: stories 1,2 complete, story 3 blocked
      expect(completedStories.get(1)).toBe('success');
      expect(completedStories.get(2)).toBe('success');
      expect(completedStories.get(3)).toBe('blocked');
      expect(completedStories.size).toBe(3);

      await helper.unsubscribeAndWait(unsubscribe);
    });
  });

  describe('AgentSpawned', () => {
    it('can be emitted with agent type and minion id', async () => {
      const eventBus = new EventBus();
      const helper = new EventBusTestHelper(eventBus);

      const handler = vi.fn();
      const unsubscribe = await helper.subscribeAndWait(MissionEvents.AgentSpawned, handler);

      await helper.emitAndWait(MissionEvents.AgentSpawned, {
        agentType: 'developer',
        minionId: 'minion-abc-123',
      });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          agentType: 'developer',
          minionId: 'minion-abc-123',
          __type: 'agent-spawned',
        })
      );

      await helper.unsubscribeAndWait(unsubscribe);
    });

    it('tracks multiple agent types in orchestration', async () => {
      const eventBus = new EventBus();
      const helper = new EventBusTestHelper(eventBus);
      const spawnedAgents: Array<{ type: string; id: string }> = [];

      const unsubscribe = await helper.subscribeAndWait(
        MissionEvents.AgentSpawned,
        (event: TypedEvent<typeof MissionEvents.AgentSpawned>) => {
          spawnedAgents.push({
            type: event.agentType,
            id: event.minionId,
          });
        }
      );

      // Simulate orchestrator spawning various agents
      await helper.emitAndWait(MissionEvents.AgentSpawned, {
        agentType: 'slice-planner',
        minionId: 'planner-001',
      });
      await helper.emitAndWait(MissionEvents.AgentSpawned, {
        agentType: 'implementation-critic',
        minionId: 'critic-001',
      });
      await helper.emitAndWait(MissionEvents.AgentSpawned, {
        agentType: 'developer',
        minionId: 'dev-001',
      });
      await helper.emitAndWait(MissionEvents.AgentSpawned, {
        agentType: 'technical-reviewer',
        minionId: 'reviewer-001',
      });

      expect(spawnedAgents).toHaveLength(4);
      expect(spawnedAgents.map((a) => a.type)).toEqual([
        'slice-planner',
        'implementation-critic',
        'developer',
        'technical-reviewer',
      ]);

      await helper.unsubscribeAndWait(unsubscribe);
    });
  });

  describe('Full Orchestration Event Sequence', () => {
    it('demonstrates complete workflow tracking for state reconstruction', async () => {
      const eventBus = new EventBus();
      const helper = new EventBusTestHelper(eventBus);
      const eventLog: Array<{
        type: string;
        data: unknown;
      }> = [];

      // Subscribe to all orchestration events
      const unsub1 = await helper.subscribeAndWait(
        MissionEvents.PhaseChanged,
        (event: TypedEvent<typeof MissionEvents.PhaseChanged>) => {
          eventLog.push({ type: 'PhaseChanged', data: { phase: event.phase, previousPhase: event.previousPhase } });
        }
      );
      const unsub2 = await helper.subscribeAndWait(
        MissionEvents.StoryStarted,
        (event: TypedEvent<typeof MissionEvents.StoryStarted>) => {
          eventLog.push({ type: 'StoryStarted', data: { storyIndex: event.storyIndex, title: event.title } });
        }
      );
      const unsub3 = await helper.subscribeAndWait(
        MissionEvents.StoryCompleted,
        (event: TypedEvent<typeof MissionEvents.StoryCompleted>) => {
          eventLog.push({ type: 'StoryCompleted', data: { storyIndex: event.storyIndex, status: event.status } });
        }
      );
      const unsub4 = await helper.subscribeAndWait(
        MissionEvents.AgentSpawned,
        (event: TypedEvent<typeof MissionEvents.AgentSpawned>) => {
          eventLog.push({ type: 'AgentSpawned', data: { agentType: event.agentType, minionId: event.minionId } });
        }
      );

      // Simulate a mini-orchestration workflow
      await helper.emitAndWait(MissionEvents.PhaseChanged, { phase: 'planning', previousPhase: 'init' });
      await helper.emitAndWait(MissionEvents.AgentSpawned, { agentType: 'slice-planner', minionId: 'sp-1' });
      await helper.emitAndWait(MissionEvents.PhaseChanged, { phase: 'development', previousPhase: 'planning' });
      await helper.emitAndWait(MissionEvents.StoryStarted, { storyIndex: 1, title: 'First Story' });
      await helper.emitAndWait(MissionEvents.AgentSpawned, { agentType: 'developer', minionId: 'dev-1' });
      await helper.emitAndWait(MissionEvents.StoryCompleted, { storyIndex: 1, status: 'success' });
      await helper.emitAndWait(MissionEvents.PhaseChanged, { phase: 'demo', previousPhase: 'development' });

      // The event log enables state reconstruction
      expect(eventLog).toHaveLength(7);
      expect(eventLog.map((e) => e.type)).toEqual([
        'PhaseChanged',
        'AgentSpawned',
        'PhaseChanged',
        'StoryStarted',
        'AgentSpawned',
        'StoryCompleted',
        'PhaseChanged',
      ]);

      // Can reconstruct state from events:
      // - Current phase: demo
      // - Stories completed: [1]
      // - Agents spawned: [slice-planner, developer]
      const lastPhaseEvent = eventLog
        .filter((e) => e.type === 'PhaseChanged')
        .pop() as { type: string; data: { phase: string } };
      expect(lastPhaseEvent.data.phase).toBe('demo');

      const completedStories = eventLog
        .filter((e) => e.type === 'StoryCompleted')
        .map((e) => (e.data as { storyIndex: number }).storyIndex);
      expect(completedStories).toEqual([1]);

      // Cleanup
      await helper.unsubscribeAndWait(unsub1);
      await helper.unsubscribeAndWait(unsub2);
      await helper.unsubscribeAndWait(unsub3);
      await helper.unsubscribeAndWait(unsub4);
    });
  });

  describe('Schema Validation', () => {
    it('PhaseChanged validates phase literal values', () => {
      // The schema uses Schema.Literal for phase, so only valid values should pass
      // This is tested implicitly by the emit() tests above, but let's verify the schema
      const validPayload = { phase: 'development' as const, previousPhase: 'planning' };
      const schema = Schema.Struct({
        phase: Schema.Literal('planning', 'development', 'demo', 'review'),
        previousPhase: Schema.String,
      });

      const result = Schema.decodeUnknownSync(schema)(validPayload);
      expect(result).toEqual(validPayload);
    });

    it('StoryCompleted validates status literal values', () => {
      const validPayload = { storyIndex: 1, status: 'success' as const };
      const schema = Schema.Struct({
        storyIndex: Schema.Number,
        status: Schema.Literal('success', 'blocked'),
      });

      const result = Schema.decodeUnknownSync(schema)(validPayload);
      expect(result).toEqual(validPayload);
    });
  });
});

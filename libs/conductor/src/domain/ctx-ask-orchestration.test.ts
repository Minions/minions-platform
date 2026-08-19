import { describe, it, expect } from 'vitest';
import {
  defineMission,
  runMission,
  createTestContext,
  type Mission,
} from './MissionEffect';
import type { AskOptions } from './MissionEffect';
import { EventBus, type IEventBus } from '@minions/events';
import { MissionEvents } from './MissionEvents';

/**
 * Helper function to track QuestionAsked and QuestionAnswered events
 * Reduces duplication of event listener setup across tests
 *
 * @param eventBus - The event bus to attach listeners to
 * @param combined - If true, events are combined into a single array with type tags
 * @returns Object with event arrays (askedEvents/answeredEvents or emittedEvents)
 */
function createQuestionEventTracker(eventBus: IEventBus, combined: true): { emittedEvents: unknown[] };
function createQuestionEventTracker(eventBus: IEventBus, combined?: false): { askedEvents: unknown[]; answeredEvents: unknown[] };
function createQuestionEventTracker(eventBus: IEventBus, combined = false): { emittedEvents: unknown[] } | { askedEvents: unknown[]; answeredEvents: unknown[] } {
  if (combined) {
    const emittedEvents: unknown[] = [];

    eventBus.on(MissionEvents.QuestionAsked, (event) => {
      emittedEvents.push({ type: 'QuestionAsked', ...event });
    });

    eventBus.on(MissionEvents.QuestionAnswered, (event) => {
      emittedEvents.push({ type: 'QuestionAnswered', ...event });
    });

    return { emittedEvents };
  }

  const askedEvents: unknown[] = [];
  const answeredEvents: unknown[] = [];

  eventBus.on(MissionEvents.QuestionAsked, (event) => {
    askedEvents.push(event);
  });

  eventBus.on(MissionEvents.QuestionAnswered, (event) => {
    answeredEvents.push(event);
  });

  return { askedEvents, answeredEvents };
}

/**
 * Integration tests demonstrating ctx.ask() in orchestration scenarios
 *
 * These tests prove that ctx.ask() enables human decision points during
 * complex multi-phase workflows, as required by the orchestrate mission.
 */
describe('ctx.ask() in Orchestration Scenarios', () => {
  describe('Mini-Orchestrator: Planning Phase Decision Point', () => {
    it('suspends mission at decision point and resumes with human input', async () => {
      const executionLog: string[] = [];
      const eventBus = new EventBus();
      const { emittedEvents } = createQuestionEventTracker(eventBus, true);

      const testContext = createTestContext({
        events: eventBus,
        askHuman: async (_options: AskOptions) => {
          executionLog.push('human asked');
          return 'Approve plan as-is';
        },
        emitEvent: (type: string, _data?: Record<string, unknown>) => {
          executionLog.push(`event:${type}`);
        },
      });

      // Mini-orchestrator mission that simulates a planning phase
      const miniOrchestrator: Mission<void> = defineMission(function* (ctx) {
        executionLog.push('phase:planning started');
        yield* ctx.emit('orchestration:phase', { phase: 'planning' });

        // Simulate planning work
        executionLog.push('planning:iteration 1');
        executionLog.push('planning:iteration 2');
        executionLog.push('planning:iteration 3');

        // Planning failed to converge - ask human
        const planValid = false;
        executionLog.push(`planning:valid=${planValid}`);

        if (!planValid) {
          executionLog.push('planning:asking human');

          const answer = yield* ctx.ask({
            question: 'Planning failed after 3 attempts. What should we do?',
            content: { type: 'markdown', content: 'The slice-planner and implementation-critic could not converge.' },
            options: [{ value: 'Approve plan as-is', label: 'Approve plan as-is' }, { value: 'Simplify scope', label: 'Simplify scope' }, { value: 'Provide guidance', label: 'Provide guidance' }],
            optionsMode: 'exclusive',
          });

          executionLog.push(`planning:answer received=${answer}`);

          // Act on the answer
          if (answer === 'Approve plan as-is') {
            yield* ctx.emit('orchestration:decision', {
              decision: 'approve',
              reason: 'human-override',
            });
            executionLog.push('decision:approve plan');
          } else if (answer === 'Simplify scope') {
            yield* ctx.emit('orchestration:decision', {
              decision: 'simplify',
              reason: 'human-override',
            });
            executionLog.push('decision:simplify scope');
          } else {
            yield* ctx.emit('orchestration:decision', {
              decision: 'guidance',
              reason: 'human-override',
            });
            executionLog.push('decision:provide guidance');
          }
        }

        executionLog.push('phase:planning completed');
        yield* ctx.emit('orchestration:phase', { phase: 'planning-completed' });
      });

      await runMission(miniOrchestrator, testContext);

      // Verify execution order
      expect(executionLog).toEqual([
        'phase:planning started',
        'event:orchestration:phase',
        'planning:iteration 1',
        'planning:iteration 2',
        'planning:iteration 3',
        'planning:valid=false',
        'planning:asking human',
        'human asked',
        'planning:answer received=Approve plan as-is',
        'event:orchestration:decision',
        'decision:approve plan',
        'phase:planning completed',
        'event:orchestration:phase',
      ]);

      // Verify question events were emitted
      expect(emittedEvents).toHaveLength(2);

      const questionAskedEvent = emittedEvents[0] as {
        type: string;
        questionId: string;
        question: string;
        content?: { type: string; content: string };
        options?: { value: string; label: string }[];
        optionsMode?: string;
      };

      expect(questionAskedEvent.type).toBe('QuestionAsked');
      expect(questionAskedEvent.question).toBe(
        'Planning failed after 3 attempts. What should we do?'
      );
      expect(questionAskedEvent.content).toEqual({
        type: 'markdown',
        content: 'The slice-planner and implementation-critic could not converge.',
      });
      expect(questionAskedEvent.options).toEqual([
        { value: 'Approve plan as-is', label: 'Approve plan as-is' },
        { value: 'Simplify scope', label: 'Simplify scope' },
        { value: 'Provide guidance', label: 'Provide guidance' },
      ]);
      expect(questionAskedEvent.optionsMode).toBe('exclusive');
      expect(questionAskedEvent.questionId).toBeDefined();

      const questionAnsweredEvent = emittedEvents[1] as {
        type: string;
        questionId: string;
        answer: string;
      };

      expect(questionAnsweredEvent.type).toBe('QuestionAnswered');
      expect(questionAnsweredEvent.answer).toBe('Approve plan as-is');
      expect(questionAnsweredEvent.questionId).toBe(questionAskedEvent.questionId);
    });

    it('handles different human decisions in orchestration flow', async () => {
      const eventBus = new EventBus();

      // Test "Simplify scope" decision
      const testContextSimplify = createTestContext({
        events: eventBus,
        askHuman: async () => 'Simplify scope',
      });

      let decisionTaken = '';

      const orchestratorSimplify: Mission<void> = defineMission(function* (ctx) {
        const answer = yield* ctx.ask({
          question: 'Planning failed. What should we do?',
          content: { type: 'markdown', content: '' },
          options: [{ value: 'Approve plan as-is', label: 'Approve plan as-is' }, { value: 'Simplify scope', label: 'Simplify scope' }, { value: 'Provide guidance', label: 'Provide guidance' }],
          optionsMode: 'exclusive',
        });

        if (answer === 'Approve plan as-is') {
          decisionTaken = 'approved';
        } else if (answer === 'Simplify scope') {
          decisionTaken = 'simplified';
        } else {
          decisionTaken = 'guidance';
        }
      });

      await runMission(orchestratorSimplify, testContextSimplify);
      expect(decisionTaken).toBe('simplified');
    });
  });

  describe('Mini-Orchestrator: Development Phase with Story Blocker', () => {
    it('asks human when story is blocked during development', async () => {
      const executionLog: string[] = [];
      const eventBus = new EventBus();

      const testContext = createTestContext({
        events: eventBus,
        askHuman: async (options: AskOptions) => {
          if (options.question.includes('blocked')) {
            return 'Skip story';
          }
          return 'Continue';
        },
        emitEvent: (type: string, _data?: Record<string, unknown>) => {
          executionLog.push(`event:${type}`);
        },
      });

      const miniOrchestrator: Mission<void> = defineMission(function* (ctx) {
        executionLog.push('phase:development started');
        yield* ctx.emit('orchestration:phase', { phase: 'development' });

        // Simulate story execution
        for (let storyIndex = 1; storyIndex <= 3; storyIndex++) {
          executionLog.push(`story:${storyIndex} started`);
          yield* ctx.emit('story:started', { index: storyIndex });

          // Story 2 encounters a blocker
          if (storyIndex === 2) {
            executionLog.push(`story:${storyIndex} blocked`);

            const answer = yield* ctx.ask({
              question: `Story ${storyIndex} is blocked due to missing dependency. What should we do?`,
              content: { type: 'markdown', content: 'Required API endpoint does not exist yet.' },
              options: [{ value: 'Skip story', label: 'Skip story' }, { value: 'Add blocker to notes', label: 'Add blocker to notes' }, { value: 'Abort slice', label: 'Abort slice' }],
              optionsMode: 'exclusive',
            });

            executionLog.push(`story:${storyIndex} decision=${answer}`);

            if (answer === 'Skip story') {
              yield* ctx.emit('story:skipped', { index: storyIndex });
              executionLog.push(`story:${storyIndex} skipped`);
              continue;
            } else if (answer === 'Abort slice') {
              yield* ctx.emit('slice:aborted', { reason: 'story-blocked' });
              executionLog.push('slice aborted');
              break;
            }
          }

          executionLog.push(`story:${storyIndex} completed`);
          yield* ctx.emit('story:completed', { index: storyIndex });
        }

        executionLog.push('phase:development completed');
        yield* ctx.emit('orchestration:phase', { phase: 'development-completed' });
      });

      await runMission(miniOrchestrator, testContext);

      // Verify story 2 was skipped and story 3 continued
      expect(executionLog).toContain('story:2 blocked');
      expect(executionLog).toContain('story:2 decision=Skip story');
      expect(executionLog).toContain('story:2 skipped');
      expect(executionLog).toContain('story:3 started');
      expect(executionLog).toContain('story:3 completed');
      expect(executionLog).toContain('phase:development completed');
    });
  });

  describe('Mini-Orchestrator: Post-Demo Approval', () => {
    it('asks human for approval before proceeding to next slice', async () => {
      const executionLog: string[] = [];
      const eventBus = new EventBus();
      const { askedEvents, answeredEvents } = createQuestionEventTracker(eventBus);

      const testContext = createTestContext({
        events: eventBus,
        askHuman: async (options: AskOptions) => {
          if (options.question.toLowerCase().includes('demo')) {
            return 'Approved - proceed';
          }
          return 'Continue';
        },
        emitEvent: (type: string, _data?: Record<string, unknown>) => {
          executionLog.push(`event:${type}`);
        },
      });

      const miniOrchestrator: Mission<void> = defineMission(function* (ctx) {
        executionLog.push('phase:demo preparation');
        yield* ctx.emit('orchestration:phase', { phase: 'demo-preparation' });

        // Simulate demo preparation
        executionLog.push('demo:collecting artifacts');
        executionLog.push('demo:generating summary');

        // Ask for demo approval
        executionLog.push('demo:asking for approval');

        const approval = yield* ctx.ask({
          question: 'Demo complete. Approve to proceed to next slice?',
          content: { type: 'markdown', content: 'All stories completed. Tests passing. Ready to merge.' },
          options: [{ value: 'Approved - proceed', label: 'Approved - proceed' }, { value: 'Request changes', label: 'Request changes' }, { value: 'End session', label: 'End session' }],
          optionsMode: 'exclusive',
        });

        executionLog.push(`demo:approval=${approval}`);

        if (approval === 'Approved - proceed') {
          yield* ctx.emit('orchestration:decision', {
            decision: 'proceed',
            reason: 'demo-approved',
          });
          executionLog.push('decision:proceed to next slice');
        } else if (approval === 'Request changes') {
          yield* ctx.emit('orchestration:decision', {
            decision: 'revise',
            reason: 'demo-changes-requested',
          });
          executionLog.push('decision:request changes');
        } else {
          yield* ctx.emit('orchestration:decision', {
            decision: 'end',
            reason: 'demo-end-session',
          });
          executionLog.push('decision:end session');
        }

        executionLog.push('phase:demo completed');
        yield* ctx.emit('orchestration:phase', { phase: 'demo-completed' });
      });

      await runMission(miniOrchestrator, testContext);

      // Verify execution flow
      expect(executionLog).toContain('demo:asking for approval');
      expect(executionLog).toContain('demo:approval=Approved - proceed');
      expect(executionLog).toContain('decision:proceed to next slice');
      expect(executionLog).toContain('phase:demo completed');

      // Verify events were emitted
      expect(askedEvents).toHaveLength(1);
      expect(answeredEvents).toHaveLength(1);

      const askedEvent = askedEvents[0] as {
        questionId: string;
        question: string;
        content?: { type: string; content: string };
        options?: { value: string; label: string }[];
        optionsMode?: string;
      };

      expect(askedEvent.question).toBe('Demo complete. Approve to proceed to next slice?');
      expect(askedEvent.content).toEqual({ type: 'markdown', content: 'All stories completed. Tests passing. Ready to merge.' });
      expect(askedEvent.options).toEqual([
        { value: 'Approved - proceed', label: 'Approved - proceed' },
        { value: 'Request changes', label: 'Request changes' },
        { value: 'End session', label: 'End session' },
      ]);

      const answeredEvent = answeredEvents[0] as {
        questionId: string;
        answer: string;
      };

      expect(answeredEvent.answer).toBe('Approved - proceed');
      expect(answeredEvent.questionId).toBe(askedEvent.questionId);
    });
  });

  describe('Mini-Orchestrator: Multi-Phase with Multiple Decision Points', () => {
    it('handles multiple questions across different phases', async () => {
      const executionLog: string[] = [];
      const eventBus = new EventBus();
      const questions: string[] = [];

      const testContext = createTestContext({
        events: eventBus,
        askHuman: async (options: AskOptions) => {
          questions.push(options.question);

          // Answer based on question content
          if (options.question.includes('Planning failed')) {
            return 'Approve plan as-is';
          } else if (options.question.includes('blocked')) {
            return 'Skip story';
          } else if (options.question.toLowerCase().includes('demo')) {
            return 'Approved - proceed';
          }
          return 'Continue';
        },
        emitEvent: (type: string) => {
          executionLog.push(`event:${type}`);
        },
      });

      const multiPhaseOrchestrator: Mission<void> = defineMission(function* (ctx) {
        // Phase 1: Planning
        executionLog.push('phase:planning');
        yield* ctx.emit('phase', { name: 'planning' });

        const planningDecision = yield* ctx.ask({
          question: 'Planning failed after 3 attempts. What should we do?',
          content: { type: 'markdown', content: '' },
          options: [{ value: 'Approve plan as-is', label: 'Approve plan as-is' }, { value: 'Simplify scope', label: 'Simplify scope' }],
          optionsMode: 'exclusive',
        });
        executionLog.push(`planning:${planningDecision}`);

        // Phase 2: Development
        executionLog.push('phase:development');
        yield* ctx.emit('phase', { name: 'development' });

        const storyDecision = yield* ctx.ask({
          question: 'Story 2 is blocked. What should we do?',
          content: { type: 'markdown', content: '' },
          options: [{ value: 'Skip story', label: 'Skip story' }, { value: 'Abort', label: 'Abort' }],
          optionsMode: 'exclusive',
        });
        executionLog.push(`development:${storyDecision}`);

        // Phase 3: Demo
        executionLog.push('phase:demo');
        yield* ctx.emit('phase', { name: 'demo' });

        const demoDecision = yield* ctx.ask({
          question: 'Demo complete. Approve to proceed?',
          content: { type: 'markdown', content: '' },
          options: [{ value: 'Approved - proceed', label: 'Approved - proceed' }, { value: 'Request changes', label: 'Request changes' }],
          optionsMode: 'exclusive',
        });
        executionLog.push(`demo:${demoDecision}`);

        executionLog.push('orchestration:complete');
      });

      await runMission(multiPhaseOrchestrator, testContext);

      // Verify all three questions were asked
      expect(questions).toHaveLength(3);
      expect(questions[0]).toContain('Planning failed');
      expect(questions[1]).toContain('blocked');
      expect(questions[2]).toContain('Demo complete');

      // Verify all phases executed
      expect(executionLog).toContain('phase:planning');
      expect(executionLog).toContain('phase:development');
      expect(executionLog).toContain('phase:demo');
      expect(executionLog).toContain('orchestration:complete');

      // Verify decisions were made
      expect(executionLog).toContain('planning:Approve plan as-is');
      expect(executionLog).toContain('development:Skip story');
      expect(executionLog).toContain('demo:Approved - proceed');
    });
  });

  describe('Mission State Preservation During Suspension', () => {
    it('preserves mission state across ctx.ask() suspension', async () => {
      const eventBus = new EventBus();
      const resolveQuestionRef: { current: ((answer: string) => void) | null } = { current: null };

      const testContext = createTestContext({
        events: eventBus,
        askHuman: async () => {
          return new Promise<string>((resolve) => {
            resolveQuestionRef.current = resolve;
          });
        },
      });

      let stateBeforeAsk: { storyIndex: number; artifactsCollected: string[] } | null = null;
      let stateAfterAsk: { storyIndex: number; artifactsCollected: string[] } | null = null;

      const orchestrator: Mission<void> = defineMission(function* (ctx) {
        // Build up state during orchestration
        const missionState = {
          storyIndex: 2,
          artifactsCollected: ['plan.md', 'story-1-output.txt'],
        };

        stateBeforeAsk = {
          storyIndex: missionState.storyIndex,
          artifactsCollected: [...missionState.artifactsCollected],
        };

        // Mission suspends here waiting for answer
        const answer = yield* ctx.ask({
          question: 'Story 2 blocked. What should we do?',
          content: { type: 'markdown', content: '' },
          options: [],
          optionsMode: 'exclusive',
        });

        // Verify state is still accessible after suspension
        stateAfterAsk = {
          storyIndex: missionState.storyIndex,
          artifactsCollected: [...missionState.artifactsCollected],
        };

        // Act on answer using preserved state
        if (answer === 'Skip story') {
          missionState.storyIndex = 3;
          missionState.artifactsCollected.push('story-2-skipped.txt');
        }

        yield* ctx.emit('state-preserved', {
          index: missionState.storyIndex,
          artifacts: missionState.artifactsCollected,
        });
      });

      const missionPromise = runMission(orchestrator, testContext);

      // Give mission time to suspend
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(stateBeforeAsk).toEqual({
        storyIndex: 2,
        artifactsCollected: ['plan.md', 'story-1-output.txt'],
      });
      expect(stateAfterAsk).toBeNull(); // Mission is suspended

      // Resume mission with answer
      if (!resolveQuestionRef.current) throw new Error('expected resolveQuestion to be set');
      resolveQuestionRef.current('Skip story');
      await missionPromise;

      // Verify state was preserved and used after resumption
      expect(stateAfterAsk).toEqual({
        storyIndex: 2,
        artifactsCollected: ['plan.md', 'story-1-output.txt'],
      });
    });
  });
});

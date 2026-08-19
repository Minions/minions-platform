import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import {
  defineMission,
  runMission,
  createTestContext,
  type Mission,
  AskError,
} from './MissionEffect';
import type { AskOptions } from './MissionContext';
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
 * Tests demonstrating the ctx.ask() API
 *
 * These tests showcase how missions ask humans questions and handle responses.
 */
describe('ctx.ask() API', () => {
  describe('Basic Question Flow', () => {
    it('asks a simple question and receives an answer', async () => {
      const testContext = createTestContext({
        askHuman: async (_options: AskOptions) => 'Yes',
      });

      let receivedAnswer: string | null = null;

      const mission: Mission<void> = defineMission(function* (ctx) {
        receivedAnswer = yield* ctx.ask({
          question: 'Should we proceed?',
          content: { type: 'markdown', content: '' },
          options: [],
          optionsMode: 'exclusive',
        });
      });

      await runMission(mission, testContext);

      expect(receivedAnswer).toBe('Yes');
    });

    it('passes question options to the ask function', async () => {
      let capturedOptions: AskOptions | null = null;

      const testContext = createTestContext({
        askHuman: async (options: AskOptions) => {
          capturedOptions = options;
          return 'Answer';
        },
      });

      const mission: Mission<void> = defineMission(function* (ctx) {
        yield* ctx.ask({
          question: 'Which approach?',
          content: { type: 'markdown', content: 'We have 3 options available' },
          options: [
            { value: 'Option A', label: 'Option A' },
            { value: 'Option B', label: 'Option B' },
            { value: 'Option C', label: 'Option C' },
          ],
          optionsMode: 'exclusive',
        });
      });

      await runMission(mission, testContext);

      expect(capturedOptions).toEqual({
        question: 'Which approach?',
        content: { type: 'markdown', content: 'We have 3 options available' },
        options: [
          { value: 'Option A', label: 'Option A' },
          { value: 'Option B', label: 'Option B' },
          { value: 'Option C', label: 'Option C' },
        ],
        optionsMode: 'exclusive',
      });
    });

    it('allows mission logic to branch on answer', async () => {
      const testContext = createTestContext({
        askHuman: async (options: AskOptions) => {
          if (options.question.includes('delete')) {
            return 'cancel';
          }
          return 'proceed';
        },
      });

      let actionTaken: string | null = null;

      const mission: Mission<void> = defineMission(function* (ctx) {
        const answer = yield* ctx.ask({
          question: 'This will delete all data. Confirm?',
          content: { type: 'markdown', content: '' },
          options: [],
          optionsMode: 'exclusive',
        });

        if (answer === 'cancel') {
          actionTaken = 'cancelled';
        } else {
          actionTaken = 'proceeded';
        }
      });

      await runMission(mission, testContext);

      expect(actionTaken).toBe('cancelled');
    });
  });

  describe('Error Handling', () => {
    it('fails with AskError when ask function throws', async () => {
      const testContext = createTestContext({
        askHuman: async () => {
          throw new Error('Question timeout');
        },
      });

      const caughtErrorRef: { current: AskError | null } = { current: null };

      const mission: Mission<void> = defineMission(function* (ctx) {
        const result = yield* Effect.either(
          ctx.ask({ question: 'Continue?', content: { type: 'markdown', content: '' }, options: [], optionsMode: 'exclusive' })
        );

        if (result._tag === 'Left') {
          caughtErrorRef.current = result.left as AskError;
        }
      });

      await runMission(mission, testContext);

      expect(caughtErrorRef.current).toBeInstanceOf(AskError);
      if (!caughtErrorRef.current) throw new Error('expected caughtError to be set');
      expect(caughtErrorRef.current.question).toBe('Continue?');
      expect(caughtErrorRef.current.reason).toBe('Question timeout');
    });

    it('fails with AskError when no ask function provided', async () => {
      const testContext = createTestContext({});

      const caughtErrorRef: { current: AskError | null } = { current: null };

      const mission: Mission<void> = defineMission(function* (ctx) {
        const result = yield* Effect.either(
          ctx.ask({ question: 'Test?', content: { type: 'markdown', content: '' }, options: [], optionsMode: 'exclusive' })
        );

        if (result._tag === 'Left') {
          caughtErrorRef.current = result.left as AskError;
        }
      });

      await runMission(mission, testContext);

      expect(caughtErrorRef.current).toBeInstanceOf(AskError);
      if (!caughtErrorRef.current) throw new Error('expected caughtError to be set');
      expect(caughtErrorRef.current.question).toBe('Test?');
      expect(caughtErrorRef.current.reason).toBe('No ask function provided in test context');
    });

    it('allows mission to handle ask errors gracefully', async () => {
      const testContext = createTestContext({
        askHuman: async () => {
          throw new Error('User cancelled');
        },
      });

      let fallbackAction: string | null = null;

      const mission: Mission<void> = defineMission(function* (ctx) {
        const result = yield* Effect.either(
          ctx.ask({ question: 'Approve?', content: { type: 'markdown', content: '' }, options: [], optionsMode: 'exclusive' })
        );

        if (result._tag === 'Left') {
          // Handle error by taking default action
          fallbackAction = 'used default behavior';
        } else {
          fallbackAction = `processed answer: ${result.right}`;
        }
      });

      await runMission(mission, testContext);

      expect(fallbackAction).toBe('used default behavior');
    });
  });

  describe('Multiple Questions', () => {
    it('asks multiple questions in sequence', async () => {
      const answers = ['Alice', 'San Francisco', 'Engineer'];
      let answerIndex = 0;

      const testContext = createTestContext({
        askHuman: async () => answers[answerIndex++],
      });

      let profile: { name: string; city: string; role: string } | null = null;

      const mission: Mission<void> = defineMission(function* (ctx) {
        const name = yield* ctx.ask({ question: 'What is your name?', content: { type: 'markdown', content: '' }, options: [], optionsMode: 'exclusive' });
        const city = yield* ctx.ask({ question: 'What city do you live in?', content: { type: 'markdown', content: '' }, options: [], optionsMode: 'exclusive' });
        const role = yield* ctx.ask({ question: 'What is your role?', content: { type: 'markdown', content: '' }, options: [], optionsMode: 'exclusive' });

        profile = { name, city, role };
      });

      await runMission(mission, testContext);

      expect(profile).toEqual({
        name: 'Alice',
        city: 'San Francisco',
        role: 'Engineer',
      });
    });

    it('asks conditional questions based on previous answers', async () => {
      const testContext = createTestContext({
        askHuman: async (options: AskOptions) => {
          if (options.question.includes('deploy')) {
            return 'staging';
          }
          if (options.question.includes('run tests')) {
            return 'yes';
          }
          return 'no';
        },
      });

      const actions: string[] = [];

      const mission: Mission<void> = defineMission(function* (ctx) {
        const environment = yield* ctx.ask({
          question: 'Which environment to deploy?',
          content: { type: 'markdown', content: '' },
          options: [{ value: 'production', label: 'production' }, { value: 'staging', label: 'staging' }, { value: 'development', label: 'development' }],
          optionsMode: 'exclusive',
        });

        actions.push(`deploy to ${environment}`);

        if (environment === 'production') {
          const runTests = yield* ctx.ask({
            question: 'Run tests before deployment?',
            content: { type: 'markdown', content: '' },
            options: [],
            optionsMode: 'exclusive',
          });

          if (runTests === 'yes') {
            actions.push('run tests');
          }
        }
      });

      await runMission(mission, testContext);

      expect(actions).toEqual(['deploy to staging']);
    });
  });

  describe('Real-World Scenarios', () => {
    it('demonstrates approval workflow', async () => {
      const testContext = createTestContext({
        askHuman: async (options: AskOptions) => {
          // Simulate reviewer approving with comments
          if (options.question.includes('Approve')) {
            return 'Approved - looks good';
          }
          return 'No';
        },
      });

      let workflowStatus: string | null = null;

      const mission: Mission<void> = defineMission(function* (ctx) {
        yield* ctx.emit('progress', { message: 'Requesting approval' });

        const approval = yield* ctx.ask({
          question: 'Approve this pull request?',
          content: { type: 'markdown', content: 'Changes: Added new feature\nTests: All passing' },
          options: [{ value: 'Approved', label: 'Approved' }, { value: 'Request changes', label: 'Request changes' }, { value: 'Comment', label: 'Comment' }],
          optionsMode: 'exclusive',
        });

        if (approval.toLowerCase().includes('approved')) {
          yield* ctx.emit('progress', { message: 'Merging changes' });
          workflowStatus = 'merged';
        } else {
          yield* ctx.emit('progress', { message: 'Waiting for revisions' });
          workflowStatus = 'pending';
        }
      });

      await runMission(mission, testContext);

      expect(workflowStatus).toBe('merged');
    });

    it('demonstrates configuration wizard', async () => {
      const answers = ['MyApp', '8080', 'postgres', 'yes'];
      let answerIndex = 0;

      const testContext = createTestContext({
        askHuman: async () => answers[answerIndex++],
      });

      let config: Record<string, unknown> | null = null;

      const mission: Mission<void> = defineMission(function* (ctx) {
        yield* ctx.emit('progress', { message: 'Starting configuration wizard' });

        const appName = yield* ctx.ask({
          question: 'Application name?',
          content: { type: 'markdown', content: '' },
          options: [],
          optionsMode: 'exclusive',
        });

        const port = yield* ctx.ask({
          question: 'Port number?',
          content: { type: 'markdown', content: '' },
          options: [],
          optionsMode: 'exclusive',
        });

        const database = yield* ctx.ask({
          question: 'Database type?',
          content: { type: 'markdown', content: '' },
          options: [{ value: 'postgres', label: 'postgres' }, { value: 'mysql', label: 'mysql' }, { value: 'sqlite', label: 'sqlite' }],
          optionsMode: 'exclusive',
        });

        const enableCache = yield* ctx.ask({
          question: 'Enable caching?',
          content: { type: 'markdown', content: '' },
          options: [{ value: 'yes', label: 'yes' }, { value: 'no', label: 'no' }],
          optionsMode: 'exclusive',
        });

        config = {
          appName,
          port: parseInt(port),
          database,
          enableCache: enableCache === 'yes',
        };

        yield* ctx.emit('completed', { summary: 'Configuration complete' });
      });

      await runMission(mission, testContext);

      expect(config).toEqual({
        appName: 'MyApp',
        port: 8080,
        database: 'postgres',
        enableCache: true,
      });
    });

    it('demonstrates retry logic with confirmation', async () => {
      const testContext = createTestContext({
        askHuman: async (options: AskOptions) => {
          // First failure asks if retry, user says yes
          // Second failure asks if retry, user says no
          if (options.question.includes('Attempt 1')) {
            return 'yes';
          }
          if (options.question.includes('Attempt 2')) {
            return 'no';
          }
          return 'no';
        },
      });

      const attemptResults: string[] = [];

      const mission: Mission<void> = defineMission(function* (ctx) {
        for (let i = 1; i <= 3; i++) {
          attemptResults.push(`attempt ${i}`);

          // Simulate work that fails on attempts 1 and 2
          const failed = i <= 2;

          if (failed) {
            const retry = yield* ctx.ask({
              question: `Attempt ${i} failed. Retry?`,
              content: { type: 'markdown', content: '' },
              options: [],
              optionsMode: 'exclusive',
            });

            if (retry !== 'yes') {
              attemptResults.push('user cancelled');
              break;
            }
          } else {
            attemptResults.push('success');
            break;
          }
        }
      });

      await runMission(mission, testContext);

      expect(attemptResults).toEqual(['attempt 1', 'attempt 2', 'user cancelled']);
    });
  });

  describe('Integration with Other Context Methods', () => {
    it('combines ctx.ask() with ctx.emit() for progress tracking', async () => {
      const emittedEvents: Array<{ type: string; data?: Record<string, unknown> }> = [];

      const testContext = createTestContext({
        askHuman: async () => 'Option B',
        emitEvent: (type: string, data?: Record<string, unknown>) =>
          emittedEvents.push({ type, data }),
      });

      const mission: Mission<void> = defineMission(function* (ctx) {
        yield* ctx.emit('progress', { message: 'Asking user for input' });

        const choice = yield* ctx.ask({
          question: 'Select option',
          content: { type: 'markdown', content: '' },
          options: [{ value: 'Option A', label: 'Option A' }, { value: 'Option B', label: 'Option B' }],
          optionsMode: 'exclusive',
        });

        yield* ctx.emit('progress', { message: `User selected: ${choice}` });
        yield* ctx.emit('completed', { summary: `Processed ${choice}` });
      });

      await runMission(mission, testContext);

      expect(emittedEvents).toHaveLength(3);
      expect(emittedEvents[0]).toEqual({
        type: 'progress',
        data: { message: 'Asking user for input' },
      });
      expect(emittedEvents[1]).toEqual({
        type: 'progress',
        data: { message: 'User selected: Option B' },
      });
      expect(emittedEvents[2]).toEqual({
        type: 'completed',
        data: { summary: 'Processed Option B' },
      });
    });

    it('uses ctx.ask() with ctx.checkCancelled() for interruptible workflows', async () => {
      let checkCount = 0;
      const testContext = createTestContext({
        askHuman: async () => 'continue',
        isCancelled: () => {
          checkCount++;
          return checkCount > 2; // Cancel after 2 checks
        },
      });

      let questionsAsked = 0;

      const mission: Mission<void> = defineMission(function* (ctx) {
        while (true) {
          const cancelled = yield* ctx.checkCancelled();
          if (cancelled) {
            break;
          }

          yield* ctx.ask({ question: 'Next step?', content: { type: 'markdown', content: '' }, options: [], optionsMode: 'exclusive' });
          questionsAsked++;
        }
      });

      await runMission(mission, testContext);

      expect(questionsAsked).toBe(2);
    });
  });

  describe('Suspension and Resumption', () => {
    it('suspends mission execution until answer arrives', async () => {
      const executionOrder: string[] = [];
      const resolveQuestionRef: { current: ((answer: string) => void) | null } = { current: null };

      const testContext = createTestContext({
        askHuman: async (_options: AskOptions) => {
          executionOrder.push('question asked');
          return new Promise<string>((resolve) => {
            resolveQuestionRef.current = resolve;
          });
        },
      });

      const mission: Mission<void> = defineMission(function* (ctx) {
        executionOrder.push('mission started');

        const answerPromise = ctx.ask({ question: 'Should we proceed?', content: { type: 'markdown', content: '' }, options: [], optionsMode: 'exclusive' });
        executionOrder.push('ask effect created');

        const answer = yield* answerPromise;
        executionOrder.push(`answer received: ${answer}`);
      });

      const missionPromise = runMission(mission, testContext);

      // Give mission time to start and suspend
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(executionOrder).toEqual([
        'mission started',
        'ask effect created',
        'question asked',
      ]);

      // Now provide the answer to resume mission
      if (!resolveQuestionRef.current) throw new Error('expected resolveQuestion to be set');
      resolveQuestionRef.current('Yes');

      await missionPromise;

      expect(executionOrder).toEqual([
        'mission started',
        'ask effect created',
        'question asked',
        'answer received: Yes',
      ]);
    });

    it('preserves mission state while suspended', async () => {
      const resolveQuestionRef: { current: ((answer: string) => void) | null } = { current: null };

      const testContext = createTestContext({
        askHuman: async () => {
          return new Promise<string>((resolve) => {
            resolveQuestionRef.current = resolve;
          });
        },
      });

      let stateBeforeAsk: string | null = null;
      let stateAfterAsk: string | null = null;

      const mission: Mission<void> = defineMission(function* (ctx) {
        const missionState = 'important-state-data';
        stateBeforeAsk = missionState;

        const answer = yield* ctx.ask({ question: 'Continue?', content: { type: 'markdown', content: '' }, options: [], optionsMode: 'exclusive' });

        // Verify state is still accessible after suspension
        stateAfterAsk = missionState;
        expect(answer).toBe('proceed');
      });

      const missionPromise = runMission(mission, testContext);

      // Give mission time to suspend
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(stateBeforeAsk).toBe('important-state-data');
      expect(stateAfterAsk).toBeNull(); // Not yet resumed

      // Resume mission
      if (!resolveQuestionRef.current) throw new Error('expected resolveQuestion to be set');
      resolveQuestionRef.current('proceed');
      await missionPromise;

      expect(stateAfterAsk).toBe('important-state-data');
    });

    it('allows other Effects to run while waiting for answer', async () => {
      const executionOrder: string[] = [];
      const resolveQuestionRef: { current: ((answer: string) => void) | null } = { current: null };

      const testContext = createTestContext({
        askHuman: async () => {
          executionOrder.push('question asked - suspending');
          return new Promise<string>((resolve) => {
            resolveQuestionRef.current = resolve;
          });
        },
      });

      const mission: Mission<void> = defineMission(function* (ctx) {
        executionOrder.push('start mission');

        // Start asking but don't wait for it yet
        const askEffect = ctx.ask({ question: 'What do you want?', content: { type: 'markdown', content: '' }, options: [], optionsMode: 'exclusive' });
        executionOrder.push('ask effect created');

        // Do other work while question is pending
        yield* ctx.emit('progress', { message: 'Doing other work' });
        executionOrder.push('emitted progress event');

        // Now wait for the answer
        const answer = yield* askEffect;
        executionOrder.push(`got answer: ${answer}`);
      });

      const missionPromise = runMission(mission, testContext);

      // Give mission time to start and suspend
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(executionOrder).toContain('emitted progress event');
      expect(executionOrder).not.toContain('got answer: response');

      // Resume mission
      if (!resolveQuestionRef.current) throw new Error('expected resolveQuestion to be set');
      resolveQuestionRef.current('response');
      await missionPromise;

      expect(executionOrder).toContain('got answer: response');
    });

    it('handles multiple sequential ctx.ask() calls', async () => {
      const resolvers: Array<(answer: string) => void> = [];
      const askedQuestions: string[] = [];

      const testContext = createTestContext({
        askHuman: async (options: AskOptions) => {
          askedQuestions.push(options.question);
          return new Promise<string>((resolve) => {
            resolvers.push(resolve);
          });
        },
      });

      const answers: Record<string, string> = {};

      const mission: Mission<void> = defineMission(function* (ctx) {
        // Ask questions sequentially (Effect.gen is sequential by default)
        const name = yield* ctx.ask({ question: 'What is your name?', content: { type: 'markdown', content: '' }, options: [], optionsMode: 'exclusive' });
        const age = yield* ctx.ask({ question: 'What is your age?', content: { type: 'markdown', content: '' }, options: [], optionsMode: 'exclusive' });

        answers.name = name;
        answers.age = age;
      });

      const missionPromise = runMission(mission, testContext);

      // Give mission time to ask first question
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(askedQuestions).toEqual(['What is your name?']);
      expect(resolvers).toHaveLength(1);

      // Answer first question
      resolvers[0]('Alice');

      // Give mission time to ask second question
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(askedQuestions).toEqual(['What is your name?', 'What is your age?']);
      expect(resolvers).toHaveLength(2);

      // Answer second question
      resolvers[1]('25');

      await missionPromise;

      expect(answers).toEqual({ name: 'Alice', age: '25' });
    });

    it('handles cancellation during suspension gracefully', async () => {
      let checkCancelledCount = 0;

      const testContext = createTestContext({
        askHuman: async () => {
          return new Promise<string>(() => {
            // Never resolve - testing cancellation path
          });
        },
        isCancelled: () => {
          checkCancelledCount++;
          return checkCancelledCount > 1; // Cancel after first check
        },
      });

      let missionCompleted = false;
      let questionAsked = false;

      const mission: Mission<void> = defineMission(function* (ctx) {
        // Check if cancelled before asking
        const cancelled1 = yield* ctx.checkCancelled();
        if (cancelled1) return;

        questionAsked = true;

        // Check if cancelled before waiting for answer
        const cancelled2 = yield* ctx.checkCancelled();
        if (cancelled2) {
          // Mission is cancelled, don't ask question
          return;
        }

        // If we get here, mission should ask question
        yield* ctx.ask({ question: 'Should we proceed?', content: { type: 'markdown', content: '' }, options: [], optionsMode: 'exclusive' });
        missionCompleted = true;
      });

      await runMission(mission, testContext);

      expect(questionAsked).toBe(true);
      expect(missionCompleted).toBe(false); // Should be cancelled before completion
      expect(checkCancelledCount).toBe(2); // Should have checked twice
    });

    it('can resume with answer value after suspension', async () => {
      const resolveQuestionRef: { current: ((answer: string) => void) | null } = { current: null };
      const receivedAnswers: string[] = [];

      const testContext = createTestContext({
        askHuman: async (_options: AskOptions) => {
          return new Promise<string>((resolve) => {
            resolveQuestionRef.current = resolve;
          });
        },
      });

      const mission: Mission<void> = defineMission(function* (ctx) {
        const answer = yield* ctx.ask({ question: 'What is your choice?', content: { type: 'markdown', content: '' }, options: [], optionsMode: 'exclusive' });
        receivedAnswers.push(answer);
      });

      const missionPromise = runMission(mission, testContext);

      // Give mission time to suspend
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(receivedAnswers).toHaveLength(0);

      // Provide answer with specific value
      if (!resolveQuestionRef.current) throw new Error('expected resolveQuestion to be set');
      resolveQuestionRef.current('Option A');

      await missionPromise;

      expect(receivedAnswers).toEqual(['Option A']);
    });
  });

  describe('Event Emission', () => {
    it('emits QuestionAsked event before asking with all options', async () => {
      const eventBus = new EventBus();
      const { askedEvents } = createQuestionEventTracker(eventBus);

      const testContext = createTestContext({
        events: eventBus,
        askHuman: async () => 'Answer',
      });

      const mission: Mission<void> = defineMission(function* (ctx) {
        yield* ctx.ask({
          question: 'Test question?',
          content: { type: 'markdown', content: 'Some context' },
          options: [{ value: 'A', label: 'A' }, { value: 'B', label: 'B' }, { value: 'C', label: 'C' }],
          optionsMode: 'exclusive',
        });
      });

      await runMission(mission, testContext);

      expect(askedEvents).toHaveLength(1);
      const event = askedEvents[0] as {
        question: string;
        content?: { type: string; content: string };
        options?: { value: string; label: string }[];
        optionsMode?: string;
        questionId: string;
      };
      expect(event.question).toBe('Test question?');
      expect(event.content).toEqual({ type: 'markdown', content: 'Some context' });
      expect(event.options).toEqual([{ value: 'A', label: 'A' }, { value: 'B', label: 'B' }, { value: 'C', label: 'C' }]);
      expect(event.optionsMode).toBe('exclusive');
      expect(event.questionId).toBeDefined();
      expect(typeof event.questionId).toBe('string');
    });

    it('emits QuestionAsked event with minimal options', async () => {
      const eventBus = new EventBus();
      const { askedEvents } = createQuestionEventTracker(eventBus);

      const testContext = createTestContext({
        events: eventBus,
        askHuman: async () => 'Answer',
      });

      const mission: Mission<void> = defineMission(function* (ctx) {
        yield* ctx.ask({
          question: 'Simple question?',
          content: { type: 'markdown', content: '' },
          options: [],
          optionsMode: 'exclusive',
        });
      });

      await runMission(mission, testContext);

      expect(askedEvents).toHaveLength(1);
      const event = askedEvents[0] as {
        question: string;
        content?: { type: string; content: string };
        options?: { value: string; label: string }[];
        optionsMode?: string;
        questionId: string;
      };
      expect(event.question).toBe('Simple question?');
      expect(event.content).toEqual({ type: 'markdown', content: '' });
      expect(event.questionId).toBeDefined();
    });

    it('emits QuestionAnswered event after receiving answer', async () => {
      const eventBus = new EventBus();
      const { answeredEvents } = createQuestionEventTracker(eventBus);

      const testContext = createTestContext({
        events: eventBus,
        askHuman: async () => 'User response',
      });

      const mission: Mission<void> = defineMission(function* (ctx) {
        yield* ctx.ask({
          question: 'Test question?',
          content: { type: 'markdown', content: '' },
          options: [],
          optionsMode: 'exclusive',
        });
      });

      await runMission(mission, testContext);

      expect(answeredEvents).toHaveLength(1);
      const event = answeredEvents[0] as {
        answer: string;
        questionId: string;
      };
      expect(event.answer).toBe('User response');
      expect(event.questionId).toBeDefined();
      expect(typeof event.questionId).toBe('string');
    });

    it('emits both QuestionAsked and QuestionAnswered with matching questionId', async () => {
      const eventBus = new EventBus();
      const { askedEvents, answeredEvents } = createQuestionEventTracker(eventBus);

      const testContext = createTestContext({
        events: eventBus,
        askHuman: async () => 'My answer',
      });

      const mission: Mission<void> = defineMission(function* (ctx) {
        yield* ctx.ask({
          question: 'What to do?',
          content: { type: 'markdown', content: 'Decide now' },
          options: [],
          optionsMode: 'exclusive',
        });
      });

      await runMission(mission, testContext);

      expect(askedEvents).toHaveLength(1);
      expect(answeredEvents).toHaveLength(1);

      const askedEvent = askedEvents[0] as {
        question: string;
        content?: { type: string; content: string };
        questionId: string;
      };
      const answeredEvent = answeredEvents[0] as {
        answer: string;
        questionId: string;
      };

      // QuestionIds should match
      expect(askedEvent.questionId).toBe(answeredEvent.questionId);

      // Verify payloads
      expect(askedEvent.question).toBe('What to do?');
      expect(askedEvent.content).toEqual({ type: 'markdown', content: 'Decide now' });
      expect(answeredEvent.answer).toBe('My answer');
    });

    it('emits events for multiple questions with different questionIds', async () => {
      const eventBus = new EventBus();
      const { askedEvents, answeredEvents } = createQuestionEventTracker(eventBus);

      const answers = ['First answer', 'Second answer'];
      let answerIndex = 0;

      const testContext = createTestContext({
        events: eventBus,
        askHuman: async () => answers[answerIndex++],
      });

      const mission: Mission<void> = defineMission(function* (ctx) {
        yield* ctx.ask({ question: 'First question?', content: { type: 'markdown', content: '' }, options: [], optionsMode: 'exclusive' });
        yield* ctx.ask({ question: 'Second question?', content: { type: 'markdown', content: '' }, options: [], optionsMode: 'exclusive' });
      });

      await runMission(mission, testContext);

      expect(askedEvents).toHaveLength(2);
      expect(answeredEvents).toHaveLength(2);

      const asked1 = askedEvents[0] as { question: string; questionId: string };
      const asked2 = askedEvents[1] as { question: string; questionId: string };
      const answered1 = answeredEvents[0] as { answer: string; questionId: string };
      const answered2 = answeredEvents[1] as { answer: string; questionId: string };

      // Each pair should have matching IDs
      expect(asked1.questionId).toBe(answered1.questionId);
      expect(asked2.questionId).toBe(answered2.questionId);

      // But the two questions should have different IDs
      expect(asked1.questionId).not.toBe(asked2.questionId);

      // Verify content
      expect(asked1.question).toBe('First question?');
      expect(asked2.question).toBe('Second question?');
      expect(answered1.answer).toBe('First answer');
      expect(answered2.answer).toBe('Second answer');
    });

    it('does not emit QuestionAnswered if ask fails', async () => {
      const eventBus = new EventBus();
      const { askedEvents, answeredEvents } = createQuestionEventTracker(eventBus);

      const testContext = createTestContext({
        events: eventBus,
        askHuman: async () => {
          throw new Error('Timeout');
        },
      });

      const mission: Mission<void> = defineMission(function* (ctx) {
        yield* Effect.either(ctx.ask({ question: 'Test?', content: { type: 'markdown', content: '' }, options: [], optionsMode: 'exclusive' }));
      });

      await runMission(mission, testContext);

      // QuestionAsked should be emitted, but not QuestionAnswered
      expect(askedEvents).toHaveLength(1);
      expect(answeredEvents).toHaveLength(0);
    });
  });
});

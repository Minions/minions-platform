import { describe, it, expect } from 'vitest';
import { createMockQuestionBridge } from './mockFactories';
import type { AskOptions } from '../domain/MissionContext';

// Minimal valid AskOptions for tests that don't care about content/options
const minAsk = (question: string): AskOptions => ({
  question,
  content: { type: 'markdown', content: '' },
  options: [],
  optionsMode: 'exclusive',
});

/**
 * Tests for createMockQuestionBridge test infrastructure
 *
 * These tests demonstrate how to use the enhanced mock question bridge
 * for testing deterministic missions with BrainlessMinion.
 */
describe('createMockQuestionBridge', () => {
  describe('Sequential Answers', () => {
    it('returns answers in sequence', async () => {
      const bridge = createMockQuestionBridge({ answers: ['First', 'Second', 'Third'] });

      const answer1 = await bridge.ask(minAsk('Question 1'), 'mission-1', 'wing-1');
      const answer2 = await bridge.ask(minAsk('Question 2'), 'mission-1', 'wing-1');
      const answer3 = await bridge.ask(minAsk('Question 3'), 'mission-1', 'wing-1');

      expect(answer1).toBe('First');
      expect(answer2).toBe('Second');
      expect(answer3).toBe('Third');
    });

    it('throws error when answers are exhausted by default', async () => {
      const bridge = createMockQuestionBridge({ answers: ['Only one'] });

      await bridge.ask(minAsk('Question 1'), 'mission-1', 'wing-1');

      await expect(
        bridge.ask(minAsk('Question 2'), 'mission-1', 'wing-1')
      ).rejects.toThrow('No more mock answers available');
    });

    it('returns empty string when throwOnExhaustion is false', async () => {
      const bridge = createMockQuestionBridge({
        answers: ['Only one'],
        throwOnExhaustion: false,
      });

      await bridge.ask(minAsk('Question 1'), 'mission-1', 'wing-1');
      const answer2 = await bridge.ask(minAsk('Question 2'), 'mission-1', 'wing-1');

      expect(answer2).toBe('');
    });

    it('handles empty answers array', async () => {
      const bridge = createMockQuestionBridge({ answers: [] });

      await expect(
        bridge.ask(minAsk('Question'), 'mission-1', 'wing-1')
      ).rejects.toThrow('No more mock answers available');
    });
  });

  describe('Answer Function', () => {
    it('computes answers based on question content', async () => {
      const bridge = createMockQuestionBridge({
        answerFn: ({ question }) => {
          if (question.toLowerCase().includes('delete')) return 'cancel';
          if (question.toLowerCase().includes('deploy')) return 'production';
          return 'proceed';
        },
      });

      const answer1 = await bridge.ask(minAsk('Delete all data?'), 'mission-1', 'wing-1');
      const answer2 = await bridge.ask(minAsk('Deploy to environment?'), 'mission-1', 'wing-1');
      const answer3 = await bridge.ask(minAsk('Continue with next step?'), 'mission-1', 'wing-1');

      expect(answer1).toBe('cancel');
      expect(answer2).toBe('production');
      expect(answer3).toBe('proceed');
    });

    it('has access to all question options', async () => {
      let capturedOptions: AskOptions | null = null;

      const bridge = createMockQuestionBridge({
        answerFn: (options) => {
          capturedOptions = options;
          return 'answered';
        },
      });

      const askOptions: AskOptions = {
        question: 'Test question?',
        content: { type: 'markdown', content: 'Some context' },
        options: [{ value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }],
        optionsMode: 'exclusive',
      };

      await bridge.ask(askOptions, 'mission-1', 'wing-1');

      expect(capturedOptions).toEqual(askOptions);
    });

    it('takes precedence over sequential answers', async () => {
      const bridge = createMockQuestionBridge({
        answers: ['Sequential'],
        answerFn: () => 'From function',
      });

      const answer = await bridge.ask(minAsk('Test'), 'mission-1', 'wing-1');

      expect(answer).toBe('From function');
    });
  });

  describe('Answer by Index', () => {
    it('computes answers based on question index', async () => {
      const bridge = createMockQuestionBridge({
        answerByIndex: (index) => `Answer ${index + 1}`,
      });

      const answer1 = await bridge.ask(minAsk('Q1'), 'mission-1', 'wing-1');
      const answer2 = await bridge.ask(minAsk('Q2'), 'mission-1', 'wing-1');
      const answer3 = await bridge.ask(minAsk('Q3'), 'mission-1', 'wing-1');

      expect(answer1).toBe('Answer 1');
      expect(answer2).toBe('Answer 2');
      expect(answer3).toBe('Answer 3');
    });

    it('has access to both index and question options', async () => {
      let capturedIndex: number | null = null;
      let capturedQuestion: string | null = null;

      const bridge = createMockQuestionBridge({
        answerByIndex: (index, options) => {
          capturedIndex = index;
          capturedQuestion = options.question;
          return 'answered';
        },
      });

      await bridge.ask(minAsk('First question'), 'mission-1', 'wing-1');
      await bridge.ask(minAsk('Second question'), 'mission-1', 'wing-1');

      expect(capturedIndex).toBe(1); // Last call was index 1
      expect(capturedQuestion).toBe('Second question');
    });

    it('answerFn takes precedence over answerByIndex', async () => {
      const bridge = createMockQuestionBridge({
        answerFn: () => 'From answerFn',
        answerByIndex: () => 'From answerByIndex',
      });

      const answer = await bridge.ask(minAsk('Test'), 'mission-1', 'wing-1');

      expect(answer).toBe('From answerFn');
    });

    it('answerByIndex takes precedence over sequential answers', async () => {
      const bridge = createMockQuestionBridge({
        answers: ['Sequential'],
        answerByIndex: () => 'From answerByIndex',
      });

      const answer = await bridge.ask(minAsk('Test'), 'mission-1', 'wing-1');

      expect(answer).toBe('From answerByIndex');
    });
  });

  describe('Question Capture', () => {
    it('captures all questions asked', async () => {
      const bridge = createMockQuestionBridge({ answers: ['Yes', 'No', 'Maybe'] });

      await bridge.ask(minAsk('Question 1?'), 'mission-1', 'wing-1');
      await bridge.ask(minAsk('Question 2?'), 'mission-2', 'wing-2');
      await bridge.ask(minAsk('Question 3?'), 'mission-1', 'wing-1');

      expect(bridge.capturedQuestions).toHaveLength(3);
      expect(bridge.capturedQuestions[0].question).toBe('Question 1?');
      expect(bridge.capturedQuestions[1].question).toBe('Question 2?');
      expect(bridge.capturedQuestions[2].question).toBe('Question 3?');
    });

    it('captures question content and options', async () => {
      const bridge = createMockQuestionBridge({ answers: ['Yes'] });

      await bridge.ask(
        {
          question: 'Deploy?',
          content: { type: 'markdown', content: 'All tests passed' },
          options: [{ value: 'production', label: 'Production' }, { value: 'staging', label: 'Staging' }],
          optionsMode: 'exclusive',
        },
        'mission-1',
        'wing-1'
      );

      expect(bridge.capturedQuestions[0]).toEqual({
        question: 'Deploy?',
        content: { type: 'markdown', content: 'All tests passed' },
        options: [{ value: 'production', label: 'Production' }, { value: 'staging', label: 'Staging' }],
        optionsMode: 'exclusive',
        controls: undefined,
        missionRunId: 'mission-1',
        wingName: 'wing-1',
        answeredWith: 'Yes',
      });
    });

    it('captures mission run ID and wing name', async () => {
      const bridge = createMockQuestionBridge({ answers: ['Answer'] });

      await bridge.ask(minAsk('Test?'), 'mission-123', 'my-wing');

      expect(bridge.capturedQuestions[0].missionRunId).toBe('mission-123');
      expect(bridge.capturedQuestions[0].wingName).toBe('my-wing');
    });

    it('captures the answer that was provided', async () => {
      const bridge = createMockQuestionBridge({
        answerFn: ({ question }) => (question.toLowerCase().includes('delete') ? 'cancel' : 'proceed'),
      });

      await bridge.ask(minAsk('Delete data?'), 'mission-1', 'wing-1');
      await bridge.ask(minAsk('Continue?'), 'mission-1', 'wing-1');

      expect(bridge.capturedQuestions[0].answeredWith).toBe('cancel');
      expect(bridge.capturedQuestions[1].answeredWith).toBe('proceed');
    });

    it('enables verification of question order', async () => {
      const bridge = createMockQuestionBridge({ answers: ['A', 'B', 'C'] });

      await bridge.ask(minAsk('Name?'), 'mission-1', 'wing-1');
      await bridge.ask(minAsk('Email?'), 'mission-1', 'wing-1');
      await bridge.ask(minAsk('Role?'), 'mission-1', 'wing-1');

      const questions = bridge.capturedQuestions.map((q) => q.question);
      expect(questions).toEqual(['Name?', 'Email?', 'Role?']);
    });
  });

  describe('Timeout Simulation', () => {
    it('throws error after configured timeout', async () => {
      const bridge = createMockQuestionBridge({ timeout: 10 });

      const startTime = Date.now();
      await expect(
        bridge.ask(minAsk('Test?'), 'mission-1', 'wing-1')
      ).rejects.toThrow('Question timeout');
      const elapsed = Date.now() - startTime;

      expect(elapsed).toBeGreaterThanOrEqual(10);
    });

    it('does not answer when timeout is configured', async () => {
      const bridge = createMockQuestionBridge({
        answers: ['Should not be used'],
        timeout: 10,
      });

      await expect(
        bridge.ask(minAsk('Test?'), 'mission-1', 'wing-1')
      ).rejects.toThrow('Question timeout');
    });

    it('timeout takes precedence over all answer strategies', async () => {
      const bridge = createMockQuestionBridge({
        answers: ['Sequential'],
        answerFn: () => 'From function',
        answerByIndex: () => 'From index',
        timeout: 10,
      });

      await expect(
        bridge.ask(minAsk('Test?'), 'mission-1', 'wing-1')
      ).rejects.toThrow('Question timeout');
    });
  });

  describe('Multiple Questions in Sequence', () => {
    it('handles complex question flow', async () => {
      const bridge = createMockQuestionBridge({
        answerFn: ({ question, options }) => {
          if (question.toLowerCase().includes('environment')) return 'production';
          if (question.toLowerCase().includes('run tests')) return 'yes';
          if (options.some(o => o.value === 'main')) return 'main';
          return 'proceed';
        },
      });

      const answers: string[] = [];
      answers.push(await bridge.ask(minAsk('Deploy to which environment?'), 'mission-1', 'wing-1'));
      answers.push(await bridge.ask(minAsk('Run tests first?'), 'mission-1', 'wing-1'));
      answers.push(
        await bridge.ask(
          {
            question: 'Select branch',
            content: { type: 'markdown', content: '' },
            options: [{ value: 'main', label: 'main' }, { value: 'develop', label: 'develop' }],
            optionsMode: 'exclusive',
          },
          'mission-1',
          'wing-1'
        )
      );
      answers.push(await bridge.ask(minAsk('Final confirmation?'), 'mission-1', 'wing-1'));

      expect(answers).toEqual(['production', 'yes', 'main', 'proceed']);
      expect(bridge.capturedQuestions).toHaveLength(4);
    });

    it('can verify questions were asked before providing answers', async () => {
      const bridge = createMockQuestionBridge({
        answerByIndex: (index, options) => {
          // Can inspect the question before answering
          if (index === 0 && options.question.includes('name')) return 'Alice';
          if (index === 1 && options.question.includes('age')) return '30';
          return 'Unknown';
        },
      });

      const name = await bridge.ask(minAsk('What is your name?'), 'mission-1', 'wing-1');
      const age = await bridge.ask(minAsk('What is your age?'), 'mission-1', 'wing-1');

      expect(name).toBe('Alice');
      expect(age).toBe('30');
      expect(bridge.capturedQuestions[0].question).toBe('What is your name?');
      expect(bridge.capturedQuestions[1].question).toBe('What is your age?');
    });
  });

  describe('Integration with Test Context', () => {
    it('can be used directly in test context', async () => {
      const bridge = createMockQuestionBridge({
        answerFn: ({ question }) => (question.includes('approve') ? 'approved' : 'rejected'),
      });

      // Simulate mission asking questions
      const answer1 = await bridge.ask(
        minAsk('Please approve this PR'),
        'test-mission',
        'test-wing'
      );
      const answer2 = await bridge.ask(
        minAsk('Continue with deployment?'),
        'test-mission',
        'test-wing'
      );

      // Verify the flow
      expect(answer1).toBe('approved');
      expect(answer2).toBe('rejected');
      expect(bridge.capturedQuestions).toHaveLength(2);
      expect(bridge.capturedQuestions[0].answeredWith).toBe('approved');
      expect(bridge.capturedQuestions[1].answeredWith).toBe('rejected');
    });

    it('supports conditional answers based on previous questions', async () => {
      let lastAnswer = '';

      const bridge = createMockQuestionBridge({
        answerFn: ({ question }) => {
          if (question.toLowerCase().includes('retry')) {
            // Only retry once
            const shouldRetry = lastAnswer !== 'yes';
            lastAnswer = shouldRetry ? 'yes' : 'no';
            return lastAnswer;
          }
          return 'continue';
        },
      });

      const answer1 = await bridge.ask(minAsk('Failed. Retry?'), 'mission-1', 'wing-1');
      const answer2 = await bridge.ask(minAsk('Failed. Retry?'), 'mission-1', 'wing-1');
      const answer3 = await bridge.ask(minAsk('Next step?'), 'mission-1', 'wing-1');

      expect(answer1).toBe('yes');
      expect(answer2).toBe('no');
      expect(answer3).toBe('continue');
    });
  });
});

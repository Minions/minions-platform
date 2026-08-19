import { describe, it, expect, beforeEach } from 'vitest';
import { QuestionQueue } from './QuestionQueue';
import type { QuestionInput } from './QuestionQueue';

// Helper for minimal valid QuestionInput
const mkInput = (overrides: Partial<QuestionInput> & { minionId: string; wingName: string; question: string }): QuestionInput => ({
  content: { type: 'markdown', content: '' },
  options: [],
  optionsMode: 'exclusive',
  ...overrides,
});

describe('QuestionQueue', () => {
  let queue: QuestionQueue;

  beforeEach(() => {
    queue = new QuestionQueue();
  });

  it('creates questions with UUID', () => {
    const question = queue.add(mkInput({
      minionId: 'minion-1',
      wingName: 'test-wing',
      question: 'Test question?',
      content: { type: 'markdown', content: 'Full conversation...' },
    }));

    expect(question.id).toBeDefined();
    expect(question.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('stores question data correctly', () => {
    const question = queue.add(mkInput({
      minionId: 'minion-1',
      wingName: 'test-wing',
      question: 'Test question?',
      content: { type: 'markdown', content: 'Full conversation...' },
    }));

    expect(question.minionId).toBe('minion-1');
    expect(question.wingName).toBe('test-wing');
    expect(question.question).toBe('Test question?');
    expect(question.content).toEqual({ type: 'markdown', content: 'Full conversation...' });
    expect(question.status).toBe('open');
    expect(question.timestamp).toBeDefined();
  });

  it('retrieves question by ID', () => {
    const question = queue.add(mkInput({
      minionId: 'minion-1',
      wingName: 'test',
      question: 'Q1',
    }));

    const retrieved = queue.get(question.id);

    expect(retrieved).toEqual(question);
  });

  it('returns undefined for non-existent question', () => {
    const retrieved = queue.get('non-existent-id');

    expect(retrieved).toBeUndefined();
  });

  it('lists all open questions', () => {
    queue.add(mkInput({ minionId: 'minion-1', wingName: 'test', question: 'Q1' }));
    queue.add(mkInput({ minionId: 'minion-2', wingName: 'test', question: 'Q2' }));

    const openQuestions = queue.getOpen();

    expect(openQuestions).toHaveLength(2);
    expect(openQuestions.every(q => q.status === 'open')).toBe(true);
  });

  it('filters open questions by wing', () => {
    queue.add(mkInput({ minionId: 'minion-1', wingName: 'wing-a', question: 'Q1' }));
    queue.add(mkInput({ minionId: 'minion-2', wingName: 'wing-b', question: 'Q2' }));

    const wingQuestions = queue.getOpenByWing('wing-a');

    expect(wingQuestions).toHaveLength(1);
    expect(wingQuestions[0].wingName).toBe('wing-a');
  });

  it('answers question and updates status', () => {
    const question = queue.add(mkInput({ minionId: 'minion-1', wingName: 'test', question: 'Q1' }));

    queue.answer(question.id, 'Answer text');

    const updated = queue.get(question.id);
    expect(updated?.status).toBe('answered');
    expect(updated?.answer).toBe('Answer text');
  });

  it('throws error when answering non-existent question', () => {
    expect(() => {
      queue.answer('non-existent', 'Answer');
    }).toThrow('Question not found');
  });

  it('throws error when answering already answered question', () => {
    const question = queue.add(mkInput({ minionId: 'minion-1', wingName: 'test', question: 'Q1' }));

    queue.answer(question.id, 'First answer');

    expect(() => {
      queue.answer(question.id, 'Second answer');
    }).toThrow('Question already answered');
  });

  it('cancels question and updates status', () => {
    const question = queue.add(mkInput({ minionId: 'minion-1', wingName: 'test', question: 'Q1' }));

    queue.cancel(question.id);

    const updated = queue.get(question.id);
    expect(updated?.status).toBe('cancelled');
  });

  it('excludes answered questions from open list', () => {
    const q1 = queue.add(mkInput({ minionId: 'minion-1', wingName: 'test', question: 'Q1' }));
    queue.add(mkInput({ minionId: 'minion-2', wingName: 'test', question: 'Q2' }));

    queue.answer(q1.id, 'Answer');

    const openQuestions = queue.getOpen();
    expect(openQuestions).toHaveLength(1);
    expect(openQuestions[0].question).toBe('Q2');
  });

  it('excludes cancelled questions from open list', () => {
    const q1 = queue.add(mkInput({ minionId: 'minion-1', wingName: 'test', question: 'Q1' }));
    queue.add(mkInput({ minionId: 'minion-2', wingName: 'test', question: 'Q2' }));

    queue.cancel(q1.id);

    const openQuestions = queue.getOpen();
    expect(openQuestions).toHaveLength(1);
    expect(openQuestions[0].question).toBe('Q2');
  });

  describe('waitForAnswer', () => {
    it('resolves immediately if already answered', async () => {
      const question = queue.add(mkInput({ minionId: 'minion-1', wingName: 'test', question: 'Q1' }));
      queue.answer(question.id, 'Already answered');

      const answer = await queue.waitForAnswer(question.id);
      expect(answer).toBe('Already answered');
    });

    it('rejects immediately if already cancelled', async () => {
      const question = queue.add(mkInput({ minionId: 'minion-1', wingName: 'test', question: 'Q1' }));
      queue.cancel(question.id);

      await expect(queue.waitForAnswer(question.id)).rejects.toThrow('Question was cancelled');
    });

    it('rejects for non-existent question', async () => {
      await expect(queue.waitForAnswer('non-existent')).rejects.toThrow('Question not found');
    });

    it('resolves when answer arrives later', async () => {
      const question = queue.add(mkInput({ minionId: 'minion-1', wingName: 'test', question: 'Q1' }));

      const answerPromise = queue.waitForAnswer(question.id);

      // Answer after a tick
      queue.answer(question.id, 'Delayed answer');

      const answer = await answerPromise;
      expect(answer).toBe('Delayed answer');
    });

    it('rejects when cancelled while waiting', async () => {
      const question = queue.add(mkInput({ minionId: 'minion-1', wingName: 'test', question: 'Q1' }));

      const answerPromise = queue.waitForAnswer(question.id);

      // Cancel after starting to wait
      queue.cancel(question.id);

      await expect(answerPromise).rejects.toThrow('Question was cancelled');
    });
  });
});

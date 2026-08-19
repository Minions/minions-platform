import { describe, it, expectTypeOf } from 'vitest';
import type { Question } from './question';

describe('Question types', () => {
  it('Question interface has required properties', () => {
    expectTypeOf<Question>().toHaveProperty('id');
    expectTypeOf<Question>().toHaveProperty('minionId');
    expectTypeOf<Question>().toHaveProperty('wingName');
    expectTypeOf<Question>().toHaveProperty('question');
    expectTypeOf<Question>().toHaveProperty('content');
    expectTypeOf<Question>().toHaveProperty('options');
    expectTypeOf<Question>().toHaveProperty('optionsMode');
    expectTypeOf<Question>().toHaveProperty('timestamp');
    expectTypeOf<Question>().toHaveProperty('status');
  });

  it('accepts valid Question objects', () => {
    const question: Question = {
      id: 'q-123',
      minionId: 'm-456',
      wingName: 'test-wing',
      question: 'What is the meaning of life?',
      content: { type: 'markdown', content: 'Discussing philosophy' },
      options: [],
      optionsMode: 'exclusive',
      timestamp: 1701234567890,
      status: 'open',
    };
    expectTypeOf(question).toMatchTypeOf<Question>();
  });

  it('status accepts all valid values', () => {
    const base = {
      id: 'q-1',
      minionId: 'm-1',
      wingName: 'wing',
      question: 'Question',
      content: { type: 'markdown' as const, content: 'Context' },
      options: [],
      optionsMode: 'exclusive' as const,
      timestamp: Date.now(),
    };

    const openQuestion: Question = { ...base, status: 'open' };
    expectTypeOf(openQuestion).toMatchTypeOf<Question>();

    const answeredQuestion: Question = { ...base, status: 'answered' };
    expectTypeOf(answeredQuestion).toMatchTypeOf<Question>();

    const cancelledQuestion: Question = { ...base, status: 'cancelled' };
    expectTypeOf(cancelledQuestion).toMatchTypeOf<Question>();
  });
});

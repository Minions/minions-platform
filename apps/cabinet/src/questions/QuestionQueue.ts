import { randomUUID } from 'crypto';
import type { AskContent, AskOption, AskControl } from '@minions/mcp-types';

export interface Question {
  id: string;
  minionId: string;
  wingName: string;
  question: string;
  content: AskContent;
  options: AskOption[];
  optionsMode: 'exclusive' | 'non-exclusive';
  controls?: AskControl[];
  timestamp: number;
  status: 'open' | 'answered' | 'cancelled';
  answer?: string;
}

export interface QuestionInput {
  minionId: string;
  wingName: string;
  question: string;
  content: AskContent;
  options: AskOption[];
  optionsMode: 'exclusive' | 'non-exclusive';
  controls?: AskControl[];
}

/**
 * Question event notification types
 */
export interface QuestionEvent {
  type: 'question_added' | 'question_answered' | 'question_cancelled';
  question: Question;
}

/**
 * Broadcast callback type for pushing question events to connected clients
 */
export type QuestionBroadcastFn = (data: QuestionEvent) => Promise<void>;

/**
 * In-memory question queue for managing minion questions.
 * Singleton pattern - one queue for the entire Cabinet instance.
 */
export class QuestionQueue {
  private questions: Map<string, Question> = new Map();
  private broadcast?: QuestionBroadcastFn;
  private answerWaiters = new Map<string, { resolve: (answer: string) => void; reject: (error: Error) => void }>();

  /**
   * Set the broadcast function for pushing events to clients
   */
  setBroadcast(fn: QuestionBroadcastFn): void {
    this.broadcast = fn;
  }

  /**
   * Emit a question event to connected clients
   */
  private emit(event: QuestionEvent): void {
    if (this.broadcast) {
      this.broadcast(event).catch((err) => {
        console.error('[QuestionQueue] Broadcast error:', err);
      });
    }
  }

  /**
   * Add a new question to the queue
   */
  add(input: QuestionInput): Question {
    const question: Question = {
      id: randomUUID(),
      minionId: input.minionId,
      wingName: input.wingName,
      question: input.question,
      content: input.content,
      options: input.options,
      optionsMode: input.optionsMode,
      controls: input.controls,
      timestamp: Date.now(),
      status: 'open'
    };

    this.questions.set(question.id, question);
    this.emit({ type: 'question_added', question });
    return question;
  }

  /**
   * Get a question by ID
   */
  get(id: string): Question | undefined {
    return this.questions.get(id);
  }

  /**
   * Get all open questions
   */
  getOpen(): Question[] {
    return Array.from(this.questions.values())
      .filter(q => q.status === 'open');
  }

  /**
   * Get open questions for a specific wing
   */
  getOpenByWing(wingName: string): Question[] {
    return this.getOpen()
      .filter(q => q.wingName === wingName);
  }

  /**
   * Answer a question
   */
  answer(id: string, answerText: string): void {
    const question = this.questions.get(id);

    if (!question) {
      throw new Error('Question not found');
    }

    if (question.status !== 'open') {
      throw new Error(`Question already ${question.status}`);
    }

    question.status = 'answered';
    question.answer = answerText;
    this.emit({ type: 'question_answered', question });

    const waiter = this.answerWaiters.get(id);
    if (waiter) {
      this.answerWaiters.delete(id);
      waiter.resolve(answerText);
    }
  }

  /**
   * Cancel a question
   */
  cancel(id: string): void {
    const question = this.questions.get(id);

    if (!question) {
      throw new Error('Question not found');
    }

    question.status = 'cancelled';
    this.emit({ type: 'question_cancelled', question });

    const waiter = this.answerWaiters.get(id);
    if (waiter) {
      this.answerWaiters.delete(id);
      waiter.reject(new Error('Question was cancelled'));
    }
  }

  /**
   * Wait for a question to be answered.
   * Resolves immediately if already answered, rejects if cancelled.
   */
  waitForAnswer(questionId: string): Promise<string> {
    const question = this.questions.get(questionId);
    if (!question) {
      return Promise.reject(new Error('Question not found'));
    }
    if (question.status === 'answered' && question.answer !== undefined) {
      return Promise.resolve(question.answer);
    }
    if (question.status === 'cancelled') {
      return Promise.reject(new Error('Question was cancelled'));
    }
    return new Promise<string>((resolve, reject) => {
      this.answerWaiters.set(questionId, { resolve, reject });
    });
  }

  /**
   * Clear all questions (for testing)
   */
  clear(): void {
    this.questions.clear();
  }
}

// Singleton instance
let queueInstance: QuestionQueue | null = null;

export function getQuestionQueue(): QuestionQueue {
  if (!queueInstance) {
    queueInstance = new QuestionQueue();
  }
  return queueInstance;
}

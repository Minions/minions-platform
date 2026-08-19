import { vi } from 'vitest';
import type { IHatchery } from '@minions/hatchery';
import type { IMinion } from '@minions/domain-types';
import type { AskContent, AskOption, AskControl } from '@minions/mcp-types';
import type { IQuestionBridge } from '../ports/IQuestionBridge';
import type { AskOptions } from '../domain/MissionContext';

/**
 * Creates a mock minion with standard vitest mocks
 */
export const createMockMinion = (id: string): IMinion => ({
  id,
  spec: {
    client: 'claude-code',
    wing: '/test/wing',
    model: 'test-model',
    useBuiltInSystemPrompt: false,
  },
  send: vi.fn().mockResolvedValue(undefined),
  receive: vi.fn(),
  kill: vi.fn(),
  interrupt: vi.fn(),
  reconfigure: vi.fn(),
  status: 'waiting' as const,
});

/**
 * Creates a mock hatchery that returns minions from a pre-configured list
 */
export const createMockHatchery = (minions: IMinion[] = []): IHatchery => {
  let spawnIndex = 0;
  return {
    spawn: vi.fn().mockImplementation(async () => {
      if (spawnIndex >= minions.length) {
        throw new Error('No more mock minions available');
      }
      return minions[spawnIndex++];
    }),
  };
};

/**
 * Configuration options for createMockQuestionBridge
 */
export interface MockQuestionBridgeConfig {
  /** Pre-configured answers to provide sequentially */
  answers?: string[];

  /** Function to provide answers based on question content */
  answerFn?: (options: AskOptions) => string;

  /** Function to provide answers based on question index */
  answerByIndex?: (index: number, options: AskOptions) => string;

  /** Whether to throw an error when no more answers are available (default: true) */
  throwOnExhaustion?: boolean;

  /** Timeout in milliseconds before throwing an error (simulates timeout behavior) */
  timeout?: number;
}

/**
 * Captured question for verification in tests
 */
export interface CapturedQuestion {
  question: string;
  content: AskContent;
  options: AskOption[];
  optionsMode: 'exclusive' | 'non-exclusive';
  controls?: AskControl[];
  missionRunId: string;
  wingName: string;
  answeredWith?: string;
}

/**
 * Creates a mock question bridge with enhanced test capabilities
 *
 * Supports multiple answer strategies:
 * 1. Sequential answers: Provide array of answers to return in order
 * 2. Answer function: Dynamically compute answer based on question content
 * 3. Answer by index: Compute answer based on question index
 *
 * All questions are captured for verification in tests.
 *
 * @example
 * ```typescript
 * // Sequential answers
 * const bridge = createMockQuestionBridge({ answers: ['Yes', 'No'] })
 *
 * // Conditional answers based on question content
 * const bridge = createMockQuestionBridge({
 *   answerFn: ({ question }) => question.includes('delete') ? 'cancel' : 'proceed'
 * })
 *
 * // Verify questions were asked
 * expect(bridge.capturedQuestions).toHaveLength(2)
 * expect(bridge.capturedQuestions[0].question).toBe('Should we proceed?')
 * ```
 */
export const createMockQuestionBridge = (config: MockQuestionBridgeConfig = {}): IQuestionBridge & { capturedQuestions: CapturedQuestion[] } => {
  let answerIndex = 0;
  const capturedQuestions: CapturedQuestion[] = [];

  const {
    answers = [],
    answerFn,
    answerByIndex,
    throwOnExhaustion = true,
    timeout,
  } = config;

  const askImpl = async (options: AskOptions, missionRunId: string, wingName: string): Promise<string> => {
    const captured: CapturedQuestion = {
      question: options.question,
      content: options.content,
      options: options.options,
      optionsMode: options.optionsMode,
      controls: options.controls,
      missionRunId,
      wingName,
    };

    // Simulate timeout if configured
    if (timeout !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, timeout));
      throw new Error('Question timeout');
    }

    let answer: string;

    // Priority: answerFn > answerByIndex > sequential answers
    if (answerFn) {
      answer = answerFn(options);
    } else if (answerByIndex) {
      answer = answerByIndex(answerIndex, options);
    } else if (answerIndex < answers.length) {
      answer = answers[answerIndex];
    } else if (throwOnExhaustion) {
      throw new Error('No more mock answers available');
    } else {
      answer = '';
    }

    answerIndex++;
    captured.answeredWith = answer;
    capturedQuestions.push(captured);

    return answer;
  };

  return {
    ask: vi.fn().mockImplementation(askImpl),
    cancel: vi.fn(),
    capturedQuestions,
  };
};

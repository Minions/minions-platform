/**
 * Cabinet Question Bridge
 *
 * Routes mission questions to Cabinet's QuestionQueue system.
 * Implements IQuestionBridge from the conductor library.
 */

import type { IQuestionBridge, AskOptions } from '@minions/conductor';
import { getQuestionQueue } from '../questions/QuestionQueue.js';
import { resolveAskContent } from '../questions/compileVueAskContent.js';

/**
 * Question bridge that routes to Cabinet's QuestionQueue
 */
export class CabinetQuestionBridge implements IQuestionBridge {
  private readonly pendingQuestions = new Map<string, string>(); // missionRunId -> questionId

  /**
   * Ask a human a question via Cabinet's question system.
   * Blocks until the human provides an answer or the question is cancelled.
   */
  async ask(options: AskOptions, missionRunId: string, wingName: string): Promise<string> {
    const queue = getQuestionQueue();

    // Create the question in the queue
    const question = queue.add({
      minionId: missionRunId, // Use mission run ID as the "minion" identifier
      wingName,
      question: options.question,
      content: await resolveAskContent(options.content),
      options: options.options,
      optionsMode: options.optionsMode,
      controls: options.controls,
    });

    // Track the pending question for cancellation
    this.pendingQuestions.set(missionRunId, question.id);

    try {
      return await queue.waitForAnswer(question.id);
    } finally {
      this.pendingQuestions.delete(missionRunId);
    }
  }

  /**
   * Cancel any pending question for a mission
   */
  cancel(missionRunId: string): void {
    const questionId = this.pendingQuestions.get(missionRunId);
    if (questionId) {
      const queue = getQuestionQueue();
      try {
        queue.cancel(questionId);
      } catch {
        // Question may already be answered or cancelled
      }
      this.pendingQuestions.delete(missionRunId);
    }
  }
}

import type { AskOptions } from '../domain/MissionContext';

/**
 * Port for asking humans questions from within missions
 *
 * IQuestionBridge abstracts the mechanism for blocking on human input.
 * Different implementations can route questions to different UIs:
 * - CabinetQuestionBridge: Uses Cabinet's question system
 * - CLIQuestionBridge: Prompts in the terminal
 * - TestQuestionBridge: Pre-programmed answers for testing
 *
 * @example
 * ```typescript
 * const bridge: IQuestionBridge = new CabinetQuestionBridge(cabinetClient);
 *
 * const answer = await bridge.ask({
 *   question: 'Which approach should we use?',
 *   context: 'We found 3 possible solutions...',
 *   suggestions: ['Option A', 'Option B', 'Option C']
 * }, missionRunId, wingName);
 *
 * console.log('User chose:', answer);
 * ```
 */
export interface IQuestionBridge {
  /**
   * Ask a human a question
   *
   * Blocks until the human provides an answer. The implementation
   * determines how the question is presented and how the answer
   * is collected.
   *
   * @param options - Question options
   * @param missionRunId - ID of the mission asking the question
   * @param wingName - Name of the wing the mission is running in
   * @returns The human's answer
   * @throws If the question times out or is cancelled
   */
  ask(options: AskOptions, missionRunId: string, wingName: string): Promise<string>;

  /**
   * Cancel a pending question
   *
   * If a question is waiting for an answer, this cancels it and
   * causes the ask() promise to reject.
   *
   * @param missionRunId - ID of the mission to cancel questions for
   */
  cancel(missionRunId: string): void;
}

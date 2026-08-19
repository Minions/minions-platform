import { Data } from 'effect';
/**
 * Error thrown when minion reconfiguration fails
 *
 * Common reasons:
 * - Attempting to change the model (not allowed)
 * - Invalid costume properties
 */
export class ReconfigureError extends Data.TaggedError('ReconfigureError') {
}
//# sourceMappingURL=IMinion.js.map
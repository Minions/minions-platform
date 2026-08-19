import { IntentionCode } from '../tools/GitCommit.js';
import type { IntentionClassification } from './ToolLogAnalyzer.js';

/**
 * Merges the agent's declared intention with the analyzer's observed intention.
 *
 * Rules:
 * - not_classified → trust the agent
 * - multiple → always multiple
 * - code → compatible with feature/bug/refactor; conflicts with test/docs/chore/plan
 * - plan → trust the agent (plan tool usage is context, not a constraint)
 * - test/docs/chore → subsumed by agent's intent, EXCEPT they override a plan agent intent
 *   (if agent said "plan" but the log shows test/docs/chore edits, the actual work is test/docs/chore)
 */
export function mergeIntentions(
  agent: IntentionCode,
  analyzer: IntentionClassification,
): IntentionClassification {
  if (analyzer === 'not_classified') return agent;
  if (analyzer === 'multiple') return 'multiple';

  // Code changes: compatible with feature/bug/refactor, conflicts with everything else
  if (analyzer === 'code') {
    if (
      agent === IntentionCode.Feature ||
      agent === IntentionCode.Bug ||
      agent === IntentionCode.Refactor
    ) {
      return agent;
    }
    return 'multiple';
  }

  // Plan analyzer result: treat like not_classified — trust the agent
  if (analyzer === IntentionCode.Plan) return agent;

  // test/docs/chore override a plan agent intent; for all others they are subsumed
  if (agent === IntentionCode.Plan) {
    return analyzer as IntentionCode;
  }

  // For all other agent intents: test/docs/chore are supportive — subsumed by the agent
  return agent;
}

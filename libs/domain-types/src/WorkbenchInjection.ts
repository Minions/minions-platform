import type { MinionMessage } from './MinionMessage';
import type { IWorkbench, ProjectFact } from './Workbench';

/**
 * Convert Workbench contents to synthetic MinionMessage history
 *
 * Converts files and facts in the workbench to synthetic messages that appear
 * as if the minion had previously executed gadgets to discover this information.
 *
 * Files are converted to tool_use/tool_result pairs (mimicking Read gadget).
 * Facts are grouped by category and converted to text messages (filtered by injectFacts).
 *
 * All messages are ordered chronologically by timestamp (oldest first).
 *
 * @param workbench - The workbench containing files and facts
 * @param injectFacts - Categories of facts to inject (from Costume.injectFacts)
 * @returns Chronologically ordered array of synthetic messages
 */
export function workbenchToSyntheticHistory(
  workbench: IWorkbench,
  injectFacts?: string[]
): MinionMessage[] {
  // Collect all items with their timestamps
  interface TimestampedItem {
    timestamp: number;
    messages: MinionMessage[];
  }

  const items: TimestampedItem[] = [];

  // Convert files to tool_use/tool_result pairs
  const files = Array.from(workbench.files.values());
  files.forEach((file, index) => {
    const toolUseId = `synthetic-read-${index}`;

    // Create pair of messages for this file
    // They share the same base timestamp but tool_result is +1ms
    const toolUse: MinionMessage = {
      type: 'tool_use',
      id: toolUseId,
      name: 'Read',
      input: {
        file_path: file.path,
      },
      timestamp: file.lastRead,
      metadata: {
        synthetic: true,
        category: file.category,
      },
    };

    const toolResult: MinionMessage = {
      type: 'tool_result',
      tool_use_id: toolUseId,
      content: file.content,
      is_error: false,
      timestamp: file.lastRead + 1, // 1ms after tool_use for proper ordering
      metadata: {
        synthetic: true,
        category: file.category,
      },
    };

    // Add as a pair with the base timestamp
    items.push({
      timestamp: file.lastRead,
      messages: [toolUse, toolResult],
    });
  });

  // Convert facts to text messages (filtered and grouped by category)
  if (injectFacts && injectFacts.length > 0) {
    // Group facts by category
    const factsByCategory = new Map<string, ProjectFact[]>();

    for (const fact of workbench.facts) {
      if (injectFacts.includes(fact.category)) {
        let bucket = factsByCategory.get(fact.category);
        if (!bucket) {
          bucket = [];
          factsByCategory.set(fact.category, bucket);
        }
        bucket.push(fact);
      }
    }

    // Create a text message for each category
    // Use current timestamp, but ensure it's after all file timestamps
    const maxFileTimestamp = files.length > 0
      ? Math.max(...files.map(f => f.lastRead + 1))
      : 0;
    const currentTimestamp = Math.max(Date.now(), maxFileTimestamp + 1);

    for (const [category, facts] of factsByCategory) {
      const factStatements = facts.map((f) => `- ${f.fact}`).join('\n');
      const content = `Project Facts (${category}):\n${factStatements}`;

      // Collect unique discoverers
      const discoverers = Array.from(
        new Set(facts.map((f) => f.discoveredBy))
      );

      const factMessage: MinionMessage = {
        type: 'text',
        content,
        timestamp: currentTimestamp,
        metadata: {
          synthetic: true,
          factCategory: category,
          factCount: facts.length,
          discoveredBy: discoverers,
        },
      };

      items.push({
        timestamp: currentTimestamp,
        messages: [factMessage],
      });
    }
  }

  // Sort items by timestamp, then flatten to messages
  // This keeps message pairs together while maintaining chronological order
  items.sort((a, b) => a.timestamp - b.timestamp);

  const messages: MinionMessage[] = [];
  for (const item of items) {
    messages.push(...item.messages);
  }

  return messages;
}

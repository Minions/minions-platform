import type { McpServerConfig } from '@minions/costumes';
import type { CostumeAccessorySummary } from './ClosetReader.js';

/**
 * Merge external MCP server configs from the active costumes' closet summaries.
 * Later costumes in activeCostumes win on server name collision.
 */
export function resolveExternalServers(
  activeCostumes: string[],
  closetSummaries: CostumeAccessorySummary[]
): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {};
  const summaryMap = new Map(closetSummaries.map((s) => [s.name, s]));
  for (const costumeName of activeCostumes) {
    const summary = summaryMap.get(costumeName);
    if (!summary) continue;
    for (const [serverName, config] of Object.entries(summary.mcpServers)) {
      result[serverName] = config;
    }
  }
  return result;
}

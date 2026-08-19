/**
 * ClosetReader — reads costume accessory summaries from the lair's closet.
 *
 * Iterates over entries in [lair-root]/closet/, reads each costume.json,
 * and returns a summary of the accessory capabilities each costume provides.
 */

import type { Directory, DirectoryLike } from '@minions/file-store';
import type { McpServerConfig } from '@minions/costumes';
import { isCostumeConfig } from '@minions/costumes';

/** Summary of a costume's accessory capabilities as installed in the closet. */
export interface CostumeAccessorySummary {
  /** Name of the costume (directory name in closet) */
  name: string;
  /** Whether the costume has missions/ that should be linked into .claude/commands/ */
  hasMissions: boolean;
  /** External MCP servers declared by this costume, keyed by server name */
  mcpServers: Record<string, McpServerConfig>;
}

/**
 * Read all costume accessory summaries from [lair-root]/closet/.
 *
 * Handles missing closet directory, missing costume.json, and invalid costume.json
 * gracefully — all errors result in a default summary (hasMissions=false, mcpServers={}).
 */
export async function readClosetCostumes(lairRoot: Directory): Promise<CostumeAccessorySummary[]> {
  const closetResult = await lairRoot.child('closet');
  if (!closetResult.found) return [];

  const node = closetResult.node;
  if (node.kind !== 'directory' && node.kind !== 'junction') return [];

  const closetDir = node as DirectoryLike;
  const children = await closetDir.children();
  const summaries: CostumeAccessorySummary[] = [];

  for (const child of children) {
    if (child.kind !== 'directory' && child.kind !== 'junction') continue;

    const costumeDir = child as DirectoryLike;
    const summary = await readCostumeSummary(costumeDir);
    summaries.push(summary);
  }

  return summaries;
}

async function readCostumeSummary(costumeDir: DirectoryLike): Promise<CostumeAccessorySummary> {
  const name = costumeDir.name;
  const defaultSummary: CostumeAccessorySummary = { name, hasMissions: false, mcpServers: {} };

  try {
    const fileResult = await costumeDir.child('costume.json');
    if (!fileResult.found || fileResult.node.kind !== 'file') {
      return defaultSummary;
    }

    const text = await (fileResult.node as { read(): Promise<string> }).read();
    const parsed: unknown = JSON.parse(text);

    if (!isCostumeConfig(parsed)) {
      return defaultSummary;
    }

    const accessories = parsed.accessories;
    if (!accessories) {
      return defaultSummary;
    }

    return {
      name,
      hasMissions: accessories.missions === true,
      mcpServers: accessories.mcpServers ?? {},
    };
  } catch {
    return defaultSummary;
  }
}

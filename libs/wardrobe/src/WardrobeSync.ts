/**
 * WardrobeSync — orchestrates all wing sync steps.
 *
 * Calls MissionsSync, McpJsonSync, and PermissionsSync in sequence.
 */

import type { Directory } from '@minions/file-store';
import type { AccessoriesConfig } from './AccessoriesConfig.js';
import { syncMissions } from './MissionsSync.js';
import { syncMcpJson } from './McpJsonSync.js';
import { syncPermissions } from './PermissionsSync.js';

/**
 * Synchronize all wing configuration from an AccessoriesConfig.
 *
 * Steps:
 * 1. MissionsSync — create/remove .claude/commands/ junctions for active costumes
 * 2. McpJsonSync — write [wing-root]/.mcp.json with cabinet endpoint
 * 3. PermissionsSync — update [work-local]/.claude/settings.json permissions (if present)
 *
 * @param wingRoot - The wing's root directory (e.g. [lair]/wings/[name]/)
 * @param workLocalRoot - The wing's work/local directory (for settings.json)
 * @param lairRoot - The lair's root directory (for closet lookup)
 * @param wingName - The wing name (used in the MCP URL)
 * @param config - The parsed accessories.json content
 * @param port - The cabinet's port number
 */
export async function syncWardrobe(
  wingRoot: Directory,
  workLocalRoot: Directory,
  lairRoot: Directory,
  wingName: string,
  config: AccessoriesConfig,
  port: number
): Promise<void> {
  await syncMissions(wingRoot, lairRoot, config.costumes);
  await syncMcpJson(wingRoot, wingName, port);
  await syncPermissions(workLocalRoot, config.permissions);
}

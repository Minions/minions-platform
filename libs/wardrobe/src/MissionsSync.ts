/**
 * MissionsSync — manages .claude/commands/ junctions for a wing.
 *
 * For each active costume where closet/[costume]/missions/ exists, creates a junction
 * [wing-root]/.claude/commands/[costume] → [lair-root]/closet/[costume]/missions/.
 * Removes stale junctions whose costume name is not in the active list.
 */

import type { Directory, DirectoryLike, Junction } from '@minions/file-store';

function isDirectory(node: { kind: string }): node is Directory {
  return node.kind === 'directory';
}

function isJunction(node: { kind: string }): node is Junction {
  return node.kind === 'junction';
}

async function getOrCreateDirectory(parent: Directory, name: string): Promise<Directory> {
  const result = await parent.child(name);
  if (result.found && isDirectory(result.node)) {
    return result.node;
  }
  return parent.createDirectory(name);
}

async function createJunctionSafe(
  parent: Directory,
  name: string,
  target: DirectoryLike
): Promise<Junction> {
  const existing = await parent.child(name);
  if (existing.found) {
    if (isJunction(existing.node)) {
      await existing.node.unlink();
    } else if (isDirectory(existing.node)) {
      await existing.node.delete(true);
    }
  }
  return parent.createJunction(name, target);
}

/**
 * Sync .claude/commands/ junctions for a wing.
 *
 * @param wingRoot - The wing's root directory
 * @param lairRoot - The lair's root directory
 * @param activeCostumes - Names of active costumes from accessories.json
 */
export async function syncMissions(
  wingRoot: Directory,
  lairRoot: Directory,
  activeCostumes: string[]
): Promise<void> {
  // Ensure .claude/commands/ exists
  const claudeDir = await getOrCreateDirectory(wingRoot, '.claude');
  const commandsDir = await getOrCreateDirectory(claudeDir, 'commands');

  const activeSet = new Set(activeCostumes);

  // Remove stale junctions (names not in activeCostumes)
  const existing = await commandsDir.children();
  for (const child of existing) {
    if (isJunction(child) && !activeSet.has(child.name)) {
      await child.unlink();
    }
  }

  // Create/update junctions for active costumes with missions
  for (const costumeName of activeCostumes) {
    const missionsDir = await findMissionsDirectory(lairRoot, costumeName);
    if (!missionsDir) continue;

    await createJunctionSafe(commandsDir, costumeName, missionsDir);
  }
}

/**
 * Navigate to [lair-root]/closet/[costumeName]/missions/ and return it if it exists.
 */
async function findMissionsDirectory(
  lairRoot: Directory,
  costumeName: string
): Promise<DirectoryLike | null> {
  const closetResult = await lairRoot.child('closet');
  if (!closetResult.found) return null;

  const closetNode = closetResult.node;
  if (closetNode.kind !== 'directory' && closetNode.kind !== 'junction') return null;

  const costumeResult = await (closetNode as DirectoryLike).child(costumeName);
  if (!costumeResult.found) return null;

  const costumeNode = costumeResult.node;
  if (costumeNode.kind !== 'directory' && costumeNode.kind !== 'junction') return null;

  const missionsResult = await (costumeNode as DirectoryLike).child('missions');
  if (!missionsResult.found) return null;

  const missionsNode = missionsResult.node;
  if (missionsNode.kind !== 'directory' && missionsNode.kind !== 'junction') return null;

  return missionsNode as DirectoryLike;
}

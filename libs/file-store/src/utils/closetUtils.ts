import type { Directory, DirectoryLike } from '../port';
import type { Wing } from '../lair';

/**
 * Helper to read costume directories from a single closet directory.
 * Costumes are directories, junctions, or worktrees (symlinks to directories).
 */
async function getCostumesFromCloset(
  closet: DirectoryLike
): Promise<DirectoryLike[]> {
  const children = await closet.children();
  const costumes: DirectoryLike[] = [];

  for (const child of children) {
    if (child.kind === 'directory' || child.kind === 'junction' || child.kind === 'worktree') {
      costumes.push(child as DirectoryLike);
    }
  }

  return costumes;
}

/**
 * Get live costume source directories from the wing's work/local/costumes/ tree.
 * Each costume must have a src/ subdirectory containing a costume.json to qualify.
 * Returns a map of costume name → src/ DirectoryLike.
 *
 * This is the highest-priority overlay: when the cabinet runs in dev mode from a
 * wing's work/local, these src/ directories are always preferred over anything in
 * the lair closet (which may point to a different wing's built dist/).
 */
async function getWorkLocalCostumes(wing: Wing): Promise<Map<string, DirectoryLike>> {
  const costumes = new Map<string, DirectoryLike>();
  try {
    // Built on the design-doc-§4.2 `WorkArea` surface (`workAreaLocal()` +
    // `activeMovement().files`) rather than `wing.workLocal()` + raw
    // `Worktree`. `workAreaLocal()` throws when there's no work/local
    // worktree set up — caught by this function's own try/catch.
    // `activeMovement().files` is `MutableDirectoryLike` (`Directory |
    // Worktree`) but is, at runtime, the same `Worktree` object every
    // adapter passes as `files` (see `CheckedOutMovement.files`'s doc
    // comment in `port/types.ts`), so every `.kind === 'worktree'` check
    // below is valid, not a guess.
    const workArea = await wing.workAreaLocal();
    const movement = await workArea.activeMovement();

    const costumesResult = await movement.files.child('costumes');
    if (!costumesResult.found) return costumes;

    const costumesNode = costumesResult.node;
    // Within a Worktree, subdirectories have kind 'worktree'
    if (costumesNode.kind !== 'worktree') {
      return costumes;
    }

    const children = await (costumesNode as DirectoryLike).children();
    for (const child of children) {
      if (child.kind !== 'worktree') continue;

      const costumeDir = child as DirectoryLike;
      const srcResult = await costumeDir.child('src');
      if (!srcResult.found) continue;
      if (srcResult.node.kind !== 'worktree') continue;

      const srcDir = srcResult.node as DirectoryLike;
      const configResult = await srcDir.child('costume.json');
      if (configResult.found && configResult.node.kind === 'file') {
        costumes.set(child.name, srcDir);
      }
    }
  } catch {
    // Error reading work/local — continue with empty map
  }
  return costumes;
}

/**
 * Get the wing's own closet directory (not the lair junction).
 * This is the directory at wing.root/closet used for debug-installed costumes.
 * Returns null if it doesn't exist or is a junction (junction points to lair).
 */
async function getWingCloset(wing: Wing): Promise<DirectoryLike | null> {
  try {
    const root = wing.root;
    const closetResult = await root.child('closet');
    if (closetResult.found && closetResult.node.kind === 'directory') {
      return closetResult.node;
    }
  } catch {
    // Wing root doesn't exist or can't be read
  }
  return null;
}

/**
 * Get the lair closet directory.
 * Returns null if it doesn't exist.
 */
async function getLairCloset(wing: Wing): Promise<Directory | null> {
  try {
    return await wing.lair.closet();
  } catch {
    return null;
  }
}

/**
 * Get all costume directories for a wing, overlaying wing closet on top of lair closet.
 *
 * The lair closet provides the base set of costumes. The wing closet (if it exists)
 * can override individual costumes by providing entries with the same name.
 * An empty wing closet provides no overrides, so all lair costumes show through.
 *
 * @param wing - The wing to get costumes for
 * @param options.includeSrcOverlay - When true, apply the work/local costumes src overlay
 *   (highest priority, for dev mode with a Vite TypeScript loader). Defaults to false.
 * @returns Map of costume name to DirectoryLike, with wing overrides applied
 */
export async function getOverlaidCostumeDirectories(
  wing: Wing,
  options?: { includeSrcOverlay?: boolean }
): Promise<Map<string, DirectoryLike>> {
  const costumes = new Map<string, DirectoryLike>();

  // Base layer: lair closet
  const lairCloset = await getLairCloset(wing);
  if (lairCloset) {
    try {
      for (const costume of await getCostumesFromCloset(lairCloset)) {
        costumes.set(costume.name, costume);
      }
    } catch {
      // Error reading lair closet, continue with empty base
    }
  }

  // Override layer: wing closet directory
  const wingCloset = await getWingCloset(wing);
  if (wingCloset) {
    try {
      for (const costume of await getCostumesFromCloset(wingCloset)) {
        costumes.set(costume.name, costume);
      }
    } catch {
      // Error reading wing closet, keep lair costumes
    }
  }

  // Override layer: work/local/costumes/*/src/ (highest priority — live dev source)
  // Only applies when a Vite TypeScript loader is available (dev mode). Never in production,
  // where native Node ESM cannot resolve @minions/* workspace imports from .ts source files.
  if (options?.includeSrcOverlay) {
    try {
      const devCostumes = await getWorkLocalCostumes(wing);
      for (const [name, dir] of devCostumes) {
        if (costumes.has(name)) {
          costumes.set(name, dir);
        }
      }
    } catch {
      // Error reading dev costumes, keep existing entries
    }
  }

  return costumes;
}

/**
 * @deprecated Use getOverlaidCostumeDirectories instead.
 * This function returns a single closet directory and does not support overlay.
 */
export async function getClosetDirectory(wing: Wing): Promise<Directory | null> {
  // Try Wing.closet() first (if it has a closet junction pointing to lair)
  try {
    const junction = await wing.closet();
    return junction as unknown as Directory;
  } catch {
    // Junction doesn't exist, try other locations
  }

  // Try wing.root/closet (debug install creates directory here)
  const root = wing.root;
  const closetResult = await root.child('closet');
  if (closetResult.found && closetResult.node.kind === 'directory') {
    return closetResult.node;
  }

  // Fallback: try lair.closet() directly
  try {
    const lairCloset = await wing.lair.closet();
    return lairCloset;
  } catch {
    // Lair closet doesn't exist either
  }

  return null;
}

/**
 * @deprecated Use getOverlaidCostumeDirectories instead.
 */
export async function getCostumeDirectories(
  closet: Directory
): Promise<DirectoryLike[]> {
  const children = await closet.children();
  const costumes: DirectoryLike[] = [];

  for (const child of children) {
    if (child.kind === 'directory' || child.kind === 'junction' || child.kind === 'worktree') {
      const result = await closet.child(child.name);
      if (result.found && (result.node.kind === 'directory' || result.node.kind === 'junction' || result.node.kind === 'worktree')) {
        costumes.push(result.node as DirectoryLike);
      }
    }
  }

  return costumes;
}

/**
 * Get the src directory from a costume directory.
 * Costumes follow the structure: costume/src/...
 *
 * @param costume - The costume directory
 * @returns The src directory, or undefined if not found
 */
export async function getCostumeSrcDirectory(
  costume: Directory
): Promise<Directory | undefined> {
  const srcResult = await costume.child('src');
  if (srcResult.found && srcResult.node.kind === 'directory') {
    return srcResult.node;
  }
  return undefined;
}

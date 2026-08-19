/**
 * Costume Management Operations
 *
 * Pure functions for installing, debug-installing, and listing costumes.
 * Operates on file-store abstractions (Directory, Wing, Junction).
 *
 * These functions were extracted from cabinet's CostumeService so that
 * both cabinet (MCP handlers) and conductor (mission context) can use them
 * without creating reverse dependencies.
 */

import type { Directory, DirectoryLike, Junction, Wing } from '@minions/file-store';
import { createDiskSandbox } from '@minions/file-store';

/**
 * Result of installing a costume (production or debug).
 */
export interface CostumeInstallResult {
  message: string;
  closetLink: Junction;
  commandsLink?: Junction;
  agentsLink?: Junction;
  skillsLink?: Junction;
}

/**
 * Summary of an installed costume in the closet.
 */
export interface InstalledCostumeSummary {
  name: string;
  isDebugInstalled: boolean;
  debugSourceWing?: string;
  debugSourcePath?: string;
  missions: string[];
  disguises: string[];
  skills: string[];
}

/**
 * Install a costume for production use by creating links to dist/.
 *
 * Installs to lair closet: <lair>/closet/<installed-name>
 * Creates .claude/ links in lair root.
 *
 * Creates:
 * 1. closet/<installed-name> -> wings/<dev-wing>/work/local/<path-to-source>/dist/
 * 2. .claude/commands/<installed-name> -> closet/<installed-name>/missions (if exists)
 * 3. .claude/agents/<installed-name> -> closet/<installed-name>/disguises (if exists)
 * 4. .claude/skills/<installed-name> -> closet/<installed-name>/skills (if exists)
 *
 * The costume must be built first (node scripts/build.cjs) to create the dist/ directory.
 */
export async function installCostume(
  lairRoot: Directory,
  sourceWingName: string,
  costumePath: string,
  installedName: string
): Promise<CostumeInstallResult> {
  if (!sourceWingName) {
    throw new Error('Source wing name is required');
  }

  if (!costumePath) {
    throw new Error('Costume path is required');
  }

  if (!installedName) {
    throw new Error('Installed name is required');
  }

  // Navigate to source wing's work/local
  const wingsDir = await requireDirectory(lairRoot, 'wings', 'Wings directory not found');
  const wingDir = await requireDirectory(wingsDir, sourceWingName, `Wing not found: ${sourceWingName}`);

  // Navigate to work/local/<costumePath>/dist (production build output)
  const costumeDist = await navigateToPath(wingDir, `work/local/${costumePath}/dist`);
  if (!costumeDist) {
    throw new Error(
      `Costume dist not found at: wings/${sourceWingName}/work/local/${costumePath}/dist. ` +
      `Run the costume build script first (node scripts/build.cjs).`
    );
  }

  // Install to lair closet
  const closetDir = await getOrCreateDirectory(lairRoot, 'closet');

  const claudeRoot = lairRoot;

  // Create the main closet junction (removes existing if present)
  const closetLink = await createJunctionSafe(closetDir, installedName, costumeDist);

  const result: CostumeInstallResult = {
    message: `Costume "${installedName}" installed to lair closet from ${sourceWingName}:${costumePath}/dist`,
    closetLink,
  };

  // Check for missions directory and create .claude/commands link
  const missionsResult = await closetLink.child('missions');
  if (missionsResult.found && (missionsResult.node.is('directory') || missionsResult.node.is('junction'))) {
    const claudeDir = await getOrCreateClaudeDir(claudeRoot);
    const commandsDir = await getOrCreateSubdir(claudeDir, 'commands');
    const commandsLink = await createJunctionSafe(commandsDir, installedName, missionsResult.node as DirectoryLike);
    result.commandsLink = commandsLink;
  }

  // Check for disguises directory and create .claude/agents link
  const disguisesResult = await closetLink.child('disguises');
  if (disguisesResult.found && (disguisesResult.node.is('directory') || disguisesResult.node.is('junction'))) {
    const claudeDir = await getOrCreateClaudeDir(claudeRoot);
    const agentsDir = await getOrCreateSubdir(claudeDir, 'agents');
    const agentsLink = await createJunctionSafe(agentsDir, installedName, disguisesResult.node as DirectoryLike);
    result.agentsLink = agentsLink;
  }

  // Check for skills directory and create .claude/skills link
  const skillsResult = await closetLink.child('skills');
  if (skillsResult.found && (skillsResult.node.is('directory') || skillsResult.node.is('junction'))) {
    const claudeDir = await getOrCreateClaudeDir(claudeRoot);
    const skillsDir = await getOrCreateSubdir(claudeDir, 'skills');
    const skillsLink = await createJunctionSafe(skillsDir, installedName, skillsResult.node as DirectoryLike);
    result.skillsLink = skillsLink;
  }

  return result;
}

/**
 * Debug install a costume by creating links from a wing's closet to a wing's work/local/src/.
 *
 * Installs to wing closet: <wing>/closet/<installed-name>
 * Creates .claude/ links in wing's work/local
 *
 * Creates:
 * 1. closet/<installed-name> -> wings/<dev-wing>/work/local/<path-to-source>/src/
 * 2. .claude/commands/<installed-name> -> closet/<installed-name>/missions (if exists)
 * 3. .claude/agents/<installed-name> -> closet/<installed-name>/disguises (if exists)
 * 4. .claude/skills/<installed-name> -> closet/<installed-name>/skills (if exists)
 */
export async function debugInstallCostume(
  lairRoot: Directory,
  sourceWingName: string,
  costumePath: string,
  installedName: string,
  targetWing: Wing
): Promise<CostumeInstallResult> {
  if (!sourceWingName) {
    throw new Error('Source wing name is required');
  }

  if (!costumePath) {
    throw new Error('Costume path is required');
  }

  if (!installedName) {
    throw new Error('Installed name is required');
  }

  // Navigate to source wing's work/local
  const wingsDir = await requireDirectory(lairRoot, 'wings', 'Wings directory not found');
  const wingDir = await requireDirectory(wingsDir, sourceWingName, `Wing not found: ${sourceWingName}`);

  // Navigate to work/local/<costumePath>/src
  const costumeSrc = await navigateToPath(wingDir, `work/local/${costumePath}/src`);
  if (!costumeSrc) {
    throw new Error(`Costume source not found at: wings/${sourceWingName}/work/local/${costumePath}/src`);
  }

  // Install to wing's root closet directory
  const wingRoot = targetWing.root;
  const closetDir = await getOrCreateClosetDir(wingRoot);

  // For .claude directory, use work/local if it exists, otherwise wing root.
  // Uses the design-doc-§4.2 `WorkArea` surface — `workAreaLocal()` throws
  // instead of returning `{ exists: false }` when there's no work/local
  // worktree.
  let claudeRoot: Directory = wingRoot;
  try {
    const workArea = await targetWing.workAreaLocal();
    const movement = await workArea.activeMovement();
    // `movement.files` is directory-like but not `Directory`; cast is safe
    // for `getOrCreateClaudeDir` (same cast the OLD `Worktree`-based code
    // already relied on).
    claudeRoot = movement.files as Directory;
  } catch {
    // No work/local worktree set up — fall back to wing root, matching the
    // OLD surface's `{ exists: false }` branch.
  }

  // Create the main closet junction (removes existing if present)
  const closetLink = await createJunctionSafe(closetDir, installedName, costumeSrc);

  const result: CostumeInstallResult = {
    message: `Costume "${installedName}" debug-installed to wing ${targetWing.name} closet from ${sourceWingName}:${costumePath}`,
    closetLink,
  };

  // Check for missions directory and create .claude/commands link
  const missionsResult = await closetLink.child('missions');
  if (missionsResult.found && (missionsResult.node.is('directory') || missionsResult.node.is('junction'))) {
    const claudeDir = await getOrCreateClaudeDir(claudeRoot);
    const commandsDir = await getOrCreateSubdir(claudeDir, 'commands');
    const commandsLink = await createJunctionSafe(commandsDir, installedName, missionsResult.node as DirectoryLike);
    result.commandsLink = commandsLink;
  }

  // Check for disguises directory and create .claude/agents link
  const disguisesResult = await closetLink.child('disguises');
  if (disguisesResult.found && (disguisesResult.node.is('directory') || disguisesResult.node.is('junction'))) {
    const claudeDir = await getOrCreateClaudeDir(claudeRoot);
    const agentsDir = await getOrCreateSubdir(claudeDir, 'agents');
    const agentsLink = await createJunctionSafe(agentsDir, installedName, disguisesResult.node as DirectoryLike);
    result.agentsLink = agentsLink;
  }

  // Check for skills directory and create .claude/skills link
  const skillsResult = await closetLink.child('skills');
  if (skillsResult.found && (skillsResult.node.is('directory') || skillsResult.node.is('junction'))) {
    const claudeDir = await getOrCreateClaudeDir(claudeRoot);
    const skillsDir = await getOrCreateSubdir(claudeDir, 'skills');
    const skillsLink = await createJunctionSafe(skillsDir, installedName, skillsResult.node as DirectoryLike);
    result.skillsLink = skillsLink;
  }

  return result;
}

/**
 * List all installed costumes in the closet.
 *
 * Returns information about each costume including:
 * - Whether it's debug-installed (junction) or package-installed (directory)
 * - For debug-installed: the source wing and path
 * - Contents: missions, disguises, and skills
 */
export async function listInstalledCostumes(
  lairRoot: Directory
): Promise<InstalledCostumeSummary[]> {
  const closetResult = await lairRoot.child('closet');
  if (!closetResult.found || !isDirectory(closetResult.node)) {
    return [];
  }

  const closetDir = closetResult.node as Directory;
  const children = await closetDir.children();
  const costumes: InstalledCostumeSummary[] = [];

  for (const child of children) {
    if (isDirectory(child)) {
      costumes.push(await buildCostumeSummary(child, lairRoot));
    } else if (isJunction(child)) {
      costumes.push(await buildCostumeSummary(child, lairRoot));
    }
  }

  return costumes;
}

/**
 * Result of installing a marketplace plugin as a costume.
 */
export interface MarketplaceCostumeInstallResult {
  message: string;
  closetPath: string;
  commandsPath?: string;
  agentsPath?: string;
  skillsPath?: string;
}

/**
 * Install a Claude Code marketplace plugin as a costume.
 *
 * Creates a junction from the lair closet to the plugin source directory so all
 * plugin component types (skills, agents, commands, hooks, MCP servers, etc.) are
 * accessible. Also creates .claude/ links for the standard component directories
 * so skills, agents, and commands are available without needing enabledPlugins.
 *
 * Creates:
 * 1. closet/<installed-name>  ->  <pluginSourcePath>  (junction to plugin root)
 * 2. .claude/skills/<installed-name>   -> closet/<installed-name>/skills   (if present)
 * 3. .claude/agents/<installed-name>   -> closet/<installed-name>/agents   (if present)
 * 4. .claude/commands/<installed-name> -> closet/<installed-name>/commands (if present)
 *
 * @param lairRoot - The lair root directory
 * @param installedName - Name for the costume in the closet
 * @param pluginSourcePath - Absolute path to the plugin directory (cache or marketplace clone)
 */
export async function installMarketplaceCostume(
  lairRoot: Directory,
  installedName: string,
  pluginSourcePath: string
): Promise<MarketplaceCostumeInstallResult> {
  if (!installedName) {
    throw new Error('Installed name is required');
  }
  if (!pluginSourcePath) {
    throw new Error('Plugin source path is required');
  }

  // Build a sandbox rooted at the plugin directory
  const pluginSandbox = createDiskSandbox(pluginSourcePath);
  const pluginRoot = pluginSandbox.root;

  // Create closet junction: closet/<installed-name> -> plugin root
  const closetDir = await getOrCreateDirectory(lairRoot, 'closet');
  const closetLink = await createJunctionSafe(closetDir, installedName, pluginRoot);

  const result: MarketplaceCostumeInstallResult = {
    message: `Plugin installed as costume "${installedName}" from ${pluginSourcePath}`,
    closetPath: closetLink.path,
  };

  const claudeDir = await getOrCreateClaudeDir(lairRoot);

  // .claude/skills/<installed-name> -> closet/<installed-name>/skills (if present)
  const skillsResult = await closetLink.child('skills');
  if (skillsResult.found && (skillsResult.node.is('directory') || skillsResult.node.is('junction'))) {
    const skillsDir = await getOrCreateSubdir(claudeDir, 'skills');
    const skillsLink = await createJunctionSafe(skillsDir, installedName, skillsResult.node as DirectoryLike);
    result.skillsPath = skillsLink.path;
  }

  // .claude/agents/<installed-name> -> closet/<installed-name>/agents (if present)
  const agentsResult = await closetLink.child('agents');
  if (agentsResult.found && (agentsResult.node.is('directory') || agentsResult.node.is('junction'))) {
    const agentsDir = await getOrCreateSubdir(claudeDir, 'agents');
    const agentsLink = await createJunctionSafe(agentsDir, installedName, agentsResult.node as DirectoryLike);
    result.agentsPath = agentsLink.path;
  }

  // .claude/commands/<installed-name> -> closet/<installed-name>/commands (if present)
  const commandsResult = await closetLink.child('commands');
  if (commandsResult.found && (commandsResult.node.is('directory') || commandsResult.node.is('junction'))) {
    const commandsDir = await getOrCreateSubdir(claudeDir, 'commands');
    const commandsLink = await createJunctionSafe(commandsDir, installedName, commandsResult.node as DirectoryLike);
    result.commandsPath = commandsLink.path;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Type check helpers that avoid the is() type guard narrowing issue
 * with compiled .d.ts union types.
 */
function isDirectory(node: { kind: string }): node is Directory {
  return node.kind === 'directory';
}

function isJunction(node: { kind: string }): node is Junction {
  return node.kind === 'junction';
}

/**
 * Navigate a path string through directory children.
 */
async function navigateToPath(
  start: DirectoryLike,
  pathStr: string
): Promise<DirectoryLike | null> {
  const parts = pathStr.split('/');
  let current: DirectoryLike = start;

  for (const part of parts) {
    const result = await current.child(part);
    if (!result.found) return null;
    current = result.node as DirectoryLike;
  }

  if (!current.isDirectoryLike()) {
    return null;
  }

  return current;
}

/**
 * Get a child directory or throw with the given message.
 */
async function requireDirectory(
  parent: DirectoryLike,
  name: string,
  errorMessage: string
): Promise<Directory> {
  const result = await parent.child(name);
  if (!result.found || !isDirectory(result.node)) {
    throw new Error(errorMessage);
  }
  return result.node;
}

/**
 * Get or create a directory child.
 */
async function getOrCreateDirectory(parent: Directory, name: string): Promise<Directory> {
  const result = await parent.child(name);
  if (result.found && isDirectory(result.node)) {
    return result.node;
  }
  return await parent.createDirectory(name);
}

/**
 * Get or create the closet directory in a wing root.
 * Handles the case where a junction exists (removes it first).
 */
async function getOrCreateClosetDir(wingRoot: Directory): Promise<Directory> {
  const closetResult = await wingRoot.child('closet');
  if (closetResult.found && isDirectory(closetResult.node)) {
    return closetResult.node;
  }
  if (closetResult.found && isJunction(closetResult.node)) {
    await closetResult.node.unlink();
  }
  return await wingRoot.createDirectory('closet');
}

/**
 * Get or create the .claude directory.
 */
async function getOrCreateClaudeDir(root: Directory): Promise<Directory> {
  return getOrCreateDirectory(root, '.claude');
}

/**
 * Get or create a subdirectory.
 */
async function getOrCreateSubdir(parent: Directory, name: string): Promise<Directory> {
  return getOrCreateDirectory(parent, name);
}

/**
 * Create a junction, removing existing one if present.
 */
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

  return await parent.createJunction(name, target);
}

async function buildCostumeSummary(
  costume: Directory | Junction,
  lairRoot: Directory
): Promise<InstalledCostumeSummary> {
  const name = costume.name;

  let isDebugInstalled = false;
  let debugSourceWing: string | undefined;
  let debugSourcePath: string | undefined;

  if (costume.is('junction')) {
    const junction = costume as Junction;
    const parsed = parseDebugSourcePath(junction.target.path, lairRoot.path);
    if (parsed) {
      isDebugInstalled = true;
      debugSourceWing = parsed.wingName;
      debugSourcePath = parsed.costumePath;
    }
  }

  const missions = await listSubdirectoryItems(costume, 'missions');
  const disguises = await listSubdirectoryItems(costume, 'disguises');
  const skills = await listSubdirectoryItems(costume, 'skills');

  return {
    name,
    isDebugInstalled,
    debugSourceWing,
    debugSourcePath,
    missions,
    disguises,
    skills,
  };
}

function parseDebugSourcePath(
  targetPath: string,
  lairRootPath: string
): { wingName: string; costumePath: string } | null {
  const normalizedTarget = targetPath.replace(/\\/g, '/');
  const normalizedLairRoot = lairRootPath.replace(/\\/g, '/');

  if (!normalizedTarget.startsWith(normalizedLairRoot)) {
    return null;
  }

  const relativePath = normalizedTarget.slice(normalizedLairRoot.length).replace(/^\//, '');

  const match = relativePath.match(/^wings\/([^/]+)\/work\/local\/(.+)\/src$/);
  if (!match) {
    return null;
  }

  return {
    wingName: match[1],
    costumePath: match[2],
  };
}

async function listSubdirectoryItems(
  costumeDir: DirectoryLike,
  subdirName: string
): Promise<string[]> {
  const subdirResult = await costumeDir.child(subdirName);
  if (!subdirResult.found) {
    return [];
  }

  const subdir = subdirResult.node;
  if (!subdir.isDirectoryLike()) {
    return [];
  }

  const children = await (subdir as DirectoryLike).children();
  const seen = new Set<string>();
  const items: string[] = [];

  for (const child of children) {
    if (child.is('file')) {
      const name = child.name;
      if (name.endsWith('.js.map') || name.endsWith('.d.ts')) {
        continue;
      }
      const dotIndex = name.lastIndexOf('.');
      const baseName = dotIndex > 0 ? name.slice(0, dotIndex) : name;
      if (!seen.has(baseName)) {
        seen.add(baseName);
        items.push(baseName);
      }
    } else {
      if (!seen.has(child.name)) {
        seen.add(child.name);
        items.push(child.name);
      }
    }
  }

  return items;
}

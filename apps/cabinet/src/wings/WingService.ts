import type { Directory, Wing, File as FileNode, WingName, RepoAlias, WorkArea } from '@minions/file-store';
import { WingManager } from './WingManager.js';

export interface ExtraWorkInfo {
  name: RepoAlias;
  path: string;
  /** Optional subdirectory within the worktree that is the effective entry point */
  subdir?: string;
}

export interface WingInfo {
  name: WingName;
  root: string;
  workLocal: string | null;
  workGlobal: string | null;
  privateLocal: string | null;
  privateGlobal: string | null;
  info: string | null;
  /** Additional named work directories beyond local/global */
  extraWork: ExtraWorkInfo[];
  repositories: {
    workLocal: string | null;
    workGlobal: string | null;
    privateLocal: string | null;
    privateGlobal: string | null;
  };
}

export interface CreateWingResult {
  message: string;
  wing: WingInfo;
}

export interface DeleteWingResult {
  message: string;
  deletedWing: string;
}

/**
 * `path`/`url` for a `workLocal`/`workGlobal`/`privateGlobal`-shaped field,
 * resolved via the design-doc-§4.2 `WorkArea` surface — mirrors
 * `lairStateService.ts`'s `resolveWorkAreaPathAndGitInfo`.
 * `privateLocal` is resolved separately: its shape is `Scratchpad`
 * (design doc §4.2/§4.5), which has no `repo` to recover a `url` from.
 */
async function resolveWorkAreaPathAndUrl(
  getWorkArea: () => Promise<WorkArea>,
): Promise<{ path: string | null; url: string | null }> {
  try {
    const workArea = await getWorkArea();
    const movement = await workArea.activeMovement();
    return { path: movement.files.path, url: workArea.repo.url };
  } catch {
    return { path: null, url: null };
  }
}

/**
 * Convert file-store Wing to WingInfo
 */
async function wingToInfo(wing: Wing): Promise<WingInfo> {
  // workLocal/workGlobal/privateGlobal resolve via `WorkArea`; privateLocal
  // is resolved separately — see `resolveWorkAreaPathAndUrl`'s doc comment.
  const [workLocalInfo, workGlobalInfo, privateLocalResult, privateGlobalInfo, namedWorkNames] = await Promise.all([
    resolveWorkAreaPathAndUrl(() => wing.workAreaLocal()),
    resolveWorkAreaPathAndUrl(() => wing.workAreaGlobal()),
    wing.privateLocal(),
    resolveWorkAreaPathAndUrl(() => wing.privateWorkAreaGlobal()),
    wing.namedWorkNames(),
  ]);

  let infoPath: string | null = null;
  try {
    const infoJunction = await wing.info();
    infoPath = infoJunction.path;
  } catch {
    // Info junction doesn't exist
  }

  const extraWorkResults = await Promise.all(
    namedWorkNames.map(async (name) => {
      // Only `name`/`path` are needed here (no gitInfo, unlike
      // `lairStateService.ts`'s equivalent loop) — `namedWorkPath()` (design
      // doc §4.2 growth point) covers every named-work backing kind,
      // including the plain-`junction` case, without exposing the raw
      // `Worktree`/`Junction` object this loop never needed.
      const path = await wing.namedWorkPath(name);
      if (!path) return null;
      return { name, path } satisfies ExtraWorkInfo;
    })
  );
  const extraWork = extraWorkResults.filter((e): e is ExtraWorkInfo => e !== null);

  return {
    name: wing.name,
    root: wing.root.path,
    workLocal: workLocalInfo.path,
    workGlobal: workGlobalInfo.path,
    privateLocal: privateLocalResult.exists ? privateLocalResult.worktree.path : null,
    privateGlobal: privateGlobalInfo.path,
    info: infoPath,
    extraWork,
    repositories: {
      workLocal: workLocalInfo.url,
      workGlobal: workGlobalInfo.url,
      privateLocal: privateLocalResult.exists ? privateLocalResult.worktree.repository.url : null,
      privateGlobal: privateGlobalInfo.url,
    }
  };
}

/**
 * Create a new wing with git worktrees
 */
export async function createWing(
  wingManager: WingManager,
  name: string,
  workLocalRepo: string,
  extraWork?: Record<string, { repo: string; branch: string }>,
  trunk?: string
): Promise<CreateWingResult> {
  if (!wingManager) {
    throw new Error('Wing manager not initialized');
  }

  // Compute branch name using pattern: l/{lair-name}/w/{wing-name}
  const workLocalBranch = `l/${wingManager.lairName}/w/${name}`;

  const wing = await wingManager.createWing({
    name,
    workLocalRepo,
    workLocalBranch,
    extraWork,
    trunk,
  });

  const wingInfo = await wingToInfo(wing);

  return {
    message: `Wing "${wing.name}" created successfully at ${wing.root.path}`,
    wing: wingInfo
  };
}

/**
 * Set (or, with `null`, clear) an existing wing's movement/plan trunk override.
 */
export async function setWingTrunk(
  wingManager: WingManager,
  name: string,
  trunk: string | null
): Promise<{ message: string; wing: WingInfo }> {
  if (!wingManager) {
    throw new Error('Wing manager not initialized');
  }
  await wingManager.setWingTrunk(name, trunk);
  const wing = wingManager.getWing(name);
  if (!wing) throw new Error(`Wing "${name}" not found`);
  const wingInfo = await wingToInfo(wing);
  return {
    message: trunk
      ? `Wing "${name}" trunk set to "${trunk}"`
      : `Wing "${name}" trunk override cleared`,
    wing: wingInfo,
  };
}

/**
 * Delete a wing and remove all its worktrees
 */
export async function deleteWing(
  wingManager: WingManager,
  name: string
): Promise<DeleteWingResult> {
  if (!wingManager) {
    throw new Error('Wing manager not initialized');
  }

  if (!name) {
    throw new Error('Wing name is required');
  }

  await wingManager.deleteWing(name);

  return {
    message: `Wing "${name}" deleted successfully`,
    deletedWing: name
  };
}

/**
 * Read CLAUDE.md file for a wing
 */
export async function readWingClaudeMd(
  wingsDir: Directory,
  wingName: string
): Promise<string> {
  if (!wingsDir) {
    throw new Error('Wings directory not initialized');
  }

  if (!wingName) {
    throw new Error('Wing name is required');
  }

  const wingResult = await wingsDir.child(wingName);
  if (!wingResult.found || !wingResult.node.is('directory')) {
    throw new Error(`Wing not found: ${wingName}`);
  }
  const wingDir = wingResult.node as Directory;

  const claudeMdResult = await wingDir.child('CLAUDE.md');
  if (!claudeMdResult.found || !claudeMdResult.node.is('file')) {
    throw new Error(`CLAUDE.md not found for wing: ${wingName}`);
  }

  return await (claudeMdResult.node as FileNode).read();
}

/**
 * Write/update CLAUDE.md file for a wing
 */
export async function writeWingClaudeMd(
  wingsDir: Directory,
  wingName: string,
  content: string
): Promise<string> {
  if (!wingsDir) {
    throw new Error('Wings directory not initialized');
  }

  if (!wingName || content === undefined) {
    throw new Error('Wing name and content are required');
  }

  const wingResult = await wingsDir.child(wingName);
  if (!wingResult.found || !wingResult.node.is('directory')) {
    throw new Error(`Wing not found: ${wingName}`);
  }
  const wingDir = wingResult.node as Directory;

  // Try to get existing file or create new one
  const claudeMdResult = await wingDir.child('CLAUDE.md');
  if (claudeMdResult.found && claudeMdResult.node.is('file')) {
    await (claudeMdResult.node as FileNode).write(content);
  } else {
    await wingDir.createFile('CLAUDE.md', content);
  }

  return `Wing CLAUDE.md updated successfully for "${wingName}"`;
}

export interface ReprovisionHooksResult {
  message: string;
  wings: string[];
}

/**
 * Reprovision the tool log hook for one or all existing wings.
 * Idempotent — safe to run on already-provisioned wings.
 */
export async function reprovisionWingHooks(
  wingManager: WingManager,
  wingName?: string,
): Promise<ReprovisionHooksResult> {
  if (!wingManager) {
    throw new Error('Wing manager not initialized');
  }
  await wingManager.reprovisionHooks(wingName);
  const affectedWings = wingName
    ? [wingName]
    : wingManager.getWings().map((w) => w.name);
  return {
    message: wingName
      ? `Tool log hook reprovisioned for wing "${wingName}"`
      : `Tool log hook reprovisioned for ${affectedWings.length} wing(s)`,
    wings: affectedWings,
  };
}

export interface UpdateWingWorkResult {
  message: string;
  wing: WingInfo;
}

/**
 * Update the work directory mappings of an existing wing.
 * Can add new named work dirs and/or remove existing ones without destroying the wing.
 */
export async function updateWingWork(
  wingManager: WingManager,
  name: string,
  add?: Record<string, { repo: string; branch: string; subdir?: string }>,
  remove?: string[]
): Promise<UpdateWingWorkResult> {
  if (!wingManager) {
    throw new Error('Wing manager not initialized');
  }
  if (!name) {
    throw new Error('Wing name is required');
  }

  await wingManager.updateWingWork(name, add, remove);

  const wing = wingManager.getWing(name);
  if (!wing) {
    throw new Error(`Wing "${name}" not found after update`);
  }

  const wingInfo = await wingToInfo(wing);
  return {
    message: `Wing "${name}" work mappings updated successfully`,
    wing: wingInfo,
  };
}

export interface SyncWingResult {
  message: string;
  synced: string[];
}

/**
 * Re-apply all provisioned wing files (CLAUDE.md, .mcp.json, .claude/settings.json,
 * tool log hook) for all wings or a single named wing.
 */
export async function syncWing(
  wingManager: WingManager,
  name?: string
): Promise<SyncWingResult> {
  if (!wingManager) {
    throw new Error('Wing manager not initialized');
  }

  const synced = await wingManager.syncWing(name);

  return {
    message: synced.length === 1
      ? `Wing "${synced[0]}" synced`
      : `${synced.length} wings synced: ${synced.join(', ')}`,
    synced,
  };
}

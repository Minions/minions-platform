import type { Lair, CloneAuth } from '@minions/file-store';
import { asLairRepoName } from '@minions/file-store';
import { LairRepoPerspective } from '@minions/repo-perspective';

export interface ArchiveInfo {
  name: string;
  type: string;
  path: string;
  remoteUrl?: string;
}

export interface ListArchivesResult {
  archives: ArchiveInfo[];
}

export interface AddArchiveResult {
  message: string;
  archive: ArchiveInfo;
}

export interface RemoveArchiveResult {
  message: string;
  removedArchive: string;
}

/**
 * List all archives in the lair (work, info, and private git repositories)
 */
export async function listArchives(
  lair: Lair
): Promise<ListArchivesResult> {
  if (!lair) {
    throw new Error('Lair not initialized');
  }

  const archives: ArchiveInfo[] = [];

  // Get work repos (bare repos)
  const workRepos = await lair.workRepos();
  for (const repo of workRepos) {
    archives.push({
      name: repo.name.replace(/\.git$/, ''),
      type: 'work',
      path: repo.path,
      remoteUrl: repo.url ?? undefined
    });
  }

  // Get info repos (read-only clones)
  const infoRepos = await lair.infoRepos();
  for (const clone of infoRepos) {
    archives.push({
      name: clone.name,
      type: 'info',
      path: clone.path,
      remoteUrl: clone.url
    });
  }

  // Get private repos (local and global)
  const privateLocalResult = await lair.privateRepo('local');
  if (privateLocalResult.exists) {
    archives.push({
      name: 'local',
      type: 'private',
      path: privateLocalResult.repo.path,
      remoteUrl: privateLocalResult.repo.url ?? undefined
    });
  }

  const privateGlobalResult = await lair.privateRepo('global');
  if (privateGlobalResult.exists) {
    archives.push({
      name: 'global',
      type: 'private',
      path: privateGlobalResult.repo.path,
      remoteUrl: privateGlobalResult.repo.url ?? undefined
    });
  }

  return { archives };
}

/**
 * Add a new archive to the lair (clone git repo or create directory)
 *
 * @param lair - The lair to add the archive to
 * @param type - Archive type: work, info, or private
 * @param name - Name for the archive
 * @param url - Git URL (required for work/info)
 * @param auth - Optional authentication credentials for private repos
 * @param branch - Optional branch to checkout (info archives only, ignored for work/private)
 */
export async function addArchive(
  lair: Lair,
  type: 'work' | 'info' | 'private',
  name: string,
  url?: string,
  auth?: CloneAuth,
  branch?: string
): Promise<AddArchiveResult> {
  if (!lair) {
    throw new Error('Lair not initialized');
  }

  if (!type || !name) {
    throw new Error('Archive type and name are required');
  }

  // Validate URL for work/info archives
  if ((type === 'work' || type === 'info') && !url) {
    throw new Error(`URL is required for ${type} archives`);
  }

  let archiveInfo: ArchiveInfo;

  if (type === 'work') {
    const repo = await lair.addWorkRepo(name, url as string, auth);
    try {
      // Eagerly materializes the repo's plan/main mirror worktree so it's
      // ready for immediate use — a newly-registered repo should be
      // immediately queryable (unlike the conductor-mirror-adjacent startup
      // calls in server.ts, which don't need this because conductor state
      // isn't resolved until something actually writes to it).
      // `LairRepoPerspective.resolve` already constructs a
      // `Trunk.mirror(...)` and its `.worktree` is a lazy proxy (Disk) /
      // already-real worktree (InMemory) — touching a cheap read
      // (`.children()`) forces the real worktree to exist synchronously
      // from this call's point of view.
      // This same worktree is also where conductor state
      // (`.meta/conductor/experiments.json`) lives once anything actually
      // writes to it — see `@minions/repo-perspective`'s
      // `resolveConductorMirror`. No separate conductor mirror bootstrap is
      // needed; this one `.children()` touch materializes the shared
      // worktree for both.
      const perspective = await LairRepoPerspective.resolve(lair, asLairRepoName(name));
      await perspective.worktree.children();
    } catch {
      // Best-effort: a repo whose mirror bootstrap fails here is picked up
      // lazily by the first real `plan`/`experiments` action call against it
      // instead of blocking registration.
    }
    archiveInfo = {
      name: repo.name.replace(/\.git$/, ''),
      type: 'work',
      path: repo.path,
      remoteUrl: repo.url ?? undefined
    };
  } else if (type === 'info') {
    const clone = await lair.addInfoRepo(name, url as string, auth, branch);
    archiveInfo = {
      name: clone.name,
      type: 'info',
      path: clone.path,
      remoteUrl: clone.url
    };
  } else if (type === 'private') {
    if (name !== 'local' && name !== 'global') {
      throw new Error('Private archives can only be named "local" or "global"');
    }
    const repo = await lair.initPrivateRepo(name as 'local' | 'global');
    archiveInfo = {
      name,
      type: 'private',
      path: repo.path,
      remoteUrl: undefined
    };
  } else {
    throw new Error('Invalid archive type. Must be "work", "info", or "private"');
  }

  return {
    message: `Archive "${name}" added successfully to ${type}/`,
    archive: archiveInfo
  };
}

/**
 * Remove an archive from the lair
 */
export async function removeArchive(
  lair: Lair,
  type: 'work' | 'info' | 'private',
  name: string
): Promise<RemoveArchiveResult> {
  if (!lair) {
    throw new Error('Lair not initialized');
  }

  if (!type || !name) {
    throw new Error('Archive type and name are required');
  }

  if (type === 'work') {
    const repoResult = await lair.workRepo(name);
    if (!repoResult.exists) {
      throw new Error(`Archive "${name}" not found in ${type}/`);
    }
    await repoResult.repo.delete();
  } else if (type === 'info') {
    const repoResult = await lair.infoRepo(name);
    if (!repoResult.exists) {
      throw new Error(`Archive "${name}" not found in ${type}/`);
    }
    await repoResult.clone.delete();
  } else if (type === 'private') {
    if (name !== 'local' && name !== 'global') {
      throw new Error('Private archives can only be named "local" or "global"');
    }
    const repoResult = await lair.privateRepo(name as 'local' | 'global');
    if (!repoResult.exists) {
      throw new Error(`Archive "${name}" not found in ${type}/`);
    }
    await repoResult.repo.delete();
  } else {
    throw new Error('Invalid archive type. Must be "work", "info", or "private"');
  }

  return {
    message: `Archive "${name}" removed from ${type}/`,
    removedArchive: name
  };
}

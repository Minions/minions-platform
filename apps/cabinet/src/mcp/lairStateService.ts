import { WingManager } from '../wings/WingManager.js';
import type { Wing, WorktreeResult, ReadOnlyClone, Worktree, WingName, RepoAlias, LairRepoName, WorkArea } from '@minions/file-store';

export interface WorktreeGitInfo {
  bareRepoDir: string | null;
  origin: string | null;
}

export interface InfoRepo {
  name: string;
  origin: string | null;
}

export interface ExtraWorkStateEntry {
  name: RepoAlias;
  path: string;
  gitInfo: WorktreeGitInfo | null;
}

export interface LairState {
  lairName: string;
  wings: Array<{
    name: WingName;
    root: string;
    workLocal: string | null;
    workGlobal: string | null;
    privateLocal: string | null;
    privateGlobal: string | null;
    info: string | null;
    extraWork: ExtraWorkStateEntry[];
    worktreeGitInfo: {
      workLocal: WorktreeGitInfo | null;
      workGlobal: WorktreeGitInfo | null;
      privateLocal: WorktreeGitInfo | null;
      privateGlobal: WorktreeGitInfo | null;
    };
    infoRepos: InfoRepo[];
  }>;
  availableWorkRepos: LairRepoName[];
}

/**
 * Get git information for a worktree from file-store WorktreeResult.
 * Used for `privateLocal` (see `resolveWorkAreaPathAndGitInfo`'s doc comment
 * on why that field is resolved this way) and for named work's
 * junction-vs-worktree distinction.
 */
function getWorktreeGitInfo(worktreeResult: WorktreeResult): WorktreeGitInfo | null {
  if (!worktreeResult.exists) {
    return null;
  }
  const worktree = worktreeResult.worktree;
  return {
    bareRepoDir: worktree.repository.path,
    origin: worktree.repository.url
  };
}

/**
 * `path`/`gitInfo` for a `workLocal`/`workGlobal`/`privateGlobal`-shaped
 * field, resolved via the `WorkArea` surface. `workAreaLocal()`/
 * `workAreaGlobal()`/`privateWorkAreaGlobal()` throw instead of returning
 * `{ exists: false }` when the worktree isn't set up — caught here and
 * normalized to a `null`/`null` shape, so callers see consistent output.
 *
 * `privateLocal` deliberately does NOT go through this function: its shape
 * is `Scratchpad`, which exposes `files` but no `repo` — there is no
 * lossless way to recover `bareRepoDir`/`origin` from it. It's resolved via
 * `wing.privateLocal()` + `getWorktreeGitInfo` below instead.
 */
async function resolveWorkAreaPathAndGitInfo(
  getWorkArea: () => Promise<WorkArea>,
): Promise<{ path: string | null; gitInfo: WorktreeGitInfo | null }> {
  try {
    const workArea = await getWorkArea();
    const movement = await workArea.activeMovement();
    return {
      path: movement.files.path,
      gitInfo: { bareRepoDir: workArea.repo.path, origin: workArea.repo.url },
    };
  } catch {
    return { path: null, gitInfo: null };
  }
}

/**
 * Get git information for a named work entry (worktree, junction, or junction-worktree),
 * via the `WorkArea` surface. Junction-only entries (same-repo subdir)
 * resolve to `undefined` here — `workAreaNamed()` has no `BareRepository`
 * to attach a `Trunk`/`Movement` to for that case — which correctly yields
 * `null` gitInfo, since there is no separate bare repo to report.
 */
async function getNamedWorkGitInfo(wing: Wing, name: RepoAlias): Promise<WorktreeGitInfo | null> {
  const workArea = await wing.workAreaNamed(name);
  if (!workArea) return null;
  return {
    bareRepoDir: workArea.repo.path,
    origin: workArea.repo.url,
  };
}

/**
 * Get all git repos in the info directory
 */
async function getInfoRepos(wing: Wing): Promise<InfoRepo[]> {
  try {
    const infoJunction = await wing.info();
    const children = await infoJunction.children();

    const repos: InfoRepo[] = [];

    for (const child of children) {
      // Check if it's a read-only clone or worktree (both are git repos)
      if (child.is('read-only-clone')) {
        const clone = child as ReadOnlyClone;
        repos.push({
          name: clone.name,
          origin: clone.url
        });
      } else if (child.is('worktree')) {
        const worktree = child as Worktree;
        repos.push({
          name: worktree.name,
          origin: worktree.repository.url
        });
      }
    }

    return repos;
  } catch {
    // Info junction doesn't exist or other error
    return [];
  }
}

/**
 * Get complete lair state including wings, paths, and available repositories
 */
export async function getLairState(
  wingManager: WingManager
): Promise<LairState> {
  const wings = wingManager.getWings();
  const availableWorkRepos = await wingManager.getAvailableWorkRepos();
  const lairName = wingManager.lairName;

  // Gather git information for all wings in parallel
  const wingsWithGitInfo = await Promise.all(
    wings.map(async (wing: Wing) => {
      // workLocal/workGlobal/privateGlobal resolve via the `WorkArea`
      // surface; privateLocal is resolved separately — see
      // `resolveWorkAreaPathAndGitInfo`'s doc comment for why (Scratchpad
      // has no `repo` to report gitInfo from).
      const [workLocalInfo, workGlobalInfo, privateLocalResult, privateGlobalInfo, namedWorkNames] = await Promise.all([
        resolveWorkAreaPathAndGitInfo(() => wing.workAreaLocal()),
        resolveWorkAreaPathAndGitInfo(() => wing.workAreaGlobal()),
        wing.privateLocal(),
        resolveWorkAreaPathAndGitInfo(() => wing.privateWorkAreaGlobal()),
        wing.namedWorkNames(),
      ]);

      // Get extra named work info in parallel — via `namedWorkPath()`/
      // `workAreaNamed()`; see `getNamedWorkGitInfo`'s doc comment for why
      // the junction-only case comes out `null`.
      const extraWorkResults = await Promise.all(
        namedWorkNames.map(async (name) => {
          const path = await wing.namedWorkPath(name);
          if (!path) return null;
          return {
            name,
            path,
            gitInfo: await getNamedWorkGitInfo(wing, name),
          } satisfies ExtraWorkStateEntry;
        })
      );
      const extraWork = extraWorkResults.filter((e): e is ExtraWorkStateEntry => e !== null);

      // Get info path (junction's own path)
      let infoPath: string | null = null;
      try {
        const infoJunction = await wing.info();
        infoPath = infoJunction.path;
      } catch {
        // Info junction doesn't exist
      }

      // Get info repos
      const infoRepos = await getInfoRepos(wing);

      return {
        name: wing.name,
        root: wing.root.path,
        // Include actual paths
        workLocal: workLocalInfo.path,
        workGlobal: workGlobalInfo.path,
        privateLocal: privateLocalResult.exists ? privateLocalResult.worktree.path : null,
        privateGlobal: privateGlobalInfo.path,
        info: infoPath,
        extraWork,
        // Include git information for worktrees
        worktreeGitInfo: {
          workLocal: workLocalInfo.gitInfo,
          workGlobal: workGlobalInfo.gitInfo,
          privateLocal: getWorktreeGitInfo(privateLocalResult),
          privateGlobal: privateGlobalInfo.gitInfo
        },
        // Include info repos
        infoRepos
      };
    })
  );

  return {
    lairName,
    wings: wingsWithGitInfo,
    availableWorkRepos
  };
}

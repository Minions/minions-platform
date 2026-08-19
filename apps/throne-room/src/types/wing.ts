export interface WorktreeGitInfo {
  bareRepoDir: string | null;
  origin: string | null;
}

export interface InfoRepo {
  name: string;
  origin: string | null;
}

export interface ExtraWorkEntry {
  name: string;
  path: string;
  gitInfo?: WorktreeGitInfo | null;
}

export interface Wing {
  name: string;
  root: string;
  workLocal?: string;
  workGlobal?: string | null;
  privateLocal?: string;
  privateGlobal?: string;
  info?: string;
  /** Additional named work directories beyond local/global */
  extraWork?: ExtraWorkEntry[];
  worktreeGitInfo?: {
    workLocal?: WorktreeGitInfo | null;
    workGlobal?: WorktreeGitInfo | null;
    privateLocal?: WorktreeGitInfo | null;
    privateGlobal?: WorktreeGitInfo | null;
  };
  infoRepos?: InfoRepo[];
}

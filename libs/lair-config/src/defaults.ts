import type { LairConfig } from './types.js';

export const DEFAULT_PLANNING_BRANCH = 'main';
export const DEFAULT_PLANNING_PATH = 'plans/';
export const DEFAULT_POST_INSTALL_MISSION = `Welcome to your new lair!

Please review the project structure and familiarise yourself with the codebase.
Start by reading any README or documentation files you find.`;

/**
 * Apply defaults to a partially-specified raw config object,
 * given the primary repo URL (used to derive the lair name and planning repo).
 */
export function applyDefaults(
  raw: Partial<RawLairConfig>,
  primaryRepoUrl: string,
): LairConfig {
  const repoName = inferRepoName(primaryRepoUrl);

  const lairName = raw.lair_name ?? repoName;

  const planning = {
    repo: raw.planning?.repo ?? primaryRepoUrl,
    branch: raw.planning?.branch ?? DEFAULT_PLANNING_BRANCH,
    path: raw.planning?.path ?? DEFAULT_PLANNING_PATH,
  };

  const workArchives = raw.work_archives ?? [{ name: 'local', url: primaryRepoUrl }];
  const infoArchives = raw.info_archives ?? [];

  return {
    lairName,
    planning,
    workArchives,
    infoArchives,
    postInstallMission: null,
  };
}

export function inferRepoName(url: string): string {
  const match = url.match(/\/([^/]+?)(?:\.git)?$/);
  return match?.[1] ?? 'my-lair';
}

/** Raw YAML front-matter shape (snake_case, as written in the config file) */
export interface RawLairConfig {
  lair_name?: string;
  planning?: {
    repo?: string;
    branch?: string;
    path?: string;
  };
  work_archives?: Array<{ name: string; url: string; branch?: string }>;
  info_archives?: Array<{ name: string; url: string; branch?: string }>;
}

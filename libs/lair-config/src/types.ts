export interface PlanningConfig {
  repo: string;
  branch: string;
  path: string;
}

export interface ArchiveConfig {
  name: string;
  url: string;
  branch?: string;
}

export interface LairConfig {
  /** Human-readable name for the lair */
  lairName: string;
  /** Planning repository configuration */
  planning: PlanningConfig;
  /** Work archives to clone */
  workArchives: ArchiveConfig[];
  /** Info (read-only) archives to clone */
  infoArchives: ArchiveConfig[];
  /** Body of the post-install mission, or null if not present */
  postInstallMission: string | null;
}

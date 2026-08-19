export interface Env {
  ARCHIVE_BUCKET: R2Bucket;
  GITHUB_APP_ID: string;
  GITHUB_PRIVATE_KEY: string;
  GITHUB_INSTALLATION_ID: string;
  /** owner/repo of the index GitHub repo, e.g. "codewarp/costume-registry" */
  INDEX_REPO: string;
}

export interface IndexEntry {
  version: string;
  url: string;
  digest: string;
  publishedAt: string;
  yanked: boolean;
  isPreview: boolean;
  publisher: string;
  yankReason?: string;
  yankedAt?: string;
  replacedAt?: string;
}

export interface PackageOwner {
  github: string;
  claimedAt: string;
}

export interface Config {
  schemaVersion: 1;
  packageOwners: Record<string, PackageOwner>;
}

export interface GitHubUser {
  login: string;
  id: number;
}

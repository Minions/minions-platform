/**
 * Costume Registry Types
 *
 * Types for the costume package registry system.
 * Registries are hosted as static files on GitHub (index) + provider-agnostic archives.
 */

/**
 * Authentication configuration for a private registry.
 * The token value is read from the specified environment variable at runtime.
 */
export interface RegistryAuth {
  type: 'github-token';
  /** Name of the environment variable holding the GitHub token */
  envVar: string;
}

/**
 * Configuration for a single registry, stored in cabinet.config.json.
 */
export interface RegistryConfig {
  /**
   * Base URL for fetching index files.
   * Index files are at: {indexBaseUrl}/index/{name}.json
   * e.g. "https://raw.githubusercontent.com/codewarp/costume-registry/main"
   */
  indexBaseUrl: string;
  /**
   * URL of the publish API (Cloudflare Worker) for the publishApi path.
   * When set, costumes are published by POSTing to this Worker.
   * e.g. "https://costume-registry.codewarp.workers.dev"
   */
  publishApi?: string;
  /**
   * Direct GitHub publishing config for the publishDirect path.
   * When set, the cabinet writes directly to GitHub via the Contents API.
   * indexRepo: GitHub "owner/repo" of the index repository.
   */
  publishDirect?: { indexRepo: string };
  /** Optional auth for private registries (install-time, not publish-time) */
  auth?: RegistryAuth;
}

/**
 * Full cabinet configuration (cabinet.config.json).
 */
export interface CabinetConfig {
  port: number;
  /** Named registries available for costume install/publish */
  registries?: Record<string, RegistryConfig>;
  /** Registry to use when no registry is specified in an install command */
  defaultRegistry?: string;
  /** Stored GitHub OAuth token obtained via device flow */
  githubAuth?: {
    token: string;
    /** GitHub username of the authenticated user */
    connectedAs: string;
    /** ISO timestamp of when the token was obtained */
    connectedAt: string;
  };
  /** GitHub App configuration for device flow auth */
  githubApp?: {
    clientId: string;
  };
  /**
   * Persisted state of this lair's shared verification browser. Records the port
   * the shared Chrome was last launched on and its CDP browser identity, so the
   * cabinet can recognize (and only reuse) its own lair's Chrome.
   */
  sharedBrowser?: {
    port: number;
    /** CDP browser GUID, stable for the life of that Chrome process. */
    browserId: string;
  };
}

/**
 * One version entry in a per-package index file (index/{name}.json).
 * Each entry is one JSON line (JSON Lines format).
 */
export interface RegistryIndexEntry {
  version: string;
  /** SHA-256 digest of the archive: "sha256:<hex>" */
  digest: string;
  /** Full URL to the archive file (provider-agnostic) */
  url: string;
  /** GitHub username of the publisher */
  publisher?: string;
  publishedAt: string;
  yanked: boolean;
  yankReason?: string;
  yankedAt?: string;
  isPreview: boolean;
  /** ISO timestamp of most recent re-publish (preview versions only) */
  replacedAt?: string;
}

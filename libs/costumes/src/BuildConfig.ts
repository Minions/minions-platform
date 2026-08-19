/**
 * Build Configuration (build.json schema)
 *
 * BuildConfig defines how a costume's src/ directory is transformed into
 * dist/ for production installation. It lives alongside costume.json in
 * the costume's src/ directory.
 *
 * Strategies:
 * - "copy": Copies src/ to dist/ recursively. Simple costumes with
 *   only markdown, JSON, and static files use this.
 * - "bundle": Uses esbuild to bundle TypeScript files, copies everything
 *   else. Costumes with TypeScript missions or event files use this.
 */

/**
 * Build configuration loaded from build.json
 */
export interface BuildConfig {
  /** Build strategy: copy everything or bundle TypeScript */
  strategy: 'copy' | 'bundle';

  /**
   * Bundle-specific configuration (only used when strategy is 'bundle')
   */
  bundle?: {
    /**
     * Directories containing TypeScript files to bundle.
     * Each .ts file becomes a separate bundle output.
     * Defaults to ['missions'] if not specified.
     */
    bundleDirs?: string[];

    /**
     * Packages to treat as external (not bundled).
     * Node built-ins are always external.
     * Defaults to ['@modelcontextprotocol/*']
     */
    external?: string[];
  };
}

/**
 * Type guard for BuildConfig
 */
export function isBuildConfig(value: unknown): value is BuildConfig {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;

  // Required: strategy must be 'copy' or 'bundle'
  if (obj.strategy !== 'copy' && obj.strategy !== 'bundle') {
    return false;
  }

  // Optional: bundle config
  if (obj.bundle !== undefined) {
    if (typeof obj.bundle !== 'object' || obj.bundle === null) return false;
    const bundle = obj.bundle as Record<string, unknown>;

    if (bundle.bundleDirs !== undefined) {
      if (!Array.isArray(bundle.bundleDirs)) return false;
      if (!bundle.bundleDirs.every((d: unknown) => typeof d === 'string')) return false;
    }

    if (bundle.external !== undefined) {
      if (!Array.isArray(bundle.external)) return false;
      if (!bundle.external.every((e: unknown) => typeof e === 'string')) return false;
    }
  }

  return true;
}

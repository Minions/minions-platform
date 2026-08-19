/**
 * Resolves the Vite package the build signal should import — the target
 * work repo's own installed copy, not one bundled into Cabinet itself.
 *
 * Vite's own internal `import.meta.url`-relative lookups (its own
 * package.json for the version banner, its default config-file list)
 * assume the real, deeply-nested `node_modules/vite/dist/node/chunks/...`
 * layout it ships with — Cabinet's flattened esbuild bundle breaks that
 * (observed: an ENOENT reading a package.json outside the lair, then
 * `DEFAULT_CONFIG_FILES is not iterable`). See resolveWorkRepoPackage.ts
 * for the shared cascade this builds on, and its rationale in full.
 */

import { resolveWorkRepoPackageEntry, defaultResolvePackage, type PackageEntryResolution, type PackageResolver } from './resolveWorkRepoPackage.js';

/** Inclusive major-version range this adapter's `build()`/RollupWatcher event handling has been built and tested against. */
export const MIN_SUPPORTED_VITE_MAJOR = 4;
export const MAX_SUPPORTED_VITE_MAJOR = 8;

export type ViteResolution = PackageEntryResolution;
export type { PackageResolver };

export function resolveWorkRepoVite(cwd: string, resolvePackage: PackageResolver = defaultResolvePackage): Promise<ViteResolution> {
  return resolveWorkRepoPackageEntry(
    cwd,
    {
      packageName: 'vite',
      signalName: 'build',
      minSupportedMajor: MIN_SUPPORTED_VITE_MAJOR,
      maxSupportedMajor: MAX_SUPPORTED_VITE_MAJOR,
      entryRelPath: (pkg) => (pkg.module as string | undefined) ?? (pkg.main as string | undefined) ?? 'dist/node/index.js',
    },
    resolvePackage
  );
}

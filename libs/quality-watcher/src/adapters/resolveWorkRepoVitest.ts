/**
 * Resolves the Vitest package the tests signal should import — the target
 * work repo's own installed copy, not one bundled into Cabinet itself.
 *
 * Cabinet's production build flattens its dependencies into a single
 * esbuild file (tools/runtime/main.js), which does not include Vitest —
 * it's a devDependency of Cabinet, dropped from the production bundle.
 * Importing a bare `vitest/node` specifier from that bundle fails with
 * `ERR_MODULE_NOT_FOUND` in production, even though it works in dev (where
 * Cabinet's own node_modules has it). See resolveWorkRepoPackage.ts for the
 * shared cascade this builds on, and its rationale in full.
 *
 * Resolved once for the whole watched work repo root (all discovered
 * project directories run inside one shared Vitest instance via
 * `test.projects` — see VitestSignalRunner), not per project directory. A
 * repo can have zero Vitest projects at all (e.g. one that's entirely
 * Go/Python), in which case there's nothing to import.
 */

import { resolveWorkRepoPackageEntry, defaultResolvePackage, type PackageEntryResolution, type PackageResolver } from './resolveWorkRepoPackage.js';

/** Inclusive major-version range this adapter's reporter (onTestRunStart/onTestRunEnd, TestModule) has been built and tested against. */
export const MIN_SUPPORTED_VITEST_MAJOR = 2;
export const MAX_SUPPORTED_VITEST_MAJOR = 4;

export type VitestResolution = PackageEntryResolution;
export type { PackageResolver };

export function resolveWorkRepoVitest(cwd: string, resolvePackage: PackageResolver = defaultResolvePackage): Promise<VitestResolution> {
  return resolveWorkRepoPackageEntry(
    cwd,
    {
      packageName: 'vitest',
      signalName: 'tests',
      minSupportedMajor: MIN_SUPPORTED_VITEST_MAJOR,
      maxSupportedMajor: MAX_SUPPORTED_VITEST_MAJOR,
      entryRelPath: (pkg) => {
        const exports = pkg.exports as { './node'?: { default?: string; import?: { default?: string } } } | undefined;
        return exports?.['./node']?.default ?? exports?.['./node']?.import?.default ?? 'dist/node.js';
      },
    },
    resolvePackage
  );
}

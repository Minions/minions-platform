/**
 * Whether `cwd` actually has a root-level Vite build to run, distinct from
 * whether the `vite` package merely *resolves* from there (see
 * `resolveWorkRepoVite.ts`). In an nx/pnpm monorepo, `vite` is commonly a
 * hoisted devDependency used by per-app configs nested under `apps/*` —
 * resolvable from the work repo root even though the root itself has no
 * buildable Vite project (no root `vite.config.*`, no root `index.html`).
 * Calling Vite's `build()` in that case fails with `UNRESOLVED_ENTRY`
 * instead of reporting the "nothing to build here" pass every other signal
 * gives for an absent config (see runCustomLint's `NO_CUSTOM_RULES`
 * convention, which this mirrors).
 */
import { createDiskSandbox, type Directory } from '@minions/file-store';

const VITE_CONFIG_FILENAMES = [
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.mts',
  'vite.config.cjs',
  'vite.config.cts',
];

export async function hasBuildableViteEntry(cwd: string, dir: Directory = createDiskSandbox(cwd).root): Promise<boolean> {
  for (const filename of VITE_CONFIG_FILENAMES) {
    const result = await dir.child(filename);
    if (result.found) return true;
  }
  const indexHtml = await dir.child('index.html');
  return indexHtml.found;
}

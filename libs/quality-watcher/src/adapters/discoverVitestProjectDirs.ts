/**
 * Finds every directory under `rootDir` that looks like an independent
 * Vitest project (has its own `vite.config.*` or `vitest.config.*`).
 *
 * Fed into Vitest's own `test.projects` (see VitestSignalRunner) so one
 * shared Vitest instance runs every discovered project. An older version of
 * this file avoided `test.projects` entirely, starting one fully separate
 * Vitest instance per directory instead — worked around long-standing
 * Vitest bugs (e.g. vitest-dev/vitest#5734, #7964) where mixing
 * Node-environment and browser/jsdom-environment projects in one process
 * leaked one project's Node-builtin externalization rules into another's,
 * breaking things like `util.promisify` and Vue component mounting. Vitest
 * 4's module-loading rewrite (vite-node → module-runner) fixed this —
 * confirmed live against this repo's actual mixed node/jsdom projects,
 * thousands of tests, zero failures — so `test.projects` is safe to use
 * again, and is strictly better: one shared instance gives real
 * cross-project *and* intra-project parallelism bounded by Vitest's own
 * worker pool, instead of one OS-level Node process per project regardless
 * of how much or little work that project has.
 */

import { createDiskSandbox, type Directory } from '@minions/file-store';

/** Shared with hasAnyTestFile.ts, which walks the same kind of tree for the same reason. */
export const IGNORED_DIR_NAMES = new Set([
  'node_modules', '.git', '.nx', 'dist', 'coverage',
  'private', 'info', 'closet', '.claude', '.costume',
]);

const CONFIG_FILE_NAMES = [
  'vitest.config.ts', 'vitest.config.js', 'vitest.config.mjs', 'vitest.config.mts',
  'vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts',
];

/**
 * Cheap heuristic, not a full config parse: every config in this repo that
 * actually wants Vitest to run against it declares a `test: { ... }` (or
 * `test = { ... }`) block. A `vite.config.ts` with no such block is
 * build-only tooling (a Vue app entry, a library bundler config, ...) —
 * treating it as a discovered Vitest project makes VitestSignalRunner spin
 * up Vitest against a directory nobody ever intended to test, which can
 * hit zero matching files under Vitest's default include glob. That's not
 * just a wasted check: Vitest's own watch-mode internals can turn "zero
 * test files" into an unhandled rejection that crashes the whole process
 * (see VitestSignalRunner.ts's passWithNoTests comment) — so a config that
 * was never meant to be a test project must never be discovered as one.
 */
function declaresTestConfig(content: string): boolean {
  return /\btest\s*[:=]/.test(content);
}

export async function discoverVitestProjectDirs(
  rootDir: string,
  dir: Directory = createDiskSandbox(rootDir).root
): Promise<string[]> {
  const found: string[] = [];

  async function walk(directory: Directory): Promise<void> {
    const entries = await directory.children();

    const configFile = entries.find((entry) => entry.kind === 'file' && CONFIG_FILE_NAMES.includes(entry.name));
    if (configFile && configFile.kind === 'file' && declaresTestConfig(await configFile.read())) {
      found.push(directory.path);
    }

    for (const entry of entries) {
      if (entry.kind === 'directory' && !IGNORED_DIR_NAMES.has(entry.name)) {
        await walk(entry);
      }
    }
  }

  await walk(dir);
  return found;
}

/**
 * Whether `dir`'s subtree currently contains at least one file matching
 * Vitest's conventional test-file naming (`*.test.*`/`*.spec.*`).
 *
 * Used by VitestSignalRunner to filter a discovered project dir out of the
 * shared instance's `test.projects` for one run if it currently has zero
 * matching files — a directory can declare a real `test:` config (so
 * discoverVitestProjectDirs rightly finds it) and still transiently have no
 * test files on disk (mid-refactor, a file just renamed/deleted, ...).
 *
 * This check is deliberately version-agnostic: rather than asking a
 * particular installed copy of Vitest to tolerate "zero test files in watch
 * mode" (via `passWithNoTests`), which depends on exactly how that patch's
 * internals happen to handle it (see VitestSignalRunner.ts's own comment on
 * the watch-mode double-`ctx.start()` bug this sidesteps), this never asks
 * Vitest to watch a directory with nothing to find in the first place — so
 * it holds regardless of which 4.x (or 2.x/3.x) patch a work repo has
 * installed.
 */

import { createDiskSandbox, type Directory } from '@minions/file-store';
import { IGNORED_DIR_NAMES } from './discoverVitestProjectDirs.js';

/** Shared with QualityWatcher.ts, which uses this to spot a newly-created test file arriving over the shared fs.watch. */
export const TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/;

export async function hasAnyTestFile(cwd: string, dir: Directory = createDiskSandbox(cwd).root): Promise<boolean> {
  const matches = await dir.glob('**/*', Array.from(IGNORED_DIR_NAMES));
  return matches.some((node) => node.kind === 'file' && TEST_FILE_PATTERN.test(node.name));
}

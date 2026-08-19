/**
 * Lazily seeds a work repo's own Nx project-graph cache so
 * `@nx/enforce-module-boundaries` (run in-process via runCustomLint.ts) can
 * actually enforce boundaries instead of silently skipping with "No cached
 * ProjectGraph is available. The rule will be skipped."
 *
 * That warning fires because the rule calls Nx's `readCachedProjectGraph()`,
 * a synchronous read of `<workspace root>/.nx/workspace-data/
 * project-graph.json` — no live daemon involved on the read side (this
 * workspace runs with NX_DAEMON=false everywhere, see CLAUDE.md's
 * nx-tail-pipe-hang note, and daemon-off graph computation still writes
 * this same cache file as a matter of course). Each independently
 * checked-out work repo is its own Nx workspace root, so each one's cache
 * has to be seeded separately — a monorepo's own `.nx/` doesn't cover a
 * repo checked out into a different wing's `work/`.
 *
 * `nx show projects` is run purely for that side effect: computing the
 * project graph (without the daemon) writes the cache; the project list it
 * prints is discarded. Skipped entirely for a `cwd` with no `nx.json` at
 * its root — not an Nx workspace, so there's nothing to seed and no point
 * spawning anything.
 *
 * Bounded by `DEFAULT_SEED_TIMEOUT_MS`: a client repo's own Nx workspace
 * state (a corrupted project graph, a misbehaving plugin, a sync-check
 * that expects an interactive answer this process can never give, ...) is
 * outside this codebase's control and can make `nx show projects` never
 * exit on its own — observed as a real risk, not just theoretical. Without
 * a timeout that wedges this seed attempt forever (see runProcessCommand's
 * `timeoutMs`, which kills the whole process tree rather than just letting
 * this promise dangle), which in turn wedges every custom-lint check for
 * this repo indefinitely, since `createCustomLintProcess` awaits this
 * before every run. 30 seconds is a hard ceiling for what's meant to be a
 * cheap graph-cache seed, not a full build — rebuilding the graph should
 * never legitimately need longer than that.
 */

import { createDiskSandbox, type Directory } from '@minions/file-store';
import { runProcessCommand, type ProcessResult } from './runProcess.js';

/** Injectable so tests never spawn a real process. */
export type Spawner = (cwd: string) => Promise<ProcessResult>;

/** How long `nx show projects` gets to seed the project-graph cache before it's killed and treated as a failed seed attempt. */
export const DEFAULT_SEED_TIMEOUT_MS = 30 * 1000;

const defaultSpawner: Spawner = (cwd) =>
  runProcessCommand(cwd, 'pnpm', ['exec', 'nx', 'show', 'projects'], { NX_DAEMON: 'false' }, DEFAULT_SEED_TIMEOUT_MS);

async function cacheFileExists(dir: Directory): Promise<boolean> {
  const nxResult = await dir.child('.nx');
  if (!nxResult.found || nxResult.node.kind !== 'directory') return false;

  const workspaceDataResult = await nxResult.node.child('workspace-data');
  if (!workspaceDataResult.found || workspaceDataResult.node.kind !== 'directory') return false;

  const graphResult = await workspaceDataResult.node.child('project-graph.json');
  return graphResult.found && graphResult.node.kind === 'file';
}

async function isNxWorkspace(dir: Directory): Promise<boolean> {
  const result = await dir.child('nx.json');
  return result.found && result.node.kind === 'file';
}

const seeded = new Map<string, Promise<string[] | undefined>>();

/**
 * Resolves to the spawner's own `warnings` (see runProcessCommand's
 * performance-degradation notice) on success, or `undefined` if there was
 * nothing to seed. Never swallowed silently — `createCustomLintProcess`
 * folds this into the custom-lint signal's own warnings, so a seed spawn
 * trending toward `DEFAULT_SEED_TIMEOUT_MS` is visible there even though a
 * genuine seed failure is still caught and treated as best-effort.
 */
async function seed(cwd: string, dir: Directory, spawner: Spawner): Promise<string[] | undefined> {
  if (!(await isNxWorkspace(dir)) || (await cacheFileExists(dir))) return undefined;

  const result = await spawner(cwd);
  if (result.exitCode !== 0) {
    throw new Error(`couldn't seed Nx's project graph cache: ${result.output.trim() || 'unknown error'}`);
  }
  return result.warnings;
}

/**
 * Safe to call repeatedly and concurrently for the same `cwd` — the actual
 * seed attempt runs at most once (subsequent calls share the same in-flight
 * promise), and a failure clears the cache so a later call can retry rather
 * than being wedged for the rest of the process's lifetime.
 */
export function ensureNxProjectGraphCache(
  cwd: string,
  spawner: Spawner = defaultSpawner,
  dir: Directory = createDiskSandbox(cwd).root
): Promise<string[] | undefined> {
  let promise = seeded.get(cwd);
  if (!promise) {
    promise = seed(cwd, dir, spawner).catch((err: unknown) => {
      seeded.delete(cwd);
      throw err;
    });
    seeded.set(cwd, promise);
  }
  return promise;
}

/** Test-only: forget any cached seed state for a cwd. */
export function resetNxProjectGraphCache(cwd: string): void {
  seeded.delete(cwd);
}

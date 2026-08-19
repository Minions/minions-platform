/**
 * Kills a spawned child process and its whole descendant tree, not just the
 * exact pid Node handed back.
 */

import { execFile } from 'node:child_process';

/** Minimal shape a spawned child process needs for tree-killing. */
export type KillableChildProcess = {
  kill(): void;
  /** PID of the spawned process, when known — used to kill its whole subtree. */
  pid?: number;
};

/**
 * `child.kill()` alone only signals the exact PID node spawned — it does not
 * follow to any descendants that PID itself spawned. For a process invoked
 * through an intermediary (e.g. `spawn('pnpm', ['exec', 'vue-tsc', ...])`,
 * where `pnpm` itself forks the real worker, or `spawn('pnpm', ['exec', 'nx',
 * ...])` similarly forking nx's own worker), that leaves the real process
 * running as an orphan forever — confirmed live as dozens of accumulated
 * `vue-tsc --watch` processes surviving days past the wing sessions that
 * started them. Windows has no process-group kill at all, so `taskkill /t`
 * (kill the whole tree rooted at pid) is the only way there; POSIX relies on
 * the spawn call passing `detached: true` (making the child its own
 * process-group leader) so `-pid` reaches the whole group. Falls back to
 * plain `child.kill()` when no pid is available (e.g. in tests, or if the
 * process already exited).
 */
export function killProcessTree(child: KillableChildProcess): void {
  if (!child.pid) {
    child.kill();
    return;
  }
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(child.pid), '/t', '/f'], () => {
      // Best-effort: the process may have already exited on its own.
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill();
  }
}

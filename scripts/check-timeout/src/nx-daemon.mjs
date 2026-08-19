import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SERVER_PROCESS_FILE = join(process.cwd(), '.nx', 'workspace-data', 'd', 'server-process.json');

/** Whether an nx daemon recorded in .nx/workspace-data is actually still alive. */
export function isDaemonRunning() {
  if (!existsSync(SERVER_PROCESS_FILE)) return false;
  let processId;
  try {
    ({ processId } = JSON.parse(readFileSync(SERVER_PROCESS_FILE, 'utf8')));
  } catch {
    return false;
  }
  if (typeof processId !== 'number') return false;
  try {
    // Signal 0 only checks the pid exists; it doesn't actually kill anything.
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * On Windows, any process spawned in this tree ambiently inherits the
 * write-end handle of a pipe (e.g. `| tail`). nx spawns its daemon
 * detached: true, so a freshly-forked daemon keeps that pipe handle open
 * after nx itself exits — the downstream reader never sees EOF and hangs
 * forever, even though the check has already finished.
 *
 * Safe rule: only let nx use a daemon that is ALREADY running — connecting
 * to it forks nothing, so nothing new can inherit/leak the pipe handle. If
 * no daemon is running yet, force NX_DAEMON=false for this run rather than
 * letting nx auto-start one in-tree.
 *
 * Do NOT revert to unconditionally forcing NX_DAEMON=false everywhere —
 * that is correct but slow, since it kills the ~3x warm-daemon speedup on
 * every run, cold or warm.
 */
export function configureNxDaemonEnv(env = process.env) {
  env.NX_DAEMON = isDaemonRunning() ? 'true' : 'false';
  return env.NX_DAEMON;
}

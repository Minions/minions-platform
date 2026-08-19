/**
 * Low-level subprocess execution, shared by every process-backed signal
 * runner (nx, oxlint, custom-rules-only eslint).
 */

import spawn from 'cross-spawn';
import { killProcessTree } from './killProcessTree.js';

/**
 * Result of running a command as a subprocess.
 *
 * `warnings` is optional and populated only by runners that can tell
 * warning-severity findings apart from real failures in their tool's own
 * output (see runOxlint.ts, runCustomLint.ts) — a plain nx/CLI runner with
 * no such distinction just omits it.
 */
export type ProcessResult = { exitCode: number; output: string; warnings?: string[] };

/**
 * Once a run takes at least this fraction of its own `timeoutMs`,
 * `runProcessCommand` attaches a performance-degradation warning to the
 * result — regardless of whether it ultimately finishes in time. The point
 * is to surface a check trending toward its timeout well before it actually
 * starts failing outright, so there's time to investigate and speed it up
 * rather than only finding out once it's already timing out.
 */
const PERF_DEGRADED_THRESHOLD_FRACTION = 0.5;

/**
 * Per-call context a `ProcessRunner` may use, beyond `cwd`/`target`. A single
 * options object rather than more positional params, since this is expected
 * to keep growing as more runners get real incremental behavior — adding a
 * field here never breaks a runner that ignores it.
 */
export type ProcessRunnerContext = {
  /**
   * Should be called every time this run has real, fine-grained evidence of
   * progress (a completed file, a processed chunk — whatever unit the
   * underlying tool naturally produces) so a caller with a finer-grained
   * view than "started" / "settled" (see
   * FileTriggeredSignalRunner.lastActivityAt) can tell a long-but-healthy
   * run apart from one that's silently stalled, without needing this to
   * bound its own total completion time. Optional: most runners (oxlint's
   * single subprocess call, a plain nx CLI invocation) have no finer signal
   * than their own start/end and can omit it entirely — callers fall back
   * to the coarser `getState().timestamp`.
   */
  onActivity?: () => void;
  /**
   * Paths (absolute, OS-native separators) that changed since the last
   * check this runner completed, or `null` if unknown/full scope — the
   * first-ever check, or one right after a `pause()`/`resume()` cycle where
   * change tracking was off and there's no reliable record (see
   * FileTriggeredSignalRunner). A runner with no incremental behavior of
   * its own just ignores this and always does a full check (see
   * runOxlint.ts's own doc comment for why that's a deliberate choice
   * there, not a gap); `runCustomLint.ts` is the one runner that currently
   * uses it to scope its per-file work.
   */
  changedPaths?: ReadonlySet<string> | null;
};

/**
 * Runs a check as a subprocess in the given working directory.
 *
 * Injectable so tests can substitute a fake process without spawning a
 * real subprocess. `target` is whatever the specific tool needs to
 * distinguish what to run (an nx target name; unused by tools, like
 * oxlint, that always check everything in one pass). `context` is optional
 * on every call site — a runner that doesn't need any of it just omits the
 * parameter entirely.
 */
export type ProcessRunner = (cwd: string, target: string, context?: ProcessRunnerContext) => Promise<ProcessResult>;

/**
 * Spawns `command args...` in cwd and resolves with its exit code and
 * combined stdout+stderr.
 *
 * Listens for the child's 'exit' event, not 'close': a spawned tool can
 * leave a detached grandchild (e.g. nx's daemon) holding the piped
 * stdout/stderr open after the direct child exits, and 'close' waits for
 * all holders of those pipes to close — which can then hang forever even
 * though the actual work already finished. 'exit' fires as soon as the
 * direct child process itself terminates, regardless of what a grandchild
 * still holds open (see nx-tail-pipe-hang in project memory).
 *
 * `timeoutMs` bounds how long this waits for the child to exit on its own:
 * past that, the whole process tree is killed (see killProcessTree — a bare
 * `child.kill()` alone can leave a real worker running as an orphan when
 * `command` is an intermediary like `pnpm exec`) and this resolves with a
 * synthetic non-zero result rather than hanging forever. Required, not
 * optional, so every caller has to make a deliberate choice about it rather
 * than silently inheriting "no bound at all" — the exact gap that let
 * `nx show projects` hang this codebase's own custom-lint signal forever
 * (see ensureNxProjectGraphCache.ts). A caller managing a genuine watch-mode
 * process's own lifetime directly (not a one-shot command expected to exit)
 * should pass a generously large value rather than sidestep this.
 *
 * Also attaches a `warnings` entry once the run has taken at least
 * {@link PERF_DEGRADED_THRESHOLD_FRACTION} of `timeoutMs` — see that
 * constant's own doc — whether or not it went on to time out.
 */
export function runProcessCommand(
  cwd: string,
  command: string,
  args: string[],
  envOverrides: Record<string, string>,
  timeoutMs: number
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, { cwd, env: { ...process.env, ...envOverrides } });

    let output = '';
    let timedOut = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
    const finish = (exitCode: number) => {
      clearTimeout(timer);
      // A grandchild can keep the piped stdio open after the direct child
      // exits; explicitly release our end so a lingering handle can't keep
      // this (long-running) process from shutting down cleanly later.
      child.stdout?.destroy();
      child.stderr?.destroy();

      const elapsedMs = Date.now() - startedAt;
      const perfWarnings =
        elapsedMs >= timeoutMs * PERF_DEGRADED_THRESHOLD_FRACTION
          ? [
              `[runProcessCommand] '${command} ${args.join(' ')}' took ${elapsedMs}ms — ` +
                `${Math.round((elapsedMs / timeoutMs) * 100)}% of its ${timeoutMs}ms timeout. Performance is ` +
                `degraded; investigate and speed up this check before it starts hitting the timeout outright.`,
            ]
          : [];

      if (timedOut) {
        resolve({
          exitCode: 1,
          output: `${output}\n[runProcessCommand] '${command} ${args.join(' ')}' timed out after ${timeoutMs}ms and was killed`,
          ...(perfWarnings.length > 0 ? { warnings: perfWarnings } : {}),
        });
        return;
      }
      resolve({ exitCode, output, ...(perfWarnings.length > 0 ? { warnings: perfWarnings } : {}) });
    };
    child.on('exit', (code) => finish(code ?? 1));
    child.on('error', (err) => {
      output += String(err);
      finish(1);
    });
  });
}

/**
 * Vite-shaped `Logger` (see `LoggerOptions.customLogger` in Vite's node API)
 * that captures `warn`/`error` calls into a caller-owned array instead of
 * letting them fall through to Vite's default console-writing logger.
 *
 * Shared by VitestSignalRunner and ViteBuildWatchSignalRunner — both run
 * their underlying tool in-process (see each file's header for why), so
 * without this, everything Vite/Vitest/esbuild/Rollup log internally
 * (dependency-optimizer notices, deprecation warnings, plugin warnings
 * routed through the logger) would hit cabinet's own shared stdout, since
 * that process runs every wing's watchers in-process. `info` is dropped
 * entirely: it's routine ("optimized dependencies changed...") rather than
 * something to flag.
 *
 * Callers own the array's identity and must mutate it in place (e.g.
 * `warnings.length = 0` to reset between runs) rather than reassigning —
 * this closes over the array reference at call time, not a variable.
 */
export function createWarningCapturingLogger(warnings: string[]) {
  return {
    info: (_msg: string) => undefined,
    warn(msg: string) {
      warnings.push(msg);
    },
    warnOnce(msg: string) {
      warnings.push(msg);
    },
    error(msg: string) {
      warnings.push(msg);
    },
    clearScreen: () => undefined,
    hasErrorLogged: () => false,
    hasWarned: false,
  };
}

/**
 * Feature flags for the minions lair.
 *
 * These are compile-time options that differ between dev mode
 * (running from source in a wing) and production mode
 * (running from the lair's tools/runtime code with lair root as cwd).
 *
 * Usage:
 *   - Call `initFlags(isDevMode)` once at startup (e.g. in cabinet's createServer).
 *   - Call `FF()` anywhere to read the active flags.
 */

const prod_flags = {
  __flags_name__: 'production',
  // Gates UI/tooling for the browser-verify costume (plan 2dac4524) while
  // it's still being built out, so prod releases can ship without it.
  BROWSER_VERIFY: false,
  // TEMPORARY (see plan to replace the quality watcher with a higher-perf
  // design, tracked alongside HIGHER_PERF_QUALITY_WATCHER below): disables
  // WingQualityWatcher initialization, the movement-commit quality gate, and
  // the quality_status MCP tool, because the current watcher can wedge under
  // load and block commits with no real signal. On in both dev and prod
  // until the replacement lands — agents must run lint/typecheck/tests
  // themselves while this is on. Remove this flag (and the dead branches it
  // guards) once HIGHER_PERF_QUALITY_WATCHER has replaced it in prod.
  HACK_OFF_QUALITY_CHECKS: true,
  // TEMPORARY: the higher-perf quality watcher replacement, on in dev only
  // until it's validated under real load and promoted to prod (at which
  // point HACK_OFF_QUALITY_CHECKS above comes off).
  HIGHER_PERF_QUALITY_WATCHER: false,
};

const dev_flags: typeof prod_flags = {
  ...prod_flags,
  __flags_name__: 'development',
  BROWSER_VERIFY: true,
  HIGHER_PERF_QUALITY_WATCHER: true,
};

let activeFlags: typeof prod_flags = prod_flags;

/**
 * Initialize the feature flags system.
 * Must be called once at startup before any call to FF().
 *
 * @param isDevMode - true when running from source in a wing (not a built product)
 */
export function initFlags(isDevMode: boolean): void {
  activeFlags = isDevMode ? dev_flags : prod_flags;
}

/**
 * Return the active feature flags.
 * Call this anywhere in the system to check flags: `FF().PLANNING_TOOL`
 */
export function FF(): typeof prod_flags {
  return activeFlags;
}

/**
 * Factory boundary between this package's Platform-generic `IQualityWatcher`
 * surface and its concrete, software-development-domain implementations
 * (`adapters/` — `WingQualityWatcher`, `RemoteQualityWatcher`,
 * `QualityWatcher`, and everything that spawns or watches real dev tooling).
 *
 * A caller that needs a real, running watcher (`apps/cabinet`'s
 * `MCPServer`, `libs/planner`'s plan-mirror commit gate) depends only on
 * this interface — never on `adapters/` directly — and receives an
 * implementation via injection from its own composition root, the same
 * `IHatchery`/`ProductionHatchery` shape already used elsewhere in this
 * codebase. No default/production implementation lives in this package:
 * whichever composition root constructs the real one (today,
 * `apps/cabinet/src/quality/productionQualityWatcherFactory.ts`) owns the
 * concrete adapter imports, so a build that never reaches that composition
 * root — e.g. a checkout that only carries this package's interface-only
 * surface — never needs `adapters/` to exist at all. A caller with no
 * injected factory degrades to "no watcher available", the same graceful
 * degrade every `IQualityWatcher` consumer already tolerates for a watcher
 * that failed to start.
 */
import type { IQualityWatcher } from './IQualityWatcher.js';

export interface QualityWatcherFactory {
  /**
   * A watcher running the full `DEV_SIGNALS` set (tests/types/build/lint)
   * against a wing's own work repo(s) — in-process, via whatever concrete
   * implementation this factory chooses (see `WingQualityWatcher`).
   */
  createWingWatcher(wingName: string, workRepoPaths: Readonly<Record<string, string>>): IQualityWatcher;

  /**
   * The HTTP-backed variant of `createWingWatcher`, talking to a separately
   * running process instead of watching in-process (see
   * `RemoteQualityWatcher`, `apps/quality-watcher-process`).
   */
  createRemoteWatcher(wingName: string, baseUrl: string, workRepoPaths: Readonly<Record<string, string>>): IQualityWatcher;

  /**
   * A watcher scoped to `GLOBAL_SIGNALS` only (see `SignalCategory.ts` —
   * currently empty, so this watcher runs no real checks yet), for a single
   * directory outside any wing — e.g. the cabinet's own plan-mirror writes,
   * which never run software-dev tooling the way a wing's own watcher does.
   */
  createGlobalSignalsWatcher(name: string, cwd: string): IQualityWatcher;
}

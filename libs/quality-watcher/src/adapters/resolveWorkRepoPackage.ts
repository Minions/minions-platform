/**
 * Shared cascade for resolving a package from the *target work repo's own*
 * `node_modules` — not one bundled into Cabinet itself — with room to add
 * fallback sources beyond that.
 *
 * Cabinet's production build flattens its own dependencies into a single
 * esbuild file (tools/runtime/main.js). That bundle drops anything that's
 * only a devDependency of Cabinet (e.g. vitest), and even for bundled deps,
 * their own `import.meta.url`-relative internal lookups (a version banner,
 * a default config-file list) assume the real, deeply-nested `node_modules/
 * <pkg>/dist/...` layout they ship with — flattening that into one file
 * breaks those lookups, since they resolve relative to the bundle's
 * location instead. Resolving and importing each target repo's own install
 * sidesteps all of this: it runs with that repo's real, untouched file
 * layout and its own pinned version — matching how every quality signal
 * already defers to each repo's own toolchain (own oxlint, own eslint
 * config, own vue-tsc) rather than one owned by Cabinet.
 *
 * The core shape is a `PackageSource<T>`: "does this repo have what I need,
 * here?" — `not-found` (nothing here, keep looking), `unsupported-version`
 * (something's here, but not usable), or `ok` (here's the value). New
 * signals compose sources with `resolveFromSources`, tried in order,
 * first `ok` wins:
 *
 *   const resolution = await resolveFromSources(cwd, [
 *     workRepoPackageEntrySource({ packageName: 'vite', ... }),  // the repo's own install
 *     cabinetBundledFallbackSource({ ... }),                     // a fallback if that's missing
 *     yetAnotherFallbackSource({ ... }),                         // and another, if that's missing too
 *   ]);
 *
 * `workRepoPackageEntrySource` below is the "repo's own install" source
 * every signal starts with — it resolves a versioned, importable entry
 * point (vite, vitest today: see resolveWorkRepoVite.ts/
 * resolveWorkRepoVitest.ts). A source doesn't have to look like that,
 * though — `hasWorkRepoPackage` is a plainer "is it there at all?" check,
 * and runOxlint.ts composes that (own oxlint) with a second source
 * wrapping Cabinet's own installable fallback binary (`FallbackOxlint`),
 * via the same `resolveFromSources`, to show a source doesn't need to
 * resolve an importable module at all — just something the caller knows
 * how to run.
 */

import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** Injectable seam for tests: resolves a bare specifier to a file path the way `require.resolve` would, starting from `cwd`. */
export type PackageResolver = (specifier: string, cwd: string) => string;

export const defaultResolvePackage: PackageResolver = (specifier, cwd) =>
  createRequire(path.join(cwd, 'package.json')).resolve(specifier);

/** True if `packageName` resolves from the work repo at `cwd` — its own install, never Cabinet's. */
export function hasWorkRepoPackage(cwd: string, packageName: string, resolvePackage: PackageResolver = defaultResolvePackage): boolean {
  try {
    resolvePackage(`${packageName}/package.json`, cwd);
    return true;
  } catch {
    return false;
  }
}

/** One step's outcome when resolving something a work repo may or may not provide. */
export type PackageResolution<T> =
  | { kind: 'not-found' }
  | { kind: 'unsupported-version'; version: string; message: string }
  | { kind: 'ok'; value: T };

/** One candidate place to look. Sync or async — `resolveFromSources` awaits either. */
export type PackageSource<T> = (cwd: string) => PackageResolution<T> | Promise<PackageResolution<T>>;

/**
 * Tries each source in order, returning the first `ok`. A `not-found`
 * source falls through to the next one — that's the whole point of a
 * fallback chain. `unsupported-version` also falls through (a later source
 * might still work — e.g. a fallback install at a supported version), but
 * if every source in the chain ultimately comes up empty, the *first*
 * unsupported-version encountered is what's returned instead of a bare
 * not-found — a real, present-but-incompatible install is more actionable
 * to surface than "nothing found" once nothing later panned out either.
 *
 * A source that throws (e.g. a fallback whose provisioning genuinely
 * fails, not just "isn't there") is not caught here — that's a real
 * operational error, distinct from "keep looking," and propagates to the
 * caller. See runOxlint.ts's fallback source for an example.
 */
export async function resolveFromSources<T>(cwd: string, sources: readonly PackageSource<T>[]): Promise<PackageResolution<T>> {
  let firstUnsupported: Extract<PackageResolution<T>, { kind: 'unsupported-version' }> | undefined;
  for (const source of sources) {
    const result = await source(cwd);
    if (result.kind === 'ok') return result;
    if (result.kind === 'unsupported-version' && !firstUnsupported) firstUnsupported = result;
  }
  return firstUnsupported ?? { kind: 'not-found' };
}

export type WorkRepoPackageEntry = { version: string; entryUrl: string };

export type WorkRepoPackageEntryOptions = {
  /** The npm package name, e.g. `'vite'` or `'vitest'`. */
  packageName: string;
  /** Human-readable signal name for the unsupported-version message, e.g. `'build'` or `'tests'`. */
  signalName: string;
  /** Inclusive major-version range this signal's integration code has been built and tested against. */
  minSupportedMajor: number;
  maxSupportedMajor: number;
  /** Given the parsed `package.json`, returns the entry file's path relative to that package.json's directory. */
  entryRelPath: (pkg: Record<string, unknown>) => string;
};

function unsupportedVersionMessage(options: WorkRepoPackageEntryOptions, version: string): string {
  const { packageName, signalName, minSupportedMajor, maxSupportedMajor } = options;
  return (
    `This repo's installed ${packageName} (${version}) is outside the range Cabinet's ${signalName} signal supports ` +
    `(${minSupportedMajor}.x-${maxSupportedMajor}.x). Update whichever is older — this repo's ${packageName}, ` +
    `or Cabinet itself — to bring them back into a compatible range. The ${signalName} signal is disabled for this repo until then.`
  );
}

/** A `PackageSource` resolving `options.packageName` from the work repo's own install: version-checked, with an importable entry URL. The building block `resolveWorkRepoPackageEntry` below runs alone; compose it with further sources via `resolveFromSources` to add a fallback. */
export function workRepoPackageEntrySource(
  options: WorkRepoPackageEntryOptions,
  resolvePackage: PackageResolver = defaultResolvePackage
): PackageSource<WorkRepoPackageEntry> {
  return (cwd) => {
    let pkgJsonPath: string;
    try {
      pkgJsonPath = resolvePackage(`${options.packageName}/package.json`, cwd);
    } catch {
      return { kind: 'not-found' };
    }

    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as Record<string, unknown>;
    const version = String(pkg.version);
    const major = Number(version.split('.')[0]);
    if (!Number.isFinite(major) || major < options.minSupportedMajor || major > options.maxSupportedMajor) {
      return { kind: 'unsupported-version', version, message: unsupportedVersionMessage(options, version) };
    }

    const entryPath = path.join(path.dirname(pkgJsonPath), options.entryRelPath(pkg));
    return { kind: 'ok', value: { version, entryUrl: pathToFileURL(entryPath).href } };
  };
}

/** Flattened result shape kept for callers matching on `{ kind: 'ok', version, entryUrl }` directly (resolveWorkRepoVite.ts, resolveWorkRepoVitest.ts) rather than `{ kind: 'ok', value: { version, entryUrl } }`. */
export type PackageEntryResolution =
  | { kind: 'not-found' }
  | { kind: 'unsupported-version'; version: string; message: string }
  | { kind: 'ok'; version: string; entryUrl: string };

/**
 * Convenience for the common single-source case: resolve `options.packageName`
 * from the work repo's own install, nothing else. Equivalent to
 * `resolveFromSources(cwd, [workRepoPackageEntrySource(options, resolvePackage)])`,
 * flattened to `PackageEntryResolution`. Reach for `resolveFromSources`
 * directly instead once a signal needs a fallback beyond the repo's own
 * install.
 */
export async function resolveWorkRepoPackageEntry(
  cwd: string,
  options: WorkRepoPackageEntryOptions,
  resolvePackage: PackageResolver = defaultResolvePackage
): Promise<PackageEntryResolution> {
  const resolution = await resolveFromSources(cwd, [workRepoPackageEntrySource(options, resolvePackage)]);
  return resolution.kind === 'ok' ? { kind: 'ok', version: resolution.value.version, entryUrl: resolution.value.entryUrl } : resolution;
}

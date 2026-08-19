/**
 * Default strict oxlint config, applied to any work repo that doesn't
 * supply its own `.oxlintrc.json`/`.oxlintrc.jsonc`. A repo only has to
 * add its own config file to override this entirely — oxlint's own config
 * discovery already prefers a repo-local file over anything we pass via
 * `--config`, so "supplying one" is what weakens (or changes) it.
 *
 * A plain exported object rather than a `.json` file loaded by path: this
 * module can end up bundled (Cabinet's production build flattens its
 * dependencies with esbuild), and a bundled file's `import.meta.url` no
 * longer points at this file's real location — see resolveWorkRepoVite.ts
 * for what that class of bug looks like when a config is instead resolved
 * relative to the bundle. Keeping the content as an ordinary JS value
 * sidesteps that: esbuild inlines it wherever it's imported, dev or
 * bundled, and materializing it to a real file on disk (oxlint's `--config`
 * needs a path, not stdin) is a separate, explicit step — see
 * materializeDefaultOxlintConfig in runOxlint.ts.
 *
 * Categories included: correctness, suspicious, perf, style — oxlint's own
 * generally-agreed-useful, stable categories, all at "deny". `pedantic`,
 * `restriction`, and `nursery` are deliberately left out: oxlint itself
 * ships them off by default because they're either highly
 * subjective/opinionated (`restriction`) or still unstable (`nursery`).
 */
export const DEFAULT_OXLINT_CONFIG = {
  categories: {
    correctness: 'deny',
    suspicious: 'deny',
    perf: 'deny',
    style: 'deny',
  },
} as const;

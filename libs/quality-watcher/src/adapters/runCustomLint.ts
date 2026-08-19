/**
 * Custom-rules-only ESLint runner.
 *
 * Runs whatever the standard oxlint signal (`.oxlintrc.json`) *can't* check:
 * a conventionally-named flat config, `eslint.custom-rules.config.mjs` at
 * the work repo's root, covering workspace-graph-aware rules like
 * `@nx/enforce-module-boundaries` (no oxlint equivalent) and template-aware
 * `eslint-plugin-vue` rules (oxlint's vue plugin only ever sees a `.vue`
 * file's extracted `<script>` block, never its `<template>`). Everything
 * oxlint *can* check belongs in `.oxlintrc.json` instead, since oxlint is
 * ~50-100x faster than ESLint for the same rule.
 *
 * Still deliberately non-type-aware (no `languageOptions.parserOptions.project`
 * in that config), which skips building a full TS program/type-checker — the
 * expensive part of a normal ESLint+typescript-eslint run — since none of
 * the rules routed here need type information.
 *
 * If a project has no `eslint.custom-rules.config.mjs`, the signal reports
 * an instant pass rather than erroring, and never even constructs an ESLint
 * instance.
 *
 * Uses ESLint's Node API (one long-lived `ESLint` instance per work repo,
 * reused across every check until the config file's own mtime changes)
 * rather than spawning the `eslint` CLI fresh each time — confirmed via a
 * live spike: ~5x faster on repeat calls in the same process (CLI pays full
 * module-resolution/config-load cost on every invocation; the Node API only
 * pays it once). Safe to reuse across calls here specifically because
 * custom rules are single-file, non-type-aware — no cross-file type cache
 * to go stale between checks. The config file itself is the one thing that
 * *is* re-checked every call (a cheap `stat()`, not a rebuild) — see
 * `getInstance()` below.
 *
 * Running in-process (rather than as a subprocess, like oxlint/vue-tsc/vite
 * build) means this doesn't get output capture "for free" via piped stdio —
 * anything a rule writes directly to `process.stdout`/`process.stderr`
 * (`@nx/enforce-module-boundaries` does exactly this when it can't find a
 * cached project graph — see ensureNxProjectGraphCache.ts, which this seeds
 * before every check) would otherwise land straight in Cabinet's own
 * console instead of this signal's result. `lintFiles()` runs under
 * `withStdioCaptured` below so that never happens: anything written gets
 * folded into the failure text on a failing run and dropped on a pass,
 * matching how every other signal already discards informational output on
 * success.
 */

import { readdir } from 'node:fs/promises';
import { statSync, readFileSync } from 'node:fs';
import { join, extname } from 'node:path';
import { ESLint } from 'eslint';
import { createDiskSandbox, type Directory } from '@minions/file-store';
import type { ProcessRunner, ProcessResult } from './runProcess.js';
import { ensureNxProjectGraphCache } from './ensureNxProjectGraphCache.js';
import { IGNORED_PATH_SEGMENTS } from './FileTriggeredSignalRunner.js';

export const CUSTOM_LINT_CONFIG_FILENAME = 'eslint.custom-rules.config.mjs';

/** No config present for this cwd — never even try to construct an ESLint instance. */
const NO_CUSTOM_RULES: unique symbol = Symbol('no-custom-rules');

/**
 * Per-absolute-path memoized data-file reads, keyed by `(path, mtimeMs)` —
 * shared globally (not scoped per repo/cwd) since callers pass absolute
 * paths, which are already unique across every repo this process watches.
 * Never explicitly invalidated: an mtime mismatch on the NEXT call is
 * exactly when a re-read is actually needed, so there's nothing to clear
 * proactively (unlike `resultsByFile`, which caches a *rule's verdict*, not
 * a file's *content* — no correctness relationship between the two).
 */
const dataFileCache = new Map<string, { mtimeMs: number; data: unknown }>();

/**
 * Reads a data file (JSON auto-detected and parsed; anything else returned
 * as raw text), re-reading from disk only when the file's own mtime has
 * actually changed since the last call — the same trick
 * `getInstance` below already uses for the config file itself, offered here
 * as a general-purpose primitive any custom rule can use in place of a
 * hand-rolled module-level cache.
 *
 * The problem this solves: a rule that caches external state at
 * plugin-*import* time (`const allowlist = loadAllowlist(...)` at module
 * scope) never sees an edit to that file again without a full process
 * restart — confirmed live that even reconstructing the `ESLint` instance
 * doesn't help, since Node's ESM loader caches a plugin's own imports by
 * resolved path regardless (see `CacheEntry`'s own doc comment). A rule
 * that instead calls `loadRuleDataFile(path)` *inside* `create()` (invoked
 * fresh per file, per real `lintFiles()` call) sees a correctly-updated
 * result on the very next check that actually re-verifies that file — no
 * restart, and no real per-call cost beyond a `statSync()` in the common
 * (unchanged) case.
 *
 * Exposed to rules at runtime via `context.settings.qualityWatcher
 * .loadDataFile` (see `getInstance`'s `overrideConfig` below) rather than
 * as a package export: a custom-rules config for a DIFFERENT repo (a
 * different wing, a different lair entirely — e.g. this was designed
 * against a real example in eolus-nabu's own `tools/design-principles
 * -lint/`) has no dependency on `@minions/quality-watcher` and never could;
 * `context.settings` is real, live, in-process ESLint API — nothing here
 * gets serialized — so this works identically regardless of which repo's
 * config is being loaded, with zero new dependency for the rule author.
 */
export function loadRuleDataFile(path: string): unknown {
  const mtimeMs = statSync(path).mtimeMs;
  const cached = dataFileCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs) {
    return cached.data;
  }
  const raw = readFileSync(path, 'utf8');
  // Auto-detected, not extension-based: extension-driven parsing would
  // couple this to WORKSPACE_METADATA_EXTENSIONS below for no real reason —
  // the two lists answer unrelated questions (what to parse here vs. what
  // forces a cache bust there) that only happen to overlap in practice.
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    data = raw;
  }
  dataFileCache.set(path, { mtimeMs, data });
  return data;
}

/** Test-only: forget any cached data-file read for a path. */
export function resetRuleDataFileCache(path: string): void {
  dataFileCache.delete(path);
}

/**
 * Cached alongside the config file's mtime at the time it was built, so a
 * later edit to `eslint.custom-rules.config.mjs` itself — e.g. someone adds
 * a new rule — is noticed and rebuilds the instance instead of silently
 * keeping the stale one (or the stale "no config" marker) for the rest of
 * this process's lifetime. Without this, a warm quality watcher started
 * before a rule was added (or before the config file existed at all) would
 * never pick it up, while a fresh `eslint` run in CI always would — exactly
 * the kind of drift this signal exists to prevent.
 *
 * `resultsByFile` lives and dies with `instance` — a previously-computed
 * result can't be trusted once the instance itself has been rebuilt.
 * `createCustomLintProcess` also clears it directly (without rebuilding the
 * instance) on a workspace-metadata change — see
 * `WORKSPACE_METADATA_EXTENSIONS`'s own doc comment for why, and for the
 * one thing that does NOT fix: a rule's own module-level state (verified
 * live — see that comment) survives even a full instance rebuild, since
 * Node's ESM loader caches a plugin's *own* imports by resolved path
 * regardless of how many times `new ESLint(...)` is constructed against it.
 */
type CacheEntry = {
  instance: ESLint | typeof NO_CUSTOM_RULES;
  mtimeMs: number | null;
  resultsByFile: Map<string, ESLint.LintResult>;
};

const instances = new Map<string, CacheEntry>();

async function getInstance(cwd: string, dir: Directory): Promise<CacheEntry> {
  const configPath = join(cwd, CUSTOM_LINT_CONFIG_FILENAME);
  const configChild = await dir.child(CUSTOM_LINT_CONFIG_FILENAME);
  const currentMtimeMs =
    configChild.found && configChild.node.kind === 'file' ? (await configChild.node.stat()).mtimeMs : null;

  const cached = instances.get(cwd);
  if (cached && cached.mtimeMs === currentMtimeMs) {
    return cached;
  }

  const instance = configChild.found
    ? new ESLint({
        cwd,
        overrideConfigFile: configPath,
        // Merged into the loaded config's own settings (real, live ESLint
        // Node API — nothing here is serialized), so any rule anywhere in
        // that config tree can call `context.settings.qualityWatcher
        // .loadDataFile(path)` instead of caching external state at
        // plugin-import time — see `loadRuleDataFile`'s own doc comment for
        // why that matters and why this works with zero dependency on
        // `@minions/quality-watcher` from the config's own repo.
        overrideConfig: { settings: { qualityWatcher: { loadDataFile: loadRuleDataFile } } },
      })
    : NO_CUSTOM_RULES;
  const entry: CacheEntry = { instance, mtimeMs: currentMtimeMs, resultsByFile: new Map() };
  instances.set(cwd, entry);
  return entry;
}

/** Test-only: forget any cached ESLint instance/no-config marker for a cwd. */
export function resetCustomLintInstance(cwd: string): void {
  instances.delete(cwd);
}

/**
 * Extensions this signal's config actually declares `files:` patterns for
 * (see `eslint.custom-rules.config.mjs`: `**\/*.ts`/`.tsx`/`.js`/`.jsx`, and
 * `**\/*.vue`). Used to pre-filter the per-file discovery walk below — kept
 * as an exact list, not a generous superset, because passing a file ESLint
 * doesn't actually have a matching `files:` pattern for risks it being
 * treated as an unconfigured-file error (a false failure) rather than a
 * harmless no-op. If a future edit to that config adds another extension,
 * this list needs the matching update.
 */
const LINTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.vue']);

/**
 * Extensions treated as "unknown blast radius" when they appear in a
 * `changedPaths` set — see `createCustomLintProcess`'s own use of this for
 * the full reasoning. Evidence-driven, not exhaustive: every real hazard
 * found (this repo's own `@nx/enforce-module-boundaries`, reading
 * project.json/nx.json/tsconfig-driven project-graph state; a design
 * -principle rule seen elsewhere, reading a burn-down allowlist file) reads
 * JSON specifically — rule authors reach for JSON to hold config/data, not
 * arbitrary file types. Deliberately narrow: an earlier draft used "anything
 * that isn't a linted source extension," but that swept in harmless changes
 * (docs, images, lockfiles) with no plausible relationship to any rule's
 * logic, for no correctness benefit. Revisit if a future custom rule reads
 * some other file type as external state — same "known extensions today"
 * caveat `LINTED_EXTENSIONS` above already carries.
 *
 * Fixes the case where a rule reads external state FRESH on every file it
 * visits (e.g. `@nx/enforce-module-boundaries`'s `readCachedProjectGraph()`
 * call, made per file, per real `lintFiles()` call — not cached anywhere
 * across calls) — clearing `resultsByFile` (see `createCustomLintProcess`)
 * is enough to force a genuine re-verification against the new state. Does
 * NOT fix a rule that instead caches external state at plugin-*import*
 * time (a module-level `const allowlist = loadAllowlist(...)`, evaluated
 * once) — confirmed live that even a brand-new `ESLint` instance doesn't
 * help there: Node's ESM loader caches a plugin's own imports by resolved
 * file path regardless of how many `ESLint` instances are constructed
 * against it, and ESLint's own cache-busting (a query string keyed on
 * mtime) only ever applies to the top-level config file itself, never to
 * files that config file — or a plugin it loads — in turn imports. Only a
 * full process restart clears that. A real, narrow, structural limitation
 * of running ESLint in-process at all — pre-existing, not introduced or
 * fixed by this scoping work.
 */
const WORKSPACE_METADATA_EXTENSIONS = new Set(['.json', '.jsonc']);

/**
 * Walks `cwd` on real disk (ESLint's Node API always reads from real disk
 * regardless of the injected `Directory` sandbox — see `getInstance`'s own
 * comment) collecting candidate files by extension, pruning known build/vcs
 * output directories by name during the walk itself (reusing
 * `IGNORED_PATH_SEGMENTS` — see its own doc comment for why this, and not
 * `isIgnoredPath`, is the right list to reuse for pruning a traversal).
 * Final authority on whether a candidate is actually lintable is
 * `instance.isPathIgnored()` — ESLint's own public API for its real
 * `ignores:`/default-ignore semantics (`.nx/**`, `**\/dist/**`, etc.) —
 * applied by the caller per candidate, not here.
 */
async function discoverCandidateFiles(cwd: string): Promise<string[]> {
  const results: string[] = [];
  async function walk(dirPath: string): Promise<void> {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      if (IGNORED_PATH_SEGMENTS.includes(entry.name)) continue;
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && LINTED_EXTENSIONS.has(extname(entry.name))) {
        results.push(fullPath);
      }
    }
  }
  await walk(cwd);
  return results;
}

/**
 * Lints `cwd` file by file over the same warm `instance` rather than one
 * `instance.lintFiles(['.'])` batch call — measured near-identical total
 * wall-clock for a full run (832 real files in this monorepo: 15524ms
 * batch vs 15900ms per-file, ~2.4% overhead) but turns "no signal for
 * however long the whole check takes" into a real, honest per-file
 * completion tick, exactly like VitestSignalRunner's per-test progress.
 * `onActivity`, if given, is called once per file *after* that file's real
 * linting completes — never before, so it can't report progress that
 * hasn't actually happened yet.
 *
 * `resultsByFile` (from the instance's own `CacheEntry` — see its doc
 * comment) is read AND mutated here: a candidate only gets a real
 * `lintFiles([file])` call (and an `onActivity` tick) when `changedPaths`
 * says it changed, `changedPaths` is `null` (unknown/full scope), or it has
 * no cached entry at all (never seen before — absence means "no cached
 * opinion," not "assume pass," so it always needs a real check). Every
 * other candidate reuses its cached result without re-verifying it,
 * without ticking `onActivity` (no real work happened, so nothing to
 * honestly report), and without even calling `isPathIgnored` again (a
 * result already in the cache was necessarily not ignored when it was
 * computed, and ignore rules are config-driven, not content-driven, so
 * they can't have changed without a config change already forcing a
 * rebuild — see `createCustomLintProcess`). Entries for files no longer
 * discovered (deleted since the last check) are pruned so the cache
 * doesn't grow unboundedly across a long-lived process.
 */
async function lintScoped(
  instance: ESLint,
  cwd: string,
  resultsByFile: Map<string, ESLint.LintResult>,
  changedPaths: ReadonlySet<string> | null,
  onActivity?: () => void
): Promise<ESLint.LintResult[]> {
  const candidates = await discoverCandidateFiles(cwd);
  const candidateSet = new Set(candidates);
  for (const cached of resultsByFile.keys()) {
    if (!candidateSet.has(cached)) resultsByFile.delete(cached);
  }

  const results: ESLint.LintResult[] = [];
  for (const file of candidates) {
    const needsRelint = changedPaths === null || changedPaths.has(file) || !resultsByFile.has(file);
    if (!needsRelint) {
      const cached = resultsByFile.get(file);
      if (cached) results.push(cached);
      continue;
    }
    if (await instance.isPathIgnored(file)) continue;
    const [result] = await instance.lintFiles([file]);
    if (result) {
      resultsByFile.set(file, result);
      results.push(result);
    }
    onActivity?.();
  }
  return results;
}

/**
 * How long the shared stdout/stderr capture lock (see below) will release
 * itself for the *next* caller even if the current one hasn't finished —
 * NOT a deadline for this signal's own result, which is always awaited to
 * real completion regardless of how long that takes (custom-lint's total
 * runtime is expected to keep growing as the ruleset/repo grows — see
 * `lintFileByFile`'s per-file ticks, which is how a genuinely stuck run
 * gets caught now, via SignalWedgeMonitor's `idlePatienceMs`, not via a
 * fixed wall-clock cutoff here). This exists purely so one truly-hung file
 * (ESLint's Node API has nothing to cancel a synchronous rule visitor with)
 * doesn't permanently block every future custom-lint check for every repo
 * this process watches — deliberately generous (5 minutes, far above any
 * realistic real run) since firing it early would have no benefit, only
 * cost: the abandoned call keeps consuming CPU and its result is simply
 * never applied by the caller once the runner itself has moved on.
 */
const LOCK_SAFETY_VALVE_MS = 5 * 60 * 1000;

/**
 * Runs `fn` with `process.stdout.write`/`process.stderr.write` buffered
 * instead of writing through, returning whatever was captured alongside
 * `fn`'s own result. A process-wide lock serializes overlapping calls
 * (rather than, say, a stack keyed by call) — `process.stdout`/`stderr` are
 * global mutable state, so two concurrent captures (e.g. custom-lint checks
 * for two different work repos firing at once) would otherwise clobber each
 * other's override and could restore real stdio while the other capture is
 * still supposed to be active.
 *
 * The caller always gets `fn`'s real result, however long it takes — no
 * forced failure here. Only the *lock's own handoff* to the next caller is
 * bounded, by `lockSafetyValveMs`, so a genuinely stuck `fn()` can't
 * permanently starve every future call — see `LOCK_SAFETY_VALVE_MS`'s own
 * doc comment. This does NOT fully protect a call that starts while a prior
 * hang is still abandoned in the background (the real stdout/stderr patch
 * stays installed until that abandoned call eventually finishes) — accepted
 * as a known, narrow residual risk given how rare an actual ESLint hang is
 * expected to be, rather than a full stdio-patch-stacking redesign.
 */
let stdioCaptureLock: Promise<void> = Promise.resolve();

function withStdioCaptured<T>(fn: () => Promise<T>, lockSafetyValveMs: number = LOCK_SAFETY_VALVE_MS): Promise<{ value: T; captured: string }> {
  const run = async (): Promise<{ value: T; captured: string }> => {
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    const originalStderrWrite = process.stderr.write.bind(process.stderr);
    let captured = '';
    const capture = ((chunk: unknown, ...rest: unknown[]): boolean => {
      captured += typeof chunk === 'string' ? chunk : String(chunk);
      const callback = rest.find((arg): arg is (err?: Error) => void => typeof arg === 'function');
      callback?.();
      return true;
    }) as typeof process.stdout.write;

    process.stdout.write = capture;
    process.stderr.write = capture;
    try {
      const value = await fn();
      return { value, captured };
    } finally {
      process.stdout.write = originalStdoutWrite;
      process.stderr.write = originalStderrWrite;
    }
  };

  const runPromise = stdioCaptureLock.then(run, run);
  const safetyValve = new Promise<void>((resolve) => {
    setTimeout(resolve, lockSafetyValveMs);
  });
  stdioCaptureLock = Promise.race([runPromise.then(() => undefined, () => undefined), safetyValve]);
  return runPromise;
}

/**
 * Calls `onActivity` on a fixed interval for as long as `promise` is still
 * pending, so a caller awaiting a single opaque, no-progress-of-its-own
 * operation (see `ensureNxProjectGraphCache`'s own comment above) can still
 * report real, ongoing liveness instead of going silent for however long
 * that operation legitimately takes. Only appropriate for an operation with
 * its own independent bound (the seed's subprocess is killed by
 * `runProcessCommand`'s own `timeoutMs` regardless of what this does) — this
 * itself doesn't add any timeout or cancellation of its own.
 */
function tickWhilePending<T>(promise: Promise<T>, onActivity: (() => void) | undefined, intervalMs = 1000): Promise<T> {
  if (!onActivity) return promise;
  const timer = setInterval(onActivity, intervalMs);
  return promise.finally(() => clearInterval(timer));
}

export type CreateCustomLintProcessOptions = {
  ensureProjectGraph?: (cwd: string) => Promise<string[] | undefined>;
  /** Injected for tests; defaults to the real disk sandbox rooted at `cwd`. */
  dir?: Directory;
  /** Injected for tests; defaults to {@link LOCK_SAFETY_VALVE_MS}. */
  lockSafetyValveMs?: number;
  /** Injected for tests; defaults to {@link tickWhilePending}'s own 1000ms. */
  seedActivityIntervalMs?: number;
};

export function createCustomLintProcess(options: CreateCustomLintProcessOptions = {}): ProcessRunner {
  const { ensureProjectGraph = ensureNxProjectGraphCache, lockSafetyValveMs = LOCK_SAFETY_VALVE_MS, seedActivityIntervalMs } = options;

  return async (cwd, _target, context): Promise<ProcessResult> => {
    const { onActivity, changedPaths = null } = context ?? {};
    const dir = options.dir ?? createDiskSandbox(cwd).root;
    const { instance, resultsByFile } = await getInstance(cwd, dir);
    if (instance === NO_CUSTOM_RULES) {
      return { exitCode: 0, output: 'no custom-rules config present; nothing to check' };
    }

    // `null` (unknown/full scope — first-ever check, or right after a
    // pause()/resume() cycle) is handled inside `lintScoped` itself
    // (every candidate needs a real check). A specific workspace-metadata
    // path is different: those files aren't lint candidates at all, so
    // `lintScoped` would never otherwise notice them — clear the per-file
    // cache directly here so every candidate is treated as "no cached
    // opinion" for this one check, without rebuilding the instance itself
    // (see WORKSPACE_METADATA_EXTENSIONS's own doc comment for why a
    // rebuild wouldn't help further, and for what this does and doesn't fix).
    if (changedPaths !== null && [...changedPaths].some((path) => WORKSPACE_METADATA_EXTENSIONS.has(extname(path)))) {
      resultsByFile.clear();
    }

    // Best-effort: if seeding fails, @nx/enforce-module-boundaries just
    // skips itself and prints its own notice — which withStdioCaptured
    // below still keeps out of Cabinet's own console either way. A
    // successful seed's own warnings (e.g. runProcessCommand's
    // performance-degradation notice when the seed spawn is trending toward
    // its own timeout) are still folded in below, though — that's real
    // signal about this repo's own Nx workspace, not something to discard.
    //
    // Ticked via tickWhilePending, not left silent: this is a real, one-time
    // (per repo checkout — see ensureNxProjectGraphCache's own cache-file
    // check) cold-start cost with no per-file granularity of its own, and it
    // was caught live taking ~40s against this repo's own first-ever run —
    // comfortably past `SignalWedgeMonitor`'s tiny default `idlePatienceMs`
    // with no tick at all. It's real, bounded work, though (capped by
    // ensureNxProjectGraphCache's own DEFAULT_SEED_TIMEOUT_MS via
    // runProcessCommand's subprocess kill) — a periodic tick here is an
    // honest "still alive, doing known bounded work" signal, not a claim of
    // false fine-grained progress.
    const seedWarnings =
      (await tickWhilePending(ensureProjectGraph(cwd).catch(() => undefined), onActivity, seedActivityIntervalMs)) ?? [];

    const { value: results, captured } = await withStdioCaptured(
      () => lintScoped(instance, cwd, resultsByFile, changedPaths, onActivity),
      lockSafetyValveMs
    );
    const errorCount = results.reduce((sum, result) => sum + result.errorCount, 0);
    const format = (result: (typeof results)[number], m: (typeof results)[number]['messages'][number]) =>
      `${result.filePath}:${m.line}:${m.column} ${m.message} (${m.ruleId ?? 'unknown'})`;
    // ESLint message severity: 1 = warn, 2 = error.
    const failureMessages = results.flatMap((result) => result.messages.filter((m) => m.severity === 2).map((m) => format(result, m)));
    const lintWarnings = results.flatMap((result) => result.messages.filter((m) => m.severity === 1).map((m) => format(result, m)));
    const warnings = [...lintWarnings, ...seedWarnings];
    const output = failureMessages.join('\n');

    if (errorCount === 0) {
      return { exitCode: 0, output, warnings };
    }
    return { exitCode: 1, output: captured.trim() ? `${output}\n\n${captured.trim()}` : output, warnings };
  };
}

export const runCustomLint: ProcessRunner = createCustomLintProcess();

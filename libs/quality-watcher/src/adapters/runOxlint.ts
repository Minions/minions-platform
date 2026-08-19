/**
 * Oxlint process runner.
 *
 * Oxlint is fast enough (whole ~40-project workspace in ~1-2s) that it
 * doesn't need any affected-scoping — every debounced check just re-scans
 * the whole work repo directly.
 *
 * Not every work repo has oxlint installed. Behavior depends on what the
 * repo actually has:
 *   - own oxlint, own `.oxlintrc(.jsonc)`: run the repo's oxlint, its config.
 *   - own oxlint, no config of its own: run the repo's oxlint against
 *     DEFAULT_OXLINT_CONFIG (see defaultOxlintConfig.ts) — a repo has to
 *     supply its own config file to change that, not just skip it.
 *   - no oxlint, no tsconfig.json: nothing TS to check here — instant pass,
 *     same convention as runCustomLint's "no config present" case.
 *   - no oxlint, tsconfig.json present: this repo has TypeScript to lint
 *     but no oxlint of its own. If a `fallback` was supplied (see
 *     createOxlintProcess), it lints with Cabinet's own oxlint instead
 *     (against the repo's own config if it has one, DEFAULT_OXLINT_CONFIG
 *     otherwise). If no fallback is available at all, or installing one
 *     fails, this reports `fail` with an explanation — a TS repo silently
 *     getting zero lint coverage is worse than a visible, actionable error.
 */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDiskSandbox, type Directory } from '@minions/file-store';
import { runProcessCommand, type ProcessRunner, type ProcessRunnerContext, type ProcessResult } from './runProcess.js';
import { DEFAULT_OXLINT_CONFIG } from './defaultOxlintConfig.js';
import {
  hasWorkRepoPackage,
  resolveFromSources,
  defaultResolvePackage,
  type PackageResolver,
  type PackageSource,
  type PackageResolution,
} from './resolveWorkRepoPackage.js';

export type { PackageResolver };

const OWN_CONFIG_FILENAMES = ['.oxlintrc.json', '.oxlintrc.jsonc'];

/**
 * How long an oxlint run gets before it's killed and treated as a failed
 * run — required by `runProcessCommand`, not just belt-and-suspenders here:
 * oxlint normally finishes a whole ~40-project workspace in ~1-2s (see the
 * file doc comment above), so a full minute is already generous headroom
 * for a slow machine, while still bounding a genuinely hung process instead
 * of leaving this signal wedged forever.
 */
const OXLINT_TIMEOUT_MS = 60 * 1000;

/** Which oxlint to run: the repo's own install, or Cabinet's fallback binary. */
type OxlintTarget = { kind: 'own' } | { kind: 'fallback'; binaryPath: string };

/** First source: the repo's own oxlint — see hasWorkRepoPackage in resolveWorkRepoPackage.ts. */
function ownOxlintSource(resolvePackage: PackageResolver): PackageSource<OxlintTarget> {
  return (cwd) => (hasWorkRepoPackage(cwd, 'oxlint', resolvePackage) ? { kind: 'ok', value: { kind: 'own' } } : { kind: 'not-found' });
}

/**
 * Second source, tried only once the first comes up empty: Cabinet's own
 * installable oxlint (see ensureFallbackOxlint.ts in apps/cabinet). Not
 * worth provisioning at all when there's no TypeScript here to check, and
 * not offered when the caller wired no fallback in the first place — both
 * report `not-found`, same as the repo's own oxlint being absent. Actual
 * provisioning failure (`ensureBinary()` rejecting) is a real operational
 * error, not "nothing here" — it's left to propagate out of
 * `resolveFromSources`, per that function's contract, rather than being
 * folded into `not-found`.
 */
function fallbackOxlintSource(fallback: FallbackOxlint | undefined, dir: Directory): PackageSource<OxlintTarget> {
  return async () => {
    if (!(await hasTypeScript(dir)) || !fallback) return { kind: 'not-found' };
    const binaryPath = await fallback.ensureBinary();
    return { kind: 'ok', value: { kind: 'fallback', binaryPath } };
  };
}

/** Whether `dir` has one of its own `.oxlintrc(.jsonc)` config files. */
async function hasOwnConfig(dir: Directory): Promise<boolean> {
  for (const filename of OWN_CONFIG_FILENAMES) {
    const result = await dir.child(filename);
    if (result.found) return true;
  }
  return false;
}

async function hasTypeScript(dir: Directory): Promise<boolean> {
  const result = await dir.child('tsconfig.json');
  return result.found;
}

let materializedDefaultConfigPath: string | null = null;

/** Writes DEFAULT_OXLINT_CONFIG to a real file once per process (oxlint's `--config` needs a path, not stdin) and reuses it after. */
export function materializeDefaultOxlintConfig(): string {
  if (materializedDefaultConfigPath) return materializedDefaultConfigPath;
  const dir = mkdtempSync(join(tmpdir(), 'minions-cabinet-oxlint-'));
  const path = join(dir, '.oxlintrc.json');
  writeFileSync(path, JSON.stringify(DEFAULT_OXLINT_CONFIG));
  materializedDefaultConfigPath = path;
  return path;
}

/** Provides Cabinet's own oxlint binary for repos that don't have one — see ensureFallbackOxlint.ts in apps/cabinet. */
export type FallbackOxlint = {
  /** Resolves to an absolute path to a working oxlint binary, installing it if necessary. Safe to call repeatedly — implementations should cache/memoize the install. */
  ensureBinary(): Promise<string>;
};

export type CreateOxlintProcessOptions = {
  fallback?: FallbackOxlint;
  resolvePackage?: PackageResolver;
  materializeDefaultConfig?: () => string;
};

/**
 * Same shape as `ProcessRunner`, plus an optional trailing `dir` — the
 * file-store `Directory` used for config detection (own `.oxlintrc(.jsonc)`,
 * `tsconfig.json`), defaulting to a disk sandbox rooted at `cwd` when
 * omitted. Placed after `context` (unused here — a single subprocess call
 * has no finer-grained progress to report, and its own doc comment already
 * explains why it needs no affected-scoping either) so this stays
 * assignable to plain `ProcessRunner` wherever callers don't need to inject
 * a Directory (see the `runOxlint` export below); tests inject one directly
 * to avoid touching the real filesystem.
 */
export type OxlintProcessRunner = (cwd: string, target: string, context?: ProcessRunnerContext, dir?: Directory) => Promise<ProcessResult>;

export function createOxlintProcess(options: CreateOxlintProcessOptions = {}): OxlintProcessRunner {
  const {
    fallback,
    resolvePackage = defaultResolvePackage,
    materializeDefaultConfig = materializeDefaultOxlintConfig,
  } = options;

  return async (cwd: string, _target?: string, _context?: ProcessRunnerContext, dir: Directory = createDiskSandbox(cwd).root): Promise<ProcessResult> => {
    const configArgs = (await hasOwnConfig(dir)) ? [] : ['--config', materializeDefaultConfig()];

    let resolution: PackageResolution<OxlintTarget>;
    try {
      resolution = await resolveFromSources(cwd, [ownOxlintSource(resolvePackage), fallbackOxlintSource(fallback, dir)]);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return {
        exitCode: 1,
        output: `couldn't install oxlint: ${reason} — install oxlint in this repo yourself, or check Cabinet's network access.`,
      };
    }

    if (resolution.kind !== 'ok') {
      if (!(await hasTypeScript(dir))) {
        return { exitCode: 0, output: 'no oxlint installed and no tsconfig.json present; nothing to check' };
      }
      return {
        exitCode: 1,
        output: 'this repo has TypeScript but no oxlint installed, and Cabinet has no fallback oxlint configured',
      };
    }

    return resolution.value.kind === 'own'
      ? runOxlintProcess(cwd, 'pnpm', ['exec', 'oxlint', '--format', 'json', ...configArgs, '.'])
      : runOxlintProcess(cwd, resolution.value.binaryPath, ['--format', 'json', ...configArgs, '.']);
  };
}

/** One oxlint JSON diagnostic — see https://oxc.rs/docs/guide/usage/linter/rules (the shape used by `--format json`). */
type OxlintDiagnostic = {
  message: string;
  code: string;
  severity: 'error' | 'warning' | string;
  filename: string;
  labels?: Array<{ span?: { line?: number; column?: number } }>;
};

function formatDiagnostic(d: OxlintDiagnostic): string {
  const span = d.labels?.[0]?.span;
  const where = span?.line != null ? `${d.filename}:${span.line}:${span.column}` : d.filename;
  return `${where} ${d.message} (${d.code})`;
}

/**
 * Runs oxlint with `--format json` and splits its diagnostics by severity
 * into `failures`/`warnings` instead of relying on `--deny-warnings` — that
 * flag would make warning-severity rules fail the process outright, losing
 * the distinction QualityWatcher's warning policy needs (see
 * QualityStatus.applyWarningPolicy: strict-by-default is enforced there,
 * uniformly across every signal, not baked into each tool's own exit code).
 * oxlint's own exit code (still respected here) already reflects only
 * error-severity findings without that flag, so it needs no adjustment.
 *
 * Falls back to the raw process result untouched if the output isn't valid
 * JSON at all (e.g. a crash before oxlint could produce a report) — nothing
 * to split in that case, and the raw text is still useful as the failure.
 */
async function runOxlintProcess(cwd: string, command: string, args: string[]): Promise<ProcessResult> {
  const result = await runProcessCommand(cwd, command, args, {}, OXLINT_TIMEOUT_MS);
  let parsed: { diagnostics?: OxlintDiagnostic[] };
  try {
    parsed = JSON.parse(result.output);
  } catch {
    return result;
  }
  const diagnostics = parsed.diagnostics ?? [];
  const failures = diagnostics.filter((d) => d.severity === 'error').map(formatDiagnostic);
  const diagnosticWarnings = diagnostics.filter((d) => d.severity === 'warning').map(formatDiagnostic);
  // `result.warnings` carries runProcessCommand's own performance-degradation
  // notice (see its PERF_DEGRADED_THRESHOLD_FRACTION) when this run took a
  // large chunk of OXLINT_TIMEOUT_MS — merge it in rather than overwrite it.
  const warnings = [...diagnosticWarnings, ...(result.warnings ?? [])];
  return { exitCode: result.exitCode, output: failures.length > 0 ? failures.join('\n') : result.output, warnings };
}

/**
 * Runs via `pnpm exec oxlint` rather than a bare `oxlint` — see runProcess.ts
 * for why (resolves the workspace-local binary through pnpm rather than
 * assuming it's on the spawning process's ambient PATH). No fallback wired:
 * a TS repo with no oxlint of its own reports `fail` rather than silently
 * passing. Cabinet wires a real fallback via createOxlintProcess directly —
 * see ensureFallbackOxlint.ts.
 */
export const runOxlint: ProcessRunner = createOxlintProcess();

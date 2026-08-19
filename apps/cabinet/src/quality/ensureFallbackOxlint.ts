/**
 * Lazily installs Cabinet's own oxlint — used by the oxlint quality signal
 * (see @minions/quality-watcher's createOxlintProcess) for work repos that
 * have TypeScript but no oxlint of their own installed.
 *
 * Installed once per lair, shared by every wing: `<lairRoot>/tools/runtime/
 * deps/` gets its own tiny package.json pinning an exact oxlint version and
 * (if pnpm itself needs bootstrapping) an exact pnpm version via Corepack —
 * matching the workspace's own `packageManager` pin, so the fallback isn't
 * silently running a different pnpm than the rest of the lair.
 *
 * oxlint ships its real binary as per-platform optional npm packages
 * (`@oxlint/win32-x64`, `@oxlint/darwin-arm64`, ...); a plain install always
 * resolves the right one for whatever machine it actually runs on. That's
 * why this installs lazily at first use rather than being bundled once at
 * build time — a zip built on one platform would only ever contain that
 * platform's binary.
 */

import spawn from 'cross-spawn';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDiskSandbox, type Directory } from '@minions/file-store';
import type { FallbackOxlint } from '@minions/quality-watcher';

export type SpawnResult = { exitCode: number; output: string };

/** Injectable so tests never spawn a real process. */
export type Spawner = (command: string, args: string[], cwd: string) => Promise<SpawnResult>;

// Build-time constants injected by esbuild (see apps/cabinet/scripts/build.js)
// from the workspace root's own package.json — undefined in dev, where this
// file runs unbundled and reads that same package.json directly instead (see
// resolveVersionPins below). Either way, bumping the workspace's own
// `packageManager`/`oxlint` pin carries through automatically instead of
// silently drifting from a hardcoded copy here.
declare const __WORKSPACE_PNPM_PACKAGE_MANAGER__: string | undefined;
declare const __WORKSPACE_OXLINT_VERSION_RANGE__: string | undefined;

type VersionPins = { pnpmPackageManager: string; oxlintVersionRange: string };

function resolveVersionPins(): VersionPins {
  if (typeof __WORKSPACE_PNPM_PACKAGE_MANAGER__ !== 'undefined' && typeof __WORKSPACE_OXLINT_VERSION_RANGE__ !== 'undefined') {
    return { pnpmPackageManager: __WORKSPACE_PNPM_PACKAGE_MANAGER__, oxlintVersionRange: __WORKSPACE_OXLINT_VERSION_RANGE__ };
  }
  // Dev mode: this file isn't bundled (only Cabinet's production build
  // flattens it — see resolveWorkRepoVite.ts for what a relative lookup like
  // this looks like once that happens), so a real path relative to this
  // file's own location safely reaches the workspace root's package.json.
  const workspacePkgPath = join(dirname(fileURLToPath(import.meta.url)), '../../../../package.json');
  const pkg = JSON.parse(readFileSync(workspacePkgPath, 'utf-8')) as {
    packageManager: string;
    devDependencies: Record<string, string>;
  };
  return { pnpmPackageManager: pkg.packageManager, oxlintVersionRange: pkg.devDependencies.oxlint };
}

export const defaultSpawner: Spawner = (command, args, cwd) =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on('exit', (code) => resolve({ exitCode: code ?? 1, output }));
    child.on('error', (err) => resolve({ exitCode: 1, output: output + String(err) }));
  });

// Relative (posix-separated) name of the deps directory and the installed
// binary, as understood by the injected Directory — kept separate from the
// real, OS-joined path strings below (depsDirFor/binaryPathFor), which are
// still needed verbatim: one is passed as `cwd` to the real spawner
// subprocess, the other is returned to callers that spawn the binary itself.
const DEPS_DIR_RELATIVE = 'tools/runtime/deps';

function binaryNameForPlatform(): string {
  return process.platform === 'win32' ? 'oxlint.CMD' : 'oxlint';
}

function binaryRelativePath(): string {
  return `${DEPS_DIR_RELATIVE}/node_modules/.bin/${binaryNameForPlatform()}`;
}

function depsDirFor(lairRoot: string): string {
  return join(lairRoot, 'tools', 'runtime', 'deps');
}

function binaryPathFor(lairRoot: string): string {
  return join(depsDirFor(lairRoot), 'node_modules', '.bin', binaryNameForPlatform());
}

async function ensurePnpmAvailable(depsDir: string, spawner: Spawner): Promise<{ command: string; baseArgs: string[] }> {
  const pnpmCheck = await spawner('pnpm', ['--version'], depsDir);
  if (pnpmCheck.exitCode === 0) {
    return { command: 'pnpm', baseArgs: [] };
  }

  const corepackEnable = await spawner('corepack', ['enable'], depsDir);
  if (corepackEnable.exitCode !== 0) {
    throw new Error(`pnpm isn't installed and Corepack couldn't enable it: ${corepackEnable.output.trim() || 'unknown error'}`);
  }
  // Corepack reads depsDir's own package.json `packageManager` field, so
  // `corepack pnpm ...` here fetches and runs exactly what that field pins.
  return { command: 'corepack', baseArgs: ['pnpm'] };
}

async function installOxlint(lairRoot: string, spawner: Spawner, dir: Directory): Promise<string> {
  const depsDir = depsDirFor(lairRoot);
  const binaryPath = binaryPathFor(lairRoot);
  if ((await dir.child(binaryRelativePath())).found) return binaryPath;

  const { pnpmPackageManager, oxlintVersionRange } = resolveVersionPins();

  // createFile creates any missing parent directories automatically, so this
  // alone materializes tools/runtime/deps/ too — no separate mkdir needed.
  await dir.createFile(
    `${DEPS_DIR_RELATIVE}/package.json`,
    JSON.stringify(
      {
        name: 'cabinet-runtime-deps',
        private: true,
        packageManager: pnpmPackageManager,
        dependencies: { oxlint: oxlintVersionRange },
      },
      null,
      2
    ) + '\n'
  );

  const { command, baseArgs } = await ensurePnpmAvailable(depsDir, spawner);
  const installResult = await spawner(command, [...baseArgs, 'install', '--prod'], depsDir);
  if (installResult.exitCode !== 0) {
    throw new Error(`pnpm install failed: ${installResult.output.trim() || 'unknown error'}`);
  }

  if (!(await dir.child(binaryRelativePath())).found) {
    throw new Error(`pnpm install succeeded but oxlint's binary wasn't found at ${binaryPath}`);
  }
  return binaryPath;
}

/**
 * Builds a FallbackOxlint scoped to one lair. `ensureBinary()` is safe to
 * call repeatedly and concurrently — the actual install runs at most once
 * per process (subsequent calls share the same in-flight promise), and a
 * failure clears the cache so a later call can retry rather than being
 * wedged for the rest of the process's lifetime.
 */
export function createFallbackOxlint(
  lairRoot: string,
  spawner: Spawner = defaultSpawner,
  dir: Directory = createDiskSandbox(lairRoot).root
): FallbackOxlint {
  let inFlight: Promise<string> | null = null;

  return {
    ensureBinary(): Promise<string> {
      if (!inFlight) {
        inFlight = installOxlint(lairRoot, spawner, dir).catch((err: unknown) => {
          inFlight = null;
          throw err;
        });
      }
      return inFlight;
    },
  };
}

/**
 * Vue-TSC Watch Signal Runner
 *
 * Production `types` signal: `vue-tsc --watch --noEmit --pretty false` as a
 * single persistent subprocess for the work repo's lifetime (see
 * ProcessWatchSignalRunner — spawned once, not per file change). vue-tsc
 * wraps tsc's own watch machinery with a Vue-aware LanguageServiceHost, so
 * it type-checks `.vue` <script>/<script setup> blocks that plain `tsc`
 * cannot see at all (see the quality-watcher-integration discomfort notes:
 * this gap is why some type errors only ever showed up at `vite build`
 * time) while still being tsc's own incremental builder for everything
 * else — no less correct or slower than plain tsc for non-Vue projects.
 *
 * `--pretty false` disables tsc's colorized/clear-screen watch output,
 * which would otherwise corrupt parseTscWatchOutput's line-based parsing.
 *
 * Spawned by resolving the work repo's own installed `vue-tsc` bin entry
 * and running it directly via `process.execPath`, NOT via `pnpm exec
 * vue-tsc` — an earlier version went through `pnpm exec` with `shell: true`,
 * which on Windows runs the command through an intermediary `cmd.exe` (and
 * `pnpm`'s own `.cmd` shim on top of that). The pid Node hands back is that
 * outer wrapper's, not the real vue-tsc.js worker's — and confirmed live,
 * that wrapper reliably exits on its own well before the worker does,
 * orphaning it from the OS's own parent-child bookkeeping. At that point
 * `killProcessTree`'s `taskkill /pid <wrapper> /t /f` has nothing to walk
 * from (the wrapper pid no longer exists) and the real worker survives
 * indefinitely — this is what accumulated as dozens of leaked `vue-tsc
 * --watch` processes across wings. Spawning the resolved entry file
 * directly makes `child.pid` the real worker's own pid (a direct child of
 * Cabinet's own process), so it's always reachable to kill regardless of
 * any wrapper's lifetime.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { IEventBus } from '@minions/events';
import { SignalType } from '../SignalState.js';
import { ProcessWatchSignalRunner, type WatchedChildProcess } from './ProcessWatchSignalRunner.js';
import { parseTscWatchOutput } from './parseTscWatchOutput.js';
import { defaultResolvePackage, type PackageResolver } from './resolveWorkRepoPackage.js';

/**
 * Resolves the work repo's own installed `vue-tsc` bin entry (its `package.json`'s
 * `bin.vue-tsc`, falling back to the conventional `bin/vue-tsc.js` if that field is
 * somehow missing) — never one bundled into Cabinet itself, same convention as
 * resolveWorkRepoVite.ts/resolveWorkRepoVitest.ts. Exported for testing.
 */
export function resolveVueTscEntry(cwd: string, resolvePackage: PackageResolver = defaultResolvePackage): string {
  const pkgJsonPath = resolvePackage('vue-tsc/package.json', cwd);
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as { bin?: Record<string, string> };
  const binRelPath = pkg.bin?.['vue-tsc'] ?? 'bin/vue-tsc.js';
  return path.join(path.dirname(pkgJsonPath), binRelPath);
}

function defaultSpawnVueTsc(cwd: string): WatchedChildProcess {
  const entryPath = resolveVueTscEntry(cwd);
  return spawn(process.execPath, [entryPath, '--watch', '--noEmit', '--pretty', 'false'], { cwd });
}

export class VueTscWatchSignalRunner extends ProcessWatchSignalRunner {
  constructor(cwd: string, eventBus: IEventBus, spawnProcess: (cwd: string) => WatchedChildProcess = defaultSpawnVueTsc) {
    super(SignalType.Types, () => spawnProcess(cwd), parseTscWatchOutput, eventBus);
  }
}

import { describe, it, expect, vi } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { EventBus } from '@minions/events';
import { VueTscWatchSignalRunner, resolveVueTscEntry } from './VueTscWatchSignalRunner.js';
import { SignalType } from '../SignalState.js';
import type { WatchedChildProcess } from './ProcessWatchSignalRunner.js';
import type { PackageResolver } from './resolveWorkRepoPackage.js';

function fakeChildProcess() {
  let stdoutListener: ((chunk: string) => void) | null = null;
  const child: WatchedChildProcess = {
    stdout: { on: (_event, listener) => { stdoutListener = listener; } },
    stderr: { on: () => undefined },
    kill: () => undefined,
  };
  return { child, emit: (chunk: string) => stdoutListener?.(chunk) };
}

describe('VueTscWatchSignalRunner', () => {
  it('spawns vue-tsc watch in the given cwd exactly once', async () => {
    const { child } = fakeChildProcess();
    const spawnProcess = vi.fn(() => child);
    const runner = new VueTscWatchSignalRunner('/wing/work/local', new EventBus(), spawnProcess);

    await runner.start();

    expect(spawnProcess).toHaveBeenCalledWith('/wing/work/local');
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  it('reports the Types signal type', () => {
    const runner = new VueTscWatchSignalRunner('/wing/work/local', new EventBus(), () => fakeChildProcess().child);
    expect(runner.signalType).toBe(SignalType.Types);
  });

  it('parses vue-tsc watch output the same way tsc watch output is parsed', async () => {
    const { child, emit } = fakeChildProcess();
    const runner = new VueTscWatchSignalRunner('/wing/work/local', new EventBus(), () => child);
    await runner.start();

    emit('Found 0 errors. Watching for file changes.\n');

    expect(runner.getState().state).toBe('pass');
  });
});

describe('resolveVueTscEntry', () => {
  /** Writes a fake `vue-tsc/package.json` under a fresh temp dir and returns a resolver that points at it. */
  function fakeInstalledVueTsc(pkg: Record<string, unknown>): PackageResolver {
    const dir = mkdtempSync(join(tmpdir(), 'resolve-vue-tsc-'));
    const pkgPath = join(dir, 'package.json');
    writeFileSync(pkgPath, JSON.stringify(pkg));
    return vi.fn((specifier: string, _cwd: string) => {
      if (specifier === 'vue-tsc/package.json') return pkgPath;
      throw new Error(`unexpected specifier: ${specifier}`);
    });
  }

  it('resolves the real worker entry file from the bin.vue-tsc field, not a shell wrapper', () => {
    const resolvePackage = fakeInstalledVueTsc({ version: '2.0.0', bin: { 'vue-tsc': './bin/vue-tsc.js' } });

    const entryPath = resolveVueTscEntry('/wing/work/local', resolvePackage);

    expect(entryPath.endsWith(join('bin', 'vue-tsc.js'))).toBe(true);
  });

  it('falls back to the conventional bin/vue-tsc.js path when the bin field is missing', () => {
    const resolvePackage = fakeInstalledVueTsc({ version: '2.0.0' });
    const pkgJsonPath = resolvePackage('vue-tsc/package.json', '/wing/work/local');

    const entryPath = resolveVueTscEntry('/wing/work/local', resolvePackage);

    expect(entryPath).toBe(join(dirname(pkgJsonPath), 'bin', 'vue-tsc.js'));
  });
});

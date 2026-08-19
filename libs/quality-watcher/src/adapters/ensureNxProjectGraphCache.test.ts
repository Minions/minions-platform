import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createInMemorySandbox } from '@minions/file-store';
import type { Directory } from '@minions/file-store';
import { ensureNxProjectGraphCache, resetNxProjectGraphCache, DEFAULT_SEED_TIMEOUT_MS, type Spawner } from './ensureNxProjectGraphCache.js';

vi.mock('cross-spawn', () => ({ default: vi.fn() }));

function tempDir(): Directory {
  return createInMemorySandbox().root;
}

async function cacheExists(dir: Directory): Promise<boolean> {
  const nxResult = await dir.child('.nx');
  if (!nxResult.found || nxResult.node.kind !== 'directory') return false;
  const workspaceDataResult = await nxResult.node.child('workspace-data');
  if (!workspaceDataResult.found || workspaceDataResult.node.kind !== 'directory') return false;
  const graphResult = await workspaceDataResult.node.child('project-graph.json');
  return graphResult.found && graphResult.node.kind === 'file';
}

async function writeCache(dir: Directory): Promise<void> {
  const nx = await dir.createDirectory('.nx');
  const workspaceData = await nx.createDirectory('workspace-data');
  await workspaceData.createFile('project-graph.json', '{}');
}

describe('ensureNxProjectGraphCache', () => {
  it('does nothing for a cwd with no nx.json — not an Nx workspace, nothing to seed', async () => {
    const cwd = 'fake-cwd-1';
    const dir = tempDir();
    const spawner: Spawner = vi.fn();

    await ensureNxProjectGraphCache(cwd, spawner, dir);

    expect(spawner).not.toHaveBeenCalled();
  });

  it('does nothing if the cache already exists', async () => {
    const cwd = 'fake-cwd-2';
    const dir = tempDir();
    await dir.createFile('nx.json', '{}');
    await writeCache(dir);
    const spawner: Spawner = vi.fn();

    await ensureNxProjectGraphCache(cwd, spawner, dir);

    expect(spawner).not.toHaveBeenCalled();
  });

  it('spawns `nx show projects` to seed the cache when it is missing in an Nx workspace', async () => {
    const cwd = 'fake-cwd-3';
    const dir = tempDir();
    await dir.createFile('nx.json', '{}');
    const spawner: Spawner = vi.fn(async () => {
      await writeCache(dir);
      return { exitCode: 0, output: 'proj-a\nproj-b' };
    });

    await ensureNxProjectGraphCache(cwd, spawner, dir);

    expect(spawner).toHaveBeenCalledWith(cwd);
    expect(await cacheExists(dir)).toBe(true);
  });

  it('throws a clear error when the spawn fails, and lets a later call retry', async () => {
    const cwd = 'fake-cwd-4';
    const dir = tempDir();
    await dir.createFile('nx.json', '{}');
    let attempt = 0;
    const spawner: Spawner = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) return { exitCode: 1, output: 'nx: command not found' };
      await writeCache(dir);
      return { exitCode: 0, output: '' };
    });

    await expect(ensureNxProjectGraphCache(cwd, spawner, dir)).rejects.toThrow(/couldn't seed Nx's project graph cache/);
    await ensureNxProjectGraphCache(cwd, spawner, dir);
    expect(await cacheExists(dir)).toBe(true);
  });

  it('shares one in-flight seed across concurrent callers for the same cwd', async () => {
    const cwd = 'fake-cwd-5';
    const dir = tempDir();
    await dir.createFile('nx.json', '{}');
    let spawnCount = 0;
    const spawner: Spawner = vi.fn(async () => {
      spawnCount += 1;
      await new Promise((r) => setTimeout(r, 5));
      await writeCache(dir);
      return { exitCode: 0, output: '' };
    });

    await Promise.all([
      ensureNxProjectGraphCache(cwd, spawner, dir),
      ensureNxProjectGraphCache(cwd, spawner, dir),
      ensureNxProjectGraphCache(cwd, spawner, dir),
    ]);

    expect(spawnCount).toBe(1);
  });

  it('resetNxProjectGraphCache forgets the memoized seed, so a later call spawns again', async () => {
    const cwd = 'fake-cwd-6';
    const dir = tempDir();
    await dir.createFile('nx.json', '{}');
    const spawner: Spawner = vi.fn(async () => {
      await writeCache(dir);
      return { exitCode: 0, output: '' };
    });

    await ensureNxProjectGraphCache(cwd, spawner, dir);
    resetNxProjectGraphCache(cwd);
    // Cache file is still on disk from the first seed, so the second call
    // still shouldn't spawn — it's the on-disk check, not just the memo,
    // that makes repeat seeding a no-op.
    await ensureNxProjectGraphCache(cwd, spawner, dir);

    expect(spawner).toHaveBeenCalledTimes(1);
  });

  it('bounds the real `nx show projects` seed spawn with a timeout, so a hung Nx workspace cannot wedge this forever', async () => {
    vi.useFakeTimers();
    try {
      const cwd = 'fake-cwd-timeout';
      const dir = tempDir();
      await dir.createFile('nx.json', '{}');

      const { default: spawn } = await import('cross-spawn');
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill: () => void;
        pid?: number;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      (child.stdout as EventEmitter & { destroy?: () => void }).destroy = () => undefined;
      (child.stderr as EventEmitter & { destroy?: () => void }).destroy = () => undefined;
      // No real subprocess ever exits on its own here — this stands in for a
      // client repo's Nx workspace state (corrupted project graph, a hung
      // plugin, ...) that makes `nx show projects` never return. kill()
      // simulates the OS actually terminating it, which is what should let
      // runProcessCommand's 'exit' listener finally resolve.
      child.kill = vi.fn(() => child.emit('exit', null));
      (spawn as unknown as ReturnType<typeof vi.fn>).mockReturnValue(child);

      // Attach the rejection assertion synchronously, before advancing fake
      // timers — otherwise the promise can reject mid-advance with no
      // handler attached yet, which Node reports as a (harmless but noisy)
      // unhandled rejection.
      const assertion = expect(ensureNxProjectGraphCache(cwd, undefined, dir)).rejects.toThrow(
        /couldn't seed Nx's project graph cache/
      );
      await vi.advanceTimersByTimeAsync(DEFAULT_SEED_TIMEOUT_MS);
      await assertion;

      expect(child.kill).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

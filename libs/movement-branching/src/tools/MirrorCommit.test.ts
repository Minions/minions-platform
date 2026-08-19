import { describe, it, expect } from 'vitest';
import { createInMemorySandbox, createInMemoryTrunk } from '@minions/file-store';
import type { Mirror } from '@minions/file-store';
import { MockQualityWatcher, SignalType } from '@minions/quality-watcher';
import { MirrorCommit } from './MirrorCommit.js';

function commitMessageOf(mirror: Mirror, hash: string): string | undefined {
  const repo = mirror.trunk.repo as unknown as { getGit(): { getCommit(h: string): { message: string } | undefined } };
  return repo.getGit().getCommit(hash)?.message;
}

async function makeMirror(): Promise<Mirror> {
  const sandbox = createInMemorySandbox();
  const repo = await sandbox.initBare(sandbox.root, 'repo');
  const seed = await repo.createWorktree(sandbox.root, 'seed', 'main');
  await seed.createFile('README.md', 'hello');
  await seed.commitAll('initial commit');
  await repo.removeWorktree(seed);

  const trunk = createInMemoryTrunk(repo, 'main', 'tools');
  return trunk.mirror('plan');
}

function watcherWith(overrides: Partial<Record<'tests' | 'types' | 'build' | 'oxlint' | 'customLint', 'pass' | 'fail'>>): MockQualityWatcher {
  const watcher = new MockQualityWatcher('test-wing');
  const now = new Date();
  const state = (key: 'tests' | 'types' | 'build' | 'oxlint' | 'customLint') =>
    (overrides[key] ?? 'pass') === 'pass'
      ? { state: 'pass' as const, timestamp: now }
      : { state: 'fail' as const, timestamp: now, failures: [`${key} failure`] };

  watcher.setStatus({
    [SignalType.Tests]: state('tests'),
    [SignalType.Types]: state('types'),
    [SignalType.Build]: state('build'),
    [SignalType.OxLint]: state('oxlint'),
    [SignalType.CustomLint]: state('customLint'),
    aggregatedAt: now,
    isPartial: false,
  });
  return watcher;
}

describe('MirrorCommit', () => {
  it('builds an intentional-commit message (type: summary, no risk code) and publishes via Mirror.apply()', async () => {
    const mirror = await makeMirror();
    const commit = new MirrorCommit(mirror);

    const result = await commit.commit({
      transform: async (view) => {
        await view.createFile('plan.toml', 'x = 1');
      },
      type: 'feat',
      summary: 'seed the plan file',
    });

    expect(result.success).toBe(true);
    expect(result.committed).toBe(true);
    expect(result.commitHash).toBeDefined();

    expect(commitMessageOf(mirror, result.commitHash as string)).toBe('feat: seed the plan file');
  });

  it('includes description and coAuthoredBy trailers, same shape as a movement merge message', async () => {
    const mirror = await makeMirror();
    const commit = new MirrorCommit(mirror);

    const result = await commit.commit({
      transform: async (view) => {
        await view.createFile('plan.toml', 'x = 1');
      },
      type: 'bug',
      summary: 'fix a thing',
      description: 'Longer explanation.',
      coAuthoredBy: 'Claude <noreply@anthropic.com>',
    });

    expect(commitMessageOf(mirror, result.commitHash as string)).toBe(
      'fix: fix a thing\n\nLonger explanation.\n\nCo-Authored-By: Claude <noreply@anthropic.com>',
    );
  });

  it('proceeds with no gate at all when no quality watcher is supplied — matches todays no-watcher-available behavior', async () => {
    const mirror = await makeMirror();
    const commit = new MirrorCommit(mirror);

    const result = await commit.commit({
      transform: async (view) => {
        await view.createFile('plan.toml', 'x = 1');
      },
      type: 'chore',
      summary: 'no watcher configured',
    });

    expect(result.success).toBe(true);
    expect(result.committed).toBe(true);
  });

  it('blocks the commit (never calls the transform) when the quality watcher reports a failing signal', async () => {
    const mirror = await makeMirror();
    const watcher = watcherWith({ build: 'fail' });
    const commit = new MirrorCommit(mirror, watcher);

    let transformRan = false;
    const result = await commit.commit({
      transform: async (view) => {
        transformRan = true;
        await view.createFile('plan.toml', 'x = 1');
      },
      type: 'feat',
      summary: 'should not land',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('quality watcher');
    expect(transformRan).toBe(false);
  });

  it('blocks on a failing lint signal by default, but allows it through as advice-only via allowLintErrors', async () => {
    const mirror = await makeMirror();
    const watcher = watcherWith({ customLint: 'fail' });

    const blocked = await new MirrorCommit(mirror, watcher).commit({
      transform: async (view) => {
        await view.createFile('plan.toml', 'x = 1');
      },
      type: 'feat',
      summary: 'lint failing',
    });
    expect(blocked.success).toBe(false);

    const allowed = await new MirrorCommit(mirror, watcher).commit({
      transform: async (view) => {
        await view.createFile('plan.toml', 'x = 1');
      },
      type: 'feat',
      summary: 'lint failing, opted out',
      allowLintErrors: true,
    });
    expect(allowed.success).toBe(true);
    expect(allowed.committed).toBe(true);
  });
});

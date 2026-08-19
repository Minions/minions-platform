import { describe, it, expect } from 'vitest';
import { createInMemorySandbox, createLair, asLairRepoName } from '@minions/file-store';
import type { Directory } from '@minions/file-store';
import { LairRepoPerspective } from './LairRepoPerspective.js';

/** Mirrors `DiskTrunk.ts`/`InMemoryTrunk.ts`'s own `sanitizeBranchForPath`. */
function sanitizeBranchForPath(branch: string): string {
  return branch.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

describe('LairRepoPerspective.resolve', () => {
  const REPO_URL = 'https://example.com/CodeWarp/suite.git';

  async function seedMain(lair: ReturnType<typeof createLair>, bareRepo: Awaited<ReturnType<Awaited<ReturnType<typeof createLair>>['addWorkRepo']>>) {
    const workResult = await lair.root.child('work');
    if (!workResult.found || !workResult.node.is('directory')) throw new Error('expected work dir');
    const mainWorktree = await bareRepo.createWorktree(workResult.node as Directory, 'local', 'main');
    await mainWorktree.createFile('.meta/plan/README.md', '# plan v1');
    await mainWorktree.commitAll('seed main');
    return mainWorktree;
  }

  it('creates the plan/main mirror worktree on demand when it does not exist yet (Mirror has no locate-only mode)', async () => {
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);
    const bareRepo = await lair.addWorkRepo('local', REPO_URL);
    await seedMain(lair, bareRepo);

    const perspective = await LairRepoPerspective.resolve(lair, asLairRepoName('local'));

    expect(perspective.repoName).toBe('local');
    expect(perspective.bareRepo).toBe(bareRepo);
    expect(perspective.worktree.branch).toBe('plan/main');
    const cabinetDir = await lair.cabinet();
    expect(perspective.worktree.path).toBe(`${cabinetDir.path}/planning/__mirror__${sanitizeBranchForPath('plan/main')}`);

    // The mirror is a real, fresh-synced worktree: seeded content is visible.
    const readme = await perspective.worktree.child('.meta/plan/README.md');
    expect(readme.found).toBe(true);
  });

  it('resolving twice reuses the same mirror worktree rather than recreating it', async () => {
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);
    const bareRepo = await lair.addWorkRepo('local', REPO_URL);
    await seedMain(lair, bareRepo);

    const first = await LairRepoPerspective.resolve(lair, asLairRepoName('local'));
    const before = (await bareRepo.worktrees()).length;
    const second = await LairRepoPerspective.resolve(lair, asLairRepoName('local'));
    const after = (await bareRepo.worktrees()).length;

    expect(after).toBe(before);
    expect(second.worktree.path).toBe(first.worktree.path);
  });

  it('throws when the repo is not registered in the lair', async () => {
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);

    await expect(LairRepoPerspective.resolve(lair, asLairRepoName('nope'))).rejects.toThrow(
      'Repo not registered in lair: nope',
    );
  });

  describe('experiment trunk', () => {
    it('creates a trunk-specific mirror distinct from main\'s, on the plan/<trunk> branch', async () => {
      const sandbox = createInMemorySandbox();
      const lair = createLair(sandbox);
      const bareRepo = await lair.addWorkRepo('local', REPO_URL);
      await seedMain(lair, bareRepo);
      await bareRepo.createBranchIfMissing('experiment/foo', 'main');

      const mainPerspective = await LairRepoPerspective.resolve(lair, asLairRepoName('local'));
      const expPerspective = await LairRepoPerspective.resolve(lair, asLairRepoName('local'), 'experiment/foo');

      expect(expPerspective.worktree.branch).toBe('plan/experiment/foo');
      expect(expPerspective.worktree.path).not.toBe(mainPerspective.worktree.path);
      const cabinetDir = await lair.cabinet();
      expect(expPerspective.worktree.path).toBe(
        `${cabinetDir.path}/planning/__mirror__${sanitizeBranchForPath('plan/experiment/foo')}`,
      );
    });
  });
});

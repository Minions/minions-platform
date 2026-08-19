import { describe, it, expect, vi } from 'vitest';
import {
  createInMemorySandbox,
  createLair,
  asWingName,
  asRepoAlias,
  asLairRepoName,
  createWorkAreaFactoriesForSandbox,
} from '@minions/file-store';
import type { Lair, Wing, Worktree, WorkArea } from '@minions/file-store';
import { WingPerspective } from './WingPerspective.js';

const mockWingName = asWingName('workshop-03');

function makeMockWing(overrides: Partial<Wing>): Wing {
  return {
    name: 'workshop-03',
    workLocal: vi.fn().mockResolvedValue({ exists: false }),
    workNamed: vi.fn().mockResolvedValue({ exists: false }),
    namedWorkNames: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as Wing;
}

function makeMockLair(wing: Wing): Lair {
  return { wing: vi.fn().mockResolvedValue({ exists: true, wing }) } as unknown as Lair;
}

describe('WingPerspective.resolve', () => {
  const REPO_URL = 'https://example.com/CodeWarp/suite.git';

  async function makeFixture() {
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);
    const bareRepo = await lair.addWorkRepo('local', REPO_URL);
    const wing = await lair.createWing('workshop-03', { workLocal: { repo: 'local', branch: 'main' } });
    const workLocalResult = await wing.workLocal();
    if (!workLocalResult.exists) throw new Error('expected work/local to exist');
    await workLocalResult.worktree.createFile('.meta/plan/README.md', '# plan v1');
    await workLocalResult.worktree.commitAll('seed main');
    return { sandbox, lair, bareRepo, wing };
  }

  it('resolves work/local for repoAlias "local"', async () => {
    const { lair } = await makeFixture();

    const perspective = await WingPerspective.resolve(lair, asWingName('workshop-03'), asRepoAlias('local'));

    expect(perspective.wingName).toBe('workshop-03');
    expect(perspective.repoAlias).toBe('local');
    expect(perspective.worktree.branch).toBe('main');
  });

  it('exposes the wing and lair objects', async () => {
    const { lair } = await makeFixture();

    const perspective = await WingPerspective.resolve(lair, asWingName('workshop-03'), asRepoAlias('local'));

    expect(perspective.wing.name).toBe('workshop-03');
    expect(perspective.lair).toBe(lair);
  });

  it('exposes the backing bareRepo as worktree.repository', async () => {
    const { lair, bareRepo } = await makeFixture();

    const perspective = await WingPerspective.resolve(lair, asWingName('workshop-03'), asRepoAlias('local'));

    expect(perspective.bareRepo).toBe(bareRepo);
  });

  it('throws a clear error when the wing does not exist', async () => {
    const { lair } = await makeFixture();

    await expect(
      WingPerspective.resolve(lair, asWingName('no-such-wing'), asRepoAlias('local')),
    ).rejects.toThrow('Wing not found: no-such-wing');
  });

  it('throws a clear error when a named repo does not exist for the wing', async () => {
    const { lair } = await makeFixture();

    await expect(
      WingPerspective.resolve(lair, asWingName('workshop-03'), asRepoAlias('billing')),
    ).rejects.toThrow(/Repo 'billing' not found for wing workshop-03/);
  });

  describe('resolve — named-repo edge cases (mocked Wing)', () => {
    it('resolves a named work repo backed by a full worktree', async () => {
      const worktree = {} as Worktree;
      const wing = makeMockWing({
        workNamed: vi.fn().mockResolvedValue({ exists: true, kind: 'worktree', path: '/wing/work/billing', worktree }),
      });

      const perspective = await WingPerspective.resolve(makeMockLair(wing), mockWingName, asRepoAlias('billing'));
      expect(perspective.worktree).toBe(worktree);
    });

    it('resolves a named work repo backed by a junction-worktree', async () => {
      const worktree = {} as Worktree;
      const wing = makeMockWing({
        workNamed: vi.fn().mockResolvedValue({
          exists: true,
          kind: 'junction-worktree',
          path: '/wing/work/billing',
          junction: {},
          worktree,
        }),
      });

      const perspective = await WingPerspective.resolve(makeMockLair(wing), mockWingName, asRepoAlias('billing'));
      expect(perspective.worktree).toBe(worktree);
    });

    it('throws a clear "not yet supported" error for a plain junction (no backing worktree)', async () => {
      const wing = makeMockWing({
        workNamed: vi.fn().mockResolvedValue({ exists: true, kind: 'junction', path: '/wing/work/billing', junction: {} }),
      });

      await expect(
        WingPerspective.resolve(makeMockLair(wing), mockWingName, asRepoAlias('billing')),
      ).rejects.toThrow("Repo 'billing' is a same-repo subdir link and is not yet supported here");
    });

    it('throws a clear error listing available repos when the named repo does not exist', async () => {
      const wing = makeMockWing({
        workNamed: vi.fn().mockResolvedValue({ exists: false }),
        namedWorkNames: vi.fn().mockResolvedValue(['billing', 'catalog']),
      });

      await expect(
        WingPerspective.resolve(makeMockLair(wing), mockWingName, asRepoAlias('nope')),
      ).rejects.toThrow('Available repos: local, billing, catalog');
    });

    it('lists just "local" as available when the wing has no named repos', async () => {
      const wing = makeMockWing({
        workNamed: vi.fn().mockResolvedValue({ exists: false }),
        namedWorkNames: vi.fn().mockResolvedValue([]),
      });

      await expect(
        WingPerspective.resolve(makeMockLair(wing), mockWingName, asRepoAlias('nope')),
      ).rejects.toThrow('Available repos: local');
    });
  });

  describe('workArea()', () => {
    it('resolves the local WorkArea when the Lair was built with WorkAreaFactories', async () => {
      const sandbox = createInMemorySandbox();
      const workAreaFactories = createWorkAreaFactoriesForSandbox(sandbox, sandbox.root);
      const lair = createLair(sandbox, workAreaFactories);
      await lair.addWorkRepo('local', REPO_URL);
      await lair.createWing('workshop-03', { workLocal: { repo: 'local', branch: 'main' } });

      const perspective = await WingPerspective.resolve(lair, asWingName('workshop-03'), asRepoAlias('local'));
      const workArea = await perspective.workArea();

      expect(workArea.repo).toBe(perspective.bareRepo);
      const movement = await workArea.activeMovement();
      expect(movement.branch).toBe('main');
    });

    it('throws the same clear error wing.workAreaLocal() throws when the Lair was built without WorkAreaFactories', async () => {
      const { lair } = await makeFixture();

      const perspective = await WingPerspective.resolve(lair, asWingName('workshop-03'), asRepoAlias('local'));

      await expect(perspective.workArea()).rejects.toThrow(/WorkAreaFactories/);
    });

    it('resolves a named repo\'s WorkArea via wing.workAreaNamed()', async () => {
      const workArea = {} as WorkArea;
      const wing = makeMockWing({
        workAreaNamed: vi.fn().mockResolvedValue(workArea),
        workNamed: vi.fn().mockResolvedValue({ exists: true, kind: 'worktree', path: '/wing/work/billing', worktree: {} as Worktree }),
      });

      const perspective = await WingPerspective.resolve(makeMockLair(wing), mockWingName, asRepoAlias('billing'));

      expect(await perspective.workArea()).toBe(workArea);
      expect(wing.workAreaNamed).toHaveBeenCalledWith(asRepoAlias('billing'));
    });

    it('throws a clear error when the named repo has no WorkArea (e.g. a plain junction)', async () => {
      const wing = makeMockWing({
        workAreaNamed: vi.fn().mockResolvedValue(undefined),
        workNamed: vi.fn().mockResolvedValue({ exists: true, kind: 'worktree', path: '/wing/work/billing', worktree: {} as Worktree }),
      });

      const perspective = await WingPerspective.resolve(makeMockLair(wing), mockWingName, asRepoAlias('billing'));

      await expect(perspective.workArea()).rejects.toThrow(/has no WorkArea/);
    });
  });

  describe('toLairRepo', () => {
    it('locates the LairRepoPerspective for the wing repo\'s registered bare-repo name', async () => {
      const { lair } = await makeFixture();
      const wingPerspective = await WingPerspective.resolve(lair, asWingName('workshop-03'), asRepoAlias('local'));

      const lairPerspective = await wingPerspective.toLairRepo();

      expect(lairPerspective.repoName).toBe(asLairRepoName('local'));
      expect(lairPerspective.bareRepo).toBe(wingPerspective.bareRepo);
    });

    it('is a trivial hop: creates the plan/main mirror on demand when it does not exist yet (LairRepoPerspective.resolve has no locate-only mode)', async () => {
      const { lair } = await makeFixture();
      const wingPerspective = await WingPerspective.resolve(lair, asWingName('workshop-03'), asRepoAlias('local'));

      const lairPerspective = await wingPerspective.toLairRepo();

      expect(lairPerspective.worktree.branch).toBe('plan/main');
    });

    it('follows the wing worktree\'s own trunk override to that trunk\'s mirror, not plan/main', async () => {
      const { lair, bareRepo } = await makeFixture();
      await bareRepo.createBranchIfMissing('experiment/foo', 'main');
      const wingPerspective = await WingPerspective.resolve(lair, asWingName('workshop-03'), asRepoAlias('local'));
      await wingPerspective.worktree.setBaseBranch('experiment/foo');

      const lairPerspective = await wingPerspective.toLairRepo();

      expect(lairPerspective.worktree.branch).toBe('plan/experiment/foo');
    });
  });
});

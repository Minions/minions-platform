import { describe, it, expect } from 'vitest';
import {
  listArchives,
  addArchive,
  removeArchive
} from './ArchiveService.js';
import type { Lair, BareRepository, ReadOnlyClone, PrivateRepoResult } from '@minions/file-store';
import { createInMemorySandbox, createLair, simulateRemote, asLairRepoName } from '@minions/file-store';
import { LairRepoPerspective, resolveConductorMirror } from '@minions/repo-perspective';

/**
 * Create a mock Lair for testing
 */
function createMockLair(options: {
  workRepos?: BareRepository[];
  infoRepos?: ReadOnlyClone[];
  privateLocal?: { exists: boolean; repo?: BareRepository };
  privateGlobal?: { exists: boolean; repo?: BareRepository };
} = {}): Lair {
  const workRepos = options.workRepos ?? [];
  const infoRepos = options.infoRepos ?? [];
  const privateLocal = options.privateLocal ?? { exists: false };
  const privateGlobal = options.privateGlobal ?? { exists: false };

  return {
    workRepos: async () => workRepos,
    infoRepos: async () => infoRepos,
    privateRepo: async (scope: 'local' | 'global'): Promise<PrivateRepoResult> => {
      if (scope === 'local') {
        return privateLocal.exists && privateLocal.repo
          ? { exists: true, repo: privateLocal.repo }
          : { exists: false, scope: 'local' };
      }
      return privateGlobal.exists && privateGlobal.repo
        ? { exists: true, repo: privateGlobal.repo }
        : { exists: false, scope: 'global' };
    },
    workRepo: async (name: string) => {
      const repo = workRepos.find(r => r.name === `${name}.git` || r.name === name);
      return repo
        ? { exists: true, repo }
        : { exists: false };
    },
    infoRepo: async (name: string) => {
      const clone = infoRepos.find(c => c.name === name);
      return clone
        ? { exists: true, clone }
        : { exists: false };
    },
    addWorkRepo: async (name: string, url: string): Promise<BareRepository> => ({
      kind: 'bare-repository',
      name: `${name}.git`,
      path: `/test/root/work/${name}.git`,
      url,
    } as BareRepository),
    addInfoRepo: async (name: string, url: string): Promise<ReadOnlyClone> => ({
      kind: 'read-only-clone',
      name,
      path: `/test/root/info/${name}`,
      url,
    } as ReadOnlyClone),
    initPrivateRepo: async (scope: 'local' | 'global'): Promise<BareRepository> => ({
      kind: 'bare-repository',
      name: scope,
      path: `/test/root/private/${scope}`,
      url: null,
    } as BareRepository),
  } as unknown as Lair;
}

describe('ArchiveService', () => {
  describe('listArchives', () => {
    it('lists all archives from lair', async () => {
      const lair = createMockLair({
        workRepos: [{
          kind: 'bare-repository',
          name: 'test-work.git',
          path: '/test/root/work/test-work.git',
          url: 'https://github.com/test/repo.git',
        } as BareRepository],
        infoRepos: [{
          kind: 'read-only-clone',
          name: 'test-info',
          path: '/test/root/info/test-info',
          url: 'https://github.com/test/info.git',
        } as ReadOnlyClone],
        privateLocal: {
          exists: true,
          repo: {
            kind: 'bare-repository',
            name: 'local',
            path: '/test/root/private/local',
            url: null,
          } as BareRepository
        }
      });

      const result = await listArchives(lair);

      expect(result.archives).toHaveLength(3);
      expect(result.archives[0].name).toBe('test-work');
      expect(result.archives[0].type).toBe('work');
      expect(result.archives[0].remoteUrl).toBe('https://github.com/test/repo.git');
      expect(result.archives[1].name).toBe('test-info');
      expect(result.archives[2].name).toBe('local');
      expect(result.archives[2].remoteUrl).toBeUndefined();
    });

    it('returns empty array when no archives exist', async () => {
      const lair = createMockLair();

      const result = await listArchives(lair);

      expect(result.archives).toHaveLength(0);
    });

    it('throws error when lair is not initialized', async () => {
      await expect(
        listArchives(null as unknown as Lair)
      ).rejects.toThrow('Lair not initialized');
    });
  });

  describe('addArchive', () => {
    it('adds a work archive with URL', async () => {
      const lair = createMockLair();

      const result = await addArchive(
        lair,
        'work',
        'test-repo',
        'https://github.com/test/repo.git'
      );

      expect(result.message).toContain('test-repo');
      expect(result.message).toContain('work/');
      expect(result.archive.name).toBe('test-repo');
      expect(result.archive.type).toBe('work');
      expect(result.archive.remoteUrl).toBe('https://github.com/test/repo.git');
    });

    it('adds an info archive with URL', async () => {
      const lair = createMockLair();

      const result = await addArchive(
        lair,
        'info',
        'test-docs',
        'https://github.com/test/docs.git'
      );

      expect(result.message).toContain('test-docs');
      expect(result.message).toContain('info/');
      expect(result.archive.name).toBe('test-docs');
      expect(result.archive.type).toBe('info');
      expect(result.archive.remoteUrl).toBe('https://github.com/test/docs.git');
    });

    it('adds a private archive without URL', async () => {
      const lair = createMockLair();

      const result = await addArchive(
        lair,
        'private',
        'local'
      );

      expect(result.message).toContain('local');
      expect(result.message).toContain('private/');
      expect(result.archive.name).toBe('local');
      expect(result.archive.type).toBe('private');
      expect(result.archive.remoteUrl).toBeUndefined();
    });

    it('throws error when lair is not initialized', async () => {
      await expect(
        addArchive(null as unknown as Lair, 'work', 'test-repo', 'https://github.com/test/repo.git')
      ).rejects.toThrow('Lair not initialized');
    });

    it('throws error when type is not provided', async () => {
      const lair = createMockLair();

      await expect(
        addArchive(lair, '' as unknown as 'work' | 'info' | 'private', 'test-repo', 'https://github.com/test/repo.git')
      ).rejects.toThrow('Archive type and name are required');
    });

    it('throws error when name is not provided', async () => {
      const lair = createMockLair();

      await expect(
        addArchive(lair, 'work', '', 'https://github.com/test/repo.git')
      ).rejects.toThrow('Archive type and name are required');
    });

    it('throws error when URL is missing for work archive', async () => {
      const lair = createMockLair();

      await expect(
        addArchive(lair, 'work', 'test-repo')
      ).rejects.toThrow('URL is required for work archives');
    });

    it('throws error when URL is missing for info archive', async () => {
      const lair = createMockLair();

      await expect(
        addArchive(lair, 'info', 'test-docs')
      ).rejects.toThrow('URL is required for info archives');
    });

    it('throws error for invalid archive type', async () => {
      const lair = createMockLair();

      await expect(
        addArchive(lair, 'invalid' as unknown as 'work' | 'info' | 'private', 'test-repo', 'https://github.com/test/repo.git')
      ).rejects.toThrow('Invalid archive type');
    });
  });

  describe('addArchive — plan mirror bootstrap', () => {
    const REPO_URL = 'https://example.com/CodeWarp/suite.git';

    async function seedRemoteMain(sandbox: ReturnType<typeof createInMemorySandbox>) {
      const remote = simulateRemote(sandbox, REPO_URL);
      const remoteMain = await remote.createWorktree(sandbox.root, 'remote-seed', 'main');
      await remoteMain.createFile('.meta/plan/README.md', '# plan v1');
      await remoteMain.commitAll('seed origin main');
      return remote;
    }

    it('makes the new work repo\'s plan mirror immediately queryable, with no wait for a periodic sync', async () => {
      const sandbox = createInMemorySandbox();
      const lair = createLair(sandbox);
      await seedRemoteMain(sandbox);

      await addArchive(lair, 'work', 'local', REPO_URL);

      // `LairRepoPerspective.resolve()` needs LOCAL `main` to already
      // resolve — `addWorkRepo`'s (simulated) clone only seeds
      // `origin/main`, matching a real fresh `git clone --bare`'s remote-
      // tracking refs, but NOT a real bare clone's local branches (which a
      // real `git clone --bare` mirrors from origin directly — an
      // intentional InMemory/Disk fidelity gap, see
      // `LairRepoPerspective.ts`'s `resolveTrunkHandle` doc comment). This
      // test performs that realignment itself.
      const workRepoForSeed = await lair.workRepo('local');
      if (!workRepoForSeed.exists) throw new Error('expected work repo to exist');
      await workRepoForSeed.repo.updateBranch('main', 'origin/main');

      const perspective = await LairRepoPerspective.resolve(lair, asLairRepoName('local'));
      expect(perspective.repoName).toBe('local');
    });

    it('the plan mirror stays fresh after main advances further, with no cascade/intertwining needed', async () => {
      // addArchive's plan-mirror bootstrap does not intertwine
      // main/plan/main — under invariant A, plan/main is purely local,
      // never pushed to origin (design doc §4.2). Freshness instead comes
      // from `LairRepoPerspective.resolve()` constructing a brand-new
      // `Trunk.mirror()` on every call, which fast-forwards to the trunk's
      // CURRENT tip at construction time (design doc §4.1) — so a second
      // resolve(), after main has advanced again, sees the new content with
      // no explicit sync step and no persisted cross-branch relationship.
      const sandbox = createInMemorySandbox();
      const lair = createLair(sandbox);
      await seedRemoteMain(sandbox);

      const result = await addArchive(lair, 'work', 'local', REPO_URL);

      const workRepo = await lair.workRepo(result.archive.name);
      if (!workRepo.exists) throw new Error('expected work repo to exist');
      const seedWorktree = await workRepo.repo.createWorktree(sandbox.root, 'advance-main', 'main');
      await seedWorktree.createFile('.meta/plan/second.md', '# second');
      await seedWorktree.commitAll('advance main further');

      const perspective = await LairRepoPerspective.resolve(lair, asLairRepoName('local'));
      expect((await perspective.worktree.child('.meta/plan/second.md')).found).toBe(true);
    });

    it('makes the new work repo\'s conductor state immediately queryable too — via the SAME plan mirror worktree, no separate conductor branch', async () => {
      // There is no separate `conductor/<trunk>` branch to intertwine/push.
      // Conductor state (`.meta/conductor/…`) lives on the SAME
      // `plan/<trunk>` mirror worktree plan itself uses (see
      // `@minions/repo-perspective`'s `resolveConductorMirror`), materialized
      // by the same `addArchive` bootstrap touch that already makes the plan
      // mirror queryable (see the test just above).
      const sandbox = createInMemorySandbox();
      const lair = createLair(sandbox);
      await seedRemoteMain(sandbox);

      await addArchive(lair, 'work', 'local', REPO_URL);

      // `resolveConductorMirror`/`LairRepoPerspective.resolve` both need
      // LOCAL `main` to already resolve to a real commit — `addWorkRepo`'s
      // clone only seeds `origin/main` (matching a real fresh `git clone
      // --bare`). `addArchive`'s own best-effort plan-mirror bootstrap
      // (inside a try/catch) silently no-ops against a repo with no local
      // `main` yet — see the "stays fresh" test above, which materializes
      // local `main` by checking out and committing on it directly; this
      // test uses the cheaper realignment instead (same as
      // `ExperimentsService.test.ts`'s `beforeEach`).
      const workRepoForSeed = await lair.workRepo('local');
      if (!workRepoForSeed.exists) throw new Error('expected work repo to exist');
      await workRepoForSeed.repo.updateBranch('main', 'origin/main');

      const conductorMirror = await resolveConductorMirror(lair, asLairRepoName('local'));
      const planPerspective = await LairRepoPerspective.resolve(lair, asLairRepoName('local'));
      expect(conductorMirror.trunk.branch).toBe('main');
      expect(conductorMirror.files.path).toBe(planPerspective.worktree.path);

      const { committed, commitHash } = await conductorMirror.apply(async (view) => {
        await view.createFile('.meta/conductor/experiments.json', '{"experiments":[]}');
      });
      expect(committed).toBe(true);
      const workRepo = await lair.workRepo('local');
      if (!workRepo.exists) throw new Error('expected work repo to exist');
      expect(await workRepo.repo.resolveLocalRef('main')).toBe(commitHash);
    });
  });

  describe('removeArchive', () => {
    it('removes an archive and returns confirmation', async () => {
      let deleteCalled = false;
      const mockRepo = {
        kind: 'bare-repository',
        name: 'test-repo.git',
        path: '/test/root/work/test-repo.git',
        url: 'https://github.com/test/repo.git',
        delete: async () => { deleteCalled = true; }
      } as unknown as BareRepository;

      const lair = createMockLair({
        workRepos: [mockRepo]
      });

      const result = await removeArchive(lair, 'work', 'test-repo');

      expect(result.message).toContain('test-repo');
      expect(result.message).toContain('work/');
      expect(result.removedArchive).toBe('test-repo');
      expect(deleteCalled).toBe(true);
    });

    it('removes an info archive', async () => {
      let deleteCalled = false;
      const mockClone = {
        kind: 'read-only-clone',
        name: 'test-docs',
        path: '/test/root/info/test-docs',
        url: 'https://github.com/test/docs.git',
        delete: async () => { deleteCalled = true; }
      } as unknown as ReadOnlyClone;

      const lair = createMockLair({
        infoRepos: [mockClone]
      });

      const result = await removeArchive(lair, 'info', 'test-docs');

      expect(result.message).toContain('test-docs');
      expect(result.message).toContain('info/');
      expect(result.removedArchive).toBe('test-docs');
      expect(deleteCalled).toBe(true);
    });

    it('removes a private archive', async () => {
      let deleteCalled = false;
      const mockRepo = {
        kind: 'bare-repository',
        name: 'local',
        path: '/test/root/private/local',
        url: null,
        delete: async () => { deleteCalled = true; }
      } as unknown as BareRepository;

      const lair = createMockLair({
        privateLocal: { exists: true, repo: mockRepo }
      });

      const result = await removeArchive(lair, 'private', 'local');

      expect(result.message).toContain('local');
      expect(result.message).toContain('private/');
      expect(result.removedArchive).toBe('local');
      expect(deleteCalled).toBe(true);
    });

    it('throws error when lair is not initialized', async () => {
      await expect(
        removeArchive(null as unknown as Lair, 'work', 'test-repo')
      ).rejects.toThrow('Lair not initialized');
    });

    it('throws error when type is not provided', async () => {
      const lair = createMockLair();

      await expect(
        removeArchive(lair, '' as unknown as 'work' | 'info' | 'private', 'test-repo')
      ).rejects.toThrow('Archive type and name are required');
    });

    it('throws error when name is not provided', async () => {
      const lair = createMockLair();

      await expect(
        removeArchive(lair, 'work', '')
      ).rejects.toThrow('Archive type and name are required');
    });
  });
});

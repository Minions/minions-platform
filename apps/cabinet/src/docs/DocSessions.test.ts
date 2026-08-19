import { describe, it, expect, beforeEach } from 'vitest';
import {
  createInMemorySandbox,
  createLair,
  type Sandbox,
  type Lair,
  type BareRepository,
  type Worktree,
} from '@minions/file-store';
import { DocSessions, type DocSessionKey } from './DocSessions.js';

async function makeWorkRepo(sandbox: Sandbox, name: string): Promise<BareRepository> {
  const workDir = await sandbox.root.createDirectory('work');
  const repo = await sandbox.initBare(workDir, `${name}.git`);
  const mainWt = await repo.createWorktree(sandbox.root, `${name}-main`, 'main');
  await mainWt.createFile('README.md', '# hi');
  await mainWt.commitAll('init');
  return repo;
}

describe('DocSessions', () => {
  let sandbox: Sandbox;
  let lair: Lair;
  let sessions: DocSessions;

  beforeEach(async () => {
    sandbox = createInMemorySandbox();
    lair = createLair(sandbox);
    sessions = new DocSessions(lair);
  });

  describe('createSession', () => {
    it('creates only a branch, no worktree', async () => {
      const repo = await makeWorkRepo(sandbox, 'suite');
      const key: DocSessionKey = { repoKind: 'work', repoName: 'suite', branch: 'docs/edit-1' };

      await sessions.createSession(key, 'main');

      expect(await repo.branches()).toContain('docs/edit-1');
      const worktrees = await repo.worktrees();
      expect(worktrees.some(wt => wt.branch === 'docs/edit-1')).toBe(false);
    });

    it('records advisory paths/purpose in meta without materializing a worktree', async () => {
      const repo = await makeWorkRepo(sandbox, 'suite');
      const key: DocSessionKey = { repoKind: 'work', repoName: 'suite', branch: 'docs/edit-1' };

      await sessions.createSession(key, 'main', { paths: ['README.md'], purpose: 'reviewing the readme' });

      const meta = await sessions.getMeta(key);
      expect(meta?.paths).toEqual(['README.md']);
      expect(meta?.purpose).toBe('reviewing the readme');
      expect((await repo.worktrees()).some(wt => wt.branch === 'docs/edit-1')).toBe(false);
    });

    it('is idempotent — reopening never moves an existing branch', async () => {
      await makeWorkRepo(sandbox, 'suite');
      const key: DocSessionKey = { repoKind: 'work', repoName: 'suite', branch: 'docs/edit-1' };

      await sessions.createSession(key, 'main');
      const movement = await sessions.materialize(key);
      await movement.files.createFile('extra.md', '# extra');
      await movement.commit({ message: 'add extra' });

      // Reopening with the same base ref must not reset the branch's new commit.
      await sessions.createSession(key, 'main');

      const reMaterialized = await sessions.materialize(key);
      const children = await reMaterialized.files.children();
      expect(children.map(c => c.name)).toContain('extra.md');
    });

    it('records commitRef in meta — the default diff base for the session', async () => {
      const repo = await makeWorkRepo(sandbox, 'suite');
      const key: DocSessionKey = { repoKind: 'work', repoName: 'suite', branch: 'docs/edit-1' };
      const mainWt = (await repo.worktrees())[0];
      await mainWt.createFile('base.md', '# base');
      const baseSha = await mainWt.commitAll('add base.md');

      await sessions.createSession(key, baseSha);

      const meta = await sessions.getMeta(key);
      expect(meta?.commitRef).toBe(baseSha);
    });

    it('reopening with a new commitRef does not overwrite the originally recorded one', async () => {
      await makeWorkRepo(sandbox, 'suite');
      const key: DocSessionKey = { repoKind: 'work', repoName: 'suite', branch: 'docs/edit-1' };

      await sessions.createSession(key, 'main');
      await sessions.createSession(key, 'main'); // idempotent reopen

      const meta = await sessions.getMeta(key);
      expect(meta?.commitRef).toBe('main');
    });

    it('rejects "main" as the session branch — main must never be checked out into a worktree', async () => {
      await makeWorkRepo(sandbox, 'suite');
      const key: DocSessionKey = { repoKind: 'work', repoName: 'suite', branch: 'main' };

      await expect(sessions.createSession(key, 'main')).rejects.toThrow(/main/i);
    });
  });

  describe('materialize', () => {
    it('creates the worktree under cabinet/docs/sessions/<kind>/<repo>/<branch>', async () => {
      await makeWorkRepo(sandbox, 'suite');
      const key: DocSessionKey = { repoKind: 'work', repoName: 'suite', branch: 'docs/edit-1' };
      await sessions.createSession(key, 'main');

      const movement = await sessions.materialize(key);

      expect((movement.files as Worktree).path).toContain('cabinet/docs/sessions/work/suite/docs/edit-1');
    });

    it('rejects "main" as the session branch even if createSession was bypassed', async () => {
      await makeWorkRepo(sandbox, 'suite');
      const key: DocSessionKey = { repoKind: 'work', repoName: 'suite', branch: 'main' };

      await expect(sessions.materialize(key)).rejects.toThrow(/main/i);
    });

    it('is idempotent — second call reuses the same worktree', async () => {
      await makeWorkRepo(sandbox, 'suite');
      const key: DocSessionKey = { repoKind: 'work', repoName: 'suite', branch: 'docs/edit-1' };
      await sessions.createSession(key, 'main');

      const first = await sessions.materialize(key);
      const second = await sessions.materialize(key);

      expect((second.files as Worktree).path).toBe((first.files as Worktree).path);
      const repo = (await lair.workRepo('suite')) as { exists: true; repo: BareRepository };
      expect((await repo.repo.worktrees()).length).toBe(2); // main-wt + the one session worktree
    });

    it('does not collide when a work repo and a private repo share a name and branch', async () => {
      await makeWorkRepo(sandbox, 'local');
      const privateRepo = await sandbox.initBare(await sandbox.root.createDirectory('private'), 'local');
      const mainWt = await privateRepo.createWorktree(sandbox.root, 'private-main', 'main');
      await mainWt.createFile('notes.md', '# notes');
      await mainWt.commitAll('init');

      const workKey: DocSessionKey = { repoKind: 'work', repoName: 'local', branch: 'docs/edit-1' };
      const privateKey: DocSessionKey = { repoKind: 'private', repoName: 'local', branch: 'docs/edit-1' };
      await sessions.createSession(workKey, 'main');
      await sessions.createSession(privateKey, 'main');

      const workWt = await sessions.materialize(workKey);
      const privateWt = await sessions.materialize(privateKey);

      expect((workWt.files as Worktree).path).not.toBe((privateWt.files as Worktree).path);
    });

    it('returns a CheckedOutMovement whose Movement half (state/commitsSince) reflects real commits', async () => {
      const repo = await makeWorkRepo(sandbox, 'suite');
      const mainWt = (await repo.worktrees())[0];
      const baseSha = await mainWt.commitAll('noop'); // same tree, but gives a stable "since" point
      const key: DocSessionKey = { repoKind: 'work', repoName: 'suite', branch: 'docs/edit-1' };
      await sessions.createSession(key, baseSha);

      const movement = await sessions.materialize(key);
      expect(await movement.state()).toBe('integrated'); // no commits yet beyond base

      await movement.files.createFile('extra.md', '# extra');
      const { hash } = await movement.commit({ message: 'add extra' });

      expect(await movement.state()).toBe('in-progress');
      const commits = await movement.commitsSince(baseSha);
      expect(commits.map(c => c.hash)).toEqual([hash]);
    });

    it('readFileAtRef reads a file\'s content at an arbitrary historical ref (design doc §4.1)', async () => {
      const repo = await makeWorkRepo(sandbox, 'suite');
      const key: DocSessionKey = { repoKind: 'work', repoName: 'suite', branch: 'docs/edit-1' };
      await sessions.createSession(key, 'main');
      const movement = await sessions.materialize(key);

      await movement.files.createFile('doc.md', '# v1');
      const { hash: firstHash } = await movement.commit({ message: 'add doc.md' });
      await movement.files.createFile('doc.md', '# v2');
      await movement.commit({ message: 'update doc.md' });

      expect(await movement.readFileAtRef(firstHash, 'doc.md')).toBe('# v1');
      expect(await movement.readFileAtRef('docs/edit-1', 'doc.md')).toBe('# v2');
      expect(await movement.readFileAtRef(firstHash, 'nonexistent.md')).toBeNull();

      // Reads main's own README too — never scoped to the session branch only.
      const mainWt = (await repo.worktrees())[0];
      expect(mainWt.branch).toBe('main');
      expect(await movement.readFileAtRef('main', 'README.md')).toBe('# hi');
    });
  });

  describe('unsupported CheckedOutMovement operations (finding #16)', () => {
    it('start() throws a documented-unsupported error', async () => {
      await makeWorkRepo(sandbox, 'suite');
      const key: DocSessionKey = { repoKind: 'work', repoName: 'suite', branch: 'docs/edit-1' };
      await sessions.createSession(key, 'main');
      const movement = await sessions.materialize(key);

      expect(() => movement.start()).toThrow(/not supported/i);
    });

    it('resolveConflict() throws a documented-unsupported error', async () => {
      await makeWorkRepo(sandbox, 'suite');
      const key: DocSessionKey = { repoKind: 'work', repoName: 'suite', branch: 'docs/edit-1' };
      await sessions.createSession(key, 'main');
      const movement = await sessions.materialize(key);

      expect(() => movement.resolveConflict()).toThrow(/not supported/i);
    });

    it('merge() throws a documented-unsupported error rather than CAS-publishing against commitRef', async () => {
      const repo = await makeWorkRepo(sandbox, 'suite');
      const key: DocSessionKey = { repoKind: 'work', repoName: 'suite', branch: 'docs/edit-1' };
      await sessions.createSession(key, 'main');
      const movement = await sessions.materialize(key);
      await movement.files.createFile('extra.md', '# extra');
      await movement.commit({ message: 'add extra' });

      expect(() => movement.merge({})).toThrow(/not supported/i);

      // No publish attempt should have touched main's tip.
      const mainWt = (await repo.worktrees())[0];
      expect(mainWt.branch).toBe('main');
    });

    it('rebaseOnto() throws a documented-unsupported error', async () => {
      await makeWorkRepo(sandbox, 'suite');
      const key: DocSessionKey = { repoKind: 'work', repoName: 'suite', branch: 'docs/edit-1' };
      await sessions.createSession(key, 'main');
      const movement = await sessions.materialize(key);

      expect(() => movement.rebaseOnto('main')).toThrow(/not supported/i);
    });

    it('cherryPick() throws a documented-unsupported error', async () => {
      await makeWorkRepo(sandbox, 'suite');
      const key: DocSessionKey = { repoKind: 'work', repoName: 'suite', branch: 'docs/edit-1' };
      await sessions.createSession(key, 'main');
      const movement = await sessions.materialize(key);

      expect(() => movement.cherryPick(['main'])).toThrow(/not supported/i);
    });
  });

  describe('close', () => {
    it('removes the worktree but leaves the branch and its commits intact', async () => {
      const repo = await makeWorkRepo(sandbox, 'suite');
      const key: DocSessionKey = { repoKind: 'work', repoName: 'suite', branch: 'docs/edit-1' };
      await sessions.createSession(key, 'main');
      await sessions.materialize(key);

      await sessions.close(key);

      expect((await repo.worktrees()).some(wt => wt.branch === 'docs/edit-1')).toBe(false);
      expect(await repo.branches()).toContain('docs/edit-1');
    });

    it('is safe to call on a session that was never materialized', async () => {
      await makeWorkRepo(sandbox, 'suite');
      const key: DocSessionKey = { repoKind: 'work', repoName: 'suite', branch: 'docs/edit-1' };
      await sessions.createSession(key, 'main');

      await expect(sessions.close(key)).resolves.not.toThrow();
    });
  });

  describe('reapStale', () => {
    it('removes worktrees idle past the ttl and leaves fresh ones', async () => {
      const repo = await makeWorkRepo(sandbox, 'suite');
      const staleKey: DocSessionKey = { repoKind: 'work', repoName: 'suite', branch: 'docs/stale' };
      const freshKey: DocSessionKey = { repoKind: 'work', repoName: 'suite', branch: 'docs/fresh' };
      await sessions.createSession(staleKey, 'main');
      await sessions.createSession(freshKey, 'main');
      await sessions.materialize(staleKey);
      await sessions.materialize(freshKey);

      // Backdate the stale session's meta sidecar past the ttl.
      const cabinetDir = await lair.cabinet();
      const staleMetaResult = await cabinetDir.child('docs/meta/work/suite/docs/stale/meta.json');
      expect(staleMetaResult.found).toBe(true);
      if (staleMetaResult.found && staleMetaResult.node.is('file')) {
        const meta = JSON.parse(await staleMetaResult.node.read());
        meta.lastActivityAt = new Date(Date.now() - 1000 * 60 * 60).toISOString();
        await staleMetaResult.node.write(JSON.stringify(meta));
      }

      const reaped = await sessions.reapStale(1000 * 60 * 30);

      expect(reaped).toEqual([staleKey]);
      expect((await repo.worktrees()).some(wt => wt.branch === 'docs/stale')).toBe(false);
      expect((await repo.worktrees()).some(wt => wt.branch === 'docs/fresh')).toBe(true);
    });

    it('returns an empty array when no sessions have ever materialized', async () => {
      const reaped = await sessions.reapStale(1000);
      expect(reaped).toEqual([]);
    });
  });
});

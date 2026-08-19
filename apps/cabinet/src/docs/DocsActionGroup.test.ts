import { describe, it, expect } from 'vitest';
import { createInMemorySandbox, createLair, type Sandbox, type Directory, type BareRepository } from '@minions/file-store';
import { createDocsActionGroup } from './DocsActionGroup.js';

interface ActionContext {
  lair: Sandbox;
  wingName?: string;
}

async function makeWorkRepo(sandbox: Sandbox, name: string): Promise<BareRepository> {
  const workDir = await sandbox.root.createDirectory('work');
  const repo = await sandbox.initBare(workDir, `${name}.git`);
  const mainWt = await repo.createWorktree(sandbox.root, `${name}-main`, 'main');
  await mainWt.createFile('README.md', '# hi');
  await mainWt.commitAll('init');
  return repo;
}

describe('createDocsActionGroup', () => {
  it('returns an ActionGroupDef named "docs" with the expected actions', () => {
    const group = createDocsActionGroup(3434);
    expect(group.name).toBe('docs');
    expect(Object.keys(group.coreActions).sort()).toEqual(['close', 'list', 'load', 'open', 'save']);
    expect(Object.keys(group.secondaryActions ?? {})).toEqual(['status']);
  });

  describe('open', () => {
    it('creates only a branch and returns a shareable URL', async () => {
      const sandbox = createInMemorySandbox();
      const repo = await makeWorkRepo(sandbox, 'suite');
      const ctx: ActionContext = { lair: sandbox };
      const group = createDocsActionGroup(3434);

      const result = await group.coreActions.open.execute(ctx, {
        repoKind: 'work', repo: 'suite', branch: 'docs/edit-1', commitRef: 'main',
      }) as { url: string };

      expect(result.url).toBe('http://localhost:3434/docs?repoKind=work&repo=suite&branch=docs%2Fedit-1');
      expect(await repo.branches()).toContain('docs/edit-1');
      expect((await repo.worktrees()).some(wt => wt.branch === 'docs/edit-1')).toBe(false);
    });
  });

  describe('list + load + save', () => {
    it('materializes on first list, then load/save/list round-trip', async () => {
      const sandbox = createInMemorySandbox();
      await makeWorkRepo(sandbox, 'suite');
      const ctx: ActionContext = { lair: sandbox };
      const group = createDocsActionGroup(3434);

      await group.coreActions.open.execute(ctx, {
        repoKind: 'work', repo: 'suite', branch: 'docs/edit-1', commitRef: 'main',
      });

      // First list materializes the worktree — freshly branched from 'main'
      // (via commitRef), so it starts with main's existing content, not empty.
      const listResult = await group.coreActions.list.execute(ctx, {
        repoKind: 'work', repo: 'suite', branch: 'docs/edit-1',
      }) as { files: string[]; readOnly: boolean };
      expect(listResult.readOnly).toBe(false);
      expect(listResult.files).toEqual(['README.md']);

      const saveResult = await group.coreActions.save.execute(ctx, {
        repoKind: 'work', repo: 'suite', branch: 'docs/edit-1', path: 'notes.md', content: '# notes',
      }) as { commitHash: string };
      expect(saveResult.commitHash).toBeTruthy();

      const loadResult = await group.coreActions.load.execute(ctx, {
        repoKind: 'work', repo: 'suite', branch: 'docs/edit-1', path: 'notes.md',
      }) as { content: string };
      expect(loadResult.content).toBe('# notes');

      const listAfterSave = await group.coreActions.list.execute(ctx, {
        repoKind: 'work', repo: 'suite', branch: 'docs/edit-1',
      }) as { files: string[] };
      expect(listAfterSave.files).toContain('notes.md');
    });
  });

  describe('load with ref', () => {
    it('reads content at the given ref instead of the live worktree file', async () => {
      const sandbox = createInMemorySandbox();
      const repo = await makeWorkRepo(sandbox, 'suite');
      const mainWt = (await repo.worktrees())[0];
      const baseSha = await mainWt.commitAll('noop');
      const ctx: ActionContext = { lair: sandbox };
      const group = createDocsActionGroup(3434);

      await group.coreActions.open.execute(ctx, {
        repoKind: 'work', repo: 'suite', branch: 'docs/edit-1', commitRef: baseSha,
      });
      await group.coreActions.save.execute(ctx, {
        repoKind: 'work', repo: 'suite', branch: 'docs/edit-1', path: 'README.md', content: '# edited',
      });

      const liveLoad = await group.coreActions.load.execute(ctx, {
        repoKind: 'work', repo: 'suite', branch: 'docs/edit-1', path: 'README.md',
      }) as { content: string; ref?: string };
      expect(liveLoad.content).toBe('# edited');
      expect(liveLoad.ref).toBeUndefined();

      const atRefLoad = await group.coreActions.load.execute(ctx, {
        repoKind: 'work', repo: 'suite', branch: 'docs/edit-1', path: 'README.md', ref: baseSha,
      }) as { content: string; ref?: string };
      expect(atRefLoad.content).toBe('# hi');
      expect(atRefLoad.ref).toBe(baseSha);
    });

    it('echoes the session\'s recorded commitRef on every load, so the client knows the default diff base', async () => {
      const sandbox = createInMemorySandbox();
      const repo = await makeWorkRepo(sandbox, 'suite');
      const mainWt = (await repo.worktrees())[0];
      const baseSha = await mainWt.commitAll('noop');
      const ctx: ActionContext = { lair: sandbox };
      const group = createDocsActionGroup(3434);

      await group.coreActions.open.execute(ctx, {
        repoKind: 'work', repo: 'suite', branch: 'docs/edit-1', commitRef: baseSha,
      });

      const liveLoad = await group.coreActions.load.execute(ctx, {
        repoKind: 'work', repo: 'suite', branch: 'docs/edit-1', path: 'README.md',
      }) as { sessionCommitRef?: string };
      expect(liveLoad.sessionCommitRef).toBe(baseSha);
    });

    it('returns null content when the file did not exist at that ref', async () => {
      const sandbox = createInMemorySandbox();
      const repo = await makeWorkRepo(sandbox, 'suite');
      const mainWt = (await repo.worktrees())[0];
      const baseSha = await mainWt.commitAll('noop');
      const ctx: ActionContext = { lair: sandbox };
      const group = createDocsActionGroup(3434);

      await group.coreActions.open.execute(ctx, {
        repoKind: 'work', repo: 'suite', branch: 'docs/edit-1', commitRef: baseSha,
      });
      await group.coreActions.save.execute(ctx, {
        repoKind: 'work', repo: 'suite', branch: 'docs/edit-1', path: 'new.md', content: '# new file',
      });

      const atRefLoad = await group.coreActions.load.execute(ctx, {
        repoKind: 'work', repo: 'suite', branch: 'docs/edit-1', path: 'new.md', ref: baseSha,
      }) as { content: string | null };
      expect(atRefLoad.content).toBeNull();
    });
  });

  describe('close', () => {
    it('removes the worktree but leaves the branch and commits intact', async () => {
      const sandbox = createInMemorySandbox();
      const repo = await makeWorkRepo(sandbox, 'suite');
      const ctx: ActionContext = { lair: sandbox };
      const group = createDocsActionGroup(3434);

      await group.coreActions.open.execute(ctx, {
        repoKind: 'work', repo: 'suite', branch: 'docs/edit-1', commitRef: 'main',
      });
      await group.coreActions.list.execute(ctx, { repoKind: 'work', repo: 'suite', branch: 'docs/edit-1' });

      await group.coreActions.close.execute(ctx, { repoKind: 'work', repo: 'suite', branch: 'docs/edit-1' });

      expect((await repo.worktrees()).some(wt => wt.branch === 'docs/edit-1')).toBe(false);
      expect(await repo.branches()).toContain('docs/edit-1');
    });
  });

  describe('status', () => {
    it('reports no new commits when sinceSha is already the session branch\'s own tip', async () => {
      const sandbox = createInMemorySandbox();
      await makeWorkRepo(sandbox, 'suite');
      const ctx: ActionContext = { lair: sandbox };
      const group = createDocsActionGroup(3434);

      await group.coreActions.open.execute(ctx, {
        repoKind: 'work', repo: 'suite', branch: 'docs/edit-1', commitRef: 'main',
      });

      const statusAction = group.secondaryActions?.status;
      if (!statusAction) throw new Error('status action not found');
      const statusResult = await statusAction.execute(ctx, {
        repoKind: 'work', repo: 'suite', branch: 'docs/edit-1', sinceSha: 'docs/edit-1',
      }) as { hasNewCommits: boolean };

      expect(statusResult.hasNewCommits).toBe(false);
    });
  });

  describe('info repo (read-only)', () => {
    it('lists and loads without needing a branch or session', async () => {
      const sandbox = createInMemorySandbox();
      const lair = createLair(sandbox);
      await lair.addInfoRepo('docs-source', 'https://example.com/docs-source.git');

      const infoDirResult = await sandbox.root.child('info');
      const infoDir = (infoDirResult as { found: true; node: Directory }).node;
      await infoDir.createFile('docs-source/readme.md', '# from info repo');

      const ctx: ActionContext = { lair: sandbox };
      const group = createDocsActionGroup(3434);

      const listResult = await group.coreActions.list.execute(ctx, {
        repoKind: 'info', repo: 'docs-source',
      }) as { readOnly: boolean; files: string[] };
      expect(listResult.readOnly).toBe(true);
      expect(listResult.files).toContain('readme.md');

      const loadResult = await group.coreActions.load.execute(ctx, {
        repoKind: 'info', repo: 'docs-source', path: 'readme.md',
      }) as { readOnly: boolean; content: string };
      expect(loadResult.readOnly).toBe(true);
      expect(loadResult.content).toBe('# from info repo');
    });
  });
});

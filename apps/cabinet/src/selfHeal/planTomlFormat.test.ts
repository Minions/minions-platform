import { describe, it, expect } from 'vitest';
import {
  createInMemorySandbox,
  createLair,
  simulateRemote,
  canonicalizeRepoUrl,
  repoIdToDirName,
  asLairRepoName,
} from '@minions/file-store';
import type { Directory, File, Sandbox } from '@minions/file-store';
import { LairRepoPerspective } from '@minions/repo-perspective';
import { planTomlFormatHeal } from './planTomlFormat.js';

const REPO_URL = 'https://example.com/CodeWarp/suite.git';

async function ensureDir(parent: Directory, name: string): Promise<Directory> {
  const result = await parent.child(name);
  if (result.found && result.node.is('directory')) return result.node as Directory;
  return parent.createDirectory(name);
}

function legacyIndexJson(rootId: string, title: string): string {
  return JSON.stringify({
    root: rootId,
    items: {
      [rootId]: {
        id: rootId,
        title,
        type: 'task',
        parent: null,
        children: [],
        requires: [],
        criteria: [],
        approved: true,
        questions: [],
      },
    },
  });
}

/**
 * Seeds a remote with a legacy index.json committed on `main`, clones it in
 * as the lair's "local" work repo, and creates a plan/main mirror worktree
 * off that clone (mirroring `bootstrapPlanMirror`'s steady-state layout) that
 * still has the same legacy index.json — the state this heal exists to fix.
 */
async function makeFixture() {
  const sandbox: Sandbox = createInMemorySandbox();
  const lair = createLair(sandbox);
  const remote = simulateRemote(sandbox, REPO_URL);
  const remoteMain = await remote.createWorktree(sandbox.root, 'remote-seed', 'main');
  await remoteMain.createFile('.meta/plan/root1/index.json', legacyIndexJson('root1', 'Legacy root'));
  await remoteMain.commitAll('seed legacy plan data');

  const bareRepo = await lair.addWorkRepo('local', REPO_URL);
  await bareRepo.updateBranch('main', 'origin/main');
  await bareRepo.createBranchIfMissing('plan/main', 'main');
  const repoId = repoIdToDirName(canonicalizeRepoUrl(REPO_URL));
  const cabinetDir = await lair.cabinet();
  const planningDir = await ensureDir(cabinetDir, 'planning');
  const mirrorWorktree = await bareRepo.createSparseWorktree(planningDir, repoId, 'plan/main', '.meta/plan');
  // The in-memory simulator tracks one shared "current branch" per bare repo
  // rather than a real independent HEAD per worktree (see the `branch` field
  // comment on InMemoryWorktree) — so `currentBranch()` needs an explicit
  // switch here to actually report "plan/main" the way a real disk worktree
  // checked out on that branch already would. Only safe when this fixture's
  // repo has exactly one worktree at this point (true for its two callers).
  await mirrorWorktree.switchBranch('plan/main');

  return { sandbox, remote, mirrorWorktree };
}

/**
 * Reads a file at `relPath` under a worktree by walking `.child()` one
 * segment at a time. Nested directories inside a worktree report kind
 * "worktree" here (not "directory") — this in-memory adapter's `children()`
 * only ever returns File | Worktree | Junction — so descent just checks
 * "not a file" rather than a specific directory-like kind.
 */
async function readMirrorFile(mirrorWorktree: Awaited<ReturnType<typeof makeFixture>>['mirrorWorktree'], relPath: string): Promise<string | null> {
  const [dirParts, fileName] = [relPath.split('/').slice(0, -1), relPath.split('/').at(-1) ?? ''];
  let dir: { child(name: string): Promise<{ found: boolean; node?: unknown }> } = mirrorWorktree;
  for (const part of dirParts) {
    const result = await dir.child(part);
    if (!result.found || !result.node || (result.node as { kind: string }).kind === 'file') return null;
    dir = result.node as typeof dir;
  }
  const fileResult = await dir.child(fileName);
  if (!fileResult.found || !fileResult.node || (fileResult.node as { kind: string }).kind !== 'file') return null;
  return (fileResult.node as File).read();
}

describe('planTomlFormatHeal', () => {
  it('check() reports unhealthy while a legacy index.json remains in the plan/main mirror', async () => {
    const { sandbox } = await makeFixture();

    expect(await planTomlFormatHeal.check(sandbox)).toBe(false);
  });

  it('heal() converts the mirror to content.toml and publishes it straight onto main (Mirror.apply(), not commit-then-absorb)', async () => {
    const { sandbox, mirrorWorktree } = await makeFixture();
    const lair = createLair(sandbox);
    const workRepoResult = await lair.workRepo('local');
    if (!workRepoResult.exists) throw new Error('expected "local" repo to be registered');
    const bareRepo = workRepoResult.repo;
    const mainTipBefore = await bareRepo.resolveLocalRef('main');

    await planTomlFormatHeal.heal(sandbox);

    // Not asserting index.json's absence here: the in-memory git
    // simulator's rebase() unions the rebased commit's tree onto its target
    // rather than replaying it as a diff (see SimulatedGit.rebase), so it
    // doesn't propagate a file *deletion* the way real git does — a
    // simulator limitation, not a production behavior. content.toml's
    // presence/content is unaffected by that and is what actually proves
    // the write + commit + publish path ran.
    const content = await readMirrorFile(mirrorWorktree, '.meta/plan/root1/content.toml');
    expect(content).toContain('Legacy root');

    // `Mirror.apply()` publishes straight onto `main`, not `plan/main` —
    // the real bare repo's `main` ref must have advanced (matching
    // `PlanActionGroup.test.ts`'s "content-owning atLair writes are atomic"
    // precedent for the same InMemory-adapter-only-does-a-LOCAL-CAS-publish
    // convention — see `InMemoryMirror.ts`'s `apply()`).
    const mainTipAfter = await bareRepo.resolveLocalRef('main');
    expect(mainTipAfter).not.toBe(mainTipBefore);

    // Provably durable, not just dirty-but-unread: a completely fresh
    // `LairRepoPerspective.resolve()` (a new `Mirror` construction) sees it.
    const perspective = await LairRepoPerspective.resolve(lair, asLairRepoName('local'));
    const fresh = await readMirrorFile(perspective.worktree, '.meta/plan/root1/content.toml');
    expect(fresh).toContain('Legacy root');
  });

  it('heal() never touches a wing worktree directly — the wing picks the migration up via its own start/merge', async () => {
    // Deliberately no plan/main mirror in this fixture — this repo's only
    // worktree is the wing's own checkout on `main`, so `findAllPlanMirrors`
    // must skip it purely on the branch check, proving heal() never reaches
    // into a wing worktree even when it's the only worktree that exists.
    const sandbox: Sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);
    const remote = simulateRemote(sandbox, REPO_URL);
    const remoteMain = await remote.createWorktree(sandbox.root, 'remote-seed', 'main');
    await remoteMain.commitAll('seed origin main');
    await lair.addWorkRepo('local', REPO_URL);
    const wing = await lair.createWing('workshop-03', { workLocal: { repo: 'local', branch: 'main' } });
    const wingWorktreeResult = await wing.workLocal();
    if (!wingWorktreeResult.exists) throw new Error('expected wing workLocal to exist');
    await wingWorktreeResult.worktree.createFile('.meta/plan/root1/index.json', legacyIndexJson('root1', 'Legacy root'));
    await wingWorktreeResult.worktree.commitAll('seed legacy plan data in wing worktree');

    await planTomlFormatHeal.heal(sandbox);

    const wingIndex = await readMirrorFile(wingWorktreeResult.worktree as unknown as Awaited<ReturnType<typeof makeFixture>>['mirrorWorktree'], '.meta/plan/root1/index.json');
    expect(wingIndex).not.toBeNull();
  });
});

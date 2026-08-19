import { describe, it, expect, beforeEach } from 'vitest';
import {
  createInMemorySandbox,
  createLair,
  createWorkAreaFactoriesForSandbox,
  simulateRemote,
  asLairRepoName,
  resolveMovementBase,
  type Sandbox,
  type Lair,
  type Wing,
} from '@minions/file-store';
import { LairRepoPerspective, resolveConductorMirror } from '@minions/repo-perspective';
import type { WingManager } from '../wings/WingManager.js';
import {
  listExperiments,
  getExperiment,
  createExperiment,
  assignWing,
  unassignWing,
  selectWinner,
  resolveExperiment,
} from './ExperimentsService.js';

const REPO_URL = 'https://example.com/CodeWarp/suite.git';

/** Minimal WingManager stand-in — ExperimentsService only ever calls getWing(). */
class FakeWingManager {
  private wings = new Map<string, Wing>();
  register(name: string, wing: Wing): void {
    this.wings.set(name, wing);
  }
  getWing(name: string): Wing | undefined {
    return this.wings.get(name);
  }
}

async function seedRemoteMain(sandbox: Sandbox): Promise<void> {
  const remote = simulateRemote(sandbox, REPO_URL);
  const remoteMain = await remote.createWorktree(sandbox.root, 'remote-seed', 'main');
  await remoteMain.createFile('README.md', '# suite');
  await remoteMain.commitAll('seed origin main');
}

async function createTestWing(lair: Lair, name: string): Promise<Wing> {
  return lair.createWing(name, { workLocal: { repo: 'local', branch: `l/test-lair/w/${name}` } });
}

describe('ExperimentsService', () => {
  let sandbox: Sandbox;
  let lair: Lair;
  let wingManager: FakeWingManager;

  beforeEach(async () => {
    sandbox = createInMemorySandbox();
    const scratchRoot = await sandbox.root.createDirectory('movement-scratch');
    lair = createLair(sandbox, createWorkAreaFactoriesForSandbox(sandbox, scratchRoot));
    await seedRemoteMain(sandbox);
    const bareRepo = await lair.addWorkRepo('local', REPO_URL);
    // `LairRepoPerspective.resolve`/`resolveConductorMirror` both need LOCAL
    // `main` to already resolve (their `Mirror` construction reads
    // `trunk.branch` — see `LairRepoPerspective.test.ts`'s own `seedMain`
    // helper for the same precondition) — `addWorkRepo`'s clone only seeds
    // `origin/main`, matching a real fresh `git clone --bare`. Production
    // code has this covered by whatever first checks out a wing's work/local
    // worktree off `main`; this test realigns it directly as the cheapest
    // correct way to satisfy that precondition here.
    await bareRepo.updateBranch('main', 'origin/main');
    wingManager = new FakeWingManager();
  });

  it('creates an experiment with a branch per variation, status open', async () => {
    const experiment = await createExperiment(lair, 'exp1', [{ slug: 'a' }, { slug: 'b' }]);

    expect(experiment.status).toBe('open');
    expect(experiment.winner).toBeNull();
    expect(experiment.variations).toEqual([
      { slug: 'a', trunkBranch: 'experiment/exp1/a', wings: [] },
      { slug: 'b', trunkBranch: 'experiment/exp1/b', wings: [] },
    ]);

    const remote = simulateRemote(sandbox, REPO_URL);
    expect(await remote.branches()).toContain('experiment/exp1/a');
    expect(await remote.branches()).toContain('experiment/exp1/b');

    const listed = await listExperiments(lair);
    expect(listed.map((e) => e.id)).toContain('exp1');
  });

  it('rejects creating a duplicate experiment id', async () => {
    await createExperiment(lair, 'exp1', [{ slug: 'a' }]);
    await expect(createExperiment(lair, 'exp1', [{ slug: 'b' }])).rejects.toThrow(/already exists/);
  });

  it('assignWing sets the wing trunk override and records membership', async () => {
    await createExperiment(lair, 'exp1', [{ slug: 'a' }]);
    const wing = await createTestWing(lair, 'lab-01');
    wingManager.register('lab-01', wing);

    const experiment = await assignWing(lair, wingManager as unknown as WingManager, 'exp1', 'a', 'lab-01');

    expect(experiment.variations[0]?.wings).toEqual(['lab-01']);
    const workLocalResult = await wing.workLocal();
    if (!workLocalResult.exists) throw new Error('expected work/local');
    expect(await resolveMovementBase(workLocalResult.worktree.repository, workLocalResult.worktree)).toBe('experiment/exp1/a');
  });

  it('selectWinner moves status to completing, records the winner, and leaves the winner\'s wings assigned', async () => {
    await createExperiment(lair, 'exp1', [{ slug: 'a' }, { slug: 'b' }]);
    const wing = await createTestWing(lair, 'lab-01');
    wingManager.register('lab-01', wing);
    await assignWing(lair, wingManager as unknown as WingManager, 'exp1', 'a', 'lab-01');

    const experiment = await selectWinner(lair, wingManager as unknown as WingManager, 'exp1', 'a');

    expect(experiment.status).toBe('completing');
    expect(experiment.winner).toBe('a');
    expect(experiment.variations.find((v) => v.slug === 'a')?.wings).toEqual(['lab-01']);
    const workLocalResult = await wing.workLocal();
    if (!workLocalResult.exists) throw new Error('expected work/local');
    expect(await resolveMovementBase(workLocalResult.worktree.repository, workLocalResult.worktree)).toBe('experiment/exp1/a');
  });

  it('selectWinner unassigns every wing on every non-winning variation', async () => {
    await createExperiment(lair, 'exp1', [{ slug: 'a' }, { slug: 'b' }]);
    const winnerWing = await createTestWing(lair, 'lab-01');
    const loserWing = await createTestWing(lair, 'lab-02');
    wingManager.register('lab-01', winnerWing);
    wingManager.register('lab-02', loserWing);
    await assignWing(lair, wingManager as unknown as WingManager, 'exp1', 'a', 'lab-01');
    await assignWing(lair, wingManager as unknown as WingManager, 'exp1', 'b', 'lab-02');

    const experiment = await selectWinner(lair, wingManager as unknown as WingManager, 'exp1', 'a');

    expect(experiment.variations.find((v) => v.slug === 'b')?.wings).toEqual([]);
    const loserWorkLocal = await loserWing.workLocal();
    if (!loserWorkLocal.exists) throw new Error('expected work/local');
    expect(await resolveMovementBase(loserWorkLocal.worktree.repository, loserWorkLocal.worktree)).toBe('main');
  });

  it('rejects selecting a winner for a non-open experiment', async () => {
    await createExperiment(lair, 'exp1', [{ slug: 'a' }]);
    await selectWinner(lair, wingManager as unknown as WingManager, 'exp1', 'a');
    await expect(selectWinner(lair, wingManager as unknown as WingManager, 'exp1', 'a')).rejects.toThrow(/not open/);
  });

  it('unassignWing clears the trunk override and removes the wing from the variation', async () => {
    await createExperiment(lair, 'exp1', [{ slug: 'a' }]);
    const wing = await createTestWing(lair, 'lab-01');
    wingManager.register('lab-01', wing);
    await assignWing(lair, wingManager as unknown as WingManager, 'exp1', 'a', 'lab-01');

    const experiment = await unassignWing(lair, wingManager as unknown as WingManager, 'exp1', 'a', 'lab-01');

    expect(experiment.variations[0]?.wings).toEqual([]);
    const workLocalResult = await wing.workLocal();
    if (!workLocalResult.exists) throw new Error('expected work/local');
    expect(await resolveMovementBase(workLocalResult.worktree.repository, workLocalResult.worktree)).toBe('main');
  });

  it('unassignWing is a no-op for a wing that was never assigned', async () => {
    await createExperiment(lair, 'exp1', [{ slug: 'a' }]);
    const experiment = await unassignWing(lair, wingManager as unknown as WingManager, 'exp1', 'a', 'lab-01');
    expect(experiment.variations[0]?.wings).toEqual([]);
  });

  it('resolveExperiment marks resolved and frees every wing across every variation, winner and losers alike', async () => {
    await createExperiment(lair, 'exp1', [{ slug: 'a' }, { slug: 'b' }]);
    const winnerWing = await createTestWing(lair, 'lab-01');
    const loserWing = await createTestWing(lair, 'lab-02');
    wingManager.register('lab-01', winnerWing);
    wingManager.register('lab-02', loserWing);
    await assignWing(lair, wingManager as unknown as WingManager, 'exp1', 'a', 'lab-01');
    await assignWing(lair, wingManager as unknown as WingManager, 'exp1', 'b', 'lab-02');
    await selectWinner(lair, wingManager as unknown as WingManager, 'exp1', 'a');

    const experiment = await resolveExperiment(lair, wingManager as unknown as WingManager, 'exp1');

    expect(experiment.status).toBe('resolved');
    expect(experiment.winner).toBe('a');

    const winnerWorkLocal = await winnerWing.workLocal();
    const loserWorkLocal = await loserWing.workLocal();
    if (!winnerWorkLocal.exists || !loserWorkLocal.exists) throw new Error('expected work/local');
    expect(await resolveMovementBase(winnerWorkLocal.worktree.repository, winnerWorkLocal.worktree)).toBe('main');
    expect(await resolveMovementBase(loserWorkLocal.worktree.repository, loserWorkLocal.worktree)).toBe('main');
  });

  it('rejects resolving an experiment that is not completing', async () => {
    await createExperiment(lair, 'exp1', [{ slug: 'a' }]);
    await expect(resolveExperiment(lair, wingManager as unknown as WingManager, 'exp1')).rejects.toThrow(/not completing/);
  });

  it('getExperiment returns null for an unknown id', async () => {
    expect(await getExperiment(lair, 'nope')).toBeNull();
  });

  it('createExperiment makes each variation\'s trunk plan+conductor mirror immediately queryable — and it is the SAME shared worktree', async () => {
    const experiment = await createExperiment(lair, 'exp1', [{ slug: 'a' }]);
    const trunkBranch = experiment.variations[0].trunkBranch;

    // There is no separate `conductor/<trunk>` branch. `resolveConductorMirror`
    // and `LairRepoPerspective.resolve` (plan) both resolve to the SAME
    // `plan/<trunk>` branch/worktree (design doc §4.1: `Mirror`'s
    // worktree-reuse is keyed by branch name), just narrowed to a different
    // subtree.
    const planPerspective = await LairRepoPerspective.resolve(lair, asLairRepoName('local'), trunkBranch);
    const conductorMirror = await resolveConductorMirror(lair, asLairRepoName('local'), trunkBranch);
    expect(planPerspective.worktree.branch).toBe(`plan/${trunkBranch}`);
    expect(conductorMirror.trunk.branch).toBe(trunkBranch);
    expect(conductorMirror.files.path).toBe(planPerspective.worktree.path);

    // Writing conductor-shaped content lands on the SAME `plan/<trunk>`
    // branch plan itself uses — proof they're genuinely the same worktree,
    // not just two mirrors that happen to agree right now. (Not provable by
    // cross-reading through EACH OTHER'S worktree handle: cone-mode sparse
    // checkout is a real, by-design VISIBILITY restriction — narrowing one
    // Mirror's handle back to `.meta/plan` correctly hides `.meta/conductor`
    // content from THAT handle's navigation, even though it's still on the
    // same branch/worktree on disk. See `Mirror.apply`'s doc comment.)
    const workRepoResult0 = await lair.workRepo('local');
    if (!workRepoResult0.exists) throw new Error('expected work repo');
    const mirrorBranchTipBefore = await workRepoResult0.repo.resolveLocalRef(`plan/${trunkBranch}`);
    const { committed, commitHash } = await conductorMirror.apply(async (view) => {
      await view.createFile('.meta/conductor/probe.txt', 'conductor wrote this');
    });
    expect(committed).toBe(true);
    expect(commitHash).not.toBe(mirrorBranchTipBefore);
    expect(await workRepoResult0.repo.resolveLocalRef(`plan/${trunkBranch}`)).toBe(commitHash);

    // The plan mirror is purely local (invariant A — never pushed to
    // origin), and stays fresh because every resolve() constructs a
    // brand-new `Trunk.mirror()` synced to the trunk's CURRENT tip, not
    // because of any intertwining cascade. Prove freshness that way too:
    // advance the trunk further, then confirm a fresh resolve() sees it.
    const workRepoResult = await lair.workRepo('local');
    if (!workRepoResult.exists) throw new Error('expected work repo');
    const bareRepo = workRepoResult.repo;
    const advanceWorktree = await bareRepo.createWorktree(sandbox.root, 'advance-trunk', trunkBranch);
    await advanceWorktree.createFile('.meta/plan/second.md', '# second');
    await advanceWorktree.commitAll('advance trunk further');
    const freshPlanPerspective2 = await LairRepoPerspective.resolve(lair, asLairRepoName('local'), trunkBranch);
    expect((await freshPlanPerspective2.worktree.child('.meta/plan/second.md')).found).toBe(true);
  });

  it('resolveExperiment separates the trunk from its plan mirror — a later push of the trunk no longer republishes it', async () => {
    const experiment = await createExperiment(lair, 'exp1', [{ slug: 'a' }]);
    const trunkBranch = experiment.variations[0].trunkBranch;
    await selectWinner(lair, wingManager as unknown as WingManager, 'exp1', 'a');

    await resolveExperiment(lair, wingManager as unknown as WingManager, 'exp1');

    const workRepoResult = await lair.workRepo('local');
    if (!workRepoResult.exists) throw new Error('expected work repo');
    const bareRepo = workRepoResult.repo;
    const remote = simulateRemote(sandbox, REPO_URL);
    const planRefBefore = await remote.resolveLocalRef(`plan/${trunkBranch}`);

    const trunkWorktree = await bareRepo.createWorktree(sandbox.root, 'trunk-advance', trunkBranch);
    await trunkWorktree.createFile('later-change.txt', 'v2');
    await trunkWorktree.commitAll('advance trunk after resolve');
    await bareRepo.pushBranch(trunkBranch);

    expect(await remote.resolveLocalRef(`plan/${trunkBranch}`)).toBe(planRefBefore);
  });
});

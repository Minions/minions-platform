import { describe, it, expect, vi } from 'vitest';
import type { Sandbox } from '@minions/file-store';
import { createInMemorySandbox, createLair, simulateRemote } from '@minions/file-store';
import { dispatchActionGroup } from '@minions/mcp-types';
import type { ActionContext } from '@minions/mcp-types';
import { movementActionGroup } from './MovementActionGroup.js';

describe('diff — dispatched via the throne endpoint (no ctx.wingName)', () => {
  it('resolves the wing from params.wing since ctx.wingName is unset', async () => {
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);
    const bareRepo = await lair.addWorkRepo('local', 'https://example.com/CodeWarp/suite.git');
    // `diff()` now builds a `Movement` (`WorkArea.activeMovement()`) to call
    // `Movement.commitsSince()`/`diffFrom()` (design doc §4.1), which
    // constructs a base-`Trunk`-scoped tool worktree that requires `main` to
    // already exist as a real local branch — seed it, matching the pattern
    // every other fixture in this file already uses (`makeWingFixture`/
    // `makeFixture` above).
    const seed = await bareRepo.createWorktree(sandbox.root, 'seed', 'main');
    await seed.createFile('README.md', '# v1\n');
    await seed.commitAll('seed');
    await seed.switchBranch('scratch');

    await lair.createWing('workshop-03', { workLocal: { repo: 'local', branch: 'wip/test' } });

    // No ctx.wingName — this is the throne-endpoint shape diff is mounted on.
    // Proves resolveMovementWingContext's params.wing fallback actually runs
    // (WingPerspective.resolve succeeds against the real wing) rather than
    // asserting on the in-memory git simulator's cross-branch diff content,
    // which isn't what this dispatch-wiring change is about.
    const ctx = { lair: sandbox } as ActionContext<Sandbox>;

    const result = (await dispatchActionGroup(
      movementActionGroup,
      { action: 'diff', wing: 'workshop-03' },
      ctx,
    )) as { diff: string };

    expect(typeof result.diff).toBe('string');
  });

  it('rejects a wing named by params.wing that does not exist — proving params.wing is actually used, not silently ignored', async () => {
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);
    await lair.addWorkRepo('local', 'https://example.com/CodeWarp/suite.git');
    await lair.createWing('workshop-03', { workLocal: { repo: 'local', branch: 'wip/test' } });

    const ctx = { lair: sandbox } as ActionContext<Sandbox>;

    await expect(
      dispatchActionGroup(movementActionGroup, { action: 'diff', wing: 'no-such-wing' }, ctx),
    ).rejects.toThrow('Wing not found: no-such-wing');
  });

  it('throws when neither ctx.wingName nor params.wing is given', async () => {
    const sandbox = createInMemorySandbox();
    const ctx = { lair: sandbox } as ActionContext<Sandbox>;

    // required: ['wing'] on the action def already rejects this before atWing
    // runs, but this proves resolveMovementWingContext itself also guards.
    await expect(
      dispatchActionGroup(movementActionGroup, { action: 'diff', wing: '' }, ctx),
    ).rejects.toThrow();
  });
});

describe('promote — precondition check and experiment-resolution wiring', () => {
  const REPO_URL = 'https://example.com/CodeWarp/suite.git';
  const TRUNK = 'experiment/foo/bar';

  /**
   * A wing whose work/local trunk override points at TRUNK, with TRUNK
   * already existing as a real local branch at origin/main's tip (so
   * promote()'s rebase is a trivial no-op success) — isolates these tests to
   * the action-group's precondition check and onExperimentPromoted wiring,
   * not the underlying git-mechanics contract (already covered exhaustively
   * by MovementManager.promote's own mocked-worktree tests).
   */
  async function makeFixture() {
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);
    const remote = simulateRemote(sandbox, REPO_URL);
    const remoteMain = await remote.createWorktree(sandbox.root, 'remote-seed', 'main');
    await remoteMain.createFile('README.md', 'v1');
    await remoteMain.commitAll('seed');

    const bareRepo = await lair.addWorkRepo('local', REPO_URL);
    await bareRepo.fetch();
    await bareRepo.updateBranch('main', 'origin/main');
    await bareRepo.updateBranch(TRUNK, 'origin/main');
    await bareRepo.pushBranch(TRUNK);

    await lair.createWing('lab-01', { workLocal: { repo: 'local', branch: 'l/lair/w/lab-01' } });
    const wingResult = await lair.wing('lab-01');
    if (!wingResult.exists) throw new Error('expected wing to exist');
    const workLocalResult = await wingResult.wing.workLocal();
    if (!workLocalResult.exists) throw new Error('expected work/local to exist');
    await workLocalResult.worktree.setBaseBranch(TRUNK);

    return { sandbox };
  }

  it('rejects when findExperimentByTrunk finds no matching experiment', async () => {
    const { sandbox } = await makeFixture();
    const onExperimentPromoted = vi.fn();
    const ctx = {
      lair: sandbox,
      wingName: 'lab-01',
      findExperimentByTrunk: vi.fn().mockResolvedValue(null),
      onExperimentPromoted,
    } as unknown as ActionContext<Sandbox>;

    await expect(
      dispatchActionGroup(movementActionGroup, { action: 'promote' }, ctx),
    ).rejects.toThrow(/not.*completing/i);
    expect(onExperimentPromoted).not.toHaveBeenCalled();
  });

  it('rejects when the matching experiment is not in "completing" status', async () => {
    const { sandbox } = await makeFixture();
    const onExperimentPromoted = vi.fn();
    const ctx = {
      lair: sandbox,
      wingName: 'lab-01',
      findExperimentByTrunk: vi.fn().mockResolvedValue({ id: 'foo', status: 'open' }),
      onExperimentPromoted,
    } as unknown as ActionContext<Sandbox>;

    await expect(
      dispatchActionGroup(movementActionGroup, { action: 'promote' }, ctx),
    ).rejects.toThrow(/completing/i);
    expect(onExperimentPromoted).not.toHaveBeenCalled();
  });

  it('proceeds and calls onExperimentPromoted(trunk) once the trunk actually promotes', async () => {
    const { sandbox } = await makeFixture();
    const onExperimentPromoted = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      lair: sandbox,
      wingName: 'lab-01',
      findExperimentByTrunk: vi.fn().mockResolvedValue({ id: 'foo', status: 'completing' }),
      onExperimentPromoted,
    } as unknown as ActionContext<Sandbox>;

    const result = (await dispatchActionGroup(
      movementActionGroup,
      { action: 'promote' },
      ctx,
    )) as { success: boolean; trunk?: string };

    expect(result.success).toBe(true);
    expect(result.trunk).toBe(TRUNK);
    expect(onExperimentPromoted).toHaveBeenCalledWith(TRUNK);
  });

  it('skips the precondition check entirely when findExperimentByTrunk is absent from context (e.g. tests with no experiments plumbing)', async () => {
    const { sandbox } = await makeFixture();
    const ctx = { lair: sandbox, wingName: 'lab-01' } as unknown as ActionContext<Sandbox>;

    const result = (await dispatchActionGroup(
      movementActionGroup,
      { action: 'promote' },
      ctx,
    )) as { success: boolean };

    expect(result.success).toBe(true);
  });
});

describe('start/merge — dispatched end-to-end through the henchery endpoint, exercising the real WorkArea wiring', () => {
  // `start`/`merge` now go through `resolveMovementWingContext`'s
  // `createLair(ctx.lair, createWorkAreaFactoriesForSandbox(...))` +
  // `resolveWorkArea` (design doc §4.2/§4.3) — the movement-manager-level
  // unit tests (`MovementManager.test.ts`/`MovementSession.test.ts`)
  // construct a `WorkArea` by hand and never touch that glue code. This
  // proves the real dispatch path — scratch-root creation under
  // `lair.cabinet()`, adapter detection, `Wing.workAreaLocal()` — actually
  // wires up end-to-end for a real MCP tool call, not just the pieces in
  // isolation.
  const REPO_URL = 'https://example.com/CodeWarp/suite.git';

  // Deliberately no `simulateRemote()` for this URL: `Movement.merge()`'s
  // InMemory adapter publishes its CAS purely locally (see
  // `InMemoryMovementImpl.merge()` — unlike Disk, it never calls
  // `pushBranch`). `main` is seeded directly, locally, instead.
  //
  // `merge` has no post-merge plan-branch sync call: `LairRepoPerspective`
  // constructs a fresh, always-synced `Mirror` per `plan` action call, so
  // there is nothing left for a post-merge sync to do.
  async function makeWingFixture() {
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);

    const bareRepo = await lair.addWorkRepo('local', REPO_URL);
    const seed = await bareRepo.createWorktree(sandbox.root, 'seed', 'main');
    await seed.createFile('README.md', '# v1\n');
    await seed.commitAll('seed');
    await seed.switchBranch('scratch');

    await lair.createWing('workshop-09', { workLocal: { repo: 'local', branch: 'wip/feature' } });

    return { sandbox };
  }

  it('start syncs the movement branch and returns success', async () => {
    const { sandbox } = await makeWingFixture();
    const ctx = { lair: sandbox, wingName: 'workshop-09' } as unknown as ActionContext<Sandbox>;

    const result = (await dispatchActionGroup(
      movementActionGroup,
      { action: 'start' },
      ctx,
    )) as { success: boolean; wasUpdated: boolean; isDirty: boolean };

    expect(result.success).toBe(true);
    expect(result.isDirty).toBe(false);
  });

  it('start creates a new wip/ branch off the current movement, inheriting its base', async () => {
    const { sandbox } = await makeWingFixture();
    const ctx = { lair: sandbox, wingName: 'workshop-09' } as unknown as ActionContext<Sandbox>;

    const result = (await dispatchActionGroup(
      movementActionGroup,
      { action: 'start', branch: 'wip/another-experiment' },
      ctx,
    )) as { success: boolean; error?: string };

    expect(result.success).toBe(true);

    const wingResult = await createLair(sandbox).wing('workshop-09');
    if (!wingResult.exists) throw new Error('expected wing to exist');
    const workLocal = await wingResult.wing.workLocal();
    if (!workLocal.exists) throw new Error('expected work/local to exist');
    expect(await workLocal.worktree.currentBranch()).toBe('wip/another-experiment');
  });

  it('merge lands the movement on main', async () => {
    const { sandbox } = await makeWingFixture();
    const wingResult = await createLair(sandbox).wing('workshop-09');
    if (!wingResult.exists) throw new Error('expected wing to exist');
    const workLocal = await wingResult.wing.workLocal();
    if (!workLocal.exists) throw new Error('expected work/local to exist');
    await workLocal.worktree.createFile('feature.ts', 'export const feature = true;\n');
    await workLocal.worktree.commitAll('. f Add feature');

    const ctx = { lair: sandbox, wingName: 'workshop-09' } as unknown as ActionContext<Sandbox>;

    const result = (await dispatchActionGroup(
      movementActionGroup,
      { action: 'merge', type: 'feat', summary: 'Add feature', description: 'Adds the feature.' },
      ctx,
    )) as { success: boolean; error?: string };

    expect(result.success).toBe(true);

    const bareRepo = workLocal.worktree.repository;
    const mainWt = await bareRepo.createWorktree(sandbox.root, 'verify-main', 'main');
    expect((await mainWt.child('feature.ts')).found).toBe(true);
  });

  it('merge reports a clean not-on-a-movement-branch error when on main', async () => {
    const { sandbox } = await makeWingFixture();
    const wingResult = await createLair(sandbox).wing('workshop-09');
    if (!wingResult.exists) throw new Error('expected wing to exist');
    const workLocal = await wingResult.wing.workLocal();
    if (!workLocal.exists) throw new Error('expected work/local to exist');
    await workLocal.worktree.switchBranch('main');

    const ctx = { lair: sandbox, wingName: 'workshop-09' } as unknown as ActionContext<Sandbox>;

    const result = (await dispatchActionGroup(
      movementActionGroup,
      { action: 'merge', type: 'feat', summary: 'x', description: 'y' },
      ctx,
    )) as { success: boolean; error?: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('movement branch');
  });
});

describe('start/merge/promote — pause/resume the quality watcher around the bulk worktree rewrite', () => {
  const REPO_URL = 'https://example.com/CodeWarp/suite.git';

  async function makeWingFixture() {
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);

    const bareRepo = await lair.addWorkRepo('local', REPO_URL);
    const seed = await bareRepo.createWorktree(sandbox.root, 'seed', 'main');
    await seed.createFile('README.md', '# v1\n');
    await seed.commitAll('seed');
    await seed.switchBranch('scratch');

    await lair.createWing('workshop-09', { workLocal: { repo: 'local', branch: 'wip/feature' } });

    return { sandbox };
  }

  function pauseResumeSpies() {
    const calls: string[] = [];
    return {
      calls,
      pauseQualityWatcher: vi.fn(async (wingName: string) => { calls.push(`pause:${wingName}`); }),
      resumeQualityWatcher: vi.fn(async (wingName: string) => { calls.push(`resume:${wingName}`); }),
    };
  }

  it('start pauses before and resumes after, in that order', async () => {
    const { sandbox } = await makeWingFixture();
    const { calls, pauseQualityWatcher, resumeQualityWatcher } = pauseResumeSpies();
    const ctx = { lair: sandbox, wingName: 'workshop-09', pauseQualityWatcher, resumeQualityWatcher } as unknown as ActionContext<Sandbox>;

    await dispatchActionGroup(movementActionGroup, { action: 'start' }, ctx);

    expect(calls).toEqual(['pause:workshop-09', 'resume:workshop-09']);
  });

  it('merge pauses before and resumes after, in that order', async () => {
    const { sandbox } = await makeWingFixture();
    const wingResult = await createLair(sandbox).wing('workshop-09');
    if (!wingResult.exists) throw new Error('expected wing to exist');
    const workLocal = await wingResult.wing.workLocal();
    if (!workLocal.exists) throw new Error('expected work/local to exist');
    await workLocal.worktree.createFile('feature.ts', 'export const feature = true;\n');
    await workLocal.worktree.commitAll('. f Add feature');

    const { calls, pauseQualityWatcher, resumeQualityWatcher } = pauseResumeSpies();
    const ctx = { lair: sandbox, wingName: 'workshop-09', pauseQualityWatcher, resumeQualityWatcher } as unknown as ActionContext<Sandbox>;

    await dispatchActionGroup(movementActionGroup, { action: 'merge', type: 'feat', summary: 'Add feature', description: 'Adds the feature.' }, ctx);

    expect(calls).toEqual(['pause:workshop-09', 'resume:workshop-09']);
  });

  it('merge still resumes even when it fails (not on a movement branch)', async () => {
    const { sandbox } = await makeWingFixture();
    const wingResult = await createLair(sandbox).wing('workshop-09');
    if (!wingResult.exists) throw new Error('expected wing to exist');
    const workLocal = await wingResult.wing.workLocal();
    if (!workLocal.exists) throw new Error('expected work/local to exist');
    await workLocal.worktree.switchBranch('main');

    const { calls, pauseQualityWatcher, resumeQualityWatcher } = pauseResumeSpies();
    const ctx = { lair: sandbox, wingName: 'workshop-09', pauseQualityWatcher, resumeQualityWatcher } as unknown as ActionContext<Sandbox>;

    const result = (await dispatchActionGroup(
      movementActionGroup,
      { action: 'merge', type: 'feat', summary: 'x', description: 'y' },
      ctx,
    )) as { success: boolean };

    expect(result.success).toBe(false);
    expect(calls).toEqual(['pause:workshop-09', 'resume:workshop-09']);
  });

  it('promote resumes even when the precondition check throws', async () => {
    const { sandbox } = await makeWingFixture();
    const { calls, pauseQualityWatcher, resumeQualityWatcher } = pauseResumeSpies();
    const ctx = {
      lair: sandbox,
      wingName: 'workshop-09',
      findExperimentByTrunk: vi.fn().mockResolvedValue(null),
      pauseQualityWatcher,
      resumeQualityWatcher,
    } as unknown as ActionContext<Sandbox>;

    await expect(
      dispatchActionGroup(movementActionGroup, { action: 'promote' }, ctx),
    ).rejects.toThrow(/not.*completing/i);
    expect(calls).toEqual(['pause:workshop-09', 'resume:workshop-09']);
  });

  it('does not pause/resume anything when the callbacks are absent from context (e.g. tests with no cabinet-level watcher plumbing)', async () => {
    const { sandbox } = await makeWingFixture();
    const ctx = { lair: sandbox, wingName: 'workshop-09' } as unknown as ActionContext<Sandbox>;

    const result = (await dispatchActionGroup(
      movementActionGroup,
      { action: 'start' },
      ctx,
    )) as { success: boolean };

    expect(result.success).toBe(true);
  });
});

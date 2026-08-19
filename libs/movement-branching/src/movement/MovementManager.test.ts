import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createInMemorySandbox,
  createWorkArea,
  createInMemoryWorkAreaFactories,
  createInMemoryTrunk,
  type Sandbox,
  type Worktree,
  type BareRepository,
  type WorkArea,
  type Trunk,
} from '@minions/file-store';
import { MovementManager } from './MovementManager.js';
import { AdvanceAttemptRegistry } from '../tools/AdvanceAttemptRegistry.js';

/**
 * Wraps `worktree` in a design doc §4.2 `WorkArea` (InMemory adapter) —
 * `startMovement`/`mergeMovement`/`promote` all delegate to
 * `WorkArea.activeMovement()`/`beginNewActiveMovement()` +
 * `CheckedOutMovement.start()`/`Movement.merge()`/`DerivedTrunk.advance()`/
 * `beginAdvance()` (design doc §4.3/§4.4) instead of hand-rolling rebase/CAS/
 * retry against the raw `Worktree` — see `MovementManager.ts`'s own doc
 * comments for the full rationale.
 */
function makeWorkArea(repo: BareRepository, worktree: Worktree): WorkArea {
  return createWorkArea(repo, worktree, createInMemoryWorkAreaFactories());
}

describe('MovementManager', () => {
  let sandbox: Sandbox;
  let repo: BareRepository;
  let worktree: Worktree;
  let workArea: WorkArea;
  let movementBranch: string;

  beforeEach(async () => {
    sandbox = createInMemorySandbox();
    repo = await sandbox.initBare(sandbox.root, 'test-repo');
    worktree = await repo.createWorktree(sandbox.root, 'work', 'main');

    // Create initial commit on main
    await worktree.createFile('README.md', '# Test Project\n');
    await worktree.commitAll('Initial commit');

    // Create and checkout movement branch
    movementBranch = 'movement/workshop-00';
    await worktree.switchBranch(movementBranch);
    workArea = makeWorkArea(repo, worktree);
  });

  describe('branch detection', () => {
    it('detects when on a movement branch', async () => {
      const manager = new MovementManager(worktree);
      expect(await manager.isOnMovementBranch()).toBe(true);
    });

    it('returns false when on main', async () => {
      await worktree.switchBranch('main');
      const manager = new MovementManager(worktree);
      expect(await manager.isOnMovementBranch()).toBe(false);
    });

    it('identifies movement branch with standard format', async () => {
      const manager = new MovementManager(worktree);
      expect(await manager.getMovementBranchName()).toBe(movementBranch);
    });

    it('identifies movement branch with l/ prefix format', async () => {
      await worktree.switchBranch('l/ArloHometown/w/workshop-00');
      const manager = new MovementManager(worktree);
      expect(await manager.isOnMovementBranch()).toBe(true);
    });

    // `isOnMovementBranch()`/`getMovementBranchName()` resolve the current
    // branch via `WorkArea.activeMovement().branch` (design doc §4.1)
    // instead of calling `Worktree.currentBranch()` directly, whenever a
    // `WorkArea` is supplied — `activeMovement()` works for any
    // currently-checked-out branch, movement-shaped or not (see
    // `SiteWorkArea.activeMovement()`), so this is a safe substitution.
    // Proven by asserting `WorkArea.activeMovement()` itself gets called
    // (the delegation), not by asserting the raw `Worktree.currentBranch()`
    // is never reached at all — `activeMovement()`'s OWN implementation
    // legitimately still calls it underneath; `MovementManager` itself
    // just never calls it a second, redundant time directly.
    it('delegates to WorkArea.activeMovement() rather than reading the branch directly, when a WorkArea is supplied', async () => {
      const activeMovementSpy = vi.spyOn(workArea, 'activeMovement');
      const manager = new MovementManager(worktree, workArea);

      expect(await manager.isOnMovementBranch()).toBe(true);
      expect(await manager.getMovementBranchName()).toBe(movementBranch);
      expect(activeMovementSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe('basic merge workflow', () => {
    it('merges movement branch to main', async () => {
      await worktree.createFile('feature.ts', 'export const feature = true;\n');
      await worktree.commitAll('. f Add feature');

      const manager = new MovementManager(worktree, workArea);
      const result = await manager.mergeMovement({
        type: 'feat',
        summary: 'Add new feature',
        description: 'Implemented the feature functionality.',
      });

      expect(result.success).toBe(true);
    });

    it('fast-forwards movement branch after merge', async () => {
      await worktree.createFile('feature.ts', 'export const feature = true;\n');
      await worktree.commitAll('. f Add feature');

      const manager = new MovementManager(worktree, workArea);
      await manager.mergeMovement({
        type: 'feat',
        summary: 'Add new feature',
        description: 'Feature description.',
      });

      // After merge, we should be back on the movement branch, clean, and
      // fast-forwarded to main's new tip.
      const currentBranch = await worktree.currentBranch();
      expect(currentBranch).toBe(movementBranch);
      expect(await worktree.isDirty()).toBe(false);
      const movementTip = await repo.resolveLocalRef(movementBranch);
      const mainTip = await repo.resolveLocalRef('main');
      expect(movementTip).toBe(mainTip);
    });

    it('lands the movement on main without ever checking out main', async () => {
      const preMergeMain = await repo.resolveLocalRef('main');
      await repo.updateBranch('pre-merge-marker', preMergeMain as string);

      await worktree.createFile('feature.ts', 'export const feature = true;\n');
      await worktree.commitAll('. f Add feature');

      const manager = new MovementManager(worktree, workArea);
      const result = await manager.mergeMovement({
        type: 'feat',
        summary: 'Add new feature',
        description: 'Feature description.',
      });

      expect(result.success).toBe(true);

      // The worktree stayed on the movement branch the whole time.
      expect(await worktree.currentBranch()).toBe(movementBranch);

      // main received the merge: its commit carries the movement's tree, and
      // a merge commit with our message sits on top.
      const onMain = await worktree.log('pre-merge-marker', 'main');
      expect(onMain[0]?.subject).toBe('feat: Add new feature');

      // Inspecting main via a fresh worktree (never this one) shows the
      // feature landed.
      const mainWt = await repo.createWorktree(sandbox.root, 'verify-main', 'main');
      const file = await mainWt.child('feature.ts');
      expect(file.found).toBe(true);
    });

    it('returns to movement branch after merge', async () => {
      await worktree.createFile('feature.ts', 'export const feature = true;\n');
      await worktree.commitAll('. f Add feature');

      const manager = new MovementManager(worktree, workArea);
      await manager.mergeMovement({
        type: 'feat',
        summary: 'Add new feature',
        description: 'Feature description.',
      });

      const currentBranch = await worktree.currentBranch();
      expect(currentBranch).toBe(movementBranch);
    });

    // The post-merge best-effort push of the movement branch goes through
    // `CheckedOutMovement.push()` (design doc §4.3) on the already-resolved
    // handle, instead of a fresh raw `Worktree.forcePushBranch(movement.branch)`
    // call — same "movement handles are cheap, reuse the one already in
    // hand" reasoning as `MovementSession.commit()`.
    it('pushes via CheckedOutMovement.push(), not a raw Worktree.forcePushBranch() call, after a successful merge', async () => {
      await worktree.createFile('feature.ts', 'export const feature = true;\n');
      await worktree.commitAll('. f Add feature');

      const pushSpy = vi.fn().mockResolvedValue(undefined);
      const originalActiveMovement = workArea.activeMovement.bind(workArea);
      vi.spyOn(workArea, 'activeMovement').mockImplementation(async () => {
        const movement = await originalActiveMovement();
        return new Proxy(movement, {
          get(target, prop, receiver) {
            if (prop === 'push') return pushSpy;
            return Reflect.get(target, prop, receiver);
          },
        });
      });
      const forcePushBranchSpy = vi.spyOn(worktree, 'forcePushBranch');

      const manager = new MovementManager(worktree, workArea);
      const result = await manager.mergeMovement({
        type: 'feat',
        summary: 'Add new feature',
        description: 'Feature description.',
      });

      expect(result.success).toBe(true);
      expect(pushSpy).toHaveBeenCalledTimes(1);
      expect(forcePushBranchSpy).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('fails when not on movement branch', async () => {
      await worktree.switchBranch('main');
      const manager = new MovementManager(worktree, workArea);

      const result = await manager.mergeMovement({
        type: 'feat',
        summary: 'Test',
        description: 'Test.',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('movement branch');
    });

    it('succeeds with no-op when movement branch has no new commits', async () => {
      const manager = new MovementManager(worktree, workArea);

      const result = await manager.mergeMovement({
        type: 'feat',
        summary: 'Test',
        description: 'Test.',
      });

      // No new commits means already-up-to-date, which is a no-op success
      expect(result.success).toBe(true);
    });

    it('fails when there are uncommitted changes', async () => {
      await worktree.createFile('uncommitted.ts', 'export const x = 1;\n');
      await worktree.commitAll('. f Add file');

      // Make another change without committing
      const fileResult = await worktree.child('uncommitted.ts');
      if (fileResult.found && fileResult.node.kind === 'file') {
        await fileResult.node.write('export const x = 2;\n');
      }

      const manager = new MovementManager(worktree, workArea);
      const result = await manager.mergeMovement({
        type: 'feat',
        summary: 'Test',
        description: 'Test.',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('uncommitted');
    });
  });

  describe('startMovement', () => {
    it('returns success and wasUpdated=false when already up to date with main', async () => {
      const manager = new MovementManager(worktree, workArea);
      const result = await manager.startMovement();
      expect(result.success).toBe(true);
      expect(result.wasUpdated).toBe(false);
    });

    it('fast-forwards movement branch when behind main', async () => {
      // Advance main directly (via a separate worktree) — no fetch needed:
      // `CheckedOutMovement.start()` rebases onto the base trunk's real
      // local branch, not a separate `origin/<trunk>` ref.
      const mainWt = await repo.createWorktree(sandbox.root, 'main-advance', 'main');
      await mainWt.createFile('new-feature.ts', 'export const newFeature = true;\n');
      await mainWt.commitAll('New feature on main');

      const manager = new MovementManager(worktree, workArea);
      const result = await manager.startMovement();

      expect(result.success).toBe(true);
      expect(result.wasUpdated).toBe(true);

      // The new file from main should now be present in the movement branch
      const file = await worktree.child('new-feature.ts');
      expect(file.found).toBe(true);
    });

    // Same as mergeMovement's post-merge push — the rebased branch's
    // best-effort push after a successful `start()` goes through
    // `CheckedOutMovement.push()` instead of a raw
    // `Worktree.forcePushBranch(movement.branch)` call.
    it('pushes via CheckedOutMovement.push(), not a raw Worktree.forcePushBranch() call, after a successful rebase', async () => {
      const mainWt = await repo.createWorktree(sandbox.root, 'main-advance', 'main');
      await mainWt.createFile('new-feature.ts', 'export const newFeature = true;\n');
      await mainWt.commitAll('New feature on main');

      const pushSpy = vi.fn().mockResolvedValue(undefined);
      const originalActiveMovement = workArea.activeMovement.bind(workArea);
      vi.spyOn(workArea, 'activeMovement').mockImplementation(async () => {
        const movement = await originalActiveMovement();
        return new Proxy(movement, {
          get(target, prop, receiver) {
            if (prop === 'push') return pushSpy;
            return Reflect.get(target, prop, receiver);
          },
        });
      });
      const forcePushBranchSpy = vi.spyOn(worktree, 'forcePushBranch');

      const manager = new MovementManager(worktree, workArea);
      const result = await manager.startMovement();

      expect(result.success).toBe(true);
      expect(result.wasUpdated).toBe(true);
      expect(pushSpy).toHaveBeenCalledTimes(1);
      expect(forcePushBranchSpy).not.toHaveBeenCalled();
    });

    it('preserves uncommitted changes when fast-forwarding', async () => {
      const mainWt = await repo.createWorktree(sandbox.root, 'main-advance', 'main');
      await mainWt.createFile('new-feature.ts', 'export const newFeature = true;\n');
      await mainWt.commitAll('New feature on main');

      // Create an uncommitted local change
      await worktree.createFile('local-wip.ts', 'export const wip = true;\n');
      expect(await worktree.isDirty()).toBe(true);

      const manager = new MovementManager(worktree, workArea);
      const result = await manager.startMovement();

      expect(result.success).toBe(true);
      expect(result.wasUpdated).toBe(true);
      expect(result.isDirty).toBe(true);

      // The new file from main should be present
      const feature = await worktree.child('new-feature.ts');
      expect(feature.found).toBe(true);

      // The uncommitted local change must still be present
      const wip = await worktree.child('local-wip.ts');
      expect(wip.found).toBe(true);
    });

    it('returns error when not on a movement branch', async () => {
      await worktree.switchBranch('main');
      const manager = new MovementManager(worktree, workArea);
      const result = await manager.startMovement();
      expect(result.success).toBe(false);
      expect(result.error).toContain('movement branch');
    });

    describe('with branch param', () => {
      it('creates and switches to a new wip/ branch', async () => {
        const manager = new MovementManager(worktree, workArea);
        const result = await manager.startMovement({ branch: 'wip/my-experiment' });
        expect(result.success).toBe(true);
        expect(await worktree.currentBranch()).toBe('wip/my-experiment');
      });

      it('checks out an existing wip/ branch', async () => {
        await worktree.switchBranch('wip/existing');
        await worktree.createFile('wip-file.ts', 'export const x = 1;\n');
        await worktree.commitAll('. f Add wip file');
        await worktree.switchBranch(movementBranch);

        const manager = new MovementManager(worktree, workArea);
        const result = await manager.startMovement({ branch: 'wip/existing' });
        expect(result.success).toBe(true);
        expect(await worktree.currentBranch()).toBe('wip/existing');
        const file = await worktree.child('wip-file.ts');
        expect(file.found).toBe(true);
      });

      it('creates and switches to a new probably-wrong/ branch', async () => {
        const manager = new MovementManager(worktree, workArea);
        const result = await manager.startMovement({ branch: 'probably-wrong/risky-idea' });
        expect(result.success).toBe(true);
        expect(await worktree.currentBranch()).toBe('probably-wrong/risky-idea');
      });

      it('creates and switches to a l/<any>/w/<wing>-sub/ branch with correct wingName', async () => {
        const manager = new MovementManager(worktree, workArea);
        const result = await manager.startMovement({
          branch: 'l/minions/w/workshop-01-sub/my-sub-task',
          wingName: 'workshop-01',
        });
        expect(result.success).toBe(true);
        expect(await worktree.currentBranch()).toBe('l/minions/w/workshop-01-sub/my-sub-task');
      });

      it('rejects a l/<any>/w/<wing>-sub/ branch when wingName does not match', async () => {
        const manager = new MovementManager(worktree, workArea);
        const result = await manager.startMovement({
          branch: 'l/minions/w/workshop-01-sub/my-sub-task',
          wingName: 'workshop-02',
        });
        expect(result.success).toBe(false);
        expect(result.error).toContain('not an allowed wip branch');
      });

      it('rejects an arbitrary branch name', async () => {
        const manager = new MovementManager(worktree, workArea);
        const result = await manager.startMovement({ branch: 'feature/some-thing' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('not an allowed wip branch');
      });

      it('rejects a movement branch name passed as branch param', async () => {
        const manager = new MovementManager(worktree, workArea);
        const result = await manager.startMovement({ branch: 'movement/some-movement' });
        expect(result.success).toBe(false);
        expect(result.error).toContain('not an allowed wip branch');
      });
    });
  });

  // NOTE: Tests for custom merge messages (type, summary, description, coAuthoredBy)
  // are skipped because custom merge messages are not yet supported by the Worktree
  // interface. See libs/movement-branching/unchangeable-git-or-fs-usages.md
});

describe('MovementManager base-branch resolution', () => {
  const MOVEMENT_BRANCH = 'l/test/w/wing';

  // Builds a real worktree on a movement branch whose base-branch override is
  // an arbitrary trunk name ("master") distinct from the sandbox's actual
  // default branch ("main"), so assertions prove the workflow operates on
  // whatever `baseBranch()` reports, never a hardcoded "main". A second,
  // disposable worktree advances the trunk after the movement branch forks
  // from it — the realistic "trunk moved on since we branched" case every
  // test in this block exercises — then frees the trunk branch name,
  // mirroring real git's refusal to force-move a branch checked out in some
  // worktree. `CheckedOutMovement.start()`/`Movement.merge()` (design doc
  // §4.3) rebase onto the trunk's real local branch directly — no separate
  // `origin/<trunk>` ref or fetch needed to observe the advance.
  async function setupBaseBranchTest(trunk = 'master') {
    const sandbox = createInMemorySandbox();
    const repo = await sandbox.initBare(sandbox.root, 'test-repo');

    const main = await repo.createWorktree(sandbox.root, 'main-seed', 'main');
    await main.createFile('README.md', '# seed\n');
    await main.commitAll('seed');

    await repo.createBranchIfMissing(trunk, 'main');
    await repo.createBranchIfMissing(MOVEMENT_BRANCH, trunk);

    const wt = await repo.createWorktree(sandbox.root, 'wing', MOVEMENT_BRANCH);
    await wt.setBaseBranch(trunk);

    const trunkWt = await repo.createWorktree(sandbox.root, 'trunk-wt', trunk);
    await trunkWt.createFile('trunk-feature.ts', 'export const onTrunk = true;\n');
    await trunkWt.commitAll('trunk moves on');
    await trunkWt.switchBranch('scratch');

    const workArea = makeWorkArea(repo, wt);
    return { sandbox, repo, wt, trunk, workArea };
  }

  it('rebases the movement branch onto the resolved base trunk when starting', async () => {
    const { wt, workArea } = await setupBaseBranchTest();

    const result = await new MovementManager(wt, workArea).startMovement();

    expect(result.success).toBe(true);
    expect(result.wasUpdated).toBe(true);
    // Rebased onto the resolved trunk ("master"), never a hardcoded "main" —
    // the trunk's content is now present in the movement branch's worktree.
    // (The in-memory rebase simulator always builds a new commit rather than
    // fast-forwarding, even with nothing of the movement's own to replay, so
    // this checks content, not tip-hash equality.)
    const file = await wt.child('trunk-feature.ts');
    expect(file.found).toBe(true);
  });

  it('merges onto the resolved base branch, never a hardcoded main', async () => {
    const { sandbox, repo, wt, trunk, workArea } = await setupBaseBranchTest();
    await wt.createFile('feature.ts', 'export const feature = true;\n');
    await wt.commitAll('add feature');

    const result = await new MovementManager(wt, workArea).mergeMovement({
      type: 'feat',
      summary: 's',
      description: 'd',
    });

    expect(result.success).toBe(true);

    // The feature landed on the resolved trunk (never a hardcoded "main"),
    // alongside the trunk's own prior content.
    const verify = await repo.createWorktree(sandbox.root, 'verify-trunk', trunk);
    expect((await verify.child('feature.ts')).found).toBe(true);
    expect((await verify.child('trunk-feature.ts')).found).toBe(true);

    // Movement branch was fast-forwarded to the trunk's new tip.
    const movementTip = await repo.resolveLocalRef(MOVEMENT_BRANCH);
    const trunkTip = await repo.resolveLocalRef(trunk);
    expect(movementTip).toBe(trunkTip);
  });

  it('mergeMovement on conflict: reports files to fix, never tells the agent to run git', async () => {
    const { wt, workArea } = await setupBaseBranchTest();
    // The in-memory simulator's rebase() never produces a real content
    // conflict on its own (see SimulatedGit.rebase) — force the one it would
    // report for an agent to resolve, the same shape a real conflict
    // returns. `CheckedOutMovement.start()` (InMemory) calls
    // `worktree.rebase()` directly on this same worktree, so intercepting it
    // here still reaches the new code path.
    vi.spyOn(wt, 'rebase').mockResolvedValueOnce({
      status: 'conflict',
      message: 'boom',
      originalHead: 'abc',
      conflictedFiles: ['shared.txt', 'other.txt'],
    });

    const result = await new MovementManager(wt, workArea).mergeMovement({
      type: 'feat',
      summary: 's',
      description: 'd',
    });

    expect(result.success).toBe(false);
    expect(result.needsRebase).toBe(true);
    expect(result.error).toContain('shared.txt');
    expect(result.error).toContain('other.txt');
    expect(result.error).toContain('call movement merge again');
    expect(result.error?.toLowerCase()).not.toContain('git add');
    expect(result.error?.toLowerCase()).not.toContain('rebase --continue');
    expect(result.error?.toLowerCase()).toContain('do not run any git commands');
  });

  it('mergeMovement when a rebase is already in progress: continues it instead of fetching and starting over', async () => {
    const { wt, workArea } = await setupBaseBranchTest();
    vi.spyOn(wt, 'hasInProgressRebase').mockResolvedValue(true);
    const continueRebaseSpy = vi.spyOn(wt, 'continueRebase').mockResolvedValueOnce({ status: 'success' });
    const isDirtySpy = vi.spyOn(wt, 'isDirty');

    const result = await new MovementManager(wt, workArea).mergeMovement({
      type: 'feat',
      summary: 's',
      description: 'd',
    });

    expect(result.success).toBe(true);
    expect(continueRebaseSpy).toHaveBeenCalled();
    // Resuming skips the dirty-check gate entirely.
    expect(isDirtySpy).not.toHaveBeenCalled();
  });

  it('mergeMovement recovers automatically from a stale rebase halt with no conflicted files — aborts and retries once instead of reporting a mislabeled conflict', async () => {
    // Regression test for a production incident: a rebase-merge session left
    // behind by an unrelated earlier interruption (a crashed/restarted host
    // process) has its own bookkeeping go stale, so continueRebase() halts
    // with status 'conflict' but an EMPTY conflictedFiles list — nothing an
    // agent can fix by editing files, and a human unblocked it manually with
    // `git rebase --abort` followed by a fresh merge attempt.
    const { wt, workArea } = await setupBaseBranchTest();
    vi.spyOn(wt, 'hasInProgressRebase').mockResolvedValue(true);
    const continueRebaseSpy = vi.spyOn(wt, 'continueRebase').mockResolvedValueOnce({
      status: 'conflict',
      message: 'unexplained halt',
      originalHead: 'abc',
      conflictedFiles: [],
    });
    const abortRebaseSpy = vi.spyOn(wt, 'abortRebase');
    const rebaseSpy = vi.spyOn(wt, 'rebase').mockResolvedValueOnce({ status: 'success' });

    const result = await new MovementManager(wt, workArea).mergeMovement({
      type: 'feat',
      summary: 's',
      description: 'd',
    });

    expect(result.success).toBe(true);
    expect(continueRebaseSpy).toHaveBeenCalledTimes(1);
    expect(abortRebaseSpy).toHaveBeenCalledTimes(1);
    // Recovery re-runs start(), which rebases fresh (InMemoryMovement.start()
    // calls worktree.rebase() — see that adapter).
    expect(rebaseSpy).toHaveBeenCalledTimes(1);
  });

  it('mergeMovement does not loop the stale-rebase recovery — a second unexplained halt on the fresh attempt is reported normally, not retried again', async () => {
    const { wt, workArea } = await setupBaseBranchTest();
    vi.spyOn(wt, 'hasInProgressRebase').mockResolvedValue(true);
    vi.spyOn(wt, 'continueRebase').mockResolvedValueOnce({
      status: 'conflict',
      message: 'unexplained halt',
      originalHead: 'abc',
      conflictedFiles: [],
    });
    const abortRebaseSpy = vi.spyOn(wt, 'abortRebase');
    const rebaseSpy = vi.spyOn(wt, 'rebase').mockResolvedValueOnce({
      status: 'conflict',
      message: 'unexplained halt again',
      originalHead: 'def',
      conflictedFiles: [],
    });

    const result = await new MovementManager(wt, workArea).mergeMovement({
      type: 'feat',
      summary: 's',
      description: 'd',
    });

    expect(result.success).toBe(false);
    expect(result.needsRebase).toBe(true);
    expect(abortRebaseSpy).toHaveBeenCalledTimes(1);
    expect(rebaseSpy).toHaveBeenCalledTimes(1);
  });

  it('mergeMovement resuming a rebase tolerates a detached HEAD — does not fail the "on a movement branch" precondition against an empty currentBranch()', async () => {
    // Real git's `branch --show-current` returns an empty string while HEAD
    // is detached mid-rebase, and only reattaches to the movement branch
    // once `rebase --continue` actually finishes — reproduce that exact
    // ordering constraint (a fixed branch-name stub can't) rather than just
    // returning an empty string once.
    const { wt, workArea } = await setupBaseBranchTest();
    let rebaseContinued = false;
    vi.spyOn(wt, 'hasInProgressRebase').mockResolvedValue(true);
    const continueRebaseSpy = vi.spyOn(wt, 'continueRebase').mockImplementation(async () => {
      rebaseContinued = true;
      return { status: 'success' };
    });
    vi.spyOn(wt, 'currentBranch').mockImplementation(async () => (rebaseContinued ? MOVEMENT_BRANCH : ''));

    const result = await new MovementManager(wt, workArea).mergeMovement({
      type: 'feat',
      summary: 's',
      description: 'd',
    });

    expect(result.success).toBe(true);
    expect(continueRebaseSpy).toHaveBeenCalled();
  });

  it('startMovement on conflict: reports files to fix, never tells the agent to run git', async () => {
    const { wt, workArea } = await setupBaseBranchTest();
    vi.spyOn(wt, 'rebase').mockResolvedValueOnce({
      status: 'conflict',
      message: 'boom',
      originalHead: 'abc',
      conflictedFiles: ['shared.txt'],
    });
    const forcePushSpy = vi.spyOn(wt, 'forcePushBranch');

    const result = await new MovementManager(wt, workArea).startMovement();

    expect(result.success).toBe(false);
    expect(result.error).toContain('shared.txt');
    expect(result.error).toContain('call movement start again');
    expect(result.error?.toLowerCase()).not.toContain('git add');
    expect(result.error?.toLowerCase()).not.toContain('rebase --continue');
    expect(result.error?.toLowerCase()).toContain('do not run any git commands');
    expect(forcePushSpy).not.toHaveBeenCalled();
  });

  it('startMovement (fresh, not resuming) also recovers from a stale rebase halt with no conflicted files — not just the resume path', async () => {
    // A fresh `movement start` call's own movement.start() -> worktree.rebase()
    // can land in the same unresolvable "conflict, no files" shape on its
    // very first attempt, not only while resuming an earlier call.
    const { wt, workArea } = await setupBaseBranchTest();
    const rebaseSpy = vi
      .spyOn(wt, 'rebase')
      .mockResolvedValueOnce({
        status: 'conflict',
        message: 'unexplained halt',
        originalHead: 'abc',
        conflictedFiles: [],
      })
      .mockResolvedValueOnce({ status: 'success' });
    const abortRebaseSpy = vi.spyOn(wt, 'abortRebase');

    const result = await new MovementManager(wt, workArea).startMovement();

    expect(result.success).toBe(true);
    expect(abortRebaseSpy).toHaveBeenCalledTimes(1);
    expect(rebaseSpy).toHaveBeenCalledTimes(2);
  });

  it('startMovement when a rebase is already in progress: continues it instead of fetching and starting over', async () => {
    const { wt, workArea } = await setupBaseBranchTest();
    vi.spyOn(wt, 'hasInProgressRebase').mockResolvedValue(true);
    const continueRebaseSpy = vi.spyOn(wt, 'continueRebase').mockResolvedValueOnce({ status: 'success' });
    const rebaseSpy = vi.spyOn(wt, 'rebase');

    const result = await new MovementManager(wt, workArea).startMovement();

    expect(result.success).toBe(true);
    expect(continueRebaseSpy).toHaveBeenCalled();
    expect(rebaseSpy).not.toHaveBeenCalled();
  });

  it('startMovement resuming into another conflict gets the exact same clean, git-mechanics-free contract (same resumable-rebase shape as mergeMovement/promote/absorbPlanBranch)', async () => {
    const { wt, workArea } = await setupBaseBranchTest();
    vi.spyOn(wt, 'hasInProgressRebase').mockResolvedValue(true);
    vi.spyOn(wt, 'continueRebase').mockResolvedValueOnce({
      status: 'conflict',
      message: 'boom again',
      originalHead: 'abc',
      conflictedFiles: ['third.txt'],
    });
    const forcePushSpy = vi.spyOn(wt, 'forcePushBranch');

    const result = await new MovementManager(wt, workArea).startMovement();

    expect(result.success).toBe(false);
    expect(result.wasUpdated).toBe(false);
    expect(result.error).toContain('third.txt');
    expect(result.error).toContain('call movement start again');
    expect(result.error?.toLowerCase()).not.toContain('git add');
    expect(result.error?.toLowerCase()).not.toContain('rebase --continue');
    expect(forcePushSpy).not.toHaveBeenCalled();
  });

  it('startMovement recovers automatically from a stale rebase halt with no conflicted files — same recovery mergeMovement already has', async () => {
    // Regression test for the gap settleRebaseAttempt closes: startMovement's
    // resume path used to skip recoverFromUnexplainedHalt entirely (only
    // mergeMovement had it), so this exact "stale, orphaned rebase session"
    // shape reported the same unresolvable "conflict" on every `movement
    // start` retry forever — confirmed live in production.
    const { wt, workArea } = await setupBaseBranchTest();
    vi.spyOn(wt, 'hasInProgressRebase').mockResolvedValue(true);
    const continueRebaseSpy = vi.spyOn(wt, 'continueRebase').mockResolvedValueOnce({
      status: 'conflict',
      message: 'unexplained halt',
      originalHead: 'abc',
      conflictedFiles: [],
    });
    const abortRebaseSpy = vi.spyOn(wt, 'abortRebase');
    const rebaseSpy = vi.spyOn(wt, 'rebase').mockResolvedValueOnce({ status: 'success' });

    const result = await new MovementManager(wt, workArea).startMovement();

    expect(result.success).toBe(true);
    expect(continueRebaseSpy).toHaveBeenCalledTimes(1);
    expect(abortRebaseSpy).toHaveBeenCalledTimes(1);
    expect(rebaseSpy).toHaveBeenCalledTimes(1);
  });

  it('startMovement does not loop the stale-rebase recovery — a second unexplained halt on the fresh attempt is reported normally, not retried again', async () => {
    const { wt, workArea } = await setupBaseBranchTest();
    vi.spyOn(wt, 'hasInProgressRebase').mockResolvedValue(true);
    vi.spyOn(wt, 'continueRebase').mockResolvedValueOnce({
      status: 'conflict',
      message: 'unexplained halt',
      originalHead: 'abc',
      conflictedFiles: [],
    });
    const abortRebaseSpy = vi.spyOn(wt, 'abortRebase');
    const rebaseSpy = vi.spyOn(wt, 'rebase').mockResolvedValueOnce({
      status: 'conflict',
      message: 'unexplained halt again',
      originalHead: 'def',
      conflictedFiles: [],
    });

    const result = await new MovementManager(wt, workArea).startMovement();

    expect(result.success).toBe(false);
    expect(abortRebaseSpy).toHaveBeenCalledTimes(1);
    expect(rebaseSpy).toHaveBeenCalledTimes(1);
    // No files to edit — the widened message explains that instead of
    // sending the agent looking for conflict markers that don't exist.
    expect(result.error).toContain('unexplained halt again');
    expect(result.error?.toLowerCase()).toContain('no conflicted files');
  });

  it('retries after losing the CAS race on the trunk, and still lands cleanly', async () => {
    // Simulates another wing's merge publishing to the trunk between this
    // call's rebase and its own publish attempt: the first CAS loses. A
    // blind `branch -f` here would silently overwrite the other wing's
    // commit instead of retrying, which is exactly what the CAS-and-retry
    // loop exists to prevent. Spies on the real repository's real
    // `updateBranchIfUnchanged` (rather than a hand-built mock) to force
    // exactly one lost race, falling through to the real implementation
    // otherwise.
    const { sandbox, repo, wt, trunk, workArea } = await setupBaseBranchTest();
    await wt.createFile('feature.ts', 'export const feature = true;\n');
    await wt.commitAll('add feature');

    const realUpdateBranchIfUnchanged = repo.updateBranchIfUnchanged.bind(repo);
    let mergePublishAttempts = 0;
    vi.spyOn(repo, 'updateBranchIfUnchanged').mockImplementation(async (name, target, expected) => {
      mergePublishAttempts++;
      if (mergePublishAttempts === 1) return false;
      return realUpdateBranchIfUnchanged(name, target, expected);
    });

    const result = await new MovementManager(wt, workArea).mergeMovement({ type: 'feat', summary: 's', description: 'd' });

    expect(result.success).toBe(true);
    expect(mergePublishAttempts).toBe(2);
    const verify = await repo.createWorktree(sandbox.root, 'verify-retry', trunk);
    expect((await verify.child('feature.ts')).found).toBe(true);
  });

  it('fails clearly instead of retrying forever when contention on the trunk never clears', async () => {
    const { repo, wt, workArea } = await setupBaseBranchTest();
    await wt.createFile('feature.ts', 'export const feature = true;\n');
    await wt.commitAll('add feature');

    vi.spyOn(repo, 'updateBranchIfUnchanged').mockResolvedValue(false);

    const result = await new MovementManager(wt, workArea).mergeMovement({ type: 'feat', summary: 's', description: 'd' });

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('two wings merging concurrently both land — real worktrees, no commit silently discarded', async () => {
    // Real (in-memory) worktrees, not mocks: two separate wings sharing one
    // bare repo, each merging its own movement branch to `main` at the same
    // time via Promise.all. Before the CAS-and-retry fix (and before
    // SimulatedGit became worktree-aware), whichever concurrent write landed
    // second would silently discard the first, exactly the incident this
    // test guards against end-to-end.
    const realSandbox = createInMemorySandbox();
    const repo = await realSandbox.initBare(realSandbox.root, 'concurrent-repo');

    const seed = await repo.createWorktree(realSandbox.root, 'seed', 'main');
    await seed.createFile('README.md', '# seed\n');
    await seed.commitAll('seed main');
    // Move this worktree off `main` — the concurrent merges below force-move
    // `main` by name, which real git refuses if any worktree has it checked out.
    await seed.switchBranch('scratch');

    const wingA = await repo.createWorktree(realSandbox.root, 'wing-a', 'l/lair/w/wing-a');
    const wingB = await repo.createWorktree(realSandbox.root, 'wing-b', 'l/lair/w/wing-b');

    await wingA.createFile('a.txt', 'from A\n');
    await wingA.commitAll('A change');

    await wingB.createFile('b.txt', 'from B\n');
    await wingB.commitAll('B change');

    const workAreaA = makeWorkArea(repo, wingA);
    const workAreaB = makeWorkArea(repo, wingB);

    const [resultA, resultB] = await Promise.all([
      new MovementManager(wingA, workAreaA).mergeMovement({ type: 'feat', summary: 'A change', description: 'A' }),
      new MovementManager(wingB, workAreaB).mergeMovement({ type: 'feat', summary: 'B change', description: 'B' }),
    ]);

    expect(resultA.success).toBe(true);
    expect(resultB.success).toBe(true);

    const verify = await repo.createWorktree(realSandbox.root, 'verify', 'main');
    expect((await verify.child('a.txt')).found).toBe(true);
    expect((await verify.child('b.txt')).found).toBe(true);
  });
});

describe('MovementManager.promote', () => {
  const TRUNK = 'experiment/faster-cache/redis';
  const WING_BRANCH = 'l/lair/w/wing';

  /**
   * Builds a real worktree (`wt`) checked out on a wing branch whose
   * base-branch override is an experiment trunk (`TRUNK`), plus the
   * `WorkArea`/root `Trunk` handle a real `promote()` call is given
   * (design doc §4.4 — `promote()` is now a thin delegation onto
   * `DerivedTrunk.advance()`/`beginAdvance()`/`Trunk.fastForwardPublish()`,
   * see `MovementManager.promote`'s own doc comment).
   *
   * `opts.conflicting`: when true, both `main` and `TRUNK` edit `shared.txt`
   * differently after diverging, so `advance()`'s conflict-free fast path
   * fails and `promote()` must escalate to `beginAdvance()`, borrowing `wt`
   * itself. When false (default), `TRUNK` simply has commits `main` doesn't
   * — the realistic "nothing to resolve" case, exercised via `advance()`
   * alone.
   */
  async function setupPromoteTest(opts?: { conflicting?: boolean }) {
    const sandbox = createInMemorySandbox();
    const repo = await sandbox.initBare(sandbox.root, 'test-repo');

    const main = await repo.createWorktree(sandbox.root, 'main-seed', 'main');
    await main.createFile('shared.txt', 'base\n');
    await main.commitAll('seed');
    await repo.pushBranch('main');

    await repo.createBranchIfMissing(TRUNK, 'main');
    const trunkWt = await repo.createWorktree(sandbox.root, 'trunk-wt', TRUNK);
    await trunkWt.createFile('trunk-feature.ts', 'export const onTrunk = true;\n');
    if (opts?.conflicting) {
      await trunkWt.createFile('shared.txt', 'trunk version\n');
    }
    await trunkWt.commitAll('trunk moves on');
    await repo.pushBranch(TRUNK);
    await repo.removeWorktree(trunkWt);

    if (opts?.conflicting) {
      // main also moves, editing the SAME file the trunk touched differently
      // — advance()'s conflict-free fast path cannot resolve this.
      await main.createFile('shared.txt', 'main version\n');
      await main.commitAll('main changes shared.txt');
      await repo.pushBranch('main');
    }
    await repo.removeWorktree(main);

    await repo.createBranchIfMissing(WING_BRANCH, TRUNK);
    const wt = await repo.createWorktree(sandbox.root, 'wing', WING_BRANCH);
    await wt.setBaseBranch(TRUNK);

    const factories = createInMemoryWorkAreaFactories();
    const workArea = createWorkArea(repo, wt, factories);
    const mainTrunk: Trunk = createInMemoryTrunk(repo, 'main');
    // A fresh registry per test — real production shares ONE process-wide
    // default (see `AdvanceAttemptRegistry`'s own doc comment), but tests
    // must not leak an open `AdvanceAttempt` from one test into the next.
    const registry = new AdvanceAttemptRegistry();

    return { sandbox, repo, wt, workArea, mainTrunk, registry };
  }

  /**
   * `InMemoryDerivedTrunk.advance()`'s conflict-free fast path is an honest
   * placeholder (flatten-via-`commitTree`, always succeeds — see
   * `InMemoryTrunk.ts`'s own doc comment) — `SimulatedGit`'s single-parent
   * history model has no real content-diffing, so it can never naturally
   * report a `"conflict"` the way real git's `rebase --rebase-merges` can.
   * To exercise `promote()`'s OWN escalation-to-`beginAdvance()` orchestration
   * (already proven correct at the file-store level, in
   * `movement-trunk-sandbox.test.ts`) without re-proving that lower-level
   * mechanism here, this pins `mainTrunk.derive()` to always return the SAME
   * `DerivedTrunk` instance and forces exactly one `advance()` call to report
   * a conflict — falling through to the REAL implementation for every
   * subsequent call (so a retry inside `foldPromotedTrunk`'s loop, or the
   * eventual real fast-forward, still behaves genuinely).
   */
  function forceOneAdvanceConflict(mainTrunk: Trunk): void {
    const derivedTrunk = mainTrunk.derive(TRUNK);
    vi.spyOn(mainTrunk, 'derive').mockReturnValue(derivedTrunk);
    vi.spyOn(derivedTrunk, 'advance').mockResolvedValueOnce({
      status: 'conflict',
      failedCommit: '',
      message: 'forced conflict for test',
    });
  }

  /** `SimulatedGit`'s rebase-conflict signal is a global toggle — see `forceOneAdvanceConflict`'s doc for why. Controls what `beginAdvance()`'s real rebase reports. */
  function setSimulatedRebaseConflict(repo: BareRepository, conflict: boolean, message?: string, files?: string[]): void {
    (repo as unknown as { getGit(): { setSimulatedRebaseConflict(c: boolean, m?: string, f?: string[]): void } })
      .getGit()
      .setSimulatedRebaseConflict(conflict, message, files);
  }

  it('on the conflict-free fast path: folds the trunk onto main with no checkout at all, and leaves the wing worktree untouched', async () => {
    const { sandbox, wt, workArea, mainTrunk, registry } = await setupPromoteTest();
    const switchBranchSpy = vi.spyOn(wt, 'switchBranch');

    const result = await new MovementManager(wt, workArea, registry).promote(mainTrunk);

    expect(result.success).toBe(true);
    expect(result.trunk).toBe(TRUNK);
    // advance()'s fast path never checks out anything in the wing's own
    // worktree — that's the point: `promote()` never needs a "check the
    // trunk out here" step.
    expect(switchBranchSpy).not.toHaveBeenCalled();
    expect(await wt.currentBranch()).toBe(WING_BRANCH);
    // main really did fast-forward to the trunk's tip.
    const trunkHash = await wt.repository.resolveLocalRef(TRUNK);
    expect(await wt.repository.resolveLocalRef('main')).toBe(trunkHash);
    const check = await wt.repository.createWorktree(sandbox.root, 'check-fast', 'main');
    expect(await check.child('trunk-feature.ts')).toMatchObject({ found: true });
    await wt.repository.removeWorktree(check);
  });

  it('on a real content conflict: escalates to beginAdvance(), borrowing the wing worktree itself — files land in wt, not somewhere new', async () => {
    const { repo, wt, workArea, mainTrunk, registry } = await setupPromoteTest({ conflicting: true });
    forceOneAdvanceConflict(mainTrunk);
    setSimulatedRebaseConflict(repo, true, 'boom', ['shared.txt']);

    const result = await new MovementManager(wt, workArea, registry).promote(mainTrunk);

    expect(result.success).toBe(false);
    expect(result.needsResolution).toBe(true);
    expect(result.trunk).toBe(TRUNK);
    expect(result.error).toContain('shared.txt');
    expect(result.error).toContain('call promote again');
    // Deliberately minimal contract: never told a rebase is in progress,
    // never told to run git, never told to commit.
    expect(result.error?.toLowerCase()).not.toContain('rebase');
    expect(result.error?.toLowerCase()).toContain('do not run any git commands');
    expect(result.error?.toLowerCase()).toContain('do not commit');
    // The conflict landed in `wt` ITSELF — beginAdvance() borrowed the wing's
    // own worktree (design doc §4.4's `resolveIn` contract) rather than
    // provisioning a new one somewhere the agent has never seen.
    expect(await wt.currentBranch()).not.toBe(WING_BRANCH);
    expect(await wt.child('shared.txt')).toMatchObject({ found: true });
    // main is untouched — nothing was folded.
    expect(await wt.repository.resolveLocalRef('main')).not.toBe(await wt.repository.resolveLocalRef(TRUNK));
  });

  it('escalating to beginAdvance() with a dirty wing worktree throws a clear, actionable error instead of a confusing conflict result (finding #14)', async () => {
    const { repo, wt, workArea, mainTrunk, registry } = await setupPromoteTest({ conflicting: true });
    forceOneAdvanceConflict(mainTrunk);
    setSimulatedRebaseConflict(repo, true, 'boom', ['shared.txt']);

    // Dirty the wing's own worktree BEFORE promote() ever escalates — this is
    // the exact `resolveIn` `beginAdvance()` borrows.
    await wt.createFile('uncommitted.txt', 'not yet committed');
    expect(await wt.isDirty()).toBe(true);

    await expect(new MovementManager(wt, workArea, registry).promote(mainTrunk)).rejects.toThrow(
      /uncommitted changes.*commit or discard/,
    );

    // No mutation was attempted: wt stayed on its own branch, still dirty
    // with exactly the uncommitted content added above, and main never moved.
    expect(await wt.currentBranch()).toBe(WING_BRANCH);
    expect(await wt.isDirty()).toBe(true);
    expect(await wt.repository.resolveLocalRef('main')).not.toBe(await wt.repository.resolveLocalRef(TRUNK));
  });

  it('resuming after fixing the conflicted file: a second promote() call resolves, publishes, and folds onto main', async () => {
    const { sandbox, repo, wt, workArea, mainTrunk, registry } = await setupPromoteTest({ conflicting: true });
    forceOneAdvanceConflict(mainTrunk);
    setSimulatedRebaseConflict(repo, true, 'boom', ['shared.txt']);

    const first = await new MovementManager(wt, workArea, registry).promote(mainTrunk);
    expect(first.needsResolution).toBe(true);

    // Simulate the agent fixing the conflicted file in place.
    setSimulatedRebaseConflict(repo, false);
    const fileResult = await wt.child('shared.txt');
    expect(fileResult.found).toBe(true);
    if (fileResult.found && fileResult.node.kind === 'file') {
      await fileResult.node.write('resolved value\n');
    }

    // A FRESH MovementManager — same worktree, same registry — mirrors a
    // brand new MCP call reconstructing everything except the process-wide
    // registry.
    const second = await new MovementManager(wt, workArea, registry).promote(mainTrunk);

    expect(second.success).toBe(true);
    expect(second.trunk).toBe(TRUNK);
    // The registry entry is cleared once the attempt genuinely lands.
    expect(registry.get(wt.path)).toBeUndefined();
    // The wing worktree is restored to its original branch — usable again
    // exactly as it was before promote() borrowed it.
    expect(await wt.currentBranch()).toBe(WING_BRANCH);
    // baseBranch() was never touched by any of this — promote() has no
    // "switch onto the trunk, then restore both branch AND base override"
    // dance at all, since beginAdvance() never checks out the trunk itself
    // in the first place.
    expect(await wt.baseBranch()).toBe(TRUNK);
    // main folded to the resolved tip. (Exact resolved CONTENT isn't
    // meaningfully assertable against `SimulatedGit`'s rebase — its conflict
    // signal is a global toggle, not real content-diffing, so a "resolved"
    // rebase's tree isn't computed from the agent's actual edit. That's
    // proven against real git in file-store's own disk-specific
    // `beginAdvance()` tests;
    // this level only needs to prove promote()'s OWN orchestration folded
    // something onto main.)
    const trunkHash = await wt.repository.resolveLocalRef(TRUNK);
    expect(await wt.repository.resolveLocalRef('main')).toBe(trunkHash);
    const check = await wt.repository.createWorktree(sandbox.root, 'check-resolved', 'main');
    expect(await check.child('shared.txt')).toMatchObject({ found: true });
    await wt.repository.removeWorktree(check);
  });

  it('never creates a synthetic merge commit — no commitTree call, unlike mergeMovement', async () => {
    const { wt, workArea, mainTrunk, registry } = await setupPromoteTest();
    const commitTreeSpy = vi.spyOn(wt, 'commitTree');
    await new MovementManager(wt, workArea, registry).promote(mainTrunk);
    expect(commitTreeSpy).not.toHaveBeenCalled();
  });

  it('throws a clear, actionable error when constructed without a WorkArea', async () => {
    const { wt, mainTrunk } = await setupPromoteTest();
    await expect(new MovementManager(wt).promote(mainTrunk)).rejects.toThrow(/requires a WorkArea/);
  });
});

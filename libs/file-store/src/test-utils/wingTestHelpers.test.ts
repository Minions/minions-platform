/**
 * Tests for `createTestWing`'s design-doc-§4.2 `WorkArea`/`Scratchpad`
 * accessors (`workAreaLocal`/`workAreaGlobal`/`workAreaNamed`/
 * `privateWorkAreaGlobal`/`scratchpad`). This test file exercises the real
 * implementation, so real callers can rely on `createTestWing` behaving the
 * same way `LairWing` does for these accessors instead of throwing.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemorySandbox } from '../adapters/memory/InMemorySandbox.js';
import { createLair } from '../lair/LairImpl.js';
import { createWorkAreaFactoriesForSandbox } from '../lair/workAreaFactoriesForSandbox.js';
import { createTestWing } from './wingTestHelpers.js';
import type { Lair, Wing } from '../lair/index.js';
import type { Directory, Worktree } from '../port/index.js';

describe('createTestWing — WorkArea/Scratchpad accessors', () => {
  let sandbox: InMemorySandbox;
  let lair: Lair;
  let wingRoot: Directory;

  beforeEach(async () => {
    sandbox = new InMemorySandbox('wing-test-helpers');
    lair = await createLair(sandbox);
    const wingsDir = await lair.root.createDirectory('wings');
    wingRoot = await wingsDir.createDirectory('test-wing');
  });

  /** Mirrors `closetUtils.test.ts`'s `makeWorkLocalWithSrc` helper: a real
   * bare repo + worktree, independent of `lair`'s own sandbox, to stand in
   * for a wing's `work/local`. */
  async function makeWorkLocalWorktree(): Promise<Worktree> {
    const wlSandbox = new InMemorySandbox('work-local');
    const repo = await wlSandbox.initBare(wlSandbox.root, 'repo.git');
    const worktree = await repo.createWorktree(wlSandbox.root, 'local', 'main');
    await worktree.createFile('hello.txt', 'hello world');
    await worktree.commitAll('seed');
    return worktree;
  }

  it('workAreaLocal() throws the "no work/local worktree" error when workLocal() reports not-exists (default stub)', async () => {
    const wing = createTestWing({ name: 'test-wing', root: wingRoot, lair });
    await expect(wing.workAreaLocal()).rejects.toThrow(/no work\/local worktree/);
  });

  it('workAreaLocal() throws the "without WorkAreaFactories" error when no factories were passed, even with a real worktree', async () => {
    const workLocalWorktree = await makeWorkLocalWorktree();
    const wing: Wing = {
      ...createTestWing({ name: 'test-wing', root: wingRoot, lair }),
      workLocal: async () => ({ exists: true, worktree: workLocalWorktree }),
    };
    await expect(wing.workAreaLocal()).rejects.toThrow(/without WorkAreaFactories/);
  });

  it('workAreaLocal() returns a real WorkArea, reflecting a workLocal() override — proves dynamic `this` dispatch', async () => {
    const workLocalWorktree = await makeWorkLocalWorktree();
    const scratchRoot = await sandbox.root.createDirectory('movement-scratch');
    const workAreaFactories = createWorkAreaFactoriesForSandbox(sandbox, scratchRoot);
    const wing: Wing = {
      ...createTestWing({ name: 'test-wing', root: wingRoot, lair, workAreaFactories }),
      workLocal: async () => ({ exists: true, worktree: workLocalWorktree }),
    };

    const workArea = await wing.workAreaLocal();
    const movement = await workArea.activeMovement();
    const children = await movement.files.children();

    expect(children.map((c) => c.name)).toContain('hello.txt');
  });

  it('scratchpad() needs no factories and works off privateLocal()', async () => {
    const privateLocalWorktree = await makeWorkLocalWorktree();
    const wing: Wing = {
      ...createTestWing({ name: 'test-wing', root: wingRoot, lair }),
      privateLocal: async () => ({ exists: true, worktree: privateLocalWorktree }),
    };

    const scratchpad = await wing.scratchpad();
    const children = await scratchpad.files.children();

    expect(children.map((c) => c.name)).toContain('hello.txt');
  });

  it('scratchpad() throws when privateLocal() reports not-exists (default stub)', async () => {
    const wing = createTestWing({ name: 'test-wing', root: wingRoot, lair });
    await expect(wing.scratchpad()).rejects.toThrow(/no private\/local worktree/);
  });
});

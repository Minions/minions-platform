/**
 * Tests for closet overlay behavior.
 *
 * Verifies that getOverlaidCostumeDirectories merges lair and wing closets,
 * with wing costumes overriding lair costumes by name.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemorySandbox } from '../src/adapters/memory/InMemorySandbox.js';
import { createLair } from '../src/lair/LairImpl.js';
import { createWorkAreaFactoriesForSandbox } from '../src/lair/workAreaFactoriesForSandbox.js';
import { createTestWing } from '../src/test-utils/wingTestHelpers.js';
import { getOverlaidCostumeDirectories } from '../src/utils/closetUtils.js';
import type { Lair, Wing, WorkAreaFactories } from '../src/lair/index.js';
import type { Directory, Worktree } from '../src/port/index.js';

describe('getOverlaidCostumeDirectories', () => {
  let lair: Lair;
  let lairCloset: Directory;
  let workAreaFactories: WorkAreaFactories;

  beforeEach(async () => {
    const sandbox = new InMemorySandbox('test-lair');
    lair = await createLair(sandbox);
    lairCloset = await lair.closet();
    // Needed so `wing.workAreaLocal()` (which `getOverlaidCostumeDirectories`'s
    // src-overlay path is built on — see closetUtils.ts) works through
    // `createTestWing`, not just `wing.workLocal()`.
    const scratchRoot = await sandbox.root.createDirectory('movement-scratch');
    workAreaFactories = createWorkAreaFactoriesForSandbox(sandbox, scratchRoot);
  });

  function makeWing(name: string, wingRoot: Directory): Wing {
    return createTestWing({ name, root: wingRoot, lair, closetExists: false, workAreaFactories });
  }

  it('returns lair costumes when wing has no closet', async () => {
    // Set up lair closet with two costumes
    await lairCloset.createDirectory('costume-a');
    await lairCloset.createDirectory('costume-b');

    // Create a wing with no closet directory
    const wingRoot = await lair.root.createDirectory('wings');
    const wingDir = await wingRoot.createDirectory('test-wing');
    const wing = makeWing('test-wing', wingDir);

    const costumes = await getOverlaidCostumeDirectories(wing);

    expect(costumes.size).toBe(2);
    expect(costumes.has('costume-a')).toBe(true);
    expect(costumes.has('costume-b')).toBe(true);
  });

  it('returns lair costumes when wing has empty closet', async () => {
    // Set up lair closet with two costumes
    await lairCloset.createDirectory('costume-a');
    await lairCloset.createDirectory('costume-b');

    // Create a wing with an empty closet directory
    const wingRoot = await lair.root.createDirectory('wings');
    const wingDir = await wingRoot.createDirectory('test-wing');
    await wingDir.createDirectory('closet');
    const wing = makeWing('test-wing', wingDir);

    const costumes = await getOverlaidCostumeDirectories(wing);

    expect(costumes.size).toBe(2);
    expect(costumes.has('costume-a')).toBe(true);
    expect(costumes.has('costume-b')).toBe(true);
  });

  it('wing costume overrides lair costume with same name', async () => {
    // Set up lair closet with a costume
    const lairCostume = await lairCloset.createDirectory('shared-costume');
    await lairCostume.createFile('marker.txt', 'from-lair');

    // Create a wing with its own version of the same costume
    const wingRoot = await lair.root.createDirectory('wings');
    const wingDir = await wingRoot.createDirectory('test-wing');
    const wingCloset = await wingDir.createDirectory('closet');
    const wingCostume = await wingCloset.createDirectory('shared-costume');
    await wingCostume.createFile('marker.txt', 'from-wing');
    const wing = makeWing('test-wing', wingDir);

    const costumes = await getOverlaidCostumeDirectories(wing);

    expect(costumes.size).toBe(1);
    expect(costumes.has('shared-costume')).toBe(true);

    // Verify the wing version won (not the lair version)
    const costume = costumes.get('shared-costume');
    if (!costume) throw new Error('expected shared-costume directory');
    const markerResult = await costume.child('marker.txt');
    expect(markerResult.found).toBe(true);
    if (markerResult.found && markerResult.node.kind === 'file') {
      const content = await markerResult.node.read();
      expect(content).toBe('from-wing');
    }
  });

  it('merges unique costumes from both lair and wing', async () => {
    // Lair has costume-a
    await lairCloset.createDirectory('costume-a');

    // Wing has costume-b
    const wingRoot = await lair.root.createDirectory('wings');
    const wingDir = await wingRoot.createDirectory('test-wing');
    const wingCloset = await wingDir.createDirectory('closet');
    await wingCloset.createDirectory('costume-b');
    const wing = makeWing('test-wing', wingDir);

    const costumes = await getOverlaidCostumeDirectories(wing);

    expect(costumes.size).toBe(2);
    expect(costumes.has('costume-a')).toBe(true);
    expect(costumes.has('costume-b')).toBe(true);
  });

  it('returns empty map when neither lair nor wing has closet', async () => {
    // Use a fresh sandbox with no closet set up
    const sandbox = new InMemorySandbox('empty-lair');
    const emptyLair = await createLair(sandbox);

    const wingRoot = await emptyLair.root.createDirectory('wings');
    const wingDir = await wingRoot.createDirectory('test-wing');
    const wing = createTestWing({ name: 'test-wing', root: wingDir, lair: emptyLair, closetExists: false });

    const costumes = await getOverlaidCostumeDirectories(wing);

    expect(costumes.size).toBe(0);
  });

  it('returns only wing costumes when lair closet is empty', async () => {
    // Lair closet exists but is empty (created in beforeEach)

    // Wing has a costume
    const wingRoot = await lair.root.createDirectory('wings');
    const wingDir = await wingRoot.createDirectory('test-wing');
    const wingCloset = await wingDir.createDirectory('closet');
    await wingCloset.createDirectory('wing-only');
    const wing = makeWing('test-wing', wingDir);

    const costumes = await getOverlaidCostumeDirectories(wing);

    expect(costumes.size).toBe(1);
    expect(costumes.has('wing-only')).toBe(true);
  });

  async function makeWorkLocalWithSrc(name: string): Promise<Worktree> {
    // Create a separate sandbox to simulate work/local worktree
    const wlSandbox = new InMemorySandbox(`work-local-${name}`);
    const repo = await wlSandbox.initBare(wlSandbox.root, 'repo.git');
    const worktree = await repo.createWorktree(wlSandbox.root, 'local', 'main');

    // Set up costumes/<costume>/src/costume.json
    const costumesDir = await worktree.createDirectory('costumes');
    const costumeDir = await costumesDir.createDirectory(name);
    const srcDir = await costumeDir.createDirectory('src');
    await srcDir.createFile('costume.json', '{}');
    await srcDir.createFile('marker.txt', 'from-src');

    return worktree;
  }

  it('src overlay is not applied by default (no includeSrcOverlay)', async () => {
    // Lair has a costume with a marker
    const lairCostume = await lairCloset.createDirectory('my-costume');
    await lairCostume.createFile('marker.txt', 'from-lair');

    // Work/local has the same costume in src/
    const workLocalWorktree = await makeWorkLocalWithSrc('my-costume');
    const wingRoot = await lair.root.createDirectory('wings-a');
    const wingDir = await wingRoot.createDirectory('test-wing');
    const wing: Wing = {
      ...makeWing('test-wing', wingDir),
      workLocal: async () => ({ exists: true, worktree: workLocalWorktree }),
    };

    // Default: no src overlay
    const costumes = await getOverlaidCostumeDirectories(wing);

    expect(costumes.has('my-costume')).toBe(true);
    const myCostume = costumes.get('my-costume');
    if (!myCostume) throw new Error('expected my-costume directory');
    const markerResult = await myCostume.child('marker.txt');
    expect(markerResult.found).toBe(true);
    if (markerResult.found && markerResult.node.kind === 'file') {
      expect(await markerResult.node.read()).toBe('from-lair');
    }
  });

  it('src overlay is applied when includeSrcOverlay is true', async () => {
    // Lair has a costume with a marker
    const lairCostume = await lairCloset.createDirectory('my-costume');
    await lairCostume.createFile('marker.txt', 'from-lair');

    // Work/local has the same costume in src/
    const workLocalWorktree = await makeWorkLocalWithSrc('my-costume');
    const wingRoot = await lair.root.createDirectory('wings-b');
    const wingDir = await wingRoot.createDirectory('test-wing');
    const wing: Wing = {
      ...makeWing('test-wing', wingDir),
      workLocal: async () => ({ exists: true, worktree: workLocalWorktree }),
    };

    // With includeSrcOverlay: true, src overlay is applied
    const costumes = await getOverlaidCostumeDirectories(wing, { includeSrcOverlay: true });

    expect(costumes.has('my-costume')).toBe(true);
    const myCostume = costumes.get('my-costume');
    if (!myCostume) throw new Error('expected my-costume directory');
    const markerResult = await myCostume.child('marker.txt');
    expect(markerResult.found).toBe(true);
    if (markerResult.found && markerResult.node.kind === 'file') {
      expect(await markerResult.node.read()).toBe('from-src');
    }
  });
});

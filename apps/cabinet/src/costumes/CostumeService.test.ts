import { describe, it, expect, beforeEach } from 'vitest';
import { debugInstallCostume, listInstalledCostumes } from './CostumeService.js';
import {
  createInMemorySandbox,
  createLair,
  createWorkAreaFactoriesForSandbox,
  type Sandbox,
  type Directory,
  type Wing,
  type File,
  type Worktree,
  type WorkArea,
  type CheckedOutMovement,
} from '@minions/file-store';

/**
 * Helper function to create a costume source directory structure.
 * Creates wings/<wingName>/work/local/<costumePath>/src with optional subdirectories.
 */
async function createCostumeSource(
  lairRoot: Directory,
  wingName: string,
  costumePath: string,
  options: {
    missions?: string[];
    disguises?: string[];
    skills?: string[];
    files?: Array<{ path: string; content: string }>;
  } = {}
): Promise<Directory> {
  // Get or create wings directory
  const wingsResult = await lairRoot.child('wings');
  let wingsDir: Directory;
  if (wingsResult.found && wingsResult.node.is('directory')) {
    wingsDir = wingsResult.node as Directory;
  } else {
    wingsDir = await lairRoot.createDirectory('wings');
  }

  // Get or create wing directory
  const wingResult = await wingsDir.child(wingName);
  let wingDir: Directory;
  if (wingResult.found && wingResult.node.is('directory')) {
    wingDir = wingResult.node as Directory;
  } else {
    wingDir = await wingsDir.createDirectory(wingName);
  }

  const workDir = await wingDir.createDirectory('work');
  const localDir = await workDir.createDirectory('local');

  // Navigate to costume path
  const pathParts = costumePath.split('/');
  let currentDir = localDir;
  for (const part of pathParts) {
    currentDir = await currentDir.createDirectory(part);
  }

  // Create src directory
  const srcDir = await currentDir.createDirectory('src');

  // Create missions directory and files
  if (options.missions && options.missions.length > 0) {
    const missionsDir = await srcDir.createDirectory('missions');
    for (const mission of options.missions) {
      await missionsDir.createFile(`${mission}.md`, `# ${mission}`);
    }
  }

  // Create disguises directory and files
  if (options.disguises && options.disguises.length > 0) {
    const disguisesDir = await srcDir.createDirectory('disguises');
    for (const disguise of options.disguises) {
      await disguisesDir.createFile(`${disguise}.md`, `# ${disguise}`);
    }
  }

  // Create skills directory and files
  if (options.skills && options.skills.length > 0) {
    const skillsDir = await srcDir.createDirectory('skills');
    for (const skill of options.skills) {
      await skillsDir.createFile(`${skill}.md`, `# ${skill}`);
    }
  }

  // Create custom files
  if (options.files && options.files.length > 0) {
    for (const file of options.files) {
      await srcDir.createFile(file.path, file.content);
    }
  }

  return srcDir;
}

/**
 * Create a mock Wing for tests that only need basic Wing properties.
 * The mock Wing has a root directory and a workLocal() that returns a worktree-like directory.
 */
async function createMockTargetWing(
  lairRoot: Directory,
  wingName: string
): Promise<Wing> {
  // Get or create wings directory
  const wingsResult = await lairRoot.child('wings');
  let wingsDir: Directory;
  if (wingsResult.found && wingsResult.node.is('directory')) {
    wingsDir = wingsResult.node as Directory;
  } else {
    wingsDir = await lairRoot.createDirectory('wings');
  }

  // Get or create wing directory
  const wingResult = await wingsDir.child(wingName);
  let wingDir: Directory;
  if (wingResult.found && wingResult.node.is('directory')) {
    wingDir = wingResult.node as Directory;
  } else {
    wingDir = await wingsDir.createDirectory(wingName);
  }

  // Create work/local structure for .claude links
  let workDir: Directory;
  const workResult = await wingDir.child('work');
  if (workResult.found && workResult.node.is('directory')) {
    workDir = workResult.node as Directory;
  } else {
    workDir = await wingDir.createDirectory('work');
  }
  let localDir: Directory;
  const localResult = await workDir.child('local');
  if (localResult.found && localResult.node.is('directory')) {
    localDir = localResult.node as Directory;
  } else {
    localDir = await workDir.createDirectory('local');
  }

  return {
    name: wingName,
    root: wingDir,
    workLocal: async () => ({ exists: true, worktree: localDir }),
    workGlobal: async () => ({ exists: false }),
    privateLocal: async () => ({ exists: false }),
    privateGlobal: async () => ({ exists: false }),
    // `CostumeManager.ts`'s `debugInstallCostume` resolves its
    // `.claude`-root via `workAreaLocal()` (design doc §4.2) — this mock
    // needs it too, or the code's try/catch would (correctly, but not what
    // these tests want) fall back to wing root instead of `localDir`.
    workAreaLocal: async () =>
      ({
        activeMovement: async () => ({ files: localDir }) as unknown as CheckedOutMovement,
      }) as unknown as WorkArea,
    workAreaLocalIfExists: async () =>
      ({
        activeMovement: async () => ({ files: localDir }) as unknown as CheckedOutMovement,
      }) as unknown as WorkArea,
  } as unknown as Wing;
}

/**
 * Real `Lair`s in this file's "wing closet behavior" tests need
 * `WorkAreaFactories` wired in — `debugInstallCostume`'s `.claude`-root
 * resolution now goes through `wing.workAreaLocal()`, which throws
 * "without WorkAreaFactories" on a `Lair` built via bare `createLair(sandbox)`
 * (same shape `apps/cabinet/src/server.ts`'s production bootstrap fix uses).
 */
async function createLairWithWorkAreaFactories(sandbox: Sandbox) {
  const scratchRoot = await sandbox.root.createDirectory('movement-scratch');
  return createLair(sandbox, createWorkAreaFactoriesForSandbox(sandbox, scratchRoot));
}

describe('CostumeService', () => {
  describe('debugInstallCostume', () => {
    let sandbox: Sandbox;
    let lairRoot: Directory;

    beforeEach(async () => {
      sandbox = createInMemorySandbox();
      lairRoot = sandbox.root;
    });

    it('throws error when source wing name is not provided', async () => {
      const targetWing = await createMockTargetWing(lairRoot, 'target-wing');
      await expect(
        debugInstallCostume(lairRoot, '', 'costumes/test', 'test-costume', targetWing)
      ).rejects.toThrow('Source wing name is required');
    });

    it('throws error when costume path is not provided', async () => {
      const targetWing = await createMockTargetWing(lairRoot, 'target-wing');
      await expect(
        debugInstallCostume(lairRoot, 'wing', '', 'test-costume', targetWing)
      ).rejects.toThrow('Costume path is required');
    });

    it('throws error when installed name is not provided', async () => {
      const targetWing = await createMockTargetWing(lairRoot, 'target-wing');
      await expect(
        debugInstallCostume(lairRoot, 'wing', 'costumes/test', '', targetWing)
      ).rejects.toThrow('Installed name is required');
    });

    it('throws error when costume source does not exist', async () => {
      // Create wings directory but not the costume source
      const wingsDir = await lairRoot.createDirectory('wings');
      await wingsDir.createDirectory('my-wing');

      const targetWing = await createMockTargetWing(lairRoot, 'target-wing');
      await expect(
        debugInstallCostume(lairRoot, 'my-wing', 'costumes/test', 'test-costume', targetWing)
      ).rejects.toThrow('Costume source not found');
    });

    it('creates closet junction to costume source in wing closet', async () => {
      // Create the costume source directory
      await createCostumeSource(lairRoot, 'my-wing', 'costumes/test', {
        files: [{ path: 'test.txt', content: 'test content' }]
      });

      const targetWing = await createMockTargetWing(lairRoot, 'target-wing');
      const result = await debugInstallCostume(
        lairRoot,
        'my-wing',
        'costumes/test',
        'test-costume',
        targetWing
      );

      expect(result.message).toContain('debug-installed');
      expect(result.message).toContain('wing target-wing');
      expect(result.closetLink.kind).toBe('junction');

      // Verify we can read files through the junction
      const fileResult = await result.closetLink.child('test.txt');
      expect(fileResult.found).toBe(true);
      if (fileResult.found && fileResult.node.is('file')) {
        const content = await (fileResult.node as File).read();
        expect(content).toBe('test content');
      }
    });

    it('creates commands junction when missions directory exists', async () => {
      // Create costume source with missions directory
      await createCostumeSource(lairRoot, 'my-wing', 'costumes/test', {
        missions: ['mission']
      });

      const targetWing = await createMockTargetWing(lairRoot, 'target-wing');
      const result = await debugInstallCostume(
        lairRoot,
        'my-wing',
        'costumes/test',
        'test-costume',
        targetWing
      );

      expect(result.commandsLink).toBeDefined();
      expect(result.commandsLink?.kind).toBe('junction');
    });

    it('creates agents junction when disguises directory exists', async () => {
      // Create costume source with disguises directory
      await createCostumeSource(lairRoot, 'my-wing', 'costumes/test', {
        disguises: ['agent']
      });

      const targetWing = await createMockTargetWing(lairRoot, 'target-wing');
      const result = await debugInstallCostume(
        lairRoot,
        'my-wing',
        'costumes/test',
        'test-costume',
        targetWing
      );

      expect(result.agentsLink).toBeDefined();
      expect(result.agentsLink?.kind).toBe('junction');
    });

    it('does not create commands junction when missions directory does not exist', async () => {
      // Create costume source without missions
      await createCostumeSource(lairRoot, 'my-wing', 'costumes/test');

      const targetWing = await createMockTargetWing(lairRoot, 'target-wing');
      const result = await debugInstallCostume(
        lairRoot,
        'my-wing',
        'costumes/test',
        'test-costume',
        targetWing
      );

      expect(result.commandsLink).toBeUndefined();
    });

    it('creates skills junction when skills directory exists', async () => {
      // Create costume source with skills directory
      await createCostumeSource(lairRoot, 'my-wing', 'costumes/test', {
        skills: ['skill']
      });

      const targetWing = await createMockTargetWing(lairRoot, 'target-wing');
      const result = await debugInstallCostume(
        lairRoot,
        'my-wing',
        'costumes/test',
        'test-costume',
        targetWing
      );

      expect(result.skillsLink).toBeDefined();
      expect(result.skillsLink?.kind).toBe('junction');
    });

    it('does not create skills junction when skills directory does not exist', async () => {
      // Create costume source without skills
      await createCostumeSource(lairRoot, 'my-wing', 'costumes/test');

      const targetWing = await createMockTargetWing(lairRoot, 'target-wing');
      const result = await debugInstallCostume(
        lairRoot,
        'my-wing',
        'costumes/test',
        'test-costume',
        targetWing
      );

      expect(result.skillsLink).toBeUndefined();
    });

    describe('wing closet behavior', () => {
      it('installs to wing closet when targetWing provided', async () => {
        // Create lair with wings
        const lair = await createLairWithWorkAreaFactories(sandbox);

        // Set up work repository
        const workDir = await lairRoot.createDirectory('work');
        const repo = await sandbox.initBare(workDir, 'test-repo.git');

        // Initialize repo with a commit
        const tempWorktree = await repo.createWorktree(lairRoot, '_temp', 'main');
        await tempWorktree.createFile('README.md', '# Test');
        await tempWorktree.commitAll('Initial commit');
        await repo.removeWorktree(tempWorktree);

        // Create source wing with costume
        const sourceWing = await lair.createWing('source-wing', {
          workLocal: { repo: 'test-repo', branch: 'main' }
        });
        const sourceWorkLocal = ((await sourceWing.workLocal()) as { exists: true; worktree: Worktree }).worktree;
        const costumesDir = await sourceWorkLocal.createDirectory('costumes');
        const testDir = await costumesDir.createDirectory('test');
        const srcDir = await testDir.createDirectory('src');
        await srcDir.createFile('test.txt', 'test content');
        const missionsDir = await srcDir.createDirectory('missions');
        await missionsDir.createFile('task.md', '# Task');

        // Create target wing
        // A worktree can't share a branch with source-wing's work/local (git
        // rejects checking out the same branch in two worktrees at once).
        const targetWing = await lair.createWing('target-wing', {
          workLocal: { repo: 'test-repo', branch: 'target-main' }
        });

        // Install with targetWing
        const result = await debugInstallCostume(
          lairRoot,
          'source-wing',
          'costumes/test',
          'test-costume',
          targetWing
        );

        // Should install to wing closet
        expect(result.message).toContain('wing target-wing');
        expect(result.closetLink.path).toContain('target-wing');
        expect(result.closetLink.path).toContain('closet/test-costume');

        // Verify wing closet exists at wing root
        const wingClosetResult = await targetWing.root.child('closet');
        expect(wingClosetResult.found).toBe(true);

        // Verify wing .claude links exist in work/local
        const targetWorkLocal = ((await targetWing.workLocal()) as { exists: true; worktree: Worktree }).worktree;
        const wingClaudeResult = await targetWorkLocal.child('.claude');
        expect(wingClaudeResult.found).toBe(true);
      });

      it('creates wing-scoped .claude links when targetWing provided', async () => {
        // Create lair with wings
        const lair = await createLairWithWorkAreaFactories(sandbox);

        // Set up work repository
        const workDir = await lairRoot.createDirectory('work');
        const repo = await sandbox.initBare(workDir, 'test-repo.git');

        // Initialize repo
        const tempWorktree = await repo.createWorktree(lairRoot, '_temp', 'main');
        await tempWorktree.createFile('README.md', '# Test');
        await tempWorktree.commitAll('Initial commit');
        await repo.removeWorktree(tempWorktree);

        // Create source wing with costume (with missions)
        const sourceWing = await lair.createWing('source-wing', {
          workLocal: { repo: 'test-repo', branch: 'main' }
        });
        const sourceWorkLocal = ((await sourceWing.workLocal()) as { exists: true; worktree: Worktree }).worktree;
        const costumesDir = await sourceWorkLocal.createDirectory('costumes');
        const testDir = await costumesDir.createDirectory('test');
        const srcDir = await testDir.createDirectory('src');
        const missionsDir = await srcDir.createDirectory('missions');
        await missionsDir.createFile('mission.md', '# Mission');

        // Create target wing
        // A worktree can't share a branch with source-wing's work/local (git
        // rejects checking out the same branch in two worktrees at once).
        const targetWing = await lair.createWing('target-wing', {
          workLocal: { repo: 'test-repo', branch: 'target-main' }
        });

        // Install with targetWing (debug mode)
        const result = await debugInstallCostume(
          lairRoot,
          'source-wing',
          'costumes/test',
          'test-costume',
          targetWing
        );

        // Verify .claude/commands link exists in wing
        expect(result.commandsLink).toBeDefined();
        const targetWorkLocal = ((await targetWing.workLocal()) as { exists: true; worktree: Worktree }).worktree;
        const commandsResult = await targetWorkLocal.child('.claude/commands/test-costume');
        expect(commandsResult.found).toBe(true);
      });

      it('falls back to wing root for .claude links when work/local does not exist', async () => {
        // Create source wing with costume
        await createCostumeSource(lairRoot, 'source-wing', 'costumes/test', {
          missions: ['mission']
        });

        // Create a mock wing without work/local
        const wingsResult = await lairRoot.child('wings');
        if (!wingsResult.found || !wingsResult.node.is('directory')) {
          throw new Error('Wings dir not found');
        }
        const targetWingDir = await (wingsResult.node as Directory).createDirectory('target-wing');
        const mockWing: Wing = {
          name: 'target-wing',
          root: targetWingDir,
          workLocal: async () => ({ exists: false }),
          workGlobal: async () => ({ exists: false }),
          privateLocal: async () => ({ exists: false }),
          privateGlobal: async () => ({ exists: false }),
        } as unknown as Wing;

        // Should succeed and install .claude to wing root
        const result = await debugInstallCostume(
          lairRoot,
          'source-wing',
          'costumes/test',
          'test-costume',
          mockWing
        );

        expect(result.message).toContain('wing target-wing');
        expect(result.commandsLink).toBeDefined();

        // Verify .claude was created in wing root (not work/local)
        const claudeResult = await targetWingDir.child('.claude');
        expect(claudeResult.found).toBe(true);
      });
    });
  });

  describe('listInstalledCostumes', () => {
    let sandbox: Sandbox;
    let lairRoot: Directory;

    beforeEach(async () => {
      sandbox = createInMemorySandbox();
      lairRoot = sandbox.root;
    });

    it('returns empty array when closet does not exist', async () => {
      const result = await listInstalledCostumes(lairRoot);
      expect(result).toEqual([]);
    });

    it('returns empty array when closet is empty', async () => {
      await lairRoot.createDirectory('closet');
      const result = await listInstalledCostumes(lairRoot);
      expect(result).toEqual([]);
    });

    it('lists debug-installed costume with source info', async () => {
      // Set up wing with costume source
      const srcDir = await createCostumeSource(lairRoot, 'my-wing', 'costumes/test', {
        missions: ['analyze'],
        disguises: ['helper'],
        skills: ['coding']
      });

      // Create a junction in the lair closet pointing to the costume source
      // (simulating what debug install would create)
      const closetDir = await lairRoot.createDirectory('closet');
      await closetDir.createJunction('test-costume', srcDir);

      // List costumes
      const result = await listInstalledCostumes(lairRoot);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('test-costume');
      expect(result[0].isDebugInstalled).toBe(true);
      expect(result[0].debugSourceWing).toBe('my-wing');
      expect(result[0].debugSourcePath).toBe('costumes/test');
      expect(result[0].missions).toEqual(['analyze']);
      expect(result[0].disguises).toEqual(['helper']);
      expect(result[0].skills).toEqual(['coding']);
    });

    it('lists package-installed costume (directory)', async () => {
      // Create a regular directory in closet (simulating package install)
      const closetDir = await lairRoot.createDirectory('closet');
      const costumeDir = await closetDir.createDirectory('pkg-costume');
      const missionsDir = await costumeDir.createDirectory('missions');
      await missionsDir.createFile('task.md', '# Task');

      const result = await listInstalledCostumes(lairRoot);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('pkg-costume');
      expect(result[0].isDebugInstalled).toBe(false);
      expect(result[0].debugSourceWing).toBeUndefined();
      expect(result[0].debugSourcePath).toBeUndefined();
      expect(result[0].missions).toEqual(['task']);
    });

    it('lists production-installed costume (junction to dist/) as not debug', async () => {
      // Create the costume dist directory at wings/<wing>/work/local/<path>/dist
      const wingsDir = await lairRoot.createDirectory('wings');
      const wingDir = await wingsDir.createDirectory('my-wing');
      const workDir = await wingDir.createDirectory('work');
      const localDir = await workDir.createDirectory('local');
      const costumesDir = await localDir.createDirectory('costumes');
      const costumeDir = await costumesDir.createDirectory('test');
      const distDir = await costumeDir.createDirectory('dist');
      const missionsDir = await distDir.createDirectory('missions');
      await missionsDir.createFile('analyze.js', 'export const mission = {}');

      // Create junction pointing to dist/ (production install)
      const closetDir = await lairRoot.createDirectory('closet');
      await closetDir.createJunction('test-costume', distDir);

      const result = await listInstalledCostumes(lairRoot);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('test-costume');
      expect(result[0].isDebugInstalled).toBe(false);
      expect(result[0].debugSourceWing).toBeUndefined();
      expect(result[0].debugSourcePath).toBeUndefined();
      expect(result[0].missions).toEqual(['analyze']);
    });

    it('lists multiple costumes', async () => {
      // Create closet with two costumes
      const closetDir = await lairRoot.createDirectory('closet');

      const costume1 = await closetDir.createDirectory('costume-a');
      const missions1 = await costume1.createDirectory('missions');
      await missions1.createFile('m1.md', '');

      const costume2 = await closetDir.createDirectory('costume-b');
      const disguises2 = await costume2.createDirectory('disguises');
      await disguises2.createFile('d1.md', '');

      const result = await listInstalledCostumes(lairRoot);

      expect(result).toHaveLength(2);
      expect(result.map(c => c.name).sort()).toEqual(['costume-a', 'costume-b']);
    });

    it('handles costume with no contents', async () => {
      const closetDir = await lairRoot.createDirectory('closet');
      await closetDir.createDirectory('empty-costume');

      const result = await listInstalledCostumes(lairRoot);

      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('empty-costume');
      expect(result[0].missions).toEqual([]);
      expect(result[0].disguises).toEqual([]);
      expect(result[0].skills).toEqual([]);
    });
  });
});

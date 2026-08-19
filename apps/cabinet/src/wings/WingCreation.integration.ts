import { beforeEach, describe, expect, it } from 'vitest';
import { WingManager } from './WingManager.js';
import {
  createInMemorySandbox,
  createLair,
  type Sandbox,
  type Lair,
  type BareRepository,
} from '@minions/file-store';

describe('WingManager - Creation Validation', () => {
  let sandbox: Sandbox;
  let lair: Lair;
  let manager: WingManager;

  /**
   * Helper to set up a lair with work repos and private repos for testing wing creation.
   * Creates bare repositories with initial commits needed for worktrees.
   */
  async function setupLairWithRepos(): Promise<{
    suiteRepo: BareRepository;
    privateLocalRepo: BareRepository;
    privateGlobalRepo: BareRepository;
  }> {
    // Create work directory with suite repo
    const workDir = await sandbox.root.createDirectory('work');
    const suiteRepo = await sandbox.initBare(workDir, 'suite.git');

    // Create initial commit in suite repo via a worktree
    const tempDir = await sandbox.root.createDirectory('temp-init');
    const tempWorktree = await suiteRepo.createWorktree(tempDir, 'init', 'main');
    await tempWorktree.createFile('README.md', '# Test');
    await tempWorktree.commitAll('Initial commit');
    await suiteRepo.removeWorktree(tempWorktree);
    await tempDir.delete(true);

    // Create private repos
    const privateDir = await sandbox.root.createDirectory('private');
    const privateLocalRepo = await sandbox.initBare(privateDir, 'local');
    const privateGlobalRepo = await sandbox.initBare(privateDir, 'global');

    // Initialize private/local with a commit
    const privateTempDir = await sandbox.root.createDirectory('temp-private');
    const privateLocalWorktree = await privateLocalRepo.createWorktree(privateTempDir, 'init', 'main');
    await privateLocalWorktree.createFile('README.md', '# Private');
    await privateLocalWorktree.commitAll('Initial commit');
    await privateLocalRepo.removeWorktree(privateLocalWorktree);
    await privateTempDir.delete(true);

    // Initialize private/global with a commit
    const privateGlobalTempDir = await sandbox.root.createDirectory('temp-private-global');
    const privateGlobalWorktree = await privateGlobalRepo.createWorktree(privateGlobalTempDir, 'init', 'main');
    await privateGlobalWorktree.createFile('README.md', '# Private Global');
    await privateGlobalWorktree.commitAll('Initial commit');
    await privateGlobalRepo.removeWorktree(privateGlobalWorktree);
    await privateGlobalTempDir.delete(true);

    // Create info directory (required for info links)
    const infoDir = await sandbox.root.createDirectory('info');
    await infoDir.createFile('test.txt', 'test');

    // Create wings directory
    await sandbox.root.createDirectory('wings');

    // Create closet directory
    await sandbox.root.createDirectory('closet');

    // Create .claude directory with CLAUDE.md
    const claudeDir = await sandbox.root.createDirectory('.claude');
    await claudeDir.createFile('CLAUDE.md', '# Test Lair CLAUDE.md');

    return { suiteRepo, privateLocalRepo, privateGlobalRepo };
  }

  beforeEach(async () => {
    sandbox = createInMemorySandbox();
    lair = createLair(sandbox);
    // Lair name is derived from sandbox root ("sandbox" by default)
    manager = new WingManager(lair, 3434);
  });

  it('creates wing with work/local as worktree', async () => {
    await setupLairWithRepos();

    await manager.createWing({
      name: 'test-wing',
      workLocalRepo: 'suite',
      workLocalBranch: 'l/test-lair/w/test-wing'
    });

    // Verify wing exists and has work/local
    const wingResult = await lair.wing('test-wing');
    expect(wingResult.exists).toBe(true);

    if (wingResult.exists) {
      const workLocalResult = await wingResult.wing.workLocal();
      expect(workLocalResult.exists).toBe(true);
      if (workLocalResult.exists) {
        expect(workLocalResult.worktree.kind).toBe('worktree');
        expect(workLocalResult.worktree.branch).toBe('l/test-lair/w/test-wing');
      }
    }
  });

  it('copies .claude directory from lair', async () => {
    await setupLairWithRepos();

    await manager.createWing({
      name: 'test-wing',
      workLocalRepo: 'suite',
      workLocalBranch: 'l/test-lair/w/test-wing'
    });

    // Verify .claude directory was copied
    const wingResult = await lair.wing('test-wing');
    expect(wingResult.exists).toBe(true);

    if (wingResult.exists) {
      const claudeResult = await wingResult.wing.root.child('.claude');
      expect(claudeResult.found).toBe(true);
      if (claudeResult.found && claudeResult.node.kind === 'directory') {
        const dirNode = claudeResult.node as import('@minions/file-store').Directory;
        const claudeMdResult = await dirNode.child('CLAUDE.md');
        expect(claudeMdResult.found).toBe(true);
        if (claudeMdResult.found && claudeMdResult.node.kind === 'file') {
          const content = await (claudeMdResult.node as import('@minions/file-store').File).read();
          expect(content).toContain('# Test Lair CLAUDE.md');
        }
      }
    }
  });

  it('creates private/local as worktree on wing-specific branch', async () => {
    await setupLairWithRepos();

    await manager.createWing({
      name: 'test-wing',
      workLocalRepo: 'suite',
      workLocalBranch: 'l/test-lair/w/test-wing'
    });

    // Verify private/local worktree
    const wingResult = await lair.wing('test-wing');
    expect(wingResult.exists).toBe(true);

    if (wingResult.exists) {
      const privateLocalResult = await wingResult.wing.privateLocal();
      expect(privateLocalResult.exists).toBe(true);
      if (privateLocalResult.exists) {
        expect(privateLocalResult.worktree.kind).toBe('worktree');
        expect(privateLocalResult.worktree.branch).toBe('l/sandbox/w/test-wing/local');
      }
    }
  });

  it('creates private/global as worktree on wing-specific branch', async () => {
    await setupLairWithRepos();

    await manager.createWing({
      name: 'test-wing',
      workLocalRepo: 'suite',
      workLocalBranch: 'l/test-lair/w/test-wing'
    });

    // Verify private/global worktree
    const wingResult = await lair.wing('test-wing');
    expect(wingResult.exists).toBe(true);

    if (wingResult.exists) {
      const privateGlobalResult = await wingResult.wing.privateGlobal();
      expect(privateGlobalResult.exists).toBe(true);
      if (privateGlobalResult.exists) {
        expect(privateGlobalResult.worktree.kind).toBe('worktree');
        expect(privateGlobalResult.worktree.branch).toBe('l/sandbox/w/test-wing/global');
      }
    }
  });

  it('creates info junction to lair info', async () => {
    await setupLairWithRepos();

    await manager.createWing({
      name: 'test-wing',
      workLocalRepo: 'suite',
      workLocalBranch: 'l/test-lair/w/test-wing'
    });

    // Verify info junction
    const wingResult = await lair.wing('test-wing');
    expect(wingResult.exists).toBe(true);

    if (wingResult.exists) {
      const infoJunction = await wingResult.wing.info();
      expect(infoJunction.kind).toBe('junction');

      // Verify we can read through the junction
      const testFileResult = await infoJunction.child('test.txt');
      expect(testFileResult.found).toBe(true);
      if (testFileResult.found && testFileResult.node.is('file')) {
        const content = await (testFileResult.node as import('@minions/file-store').File).read();
        expect(content).toBe('test');
      }
    }
  });

  it('creates CLAUDE.md file with wing info', async () => {
    await setupLairWithRepos();

    await manager.createWing({
      name: 'planning-wing',
      workLocalRepo: 'suite',
      workLocalBranch: 'l/test-lair/w/planning-wing'
    });

    // Verify CLAUDE.md content
    const wingResult = await lair.wing('planning-wing');
    expect(wingResult.exists).toBe(true);

    if (wingResult.exists) {
      const claudeMdFile = await wingResult.wing.claudeMd();
      const content = await claudeMdFile.read();

      // Verify content includes CLAUDE.md header
      expect(content).toContain('# CLAUDE.md');

      // Verify it includes movement branch
      expect(content).toContain('l/sandbox/w/planning-wing');

      // Verify it includes key sections
      expect(content).toContain('## Directory Structure');
      expect(content).toContain('## Git Workflow');
      expect(content).toContain('### Working in Steps');

      // Verify it points to work/local/CLAUDE.md for repo-specific guidance
      expect(content).toContain('work/local/CLAUDE.md');

      // Verify it does NOT mention raw lair root path
      expect(content).not.toContain('lair root');
    }
  });

  it('creates expected wing structure', async () => {
    await setupLairWithRepos();

    await manager.createWing({
      name: 'test-wing',
      workLocalRepo: 'suite',
      workLocalBranch: 'l/test-lair/w/test-wing'
    });

    // Verify complete structure via Wing API
    const wingResult = await lair.wing('test-wing');
    expect(wingResult.exists).toBe(true);

    if (wingResult.exists) {
      const wing = wingResult.wing;

      // Check .claude directory
      const claudeDirResult = await wing.root.child('.claude');
      expect(claudeDirResult.found).toBe(true);

      // Check CLAUDE.md
      const claudeMd = await wing.claudeMd();
      expect(claudeMd.kind).toBe('file');

      // Check work/local worktree
      const workLocalResult = await wing.workLocal();
      expect(workLocalResult.exists).toBe(true);

      // Check private/local worktree
      const privateLocalResult = await wing.privateLocal();
      expect(privateLocalResult.exists).toBe(true);

      // Check private/global worktree
      const privateGlobalResult = await wing.privateGlobal();
      expect(privateGlobalResult.exists).toBe(true);

      // Check info junction
      const infoJunction = await wing.info();
      expect(infoJunction.kind).toBe('junction');

      // Check closet junction
      const closetJunction = await wing.closet();
      expect(closetJunction.kind).toBe('junction');
    }
  });
});

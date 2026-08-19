import { describe, it, expect, beforeEach } from 'vitest';
import {
  createWing,
  deleteWing,
  readWingClaudeMd,
  writeWingClaudeMd,
  reprovisionWingHooks,
} from './WingService.js';
import { WingManager, CreateWingOptions } from './WingManager.js';
import {
  createInMemorySandbox,
  createLair,
  type Sandbox,
  type Directory,
  type Wing,
  type WorktreeResult,
  type NamedWorkResult,
  type BareRepository,
  type Worktree,
  type Junction,
  type File,
  type WorkArea,
  type CheckedOutMovement,
} from '@minions/file-store';

/**
 * Create a mock file-store Wing for testing
 */
function createMockWing(options: {
  name: string;
  rootPath: string;
  workLocalPath?: string;
  workGlobalPath?: string;
  privateLocalPath?: string;
  privateGlobalPath?: string;
  infoPath?: string;
  workLocalUrl?: string | null;
  workGlobalUrl?: string | null;
}): Wing {
  const mockBareRepo = (url: string | null): BareRepository => ({
    kind: 'bare-repository',
    name: 'repo.git',
    path: '/repo.git',
    url,
  } as BareRepository);

  const mockWorktreeResult = (path: string | undefined, url: string | null | undefined): WorktreeResult => {
    if (!path) {
      return { exists: false } as WorktreeResult;
    }
    return {
      exists: true,
      worktree: {
        kind: 'worktree',
        name: path.split('/').pop() || '',
        path,
        branch: 'main',
        repository: mockBareRepo(url ?? null),
      } as Worktree
    } as WorktreeResult;
  };

  // Minimal `WorkArea` mock — `WingService.ts`'s `wingToInfo` resolves
  // workLocal/workGlobal/privateGlobal via `workAreaLocal()`/`workAreaGlobal()`/
  // `privateWorkAreaGlobal()` (design doc §4.2), so this mock `Wing` needs
  // those too — same reasoning as `lairStateService.test.ts`'s identical
  // helper.
  const mockWorkArea = (path: string | undefined, url: string | null | undefined): (() => Promise<WorkArea>) => {
    return async () => {
      if (!path) {
        throw new Error('no worktree set up');
      }
      return {
        repo: mockBareRepo(url ?? null),
        activeMovement: async () => ({ files: { path } } as unknown as CheckedOutMovement),
        beginNewActiveMovement: async () => { throw new Error('Not implemented'); },
      } as WorkArea;
    };
  };

  return {
    name: options.name,
    root: {
      kind: 'directory',
      name: options.name,
      path: options.rootPath,
    } as Directory,
    workLocal: async () => mockWorktreeResult(options.workLocalPath, options.workLocalUrl),
    workGlobal: async () => mockWorktreeResult(options.workGlobalPath, options.workGlobalUrl),
    privateLocal: async () => mockWorktreeResult(options.privateLocalPath, null),
    privateGlobal: async () => mockWorktreeResult(options.privateGlobalPath, null),
    workAreaLocal: mockWorkArea(options.workLocalPath, options.workLocalUrl),
    workAreaGlobal: mockWorkArea(options.workGlobalPath, options.workGlobalUrl),
    privateWorkAreaGlobal: mockWorkArea(options.privateGlobalPath, null),
    info: async () => ({
      kind: 'junction',
      name: 'info',
      path: options.infoPath || '',
    } as Junction),
    workNamed: async () => ({ exists: false } as NamedWorkResult),
    namedWorkNames: async () => [] as string[],
    addWorkNamed: async () => { throw new Error('Not implemented'); },
    removeWorkNamed: async (_name: string) => { return; },
  } as unknown as Wing;
}

/**
 * Helper to create a test WingManager with mocked methods.
 * Uses in-memory sandbox to satisfy the Lair dependency.
 * Lair name is derived from sandbox root directory name ("sandbox" by default).
 */
function createTestWingManager(): WingManager {
  const sandbox = createInMemorySandbox();
  const lair = createLair(sandbox);
  return new WingManager(lair, 3434);
}

describe('WingService', () => {
  describe('createWing', () => {
    it('creates a wing and returns wing info', async () => {
      const wingManager = createTestWingManager();

      // Mock createWing to return a test Wing
      wingManager.createWing = async () => createMockWing({
        name: 'test-wing',
        rootPath: '/test/root/wings/test-wing',
        workLocalPath: '/test/root/wings/test-wing/work/local',
        workGlobalPath: '/test/root/wings/test-wing/work/global',
        privateLocalPath: '/test/root/wings/test-wing/private/local',
        privateGlobalPath: '/test/root/wings/test-wing/private/global',
        infoPath: '/test/root/wings/test-wing/info',
        workLocalUrl: 'https://github.com/test/test-repo.git',
      });

      const result = await createWing(
        wingManager,
        'test-wing',
        'test-repo'
      );

      // Verify result structure
      expect(result).toHaveProperty('message');
      expect(result).toHaveProperty('wing');
      expect(result.wing.name).toBe('test-wing');
      expect(result.wing.repositories.workLocal).toBe('https://github.com/test/test-repo.git');
      expect(result.message).toContain('created successfully');
    });

    it('computes branch name using lair name and wing name', async () => {
      const wingManager = createTestWingManager();

      let capturedOptions: CreateWingOptions | null = null;
      wingManager.createWing = async (options) => {
        capturedOptions = options;
        return createMockWing({
          name: options.name,
          rootPath: '/test/root/wings/test-wing',
          workLocalPath: '/test/root/wings/test-wing/work/local',
        });
      };

      await createWing(wingManager, 'my-wing', 'test-repo');

      // Lair name is "sandbox" from the in-memory sandbox root
      expect((capturedOptions as CreateWingOptions | null)?.workLocalBranch).toBe('l/sandbox/w/my-wing');
    });

    it('throws error when wing manager is not initialized', async () => {
      await expect(
        createWing(null as unknown as WingManager, 'test-wing', 'test-repo')
      ).rejects.toThrow('Wing manager not initialized');
    });
  });

  describe('deleteWing', () => {
    it('deletes a wing and returns confirmation', async () => {
      const wingManager = createTestWingManager();

      let deletedWingName: string | null = null;
      wingManager.deleteWing = async (name: string) => {
        deletedWingName = name;
      };

      const result = await deleteWing(wingManager, 'test-wing');

      expect(deletedWingName).toBe('test-wing');
      expect(result.message).toContain('deleted successfully');
      expect(result.deletedWing).toBe('test-wing');
    });

    it('throws error when wing manager is not initialized', async () => {
      await expect(
        deleteWing(null as unknown as WingManager, 'test-wing')
      ).rejects.toThrow('Wing manager not initialized');
    });

    it('throws error when wing name is not provided', async () => {
      const wingManager = createTestWingManager();

      await expect(
        deleteWing(wingManager, '')
      ).rejects.toThrow('Wing name is required');
    });
  });

  describe('readWingClaudeMd', () => {
    let sandbox: Sandbox;
    let wingsDir: Directory;

    beforeEach(async () => {
      sandbox = createInMemorySandbox();
      wingsDir = await sandbox.root.createDirectory('wings');
    });

    it('reads CLAUDE.md from wing directory', async () => {
      const wing = await wingsDir.createDirectory('test-wing');
      await wing.createFile('CLAUDE.md', '# Test Wing Instructions');

      const content = await readWingClaudeMd(wingsDir, 'test-wing');
      expect(content).toBe('# Test Wing Instructions');
    });

    it('throws error when wings directory is not initialized', async () => {
      await expect(
        readWingClaudeMd(null as unknown as Directory, 'test-wing')
      ).rejects.toThrow('Wings directory not initialized');
    });

    it('throws error when wing name is not provided', async () => {
      await expect(
        readWingClaudeMd(wingsDir, '')
      ).rejects.toThrow('Wing name is required');
    });

    it('throws error when wing does not exist', async () => {
      await expect(
        readWingClaudeMd(wingsDir, 'nonexistent')
      ).rejects.toThrow('Wing not found: nonexistent');
    });

    it('throws error when CLAUDE.md does not exist', async () => {
      await wingsDir.createDirectory('empty-wing');

      await expect(
        readWingClaudeMd(wingsDir, 'empty-wing')
      ).rejects.toThrow('CLAUDE.md not found for wing: empty-wing');
    });
  });

  describe('writeWingClaudeMd', () => {
    let sandbox: Sandbox;
    let wingsDir: Directory;

    beforeEach(async () => {
      sandbox = createInMemorySandbox();
      wingsDir = await sandbox.root.createDirectory('wings');
    });

    it('writes CLAUDE.md to existing wing directory', async () => {
      const wing = await wingsDir.createDirectory('test-wing');
      await wing.createFile('CLAUDE.md', 'old content');

      const result = await writeWingClaudeMd(wingsDir, 'test-wing', 'new content');
      expect(result).toContain('updated successfully');

      const claudeMdResult = await wing.child('CLAUDE.md');
      expect(claudeMdResult.found).toBe(true);
      if (claudeMdResult.found && claudeMdResult.node.is('file')) {
        const content = await (claudeMdResult.node as File).read();
        expect(content).toBe('new content');
      }
    });

    it('creates CLAUDE.md if it does not exist', async () => {
      await wingsDir.createDirectory('new-wing');

      const result = await writeWingClaudeMd(wingsDir, 'new-wing', '# New Instructions');
      expect(result).toContain('updated successfully');

      const wingResult = await wingsDir.child('new-wing');
      expect(wingResult.found).toBe(true);
      if (wingResult.found && wingResult.node.is('directory')) {
        const claudeMdResult = await (wingResult.node as Directory).child('CLAUDE.md');
        expect(claudeMdResult.found).toBe(true);
        if (claudeMdResult.found && claudeMdResult.node.is('file')) {
          const content = await (claudeMdResult.node as File).read();
          expect(content).toBe('# New Instructions');
        }
      }
    });

    it('throws error when wings directory is not initialized', async () => {
      await expect(
        writeWingClaudeMd(null as unknown as Directory, 'test-wing', 'content')
      ).rejects.toThrow('Wings directory not initialized');
    });

    it('throws error when wing name is not provided', async () => {
      await expect(
        writeWingClaudeMd(wingsDir, '', 'content')
      ).rejects.toThrow('Wing name and content are required');
    });

    it('throws error when content is undefined', async () => {
      await expect(
        writeWingClaudeMd(wingsDir, 'test-wing', undefined as unknown as string)
      ).rejects.toThrow('Wing name and content are required');
    });

    it('throws error when wing does not exist', async () => {
      await expect(
        writeWingClaudeMd(wingsDir, 'nonexistent', 'content')
      ).rejects.toThrow('Wing not found: nonexistent');
    });
  });

  describe('reprovisionWingHooks', () => {
    it('calls reprovisionHooks on the wing manager', async () => {
      const wingManager = createTestWingManager();
      let reprovisionCalled = false;
      let capturedWingName: string | undefined;
      wingManager.reprovisionHooks = async (name?: string) => {
        reprovisionCalled = true;
        capturedWingName = name;
      };

      const result = await reprovisionWingHooks(wingManager, 'my-wing');

      expect(reprovisionCalled).toBe(true);
      expect(capturedWingName).toBe('my-wing');
      expect(result.message).toContain('my-wing');
      expect(result.wings).toContain('my-wing');
    });

    it('reprovisions all wings when no wing name provided', async () => {
      const wingManager = createTestWingManager();
      wingManager.reprovisionHooks = async () => { /* no-op: simulate reprovisioning all wings */ };

      const result = await reprovisionWingHooks(wingManager);

      expect(result.wings).toEqual([]);
      expect(result.message).toContain('0 wing(s)');
    });

    it('throws error when wing manager not initialized', async () => {
      await expect(
        reprovisionWingHooks(null as unknown as WingManager)
      ).rejects.toThrow('Wing manager not initialized');
    });
  });
});

import { describe, it, expect } from 'vitest';
import { getLairState } from './lairStateService.js';
import { WingManager } from '../wings/WingManager.js';
import {
  createInMemorySandbox,
  createLair,
  type Wing,
  type WorktreeResult,
  type NamedWorkResult,
  type BareRepository,
  type Worktree,
  type Junction,
  type Directory,
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

  // Minimal `WorkArea` mock — `lairStateService.ts`'s `workLocal`/`workGlobal`/
  // `privateGlobal` fields resolve via `workAreaLocal()`/`workAreaGlobal()`/
  // `privateWorkAreaGlobal()` (design doc §4.2), so this mock `Wing` needs to
  // implement those too — otherwise calling the missing method would throw a
  // generic `TypeError`, which `resolveWorkAreaPathAndGitInfo`'s catch-all
  // would (correctly) treat identically to "not set up", silently masking
  // the mock's intended path/url from every assertion.
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
      children: async () => [],
    } as unknown as Junction),
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

describe('getLairState', () => {
  it('returns lair state with lair name, wings, and available repos', async () => {
    const wingManager = createTestWingManager();

    // Mock the methods we need
    wingManager.getWings = () => [
      createMockWing({
        name: 'test-wing',
        rootPath: '/test/root/test-wing',
        workLocalPath: '/test/root/test-wing/work/local',
        workGlobalPath: '/test/root/test-wing/work/global',
        privateLocalPath: '/test/root/test-wing/private/local',
        privateGlobalPath: '/test/root/test-wing/private/global',
        infoPath: '/test/root/test-wing/info',
        workLocalUrl: 'https://github.com/repo.local',
      })
    ];

    wingManager.getAvailableWorkRepos = async () => ['repo1', 'repo2'];

    const state = await getLairState(wingManager);

    // Lair name derived from sandbox root ("sandbox")
    expect(state.lairName).toBe('sandbox');
    expect(state.wings.length).toBe(1);
    expect(state.availableWorkRepos.length).toBe(2);
    expect(state.wings[0].name).toBe('test-wing');
    expect(state.wings[0].worktreeGitInfo).toBeDefined();
    expect(Array.isArray(state.wings[0].infoRepos)).toBe(true);
  });

  it('includes all wing paths and git information', async () => {
    const wingManager = createTestWingManager();

    const mockWing = createMockWing({
      name: 'test-wing',
      rootPath: '/test/root/test-wing',
      workLocalPath: '/path/to/work/local',
      workGlobalPath: '/path/to/work/global',
      privateLocalPath: '/path/to/private/local',
      privateGlobalPath: '/path/to/private/global',
      infoPath: '/path/to/info',
      workLocalUrl: 'local-repo',
      workGlobalUrl: 'global-repo',
    });

    wingManager.getWings = () => [mockWing];
    wingManager.getAvailableWorkRepos = async () => [];

    const state = await getLairState(wingManager);
    const wing = state.wings[0];

    expect(wing.workLocal).toBe('/path/to/work/local');
    expect(wing.workGlobal).toBe('/path/to/work/global');
    expect(wing.privateLocal).toBe('/path/to/private/local');
    expect(wing.privateGlobal).toBe('/path/to/private/global');
    expect(wing.info).toBe('/path/to/info');

    // Check that worktreeGitInfo structure exists
    expect(wing.worktreeGitInfo).toBeDefined();
    expect(wing.worktreeGitInfo.workLocal).toBeDefined();
    expect(wing.worktreeGitInfo.workGlobal).toBeDefined();
    expect(wing.worktreeGitInfo.privateLocal).toBeDefined();
    expect(wing.worktreeGitInfo.privateGlobal).toBeDefined();

    // Check that infoRepos is an array
    expect(Array.isArray(wing.infoRepos)).toBe(true);
  });
});

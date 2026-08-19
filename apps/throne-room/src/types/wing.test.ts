import { describe, it, expectTypeOf } from 'vitest';
import type { Wing, WorktreeGitInfo, InfoRepo } from './wing';

describe('Wing types', () => {
  it('Wing interface has required properties', () => {
    expectTypeOf<Wing>().toHaveProperty('name');
    expectTypeOf<Wing>().toHaveProperty('root');
  });

  it('Wing interface has optional properties', () => {
    expectTypeOf<Wing>().toHaveProperty('workLocal');
    expectTypeOf<Wing>().toHaveProperty('workGlobal');
    expectTypeOf<Wing>().toHaveProperty('privateLocal');
    expectTypeOf<Wing>().toHaveProperty('privateGlobal');
    expectTypeOf<Wing>().toHaveProperty('info');
    expectTypeOf<Wing>().toHaveProperty('worktreeGitInfo');
    expectTypeOf<Wing>().toHaveProperty('infoRepos');
  });

  it('WorktreeGitInfo interface has expected properties', () => {
    expectTypeOf<WorktreeGitInfo>().toHaveProperty('bareRepoDir');
    expectTypeOf<WorktreeGitInfo>().toHaveProperty('origin');
  });

  it('InfoRepo interface has expected properties', () => {
    expectTypeOf<InfoRepo>().toHaveProperty('name');
    expectTypeOf<InfoRepo>().toHaveProperty('origin');
  });

  it('accepts valid Wing objects', () => {
    const minimalWing: Wing = {
      name: 'test-wing',
      root: '/path/to/wing',
    };
    expectTypeOf(minimalWing).toMatchTypeOf<Wing>();

    const fullWing: Wing = {
      name: 'test-wing',
      root: '/path/to/wing',
      workLocal: '/path/to/work/local',
      workGlobal: '/path/to/work/global',
      privateLocal: '/path/to/private/local',
      privateGlobal: '/path/to/private/global',
      info: '/path/to/info',
      worktreeGitInfo: {
        workLocal: { bareRepoDir: '/bare', origin: 'https://example.com/repo' },
        workGlobal: null,
        privateLocal: { bareRepoDir: null, origin: null },
        privateGlobal: null,
      },
      infoRepos: [
        { name: 'docs', origin: 'https://example.com/docs' },
      ],
    };
    expectTypeOf(fullWing).toMatchTypeOf<Wing>();
  });
});

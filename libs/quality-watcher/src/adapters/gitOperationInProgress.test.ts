import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isGitOperationInProgress, getGitOperationStatus } from './gitOperationInProgress.js';

let tmpDir: string;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
});

function makePlainRepo(): string {
  tmpDir = mkdtempSync(join(tmpdir(), 'git-op-in-progress-'));
  mkdirSync(join(tmpDir, '.git'), { recursive: true });
  return tmpDir;
}

function makeLinkedWorktree(): { cwd: string; gitDir: string } {
  tmpDir = mkdtempSync(join(tmpdir(), 'git-op-in-progress-'));
  const gitDir = join(tmpDir, 'bare.git', 'worktrees', 'wt');
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(join(tmpDir, '.git'), `gitdir: ${gitDir}\n`);
  return { cwd: tmpDir, gitDir };
}

describe('isGitOperationInProgress', () => {
  it('reports false for a repo with no operation in progress', async () => {
    const cwd = makePlainRepo();
    expect(await isGitOperationInProgress(cwd)).toBe(false);
  });

  it('reports false for a cwd that has no .git at all', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'git-op-in-progress-'));
    expect(await isGitOperationInProgress(tmpDir)).toBe(false);
  });

  it('detects an interactive rebase in progress via rebase-merge', async () => {
    const cwd = makePlainRepo();
    mkdirSync(join(cwd, '.git', 'rebase-merge'));
    expect(await isGitOperationInProgress(cwd)).toBe(true);
  });

  it('detects a non-interactive rebase in progress via rebase-apply', async () => {
    const cwd = makePlainRepo();
    mkdirSync(join(cwd, '.git', 'rebase-apply'));
    expect(await isGitOperationInProgress(cwd)).toBe(true);
  });

  it('detects an in-progress merge via MERGE_HEAD', async () => {
    const cwd = makePlainRepo();
    writeFileSync(join(cwd, '.git', 'MERGE_HEAD'), 'abc123\n');
    expect(await isGitOperationInProgress(cwd)).toBe(true);
  });

  it('detects an in-progress cherry-pick via CHERRY_PICK_HEAD', async () => {
    const cwd = makePlainRepo();
    writeFileSync(join(cwd, '.git', 'CHERRY_PICK_HEAD'), 'abc123\n');
    expect(await isGitOperationInProgress(cwd)).toBe(true);
  });

  it('detects an in-progress revert via REVERT_HEAD', async () => {
    const cwd = makePlainRepo();
    writeFileSync(join(cwd, '.git', 'REVERT_HEAD'), 'abc123\n');
    expect(await isGitOperationInProgress(cwd)).toBe(true);
  });

  it('resolves a linked worktree\'s own gitdir (not the bare repo root) and detects its rebase state', async () => {
    const { cwd, gitDir } = makeLinkedWorktree();
    mkdirSync(join(gitDir, 'rebase-merge'));

    expect(await isGitOperationInProgress(cwd)).toBe(true);
  });

  it('does not report a linked worktree as in-progress just because a sibling worktree is rebasing', async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'git-op-in-progress-'));
    const bareRoot = join(tmpDir, 'bare.git');
    const gitDirA = join(bareRoot, 'worktrees', 'a');
    const gitDirB = join(bareRoot, 'worktrees', 'b');
    mkdirSync(gitDirA, { recursive: true });
    mkdirSync(gitDirB, { recursive: true });
    mkdirSync(join(gitDirA, 'rebase-merge'));
    const cwdA = join(tmpDir, 'a');
    const cwdB = join(tmpDir, 'b');
    mkdirSync(cwdA);
    mkdirSync(cwdB);
    writeFileSync(join(cwdA, '.git'), `gitdir: ${gitDirA}\n`);
    writeFileSync(join(cwdB, '.git'), `gitdir: ${gitDirB}\n`);

    expect(await isGitOperationInProgress(cwdA)).toBe(true);
    expect(await isGitOperationInProgress(cwdB)).toBe(false);
  });
});

describe('getGitOperationStatus', () => {
  it('reports not in progress, stable, when nothing is happening', async () => {
    const cwd = makePlainRepo();
    expect(await getGitOperationStatus(cwd)).toEqual({ inProgress: false, stable: true });
  });

  it('reports in progress, NOT stable, for a rebase-merge with no stopped-sha yet (actively churning through commits)', async () => {
    const cwd = makePlainRepo();
    mkdirSync(join(cwd, '.git', 'rebase-merge'));
    expect(await getGitOperationStatus(cwd)).toEqual({ inProgress: true, stable: false });
  });

  it('reports in progress, stable, once rebase-merge has a stopped-sha (a real halt — conflict or empty-patch confirmation)', async () => {
    const cwd = makePlainRepo();
    mkdirSync(join(cwd, '.git', 'rebase-merge'));
    writeFileSync(join(cwd, '.git', 'rebase-merge', 'stopped-sha'), 'abc123\n');
    expect(await getGitOperationStatus(cwd)).toEqual({ inProgress: true, stable: true });
  });

  it('treats a plain merge conflict (MERGE_HEAD) as stable the instant it appears — this codebase never drives it through multiple automatic steps', async () => {
    const cwd = makePlainRepo();
    writeFileSync(join(cwd, '.git', 'MERGE_HEAD'), 'abc123\n');
    expect(await getGitOperationStatus(cwd)).toEqual({ inProgress: true, stable: true });
  });

  it('treats rebase-apply, CHERRY_PICK_HEAD, and REVERT_HEAD as stable the instant they appear, same as MERGE_HEAD', async () => {
    for (const marker of ['rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
      const cwd = makePlainRepo();
      if (marker === 'rebase-apply') {
        mkdirSync(join(cwd, '.git', marker));
      } else {
        writeFileSync(join(cwd, '.git', marker), 'abc123\n');
      }
      expect(await getGitOperationStatus(cwd)).toEqual({ inProgress: true, stable: true });
    }
  });

  it('resolves a linked worktree\'s own gitdir, same as isGitOperationInProgress', async () => {
    const { cwd, gitDir } = makeLinkedWorktree();
    mkdirSync(join(gitDir, 'rebase-merge'));
    expect(await getGitOperationStatus(cwd)).toEqual({ inProgress: true, stable: false });
  });
});

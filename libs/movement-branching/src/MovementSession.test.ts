import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createInMemorySandbox,
  createWorkArea,
  createInMemoryWorkAreaFactories,
  type Sandbox,
  type Worktree,
  type WorkArea,
} from '@minions/file-store';
import { MovementSession } from './MovementSession.js';

describe('MovementSession', () => {
  let sandbox: Sandbox;
  let worktree: Worktree;
  let workArea: WorkArea;
  let session: MovementSession;

  beforeEach(async () => {
    sandbox = createInMemorySandbox();
    const repo = await sandbox.initBare(sandbox.root, 'test-repo');
    worktree = await repo.createWorktree(sandbox.root, 'work', 'main');

    // Create initial commit on main
    await worktree.createFile('README.md', '# Test Project\n');
    await worktree.commitAll('Initial commit');

    // Create and checkout movement branch
    await worktree.switchBranch('l/test/w/workshop');

    // `status()`/`diff()` need a `WorkArea` to build a `Movement` handle
    // (`Movement.commitsSince()`/`diffFrom()`) — same pattern as the
    // `merge` describe block below.
    workArea = createWorkArea(worktree.repository, worktree, createInMemoryWorkAreaFactories());
    session = new MovementSession(worktree, undefined, undefined, undefined, undefined, workArea);
  });

  describe('status', () => {
    it('returns branch info and movement status', async () => {
      const status = await session.status();

      expect(status.branch).toBe('l/test/w/workshop');
      expect(status.isMovementBranch).toBe(true);
      expect(status.isDirty).toBe(false);
      expect(status.modifiedFiles).toEqual([]);
    });

    it('reports non-movement branch', async () => {
      await worktree.switchBranch('main');

      const status = await session.status();

      expect(status.isMovementBranch).toBe(false);
    });

    it('tracks modified files', async () => {
      session.recordFileEdit('src/foo.ts');
      session.recordFileEdit('src/bar.ts');

      const status = await session.status();

      expect(status.modifiedFiles).toEqual(['src/foo.ts', 'src/bar.ts']);
    });
  });

  describe('diff', () => {
    it('returns the diff between the base branch and HEAD', async () => {
      // `diff()` now delegates to `Movement.diffFrom()` (design doc §4.1),
      // which routes through the movement's base `Trunk`'s own tool
      // worktree rather than this session's `Worktree` directly — so this
      // asserts on the resulting diff content, not which git plumbing
      // methods got called under the hood.
      await worktree.createFile('file.txt', 'added line\n');
      await worktree.commitAll('. f Add file');

      const result = await session.diff();

      expect(result.diff).toContain('file.txt');
      expect(result.diff).toContain('+added line');
    });
  });

  describe('recordFileEdit', () => {
    it('tracks edited files', async () => {
      session.recordFileEdit('src/test.ts');

      const status = await session.status();
      expect(status.modifiedFiles).toContain('src/test.ts');
    });
  });

  describe('addRiskFactor', () => {
    it('increases commit risk', async () => {
      await worktree.createFile('src/test.ts', 'export const test = 1;\n');
      session.recordFileEdit('src/test.ts');
      session.addRiskFactor('risky', 'Breaking API change');

      const result = await session.commit({
        type: 'feature',
        summary: 'Add breaking change',
        testsRan: true,
        testsPassed: true,
        isComprehensive: true,
      });

      expect(result.success).toBe(true);
      expect(result.commitHash).toBeDefined();
    });
  });

  describe('commit', () => {
    it('commits with risk notation', async () => {
      await worktree.createFile('src/test.ts', 'export const test = 1;\n');
      session.recordFileEdit('src/test.ts');

      const result = await session.commit({
        type: 'feature',
        summary: 'Add user auth',
        testsRan: false,
        testsPassed: false,
      });

      expect(result.success).toBe(true);
      expect(result.commitHash).toBeDefined();
    });

    it('includes a risk explanation for a risky (@) commit', async () => {
      await worktree.createFile('src/app.ts', 'export const app = 1;\n');
      session.recordFileEdit('src/app.ts');

      const result = await session.commit({
        type: 'feature',
        summary: 'Add feature with no tests',
        testsRan: false,
        testsPassed: false,
      });

      expect(result.risk?.code).toBe('@');
      expect(result.risk?.explanation).toBeDefined();
      expect(result.risk?.explanation).toContain('Next time');
    });

    it('omits the risk explanation for a provable (.) commit', async () => {
      await worktree.createFile('README.md', '# Test Project\nFixed typo\n');
      session.recordFileEdit('README.md');

      const result = await session.commit({
        type: 'docs',
        summary: 'Fix typo',
        testsRan: false,
        testsPassed: false,
      });

      expect(result.risk?.code).toBe('.');
      expect(result.risk?.explanation).toBeUndefined();
    });

    it('omits the risk explanation when a manual risk factor escalates the code with no tracked file edits — never surfaces "No changes" or a "Manual:" reasoning trace', async () => {
      // A real, uncommitted change makes the worktree dirty, but no
      // recordFileEdit call — the automated assessment sees zero changed
      // files ("No changes", Provable) and has nothing suggestable; a manual
      // factor (e.g. tool-log analysis) is what pushes the code up.
      await worktree.createFile('untracked-by-session.txt', 'change\n');
      session.addRiskFactor('risky', 'Tool log analysis');

      const result = await session.commit({
        type: 'feature',
        summary: 'Add feature',
        testsRan: false,
        testsPassed: false,
      });

      expect(result.risk?.code).toBe('@');
      expect(result.risk?.explanation).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain('No changes');
      expect(JSON.stringify(result)).not.toContain('Manual:');
    });

    it('pushes via CheckedOutMovement.push() (design doc §4.3), not the raw Worktree.forcePush(), when a WorkArea is available', async () => {
      await worktree.createFile('src/pushed.ts', 'export const pushed = 1;\n');
      session.recordFileEdit('src/pushed.ts');

      // `activeMovement()` returns a fresh, cheap handle each call (design
      // doc §4.1) — intercept just the `push` method on whatever handle
      // MovementSession's post-commit push resolves, via a Proxy so every
      // other method keeps its normal `this`-bound behavior.
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
      const forcePushSpy = vi.spyOn(worktree, 'forcePush');

      const result = await session.commit({
        type: 'feature',
        summary: 'Add pushed file',
        testsRan: false,
        testsPassed: false,
      });

      expect(result.success).toBe(true);
      expect(pushSpy).toHaveBeenCalledTimes(1);
      expect(forcePushSpy).not.toHaveBeenCalled();
    });

    it('returns idempotent success (noop) when nothing to commit', async () => {
      const result = await session.commit({
        type: 'feature',
        summary: 'Nothing changed',
        testsRan: true,
        testsPassed: true,
      });

      expect(result.success).toBe(true);
    });

    it('supports all type values', async () => {
      const intentions = ['feature', 'bug', 'refactor', 'test', 'docs', 'chore', 'plan'] as const;

      for (let i = 0; i < intentions.length; i++) {
        await worktree.createFile(`file${i}.ts`, `export const file${i} = ${i};\n`);
        session.recordFileEdit(`file${i}.ts`);

        const result = await session.commit({
          type: intentions[i],
          summary: 'Test',
          testsRan: false,
          testsPassed: false,
        });

        expect(result.commitHash).toBeDefined();
      }
    });

    it('surfaces a warning when the reasoning log fails to write, without failing the commit', async () => {
      const tmpDir = mkdtempSync(join(tmpdir(), 'movement-reasoning-'));
      const blockingFile = join(tmpDir, 'blocked-by-a-file');
      writeFileSync(blockingFile, 'not a directory');
      // Path treats a file as a directory segment — mkdir(recursive) must fail.
      const badReasoningPath = join(blockingFile, 'reasoning.md');

      try {
        const loggingSession = new MovementSession(worktree, undefined, badReasoningPath);
        await worktree.createFile('src/test.ts', 'export const test = 1;\n');
        loggingSession.recordFileEdit('src/test.ts');

        const result = await loggingSession.commit({
          type: 'feature',
          summary: 'Add user auth',
          testsRan: false,
          testsPassed: false,
        });

        expect(result.success).toBe(true);
        expect(result.reasoningLogWarning).toContain(badReasoningPath);
        expect(existsSync(badReasoningPath)).toBe(false);
      } finally {
        rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    it('does not set a reasoning warning when no reasoning log path is configured', async () => {
      await worktree.createFile('src/test.ts', 'export const test = 1;\n');
      session.recordFileEdit('src/test.ts');

      const result = await session.commit({
        type: 'feature',
        summary: 'Add user auth',
        testsRan: false,
        testsPassed: false,
      });

      expect(result.reasoningLogWarning).toBeUndefined();
    });
  });

  describe('merge', () => {
    // `merge()` now delegates to `MovementManager.mergeMovement()`, which
    // requires a design doc §4.2 `WorkArea` — the top-level `workArea`
    // (now built in this file's outer `beforeEach` for `status`/`diff`) is
    // reused here rather than redeclared.
    let mergeSession: MovementSession;

    beforeEach(() => {
      mergeSession = new MovementSession(worktree, undefined, undefined, undefined, undefined, workArea);
    });

    it('merges movement to main without checking out main', async () => {
      // The movement branch has a commit beyond main, so the merge proceeds.
      await worktree.createFile('feature.ts', 'export const feature = true;\n');
      await worktree.commitAll('. f Add feature');

      const switchBranchSpy = vi.spyOn(worktree, 'switchBranch');

      const result = await mergeSession.merge({
        type: 'feat',
        summary: 'Add authentication',
        description: 'Implements JWT-based auth',
      });

      expect(result.success).toBe(true);
      // main is moved by name — never checked out.
      expect(switchBranchSpy).not.toHaveBeenCalledWith('main');
      // The worktree stayed on the movement branch, and the feature landed
      // on main (via a fresh worktree, never this one).
      expect(await worktree.currentBranch()).toBe('l/test/w/workshop');
      const mainWt = await worktree.repository.createWorktree(sandbox.root, 'verify-main', 'main');
      expect((await mainWt.child('feature.ts')).found).toBe(true);
    });

    it('no-ops with success when the movement adds no commits', async () => {
      // No commits beyond main — nothing to merge.
      const result = await mergeSession.merge({
        type: 'feat',
        summary: 'Nothing new',
        description: 'No commits beyond main',
      });

      expect(result.success).toBe(true);
    });

    it('returns error when not on movement branch', async () => {
      await worktree.switchBranch('main');

      const result = await mergeSession.merge({
        type: 'feat',
        summary: 'Test',
        description: 'Test',
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('Not on a movement branch');
    });
  });

  describe('reasoning log integration', () => {
    let tmpDir: string;
    let reasoningPath: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'movement-session-'));
      reasoningPath = join(tmpDir, 'sub', 'reasoning.md');
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('writes a reasoning log entry on successful commit', async () => {
      const s = new MovementSession(worktree, undefined, reasoningPath);
      await worktree.createFile('src/app.ts', 'export const app = 1;\n');
      s.recordFileEdit('src/app.ts');

      await s.commit({ type: 'feature', summary: 'Add thing', testsRan: true, testsPassed: true });

      const content = readFileSync(reasoningPath, 'utf-8');
      expect(content).toContain('### Agent Input');
      expect(content).toContain('- type: feature');
      expect(content).toContain('- summary: Add thing');
    });

    it('writes a reasoning log entry for a noop commit (nothing to commit is success, not failure)', async () => {
      const s = new MovementSession(worktree, undefined, reasoningPath);

      await s.commit({ type: 'feature', summary: 'Nothing', testsRan: false, testsPassed: false });

      const content = readFileSync(reasoningPath, 'utf-8');
      expect(content).not.toContain('**Failed**');
      expect(content).toContain('### Final Commit');
    });

    it('includes tool entries in the log when tool log path also provided', async () => {
      const logPath = join(tmpDir, 'tool-log.jsonl');
      writeFileSync(logPath, JSON.stringify({ timestamp: Date.now(), tool: 'Edit', filePath: 'src/app.ts' }) + '\n');
      const s = new MovementSession(worktree, logPath, reasoningPath);
      await worktree.createFile('src/app.ts', 'export const app = 1;\n');

      await s.commit({ type: 'feature', summary: 'Add thing', testsRan: false, testsPassed: false });

      const content = readFileSync(reasoningPath, 'utf-8');
      expect(content).toContain('| Edit | src/app.ts |');
    });

    it('does not write reasoning log when no path provided', async () => {
      await worktree.createFile('src/app.ts', 'export const app = 1;\n');
      session.recordFileEdit('src/app.ts');
      await session.commit({ type: 'feature', summary: 'Test', testsRan: false, testsPassed: false });

      // no reasoningPath set on session — no file should appear
      expect(existsSync(reasoningPath)).toBe(false);
    });
  });

  describe('tool log integration', () => {
    let tmpDir: string;
    let logPath: string;

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'movement-session-'));
      logPath = join(tmpDir, 'tool-log.jsonl');
    });

    afterEach(() => {
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it('includes toolLog analysis in commit result when log path provided', async () => {
      writeFileSync(logPath, JSON.stringify({ timestamp: Date.now(), tool: 'Edit', filePath: 'src/app.ts' }) + '\n');
      const s = new MovementSession(worktree, logPath);
      await worktree.createFile('src/app.ts', 'export const app = 1;\n');

      const result = await s.commit({ type: 'feature', summary: 'Test', testsRan: false, testsPassed: false });

      expect(result.toolLog).toBeDefined();
      if (!result.toolLog) throw new Error('expected toolLog to be defined');
      expect(result.toolLog.entriesRead).toBe(1);
    });

    it('works normally without tool log path', async () => {
      await worktree.createFile('src/app.ts', 'export const app = 1;\n');
      session.recordFileEdit('src/app.ts');
      const result = await session.commit({ type: 'feature', summary: 'Test', testsRan: false, testsPassed: false });

      expect(result.success).toBe(true);
      expect(result.toolLog).toBeUndefined();
    });

    it('works normally when log file does not exist', async () => {
      // file doesn't exist — session should fall back to agent type
      await worktree.createFile('src/app.ts', 'export const app = 1;\n');
      session.recordFileEdit('src/app.ts');

      const result = await session.commit({ type: 'feature', summary: 'Test', testsRan: false, testsPassed: false });

      expect(result.success).toBe(true);
    });

    it('clears the log file after a successful commit', async () => {
      writeFileSync(logPath, JSON.stringify({ timestamp: Date.now(), tool: 'Edit', filePath: 'src/app.ts' }) + '\n');
      const s = new MovementSession(worktree, logPath);
      await worktree.createFile('src/app.ts', 'export const app = 1;\n');

      await s.commit({ type: 'feature', summary: 'Test', testsRan: false, testsPassed: false });

      expect(existsSync(logPath)).toBe(true);
      expect(readFileSync(logPath, 'utf8')).toBe('');
    });

    it('uses merged intention in commit message when multiple detected', async () => {
      // Agent says "test" but log shows code edits → multiple (code conflicts with test-only intent)
      writeFileSync(logPath, [
        JSON.stringify({ timestamp: 2000, tool: 'Edit', filePath: 'src/app.ts' }),
      ].join('\n') + '\n');
      const s = new MovementSession(worktree, logPath);
      const commitAllSpy = vi.spyOn(worktree, 'commitAll');
      await worktree.createFile('src/app.ts', 'export const app = 1;\n');

      const result = await s.commit({ type: 'test', summary: 'Test', testsRan: false, testsPassed: false });

      const lastCall = commitAllSpy.mock.calls.at(-1);
      if (!lastCall) throw new Error('expected commitAll to have been called');
      const message = lastCall[0] as string;
      expect(message).toMatch(/\? /); // unknown/multiple intention code
      expect(result.toolLog?.mismatchNote).toContain('"test"');
      expect(result.toolLog?.mismatchNote).toContain('code');
    });

    it('does not set a mismatch note when merged intention matches the declared type', async () => {
      writeFileSync(logPath, JSON.stringify({ timestamp: Date.now(), tool: 'Edit', filePath: 'README.md' }) + '\n');
      const s = new MovementSession(worktree, logPath);
      await worktree.createFile('README.md', '# Test Project\nUpdated\n');

      const result = await s.commit({ type: 'docs', summary: 'Test', testsRan: false, testsPassed: false });

      expect(result.toolLog?.mismatchNote).toBeUndefined();
    });

    it('keeps agent intention when analyzer returns not_classified', async () => {
      // Only read tools in log — no file edits
      writeFileSync(logPath, JSON.stringify({ timestamp: Date.now(), tool: 'Read' }) + '\n');
      const s = new MovementSession(worktree, logPath);
      const commitAllSpy = vi.spyOn(worktree, 'commitAll');
      await worktree.createFile('src/app.ts', 'export const app = 1;\n');
      s.recordFileEdit('src/app.ts');

      await s.commit({ type: 'feature', summary: 'Test', testsRan: false, testsPassed: false });

      const lastCall = commitAllSpy.mock.calls.at(-1);
      if (!lastCall) throw new Error('expected commitAll to have been called');
      const message = lastCall[0] as string;
      expect(message).toMatch(/ f /); // feature intention code
    });
  });

  describe('state persistence', () => {
    it('exports and imports state', async () => {
      session.recordFileEdit('src/foo.ts');
      session.addRiskFactor('covered', 'Needs review');

      const state = session.exportState();

      // Create new session and import
      const newSession = new MovementSession(worktree, undefined, undefined, undefined, undefined, workArea);
      newSession.importState(state);

      const status = await newSession.status();
      expect(status.modifiedFiles).toContain('src/foo.ts');
    });
  });
});

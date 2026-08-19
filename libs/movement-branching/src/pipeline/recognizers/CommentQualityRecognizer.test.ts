import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemorySandbox, type Sandbox, type Worktree } from '@minions/file-store';
import { CommentQualityRecognizer } from './CommentQualityRecognizer.js';
import { FileClassifierDetector } from '../detectors/FileClassifierDetector.js';
import { MOVEMENT_COMMIT_HOOK_POINT } from '../types.js';
import type { PipelineContext, TextChange } from '../types.js';
import { ToolTracker } from '../../risk/ToolTracker.js';

describe('CommentQualityRecognizer', () => {
  let sandbox: Sandbox;
  let worktree: Worktree;
  let toolTracker: ToolTracker;

  beforeEach(async () => {
    sandbox = createInMemorySandbox();
    const repo = await sandbox.initBare(sandbox.root, 'test-repo');
    worktree = await repo.createWorktree(sandbox.root, 'work', 'main');
    toolTracker = new ToolTracker();
  });

  async function contextFor(file: string): Promise<{ ctx: PipelineContext; evidence: Awaited<ReturnType<FileClassifierDetector['detect']>> }> {
    toolTracker.recordTool('Edit', { file });
    const ctx: PipelineContext = {
      hookPointId: MOVEMENT_COMMIT_HOOK_POINT.id,
      worktree,
      toolTracker,
      changedFiles: toolTracker.getEditedFiles(),
      testsRan: false,
      testsPassed: false,
      manualRiskFactors: [],
    };
    const evidence = await new FileClassifierDetector().detect(ctx, []);
    return { ctx, evidence };
  }

  it('proposes stripping a comment that only restates the next line', async () => {
    await worktree.createFile('src/widget.ts', '// increment counter\ncounter++;\n');
    const { ctx, evidence } = await contextFor('src/widget.ts');

    const verdict = await new CommentQualityRecognizer().recognize(ctx, evidence);
    const textChanges = verdict.changes.filter((c): c is TextChange => c.kind === 'text');
    expect(textChanges).toHaveLength(1);
    expect(textChanges[0].value.file).toBe('src/widget.ts');

    const advice = verdict.changes.find((c) => c.kind === 'advice');
    expect(advice).toBeDefined();
  });

  it('keeps a comment carrying a non-obvious rationale', async () => {
    await worktree.createFile(
      'src/widget.ts',
      '// workaround for upstream bug #123 — remove once fixed\ncounter++;\n',
    );
    const { ctx, evidence } = await contextFor('src/widget.ts');

    const verdict = await new CommentQualityRecognizer().recognize(ctx, evidence);
    expect(verdict.changes.filter((c) => c.kind === 'text')).toHaveLength(0);
  });

  it('ignores non-code files even if a comment-like line restates its neighbor', async () => {
    await worktree.createFile('README.md', '// increment counter\ncounter++;\n');
    const { ctx, evidence } = await contextFor('README.md');

    const verdict = await new CommentQualityRecognizer().recognize(ctx, evidence);
    expect(verdict.changes.filter((c) => c.kind === 'text')).toHaveLength(0);
  });
});

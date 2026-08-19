import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemorySandbox, type Sandbox, type Worktree } from '@minions/file-store';
import { runCommitPipeline } from './runCommitPipeline.js';
import { PipelineRegistry } from './CommitPipelineRegistry.js';
import { createDefaultCommitPipelineRegistry } from './defaultRegistry.js';
import { MOVEMENT_COMMIT_HOOK_POINT } from './types.js';
import type { Detector, PipelineContext, Recognizer } from './types.js';
import { ToolTracker } from '../risk/ToolTracker.js';
import { RiskCode } from '../risk/RiskComputer.js';

async function makeContext(worktree: Worktree, toolTracker: ToolTracker, overrides: Partial<PipelineContext> = {}): Promise<PipelineContext> {
  return {
    hookPointId: MOVEMENT_COMMIT_HOOK_POINT.id,
    worktree,
    toolTracker,
    changedFiles: toolTracker.getEditedFiles(),
    testsRan: false,
    testsPassed: false,
    manualRiskFactors: [],
    ...overrides,
  };
}

describe('runCommitPipeline', () => {
  let sandbox: Sandbox;
  let worktree: Worktree;
  let toolTracker: ToolTracker;

  beforeEach(async () => {
    sandbox = createInMemorySandbox();
    const repo = await sandbox.initBare(sandbox.root, 'test-repo');
    worktree = await repo.createWorktree(sandbox.root, 'work', 'main');
    await worktree.createFile('README.md', '# Test');
    await worktree.commitAll('initial');
    toolTracker = new ToolTracker();
  });

  it('produces a risk assessment using only the default registry — no product code touched to register it', async () => {
    const readmeResult = await worktree.child('README.md');
    if (readmeResult.found && readmeResult.node.kind === 'file') {
      await readmeResult.node.write('# Updated');
    }
    toolTracker.recordTool('Edit', { file: 'README.md' });

    const ctx = await makeContext(worktree, toolTracker);
    const outcome = await runCommitPipeline(ctx, createDefaultCommitPipelineRegistry());

    expect(outcome.riskAssessment?.code).toBe(RiskCode.Provable);
    expect(outcome.accept).toBe(true);
  });

  it('a new check registers against movement.commit without editing pipeline core', async () => {
    const readmeResult = await worktree.child('README.md');
    if (readmeResult.found && readmeResult.node.kind === 'file') {
      await readmeResult.node.write('# Updated');
    }
    toolTracker.recordTool('Edit', { file: 'README.md' });

    const trivialRecognizer: Recognizer = {
      id: 'throwaway-recognizer',
      kind: 'deterministic',
      async recognize() {
        return { changes: [{ kind: 'advice', value: { message: 'hello from a new check', priority: 1 }, producer: 'throwaway-recognizer' }] };
      },
    };

    const registry = createDefaultCommitPipelineRegistry().extend({
      handler: trivialRecognizer,
      hookPoints: [MOVEMENT_COMMIT_HOOK_POINT.id],
      mandatory: false,
    });

    const ctx = await makeContext(worktree, toolTracker);
    const outcome = await runCommitPipeline(ctx, registry);

    expect(outcome.advice).toContain('hello from a new check');
  });

  it('degrades a throwing recognizer to an advice entry naming it — commit still proceeds', async () => {
    const readmeResult = await worktree.child('README.md');
    if (readmeResult.found && readmeResult.node.kind === 'file') {
      await readmeResult.node.write('# Updated');
    }
    toolTracker.recordTool('Edit', { file: 'README.md' });

    const brokenRecognizer: Recognizer = {
      id: 'broken-recognizer',
      kind: 'deterministic',
      async recognize() {
        throw new Error('boom');
      },
    };

    const registry = createDefaultCommitPipelineRegistry().extend({
      handler: brokenRecognizer,
      hookPoints: [MOVEMENT_COMMIT_HOOK_POINT.id],
      mandatory: false,
    });

    const ctx = await makeContext(worktree, toolTracker);
    const outcome = await runCommitPipeline(ctx, registry);

    expect(outcome.accept).toBe(true);
    expect(outcome.brokenHandlers).toContain('broken-recognizer');
    expect(outcome.advice.some((a) => a.includes('broken-recognizer'))).toBe(true);
  });

  it('a broken detector also degrades to advice rather than blocking the commit', async () => {
    const readmeResult = await worktree.child('README.md');
    if (readmeResult.found && readmeResult.node.kind === 'file') {
      await readmeResult.node.write('# Updated');
    }
    toolTracker.recordTool('Edit', { file: 'README.md' });

    const brokenDetector: Detector = {
      id: 'broken-detector',
      async detect() {
        throw new Error('boom');
      },
    };

    const registry = new PipelineRegistry();
    registry.registerDetector(brokenDetector, { hookPoints: [MOVEMENT_COMMIT_HOOK_POINT.id], mandatory: false });

    const ctx = await makeContext(worktree, toolTracker);
    const outcome = await runCommitPipeline(ctx, registry);

    expect(outcome.accept).toBe(true);
    expect(outcome.brokenHandlers).toContain('broken-detector');
  });

  it('runs independent detectors concurrently rather than stacking their latencies', async () => {
    const HANDLER_DELAY_MS = 150;
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const slowDetectorA: Detector = {
      id: 'slow-detector-a',
      async detect() {
        await delay(HANDLER_DELAY_MS);
        return [];
      },
    };
    const slowDetectorB: Detector = {
      id: 'slow-detector-b',
      async detect() {
        await delay(HANDLER_DELAY_MS);
        return [];
      },
    };

    const registry = new PipelineRegistry();
    registry.registerDetector(slowDetectorA, { hookPoints: [MOVEMENT_COMMIT_HOOK_POINT.id], mandatory: false });
    registry.registerDetector(slowDetectorB, { hookPoints: [MOVEMENT_COMMIT_HOOK_POINT.id], mandatory: false });

    const ctx = await makeContext(worktree, toolTracker);
    const start = performance.now();
    await runCommitPipeline(ctx, registry);
    const elapsed = performance.now() - start;

    // Two detectors run one after another would take ~2x the delay; running
    // concurrently takes ~1x. Generous margin for CI jitter — this is a
    // "didn't regress to serial" check, not a tight timing assertion.
    expect(elapsed).toBeLessThan(HANDLER_DELAY_MS * 1.8);
  });

  it('runs independent recognizers within the same tier concurrently rather than stacking their latencies', async () => {
    const HANDLER_DELAY_MS = 150;
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    const slowRecognizerA: Recognizer = {
      id: 'slow-recognizer-a',
      kind: 'deterministic',
      async recognize() {
        await delay(HANDLER_DELAY_MS);
        return { changes: [] };
      },
    };
    const slowRecognizerB: Recognizer = {
      id: 'slow-recognizer-b',
      kind: 'deterministic',
      async recognize() {
        await delay(HANDLER_DELAY_MS);
        return { changes: [] };
      },
    };

    const registry = new PipelineRegistry();
    registry.registerRecognizer(slowRecognizerA, { hookPoints: [MOVEMENT_COMMIT_HOOK_POINT.id], mandatory: false });
    registry.registerRecognizer(slowRecognizerB, { hookPoints: [MOVEMENT_COMMIT_HOOK_POINT.id], mandatory: false });

    const ctx = await makeContext(worktree, toolTracker);
    const start = performance.now();
    await runCommitPipeline(ctx, registry);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(HANDLER_DELAY_MS * 1.8);
  });
});

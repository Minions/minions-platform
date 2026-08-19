import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemorySandbox, type Sandbox, type Worktree } from '@minions/file-store';
import { MockQualityWatcher, SignalType } from '@minions/quality-watcher';
import { QualitySignalReader } from './QualitySignalReader.js';
import { MOVEMENT_COMMIT_HOOK_POINT } from '../types.js';
import type { PipelineContext } from '../types.js';
import { ToolTracker } from '../../risk/ToolTracker.js';

describe('QualitySignalReader', () => {
  let sandbox: Sandbox;
  let worktree: Worktree;
  let toolTracker: ToolTracker;

  beforeEach(async () => {
    sandbox = createInMemorySandbox();
    const repo = await sandbox.initBare(sandbox.root, 'test-repo');
    worktree = await repo.createWorktree(sandbox.root, 'work', 'main');
    toolTracker = new ToolTracker();
  });

  function baseContext(overrides: Partial<PipelineContext> = {}): PipelineContext {
    return {
      hookPointId: MOVEMENT_COMMIT_HOOK_POINT.id,
      worktree,
      toolTracker,
      changedFiles: [],
      testsRan: false,
      testsPassed: false,
      manualRiskFactors: [],
      ...overrides,
    };
  }

  it('emits no evidence when no quality watcher is available', async () => {
    const evidence = await new QualitySignalReader().detect(baseContext(), []);
    expect(evidence).toEqual([]);
  });

  it('emits signal-state evidence for tests/types/lint/build from the watcher', async () => {
    const watcher = new MockQualityWatcher('test-wing');
    const now = new Date();
    watcher.setStatus({
      [SignalType.Tests]: { state: 'pass', timestamp: now },
      [SignalType.Types]: { state: 'pass', timestamp: now },
      [SignalType.Build]: { state: 'pass', timestamp: now },
      [SignalType.OxLint]: { state: 'pass', timestamp: now },
      [SignalType.CustomLint]: { state: 'fail', timestamp: now, failures: ['unused import'] },
      aggregatedAt: now,
      isPartial: false,
    });

    const evidence = await new QualitySignalReader().detect(baseContext({ qualityWatcher: watcher }), []);

    expect(evidence).toEqual([
      {
        producer: 'quality-signal-reader',
        kind: 'signal-state',
        payload: {
          tests: { state: 'pass', timestamp: now },
          types: { state: 'pass', timestamp: now },
          build: { state: 'pass', timestamp: now },
          lint: { state: 'fail', timestamp: now, failures: ['[customLint] unused import'] },
        },
      },
    ]);
  });
});

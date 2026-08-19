import { describe, it, expect, beforeEach } from 'vitest';
import { createInMemorySandbox, type Sandbox, type Worktree } from '@minions/file-store';
import { RiskAnnotationRecognizer } from './RiskAnnotationRecognizer.js';
import { MOVEMENT_COMMIT_HOOK_POINT } from '../types.js';
import type { Evidence, PipelineContext, RiskChange } from '../types.js';
import type { SignalStateEvidencePayload } from '../detectors/QualitySignalReader.js';
import { ToolTracker } from '../../risk/ToolTracker.js';
import { RiskCode } from '../../risk/RiskComputer.js';

describe('RiskAnnotationRecognizer', () => {
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
      changedFiles: toolTracker.getEditedFiles(),
      testsRan: false,
      testsPassed: false,
      manualRiskFactors: [],
      ...overrides,
    };
  }

  function signalStateEvidence(payload: SignalStateEvidencePayload): Evidence[] {
    return [{ producer: 'quality-signal-reader', kind: 'signal-state', payload }];
  }

  const now = new Date();
  const pass = { state: 'pass' as const, timestamp: now };
  const fail = { state: 'fail' as const, timestamp: now, failures: ['boom'] };

  it('with no signal-state evidence, behaves exactly like the tool-log heuristic alone', async () => {
    await worktree.createFile('src/widget.ts', 'export const x = 1;\n');
    toolTracker.recordTool('Edit', { file: 'src/widget.ts' });

    const verdict = await new RiskAnnotationRecognizer().recognize(baseContext(), []);
    const risk = verdict.changes.find((c): c is RiskChange => c.kind === 'risk');

    expect(risk?.value.code).toBe(RiskCode.Risky);
    expect(risk?.value.reason).toBe('No test coverage');
  });

  it('a live lint failure escalates risk even when no lint tool call was logged this session', async () => {
    await worktree.createFile('README.md', '# Updated\n');
    toolTracker.recordTool('Edit', { file: 'README.md' });

    const evidence = signalStateEvidence({ tests: pass, types: pass, build: pass, lint: fail });
    const verdict = await new RiskAnnotationRecognizer().recognize(baseContext(), evidence);
    const risk = verdict.changes.find((c): c is RiskChange => c.kind === 'risk');

    // Docs-only would normally be Provable — a live lint failure must still surface.
    expect(risk?.value.code).toBe(RiskCode.Risky);
    expect(risk?.value.manualFactors.some((f) => f.reason.includes('Live lint signal'))).toBe(true);
  });

  it('a live build failure escalates risk even when no build tool call was logged this session', async () => {
    await worktree.createFile('README.md', '# Updated\n');
    toolTracker.recordTool('Edit', { file: 'README.md' });

    const evidence = signalStateEvidence({ tests: pass, types: pass, build: fail, lint: pass });
    const verdict = await new RiskAnnotationRecognizer().recognize(baseContext(), evidence);
    const risk = verdict.changes.find((c): c is RiskChange => c.kind === 'risk');

    expect(risk?.value.code).toBe(RiskCode.Risky);
    expect(risk?.value.manualFactors.some((f) => f.reason.includes('Live build signal'))).toBe(true);
  });

  it('a live tests-pass signal can reach a better classification than the heuristic alone, even when testsRan was not declared', async () => {
    await worktree.createFile('src/widget.ts', 'export const x = 1;\n');
    await worktree.createFile('src/widget.test.ts', 'test("x", () => {});\n');
    toolTracker.recordTool('Edit', { file: 'src/widget.ts' });
    toolTracker.recordTool('Edit', { file: 'src/widget.test.ts' });

    const withoutSignal = await new RiskAnnotationRecognizer().recognize(baseContext(), []);
    const riskWithout = withoutSignal.changes.find((c): c is RiskChange => c.kind === 'risk');
    expect(riskWithout?.value.code).toBe(RiskCode.Risky);
    expect(riskWithout?.value.reason).toBe('Tests did not run');

    const evidence = signalStateEvidence({ tests: pass, types: pass, build: pass, lint: pass });
    const withSignal = await new RiskAnnotationRecognizer().recognize(baseContext(), evidence);
    const riskWith = withSignal.changes.find((c): c is RiskChange => c.kind === 'risk');

    expect(riskWith?.value.code).not.toBe(RiskCode.Risky);
  });
});

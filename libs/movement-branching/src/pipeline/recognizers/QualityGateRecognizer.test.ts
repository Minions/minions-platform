import { describe, it, expect } from 'vitest';
import { QualityGateRecognizer, evaluateQualitySignals } from './QualityGateRecognizer.js';
import { MOVEMENT_COMMIT_HOOK_POINT } from '../types.js';
import type { Evidence, PipelineContext, OutcomeChange, AdviceChange } from '../types.js';
import type { SignalStateEvidencePayload } from '../detectors/QualitySignalReader.js';
import { ToolTracker } from '../../risk/ToolTracker.js';

describe('QualityGateRecognizer', () => {
  function baseContext(): PipelineContext {
    return {
      hookPointId: MOVEMENT_COMMIT_HOOK_POINT.id,
      worktree: undefined as never,
      toolTracker: new ToolTracker(),
      changedFiles: [],
      testsRan: false,
      testsPassed: false,
      manualRiskFactors: [],
    };
  }

  function signalStateEvidence(payload: SignalStateEvidencePayload): Evidence[] {
    return [{ producer: 'quality-signal-reader', kind: 'signal-state', payload }];
  }

  const now = new Date();
  const pass = { state: 'pass' as const, timestamp: now };
  const running = { state: 'running' as const, timestamp: now, failures: [] as string[] };
  const pending = { state: 'pending' as const, timestamp: now };
  const failWith = (failures: string[]) => ({ state: 'fail' as const, timestamp: now, failures });
  const staleSince = new Date(now.getTime() - 10 * 60 * 1000);
  const staleWith = (message: string) => ({ state: 'stale' as const, timestamp: now, staleSince, message });

  it('proposes nothing when there is no signal-state evidence at all', async () => {
    const verdict = await new QualityGateRecognizer().recognize(baseContext(), []);
    expect(verdict.changes).toEqual([]);
  });

  it('proposes nothing when every signal passes', async () => {
    const evidence = signalStateEvidence({ tests: pass, types: pass, build: pass, lint: pass });
    const verdict = await new QualityGateRecognizer().recognize(baseContext(), evidence);
    expect(verdict.changes).toEqual([]);
  });

  it('does not block on running or pending signals — only a settled failure', async () => {
    const evidence = signalStateEvidence({ tests: running, types: pending, build: pass, lint: pass });
    const verdict = await new QualityGateRecognizer().recognize(baseContext(), evidence);
    expect(verdict.changes).toEqual([]);
  });

  it('rejects the commit when tests/types/build report fail, naming the quality watcher and the failures', async () => {
    const evidence = signalStateEvidence({
      tests: pass,
      types: pass,
      build: failWith(['TS build error']),
      lint: pass,
    });
    const verdict = await new QualityGateRecognizer().recognize(baseContext(), evidence);

    expect(verdict.changes).toHaveLength(1);
    const outcome = verdict.changes[0] as OutcomeChange;
    expect(outcome.kind).toBe('outcome');
    expect(outcome.value.accept).toBe(false);
    expect(outcome.value.reason).toContain('quality watcher');
    expect(outcome.value.reason).toContain('mcp__cabinet__quality_status');
    expect(outcome.value.reason).toContain('Build:');
    expect(outcome.value.reason).toContain('TS build error');
  });

  it('reports every failing blocking signal, not just the first', async () => {
    const evidence = signalStateEvidence({
      tests: failWith(['test "x" failed']),
      types: pass,
      build: failWith(['TS error']),
      lint: pass,
    });
    const verdict = await new QualityGateRecognizer().recognize(baseContext(), evidence);
    const outcome = verdict.changes[0] as OutcomeChange;

    expect(outcome.value.reason).toContain('Tests:');
    expect(outcome.value.reason).toContain('test "x" failed');
    expect(outcome.value.reason).toContain('Build:');
    expect(outcome.value.reason).toContain('TS error');
  });

  it('blocks on a lint failure by default, same as tests/types/build', async () => {
    const evidence = signalStateEvidence({
      tests: pass,
      types: pass,
      build: pass,
      lint: failWith(['src/widget.ts:3 unused variable']),
    });
    const verdict = await new QualityGateRecognizer().recognize(baseContext(), evidence);

    expect(verdict.changes).toHaveLength(1);
    const outcome = verdict.changes[0] as OutcomeChange;
    expect(outcome.kind).toBe('outcome');
    expect(outcome.value.accept).toBe(false);
    expect(outcome.value.reason).toContain('Lint:');
    expect(outcome.value.reason).toContain('src/widget.ts:3 unused variable');
  });

  it('does not block on a lint failure when allowLintErrors is true — reports it as advice instead', async () => {
    const evidence = signalStateEvidence({
      tests: pass,
      types: pass,
      build: pass,
      lint: failWith(['src/widget.ts:3 unused variable']),
    });
    const verdict = await new QualityGateRecognizer().recognize({ ...baseContext(), allowLintErrors: true }, evidence);

    expect(verdict.changes).toHaveLength(1);
    const advice = verdict.changes[0] as AdviceChange;
    expect(advice.kind).toBe('advice');
    expect(advice.value.message).toContain('Lint is failing');
    expect(advice.value.message).toContain('src/widget.ts:3 unused variable');
  });

  it('caps lint advice at the top 5 failures and notes how many more there are, when allowLintErrors is true', async () => {
    const failures = Array.from({ length: 8 }, (_, i) => `src/file${i}.ts: issue ${i}`);
    const evidence = signalStateEvidence({ tests: pass, types: pass, build: pass, lint: failWith(failures) });
    const verdict = await new QualityGateRecognizer().recognize({ ...baseContext(), allowLintErrors: true }, evidence);

    const advice = verdict.changes[0] as AdviceChange;
    for (const failure of failures.slice(0, 5)) {
      expect(advice.value.message).toContain(failure);
    }
    for (const failure of failures.slice(5)) {
      expect(advice.value.message).not.toContain(failure);
    }
    expect(advice.value.message).toContain('3 more');
  });

  it('caps the blocking reason at the top 5 failures per signal and notes how many more there are', async () => {
    const testFailures = Array.from({ length: 9 }, (_, i) => `test "x${i}" failed`);
    const buildFailures = Array.from({ length: 6 }, (_, i) => `TS error ${i}`);
    const evidence = signalStateEvidence({
      tests: failWith(testFailures),
      types: pass,
      build: failWith(buildFailures),
      lint: pass,
    });
    const verdict = await new QualityGateRecognizer().recognize(baseContext(), evidence);
    const outcome = verdict.changes[0] as OutcomeChange;

    for (const failure of testFailures.slice(0, 5)) {
      expect(outcome.value.reason).toContain(failure);
    }
    for (const failure of testFailures.slice(5)) {
      expect(outcome.value.reason).not.toContain(failure);
    }
    expect(outcome.value.reason).toContain('...and 4 more');

    for (const failure of buildFailures.slice(0, 5)) {
      expect(outcome.value.reason).toContain(failure);
    }
    for (const failure of buildFailures.slice(5)) {
      expect(outcome.value.reason).not.toContain(failure);
    }
    expect(outcome.value.reason).toContain('...and 1 more');
  });

  it('still rejects on a blocking failure even when lint also fails, and reports both, when allowLintErrors is true', async () => {
    const evidence = signalStateEvidence({
      tests: failWith(['test "x" failed']),
      types: pass,
      build: pass,
      lint: failWith(['unused import']),
    });
    const verdict = await new QualityGateRecognizer().recognize({ ...baseContext(), allowLintErrors: true }, evidence);

    expect(verdict.changes).toHaveLength(2);
    const outcome = verdict.changes.find((c) => c.kind === 'outcome') as OutcomeChange;
    const advice = verdict.changes.find((c) => c.kind === 'advice') as AdviceChange;
    expect(outcome.value.accept).toBe(false);
    expect(outcome.value.reason).toContain('Tests:');
    expect(outcome.value.reason).not.toContain('Lint:');
    expect(advice.value.message).toContain('unused import');
  });

  it('reports tests and lint together in one blocking reason when both fail and allowLintErrors is false', async () => {
    const evidence = signalStateEvidence({
      tests: failWith(['test "x" failed']),
      types: pass,
      build: pass,
      lint: failWith(['unused import']),
    });
    const verdict = await new QualityGateRecognizer().recognize(baseContext(), evidence);

    expect(verdict.changes).toHaveLength(1);
    const outcome = verdict.changes[0] as OutcomeChange;
    expect(outcome.value.accept).toBe(false);
    expect(outcome.value.reason).toContain('Tests:');
    expect(outcome.value.reason).toContain('Lint:');
    expect(outcome.value.reason).toContain('unused import');
  });

  it('rejects the commit when a signal is stale, explaining it is a stuck watcher rather than a real failure', async () => {
    const evidence = signalStateEvidence({
      tests: pass,
      types: staleWith('types quality signal is currently broken: its last real result is from ... An automatic recovery attempt is in progress right now; retry shortly.'),
      build: pass,
      lint: pass,
    });
    const verdict = await new QualityGateRecognizer().recognize(baseContext(), evidence);

    expect(verdict.changes).toHaveLength(1);
    const outcome = verdict.changes[0] as OutcomeChange;
    expect(outcome.kind).toBe('outcome');
    expect(outcome.value.accept).toBe(false);
    expect(outcome.value.reason).toContain('mcp__cabinet__quality_status');
    expect(outcome.value.reason).toContain('STUCK WATCHER');
    expect(outcome.value.reason).toContain('Types');
    expect(outcome.value.reason).toContain('automatic recovery attempt is in progress');
    expect(outcome.value.reason).toContain('vue-tsc --watch');
  });

  it('blocks on a stale lint signal even when allowLintErrors is true — a stale signal has no result to accept', async () => {
    const evidence = signalStateEvidence({
      tests: pass,
      types: pass,
      build: pass,
      lint: staleWith('lint quality signal is currently broken: no fresh result since a relevant change.'),
    });
    const verdict = await new QualityGateRecognizer().recognize({ ...baseContext(), allowLintErrors: true }, evidence);

    expect(verdict.changes).toHaveLength(1);
    const outcome = verdict.changes[0] as OutcomeChange;
    expect(outcome.kind).toBe('outcome');
    expect(outcome.value.accept).toBe(false);
    expect(outcome.value.reason).toContain('STUCK WATCHER');
  });

  it('reports a real failure and a stuck-watcher signal together, distinguishing the two', async () => {
    const evidence = signalStateEvidence({
      tests: failWith(['test "x" failed']),
      types: staleWith('types quality signal is currently broken.'),
      build: pass,
      lint: pass,
    });
    const verdict = await new QualityGateRecognizer().recognize(baseContext(), evidence);

    expect(verdict.changes).toHaveLength(1);
    const outcome = verdict.changes[0] as OutcomeChange;
    expect(outcome.value.reason).toContain('[FAILING] Tests:');
    expect(outcome.value.reason).toContain('test "x" failed');
    expect(outcome.value.reason).toContain('Types [STUCK WATCHER');
  });

  it('does not treat a stale signal as verified-clean for qualityGateVerifiedClean purposes', async () => {
    const evidence = signalStateEvidence({
      tests: pass,
      types: staleWith('types quality signal is currently broken.'),
      build: pass,
      lint: pass,
    });
    const result = evaluateQualitySignals(evidence);
    expect(result.allPass).toBe(false);
    expect(result.stale).toEqual(['types']);
    expect(result.failing).toEqual([]);
  });
});

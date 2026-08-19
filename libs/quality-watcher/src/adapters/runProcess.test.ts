import { describe, it, expect } from 'vitest';
import { runProcessCommand } from './runProcess.js';

describe('runProcessCommand', () => {
  it('resolves with the exit code and output of a command that exits on its own', async () => {
    const result = await runProcessCommand(process.cwd(), process.execPath, ['-e', "process.stdout.write('hi'); process.exit(0)"], {}, 5000);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe('hi');
  });

  it('resolves normally when the command finishes well within timeoutMs, with no performance-degradation warning', async () => {
    const result = await runProcessCommand(process.cwd(), process.execPath, ['-e', 'process.exit(0)'], {}, 5000);
    expect(result.exitCode).toBe(0);
    expect(result.warnings).toBeUndefined();
  });

  it('kills a command that never exits and resolves with a non-zero, explanatory result once timeoutMs elapses', async () => {
    const result = await runProcessCommand(
      process.cwd(),
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {},
      300
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('timed out after 300ms');
  }, 10_000);

  it('attaches a performance-degradation warning to a timed-out run\'s result too, alongside the timeout failure', async () => {
    const result = await runProcessCommand(
      process.cwd(),
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {},
      300
    );
    expect(result.warnings?.[0]).toContain('Performance is degraded');
  }, 10_000);

  it('attaches a performance-degradation warning once a command that DOES finish still took over half of timeoutMs', async () => {
    // 1400ms of deliberate sleep against a 2000ms timeout is 70% — clearly
    // over the 50% threshold even accounting for real spawn/scheduling
    // overhead, and clearly under 100% so it isn't killed. A prior version
    // of this test used 700ms/2000ms, which is only 35% of the timeout —
    // node's own process-spawn overhead (measured directly: a bare `spawn`
    // + 700ms `setTimeout` completes in under 800ms total) meant this could
    // fail on a fast/idle machine despite "passing" under heavier load —
    // the numbers themselves were wrong, not flaky timing.
    const result = await runProcessCommand(
      process.cwd(),
      process.execPath,
      ['-e', 'setTimeout(() => process.exit(0), 1400)'],
      {},
      2000
    );
    expect(result.exitCode).toBe(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toContain('Performance is degraded');
    expect(result.warnings?.[0]).toContain('2000ms timeout');
  }, 10_000);
});

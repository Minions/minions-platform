import { describe, it, expect } from 'vitest';
import { AlwaysPassSignalRunner } from './AlwaysPassSignalRunner.js';
import { SignalType } from '../SignalState.js';

describe('AlwaysPassSignalRunner', () => {
  it('always reports pass, for whichever SignalType it was built for', () => {
    const runner = new AlwaysPassSignalRunner(SignalType.CustomLint);
    expect(runner.signalType).toBe(SignalType.CustomLint);
    expect(runner.getState().state).toBe('pass');
  });

  it('start()/stop() are no-ops that never throw', async () => {
    const runner = new AlwaysPassSignalRunner(SignalType.Tests);
    await expect(runner.start()).resolves.toBeUndefined();
    await expect(runner.stop()).resolves.toBeUndefined();
    expect(runner.getState().state).toBe('pass');
  });
});

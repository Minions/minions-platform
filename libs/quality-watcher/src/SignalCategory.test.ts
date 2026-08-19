import { describe, it, expect } from 'vitest';
import { GLOBAL_SIGNALS, DEV_SIGNALS } from './SignalCategory.js';
import { SignalType } from './SignalState.js';

describe('SignalCategory', () => {
  it('GLOBAL_SIGNALS is currently empty — no global check exists yet', () => {
    expect(GLOBAL_SIGNALS).toEqual([]);
  });

  it('DEV_SIGNALS covers every software-dev signal, exactly once each', () => {
    expect(new Set(DEV_SIGNALS)).toEqual(new Set(Object.values(SignalType)));
    expect(DEV_SIGNALS.length).toBe(Object.values(SignalType).length);
  });

  it('the two categories never overlap', () => {
    const overlap = DEV_SIGNALS.filter((s) => GLOBAL_SIGNALS.includes(s));
    expect(overlap).toEqual([]);
  });
});

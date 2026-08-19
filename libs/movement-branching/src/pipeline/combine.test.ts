import { describe, it, expect } from 'vitest';
import { combine, mergeTextChanges } from './combine.js';
import { RiskCode } from '../risk/RiskComputer.js';
import type { AdviceChange, OutcomeChange, RiskChange, TextChange } from './types.js';

function textChange(file: string, range: [number, number], replacement: string, producer = 'p'): TextChange {
  return { kind: 'text', value: { file, baseContentHash: 'h', range, replacement }, producer };
}

function riskChange(code: RiskCode, reason: string, producer = 'p'): RiskChange {
  return {
    kind: 'risk',
    value: { code, reason, automated: { code, reason }, manualFactors: [], suggestions: [] },
    producer,
  };
}

describe('mergeTextChanges', () => {
  it('accepts non-overlapping edits in the same file', () => {
    const a = textChange('f.ts', [10, 20], 'X');
    const b = textChange('f.ts', [0, 5], 'Y');
    const { accepted, conflicted } = mergeTextChanges([a, b]);
    expect(accepted.get('f.ts')).toEqual([a, b]);
    expect(conflicted).toHaveLength(0);
  });

  it('defers overlapping edits to conflicted, never dropping or double-applying', () => {
    const a = textChange('f.ts', [10, 30], 'X');
    const b = textChange('f.ts', [20, 40], 'Y'); // overlaps a
    const { accepted, conflicted } = mergeTextChanges([a, b]);
    // sorted by range end descending: b (end 40) wins the pass, a conflicts
    expect(accepted.get('f.ts')).toEqual([b]);
    expect(conflicted).toEqual([a]);
  });
});

describe('combine — risk reducer', () => {
  it('picks the highest risk code regardless of contributor order', () => {
    const low = riskChange(RiskCode.Provable, 'docs only');
    const high = riskChange(RiskCode.Risky, 'no coverage');
    expect(combine([low, high]).risk?.code).toBe(RiskCode.Risky);
    expect(combine([high, low]).risk?.code).toBe(RiskCode.Risky);
  });
});

describe('combine — advice reducer', () => {
  it('concatenates advice ordered by priority, highest first', () => {
    const low: AdviceChange = { kind: 'advice', value: { message: 'low', priority: 1 }, producer: 'p' };
    const high: AdviceChange = { kind: 'advice', value: { message: 'high', priority: 10 }, producer: 'p' };
    expect(combine([low, high]).advice).toEqual(['high', 'low']);
  });

  it('suppresses advice entirely when the reduced outcome rejects', () => {
    const advice: AdviceChange = { kind: 'advice', value: { message: 'unrelated', priority: 1 }, producer: 'p' };
    const reject: OutcomeChange = { kind: 'outcome', value: { accept: false, reason: 'blocked' }, producer: 'p' };
    expect(combine([advice, reject]).advice).toEqual([]);
  });
});

describe('combine — outcome reducer', () => {
  it('accepts when no rejections were proposed', () => {
    expect(combine([]).outcome).toEqual({ accept: true, reasons: [] });
  });

  it('rejects if any recognizer rejects, concatenating reasons', () => {
    const r1: OutcomeChange = { kind: 'outcome', value: { accept: false, reason: 'a' }, producer: 'p1' };
    const r2: OutcomeChange = { kind: 'outcome', value: { accept: false, reason: 'b' }, producer: 'p2' };
    expect(combine([r1, r2]).outcome).toEqual({ accept: false, reasons: ['a', 'b'] });
  });
});

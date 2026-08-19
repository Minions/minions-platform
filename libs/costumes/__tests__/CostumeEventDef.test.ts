import { describe, it, expect } from 'vitest';
import { isCostumeEventDef } from '../src/CostumeEventDef';

describe('isCostumeEventDef', () => {
  it('returns true for valid event def', () => {
    expect(isCostumeEventDef({
      declaration: { type: 'phase-changed', schema: {} },
    })).toBe(true);
  });

  it('returns true for declaration with just type', () => {
    expect(isCostumeEventDef({
      declaration: { type: 'test-event' },
    })).toBe(true);
  });

  it('returns false for null', () => {
    expect(isCostumeEventDef(null)).toBe(false);
  });

  it('returns false for non-object', () => {
    expect(isCostumeEventDef('string')).toBe(false);
  });

  it('returns false for missing declaration', () => {
    expect(isCostumeEventDef({})).toBe(false);
  });

  it('returns false for non-object declaration', () => {
    expect(isCostumeEventDef({ declaration: 'string' })).toBe(false);
  });

  it('returns false for declaration without type', () => {
    expect(isCostumeEventDef({ declaration: { schema: {} } })).toBe(false);
  });

  it('returns false for declaration with non-string type', () => {
    expect(isCostumeEventDef({ declaration: { type: 123 } })).toBe(false);
  });
});

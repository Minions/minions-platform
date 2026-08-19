import { describe, it, expect } from 'vitest';
import { STANDARD_WINGS } from './provisioner.js';

describe('STANDARD_WINGS', () => {
  it('always includes a planning wing and at least one workshop wing', () => {
    expect(STANDARD_WINGS).toContain('planning');
    expect(STANDARD_WINGS.some((name) => name.startsWith('workshop-'))).toBe(true);
  });

  it('has no duplicate wing names', () => {
    expect(new Set(STANDARD_WINGS).size).toBe(STANDARD_WINGS.length);
  });
});

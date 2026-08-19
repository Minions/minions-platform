import { describe, it, expect } from 'vitest';
import { isAccessoriesConfig } from '../src/AccessoriesConfig';

describe('isAccessoriesConfig', () => {
  it('accepts minimal config with empty costumes', () => {
    expect(isAccessoriesConfig({ costumes: [] })).toBe(true);
  });

  it('accepts config with costume names', () => {
    expect(isAccessoriesConfig({ costumes: ['dev-and-check', 'playwright'] })).toBe(true);
  });

  it('accepts config with allow permissions', () => {
    expect(isAccessoriesConfig({
      costumes: [],
      permissions: { allow: ['Read', 'Bash(git *)'] },
    })).toBe(true);
  });

  it('accepts config with deny permissions', () => {
    expect(isAccessoriesConfig({
      costumes: [],
      permissions: { deny: ['Write', 'Edit'] },
    })).toBe(true);
  });

  it('accepts config with both allow and deny', () => {
    expect(isAccessoriesConfig({
      costumes: ['dev-and-check'],
      permissions: { allow: ['Read'], deny: ['Write'] },
    })).toBe(true);
  });

  it('accepts config with no permissions field', () => {
    expect(isAccessoriesConfig({ costumes: ['x'] })).toBe(true);
  });

  it('rejects null', () => {
    expect(isAccessoriesConfig(null)).toBe(false);
  });

  it('rejects non-object', () => {
    expect(isAccessoriesConfig('string')).toBe(false);
  });

  it('rejects missing costumes', () => {
    expect(isAccessoriesConfig({})).toBe(false);
  });

  it('rejects non-array costumes', () => {
    expect(isAccessoriesConfig({ costumes: 'bad' })).toBe(false);
  });

  it('rejects non-string costume names', () => {
    expect(isAccessoriesConfig({ costumes: [123] })).toBe(false);
  });

  it('rejects non-object permissions', () => {
    expect(isAccessoriesConfig({ costumes: [], permissions: 'bad' })).toBe(false);
  });

  it('rejects non-array permissions.allow', () => {
    expect(isAccessoriesConfig({ costumes: [], permissions: { allow: 'bad' } })).toBe(false);
  });

  it('rejects non-array permissions.deny', () => {
    expect(isAccessoriesConfig({ costumes: [], permissions: { deny: 'bad' } })).toBe(false);
  });

  it('rejects non-string items in permissions.allow', () => {
    expect(isAccessoriesConfig({ costumes: [], permissions: { allow: [123] } })).toBe(false);
  });
});

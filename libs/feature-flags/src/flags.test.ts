import { describe, it, expect } from 'vitest';
import { initFlags, FF } from './flags';

describe('Feature Flags', () => {
  it('defaults to production flags', () => {
    initFlags(false);
    expect(FF().__flags_name__).toBe('production');
  });

  it('returns flags in dev mode', () => {
    initFlags(true);
    expect(FF().__flags_name__).toBe('development');
  });

  it('gates BROWSER_VERIFY off in production and on in dev', () => {
    initFlags(false);
    expect(FF().BROWSER_VERIFY).toBe(false);
    initFlags(true);
    expect(FF().BROWSER_VERIFY).toBe(true);
  });

  it('returns production flags after switching back', () => {
    initFlags(true);
    initFlags(false);
    expect(FF().__flags_name__).toBe('production');
  });

  it('gates HACK_OFF_QUALITY_CHECKS on in both production and dev', () => {
    initFlags(false);
    expect(FF().HACK_OFF_QUALITY_CHECKS).toBe(true);
    initFlags(true);
    expect(FF().HACK_OFF_QUALITY_CHECKS).toBe(true);
  });

  it('gates HIGHER_PERF_QUALITY_WATCHER off in production and on in dev', () => {
    initFlags(false);
    expect(FF().HIGHER_PERF_QUALITY_WATCHER).toBe(false);
    initFlags(true);
    expect(FF().HIGHER_PERF_QUALITY_WATCHER).toBe(true);
  });
});

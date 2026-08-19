import { describe, it, expect } from 'vitest';
import { createWarningCapturingLogger } from './createWarningCapturingLogger.js';

describe('createWarningCapturingLogger', () => {
  it('pushes warn() calls into the given array', () => {
    const warnings: string[] = [];
    const logger = createWarningCapturingLogger(warnings);

    logger.warn('deprecated option foo');

    expect(warnings).toEqual(['deprecated option foo']);
  });

  it('pushes warnOnce() and error() calls into the same array too', () => {
    const warnings: string[] = [];
    const logger = createWarningCapturingLogger(warnings);

    logger.warnOnce('shown once');
    logger.error('build plugin error');

    expect(warnings).toEqual(['shown once', 'build plugin error']);
  });

  it('drops info() entirely — routine framework chatter, not a warning', () => {
    const warnings: string[] = [];
    const logger = createWarningCapturingLogger(warnings);

    logger.info('optimized dependencies changed, reloading');

    expect(warnings).toEqual([]);
  });

  it('captures into the array by reference, so an in-place clear is visible to future calls', () => {
    const warnings: string[] = [];
    const logger = createWarningCapturingLogger(warnings);

    logger.warn('first run warning');
    warnings.length = 0;
    logger.warn('second run warning');

    expect(warnings).toEqual(['second run warning']);
  });
});

import { describe, it, expect } from 'vitest';
import { buildHealthResponse } from './health.js';

describe('buildHealthResponse', () => {
  it('reports ok with the given time', () => {
    expect(buildHealthResponse(() => 12345)).toEqual({ status: 'ok', timestamp: 12345 });
  });
});

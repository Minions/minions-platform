import { describe, it, expect } from 'vitest';
import { generateId } from './types.js';
import { asNodeId } from './nodeId.js';

describe('generateId', () => {
  it('generates an 8-character lowercase hex id', () => {
    const id = generateId();
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('generates distinct ids across calls', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateId()));
    expect(ids.size).toBe(50);
  });
});

describe('asNodeId', () => {
  it('passes the raw string through unchanged', () => {
    expect(asNodeId('a1b2c3d4')).toBe('a1b2c3d4');
  });
});

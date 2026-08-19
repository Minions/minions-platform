import { describe, it, expect } from 'vitest';
import { Effect } from 'effect';
import { isMission, type Mission, type MissionContext } from './';

describe('isMission', () => {
  it('returns true for valid mission objects', () => {
    const validMission: Mission<{ goal: string }> = {
      name: 'test-mission',
      description: 'A test mission',
      api: 'effect',
      args: {
        type: 'object',
        properties: {
          goal: { type: 'string', description: 'The goal' },
        },
        required: ['goal'],
      },
      run(_ctx: MissionContext, _args: { goal: string }) {
        return Effect.void;
      },
    };

    expect(isMission(validMission)).toBe(true);
  });

  it('returns false for null', () => {
    expect(isMission(null)).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isMission(undefined)).toBe(false);
  });

  it('returns false for primitives', () => {
    expect(isMission('string')).toBe(false);
    expect(isMission(123)).toBe(false);
    expect(isMission(true)).toBe(false);
  });

  it('returns false for objects missing name', () => {
    expect(
      isMission({
        description: 'test',
        args: { type: 'object', properties: {} },
        run: async () => { /* test stub */ },
      })
    ).toBe(false);
  });

  it('returns false for objects missing description', () => {
    expect(
      isMission({
        name: 'test',
        args: { type: 'object', properties: {} },
        run: async () => { /* test stub */ },
      })
    ).toBe(false);
  });

  it('returns false for objects missing args', () => {
    expect(
      isMission({
        name: 'test',
        description: 'test',
        run: async () => { /* test stub */ },
      })
    ).toBe(false);
  });

  it('returns false for objects missing run', () => {
    expect(
      isMission({
        name: 'test',
        description: 'test',
        args: { type: 'object', properties: {} },
      })
    ).toBe(false);
  });

  it('returns false for objects with non-function run', () => {
    expect(
      isMission({
        name: 'test',
        description: 'test',
        args: { type: 'object', properties: {} },
        run: 'not a function',
      })
    ).toBe(false);
  });
});

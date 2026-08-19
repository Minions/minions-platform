/**
 * Tests for Gadget interface and isGadget type guard
 */

import { describe, it, expect } from 'vitest';
import { isGadget } from './Gadget';
import type { Gadget, GadgetContext, GadgetResult } from './Gadget';

describe('isGadget', () => {
  it('accepts a valid gadget', () => {
    const gadget = {
      name: 'test_gadget',
      description: 'A test gadget',
      args: { type: 'object' as const, properties: {} },
      execute: async () => ({ success: true as const, result: 'ok' }),
    };

    expect(isGadget(gadget)).toBe(true);
  });

  it('rejects null', () => {
    expect(isGadget(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isGadget(undefined)).toBe(false);
  });

  it('rejects non-object', () => {
    expect(isGadget('string')).toBe(false);
    expect(isGadget(42)).toBe(false);
  });

  it('rejects object missing name', () => {
    expect(isGadget({
      description: 'A gadget',
      args: { type: 'object', properties: {} },
      execute: async () => ({ success: true, result: 'ok' }),
    })).toBe(false);
  });

  it('rejects object missing description', () => {
    expect(isGadget({
      name: 'test',
      args: { type: 'object', properties: {} },
      execute: async () => ({ success: true, result: 'ok' }),
    })).toBe(false);
  });

  it('rejects object missing args', () => {
    expect(isGadget({
      name: 'test',
      description: 'A gadget',
      execute: async () => ({ success: true, result: 'ok' }),
    })).toBe(false);
  });

  it('rejects object with null args', () => {
    expect(isGadget({
      name: 'test',
      description: 'A gadget',
      args: null,
      execute: async () => ({ success: true, result: 'ok' }),
    })).toBe(false);
  });

  it('rejects object missing execute', () => {
    expect(isGadget({
      name: 'test',
      description: 'A gadget',
      args: { type: 'object', properties: {} },
    })).toBe(false);
  });

  it('rejects object with non-function execute', () => {
    expect(isGadget({
      name: 'test',
      description: 'A gadget',
      args: { type: 'object', properties: {} },
      execute: 'not a function',
    })).toBe(false);
  });
});

describe('Gadget interface', () => {
  it('can be created with typed args', async () => {
    const gadget: Gadget<{ message: string }> = {
      name: 'echo',
      description: 'Echoes input',
      args: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Message to echo' },
        },
        required: ['message'],
      },
      async execute(_ctx: GadgetContext, args: { message: string }): Promise<GadgetResult> {
        return { success: true, result: { echo: args.message } };
      },
    };

    const ctx: GadgetContext = {
      getWing: () => undefined,
      lairRoot: '/test/lair',
    };

    const result = await gadget.execute(ctx, { message: 'hello' });
    expect(result).toEqual({ success: true, result: { echo: 'hello' } });
  });

  it('can return failure result', async () => {
    const gadget: Gadget = {
      name: 'fail',
      description: 'Always fails',
      args: { type: 'object', properties: {} },
      async execute(): Promise<GadgetResult> {
        return { success: false, error: 'Something went wrong' };
      },
    };

    const ctx: GadgetContext = {
      getWing: () => undefined,
      lairRoot: '/test/lair',
    };

    const result = await gadget.execute(ctx, {});
    expect(result).toEqual({ success: false, error: 'Something went wrong' });
  });
});

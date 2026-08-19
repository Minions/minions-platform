/**
 * Tests for CostumeExtensions types and runtime validators
 */

import { describe, it, expect } from 'vitest';
import { isCostumeExtensions, isCostumeActionGroup, isCostumeGadgetMount } from './CostumeExtensions';
import type { CostumeExtensions, CostumeActionGroup, CostumeGadgetMount, CostumeExtensionsFactory } from './CostumeExtensions';
import type { ActionGroupDef } from '@minions/mcp-types';
import type { Gadget } from './Gadget';

function makeActionGroupDef(): ActionGroupDef {
  return {
    name: 'my_group',
    description: 'A test action group',
    coreActions: {
      ping: {
        description: 'Ping',
        help: 'Pings.',
        async execute() {
          return { pong: true };
        },
      },
    },
  };
}

function makeGadget(): Gadget {
  return {
    name: 'echo',
    description: 'Echoes',
    args: { type: 'object', properties: {} },
    async execute() {
      return { success: true as const, result: 'ok' };
    },
  };
}

describe('isCostumeActionGroup', () => {
  it('accepts a valid entry with a single endpoint', () => {
    const entry: CostumeActionGroup = { def: makeActionGroupDef(), endpoints: ['henchery'] };
    expect(isCostumeActionGroup(entry)).toBe(true);
  });

  it('accepts a valid entry with multiple endpoints and actionEndpoints overrides', () => {
    const entry: CostumeActionGroup = {
      def: makeActionGroupDef(),
      endpoints: ['henchery', 'lair'],
      actionEndpoints: { ping: ['henchery'] },
    };
    expect(isCostumeActionGroup(entry)).toBe(true);
  });

  it('rejects a def missing coreActions', () => {
    expect(isCostumeActionGroup({ def: { name: 'x', description: 'y' }, endpoints: ['henchery'] })).toBe(false);
  });

  it('rejects an empty endpoints array', () => {
    expect(isCostumeActionGroup({ def: makeActionGroupDef(), endpoints: [] })).toBe(false);
  });

  it('rejects an unknown endpoint name', () => {
    expect(isCostumeActionGroup({ def: makeActionGroupDef(), endpoints: ['nowhere'] })).toBe(false);
  });

  it('rejects "all" as an endpoint — not a real mount target', () => {
    expect(isCostumeActionGroup({ def: makeActionGroupDef(), endpoints: ['all'] })).toBe(false);
  });

  it('rejects actionEndpoints with an invalid endpoint', () => {
    expect(isCostumeActionGroup({
      def: makeActionGroupDef(),
      endpoints: ['henchery'],
      actionEndpoints: { ping: ['bogus'] },
    })).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(isCostumeActionGroup(null)).toBe(false);
    expect(isCostumeActionGroup('nope')).toBe(false);
  });
});

describe('isCostumeGadgetMount', () => {
  it('accepts a valid entry with a single endpoint', () => {
    const entry: CostumeGadgetMount = { gadget: makeGadget(), endpoints: ['henchery'] };
    expect(isCostumeGadgetMount(entry)).toBe(true);
  });

  it('accepts a valid entry with multiple endpoints — gadgets are not limited to henchery', () => {
    const entry: CostumeGadgetMount = { gadget: makeGadget(), endpoints: ['henchery', 'throne', 'lair'] };
    expect(isCostumeGadgetMount(entry)).toBe(true);
  });

  it('rejects a malformed gadget', () => {
    expect(isCostumeGadgetMount({ gadget: { name: 'bad' }, endpoints: ['henchery'] })).toBe(false);
  });

  it('rejects an empty endpoints array', () => {
    expect(isCostumeGadgetMount({ gadget: makeGadget(), endpoints: [] })).toBe(false);
  });

  it('rejects an unknown endpoint name', () => {
    expect(isCostumeGadgetMount({ gadget: makeGadget(), endpoints: ['nowhere'] })).toBe(false);
  });

  it('rejects "all" as an endpoint — not a real mount target', () => {
    expect(isCostumeGadgetMount({ gadget: makeGadget(), endpoints: ['all'] })).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(isCostumeGadgetMount(null)).toBe(false);
    expect(isCostumeGadgetMount('nope')).toBe(false);
  });
});

describe('isCostumeExtensions', () => {
  it('accepts an empty object (no action groups, no gadgets)', () => {
    expect(isCostumeExtensions({})).toBe(true);
  });

  it('accepts action groups only', () => {
    const extensions: CostumeExtensions = {
      actionGroups: [{ def: makeActionGroupDef(), endpoints: ['henchery'] }],
    };
    expect(isCostumeExtensions(extensions)).toBe(true);
  });

  it('accepts gadgets only', () => {
    const extensions: CostumeExtensions = {
      gadgets: [{ gadget: makeGadget(), endpoints: ['henchery'] }],
    };
    expect(isCostumeExtensions(extensions)).toBe(true);
  });

  it('accepts a gadget mounted on multiple endpoints', () => {
    const extensions: CostumeExtensions = {
      gadgets: [{ gadget: makeGadget(), endpoints: ['henchery', 'throne'] }],
    };
    expect(isCostumeExtensions(extensions)).toBe(true);
  });

  it('accepts both action groups and gadgets together', () => {
    const extensions: CostumeExtensions = {
      actionGroups: [{ def: makeActionGroupDef(), endpoints: ['henchery'] }],
      gadgets: [{ gadget: makeGadget(), endpoints: ['henchery'] }],
    };
    expect(isCostumeExtensions(extensions)).toBe(true);
  });

  it('rejects a malformed action group inside the array', () => {
    expect(isCostumeExtensions({ actionGroups: [{ def: {}, endpoints: ['henchery'] }] })).toBe(false);
  });

  it('rejects a malformed gadget mount inside the array', () => {
    expect(isCostumeExtensions({ gadgets: [{ gadget: { name: 'bad' }, endpoints: ['henchery'] }] })).toBe(false);
  });

  it('rejects a bare gadget (missing endpoints wrapper) — old shape no longer accepted', () => {
    expect(isCostumeExtensions({ gadgets: [makeGadget()] })).toBe(false);
  });

  it('rejects non-object input', () => {
    expect(isCostumeExtensions(null)).toBe(false);
    expect(isCostumeExtensions(undefined)).toBe(false);
    expect(isCostumeExtensions(42)).toBe(false);
  });

  it('rejects when actionGroups is not an array', () => {
    expect(isCostumeExtensions({ actionGroups: 'nope' })).toBe(false);
  });

  it('rejects when gadgets is not an array', () => {
    expect(isCostumeExtensions({ gadgets: 'nope' })).toBe(false);
  });
});

describe('CostumeExtensionsFactory', () => {
  it('is a zero-arg function returning CostumeExtensions', () => {
    const factory: CostumeExtensionsFactory = () => ({
      actionGroups: [{ def: makeActionGroupDef(), endpoints: ['henchery'] }],
      gadgets: [{ gadget: makeGadget(), endpoints: ['henchery', 'throne'] }],
    });
    expect(isCostumeExtensions(factory())).toBe(true);
  });
});

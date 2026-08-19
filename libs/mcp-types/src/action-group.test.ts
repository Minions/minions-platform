import { describe, it, expect, vi, expectTypeOf } from 'vitest';
import {
  buildActionGroupSchema,
  buildActionGroupDescription,
  handleActionGroupHelp,
  dispatchActionGroup,
} from './action-group';
import type { ActionGroupDef, ActionContext, ActionDef, InferActionMap } from './action-group';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const noop = vi.fn().mockResolvedValue({ ok: true });

const minimalDef: ActionGroupDef = {
  name: 'widget',
  description: 'Manage widgets.',
  coreActions: {
    create: {
      description: 'create a new widget',
      help: 'Create help text.',
      params: { name: { type: 'string', description: 'Widget name' } },
      required: ['name'],
      execute: noop,
    },
    list: {
      description: 'list all widgets',
      help: 'List help text.',
      execute: noop,
    },
  },
};

const richDef: ActionGroupDef = {
  name: 'ship',
  description: 'Ship things around.',
  workflow: 'load → sail → unload',
  sharedParams: {
    port: { type: 'string', description: 'Destination port' },
  },
  coreActions: {
    load: {
      description: 'load cargo',
      help: 'Load help.',
      params: { cargo: { type: 'string', description: 'What to load' } },
      required: ['port', 'cargo'],
      execute: noop,
    },
    sail: {
      description: 'sail to port',
      help: 'Sail help.',
      required: ['port'],
      execute: noop,
    },
  },
  secondaryActions: {
    repair: {
      description: 'repair the ship',
      help: 'Repair help.',
      params: { component: { type: 'string', description: 'Part to repair' } },
      execute: noop,
    },
  },
};

const ctx: ActionContext = { lair: {} };

// ---------------------------------------------------------------------------
// buildActionGroupSchema
// ---------------------------------------------------------------------------

describe('buildActionGroupSchema', () => {
  it('sets type to object with action required', () => {
    const schema = buildActionGroupSchema(minimalDef);
    expect(schema.type).toBe('object');
    expect(schema.required).toEqual(['action']);
  });

  it('includes all core and secondary action names plus help in action enum', () => {
    const schema = buildActionGroupSchema(richDef);
    const actionEnum = schema.properties['action'].enum ?? [];
    expect(actionEnum).toContain('load');
    expect(actionEnum).toContain('sail');
    expect(actionEnum).toContain('repair');
    expect(actionEnum).toContain('help');
  });

  it('includes command property for help sub-command', () => {
    const schema = buildActionGroupSchema(minimalDef);
    expect(schema.properties).toHaveProperty('command');
  });

  it('merges shared params into properties', () => {
    const schema = buildActionGroupSchema(richDef);
    expect(schema.properties).toHaveProperty('port');
  });

  it('merges core action-specific params into properties', () => {
    const schema = buildActionGroupSchema(richDef);
    expect(schema.properties).toHaveProperty('cargo');
  });

  it('omits secondary action params from the schema', () => {
    const schema = buildActionGroupSchema(richDef);
    expect(schema.properties).not.toHaveProperty('component');
  });

  it('shared params take precedence over same-named action params', () => {
    const def: ActionGroupDef = {
      name: 'clash',
      description: 'Test precedence.',
      sharedParams: {
        target: { type: 'string', description: 'shared target' },
      },
      coreActions: {
        fire: {
          description: 'fire',
          help: 'Fire help.',
          params: { target: { type: 'number', description: 'action target' } },
          execute: noop,
        },
      },
    };
    const schema = buildActionGroupSchema(def);
    expect(schema.properties['target'].type).toBe('string');
    expect(schema.properties['target'].description).toBe('shared target');
  });
});

// ---------------------------------------------------------------------------
// buildActionGroupDescription
// ---------------------------------------------------------------------------

describe('buildActionGroupDescription', () => {
  it('includes the group description', () => {
    const desc = buildActionGroupDescription(minimalDef);
    expect(desc).toContain('Manage widgets.');
  });

  it('includes workflow when provided', () => {
    const desc = buildActionGroupDescription(richDef);
    expect(desc).toContain('load → sail → unload');
  });

  it('omits workflow line when not provided', () => {
    const desc = buildActionGroupDescription(minimalDef);
    expect(desc).not.toContain('Normal workflow:');
  });

  it('lists core actions in CSV section', () => {
    const desc = buildActionGroupDescription(minimalDef);
    expect(desc).toContain('create,');
    expect(desc).toContain('list,');
  });

  it('includes help row in CSV section', () => {
    const desc = buildActionGroupDescription(minimalDef);
    expect(desc).toContain('help,"get specific info on a command"');
  });

  it('lists secondary actions by name when present', () => {
    const desc = buildActionGroupDescription(richDef);
    expect(desc).toContain('repair');
  });

  it('does not include a Parameters section', () => {
    const desc = buildActionGroupDescription(richDef);
    expect(desc).not.toContain('Parameters:');
  });

  it('does not list individual param bullet lines', () => {
    const desc = buildActionGroupDescription(richDef);
    expect(desc).not.toMatch(/^- \w+ \(/m);
  });
});

// ---------------------------------------------------------------------------
// handleActionGroupHelp
// ---------------------------------------------------------------------------

describe('handleActionGroupHelp', () => {
  it('returns group overview when no command given', () => {
    const text = handleActionGroupHelp(richDef);
    expect(text).toContain('ship');
    expect(text).toContain('Core actions:');
    expect(text).toContain('load');
    expect(text).toContain('sail');
  });

  it('includes workflow in overview when defined', () => {
    const text = handleActionGroupHelp(richDef);
    expect(text).toContain('load → sail → unload');
  });

  it('lists secondary actions in overview', () => {
    const text = handleActionGroupHelp(richDef);
    expect(text).toContain('Secondary actions:');
    expect(text).toContain('repair');
  });

  it('lists shared params with required-by annotation', () => {
    const text = handleActionGroupHelp(richDef);
    expect(text).toContain('port');
    expect(text).toContain('required by:');
  });

  it('returns specific action help when command given', () => {
    const text = handleActionGroupHelp(richDef, 'load');
    expect(text).toBe('Load help.');
  });

  it('returns specific help for secondary actions too', () => {
    const text = handleActionGroupHelp(richDef, 'repair');
    expect(text).toBe('Repair help.');
  });

  it('returns error message for unknown command', () => {
    const text = handleActionGroupHelp(richDef, 'unknown');
    expect(text).toContain('Unknown action: "unknown"');
    expect(text).toContain('Available actions:');
  });
});

// ---------------------------------------------------------------------------
// dispatchActionGroup
// ---------------------------------------------------------------------------

describe('dispatchActionGroup', () => {
  it('dispatches action=help to handleActionGroupHelp', async () => {
    const result = await dispatchActionGroup(richDef, { action: 'help' }, ctx) as { action: string; content: string };
    expect(result.action).toBe('help');
    expect(result.content).toContain('ship');
  });

  it('dispatches action=help command=<name> for specific help', async () => {
    const result = await dispatchActionGroup(richDef, { action: 'help', command: 'load' }, ctx) as { action: string; content: string };
    expect(result.content).toBe('Load help.');
  });

  it('dispatches to the correct action execute()', async () => {
    const executeFn = vi.fn().mockResolvedValue({ done: true });
    const def: ActionGroupDef = {
      name: 'test',
      description: 'Test group.',
      coreActions: {
        go: { description: 'go', help: 'Go help.', execute: executeFn },
      },
    };
    const result = await dispatchActionGroup(def, { action: 'go' }, ctx);
    expect(executeFn).toHaveBeenCalledWith(ctx, { action: 'go' });
    expect(result).toEqual({ done: true });
  });

  it('throws on unknown action', async () => {
    await expect(
      dispatchActionGroup(minimalDef, { action: 'destroy' }, ctx)
    ).rejects.toThrow('Unknown action "destroy"');
  });

  it('throws when required params are missing', async () => {
    await expect(
      dispatchActionGroup(minimalDef, { action: 'create' }, ctx)
    ).rejects.toThrow('Missing required parameter(s) for action "create": name');
  });

  it('throws when required param is null', async () => {
    await expect(
      dispatchActionGroup(minimalDef, { action: 'create', name: null }, ctx)
    ).rejects.toThrow('Missing required parameter(s) for action "create": name');
  });

  it('passes when all required params are present', async () => {
    const executeFn = vi.fn().mockResolvedValue({});
    const def: ActionGroupDef = {
      name: 'test',
      description: 'Test.',
      coreActions: {
        create: {
          description: 'create',
          help: 'Create help.',
          params: { name: { type: 'string' } },
          required: ['name'],
          execute: executeFn,
        },
      },
    };
    await dispatchActionGroup(def, { action: 'create', name: 'foo' }, ctx);
    expect(executeFn).toHaveBeenCalled();
  });

  it('atWing/atLair: calls atWing via resolveWingContext when context.wingName is set', async () => {
    const atWing = vi.fn().mockResolvedValue({ via: 'wing' });
    const resolveWingContext = vi.fn().mockResolvedValue({ wing: 'ctx' });
    const def: ActionGroupDef = {
      name: 'test',
      description: 'Test.',
      resolveWingContext,
      coreActions: {
        go: { description: 'go', help: 'Go help.', atWing },
      },
    };
    const wingCtx: ActionContext = { lair: {}, wingName: 'workshop-01' };

    const result = await dispatchActionGroup(def, { action: 'go', repo: 'billing' }, wingCtx);

    expect(resolveWingContext).toHaveBeenCalledWith(wingCtx, 'billing', { action: 'go', repo: 'billing' });
    expect(atWing).toHaveBeenCalledWith({ wing: 'ctx' }, { action: 'go', repo: 'billing' });
    expect(result).toEqual({ via: 'wing' });
  });

  it('atWing/atLair: calls atLair via resolveLairContext when context.wingName is undefined', async () => {
    const atLair = vi.fn().mockResolvedValue({ via: 'lair' });
    const resolveLairContext = vi.fn().mockResolvedValue({ lair: 'ctx' });
    const def: ActionGroupDef = {
      name: 'test',
      description: 'Test.',
      resolveLairContext,
      coreActions: {
        go: { description: 'go', help: 'Go help.', atLair },
      },
    };

    const result = await dispatchActionGroup(def, { action: 'go' }, ctx);

    expect(resolveLairContext).toHaveBeenCalledWith(ctx, undefined, { action: 'go' });
    expect(atLair).toHaveBeenCalledWith({ lair: 'ctx' }, { action: 'go' });
    expect(result).toEqual({ via: 'lair' });
  });

  it('atWing/atLair: throws when the action has no atWing but is called at a wing endpoint', async () => {
    const def: ActionGroupDef = {
      name: 'test',
      description: 'Test.',
      resolveLairContext: vi.fn(),
      coreActions: {
        go: { description: 'go', help: 'Go help.', atLair: vi.fn() },
      },
    };
    const wingCtx: ActionContext = { lair: {}, wingName: 'workshop-01' };

    await expect(dispatchActionGroup(def, { action: 'go' }, wingCtx)).rejects.toThrow(
      'Action "go" is not available at a wing endpoint',
    );
  });

  it('atWing/atLair: an atWing-only action (no atLair) still resolves via atWing when called at a non-wing endpoint — it has no lair-scoped meaning to fall back to, so resolveWingContext gets a chance to find a wing from params instead (e.g. movement diff\'s explicit `wing` param)', async () => {
    const atWing = vi.fn().mockResolvedValue({ via: 'wing' });
    const resolveWingContext = vi.fn().mockResolvedValue({ wing: 'ctx' });
    const def: ActionGroupDef = {
      name: 'test',
      description: 'Test.',
      resolveWingContext,
      coreActions: {
        go: { description: 'go', help: 'Go help.', atWing },
      },
    };

    const result = await dispatchActionGroup(def, { action: 'go', wing: 'workshop-01' }, ctx);

    expect(resolveWingContext).toHaveBeenCalledWith(ctx, undefined, { action: 'go', wing: 'workshop-01' });
    expect(atWing).toHaveBeenCalledWith({ wing: 'ctx' }, { action: 'go', wing: 'workshop-01' });
    expect(result).toEqual({ via: 'wing' });
  });

  it('atWing/atLair: throws when the action has neither atWing nor atLair as a real function', async () => {
    const def: ActionGroupDef = {
      name: 'test',
      description: 'Test.',
      coreActions: {
        // 'atLair' key present (satisfies the endpoint-action-def check) but
        // no atWing and no callable atLair — a defensive, effectively
        // unreachable-in-practice edge case.
        go: { description: 'go', help: 'Go help.', atLair: undefined },
      },
    };

    await expect(dispatchActionGroup(def, { action: 'go' }, ctx)).rejects.toThrow(
      'Action "go" is not available outside a wing endpoint',
    );
  });

  it('atWing/atLair: throws a clear error when the group has no resolveWingContext', async () => {
    const def: ActionGroupDef = {
      name: 'test',
      description: 'Test.',
      coreActions: {
        go: { description: 'go', help: 'Go help.', atWing: vi.fn() },
      },
    };
    const wingCtx: ActionContext = { lair: {}, wingName: 'workshop-01' };

    await expect(dispatchActionGroup(def, { action: 'go' }, wingCtx)).rejects.toThrow(
      'Action group "test" declares atWing actions but no resolveWingContext',
    );
  });

  it('a plain ActionDef (old shape) still dispatches via execute unchanged, regardless of wingName', async () => {
    const executeFn = vi.fn().mockResolvedValue({ done: true });
    const def: ActionGroupDef = {
      name: 'test',
      description: 'Test.',
      coreActions: {
        go: { description: 'go', help: 'Go help.', execute: executeFn },
      },
    };
    const wingCtx: ActionContext = { lair: {}, wingName: 'workshop-01' };

    const result = await dispatchActionGroup(def, { action: 'go' }, wingCtx);

    expect(executeFn).toHaveBeenCalledWith(wingCtx, { action: 'go' });
    expect(result).toEqual({ done: true });
  });

  it('dispatches secondary actions', async () => {
    const executeFn = vi.fn().mockResolvedValue({ repaired: true });
    const def: ActionGroupDef = {
      ...richDef,
      secondaryActions: {
        repair: { description: 'repair', help: 'Repair help.', execute: executeFn },
      },
    };
    const result = await dispatchActionGroup(def, { action: 'repair' }, ctx);
    expect(executeFn).toHaveBeenCalled();
    expect(result).toEqual({ repaired: true });
  });
});

// ---------------------------------------------------------------------------
// InferActionMap / ActionGroupDef<TActionMap>
// ---------------------------------------------------------------------------

describe('InferActionMap and ActionGroupDef<TActionMap>', () => {
  const typedActions = {
    'get-widget': {
      description: 'get a widget',
      help: 'Get help.',
      required: ['id'],
      execute: async (
        _ctx: ActionContext,
        _params: { id: string },
      ): Promise<{ name: string }> => ({ name: 'widget' }),
    },
    'list-widgets': {
      description: 'list widgets',
      help: 'List help.',
      execute: async (_ctx: ActionContext, _params: Record<string, never>): Promise<string[]> => [],
    },
  } satisfies Record<string, ActionDef<Record<string, unknown>, unknown>>;

  type TypedActionMap = InferActionMap<typeof typedActions>;

  it('infers non-never params/result for an action whose required array is populated', () => {
    expectTypeOf<TypedActionMap['get-widget']['params']>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<TypedActionMap['get-widget']['result']>().toEqualTypeOf<{ name: string }>();
    expectTypeOf<TypedActionMap['list-widgets']['params']>().toEqualTypeOf<Record<string, never>>();
    expectTypeOf<TypedActionMap['list-widgets']['result']>().toEqualTypeOf<string[]>();
  });

  it('a well-typed actions object satisfies ActionGroupDef<TActionMap> with no cast', () => {
    const def: ActionGroupDef<TypedActionMap> = {
      name: 'widgets',
      description: 'Manage widgets.',
      coreActions: typedActions,
    };
    expect(def.coreActions['get-widget'].description).toBe('get a widget');
  });

  it('rejects a mismatched-brand param at a mock call site', () => {
    type BrandA = string & { readonly __brand: 'A' };
    type BrandB = string & { readonly __brand: 'B' };

    const brandedActions = {
      'do-thing': {
        description: 'do thing',
        help: 'help',
        required: ['id'],
        execute: async (_ctx: ActionContext, _params: { id: BrandA }): Promise<{ done: true }> => ({ done: true }),
      },
    } satisfies Record<string, ActionDef<Record<string, unknown>, unknown>>;

    type BrandedMap = InferActionMap<typeof brandedActions>;

    function callWithBrandA(params: BrandedMap['do-thing']['params']): void {
      void params;
    }

    const brandB = 'x' as BrandB;
    // @ts-expect-error — BrandB is not assignable where BrandA is expected, even though both are `string`.
    callWithBrandA({ id: brandB });

    expect(brandedActions['do-thing'].description).toBe('do thing');
  });
});

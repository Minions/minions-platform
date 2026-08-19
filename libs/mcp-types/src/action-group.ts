/**
 * ActionGroupDef — a self-describing set of related MCP actions mounted as one tool.
 *
 * A lib defines an ActionGroupDef and exports it. The cabinet calls
 * mcpServer.mountActionGroup(def) — no inline schemas, no action parsing,
 * no help text needed in the cabinet.
 *
 * The framework (this file) handles:
 *   - Assembling the flat JSON schema from per-action and shared params
 *   - Generating the terse tool description (core vs secondary actions)
 *   - Routing action=help to per-action help strings or an auto-generated overview
 *   - Dispatching all other actions to their execute() handler
 */

// ---- Schema types ----

/** Loose JSON Schema property type covering the shapes used in MCP tool definitions. */
export interface JsonSchemaProperty {
  type?: string;
  description?: string;
  enum?: string[];
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  [key: string]: unknown;
}

// ---- Action definition ----

/**
 * Per-call context supplied by the framework to every action's execute().
 *
 * @typeParam TLair  The concrete lair sandbox type (e.g. `Sandbox` from
 *                    `@minions/file-store`). Defaults to `unknown` since
 *                    `mcp-types` has zero `@minions/*` dependencies and
 *                    can't name that type itself — a concrete action group
 *                    (movement, plan, ...) parameterizes its own
 *                    `ActionGroupDef`/`ActionDef` with its real lair type,
 *                    so its `execute`/`resolveWingContext`/etc. get `lair`
 *                    fully typed with no cast. The framework itself only
 *                    ever handles the type-erased `TLair = unknown` form
 *                    (see `MCPServer.mountActionGroup`'s single, documented
 *                    erasure cast) since dispatch is generic over every
 *                    mounted group and never needs the concrete type.
 */
export interface ActionContext<TLair = unknown> {
  /** The lair sandbox. Libs use this to resolve wings, plan stores, etc. */
  lair: TLair;
  /** The wing name for henchery-endpoint requests (from the URL path /mcp/henchery/:wingName).
   *  Undefined on non-henchery endpoints (lair, conductor, throne). */
  wingName?: string;
  /** Additional context fields passed by specific action group dispatchers. */
  [key: string]: unknown;
}

/**
 * Definition of a single action within an ActionGroupDef.
 *
 * @typeParam TParams  The typed params this action accepts (excluding shared params).
 *                     In practice the execute() receives the full flat call params.
 * @typeParam TResult  The typed result this action's execute() resolves to.
 */
export interface ActionDef<
  TParams extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown,
  TLair = unknown,
> {
  /** Terse one-liner shown in the action list inside the tool description. */
  description: string;
  /** Authored full help text — returned verbatim by action=help command=<this>. */
  help: string;
  /** Action-specific params only. Shared params are declared on ActionGroupDef.sharedParams. */
  params?: Record<string, JsonSchemaProperty>;
  /**
   * Which params are required for this action.
   * May include names from sharedParams as well as action-specific params.
   */
  required?: (keyof TParams & string)[];
  execute(context: ActionContext<TLair>, params: TParams): Promise<TResult>;
}

/**
 * Definition of a single action that resolves its working context by
 * *which endpoint it was called on*, instead of branching on raw
 * `ActionContext` fields inside its own body.
 *
 * `atWing` is called when the group's `resolveWingContext` factory can
 * produce a context (i.e. `ActionContext.wingName` is set); `atLair` is
 * called otherwise, via `resolveLairContext`. Both context types are
 * `unknown` here deliberately: `mcp-types` has zero `@minions/*`
 * dependencies, so it cannot know the concrete shape a real action group
 * resolves to (e.g. `WingPerspective`/`LairRepoPerspective` from
 * `@minions/repo-perspective`) — that type safety lives at the concrete
 * action-group module's own call site, via ordinary closure typing over
 * its own `resolveWingContext`/`resolveLairContext` implementations.
 *
 * An action need not declare both hooks — e.g. a wing-only action omits
 * `atLair` and the group omits `resolveLairContext` entirely; dispatching
 * such an action from a non-wing endpoint is then a clear runtime error
 * rather than a silent fallback.
 */
export interface EndpointActionDef<
  TParams extends Record<string, unknown> = Record<string, unknown>,
  TResult = unknown,
> {
  description: string;
  help: string;
  params?: Record<string, JsonSchemaProperty>;
  required?: (keyof TParams & string)[];
  /** Called when this action is invoked at a wing-scoped endpoint (`context.wingName` is set). */
  atWing?(wingContext: unknown, params: TParams): Promise<TResult>;
  /** Called when this action is invoked at a non-wing endpoint (`context.wingName` is undefined). */
  atLair?(lairContext: unknown, params: TParams): Promise<TResult>;
}

/** Erased form used when mixing actions with different TParams/TResult in one group. */
export type AnyActionDef<TLair = unknown> =
  | ActionDef<Record<string, unknown>, unknown, TLair>
  | EndpointActionDef<Record<string, unknown>, unknown>;

function isEndpointActionDef(action: AnyActionDef): action is EndpointActionDef<Record<string, unknown>, unknown> {
  return 'atWing' in action || 'atLair' in action;
}

/**
 * Infers a group's action map — `{ [action]: { params; result } }` — structurally from
 * each action's execute() call signature.
 *
 * Must match only the execute() call signature, not the whole nominal ActionDef interface
 * (e.g. `T[K] extends ActionDef<infer P, infer R>`): ActionDef's TParams also appears in
 * `required?: (keyof TParams & string)[]`, a differently-varianced position, and every real
 * action populates `required`, so matching the whole interface silently collapses `params`
 * to `never`.
 */
export type InferActionMap<T> = {
  [K in keyof T]: T[K] extends {
    execute(context: ActionContext, params: infer P): Promise<infer R>;
  }
    ? { params: P; result: R }
    : never;
};

// ---- Group definition ----

/**
 * A self-describing group of related actions exposed as a single MCP tool.
 * Export one of these from your lib; the cabinet mounts it with mountActionGroup().
 *
 * @typeParam TActionMap  The group's inferred `{ [action]: { params; result } }` map
 *                        (typically `InferActionMap<typeof actions>`). Carried only as a
 *                        phantom marker (`__actionMap`) so a factory's return type can be
 *                        checked against its actions object with no cast, while storage
 *                        (`coreActions`/`secondaryActions`) stays erased — dispatch is
 *                        genuinely dynamic (costume/gadget-provided groups aren't known at
 *                        this type's level).
 */
export interface ActionGroupDef<
  TActionMap = Record<string, { params: unknown; result: unknown }>,
  TLair = unknown,
> {
  /** MCP tool name (e.g. 'movement', 'plan'). */
  name: string;
  /** Terse 1–2 sentence summary of the group. */
  description: string;
  /**
   * Optional short workflow narrative shown in the tool description and help overview.
   * Example: "start → (make changes) → commit → (repeat) → merge"
   */
  workflow?: string;
  /**
   * Params shared across multiple actions — defined once here, referenced by name
   * in each action's required[]. The generated description lists them once with a
   * "required by: A, B, C" annotation in the help overview.
   */
  sharedParams?: Record<string, JsonSchemaProperty>;
  /**
   * Primary actions shown in full in the tool description.
   * These are the ones the AI should use by default.
   */
  coreActions: Record<string, AnyActionDef<TLair>>;
  /**
   * Additional actions mentioned briefly in the description but requiring action=help
   * to learn about. Keeps the default description tight for normal usage.
   */
  secondaryActions?: Record<string, AnyActionDef<TLair>>;
  /**
   * Builds the context passed to any `EndpointActionDef.atWing` in this
   * group, from the raw dispatch context, the `repo` param, and the full
   * call params (for an action like `movement diff` that is mounted on a
   * non-wing endpoint but is still wing-scoped via its own explicit `wing`
   * param instead of `ctx.wingName`). Required if any action in the group
   * declares `atWing`.
   */
  resolveWingContext?(ctx: ActionContext<TLair>, repoRaw: string | undefined, params: Record<string, unknown>): Promise<unknown>;
  /**
   * Builds the context passed to any `EndpointActionDef.atLair` in this
   * group, from the raw dispatch context, the `repo` param, and the full
   * call params. Required if any action in the group declares `atLair`.
   */
  resolveLairContext?(ctx: ActionContext<TLair>, repoRaw: string | undefined, params: Record<string, unknown>): Promise<unknown>;
  /** Phantom marker only — never assigned a real value. Carries TActionMap for type inference. */
  __actionMap?: TActionMap;
}

// ---- Framework utilities ----

function allActions(def: ActionGroupDef): Record<string, AnyActionDef> {
  return { ...def.coreActions, ...def.secondaryActions };
}

/**
 * Build the flat MCP inputSchema for an ActionGroupDef.
 * Merges shared params + core action-specific params into one object schema.
 * Secondary action params are omitted — use action=help to learn about them.
 */
export function buildActionGroupSchema(def: ActionGroupDef): {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
} {
  const coreNames = Object.keys(def.coreActions);
  const secondaryNames = Object.keys(def.secondaryActions ?? {});
  const allNames = [...coreNames, ...secondaryNames, 'help'];

  const properties: Record<string, JsonSchemaProperty> = {
    action: {
      type: 'string',
      enum: allNames,
      description: 'Action to perform. See tool description for details.',
    },
    // help sub-command
    command: {
      type: 'string',
      description: '[help] Action name to get help for. Omit for overview.',
    },
    // shared params
    ...def.sharedParams,
  };

  // Merge core action-specific params only (deduped by name — shared params take precedence)
  for (const action of Object.values(def.coreActions)) {
    for (const [key, schema] of Object.entries(action.params ?? {})) {
      if (!(key in properties)) {
        properties[key] = schema;
      }
    }
  }

  return { type: 'object', properties, required: ['action'] };
}

/**
 * Build the terse tool description string for the MCP tool listing.
 * Shown to the AI as the short description of this tool.
 */
export function buildActionGroupDescription(def: ActionGroupDef): string {
  const lines: string[] = [];

  // Description section
  lines.push('Description:');
  lines.push('');
  lines.push(def.description);
  if (def.workflow) lines.push(`Normal workflow: ${def.workflow}`);
  lines.push('');

  // Actions (CSV) section
  lines.push('Actions (CSV):');
  lines.push('');
  lines.push('Action,Description,Required Parameters,Optional Parameters');
  for (const [name, action] of Object.entries(def.coreActions)) {
    const required = action.required ?? [];
    const optional = Object.keys(action.params ?? {}).filter(p => !required.includes(p));
    const reqStr = required.length > 0 ? `"${required.join(',')}"` : '""';
    const optStr = optional.length > 0 ? `"${optional.join(',')}"` : '""';
    lines.push(`${name},"${action.description}",${reqStr},${optStr}`);
  }
  lines.push('help,"get specific info on a command","","command"');

  const secondaryNames = Object.keys(def.secondaryActions ?? {});
  if (secondaryNames.length > 0) {
    lines.push('');
    lines.push(`Other actions (use help to get calling info): ${secondaryNames.join(', ')}`);
  }

  return lines.join('\n');
}

/**
 * Handle the action=help sub-command.
 * Returns a plain-text help string suitable for the MCP text response.
 */
export function handleActionGroupHelp(def: ActionGroupDef, command?: string): string {
  if (command) {
    const action = allActions(def)[command];
    if (!action) {
      const available = Object.keys(allActions(def)).join(', ');
      return `Unknown action: "${command}". Available actions: ${available}`;
    }
    return action.help;
  }

  // Overview
  const lines: string[] = [`**${def.name}** — ${def.description}`, ''];
  if (def.workflow) {
    lines.push(`Normal workflow: ${def.workflow}`, '');
  }

  lines.push('Core actions:');
  for (const [name, action] of Object.entries(def.coreActions)) {
    lines.push(`  ${name.padEnd(12)}— ${action.description}`);
  }

  const secondaryNames = Object.keys(def.secondaryActions ?? {});
  if (secondaryNames.length > 0) {
    lines.push('');
    lines.push('Secondary actions:');
    for (const [name, action] of Object.entries(def.secondaryActions ?? {})) {
      lines.push(`  ${name.padEnd(12)}— ${action.description}`);
    }
  }

  // Shared params — list once with required-by annotation
  if (def.sharedParams && Object.keys(def.sharedParams).length > 0) {
    lines.push('');
    lines.push('Shared params:');
    const all = allActions(def);
    for (const [paramName, schema] of Object.entries(def.sharedParams)) {
      const requiredBy = Object.entries(all)
        .filter(([, a]) => a.required?.includes(paramName))
        .map(([n]) => n);
      const suffix = requiredBy.length > 0 ? ` (required by: ${requiredBy.join(', ')})` : '';
      lines.push(`  ${paramName}${suffix} — ${schema.description ?? ''}`);
    }
  }

  lines.push('');
  lines.push('Use action=help command=<action> for detailed help on a specific action.');
  return lines.join('\n');
}

/**
 * Dispatch an action=help or action=<name> call to the correct handler.
 * Returns the raw result value (the caller wraps it in MCP content).
 */
export async function dispatchActionGroup<TLair = unknown>(
  def: ActionGroupDef<Record<string, { params: unknown; result: unknown }>, TLair>,
  params: Record<string, unknown>,
  context: ActionContext<TLair>,
): Promise<unknown> {
  const action = params['action'] as string;

  if (action === 'help') {
    const command = params['command'] as string | undefined;
    return { action: 'help', content: handleActionGroupHelp(def, command) };
  }

  const actionDef = allActions(def)[action];
  if (!actionDef) {
    const available = Object.keys(allActions(def)).join(', ');
    throw new Error(`Unknown action "${action}". Available: ${available}`);
  }

  const missing = (actionDef.required ?? []).filter(
    (key) => params[key] === undefined || params[key] === null,
  );
  if (missing.length > 0) {
    throw new Error(
      `Missing required parameter(s) for action "${action}": ${missing.join(', ')}`,
    );
  }

  if (isEndpointActionDef(actionDef)) {
    const repoRaw = params['repo'] as string | undefined;

    const callAtWing = async (atWing: NonNullable<EndpointActionDef['atWing']>) => {
      if (!def.resolveWingContext) {
        throw new Error(`Action group "${def.name}" declares atWing actions but no resolveWingContext`);
      }
      const wingContext = await def.resolveWingContext(context, repoRaw, params);
      return atWing(wingContext, params);
    };
    const callAtLair = async (atLair: NonNullable<EndpointActionDef['atLair']>) => {
      if (!def.resolveLairContext) {
        throw new Error(`Action group "${def.name}" declares atLair actions but no resolveLairContext`);
      }
      const lairContext = await def.resolveLairContext(context, repoRaw, params);
      return atLair(lairContext, params);
    };

    if (context.wingName !== undefined) {
      if (!actionDef.atWing) throw new Error(`Action "${action}" is not available at a wing endpoint`);
      return callAtWing(actionDef.atWing);
    }
    if (actionDef.atLair) return callAtLair(actionDef.atLair);
    // No atLair at all: this action has no lair-scoped meaning, so it isn't
    // really "unavailable outside a wing endpoint" the way an atWing-having
    // action with no atLair would be — it may still resolve a wing from the
    // call's own params (e.g. `movement diff`'s `wing` param) even though
    // this call arrived at a non-wing endpoint. resolveWingContext is the one
    // place responsible for finding that wing name.
    if (actionDef.atWing) return callAtWing(actionDef.atWing);
    throw new Error(`Action "${action}" is not available outside a wing endpoint`);
  }

  return actionDef.execute(context, params);
}

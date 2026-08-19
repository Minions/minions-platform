import type { ActionContext, ActionGroupDef } from '@minions/mcp-types';

/**
 * Worked example for `docs/design/application-tool-sdk.md`, "Piece 3": an
 * external application's own tool interface, hand-authored once and shared
 * by its server-side `ActionGroupDef` (below) and its UI component's props
 * (`MyToolPanelProps`, further below) — no new mechanism, just a plain TS
 * type both halves import. This file lives entirely outside `apps/cabinet`
 * and imports nothing minions-domain-specific (only the generic,
 * domain-agnostic `@minions/mcp-types`), demonstrating that an application
 * can mount a fully custom `ActionGroupDef` into `McpServerCore` with zero
 * dependency on minions.
 */
export interface MyToolApi {
  doThing(params: { id: string }): Promise<{ ok: boolean; echoedId: string }>;
}

type DoThingParams = Parameters<MyToolApi['doThing']>[0];
type DoThingResult = Awaited<ReturnType<MyToolApi['doThing']>>;

/**
 * The server half: an `ActionGroupDef` whose one action's params/result are
 * pinned to `MyToolApi['doThing']` — an external application constructs its
 * own `McpServerCore` and mounts this exactly the way `apps/cabinet` mounts
 * its own built-in groups (`core.mountActionGroup(myToolActionGroup)`).
 */
export const myToolActionGroup: ActionGroupDef = {
  name: 'my-tool',
  description: 'Example application tool with zero minions-domain dependency.',
  coreActions: {
    doThing: {
      description: 'Do the thing for the given id.',
      help: 'my-tool doThing id=<string>',
      params: { id: { type: 'string' } },
      required: ['id'],
      execute: async (_ctx: ActionContext, params: Record<string, unknown>): Promise<DoThingResult> => {
        const { id } = params as unknown as DoThingParams;
        return { ok: true, echoedId: id };
      },
    },
  },
};

/**
 * The UI half: a panel component's props typed directly off the same
 * `MyToolApi` interface the server half implements above — the
 * compile-time client/server pairing this path enables for free. A real
 * application would put this in a sibling `.vue`/`.tsx` file that imports
 * only `MyToolApi`, never `myToolActionGroup` or any server code.
 */
export interface MyToolPanelProps {
  params: Parameters<MyToolApi['doThing']>[0];
  onResult: (result: Awaited<ReturnType<MyToolApi['doThing']>>) => void;
}

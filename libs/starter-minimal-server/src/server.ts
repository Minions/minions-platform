/**
 * Minimal starter for the server half of a Minions Platform application.
 *
 * Copy this file and this package's `package.json` as the starting point
 * for your own cabinet-equivalent server. In your own repo, swap the
 * `workspace:*` dependency this in-repo copy uses for the published SDK
 * range, e.g. `"@minions/platform-sdk": "^0.1.0"`.
 *
 * What this demonstrates, end to end:
 * 1. Construct an `McpServerCore` — your server's session/transport/
 *    action-group mounting core.
 * 2. Mount your own custom `ActionGroupDef` (`helloActionGroup`, below).
 * 3. Bind the standard-core bundle (`movementActionGroup`) so your
 *    application gets minion/mission/movement tools for free, alongside
 *    your own.
 * 4. Expose it over HTTP with Express, the same streamable-HTTP MCP
 *    transport `apps/cabinet` itself uses.
 */
import express from 'express';
import {
  McpServerCore,
  movementActionGroup,
  type ActionContext,
  type ActionGroupDef,
} from '@minions/platform-sdk';

/** Your own tool, hand-authored the same way any built-in costume is. */
export const helloActionGroup: ActionGroupDef = {
  name: 'hello',
  description: 'Example application tool — replace with your own.',
  coreActions: {
    greet: {
      description: 'Greet the given name.',
      help: 'hello greet name=<string>',
      params: { name: { type: 'string' } },
      required: ['name'],
      execute: async (_ctx: ActionContext, params: Record<string, unknown>) => {
        const { name } = params as { name: string };
        return { message: `Hello, ${name}!` };
      },
    },
  },
};

/** Builds the core, with your tools and the standard-core bundle mounted. Exported so the starter's own test can drive it without a real HTTP listener. */
export function buildServerCore(): McpServerCore {
  const core = new McpServerCore(
    { name: 'my-application', version: () => '0.1.0' },
    {
      buildActionContext: () => ({}),
      handleOtherTool: async (name) => {
        throw new Error(`Unhandled tool: ${name}`);
      },
    },
  );

  core.mountActionGroup(helloActionGroup);
  core.mountActionGroup(movementActionGroup);

  return core;
}

/** Wires the core into an Express app on the conventional `/mcp` endpoint. */
export function buildApp(core: McpServerCore = buildServerCore()): express.Express {
  const app = express();
  app.use(express.json());

  app.post('/mcp', (req, res) => {
    void core.handleRequest(req, res, 'all', {});
  });
  app.get('/mcp', (req, res) => {
    void core.handleRequest(req, res, 'all', {});
  });
  app.delete('/mcp', (req, res) => {
    void core.handleRequest(req, res, 'all', {});
  });

  return app;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`;
if (isMain) {
  const port = Number(process.env.PORT ?? 3100);
  buildApp().listen(port, () => {
    console.log(`my-application MCP server listening on :${port}/mcp`);
  });
}

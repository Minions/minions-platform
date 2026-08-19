import { describe, it, expect, vi } from 'vitest';
import { McpServerCore } from '../McpServerCore.js';
import { myToolActionGroup } from './my-tool.js';

/**
 * Drives the worked example end-to-end: an external application constructs
 * its own `McpServerCore`, mounts its own `ActionGroupDef` (defined in
 * `my-tool.ts`, which imports nothing from `apps/cabinet` or any
 * minions-domain package), and dispatches a real call through it — proving
 * the zero-dependency, app-mountable claim concretely rather than only in
 * prose.
 */
describe('worked example: an external application mounting its own ActionGroupDef', () => {
  it('constructs its own core, mounts its own action group, and dispatches a real call through it', async () => {
    const core = new McpServerCore(
      { name: 'my-app-server', version: () => '0.0.1' },
      {
        buildActionContext: () => ({ lair: undefined }),
        handleOtherTool: async (name) => {
          throw new Error(`Unhandled tool: ${name}`);
        },
      },
    );

    core.mountActionGroup(myToolActionGroup);

    const server = core.createServer();
    const handlers = (server as unknown as {
      _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
    })._requestHandlers;
    const handler = handlers.get('tools/call');
    if (!handler) throw new Error('tools/call handler not registered');

    const result = await handler(
      { method: 'tools/call', params: { name: 'my-tool', arguments: { action: 'doThing', id: 'abc' } } },
      { sessionId: undefined, sendNotification: vi.fn().mockResolvedValue(undefined), _meta: {} },
    );

    expect(JSON.parse((result as { content: [{ text: string }] }).content[0].text)).toEqual({
      ok: true,
      echoedId: 'abc',
    });
  });
});

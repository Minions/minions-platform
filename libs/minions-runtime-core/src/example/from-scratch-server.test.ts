import { describe, it, expect, vi } from 'vitest';
import { createInMemorySandbox, createLair } from '@minions/file-store';
import { McpServerCore } from '@minions/mcp-server-core';
import { movementActionGroup } from '../index.js';

/**
 * Drives the acceptance criterion end-to-end: "a from-scratch server
 * instance can bind `libs/minions-runtime-core` alone (no custom tools) and
 * successfully dispatch a minions-standard tool call." An application
 * outside this repo constructs its own `McpServerCore` (from
 * `@minions/mcp-server-core`), mounts the `movementActionGroup` this lib
 * bundles (from `@minions/minions-runtime-core`, not
 * `@minions/movement-branching` directly — proving it's reachable through
 * the bundle), and dispatches a real MCP tool call through it — with zero
 * app-specific wiring, mirroring `@minions/mcp-server-core`'s own
 * `example/my-tool.test.ts` worked example for a custom `ActionGroupDef`.
 */
describe('worked example: a from-scratch application binding minions-runtime-core alone', () => {
  it('constructs its own core, mounts the bundled movement action group with no custom tools, and dispatches a real call through it', async () => {
    const sandbox = createInMemorySandbox();
    const lair = createLair(sandbox);
    const bareRepo = await lair.addWorkRepo('local', 'https://example.com/example/repo.git');
    const seed = await bareRepo.createWorktree(sandbox.root, 'seed', 'main');
    await seed.createFile('README.md', '# v1\n');
    await seed.commitAll('seed');

    await lair.createWing('example-wing', { workLocal: { repo: 'local', branch: 'wip/test' } });

    const core = new McpServerCore(
      { name: 'from-scratch-app', version: () => '0.0.1' },
      {
        buildActionContext: () => ({ lair: sandbox }),
        handleOtherTool: async (name) => {
          throw new Error(`Unhandled tool: ${name}`);
        },
      },
    );

    core.mountActionGroup(movementActionGroup);

    const server = core.createServer();
    const handlers = (server as unknown as {
      _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
    })._requestHandlers;
    const handler = handlers.get('tools/call');
    if (!handler) throw new Error('tools/call handler not registered');

    const result = await handler(
      { method: 'tools/call', params: { name: 'movement', arguments: { action: 'diff', wing: 'example-wing' } } },
      { sessionId: undefined, sendNotification: vi.fn().mockResolvedValue(undefined), _meta: {} },
    );

    const parsed = JSON.parse((result as { content: [{ text: string }] }).content[0].text) as { diff: string };
    expect(typeof parsed.diff).toBe('string');
  });
});

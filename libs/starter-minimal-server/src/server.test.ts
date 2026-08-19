import { describe, it, expect, vi } from 'vitest';
import { buildServerCore, helloActionGroup } from './server.js';

/**
 * Proves the starter template actually works, not just compiles: a
 * from-scratch server built with this file's own `buildServerCore()` can
 * dispatch both a custom application tool (`hello`) and the bundled
 * standard-core tool (`movement`), through the same `McpServerCore`
 * instance an external application would construct after copying this
 * file.
 */
describe('starter minimal server', () => {
  async function callTool(name: string, args: Record<string, unknown>) {
    const core = buildServerCore();
    const server = core.createServer();
    const handlers = (server as unknown as {
      _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
    })._requestHandlers;
    const handler = handlers.get('tools/call');
    if (!handler) throw new Error('tools/call handler not registered');

    return handler(
      { method: 'tools/call', params: { name, arguments: args } },
      { sessionId: undefined, sendNotification: vi.fn().mockResolvedValue(undefined), _meta: {} },
    ) as Promise<{ content: [{ text: string }] }>;
  }

  it('dispatches the custom hello tool mounted alongside the standard core', async () => {
    const result = await callTool('hello', { action: 'greet', name: 'World' });
    expect(JSON.parse(result.content[0].text)).toEqual({ message: 'Hello, World!' });
  });

  it('dispatches the bundled standard-core movement tool through the same server', async () => {
    // `help` is every ActionGroupDef's universal built-in action (see
    // `dispatchActionGroup` in @minions/mcp-types) — the one movement action
    // that needs no real git/wing state, so this proves `movementActionGroup`
    // is genuinely mounted and dispatching through this file's real
    // `McpServerCore` instance, not just present on the object.
    const result = await callTool('movement', { action: 'help' });
    const parsed = JSON.parse(result.content[0].text) as { action: string; content: string };
    expect(parsed.action).toBe('help');
    expect(typeof parsed.content).toBe('string');
  });

  it('mounts the hello action group with the expected shape', () => {
    expect(helloActionGroup.coreActions.greet).toBeDefined();
  });
});

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { Request, Response } from 'express';
import type { ActionGroupDef, ActionContext } from '@minions/mcp-types';
import { McpServerCore, ALL_ENDPOINTS, type McpServerCoreHooks } from './McpServerCore.js';

// ---------------------------------------------------------------------------
// Minimal fake StreamableHTTPServerTransport: real `Server`/`Protocol` wiring
// is exercised as-is (only the transport's own I/O is mocked), so
// `sendLoggingMessage`/session-close plumbing all run for real, they just
// bottom out in a mocked `send`/`close` instead of an actual HTTP response.
// ---------------------------------------------------------------------------
const transportState = vi.hoisted(() => ({
  created: [] as Array<{
    sessionId: string | undefined;
    onclose: (() => void) | undefined;
    send: Mock;
    close: Mock;
    handleRequest: Mock;
  }>,
}));

vi.mock('@modelcontextprotocol/sdk/server/streamableHttp.js', () => ({
  // A named function expression, not an arrow function: `new StreamableHTTPServerTransport(...)`
  // requires the mocked implementation itself be constructible.
  StreamableHTTPServerTransport: vi.fn().mockImplementation(function FakeTransport(
    opts: { sessionIdGenerator?: () => string; onsessioninitialized?: (sid: string) => void },
  ) {
    const transport = {
      sessionId: undefined as string | undefined,
      onclose: undefined as (() => void) | undefined,
      start: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockImplementation(async () => {
        transport.onclose?.();
      }),
      handleRequest: vi.fn().mockImplementation(async (_req: unknown, _res: unknown, body: { method?: string }) => {
        if (body?.method === 'initialize') {
          transport.sessionId = opts.sessionIdGenerator ? opts.sessionIdGenerator() : 'session-1';
          opts.onsessioninitialized?.(transport.sessionId);
        }
      }),
    };
    transportState.created.push(transport);
    return transport;
  }),
}));

interface TestMeta {
  wingName?: string;
}

function makeHooks(overrides: Partial<McpServerCoreHooks<TestMeta>> = {}): McpServerCoreHooks<TestMeta> {
  return {
    buildActionContext: (meta) => ({ lair: 'test-lair', wingName: meta?.wingName }),
    handleOtherTool: async (name) => {
      throw new Error(`Unhandled tool: ${name}`);
    },
    ...overrides,
  };
}

function makeCore(hooks?: Partial<McpServerCoreHooks<TestMeta>>) {
  return new McpServerCore<TestMeta>(
    { name: 'test-server', version: () => '0.0.0' },
    makeHooks(hooks),
  );
}

const echoGroup: ActionGroupDef = {
  name: 'echo',
  description: 'Echoes params back',
  coreActions: {
    say: {
      description: 'Echo a message',
      help: 'echo say message=<text>',
      params: { message: { type: 'string' } },
      required: ['message'],
      execute: async (_ctx: ActionContext, params: Record<string, unknown>) => ({ said: params['message'] }),
    },
  },
};

const initBody = {
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0' },
  },
};

function fakeReqRes(sessionId?: string): { req: Request; res: Response } {
  return {
    req: { headers: sessionId ? { 'mcp-session-id': sessionId } : {}, body: initBody } as unknown as Request,
    res: { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response,
  };
}

/** Grab the `tools/call` handler off a real `Server` instance created by `core.createServer()`. */
function toolCallHandlerOf(server: unknown) {
  const handlers = (server as {
    _requestHandlers: Map<string, (req: unknown, extra: unknown) => Promise<unknown>>;
  })._requestHandlers;
  const handler = handlers.get('tools/call');
  if (!handler) throw new Error('tools/call handler not registered');
  return handler;
}

describe('McpServerCore', () => {
  beforeEach(() => {
    transportState.created.length = 0;
  });

  describe('registerTool + getToolsForEndpoint', () => {
    it('includes a tool with no endpoint restriction on every endpoint', () => {
      const core = makeCore();
      core.registerTool({ name: 'unrestricted', description: '', inputSchema: { type: 'object' } });
      expect(core.getToolsForEndpoint('henchery').map((t) => t.name)).toContain('unrestricted');
      expect(core.getToolsForEndpoint('throne').map((t) => t.name)).toContain('unrestricted');
    });

    it('restricts a tool to its registered endpoints', () => {
      const core = makeCore();
      core.registerTool({ name: 'henchery-only', description: '', inputSchema: { type: 'object' } }, ['henchery']);
      expect(core.getToolsForEndpoint('henchery').map((t) => t.name)).toContain('henchery-only');
      expect(core.getToolsForEndpoint('throne').map((t) => t.name)).not.toContain('henchery-only');
    });

    it('ALL_ENDPOINTS bypasses every restriction', () => {
      const core = makeCore();
      core.registerTool({ name: 'henchery-only', description: '', inputSchema: { type: 'object' } }, ['henchery']);
      expect(core.getToolsForEndpoint(ALL_ENDPOINTS).map((t) => t.name)).toContain('henchery-only');
    });
  });

  describe('mountActionGroup + getToolsForEndpoint', () => {
    it('lists a mounted action group as a tool, filtered by endpoint', () => {
      const core = makeCore();
      core.mountActionGroup(echoGroup, ['henchery']);
      expect(core.getToolsForEndpoint('henchery').map((t) => t.name)).toContain('echo');
      expect(core.getToolsForEndpoint('throne').map((t) => t.name)).not.toContain('echo');
      expect(core.hasActionGroup('echo')).toBe(true);
    });

    it('filters individual actions out of the schema for endpoints they are not permitted on', () => {
      const core = makeCore();
      core.mountActionGroup(echoGroup, ['henchery', 'throne'], { say: ['henchery'] });
      const forThrone = core.getToolsForEndpoint('throne').find((t) => t.name === 'echo');
      expect(forThrone?.description).not.toContain('say');
    });
  });

  describe('CallTool dispatch', () => {
    async function dispatch(core: McpServerCore<TestMeta>, name: string, args: Record<string, unknown>) {
      const server = core.createServer();
      const handler = toolCallHandlerOf(server);
      return handler(
        { method: 'tools/call', params: { name, arguments: args } },
        { sessionId: undefined, sendNotification: vi.fn().mockResolvedValue(undefined), _meta: {} },
      );
    }

    it('dispatches a mounted action group through dispatchActionGroup', async () => {
      const core = makeCore();
      core.mountActionGroup(echoGroup);
      const result = await dispatch(core, 'echo', { action: 'say', message: 'hi' });
      expect(JSON.parse((result as { content: [{ text: string }] }).content[0].text)).toEqual({ said: 'hi' });
    });

    it('extends the base action context per group via extendActionContext', async () => {
      const seen: unknown[] = [];
      const extendedGroup: ActionGroupDef = {
        name: 'ctxcheck',
        description: 'records the context it was called with',
        coreActions: {
          check: {
            description: 'record ctx',
            help: '',
            execute: async (ctx: ActionContext) => {
              seen.push(ctx);
              return { ok: true };
            },
          },
        },
      };
      const core = makeCore({
        extendActionContext: (groupName, base) => ({ ...(base as object), extra: groupName }),
      });
      core.mountActionGroup(extendedGroup);
      await dispatch(core, 'ctxcheck', { action: 'check' });
      expect(seen[0]).toMatchObject({ extra: 'ctxcheck' });
    });

    it('falls through to handleOtherTool for a non-action-group tool', async () => {
      const handleOtherTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'handled' }] });
      const core = makeCore({ handleOtherTool });
      const result = await dispatch(core, 'builtin', { foo: 'bar' });
      expect(handleOtherTool).toHaveBeenCalledWith('builtin', { foo: 'bar' }, expect.anything(), expect.anything());
      expect(result).toEqual({ content: [{ type: 'text', text: 'handled' }] });
    });

    it('runs checkToolAccess and rejects when it throws', async () => {
      const core = makeCore({
        checkToolAccess: () => {
          throw new Error('not allowed here');
        },
      });
      core.mountActionGroup(echoGroup);
      await expect(dispatch(core, 'echo', { action: 'say', message: 'hi' })).rejects.toThrow('not allowed here');
    });
  });

  describe('sessions (unknown session)', () => {
    it('reports ALL_ENDPOINTS and undefined meta for an unknown session', () => {
      const core = makeCore();
      expect(core.getSessionEndpoint('missing')).toBe(ALL_ENDPOINTS);
      expect(core.getSessionMeta('missing')).toBeUndefined();
      expect(core.getSessionCount()).toBe(0);
    });
  });

  describe('session lifecycle (handleRequest-driven)', () => {
    it('populates the session table and fires onSessionInitialized on init, live for getSessionEndpoint/getSessionMeta', async () => {
      const onSessionInitialized = vi.fn();
      const core = makeCore({ onSessionInitialized });
      const { req, res } = fakeReqRes();

      await core.handleRequest(req, res, 'henchery', { wingName: 'wing-a' });

      expect(transportState.created).toHaveLength(1);
      const sid = transportState.created[0]?.sessionId;
      expect(sid).toBeDefined();
      expect(core.getSessionCount()).toBe(1);
      expect(core.getSessionEndpoint(sid)).toBe('henchery');
      expect(core.getSessionMeta(sid)).toEqual({ wingName: 'wing-a' });
      expect(onSessionInitialized).toHaveBeenCalledWith(sid, expect.objectContaining({
        endpoint: 'henchery',
        meta: { wingName: 'wing-a' },
      }));
    });

    it('reuses the existing transport for a follow-up request carrying the session id', async () => {
      const core = makeCore();
      const { req, res } = fakeReqRes();
      await core.handleRequest(req, res, 'henchery', { wingName: 'wing-a' });
      const sid = transportState.created[0]?.sessionId as string;

      const { req: req2, res: res2 } = fakeReqRes(sid);
      req2.body = { method: 'tools/list' };
      await core.handleRequest(req2, res2, 'henchery', { wingName: 'wing-a' });

      // No second transport created — the existing one handled the follow-up request.
      expect(transportState.created).toHaveLength(1);
      expect(transportState.created[0]?.handleRequest).toHaveBeenCalledTimes(2);
    });

    it('removes the session and fires onSessionClosed when the transport closes', async () => {
      const onSessionClosed = vi.fn();
      const core = makeCore({ onSessionClosed });
      const { req, res } = fakeReqRes();
      await core.handleRequest(req, res, 'henchery', { wingName: 'wing-a' });
      const transport = transportState.created[0];
      const sid = transport?.sessionId as string;
      expect(core.getSessionCount()).toBe(1);

      await transport?.close();

      expect(core.getSessionCount()).toBe(0);
      expect(onSessionClosed).toHaveBeenCalledWith(sid);
      expect(core.getSessionEndpoint(sid)).toBe(ALL_ENDPOINTS);
      expect(core.getSessionMeta(sid)).toBeUndefined();
    });
  });

  describe('broadcast', () => {
    async function initSession(core: McpServerCore<TestMeta>, wingName: string) {
      const { req, res } = fakeReqRes();
      const createServerSpy = vi.spyOn(core, 'createServer');
      await core.handleRequest(req, res, 'henchery', { wingName });
      const server = createServerSpy.mock.results[0]?.value;
      createServerSpy.mockRestore();
      const transport = transportState.created[transportState.created.length - 1];
      const sid = transport?.sessionId as string;
      return { sid, server, transport };
    }

    async function registerInterest(server: unknown, sid: string, toolName: string) {
      const handler = toolCallHandlerOf(server);
      await handler(
        { method: 'tools/call', params: { name: toolName, arguments: {} } },
        { sessionId: sid, sendNotification: vi.fn().mockResolvedValue(undefined), _meta: {} },
      );
    }

    it('sends only to sessions interested in the given category', async () => {
      const core = makeCore({
        inferInterestFromTool: (toolName) => (toolName === 'ask' ? 'question' : null),
        handleOtherTool: async () => ({ content: [] }),
      });
      const a = await initSession(core, 'wing-a');
      const b = await initSession(core, 'wing-b');
      await registerInterest(a.server, a.sid, 'ask'); // a is interested in 'question'
      await registerInterest(b.server, b.sid, 'other'); // b is not

      await core.broadcast({ hello: 'world' }, 'question');

      expect(a.transport?.send).toHaveBeenCalled();
      expect(b.transport?.send).not.toHaveBeenCalled();
    });

    it('sends to every session when category is null', async () => {
      const core = makeCore({ handleOtherTool: async () => ({ content: [] }) });
      const a = await initSession(core, 'wing-a');
      const b = await initSession(core, 'wing-b');

      await core.broadcast({ hello: 'world' }, null);

      expect(a.transport?.send).toHaveBeenCalled();
      expect(b.transport?.send).toHaveBeenCalled();
    });

    it('removes a session whose send fails instead of throwing', async () => {
      const onSessionClosed = vi.fn();
      const core = makeCore({ onSessionClosed });
      const a = await initSession(core, 'wing-a');
      const b = await initSession(core, 'wing-b');
      a.transport?.send.mockRejectedValueOnce(new Error('connection reset'));

      await expect(core.broadcast({ hello: 'world' }, null)).resolves.toBeUndefined();

      expect(onSessionClosed).toHaveBeenCalledWith(a.sid);
      expect(core.getSessionCount()).toBe(1);
      expect(core.getSessionEndpoint(b.sid)).toBe('henchery');
    });
  });

  describe('closeAll', () => {
    it('closes every live transport and removes every session', async () => {
      const onSessionClosed = vi.fn();
      const core = makeCore({ onSessionClosed });
      const { req, res } = fakeReqRes();
      await core.handleRequest(req, res, 'henchery', { wingName: 'wing-a' });
      const { req: req2, res: res2 } = fakeReqRes();
      await core.handleRequest(req2, res2, 'lair', { wingName: undefined });
      expect(core.getSessionCount()).toBe(2);
      const [t1, t2] = transportState.created;

      await core.closeAll();

      expect(t1?.close).toHaveBeenCalled();
      expect(t2?.close).toHaveBeenCalled();
      expect(core.getSessionCount()).toBe(0);
      expect(onSessionClosed).toHaveBeenCalledTimes(2);
    });
  });
});

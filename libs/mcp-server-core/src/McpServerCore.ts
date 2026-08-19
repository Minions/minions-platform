import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { Tool, CallToolResult, ServerRequest, ServerNotification, ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';
import type { ActionGroupDef, ActionContext } from '@minions/mcp-types';
import { buildActionGroupSchema, buildActionGroupDescription, dispatchActionGroup } from '@minions/mcp-types';

/** The `extra` argument every MCP request handler receives from the SDK's `Server`. */
export type McpRequestExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/**
 * The single reserved endpoint value meaning "no restriction — every mounted
 * tool/action group is visible and callable regardless of its own endpoint
 * set". Every other endpoint value is opaque to this core; the consuming
 * application defines what its own endpoint names mean.
 */
export const ALL_ENDPOINTS = 'all';

/** Everything the core keeps about one live session, generic over whatever
 *  per-session metadata (e.g. a wing name) the consuming application wants
 *  attached — the core itself never interprets `meta`. */
export interface SessionInfo<TMeta> {
  endpoint: string;
  meta: TMeta;
  transport: StreamableHTTPServerTransport;
  server: Server;
}

interface SessionRecord<TMeta> extends SessionInfo<TMeta> {
  interests: Set<string>;
}

/**
 * The application-supplied behavior a generic `McpServerCore` cannot know on
 * its own — every point where the extracted mounting/dispatch mechanism used
 * to reach directly into minions-specific state now goes through one of
 * these narrow hooks instead. `TMeta` is whatever per-session data the app
 * wants to carry (e.g. `{ wingName }`).
 */
export interface McpServerCoreHooks<TMeta> {
  /** Build the base `ActionContext` object passed to every mounted action group's dispatch for this call. */
  buildActionContext(meta: TMeta | undefined, sessionId: string | undefined): unknown;
  /** Extend the base context for one specific action group by name (e.g. a group that needs extra fields beyond the shared base). Returns `baseContext` unchanged when omitted. */
  extendActionContext?(groupName: string, baseContext: unknown, extra: McpRequestExtra): unknown;
  /** Enforce any endpoint-based access control beyond a mounted action group's own endpoint set (e.g. a static built-in-tool-name-to-endpoint table). Throw to reject the call. */
  checkToolAccess?(toolName: string, sessionEndpoint: string): void;
  /** Handle a `tools/call` for a name that isn't a mounted action group. */
  handleOtherTool(name: string, args: Record<string, unknown>, extra: McpRequestExtra, server: Server): Promise<CallToolResult>;
  /**
   * Produce the final `tools/list` result for one request, given the
   * statically-registered tools/action groups already filtered by endpoint.
   * Combines what used to be separate dynamic filtering (e.g. active-costume
   * gating of gadgets) and extra tools (e.g. proxied external-server tools)
   * into one hook so both can share a single async resolution (e.g. one read
   * of a wing's active-costume config) instead of two. Returns `staticTools`
   * unchanged when omitted.
   */
  resolveTools?(endpoint: string, meta: TMeta | undefined, sessionId: string | undefined, staticTools: Tool[]): Promise<Tool[]>;
  /** Infer a broadcast-interest category from a called tool's name, or `null` for none. */
  inferInterestFromTool?(toolName: string): string | null;
  /** Called once a session finishes initializing. */
  onSessionInitialized?(sessionId: string, info: SessionInfo<TMeta>): void;
  /** Called once a session's transport closes. */
  onSessionClosed?(sessionId: string): void;
}

export interface McpServerCoreOptions {
  /** Server identity reported to clients. `version` is a thunk (not a fixed string) since a
   *  long-lived core is often constructed before the app knows its own version/commit sha, and
   *  a fresh `Server` is created per session anyway. */
  name: string;
  version: () => string;
  /** Extra capabilities beyond `{ tools: {}, logging: {} }`, which are always included. */
  capabilities?: ServerCapabilities;
  /** Human-readable server instructions, built fresh per server instance (a new one is created per session). */
  buildInstructions?: () => string;
  /**
   * How often `tools/call` sends a progress-notification heartbeat while a
   * handler is running, in addition to one fired immediately on receipt.
   * Keep well under the streamable-HTTP idle timeout and the
   * auto-backgrounding threshold so a slow tool never looks dead.
   */
  heartbeatIntervalMs?: number;
}

const DEFAULT_HEARTBEAT_INTERVAL_MS = 90_000;

/**
 * The domain-agnostic half of an MCP server built on `StreamableHTTPServerTransport`:
 * per-session transport/session management, tool + action-group registration
 * and per-endpoint filtering, and the `tools/list`/`tools/call` protocol
 * wiring for the action-group dispatch path. Everything domain-specific
 * (built-in tool dispatch, gadget/proxy fallback, the shape of a session's
 * metadata) is supplied by the consuming application via `McpServerCoreHooks`,
 * never known to this class.
 */
export class McpServerCore<TMeta = unknown> {
  private readonly tools: Tool[] = [];
  private readonly toolEndpoints = new Map<string, Set<string>>();
  private readonly actionGroups = new Map<string, ActionGroupDef>();
  private readonly actionGroupEndpoints = new Map<string, Set<string>>();
  private readonly actionGroupActionEndpoints = new Map<string, Map<string, Set<string>>>();
  private readonly sessions = new Map<string, SessionRecord<TMeta>>();

  constructor(
    private readonly options: McpServerCoreOptions,
    private readonly hooks: McpServerCoreHooks<TMeta>,
  ) {}

  /**
   * Register a tool for `tools/list`/`tools/call`, restricted to the given
   * endpoints when provided. Dispatch for it goes through
   * `hooks.handleOtherTool` — this core never executes a tool itself.
   */
  registerTool(tool: Tool, endpoints?: string[]): void {
    this.tools.push(tool);
    if (endpoints) this.toolEndpoints.set(tool.name, new Set(endpoints));
  }

  /**
   * Mount an `ActionGroupDef` as a single MCP tool. This core assembles the
   * schema and description and dispatches every call through
   * `dispatchActionGroup`; the caller supplies only the def, which endpoints
   * should expose the tool, and optionally which endpoints expose each
   * individual action within the group.
   *
   * @param actionEndpoints Optional per-action endpoint restrictions. When provided for an
   *   action, that action is only documented and callable from the listed endpoints (which
   *   must be a subset of the group-level endpoints). When omitted for an action, the
   *   action inherits the group-level endpoint set.
   */
  mountActionGroup<TLair = unknown>(
    def: ActionGroupDef<Record<string, { params: unknown; result: unknown }>, TLair>,
    endpoints?: string[],
    actionEndpoints?: Partial<Record<string, string[]>>,
  ): void {
    // Type-erase the group's concrete lair type: dispatch is generic over
    // every mounted group (this class never inspects the context's lair
    // itself, it only ever forwards it through), so only the call site
    // authoring `def` needs the concrete type — this is the one place that
    // knowledge is intentionally forgotten.
    this.actionGroups.set(def.name, def as unknown as ActionGroupDef);
    if (endpoints) this.actionGroupEndpoints.set(def.name, new Set(endpoints));
    if (actionEndpoints) {
      const map = new Map<string, Set<string>>();
      for (const [action, eps] of Object.entries(actionEndpoints)) {
        if (eps) map.set(action, new Set(eps));
      }
      this.actionGroupActionEndpoints.set(def.name, map);
    }
  }

  /**
   * The statically-registered tools and action groups visible on the given
   * endpoint — `ALL_ENDPOINTS` bypasses every endpoint restriction. Does not
   * include anything from `hooks.listExtraTools`/`hooks.filterTools`; those
   * are applied by the `tools/list` handler itself.
   */
  getToolsForEndpoint(endpoint: string): Tool[] {
    const result: Tool[] = [];

    for (const t of this.tools) {
      if (endpoint !== ALL_ENDPOINTS) {
        const allowed = this.toolEndpoints.get(t.name);
        if (allowed && !allowed.has(endpoint)) continue;
      }
      result.push(t);
    }

    for (const [name, def] of this.actionGroups) {
      if (endpoint !== ALL_ENDPOINTS) {
        const groupEndpoints = this.actionGroupEndpoints.get(name);
        if (groupEndpoints && !groupEndpoints.has(endpoint)) continue;
      }
      const filteredDef = this.filterActionGroupForEndpoint(def, name, endpoint);
      result.push({
        name: filteredDef.name,
        description: buildActionGroupDescription(filteredDef),
        inputSchema: buildActionGroupSchema(filteredDef),
      });
    }

    return result;
  }

  /** Whether a name is a mounted action group. */
  hasActionGroup(name: string): boolean {
    return this.actionGroups.has(name);
  }

  /**
   * Return a copy of an `ActionGroupDef` with actions not available on the
   * given endpoint removed. When no per-action restrictions are configured,
   * returns the def unchanged.
   */
  private filterActionGroupForEndpoint(def: ActionGroupDef, groupName: string, endpoint: string): ActionGroupDef {
    const actionEpMap = this.actionGroupActionEndpoints.get(groupName);
    if (!actionEpMap) return def;

    const allowed = (actionName: string): boolean => {
      const eps = actionEpMap.get(actionName);
      return !eps || eps.has(endpoint);
    };

    return {
      ...def,
      coreActions: Object.fromEntries(
        Object.entries(def.coreActions).filter(([n]) => allowed(n)),
      ),
      secondaryActions: def.secondaryActions
        ? Object.fromEntries(Object.entries(def.secondaryActions).filter(([n]) => allowed(n)))
        : undefined,
    };
  }

  /** The endpoint a session is talking to, or `ALL_ENDPOINTS` when the session is unknown/absent. */
  getSessionEndpoint(sessionId: string | undefined): string {
    return (sessionId ? this.sessions.get(sessionId)?.endpoint : undefined) ?? ALL_ENDPOINTS;
  }

  /** The metadata a session was initialized with, if it's live. */
  getSessionMeta(sessionId: string | undefined): TMeta | undefined {
    return sessionId ? this.sessions.get(sessionId)?.meta : undefined;
  }

  /** Create a new MCP `Server` instance with `tools/list`/`tools/call` handlers configured. */
  createServer(): Server {
    const server = new Server(
      { name: this.options.name, version: this.options.version() },
      {
        capabilities: { tools: {}, logging: {}, ...this.options.capabilities },
        instructions: this.options.buildInstructions?.(),
      },
    );
    this.setupHandlersOnServer(server);
    return server;
  }

  private setupHandlersOnServer(server: Server): void {
    server.setRequestHandler(ListToolsRequestSchema, async (_request, extra) => {
      const sid = extra.sessionId;
      const endpoint = this.getSessionEndpoint(sid);
      const meta = this.getSessionMeta(sid);
      const staticTools = this.getToolsForEndpoint(endpoint);
      const tools = (await this.hooks.resolveTools?.(endpoint, meta, sid, staticTools)) ?? staticTools;
      return { tools };
    });

    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const heartbeatIntervalMs = this.options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
      const progressToken = extra._meta?.progressToken;
      let heartbeatCount = 0;
      const sendHeartbeat = (): void => {
        if (progressToken === undefined) return;
        heartbeatCount += 1;
        extra.sendNotification({
          method: 'notifications/progress',
          params: { progressToken, progress: heartbeatCount, message: 'working...' },
        }).catch((err: unknown) => {
          console.error('[McpServerCore] Failed to send tool-call heartbeat:', err);
        });
      };
      sendHeartbeat();
      const heartbeatTimer = setInterval(sendHeartbeat, heartbeatIntervalMs);

      try {
        const { name, arguments: args } = request.params;
        const callArgs = (args ?? {}) as Record<string, unknown>;

        if (extra.sessionId) {
          const category = this.hooks.inferInterestFromTool?.(name) ?? null;
          if (category) this.sessions.get(extra.sessionId)?.interests.add(category);
        }

        const sessionEndpoint = this.getSessionEndpoint(extra.sessionId);
        this.hooks.checkToolAccess?.(name, sessionEndpoint);

        const actionGroupDef = this.actionGroups.get(name);
        if (actionGroupDef) {
          if (sessionEndpoint !== ALL_ENDPOINTS) {
            const groupEndpoints = this.actionGroupEndpoints.get(name);
            if (groupEndpoints && !groupEndpoints.has(sessionEndpoint)) {
              throw new Error(`Tool '${name}' is not available on the '${sessionEndpoint}' endpoint`);
            }
            const actionName = callArgs['action'] as string | undefined;
            if (actionName && actionName !== 'help') {
              const actionEpMap = this.actionGroupActionEndpoints.get(name);
              const actionEps = actionEpMap?.get(actionName);
              if (actionEps && !actionEps.has(sessionEndpoint)) {
                throw new Error(`Action '${actionName}' of tool '${name}' is not available on the '${sessionEndpoint}' endpoint`);
              }
            }
          }
          const meta = this.getSessionMeta(extra.sessionId);
          const baseContext = this.hooks.buildActionContext(meta, extra.sessionId);
          const context = this.hooks.extendActionContext?.(name, baseContext, extra) ?? baseContext;
          const result = await dispatchActionGroup(actionGroupDef, callArgs, context as ActionContext);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }

        return await this.hooks.handleOtherTool(name, callArgs, extra, server);
      } finally {
        clearInterval(heartbeatTimer);
      }
    });
  }

  /**
   * Handle an incoming HTTP request (POST, GET, or DELETE), creating
   * per-session transports for proper MCP session management.
   */
  async handleRequest(req: Request, res: Response, endpoint: string, meta: TMeta): Promise<void> {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    const existing = sessionId ? this.sessions.get(sessionId) : undefined;
    if (existing) {
      await existing.transport.handleRequest(req, res, req.body);
      return;
    }

    if (isInitializeRequest(req.body)) {
      const server = this.createServer();

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          const info: SessionInfo<TMeta> = { endpoint, meta, transport, server };
          this.sessions.set(sid, { ...info, interests: new Set() });
          this.hooks.onSessionInitialized?.(sid, info);
        },
        onsessionclosed: (sid) => {
          this.removeSession(sid);
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) this.removeSession(sid);
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (sessionId) {
      res.status(404).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Session not found' },
        id: req.body?.id ?? null,
      });
      return;
    }

    // Stateless mode fallback: handle requests without session ID. This
    // supports simple clients that don't want full session management.
    const statelessTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const statelessServer = this.createServer();
    await statelessServer.connect(statelessTransport);
    await statelessTransport.handleRequest(req, res, req.body);
  }

  /** Broadcast a logging message to every session interested in `category` (or all sessions, when `category` is `null`). */
  async broadcast(data: unknown, category: string | null): Promise<void> {
    const targets: Array<[string, Server]> = [];
    for (const [sid, record] of this.sessions) {
      if (!category || record.interests.has(category)) targets.push([sid, record.server]);
    }

    await Promise.all(
      targets.map(([sessionId, server]) =>
        server.sendLoggingMessage({ level: 'info', data }).catch((err: unknown) => {
          console.error(`[McpServerCore] Broadcast failed for session ${sessionId}, removing session:`, err);
          this.removeSession(sessionId);
        })
      )
    );
  }

  /** Number of live sessions. */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /** Close every active session's transport. */
  async closeAll(): Promise<void> {
    for (const [sessionId, record] of this.sessions) {
      try {
        console.log(`[McpServerCore] Closing transport for session ${sessionId}`);
        await record.transport.close();
      } catch (error) {
        console.error(`[McpServerCore] Error closing transport for session ${sessionId}:`, error);
      } finally {
        this.removeSession(sessionId);
      }
    }
  }

  /**
   * Remove a session from the table and notify `hooks.onSessionClosed`,
   * exactly once — a transport's `close()` and its `onclose` callback can
   * both fire for the same close (confirmed in the underlying
   * `StreamableHTTPServerTransport`), so every removal path funnels through
   * here instead of duplicating the delete-then-notify pair.
   */
  private removeSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return;
    this.sessions.delete(sessionId);
    this.hooks.onSessionClosed?.(sessionId);
  }
}

/**
 * MCP client for calling Cabinet server using @modelcontextprotocol/sdk
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LoggingMessageNotificationSchema, ResultSchema } from '@modelcontextprotocol/sdk/types.js';
import type { ClientRequest } from '@modelcontextprotocol/sdk/types.js';
import type { MCPToolMap, MissionEventRecord, ArchivesListResult } from '@minions/mcp-types';
import type { ThroneToolName, LairToolName, ConductorToolName } from '@minions/mcp-types';
import type { Question } from '../types/question';

// ============================================================================
// Unified Event System with Filtering
// ============================================================================

/**
 * Base structure for all cabinet events
 */
export interface CabinetEvent {
  type: string;
  [key: string]: unknown;
}

/**
 * Filter for subscribing to cabinet events.
 * All specified conditions must match (AND logic).
 * Array values allow multiple options (OR within that field).
 */
export interface EventFilter {
  /** Filter by event type(s) */
  type?: string | string[];
  /** Any other field to filter on */
  [key: string]: unknown;
}

/**
 * Unified event emitter with filter-based subscriptions.
 * Provider applies filters, sending only matching events to consumers.
 */
class CabinetEventEmitter {
  private listeners = new Set<{
    filter: EventFilter;
    callback: (event: CabinetEvent) => void;
  }>();

  /**
   * Subscribe to events matching the filter
   * @param filter - Filter conditions (all must match)
   * @param callback - Called when matching event is received
   * @returns Unsubscribe function
   */
  subscribe<T extends CabinetEvent = CabinetEvent>(
    filter: EventFilter,
    callback: (event: T) => void
  ): () => void {
    const listener = { filter, callback: callback as (event: CabinetEvent) => void };
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Check if event matches filter
   */
  private matches(event: CabinetEvent, filter: EventFilter): boolean {
    for (const [key, filterValue] of Object.entries(filter)) {
      if (filterValue === undefined) continue;

      const eventValue = event[key];

      // Handle array of allowed values (OR within the field)
      if (Array.isArray(filterValue)) {
        if (!filterValue.includes(eventValue)) return false;
      } else {
        if (eventValue !== filterValue) return false;
      }
    }
    return true;
  }

  /**
   * Emit an event to matching subscribers
   */
  emit(event: CabinetEvent): void {
    let matchCount = 0;
    for (const { filter, callback } of this.listeners) {
      if (this.matches(event, filter)) {
        matchCount++;
        callback(event);
      }
    }
    console.log(`[CabinetEvents] Emitted ${event.type}, matched ${matchCount}/${this.listeners.size} listeners`);
  }

  /**
   * Get listener count (for debugging)
   */
  get listenerCount(): number {
    return this.listeners.size;
  }
}

export const cabinetEvents = new CabinetEventEmitter();

// ============================================================================
// Event Type Definitions
// ============================================================================

/**
 * Mission event notification from Cabinet
 */
export interface MissionEventNotification extends CabinetEvent {
  type: 'mission_event';
  missionRunId: string;
  missionName: string;
  costume: string;
  wingName: string;
  event: MissionEventRecord;
}

/**
 * Question event notification from Cabinet
 */
export interface QuestionEventNotification extends CabinetEvent {
  type: 'question_added' | 'question_answered' | 'question_cancelled';
  question: Question;
}

/**
 * Minion event notification from Cabinet
 */
export interface MinionEventNotification extends CabinetEvent {
  type: 'minion_spawned' | 'minion_killed' | 'minion_status_changed';
  minionId: string;
  wingName: string;
  status?: string;
  client?: string;
}

// ============================================================================
// Legacy Emitters (for backward compatibility)
// ============================================================================

/**
 * @deprecated Use cabinetEvents.subscribe({ type: 'mission_event' }, callback) instead
 */
class MissionEventEmitter {
  subscribe(missionRunId: string, callback: (event: MissionEventRecord) => void): () => void {
    return cabinetEvents.subscribe<MissionEventNotification>(
      { type: 'mission_event', missionRunId },
      (notification) => callback(notification.event)
    );
  }

  subscribeAll(callback: (notification: MissionEventNotification) => void): () => void {
    return cabinetEvents.subscribe<MissionEventNotification>(
      { type: 'mission_event' },
      callback
    );
  }

  emit(notification: MissionEventNotification): void {
    cabinetEvents.emit(notification);
  }
}

export const missionEvents = new MissionEventEmitter();

/**
 * @deprecated Use cabinetEvents.subscribe({ type: ['question_added', ...] }, callback) instead
 */
class QuestionEventEmitter {
  subscribe(callback: (notification: QuestionEventNotification) => void): () => void {
    return cabinetEvents.subscribe<QuestionEventNotification>(
      { type: ['question_added', 'question_answered', 'question_cancelled'] },
      callback
    );
  }

  emit(notification: QuestionEventNotification): void {
    cabinetEvents.emit(notification);
  }
}

export const questionEvents = new QuestionEventEmitter();

/**
 * Determine the Cabinet URL:
 * 1. Use VITE_CABINET_URL if explicitly set (for development or custom configs)
 * 2. In production (served from cabinet), use current origin
 * 3. Fallback to localhost:3000 for development
 */
export function getCabinetUrl(): string {
  // If explicitly set, use that
  if (import.meta.env.VITE_CABINET_URL) {
    return import.meta.env.VITE_CABINET_URL;
  }

  // Any Vite dev server port (5xxx on localhost) → point at the dev cabinet on 3000
  if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
    const port = parseInt(window.location.port, 10);
    if (port >= 5000 && port < 6000) {
      return import.meta.env.VITE_DEV_CABINET_URL ?? 'http://localhost:3000';
    }
  }

  // Served from cabinet (production) — use current origin
  return typeof window !== 'undefined' ? window.location.origin : 'http://localhost:3000';
}

const CABINET_URL = getCabinetUrl();

/**
 * Make a REST call to the Cabinet server.
 * Used for endpoints that are not exposed as MCP tools (e.g. GitHub auth flow).
 */
export async function callCabinetREST<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const res = await fetch(`${CABINET_URL}${path}`, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'include',
  });
  if (res.status === 204) return undefined as unknown as T;
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    throw new Error(text || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// ============================================================================
// Throne Client (primary - handles notifications)
// ============================================================================

let mcpClient: Client | null = null;
let clientPromise: Promise<Client> | null = null;

/**
 * Get or create the singleton throne MCP client.
 * The throne client is also responsible for receiving server-pushed notifications.
 */
async function getMCPClient(): Promise<Client> {
  if (mcpClient) {
    return mcpClient;
  }

  // Prevent multiple concurrent initializations
  if (clientPromise) {
    return clientPromise;
  }

  clientPromise = (async () => {
    console.log('[Throne-Room] Creating MCP client...');
    const client = new Client(
      {
        name: 'throne-room',
        version: '0.0.1',
      },
      {
        capabilities: {},
      }
    );

    console.log('[Throne-Room] Creating transport to:', CABINET_URL);
    const transport = new StreamableHTTPClientTransport(
      new URL(`${CABINET_URL}/mcp/throne`),
      {
        // Enable credentials for cross-origin session management
        requestInit: {
          credentials: 'include',
        },
      }
    );

    console.log('[Throne-Room] Connecting client to transport...');
    try {
      await client.connect(transport);
      console.log('[Throne-Room] Client connected successfully');
    } catch (err) {
      console.error('[Throne-Room] Client connection failed:', err);
      throw err;
    }

    // Set up global notification handler for server-pushed events
    // All events flow through the unified cabinetEvents system
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      const data = notification.params.data as CabinetEvent | undefined;
      if (data?.type) {
        console.log('[Throne-Room] Received event:', data.type);
        cabinetEvents.emit(data);
      }
    });

    console.log('[Throne-Room] MCP client connected and notification handler set up');

    mcpClient = client;
    clientPromise = null;
    return client;
  })();

  return clientPromise;
}

// ============================================================================
// Lair Client
// ============================================================================

let lairMcpClient: Client | null = null;
let lairClientPromise: Promise<Client> | null = null;

async function getLairMCPClient(): Promise<Client> {
  if (lairMcpClient) return lairMcpClient;
  if (lairClientPromise) return lairClientPromise;
  lairClientPromise = (async () => {
    const client = new Client({ name: 'throne-room-lair', version: '0.0.1' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${CABINET_URL}/mcp/lair`),
      { requestInit: { credentials: 'include' } }
    );
    await client.connect(transport);
    lairMcpClient = client;
    lairClientPromise = null;
    return client;
  })();
  return lairClientPromise;
}

// ============================================================================
// Conductor Client
// ============================================================================

let conductorMcpClient: Client | null = null;
let conductorClientPromise: Promise<Client> | null = null;

async function getConductorMCPClient(): Promise<Client> {
  if (conductorMcpClient) return conductorMcpClient;
  if (conductorClientPromise) return conductorClientPromise;
  conductorClientPromise = (async () => {
    const client = new Client({ name: 'throne-room-conductor', version: '0.0.1' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${CABINET_URL}/mcp/conductor`),
      { requestInit: { credentials: 'include' } }
    );
    await client.connect(transport);
    conductorMcpClient = client;
    conductorClientPromise = null;
    return client;
  })();
  return conductorClientPromise;
}

// ============================================================================
// Per-wing Henchery Clients (for branch overlay plan reads)
// ============================================================================

const wingMcpClients = new Map<string, Client>();
const wingClientPromises = new Map<string, Promise<Client>>();

async function getWingMCPClient(wingName: string): Promise<Client> {
  const existing = wingMcpClients.get(wingName);
  if (existing) return existing;

  const inFlight = wingClientPromises.get(wingName);
  if (inFlight) return inFlight;

  const promise = (async () => {
    const client = new Client({ name: `throne-room-wing-${wingName}`, version: '0.0.1' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${CABINET_URL}/mcp/henchery/${encodeURIComponent(wingName)}`),
      { requestInit: { credentials: 'include' } }
    );
    await client.connect(transport);
    wingMcpClients.set(wingName, client);
    wingClientPromises.delete(wingName);
    return client;
  })();

  wingClientPromises.set(wingName, promise);
  return promise;
}

/**
 * Raw MCP tool call to a wing's henchery endpoint.
 * Reads plan data from the wing's branch (contextual: list-roots/get-subtree
 * return the wing's plan store when called this way).
 */
export async function callMCPHenchery<T>(wingName: string, toolName: string, args: Record<string, unknown>): Promise<T> {
  const client = await getWingMCPClient(wingName);
  const result = await client.callTool({ name: toolName, arguments: args });
  const content = result?.content as Array<{ type: string; text?: string }> | undefined;
  if (content?.[0]?.text) {
    return JSON.parse(content[0].text) as T;
  }
  return result as unknown as T;
}

// ============================================================================
// Generic protocol helpers (use throne client)
// ============================================================================

/**
 * Generic MCP protocol call using SDK client
 */
export async function callMCPMethod<T>(method: string, params?: Record<string, unknown>): Promise<T> {
  const client = await getMCPClient();

  // Use the client's request method for generic protocol calls
  const result = await client.request(
    { method, params: params || {} } as ClientRequest,
    ResultSchema
  );

  return result as T;
}

/**
 * List all available MCP tools
 */
export interface MCPToolInputSchema {
  type?: string;
  properties?: Record<string, { type?: string; description?: string }>;
  required?: string[];
}

export async function listTools(): Promise<Array<{
  name: string;
  description?: string;
  inputSchema: MCPToolInputSchema;
}>> {
  const client = await getMCPClient();
  const result = await client.listTools();
  return result.tools as Array<{ name: string; description?: string; inputSchema: MCPToolInputSchema }>;
}

/**
 * List all available MCP prompts
 */
export async function listPrompts(): Promise<Array<{
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}>> {
  const client = await getMCPClient();
  const result = await client.listPrompts();
  return (result.prompts || []) as Array<{ name: string; description?: string; arguments?: Array<{ name: string; description?: string; required?: boolean }> }>;
}

/**
 * List all available MCP resources
 */
export async function listResources(): Promise<Array<{
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}>> {
  const client = await getMCPClient();
  const result = await client.listResources();
  return result.resources || [];
}

// ============================================================================
// Type-safe per-endpoint call functions
// ============================================================================

/**
 * Type-safe MCP tool call to the throne endpoint.
 * Throne tools: lair_get_state, minions, missions, ask, review
 */
export async function callMCPThrone<K extends ThroneToolName>(
  toolName: K,
  args: MCPToolMap[K]['params']
): Promise<MCPToolMap[K]['result']> {
  const client = await getMCPClient(); // throne client
  const result = await client.callTool({
    name: toolName as string,
    arguments: args as Record<string, unknown>
  });
  const content = result?.content as Array<{ type: string; text?: string }> | undefined;
  if (content?.[0]?.text) {
    return JSON.parse(content[0].text) as MCPToolMap[K]['result'];
  }
  return result as unknown as MCPToolMap[K]['result'];
}

/**
 * Type-safe MCP tool call to the lair endpoint.
 * Lair tools: archives
 * Action-group tools (use callMCPLairRaw): costumes
 */
export async function callMCPLair<K extends LairToolName>(
  toolName: K,
  args: MCPToolMap[K]['params']
): Promise<MCPToolMap[K]['result']> {
  const client = await getLairMCPClient();
  const result = await client.callTool({
    name: toolName as string,
    arguments: args as Record<string, unknown>
  });
  const content = result?.content as Array<{ type: string; text?: string }> | undefined;
  if (content?.[0]?.text) {
    return JSON.parse(content[0].text) as MCPToolMap[K]['result'];
  }
  return result as unknown as MCPToolMap[K]['result'];
}

/**
 * Raw MCP tool call to the throne endpoint for action-group tools (e.g. "plan").
 * Use this when the tool is not in ThroneToolName (action groups are mounted separately).
 */
export async function callMCPThroneRaw<T>(toolName: string, args: Record<string, unknown>): Promise<T> {
  const client = await getMCPClient();
  const result = await client.callTool({ name: toolName, arguments: args });
  const content = result?.content as Array<{ type: string; text?: string }> | undefined;
  if (content?.[0]?.text) {
    return JSON.parse(content[0].text) as T;
  }
  return result as unknown as T;
}

/**
 * Raw MCP tool call to the lair endpoint for action-group tools (e.g. "costumes").
 * Use this when the tool is not in LairToolName (action groups are mounted separately).
 */
export async function callMCPLairRaw<T>(toolName: string, args: Record<string, unknown>): Promise<T> {
  const client = await getLairMCPClient();
  const result = await client.callTool({ name: toolName, arguments: args });
  const content = result?.content as Array<{ type: string; text?: string }> | undefined;
  if (content?.[0]?.text) {
    return JSON.parse(content[0].text) as T;
  }
  return result as unknown as T;
}

// ============================================================================
// Lair-registered work repo names (for non-wing plan reads)
// ============================================================================

let workRepoNamesPromise: Promise<string[]> | null = null;

/**
 * Names of every lair-registered work repo (from the `archives` lair tool),
 * cached for the session. The plan tool has no server-side default `repo`
 * for non-wing resolution (e.g. the MAIN plan view, which has no wing to
 * alias "local" through) — a lair can register any number of work repos with
 * no natural "the" one among them, so callers must pass `repo` explicitly.
 * This is the shared source of truth for which repo names to pass.
 */
export async function getWorkRepoNames(): Promise<string[]> {
  if (!workRepoNamesPromise) {
    workRepoNamesPromise = callMCPLair('archives', { action: 'list' })
      .then((result) => (result as unknown as ArchivesListResult).archives
        .filter((a) => a.type === 'work')
        .map((a) => a.name))
      .catch((e) => { workRepoNamesPromise = null; throw e; });
  }
  return workRepoNamesPromise;
}

/**
 * Type-safe MCP tool call to the conductor endpoint.
 * Conductor tools: wings, minions, missions, plan, demos_list
 */
export async function callMCPConductor<K extends ConductorToolName>(
  toolName: K,
  args: MCPToolMap[K]['params']
): Promise<MCPToolMap[K]['result']> {
  const client = await getConductorMCPClient();
  const result = await client.callTool({
    name: toolName as string,
    arguments: args as unknown as Record<string, unknown>
  });
  const content = result?.content as Array<{ type: string; text?: string }> | undefined;
  if (content?.[0]?.text) {
    return JSON.parse(content[0].text) as MCPToolMap[K]['result'];
  }
  return result as unknown as MCPToolMap[K]['result'];
}

// ============================================================================
// Streaming event support
// ============================================================================

/**
 * Streaming event for MCP tool calls
 */
export interface StreamingEvent {
  type: 'content' | 'user_message' | 'error' | 'complete';
  data?: unknown;
}

/**
 * Conductor MCP tool call with streaming callback support via logging notifications.
 *
 * Used for minions send_message which produces streaming output.
 * Subscribes to the throne client's notification stream while calling
 * through the conductor client.
 */
export async function callMCPStreamingConductor<K extends ConductorToolName>(
  toolName: K,
  args: MCPToolMap[K]['params'],
  onEvent: (event: StreamingEvent) => void
): Promise<MCPToolMap[K]['result']> {
  // Ensure throne client is connected for event subscription
  await getMCPClient();

  const unsubscribe = cabinetEvents.subscribe(
    { type: ['content', 'user_message', 'error'] },
    (event: CabinetEvent) => {
      if (event.type === 'content') {
        onEvent({ type: 'content', data: (event as Record<string, unknown>).content });
      } else if (event.type === 'user_message') {
        onEvent({ type: 'user_message', data: (event as Record<string, unknown>).content });
      } else if (event.type === 'error') {
        onEvent({ type: 'error', data: (event as Record<string, unknown>).error });
      }
    }
  );

  try {
    const client = await getConductorMCPClient();
    const result = await client.callTool({
      name: toolName as string,
      arguments: args as unknown as Record<string, unknown>
    });

    onEvent({ type: 'complete' });

    const content = result?.content as Array<{ type: string; text?: string }> | undefined;
    if (content?.[0]?.text) {
      return JSON.parse(content[0].text) as MCPToolMap[K]['result'];
    }
    return result as unknown as MCPToolMap[K]['result'];
  } catch (error) {
    onEvent({ type: 'error', data: error });
    throw error;
  } finally {
    unsubscribe();
  }
}

/**
 * Legacy generic type-safe MCP tool call.
 * Kept for backward compatibility during transition.
 * New code should use callMCPThrone, callMCPLair, or callMCPConductor.
 */
export async function callMCP<K extends keyof MCPToolMap>(
  toolName: K,
  args: MCPToolMap[K]['params']
): Promise<MCPToolMap[K]['result']> {
  const client = await getMCPClient();

  const result = await client.callTool({
    name: toolName as string,
    arguments: args as Record<string, unknown>
  });

  // Parse result - MCP tools return content array with text
  const content = result?.content as Array<{ type: string; text?: string }> | undefined;
  if (content?.[0]?.text) {
    return JSON.parse(content[0].text) as MCPToolMap[K]['result'];
  }

  return result as unknown as MCPToolMap[K]['result'];
}

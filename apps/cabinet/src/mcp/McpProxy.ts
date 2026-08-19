/**
 * McpProxy — cabinet-side MCP client that connects to external MCP servers
 * declared in costume accessories and proxies their tools to wings.
 *
 * Connection strategy:
 *   - http/sse configs → StreamableHTTPClientTransport (preferred for network servers)
 *   - sse configs → SSEClientTransport (legacy SSE-only servers)
 *   - stdio configs → StdioClientTransport
 *
 * One client per server name; connections are reused across requests.
 * Tool names are namespaced as `<serverName>__<toolName>` to avoid collisions.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { McpServerConfig } from '@minions/costumes';
import type { SharedBrowserProvider } from '../browser/SharedBrowserService.js';

export const SERVER_NAME_SEPARATOR = '__';

/**
 * The cabinet-managed external server whose stdio connection is bound to the lair's
 * shared verification browser. The cabinet (as the proxy) owns this binding: when it
 * connects this server it resolves the running shared Chrome and supplies
 * `--browserUrl <url> --experimentalPageIdRouting`. Costumes declare the server as a
 * plain stdio command; they do not opt in or supply the URL.
 */
export const SHARED_BROWSER_SERVER_NAME = 'chrome-devtools-mcp';

/** Build the proxied tool name: `<serverName>__<toolName>` */
export function prefixedToolName(serverName: string, toolName: string): string {
  return `${serverName}${SERVER_NAME_SEPARATOR}${toolName}`;
}

/** Extract the original tool name from a prefixed proxy name */
export function unpackToolName(serverName: string, prefixedName: string): string {
  const prefix = `${serverName}${SERVER_NAME_SEPARATOR}`;
  if (!prefixedName.startsWith(prefix)) {
    throw new Error(`Tool name '${prefixedName}' does not have expected prefix '${prefix}'`);
  }
  return prefixedName.slice(prefix.length);
}

/** CDP routing flag: makes every page-scoped tool carry a `pageId` so wings get
 *  separate tabs on the shared browser with concurrent, non-blocking calls. */
const PAGE_ID_ROUTING_FLAG = '--experimentalPageIdRouting';

/**
 * Return a copy of `config` with the shared verification browser's connection
 * args appended: `--browserUrl <browserUrl> --experimentalPageIdRouting`. Pure
 * and idempotent — re-applying does not duplicate either flag. Used by the proxy
 * when it connects the cabinet-managed browser server (see SHARED_BROWSER_SERVER_NAME)
 * so it attaches to the cabinet's lair-shared Chrome.
 */
export function injectSharedBrowserArgs(
  config: McpServerConfig,
  browserUrl: string
): McpServerConfig {
  const args = config.args ? [...config.args] : [];
  if (!args.includes('--browserUrl')) {
    args.push('--browserUrl', browserUrl);
  }
  if (!args.includes(PAGE_ID_ROUTING_FLAG)) {
    args.push(PAGE_ID_ROUTING_FLAG);
  }
  return { ...config, args };
}

interface Connection {
  client: Client;
}

/**
 * Cabinet proxy for external MCP servers declared in costume accessories.
 * Maintains one persistent connection per server name.
 */
export class McpProxy {
  private readonly connections = new Map<string, Connection>();
  /** Resolves the lair's shared verification browser for the cabinet-managed browser server. */
  private sharedBrowser?: SharedBrowserProvider;

  /**
   * Provide the shared-browser service so that the cabinet-managed browser server
   * (SHARED_BROWSER_SERVER_NAME) gets `--browserUrl <url> --experimentalPageIdRouting`
   * injected at connect time. Called by the cabinet once the service exists.
   */
  setSharedBrowser(provider: SharedBrowserProvider): void {
    this.sharedBrowser = provider;
  }

  /**
   * Ensure a connection to the named MCP server exists.
   * If already connected, this is a no-op.
   */
  async ensureConnected(serverName: string, config: McpServerConfig): Promise<void> {
    if (this.connections.has(serverName)) return;

    const client = new Client(
      { name: 'cabinet', version: '0.0.1' },
      { capabilities: {} }
    );

    const effectiveConfig = await this.applySharedBrowser(serverName, config);
    const transport = buildTransport(effectiveConfig);
    await client.connect(transport);

    this.connections.set(serverName, { client });
  }

  /**
   * Cabinet-owned browser binding: for the shared-browser server (stdio), resolve the
   * running shared Chrome and supply its connection args. Other servers pass through
   * unchanged. Because the cabinet is the proxy, this is also the natural place to add
   * further per-connection policy later (advertise/deny specific tools, restrict URLs).
   */
  private async applySharedBrowser(
    serverName: string,
    config: McpServerConfig
  ): Promise<McpServerConfig> {
    if (serverName !== SHARED_BROWSER_SERVER_NAME || config.type !== 'stdio' || !this.sharedBrowser) {
      return config;
    }
    const { browserUrl } = await this.sharedBrowser.ensureRunning();
    return injectSharedBrowserArgs(config, browserUrl);
  }

  /**
   * List all tools from a connected server, with names prefixed by `<serverName>__`.
   * Returns an empty array if the server is not connected.
   */
  async listTools(serverName: string): Promise<Tool[]> {
    const connection = this.connections.get(serverName);
    if (!connection) return [];

    const result = await connection.client.listTools();
    return result.tools.map((t) => ({
      ...t,
      name: prefixedToolName(serverName, t.name),
    }));
  }

  /**
   * Call a tool on a connected server.
   * `prefixedName` must be in the form `<serverName>__<toolName>`.
   * Throws if the server is not connected.
   */
  async callTool(
    serverName: string,
    prefixedName: string,
    args: Record<string, unknown>
  ): Promise<unknown> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      throw new Error(`MCP server '${serverName}' is not connected`);
    }

    const toolName = unpackToolName(serverName, prefixedName);
    return connection.client.callTool({ name: toolName, arguments: args });
  }

  /**
   * Close the connection for a single server and remove it.
   * No-op if the server is not connected.
   */
  async disconnect(serverName: string): Promise<void> {
    const connection = this.connections.get(serverName);
    if (!connection) return;
    this.connections.delete(serverName);
    await connection.client.close();
  }

  /**
   * Close all active connections.
   */
  async disconnectAll(): Promise<void> {
    await Promise.all(
      [...this.connections.keys()].map((name) => this.disconnect(name))
    );
  }

  /** The set of currently connected server names */
  get connectedServers(): ReadonlySet<string> {
    return new Set(this.connections.keys());
  }
}

// ---------------------------------------------------------------------------

function buildTransport(
  config: McpServerConfig
): Parameters<Client['connect']>[0] {
  if (config.type === 'http') {
    if (!config.url) throw new Error('MCP server config of type "http" requires a url');
    return new StreamableHTTPClientTransport(new URL(config.url));
  }
  if (config.type === 'sse') {
    if (!config.url) throw new Error('MCP server config of type "sse" requires a url');
    return new SSEClientTransport(new URL(config.url));
  }
  // stdio
  if (!config.command) throw new Error('MCP server config of type "stdio" requires a command');
  return new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: config.env,
  });
}

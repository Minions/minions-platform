import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServerConfig } from '@minions/costumes';

// ---------------------------------------------------------------------------
// Minimal mock of the MCP SDK Client
// ---------------------------------------------------------------------------
const mockListTools = vi.fn();
const mockCallTool = vi.fn();
const mockConnect = vi.fn();
const mockClose = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(function Client() {
    return {
      connect: mockConnect,
      close: mockClose,
      listTools: mockListTools,
      callTool: mockCallTool,
    };
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(function StreamableHTTPClientTransport() {
    return {};
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => ({
  SSEClientTransport: vi.fn().mockImplementation(function SSEClientTransport() {
    return {};
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation(function StdioClientTransport() {
    return {};
  }),
}));

// Import after mocks are set up
const { McpProxy, injectSharedBrowserArgs } = await import('../McpProxy.js');

// ---------------------------------------------------------------------------

const httpConfig: McpServerConfig = { type: 'http', url: 'http://localhost:8931/sse' };
const sseConfig: McpServerConfig = { type: 'sse', url: 'http://localhost:9000/sse' };
const stdioConfig: McpServerConfig = {
  type: 'stdio',
  command: 'npx',
  args: ['@modelcontextprotocol/server-node-debug'],
};

describe('McpProxy', () => {
  let proxy: InstanceType<typeof McpProxy>;

  beforeEach(() => {
    proxy = new McpProxy();
    vi.clearAllMocks();
    mockConnect.mockResolvedValue(undefined);
    mockClose.mockResolvedValue(undefined);
    mockListTools.mockResolvedValue({ tools: [] });
    mockCallTool.mockResolvedValue({ content: [] });
  });

  describe('ensureConnected', () => {
    it('connects to an http server using StreamableHTTPClientTransport', async () => {
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
      await proxy.ensureConnected('playwright', httpConfig);
      if (!httpConfig.url) throw new Error('httpConfig.url must be set for this test');
      expect(StreamableHTTPClientTransport).toHaveBeenCalledWith(new URL(httpConfig.url));
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it('connects to an sse server using SSEClientTransport', async () => {
      const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
      await proxy.ensureConnected('sse-server', sseConfig);
      if (!sseConfig.url) throw new Error('sseConfig.url must be set for this test');
      expect(SSEClientTransport).toHaveBeenCalledWith(new URL(sseConfig.url));
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it('connects to a stdio server using StdioClientTransport', async () => {
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      await proxy.ensureConnected('debugger', stdioConfig);
      expect(StdioClientTransport).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'npx', args: ['@modelcontextprotocol/server-node-debug'] })
      );
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    it('does not reconnect if already connected', async () => {
      await proxy.ensureConnected('playwright', httpConfig);
      await proxy.ensureConnected('playwright', httpConfig);
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('ensureConnected with shared browser injection', () => {
    // A real in-process fake of SharedBrowserProvider — no mocking framework.
    function fakeSharedBrowser(browserUrl = 'http://127.0.0.1:9333') {
      return {
        calls: 0,
        async ensureRunning() {
          this.calls += 1;
          return { browserUrl, reused: false };
        },
      };
    }

    const chromeConfig: McpServerConfig = {
      type: 'stdio',
      command: 'cmd',
      args: ['/c', 'npx', '-y', 'chrome-devtools-mcp@1.3.0'],
    };

    it('binds the shared-browser server (by name) to the resolved browserUrl', async () => {
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      const browser = fakeSharedBrowser('http://127.0.0.1:9333');
      proxy.setSharedBrowser(browser);

      await proxy.ensureConnected('chrome-devtools-mcp', chromeConfig);

      expect(browser.calls).toBe(1);
      expect(StdioClientTransport).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'cmd',
          args: [
            '/c', 'npx', '-y', 'chrome-devtools-mcp@1.3.0',
            '--browserUrl', 'http://127.0.0.1:9333',
            '--experimentalPageIdRouting',
          ],
        })
      );
    });

    it('leaves other servers untouched and does not resolve the browser for them', async () => {
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      const browser = fakeSharedBrowser();
      proxy.setSharedBrowser(browser);

      await proxy.ensureConnected('debugger', stdioConfig);

      expect(browser.calls).toBe(0);
      expect(StdioClientTransport).toHaveBeenCalledWith(
        expect.objectContaining({ args: ['@modelcontextprotocol/server-node-debug'] })
      );
    });

    it('connects without injection (no throw) when no provider is set', async () => {
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      await proxy.ensureConnected('chrome-devtools-mcp', chromeConfig);

      expect(StdioClientTransport).toHaveBeenCalledWith(
        expect.objectContaining({ args: ['/c', 'npx', '-y', 'chrome-devtools-mcp@1.3.0'] })
      );
      expect(mockConnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('listTools', () => {
    it('returns tools from a connected server, prefixed with serverName__', async () => {
      mockListTools.mockResolvedValue({
        tools: [
          { name: 'browser_click', description: 'Click', inputSchema: { type: 'object', properties: {} } },
          { name: 'browser_navigate', description: 'Nav', inputSchema: { type: 'object', properties: {} } },
        ],
      });
      await proxy.ensureConnected('playwright', httpConfig);
      const tools = await proxy.listTools('playwright');
      expect(tools).toHaveLength(2);
      expect(tools[0].name).toBe('playwright__browser_click');
      expect(tools[1].name).toBe('playwright__browser_navigate');
    });

    it('returns empty array when server is not connected', async () => {
      const tools = await proxy.listTools('unknown');
      expect(tools).toEqual([]);
    });
  });

  describe('callTool', () => {
    it('calls the underlying tool with unprefixed name', async () => {
      mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
      await proxy.ensureConnected('playwright', httpConfig);
      const result = await proxy.callTool('playwright', 'playwright__browser_click', { x: 10, y: 20 });
      expect(mockCallTool).toHaveBeenCalledWith({ name: 'browser_click', arguments: { x: 10, y: 20 } });
      expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }] });
    });

    it('throws when server is not connected', async () => {
      await expect(proxy.callTool('unknown', 'unknown__tool', {})).rejects.toThrow(
        "MCP server 'unknown' is not connected"
      );
    });
  });

  describe('disconnect', () => {
    it('closes the client and removes the connection', async () => {
      await proxy.ensureConnected('playwright', httpConfig);
      await proxy.disconnect('playwright');
      expect(mockClose).toHaveBeenCalledTimes(1);
      // After disconnect, listTools returns empty
      const tools = await proxy.listTools('playwright');
      expect(tools).toEqual([]);
    });

    it('is a no-op for unknown server names', async () => {
      await expect(proxy.disconnect('unknown')).resolves.toBeUndefined();
      expect(mockClose).not.toHaveBeenCalled();
    });
  });

  describe('disconnectAll', () => {
    it('closes all connected servers', async () => {
      await proxy.ensureConnected('playwright', httpConfig);
      await proxy.ensureConnected('debugger', stdioConfig);
      await proxy.disconnectAll();
      expect(mockClose).toHaveBeenCalledTimes(2);
    });
  });
});

describe('injectSharedBrowserArgs', () => {
  const base: McpServerConfig = {
    type: 'stdio',
    command: 'cmd',
    args: ['/c', 'npx', '-y', 'chrome-devtools-mcp@1.3.0', '--no-usage-statistics'],
  };

  it('appends --browserUrl and --experimentalPageIdRouting to the args tail', () => {
    const out = injectSharedBrowserArgs(base, 'http://127.0.0.1:9333');
    expect(out.args).toEqual([
      '/c', 'npx', '-y', 'chrome-devtools-mcp@1.3.0', '--no-usage-statistics',
      '--browserUrl', 'http://127.0.0.1:9333',
      '--experimentalPageIdRouting',
    ]);
  });

  it('preserves all other config fields and does not mutate the input', () => {
    const input: McpServerConfig = { ...base, env: { FOO: 'bar' }, sharedBrowser: true };
    const out = injectSharedBrowserArgs(input, 'http://127.0.0.1:9555');
    expect(out.type).toBe('stdio');
    expect(out.command).toBe('cmd');
    expect(out.env).toEqual({ FOO: 'bar' });
    // input untouched
    expect(input.args).toEqual(base.args);
  });

  it('handles a config with no args', () => {
    const out = injectSharedBrowserArgs({ type: 'stdio', command: 'cmd' }, 'http://127.0.0.1:9333');
    expect(out.args).toEqual(['--browserUrl', 'http://127.0.0.1:9333', '--experimentalPageIdRouting']);
  });

  it('is idempotent — does not duplicate flags when applied twice', () => {
    const once = injectSharedBrowserArgs(base, 'http://127.0.0.1:9333');
    const twice = injectSharedBrowserArgs(once, 'http://127.0.0.1:9333');
    expect(twice.args).toEqual(once.args);
  });
});

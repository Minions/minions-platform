import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { callMCPThrone, callMCPMethod, listTools, listPrompts, listResources } from './cabinet';

// Define mock client interface with vitest mock types
interface MockClient {
  connect: Mock;
  callTool: Mock;
  listTools: Mock;
  listPrompts: Mock;
  listResources: Mock;
  request: Mock;
  setNotificationHandler: Mock;
}

// Mock the MCP SDK
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
  const mockClient: MockClient = {
    connect: vi.fn().mockResolvedValue(undefined),
    callTool: vi.fn(),
    listTools: vi.fn(),
    listPrompts: vi.fn(),
    listResources: vi.fn(),
    request: vi.fn(),
    setNotificationHandler: vi.fn(),
  };

  return {
    Client: vi.fn(function Client() {
      return mockClient;
    }),
  };
});

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
  return {
    StreamableHTTPClientTransport: vi.fn(function StreamableHTTPClientTransport() {
      return {};
    }),
  };
});

vi.mock('@modelcontextprotocol/sdk/types.js', () => {
  return {
    LoggingMessageNotificationSchema: { shape: { method: { value: 'notifications/message' } } },
    ResultSchema: {},
  };
});

// Import after mocking to get the mocked version
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

describe('MCP Client', () => {
  let mockClientInstance: MockClient;

  beforeEach(() => {
    vi.clearAllMocks();
    // Get the mock client instance
    mockClientInstance = new Client({ name: 'test', version: '1.0.0' }, {}) as unknown as MockClient;
  });

  afterEach(() => {
    // Reset the singleton client between tests
    vi.resetModules();
  });

  it('calls SDK callTool with correct parameters', async () => {
    const mockResult = {
      content: [{ type: 'text', text: JSON.stringify([]) }]
    };

    mockClientInstance.callTool.mockResolvedValue(mockResult);

    await callMCPThrone('lair_get_state', {});

    expect(mockClientInstance.callTool).toHaveBeenCalledWith({
      name: 'lair_get_state',
      arguments: {}
    });
  });

  it('parses result from MCP SDK response', async () => {
    const mockDistricts = [
      { name: 'wing-1', root: '/path/1' },
      { name: 'wing-2', root: '/path/2' }
    ];

    mockClientInstance.callTool.mockResolvedValue({
      content: [{ type: 'text', text: JSON.stringify(mockDistricts) }]
    });

    const result = await callMCPThrone('lair_get_state', {});

    expect(result).toEqual(mockDistricts);
  });

  it('handles result without text content', async () => {
    const mockResult = { someField: 'value' };

    mockClientInstance.callTool.mockResolvedValue(mockResult);

    const result = await callMCPThrone('lair_get_state', {});

    expect(result).toEqual(mockResult);
  });

  it('callMCPMethod makes generic MCP protocol calls', async () => {
    const mockTools = [
      { name: 'tool1', description: 'Test tool', inputSchema: {} }
    ];

    mockClientInstance.request.mockResolvedValue({ tools: mockTools });

    const result = await callMCPMethod('tools/list', {});

    expect(result).toEqual({ tools: mockTools });
    expect(mockClientInstance.request).toHaveBeenCalledWith(
      {
        method: 'tools/list',
        params: {}
      },
      expect.anything()
    );
  });

  it('listTools fetches available tools', async () => {
    const mockTools = [
      { name: 'lair_get_state', description: 'Get lair state', inputSchema: {} },
      { name: 'wings', description: 'Manage wings', inputSchema: {} }
    ];

    mockClientInstance.listTools.mockResolvedValue({ tools: mockTools });

    const tools = await listTools();

    expect(tools).toEqual(mockTools);
    expect(tools).toHaveLength(2);
  });

  it('listPrompts fetches available prompts', async () => {
    const mockPrompts = [
      { name: 'test_prompt', description: 'A test prompt' }
    ];

    mockClientInstance.listPrompts.mockResolvedValue({ prompts: mockPrompts });

    const prompts = await listPrompts();

    expect(prompts).toEqual(mockPrompts);
  });

  it('listResources fetches available resources', async () => {
    const mockResources = [
      { uri: 'file:///test', name: 'Test Resource' }
    ];

    mockClientInstance.listResources.mockResolvedValue({ resources: mockResources });

    const resources = await listResources();

    expect(resources).toEqual(mockResources);
  });

  it('listPrompts returns empty array when no prompts', async () => {
    mockClientInstance.listPrompts.mockResolvedValue({ prompts: [] });

    const prompts = await listPrompts();

    expect(prompts).toEqual([]);
  });
});

#!/usr/bin/env node

/**
 * MCP Client
 *
 * A reusable HTTP client for making requests to MCP servers.
 * Handles session management and request/response processing.
 */

import http from 'http';

export class MCPClient {
  constructor(options = {}) {
    this.hostname = options.hostname || 'localhost';
    this.port = options.port || 3000;
    this.path = options.path || '/mcp/conductor';
    this.sessionId = null;
  }

  /**
   * Make a request to the MCP server
   * @param {Object} requestData - The JSON-RPC request data
   * @returns {Promise<Object>} The response with result and sessionId
   */
  async makeRequest(requestData) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify(requestData);

      const options = {
        hostname: this.hostname,
        port: this.port,
        path: this.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          'Accept': 'application/json, text/event-stream'
        }
      };

      if (this.sessionId) {
        options.headers['mcp-session-id'] = this.sessionId;
      }

      const req = http.request(options, (res) => {
        let body = '';

        res.on('data', (chunk) => {
          body += chunk;
        });

        res.on('end', () => {
          const newSessionId = res.headers['mcp-session-id'];
          if (newSessionId) {
            this.sessionId = newSessionId;
          }

          try {
            // Handle SSE format (event: message\ndata: {...})
            let jsonBody = body;
            if (body.startsWith('event:')) {
              // Parse SSE format - extract the data line
              const lines = body.split('\n');
              for (const line of lines) {
                if (line.startsWith('data:')) {
                  jsonBody = line.substring(5).trim();
                  break;
                }
              }
            }
            const result = JSON.parse(jsonBody);
            resolve({ result, sessionId: this.sessionId });
          } catch (error) {
            reject(new Error(`Failed to parse response: ${error.message}\nBody: ${body}`));
          }
        });
      });

      req.on('error', (error) => {
        reject(new Error(`Request failed: ${error.message}`));
      });

      req.write(data);
      req.end();
    });
  }

  /**
   * Initialize an MCP session
   * @param {Object} clientInfo - Information about the client
   * @returns {Promise<Object>} The initialization result
   */
  async initialize(clientInfo = {}) {
    const initRequest = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {
          roots: { listChanged: false },
          sampling: {}
        },
        clientInfo: {
          name: clientInfo.name || 'mcp-client',
          version: clientInfo.version || '1.0.0'
        }
      }
    };

    const { result } = await this.makeRequest(initRequest);

    if (result.error) {
      throw new Error(`Initialization failed: ${result.error.message}`);
    }

    return result;
  }

  /**
   * Call an MCP tool
   * @param {string} toolName - The name of the tool to call
   * @param {Object} toolArgs - The arguments for the tool
   * @param {number} requestId - The JSON-RPC request ID
   * @returns {Promise<Object>} The tool result
   */
  async callTool(toolName, toolArgs = {}, requestId = Date.now()) {
    const toolRequest = {
      jsonrpc: '2.0',
      id: requestId,
      method: 'tools/call',
      params: {
        name: toolName,
        arguments: toolArgs
      }
    };

    const { result } = await this.makeRequest(toolRequest);

    if (result.error) {
      throw new Error(`Tool call failed: ${result.error.message}`);
    }

    // Parse the tool result if it's JSON text content
    if (result.result?.content?.[0]?.type === 'text') {
      try {
        return JSON.parse(result.result.content[0].text);
      } catch {
        return result.result.content[0].text;
      }
    }

    return result.result;
  }

  /**
   * Get the current session ID
   * @returns {string|null} The session ID or null if not initialized
   */
  getSessionId() {
    return this.sessionId;
  }
}

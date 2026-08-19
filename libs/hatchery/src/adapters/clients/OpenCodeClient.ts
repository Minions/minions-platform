import { spawn, type ChildProcess } from 'child_process';
import type { IMinionClient } from '../../ports/IMinionClient';
import type { MinionSpec, MinionMessage, UserMessage, TextMessage, StatusMessage, ErrorMessage } from '@minions/domain-types';
import { parseJsonSafely } from '../../utils/parseJsonSafely';
import type { Lair, File } from '@minions/file-store';
import { parseWingNameFromPath } from '@minions/file-store';

/**
 * Shape of the JSON body returned by POST /session.
 *
 * This is untrusted external HTTP response JSON, so
 * isOpenCodeSessionResponse() verifies this shape at runtime before use.
 */
interface OpenCodeSessionResponse {
  id?: string;
}

function isOpenCodeSessionResponse(value: unknown): value is OpenCodeSessionResponse {
  return typeof value === 'object' && value !== null;
}

/**
 * Shape of the JSON body returned by POST /session/:id/message.
 *
 * OpenCode response format:
 * {
 *   info: { id, role, modelID, error?, ... },
 *   parts: [{ type: 'text', text: 'content' }],
 *   blocked: false,
 *   shouldRetry: false
 * }
 *
 * This is untrusted external HTTP response JSON, so
 * isOpenCodeMessageResponse() verifies this shape at runtime before use.
 */
interface OpenCodeMessageResponse {
  parts?: Array<{ type: string; text?: string }>;
  info?: { error?: unknown };
}

function isOpenCodeMessageResponse(value: unknown): value is OpenCodeMessageResponse {
  return typeof value === 'object' && value !== null;
}

/**
 * OpenCode client implementation
 *
 * Spawns `opencode serve` process and communicates via HTTP REST API.
 * Uses POST /session/:id/message for bidirectional communication.
 *
 * Session Persistence:
 * - Creates session via POST /session on first start()
 * - Preserves sessionId across stop/start cycles (e.g., during reconfigure)
 * - Server maintains session state, so reusing sessionId preserves conversation history
 * - Only resets session if explicitly cleared
 *
 * Architecture:
 * 1. Spawn `opencode serve` subprocess on available port
 * 2. Create or reuse session via POST /session
 * 3. Send messages via POST /session/:id/message
 * 4. Receive responses synchronously from POST response
 */
export class OpenCodeClient implements IMinionClient {
  readonly type = 'opencode';

  private process: ChildProcess | null = null;
  private messageQueue: MinionMessage[] = [];
  private messageResolvers: Array<(value: IteratorResult<MinionMessage>) => void> = [];
  private sessionId: string | null = null;
  private baseUrl: string | null = null;
  private port: number | null = null;
  private configFile: File | null = null;
  private shouldPreserveSession = false;
  private lair: Lair;

  constructor(lair: Lair) {
    this.lair = lair;
  }


  async start(spec: MinionSpec): Promise<void> {
    if (this.process) {
      throw new Error('Client already started');
    }

    // Parse wing name from spec.wing path and get Wing object
    const wingName = parseWingNameFromPath(spec.wing);
    const wingResult = await this.lair.wing(wingName);
    if (!wingResult.exists) {
      throw new Error(`Wing not found: ${wingName}`);
    }
    const wing = wingResult.wing;

    // Get work/local directory from Wing via the design-doc-§4.2 `WorkArea`
    // surface — `workAreaLocal()` throws instead of returning
    // `{ exists: false }`. Still writes without committing — deliberately
    // out of scope for this function to change.
    let workLocal;
    try {
      const workArea = await wing.workAreaLocal();
      workLocal = (await workArea.activeMovement()).files;
    } catch {
      throw new Error(`work/local not found for wing: ${wingName}`);
    }

    // Create opencode config file with just model
    const modelString = spec.model || 'opencode/gpt-5-nano';
    const configContent = {
      "$schema": "https://opencode.ai/config.json",
      model: modelString,
    };

    try {
      // Get or create config file in work/local
      const configChildResult = await workLocal.child('opencode.jsonc');
      let configFile: File;
      if (configChildResult.found) {
        configFile = configChildResult.node as File;
      } else {
        configFile = await workLocal.createFile('opencode.jsonc');
      }

      await configFile.write(JSON.stringify(configContent, null, '\t'));
      this.configFile = configFile;
    } catch (error) {
      throw new Error(`Failed to create OpenCode config file: ${error}`);
    }

    // Let opencode choose its own port
    // We'll parse it from stdout when it reports "opencode server listening on http://..."

    // Spawn opencode serve without specifying port
    this.process = spawn(
      'opencode',
      ['serve'],
      {
        cwd: spec.wing,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
      }
    );

    // Captured in a local const so the callbacks below narrow to a non-null
    // ChildProcess regardless of what this.process is reassigned to later.
    const childProcess = this.process;

    childProcess.on('exit', () => {
      this.completeAllIterators();
    });

    childProcess.on('error', (error) => {
      console.error('[OpenCodeClient] Process error:', error);
      this.completeAllIterators();
    });

    // Create a promise to wait for port detection
    const portDetected = new Promise<void>((resolve, reject) => {
      let portFound = false;

      // Capture stdout - parse for port, then send as status messages
      if (childProcess.stdout) {
        childProcess.stdout.on('data', (data) => {
          const content = data.toString();

          // Split by newlines in case multiple lines come in one chunk
          const lines = content.split('\n');

          for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;

            // Check for port announcement: "opencode server listening on http://127.0.0.1:PORT"
            if (!portFound) {
              const portMatch = trimmedLine.match(/opencode server listening on http:\/\/127\.0\.0\.1:(\d+)/);
              if (portMatch) {
                this.port = parseInt(portMatch[1], 10);
                this.baseUrl = `http://127.0.0.1:${this.port}`;
                portFound = true;
                resolve();
              }
            }

            const statusMessage: StatusMessage = {
              type: 'status',
              status: trimmedLine,
              timestamp: Date.now(),
              metadata: { source: 'stdout' },
            };
            this.enqueueMessage(statusMessage);
          }
        });
      }

      // Capture stderr - send as error messages
      if (childProcess.stderr) {
        childProcess.stderr.on('data', (data) => {
          const content = data.toString();
          const lines = content.split('\n');

          for (const line of lines) {
            const trimmedLine = line.trim();
            if (!trimmedLine) continue;

            const errorMessage: ErrorMessage = {
              type: 'error',
              error: {
                message: trimmedLine,
                code: 'stderr',
              },
              timestamp: Date.now(),
              metadata: { source: 'stderr' },
            };
            this.enqueueMessage(errorMessage);
          }
        });
      }

      // Handle process exit before port is detected
      childProcess.on('exit', () => {
        if (!portFound) {
          reject(new Error('OpenCode process exited before port was detected'));
        }
      });

      // Add timeout for port detection
      setTimeout(() => {
        if (!portFound) {
          reject(new Error('Timeout waiting for OpenCode to report port'));
        }
      }, 10000); // 10 second timeout
    });

    // Wait for port to be detected
    await portDetected;

    if (!this.process || this.process.exitCode !== null) {
      throw new Error('OpenCode server failed to start');
    }

    // Wait for server to be ready
    await this.waitForServerReady();

    if (!this.process || this.process.exitCode !== null) {
      throw new Error('OpenCode server failed to start');
    }

    // Create session only if we don't have one to preserve, or reuse existing
    if (!this.shouldPreserveSession || !this.sessionId) {
      await this.createSession();
      this.shouldPreserveSession = true; // Enable preservation for subsequent restarts
    }
    // If shouldPreserveSession is true and sessionId exists, we reuse the existing session
  }

  async stop(): Promise<void> {
    if (this.process && this.process.pid) {
      // On Windows, we need to kill the entire process tree
      if (process.platform === 'win32') {
        try {
          const { execSync } = await import('child_process');
          execSync(`taskkill /pid ${this.process.pid} /T /F`, { stdio: 'ignore' });
        } catch {
          // Process may already be dead, ignore error
        }
      } else {
        this.process.kill();
      }
      this.process = null;
    }
    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    // Delete config file if it exists
    if (this.configFile) {
      try {
        const exists = await this.configFile.exists();
        if (exists) {
          await this.configFile.delete();
        }
      } catch (error) {
        console.error('[OpenCodeClient] Failed to delete config file:', error);
      }
    }

    // Reset state (but preserve sessionId if shouldPreserveSession is true)
    this.configFile = null;
    if (!this.shouldPreserveSession) {
      this.sessionId = null;
    }
    this.baseUrl = null;
    this.port = null;
    this.completeAllIterators();
  }

  async send(message: MinionMessage): Promise<void> {
    if (!(await this.isClientAlive())) {
      throw new Error('Client not running');
    }

    // Only support user messages
    if (message.type === 'user') {
      const userMsg = message as UserMessage;

      // Send message to OpenCode via HTTP POST
      const url = `${this.baseUrl}/session/${this.sessionId}/message`;

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            parts: [
              {
                type: 'text',
                text: userMsg.content,
              },
            ],
          }),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        // Get response text and safely parse as JSON
        const responseText = await response.text();
        const { parsed } = parseJsonSafely(responseText);

        // Use parsed JSON if available, otherwise wrap raw text
        const data = parsed || {
          parts: responseText.trim() ? [{
            type: 'text',
            text: responseText
          }] : []
        };

        // Convert response to MinionMessage
        const responseMessage = this.convertToMinionMessage(data);
        if (responseMessage) {
          this.enqueueMessage(responseMessage);
        }
      } catch (error) {
        console.error('[OpenCodeClient] Failed to send message:', error);
        throw error;
      }
    } else {
      console.warn('[OpenCodeClient] Only user messages supported for sending');
    }
  }

  async *receive(): AsyncIterableIterator<MinionMessage> {
    while ((await this.isClientAlive()) || this.messageQueue.length > 0) {
      if (this.messageQueue.length > 0) {
        const message = this.messageQueue.shift();
        if (message) {
          yield message;
        }
      } else if (await this.isClientAlive()) {
        // Wait for next message
        const result = await new Promise<IteratorResult<MinionMessage>>((resolve) => {
          this.messageResolvers.push(resolve);
        });
        if (!result.done) {
          yield result.value;
        } else {
          break;
        }
      }
    }
  }

  kill(): void {
    if (this.process && this.process.pid) {
      // On Windows, we need to kill the entire process tree
      if (process.platform === 'win32') {
        try {
          const { execSync } = require('child_process');
          execSync(`taskkill /pid ${this.process.pid} /T /F`, { stdio: 'ignore' });
        } catch {
          // Process may already be dead, ignore error
        }
      } else {
        this.process.kill('SIGKILL');
      }
      this.process = null;
    }
    // Fire and forget cleanup (kill() is synchronous by design)
    this.cleanup().catch((error) => {
      console.error('[OpenCodeClient] Cleanup error during kill:', error);
    });
  }

  interrupt(): void {
    // For OpenCode, we can try to cancel the current session or send interrupt signal
    // For now, we'll send SIGINT to the process
    if (this.process) {
      this.process.kill('SIGINT');
    }
  }

  /**
   * Check if the client is alive by verifying:
   * 1. Process exists and hasn't exited
   * 2. Server responds to health check (GET /agent - lightweight, doesn't hit LLM)
   */
  private async isClientAlive(): Promise<boolean> {
    // Check if process exists and hasn't exited
    if (!this.process || this.process.exitCode !== null) {
      return false;
    }

    // Check if we have session and base URL
    if (!this.sessionId || !this.baseUrl) {
      return false;
    }

    // Ping the server with a lightweight endpoint
    try {
      const response = await fetch(`${this.baseUrl}/agent`, {
        method: 'GET',
        signal: AbortSignal.timeout(1000) // 1 second timeout
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Wait for OpenCode server to be ready by polling the /agent endpoint
   */
  private async waitForServerReady(maxAttempts = 30, delayMs = 100): Promise<void> {
    if (!this.baseUrl) {
      throw new Error('Base URL not set - port not detected');
    }

    for (let i = 0; i < maxAttempts; i++) {
      try {
        // Use /agent endpoint which is lighter weight and doesn't hit the LLM
        const response = await fetch(`${this.baseUrl}/agent`, { method: 'GET' });
        // Accept any response (200, 500, etc.) - just need the server to respond
        // The fact that we got a response means the server is running
        if (response.status) {
          return; // Server is ready (responded to request)
        }
      } catch {
        // Server not ready yet (connection refused), continue waiting
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    throw new Error('OpenCode server failed to become ready');
  }

  /**
   * Create a new session via POST /session
   */
  private async createSession(): Promise<void> {
    if (!this.baseUrl) {
      throw new Error('Base URL not set');
    }

    const url = `${this.baseUrl}/session`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: 'Hatchery Minion Session',
          // Note: Do NOT pass model parameter here - let OpenCode use the model from config file
          // Passing model here can cause issues with provider resolution
        }),
      });

      if (!response.ok) {
        throw new Error(`Failed to create session: HTTP ${response.status}`);
      }

      const data: unknown = await response.json();
      this.sessionId = isOpenCodeSessionResponse(data) ? (data.id ?? null) : null;

      if (!this.sessionId) {
        throw new Error('Session ID not returned from server');
      }
    } catch (error) {
      console.error('[OpenCodeClient] Failed to create session:', error);
      throw error;
    }
  }

  /**
   * Convert OpenCode response to MinionMessage
   *
   * OpenCode response format:
   * {
   *   info: { id, role, modelID, ... },
   *   parts: [{ type: 'text', text: 'content' }],
   *   blocked: false,
   *   shouldRetry: false
   * }
   */
  private convertToMinionMessage(data: unknown): MinionMessage | null {
    const timestamp = Date.now();

    if (!isOpenCodeMessageResponse(data)) {
      return null;
    }

    // OpenCode returns parts array with response content
    if (Array.isArray(data.parts)) {
      // Iterate through parts to find text content
      for (const part of data.parts) {
        if (part && part.type === 'text' && part.text) {
          const textMessage: TextMessage = {
            type: 'text',
            content: part.text,
            timestamp,
          };
          return textMessage;
        }
      }
    }

    // Check for errors in response
    if (data.info && data.info.error) {
      console.warn('[OpenCodeClient] API returned error:', data.info.error);
    }

    return null;
  }

  private enqueueMessage(message: MinionMessage): void {
    const resolver = this.messageResolvers.shift();
    if (resolver) {
      resolver({ done: false, value: message });
    } else {
      this.messageQueue.push(message);
    }
  }

  private completeAllIterators(): void {
    let resolver = this.messageResolvers.shift();
    while (resolver) {
      resolver({ done: true, value: undefined });
      resolver = this.messageResolvers.shift();
    }
  }
}

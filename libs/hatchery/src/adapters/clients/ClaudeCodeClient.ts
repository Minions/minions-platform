import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { IMinionClient } from '../../ports/IMinionClient';
import type { MinionSpec, MinionMessage, UserMessage, TextMessage, StatusMessage, ErrorMessage } from '@minions/domain-types';
import * as readline from 'readline';
import { parseJsonSafely } from '../../utils/parseJsonSafely';
import { randomUUID } from 'crypto';

/**
 * Shape of a parsed line from Claude CLI's stream-json output.
 *
 * This is a partial description of the protocol - only the fields
 * convertToMinionMessage() actually reads. The CLI's output is untrusted
 * external JSON, so isClaudeStreamJsonMessage() verifies this shape at
 * runtime before any field is accessed.
 */
interface ClaudeStreamJsonMessage {
  type: string;
  message?: {
    content?: Array<{ type: string; text?: string }>;
  };
  result?: string;
}

function isClaudeStreamJsonMessage(value: unknown): value is ClaudeStreamJsonMessage {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}

/**
 * Locate the claude binary, preferring the native installer's default path so
 * that the auto-updater can find and replace it correctly. Falls back to PATH
 * for cases where claude was installed some other way.
 */
function findClaudePath(): string {
  const candidates: string[] =
    process.platform === 'win32'
      ? [
          // Native installer default on Windows
          join(process.env['LOCALAPPDATA'] ?? '', 'AnthropicClaude', 'claude.exe'),
        ]
      : [
          // Native installer default on macOS / Linux
          join(homedir(), '.local', 'bin', 'claude'),
        ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Fall back to bare name — Node's spawn will search PATH
  return 'claude';
}

/**
 * Claude Code CLI client implementation
 *
 * Spawns the `claude` CLI process and communicates via stream-json protocol.
 * Uses bidirectional stream-json format for communication.
 *
 * Session Persistence:
 * - Generates a unique session ID on first start()
 * - Passes --session-id to Claude CLI to persist conversation history
 * - Reuses the same session ID on subsequent start() calls (e.g., after reconfigure)
 * - This ensures conversation history is preserved across client restarts
 *
 * Input format: { type: "user", message: { role: "user", content: "..." } }
 * Output format: Newline-delimited JSON with type: "system", "assistant", "result", etc.
 */
export class ClaudeCodeClient implements IMinionClient {
  readonly type = 'claude-code';

  private process: ChildProcess | null = null;
  private messageQueue: MinionMessage[] = [];
  private messageResolvers: Array<(value: IteratorResult<MinionMessage>) => void> = [];
  private isAlive = false;
  private sessionId: string | null = null;

  async start(spec: MinionSpec): Promise<void> {
    if (this.process) {
      throw new Error('Client already started');
    }

    this.isAlive = true;

    // Session ID priority: spec-provided > reuse existing (reconfigure) > generate fresh
    this.sessionId = spec.sessionId ?? this.sessionId ?? randomUUID();

    // Build command line arguments from spec
    const args = this.buildCliArgs(spec);

    // Spawn claude with bidirectional stream-json.
    // findClaudePath() checks the native installer's default location first so
    // we don't depend on the binary being on PATH, and so auto-updates keep working.
    this.process = spawn(
      findClaudePath(),
      args,
      {
        cwd: spec.wing,
        stdio: ['pipe', 'pipe', 'pipe'],
      }
    );

    if (!this.process.stdout || !this.process.stdin) {
      throw new Error('Failed to create stdio streams');
    }

    // Set up stdout parser for newline-delimited JSON
    const rl = readline.createInterface({
      input: this.process.stdout,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      if (!line.trim()) return;

      // Parse the line - always get raw string, optionally get parsed JSON
      const {  raw, parsed } = parseJsonSafely(line);

      // Emit one status message with raw string and optionally parsed JSON
      const metadata: Record<string, unknown> = { source: 'stdout' };
      if (parsed) {
        metadata['parsed'] = parsed;
      }
      const statusMessage: StatusMessage = {
        type: 'status',
        status: raw,
        timestamp: Date.now(),
        metadata,
      };
      this.enqueueMessage(statusMessage);

      // If we have parsed JSON, also emit the converted message type
      if (parsed) {
        const message = this.convertToMinionMessage(parsed);
        if (message) {
          this.enqueueMessage(message);
        }
      }
    });

    // Capture stderr - send as error messages for complete transcript
    if (this.process.stderr) {
      this.process.stderr.on('data', (data) => {
        const content = data.toString().trim();
        if (content) {
          const errorMessage: ErrorMessage = {
            type: 'error',
            error: {
              message: content,
              code: 'stderr',
            },
            timestamp: Date.now(),
            metadata: { source: 'stderr' },
          };
          this.enqueueMessage(errorMessage);
        }
      });
    }

    // Handle process exit
    this.process.on('exit', () => {
      this.isAlive = false;
      this.completeAllIterators();
    });

    this.process.on('error', (error) => {
      console.error('[ClaudeCodeClient] Process error:', error);
      this.isAlive = false;
      this.completeAllIterators();
    });

    // Wait for initialization message
    await new Promise((resolve) => setTimeout(resolve, 1000));

    if (!this.process || !this.isAlive) {
      throw new Error('Claude process failed to start');
    }
  }

  async stop(): Promise<void> {
    if (this.process) {
      this.process.kill();
      this.process = null;
    }
    this.isAlive = false;
    this.completeAllIterators();
  }

  async send(message: MinionMessage): Promise<void> {
    if (!this.process || !this.process.stdin || !this.isAlive) {
      throw new Error('Client not running');
    }

    // Only support user messages
    if (message.type === 'user') {
      const userMsg = message as UserMessage;

      // Format as stream-json input
      const streamJsonMessage = {
        type: 'user',
        message: {
          role: 'user',
          content: userMsg.content,
        },
      };

      this.process.stdin.write(JSON.stringify(streamJsonMessage) + '\n');
    } else {
      console.warn('[ClaudeCodeClient] Only user messages supported for sending');
    }
  }

  async *receive(): AsyncIterableIterator<MinionMessage> {
    while (this.isAlive || this.messageQueue.length > 0) {
      if (this.messageQueue.length > 0) {
        const message = this.messageQueue.shift();
        if (message) {
          yield message;
        }
      } else if (this.isAlive) {
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
    if (this.process) {
      this.process.kill('SIGKILL');
      this.process = null;
    }
    this.isAlive = false;
    this.completeAllIterators();
  }

  interrupt(): void {
    if (this.process && this.process.stdin) {
      // Send Ctrl+C to interrupt
      this.process.stdin.write('\x03');
    }
  }

  /**
   * Convert Claude's stream-json output to MinionMessage
   *
   * @param parsed - Parsed JSON from a stream-json line. This is untrusted
   * external CLI output, so shape is verified at runtime before use.
   */
  private convertToMinionMessage(parsed: unknown): MinionMessage | null {
    const timestamp = Date.now();

    if (!isClaudeStreamJsonMessage(parsed)) {
      return null;
    }

    switch (parsed.type) {
      case 'system':
        // Ignore system init messages
        return null;

      case 'assistant': {
        // Extract text content from assistant message
        const content = parsed.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
              const textMessage: TextMessage = {
                type: 'text',
                content: block.text,
                timestamp,
              };
              return textMessage;
            }
            // TODO: Handle tool_use blocks in future
          }
        }
        return null;
      }

      case 'result':
        // Final result summary
        if (parsed.result) {
          const textMessage: TextMessage = {
            type: 'text',
            content: parsed.result,
            timestamp,
          };
          return textMessage;
        }
        return null;

      default:
        return null;
    }
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

  /**
   * Build CLI arguments from MinionSpec
   *
   * Translates spec configuration to claude CLI options:
   * - spec.model → --model
   * - spec.agentPrompt → --system-prompt or --append-system-prompt (based on useBuiltInSystemPrompt)
   * - spec.tools → --tools (tool names only, for built-in tools)
   * - sessionId → --session-id (for conversation history persistence)
   */
  private buildCliArgs(spec: MinionSpec): string[] {
    const args = [
      '--input-format=stream-json',
      '--output-format=stream-json',
      '--verbose',
      '--dangerously-skip-permissions',
    ];

    // Add session ID for conversation history persistence
    if (this.sessionId) {
      args.push('--session-id', this.sessionId);
    }

    // Add model if specified
    if (spec.model) {
      args.push('--model', spec.model);
    }

    // Add system prompt if specified
    if (spec.agentPrompt) {
      if (spec.useBuiltInSystemPrompt) {
        // Append to built-in system prompt
        args.push('--append-system-prompt', spec.agentPrompt);
      } else {
        // Replace system prompt entirely
        args.push('--system-prompt', spec.agentPrompt);
      }
    }

    // Add tools if specified (tool names for built-in tools)
    if (spec.tools && spec.tools.length > 0) {
      const toolNames = spec.tools.map(t => t.name).join(',');
      args.push('--tools', toolNames);
    }

    return args;
  }
}

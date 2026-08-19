import { Effect } from 'effect';
import type { Mission, MissionArgsSchema, MissionPropertySchema } from '../domain/Mission';
import type { MissionContext } from '../domain/MissionContext';
import { MissionExecutionError } from '../domain/MissionEffect';

/**
 * Wraps a legacy markdown mission file as a Mission object
 *
 * Legacy markdown missions have this structure:
 * ```markdown
 * # Mission: [Name]
 *
 * ## Objective
 * [Description]
 *
 * ## Arguments
 * - `arg-name`: Description
 *
 * ## Process
 * [Steps with <arg-name> template variables]
 * ```
 *
 * LegacyMissionWrapper:
 * 1. Parses the markdown to extract name, description, and args schema
 * 2. Creates a Mission that substitutes args and sends markdown to a minion
 */
export class LegacyMissionWrapper {
  /**
   * Create a Mission from markdown content
   *
   * @param markdown - The markdown mission content
   * @param filename - The filename (used as fallback for mission name)
   * @returns A Mission object that wraps the markdown
   */
  static wrap(markdown: string, filename: string): Mission<Record<string, unknown>> {
    const name = this.extractName(markdown, filename);
    const description = this.extractDescription(markdown);
    const args = this.extractArgsSchema(markdown);

    return {
      name,
      description,
      api: 'effect' as const,
      args,
      run(ctx: MissionContext, argValues: Record<string, unknown>) {
        return Effect.gen(function* () {
          // Substitute template variables in markdown
          let content = markdown;
          for (const [key, value] of Object.entries(argValues)) {
            // Replace <arg-name> patterns
            const pattern = new RegExp(`<${key}>`, 'g');
            content = content.replace(pattern, String(value));
          }

          // Emit started event
          ctx.emit('started', { missionName: name, args: argValues });

          // Spawn a minion
          ctx.emit('log', { level: 'info', message: 'Spawning minion for legacy mission...' });
          const minion = yield* ctx.spawn({ client: 'claude-code' });

          ctx.emit('minion-spawned', { minionId: minion.id });

          yield* Effect.tryPromise({
            try: async () => {
              // Send the markdown content as the prompt
              await minion.send({
                type: 'user',
                content,
                timestamp: Date.now(),
              });

              // Stream minion messages
              for await (const message of minion.receive()) {
                if (ctx.isCancelled) {
                  break;
                }

                // Forward message as event
                ctx.emit('minion-message', {
                  minionId: minion.id,
                  messageType: message.type,
                  content: extractContent(message),
                  timestamp: message.timestamp,
                });

                // Emit progress for text messages
                if (message.type === 'text') {
                  const preview = message.content.slice(0, 100);
                  ctx.emit('progress', {
                    message: preview + (message.content.length > 100 ? '...' : ''),
                  });
                }
              }

              if (!ctx.isCancelled) {
                ctx.emit('minion-completed', { minionId: minion.id });
                ctx.emit('completed', { summary: `Legacy mission ${name} completed` });
              }
            },
            catch: (error) => {
              if (ctx.isCancelled) {
                return new MissionExecutionError({ message: 'Mission cancelled' });
              }
              return new MissionExecutionError({
                message: error instanceof Error ? error.message : String(error),
                cause: error,
              });
            },
          });
        });
      },
    };
  }

  /**
   * Extract mission name from markdown
   *
   * Looks for `# Mission: [Name]` pattern, falls back to filename
   */
  static extractName(markdown: string, filename: string): string {
    // Match "# Mission: Name" or "# Mission: Name - Subtitle"
    const match = markdown.match(/^#\s+Mission:\s*(.+)$/m);
    if (match) {
      return match[1].trim().toLowerCase().replace(/\s+/g, '-');
    }
    // Fall back to filename without extension
    return filename.replace(/\.md$/, '');
  }

  /**
   * Extract description from Objective section
   */
  static extractDescription(markdown: string): string {
    // Match content between ## Objective and next ## section (or end of string)
    const match = markdown.match(/##\s+Objective\s*\n+([\s\S]*?)(?=\n##\s|\n---|$)/);
    if (match) {
      return match[1].trim().split('\n')[0]; // First line only
    }
    return 'Legacy markdown mission';
  }

  /**
   * Extract arguments schema from Arguments section
   */
  static extractArgsSchema(markdown: string): MissionArgsSchema {
    const properties: Record<string, MissionPropertySchema> = {};
    const required: string[] = [];

    // Match content between ## Arguments and next ## section (or end of string)
    const argsSection = markdown.match(/##\s+Arguments\s*\n+([\s\S]*?)(?=\n##\s|\n---|$)/);
    if (!argsSection) {
      return { type: 'object', properties, required };
    }

    // Match argument patterns: - `arg-name`: Description
    const argPattern = /^-\s+`([^`]+)`:\s*(.+)$/gm;
    let match;
    while ((match = argPattern.exec(argsSection[1])) !== null) {
      const argName = match[1];
      const description = match[2].trim();

      properties[argName] = {
        type: 'string',
        description,
      };
      required.push(argName);
    }

    return { type: 'object', properties, required };
  }
}

/**
 * Extract content from a minion message for event payload
 */
function extractContent(message: { type: string }): unknown {
  const msg = message as Record<string, unknown>;
  switch (message.type) {
    case 'text':
    case 'thinking':
    case 'user':
      return msg.content;
    case 'tool_use':
      return { id: msg.id, name: msg.name, input: msg.input };
    case 'tool_result':
      return { tool_use_id: msg.tool_use_id, content: msg.content };
    case 'error':
      return msg.error;
    case 'status':
      return msg.status;
    default:
      return message;
  }
}

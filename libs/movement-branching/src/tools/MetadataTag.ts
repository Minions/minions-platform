/**
 * Metadata about the AI agent that created a commit
 */
export interface MinionMetadata {
  /** Client type (e.g., 'claude-code', 'claude-lightweight', 'custom') */
  clientType: string;
  /** LLM model used (e.g., 'claude-opus-4-5', 'claude-3-haiku') */
  model: string;
  /** Active command or slash command (e.g., '/implement-feature') */
  activeCommand?: string;
  /** Disguise/costume/persona active (e.g., 'senior-engineer') */
  disguise?: string;
}

/**
 * Standard trailer keys for minion metadata
 */
const TRAILER_KEYS = {
  clientType: 'Minion-Client',
  model: 'Minion-Model',
  activeCommand: 'Minion-Command',
  disguise: 'Minion-Disguise',
} as const;

/**
 * Formats and parses minion metadata as git trailers.
 *
 * Git trailers are key-value pairs at the end of commit messages, formatted as:
 * ```
 * Key: Value
 * ```
 *
 * This class provides utilities to:
 * - Format MinionMetadata as trailers to append to commit messages
 * - Parse trailers from commit messages back into MinionMetadata
 *
 * Usage:
 * ```typescript
 * const trailers = new MetadataTrailers();
 *
 * // When creating a commit, format trailers and append to message
 * const metadata = { clientType: 'claude-code', model: 'claude-opus-4-5' };
 * const trailerText = trailers.formatTrailers(metadata);
 * const fullMessage = `feat: Add new feature\n\n${trailerText}`;
 * await worktree.commitAll(fullMessage);
 *
 * // When reading a commit message, parse trailers
 * const parsed = trailers.parseTrailers(commitMessage);
 * if (parsed) {
 *   console.log(`Commit by ${parsed.clientType} using ${parsed.model}`);
 * }
 * ```
 */
export class MetadataTrailers {
  /**
   * Formats minion metadata as git trailers.
   *
   * @param metadata - The metadata to format
   * @returns Trailer text to append to commit message (with leading blank line)
   */
  formatTrailers(metadata: MinionMetadata): string {
    const lines: string[] = [];

    // Always include required fields
    lines.push(`${TRAILER_KEYS.clientType}: ${metadata.clientType}`);
    lines.push(`${TRAILER_KEYS.model}: ${metadata.model}`);

    // Include optional fields if present
    if (metadata.activeCommand) {
      lines.push(`${TRAILER_KEYS.activeCommand}: ${metadata.activeCommand}`);
    }
    if (metadata.disguise) {
      lines.push(`${TRAILER_KEYS.disguise}: ${metadata.disguise}`);
    }

    return lines.join('\n');
  }

  /**
   * Parses minion metadata from git trailers in a commit message.
   *
   * @param message - The full commit message
   * @returns Parsed metadata if minion trailers are present, null otherwise
   */
  parseTrailers(message: string): MinionMetadata | null {
    const trailers = this.extractTrailers(message);

    // Check if this has minion metadata (requires both client and model)
    const clientType = trailers.get(TRAILER_KEYS.clientType);
    const model = trailers.get(TRAILER_KEYS.model);

    if (!clientType || !model) {
      return null;
    }

    const metadata: MinionMetadata = {
      clientType,
      model,
    };

    // Add optional fields if present
    const activeCommand = trailers.get(TRAILER_KEYS.activeCommand);
    if (activeCommand) {
      metadata.activeCommand = activeCommand;
    }

    const disguise = trailers.get(TRAILER_KEYS.disguise);
    if (disguise) {
      metadata.disguise = disguise;
    }

    return metadata;
  }

  /**
   * Checks if a commit message contains minion metadata trailers.
   *
   * @param message - The commit message to check
   * @returns True if minion metadata is present
   */
  hasMetadata(message: string): boolean {
    return this.parseTrailers(message) !== null;
  }

  /**
   * Extracts all trailers from a commit message.
   *
   * Trailers are key-value pairs at the end of a commit message,
   * separated from the body by a blank line.
   */
  private extractTrailers(message: string): Map<string, string> {
    const trailers = new Map<string, string>();

    // Split into paragraphs (separated by blank lines)
    const paragraphs = message.split(/\n\s*\n/);

    // Trailers are typically in the last paragraph
    const lastParagraph = paragraphs[paragraphs.length - 1];
    if (!lastParagraph) {
      return trailers;
    }

    // Parse trailer lines (Key: Value format)
    const lines = lastParagraph.trim().split('\n');
    for (const line of lines) {
      const match = line.match(/^([A-Za-z][A-Za-z0-9-]*): (.+)$/);
      if (match) {
        const [, key, value] = match;
        trailers.set(key, value.trim());
      }
    }

    return trailers;
  }
}

// Also exported as `MetadataTag` for callers that key on that name.
export { MetadataTrailers as MetadataTag };

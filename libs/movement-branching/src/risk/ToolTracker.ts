/**
 * Represents a single tool usage record
 */
export interface ToolRecord {
  tool: string;
  params: Record<string, unknown>;
  timestamp: number;
}

/**
 * Serializable state of the ToolTracker for persistence
 */
export interface ToolTrackerState {
  tools: ToolRecord[];
}

/**
 * Read-only tools that don't modify the filesystem
 */
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Bash', 'WebFetch', 'WebSearch']);

/**
 * Write tools that modify files
 */
const WRITE_TOOLS = new Set(['Edit', 'Write']);

/**
 * Tracks tools used since last commit for risk computation.
 *
 * The ToolTracker records each tool invocation along with its parameters
 * and timestamp. This information is used by the RiskComputer to determine
 * the risk level of a commit based on what operations were performed.
 */
export class ToolTracker {
  private tools: ToolRecord[] = [];

  /**
   * Record a tool usage
   * @param tool - The name of the tool (e.g., 'Edit', 'Read', 'Write')
   * @param params - Parameters passed to the tool (should include 'file' for file operations)
   */
  recordTool(tool: string, params: Record<string, unknown>): void {
    this.tools.push({
      tool,
      params,
      timestamp: Date.now(),
    });
  }

  /**
   * Get all tools recorded since the last commit/reset
   */
  getToolsSinceLastCommit(): readonly ToolRecord[] {
    return this.tools;
  }

  /**
   * Reset the tracker (call after a commit)
   */
  reset(): void {
    this.tools = [];
  }

  /**
   * Get unique list of files that were edited (by Edit or Write tools)
   */
  getEditedFiles(): string[] {
    const files = new Set<string>();

    for (const record of this.tools) {
      if (this.isWriteTool(record.tool)) {
        const file = record.params['file'];
        if (typeof file === 'string') {
          files.add(file);
        }
      }
    }

    return Array.from(files);
  }

  /**
   * Check if a tool is read-only (doesn't modify files)
   */
  isReadOnlyTool(tool: string): boolean {
    return READ_ONLY_TOOLS.has(tool);
  }

  /**
   * Check if a tool modifies files
   */
  isWriteTool(tool: string): boolean {
    return WRITE_TOOLS.has(tool);
  }

  /**
   * Check if any write operations have been performed since last commit
   */
  hasWriteOperations(): boolean {
    return this.tools.some((record) => this.isWriteTool(record.tool));
  }

  /**
   * Export state for persistence (e.g., to survive context loss)
   */
  exportState(): ToolTrackerState {
    return {
      tools: [...this.tools],
    };
  }

  /**
   * Import state from persistence
   */
  importState(state: ToolTrackerState): void {
    this.tools = [...state.tools];
  }
}

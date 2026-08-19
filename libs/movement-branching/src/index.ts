/**
 * Movement Branching - Minimal API for MCP tools
 *
 * This library provides a single facade for movement-based git workflow:
 * - Record file edits
 * - Get status
 * - Commit with risk notation
 * - Merge movements to main
 */

export { MovementSession } from './MovementSession.js';
export type {
  CommitType,
  Risk,
  StatusResult,
  StartResult,
  CommitOptions,
  CommitResult,
  MergeOptions,
  MergeResult,
  AbsorbPlanResult,
  MovementSessionState,
  ToolLogCommitAnalysis,
} from './MovementSession.js';

// Shared per-worktree commit-debounce state — a host process (the cabinet)
// that wants its own explicit, long-lived instance (rather than every
// MovementSession implicitly sharing a hidden module-level default)
// constructs one of these and passes it through.
export { CommitCoordinator } from './tools/CommitCoordinator.js';

export { ToolLogAnalyzer } from './tool-log/ToolLogAnalyzer.js';
export { mergeIntentions } from './tool-log/IntentionMerger.js';
export type { IntentionClassification, RiskClassification, ToolLogAnalysis } from './tool-log/ToolLogAnalyzer.js';
export type { ToolLogEntry } from './tool-log/ToolLogEntry.js';
export { ToolLogReader } from './tool-log/ToolLogReader.js';
export { TOOL_LOG_HOOK_SCRIPT, TOOL_LOG_HOOK_SCRIPT_NAME } from './tool-log/hook-script.js';

// Re-export Worktree type for convenience
export type { Worktree } from '@minions/file-store';

export { retryInstructionFor } from './movement/MovementManager.js';

export { MirrorCommit } from './tools/MirrorCommit.js';
export type { MirrorCommitOptions, MirrorCommitResult } from './tools/MirrorCommit.js';

export { movementActionGroup } from './MovementActionGroup.js';

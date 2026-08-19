/**
 * Port module exports
 *
 * This module exports all port interfaces and types for the FileStore domain.
 */

export type { Sandbox } from "./Sandbox.js";

export type { GitRef } from "./types.js";
export { asGitRef } from "./types.js";

export type {
  // Node types
  File,
  Directory,
  Junction,
  BareRepository,
  Worktree,
  ReadOnlyClone,
  ReadOnlyDirectory,
  // Type unions
  Node,
  NodeKind,
  DirectoryLike,
  DirectoryChild,
  WorktreeChild,
  ReadOnlyChild,
  // File metadata
  FileStat,
  // Result types
  ChildResult,
  DirectoryChildResult,
  WorktreeChildResult,
  ReadOnlyChildResult,
  MergeResult,
  MergeOptions,
  RebaseResult,
  CommitInfo,
  // Authentication types
  CloneAuth,
  // Movement/Trunk safety redesign — Sandbox layer (design doc §4.1)
  CommitRef,
  MovementState,
  MergeSpec,
  CommitSpec,
  CommitResult,
  StartResult,
  CherryPickResult,
  Movement,
  CheckedOutMovement,
  Trunk,
  DerivedTrunk,
  AdvanceResult,
  AdvanceAttempt,
  Mirror,
  MutableDirectoryLike,
} from "./types.js";

export type {
  // Matchers
  FullMatcher,
  DirectoryChildMatcher,
  WorktreeChildMatcher,
  ReadOnlyChildMatcher,
  FileMatcher,
  DirectoryMatcher,
  JunctionMatcher,
  BareRepositoryMatcher,
  WorktreeMatcher,
  ReadOnlyCloneMatcher,
  ReadOnlyDirectoryMatcher,
} from "./matchers.js";

export { runSandboxContractTests } from "./contracts.js";

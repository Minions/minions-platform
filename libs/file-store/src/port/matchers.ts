/**
 * Pattern Matching Type Definitions
 *
 * Matcher types for pattern matching on node types.
 * Each container type has a matcher that includes only its valid child types.
 */

import type {
  File,
  Directory,
  Junction,
  BareRepository,
  Worktree,
  ReadOnlyClone,
  ReadOnlyDirectory,
} from "./types.js";

// ============================================
// Full Matcher (all node types)
// ============================================

/**
 * Matcher for all possible node types in the sandbox
 */
export type FullMatcher<T> = {
  file: (f: File) => T;
  directory: (d: Directory) => T;
  junction: (j: Junction) => T;
  bareRepository: (r: BareRepository) => T;
  worktree: (w: Worktree) => T;
  readOnlyClone: (c: ReadOnlyClone) => T;
  readOnlyDirectory: (d: ReadOnlyDirectory) => T;
};

// ============================================
// Container Child Matchers
// ============================================

/**
 * Matcher for Directory children (all container child types except ReadOnlyDirectory)
 */
export type DirectoryChildMatcher<T> = {
  file: (f: File) => T;
  directory: (d: Directory) => T;
  junction: (j: Junction) => T;
  bareRepository: (r: BareRepository) => T;
  worktree: (w: Worktree) => T;
  readOnlyClone: (c: ReadOnlyClone) => T;
};

/**
 * Matcher for Worktree children (only git-tracked content types)
 */
export type WorktreeChildMatcher<T> = {
  file: (f: File) => T;
  worktree: (w: Worktree) => T;
  junction: (j: Junction) => T;
};

/**
 * Matcher for ReadOnlyClone/ReadOnlyDirectory children
 */
export type ReadOnlyChildMatcher<T> = {
  file: (f: File) => T;
  readOnlyDirectory: (d: ReadOnlyDirectory) => T;
};

// ============================================
// Single-Type Matchers
// ============================================

/**
 * Matcher for File nodes (single case)
 */
export type FileMatcher<T> = {
  file: (f: File) => T;
};

/**
 * Matcher for Directory nodes (single case)
 */
export type DirectoryMatcher<T> = {
  directory: (d: Directory) => T;
};

/**
 * Matcher for Junction nodes (single case)
 */
export type JunctionMatcher<T> = {
  junction: (j: Junction) => T;
};

/**
 * Matcher for BareRepository nodes (single case)
 */
export type BareRepositoryMatcher<T> = {
  bareRepository: (r: BareRepository) => T;
};

/**
 * Matcher for Worktree nodes (single case)
 */
export type WorktreeMatcher<T> = {
  worktree: (w: Worktree) => T;
};

/**
 * Matcher for ReadOnlyClone nodes (single case)
 */
export type ReadOnlyCloneMatcher<T> = {
  readOnlyClone: (c: ReadOnlyClone) => T;
};

/**
 * Matcher for ReadOnlyDirectory nodes (single case)
 */
export type ReadOnlyDirectoryMatcher<T> = {
  readOnlyDirectory: (d: ReadOnlyDirectory) => T;
};

import { Effect, Stream } from 'effect';

/**
 * Knowledge about a file in the Workbench
 *
 * Represents a file that has been read or created during mission execution.
 * Files can be shared across minions via the Workbench.
 */
export interface FileKnowledge {
  /** File path (relative to wing work/local or absolute) */
  path: string;

  /** File content */
  content: string;

  /** Timestamp when file was last read/updated */
  lastRead: number;

  /** Has this file been modified by a minion/mission? */
  modified: boolean;

  /** File category (open-ended string like 'source', 'config', 'test', etc.) */
  category: string;

  /** Last known modification time from filesystem (milliseconds since epoch) */
  lastModified?: number;
}

/**
 * A fact discovered about the project
 *
 * Facts are snippets of knowledge about the project that are useful
 * across minions (e.g., "Build command is: pnpm build").
 */
export interface ProjectFact {
  /** Fact category (open-ended: 'build', 'test', 'package-manager', or any custom category) */
  category: string;

  /** The fact itself (e.g., "Build command is: pnpm build") */
  fact: string;

  /** Who discovered this fact */
  discoveredBy: string;

  /** Confidence level in this fact */
  confidence: 'confirmed' | 'inferred';
}

/**
 * File change event emitted when a file is updated in the workbench
 */
export interface FileChangeEvent {
  /** File path that changed */
  path: string;
  /** Updated file content */
  content: string;
}

/**
 * Callback invoked when a file is updated in the workbench
 */
export type FileChangeCallback = (path: string, content: string) => void;

/**
 * Minimal shape of a file-store `File` object accepted by `addFile`/`writeFile`.
 *
 * Kept structural (rather than importing `File` from `@minions/file-store`) so
 * domain-types does not take a dependency on file-store - see
 * `__tests__/domain-boundaries.test.ts`, which enforces that this package only
 * depends on `effect` and `@minions/costumes`. `@minions/file-store`'s `File`
 * type structurally satisfies this interface, so callers can pass it directly.
 */
export interface FileHandle {
  /** Absolute (or virtual, for in-memory implementations) filesystem path */
  readonly path: string;
  /** Reads the full file content */
  read(): Promise<string>;
  /** Writes content to the file */
  write(content: string): Promise<void>;
  /** Returns file metadata, including last-modified time */
  stat(): Promise<{ mtimeMs: number }>;
}

/**
 * Workbench for shared contextual knowledge
 *
 * The Workbench is a container for knowledge that minions need to share:
 * - Files relevant to the current task
 * - Project facts discovered during work
 *
 * Minions receive Workbench contents as synthetic gadget history so they
 * don't need to repeat discovery work.
 */
export interface IWorkbench {
  /** Files stored in the workbench (keyed by path) */
  readonly files: ReadonlyMap<string, FileKnowledge>;

  /** Project facts stored in the workbench */
  readonly facts: ReadonlyArray<ProjectFact>;

  /**
   * Add a file by path and content string
   *
   * @param path - File path
   * @param content - File content
   * @param category - File category (default: 'general')
   */
  addFile(path: string, content: string, category?: string): Effect.Effect<void, Error, never>;

  /**
   * Add a file by path and content promise
   *
   * The promise is resolved internally - callers don't need to await.
   *
   * @param path - File path
   * @param contentPromise - Promise that resolves to file content
   * @param category - File category (default: 'general')
   */
  addFile(path: string, contentPromise: Promise<string>, category?: string): Effect.Effect<void, Error, never>;

  /**
   * Add a file from file-store IFile object
   *
   * Reads the file content automatically.
   *
   * @param file - IFile from file-store
   * @param category - File category (default: 'general')
   */
  addFile(file: FileHandle, category?: string): Effect.Effect<void, Error, never>;

  /**
   * Add a project fact
   *
   * @param category - Fact category (open-ended: 'build', 'test', etc.)
   * @param fact - The fact itself
   * @param confidence - Confidence level
   * @param discoveredBy - Who discovered this fact (default: 'mission')
   */
  addFact(
    category: string,
    fact: string,
    confidence: 'confirmed' | 'inferred',
    discoveredBy?: string
  ): void;

  /**
   * Re-read a file from disk and update the cache
   *
   * @param path - File path to refresh
   * @returns true if file was refreshed, false if not in cache
   */
  refreshFile(path: string): Effect.Effect<boolean, Error, never>;

  /**
   * Re-read all files that may have changed externally
   *
   * Checks all cached files and refreshes those whose modification time
   * has changed since last read. Uses parallel reads for performance.
   *
   * @returns Array of paths that were refreshed
   */
  refreshDirtyFiles(): Effect.Effect<string[], Error, never>;

  /**
   * Check if a file may have changed externally
   *
   * Compares cached modification time with current filesystem modification time.
   *
   * @param path - File path to check
   * @returns true if file may have changed, false if up-to-date or not in cache
   */
  isDirty(path: string): Effect.Effect<boolean, never, never>;

  /**
   * Get a Stream of file change events
   *
   * @returns Stream of FileChangeEvent
   */
  fileChanges(): Stream.Stream<FileChangeEvent, never, never>;

  /**
   * Register a callback to be notified when a file is updated
   *
   * @deprecated Use fileChanges() Stream instead for Effect-based consumption
   * @param callback - Function to call when a file changes
   * @returns Function to unregister the callback
   */
  onFileChange(callback: FileChangeCallback): () => void;

  /**
   * Write content to a file and update the cache
   *
   * This is the recommended way to write files when using the workbench,
   * as it keeps the cache synchronized.
   *
   * @param file - File object to write to
   * @param content - Content to write
   * @param category - File category (default: 'general')
   */
  writeFile(file: FileHandle, content: string, category?: string): Effect.Effect<void, Error, never>;
}

import type { File, Sandbox } from '@minions/file-store';
import { pathToFile } from '@minions/file-store';
import { Data, Effect, PubSub, Stream } from 'effect';
// path import removed (unused)
import type {
  IWorkbench,
  FileKnowledge,
  ProjectFact,
  FileChangeEvent,
  FileChangeCallback,
  FileHandle,
} from '@minions/domain-types';

/**
 * File operation errors using Effect's Data module for tagged errors
 */
export class FileError extends Data.TaggedError('FileError')<{
  message: string;
  path?: string;
  cause?: unknown;
}> {}

// Re-export types for backward compatibility
export type { IWorkbench, FileKnowledge, ProjectFact, FileChangeEvent, FileChangeCallback };

/**
 * Default implementation of IWorkbench
 */
export class Workbench implements IWorkbench {
  private readonly _files = new Map<string, FileKnowledge>();
  private readonly _facts: ProjectFact[] = [];
  private readonly _fileChangeCallbacks: FileChangeCallback[] = [];
  private readonly _fileChangePubSub: PubSub.PubSub<FileChangeEvent>;
  private readonly _sandbox: Sandbox;

  constructor(sandbox: Sandbox) {
    this._sandbox = sandbox;
    // Create unbounded PubSub for file change events
    // This must be created synchronously, so we use runSync
    this._fileChangePubSub = Effect.runSync(PubSub.unbounded<FileChangeEvent>());
  }

  get files(): ReadonlyMap<string, FileKnowledge> {
    return this._files;
  }

  get facts(): ReadonlyArray<ProjectFact> {
    return this._facts;
  }

  /**
   * Convert an absolute file path to a file-store File object.
   * Uses the sandbox to navigate from root to the target file.
   *
   * @param filePath - Absolute file path
   * @returns File object, or undefined if path invalid
   */
  private async _pathToFile(filePath: string): Promise<File | undefined> {
    return pathToFile(this._sandbox, filePath);
  }

  /**
   * Get a file's modification time via file-store's File.stat().
   *
   * @param filePath - Absolute file path
   * @returns Modification time in milliseconds, or undefined if file doesn't exist
   */
  private async _getFileModificationTime(filePath: string): Promise<number | undefined> {
    try {
      const file = await this._pathToFile(filePath);
      if (!file) {
        return undefined;
      }
      return (await file.stat()).mtimeMs;
    } catch {
      return undefined;
    }
  }

  addFile(
    pathOrFile: string | FileHandle,
    contentOrCategory?: string | Promise<string>,
    category?: string
  ): Effect.Effect<void, FileError, never> {
    return Effect.gen(this, function* () {
      try {
        // Handle IFile object
        if (typeof pathOrFile !== 'string') {
          const file = pathOrFile;
          const cat = typeof contentOrCategory === 'string' ? contentOrCategory : 'general';
          const content = yield* Effect.tryPromise({
            try: () => file.read(),
            catch: (error) => new FileError({
              message: 'Failed to read file',
              path: file.path,
              cause: error,
            }),
          });
          const lastModified = yield* Effect.promise(() => file.stat().then((s) => s.mtimeMs).catch(() => undefined));

          this._files.set(file.path, {
            path: file.path,
            content,
            lastRead: Date.now(),
            modified: false,
            category: cat,
            lastModified,
          });
          return;
        }

        // Handle path + content or path + promise
        // At this point, pathOrFile must be a string since we've checked it's not a File above
        const path = pathOrFile as string;
        const cat = category ?? 'general';

        if (contentOrCategory === undefined) {
          return yield* Effect.fail(new FileError({
            message: 'Content must be provided when adding file by path',
            path,
          }));
        }

        // Resolve content (whether it's a string or Promise<string>)
        const content = yield* Effect.promise(() => Promise.resolve(contentOrCategory));
        const lastModified = yield* Effect.promise(() => this._getFileModificationTime(path));

        this._files.set(path, {
          path,
          content,
          lastRead: Date.now(),
          modified: false,
          category: cat,
          lastModified,
        });
      } catch (error) {
        return yield* Effect.fail(new FileError({
          message: error instanceof Error ? error.message : 'Unknown error while adding file',
          path: typeof pathOrFile === 'string' ? pathOrFile : pathOrFile.path,
          cause: error,
        }));
      }
    });
  }

  addFact(
    category: string,
    fact: string,
    confidence: 'confirmed' | 'inferred',
    discoveredBy = 'mission'
  ): void {
    this._facts.push({
      category,
      fact,
      discoveredBy,
      confidence,
    });
  }

  refreshFile(filePath: string): Effect.Effect<boolean, FileError, never> {
    return Effect.gen(this, function* () {
      const existing = this._files.get(filePath);
      if (!existing) {
        return false;
      }

      const result = yield* Effect.tryPromise({
        try: async () => {
          const file = await this._pathToFile(filePath);
          if (!file) {
            throw new Error(`File not found: ${filePath}`);
          }

          const content = await file.read();
          const lastModified = await this._getFileModificationTime(filePath);
          return { content, lastModified };
        },
        catch: (error) => new FileError({
          message: 'Failed to refresh file',
          path: filePath,
          cause: error,
        }),
      }).pipe(
        Effect.catchAll(() => Effect.succeed(null))
      );

      if (!result) {
        // File no longer exists or can't be read
        return false;
      }

      this._files.set(filePath, {
        ...existing,
        content: result.content,
        lastRead: Date.now(),
        lastModified: result.lastModified,
      });

      // Notify callbacks and publish to stream
      yield* this._notifyFileChange(filePath, result.content);

      return true;
    });
  }

  refreshDirtyFiles(): Effect.Effect<string[], FileError, never> {
    return Effect.gen(this, function* () {
      const paths = Array.from(this._files.keys());

      // Check all files in parallel
      const isDirtyResults = yield* Effect.all(
        paths.map((path) =>
          Effect.map(this.isDirty(path), (isDirty) => ({ path, isDirty }))
        ),
        { concurrency: 'unbounded' }
      );

      const dirtyPaths = isDirtyResults
        .filter(({ isDirty }) => isDirty)
        .map(({ path }) => path);

      // Refresh all dirty files in parallel
      yield* Effect.all(
        dirtyPaths.map((path) => this.refreshFile(path)),
        { concurrency: 'unbounded' }
      );

      return dirtyPaths;
    });
  }

  isDirty(path: string): Effect.Effect<boolean, never, never> {
    return Effect.gen(this, function* () {
      const knowledge = this._files.get(path);
      if (!knowledge || knowledge.lastModified === undefined) {
        return false;
      }

      const currentModified = yield* Effect.promise(() => this._getFileModificationTime(path));
      if (currentModified === undefined) {
        // File no longer exists
        return false;
      }

      // File is dirty if modification time has changed
      return currentModified !== knowledge.lastModified;
    });
  }

  fileChanges(): Stream.Stream<FileChangeEvent, never, never> {
    return Stream.fromPubSub(this._fileChangePubSub);
  }

  onFileChange(callback: FileChangeCallback): () => void {
    this._fileChangeCallbacks.push(callback);

    // Return unregister function
    return () => {
      const index = this._fileChangeCallbacks.indexOf(callback);
      if (index !== -1) {
        this._fileChangeCallbacks.splice(index, 1);
      }
    };
  }

  writeFile(file: FileHandle, content: string, category = 'general'): Effect.Effect<void, FileError, never> {
    return Effect.gen(this, function* () {
      yield* Effect.tryPromise({
        try: () => file.write(content),
        catch: (error) => new FileError({
          message: 'Failed to write file',
          path: file.path,
          cause: error,
        }),
      });

      const lastModified = yield* Effect.promise(() => file.stat().then((s) => s.mtimeMs).catch(() => undefined));

      this._files.set(file.path, {
        path: file.path,
        content,
        lastRead: Date.now(),
        modified: true,
        category,
        lastModified,
      });

      // Notify callbacks and publish to stream
      yield* this._notifyFileChange(file.path, content);
    });
  }

  private _notifyFileChange(path: string, content: string): Effect.Effect<void, never, never> {
    return Effect.gen(this, function* () {
      // Publish to Stream
      yield* PubSub.publish(this._fileChangePubSub, { path, content });

      // Also notify legacy callbacks
      for (const callback of this._fileChangeCallbacks) {
        try {
          callback(path, content);
        } catch (error) {
          // Silently ignore callback errors to prevent one callback from breaking others
          console.error('File change callback error:', error);
        }
      }
    });
  }
}

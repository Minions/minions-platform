/**
 * Fake Modification-Time Clock (In-Memory Adapter)
 *
 * InMemorySandbox has no real filesystem, so File.stat() can't report a real
 * mtime. Instead, every write/append/create advances a shared fake clock by
 * one second and records that value as the file's mtime. Tests can read the
 * clock via InMemorySandbox.now() to compute the exact mtimeMs they should
 * expect, without depending on wall-clock timing.
 */

import type { SandboxStorage } from "./InMemorySandbox.js";

/**
 * Advances the sandbox's fake clock by one second and records it as the
 * modification time for `path`. Call this from every operation that would
 * change a real file's mtime (write, append, create).
 *
 * @returns The new clock value (also the file's new mtimeMs)
 */
export function touchFile(storage: SandboxStorage, path: string): number {
  storage.clock.value += 1000;
  storage.fileMtimes.set(path, storage.clock.value);
  return storage.clock.value;
}

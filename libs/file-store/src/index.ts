/**
 * FileStore Domain
 *
 * A version-aware file store that combines filesystem operations with git
 * version control. Uses object-first navigation and pattern matching.
 *
 * Two layers:
 * - Sandbox: Raw filesystem + git operations with typed directory objects
 * - Lair: Structure overlay for managing wings, repositories, and worktrees
 *
 * @example
 * ```typescript
 * import { createInMemorySandbox, createInMemoryLair } from '@minions/file-store';
 *
 * // Sandbox layer
 * const sandbox = createInMemorySandbox();
 * const file = await sandbox.root.createFile('test.txt', 'Hello!');
 *
 * // Lair layer
 * const lair = await createInMemoryLair(sandbox, 'my-lair');
 * const wing = await lair.createWing('my-wing', { ... });
 * ```
 */

// Export port interfaces and types
export * from "./port/index.js";

// Export lair layer interfaces
export * from "./lair/index.js";

// Export sandbox factory functions
export { createInMemorySandbox, simulateRemote } from "./adapters/memory/index.js";
export { createDiskSandbox } from "./adapters/disk/index.js";

// Export Movement/Trunk safety redesign sandbox-layer factories — both
// InMemory and Disk adapters now implement `Trunk`/`DerivedTrunk`/
// `Movement`/`CheckedOutMovement`/`Mirror` (see
// docs/design/movement-trunk-safety-redesign.md §4.1 and its progress
// journal for status; chunk 4 added the Disk adapter).
export {
  createInMemoryTrunk,
  createInMemoryCheckedOutMovement,
} from "./adapters/memory/index.js";
export {
  createDiskTrunk,
  createDiskCheckedOutMovement,
} from "./adapters/disk/index.js";

// Wing-layer WorkArea/Scratchpad factories (design doc §4.2, end of
// section): the adapter-specific pieces `createLair(sandbox,
// workAreaFactories)` needs to enable `Wing`'s
// workAreaLocal/workAreaGlobal/workAreaNamed/privateWorkAreaGlobal
// accessors.
export { createInMemoryWorkAreaFactories } from "./adapters/memory/index.js";
export { createDiskWorkAreaFactories } from "./adapters/disk/index.js";

// Shared git write-serialization/fetch-cache state — a host process (the
// cabinet) that wants its own explicit, long-lived instance (rather than
// every sandbox implicitly sharing a hidden module-level default) constructs
// one of these and passes it to `createDiskSandbox`.
export { GitCoordinationState } from "./adapters/disk/GitOperations.js";

// The design doc §3 fetch strategy's generic retry driver — optimistic
// first attempt, scoped-fetch-on-rejection, jittered backoff. Standalone
// (no Disk-adapter-specific wiring yet — that's checklist chunk 4); exported
// here so chunk 4's `Movement`/`Mirror` Disk implementations can drive their
// CAS-retry loops through it rather than hand-rolling a new one.
export {
  publishWithRetry,
  PublishRejectedError,
  jitteredDelayMs,
  type PublishRetryOptions,
} from "./adapters/disk/PublishRetry.js";

// Export utility functions
export {
  pathToFile,
  pathToDirectory,
  parseWingNameFromPath,
} from "./utils/pathConversion.js";
export {
  getOverlaidCostumeDirectories,
  getClosetDirectory,
  getCostumeDirectories,
  getCostumeSrcDirectory,
} from "./utils/closetUtils.js";

// Export test utilities
export { createTestWing } from "./test-utils/wingTestHelpers.js";
export type { CreateTestWingOptions } from "./test-utils/wingTestHelpers.js";

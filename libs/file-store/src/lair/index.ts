/**
 * Lair Layer Module Exports
 *
 * This module exports the Lair overlay layer, which provides
 * structure for managing repositories, wings, and shared resources.
 */

// Interfaces
export type { Lair } from "./Lair.js";
export type { Wing } from "./Wing.js";

// Result types and configuration
export type {
  WorkRepoResult,
  InfoRepoResult,
  PrivateRepoResult,
  WingResult,
  WorktreeResult,
  NamedWorkResult,
  DirectoryResult,
  WingConfig,
  ExtraWorkEntry,
} from "./lair-types.js";

// Implementation classes (exported for type compatibility, prefer factory functions)
export { LairImpl } from "./LairImpl.js";
export { LairWing } from "./LairWing.js";

// Primary factory function
export { createLair } from "./LairImpl.js";

// Wing template generation
export {
  generateWingClaudeMd,
} from "./wing-template.js";
export type {
  WingClaudeMdOptions,
} from "./wing-template.js";

// Contract tests (for internal use)
export { runLairContractTests } from "./lair-contracts.js";

// Repo identity resolution
export { canonicalizeRepoUrl, repoIdToDirName, resolveRepoIdentity, samePath } from "./repoIdentity.js";
export type { RepoIdentityResult } from "./repoIdentity.js";

// Branded repo/wing identity types
export { asWingName, asRepoAlias, asLairRepoName, asRepoId } from "./brandedIds.js";
export type { WingName, RepoAlias, LairRepoName, RepoId } from "./brandedIds.js";

// Wing-layer types (design doc §4.2): WorkArea/Scratchpad, the
// movement-shaped counterpart to Wing's workLocal/workNamed/workGlobal/
// privateGlobal/privateLocal accessors. These exist alongside the Wing
// surface above, which remains the production surface real callers depend
// on today — see Wing.ts's doc comment on workAreaLocal/workAreaGlobal/
// workAreaNamed/privateWorkAreaGlobal/scratchpad for the exact naming
// rationale.
export type { WorkArea, Scratchpad } from "./work-area-types.js";
export {
  createWorkArea,
  createScratchpad,
  resolveMovementBase,
  clearMovementBase,
  type WorkAreaFactories,
  type TrunkFactory,
  type CheckedOutMovementFactory,
} from "./SiteWorkArea.js";
// Adapter detection for WorkAreaFactories — real callers (e.g.
// libs/movement-branching's MovementActionGroup) hold only a `Sandbox` and
// have no other way to tell which adapter built it. See this module's own
// doc comment for why the detection has to live inside file-store.
export { createWorkAreaFactoriesForSandbox } from "./workAreaFactoriesForSandbox.js";

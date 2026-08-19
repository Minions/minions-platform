/**
 * Costumes Package - Public API
 *
 * Provides costume definitions, loading, and event declaration system
 * for AI minions.
 */

// Costume types
export type { Costume, CostumeEvent, Skill, Tool } from './Costume';
export { isCostume } from './Costume';

// Costume config types (costume.json schema)
export type { CostumeConfig, Entrypoint, CostumeEventRef, McpServerConfig, CostumeAccessories } from './CostumeConfig';
export { isCostumeConfig, isEntrypoint, isMcpServerConfig, isCostumeAccessories } from './CostumeConfig';

// Costume event definition (event entrypoint exports)
export type { CostumeEventDef } from './CostumeEventDef';
export { isCostumeEventDef } from './CostumeEventDef';

// Build config types (build.json schema)
export type { BuildConfig } from './BuildConfig';
export { isBuildConfig } from './BuildConfig';

// Event declaration system - re-exported from @minions/events
export type {
  EventDeclaration,
  PayloadOf,
  ParentTypeOf,
  EventsWithParent,
  ChildEventsOf,
  DescendantEventsOf,
  EventWithDescendants,
  TypedEvent,
  TypedEventUnion,
} from '@minions/events';
export {
  defineEvent,
  defineChildEvent,
  getParentEventType,
  getAncestorChain,
  isChildEvent,
  getEventSchemaInfo,
} from '@minions/events';

// Costume loader
export { ClosetCostumeLoader, LoadError } from './ClosetCostumeLoader';
export type { ClosetCostumeLoaderOptions } from './ClosetCostumeLoader';

// Extension loader (costume-declared action groups + gadgets)
export { ClosetExtensionLoader } from './ClosetExtensionLoader';
export type { ClosetExtensionLoaderOptions, LoadedCostumeExtensions, ExtensionInfo } from './ClosetExtensionLoader';

// Costume management (install, debug-install, list, marketplace)
export type { CostumeInstallResult, InstalledCostumeSummary, MarketplaceCostumeInstallResult } from './CostumeManager';
export { installCostume, debugInstallCostume, listInstalledCostumes, installMarketplaceCostume } from './CostumeManager';

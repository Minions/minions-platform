/**
 * Minions Runtime Core — the standard-tool base set every Minions Platform
 * application gets for free: minion spawn/list/history/kill, missions, and
 * movement/git operations, plus the shared infrastructure those depend on.
 *
 * Sits one layer above `@minions/mcp-server-core` (the generic session/
 * transport/action-group mounting core): an application binds this lib's
 * pieces to its own `McpServerCore` instance the same way `apps/cabinet`
 * does, and gets a working minion/mission/movement tool surface with no
 * custom `ActionGroupDef` of its own required.
 */

// --- Minions ---------------------------------------------------------------

export { MinionManager } from './minions/MinionManager.js';
export type { ListMinionsOptions, MinionEvent } from './minions/MinionManager.js';

export {
  spawnMinion,
  listMinions,
  getMinionHistory,
  getMinionInteractions,
  getMinionInteractionDetail,
  killMinion,
  respawnExecutor,
} from './minions/MinionService.js';
export type {
  MinionInfo,
  SpawnMinionResult,
  ListMinionsResult,
  MinionHistoryResult,
  InteractionSummary,
  MinionInteractionsResult,
  InteractionDetail,
  MinionInteractionDetailResult,
  KillMinionResult,
} from './minions/MinionService.js';

export { MinionStatus } from './minions/types.js';
export type { MinionClient, Message, MinionExecutor, Minion, CreateMinionOptions } from './minions/types.js';

export { ConversationDumper } from './minions/ConversationDumper.js';
export { HatcheryMinionAdapter } from './minions/HatcheryMinionAdapter.js';
export { MessageCapture } from './minions/MessageCapture.js';
export type { RawInteraction } from './minions/MessageCapture.js';
export { SimulatedMinionExecutor } from './minions/SimulatedMinionExecutor.js';
export { formatPromptSummary } from './minions/debug-tools.js';
export type { ContentBlock } from './minions/events.js';

// --- Missions ----------------------------------------------------------------

export { MissionService } from './missions/MissionService.js';
export type { BroadcastFn } from './missions/MissionService.js';

// --- Movement / git operations ------------------------------------------------
// `movement-branching` already packages its own ActionGroupDef; re-exported
// here so an application gets it as part of the standard core bundle without
// depending on `@minions/movement-branching` directly.

export { movementActionGroup } from '@minions/movement-branching';

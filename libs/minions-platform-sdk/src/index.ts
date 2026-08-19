/**
 * Minions Platform SDK — the single publishable artifact an external
 * application installs to build its own Minions Platform application:
 * `@minions/mcp-server-core`'s generic MCP session/transport/action-group
 * mounting core, plus `@minions/minions-runtime-core`'s standard
 * minion/mission/movement tool set, bundled together with every
 * `@minions/*` workspace dependency they need. No `apps/cabinet` or other
 * app-specific code is part of this surface.
 *
 * See `docs/getting-started/application-tool-sdk.md` for the install-and-
 * mount walkthrough.
 */

export {
  McpServerCore,
  ALL_ENDPOINTS,
} from '@minions/mcp-server-core';
export type {
  McpServerCoreOptions,
  McpServerCoreHooks,
  McpRequestExtra,
  SessionInfo,
} from '@minions/mcp-server-core';

// The generic action-group primitives every custom `ActionGroupDef` an
// application authors is built from — `@minions/mcp-types`'s
// lair/throne-room-specific tool-map types are intentionally not
// re-exported here; only the domain-agnostic pieces `McpServerCore` itself
// operates on belong to this SDK's public surface.
export {
  buildActionGroupSchema,
  buildActionGroupDescription,
  handleActionGroupHelp,
  dispatchActionGroup,
} from '@minions/mcp-types';
export type {
  JsonSchemaProperty,
  ActionContext,
  ActionDef,
  AnyActionDef,
  ActionGroupDef,
  InferActionMap,
} from '@minions/mcp-types';

export {
  MinionManager,
  spawnMinion,
  listMinions,
  getMinionHistory,
  getMinionInteractions,
  getMinionInteractionDetail,
  killMinion,
  respawnExecutor,
  MinionStatus,
  ConversationDumper,
  HatcheryMinionAdapter,
  MessageCapture,
  SimulatedMinionExecutor,
  formatPromptSummary,
  MissionService,
  movementActionGroup,
} from '@minions/minions-runtime-core';
export type {
  ListMinionsOptions,
  MinionEvent,
  MinionInfo,
  SpawnMinionResult,
  ListMinionsResult,
  MinionHistoryResult,
  InteractionSummary,
  MinionInteractionsResult,
  InteractionDetail,
  MinionInteractionDetailResult,
  KillMinionResult,
  MinionClient,
  Message,
  MinionExecutor,
  Minion,
  CreateMinionOptions,
  RawInteraction,
  ContentBlock,
  BroadcastFn,
} from '@minions/minions-runtime-core';

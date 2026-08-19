/**
 * Shared type definitions for MCP tool calls between Cabinet and Throne Room
 */

// This package is platform:universal (importable from browser code, see
// apps/throne-room), so it must never depend — even type-only — on a
// platform:node package like @minions/file-store or @minions/quality-watcher
// (both pull in real Node-only runtime elsewhere in their module graph, and
// a real import of either would drag that into any browser bundle that
// imports anything else from this package). The branded ID / status shapes
// below are duplicated rather than imported: they're each one-line brands or
// a small closed union, effectively never change, and TypeScript's
// structural typing keeps them assignment-compatible with the originals —
// a real WingName/GitRef/QualityStatus value constructed on the cabinet side
// still satisfies these types with no cast needed. The browser only ever
// carries already-branded values it received from a cabinet response, so it
// never needs the constructors (asWingName, asGitRef, etc.) — those stay
// import from @minions/file-store / @minions/quality-watcher directly in
// cabinet-side code.
export type WingName = string & { readonly __brand: 'WingName' };
export type RepoAlias = string & { readonly __brand: 'RepoAlias' };
export type LairRepoName = string & { readonly __brand: 'LairRepoName' };
export type GitRef = string & { readonly __brand: 'GitRef' };

/** Mirrors @minions/quality-watcher's SignalState — see that package for the authoritative definition. */
export type SignalState =
  | { state: 'pass'; timestamp: Date }
  | { state: 'fail'; timestamp: Date; failures: string[] }
  | { state: 'running'; timestamp: Date; failures: string[] }
  | { state: 'pending'; timestamp: Date };

/** Mirrors @minions/quality-watcher's QualityStatus — see that package for the authoritative definition. */
export type QualityStatus = {
  tests: SignalState;
  types: SignalState;
  build: SignalState;
  oxlint: SignalState;
  customLint: SignalState;
  aggregatedAt: Date;
  isPartial: boolean;
};

export type {
  JsonSchemaProperty,
  ActionContext,
  ActionDef,
  AnyActionDef,
  ActionGroupDef,
  InferActionMap,
} from './action-group.js';
export {
  buildActionGroupSchema,
  buildActionGroupDescription,
  handleActionGroupHelp,
  dispatchActionGroup,
} from './action-group.js';

// ========== Lair Tools ==========

// oxlint-disable-next-line no-empty-interface
export interface LairGetStateParams {
  // No params required for this tool
}

export interface LairGetStateResult {
  lairName: string;
  wings: WingSummary[];
  availableWorkRepos: LairRepoName[];
}

export interface WingSummaryExtraWork {
  name: RepoAlias;
  path: string;
  gitInfo?: { bareRepoDir: string | null; origin: string | null } | null;
}

export interface WingSummary {
  name: WingName;
  root: string;
  workLocal?: string;
  workGlobal?: string | null;
  privateLocal?: string;
  privateGlobal?: string;
  info?: string;
  /** Additional named work directories beyond local/global */
  extraWork?: WingSummaryExtraWork[];
  repositories?: {
    workLocal?: string;
    workGlobal?: string;
    privateLocal?: string | null;
    privateGlobal?: string | null;
  };
}

// ========== Wing Tools ==========

export interface WingsCreateParams {
  name: string;
  description?: string;
  workLocalRepo: string;
  workLocalBranch?: string;
  /** Additional named work directories to create alongside work/local */
  extraWork?: Record<string, { repo: string; branch: string; subdir?: string }>;
  /** Optional trunk override for work/local (e.g. an experiment branch) — see WingsSetTrunkParams. */
  trunk?: string;
}

export interface WingsCreateResult {
  message: string;
  wing: WingSummary;
}

export interface WingsDeleteParams {
  name: string;
}

export interface WingsDeleteResult {
  message: string;
  deletedWing: string;
}

export interface WingsUpdateParams {
  name: string;
  /** Named work directories to add. Keys are dir names, values are {repo, branch, subdir?}. */
  addWork?: Record<string, { repo: string; branch: string; subdir?: string }>;
  /** Names of work directories to remove. */
  removeWork?: string[];
}

export interface WingsUpdateResult {
  message: string;
  wing: WingSummary;
}

export interface WingsSetTrunkParams {
  name: string;
  /** Branch this wing's movement/plan operations should target, or null to clear the override (back to the repo's default branch). */
  trunk: string | null;
}

export interface WingsSetTrunkResult {
  message: string;
  wing: WingSummary;
}

// ========== Minion Tools ==========

export type MinionClient = 'claude-code' | 'anthropic-agentic' | 'opencode' | 'code-puppy';

/**
 * Metadata for a minion client type
 */
export interface MinionClientMetadata {
  type: MinionClient;
  displayName: string;
  description: string;
}

/**
 * Available production minion clients with their metadata
 */
export const AVAILABLE_MINION_CLIENTS: MinionClientMetadata[] = [
  {
    type: 'claude-code',
    displayName: 'Claude Code',
    description: 'Full-featured Claude Code client with built-in tools'
  },
  {
    type: 'anthropic-agentic',
    displayName: 'Anthropic Agentic',
    description: 'Anthropic agentic execution client'
  },
  {
    type: 'opencode',
    displayName: 'OpenCode',
    description: 'Open source code execution client'
  },
  {
    type: 'code-puppy',
    displayName: 'Code Puppy',
    description: 'Lightweight code execution client'
  }
];

export interface MinionsSpawnParams {
  wingName: string;
  client: MinionClient;
  initialPrompt?: string;
  agentPrompt?: string;
}

export interface MinionsSpawnResult {
  minionId: string;
  client: MinionClient;
  status: MinionStatus;
}

export type MinionStatus = 'idle' | 'working' | 'blocked' | 'dead';

export interface MinionsListParams {
  wingName?: string;
}

export interface MinionsListResult {
  minions: MinionSummary[];
}

export interface MinionSummary {
  id: string;
  client: MinionClient;
  status: MinionStatus;
  wingName: string;
  createdAt: number;
}

export interface MinionsSendMessageParams {
  minionId: string;
  message: string;
}

export interface MinionsSendMessageResult {
  acknowledged: boolean;
}

export interface MinionsGetHistoryParams {
  minionId: string;
}

export interface MinionsGetHistoryResult {
  messages: MinionMessage[];
}

export interface MinionMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

export interface MinionsKillParams {
  minionId: string;
}

export interface MinionsKillResult {
  message: string;
  dumpPath?: string;
}

// ========== Debug View Tools ==========

export interface MinionsGetInteractionsParams {
  minionId: string;
}

export interface MinionsGetInteractionsResult {
  interactions: InteractionSummary[];
}

export interface InteractionSummary {
  id: string;
  timestamp: number;
  promptSummary: string;
  status: 'pending' | 'streaming' | 'completed' | 'error';
  blockCount: number;
}

export interface MinionsGetInteractionDetailParams {
  minionId: string;
  interactionId: string;
}

export interface MinionsGetInteractionDetailResult {
  id: string;
  timestamp: number;
  userPrompt: string;
  fullRequest: string;
  responseBlocks: ResponseBlock[];
  status: 'pending' | 'streaming' | 'completed' | 'error';
  error?: string;
}

export interface ResponseBlock {
  type: 'message' | 'reasoning' | 'tool_use' | 'tool_result' | 'init' | string;
  content?: string;
  name?: string;
  input?: unknown;
  output?: unknown;
  timestamp?: number;
  [anyKey: string]: unknown;
}

// ========== Question Tools ==========

export interface AskContent {
  type: 'markdown' | 'html' | 'vue' | 'review' | 'variants';
  content: string;
  /** Named SFC strings for vue type; resolved as modules during server-side compilation */
  components?: Record<string, string>;
}

export interface VariantFeature {
  id: string;
  name: string;
  description?: string;
}

export interface Variant {
  id: string;
  name: string;
  description?: string;
  html: string;
  features: VariantFeature[];
}

export interface VariantsContent {
  __type: 'variants';
  variants: Variant[];
}

export interface AskOption {
  value: string;
  label: string;
  description?: string;
}

export interface AskControl {
  name: string;
  type: 'textarea';
  label: string;
  hint?: string;
  placeholder?: string;
  rows?: number;
}

export type AskParams =
  | {
      action: 'blocking' | 'nonblocking';
      question: string;
      content: AskContent;
      options: AskOption[];
      optionsMode: 'exclusive' | 'non-exclusive';
      controls?: AskControl[];
    }
  | { action: 'await'; questionId: string }
  | { action: 'list'; wingName?: string; status?: 'open' | 'answered' | 'cancelled' }
  | { action: 'answer'; questionId: string; answer: string };

export type AskResult =
  | { answer: string }
  | { questionId: string }
  | { questions: QuestionSummary[] }
  | { success: boolean };

export interface QuestionsListParams {
  wingName?: string;
  status?: 'open' | 'answered' | 'cancelled';
}

export interface QuestionsListResult {
  questions: QuestionSummary[];
}

export interface QuestionSummary {
  id: string;
  minionId: string;
  wingName: string;
  question: string;
  content: AskContent;
  options: AskOption[];
  optionsMode: 'exclusive' | 'non-exclusive';
  controls?: AskControl[];
  timestamp: number;
  status: 'open' | 'answered' | 'cancelled';
  answer?: string;
}

export interface QuestionsAnswerParams {
  questionId: string;
  answer: string;
}

export interface QuestionsAnswerResult {
  success: boolean;
}

// ========== Archive Tools ==========

// oxlint-disable-next-line no-empty-interface
export interface ArchivesListParams {
  // No params required for this tool
}

export interface ArchivesListResult {
  archives: ArchiveSummary[];
}

export interface ArchiveSummary {
  name: string;
  type: 'work' | 'info' | 'private';
  path: string;
  remoteUrl?: string;
}

/**
 * Authentication credentials for cloning private repositories.
 *
 * For GitHub:
 * - Use `token` alone (username optional, defaults to 'oauth2')
 * - Example: { token: 'ghp_xxxx' }
 *
 * For Bitbucket:
 * - Use `username` + `token` (app password)
 * - Example: { username: 'myuser', token: 'xxxx' }
 */
export interface CloneAuthParams {
  /** Username for authentication. Required for Bitbucket. Optional for GitHub. */
  username?: string;
  /** Authentication token (GitHub PAT) or app password (Bitbucket). */
  token: string;
}

export interface ArchivesAddParams {
  type: 'work' | 'info' | 'private';
  name: string;
  url?: string; // Required for work/info, not used for private
  auth?: CloneAuthParams; // Optional authentication for private repos
  branch?: string; // Optional branch to checkout (info archives only, ignored for work/private)
}

export interface ArchivesAddResult {
  message: string;
  archive: ArchiveSummary;
}

export interface ArchivesRemoveParams {
  type: 'work' | 'info' | 'private';
  name: string;
}

export interface ArchivesRemoveResult {
  message: string;
  removedArchive: string;
}

// ========== Costume Tools ==========

/**
 * Production install params - installs to lair closet, links to dist/
 */
export interface CostumesInstallParams {
  wingName: string;
  costumePath: string;
  installedName: string;
}

export interface CostumesInstallResult {
  message: string;
  closetLink: string;
  commandsLink?: string;
  agentsLink?: string;
  skillsLink?: string;
}

/**
 * Debug install params - installs to a wing's closet, links to src/
 */
export interface CostumesDebugInstallParams {
  wingName: string;
  costumePath: string;
  installedName: string;
  /** Name of the wing to install the costume into (wing closet) */
  targetWingName: string;
}

export interface CostumesDebugInstallResult {
  message: string;
  closetLink: string;
  commandsLink?: string;
  agentsLink?: string;
  skillsLink?: string;
}

/**
 * Install a Claude Code marketplace plugin as a costume.
 * Handles all plugin component types: skills, agents, commands, hooks, MCP servers, etc.
 * Writes enabledPlugins to user-level ~/.claude/settings.json so the plugin is active
 * in all sessions on this machine, including all existing and future wings.
 */
export interface CostumesInstallFromMarketplaceParams {
  /** Plugin name from the marketplace (e.g. "frontend-design") */
  pluginName: string;
  /** Marketplace identifier. Defaults to "claude-plugins-official" */
  marketplace?: string;
  /** Name to register the costume as. Defaults to pluginName */
  installedName?: string;
}

export interface CostumesInstallFromMarketplaceResult {
  message: string;
  closetPath: string;
  commandsPath?: string;
  agentsPath?: string;
  skillsPath?: string;
}

// oxlint-disable-next-line no-empty-interface
export interface CostumesListParams {
  // No params required for this tool
}

export interface CostumesListResult {
  costumes: InstalledCostumeSummary[];
}

/**
 * Summary of an installed costume in the closet.
 */
export interface InstalledCostumeSummary {
  /** Name of the costume (directory name in closet) */
  name: string;
  /** Whether this is a debug-installed costume (via symlink/junction) */
  isDebugInstalled: boolean;
  /** For debug-installed: the wing containing the source */
  debugSourceWing?: string;
  /** For debug-installed: the path within the wing's work/local */
  debugSourcePath?: string;
  /** List of mission names if any */
  missions: string[];
  /** List of disguise names if any */
  disguises: string[];
  /** List of skill names if any */
  skills: string[];
}

// ========== SSE Event Types ==========

export interface SSEMessageEvent {
  type: 'message';
  role: 'user' | 'assistant' | 'system';
  content: string;
  messageType?: string;
  timestamp: number;
  minionId: string;
}

export interface SSEConnectedEvent {
  type: 'connected';
  minionId: string;
  timestamp: number;
}

export interface SSEInteractionStartedEvent {
  type: 'interaction_started';
  interactionId: string;
  promptSummary: string;
  timestamp: number;
}

export interface SSEInteractionBlockEvent {
  type: 'interaction_block';
  interactionId: string;
  block: ResponseBlock;
}

export interface SSEInteractionCompletedEvent {
  type: 'interaction_completed';
  interactionId: string;
  status: 'completed' | 'error';
}

export type SSEEvent =
  | SSEMessageEvent
  | SSEConnectedEvent
  | SSEInteractionStartedEvent
  | SSEInteractionBlockEvent
  | SSEInteractionCompletedEvent;

// ========== Mission Tools ==========

export interface MissionListParams {
  wingName: string;
}

export interface MissionListResult {
  missions: MissionSummary_[];
}

/**
 * Summary of a mission available in the closet.
 * Named MissionSummary_ to avoid conflict with MinionSummary.
 */
export interface MissionSummary_ {
  costume: string;
  name: string;
  description?: string;
  argsSchema?: MissionArgsSchemaType;
  isLegacy: boolean;
  /** Whether the mission can be started (false for legacy Promise-based missions) */
  runnable: boolean;
  /** If not runnable, explains why */
  unrunnableReason?: string;
}

/**
 * JSON Schema for mission arguments
 */
export interface MissionArgsSchemaType {
  type: 'object';
  properties: Record<string, MissionPropertySchemaType>;
  required?: string[];
}

export interface MissionPropertySchemaType {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'file-path';
  description?: string;
  default?: unknown;
  items?: MissionPropertySchemaType;
  enum?: unknown[];
}

export interface MissionStartParams {
  wingName: string;
  costume: string;
  mission: string;
  args?: Record<string, unknown>;
}

export interface MissionStartResult {
  missionRunId: string;
  missionName: string;
  costume: string;
}

export type MissionRunStatus = 'running' | 'completed' | 'failed' | 'cancelled';

export interface MissionEventsParams {
  missionRunId: string;
}

export interface MissionEventsResult {
  missionRunId: string;
  status: MissionRunStatus;
  events: MissionEventRecord[];
}

export interface MissionEventRecord {
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface MissionCancelParams {
  missionRunId: string;
  reason?: string;
}

export interface MissionCancelResult {
  success: boolean;
  missionRunId: string;
}

export interface MissionsRunningParams {
  wingName?: string;
}

export interface MissionsRunningResult {
  missions: TrackedMissionSummary[];
}

export interface TrackedMissionSummary {
  missionRunId: string;
  missionName: string;
  costume: string;
  wingName: string;
  status: MissionRunStatus;
  startedAt: number;
}

// ========== Demos Tools ==========

export interface DemosListParams {
  wingName: string;
}

export interface DemoSummary {
  /** Relative to .meta/ — becomes give-demo's slicePath arg */
  slicePath: string;
  /** From demo.json title field */
  title: string;
}

export interface DemosListResult {
  demos: DemoSummary[];
}

// ========== Quality Status Tools ==========

export type QualityStatusParams = Record<string, never>;

export type QualityStatusResult = QualityStatus;


// ========== Planner Tools ==========

export type PlanItemType = 'task' | 'fork' | 'option';

export interface PlanItemRecord {
  id: string;
  title: string;
  type: PlanItemType;
  parent: string | null;
  children: string[];
  requires: string[];
  exploring?: Record<string, string>;
  approved?: false | true | 'tentative';
  started?: boolean;
  /** True when this item is on the active path leading to a claimed leaf. Does NOT mean this item is itself claimed. */
  onPath?: boolean;
  /** Set only on the leaf node being actively worked on; identifies the wing and branch doing the work. */
  claimedBy?: { wing: string; branch: string };
  demoLink?: string;
  questions?: string[];
  /** True when the overlord has explicitly queued this item for execution. Only valid when approved is non-false. */
  ready?: boolean;
  /**
   * Product-space placement, keyed by space kind ('user-flow' | 'data-flow'): the
   * stable locations (and optionally flows) this node touches. Locations/flows
   * themselves are defined in .meta/plan/.spaces/*.json.
   */
  places?: Record<string, { locationIds: string[]; flowIds?: string[] }>;
  /** Populated when get-subtree is called with includeDetails:true */
  details?: string;
  /** Contextual markdown from ancestor nodes. Populated when get-subtree is called with includeDetails:true. Always empty for root items. */
  parentContext?: string;
}

export interface SubtreeRecord {
  root: string;
  items: Record<string, PlanItemRecord>;
}

export type PlanItemRecordView = Omit<PlanItemRecord, 'children' | 'requires'> & {
  children?: string[];
  requires?: string[];
};

export interface SubtreeRecordView {
  root: string;
  items: Record<string, PlanItemRecordView>;
}

/**
 * A product-space definition, as persisted at .meta/plan/.spaces/<kind>.json.
 * Locations are stable "places"; flows are linear traversals across them.
 */
export interface ProductSpaceData {
  kind: string;
  title: string;
  caption: string;
  locations: Array<{ id: string; label: string; x: number; y: number; kind: string }>;
  flows: Array<{ id: string; label: string; color: string; path: string[] }>;
}

export type PlanParams =
  | { action: 'list-wings' }
  | { action: 'list-roots' }
  | { action: 'get-subtree'; itemId: string; includeDetails?: boolean }
  | { action: 'delete-subtree'; itemId: string }
  | { action: 'add-children'; parentId: string; children: Array<{ title: string; type?: PlanItemType; details: string; context: string }> }
  | { action: 'claim-node'; nodeId: string; goalId: string }
  | { action: 'get-spaces' };

export type PlanResult =
  | { action: 'list-wings'; wings: Array<{ name: string; branch: string }> }
  | { action: 'list-roots'; roots: Array<{ id: string; title: string }> }
  | { action: 'get-subtree'; subtree: SubtreeRecord | null; details: string; parentContext: string }
  | { action: 'delete-subtree'; deleted: string }
  | { action: 'add-children'; created: PlanItemRecord[] }
  | { action: 'claim-node'; nodeId: string; goalId: string; path: string[] }
  | { action: 'get-spaces'; spaces: Record<string, ProductSpaceData> };

// ========== Review Tools ==========

export interface ReviewDocumentsParams {
  paths: string[];
  purpose: string;
  scope?: string;
  callerSessionId?: string;
}

export interface ReviewDocumentsResult {
  summary: string;
  /** Files changed during the review (human + resolver commits), relative to work/local */
  changedFiles: string[];
}

// ========== Consolidated Tool Types ==========

export type MissionsParams =
  | { action: 'list'; wingName: string }
  | { action: 'start'; wingName: string; costume: string; mission: string; args?: Record<string, unknown> }
  | { action: 'events'; missionRunId: string }
  | { action: 'cancel'; missionRunId: string; reason?: string }
  | { action: 'running'; wingName?: string };

export type MissionsResult =
  | MissionListResult
  | MissionStartResult
  | MissionEventsResult
  | MissionCancelResult
  | MissionsRunningResult;

export type ReviewParams =
  { action: 'start'; paths: string[]; purpose: string; scope?: string; callerSessionId?: string; wingName?: string };

export type ReviewResult = ReviewDocumentsResult;

export type MinionsParams =
  | { action: 'spawn'; wingName: string; client: MinionClient; agentPrompt?: string }
  | { action: 'list'; wingName?: string }
  | { action: 'send_message'; minionId: string; message: string }
  | { action: 'get_history'; minionId: string }
  | { action: 'get_interactions'; minionId: string }
  | { action: 'get_interaction_detail'; minionId: string; interactionId: string }
  | { action: 'kill'; minionId: string };

export type MinionsResult =
  | MinionsSpawnResult
  | MinionsListResult
  | MinionsSendMessageResult
  | MinionsGetHistoryResult
  | MinionsGetInteractionsResult
  | MinionsGetInteractionDetailResult
  | MinionsKillResult;

export type WingsParams =
  | { action: 'create'; name: string; workLocalRepo: string; description?: string; workLocalBranch?: string; extraWork?: Record<string, { repo: string; branch: string; subdir?: string }>; trunk?: string }
  | { action: 'delete'; name: string }
  | { action: 'update'; name: string; addWork?: Record<string, { repo: string; branch: string; subdir?: string }>; removeWork?: string[] }
  | { action: 'set-trunk'; name: string; trunk: string | null }
  | { action: 'sync-wing'; name?: string };

export interface WingsSyncResult {
  message: string;
  synced: string[];
}

export type WingsResult = WingsCreateResult | WingsDeleteResult | WingsUpdateResult | WingsSetTrunkResult | WingsSyncResult;

// ========== Experiment Tools ==========

export type ExperimentStatus = 'open' | 'completing' | 'resolved';

export interface ExperimentVariation {
  slug: string;
  trunkBranch: string;
  wings: string[];
}

export interface ExperimentRecord {
  id: string;
  status: ExperimentStatus;
  variations: ExperimentVariation[];
  winner: string | null;
}

export type ExperimentsParams =
  | { action: 'list'; repo?: string }
  | { action: 'get'; id: string; repo?: string }
  | { action: 'create'; id: string; variations: Array<{ slug: string }>; repo?: string }
  | { action: 'assign-wing'; id: string; slug: string; wingName: string; repo?: string }
  | { action: 'select-winner'; id: string; winnerSlug: string; repo?: string };

export type ExperimentsResult =
  | { action: 'list'; experiments: ExperimentRecord[] }
  | { action: 'get'; experiment: ExperimentRecord | null }
  | { action: 'create'; experiment: ExperimentRecord }
  | { action: 'assign-wing'; experiment: ExperimentRecord }
  | { action: 'select-winner'; experiment: ExperimentRecord };

export type ArchivesParams =
  | { action: 'list' }
  | { action: 'add'; type: 'work' | 'info' | 'private'; name: string; url?: string; auth?: CloneAuthParams; branch?: string }
  | { action: 'remove'; type: 'work' | 'info' | 'private'; name: string };

export type ArchivesResult = ArchivesListResult | ArchivesAddResult | ArchivesRemoveResult;

// ========== MCP Tool Map ==========

/**
 * Type-safe mapping of MCP tool names to their params and results
 */
export interface MCPToolMap {
  lair_get_state: { params: LairGetStateParams; result: LairGetStateResult };
  // Legacy individual tool names (kept for backwards compatibility with existing code that references them)
  wings_create: { params: WingsCreateParams; result: WingsCreateResult };
  wings_delete: { params: WingsDeleteParams; result: WingsDeleteResult };
  wings_update: { params: WingsUpdateParams; result: WingsUpdateResult };
  archives_list: { params: ArchivesListParams; result: ArchivesListResult };
  archives_add: { params: ArchivesAddParams; result: ArchivesAddResult };
  archives_remove: { params: ArchivesRemoveParams; result: ArchivesRemoveResult };
  minions_spawn: { params: MinionsSpawnParams; result: MinionsSpawnResult };
  minions_list: { params: MinionsListParams; result: MinionsListResult };
  minions_send_message: { params: MinionsSendMessageParams; result: MinionsSendMessageResult };
  minions_get_history: { params: MinionsGetHistoryParams; result: MinionsGetHistoryResult };
  minions_get_interactions: { params: MinionsGetInteractionsParams; result: MinionsGetInteractionsResult };
  minions_get_interaction_detail: { params: MinionsGetInteractionDetailParams; result: MinionsGetInteractionDetailResult };
  minions_kill: { params: MinionsKillParams; result: MinionsKillResult };
  mission_list: { params: MissionListParams; result: MissionListResult };
  mission_start: { params: MissionStartParams; result: MissionStartResult };
  mission_events: { params: MissionEventsParams; result: MissionEventsResult };
  mission_cancel: { params: MissionCancelParams; result: MissionCancelResult };
  missions_running: { params: MissionsRunningParams; result: MissionsRunningResult };
  questions_list: { params: QuestionsListParams; result: QuestionsListResult };
  questions_answer: { params: QuestionsAnswerParams; result: QuestionsAnswerResult };
  review_documents: { params: ReviewDocumentsParams; result: ReviewDocumentsResult };
  // Consolidated tools
  missions: { params: MissionsParams; result: MissionsResult };
  review: { params: ReviewParams; result: ReviewResult };
  minions: { params: MinionsParams; result: MinionsResult };
  wings: { params: WingsParams; result: WingsResult };
  archives: { params: ArchivesParams; result: ArchivesResult };
  ask: { params: AskParams; result: AskResult };
  demos_list: { params: DemosListParams; result: DemosListResult };
  quality_status: { params: QualityStatusParams; result: QualityStatusResult };
  plan: { params: PlanParams; result: PlanResult };
  gsd_compute_frames: { params: GsdComputeFramesParams; result: GsdComputeFramesResult };
  experiments: { params: ExperimentsParams; result: ExperimentsResult };
}

// ========== GSD Frame Types ==========

export type GsdFrameType = 'unblock' | 'refine' | 'pathfind' | 'risk-scan' | 'capture'
export type GsdItemRole = 'anchor' | 'chain' | 'context'

export interface GsdFrameItem {
  itemId: string
  role: GsdItemRole
}

export interface GsdFrame {
  id: string
  type: GsdFrameType
  title: string
  rationale: string
  saving: string
  priority: number
  items: GsdFrameItem[]
}

export interface GsdComputeFramesParams {
  items: Record<string, PlanItemRecordView>
  rootIds: string[]
}

export interface GsdComputeFramesResult {
  frames: GsdFrame[]
}

// ========== Endpoint Tool Sets ==========
// Single source of truth for which tools belong to which endpoint.
// Used by both the cabinet (ToolRegistry) and the throne room (type-safe clients).

export const THRONE_TOOL_NAMES = [
  'lair_get_state',
  'minions', 'missions', 'review', 'gsd_compute_frames',
  'experiments',
] as const satisfies readonly (keyof MCPToolMap)[];

export type ThroneToolName = typeof THRONE_TOOL_NAMES[number];

export const LAIR_TOOL_NAMES = [
  'archives',
] as const satisfies readonly (keyof MCPToolMap)[];

export type LairToolName = typeof LAIR_TOOL_NAMES[number];

export const CONDUCTOR_TOOL_NAMES = [
  'wings', 'minions', 'missions',
  'demos_list', 'experiments',
] as const satisfies readonly (keyof MCPToolMap)[];

export type ConductorToolName = typeof CONDUCTOR_TOOL_NAMES[number];

import path from 'path';
import type { Directory } from '@minions/file-store';
import type { MinionManager } from './MinionManager.js';
import type { Minion, MinionClient } from './types.js';
import { MinionStatus } from './types.js';
import { ConversationDumper } from './ConversationDumper.js';
import { HatcheryMinionAdapter } from './HatcheryMinionAdapter.js';
import type { ProductionHatchery, MinionSpec as HatcheryMinionSpec } from '@minions/hatchery';
import { formatPromptSummary } from './debug-tools.js';
import type { RawInteraction } from './MessageCapture.js';
import type { Message } from './types.js';

export interface MinionInfo {
  id: string;
  client: MinionClient;
  status: MinionStatus;
  wingName: string;
  createdAt: number;
}

export interface SpawnMinionResult {
  minionId: string;
  client: MinionClient;
  status: MinionStatus;
}

export interface ListMinionsResult {
  minions: MinionInfo[];
}

export interface MinionHistoryResult {
  messages: Minion['messageHistory'];
}

export interface InteractionSummary {
  id: string;
  timestamp: number;
  promptSummary: string;
  status: string;
  blockCount: number;
}

export interface MinionInteractionsResult {
  interactions: InteractionSummary[];
}

export interface InteractionDetail {
  id: string;
  timestamp: number;
  userPrompt: string;
  fullRequest: unknown;
  responseBlocks: unknown[];
  status: string;
  error?: string;
}

export type MinionInteractionDetailResult = InteractionDetail

export interface KillMinionResult {
  message: string;
  dumpPath?: string;
}

/**
 * Spawn a new minion using hatchery
 */
export async function spawnMinion(
  minionManager: MinionManager,
  hatchery: ProductionHatchery,
  client: MinionClient,
  wingName: string,
  lairRoot?: string,
  agentPrompt?: string
): Promise<SpawnMinionResult> {
  if (!minionManager || !hatchery) {
    throw new Error('Minion manager or hatchery not initialized');
  }

  // Create minion entry in cabinet's manager
  const minion = minionManager.create({
    client,
    wingName,
    agentPrompt
  });

  // Build hatchery minion spec
  const wingPath = lairRoot ? path.join(lairRoot, 'wings', wingName) : process.cwd();
  const hatcherySpec: HatcheryMinionSpec = {
    client,
    wing: wingPath,
    model: 'claude-sonnet-4-20250514',
    useBuiltInSystemPrompt: !agentPrompt,
    agentPrompt,
    sessionId: minion.sessionId,
  };

  // Spawn minion via hatchery
  const hatcheryMinion = await hatchery.spawn(hatcherySpec);

  // Wrap in adapter to bridge to cabinet's event system, reusing minion's persistent MessageCapture
  const adapter = new HatcheryMinionAdapter(hatcheryMinion, minion.messageCapture);

  // Store adapter as executor and set up event handlers
  minion.executor = adapter;
  setupEventHandlers(adapter, minion, minionManager);

  // Start the adapter (begins receiving messages from hatchery minion)
  await adapter.start();
  minionManager.updateStatus(minion.id, MinionStatus.Idle);

  return {
    minionId: minion.id,
    client: client,
    status: minion.status
  };
}

/**
 * List all minions, optionally filtered by wing
 */
export function listMinions(
  minionManager: MinionManager,
  wingName?: string
): ListMinionsResult {
  if (!minionManager) {
    throw new Error('Minion manager not initialized');
  }

  const minions = minionManager.list(
    wingName ? { wingName } : undefined
  );

  // Remove executor from serialization
  const serializedMinions = minions.map((m: Minion) => ({
    id: m.id,
    client: m.client,
    status: m.status,
    wingName: m.wingName,
    createdAt: m.created
  }));

  return {
    minions: serializedMinions
  };
}

/**
 * Get full conversation history for a minion
 */
export function getMinionHistory(
  minionManager: MinionManager,
  minionId: string
): MinionHistoryResult {
  if (!minionManager) {
    throw new Error('Minion manager not initialized');
  }

  if (!minionId) {
    throw new Error('Minion ID is required');
  }

  const minion = minionManager.get(minionId);
  if (!minion) {
    throw new Error(`Minion not found: ${minionId}`);
  }

  return {
    messages: minion.messageHistory
  };
}

/**
 * Get all raw API interactions for a minion (debug view)
 */
export function getMinionInteractions(
  minionManager: MinionManager,
  minionId: string
): MinionInteractionsResult {
  if (!minionManager) {
    throw new Error('Minion manager not initialized');
  }

  if (!minionId) {
    throw new Error('Minion ID is required');
  }

  const minion = minionManager.get(minionId);
  if (!minion) {
    throw new Error(`Minion not found: ${minionId}`);
  }

  const capture = minion.executor?.getMessageCapture() ?? minion.messageCapture;

  const interactions = capture.getAllInteractions();

  // Format for UI with prompt summaries
  return {
    interactions: interactions.map((i: RawInteraction) => ({
      id: i.id,
      timestamp: i.timestamp,
      promptSummary: formatPromptSummary(i.userPrompt),
      status: i.status,
      blockCount: i.responseBlocks.length
    }))
  };
}

/**
 * Get full details of a specific interaction (debug view)
 */
export function getMinionInteractionDetail(
  minionManager: MinionManager,
  minionId: string,
  interactionId: string
): MinionInteractionDetailResult {
  if (!minionManager) {
    throw new Error('Minion manager not initialized');
  }

  if (!minionId || !interactionId) {
    throw new Error('Minion ID and interaction ID are required');
  }

  const minion = minionManager.get(minionId);
  if (!minion) {
    throw new Error(`Minion not found: ${minionId}`);
  }

  const capture = minion.executor?.getMessageCapture() ?? minion.messageCapture;

  const interaction = capture.getInteraction(interactionId);

  if (!interaction) {
    throw new Error(`Interaction not found: ${interactionId}`);
  }

  // Return full interaction details
  return {
    id: interaction.id,
    timestamp: interaction.timestamp,
    userPrompt: interaction.userPrompt,
    fullRequest: interaction.fullRequest,
    responseBlocks: interaction.responseBlocks,
    status: interaction.status,
    error: interaction.error
  };
}

/**
 * Set up event handlers on an adapter for a minion.
 * Extracted so it can be reused by both spawnMinion() and respawnExecutor().
 */
function setupEventHandlers(
  adapter: HatcheryMinionAdapter,
  minion: Minion,
  minionManager: MinionManager
): void {
  adapter.on('turn_started', () => {
    console.log(`Minion ${minion.id} turn started`);
    minionManager.updateStatus(minion.id, MinionStatus.Working);
  });

  adapter.on('content', (block) => {
    const timestamp = Date.now();
    minion.messageHistory.push({
      role: 'assistant',
      content: JSON.stringify(block),
      timestamp
    });
  });

  adapter.on('turn_ended', () => {
    console.log(`Minion ${minion.id} turn ended`);
    minionManager.updateStatus(minion.id, MinionStatus.Idle);
  });

  adapter.on('error', (error) => {
    console.error(`Minion ${minion.id} error:`, error);
    minionManager.updateStatus(minion.id, MinionStatus.Blocked);
  });

  adapter.on('session_ended', () => {
    console.log(`Minion ${minion.id} session ended (process exited), setting to Idle`);
    minion.executor = undefined;
    minionManager.updateStatus(minion.id, MinionStatus.Idle);
  });
}

/**
 * Build a resume context from message history for clients that don't support
 * native session resumption. Formats the conversation history as a markdown
 * preamble that can be prepended to the agent prompt.
 */
function buildResumeContext(messageHistory: Message[]): string | undefined {
  if (messageHistory.length === 0) return undefined;

  const lines: string[] = [
    '## Previous Conversation Context',
    'You are continuing a previous conversation. Here is what has happened so far:',
    ''
  ];

  for (const msg of messageHistory) {
    const role = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : 'System';
    // Truncate very long messages for the summary
    const content = msg.content.length > 500
      ? msg.content.substring(0, 500) + '...[truncated]'
      : msg.content;
    lines.push(`**${role}**: ${content}`);
    lines.push('');
  }

  lines.push('---');
  lines.push('Continue from where you left off.');

  return lines.join('\n');
}

/**
 * Respawn an executor for an idle minion that has no active process.
 *
 * This creates a new agent process, reusing the minion's session ID for
 * conversation continuity. For claude-code, the session ID enables native
 * history restoration. For other clients, a resume context is injected
 * as a prompt preamble.
 */
export async function respawnExecutor(
  minion: Minion,
  hatchery: ProductionHatchery,
  minionManager: MinionManager,
  lairRoot?: string
): Promise<void> {
  // Build hatchery spec from minion's stored configuration
  const wingPath = lairRoot ? path.join(lairRoot, 'wings', minion.wingName) : process.cwd();

  let agentPrompt = minion.agentPrompt;

  // For clients that don't support native session resumption,
  // inject resume context from message history
  if (minion.client !== 'claude-code') {
    const resumeContext = buildResumeContext(minion.messageHistory);
    if (resumeContext) {
      agentPrompt = (agentPrompt ?? '') + '\n\n' + resumeContext;
    }
  }

  const hatcherySpec: HatcheryMinionSpec = {
    client: minion.client,
    wing: wingPath,
    model: 'claude-sonnet-4-20250514',
    useBuiltInSystemPrompt: !agentPrompt,
    agentPrompt,
    sessionId: minion.sessionId,
  };

  // Spawn new hatchery minion
  const hatcheryMinion = await hatchery.spawn(hatcherySpec);

  // Create new adapter, reusing the minion's persistent MessageCapture
  const adapter = new HatcheryMinionAdapter(hatcheryMinion, minion.messageCapture);
  minion.executor = adapter;

  // Re-attach event handlers
  setupEventHandlers(adapter, minion, minionManager);

  // Start the adapter
  await adapter.start();
  minionManager.updateStatus(minion.id, MinionStatus.Idle);
}

/**
 * Kill a minion and dump its conversation history
 */
export async function killMinion(
  minionManager: MinionManager,
  minionId: string,
  wingsDir?: Directory
): Promise<KillMinionResult> {
  if (!minionManager) {
    throw new Error('Minion manager not initialized');
  }

  if (!minionId) {
    throw new Error('Minion ID is required');
  }

  const minion = minionManager.get(minionId);
  if (!minion) {
    throw new Error(`Minion not found: ${minionId}`);
  }

  // Stop the executor if running and clear it
  if (minion.executor) {
    minion.executor.stop();
    minion.executor = undefined;
  }

  // Update status
  minionManager.updateStatus(minionId, MinionStatus.Dead);

  // Dump conversation if wingsDir available
  let dumpPath: string | undefined;
  if (wingsDir) {
    const dumper = new ConversationDumper(wingsDir);
    const dumpFile = await dumper.dump(minion);
    dumpPath = dumpFile.name;
  }

  // Remove from manager
  minionManager.remove(minionId);

  return {
    message: dumpPath
      ? `Minion "${minionId}" killed. Conversation dumped to: ${dumpPath}`
      : `Minion "${minionId}" killed. No dump created (wingsDir not available).`,
    dumpPath
  };
}

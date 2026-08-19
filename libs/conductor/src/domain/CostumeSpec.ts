/**
 * CostumeSpec - Helper for building MinionSpec from Costume
 *
 * This module provides the buildSpecFromCostume helper that constructs
 * a complete MinionSpec from a Costume definition. The helper applies
 * costume properties as defaults and allows explicit overrides to take
 * precedence.
 */

import type { MinionSpec, MinionClient, MinionMessage } from '@minions/domain-types';
import type { ExecutableGadget } from '@minions/gadgets';
import type { Costume, CostumeEvent, Skill } from './Costume';
import type { IWorkbench } from './Workbench';

/**
 * Extended MinionSpec that includes costume-specific properties
 *
 * These properties are stored in the spec for future use but may not
 * be immediately consumed by hatchery. They enable:
 * - Skills integration (future)
 * - Bidirectional events (auto-injection of event gadgets)
 * - Workbench integration (fact filtering)
 */
export interface ExtendedMinionSpec extends MinionSpec {
  /**
   * Skills from the costume (for future use)
   *
   * Skills are stored in the spec but not yet used by hatchery.
   * Future skills integration will consume this property.
   */
  skills?: Skill[];

  /**
   * Events from the costume (for future auto-injection)
   *
   * Events are stored in the spec to enable future auto-injection
   * of event gadgets (get_event_schema, emit_event) in the
   * Bidirectional Events slice.
   */
  events?: CostumeEvent[];

  /**
   * Fact categories for Workbench integration
   *
   * These categories determine which facts from the Workbench
   * are injected into the minion's context. Used by Workbench
   * filtering logic.
   */
  injectFacts?: string[];

  /**
   * Executable gadgets with mission context
   *
   * These are runtime closures created by conductor that have mission
   * context (costume, event bus, etc.) captured in their closures.
   * Hatchery passes these to minions for execution. When a minion
   * requests a tool by name, hatchery checks this array and executes
   * the matching gadget if found.
   *
   * Example: Event gadgets (get_event_schema, emit_event) created by
   * createEventGadgets() factory when spawning minions with costumes
   * that define events.
   */
  executableGadgets?: ExecutableGadget[];

  /**
   * Workbench instance for shared context
   *
   * When provided, the workbench is available to the minion for
   * accessing shared files and facts. Used in combination with
   * syntheticHistory to inject pre-discovered context.
   */
  workbench?: IWorkbench;

  /**
   * Synthetic message history for context injection
   *
   * Pre-populated message history that appears as if the minion
   * had previously executed gadgets to discover this information.
   * Generated from workbench contents when both workbench and
   * injectFacts are present.
   */
  syntheticHistory?: MinionMessage[];
}

/**
 * Overrides for buildSpecFromCostume
 *
 * All properties are optional. When provided, they take precedence
 * over costume defaults.
 */
export interface CostumeSpecOverrides {
  /** Override the client type */
  client?: MinionClient;

  /** Override the wing (working directory) */
  wing?: string;

  /** Override the model */
  model?: string;

  /** Override useBuiltInSystemPrompt setting */
  useBuiltInSystemPrompt?: boolean;

  /** Override the agent prompt */
  agentPrompt?: string;

  /** Override the tools */
  tools?: MinionSpec['tools'];

  /** Override the minion name */
  name?: string;

  /** Override the metadata */
  metadata?: MinionSpec['metadata'];

  /** Override the skills */
  skills?: Skill[];

  /** Override the events */
  events?: CostumeEvent[];

  /** Override the injectFacts */
  injectFacts?: string[];

  /**
   * Session ID for conversation history inheritance (clone support).
   * Passed through to MinionSpec.sessionId.
   */
  sessionId?: string;
}

/**
 * Model compatibility map
 *
 * Defines which models are compatible with which client types.
 * This is used to validate that the costume's model is compatible
 * with the requested client type.
 */
const MODEL_CLIENT_COMPATIBILITY: Record<string, MinionClient[]> = {
  // Claude models are compatible with Anthropic clients
  'claude-sonnet-4-20250514': ['claude-code', 'anthropic-agentic', 'brainless'],
  'claude-opus-4-20250514': ['claude-code', 'anthropic-agentic', 'brainless'],
  'claude-sonnet-3-5-20241022': ['claude-code', 'anthropic-agentic', 'brainless'],

  // OpenAI models are compatible with OpenAI clients
  'gpt-4': ['opencode', 'brainless'],
  'gpt-4-turbo': ['opencode', 'brainless'],
  'gpt-3.5-turbo': ['opencode', 'brainless'],

  // Codestral models
  'codestral-latest': ['code-puppy', 'brainless'],
};

/**
 * Validate model compatibility with client type
 *
 * Checks if the specified model is compatible with the requested
 * client type. Throws an error if incompatible.
 *
 * @param model - Model identifier
 * @param client - Client type
 * @throws Error if model is incompatible with client
 */
function validateModelCompatibility(model: string, client: MinionClient): void {
  // Brainless client accepts any model (for testing)
  if (client === 'brainless') {
    return;
  }

  const compatibleClients = MODEL_CLIENT_COMPATIBILITY[model];

  if (!compatibleClients) {
    // Unknown model - log warning but allow it
    console.warn(`Unknown model "${model}" - cannot verify compatibility with client "${client}"`);
    return;
  }

  if (!compatibleClients.includes(client)) {
    throw new Error(
      `Model "${model}" is not compatible with client type "${client}". ` +
      `Compatible clients: ${compatibleClients.join(', ')}`
    );
  }
}

/**
 * Build event guidance text for system prompt
 *
 * Generates guidance text that instructs the minion about available events.
 * Format for each event:
 * - **{eventName}**: {guidance}
 *   Use get_event_schema('{eventName}') to see payload structure, then emit_event('{eventName}', payload) to emit.
 *
 * @param events - Array of costume events
 * @returns Formatted guidance text, or empty string if no events
 */
function buildEventGuidance(events: CostumeEvent[]): string {
  if (!events || events.length === 0) {
    return '';
  }

  const eventEntries = events.map(({ event, guidance }) => {
    const eventName = event.type;
    return `- **${eventName}**: ${guidance}\n  Use get_event_schema('${eventName}') to see payload structure, then emit_event('${eventName}', payload) to emit.`;
  });

  return `\n\nYou can emit the following events:\n\n${eventEntries.join('\n\n')}`;
}

/**
 * Build a MinionSpec from a Costume with optional overrides
 *
 * This helper constructs a complete MinionSpec from a Costume definition.
 * The costume provides defaults, and explicit overrides take precedence.
 *
 * Mapping:
 * - costume.model → spec.model
 * - costume.systemPrompt → spec.agentPrompt
 * - costume.gadgets → spec.tools
 * - costume.skills → spec.skills (extended property)
 * - costume.events → spec.events (extended property)
 * - costume.injectFacts → spec.injectFacts (extended property)
 *
 * Event Guidance:
 * When costume.events (or overrides.events) is defined and non-empty,
 * event guidance is appended to the agentPrompt. This guidance is NOT
 * appended if agentPrompt is explicitly overridden.
 *
 * @param costume - Costume definition
 * @param overrides - Optional overrides that take precedence
 * @returns Complete ExtendedMinionSpec
 * @throws Error if model is incompatible with client type
 *
 * @example
 * ```typescript
 * const costume: Costume = {
 *   model: 'claude-sonnet-4-20250514',
 *   systemPrompt: 'You are a developer...',
 *   gadgets: [readTool, writeTool],
 *   skills: [],
 *   events: [],
 *   injectFacts: ['build', 'test'],
 * };
 *
 * const spec = buildSpecFromCostume(costume, {
 *   client: 'claude-code',
 *   wing: '/path/to/wing',
 *   name: 'developer-minion',
 * });
 * ```
 */
export function buildSpecFromCostume(
  costume: Costume,
  overrides?: CostumeSpecOverrides
): ExtendedMinionSpec {
  // Determine client type (override or default to brainless)
  const client = overrides?.client ?? 'brainless';

  // Determine model (override takes precedence)
  const model = overrides?.model ?? costume.model;

  // Validate model compatibility with client
  validateModelCompatibility(model, client);

  // Determine which events to use (override takes precedence)
  const events = overrides?.events ?? costume.events;

  // Build base agentPrompt (override takes precedence, then costume)
  let agentPrompt = overrides?.agentPrompt ?? costume.systemPrompt;

  // Append event guidance if no override and events are defined
  if (!overrides?.agentPrompt && events && events.length > 0) {
    const basePrompt = agentPrompt ?? '';
    const eventGuidance = buildEventGuidance(events);
    agentPrompt = basePrompt + eventGuidance;
  }

  // Build the spec with costume defaults and overrides
  const spec: ExtendedMinionSpec = {
    // Required MinionSpec properties
    client,
    wing: overrides?.wing ?? '',
    model,
    useBuiltInSystemPrompt: overrides?.useBuiltInSystemPrompt ?? false,

    // Optional MinionSpec properties (override takes precedence, then costume)
    agentPrompt,
    tools: overrides?.tools ?? costume.gadgets,
    name: overrides?.name,
    metadata: overrides?.metadata,

    // Extended properties (override takes precedence, then costume)
    skills: overrides?.skills ?? costume.skills,
    events,
    injectFacts: overrides?.injectFacts ?? costume.injectFacts,

    // Clone support: session ID for conversation history inheritance
    sessionId: overrides?.sessionId,
  };

  return spec;
}

/**
 * Costume System
 *
 * A Costume defines everything about how a minion operates, including:
 * - AI configuration (model, system prompt)
 * - Available capabilities (gadgets, skills)
 * - Event definitions
 * - Workbench fact injection preferences
 *
 * Costumes are stored in the closet alongside missions and discovered by
 * ClosetCostumeLoader. There are no inline Costumes - all Costumes must be
 * defined in the closet.
 *
 * Key terminology:
 * - **Gadget**: An MCP tool. Gadgets are the tools exposed to minions via
 *   the Model Context Protocol.
 * - **Skill**: A Claude Code skill. Skills are higher-level capabilities that
 *   may combine multiple gadgets.
 *
 * @example
 * ```typescript
 * import { Schema } from 'effect';
 *
 * const DeveloperCostume: Costume = {
 *   model: 'claude-sonnet-4-20250514',
 *   systemPrompt: 'You are a developer agent...',
 *   gadgets: [
 *     { name: 'Read', description: 'Read file contents', input_schema: {} },
 *     { name: 'Write', description: 'Write file contents', input_schema: {} },
 *   ],
 *   skills: [],
 *   events: [
 *     {
 *       event: defineEvent<{ taskId: string; result: string }>(
 *         'implementation-complete',
 *         Schema.Struct({ taskId: Schema.String, result: Schema.String })
 *       ),
 *       guidance: 'Emit when feature is fully implemented and tested',
 *     },
 *   ],
 *   injectFacts: ['build', 'package-manager', 'structure'],
 * };
 * ```
 */

import type { EventDeclaration } from '@minions/events';

/**
 * MCP-style tool definition
 *
 * This is a simplified version to avoid circular dependencies with hatchery.
 * The full Tool type lives in hatchery's MinionSpec.
 */
export interface Tool {
  name: string;
  description: string;
  input_schema?: Record<string, unknown>;
}

/**
 * Placeholder type for Claude Code skills
 *
 * Skills are higher-level capabilities that may combine multiple gadgets.
 * The structure of skills is deferred to the skills integration slice.
 * For now, this is a placeholder type to establish the Costume interface.
 */
export type Skill = unknown;

/**
 * Event definition within a Costume
 *
 * Associates an EventDeclaration with guidance about when to emit it.
 * The event declaration includes an Effect Schema for payload validation.
 */
export interface CostumeEvent {
  /**
   * Event declaration with payload type and Effect Schema
   *
   * The schema is used for runtime validation when the event is emitted.
   * Per PRD lines 176-179, event declarations must include Effect Schema.
   */
  event: EventDeclaration;

  /**
   * Guidance string for when to emit this event
   *
   * This guidance is provided to the minion to help it understand when
   * to emit this event. Should be clear, actionable, and specific.
   *
   * @example
   * - "Emit when feature is fully implemented and tested"
   * - "Emit if you encounter an obstacle that blocks progress"
   * - "Emit when code review is complete with findings"
   */
  guidance: string;
}

/**
 * Costume definition
 *
 * A Costume defines everything about how a minion operates. Costumes are
 * stored in the closet and referenced by name when spawning minions.
 *
 * Costumes provide defaults that can be overridden at spawn time. The
 * precedence rule is: costume provides defaults, explicit overrides take
 * precedence.
 */
export interface Costume {
  /**
   * Model identifier for the AI client (REQUIRED, non-empty)
   *
   * @example "claude-sonnet-4-20250514"
   */
  model: string;

  /**
   * System prompt for the minion (OPTIONAL)
   *
   * This can be loaded from a prompt.md file in the costume directory
   * or specified directly in the costume definition.
   */
  systemPrompt?: string;

  /**
   * Gadgets (MCP tools) available to the minion (OPTIONAL)
   *
   * Gadgets ARE MCP tools, so we use the existing Tool interface from
   * MinionSpec. These are the low-level tools exposed via the Model
   * Context Protocol.
   */
  gadgets?: Tool[];

  /**
   * Skills (Claude Code skills) available to the minion (OPTIONAL)
   *
   * Skills are higher-level capabilities that may combine multiple gadgets.
   * The structure of skills is deferred - for now, this is a placeholder.
   */
  skills?: Skill[];

  /**
   * Events this costume can emit (OPTIONAL)
   *
   * Each event includes an EventDeclaration (with Effect Schema) and
   * guidance about when to emit it. Events are primarily defined by the
   * Costume, with per-interaction overrides possible at send() time.
   */
  events?: CostumeEvent[];

  /**
   * Which Workbench fact categories to inject (OPTIONAL)
   *
   * This is an array of open-ended strings (not an enum). Anyone can
   * define any category. Examples: 'build', 'test', 'structure',
   * 'convention', 'package-manager', 'deployment', etc.
   *
   * Facts matching these categories will be injected into the minion's
   * context when spawning with a Workbench.
   *
   * @example
   * - Developer: ['build', 'package-manager', 'structure']
   * - Demo: ['build']
   * - Planner: []
   */
  injectFacts?: string[];
}

/**
 * Type guard to check if a value is a valid Costume
 *
 * Validates that:
 * - Required fields: model (string, non-empty)
 * - Optional fields: systemPrompt, gadgets, skills, events, injectFacts
 * - Optional fields must have correct type IF present
 *
 * "Strict but optional" means: if a field is present, it must be the right type.
 * If a field is missing, that's fine for optional fields.
 */
export function isCostume(value: unknown): value is Costume {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;

  // Required: model must be a non-empty string
  if (typeof obj.model !== 'string' || obj.model.length === 0) {
    return false;
  }

  // Optional: systemPrompt must be string IF present
  if (obj.systemPrompt !== undefined && typeof obj.systemPrompt !== 'string') {
    return false;
  }

  // Optional: gadgets must be array IF present
  if (obj.gadgets !== undefined && !Array.isArray(obj.gadgets)) {
    return false;
  }

  // Optional: skills must be array IF present
  if (obj.skills !== undefined && !Array.isArray(obj.skills)) {
    return false;
  }

  // Optional: events must be array IF present
  if (obj.events !== undefined && !Array.isArray(obj.events)) {
    return false;
  }

  // Optional: injectFacts must be array IF present
  if (obj.injectFacts !== undefined && !Array.isArray(obj.injectFacts)) {
    return false;
  }

  return true;
}

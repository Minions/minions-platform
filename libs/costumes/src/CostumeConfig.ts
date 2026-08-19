/**
 * Costume Configuration (costume.json schema)
 *
 * CostumeConfig is the JSON-serializable configuration for a costume.
 * It replaces costume.ts with pure data: model, prompt references,
 * and entrypoint references to gadgets, missions, and events.
 *
 * Entrypoints use { file, export } so the same schema works for both
 * src/ (debug install) and dist/ (production install) — only the
 * file paths differ.
 */

/**
 * Reference to a loadable export in a TypeScript/JavaScript file.
 *
 * In src/ (debug install): { file: "gadgets/ping.ts", export: "gadget" }
 * In dist/ (production):   { file: "bundle.js", export: "ping_gadget" }
 */
export interface Entrypoint {
  /** Path to the file, relative to the costume directory */
  file: string;
  /** Named export to import from the file */
  export: string;
}

/**
 * Event reference in costume.json
 *
 * Associates an entrypoint (which exports a CostumeEventDef) with
 * guidance about when to emit the event.
 */
export interface CostumeEventRef {
  /** Entrypoint to the event definition file */
  entrypoint: Entrypoint;
  /** Guidance for when to emit this event */
  guidance: string;
}

/**
 * MCP server configuration for an externally-proxied server.
 * The cabinet connects to this server and proxies its tools to wings.
 */
export interface McpServerConfig {
  /** Transport type */
  type: 'stdio' | 'sse' | 'http';
  /** Executable command (stdio only) */
  command?: string;
  /** Arguments to pass to the command (stdio only) */
  args?: string[];
  /** Server URL (sse or http) */
  url?: string;
  /** Environment variables to set (stdio only) */
  env?: Record<string, string>;
  /** HTTP headers to send (sse/http only) */
  headers?: Record<string, string>;
}

/**
 * Wing-level accessories this costume contributes.
 * Controls what the cabinet exposes per wing and what gets linked into .claude/.
 */
export interface CostumeAccessories {
  /** Whether the costume has missions/ linked into .claude/commands/ */
  missions?: boolean;
  /** External MCP servers the cabinet will proxy for this costume, keyed by server name */
  mcpServers?: Record<string, McpServerConfig>;
}

/**
 * Costume configuration loaded from costume.json
 *
 * Pure data — no code. All executable content is referenced via
 * entrypoints that are dynamically imported at load time.
 */
export interface CostumeConfig {
  /** Model identifier for the AI client */
  model: string;

  /** Inline system prompt (mutually exclusive with systemPromptFile) */
  systemPrompt?: string;

  /** Path to system prompt file, relative to costume directory */
  systemPromptFile?: string;

  /** Entrypoints to gadget files in gadgets/ */
  gadgets?: Entrypoint[];

  /** Entrypoints to mission files in missions/ */
  missions?: Entrypoint[];

  /** Event references with guidance */
  events?: CostumeEventRef[];

  /** Workbench fact categories to inject */
  injectFacts?: string[];

  /** Wing-level accessories this costume contributes */
  accessories?: CostumeAccessories;
}

/**
 * Type guard for Entrypoint
 */
export function isEntrypoint(value: unknown): value is Entrypoint {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.file === 'string' && typeof obj.export === 'string';
}

const MCP_SERVER_TYPES = new Set(['stdio', 'sse', 'http']);

/**
 * Type guard for McpServerConfig
 */
export function isMcpServerConfig(value: unknown): value is McpServerConfig {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (!MCP_SERVER_TYPES.has(obj.type as string)) return false;
  if (obj.command !== undefined && typeof obj.command !== 'string') return false;
  if (obj.args !== undefined) {
    if (!Array.isArray(obj.args)) return false;
    if (!obj.args.every((a: unknown) => typeof a === 'string')) return false;
  }
  if (obj.url !== undefined && typeof obj.url !== 'string') return false;
  if (obj.env !== undefined) {
    if (typeof obj.env !== 'object' || obj.env === null || Array.isArray(obj.env)) return false;
    if (!Object.values(obj.env as Record<string, unknown>).every(v => typeof v === 'string')) return false;
  }
  if (obj.headers !== undefined) {
    if (typeof obj.headers !== 'object' || obj.headers === null || Array.isArray(obj.headers)) return false;
    if (!Object.values(obj.headers as Record<string, unknown>).every(v => typeof v === 'string')) return false;
  }
  return true;
}

/**
 * Type guard for CostumeAccessories
 */
export function isCostumeAccessories(value: unknown): value is CostumeAccessories {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj.missions !== undefined && typeof obj.missions !== 'boolean') return false;
  if (obj.mcpServers !== undefined) {
    if (typeof obj.mcpServers !== 'object' || obj.mcpServers === null || Array.isArray(obj.mcpServers)) return false;
    for (const server of Object.values(obj.mcpServers as Record<string, unknown>)) {
      if (!isMcpServerConfig(server)) return false;
    }
  }
  return true;
}

/**
 * Type guard for CostumeConfig
 *
 * Validates that:
 * - Required: model (non-empty string)
 * - Optional fields must have correct type IF present
 */
export function isCostumeConfig(value: unknown): value is CostumeConfig {
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

  // Optional: systemPromptFile must be string IF present
  if (obj.systemPromptFile !== undefined && typeof obj.systemPromptFile !== 'string') {
    return false;
  }

  // Optional: gadgets must be array of Entrypoints IF present
  if (obj.gadgets !== undefined) {
    if (!Array.isArray(obj.gadgets)) return false;
    if (!obj.gadgets.every(isEntrypoint)) return false;
  }

  // Optional: missions must be array of Entrypoints IF present
  if (obj.missions !== undefined) {
    if (!Array.isArray(obj.missions)) return false;
    if (!obj.missions.every(isEntrypoint)) return false;
  }

  // Optional: events must be array with entrypoint+guidance IF present
  if (obj.events !== undefined) {
    if (!Array.isArray(obj.events)) return false;
    for (const event of obj.events) {
      if (typeof event !== 'object' || event === null) return false;
      const e = event as Record<string, unknown>;
      if (!isEntrypoint(e.entrypoint)) return false;
      if (typeof e.guidance !== 'string') return false;
    }
  }

  // Optional: injectFacts must be array of strings IF present
  if (obj.injectFacts !== undefined) {
    if (!Array.isArray(obj.injectFacts)) return false;
    if (!obj.injectFacts.every((f: unknown) => typeof f === 'string')) return false;
  }

  // Optional: accessories must be valid CostumeAccessories IF present
  if (obj.accessories !== undefined && !isCostumeAccessories(obj.accessories)) {
    return false;
  }

  return true;
}

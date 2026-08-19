/**
 * Wing accessories configuration (stored at .meta/accessories.json).
 *
 * Declares which costumes are active for a wing and what built-in
 * Claude Code tool permissions to apply.
 */

/** Claude Code permissions controlling which built-in tools are available */
export interface AccessoriesPermissions {
  /** Tool patterns to explicitly allow (e.g. 'Read', 'Bash(git *)') */
  allow?: string[];
  /** Tool patterns to explicitly deny (e.g. 'Write', 'Edit') */
  deny?: string[];
}

/** Full wing accessories declaration */
export interface AccessoriesConfig {
  /** Names of active costumes (from the lair's closet) */
  costumes: string[];
  /** Optional Claude Code built-in tool permissions */
  permissions?: AccessoriesPermissions;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function isAccessoriesPermissions(value: unknown): value is AccessoriesPermissions {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (obj.allow !== undefined && !isStringArray(obj.allow)) return false;
  if (obj.deny !== undefined && !isStringArray(obj.deny)) return false;
  return true;
}

export function isAccessoriesConfig(value: unknown): value is AccessoriesConfig {
  if (typeof value !== 'object' || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (!isStringArray(obj.costumes)) return false;
  if (obj.permissions !== undefined && !isAccessoriesPermissions(obj.permissions)) return false;
  return true;
}

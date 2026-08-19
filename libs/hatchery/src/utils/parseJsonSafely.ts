/**
 * Safely parse a string as JSON
 *
 * @param rawString - The raw string to parse
 * @returns Object containing the raw string and optionally the parsed JSON
 */
export interface ParsedMessage {
  raw: string;
  parsed?: unknown;
}

export function parseJsonSafely(rawString: string): ParsedMessage {
  const trimmed = rawString.trim();

  if (!trimmed) {
    return { raw: rawString };
  }

  try {
    const parsed = JSON.parse(trimmed);
    return {
      raw: rawString,
      parsed,
    };
  } catch {
    // Not valid JSON, return raw string only
    return { raw: rawString };
  }
}

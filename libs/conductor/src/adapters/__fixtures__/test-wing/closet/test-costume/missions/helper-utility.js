/**
 * A helper utility co-located in the missions directory.
 * This file intentionally does NOT export a mission object —
 * it should be excluded from mission discovery.
 */

export function formatMessage(text) {
  return text.trim();
}

export const MAX_LENGTH = 100;

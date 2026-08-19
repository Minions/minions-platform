/**
 * Format a user prompt into a summary suitable for display in lists
 * @param prompt The full user prompt
 * @param maxLength Maximum length before truncation (default 100)
 * @returns Formatted summary, possibly truncated with '...'
 */
export function formatPromptSummary(prompt: string, maxLength = 100): string {
  if (prompt.length <= maxLength) {
    return prompt;
  }
  return prompt.substring(0, maxLength) + '...';
}

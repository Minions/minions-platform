import { describe, it, expect } from 'vitest';
import { formatPromptSummary } from './debug-tools.js';

describe('formatPromptSummary', () => {
  it('returns prompt unchanged if under limit', () => {
    const short = 'This is a short prompt';
    expect(formatPromptSummary(short)).toBe(short);
  });

  it('truncates long prompts to 100 chars with ellipsis', () => {
    const long = 'a'.repeat(200);
    const result = formatPromptSummary(long);

    expect({
      isTruncated: result.endsWith('...'),
      length: result.length,
      withinLimit: result.length <= 103
    }).toMatchSnapshot();
  });

  it('respects custom maxLength parameter', () => {
    const text = 'a'.repeat(50);
    const result = formatPromptSummary(text, 30);

    expect({
      isTruncated: result.endsWith('...'),
      length: result.length,
      withinLimit: result.length <= 33
    }).toMatchSnapshot();
  });
});

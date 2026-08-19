/**
 * Parses tsc/vue-tsc `--watch` stdout into SignalState cycle boundaries.
 *
 * Both tools' watch mode (vue-tsc's is tsc's own watch machinery, just with
 * a Vue-aware LanguageServiceHost swapped in) prints one of these lines to
 * mark the end of a compilation cycle:
 *
 *   Found 0 errors. Watching for file changes.
 *   Found 3 errors. Watching for file changes.
 *
 * Everything printed since the previous cycle boundary (diagnostics, or the
 * "Starting compilation..."/"File change detected..." banner) is the
 * failure detail for a non-zero count.
 */

import type { SignalState } from '../SignalState.js';

const CYCLE_END = /Found (\d+) errors?\. Watching for file changes\./;

/**
 * Strips ANSI escape sequences — `--pretty false` still prints a
 * clear-screen sequence (ESC `[2J` `[3J` `[H`) immediately before each
 * cycle's banner line, confirmed live against the installed
 * vue-tsc@2.2.12. Built via String.fromCharCode rather than a literal ESC
 * character in source, so the control byte can't get silently mangled by
 * an editor/diff tool along the way.
 */
const ESC = String.fromCharCode(27);
const ANSI_ESCAPE = new RegExp(ESC + '\\[[0-9;]*[a-zA-Z]', 'g');

/**
 * Matches the "Starting compilation"/"File change detected" banner line,
 * after ANSI codes are stripped, with an optional timestamp prefix in
 * either shape actually observed: bracketed (`[10:00:00] `) or plain
 * (`8:01:02 PM - `, what `vue-tsc --pretty false` really prints — confirmed
 * live against the installed vue-tsc@2.2.12, not just the bracketed form
 * the original fixtures assumed).
 */
const BANNER_LINE = /^(\[.*?\]\s*)?(\d{1,2}:\d{2}:\d{2}\s*[AP]M\s*-\s*)?(Starting compilation|File change detected)\b/;

export function parseTscWatchOutput(buffer: string): { consumedThrough: number; state: SignalState } | null {
  const match = buffer.match(CYCLE_END);
  if (!match) return null;

  const consumedThrough = (match.index ?? 0) + match[0].length;
  const errorCount = Number(match[1]);
  const timestamp = new Date();

  if (errorCount === 0) {
    return { consumedThrough, state: { state: 'pass', timestamp } };
  }

  // Only whole lines before the cycle-end line count as diagnostics — the
  // cycle-end match itself may start mid-line (e.g. after a `[10:00:01] `
  // timestamp prefix), and that dangling fragment isn't a diagnostic.
  const matchIndex = match.index ?? 0;
  const lastNewlineBeforeMatch = buffer.lastIndexOf('\n', matchIndex);
  const diagnosticsSection = lastNewlineBeforeMatch === -1 ? '' : buffer.slice(0, lastNewlineBeforeMatch);

  const diagnostics = diagnosticsSection
    .split('\n')
    .map((line) => line.replace(ANSI_ESCAPE, '').trim())
    .filter((line) => line.length > 0 && !BANNER_LINE.test(line));

  return { consumedThrough, state: { state: 'fail', timestamp, failures: diagnostics } };
}

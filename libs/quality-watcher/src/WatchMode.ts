/**
 * Watch Mode Configuration Type
 *
 * Type for representing watch mode configuration that controls early return
 * vs full-details behavior.
 */

/**
 * Watch mode discriminated union
 *
 * Controls the behavior of quality status reporting:
 *
 * - **early-return**: Return as soon as 3 failures of any category are found
 *   OR any tool finishes with errors. This is the default mode that provides
 *   fast feedback - the watcher returns partial results immediately when
 *   enough information is available to indicate quality issues.
 *
 * - **full-details**: Wait for all signals to complete before returning.
 *   This mode collects complete results from all quality signals (tests,
 *   types, lint, build) and returns only when all have finished executing,
 *   providing comprehensive quality information.
 */
export type WatchMode = 'early-return' | 'full-details';

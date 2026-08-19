/**
 * Signal categories
 *
 * A `QualityWatcher` doesn't have to run every `SignalType` — which ones it
 * actually runs is its "active set" (see `QualityWatcherOptions.signals`).
 * These two constants are the vocabulary for building that set:
 *
 * - `GLOBAL_SIGNALS` — checks that make sense everywhere a quality watcher
 *   runs, including a wing AND the cabinet's own docs/plan-only watcher
 *   (which never runs software-dev tooling at all). Currently empty — no
 *   global check exists yet. This is where a future doc/plan-quality signal
 *   (e.g. broken-link checking, markdown lint) joins; it is not a
 *   placeholder to work around.
 * - `DEV_SIGNALS` — checks that only make sense against a real software-dev
 *   work repo (tests/types/build/lint). Used by wings; never by the
 *   cabinet's own watcher, which doesn't do software dev.
 *
 * A wing's watcher runs `GLOBAL_SIGNALS ∪ DEV_SIGNALS` (today identical to
 * `DEV_SIGNALS` alone, since the global set is empty) — the moment a real
 * global signal is added, every wing watcher picks it up with no call-site
 * change. The cabinet's own watcher runs `GLOBAL_SIGNALS` alone.
 */

import { SignalType } from './SignalState.js';

export const GLOBAL_SIGNALS: readonly SignalType[] = [];

export const DEV_SIGNALS: readonly SignalType[] = [
  SignalType.Tests,
  SignalType.Types,
  SignalType.Build,
  SignalType.OxLint,
  SignalType.CustomLint,
];

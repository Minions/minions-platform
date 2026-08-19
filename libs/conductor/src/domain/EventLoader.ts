/**
 * Event Loading for Mission State Reconstruction
 *
 * Provides utilities to load persisted events in chronological order,
 * enabling mission state reconstruction from event logs.
 *
 * Loading is separate from replay - this helper simply loads events
 * as data. Missions decide how to use the loaded events (state
 * reconstruction, replay to handlers, etc.).
 */

import { Effect } from 'effect';
import type { IEventPersister, PersistError } from './EventPersister';
import type { SerializedEvent } from './EventSerialization';

/**
 * Load all persisted events in chronological order
 *
 * Loads events from the persister and ensures they are sorted by
 * timestamp to preserve original event order. Returns empty array
 * if no events exist.
 *
 * This is a simple helper that delegates to persister.load() and
 * ensures proper ordering. The actual persistence implementation
 * (file-based, database, etc.) is handled by the IEventPersister
 * adapter.
 *
 * @param persister - The event persister to load from
 * @returns Effect that succeeds with array of SerializedEvent in chronological order, or fails with PersistError
 *
 * @example
 * ```typescript
 * const persister: IEventPersister = new FileEventPersister(eventFile);
 * const loadEffect = loadEvents(persister);
 * const events = await Effect.runPromise(loadEffect);
 *
 * // Events are in chronological order by timestamp
 * // Use them to reconstruct mission state
 * const state = events.reduce((state, event) => {
 *   return applyEvent(state, event);
 * }, initialState);
 * ```
 */
export function loadEvents(
  persister: IEventPersister
): Effect.Effect<SerializedEvent[], PersistError, never> {
  return Effect.gen(function* () {
    // Load all events from persister
    const events = yield* persister.load();

    // Sort by timestamp to ensure chronological order
    // This is defensive - most persisters should already maintain order,
    // but sorting ensures consistency regardless of implementation
    const sortedEvents = [...events].sort((a, b) => a.timestamp - b.timestamp);

    return sortedEvents;
  });
}

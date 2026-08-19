import type { EventDeclaration } from '@minions/events';
import type { CostumeEvent } from '../domain/Costume.js';

/**
 * Builds a `CostumeEvent` from a concretely-typed `EventDeclaration`.
 *
 * `CostumeEvent.event` is typed with an erased payload (`EventDeclaration`'s
 * `P` defaults to `unknown`) so a costume's heterogeneous `events[]` array
 * can mix event declarations with different payload shapes in one array.
 * Effect's `Schema` is invariant in its payload type, so a concrete
 * `EventDeclaration<P, ...>` isn't directly assignable to that erased slot —
 * this helper is the one place that erasure happens. It's safe: every real
 * consumer of `CostumeEvent.event` (`getEventSchemaInfo`, `Schema.decode`)
 * only needs *a* schema to operate on generically at the point it's read,
 * never the concrete `P` visible statically.
 */
export function buildCostumeEvent<P>(event: EventDeclaration<P, string, string>, guidance: string): CostumeEvent {
  return { event: event as unknown as CostumeEvent['event'], guidance };
}

/**
 * Product-space model.
 *
 * A *space* is one lens on the product. Locations are fixed "places" in that
 * space — for a user-flow space they are things a person does; for a data-flow
 * space they are the real sources, transformers, and sinks in the system. A
 * *flow* is a single linear, non-branching, non-looping traversal that visits an
 * ordered sequence of locations. Multiple flows reuse the same locations (and
 * may introduce new ones), which is how the map of the product builds up over
 * time. Plan work — and, later, analyzed existing-code nodes — get laid onto
 * this same space near the locations and flows they touch.
 *
 * Spaces are loaded at runtime from .meta/plan/.spaces/<kind>.json (via the
 * cabinet's plan `get-spaces` action). This module holds only the shape and the
 * pure helpers used to render them.
 */

export type LocationKind = 'action' | 'source' | 'transform' | 'sink'

export interface SpaceLocation {
  id: string
  label: string
  /** Position in virtual space units. */
  x: number
  y: number
  kind: LocationKind
}

export interface SpaceFlow {
  id: string
  label: string
  /** Stroke colour for the flow's route. */
  color: string
  /** Ordered location ids the flow traverses. Linear: no branches, no repeats. */
  path: string[]
}

export type SpaceKind = 'user-flow' | 'data-flow'

export interface ProductSpace {
  kind: SpaceKind
  title: string
  caption: string
  locations: SpaceLocation[]
  flows: SpaceFlow[]
}

/** Returns the ordered (x,y) points a flow visits, skipping unknown locations. */
export function flowPoints(space: ProductSpace, flow: SpaceFlow): Array<{ x: number; y: number }> {
  const byId = new Map(space.locations.map(l => [l.id, l]))
  const pts: Array<{ x: number; y: number }> = []
  for (const id of flow.path) {
    const l = byId.get(id)
    if (l) pts.push({ x: l.x, y: l.y })
  }
  return pts
}

/** Every location id referenced by a flow that doesn't exist in the space. */
export function danglingFlowRefs(space: ProductSpace): string[] {
  const ids = new Set(space.locations.map(l => l.id))
  const missing: string[] = []
  for (const f of space.flows) for (const id of f.path) if (!ids.has(id)) missing.push(id)
  return missing
}

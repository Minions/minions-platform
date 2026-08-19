import type { PlanItemRecord } from '@minions/mcp-types'
import { STAGE_LABEL } from './stageLabels'

export type RiverZone = 'imagine' | 'plan-done' | 'ready' | 'in-goal' | 'active' | 'done'

export interface RiverZoneConfig {
  id: RiverZone
  label: string
  accent: string
  x: number
  w: number
}

export const RIVER_ZONES: RiverZoneConfig[] = [
  { id: 'imagine',   label: STAGE_LABEL['imagine'],   accent: '#818cf8', x: 10,  w: 120 },
  { id: 'plan-done', label: STAGE_LABEL['plan-done'], accent: '#38bdf8', x: 145, w: 130 },
  { id: 'ready',     label: STAGE_LABEL['ready'],     accent: '#4ade80', x: 285, w: 120 },
  { id: 'in-goal',   label: STAGE_LABEL['in-goal'],   accent: '#22d3ee', x: 415, w: 130 },
  { id: 'active',    label: STAGE_LABEL['active'],    accent: '#fbbf24', x: 555, w: 200 },
  { id: 'done',      label: STAGE_LABEL['done'],      accent: '#c084fc', x: 765, w: 150 },
]

// Banks are set so that STANDARD_WIDTH (0.60 × SVG height) fills exactly bank-to-bank.
// SVG height H = 520. 0.60 × 520 = 312. RIVER_MID − 156 = 104 (top), + 156 = 416 (bottom).
export const RIVER_BANK_TOP = 104
export const RIVER_BANK_BOT = 416
export const RIVER_MID = (RIVER_BANK_TOP + RIVER_BANK_BOT) / 2  // 260

/** Standard channel width — 0.60 × SVG viewport height (312 px). A healthy zone fills bank-to-bank. */
export const STANDARD_WIDTH = 312

/** Items per zone at which the channel is at standard width. Exceeding this narrows the channel. */
export const HEALTHY_WIP = 4

/** Channel width narrows by this many pixels for each item above HEALTHY_WIP. */
export const SHRINK_PER_ITEM = 40

/** Minimum channel width — the river never collapses below this. */
export const MIN_CHANNEL_WIDTH = 60

/**
 * Map an item to its river zone.
 * Blocked is an overlay condition, not a zone — it does not affect zone assignment.
 */
export function classifyItemZone(item: PlanItemRecord): RiverZone {
  if (item.demoLink) return 'done'
  if (item.started) return 'active'
  if (item.onPath) return 'in-goal'
  if (item.ready) return 'ready'
  if (item.approved === false || item.approved === undefined) return 'imagine'
  return 'plan-done'  // approved=true or approved='tentative'
}

/** An item is blocked if it has unanswered questions. This is a condition, not a zone. */
export function isItemBlocked(item: PlanItemRecord): boolean {
  return !!(item.questions && item.questions.length > 0)
}

/**
 * Compute channel width for a zone given its items.
 *
 * Inverted from naïve intuition: a healthy channel is WIDE (free-flowing).
 * As items accumulate beyond HEALTHY_WIP, the channel NARROWS — the river
 * looks crowded, which is the signal that something is backing up.
 *
 * Plan-done zone is exempt: it is a holding pool for approved work awaiting
 * explicit selection, and can grow without indicating a problem.
 */
export function computeChannelWidth(zone: RiverZoneConfig, items: PlanItemRecord[]): number {
  if (zone.id === 'plan-done') return STANDARD_WIDTH
  const excess = Math.max(0, items.length - HEALTHY_WIP)
  return Math.max(MIN_CHANNEL_WIDTH, STANDARD_WIDTH - excess * SHRINK_PER_ITEM)
}

export interface NodePosition {
  item: PlanItemRecord
  x: number
  y: number
}

/**
 * Whether an item should be shown in the river.
 *
 * Hides items whose parent is in the same zone — the parent already represents
 * that zone's presence. Only items that have crossed a stage boundary (or have
 * no parent) are shown, keeping the river uncluttered.
 */
export function shouldShowItem(
  item: PlanItemRecord,
  allItems: Record<string, PlanItemRecord>,
): boolean {
  if (!item.parent) return true
  const parent = allItems[item.parent]
  if (!parent) return true
  return classifyItemZone(parent) !== classifyItemZone(item)
}

/** Zone index — higher = further downstream (more complete). */
export function zoneIndex(zone: RiverZone): number {
  return RIVER_ZONES.findIndex(z => z.id === zone)
}

/**
 * Collect all transitive prerequisite items of `item` via children + requires links.
 * Visits each ID at most once to avoid cycles.
 */
function collectTransitiveDeps(
  item: PlanItemRecord,
  allItems: Record<string, PlanItemRecord>,
  visited: Set<string>,
): PlanItemRecord[] {
  const deps: PlanItemRecord[] = []
  for (const id of [...item.children, ...item.requires]) {
    if (visited.has(id)) continue
    visited.add(id)
    const dep = allItems[id]
    if (!dep) continue
    deps.push(dep)
    deps.push(...collectTransitiveDeps(dep, allItems, visited))
  }
  return deps
}

/**
 * Find transitive prerequisite items that are already in a more-complete zone than `item`.
 * These have "flowed downstream" — the dependency is further along the river than the item
 * that depends on it, which is the normal healthy state in a Mikado graph.
 */
export function findDownstreamDeps(
  item: PlanItemRecord,
  allItems: Record<string, PlanItemRecord>,
): PlanItemRecord[] {
  const visited = new Set<string>([item.id])
  const itemZone = zoneIndex(classifyItemZone(item))
  return collectTransitiveDeps(item, allItems, visited)
    .filter(dep => zoneIndex(classifyItemZone(dep)) > itemZone)
}

/** FNV-1a hash of a string → unsigned 32-bit int. */
function hashId(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), 16777619) >>> 0
  }
  return h
}

/** Linear-congruential PRNG seeded from a 32-bit value. Returns values in [0, 1). */
function seededRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

/**
 * Position items with a chaotic, organic scatter within their zone's usable area.
 *
 * Each item's position is derived deterministically from its ID hash so the layout
 * is stable across re-renders. A candidate-selection pass picks the position furthest
 * from already-placed nodes to reduce collisions while keeping the look irregular.
 *
 * Pass `mid` and `nodeR` when using scaled/responsive coordinates so padding
 * stays proportional to the rendered node size.
 */
export function computeNodePositions(
  zones: RiverZoneConfig[],
  itemsByZone: Record<string, PlanItemRecord[]>,
  channelWidths: Record<string, number>,
  mid: number = RIVER_MID,
  nodeR = 10,
): NodePosition[] {
  return zones.flatMap(zone => {
    const items = itemsByZone[zone.id] ?? []
    if (items.length === 0) return []

    const cw = channelWidths[zone.id] ?? STANDARD_WIDTH

    const xPad = Math.max(nodeR * 2.5, zone.w * 0.12)
    const yPad = Math.max(nodeR * 3, cw * 0.18)

    const xMin = zone.x + xPad
    const xMax = zone.x + zone.w - xPad
    const yMin = mid - cw / 2 + yPad
    const yMax = mid + cw / 2 - yPad
    const areaW = Math.max(1, xMax - xMin)
    const areaH = Math.max(1, yMax - yMin)

    const placed: NodePosition[] = []

    for (const item of items) {
      const rng = seededRng(hashId(item.id))

      // Generate 14 candidate positions, pick the one furthest from all placed nodes.
      let bestX = xMin + rng() * areaW
      let bestY = yMin + rng() * areaH
      let bestDist = placed.reduce((d, p) => Math.min(d, Math.hypot(bestX - p.x, bestY - p.y)), Infinity)

      for (let attempt = 1; attempt < 14; attempt++) {
        const cx = xMin + rng() * areaW
        const cy = yMin + rng() * areaH
        const d = placed.reduce((d, p) => Math.min(d, Math.hypot(cx - p.x, cy - p.y)), Infinity)
        if (d > bestDist) { bestDist = d; bestX = cx; bestY = cy }
        if (bestDist >= nodeR * 3.5) break
      }

      placed.push({ item, x: bestX, y: bestY })
    }

    return placed
  })
}

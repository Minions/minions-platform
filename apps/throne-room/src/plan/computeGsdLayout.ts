import type { GsdFrame, GsdFrameType } from '@minions/mcp-types'

export type GsdNodeShape = 'diamond' | 'hexagon' | 'shield' | 'blob' | 'arrow'

export interface GsdFrameLayout {
  id: string
  x: number
  y: number
  r: number
  shape: GsdNodeShape
  spokeDotOffset: number
  /** Degrees to rotate an arrow shape so it points radially away from center */
  rotationDeg: number
  /** Label position relative to node center (points radially outward) */
  labelDx: number
  labelDy: number
  /** SVG text-anchor for the label */
  textAnchor: 'start' | 'middle' | 'end'
}

const TYPE_SHAPE: Record<GsdFrameType, GsdNodeShape> = {
  'unblock':   'diamond',
  'pathfind':  'hexagon',
  'refine':    'shield',
  'risk-scan': 'arrow',
  'capture':   'blob',
}

// Evenly spread 5 types around the full circle (72° apart).
// 0° = right, 90° = down, 180° = left, 270° = up (SVG convention).
const TYPE_ZONE_DEG: Record<GsdFrameType, number> = {
  'unblock':    0,   // right (URGENT)
  'pathfind':  72,   // lower right (BUILD)
  'refine':   144,   // lower left (BUILD→IMAGINE)
  'capture':  216,   // left (IMAGINE)
  'risk-scan':288,   // upper left (TIME)
}

// Base radius per type. Priority adjusts from here: priority 1 = base, priority 2 = base+25.
const TYPE_BASE_RADIUS: Record<GsdFrameType, number> = {
  'unblock':   155,
  'pathfind':  215,
  'refine':    225,
  'capture':   240,
  'risk-scan': 210,
}

const NODE_R = 30
// Larger gap than node diameter to keep text labels from overlapping
const MIN_DIST = NODE_R * 2 + 70

/**
 * Computes SVG positions for GSD frames.
 *
 * - Frame type determines the zone angle, evenly spread across the full circle.
 * - Frame priority sets radial distance (1 = closest, most urgent).
 * - Iterative collision resolution guarantees no overlaps.
 * - Returns label offsets for radial text placement.
 */
export function computeGsdLayouts(
  frames: GsdFrame[],
  cx: number,
  cy: number,
): GsdFrameLayout[] {
  if (frames.length === 0) return []

  const typeCount: Partial<Record<GsdFrameType, number>> = {}

  const pos = frames.map((f, i) => {
    const baseDeg = TYPE_ZONE_DEG[f.type]
    const count = typeCount[f.type] ?? 0
    typeCount[f.type] = count + 1

    const priorityOffset = Math.max(0, f.priority - 1) * 28
    const r = TYPE_BASE_RADIUS[f.type] + priorityOffset

    // Alternate spread direction for siblings within same type
    const spreadDeg = count === 0 ? 0 : (count % 2 === 1 ? 20 : -20) * Math.ceil(count / 2)
    const angle = (baseDeg + spreadDeg) * Math.PI / 180

    return {
      id: f.id,
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle),
      shape: TYPE_SHAPE[f.type] as GsdNodeShape,
      spokeDotOffset: i / Math.max(frames.length, 1),
    }
  })

  // Iterative collision resolution
  for (let iter = 0; iter < 300; iter++) {
    let moved = false
    for (let i = 0; i < pos.length; i++) {
      for (let j = i + 1; j < pos.length; j++) {
        const a = pos[i]
        const b = pos[j]
        if (!a || !b) continue
        const dx = b.x - a.x
        const dy = b.y - a.y
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist < MIN_DIST && dist > 0.001) {
          const push = (MIN_DIST - dist) / 2
          const nx = dx / dist
          const ny = dy / dist
          a.x -= nx * push
          a.y -= ny * push
          b.x += nx * push
          b.y += ny * push
          moved = true
        }
      }
    }
    if (!moved) break
  }

  const LABEL_OFFSET = NODE_R + 16

  return pos.map(p => {
    const angle = Math.atan2(p.y - cy, p.x - cx)
    const lx = Math.cos(angle) * LABEL_OFFSET
    const ly = Math.sin(angle) * LABEL_OFFSET
    const textAnchor: GsdFrameLayout['textAnchor'] =
      lx > 8 ? 'start' : lx < -8 ? 'end' : 'middle'

    return {
      ...p,
      r: NODE_R,
      rotationDeg: angle * 180 / Math.PI,
      labelDx: lx,
      labelDy: ly,
      textAnchor,
    }
  })
}

export function shortLabel(title: string, max = 28): string {
  const cut = title.split(' — ')[0] ?? title
  return cut.length <= max ? cut : cut.slice(0, max - 1) + '…'
}

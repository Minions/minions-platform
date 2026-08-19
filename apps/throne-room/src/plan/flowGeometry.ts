/** Geometry helpers for rendering product-space flow maps. */

export interface Pt { x: number; y: number }
export interface Box { minX: number; minY: number; maxX: number; maxY: number }

/** Axis-aligned bounds of a set of points, optionally padded. Empty → unit box. */
export function boundsOf(points: Pt[], pad = 0): Box {
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 1, maxY: 1 }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  return { minX: minX - pad, minY: minY - pad, maxX: maxX + pad, maxY: maxY + pad }
}

/**
 * Transform (translate + uniform scale) that fits `box` into a `vw`×`vh`
 * viewport with `pad` px of margin, centred. Apply as `translate(tx,ty) scale(s)`.
 */
export function fitTransform(box: Box, vw: number, vh: number, pad = 40): { tx: number; ty: number; scale: number } {
  const w = Math.max(1, box.maxX - box.minX)
  const h = Math.max(1, box.maxY - box.minY)
  const scale = Math.min((vw - 2 * pad) / w, (vh - 2 * pad) / h)
  const tx = (vw - scale * w) / 2 - scale * box.minX
  const ty = (vh - scale * h) / 2 - scale * box.minY
  return { tx, ty, scale }
}

/**
 * Smooth SVG path through `points` using a Catmull-Rom spline converted to cubic
 * béziers, so a flow's route reads as an organic curve rather than a polyline.
 * 0 points → empty; 1 → a degenerate move; 2 → a straight line.
 */
export function catmullRomPath(points: Pt[], tension = 0.5): string {
  if (points.length === 0) return ''
  if (points.length === 1) return `M ${r(points[0].x)},${r(points[0].y)}`
  if (points.length === 2) return `M ${r(points[0].x)},${r(points[0].y)} L ${r(points[1].x)},${r(points[1].y)}`

  let d = `M ${r(points[0].x)},${r(points[0].y)}`
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] ?? points[i]
    const p1 = points[i]
    const p2 = points[i + 1]
    const p3 = points[i + 2] ?? p2
    const c1x = p1.x + ((p2.x - p0.x) / 6) * tension * 2
    const c1y = p1.y + ((p2.y - p0.y) / 6) * tension * 2
    const c2x = p2.x - ((p3.x - p1.x) / 6) * tension * 2
    const c2y = p2.y - ((p3.y - p1.y) / 6) * tension * 2
    d += ` C ${r(c1x)},${r(c1y)} ${r(c2x)},${r(c2y)} ${r(p2.x)},${r(p2.y)}`
  }
  return d
}

function r(n: number): number {
  return Math.round(n * 100) / 100
}

import { describe, it, expect } from 'vitest'
import { computeGsdLayouts, shortLabel } from './computeGsdLayout'
import type { GsdFrame } from '@minions/mcp-types'

function frame(
  id: string,
  type: GsdFrame['type'],
  priority = 1,
  itemCount = 1,
): GsdFrame {
  return {
    id,
    type,
    title: id,
    rationale: '',
    saving: '',
    priority,
    items: Array.from({ length: itemCount }, (_, i) => ({
      itemId: `item-${i}`,
      role: i === 0 ? 'anchor' : 'context',
    })),
  }
}

const CX = 490, CY = 280

describe('computeGsdLayouts', () => {
  it('returns empty array for no frames', () => {
    expect(computeGsdLayouts([], CX, CY)).toEqual([])
  })

  it('returns one layout per frame', () => {
    const frames = [frame('f1', 'unblock'), frame('f2', 'refine')]
    const layouts = computeGsdLayouts(frames, CX, CY)
    expect(layouts).toHaveLength(2)
  })

  it('each layout has the correct id', () => {
    const frames = [frame('f-unblock', 'unblock')]
    const [layout] = computeGsdLayouts(frames, CX, CY)
    if (!layout) throw new Error('expected a layout')
    expect(layout.id).toBe('f-unblock')
  })

  it('unblock frame is placed closer to center than capture', () => {
    const frames = [frame('u', 'unblock'), frame('c', 'capture')]
    const layouts = computeGsdLayouts(frames, CX, CY)
    const unblock = layouts.find(l => l.id === 'u')
    const capture = layouts.find(l => l.id === 'c')
    if (!unblock || !capture) throw new Error('expected both layouts')
    const distUnblock = Math.hypot(unblock.x - CX, unblock.y - CY)
    const distCapture = Math.hypot(capture.x - CX, capture.y - CY)
    expect(distUnblock).toBeLessThan(distCapture)
  })

  it('higher priority (lower number) frame is closer to center within same type', () => {
    const frames = [frame('f1', 'refine', 1), frame('f2', 'refine', 3)]
    const layouts = computeGsdLayouts(frames, CX, CY)
    const l1 = layouts.find(l => l.id === 'f1')
    const l2 = layouts.find(l => l.id === 'f2')
    if (!l1 || !l2) throw new Error('expected both layouts')
    // f1 priority=1 → base radius; f2 priority=3 → base+50
    // After collision resolution both should be apart, but f1 starts closer
    const dist1 = Math.hypot(l1.x - CX, l1.y - CY)
    const dist2 = Math.hypot(l2.x - CX, l2.y - CY)
    expect(dist1).toBeLessThan(dist2)
  })

  it('no two frames are at the same position', () => {
    const frames = [
      frame('a', 'unblock'),
      frame('b', 'refine'),
      frame('c', 'pathfind'),
      frame('d', 'risk-scan'),
      frame('e', 'capture'),
    ]
    const layouts = computeGsdLayouts(frames, CX, CY)
    for (let i = 0; i < layouts.length; i++) {
      for (let j = i + 1; j < layouts.length; j++) {
        const a = layouts[i], b = layouts[j]
        if (!a || !b) throw new Error('expected both layouts')
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        expect(dist).toBeGreaterThan(0.5)
      }
    }
  })

  it('no two frames overlap (min gap enforced)', () => {
    const frames = [
      frame('a', 'refine', 1),
      frame('b', 'refine', 2),
      frame('c', 'refine', 3),
      frame('d', 'refine', 4),
    ]
    const layouts = computeGsdLayouts(frames, CX, CY)
    const NODE_R = 30
    for (let i = 0; i < layouts.length; i++) {
      for (let j = i + 1; j < layouts.length; j++) {
        const a = layouts[i], b = layouts[j]
        if (!a || !b) throw new Error('expected both layouts')
        const dist = Math.hypot(a.x - b.x, a.y - b.y)
        expect(dist).toBeGreaterThanOrEqual(NODE_R * 2 + 70 - 0.1)
      }
    }
  })

  it('unblock uses diamond shape', () => {
    const [layout] = computeGsdLayouts([frame('f', 'unblock')], CX, CY)
    if (!layout) throw new Error('expected a layout')
    expect(layout.shape).toBe('diamond')
  })

  it('capture uses blob shape', () => {
    const [layout] = computeGsdLayouts([frame('f', 'capture')], CX, CY)
    if (!layout) throw new Error('expected a layout')
    expect(layout.shape).toBe('blob')
  })

  it('assigns unique spokeDotOffset values', () => {
    const frames = [
      frame('a', 'unblock'),
      frame('b', 'refine'),
      frame('c', 'pathfind'),
    ]
    const layouts = computeGsdLayouts(frames, CX, CY)
    const offsets = layouts.map(l => l.spokeDotOffset)
    const unique = new Set(offsets)
    expect(unique.size).toBe(frames.length)
  })

  it('each layout has rotationDeg, labelDx, labelDy, textAnchor', () => {
    const [layout] = computeGsdLayouts([frame('f', 'risk-scan')], CX, CY)
    if (!layout) throw new Error('expected a layout')
    expect(typeof layout.rotationDeg).toBe('number')
    expect(typeof layout.labelDx).toBe('number')
    expect(typeof layout.labelDy).toBe('number')
    expect(['start', 'middle', 'end']).toContain(layout.textAnchor)
  })

  it('label points radially away from center', () => {
    const [layout] = computeGsdLayouts([frame('f', 'unblock')], CX, CY)
    if (!layout) throw new Error('expected a layout')
    // unblock is at ~0° (right of center), so labelDx should be positive
    expect(layout.labelDx).toBeGreaterThan(0)
  })

  it('five distinct types spread across the full circle — no two within 30°', () => {
    const frames = [
      frame('a', 'unblock'),
      frame('b', 'pathfind'),
      frame('c', 'refine'),
      frame('d', 'capture'),
      frame('e', 'risk-scan'),
    ]
    const layouts = computeGsdLayouts(frames, CX, CY)
    const angles = layouts.map(l => Math.atan2(l.y - CY, l.x - CX) * 180 / Math.PI)
    // Each pair should be at least 30° apart around the circle
    for (let i = 0; i < angles.length; i++) {
      for (let j = i + 1; j < angles.length; j++) {
        const angleI = angles[i], angleJ = angles[j]
        if (angleI === undefined || angleJ === undefined) throw new Error('expected both angles')
        let diff = Math.abs(angleI - angleJ)
        if (diff > 180) diff = 360 - diff
        expect(diff).toBeGreaterThan(30)
      }
    }
  })
})

describe('shortLabel', () => {
  it('returns full title when short enough', () => {
    expect(shortLabel('Short title')).toBe('Short title')
  })

  it('cuts at em-dash separator', () => {
    expect(shortLabel('Demo System — Fix bugs')).toBe('Demo System')
  })

  it('truncates long first segment', () => {
    const long = 'A very long title that exceeds the max character limit'
    const result = shortLabel(long)
    expect(result.length).toBeLessThanOrEqual(28)
    expect(result.endsWith('…')).toBe(true)
  })
})

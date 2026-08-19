import { describe, it, expect } from 'vitest'
import {
  classifyItemZone,
  isItemBlocked,
  computeChannelWidth,
  computeNodePositions,
  shouldShowItem,
  findDownstreamDeps,
  RIVER_ZONES,
  RIVER_BANK_TOP,
  RIVER_BANK_BOT,
  STANDARD_WIDTH,
  HEALTHY_WIP,
  MIN_CHANNEL_WIDTH,
} from './computeRiverLayout'
import type { PlanItemRecord } from '@minions/mcp-types'

function item(overrides: Partial<PlanItemRecord> = {}): PlanItemRecord {
  return {
    id: 'test',
    title: 'Test Item',
    type: 'task',
    parent: null,
    children: [],
    requires: [],
    ...overrides,
  }
}

function findZone(id: string): (typeof RIVER_ZONES)[number] {
  const zone = RIVER_ZONES.find(z => z.id === id)
  if (!zone) throw new Error(`expected a river zone with id ${id}`)
  return zone
}

// ── classifyItemZone ──────────────────────────────────────────────────────────

describe('classifyItemZone', () => {
  it('maps demo-ready item (has demoLink) to done', () => {
    expect(classifyItemZone(item({ demoLink: 'http://demo' }))).toBe('done')
  })

  it('demoLink takes precedence over started', () => {
    expect(classifyItemZone(item({ demoLink: 'http://demo', started: true }))).toBe('done')
  })

  it('maps started item (no demoLink) to active', () => {
    expect(classifyItemZone(item({ started: true }))).toBe('active')
  })

  it('started takes precedence over onPath for zone (wip beats in-goal)', () => {
    expect(classifyItemZone(item({ started: true, onPath: true }))).toBe('active')
  })

  it('maps onPath-but-not-started item to in-goal', () => {
    expect(classifyItemZone(item({ onPath: true, approved: true }))).toBe('in-goal')
  })

  it('maps unapproved item to imagine', () => {
    expect(classifyItemZone(item({ approved: false }))).toBe('imagine')
  })

  it('maps tentatively-approved item to plan-done', () => {
    expect(classifyItemZone(item({ approved: 'tentative' }))).toBe('plan-done')
  })

  it('maps approved item (approved=true) to plan-done', () => {
    expect(classifyItemZone(item({ approved: true }))).toBe('plan-done')
  })

  it('maps item with ready=true to ready zone', () => {
    expect(classifyItemZone(item({ approved: true, ready: true }))).toBe('ready')
  })

  it('maps item with no explicit approval to imagine (default)', () => {
    expect(classifyItemZone(item())).toBe('imagine')
  })

  it('blocked item stays in its underlying zone — blocked is an overlay, not a zone', () => {
    expect(classifyItemZone(item({ started: true, questions: ['q1'] }))).toBe('active')
    expect(classifyItemZone(item({ approved: false, questions: ['q1'] }))).toBe('imagine')
    expect(classifyItemZone(item({ onPath: true, questions: ['q1'] }))).toBe('in-goal')
  })
})

// ── isItemBlocked ─────────────────────────────────────────────────────────────

describe('isItemBlocked', () => {
  it('returns false when questions is undefined', () => {
    expect(isItemBlocked(item())).toBe(false)
  })

  it('returns false when questions is empty', () => {
    expect(isItemBlocked(item({ questions: [] }))).toBe(false)
  })

  it('returns true when questions has entries', () => {
    expect(isItemBlocked(item({ questions: ['q1'] }))).toBe(true)
    expect(isItemBlocked(item({ questions: ['q1', 'q2'] }))).toBe(true)
  })
})

// ── computeChannelWidth ───────────────────────────────────────────────────────

describe('computeChannelWidth', () => {
  const planDoneZone = findZone('plan-done')
  const activeZone = findZone('active')
  const imagineZone = findZone('imagine')
  const doneZone = findZone('done')

  it('plan-done zone is always STANDARD_WIDTH regardless of item count', () => {
    expect(computeChannelWidth(planDoneZone, [])).toBe(STANDARD_WIDTH)
    expect(computeChannelWidth(planDoneZone, [item(), item(), item(), item(), item(), item(), item(), item()])).toBe(STANDARD_WIDTH)
  })

  it('all other zones return STANDARD_WIDTH when at or below HEALTHY_WIP', () => {
    const empty = computeChannelWidth(activeZone, [])
    expect(empty).toBe(STANDARD_WIDTH)
    const atLimit = computeChannelWidth(activeZone, Array.from({ length: HEALTHY_WIP }, () => item()))
    expect(atLimit).toBe(STANDARD_WIDTH)
  })

  it('channel narrows as item count exceeds HEALTHY_WIP', () => {
    const atLimit = computeChannelWidth(activeZone, Array.from({ length: HEALTHY_WIP }, () => item()))
    const oneOver = computeChannelWidth(activeZone, Array.from({ length: HEALTHY_WIP + 1 }, () => item()))
    expect(oneOver).toBeLessThan(atLimit)
  })

  it('channel never goes below MIN_CHANNEL_WIDTH', () => {
    const manyItems = Array.from({ length: 100 }, () => item())
    expect(computeChannelWidth(activeZone, manyItems)).toBeGreaterThanOrEqual(MIN_CHANNEL_WIDTH)
    expect(computeChannelWidth(imagineZone, manyItems)).toBeGreaterThanOrEqual(MIN_CHANNEL_WIDTH)
    expect(computeChannelWidth(doneZone, manyItems)).toBeGreaterThanOrEqual(MIN_CHANNEL_WIDTH)
  })

  it('width is consistent across zone types for same item count (except plan-done)', () => {
    const items2 = [item(), item()]
    const wImagine = computeChannelWidth(imagineZone, items2)
    const wActive = computeChannelWidth(activeZone, items2)
    const wDone = computeChannelWidth(doneZone, items2)
    expect(wImagine).toBe(wActive)
    expect(wImagine).toBe(wDone)
  })
})

// ── shouldShowItem ────────────────────────────────────────────────────────────

describe('shouldShowItem', () => {
  it('shows items with no parent', () => {
    const root = item({ id: 'root', parent: null })
    expect(shouldShowItem(root, { root })).toBe(true)
  })

  it('shows item whose parent is in a different zone', () => {
    const parent = item({ id: 'p', parent: null, approved: false })   // imagine
    const child  = item({ id: 'c', parent: 'p', approved: true })     // plan-done
    expect(shouldShowItem(child, { p: parent, c: child })).toBe(true)
  })

  it('hides item whose parent is in the same zone', () => {
    const parent = item({ id: 'p', parent: null, approved: true })    // plan-done
    const child  = item({ id: 'c', parent: 'p', approved: true })     // plan-done
    expect(shouldShowItem(child, { p: parent, c: child })).toBe(false)
  })

  it('shows item whose parent is not found in the item map', () => {
    const orphan = item({ id: 'o', parent: 'missing' })
    expect(shouldShowItem(orphan, { o: orphan })).toBe(true)
  })

  it('compares zones, so started child of plan-done parent is visible', () => {
    const parent = item({ id: 'p', parent: null, approved: 'tentative' })  // plan-done
    const child  = item({ id: 'c', parent: 'p', started: true })           // active
    expect(shouldShowItem(child, { p: parent, c: child })).toBe(true)
  })
})

// ── findDownstreamDeps ────────────────────────────────────────────────────────

describe('findDownstreamDeps', () => {
  it('returns empty when item has no children or requires', () => {
    const root = item({ id: 'r', approved: true })  // plan-done
    expect(findDownstreamDeps(root, { r: root })).toEqual([])
  })

  it('returns a direct child that is further downstream (done > plan-done)', () => {
    const parent = item({ id: 'p', approved: true })            // plan-done
    const child  = item({ id: 'c', parent: 'p', demoLink: 'x' }) // done
    const all = { p: { ...parent, children: ['c'] }, c: child }
    const result = findDownstreamDeps(all.p, all)
    expect(result.map(d => d.id)).toContain('c')
  })

  it('returns a requires-linked item that is further downstream', () => {
    const a = item({ id: 'a', approved: true })   // plan-done
    const b = item({ id: 'b', started: true })    // active — downstream of plan-done
    const all = { a: { ...a, requires: ['b'] }, b }
    const result = findDownstreamDeps(all.a, all)
    expect(result.map(d => d.id)).toContain('b')
  })

  it('does NOT return a dep in the same or earlier zone', () => {
    const a = item({ id: 'a', started: true })   // active
    const b = item({ id: 'b', approved: true })  // plan-done — upstream of active
    const all = { a: { ...a, requires: ['b'] }, b }
    expect(findDownstreamDeps(all.a, all)).toHaveLength(0)
  })

  it('follows transitive children', () => {
    const gp = item({ id: 'gp', approved: true })         // plan-done
    const p  = item({ id: 'p',  parent: 'gp', onPath: true })  // in-goal — downstream
    const c  = item({ id: 'c',  parent: 'p',  demoLink: 'x' })  // done — further downstream
    const all = {
      gp: { ...gp, children: ['p'] },
      p:  { ...p,  children: ['c'] },
      c,
    }
    const ids = findDownstreamDeps(all.gp, all).map(d => d.id)
    expect(ids).toContain('p')
    expect(ids).toContain('c')
  })

  it('does not infinite-loop on cycles', () => {
    const a = item({ id: 'a', approved: true })
    const b = item({ id: 'b', demoLink: 'x' })
    const all = {
      a: { ...a, requires: ['b'] },
      b: { ...b, requires: ['a'] },
    }
    expect(() => findDownstreamDeps(all.a, all)).not.toThrow()
  })
})

// ── computeNodePositions ──────────────────────────────────────────────────────

describe('computeNodePositions', () => {
  const channelWidths = Object.fromEntries(RIVER_ZONES.map(z => [z.id, 100])) as Record<string, number>

  it('returns one position per item', () => {
    const items = [item({ id: 'a' }), item({ id: 'b' })]
    const itemsByZone = Object.fromEntries(RIVER_ZONES.map(z => [z.id, z.id === 'imagine' ? items : []]))
    const positions = computeNodePositions(RIVER_ZONES, itemsByZone, channelWidths)
    expect(positions).toHaveLength(2)
  })

  it('y positions stay within channel bounds', () => {
    const mid = (RIVER_BANK_TOP + RIVER_BANK_BOT) / 2
    const cw = 100
    const topY = mid - cw / 2
    const botY = mid + cw / 2
    const manyItems = Array.from({ length: 6 }, (_, i) => item({ id: String(i) }))
    const itemsByZone = Object.fromEntries(RIVER_ZONES.map(z => [z.id, z.id === 'imagine' ? manyItems : []]))
    const widths = { ...channelWidths, imagine: cw }
    const positions = computeNodePositions(RIVER_ZONES, itemsByZone, widths)
    for (const pos of positions) {
      expect(pos.y).toBeGreaterThanOrEqual(topY)
      expect(pos.y).toBeLessThanOrEqual(botY)
    }
  })

  it('each position carries its source item', () => {
    const a = item({ id: 'a' })
    const itemsByZone = Object.fromEntries(RIVER_ZONES.map(z => [z.id, z.id === 'imagine' ? [a] : []]))
    const [pos] = computeNodePositions(RIVER_ZONES, itemsByZone, channelWidths)
    if (!pos) throw new Error('expected a position')
    expect(pos.item.id).toBe('a')
  })

  it('single item in a zone is placed within the zone\'s horizontal bounds', () => {
    const zone = findZone('ready')
    const itemsByZone = Object.fromEntries(RIVER_ZONES.map(z => [z.id, z.id === 'ready' ? [item({ id: 'r1' })] : []]))
    const [pos] = computeNodePositions(RIVER_ZONES, itemsByZone, channelWidths)
    if (!pos) throw new Error('expected a position')
    expect(pos.x).toBeGreaterThanOrEqual(zone.x)
    expect(pos.x).toBeLessThanOrEqual(zone.x + zone.w)
  })

  it('layout is deterministic — same item IDs produce the same positions', () => {
    const twoItems = [item({ id: 'alpha-id' }), item({ id: 'beta-id' })]
    const itemsByZone = Object.fromEntries(RIVER_ZONES.map(z => [z.id, z.id === 'active' ? twoItems : []]))
    const pos1 = computeNodePositions(RIVER_ZONES, itemsByZone, channelWidths)
    const pos2 = computeNodePositions(RIVER_ZONES, itemsByZone, channelWidths)
    const [pos1a, pos1b] = pos1
    const [pos2a, pos2b] = pos2
    if (!pos1a || !pos1b || !pos2a || !pos2b) throw new Error('expected two positions in each result')
    expect(pos1a.x).toBeCloseTo(pos2a.x)
    expect(pos1a.y).toBeCloseTo(pos2a.y)
    expect(pos1b.x).toBeCloseTo(pos2b.x)
    expect(pos1b.y).toBeCloseTo(pos2b.y)
  })

  it('multiple items are spread horizontally across the zone, not all at center', () => {
    const fiveItems = Array.from({ length: 5 }, (_, i) => item({ id: `i${i}` }))
    const itemsByZone = Object.fromEntries(RIVER_ZONES.map(z => [z.id, z.id === 'active' ? fiveItems : []]))
    const positions = computeNodePositions(RIVER_ZONES, itemsByZone, channelWidths)
    const xs = positions.map(p => p.x)
    const spread = Math.max(...xs) - Math.min(...xs)
    expect(spread).toBeGreaterThan(10)
  })

  it('no two items occupy the same position', () => {
    const sixItems = Array.from({ length: 6 }, (_, i) => item({ id: `i${i}` }))
    const itemsByZone = Object.fromEntries(RIVER_ZONES.map(z => [z.id, z.id === 'plan-done' ? sixItems : []]))
    const positions = computeNodePositions(RIVER_ZONES, itemsByZone, channelWidths)
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const a = positions[i], b = positions[j]
        if (!a || !b) throw new Error('expected both positions')
        const dx = a.x - b.x
        const dy = a.y - b.y
        expect(Math.sqrt(dx * dx + dy * dy)).toBeGreaterThan(0.5)
      }
    }
  })
})

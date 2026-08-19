import { describe, it, expect } from 'vitest'
import { boundsOf, fitTransform, catmullRomPath } from './flowGeometry'

describe('boundsOf', () => {
  it('returns a unit box for no points', () => {
    expect(boundsOf([])).toEqual({ minX: 0, minY: 0, maxX: 1, maxY: 1 })
  })

  it('computes tight bounds', () => {
    const b = boundsOf([{ x: 2, y: 3 }, { x: 8, y: 1 }, { x: 5, y: 9 }])
    expect(b).toEqual({ minX: 2, minY: 1, maxX: 8, maxY: 9 })
  })

  it('applies padding outward', () => {
    const b = boundsOf([{ x: 0, y: 0 }, { x: 10, y: 10 }], 5)
    expect(b).toEqual({ minX: -5, minY: -5, maxX: 15, maxY: 15 })
  })
})

describe('fitTransform', () => {
  it('centres and scales a box into the viewport', () => {
    const box = { minX: 0, minY: 0, maxX: 100, maxY: 100 }
    const { tx, ty, scale } = fitTransform(box, 400, 200, 0)
    // height-limited: scale = 200/100 = 2
    expect(scale).toBe(2)
    // content width 200 centred in 400 → tx = 100
    expect(tx).toBeCloseTo(100)
    expect(ty).toBeCloseTo(0)
  })

  it('maps box corners inside the padded viewport', () => {
    const box = { minX: 10, minY: 20, maxX: 110, maxY: 70 }
    const vw = 800, vh = 600, pad = 40
    const { tx, ty, scale } = fitTransform(box, vw, vh, pad)
    const apply = (x: number, y: number) => ({ x: tx + scale * x, y: ty + scale * y })
    const tl = apply(box.minX, box.minY)
    const br = apply(box.maxX, box.maxY)
    expect(tl.x).toBeGreaterThanOrEqual(pad - 0.5)
    expect(tl.y).toBeGreaterThanOrEqual(pad - 0.5)
    expect(br.x).toBeLessThanOrEqual(vw - pad + 0.5)
    expect(br.y).toBeLessThanOrEqual(vh - pad + 0.5)
  })
})

describe('catmullRomPath', () => {
  it('returns empty for no points', () => {
    expect(catmullRomPath([])).toBe('')
  })

  it('returns a straight line for two points', () => {
    expect(catmullRomPath([{ x: 0, y: 0 }, { x: 10, y: 5 }])).toBe('M 0,0 L 10,5')
  })

  it('starts at the first point and emits a cubic per segment for 3+ points', () => {
    const d = catmullRomPath([{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }])
    expect(d.startsWith('M 0,0')).toBe(true)
    expect((d.match(/C/g) ?? []).length).toBe(2)
  })
})

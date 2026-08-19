import { describe, it, expect } from 'vitest'
import { flowPoints, danglingFlowRefs, type ProductSpace } from './productSpace'

function space(overrides: Partial<ProductSpace> = {}): ProductSpace {
  return {
    kind: 'user-flow',
    title: 'Test',
    caption: 'c',
    locations: [
      { id: 'a', label: 'A', x: 10, y: 20, kind: 'action' },
      { id: 'b', label: 'B', x: 30, y: 40, kind: 'action' },
      { id: 'c', label: 'C', x: 50, y: 60, kind: 'action' },
    ],
    flows: [{ id: 'f', label: 'F', color: '#fff', path: ['a', 'b', 'c'] }],
    ...overrides,
  }
}

describe('flowPoints', () => {
  it('returns one point per resolved location, in path order', () => {
    const s = space()
    expect(flowPoints(s, s.flows[0])).toEqual([
      { x: 10, y: 20 },
      { x: 30, y: 40 },
      { x: 50, y: 60 },
    ])
  })

  it('skips unknown location ids', () => {
    const s = space({
      locations: [{ id: 'a', label: 'A', x: 1, y: 2, kind: 'action' }],
      flows: [{ id: 'f', label: 'F', color: '#fff', path: ['a', 'ghost'] }],
    })
    expect(flowPoints(s, s.flows[0])).toEqual([{ x: 1, y: 2 }])
  })
})

describe('danglingFlowRefs', () => {
  it('returns empty when every flow ref resolves', () => {
    expect(danglingFlowRefs(space())).toEqual([])
  })

  it('reports ids referenced by a flow but missing from the space', () => {
    const s = space({
      locations: [{ id: 'a', label: 'A', x: 0, y: 0, kind: 'source' }],
      flows: [{ id: 'f', label: 'F', color: '#fff', path: ['a', 'missing'] }],
    })
    expect(danglingFlowRefs(s)).toEqual(['missing'])
  })
})

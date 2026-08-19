import { describe, it, expect } from 'vitest'
import { wrapLabel } from './nodeLabel'

describe('wrapLabel', () => {
  it('returns no lines for an empty or whitespace title', () => {
    expect(wrapLabel('')).toEqual([])
    expect(wrapLabel('   ')).toEqual([])
  })

  it('keeps a short title on a single line', () => {
    expect(wrapLabel('Login flow', 18, 3)).toEqual(['Login flow'])
  })

  it('wraps on word boundaries within the character budget', () => {
    const lines = wrapLabel('Add user onboarding wizard', 14, 3)
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(14)
  })

  it('never overflows the per-line budget', () => {
    const lines = wrapLabel('Real-time collaborative document editing surface', 16, 3)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(16)
  })

  it('caps at maxLines and ellipsises the remainder', () => {
    const lines = wrapLabel('one two three four five six seven eight nine ten', 8, 2)
    expect(lines).toHaveLength(2)
    expect(lines[lines.length - 1].endsWith('…')).toBe(true)
  })

  it('hard-splits a single word longer than the line budget', () => {
    const lines = wrapLabel('supercalifragilisticexpialidocious', 10, 3)
    expect(lines.length).toBeGreaterThan(1)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(10)
  })

  it('does not add an ellipsis when the title fits exactly', () => {
    const lines = wrapLabel('alpha beta gamma', 11, 3)
    expect(lines.join(' ')).toBe('alpha beta gamma')
    expect(lines.some(l => l.includes('…'))).toBe(false)
  })
})

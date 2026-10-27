import { describe, expect, it } from 'vitest'
import { excerptAround } from './excerpt'

const long = `${'Vorne steht viel Text. '.repeat(12)}Die Brandschutztür im Stiegenhaus fehlt. ${'Hinten auch. '.repeat(12)}`

describe('excerptAround', () => {
  it('returns a short text whole, its whitespace collapsed', () => {
    expect(excerptAround('Tür\n\n  fehlt', 'tür', 200)).toBe('Tür fehlt')
  })

  it('keeps the term in view, any case, and marks both cuts', () => {
    const excerpt = excerptAround(long, 'BRANDSCHUTZTÜR', 80)
    expect(excerpt.length).toBeLessThanOrEqual(80)
    expect(excerpt).toContain('Brandschutztür')
    expect(excerpt.startsWith('…')).toBe(true)
    expect(excerpt.endsWith('…')).toBe(true)
  })

  it('takes the start when the term is absent or not given', () => {
    for (const term of ['Fenster', null]) {
      const excerpt = excerptAround(long, term, 50)
      expect(excerpt.length).toBeLessThanOrEqual(50)
      expect(excerpt.startsWith('Vorne')).toBe(true)
      expect(excerpt.endsWith('…')).toBe(true)
    }
  })

  it('does not cut the start when the term is near it', () => {
    const excerpt = excerptAround(`Tür ${'x '.repeat(200)}`, 'tür', 40)
    expect(excerpt.startsWith('Tür')).toBe(true)
    expect(excerpt.length).toBeLessThanOrEqual(40)
  })
})

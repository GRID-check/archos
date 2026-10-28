/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { filterNorms } from './norm-list-wire'
import { normEntrySchema } from './schemas'

const entry = (value: Record<string, unknown>) =>
  normEntrySchema.parse({ rank: 'state_law', short: 's', ...value })

const registry = {
  states: { vienna: 'Wien' },
  entries: [
    entry({ id: 'bo-wien', title: 'Bauordnung für Wien', federal_state: 'Wien', topics: ['bauantrag'], review_note: 'open' }),
    entry({ id: 'bo-tirol', title: 'Tiroler Bauordnung', federal_state: 'Tirol' }),
    entry({ id: 'gewo', title: 'Gewerbeordnung', rank: 'federal_law', topics: ['betriebsanlage'] }),
  ],
}

describe('filterNorms', () => {
  it('keeps a state’s norms and the federal ones, by name or token', () => {
    expect(filterNorms(registry, { federalState: 'vienna' }).map((n) => n.id)).toEqual(['bo-wien', 'gewo'])
    expect(filterNorms(registry, { federalState: 'Wien' }).map((n) => n.id)).toEqual(['bo-wien', 'gewo'])
  })

  it('filters by topic and never carries the review note', () => {
    const [norm] = filterNorms(registry, { topic: 'Bauantrag' })
    expect(norm.id).toBe('bo-wien')
    expect(norm).not.toHaveProperty('review_note')
    expect(norm).not.toHaveProperty('reviewNote')
  })
})

import { describe, expect, it } from 'vitest'
import { planDocumentsSchema, sanitizePlanDocuments } from './plan-documents'
import { modernizePlan } from './plan-vocabulary'

describe('a plan written before the English names', () => {
  it('reads its keys and its genre and depth in English', () => {
    expect(
      modernizePlan({
        title: 'T',
        genre: 'pruefbericht',
        depth: 'kurzpruefung',
        grundlage: ['a.pdf'],
        ausgeschlossen: [],
        unterlagen: [{ name: 'a.pdf' }],
      })
    ).toEqual({
      title: 'T',
      genre: 'inspection_report',
      depth: 'quick_check',
      basis: ['a.pdf'],
      excluded: [],
      documents: [{ name: 'a.pdf' }],
    })
  })

  it('keeps the English key when both are present, and leaves English values alone', () => {
    expect(modernizePlan({ genre: 'report', depth: 'expert_report', basis: ['x'], grundlage: ['y'] })).toEqual({
      genre: 'report',
      depth: 'expert_report',
      basis: ['x'],
    })
  })

  it('returns what is not an object as it is', () => {
    expect(modernizePlan(null)).toBeNull()
    expect(modernizePlan('x')).toBe('x')
  })

  it('reads the documents a task froze or a tab sent under the old keys', () => {
    const old = { grundlage: [{ name: 'a.pdf' }], ausgeschlossen: [{ name: 'b.pdf' }] }
    expect(planDocumentsSchema.parse(old)).toEqual({ basis: [{ name: 'a.pdf' }], excluded: [{ name: 'b.pdf' }] })
    expect(sanitizePlanDocuments(old)).toEqual({ basis: [{ name: 'a.pdf' }], excluded: [{ name: 'b.pdf' }] })
  })
})

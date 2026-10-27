import { describe, expect, it } from 'vitest'
import { narrowsAnnotations, narrowsDocuments, setAsideKinds } from './search-wire'

describe('narrowsDocuments', () => {
  it('counts what a document is, and neither the projects (they cut every kind) nor the archive (it only widens)', () => {
    expect(narrowsDocuments(undefined)).toBe(false)
    expect(narrowsDocuments({ projectIds: ['p'], includeArchived: true, currentOnly: false, tags: [], pages: {} })).toBe(false)
    expect(narrowsDocuments({ planNumber: 'EP-0' })).toBe(true)
    expect(narrowsDocuments({ currentOnly: true })).toBe(true)
    expect(narrowsDocuments({ pages: { min: 2 } })).toBe(true)
    expect(narrowsDocuments({ citing: '22222222-2222-4222-8222-222222222222' })).toBe(true)
  })
})

describe('narrowsAnnotations', () => {
  it('counts any annotation filter that holds a value', () => {
    expect(narrowsAnnotations({})).toBe(false)
    expect(narrowsAnnotations({ statuses: [], assignedToMe: false })).toBe(false)
    expect(narrowsAnnotations({ statuses: ['resolved'] })).toBe(true)
    expect(narrowsAnnotations({ createdByMe: true })).toBe(true)
  })
})

describe('setAsideKinds', () => {
  it('names the kinds asked for that a document filter cannot narrow; annotations narrow through their document', () => {
    expect(setAsideKinds({ text: 'Fluchtweg', filters: { documentTypes: ['submission_drawing'] } })).toEqual({
      folder: 'document_filters',
      project: 'document_filters',
      conversation: 'document_filters',
    })
    expect(setAsideKinds({ text: 'Fluchtweg', kinds: ['document', 'folder'], filters: { cites: ['OIB-RL 2'] } })).toEqual({
      folder: 'document_filters',
    })
  })

  it('sets the documents aside too while an annotation filter is set', () => {
    expect(setAsideKinds({ annotationFilters: { assignedToMe: true } })).toEqual({ document: 'annotation_filters' })
    expect(setAsideKinds({ text: 'Tür', kinds: ['folder'], annotationFilters: { kinds: ['defect'] } })).toEqual({ folder: 'annotation_filters' })
  })

  it('names nothing without a narrowing filter, or for a kind the words would not have searched', () => {
    expect(setAsideKinds({ text: 'Fluchtweg', filters: { projectIds: ['p'] } })).toEqual({})
    expect(setAsideKinds({ filters: { planNumber: 'EP' } })).toEqual({})
  })
})

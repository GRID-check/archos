import { describe, expect, it } from 'vitest'

import { findDocumentReferenceQuery, insertDocumentReference } from './document-reference'

describe('findDocumentReferenceQuery', () => {
  it('finds the fragment after a # at the start or after a space', () => {
    expect(findDocumentReferenceQuery('#Flucht', 7)).toEqual({ query: 'Flucht', start: 0, end: 7 })
    expect(findDocumentReferenceQuery('Was steht in #EP-0', 18)).toEqual({ query: 'EP-0', start: 13, end: 18 })
    expect(findDocumentReferenceQuery('(#Statik', 8)).toEqual({ query: 'Statik', start: 1, end: 8 })
  })

  it('opens on a bare #', () => {
    expect(findDocumentReferenceQuery('siehe #', 7)).toEqual({ query: '', start: 6, end: 7 })
  })

  it('stays shut inside a word, after whitespace, and for a heading', () => {
    expect(findDocumentReferenceQuery('Nr.#3', 5)).toBeNull()
    expect(findDocumentReferenceQuery('#Grundriss EG', 13)).toBeNull()
    expect(findDocumentReferenceQuery('# Titel', 7)).toBeNull()
    expect(findDocumentReferenceQuery('ohne Raute', 10)).toBeNull()
  })
})

describe('insertDocumentReference', () => {
  it('writes the name in the office quotes and puts the caret after a space', () => {
    const text = 'Was steht in #EP'
    const range = findDocumentReferenceQuery(text, text.length)
    if (!range) throw new Error('no fragment')
    expect(insertDocumentReference(text, range, 'Einreichplan EG')).toEqual({ text: 'Was steht in „Einreichplan EG“ ', caret: 31 })
  })

  it('adds no second space mid-sentence', () => {
    const text = 'Vergleiche #EP mit dem Bescheid'
    const range = findDocumentReferenceQuery(text, 14)
    if (!range) throw new Error('no fragment')
    expect(insertDocumentReference(text, range, 'EP-03').text).toBe('Vergleiche „EP-03“ mit dem Bescheid')
  })
})

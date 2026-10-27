import { describe, expect, it } from 'vitest'
import { readDocumentLocus } from '@/features/documents/lib/document-locus'
import type { SearchPassage } from '@/lib/search/search-wire'
import { annotationHitHref, documentHitHref, folderHitHref } from './search-hrefs'

const projectHit = (passage: SearchPassage | null = null) => ({ id: 'd1', shelf: 'project', projectId: 'p1', passage }) as const

describe('documentHitHref', () => {
  it('opens a document without a passage in its shelf preview', () => {
    expect(documentHitHref(projectHit())).toBe('/app/projects/p1/files?doc=d1')
    expect(documentHitHref({ id: 'd2', shelf: 'office_shelf', projectId: null })).toBe('/app/office-shelf?doc=d2')
  })

  it('opens a document with a passage at its page, the passage to light up', () => {
    const href = documentHitHref(projectHit({ text: 'Die maximale Gehweglänge beträgt 34 m', page: 7 }))
    const url = new URL(href, 'https://piloti.test')
    expect(url.pathname).toBe('/app/projects/p1/files')
    expect(readDocumentLocus(url.searchParams, 'd1')).toEqual({ page: 7, highlight: 'Die maximale Gehweglänge beträgt 34 m' })
  })

  it('carries the passage alone when it has no page', () => {
    const href = documentHitHref({ id: 'd2', shelf: 'office_shelf', projectId: null, passage: { text: 'REI 90', page: null } })
    expect(href).toBe('/app/office-shelf?doc=d2&highlight=REI+90')
  })

  it('clips a long passage so the link stays a link', () => {
    const text = 'Brandabschnitt '.repeat(40)
    const url = new URL(documentHitHref(projectHit({ text, page: 2 })), 'https://piloti.test')
    expect((url.searchParams.get('highlight') ?? '').length).toBeLessThanOrEqual(200)
    expect(url.searchParams.get('page')).toBe('2')
  })
})

describe('the other hits', () => {
  it('open where the workspace shows them', () => {
    expect(annotationHitHref({ id: 'a1', documentId: 'd1', projectId: 'p1' })).toBe('/app/projects/p1/files?doc=d1&review=1&mark=a1')
    expect(folderHitHref({ id: 'f1', shelf: 'office_shelf', projectId: null })).toBe('/app/office-shelf?folder=f1')
  })
})

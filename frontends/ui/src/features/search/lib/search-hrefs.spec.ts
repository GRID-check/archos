import { describe, expect, it } from 'vitest'
import { readDocumentLocus } from '@/features/documents/lib/document-locus'
import { readDocumentBack, readReviewParams } from '@/features/documents/lib/open-review'
import type { SearchPassage } from '@/lib/search/search-wire'
import { annotationHitHref, documentFolderHref, documentHitHref, documentLinkHref, documentReviewHitHref, folderHitHref, hitHref, searchReturnPath } from './search-hrefs'

describe('documentReviewHitHref', () => {
  const SEARCH = '/app/search?q=Brandschutz'
  const read = (href: string): URL => new URL(href, 'https://piloti.test')

  it('opens the document’s Prüfansicht on its shelf, at no mark, returning to the search', () => {
    const project = read(documentReviewHitHref({ id: 'd1', shelf: 'project', projectId: 'p1' }, { back: SEARCH }))
    expect(project.pathname).toBe('/app/projects/p1/files')
    expect(readReviewParams(project.searchParams)).toMatchObject({ documentId: 'd1', open: true, back: SEARCH })
    expect(project.searchParams.get('mark')).toBeNull()
    const shelf = read(documentReviewHitHref({ id: 'd2', shelf: 'office_shelf', projectId: null }, { back: SEARCH }))
    expect(shelf.pathname).toBe('/app/office-shelf')
    expect(readReviewParams(shelf.searchParams)).toMatchObject({ documentId: 'd2', open: true, back: SEARCH })
  })
})

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

describe('documentLinkHref and documentFolderHref', () => {
  it('passes on the document itself, absolute, without the passage or a way back', () => {
    expect(documentLinkHref({ id: 'd1', shelf: 'project', projectId: 'p1' }, 'https://piloti.test')).toBe('https://piloti.test/app/projects/p1/files?doc=d1')
    expect(documentLinkHref({ id: 'd2', shelf: 'office_shelf', projectId: null }, 'https://piloti.test')).toBe('https://piloti.test/app/office-shelf?doc=d2')
  })

  it('shows the folder a document lies in, and the shelf’s top level for one at its root', () => {
    expect(documentFolderHref({ shelf: 'project', projectId: 'p1', folderId: 'f1' })).toBe('/app/projects/p1/files?folder=f1')
    expect(documentFolderHref({ shelf: 'office_shelf', projectId: null, folderId: null })).toBe('/app/office-shelf')
  })
})

describe('the other hits', () => {
  it('open where the workspace shows them', () => {
    expect(annotationHitHref({ id: 'a1', documentId: 'd1', projectId: 'p1' })).toBe('/app/projects/p1/files?doc=d1&review=1&mark=a1')
    expect(folderHitHref({ id: 'f1', shelf: 'office_shelf', projectId: null })).toBe('/app/office-shelf?folder=f1')
  })
})

describe('back to the search', () => {
  const SEARCH = '/app/search?q=Brandschutz&view=register&type=plan&sort=planNumber&dir=desc'
  const read = (href: string): URL => new URL(href, 'https://piloti.test')

  it('takes the search page as it stands, without a back handed to it', () => {
    expect(searchReturnPath('/app/search', 'q=Brandschutz&view=register')).toBe('/app/search?q=Brandschutz&view=register')
    expect(searchReturnPath('/app/projects/p1/files', 'mode=search&q=REI&back=%2Fapp%2Finbox')).toBe('/app/projects/p1/files?mode=search&q=REI')
    expect(searchReturnPath('/app/search', '')).toBe('/app/search')
  })

  it('puts the search on a document hit, beside its page and passage', () => {
    const url = read(documentHitHref(projectHit({ text: 'REI 90 Trennwand', page: 4 }), { back: SEARCH }))
    expect(url.pathname).toBe('/app/projects/p1/files')
    expect(readDocumentBack(url.searchParams)).toBe(SEARCH)
    expect(readDocumentLocus(url.searchParams, 'd1')).toEqual({ page: 4, highlight: 'REI 90 Trennwand' })
  })

  it('opens an annotation hit in the review, returning to the search on closing', () => {
    const project = read(annotationHitHref({ id: 'a1', documentId: 'd1', projectId: 'p1' }, { back: SEARCH }))
    expect(project.pathname).toBe('/app/projects/p1/files')
    expect(readReviewParams(project.searchParams)).toMatchObject({ documentId: 'd1', open: true, annotationId: 'a1', back: SEARCH })
    const shelf = read(annotationHitHref({ id: 'a2', documentId: 'd2', projectId: null }, { back: SEARCH }))
    expect(shelf.pathname).toBe('/app/office-shelf')
    expect(readReviewParams(shelf.searchParams)).toMatchObject({ documentId: 'd2', open: true, annotationId: 'a2', back: SEARCH })
  })

  it('drops a back that leaves the app', () => {
    for (const back of ['https://evil.example/app/search', '//evil.example/app/search', '/\\evil.example', 'javascript:alert(1)', '/api/search']) {
      expect(documentHitHref(projectHit(), { back })).toBe('/app/projects/p1/files?doc=d1')
      expect(annotationHitHref({ id: 'a1', documentId: 'd1', projectId: 'p1' }, { back })).toBe('/app/projects/p1/files?doc=d1&review=1&mark=a1')
    }
  })

  it('leaves the hits with nothing to close as they were: Back walks to the search', () => {
    expect(hitHref({ kind: 'folder', id: 'f1', shelf: 'office_shelf', projectId: null } as Parameters<typeof hitHref>[0], { back: SEARCH })).toBe(
      '/app/office-shelf?folder=f1'
    )
  })

  it('carries no back outside a search surface', () => {
    expect(documentHitHref(projectHit())).toBe('/app/projects/p1/files?doc=d1')
  })
})

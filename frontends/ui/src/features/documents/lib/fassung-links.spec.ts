import { describe, expect, it } from 'vitest'
import { compareFromReviewHref, otherReviewHref } from './fassung-links'

const files = { pathname: '/app/projects/p1/files', search: '?doc=doc-c&review=1&mark=ann-7' }

describe('otherReviewHref', () => {
  it('opens another document’s review at a mark, where the page addresses documents by doc', () => {
    expect(otherReviewHref(files, 'doc-c', { documentId: 'doc-b', annotationId: 'ann-4' })).toBe(
      '/app/projects/p1/files?doc=doc-b&review=1&mark=ann-4'
    )
  })

  it('gives no link over the chat, where doc is the subject of an ask', () => {
    expect(otherReviewHref({ pathname: '/app/projects/p1/chat', search: '?review=1' }, 'doc-c', { documentId: 'doc-b' })).toBeNull()
  })
})

describe('compareFromReviewHref', () => {
  it('leaves the review and opens the comparison of the shown document with the older one', () => {
    expect(compareFromReviewHref(files, 'doc-c', 'doc-b')).toBe('/app/projects/p1/files?doc=doc-c&compare=doc-b')
  })

  it('gives no link where the page does not address the shown document', () => {
    expect(compareFromReviewHref({ pathname: '/app/archiv', search: '?doc=other' }, 'doc-c', 'doc-b')).toBeNull()
  })
})

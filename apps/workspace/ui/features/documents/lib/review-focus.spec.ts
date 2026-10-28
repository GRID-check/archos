import { describe, expect, it } from 'vitest'
import { reviewFocusOf } from './review-focus'

const document = { fileName: 'Grundriss.pdf', versionId: null, versionState: null, shelf: 'project' as const }

describe('reviewFocusOf', () => {
  it('is null with nothing drawn or selected', () => {
    expect(reviewFocusOf({ documentId: 'd1', draft: null, selected: null, document })).toBeNull()
  })

  it('is the drawn box, on its page, for the open document', () => {
    const focus = reviewFocusOf({
      documentId: 'd1',
      draft: { page: 2, shape: 'region', x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
      selected: { page: 1, x: 0.5, y: 0.5, w: 0.1, h: 0.1 },
      document,
    })
    expect(focus).toMatchObject({
      documentId: 'd1',
      fileName: 'Grundriss.pdf',
      replyInThread: false,
      region: { page: 2, x: 0.1, y: 0.2, w: 0.3, h: 0.4 },
    })
  })

  it('is a small box around a selected point', () => {
    const focus = reviewFocusOf({
      documentId: 'd1',
      draft: null,
      selected: { page: 3, x: 0.5, y: 0.5, w: null, h: null },
      document,
    })
    expect(focus?.region).toMatchObject({ page: 3, w: 0.08, h: 0.08 })
  })
})

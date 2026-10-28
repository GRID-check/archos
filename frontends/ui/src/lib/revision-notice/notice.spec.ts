/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { MAX_PROPOSALS_PER_CALL, annotationProposalSchema } from '@/lib/annotations/types'
import {
  DEFAULT_MAX_PAGES,
  markBasis,
  markBody,
  maxNoticePages,
  noticeDelaySeconds,
  noticeExcerpt,
  noticeMessage,
  pagesToCompare,
  proposalsFrom,
  revisionNoticeId,
  revisionNoticeMessageId,
  type PageComparison,
} from './notice'

const REGION = { page: 2, x: 0.2, y: 0.3, w: 0.1, h: 0.25, label: 'Wand nach Norden verschoben' }
const OLDER = 'Grundriss EG Index B'

const comparison = (page: number, regions = [REGION], summary = ['Die Nordwand ist um 0,5 m gerückt.']): PageComparison => ({
  page,
  changes: { regions: regions.map((region) => ({ ...region, page })), summary },
})

describe('ids', () => {
  it('names one pair once, and its message once', () => {
    const id = revisionNoticeId('doc-b', 'doc-a')
    expect(id).toBe(revisionNoticeId('doc-b', 'doc-a'))
    expect(id).not.toBe(revisionNoticeId('doc-a', 'doc-b'))
    expect(revisionNoticeMessageId(id)).toBe(revisionNoticeMessageId(id))
    expect(revisionNoticeMessageId(id)).not.toBe(id)
  })
})

describe('caps', () => {
  it('reads the deployment’s caps, bounded, with defaults', () => {
    expect(maxNoticePages({})).toBe(DEFAULT_MAX_PAGES)
    expect(maxNoticePages({ GRID_REVISION_NOTICE_MAX_PAGES: '5' })).toBe(5)
    expect(maxNoticePages({ GRID_REVISION_NOTICE_MAX_PAGES: '500' })).toBe(10)
    expect(maxNoticePages({ GRID_REVISION_NOTICE_MAX_PAGES: '0' })).toBe(1)
    expect(maxNoticePages({ GRID_REVISION_NOTICE_MAX_PAGES: 'x' })).toBe(DEFAULT_MAX_PAGES)
    expect(noticeDelaySeconds({})).toBe(120)
    expect(noticeDelaySeconds({ GRID_REVISION_NOTICE_DELAY_SECONDS: '0' })).toBe(0)
  })
})

describe('pagesToCompare', () => {
  it('looks at the changed pages first, and names those past the cap', () => {
    expect(pagesToCompare({ pages: [7, 2, 4, 2, 9], newerPageCount: 10, comparable: true }, 3)).toEqual({
      pages: [2, 4, 7],
      skipped: [9],
    })
  })

  it('looks at nothing when the read content shows nothing changed', () => {
    expect(pagesToCompare({ pages: [], newerPageCount: 4, comparable: true }, 3)).toEqual({ pages: [], skipped: [] })
  })

  it('looks at the first pages of a scan, where nothing can be called unchanged', () => {
    expect(pagesToCompare({ pages: [], newerPageCount: 2, comparable: false }, 3).pages).toEqual([1, 2])
    expect(pagesToCompare({ pages: [], newerPageCount: 0, comparable: false }, 3).pages).toEqual([1, 2, 3])
  })
})

describe('proposalsFrom', () => {
  it('makes each box a proposed hint at its place, saying what moved and on which basis', () => {
    const [proposal] = proposalsFrom([comparison(2)], OLDER)

    expect(proposal).toMatchObject({ page: 2, shape: 'region', x: 0.2, y: 0.3, w: 0.1, h: 0.25, kind: 'hint' })
    expect(proposal.body).toBe(
      'Geändert gegenüber „Grundriss EG Index B“: Wand nach Norden verschoben. Die Nordwand ist um 0,5 m gerückt.',
    )
    expect(proposal.basis).toContain('Bildvergleich mit „Grundriss EG Index B“, S. 2')
    expect(proposal.basis).toContain('nicht geprüft')
    expect(annotationProposalSchema.safeParse(proposal).success).toBe(true)
  })

  it('uses the box’s label alone when the sentences do not pair with the boxes', () => {
    const [proposal] = proposalsFrom([comparison(1, [REGION, { ...REGION, label: 'Tür neu' }], ['Ein Satz.'])], OLDER)

    expect(proposal.body).toBe('Geändert gegenüber „Grundriss EG Index B“: Wand nach Norden verschoben.')
  })

  it('proposes nothing for a page without a visible change', () => {
    expect(proposalsFrom([comparison(1, [], ['keine sichtbare Änderung'])], OLDER)).toEqual([])
  })

  it('does not propose again what Piloti already proposed there (a retried notice)', () => {
    const [first] = proposalsFrom([comparison(2)], OLDER)
    const existing = [{ ...first, w: first.w ?? null, h: first.h ?? null, authorKind: 'piloti' }]

    expect(proposalsFrom([comparison(2)], OLDER, existing)).toEqual([])
    expect(proposalsFrom([comparison(2)], OLDER, [{ ...existing[0], authorKind: 'user' }])).toHaveLength(1)
  })

  it('stops at what one call may propose, in page order', () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ ...REGION, label: `Änderung ${index}` }))
    const proposals = proposalsFrom([comparison(3, many, []), comparison(1, many, [])], OLDER)

    expect(proposals).toHaveLength(MAX_PROPOSALS_PER_CALL)
    expect(proposals[0].page).toBe(1)
  })

  it('keeps a body and a basis inside what the database allows', () => {
    const long = 'x'.repeat(5000)
    expect(markBody({ ...REGION, label: long }, long, long).length).toBeLessThanOrEqual(2000)
    expect(markBasis(1, long).length).toBeLessThanOrEqual(300)
  })
})

describe('noticeMessage', () => {
  it('says what was compared, what is proposed, what was not looked at, and that it is no legal check', () => {
    const proposals = proposalsFrom([comparison(2)], OLDER)

    const text = noticeMessage({ newerName: 'Grundriss EG Index C', olderName: OLDER, compared: [2], skipped: [5, 6], proposals })

    expect(text).toContain('„Grundriss EG Index C“ mit „Grundriss EG Index B“ verglichen (Seite 2)')
    expect(text).toContain('Eine Stelle ist am Dokument als Vorschlag markiert, noch nicht übernommen')
    expect(text).toContain('1. S. 2: Geändert gegenüber')
    expect(text).toContain('Weitere geänderte Seiten 5, 6 habe ich nicht angesehen')
    expect(text).toContain('keine Prüfung gegen Vorschriften')
    expect(noticeExcerpt(proposals)).toMatch(/^S\. 2: Geändert/)
    expect(noticeExcerpt([])).toBeNull()
  })
})

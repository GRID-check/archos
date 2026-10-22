/**
 * @vitest-environment node
 */
/**
 * The evidence of an ask's answer (ADR-0124): read from what the message
 * stores, linked the way the UI links a citation, absent where the message has
 * none.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/sharing/registry', () => ({
  describeResource: () => ({
    deepLink: (id: string, options?: { projectId?: string }) =>
      options?.projectId
        ? `/app/projects/${options.projectId}/chat?session=${id}`
        : `/app/chat?session=${id}`,
  }),
}))

import { parseCitationLink } from '@/features/chat/lib/citations/deep-link'
import { answerEvidence } from './answer-evidence'

const THREAD = 's_11111111_1111_4111_8111_111111111111'
const PROJECT = '44444444-4444-4444-8444-444444444444'
const createdAt = new Date('2026-10-21T09:00:30.000Z')

const stored = {
  citations: {
    v: 1,
    sources: [
      {
        file_name: 'Brandschutzkonzept.pdf',
        document_id: 'col_p:Brandschutzkonzept.pdf',
        collection: 'col_p',
        title: 'Brandschutzkonzept',
        page: 3,
        number: 1,
        shelf: 'project',
        is_cited: true,
      },
      {
        file_name: 'Brandschutzkonzept.pdf',
        document_id: 'col_p:Brandschutzkonzept.pdf',
        collection: 'col_p',
        title: 'Brandschutzkonzept',
        page: 9,
        shelf: 'project',
        is_cited: false,
      },
    ],
  },
  provenance: { answerConfidence: 'high', answerConfidenceReason: 'Zitiert aus dem Dokument.' },
}

describe('answerEvidence', () => {
  it('lists the cited sources with a link that opens the cited page, and the stored confidence', () => {
    const evidence = answerEvidence(
      { metadata: stored, createdAt },
      { conversationId: THREAD, projectId: PROJECT, origin: 'https://app.piloti.at' },
    )
    expect(evidence.sources).toHaveLength(1)
    const [source] = evidence.sources ?? []
    expect(source).toMatchObject({ documentId: 'col_p:Brandschutzkonzept.pdf', name: 'Brandschutzkonzept', page: 3 })
    const url = new URL(source?.url ?? '')
    expect(url.origin + url.pathname).toBe(`https://app.piloti.at/app/projects/${PROJECT}/chat`)
    expect(url.searchParams.get('session')).toBe(THREAD)
    expect(parseCitationLink(url.searchParams.get('cite'))?.documentId).toBe('col_p:Brandschutzkonzept.pdf')
    expect(evidence.confidence).toEqual({ level: 'high', reason: 'Zitiert aus dem Dokument.' })
  })

  it('leaves the link relative where the deployment pins no origin', () => {
    const evidence = answerEvidence({ metadata: stored, createdAt }, { conversationId: THREAD, projectId: null })
    expect(evidence.sources?.[0]?.url.startsWith(`/app/chat?session=${THREAD}&cite=`)).toBe(true)
  })

  it('links a web source to its own address', () => {
    const evidence = answerEvidence(
      {
        metadata: {
          citations: { v: 1, sources: [{ url: 'https://www.ris.bka.gv.at/x', title: 'RIS', origin: 'ris', is_cited: true }] },
        },
        createdAt,
      },
      { conversationId: THREAD, projectId: null },
    )
    expect(evidence.sources?.[0]).toMatchObject({ name: 'RIS', url: 'https://www.ris.bka.gv.at/x' })
  })

  it('carries no key for what the message does not store', () => {
    expect(answerEvidence({ metadata: null, createdAt }, { conversationId: THREAD, projectId: null })).toEqual({})
    expect(answerEvidence({ metadata: { citations: { v: 1, sources: [] } }, createdAt }, { conversationId: THREAD, projectId: null })).toEqual({})
  })

  it('reports an answer the search found nothing for as ungrounded', () => {
    const evidence = answerEvidence(
      { metadata: { provenance: { answerConfidence: 'low', lookupFoundNothing: true } }, createdAt },
      { conversationId: THREAD, projectId: null },
    )
    expect(evidence).toEqual({ confidence: { level: 'low', lookupFoundNothing: true } })
  })
})

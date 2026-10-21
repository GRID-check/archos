/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NotFoundError, UnprocessableError, UpstreamError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Document } from '@/lib/db/schema'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/auth/pinned-session', () => ({ resolvePinnedRequesterSession: vi.fn() }))
vi.mock('@/lib/annotations/agent', () => ({ runAgentAnnotationRequest: vi.fn() }))
vi.mock('@/lib/annotations/document-thread', () => ({ ensureDocumentThread: vi.fn() }))
vi.mock('@/lib/annotations/repository', () => ({ listDocumentAnnotations: vi.fn() }))
vi.mock('@/lib/budgets/service', () => ({ getBudgetStatus: vi.fn() }))
vi.mock('@/lib/conversations/repository', () => ({ insertMessages: vi.fn() }))
vi.mock('@/lib/documents/repository', () => ({ findDocumentInOrg: vi.fn() }))
vi.mock('@/lib/documents/revision-compare-service', () => ({
  changedRevisionPages: vi.fn(),
  compareRevisionPage: vi.fn(),
}))
vi.mock('@/lib/inbox/service', () => ({ emitInboxItems: vi.fn() }))
vi.mock('@/lib/langfuse/revision-notice-score', () => ({ recordRevisionNoticeScore: vi.fn() }))

import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import { runAgentAnnotationRequest } from '@/lib/annotations/agent'
import { ensureDocumentThread } from '@/lib/annotations/document-thread'
import { listDocumentAnnotations } from '@/lib/annotations/repository'
import { getBudgetStatus } from '@/lib/budgets/service'
import { insertMessages } from '@/lib/conversations/repository'
import { findDocumentInOrg } from '@/lib/documents/repository'
import { changedRevisionPages, compareRevisionPage } from '@/lib/documents/revision-compare-service'
import { emitInboxItems } from '@/lib/inbox/service'
import { recordRevisionNoticeScore } from '@/lib/langfuse/revision-notice-score'
import { noticeRevision, runRevisionNotice } from './job'
import { revisionNoticeId, revisionNoticeMessageId } from './notice'

const ORG = 'org-1'
const NEWER_ID = '00000000-0000-4000-8000-00000000000b'
const OLDER_ID = '00000000-0000-4000-8000-00000000000a'
const NOTICE_ID = revisionNoticeId(NEWER_ID, OLDER_ID)
const TRACE = 'c'.repeat(32)
const payload = { noticeId: NOTICE_ID, newerId: NEWER_ID, olderId: OLDER_ID, actor: { userId: 'editor', email: 'e@x.test' } }

const session = {
  userId: 'editor',
  email: 'e@x.test',
  organizationId: ORG,
  featureFlags: ['piloti-notices'],
} as unknown as AuthorizedSession

const doc = (id: string, filename: string): Document =>
  ({ id, filename, displayName: null, projectId: 'p1', collectionName: 'proj_abc', scope: 'project' }) as Document
const NEWER = doc(NEWER_ID, 'Grundriss_EG_Index_C.pdf')
const OLDER = doc(OLDER_ID, 'Grundriss_EG_Index_B.pdf')

const REGION = { page: 2, x: 0.2, y: 0.3, w: 0.1, h: 0.25, label: 'Wand verschoben' }

beforeEach(() => {
  vi.resetAllMocks()
  // Where people sign in, a session's flags decide (`lib/authz/feature-flags.ts`).
  vi.stubEnv('REQUIRE_AUTH', 'true')
  vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(session)
  vi.mocked(findDocumentInOrg).mockImplementation(async (id) => [NEWER, OLDER].find((d) => d.id === id) ?? null)
  vi.mocked(getBudgetStatus).mockResolvedValue({ blocked: false } as Awaited<ReturnType<typeof getBudgetStatus>>)
  vi.mocked(changedRevisionPages).mockResolvedValue({ pages: [2, 4, 5, 6], newerPageCount: 6, comparable: true })
  vi.mocked(compareRevisionPage).mockImplementation(async (_s, _n, _o, page) =>
    page === 2
      ? { changes: { regions: [REGION], summary: ['Die Wand ist gerückt.'] }, traceId: TRACE }
      : { changes: { regions: [], summary: ['keine sichtbare Änderung'] }, traceId: null },
  )
  vi.mocked(listDocumentAnnotations).mockResolvedValue([])
  vi.mocked(ensureDocumentThread).mockResolvedValue('s_thread')
  vi.mocked(insertMessages).mockResolvedValue([])
  vi.mocked(runAgentAnnotationRequest).mockResolvedValue({
    documentId: NEWER_ID,
    documentName: NEWER.filename,
    proposed: [{ id: 'mark-1', number: 7, page: 2, shape: 'region', x: 0.2, y: 0.3, w: 0.1, h: 0.25, kind: 'hint', body: 'b' }],
  } as Awaited<ReturnType<typeof runAgentAnnotationRequest>>)
  vi.mocked(emitInboxItems).mockResolvedValue(1)
  vi.mocked(recordRevisionNoticeScore).mockResolvedValue(undefined)
})

describe('noticeRevision', () => {
  it('compares the changed pages up to the cap, as a notice, as the person who made the Fassung', async () => {
    const outcome = await noticeRevision(ORG, payload)

    expect(resolvePinnedRequesterSession).toHaveBeenCalledWith({ userId: 'editor', email: 'e@x.test', organizationId: ORG })
    expect(vi.mocked(compareRevisionPage).mock.calls.map((call) => [call[0], call[3], call[4]])).toEqual([
      [session, 2, 'notice'],
      [session, 4, 'notice'],
      [session, 5, 'notice'],
    ])
    expect(outcome).toEqual({ status: 'proposed', compared: [2, 4, 5], marks: 1 })
  })

  it('proposes through the canvas tool’s one path, recorded against its own message, never open', async () => {
    await noticeRevision(ORG, payload)

    const [asSession, document, request, agent] = vi.mocked(runAgentAnnotationRequest).mock.calls[0]
    expect(asSession).toBe(session)
    expect(document).toEqual({ id: NEWER_ID, name: NEWER.filename, projectId: 'p1' })
    expect(request).toMatchObject({ op: 'propose', answerMessageId: revisionNoticeMessageId(NOTICE_ID) })
    expect(request.op === 'propose' && request.proposals).toEqual([
      expect.objectContaining({ page: 2, kind: 'hint', shape: 'region', x: 0.2, y: 0.3 }),
    ])
    expect(agent).toEqual({ organizationId: ORG, conversationId: 's_thread', onBehalfOf: 'editor' })
  })

  it('writes one message into the person’s thread carrying the trace, saying which pages it did not look at', async () => {
    await noticeRevision(ORG, payload)

    const [[[message]]] = vi.mocked(insertMessages).mock.calls
    expect(message).toMatchObject({
      id: revisionNoticeMessageId(NOTICE_ID),
      conversationId: 's_thread',
      role: 'assistant',
      metadata: { messageType: 'agent_response', trace_id: TRACE },
    })
    expect(message.content).toContain('Weitere geänderte Seite 6 habe ich nicht angesehen')
    expect(message.content).toContain('keine Prüfung gegen Vorschriften')
  })

  it('tells the person once in the inbox, anchored on the first mark, and scores the count', async () => {
    await noticeRevision(ORG, payload)

    expect(emitInboxItems).toHaveBeenCalledWith([
      expect.objectContaining({
        recipientUserId: 'editor',
        type: 'piloti.revision_checked',
        resourceType: 'document',
        resourceId: NEWER_ID,
        anchorId: 'mark-1',
        actorUserId: null,
        payload: expect.objectContaining({ subject: NEWER.filename, related: OLDER.filename, openMarks: 1, variant: 'one' }),
      }),
    ])
    expect(recordRevisionNoticeScore).toHaveBeenCalledWith({
      noticeId: NOTICE_ID,
      traceId: TRACE,
      proposed: 1,
      pagesCompared: 3,
      pagesChanged: 4,
    })
  })

  it('is silent when nothing visible moved: no mark, no message, no row, only the score', async () => {
    vi.mocked(compareRevisionPage).mockResolvedValue({ changes: { regions: [], summary: ['keine sichtbare Änderung'] }, traceId: TRACE })

    expect(await noticeRevision(ORG, payload)).toEqual({ status: 'silent', compared: [2, 4, 5] })
    expect(runAgentAnnotationRequest).not.toHaveBeenCalled()
    expect(insertMessages).not.toHaveBeenCalled()
    expect(emitInboxItems).not.toHaveBeenCalled()
    expect(recordRevisionNoticeScore).toHaveBeenCalledWith(expect.objectContaining({ proposed: 0 }))
  })

  it('asks no model when the read content shows no page changed', async () => {
    vi.mocked(changedRevisionPages).mockResolvedValue({ pages: [], newerPageCount: 3, comparable: true })

    expect(await noticeRevision(ORG, payload)).toEqual({ status: 'silent', compared: [] })
    expect(compareRevisionPage).not.toHaveBeenCalled()
  })

  it('skips a page that cannot be rendered and keeps the others', async () => {
    vi.mocked(compareRevisionPage).mockImplementation(async (_s, _n, _o, page) => {
      if (page === 4) throw new NotFoundError('That page is not available for comparison')
      return { changes: { regions: page === 2 ? [REGION] : [], summary: [] }, traceId: null }
    })

    expect(await noticeRevision(ORG, payload)).toMatchObject({ status: 'proposed', compared: [2, 5] })
  })

  it.each([
    ['a person who left', () => vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(null), 'no longer a member'],
    [
      'the switch off',
      () => vi.mocked(resolvePinnedRequesterSession).mockResolvedValue({ ...session, featureFlags: [] }),
      'piloti-notices is off',
    ],
    ['a held document', () => vi.mocked(findDocumentInOrg).mockResolvedValue(null), 'gone or held'],
    [
      'a spent budget',
      () => vi.mocked(getBudgetStatus).mockResolvedValue({ blocked: true } as Awaited<ReturnType<typeof getBudgetStatus>>),
      'budget',
    ],
    ['an unreadable budget', () => vi.mocked(getBudgetStatus).mockRejectedValue(new Error('db')), 'budget'],
    [
      'a restricted folder',
      () =>
        vi.mocked(changedRevisionPages).mockRejectedValue(
          new UnprocessableError('Documents in a restricted folder cannot be compared by Piloti'),
        ),
      'restricted folder',
    ],
  ])('ends quietly for %s, before any model is asked', async (_name, arrange, reason) => {
    vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    arrange()

    const outcome = await noticeRevision(ORG, payload)

    expect(outcome.status).toBe('skipped')
    expect(outcome.status === 'skipped' && outcome.reason).toContain(reason)
    expect(compareRevisionPage).not.toHaveBeenCalled()
    expect(runAgentAnnotationRequest).not.toHaveBeenCalled()
  })

  it('leaves a write it may not make to the person: refused, nothing retried, no message about marks that are not there', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    vi.mocked(runAgentAnnotationRequest).mockRejectedValue(new NotFoundError())

    expect((await noticeRevision(ORG, payload)).status).toBe('skipped')
    expect(insertMessages).not.toHaveBeenCalled()
  })

  it('on a retry after the marks were written, proposes nothing again and still writes the message', async () => {
    await noticeRevision(ORG, payload)
    const proposed = vi.mocked(runAgentAnnotationRequest).mock.calls[0][2]
    const written = proposed.op === 'propose' ? proposed.proposals : []
    vi.mocked(runAgentAnnotationRequest).mockClear()
    vi.mocked(insertMessages).mockClear()
    vi.mocked(listDocumentAnnotations).mockResolvedValue(
      written.map((mark) => ({ ...mark, w: mark.w ?? null, h: mark.h ?? null, authorKind: 'piloti' })) as unknown as Awaited<
        ReturnType<typeof listDocumentAnnotations>
      >,
    )

    await noticeRevision(ORG, payload)

    expect(runAgentAnnotationRequest).not.toHaveBeenCalled()
    expect(insertMessages).toHaveBeenCalledTimes(1)
  })
})

describe('runRevisionNotice', () => {
  it('throws what a retry may fix, and gives up quietly on the last attempt', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.mocked(compareRevisionPage).mockRejectedValue(new UpstreamError('The comparison could not be made'))

    await expect(runRevisionNotice(ORG, payload, { last: false })).rejects.toThrow('could not be made')
    await expect(runRevisionNotice(ORG, payload, { last: true })).resolves.toBeUndefined()
  })
})

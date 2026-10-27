/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import type { Document } from '@/lib/db/schema'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/auth/pinned-session', () => ({ resolvePinnedRequesterSession: vi.fn() }))
vi.mock('@/lib/documents/access', () => ({ getAccessibleDocument: vi.fn() }))
vi.mock('@/lib/budgets/unasked-spend', () => ({ unaskedSpendAllowed: vi.fn() }))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/conversations/repository', () => ({
  deleteConversationInOrg: vi.fn(),
  findMessageInConversation: vi.fn(),
  insertConversation: vi.fn(),
  insertMessages: vi.fn(),
}))
vi.mock('@/lib/changes/repository', () => ({ listTurnChangeRows: vi.fn() }))
vi.mock('@/lib/annotations/repository', () => ({ listDocumentAnnotations: vi.fn() }))
vi.mock('@/lib/annotations/document-thread', () => ({ ensureDocumentThread: vi.fn() }))
vi.mock('@/lib/inbox/service', () => ({ emitInboxItems: vi.fn() }))
vi.mock('@/lib/langfuse/document-check-score', () => ({ recordDocumentCheckScore: vi.fn() }))
vi.mock('@/lib/agent-asks/service', () => ({
  askAnswerMessageId: (conversationId: string, askId: string) => `answer:${conversationId}:${askId}`,
}))
vi.mock('@/lib/turns/headless-turn', () => ({ chatSocketUrl: vi.fn(() => 'ws://chat/websocket'), runHeadlessTurn: vi.fn() }))
vi.mock('@/lib/turns/turn-context', async () => {
  class TurnBudgetExhaustedError extends Error {
    constructor(readonly blockedScope: string | null) {
      super(`The ${blockedScope} LLM budget is exhausted.`)
    }
  }
  return { resolveTurnContext: vi.fn(), TurnBudgetExhaustedError }
})
vi.mock('@/lib/turns/turn-headers.js', () => ({ turnContextHeaders: vi.fn(() => ({ 'x-grid-request-context': 'signed' })) }))

import { listDocumentAnnotations } from '@/lib/annotations/repository'
import { ensureDocumentThread } from '@/lib/annotations/document-thread'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import { unaskedSpendAllowed } from '@/lib/budgets/unasked-spend'
import { requireProjectAccess } from '@/lib/authz/projects'
import { listTurnChangeRows } from '@/lib/changes/repository'
import {
  deleteConversationInOrg,
  findMessageInConversation,
  insertConversation,
  insertMessages,
} from '@/lib/conversations/repository'
import { getAccessibleDocument } from '@/lib/documents/access'
import { emitInboxItems } from '@/lib/inbox/service'
import { recordDocumentCheckScore } from '@/lib/langfuse/document-check-score'
import { runHeadlessTurn } from '@/lib/turns/headless-turn'
import { resolveTurnContext, TurnBudgetExhaustedError } from '@/lib/turns/turn-context'
import type { DocumentCheckPayload } from '@/lib/jobs-queue/types'
import { documentCheckConversationId, documentCheckId, documentCheckMessageId } from './check'
import { runDocumentCheckSlice } from './job'

const ORG = 'org-1'
const DOC_ID = '00000000-0000-4000-8000-0000000000d1'
const CHECK_ID = documentCheckId(DOC_ID, 'v1')
const CONVERSATION = documentCheckConversationId(CHECK_ID)
const ANSWER = `answer:${CONVERSATION}:${CHECK_ID}`
const TRACE = 'c'.repeat(32)
const attempt = { last: false }

const start: DocumentCheckPayload = {
  checkId: CHECK_ID,
  documentId: DOC_ID,
  actor: { userId: 'uploader', email: 'u@x.test' },
  conversationId: null,
  waits: 0,
}
const waiting: DocumentCheckPayload = { ...start, conversationId: CONVERSATION }

const session = {
  userId: 'uploader',
  email: 'u@x.test',
  name: 'Anna Weber',
  organizationId: ORG,
  featureFlags: ['piloti-notices'],
} as unknown as AuthorizedSession
const DOCUMENT = {
  id: DOC_ID,
  filename: 'Brandschutzkonzept.pdf',
  displayName: null,
  projectId: 'p1',
  scope: 'project',
  lifecycle: 'active',
} as Document

const change = (annotationId: string, overrides: Record<string, unknown> = {}) =>
  ({ objectKind: 'annotation', op: 'create', annotationId, undoneAt: null, ...overrides }) as never
const mark = (id: string, page: number, body: string) => ({ id, page, number: page, body }) as never

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv('REQUIRE_AUTH', 'true')
  vi.stubEnv('GRID_INTERNAL_API_TOKEN', 'secret')
  vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(session)
  vi.mocked(getAccessibleDocument).mockResolvedValue(DOCUMENT)
  vi.mocked(unaskedSpendAllowed).mockResolvedValue(true)
  vi.mocked(requireProjectAccess).mockResolvedValue(undefined as never)
  vi.mocked(insertConversation).mockResolvedValue(null)
  vi.mocked(insertMessages).mockResolvedValue([])
  vi.mocked(deleteConversationInOrg).mockResolvedValue(undefined)
  vi.mocked(resolveTurnContext).mockResolvedValue({ projectId: 'p1' } as never)
  vi.mocked(runHeadlessTurn).mockResolvedValue({ kind: 'started' })
  vi.mocked(findMessageInConversation).mockResolvedValue({ id: ANSWER, metadata: { trace_id: TRACE } } as never)
  vi.mocked(listTurnChangeRows).mockResolvedValue([])
  vi.mocked(listDocumentAnnotations).mockResolvedValue([])
  vi.mocked(ensureDocumentThread).mockResolvedValue('s_thread')
  vi.mocked(emitInboxItems).mockResolvedValue(1)
  vi.mocked(recordDocumentCheckScore).mockResolvedValue(undefined)
})

describe('runDocumentCheckSlice — starting the turn', () => {
  it('starts a headless turn as the person, in a private conversation about the document, with the fixed English instruction', async () => {
    const result = await runDocumentCheckSlice(ORG, start, attempt)

    expect(insertConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: CONVERSATION,
        createdBy: 'uploader',
        projectId: 'p1',
        subjectResourceType: 'document',
        subjectResourceId: DOC_ID,
      }),
    )
    const [[request]] = vi.mocked(runHeadlessTurn).mock.calls
    expect(request.conversationId).toBe(CONVERSATION)
    expect(request.headers['x-aiq-mode']).toBe('headless')
    expect(request.requires).toEqual(['user_message.trigger', 'user_message.if_idle'])
    expect(request.message).toMatchObject({
      message_id: CHECK_ID,
      focus_document_id: DOC_ID,
      if_idle: true,
      trigger: { kind: 'new_document', event_id: CHECK_ID, annotation_id: null },
    })
    expect(request.message.text).toContain('canvas__mark')
    expect(request.message.text).toContain('do not ask anything')
    // The person's message is the same instruction, under the turn's id.
    expect(vi.mocked(insertMessages).mock.calls[0][0][0]).toMatchObject({ id: CHECK_ID, role: 'user', authorUserId: 'uploader' })
    expect(result).toMatchObject({ done: false, payload: { conversationId: CONVERSATION } })
    expect(result.notBefore).toBeInstanceOf(Date)
  })

  it.each([
    ['a person who left', () => vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(null)],
    ['the switch off', () => vi.mocked(resolvePinnedRequesterSession).mockResolvedValue({ ...session, featureFlags: [] })],
    ['a document gone or held', () => vi.mocked(getAccessibleDocument).mockRejectedValue(new NotFoundError())],
    [
      'a document that is not a project\'s',
      () => vi.mocked(getAccessibleDocument).mockResolvedValue({ ...DOCUMENT, scope: 'office_shelf', projectId: null }),
    ],
  ])('ends quietly for %s, before anything is written or a model is asked', async (_name, arrange) => {
    arrange()

    const result = await runDocumentCheckSlice(ORG, start, attempt)

    expect(result.done).toBe(true)
    expect(insertConversation).not.toHaveBeenCalled()
    expect(runHeadlessTurn).not.toHaveBeenCalled()
  })

  it('asks the fail-closed budget gate before it writes anything or starts a turn', async () => {
    vi.mocked(unaskedSpendAllowed).mockResolvedValue(false)

    const result = await runDocumentCheckSlice(ORG, start, attempt)

    expect(result.done).toBe(true)
    expect(unaskedSpendAllowed).toHaveBeenCalledWith(session, 'p1')
    expect(resolveTurnContext).not.toHaveBeenCalled()
    expect(runHeadlessTurn).not.toHaveBeenCalled()
  })

  it('ends and erases its conversation when the budget is spent', async () => {
    vi.mocked(resolveTurnContext).mockRejectedValue(new TurnBudgetExhaustedError('person'))

    const result = await runDocumentCheckSlice(ORG, start, attempt)

    expect(result.done).toBe(true)
    expect(runHeadlessTurn).not.toHaveBeenCalled()
    expect(deleteConversationInOrg).toHaveBeenCalledWith(CONVERSATION, ORG)
  })

  it('retries when the chat service is not reachable, and gives up on the last attempt', async () => {
    vi.mocked(runHeadlessTurn).mockResolvedValue({ kind: 'unavailable', reason: 'no answer in time' })

    await expect(runDocumentCheckSlice(ORG, start, attempt)).rejects.toThrow('not reachable')
    const last = await runDocumentCheckSlice(ORG, start, { last: true })

    expect(last.done).toBe(true)
    expect(deleteConversationInOrg).toHaveBeenCalledWith(CONVERSATION, ORG)
  })

  it('ends and erases when admission refuses the turn', async () => {
    vi.mocked(runHeadlessTurn).mockResolvedValue({ kind: 'refused', reason: 'budget' })

    const result = await runDocumentCheckSlice(ORG, start, attempt)

    expect(result.done).toBe(true)
    expect(deleteConversationInOrg).toHaveBeenCalled()
  })
})

describe('runDocumentCheckSlice — waiting for the answer', () => {
  it('waits while the turn has not answered, and gives up after the longest wait', async () => {
    vi.mocked(findMessageInConversation).mockResolvedValue(null)

    const waits = await runDocumentCheckSlice(ORG, waiting, attempt)
    expect(waits).toMatchObject({ done: false, payload: { waits: 1 } })

    const gaveUp = await runDocumentCheckSlice(ORG, { ...waiting, waits: 60 }, attempt)
    expect(gaveUp.done).toBe(true)
    expect(deleteConversationInOrg).toHaveBeenCalledWith(CONVERSATION, ORG)
    expect(emitInboxItems).not.toHaveBeenCalled()
  })

  it('leaves nothing when everything agrees: no message, no inbox row, the conversation erased, the score 0', async () => {
    const result = await runDocumentCheckSlice(ORG, waiting, attempt)

    expect(result.done).toBe(true)
    expect(deleteConversationInOrg).toHaveBeenCalledWith(CONVERSATION, ORG)
    expect(insertMessages).not.toHaveBeenCalled()
    expect(emitInboxItems).not.toHaveBeenCalled()
    expect(recordDocumentCheckScore).toHaveBeenCalledWith({ checkId: CHECK_ID, traceId: TRACE, findings: 0 })
  })

  it('does not count a mark that was undone or is not a creation', async () => {
    vi.mocked(listTurnChangeRows).mockResolvedValue([
      change('a1', { undoneAt: new Date() }),
      change('a2', { op: 'update' }),
      change('a3', { objectKind: 'annotation_reply' }),
    ])

    await runDocumentCheckSlice(ORG, waiting, attempt)

    expect(emitInboxItems).not.toHaveBeenCalled()
    expect(recordDocumentCheckScore).toHaveBeenCalledWith(expect.objectContaining({ findings: 0 }))
  })

  it('leaves one message in the thread about the document and one inbox row on the first mark when it found something', async () => {
    vi.mocked(listTurnChangeRows).mockResolvedValue([change('a2'), change('a1')])
    vi.mocked(listDocumentAnnotations).mockResolvedValue([
      mark('a1', 4, 'Das Konzept nennt 11 Wohnungen, der Einreichplan Index B zeigt 10.'),
      mark('a2', 2, 'Gebäudeklasse 4 im Konzept, GK 3 im Einreichplan.'),
      mark('a3', 1, 'a mark of someone else'),
    ])

    const result = await runDocumentCheckSlice(ORG, waiting, attempt)

    expect(result.done).toBe(true)
    expect(deleteConversationInOrg).not.toHaveBeenCalled()
    expect(insertMessages).toHaveBeenCalledTimes(1)
    const [[message]] = vi.mocked(insertMessages).mock.calls[0]
    expect(message).toMatchObject({
      id: documentCheckMessageId(CHECK_ID),
      conversationId: 's_thread',
      role: 'assistant',
      metadata: { trace_id: TRACE, documentCheck: { checkId: CHECK_ID } },
    })
    expect(message.content).toContain('2 Stellen sind')
    expect(message.content).toContain('11 Wohnungen')
    expect(message.content.indexOf('Gebäudeklasse')).toBeLessThan(message.content.indexOf('11 Wohnungen'))
    expect(emitInboxItems).toHaveBeenCalledTimes(1)
    expect(vi.mocked(emitInboxItems).mock.calls[0][0][0]).toMatchObject({
      type: 'piloti.revision_checked',
      recipientUserId: 'uploader',
      resourceId: DOC_ID,
      anchorId: 'a2',
      payload: { variant: 'check_many', openMarks: 2 },
    })
    expect(recordDocumentCheckScore).toHaveBeenCalledWith({ checkId: CHECK_ID, traceId: TRACE, findings: 2 })
  })

  it('never throws on its last attempt for a write that failed, and retries before', async () => {
    vi.mocked(listTurnChangeRows).mockRejectedValue(new Error('db down'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(runDocumentCheckSlice(ORG, waiting, attempt)).rejects.toThrow('db down')
    await expect(runDocumentCheckSlice(ORG, waiting, { last: true })).resolves.toMatchObject({ done: true })
  })
})

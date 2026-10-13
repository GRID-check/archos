/**
 * @vitest-environment node
 */
/**
 * The `piloti_wake` job (ADR-0106): it asks everything again as the person
 * whose act woke Piloti, then opens the chat socket as them and sends one
 * `user_message`. Pinned here: the message the contract names
 * (`docs/api/websocket-protocol.md`, „A turn an event woke"), the signed
 * envelope with the person's thread inside it, the headless header, a busy
 * thread waiting without spending an attempt, `duplicate_turn` as done, and
 * every way a wake ends without a turn recorded on its row.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/pinned-session', () => ({ resolvePinnedRequesterSession: vi.fn() }))
vi.mock('@/lib/documents/access', () => ({ getAccessibleDocument: vi.fn() }))
vi.mock('@/lib/db', () => ({ getDb: vi.fn(() => ({ handle: 'db' })) }))
vi.mock('@/lib/conversations/repository', () => ({ insertMessages: vi.fn() }))
vi.mock('@/lib/sharing/directory', () => ({ loadOrganizationDirectory: vi.fn() }))
vi.mock('@/lib/audit/service', () => ({ recordAuditEvent: vi.fn() }))
vi.mock('@/lib/jobs-queue/enqueue', () => ({ enqueueJob: vi.fn() }))
vi.mock('./document-thread', () => ({ ensureDocumentThread: vi.fn() }))
vi.mock('./repository', () => ({ findDocumentAnnotation: vi.fn() }))
vi.mock('./wake-repository', () => ({ findWake: vi.fn(), settleWake: vi.fn(), countWakes: vi.fn(), insertWake: vi.fn() }))
vi.mock('@/lib/turns/headless-turn', () => ({ runHeadlessTurn: vi.fn(), chatSocketUrl: vi.fn(() => 'ws://aiq-agent:8000/websocket') }))
vi.mock('@/lib/turns/turn-context', async () => {
  const actual = await vi.importActual<typeof import('@/lib/turns/turn-context')>('@/lib/turns/turn-context')
  return { ...actual, resolveTurnContext: vi.fn() }
})

import { ForbiddenError } from '@/lib/api/errors'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import type { AuthorizedSession } from '@/lib/auth/types'
import { recordAuditEvent } from '@/lib/audit/service'
import { insertMessages } from '@/lib/conversations/repository'
import type { Document, PilotiWakeRow } from '@/lib/db/schema'
import { getAccessibleDocument } from '@/lib/documents/access'
import type { PilotiWakePayload } from '@/lib/jobs-queue/types'
import { verifyGridRequestContextEnvelope } from '@/lib/request-context'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { runHeadlessTurn, type HeadlessTurnRequest } from '@/lib/turns/headless-turn'
import { resolveTurnContext, TurnBudgetExhaustedError } from '@/lib/turns/turn-context'
import { ensureDocumentThread } from './document-thread'
import { findDocumentAnnotation, type AnnotationRecord } from './repository'
import { MAX_WAKE_WAITS, runPilotiWake, waitAfter, WAKE_REQUIRES } from './wake-job'
import { countWakes, findWake, settleWake } from './wake-repository'
import { documentThreadConversationId, wakeTurnId } from './wake-ids'

const SECRET = 'wake-secret'
const DOC_ID = '11111111-1111-4111-8111-111111111111'
const MARK_ID = '22222222-2222-4222-8222-222222222222'
const REPLY_ID = '33333333-3333-4333-8333-333333333333'
const WAKE_ID = wakeTurnId(REPLY_ID)
const THREAD = documentThreadConversationId(DOC_ID, 'user_anna')

const PAYLOAD: PilotiWakePayload = {
  wakeId: WAKE_ID,
  trigger: 'thread_mention',
  eventId: REPLY_ID,
  documentId: DOC_ID,
  annotationId: MARK_ID,
  actor: { userId: 'user_anna', email: 'anna@example.at' },
  waits: 0,
}

const SESSION: AuthorizedSession = {
  userId: 'user_anna',
  email: 'anna@example.at',
  name: null,
  accessToken: '',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
  featureFlags: ['piloti-wakes'],
}

const DOC = { id: DOC_ID, scope: 'project', projectId: 'proj_1', filename: 'grundriss.pdf', displayName: 'Grundriss EG' } as Partial<Document> as Document

const MARK = {
  id: MARK_ID,
  number: 4,
  page: 2,
  shape: 'region',
  x: 0.1,
  y: 0.2,
  w: 0.3,
  h: 0.25,
  body: 'Türbreite prüfen',
  replies: [{ id: REPLY_ID, body: '  Stimmt die Breite?  ' }],
} as Partial<AnnotationRecord> as AnnotationRecord

const WAKE = { id: WAKE_ID, status: 'queued', createdAt: new Date('2026-10-13T10:00:00Z') } as Partial<PilotiWakeRow> as PilotiWakeRow

const NOT_LAST = { last: false }

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('REQUIRE_AUTH', 'true')
  vi.stubEnv('GRID_INTERNAL_API_TOKEN', SECRET)
  vi.mocked(findWake).mockResolvedValue(WAKE)
  vi.mocked(settleWake).mockResolvedValue(true)
  vi.mocked(countWakes).mockResolvedValue(0)
  vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(SESSION)
  vi.mocked(getAccessibleDocument).mockResolvedValue(DOC)
  vi.mocked(findDocumentAnnotation).mockResolvedValue(MARK)
  vi.mocked(loadOrganizationDirectory).mockResolvedValue(
    new Map([['user_anna', { userId: 'user_anna', email: 'anna@example.at', name: 'Anna Berger', profilePictureUrl: null }]])
  )
  vi.mocked(ensureDocumentThread).mockResolvedValue(THREAD)
  vi.mocked(resolveTurnContext).mockResolvedValue({
    scope: ['oib_knowledge', 'proj_1'],
    scopedCollections: [],
    header: 'c2NvcGU',
    conversationId: THREAD,
    organizationId: 'org_1',
    userId: 'user_anna',
    accessToken: '',
    projectId: 'proj_1',
    memoryReflectionEnabled: false,
  })
  vi.mocked(runHeadlessTurn).mockResolvedValue({ kind: 'started' })
})

afterEach(() => {
  vi.unstubAllEnvs()
})

const sentRequest = (): HeadlessTurnRequest => vi.mocked(runHeadlessTurn).mock.calls[0][0]

describe('a wake that runs', () => {
  it('sends the user_message the contract names, as the person, in their thread', async () => {
    await expect(runPilotiWake('org_1', PAYLOAD, NOT_LAST)).resolves.toEqual({ done: true, payload: PAYLOAD })

    const request = sentRequest()
    expect(request.url).toBe('ws://aiq-agent:8000/websocket')
    expect(request.conversationId).toBe(THREAD)
    expect(request.requires).toEqual(WAKE_REQUIRES)
    expect(request.message).toEqual({
      type: 'user_message',
      conversation_id: THREAD,
      message_id: WAKE_ID,
      text: 'Stimmt die Breite?',
      author_name: 'Anna Berger',
      focus_file_name: 'Grundriss EG',
      focus_shelf: 'project',
      focus_document_id: DOC_ID,
      focus_region: { page: 2, x: 0.1, y: 0.2, w: 0.3, h: 0.25, annotation_id: MARK_ID },
      reply_in_thread: true,
      trigger: { kind: 'thread_mention', event_id: REPLY_ID, annotation_id: MARK_ID },
      if_idle: true,
      reasoning_effort: 'low',
    })
    expect(settleWake).toHaveBeenCalledWith('org_1', WAKE_ID, { status: 'started' })
  })

  it('opens the socket headless, with the signed envelope naming the person and their thread', async () => {
    await runPilotiWake('org_1', PAYLOAD, NOT_LAST)

    const { headers } = sentRequest()
    expect(headers['x-aiq-mode']).toBe('headless')
    expect(headers['x-grid-user-id']).toBe('user_anna')
    // No browser cookie and no bearer: the backend reads an internal caller and trusts the envelope.
    expect(headers).not.toHaveProperty('authorization')
    const envelope = verifyGridRequestContextEnvelope(
      headers['x-grid-request-context'],
      headers['x-grid-request-context-sig'],
      SECRET
    )
    expect(envelope).toMatchObject({ organizationId: 'org_1', userId: 'user_anna', projectId: 'proj_1', conversationId: THREAD })
    // The turn's context is resolved for the person's pinned session and THAT thread.
    expect(resolveTurnContext).toHaveBeenCalledWith(SESSION, { projectId: 'proj_1', conversationId: THREAD })
  })

  it('writes the trigger into the thread once, under the turn id: who, which mark, what they wrote', async () => {
    await runPilotiWake('org_1', PAYLOAD, NOT_LAST)

    expect(insertMessages).toHaveBeenCalledWith([
      expect.objectContaining({
        id: WAKE_ID,
        conversationId: THREAD,
        role: 'user',
        authorUserId: 'user_anna',
        content: 'Anna Berger in Anmerkung 4: „Stimmt die Breite?“',
        metadata: expect.objectContaining({
          trigger: expect.objectContaining({ kind: 'thread_mention', annotationId: MARK_ID, annotationNumber: 4 }),
        }),
      }),
    ])
  })

  it('asks a delegated mark with what the mark says', async () => {
    await runPilotiWake('org_1', { ...PAYLOAD, trigger: 'assigned', eventId: 'delegation-1' }, NOT_LAST)

    expect(sentRequest().message).toMatchObject({
      text: 'Türbreite prüfen',
      trigger: { kind: 'assigned', event_id: 'delegation-1', annotation_id: MARK_ID },
    })
  })
})

describe('what the socket answers', () => {
  it('busy: waits without spending an attempt, longer each time, under the same id', async () => {
    vi.mocked(runHeadlessTurn).mockResolvedValue({ kind: 'busy' })
    const before = Date.now()

    const result = await runPilotiWake('org_1', PAYLOAD, NOT_LAST)

    expect(result.done).toBe(false)
    expect(result.payload).toEqual({ ...PAYLOAD, waits: 1 })
    expect(result.notBefore?.getTime()).toBeGreaterThanOrEqual(before + waitAfter(0))
    expect(waitAfter(3)).toBeGreaterThan(waitAfter(0))
    expect(settleWake).not.toHaveBeenCalled()
  })

  it('busy past the last wait: gives up, and says so on the row', async () => {
    vi.mocked(runHeadlessTurn).mockResolvedValue({ kind: 'busy' })

    const result = await runPilotiWake('org_1', { ...PAYLOAD, waits: MAX_WAKE_WAITS }, NOT_LAST)

    expect(result.done).toBe(true)
    expect(settleWake).toHaveBeenCalledWith('org_1', WAKE_ID, { status: 'failed', reason: expect.stringMatching(/^gave up waiting/) })
  })

  it('duplicate_turn: that turn ran or runs, the wake is done', async () => {
    vi.mocked(runHeadlessTurn).mockResolvedValue({ kind: 'duplicate' })

    await expect(runPilotiWake('org_1', PAYLOAD, NOT_LAST)).resolves.toMatchObject({ done: true })
    expect(settleWake).toHaveBeenCalledWith('org_1', WAKE_ID, { status: 'started' })
  })

  it('a refused turn is recorded as refused, with the reason, in the audit trail too', async () => {
    vi.mocked(runHeadlessTurn).mockResolvedValue({ kind: 'refused', reason: 'Budget erschöpft.' })

    await expect(runPilotiWake('org_1', PAYLOAD, NOT_LAST)).resolves.toMatchObject({ done: true })
    expect(settleWake).toHaveBeenCalledWith('org_1', WAKE_ID, { status: 'refused', reason: 'Budget erschöpft.' })
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'piloti.wake.suppressed', metadata: expect.objectContaining({ status: 'refused', stage: 'claim' }) })
    )
  })

  it('a rejected envelope is retried by the queue, and recorded on the last attempt', async () => {
    vi.mocked(runHeadlessTurn).mockResolvedValue({ kind: 'rejected', code: 'auth_expired', message: null })

    await expect(runPilotiWake('org_1', PAYLOAD, NOT_LAST)).rejects.toThrow(/auth_expired/)
    expect(settleWake).not.toHaveBeenCalled()

    await expect(runPilotiWake('org_1', PAYLOAD, { last: true })).resolves.toMatchObject({ done: true })
    expect(settleWake).toHaveBeenCalledWith('org_1', WAKE_ID, { status: 'failed', reason: 'rejected: auth_expired' })
  })
})

describe('asked again when the job runs', () => {
  it('the person’s spent budget refuses the wake before any socket opens', async () => {
    vi.mocked(resolveTurnContext).mockRejectedValue(new TurnBudgetExhaustedError('user'))

    await expect(runPilotiWake('org_1', PAYLOAD, NOT_LAST)).resolves.toMatchObject({ done: true })
    expect(runHeadlessTurn).not.toHaveBeenCalled()
    expect(settleWake).toHaveBeenCalledWith('org_1', WAKE_ID, { status: 'refused', reason: expect.stringMatching(/^budget: /) })
  })

  it('a person who may no longer write the document wakes nothing', async () => {
    vi.mocked(getAccessibleDocument).mockRejectedValue(new ForbiddenError())

    await runPilotiWake('org_1', PAYLOAD, NOT_LAST)
    expect(runHeadlessTurn).not.toHaveBeenCalled()
    expect(settleWake).toHaveBeenCalledWith('org_1', WAKE_ID, { status: 'suppressed', reason: expect.stringMatching(/write/) })
  })

  it('a person who left, or a switch turned off since, wakes nothing', async () => {
    vi.mocked(resolvePinnedRequesterSession).mockResolvedValueOnce(null)
    await runPilotiWake('org_1', PAYLOAD, NOT_LAST)
    vi.mocked(resolvePinnedRequesterSession).mockResolvedValueOnce({ ...SESSION, featureFlags: [] })
    await runPilotiWake('org_1', PAYLOAD, NOT_LAST)

    expect(runHeadlessTurn).not.toHaveBeenCalled()
    expect(vi.mocked(settleWake).mock.calls.map((call) => call[2])).toEqual([
      { status: 'suppressed', reason: 'the person is no longer a member' },
      { status: 'suppressed', reason: 'piloti-wakes is off for the organization' },
    ])
  })

  it('the caps hold at claim too, counting only the wakes recorded ahead of this one', async () => {
    vi.mocked(countWakes).mockImplementation(async (_db, query) => (query.actorUserId ? 50 : 0))

    await runPilotiWake('org_1', PAYLOAD, NOT_LAST)

    expect(runHeadlessTurn).not.toHaveBeenCalled()
    expect(settleWake).toHaveBeenCalledWith('org_1', WAKE_ID, { status: 'suppressed', reason: 'cap:person-day' })
    expect(countWakes).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ before: { createdAt: WAKE.createdAt, id: WAKE_ID } })
    )
  })

  it('a wake already settled by an earlier run does nothing', async () => {
    vi.mocked(findWake).mockResolvedValue({ ...WAKE, status: 'started' })

    await expect(runPilotiWake('org_1', PAYLOAD, NOT_LAST)).resolves.toEqual({ done: true, payload: PAYLOAD })
    expect(resolvePinnedRequesterSession).not.toHaveBeenCalled()
    expect(runHeadlessTurn).not.toHaveBeenCalled()
  })
})

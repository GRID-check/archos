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
vi.mock('./wake-repository', () => ({
  findWake: vi.fn(),
  settleWake: vi.fn(),
  countWakes: vi.fn(),
  insertWake: vi.fn(),
  handBackDelegation: vi.fn(),
}))
vi.mock('./attention', () => ({ onWakeEnded: vi.fn() }))
vi.mock('@/lib/realtime/document-channel', () => ({ publishToDocumentRoom: vi.fn() }))
vi.mock('@/lib/db/tenant-context', () => ({ withTenant: vi.fn((_scope: unknown, fn: () => unknown) => fn()) }))
vi.mock('@/lib/turns/headless-turn', () => ({ runHeadlessTurn: vi.fn(), chatSocketUrl: vi.fn(() => 'ws://aiq-agent:8000/websocket') }))
vi.mock('@/lib/turns/turn-context', async () => {
  const actual = await vi.importActual<typeof import('@/lib/turns/turn-context')>('@/lib/turns/turn-context')
  return { ...actual, resolveTurnContext: vi.fn() }
})

import { ForbiddenError } from '@/lib/api/errors'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import type { AuthorizedSession } from '@/lib/auth/types'
import { recordAuditEvent } from '@/lib/audit/service'
import { expectRegistered } from '@/test-utils/audit'
import { insertMessages } from '@/lib/conversations/repository'
import type { Document, PilotiWakeRow } from '@/lib/db/schema'
import { getAccessibleDocument } from '@/lib/documents/access'
import type { PilotiWakePayload } from '@/lib/jobs-queue/types'
import { verifyGridRequestContextEnvelope } from '@/lib/request-context'
import { loadOrganizationDirectory } from '@/lib/sharing/directory'
import { runHeadlessTurn, type HeadlessTurnRequest } from '@/lib/turns/headless-turn'
import { resolveTurnContext, TurnBudgetExhaustedError } from '@/lib/turns/turn-context'
import { publishToDocumentRoom } from '@/lib/realtime/document-channel'
import { onWakeEnded } from './attention'
import { ensureDocumentThread } from './document-thread'
import { findDocumentAnnotation, type AnnotationRecord } from './repository'
import { MAX_WAKE_WAITS, runPilotiWake, waitAfter, WAKE_REQUIRES } from './wake-job'
import { countWakes, findWake, handBackDelegation, settleWake } from './wake-repository'
import { delegationEventId, documentThreadConversationId, wakeTurnId } from './wake-ids'

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
  // The pinned session knows the person by name (`resolvePerson`).
  name: 'Anna Berger',
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
  vi.mocked(handBackDelegation).mockResolvedValue(true)
  vi.mocked(publishToDocumentRoom).mockResolvedValue(undefined)
  vi.mocked(onWakeEnded).mockResolvedValue(undefined)
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
    const delegatedAt = new Date('2026-10-13T09:59:00Z')
    const eventId = delegationEventId(MARK_ID, delegatedAt)
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, delegatedBy: 'user_1', delegatedAt })
    await runPilotiWake('org_1', { ...PAYLOAD, trigger: 'assigned', eventId }, NOT_LAST)

    expect(sentRequest().message).toMatchObject({
      text: 'Türbreite prüfen',
      trigger: { kind: 'assigned', event_id: eventId, annotation_id: MARK_ID },
    })
  })

  it('runs no turn for a delegation taken back (or delegated anew) since it was queued', async () => {
    const queuedFor = delegationEventId(MARK_ID, new Date('2026-10-13T09:59:00Z'))
    for (const now of [
      { delegatedBy: null, delegatedAt: null },
      { delegatedBy: 'user_2', delegatedAt: new Date('2026-10-13T10:05:00Z') },
    ]) {
      vi.mocked(runHeadlessTurn).mockClear()
      vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, ...now })
      await runPilotiWake('org_1', { ...PAYLOAD, trigger: 'assigned', eventId: queuedFor }, NOT_LAST)
      expect(runHeadlessTurn).not.toHaveBeenCalled()
      expect(settleWake).toHaveBeenLastCalledWith('org_1', WAKE_ID, { status: 'suppressed', reason: 'taken back' })
    }
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
      expect.objectContaining({ action: 'piloti.wake.ended', metadata: expect.objectContaining({ outcome: 'refused' }) })
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

  it('a suppressed wake tells nobody: the person’s own act, a rule or a cap held it', async () => {
    vi.mocked(getAccessibleDocument).mockRejectedValue(new ForbiddenError())

    await runPilotiWake('org_1', PAYLOAD, NOT_LAST)
    expect(onWakeEnded).not.toHaveBeenCalled()
    expect(handBackDelegation).not.toHaveBeenCalled()
  })

  it('a wake already settled by an earlier run does nothing', async () => {
    vi.mocked(findWake).mockResolvedValue({ ...WAKE, status: 'started' })

    await expect(runPilotiWake('org_1', PAYLOAD, NOT_LAST)).resolves.toEqual({ done: true, payload: PAYLOAD })
    expect(resolvePinnedRequesterSession).not.toHaveBeenCalled()
    expect(runHeadlessTurn).not.toHaveBeenCalled()
  })
})

describe('the audit trail of a wake that started', () => {
  const started = () => vi.mocked(recordAuditEvent).mock.calls.filter(([input]) => input.action === 'piloti.wake.started')
  // Whatever was emitted, WorkOS would accept: every target type and key is registered.
  afterEach(() => {
    for (const [input] of vi.mocked(recordAuditEvent).mock.calls) expectRegistered(input)
  })

  it('records the start once, as the person whose act woke Piloti, on the mark, its document, project and thread', async () => {
    await runPilotiWake('org_1', { ...PAYLOAD, waits: 2 }, NOT_LAST)

    expect(recordAuditEvent).toHaveBeenCalledTimes(1)
    expect(started()[0][0]).toEqual({
      action: 'piloti.wake.started',
      organizationId: 'org_1',
      actor: { userId: 'user_anna', email: 'anna@example.at' },
      targetType: 'document_annotation',
      targetId: MARK_ID,
      alsoTargets: [
        { type: 'document', id: DOC_ID },
        { type: 'project', id: 'proj_1' },
        { type: 'conversation', id: THREAD },
      ],
      metadata: { trigger: 'thread_mention', wakeId: WAKE_ID, markNumber: 4, waits: 2 },
    })
  })

  it('records nothing when another run, or the turn’s own end, settled the wake first', async () => {
    vi.mocked(settleWake).mockResolvedValue(false)
    await runPilotiWake('org_1', PAYLOAD, NOT_LAST)
    vi.mocked(runHeadlessTurn).mockResolvedValue({ kind: 'duplicate' })
    await runPilotiWake('org_1', PAYLOAD, NOT_LAST)

    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('records nothing for a busy thread: the wake has not started', async () => {
    vi.mocked(runHeadlessTurn).mockResolvedValue({ kind: 'busy' })
    await runPilotiWake('org_1', PAYLOAD, NOT_LAST)

    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('is done when the trail fails', async () => {
    vi.mocked(recordAuditEvent).mockRejectedValueOnce(new Error('WorkOS down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(runPilotiWake('org_1', PAYLOAD, NOT_LAST)).resolves.toEqual({ done: true, payload: PAYLOAD })
    await vi.waitFor(() => expect(warn).toHaveBeenCalled())
    warn.mockRestore()
  })
})

describe('a wake that ends without an answer', () => {
  const DELEGATED_AT = new Date('2026-10-13T09:59:00Z')
  const DELEGATION = { ...PAYLOAD, trigger: 'assigned' as const, eventId: delegationEventId(MARK_ID, DELEGATED_AT) }

  it('tells the person who woke Piloti why, with the mark it was about', async () => {
    vi.mocked(resolveTurnContext).mockRejectedValue(new TurnBudgetExhaustedError('user'))

    await runPilotiWake('org_1', PAYLOAD, NOT_LAST)

    expect(onWakeEnded).toHaveBeenCalledTimes(1)
    expect(onWakeEnded).toHaveBeenCalledWith({
      organizationId: 'org_1',
      documentId: DOC_ID,
      annotationId: MARK_ID,
      annotationNumber: 4,
      projectId: 'proj_1',
      actorUserId: 'user_anna',
      trigger: 'thread_mention',
      outcome: 'failed',
      reason: expect.stringMatching(/^budget: /),
      markText: 'Türbreite prüfen',
    })
  })

  it.each([
    ['a refusal', { kind: 'refused', reason: 'The assistant is busy right now. Please send your message again in a moment.' }, 0],
    ['a give-up', { kind: 'busy' }, MAX_WAKE_WAITS],
  ] as const)('tells after %s too', async (_case, outcome, waits) => {
    vi.mocked(runHeadlessTurn).mockResolvedValue(outcome)

    await runPilotiWake('org_1', { ...PAYLOAD, waits }, NOT_LAST)

    expect(onWakeEnded).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'failed', reason: expect.any(String) }))
  })

  it('hands a delegated mark back, so it stops reading „Piloti arbeitet daran“', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, delegatedBy: 'user_anna', delegatedAt: DELEGATED_AT })
    vi.mocked(resolveTurnContext).mockRejectedValue(new TurnBudgetExhaustedError('user'))

    await runPilotiWake('org_1', DELEGATION, NOT_LAST)

    expect(handBackDelegation).toHaveBeenCalledWith(expect.anything(), 'org_1', MARK_ID, DELEGATED_AT)
    expect(publishToDocumentRoom).toHaveBeenCalledWith(
      DOC_ID,
      expect.objectContaining({ kind: 'annotations.changed', annotationIds: [MARK_ID] })
    )
    expect(onWakeEnded).toHaveBeenCalledWith(expect.objectContaining({ trigger: 'assigned', outcome: 'failed' }))
  })

  it('hands nothing back for a mention, and still tells when the hand-back fails', async () => {
    vi.mocked(resolveTurnContext).mockRejectedValue(new TurnBudgetExhaustedError('user'))
    await runPilotiWake('org_1', PAYLOAD, NOT_LAST)
    expect(handBackDelegation).not.toHaveBeenCalled()

    vi.mocked(onWakeEnded).mockClear()
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, delegatedBy: 'user_anna', delegatedAt: DELEGATED_AT })
    vi.mocked(handBackDelegation).mockRejectedValue(new Error('database down'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(runPilotiWake('org_1', DELEGATION, NOT_LAST)).resolves.toMatchObject({ done: true })
    expect(onWakeEnded).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalled()
    log.mockRestore()
  })

  it('tells nobody when another end settled the wake first', async () => {
    vi.mocked(settleWake).mockResolvedValue(false)
    vi.mocked(resolveTurnContext).mockRejectedValue(new TurnBudgetExhaustedError('user'))

    await runPilotiWake('org_1', PAYLOAD, NOT_LAST)

    expect(onWakeEnded).not.toHaveBeenCalled()
  })
})

describe('the audit trail of a wake the job ended', () => {
  const DELEGATED_AT = new Date('2026-10-13T09:59:00Z')
  const DELEGATION = { ...PAYLOAD, trigger: 'assigned' as const, eventId: delegationEventId(MARK_ID, DELEGATED_AT) }
  const audited = () => vi.mocked(recordAuditEvent).mock.calls.map(([input]) => input)
  afterEach(() => {
    for (const [input] of vi.mocked(recordAuditEvent).mock.calls) expectRegistered(input)
  })

  it('records a refusal once as piloti.wake.ended, like a turn’s end, with the class of its reason', async () => {
    vi.mocked(resolveTurnContext).mockRejectedValue(new TurnBudgetExhaustedError('user'))

    await runPilotiWake('org_1', PAYLOAD, NOT_LAST)

    expect(audited()).toEqual([
      {
        action: 'piloti.wake.ended',
        organizationId: 'org_1',
        actor: { userId: 'user_anna', email: 'anna@example.at' },
        targetType: 'document_annotation',
        targetId: MARK_ID,
        alsoTargets: [
          { type: 'document', id: DOC_ID },
          { type: 'project', id: 'proj_1' },
          { type: 'conversation', id: THREAD },
        ],
        metadata: {
          trigger: 'thread_mention',
          wakeId: WAKE_ID,
          outcome: 'refused',
          turnOutcome: null,
          reason: expect.stringMatching(/^budget: /),
          reasonKind: 'budget',
          handedBack: false,
          markNumber: 4,
        },
      },
    ])
  })

  it.each([
    ['a give-up', { kind: 'busy' }, MAX_WAKE_WAITS, 'failed', 'busy'],
    ['a refusal at the socket', { kind: 'refused', reason: 'Send your message again in a moment.' }, 0, 'refused', 'busy'],
    ['a rejected message', { kind: 'rejected', code: 'bad_request', message: null }, 0, 'failed', 'error'],
  ] as const)('records %s with its outcome and class', async (_case, outcome, waits, recorded, reasonKind) => {
    vi.mocked(runHeadlessTurn).mockResolvedValue(outcome)

    await runPilotiWake('org_1', { ...PAYLOAD, waits }, NOT_LAST)

    expect(audited()).toHaveLength(1)
    expect(audited()[0]).toMatchObject({ action: 'piloti.wake.ended', metadata: { outcome: recorded, reasonKind } })
  })

  it('says the delegation went back with it, and not when the hand-back failed', async () => {
    vi.mocked(findDocumentAnnotation).mockResolvedValue({ ...MARK, delegatedBy: 'user_anna', delegatedAt: DELEGATED_AT })
    vi.mocked(resolveTurnContext).mockRejectedValue(new TurnBudgetExhaustedError('user'))
    await runPilotiWake('org_1', DELEGATION, NOT_LAST)
    expect(audited()[0].metadata).toMatchObject({ trigger: 'assigned', handedBack: true })

    vi.mocked(recordAuditEvent).mockClear()
    vi.mocked(handBackDelegation).mockRejectedValue(new Error('database down'))
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await runPilotiWake('org_1', DELEGATION, NOT_LAST)
    log.mockRestore()
    expect(audited()).toHaveLength(1)
    expect(audited()[0].metadata).toMatchObject({ handedBack: false })
  })

  it('records nothing when another end settled the wake first', async () => {
    vi.mocked(settleWake).mockResolvedValue(false)
    vi.mocked(resolveTurnContext).mockRejectedValue(new TurnBudgetExhaustedError('user'))

    await runPilotiWake('org_1', PAYLOAD, NOT_LAST)

    expect(recordAuditEvent).not.toHaveBeenCalled()
  })

  it('keeps piloti.wake.suppressed for a wake held before Piloti was asked', async () => {
    vi.mocked(getAccessibleDocument).mockRejectedValue(new ForbiddenError())

    await runPilotiWake('org_1', PAYLOAD, NOT_LAST)

    expect(audited().map((input) => input.action)).toEqual(['piloti.wake.suppressed'])
    expect(audited()[0].metadata).toMatchObject({ status: 'suppressed', stage: 'claim' })
  })

  it('looks the person’s email up when the wake carries none, and names the id alone when nobody knows it', async () => {
    vi.mocked(resolveTurnContext).mockRejectedValue(new TurnBudgetExhaustedError('user'))
    const anonymous = { ...PAYLOAD, actor: { userId: 'user_anna', email: null } }

    await runPilotiWake('org_1', anonymous, NOT_LAST)
    await vi.waitFor(() => expect(recordAuditEvent).toHaveBeenCalledTimes(1))
    expect(audited()[0].actor).toEqual({ userId: 'user_anna', email: 'anna@example.at' })

    vi.mocked(recordAuditEvent).mockClear()
    vi.mocked(loadOrganizationDirectory).mockResolvedValue(new Map())
    await runPilotiWake('org_1', anonymous, NOT_LAST)
    await vi.waitFor(() => expect(recordAuditEvent).toHaveBeenCalledTimes(1))
    expect(audited()[0].actor).toEqual({ userId: 'user_anna', email: null })
  })
})

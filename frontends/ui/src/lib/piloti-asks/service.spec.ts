/**
 * @vitest-environment node
 */
/**
 * An agent asks Piloti (ADR-0122). Pinned here: the switch; the thread (a new
 * private one, or one an earlier ask of the same person started, never another
 * conversation); the question written under the ask's id; the headless turn
 * with the `agent_consult` trigger, `if_idle` and the signed envelope; every way
 * an ask ends without a turn; the wait for the turn's outcome; the answer read by
 * the id the agent derives; only the asker reads or stops an ask; and how a
 * turn's outcome ends its ask.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/authz/projects', () => ({ requireProjectAccess: vi.fn() }))
vi.mock('@/lib/conversations/repository', () => ({
  findConversationInOrg: vi.fn(),
  findMessageInConversation: vi.fn(),
  insertConversation: vi.fn(),
  insertMessages: vi.fn(),
}))
vi.mock('@/lib/db/tenant-context', () => ({
  withPlatformAccess: vi.fn((_why: string, fn: () => unknown) => fn()),
  withTenant: vi.fn((_scope: unknown, fn: () => unknown) => fn()),
}))
vi.mock('./repository', () => ({
  endAsk: vi.fn(),
  findAsk: vi.fn(),
  findAskById: vi.fn(),
  hasAskedInConversation: vi.fn(),
  insertAsk: vi.fn(),
  listAskDocuments: vi.fn(async () => []),
  markAskWorking: vi.fn(),
}))
vi.mock('@/lib/turns/headless-turn', () => ({
  runHeadlessTurn: vi.fn(),
  cancelHeadlessTurn: vi.fn(),
  chatSocketUrl: vi.fn(() => 'ws://aiq-agent:8000/websocket'),
}))
vi.mock('@/lib/turns/turn-context', async () => {
  const actual = await vi.importActual<typeof import('@/lib/turns/turn-context')>('@/lib/turns/turn-context')
  return { ...actual, resolveTurnContext: vi.fn() }
})

import { ConflictError, ForbiddenError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { requireProjectAccess } from '@/lib/authz/projects'
import {
  findConversationInOrg,
  findMessageInConversation,
  insertConversation,
  insertMessages,
} from '@/lib/conversations/repository'
import type { Conversation, Message, PilotiAskRow } from '@/lib/db/schema'
import { verifyGridRequestContextEnvelope } from '@/lib/request-context'
import { cancelHeadlessTurn, runHeadlessTurn, type HeadlessTurnRequest } from '@/lib/turns/headless-turn'
import { resolveTurnContext, TurnBudgetExhaustedError } from '@/lib/turns/turn-context'
import {
  endAsk,
  findAsk,
  findAskById,
  hasAskedInConversation,
  insertAsk,
  markAskWorking,
} from './repository'
import { ASK_REQUIRES, askAnswerMessageId, askEndOf, askPiloti, cancelAsk, getAsk, recordAskOutcome } from './service'

const SECRET = 'internal-secret'
const ORG = 'org_1'
const USER = 'user_anna'
const PROJECT = '44444444-4444-4444-8444-444444444444'
const THREAD = 's_11111111_1111_4111_8111_111111111111'

const SESSION: AuthorizedSession = {
  userId: USER,
  email: 'anna@example.at',
  name: 'Anna Weber',
  accessToken: '',
  organizationId: ORG,
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
  featureFlags: ['piloti-ask'],
}

let row: PilotiAskRow

const askRow = (over: Partial<PilotiAskRow> = {}): PilotiAskRow => ({
  id: '22222222-2222-4222-8222-222222222222',
  organizationId: ORG,
  conversationId: THREAD,
  requestedBy: USER,
  state: 'submitted',
  reason: null,
  createdAt: new Date('2026-10-21T09:00:00Z'),
  updatedAt: new Date('2026-10-21T09:00:00Z'),
  endedAt: null,
  ...over,
})

const conversation = (over: Partial<Conversation> = {}): Conversation =>
  ({ id: THREAD, organizationId: ORG, createdBy: USER, projectId: null, deletedAt: null, ...over }) as Conversation

const turnRequest = (): HeadlessTurnRequest => vi.mocked(runHeadlessTurn).mock.calls[0]?.[0] as HeadlessTurnRequest

beforeEach(() => {
  vi.clearAllMocks()
  process.env.GRID_INTERNAL_API_TOKEN = SECRET
  process.env.REQUIRE_AUTH = 'true'
  row = askRow()
  vi.mocked(insertAsk).mockImplementation(async (values) => {
    row = askRow({ ...values })
    return row
  })
  vi.mocked(findAsk).mockImplementation(async () => row)
  vi.mocked(markAskWorking).mockImplementation(async () => {
    row = { ...row, state: 'working' }
    return true
  })
  vi.mocked(endAsk).mockImplementation(async (_org, _id, end) => {
    if (row.state !== 'submitted' && row.state !== 'working') return null
    row = { ...row, state: end.state, reason: 'reason' in end ? end.reason : null, endedAt: new Date() }
    return row
  })
  vi.mocked(findConversationInOrg).mockResolvedValue(conversation())
  vi.mocked(findMessageInConversation).mockResolvedValue(null)
  vi.mocked(insertConversation).mockResolvedValue(conversation())
  vi.mocked(insertMessages).mockResolvedValue([])
  vi.mocked(resolveTurnContext).mockImplementation(async (_session, request) => ({
    scope: [],
    scopedCollections: [],
    header: '',
    conversationId: request.conversationId,
    organizationId: ORG,
    userId: USER,
    projectId: request.projectId,
    memoryReflectionEnabled: false,
  }))
  vi.mocked(runHeadlessTurn).mockResolvedValue({ kind: 'started' })
})

afterEach(() => {
  delete process.env.GRID_INTERNAL_API_TOKEN
  delete process.env.REQUIRE_AUTH
})

describe('askAnswerMessageId', () => {
  it('is the id the agent gives its answer (aiq_agent.turn.response.answer_message_id)', () => {
    // Computed by the Python function for the same pair.
    expect(askAnswerMessageId(THREAD, '22222222-2222-4222-8222-222222222222')).toBe('e007c373-c4c5-504d-9558-2d975bb207d1')
  })
})

describe('askPiloti', () => {
  it('is refused without the organization’s switch, before anything is written', async () => {
    const off = { ...SESSION, featureFlags: [] }
    await expect(askPiloti(off, { question: 'Hallo?' })).rejects.toBeInstanceOf(ForbiddenError)
    expect(insertAsk).not.toHaveBeenCalled()
    expect(runHeadlessTurn).not.toHaveBeenCalled()
  })

  it('opens a new private thread of the person, in the project they named, after the project check', async () => {
    await askPiloti(SESSION, { question: 'Welche Fluchtweglänge gilt?', projectId: PROJECT }, { waitMs: 0 })
    expect(requireProjectAccess).toHaveBeenCalledWith(SESSION, PROJECT, ['project:chat', 'project:edit'])
    const created = vi.mocked(insertConversation).mock.calls[0]?.[0]
    expect(created).toMatchObject({ organizationId: ORG, createdBy: USER, projectId: PROJECT, title: 'Welche Fluchtweglänge gilt?' })
    expect(created?.id).toMatch(/^s_[0-9a-f]{8}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{4}_[0-9a-f]{12}$/)
    expect(created?.visibility).toBeUndefined()
  })

  it('writes the question as the person’s message under the ask’s id, which is the turn’s id', async () => {
    await askPiloti(SESSION, { question: 'Welche Fluchtweglänge gilt?' }, { waitMs: 0 })
    const [message] = vi.mocked(insertMessages).mock.calls[0]?.[0] ?? []
    expect(message).toMatchObject({ id: row.id, role: 'user', authorUserId: USER, content: 'Welche Fluchtweglänge gilt?' })
    expect(turnRequest().message.message_id).toBe(row.id)
  })

  it('starts a headless turn as the person, with the agent_consult trigger, if_idle and the signed envelope', async () => {
    await askPiloti(SESSION, { question: 'Welche Fluchtweglänge gilt?' }, { waitMs: 0 })
    const request = turnRequest()
    expect(request.message).toMatchObject({
      type: 'user_message',
      text: 'Welche Fluchtweglänge gilt?',
      author_name: 'Anna Weber',
      trigger: { kind: 'agent_consult', event_id: row.id, annotation_id: null },
      if_idle: true,
    })
    expect(request.requires).toEqual(ASK_REQUIRES)
    expect(request.headers['x-aiq-mode']).toBe('headless')
    const context = verifyGridRequestContextEnvelope(
      request.headers['x-grid-request-context'],
      request.headers['x-grid-request-context-sig'],
      SECRET,
    )
    expect(context).toMatchObject({ userId: USER, organizationId: ORG, conversationId: row.conversationId })
  })

  it('waits for the turn’s outcome and answers with Piloti’s message', async () => {
    vi.mocked(findAsk).mockImplementation(async () => {
      if (row.state === 'working') row = { ...row, state: 'completed', endedAt: new Date() }
      return row
    })
    // The ask's id is minted inside, so the answer's id is derived from the row as it is read.
    vi.mocked(findMessageInConversation).mockImplementation(async (conversationId, id) =>
      id === askAnswerMessageId(conversationId, row.id) ? ({ id, content: 'Höchstens 40 m.' } as Message) : null,
    )
    const view = await askPiloti(SESSION, { question: 'Welche Fluchtweglänge gilt?' }, { waitMs: 5_000 })
    expect(view.state).toBe('completed')
    expect(view.answer).toEqual({ messageId: askAnswerMessageId(row.conversationId, row.id), text: 'Höchstens 40 m.' })
    expect(view.pollAfterSeconds).toBeNull()
  })

  it('answers working past the wait, with when to poll', async () => {
    const view = await askPiloti(SESSION, { question: 'Lang?' }, { waitMs: 0 })
    expect(view.state).toBe('working')
    expect(view.answer).toBeNull()
    expect(view.pollAfterSeconds).toBeGreaterThan(0)
  })

  it('ends rejected, with the reason and without a socket, when the budget is spent', async () => {
    vi.mocked(resolveTurnContext).mockRejectedValue(new TurnBudgetExhaustedError('organization'))
    const view = await askPiloti(SESSION, { question: 'Hallo?' }, { waitMs: 0 })
    expect(view.state).toBe('rejected')
    expect(view.reason).toMatch(/^budget: The organization LLM budget is exhausted/)
    expect(runHeadlessTurn).not.toHaveBeenCalled()
  })

  it.each([
    [{ kind: 'busy' } as const, 'rejected', /still answering/],
    [{ kind: 'refused', reason: 'Budget erschöpft.' } as const, 'rejected', /Budget erschöpft/],
    [{ kind: 'rejected', code: 'invalid_message', message: null } as const, 'failed', /invalid_message/],
    [{ kind: 'unavailable', reason: 'socket failed' } as const, 'failed', /could not be reached/],
  ])('ends an ask whose turn did not start (%o) as %s', async (outcome, state, reason) => {
    vi.mocked(runHeadlessTurn).mockResolvedValue(outcome)
    const view = await askPiloti(SESSION, { question: 'Hallo?' }, { waitMs: 0 })
    expect(view.state).toBe(state)
    expect(view.reason).toMatch(reason)
    expect(markAskWorking).not.toHaveBeenCalled()
  })

  it('continues a conversation an earlier ask of the same person started, in its project', async () => {
    vi.mocked(findConversationInOrg).mockResolvedValue(conversation({ projectId: PROJECT }))
    vi.mocked(hasAskedInConversation).mockResolvedValue(true)
    await askPiloti(SESSION, { question: 'Und im Keller?', conversationId: THREAD }, { waitMs: 0 })
    expect(insertConversation).not.toHaveBeenCalled()
    expect(hasAskedInConversation).toHaveBeenCalledWith(ORG, THREAD, USER)
    expect(turnRequest().conversationId).toBe(THREAD)
    expect(resolveTurnContext).toHaveBeenCalledWith(SESSION, { projectId: PROJECT, conversationId: THREAD })
  })

  it.each([
    ['no ask started it', conversation(), false],
    ['it is somebody else’s', conversation({ createdBy: 'user_bernd' }), true],
    ['it is being deleted', conversation({ deletedAt: new Date() }), true],
  ])('never writes into a conversation when %s', async (_why, found, asked) => {
    vi.mocked(findConversationInOrg).mockResolvedValue(found)
    vi.mocked(hasAskedInConversation).mockResolvedValue(asked)
    await expect(askPiloti(SESSION, { question: 'Und?', conversationId: THREAD })).rejects.toBeInstanceOf(NotFoundError)
    expect(insertAsk).not.toHaveBeenCalled()
  })

  it('refuses to move a continued conversation to another project', async () => {
    vi.mocked(findConversationInOrg).mockResolvedValue(conversation({ projectId: null }))
    vi.mocked(hasAskedInConversation).mockResolvedValue(true)
    await expect(
      askPiloti(SESSION, { question: 'Und?', conversationId: THREAD, projectId: PROJECT }),
    ).rejects.toBeInstanceOf(ConflictError)
  })
})

describe('getAsk and cancelAsk', () => {
  it('answers 404 for an id of another shape, without a lookup', async () => {
    await expect(getAsk(SESSION, 'not-an-id')).rejects.toBeInstanceOf(NotFoundError)
    expect(findAsk).not.toHaveBeenCalled()
  })

  it('reads only the asker’s own ask', async () => {
    row = askRow({ requestedBy: 'user_bernd' })
    await expect(getAsk(SESSION, row.id)).rejects.toBeInstanceOf(NotFoundError)
    await expect(cancelAsk(SESSION, row.id)).rejects.toBeInstanceOf(NotFoundError)
    expect(cancelHeadlessTurn).not.toHaveBeenCalled()
  })

  it('refuses to stop an ask that has ended (A2A TaskNotCancelableError)', async () => {
    row = askRow({ state: 'completed', endedAt: new Date() })
    await expect(cancelAsk(SESSION, row.id)).rejects.toBeInstanceOf(ConflictError)
  })

  it('stops the turn as the asker, and ends an ask whose turn is not running', async () => {
    row = askRow({ state: 'working' })
    vi.mocked(cancelHeadlessTurn).mockResolvedValue({ kind: 'not_running' })
    const view = await cancelAsk(SESSION, row.id)
    const request = vi.mocked(cancelHeadlessTurn).mock.calls[0]?.[0]
    expect(request?.turnId).toBe(row.id)
    const headers = request?.headers ?? {}
    expect(
      verifyGridRequestContextEnvelope(headers['x-grid-request-context'], headers['x-grid-request-context-sig'], SECRET),
    ).toMatchObject({ userId: USER, conversationId: THREAD })
    expect(endAsk).toHaveBeenCalledWith(ORG, row.id, { state: 'canceled' })
    expect(view.state).toBe('canceled')
  })
})

describe('recordAskOutcome', () => {
  const outcome = { conversationId: THREAD, turnId: '22222222-2222-4222-8222-222222222222', outcome: 'answered' } as const

  it.each([
    ['answered', undefined, { state: 'completed' }],
    ['handed_off', undefined, { state: 'completed' }],
    ['stopped', undefined, { state: 'canceled' }],
    ['refused', 'Budget erschöpft.', { state: 'rejected', reason: 'Budget erschöpft.' }],
    ['failed', undefined, { state: 'failed', reason: 'the turn ended without an answer' }],
  ] as const)('maps %s to the ask’s end', (turnOutcome, reason, end) => {
    expect(askEndOf({ outcome: turnOutcome, reason })).toEqual(end)
  })

  it('ends the ask its turn names', async () => {
    vi.mocked(findAskById).mockResolvedValue(askRow({ state: 'working' }))
    expect(await recordAskOutcome(outcome)).toBe(true)
    expect(endAsk).toHaveBeenCalledWith(ORG, outcome.turnId, { state: 'completed' })
  })

  it.each([
    ['an unknown turn (a browser’s)', null],
    ['an ask that already ended', askRow({ state: 'canceled', endedAt: new Date() })],
    ['another conversation’s turn', askRow({ state: 'working', conversationId: 's_99999999_9999_4999_8999_999999999999' })],
  ])('settles nothing for %s', async (_why, found) => {
    vi.mocked(findAskById).mockResolvedValue(found)
    expect(await recordAskOutcome(outcome)).toBe(false)
    expect(endAsk).not.toHaveBeenCalled()
  })
})

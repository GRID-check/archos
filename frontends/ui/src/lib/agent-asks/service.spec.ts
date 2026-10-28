/**
 * @vitest-environment node
 */
/**
 * An agent asks Piloti (ADR-0124). Pinned here: the switch; the thread (a new
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
  deleteConversationInOrg: vi.fn(),
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
  deleteAskQuestion: vi.fn(),
  endAsk: vi.fn(),
  findAsk: vi.fn(),
  findAskById: vi.fn(),
  hasAskedInConversation: vi.fn(),
  insertAsk: vi.fn(),
  listAskDocuments: vi.fn(async () => []),
  markAskWorking: vi.fn(),
}))
vi.mock('@/lib/projects/repository', () => ({ findProjectProfile: vi.fn(async () => null) }))
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
  deleteConversationInOrg,
  findConversationInOrg,
  findMessageInConversation,
  insertConversation,
  insertMessages,
} from '@/lib/conversations/repository'
import type { Conversation } from '@/lib/db/schema/conversations'
import type { Message } from '@/lib/db/schema/messages'
import type { PilotiAskRow } from '@/lib/db/schema/piloti-asks'
import { findProjectProfile } from '@/lib/projects/repository'
import { verifyGridRequestContextEnvelope } from '@/lib/request-context'
import { cancelHeadlessTurn, chatSocketUrl, runHeadlessTurn, type HeadlessTurnRequest } from '@/lib/turns/headless-turn'
import { resolveTurnContext, TurnBudgetExhaustedError } from '@/lib/turns/turn-context'
import {
  deleteAskQuestion,
  endAsk,
  findAsk,
  findAskById,
  hasAskedInConversation,
  insertAsk,
  markAskWorking,
} from './repository'
import {
  ASK_REQUIRES,
  askAnswerMessageId,
  askEndOf,
  askMaxSeconds,
  askPiloti,
  cancelAsk,
  getAsk,
  recordAskOutcome,
} from './service'
import { CHAT_TURN_DEADLINE_SECONDS, DEFAULT_ASK_MAX_SECONDS } from './ask-wire'

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
  createdAt: new Date(),
  updatedAt: new Date(),
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
  vi.mocked(chatSocketUrl).mockReturnValue('ws://aiq-agent:8000/websocket')
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

  it('adds the sources and confidence the answer stored, read from its message', async () => {
    row = askRow({ state: 'completed', endedAt: new Date() })
    vi.mocked(findConversationInOrg).mockResolvedValue(conversation({ projectId: PROJECT }))
    vi.mocked(findMessageInConversation).mockImplementation(async (conversationId, id) =>
      id === askAnswerMessageId(conversationId, row.id)
        ? ({
            id,
            content: 'Höchstens 40 m.',
            createdAt: new Date(),
            metadata: {
              citations: { v: 1, sources: [{ file_name: 'Konzept.pdf', document_id: 'c:Konzept.pdf', page: 2, is_cited: true }] },
              provenance: { answerConfidence: 'medium' },
            },
          } as Message)
        : null,
    )
    const view = await getAsk(SESSION, row.id)
    expect(view.answer?.sources).toMatchObject([{ documentId: 'c:Konzept.pdf', page: 2 }])
    expect(view.answer?.sources?.[0]?.url).toContain(`/app/projects/${PROJECT}/chat?session=${THREAD}&cite=`)
    expect(view.answer?.confidence).toEqual({ level: 'medium' })
  })

  it('hands the agent plain Markdown: no directive fence, and a binding read off the project', async () => {
    row = askRow({ state: 'completed', endedAt: new Date() })
    vi.mocked(findConversationInOrg).mockResolvedValue(conversation({ projectId: PROJECT }))
    vi.mocked(findProjectProfile).mockResolvedValue({
      version: 1,
      facts: { building_class: { value: 'gk5', confidence: 'confirmed', source: 'onboarding', updatedAt: '' } },
    } as never)
    vi.mocked(findMessageInConversation).mockImplementation(async (conversationId, id) =>
      id === askAnswerMessageId(conversationId, row.id)
        ? ({
            id,
            content: 'Klasse :project[building_class].\n\n:::check\n| A | B |\n|---|---|\n| x | y |\n:::',
            createdAt: new Date(),
            metadata: {},
          } as Message)
        : null,
    )
    const view = await getAsk(SESSION, row.id)
    expect(view.answer?.text).not.toContain(':::')
    expect(view.answer?.text).not.toContain(':project[')
    expect(view.answer?.text).toContain('| x | y |')
    expect(findProjectProfile).toHaveBeenCalledWith(PROJECT, ORG)
  })

  it('names the busy thread and the way out in the reason the agent reads', async () => {
    vi.mocked(runHeadlessTurn).mockResolvedValue({ kind: 'busy' })
    const view = await askPiloti(SESSION, { question: 'Und danach?', waitSeconds: 0 })
    expect(view.reason).toMatch(/never interrupts a running turn.*agent-ask-get.*conversationId/)
  })

  it('leaves the turn’s start to the chat path’s own time bound', async () => {
    await askPiloti(SESSION, { question: 'Welche Fluchtweglänge gilt?', waitSeconds: 0 })
    expect(turnRequest().timeoutMs).toBeUndefined()
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
    // The thread this ask opened holds nothing anyone will answer: it goes, the ask row with it.
    expect(deleteConversationInOrg).toHaveBeenCalledWith(row.conversationId, ORG)
  })

  it('ends failed, with an id and no 500, when this deployment has no chat service', async () => {
    vi.mocked(chatSocketUrl).mockImplementation(() => {
      throw new Error('BACKEND_CHAT_URL is not set: the wake has no chat socket to open')
    })
    const view = await askPiloti(SESSION, { question: 'Hallo?' }, { waitMs: 0 })
    expect(view.id).toBe(row.id)
    expect(view.state).toBe('failed')
    expect(view.reason).toMatch(/could not be reached: .*BACKEND_CHAT_URL/)
    expect(runHeadlessTurn).not.toHaveBeenCalled()
  })

  it('ends failed, never left submitted, when starting the turn throws', async () => {
    vi.mocked(resolveTurnContext).mockRejectedValue(new Error('connection reset'))
    const view = await askPiloti(SESSION, { question: 'Hallo?' }, { waitMs: 0 })
    expect(view.state).toBe('failed')
    expect(view.reason).toBe('Piloti could not start the turn.')
    expect(endAsk).toHaveBeenCalledWith(ORG, view.id, { state: 'failed', reason: 'Piloti could not start the turn.' })
  })

  it('takes back the question, and keeps the thread, when a continued conversation is busy', async () => {
    vi.mocked(findConversationInOrg).mockResolvedValue(conversation())
    vi.mocked(hasAskedInConversation).mockResolvedValue(true)
    vi.mocked(runHeadlessTurn).mockResolvedValue({ kind: 'busy' })
    const view = await askPiloti(SESSION, { question: 'Und?', conversationId: THREAD }, { waitMs: 0 })
    expect(view.state).toBe('rejected')
    expect(view.question).toBe('Und?')
    expect(deleteAskQuestion).toHaveBeenCalledWith(ORG, THREAD, view.id)
    expect(deleteConversationInOrg).not.toHaveBeenCalled()
  })

  it('sends no turn for an ask canceled while its turn context was read', async () => {
    vi.mocked(resolveTurnContext).mockImplementation(async (_session, request) => {
      row = { ...row, state: 'canceled', endedAt: new Date() }
      return {
        scope: [],
        scopedCollections: [],
        header: '',
        conversationId: request.conversationId,
        organizationId: ORG,
        userId: USER,
        projectId: request.projectId,
        memoryReflectionEnabled: false,
      }
    })
    const view = await askPiloti(SESSION, { question: 'Hallo?' }, { waitMs: 0 })
    expect(runHeadlessTurn).not.toHaveBeenCalled()
    expect(view.state).toBe('canceled')
  })

  it('stops a turn that was sent while the ask was canceled', async () => {
    vi.mocked(markAskWorking).mockImplementation(async () => {
      row = { ...row, state: 'canceled', endedAt: new Date() }
      return false
    })
    vi.mocked(cancelHeadlessTurn).mockResolvedValue({ kind: 'sent' })
    await askPiloti(SESSION, { question: 'Hallo?' }, { waitMs: 0 })
    expect(cancelHeadlessTurn).toHaveBeenCalledWith(expect.objectContaining({ turnId: row.id }))
  })

  it('returns at once with waitSeconds 0, and waits by default, for an answer one poll away', async () => {
    const answerOnFirstPoll = () => {
      let reads = 0
      vi.mocked(findAsk).mockImplementation(async () => {
        reads += 1
        // Read 1 is the start's re-read, read 2 the one after `working`; read 3 is the first poll.
        if (reads >= 3 && row.state === 'working') row = { ...row, state: 'completed', endedAt: new Date() }
        return row
      })
    }
    answerOnFirstPoll()
    expect((await askPiloti(SESSION, { question: 'Hallo?', waitSeconds: 0 })).state).toBe('working')
    answerOnFirstPoll()
    expect((await askPiloti(SESSION, { question: 'Hallo?' })).state).toBe('completed')
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
    expect(view.pollAfterSeconds).toBeNull()
    expect(markAskWorking).not.toHaveBeenCalled()
    expect(deleteConversationInOrg).toHaveBeenCalledWith(row.conversationId, ORG)
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

  it('ends a submitted ask before it sends the stop, so a start under way sends no turn', async () => {
    row = askRow({ state: 'submitted' })
    let stateAtStop: string | null = null
    vi.mocked(cancelHeadlessTurn).mockImplementation(async () => {
      stateAtStop = row.state
      return { kind: 'sent' }
    })
    expect((await cancelAsk(SESSION, row.id)).state).toBe('canceled')
    expect(stateAtStop).toBe('canceled')
  })

  it('cancels a submitted ask even without a chat service', async () => {
    row = askRow({ state: 'submitted' })
    vi.mocked(chatSocketUrl).mockImplementation(() => {
      throw new Error('BACKEND_CHAT_URL is not set')
    })
    const view = await cancelAsk(SESSION, row.id)
    expect(view.state).toBe('canceled')
    expect(cancelHeadlessTurn).not.toHaveBeenCalled()
  })

  it('refuses to claim a stop it could not send for a running ask', async () => {
    row = askRow({ state: 'working' })
    vi.mocked(chatSocketUrl).mockImplementation(() => {
      throw new Error('BACKEND_CHAT_URL is not set')
    })
    await expect(cancelAsk(SESSION, row.id)).rejects.toBeInstanceOf(ConflictError)
    expect(row.state).toBe('working')
  })

  it('answers canceled once the stop was taken, even when the turn’s notice is late', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] })
    try {
      row = askRow({ state: 'working' })
      vi.mocked(cancelHeadlessTurn).mockResolvedValue({ kind: 'sent' })
      const pending = cancelAsk(SESSION, row.id)
      await vi.advanceTimersByTimeAsync(6_000)
      const view = await pending
      expect(view.state).toBe('canceled')
      expect(view.pollAfterSeconds).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('ends an ask whose outcome never came once it is older than any turn runs', async () => {
    row = askRow({ state: 'working', createdAt: new Date(Date.now() - (askMaxSeconds() + 60) * 1_000) })
    const view = await getAsk(SESSION, row.id)
    expect(view.state).toBe('failed')
    expect(view.reason).toMatch(/did not report the end of its turn/)
  })

  it('leaves a running ask alone inside that time', async () => {
    row = askRow({ state: 'working', createdAt: new Date(Date.now() - 60_000) })
    expect((await getAsk(SESSION, row.id)).state).toBe('working')
    expect(endAsk).not.toHaveBeenCalled()
  })

  it('leaves an ask alone while its turn may still answer, up to the chat turn deadline', async () => {
    // The old bound (30 minutes) ended an ask whose turn the socket lets run 45.
    row = askRow({ state: 'working', createdAt: new Date(Date.now() - (CHAT_TURN_DEADLINE_SECONDS - 60) * 1_000) })
    expect((await getAsk(SESSION, row.id)).state).toBe('working')
    expect(endAsk).not.toHaveBeenCalled()
  })

  it('reads the longest an ask stays open from GRID_PILOTI_ASK_MAX_SECONDS', () => {
    expect(askMaxSeconds({ GRID_PILOTI_ASK_MAX_SECONDS: '600' })).toBe(600)
    expect(askMaxSeconds({ GRID_PILOTI_ASK_MAX_SECONDS: 'x' })).toBe(DEFAULT_ASK_MAX_SECONDS)
    expect(askMaxSeconds({})).toBe(DEFAULT_ASK_MAX_SECONDS)
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

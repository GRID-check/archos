/**
 * @vitest-environment node
 */
/**
 * The ask routes (ADR-0124) as thin adapters: the session, the body and query
 * schemas, the chat-turn budget, and the status that tells an agent whether to
 * poll (200 for an ask that ended, 202 for one still running). The rules are
 * the service's (`lib/agent-asks/service.spec.ts`).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

const SESSION = vi.hoisted(() => ({
  userId: 'user_anna',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  email: 'anna@example.at',
  name: 'Anna Weber',
  role: 'member',
  permissions: [] as string[],
  accessToken: '',
  featureFlags: ['piloti-ask'],
}))

vi.mock('@/lib/auth/require-auth', () => ({ requireAuthorizedSession: vi.fn(async () => SESSION) }))
vi.mock('@/lib/limits/enforce', async (original) => ({
  ...(await original<typeof import('@/lib/limits/enforce')>()),
  enforceLimit: vi.fn(async () => undefined),
}))
vi.mock('@/lib/agent-asks/service', () => ({ askAgent: vi.fn(), getAsk: vi.fn(), cancelAsk: vi.fn() }))

import { UnauthorizedError } from '@/lib/api/errors'
import { requireAuthorizedSession } from '@/lib/auth/require-auth'
import { CHAT_TURN_LIMIT } from '@/lib/limits/catalog'
import { enforceLimit } from '@/lib/limits/enforce'
import type { AskView } from '@/lib/agent-asks/ask-wire'
import { askAgent, cancelAsk, getAsk } from '@/lib/agent-asks/service'
import { POST as cancel } from './[id]/cancel/route'
import { GET as read } from './[id]/route'
import { POST as ask } from './route'

const ID = '22222222-2222-4222-8222-222222222222'

const view = (over: Partial<AskView> = {}): AskView => ({
  id: ID,
  conversationId: 's_11111111_1111_4111_8111_111111111111',
  projectId: null,
  state: 'working',
  question: 'Welche Fluchtweglänge gilt?',
  reason: null,
  answer: null,
  documents: [],
  createdAt: '2026-10-21T09:00:00.000Z',
  updatedAt: '2026-10-21T09:00:00.000Z',
  endedAt: null,
  pollAfterSeconds: 10,
  ...over,
})

const post = (body: unknown) =>
  new Request('http://piloti.test/api/agent-asks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const params = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST /api/agent-asks', () => {
  it('answers 202 while Piloti works, so the agent polls', async () => {
    vi.mocked(askAgent).mockResolvedValue(view())
    const response = await ask(post({ question: 'Welche Fluchtweglänge gilt?' }))
    expect(response.status).toBe(202)
    expect(await response.json()).toMatchObject({ id: ID, state: 'working', pollAfterSeconds: 10 })
    expect(askAgent).toHaveBeenCalledWith(SESSION, { question: 'Welche Fluchtweglänge gilt?' })
  })

  it('answers 200 with the answer once the ask ended', async () => {
    vi.mocked(askAgent).mockResolvedValue(view({ state: 'completed', answer: { messageId: 'm', text: '40 m.' } }))
    const response = await ask(post({ question: 'Welche Fluchtweglänge gilt?' }))
    expect(response.status).toBe(200)
  })

  it('charges the chat-turn budget: an ask is a turn', async () => {
    vi.mocked(askAgent).mockResolvedValue(view())
    await ask(post({ question: 'Hallo?' }))
    expect(enforceLimit).toHaveBeenCalledWith(CHAT_TURN_LIMIT, expect.anything())
  })

  it.each([
    ['an empty question', { question: '   ' }],
    ['a question past the bound', { question: 'x'.repeat(8_001) }],
    ['a conversation id of another shape', { question: 'Und?', conversationId: 'conv_1' }],
    ['a field the contract does not name', { question: 'Und?', model: 'gpt' }],
  ])('refuses %s with 400, before the service runs', async (_why, body) => {
    const response = await ask(post(body))
    expect(response.status).toBe(400)
    expect(askAgent).not.toHaveBeenCalled()
  })

  it('refuses a caller without a session', async () => {
    vi.mocked(requireAuthorizedSession).mockRejectedValueOnce(new UnauthorizedError())
    const response = await ask(post({ question: 'Hallo?' }))
    expect(response.status).toBe(401)
    expect(askAgent).not.toHaveBeenCalled()
  })
})

describe('GET /api/agent-asks/[id]', () => {
  it('reads the ask, waiting as long as asked', async () => {
    vi.mocked(getAsk).mockResolvedValue(view())
    const response = await read(new Request(`http://piloti.test/api/agent-asks/${ID}?waitSeconds=25`), params(ID))
    expect(response.status).toBe(200)
    expect(getAsk).toHaveBeenCalledWith(SESSION, ID, 25)
  })

  it('refuses a wait past the bound with 400', async () => {
    const response = await read(new Request(`http://piloti.test/api/agent-asks/${ID}?waitSeconds=41`), params(ID))
    expect(response.status).toBe(400)
    expect(getAsk).not.toHaveBeenCalled()
  })
})

describe('POST /api/agent-asks/[id]/cancel', () => {
  it('stops the ask', async () => {
    vi.mocked(cancelAsk).mockResolvedValue(view({ state: 'canceled', pollAfterSeconds: null }))
    const response = await cancel(new Request(`http://piloti.test/api/agent-asks/${ID}/cancel`, { method: 'POST' }), params(ID))
    expect(response.status).toBe(200)
    expect(cancelAsk).toHaveBeenCalledWith(SESSION, ID)
  })
})

/**
 * @vitest-environment node
 */
/**
 * The A2A door (ADR-0123), end to end below the principal: a JSON-RPC request
 * goes through the official SDK, the request handler, the dispatcher and the
 * real ask routes, and stops at the ask service, which is mocked. Pinned: who
 * is turned away (no token, Piloti's own credential: the recursion lock), both
 * protocol versions (1.0 `SendMessage`, 0.3 `message/send`), the task the ask
 * becomes, the A2A errors a route's refusal becomes, and the stream.
 */

import { webcrypto } from 'node:crypto'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/agent-api/principal', async (original) => ({
  ...(await original<typeof import('@/lib/agent-api/principal')>()),
  resolvePrincipal: vi.fn(),
}))
vi.mock('@/lib/limits', async (original) => ({
  ...(await original<typeof import('@/lib/limits')>()),
  enforceLimit: vi.fn(),
}))
vi.mock('@/lib/limits/enforce', async (original) => ({
  ...(await original<typeof import('@/lib/limits/enforce')>()),
  enforceLimit: vi.fn(async () => undefined),
}))
vi.mock('@/lib/piloti-asks/service', () => ({ askPiloti: vi.fn(), getAsk: vi.fn(), cancelAsk: vi.fn() }))

import { ConflictError, NotFoundError } from '@/lib/api/errors'
import type { AuthorizedSession } from '@/lib/auth/types'
import { resolvePrincipal, type AgentPrincipal } from '@/lib/agent-api/principal'
import { enforceLimit, MCP_REQUEST_LIMIT, memberSubject } from '@/lib/limits'
import type { AskView } from '@/lib/piloti-asks/ask-wire'
import { askPiloti, cancelAsk, getAsk } from '@/lib/piloti-asks/service'
import { GET, POST } from './route'

const URL_ = 'https://app.piloti.test/api/a2a'
const ID = '22222222-2222-4222-8222-222222222222'
const THREAD = 's_11111111_1111_4111_8111_111111111111'

const SESSION: AuthorizedSession = {
  userId: 'user_anna',
  email: 'anna@example.at',
  name: 'Anna Weber',
  accessToken: '',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'member',
  permissions: [],
  featureFlags: ['piloti-ask'],
}

const PERSON: AgentPrincipal = { actor: 'external_agent', session: SESSION, clientId: 'claude', scopes: [] }

const view = (over: Partial<AskView> = {}): AskView => ({
  id: ID,
  conversationId: THREAD,
  projectId: null,
  state: 'completed',
  question: 'Welche Fluchtweglänge gilt?',
  reason: null,
  answer: { messageId: '33333333-3333-4333-8333-333333333333', text: 'Höchstens 40 m.' },
  documents: [],
  createdAt: '2026-10-21T09:00:00.000Z',
  updatedAt: '2026-10-21T09:00:30.000Z',
  endedAt: '2026-10-21T09:00:30.000Z',
  pollAfterSeconds: null,
  ...over,
})

function rpc(method: string, params: unknown, headers: Record<string, string> = {}): Request {
  return new Request(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer token', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

const V1 = { 'A2A-Version': '1.0' }

const userMessage = (text: string, extra: Record<string, unknown> = {}) => ({
  messageId: 'msg-1',
  role: 'ROLE_USER',
  parts: [{ text }],
  ...extra,
})

const legacyMessage = (text: string, extra: Record<string, unknown> = {}) => ({
  kind: 'message',
  messageId: 'msg-1',
  role: 'user',
  parts: [{ kind: 'text', text }],
  ...extra,
})

type Envelope = { result?: Record<string, unknown>; error?: { code: number; message: string } }

beforeAll(() => {
  // The shared setup swaps `crypto` for a stub without randomUUID, which the route factory uses.
  vi.stubGlobal('crypto', webcrypto)
})

beforeEach(() => {
  vi.clearAllMocks()
  process.env.WORKOS_AUTHKIT_DOMAIN = 'auth.piloti.test'
  process.env.GRID_MCP_RESOURCE_URL = 'https://app.piloti.test/api/mcp'
  vi.mocked(resolvePrincipal).mockResolvedValue(PERSON)
  vi.mocked(askPiloti).mockResolvedValue(view())
  vi.mocked(getAsk).mockResolvedValue(view())
})

describe('who is turned away', () => {
  it('passes the bearer challenge through, so the client can start OAuth', async () => {
    vi.mocked(resolvePrincipal).mockResolvedValue({
      kind: 'challenge',
      response: new Response(null, { status: 401, headers: { 'www-authenticate': 'Bearer resource_metadata="x"' } }),
    })
    const response = await POST(rpc('SendMessage', { message: userMessage('Hallo?') }, V1))
    expect(response.status).toBe(401)
    expect(askPiloti).not.toHaveBeenCalled()
    expect(enforceLimit).not.toHaveBeenCalled()
  })

  it('refuses Piloti’s own credential: Piloti never asks Piloti', async () => {
    vi.mocked(resolvePrincipal).mockResolvedValue({ ...PERSON, actor: 'piloti', clientId: null })
    const response = await POST(rpc('SendMessage', { message: userMessage('Hallo?') }, V1))
    expect(response.status).toBe(403)
    expect((await response.json()).error).toMatch(/Piloti cannot ask Piloti/)
    expect(askPiloti).not.toHaveBeenCalled()
  })

  it('answers 503 while the agent door is not configured', async () => {
    delete process.env.WORKOS_AUTHKIT_DOMAIN
    const response = await POST(rpc('SendMessage', { message: userMessage('Hallo?') }, V1))
    expect(response.status).toBe(503)
  })

  it('rejects a browser origin that is not the app', async () => {
    const response = await POST(rpc('SendMessage', { message: userMessage('Hallo?') }, { ...V1, origin: 'https://evil.example' }))
    expect(response.status).toBe(403)
    expect(resolvePrincipal).not.toHaveBeenCalled()
  })

  it('charges the agent door’s budget once, to the member', async () => {
    await POST(rpc('GetTask', { id: ID }, V1))
    expect(enforceLimit).toHaveBeenCalledTimes(1)
    expect(enforceLimit).toHaveBeenCalledWith(MCP_REQUEST_LIMIT, memberSubject(SESSION))
  })
})

describe('A2A 1.0', () => {
  it('SendMessage asks Piloti as the person and answers the completed task with its answer', async () => {
    const response = await POST(
      rpc('SendMessage', { message: userMessage('Welche Fluchtweglänge gilt?', { metadata: { projectId: '44444444-4444-4444-8444-444444444444' } }) }, V1),
    )
    const body = (await response.json()) as Envelope
    expect(askPiloti).toHaveBeenCalledWith(SESSION, {
      question: 'Welche Fluchtweglänge gilt?',
      projectId: '44444444-4444-4444-8444-444444444444',
    })
    const task = body.result?.task as Record<string, unknown>
    expect(task).toMatchObject({ id: ID, contextId: THREAD, status: { state: 'TASK_STATE_COMPLETED' } })
    expect(task.artifacts).toEqual([
      expect.objectContaining({ artifactId: '33333333-3333-4333-8333-333333333333', name: 'answer', parts: [expect.objectContaining({ text: 'Höchstens 40 m.' })] }),
    ])
  })

  it('a follow-up names the conversation as contextId', async () => {
    await POST(rpc('SendMessage', { message: userMessage('Und im Keller?', { contextId: THREAD }) }, V1))
    expect(askPiloti).toHaveBeenCalledWith(SESSION, { question: 'Und im Keller?', conversationId: THREAD })
  })

  it('returnImmediately answers the task as it stands after the ask’s own wait', async () => {
    vi.mocked(askPiloti).mockResolvedValue(view({ state: 'working', answer: null, endedAt: null, pollAfterSeconds: 10 }))
    const response = await POST(
      rpc('SendMessage', { message: userMessage('Lang?'), configuration: { returnImmediately: true } }, V1),
    )
    const body = (await response.json()) as Envelope
    expect(body.result?.task).toMatchObject({ status: { state: 'TASK_STATE_WORKING' } })
    expect(getAsk).not.toHaveBeenCalled()
  })

  it('a blocking SendMessage polls until the task ends', async () => {
    vi.mocked(askPiloti).mockResolvedValue(view({ state: 'working', answer: null, endedAt: null, pollAfterSeconds: 10 }))
    const response = await POST(rpc('SendMessage', { message: userMessage('Lang?') }, V1))
    const body = (await response.json()) as Envelope
    expect(getAsk).toHaveBeenCalledWith(SESSION, ID, 40)
    expect(body.result?.task).toMatchObject({ status: { state: 'TASK_STATE_COMPLETED' } })
  })

  it('refuses a file part: Piloti reads files from the workspace', async () => {
    const message = { messageId: 'm', role: 'ROLE_USER', parts: [{ url: 'https://x.test/a.pdf', mediaType: 'application/pdf' }] }
    const body = (await (await POST(rpc('SendMessage', { message }, V1))).json()) as Envelope
    expect(body.error?.code).toBe(-32005)
    expect(askPiloti).not.toHaveBeenCalled()
  })

  it('GetTask of an ask that is not the person’s is TaskNotFound', async () => {
    vi.mocked(getAsk).mockRejectedValue(new NotFoundError('Ask not found'))
    const body = (await (await POST(rpc('GetTask', { id: ID }, V1))).json()) as Envelope
    expect(body.error?.code).toBe(-32001)
  })

  it('CancelTask of an ask that ended is TaskNotCancelable', async () => {
    vi.mocked(cancelAsk).mockRejectedValue(new ConflictError('The ask has already ended (completed).'))
    const body = (await (await POST(rpc('CancelTask', { id: ID }, V1))).json()) as Envelope
    expect(body.error?.code).toBe(-32002)
  })

  it('CancelTask stops the ask', async () => {
    vi.mocked(cancelAsk).mockResolvedValue(view({ state: 'canceled', answer: null }))
    const body = (await (await POST(rpc('CancelTask', { id: ID }, V1))).json()) as Envelope
    expect(cancelAsk).toHaveBeenCalledWith(SESSION, ID)
    expect(body.result).toMatchObject({ id: ID, status: { state: 'TASK_STATE_CANCELED' } })
  })

  it('a version it does not speak is VersionNotSupported', async () => {
    const body = (await (await POST(rpc('GetTask', { id: ID }, { 'A2A-Version': '2.0' }))).json()) as Envelope
    expect(body.error?.code).toBe(-32009)
  })

  it('SendStreamingMessage answers server-sent events: the task, the artifact, the end', async () => {
    const response = await POST(rpc('SendStreamingMessage', { message: userMessage('Welche Fluchtweglänge gilt?') }, V1))
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    const events = (await response.text())
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => JSON.parse(line.slice('data: '.length)) as Envelope)
    expect(events.map((event) => Object.keys(event.result ?? {})[0])).toEqual(['task', 'artifactUpdate', 'statusUpdate'])
    expect(events.at(-1)?.result).toMatchObject({ statusUpdate: { status: { state: 'TASK_STATE_COMPLETED' } } })
  })
})

describe('A2A 0.3, for clients that send no version', () => {
  it('message/send answers the task in the 0.3 shape', async () => {
    const response = await POST(rpc('message/send', { message: legacyMessage('Welche Fluchtweglänge gilt?') }))
    const body = (await response.json()) as Envelope
    expect(askPiloti).toHaveBeenCalledWith(SESSION, { question: 'Welche Fluchtweglänge gilt?' })
    expect(body.result).toMatchObject({ kind: 'task', id: ID, contextId: THREAD, status: { state: 'completed' } })
  })

  it('tasks/get reads the task', async () => {
    const body = (await (await POST(rpc('tasks/get', { id: ID }))).json()) as Envelope
    expect(body.result).toMatchObject({ kind: 'task', id: ID })
  })
})

describe('transport', () => {
  it('answers GET with 405: the card is at /.well-known/agent-card.json', async () => {
    const response = await GET()
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
  })
})

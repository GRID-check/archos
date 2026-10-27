/**
 * @vitest-environment node
 */
/**
 * Asking Piloti through the real SDK on the 2026-07-28 era: progress while the
 * door waits, the tasks extension (SEP-2663) over the stored ask, and every
 * other call still one JSON body. The routes are the dispatcher's mock; the
 * catalog, exposure, policy, server and handler are the real ones.
 */
import { webcrypto } from 'node:crypto'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./dispatch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./dispatch')>()),
  callOperation: vi.fn(),
}))
vi.mock('./telemetry', () => ({ recordOperationCalled: vi.fn(), recordOperationMissing: vi.fn() }))

import type { AskState, AskView } from '@/lib/piloti-asks/ask-wire'
import { TASKS_EXTENSION } from './ask-calls'
import { callOperation, validateOperationInput } from './dispatch'
import { createAgentDoorHandler } from './mcp-server'
import type { AgentPrincipal } from './principal'

const session = {
  userId: 'user_1',
  email: 'a@piloti.test',
  name: null,
  accessToken: '',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'admin' as const,
  permissions: [],
  featureFlags: null,
}
const outside: AgentPrincipal = { actor: 'external_agent', clientId: 'c', scopes: [], session }
const piloti: AgentPrincipal = { actor: 'piloti', clientId: null, scopes: [], session }

const ASK_ID = '0d7b3a5e-7c1c-4a4e-9a63-6a4a1f5f1c11'

beforeAll(() => {
  // The shared setup file swaps `crypto` for a stub with no randomUUID.
  Object.defineProperty(globalThis, 'crypto', { value: webcrypto, configurable: true })
})

function view(state: AskState, extra: Partial<AskView> = {}): AskView {
  const terminal = !['submitted', 'working'].includes(state)
  return {
    id: ASK_ID,
    conversationId: 's_1',
    projectId: null,
    state,
    question: 'Wie hoch darf die Attika sein?',
    reason: null,
    answer: state === 'completed' ? { messageId: 'm_1', text: 'Höchstens 1,20 m.' } : null,
    documents: [],
    createdAt: '2026-10-22T10:00:00.000Z',
    updatedAt: '2026-10-22T10:00:05.000Z',
    endedAt: terminal ? '2026-10-22T10:00:05.000Z' : null,
    pollAfterSeconds: terminal ? null : 10,
    ...extra,
  }
}

/** The ask's routes: `create` answers `working`, each `get` the next state in `gets`. */
function askRoutes(gets: AskState[], create: AskState = 'working') {
  const queue = [...gets]
  vi.mocked(callOperation).mockImplementation(async (op, input) => {
    // The dispatcher refuses an input its operation cannot take before the route runs.
    validateOperationInput(op, input)
    if (op.name === 'piloti-ask-create') return { status: 202, ok: true, body: view(create) }
    if (op.name === 'piloti-ask-get') {
      // A read that does not end the ask takes its time, as the route's wait does.
      await new Promise((resolve) => setTimeout(resolve, 5))
      return { status: 200, ok: true, body: view(queue.shift() ?? 'completed') }
    }
    if (op.name === 'piloti-ask-cancel') return { status: 200, ok: true, body: view('canceled') }
    return { status: 200, ok: true, body: { projects: [] } }
  })
}

const calls = (name: string) => vi.mocked(callOperation).mock.calls.filter(([op]) => op.name === name)

beforeEach(() => askRoutes(['working', 'completed']))
afterEach(() => vi.mocked(callOperation).mockReset())

const handler = createAgentDoorHandler(() => undefined)

const TASKS = { extensions: { [TASKS_EXTENSION]: {} } }

/** One 2026-07-28 request: the envelope in `_meta`, and the standard headers SEP-2243 asks for. */
async function modern(
  method: string,
  params: Record<string, unknown>,
  options: { name?: string; capabilities?: object; meta?: object; principal?: AgentPrincipal; mode?: 'search' | 'tools' } = {},
) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2026-07-28',
    'mcp-method': method,
  }
  if (options.name) headers['mcp-name'] = options.name
  const _meta = {
    'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    'io.modelcontextprotocol/clientCapabilities': options.capabilities ?? {},
    'io.modelcontextprotocol/clientInfo': { name: 'spec', version: '1' },
    ...options.meta,
  }
  const response = await handler.fetch(
    new Request('https://app.piloti.test/api/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: { ...params, _meta } }),
    }),
    { authInfo: { token: '', clientId: 'c', scopes: [], extra: { principal: options.principal ?? outside, mode: options.mode ?? 'search' } } },
  )
  return { type: response.headers.get('content-type') ?? '', messages: messagesOf(await response.text()) }
}

type Message = { method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code: number; message: string } }

/** The JSON-RPC messages of a body: one JSON object, or the `data:` lines of an SSE stream. */
function messagesOf(raw: string): Message[] {
  const data = raw.split('\n').filter((line) => line.startsWith('data:'))
  return data.length ? data.map((line) => JSON.parse(line.slice(5)) as Message) : [JSON.parse(raw) as Message]
}

const last = (messages: Message[]) => messages[messages.length - 1]

const askCall = (input: Record<string, unknown> = { body: { question: 'Wie hoch darf die Attika sein?' } }) => ({
  name: 'call-operation',
  arguments: { name: 'piloti-ask-create', input },
})

describe('progress while Piloti answers', () => {
  it('streams progress against the wait budget, then the answer, when the call carries a progress token', async () => {
    const { type, messages } = await modern('tools/call', askCall(), { name: 'call-operation', meta: { progressToken: 'p1' } })
    expect(type).toMatch(/^text\/event-stream/)
    const progress = messages.filter((message) => message.method === 'notifications/progress').map((message) => message.params)
    expect(progress.length).toBeGreaterThan(0)
    expect(progress[0]).toMatchObject({ progressToken: 'p1', total: 40, message: 'Piloti is working on the answer.' })
    const values = progress.map((params) => params?.progress as number)
    expect(values).toEqual([...values].sort((a, b) => a - b))
    expect(new Set(values).size).toBe(values.length)
    const result = last(messages).result as { structuredContent: AskView; isError?: boolean }
    expect(result.isError).toBeUndefined()
    expect(result.structuredContent).toMatchObject({ id: ASK_ID, state: 'completed' })
    // The ask is started without the route's own wait; the door waits, in reads short enough to report between.
    expect(calls('piloti-ask-create')[0][1]).toMatchObject({ body: { waitSeconds: 0 } })
    for (const [, input] of calls('piloti-ask-get')) {
      expect(input).toMatchObject({ params: { id: ASK_ID } })
      expect((input.query as { waitSeconds: number }).waitSeconds).toBeLessThanOrEqual(5)
    }
  })

  it('reports against the waitSeconds the caller asked for', async () => {
    const { messages } = await modern('tools/call', askCall({ body: { question: 'Q', waitSeconds: 12 } }), {
      name: 'call-operation',
      meta: { progressToken: 7 },
    })
    expect(messages.find((message) => message.method === 'notifications/progress')?.params).toMatchObject({ progressToken: 7, total: 12 })
  })

  it('streams progress in tools mode too', async () => {
    const { type, messages } = await modern(
      'tools/call',
      { name: 'piloti-ask-create', arguments: { body: { question: 'Q' } } },
      { name: 'piloti-ask-create', mode: 'tools', meta: { progressToken: 'p' } },
    )
    expect(type).toMatch(/^text\/event-stream/)
    expect(messages.some((message) => message.method === 'notifications/progress')).toBe(true)
    expect((last(messages).result as { structuredContent: AskView }).structuredContent.state).toBe('completed')
  })

  it('without a progress token is today’s single call: one JSON body, the route’s own wait', async () => {
    const { type, messages } = await modern('tools/call', askCall(), { name: 'call-operation' })
    expect(type).toMatch(/^application\/json/)
    expect(messages).toHaveLength(1)
    expect(calls('piloti-ask-create')).toHaveLength(1)
    expect(calls('piloti-ask-create')[0][1]).toEqual({ body: { question: 'Wie hoch darf die Attika sein?' } })
    expect(calls('piloti-ask-get')).toHaveLength(0)
  })

  it('refuses an input it cannot take exactly as today, before anything is stored', async () => {
    const { messages } = await modern('tools/call', askCall({ body: { question: '' } }), {
      name: 'call-operation',
      meta: { progressToken: 'p' },
    })
    const result = last(messages).result as { isError: boolean; content: { text: string }[] }
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/question/)
    // Handed to today's call with the input as given (no `waitSeconds: 0` of the door's own), and refused there.
    expect(calls('piloti-ask-create').map(([, input]) => input)).toEqual([{ body: { question: '' } }])
    expect(calls('piloti-ask-get')).toHaveLength(0)
  })
})

describe('every other call answers one JSON body', () => {
  it.each([
    ['server/discover', {}, undefined],
    ['tools/list', {}, undefined],
    ['tools/call', { name: 'call-operation', arguments: { name: 'project-list', input: {} } }, 'call-operation'],
    ['tools/call', { name: 'search-operations', arguments: { query: 'ask Piloti' } }, 'search-operations'],
    ['resources/list', {}, undefined],
    ['prompts/list', {}, undefined],
  ])('%s %j', async (method, params, name) => {
    // A progress token alone does not stream a call whose wait is not ours.
    const { type, messages } = await modern(method, params, { name, meta: { progressToken: 'p' } })
    expect(type).toMatch(/^application\/json/)
    expect(messages).toHaveLength(1)
    expect(last(messages).error).toBeUndefined()
  })
})

describe('the tasks extension (SEP-2663)', () => {
  it('is advertised on the 2026-07-28 era to an agent that may ask Piloti, and to nobody else', async () => {
    const offered = await modern('server/discover', {})
    // MCP Apps is echoed only to a client that declared it renders them (`mcp-apps.ts`); this one declared nothing.
    expect((last(offered.messages).result as { capabilities: { extensions?: object } }).capabilities.extensions).toEqual({
      [TASKS_EXTENSION]: {},
    })
    const own = await modern('server/discover', {}, { principal: piloti })
    expect((last(own.messages).result as { capabilities: { extensions?: object } }).capabilities.extensions).toBeUndefined()
  })

  it('answers a call that declares tasks with a CreateTaskResult, the ask id as its task id', async () => {
    const { type, messages } = await modern('tools/call', askCall(), { name: 'call-operation', capabilities: TASKS })
    expect(type).toMatch(/^application\/json/)
    expect(last(messages).result).toMatchObject({
      resultType: 'task',
      taskId: ASK_ID,
      status: 'working',
      createdAt: '2026-10-22T10:00:00.000Z',
      lastUpdatedAt: '2026-10-22T10:00:05.000Z',
      ttlMs: null,
      pollIntervalMs: 10_000,
    })
    expect(calls('piloti-ask-create')[0][1]).toMatchObject({ body: { waitSeconds: 0 } })
    expect(calls('piloti-ask-get')).toHaveLength(0)
  })

  it('answers an ask that ended at once as the call it was, not as a task', async () => {
    askRoutes([], 'rejected')
    const { messages } = await modern('tools/call', askCall(), { name: 'call-operation', capabilities: TASKS })
    const result = last(messages).result as { resultType: string; structuredContent: AskView }
    expect(result.resultType).toBe('complete')
    expect(result.structuredContent.state).toBe('rejected')
  })

  it('reads a working ask as a working task, and a finished one with the tool result inline', async () => {
    askRoutes(['working', 'completed'])
    const working = await modern('tasks/get', { taskId: ASK_ID }, { name: ASK_ID, capabilities: TASKS })
    expect(last(working.messages).result).toMatchObject({ resultType: 'complete', taskId: ASK_ID, status: 'working', pollIntervalMs: 10_000 })
    expect(last(working.messages).result).not.toHaveProperty('result')
    const done = await modern('tasks/get', { taskId: ASK_ID }, { name: ASK_ID, capabilities: TASKS })
    const task = last(done.messages).result as { status: string; result: { content: unknown[]; structuredContent: AskView } }
    expect(task.status).toBe('completed')
    expect(task.result.structuredContent.answer?.text).toBe('Höchstens 1,20 m.')
    expect(calls('piloti-ask-get')[0][1]).toEqual({ params: { id: ASK_ID } })
  })

  it('reads a canceled ask as a cancelled task', async () => {
    askRoutes(['canceled'])
    const { messages } = await modern('tasks/get', { taskId: ASK_ID }, { name: ASK_ID, capabilities: TASKS })
    expect(last(messages).result).toMatchObject({ status: 'cancelled' })
  })

  it('answers -32602 for an id that names no ask of this person’s, as the route’s 404 says', async () => {
    vi.mocked(callOperation).mockResolvedValue({ status: 404, ok: false, body: { error: 'Ask not found', code: 'NOT_FOUND' } })
    const { messages } = await modern('tasks/get', { taskId: ASK_ID }, { name: ASK_ID, capabilities: TASKS })
    expect(last(messages).error?.code).toBe(-32602)
    const malformed = await modern('tasks/get', { taskId: 'not-an-ask' }, { name: 'not-an-ask', capabilities: TASKS })
    expect(last(malformed.messages).error?.code).toBe(-32602)
  })

  it('answers -32021 to a task request that does not declare the extension', async () => {
    const { messages } = await modern('tasks/get', { taskId: ASK_ID }, { name: ASK_ID })
    expect(last(messages).error?.code).toBe(-32021)
    expect(calls('piloti-ask-get')).toHaveLength(0)
  })

  it('cancels through piloti-ask-cancel and acknowledges, also an ask that had already ended', async () => {
    const { messages } = await modern('tasks/cancel', { taskId: ASK_ID }, { name: ASK_ID, capabilities: TASKS })
    expect(last(messages).result).toMatchObject({ resultType: 'complete' })
    expect(calls('piloti-ask-cancel')[0][1]).toEqual({ params: { id: ASK_ID } })
    vi.mocked(callOperation).mockResolvedValue({ status: 409, ok: false, body: { error: 'The ask has already ended (completed).' } })
    const ended = await modern('tasks/cancel', { taskId: ASK_ID }, { name: ASK_ID, capabilities: TASKS })
    expect(last(ended.messages).error).toBeUndefined()
  })

  it('acknowledges tasks/update: an ask never waits for input', async () => {
    const { messages } = await modern('tasks/update', { taskId: ASK_ID, inputResponses: {} }, { name: ASK_ID, capabilities: TASKS })
    expect(last(messages).result).toMatchObject({ resultType: 'complete' })
  })

  it('is not served to Piloti’s own client, whose writes are proposals', async () => {
    const { messages } = await modern('tasks/get', { taskId: ASK_ID }, { name: ASK_ID, capabilities: TASKS, principal: piloti })
    expect(last(messages).error?.code).toBe(-32601)
  })
})

describe('the 2025-era path', () => {
  it('ignores a progress token and answers today’s single JSON call', async () => {
    const response = await handler.fetch(
      new Request('https://app.piloti.test/api/mcp', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'mcp-protocol-version': '2025-11-25' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { ...askCall(), _meta: { progressToken: 'p' } } }),
      }),
      { authInfo: { token: '', clientId: 'c', scopes: [], extra: { principal: outside, mode: 'search' } } },
    )
    expect(response.headers.get('content-type')).toMatch(/^application\/json/)
    expect(calls('piloti-ask-create')).toHaveLength(1)
    expect(calls('piloti-ask-create')[0][1]).toEqual({ body: { question: 'Wie hoch darf die Attika sein?' } })
    expect(calls('piloti-ask-get')).toHaveLength(0)
  })
})

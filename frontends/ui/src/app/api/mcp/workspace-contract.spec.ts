// @vitest-environment node
/**
 * The contract between Piloti's Python agent and its own MCP server (ADR-0122).
 *
 * `tests/fixtures/workspace_mcp_requests.json` is written by the Python test
 * `tests/aiq_agent/tools/workspace/test_workspace_mcp_contract.py` from the real
 * request builder of `client.py`. Every request in it is replayed here against the
 * REAL `POST` handler of `/api/mcp` (real SDK, real principal, real envelope
 * verification). Only these seams are replaced: the token, a freshly SIGNED
 * envelope, the pinned session lookup, the catalog (the small fake one), and the
 * two things a call would reach into (`callOperation`, `proposeOperation`).
 *
 * What the route really answered is written to `workspace_mcp_responses.json`,
 * which the Python test feeds back through the real response parser. Rewrites the
 * responses fixture when `UPDATE_FIXTURES=1`, otherwise compares.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { webcrypto } from 'node:crypto'
import { resolve } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/agent-api/catalog', async () => {
  const { FAKE_OPERATIONS } = await import('@/lib/agent-api/test-operations')
  return {
    AGENT_OPERATIONS: FAKE_OPERATIONS,
    findOperation: (name: string) => FAKE_OPERATIONS.find((op) => op.name === name),
  }
})
vi.mock('@/lib/agent-api/exposure.config', async (importOriginal) =>
  (await import('@/lib/agent-api/test-operations')).withFakeExposure(
    await importOriginal<typeof import('@/lib/agent-api/exposure.config')>(),
  ),
)
vi.mock('@/lib/auth/pinned-session', () => ({ resolvePinnedRequesterSession: vi.fn() }))
vi.mock('@/lib/workos/feature-flags', () => ({ isOrgFeatureEnabled: vi.fn() }))
vi.mock('@/lib/agent-api/telemetry', () => ({
  recordOperationCalled: vi.fn(),
  recordOperationMissing: vi.fn(),
}))
vi.mock('@/lib/agent-api/operation-proposals', () => ({ proposeOperation: vi.fn() }))
vi.mock('@/lib/agent-api/conversation-audience', async (importOriginal) => ({
  // The real judge and refusals; who reads the conversation and the record are the database's.
  ...(await importOriginal<typeof import('@/lib/agent-api/conversation-audience')>()),
  conversationAudienceOf: vi.fn(),
  ownRestrictingFolders: vi.fn(async () => []),
  recordWorkspaceHandOut: vi.fn(),
}))
vi.mock('@/lib/agent-api/dispatch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-api/dispatch')>()),
  callOperation: vi.fn(),
}))

import { conversationAudienceOf, recordWorkspaceHandOut } from '@/lib/agent-api/conversation-audience'
import { callOperation } from '@/lib/agent-api/dispatch'
import { proposeOperation } from '@/lib/agent-api/operation-proposals'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import { signGridRequestContextEnvelope } from '@/lib/request-context'
import { POST } from './route'

const SECRET = 'internal-token-for-tests' // pragma: allowlist secret
const FIXTURES = resolve(__dirname, '../../../../tests/fixtures')
const REQUESTS = resolve(FIXTURES, 'workspace_mcp_requests.json')
const RESPONSES = resolve(FIXTURES, 'workspace_mcp_responses.json')

interface RecordedRequest {
  name: string
  method: string
  path: string
  headers: Record<string, string>
  body: { method: string; params: { name: string } }
}
interface RequestsFixture {
  placeholders: { token: string; signature: string; envelope: string }
  envelopePayload: Record<string, unknown>
  requests: RecordedRequest[]
}
interface RecordedResponse {
  status: number
  contentType: string
  body: string
}

const fixture = JSON.parse(readFileSync(REQUESTS, 'utf8')) as RequestsFixture

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

/** The envelope the fixture names, with a current `issuedAt`, signed with `secret`. */
function envelopeSignedWith(secret: string): { header: string; signature: string } {
  const json = JSON.stringify({ ...fixture.envelopePayload, issuedAt: Date.now() })
  return {
    header: Buffer.from(json, 'utf8').toString('base64url'),
    signature: signGridRequestContextEnvelope(json, secret),
  }
}

type Tamper = (headers: Record<string, string>) => void

/** The recorded request with the placeholders filled in, as the BFF would receive it. */
function replay(recorded: RecordedRequest, tamper?: Tamper): Request {
  const { header, signature } = envelopeSignedWith(SECRET)
  const swaps: Record<string, string> = {
    [fixture.placeholders.token]: SECRET,
    [fixture.placeholders.signature]: signature,
    [fixture.placeholders.envelope]: header,
  }
  const headers = Object.fromEntries(
    Object.entries(recorded.headers).map(([name, value]) => [name, swaps[value] ?? value])
  )
  tamper?.(headers)
  return new Request(`https://app.piloti.test${recorded.path}`, {
    method: recorded.method,
    headers,
    body: JSON.stringify(recorded.body),
  })
}

const recorded = (name: string): RecordedRequest => {
  const found = fixture.requests.find((request) => request.name === name)
  if (!found) throw new Error(`workspace_mcp_requests.json has no "${name}" request`)
  return found
}

/** What the Python client reads: status, content type, and the raw body. */
async function captured(response: Response): Promise<RecordedResponse> {
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    body: await response.text(),
  }
}

/** The JSON-RPC message of a captured answer, JSON or SSE. */
function messageOf<T>(answer: RecordedResponse): T {
  const data = answer.body.split('\n').find((line) => line.startsWith('data:'))
  return JSON.parse(data ? data.slice('data:'.length) : answer.body) as T
}

type ToolResult = {
  result: {
    isError?: boolean
    content: { type: string; text: string }[]
    structuredContent?: Record<string, unknown>
  }
}

const answers: Record<string, RecordedResponse> = {}

beforeAll(() => {
  // The shared setup file swaps `crypto` for a stub with no randomUUID, which the SDK uses.
  vi.stubGlobal('crypto', webcrypto)
})

/** Who reads the conversation: the requester alone, or someone else too. */
const audienceOf = (solo: boolean) => ({
  row: { exists: true, projectId: null, createdBy: 'user_1', visibility: 'private' as const, grantees: solo ? [] : ['user_2'] },
  solo,
  key: solo ? 'private|user_1' : 'private|user_1|user_2',
})

beforeEach(() => {
  vi.clearAllMocks()
  process.env.INTERNAL_API_TOKEN = SECRET
  process.env.MCP_RESOURCE_URL = 'https://app.piloti.test/api/mcp'
  vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(session)
  vi.mocked(callOperation).mockResolvedValue({
    ok: true,
    status: 200,
    body: { projects: [{ id: 'proj_1', name: 'Haus Muster' }] },
  })
  vi.mocked(conversationAudienceOf).mockResolvedValue(audienceOf(true))
  vi.mocked(recordWorkspaceHandOut).mockResolvedValue(true)
  vi.mocked(proposeOperation).mockResolvedValue({
    proposalId: 'prop_1',
    summary: 'Add user_2 to proj_1 as viewer',
  } as Awaited<ReturnType<typeof proposeOperation>>)
})

describe('what client.py sends, replayed against the real route', () => {
  it('replays the same set of requests the Python test records', () => {
    expect(fixture.requests.map((request) => request.name)).toEqual([
      'search',
      'describe',
      'call_write',
      'call_read',
      'report_missing',
    ])
    for (const request of fixture.requests) expect(request.body.method).toBe('tools/call')
  })

  it.each(['search', 'describe', 'call_write', 'call_read', 'report_missing'])(
    'accepts a 2025-11-25 tools/call with no initialize: %s',
    async (name) => {
      const answer = await captured(await POST(replay(recorded(name))))
      answers[name] = answer
      expect(answer.status).toBe(200)
      const message = messageOf<ToolResult & { error?: unknown }>(answer)
      expect(message.error).toBeUndefined()
      expect(message.result.isError).not.toBe(true)
      expect(message.result.content[0]?.text.length).toBeGreaterThan(0)
    }
  )

  it('answers in a format the Python client parses (JSON, or SSE with one data: event)', async () => {
    for (const name of ['search', 'call_write']) {
      const { contentType } = answers[name] ?? (await captured(await POST(replay(recorded(name)))))
      expect(contentType).toMatch(/^(application\/json|text\/event-stream)/)
    }
  })

  it('serves the search-mode tools: search-operations, describe-operation, call-operation, report-missing-operation', async () => {
    const list = {
      ...recorded('search'),
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    } as unknown as RecordedRequest
    const answer = await captured(await POST(replay(list)))
    const tools = messageOf<{ result: { tools: { name: string }[] } }>(answer).result.tools.map(
      (tool) => tool.name
    )
    expect(tools).toEqual([
      'search-operations',
      'describe-operation',
      'call-operation',
      'report-missing-operation',
    ])
  })

  it('finds the operation a search names', () => {
    const text = messageOf<ToolResult>(answers.search).result.content[0].text
    expect(text).toContain('project-member-add')
  })

  it('turns a write through call-operation into a proposal and changes nothing', async () => {
    const result = messageOf<ToolResult>(
      await captured(await POST(replay(recorded('call_write'))))
    ).result
    expect(result.structuredContent).toEqual({
      decision: 'propose',
      proposalId: 'prop_1',
      summary: 'Add user_2 to proj_1 as viewer',
      operation: 'project-member-add',
    })
    expect(vi.mocked(proposeOperation)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(callOperation)).not.toHaveBeenCalled()
  })

  it("runs a read through call-operation as the envelope's person", async () => {
    await POST(replay(recorded('call_read')))
    expect(vi.mocked(callOperation)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(callOperation).mock.calls[0][2]).toMatchObject({
      userId: 'user_1',
      organizationId: 'org_1',
    })
    expect(vi.mocked(resolvePinnedRequesterSession)).toHaveBeenCalledWith({
      userId: 'user_1',
      email: null,
      organizationId: 'org_1',
    })
  })

  it('records the read in a solo conversation for the answer the client named, before running it', async () => {
    await POST(replay(recorded('call_read')))
    expect(vi.mocked(recordWorkspaceHandOut)).toHaveBeenCalledTimes(1)
    const [principal] = vi.mocked(recordWorkspaceHandOut).mock.calls[0]
    expect(principal).toMatchObject({
      actor: 'piloti',
      conversationId: 'conv_1',
      answerMessageId: recorded('call_read').headers['x-grid-answer-message-id'],
    })
    expect(vi.mocked(recordWorkspaceHandOut).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(callOperation).mock.invocationCallOrder[0]
    )
  })

  it('refuses a read in a shared conversation with a sentence the model relays, and runs nothing', async () => {
    vi.mocked(conversationAudienceOf).mockResolvedValue(audienceOf(false))
    const answer = await captured(await POST(replay(recorded('call_read'))))
    answers.refused_shared_conversation = answer
    const result = messageOf<ToolResult>(answer).result
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/^This conversation is shared/)
    expect(vi.mocked(callOperation)).not.toHaveBeenCalled()
    expect(vi.mocked(recordWorkspaceHandOut)).not.toHaveBeenCalled()
  })

  it('hands a tool-level error back as a tool result, not a protocol error', async () => {
    const unknown = {
      ...recorded('describe'),
      body: {
        ...recorded('describe').body,
        params: { name: 'describe-operation', arguments: { name: 'nope' } },
      },
    }
    const answer = await captured(await POST(replay(unknown)))
    answers.unknown_operation = answer
    const result = messageOf<ToolResult>(answer).result
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toMatch(/^Unknown operation "nope"/)
  })
})

describe('what the route says to a request the client cannot make valid', () => {
  const expectRefusal = (name: string, answer: RecordedResponse, status: number): void => {
    answers[name] = answer
    expect(answer.status).toBe(status)
    const body = JSON.parse(answer.body) as { error: string }
    // The client relays `error` as a string: `_http_refusal` reads `payload["error"]`.
    expect(typeof body.error).toBe('string')
    expect(body.error.length).toBeGreaterThan(0)
  }

  it('refuses a call with no envelope', async () => {
    const answer = await captured(
      await POST(
        replay(recorded('search'), (h) => {
          delete h['x-grid-request-context']
          delete h['x-grid-request-context-sig']
        })
      )
    )
    expectRefusal('refused_no_envelope', answer, 401)
    expect(vi.mocked(resolvePinnedRequesterSession)).not.toHaveBeenCalled()
  })

  it('refuses an envelope signed with another key', async () => {
    const forged = envelopeSignedWith('not-the-secret')
    const answer = await captured(
      await POST(
        replay(recorded('search'), (h) => {
          h['x-grid-request-context'] = forged.header
          h['x-grid-request-context-sig'] = forged.signature
        })
      )
    )
    expectRefusal('refused_forged_envelope', answer, 401)
  })

  it('refuses a wrong service token', async () => {
    const answer = await captured(
      await POST(
        replay(recorded('search'), (h) => {
          h['x-grid-internal-token'] = 'wrong'
        })
      )
    )
    expect(answer.status).toBeGreaterThanOrEqual(401)
    expectRefusal('refused_wrong_token', answer, answer.status)
  })
})

describe('the responses fixture', () => {
  it('is what the route answered', () => {
    const generated = {
      comment:
        'Written by workspace-contract.spec.ts from the real route; read by test_workspace_mcp_contract.py. Regenerate with UPDATE_FIXTURES=1.',
      responses: Object.fromEntries(Object.entries(answers).sort(([a], [b]) => a.localeCompare(b))),
    }
    const text = JSON.stringify(generated, null, 2) + '\n'
    if (process.env.UPDATE_FIXTURES === '1') writeFileSync(RESPONSES, text, 'utf8')
    expect(JSON.parse(readFileSync(RESPONSES, 'utf8'))).toEqual(generated)
  })
})

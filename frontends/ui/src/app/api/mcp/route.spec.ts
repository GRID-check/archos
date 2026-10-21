/**
 * @vitest-environment node
 */
/**
 * The agent door's HTTP edge (ADR-0121): who is turned away before the MCP
 * handler runs, the challenge an MCP client needs to start OAuth, and one real
 * round trip through the SDK so the server we build is the server that answers.
 */

import { webcrypto } from 'node:crypto'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/agent-api/catalog', async () => {
  const { FAKE_OPERATIONS } = await import('@/lib/agent-api/test-operations')
  return {
    AGENT_OPERATIONS: FAKE_OPERATIONS,
    findOperation: (name: string) => FAKE_OPERATIONS.find((op) => op.name === name),
  }
})
vi.mock('@/lib/auth/pinned-session', () => ({ resolvePinnedRequesterSession: vi.fn() }))
vi.mock('@/lib/workos/feature-flags', () => ({ isOrgFeatureEnabled: vi.fn() }))
vi.mock('@/lib/agent-api/telemetry', () => ({ recordOperationCalled: vi.fn(), recordCapabilityMissing: vi.fn() }))
vi.mock('@/lib/limits', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/limits')>()),
  enforceLimit: vi.fn(),
}))

import { TooManyRequestsError } from '@/lib/api/errors'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import { MCP_REQUEST_LIMIT, enforceLimit, memberSubject } from '@/lib/limits'
import { buildGridRequestContextEnvelope, GRID_HEADER_NAMES } from '@/lib/request-context'
import { DELETE, GET, POST } from './route'

const SECRET = 'internal-token-for-tests' // pragma: allowlist secret
const URL_ = 'https://app.piloti.test/api/mcp'

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

function pilotiHeaders(): Record<string, string> {
  const { header, signature } = buildGridRequestContextEnvelope(
    { organizationId: 'org_1', userId: 'user_1', conversationId: 'conv_1', issuedAt: Date.now() },
    SECRET,
  )
  return {
    'x-grid-internal-token': SECRET,
    [GRID_HEADER_NAMES.REQUEST_CONTEXT]: header,
    [GRID_HEADER_NAMES.REQUEST_CONTEXT_SIG]: signature ?? '',
  }
}

function rpc(method: string, params: unknown, headers: Record<string, string> = {}, url = URL_): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

// The shared setup file swaps `crypto` for a stub with no randomUUID, which the SDK uses.
beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto)
})

beforeEach(() => {
  vi.clearAllMocks()
  process.env.WORKOS_AUTHKIT_DOMAIN = 'auth.piloti.test'
  process.env.GRID_MCP_RESOURCE_URL = URL_
  process.env.GRID_INTERNAL_API_TOKEN = SECRET
  process.env.WORKOS_REDIRECT_URI = 'https://app.piloti.test/api/auth/callback'
  vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(session)
  vi.mocked(enforceLimit).mockResolvedValue({
    allowed: true,
    rule: MCP_REQUEST_LIMIT.name,
    remaining: 1,
    limit: MCP_REQUEST_LIMIT.limit,
    retryAfterSeconds: 0,
    degraded: false,
  })
})

describe('authentication', () => {
  it('answers 401 with the bearer challenge that points at the protected-resource metadata', async () => {
    const response = await POST(rpc('tools/list', {}))
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe(
      'Bearer error="invalid_token", error_description="Missing Authorization header", ' +
        'resource_metadata="https://app.piloti.test/.well-known/oauth-protected-resource/api/mcp"',
    )
  })

  it('answers 401 for a token that is not a JWT', async () => {
    const response = await POST(rpc('tools/list', {}, { authorization: 'Bearer not-a-jwt' }))
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('resource_metadata=')
  })

  it('answers 503 on the external door while AuthKit is not configured', async () => {
    delete process.env.WORKOS_AUTHKIT_DOMAIN
    const response = await POST(rpc('tools/list', {}, { authorization: 'Bearer x.y.z' }))
    expect(response.status).toBe(503)
  })

  it('keeps Piloti\'s door working without an AuthKit domain', async () => {
    delete process.env.WORKOS_AUTHKIT_DOMAIN
    const response = await POST(rpc('tools/list', {}, pilotiHeaders()))
    expect(response.status).toBe(200)
  })
})

describe('origin', () => {
  it('rejects a browser origin that is not the app', async () => {
    const response = await POST(rpc('tools/list', {}, { origin: 'https://evil.example', ...pilotiHeaders() }))
    expect(response.status).toBe(403)
  })

  it('lets the app\'s own origin and clients with no origin through to authentication', async () => {
    const own = await POST(rpc('tools/list', {}, { origin: 'https://app.piloti.test' }))
    expect(own.status).toBe(401)
    const none = await POST(rpc('tools/list', {}))
    expect(none.status).toBe(401)
  })
})

describe('rate limit (M6)', () => {
  it('charges the mcp-request rule once per HTTP request, to the member, after the caller is known', async () => {
    const response = await POST(
      rpc('tools/call', { name: 'search-operations', arguments: { query: 'project' } }, pilotiHeaders()),
    )
    expect(response.status).toBe(200)
    expect(enforceLimit).toHaveBeenCalledTimes(1)
    expect(enforceLimit).toHaveBeenCalledWith(MCP_REQUEST_LIMIT, memberSubject(session))
  })

  it('charges nothing for a caller it turned away', async () => {
    expect((await POST(rpc('tools/list', {}))).status).toBe(401)
    expect(enforceLimit).not.toHaveBeenCalled()
  })

  it('answers 429 with Retry-After once the budget is spent, and runs nothing', async () => {
    const decision = {
      allowed: false,
      rule: MCP_REQUEST_LIMIT.name,
      remaining: 0,
      limit: MCP_REQUEST_LIMIT.limit,
      retryAfterSeconds: 7,
      degraded: false,
    }
    vi.mocked(enforceLimit).mockRejectedValueOnce(new TooManyRequestsError(decision))
    const response = await POST(rpc('tools/list', {}, pilotiHeaders()))
    expect(response.status).toBe(429)
    expect(response.headers.get('retry-after')).toBe('7')
    expect(response.headers.get('x-ratelimit-policy')).toBe('mcp-request')
  })

  it('names a budget and documents it', () => {
    expect(MCP_REQUEST_LIMIT).toMatchObject({ name: 'mcp-request' })
    expect(MCP_REQUEST_LIMIT.limit).toBeGreaterThan(0)
    expect(MCP_REQUEST_LIMIT.burst?.limit).toBeLessThan(MCP_REQUEST_LIMIT.limit)
  })
})

describe('stateless transport', () => {
  it('answers GET and DELETE with 405', async () => {
    for (const handler of [GET, DELETE]) {
      const response = await handler()
      expect(response.status).toBe(405)
      expect(response.headers.get('allow')).toBe('POST')
    }
  })
})

/**
 * The JSON-RPC message in a response. The 2025-era leg of the SDK answers as an
 * SSE stream (`responseMode: 'json'` shapes the 2026 leg only); either way one
 * message comes back.
 */
async function messageOf<T>(response: Response): Promise<T> {
  const raw = await response.text()
  const data = raw.split('\n').find((line) => line.startsWith('data:'))
  return JSON.parse(data ? data.slice('data:'.length) : raw) as T
}

describe('MCP round trip as Piloti', () => {
  async function toolNames(url: string, headers: Record<string, string> = {}): Promise<string[]> {
    const response = await POST(rpc('tools/list', {}, { ...pilotiHeaders(), ...headers }, url))
    expect(response.status).toBe(200)
    const body = await messageOf<{ result: { tools: { name: string }[] } }>(response)
    return body.result.tools.map((tool) => tool.name)
  }

  it('lists the four meta-tools by default', async () => {
    expect(await toolNames(URL_)).toEqual([
      'search-operations',
      'describe-operation',
      'call-operation',
      'report-missing-capability',
    ])
  })

  it('lists one tool per operation in tools mode, chosen by query or header', async () => {
    // folder-access-grant is sensitive: Piloti may not propose it, so it never sees it (M4).
    const expected = ['project-list', 'project-member-add', 'project-delete', 'document-search', 'report-missing-capability']
    expect(await toolNames(`${URL_}?mode=tools`)).toEqual(expected)
    expect(await toolNames(URL_, { 'x-piloti-mcp-mode': 'tools' })).toEqual(expected)
  })

  it('serves the instructions that say what Piloti is', async () => {
    const response = await POST(
      rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'spec', version: '1' },
      }, pilotiHeaders()),
    )
    const body = await messageOf<{ result: { instructions: string } }>(response)
    expect(body.result.instructions).toMatch(/workspace for architects/)
    expect(body.result.instructions).not.toMatch(/compliance/i)
  })

  it('searches the catalog through tools/call', async () => {
    const response = await POST(
      rpc('tools/call', { name: 'search-operations', arguments: { query: 'project' } }, pilotiHeaders()),
    )
    const body = await messageOf<{ result: { structuredContent: { operations: { name: string }[] } } }>(response)
    expect(body.result.structuredContent.operations.map((op) => op.name)).toContain('project-list')
  })
})

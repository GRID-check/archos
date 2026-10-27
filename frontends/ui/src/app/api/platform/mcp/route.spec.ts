/**
 * @vitest-environment node
 */
/**
 * The platform door (ADR-0126), end to end through the real principal: a signed
 * AuthKit token, verified against a local key set, decides who gets in, and the
 * same MCP server as the office door answers with the platform domain only.
 *
 * Pinned: the audiences do not cross (an office token here, a platform token on
 * `/api/mcp`); only the GRID Platform organization, with the door switched on,
 * for platform staff; never Piloti's credential; a JSON 503 when WorkOS cannot
 * answer; one charge of the agent budget; the listing is exactly the platform
 * domain, and the office door does not list it for the same person.
 */

import { webcrypto } from 'node:crypto'
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const keys: { current: ReturnType<typeof createLocalJWKSet> | null } = { current: null }

vi.mock('jose', async (original) => ({
  ...(await original<typeof import('jose')>()),
  // AuthKit's key set, answered locally: the token is really signed and really verified.
  createRemoteJWKSet: () => (...args: Parameters<ReturnType<typeof createLocalJWKSet>>) => {
    if (!keys.current) throw new Error('no key set')
    return keys.current(...args)
  },
}))
vi.mock('@/lib/agent-api/catalog', async () => {
  const { FAKE_OPERATIONS, PLATFORM_FAKE_OPERATIONS } = await import('@/lib/agent-api/test-operations')
  const all = [...FAKE_OPERATIONS, ...PLATFORM_FAKE_OPERATIONS]
  return { AGENT_OPERATIONS: all, findOperation: (name: string) => all.find((op) => op.name === name) }
})
vi.mock('@/lib/auth/pinned-session', () => ({ resolvePinnedRequesterSession: vi.fn() }))
vi.mock('@/lib/workos/feature-flags', () => ({ isOrgFeatureEnabled: vi.fn() }))
vi.mock('@/lib/authz/platform', () => ({ getPlatformOrganizationId: vi.fn(), isPlatformStaff: vi.fn() }))
vi.mock('@/lib/agent-api/telemetry', async (original) => ({
  ...(await original<typeof import('@/lib/agent-api/telemetry')>()),
  recordOperationCalled: vi.fn(),
  recordOperationMissing: vi.fn(),
}))
vi.mock('@/lib/limits', async (original) => ({
  ...(await original<typeof import('@/lib/limits')>()),
  enforceLimit: vi.fn(),
}))

import { recordOperationCalled } from '@/lib/agent-api/telemetry'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import type { AuthorizedSession } from '@/lib/auth/types'
import { getPlatformOrganizationId, isPlatformStaff } from '@/lib/authz/platform'
import { MCP_REQUEST_LIMIT, enforceLimit, memberSubject } from '@/lib/limits'
import { buildGridRequestContextEnvelope, GRID_HEADER_NAMES } from '@/lib/request-context'
import { isOrgFeatureEnabled } from '@/lib/workos/feature-flags'
import { POST as officePOST } from '../../mcp/route'
import { platformOverviewCalls } from '@/lib/agent-api/test-operations'
import { DELETE, GET, POST } from './route'

const DOMAIN = 'auth.piloti.test'
const OFFICE = 'https://app.piloti.test/api/mcp'
const A2A = 'https://app.piloti.test/api/a2a'
const PLATFORM = 'https://app.piloti.test/api/platform/mcp'
const PLATFORM_ORG = 'org_platform'
const SECRET = 'internal-token-for-tests' // pragma: allowlist secret
const KID = 'test-key'

const operator: AuthorizedSession = {
  userId: 'user_ops',
  email: 'ops@grid.test',
  name: 'Operator',
  accessToken: '',
  organizationId: PLATFORM_ORG,
  organizationMembershipId: 'om_ops',
  role: 'org-platform-owner',
  permissions: ['platform:settings:view', 'platform:settings:manage', 'platform:organizations:view'],
  featureFlags: null,
}

let privateKey: CryptoKey

beforeAll(async () => {
  // The shared setup file swaps `crypto` for a stub with no randomUUID, which the SDK uses.
  vi.stubGlobal('crypto', webcrypto)
  const pair = await generateKeyPair('RS256')
  privateKey = pair.privateKey as CryptoKey
  keys.current = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'RS256', use: 'sig' }] })
})

async function token({ aud = PLATFORM, org = PLATFORM_ORG }: { aud?: string; org?: string } = {}): Promise<string> {
  return new SignJWT({ client_id: 'client_claude', scope: 'openid profile', org_id: org })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setSubject('user_ops')
    .setIssuer(`https://${DOMAIN}`)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey)
}

function rpc(url: string, method: string, params: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
}

const bearer = async (options?: { aud?: string; org?: string }) => ({ authorization: `Bearer ${await token(options)}` })

/** The JSON-RPC message of a response, an SSE frame or a plain body. */
async function messageOf<T>(response: Response): Promise<T> {
  const raw = await response.text()
  const data = raw.split('\n').find((line) => line.startsWith('data:'))
  return JSON.parse(data ? data.slice('data:'.length) : raw) as T
}

type Tool = { name: string; annotations?: Record<string, unknown>; inputSchema?: { properties?: Record<string, { enum?: string[] }> } }

async function toolsOf(post: typeof POST, url: string, headers: Record<string, string>): Promise<Tool[]> {
  const response = await post(rpc(url, 'tools/list', {}, headers))
  expect(response.status).toBe(200)
  return (await messageOf<{ result: { tools: Tool[] } }>(response)).result.tools
}

beforeEach(() => {
  vi.clearAllMocks()
  platformOverviewCalls.length = 0
  process.env.WORKOS_AUTHKIT_DOMAIN = DOMAIN
  process.env.MCP_RESOURCE_URL = OFFICE
  process.env.GRID_INTERNAL_API_TOKEN = SECRET
  process.env.WORKOS_REDIRECT_URI = 'https://app.piloti.test/api/auth/callback'
  vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(operator)
  vi.mocked(isOrgFeatureEnabled).mockResolvedValue(true)
  vi.mocked(getPlatformOrganizationId).mockResolvedValue(PLATFORM_ORG)
  vi.mocked(isPlatformStaff).mockResolvedValue(true)
  vi.mocked(enforceLimit).mockResolvedValue({
    allowed: true,
    rule: MCP_REQUEST_LIMIT.name,
    remaining: 1,
    limit: MCP_REQUEST_LIMIT.limit,
    retryAfterSeconds: 0,
    degraded: false,
  })
})

describe('who may knock', () => {
  it('answers 401 with the challenge that points at the platform door’s own metadata', async () => {
    const response = await POST(rpc(PLATFORM, 'tools/list', {}))
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://app.piloti.test/.well-known/oauth-protected-resource/api/platform/mcp"',
    )
    expect(enforceLimit).not.toHaveBeenCalled()
  })

  it('refuses a token for an office door: the audiences do not cross', async () => {
    for (const aud of [OFFICE, A2A]) {
      const response = await POST(rpc(PLATFORM, 'tools/list', {}, await bearer({ aud })))
      expect(response.status, aud).toBe(401)
      expect(response.headers.get('www-authenticate'), aud).toMatch(/invalid_token/)
    }
    expect(resolvePinnedRequesterSession).not.toHaveBeenCalled()
  })

  it('is refused on the office door with a platform-door token, in the reverse direction too', async () => {
    const response = await officePOST(rpc(OFFICE, 'tools/list', {}, await bearer()))
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toContain('oauth-protected-resource/api/mcp"')
    expect(resolvePinnedRequesterSession).not.toHaveBeenCalled()
  })

  it('refuses an office organization’s token with 403, whatever its audience', async () => {
    const response = await POST(rpc(PLATFORM, 'tools/list', {}, await bearer({ org: 'org_office' })))
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ code: 'FORBIDDEN', error: expect.stringMatching(/GRID Platform organization/) })
    expect(resolvePinnedRequesterSession).not.toHaveBeenCalled()
    expect(enforceLimit).not.toHaveBeenCalled()
  })

  it('stays shut while the platform organization has not switched the door on', async () => {
    vi.mocked(isOrgFeatureEnabled).mockImplementation(async (flag) => flag !== 'platform-agent-mcp')
    const response = await POST(rpc(PLATFORM, 'tools/list', {}, await bearer()))
    expect(response.status).toBe(403)
    expect(isOrgFeatureEnabled).toHaveBeenCalledWith('platform-agent-mcp', PLATFORM_ORG)
    // The office door's flag opens nothing here.
    expect(isOrgFeatureEnabled).not.toHaveBeenCalledWith('agent-mcp', PLATFORM_ORG)
  })

  it('refuses a member of the platform organization who is not platform staff', async () => {
    vi.mocked(isPlatformStaff).mockResolvedValue(false)
    const response = await POST(rpc(PLATFORM, 'tools/list', {}, await bearer()))
    expect(response.status).toBe(403)
    expect(isPlatformStaff).toHaveBeenCalledWith(operator)
  })

  it('refuses a person who is no longer a member', async () => {
    vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(null)
    expect((await POST(rpc(PLATFORM, 'tools/list', {}, await bearer()))).status).toBe(403)
  })

  it('never takes Piloti’s own credential', async () => {
    const { header, signature } = buildGridRequestContextEnvelope(
      { organizationId: PLATFORM_ORG, userId: 'user_ops', conversationId: 'conv_1', issuedAt: Date.now() },
      SECRET,
    )
    const response = await POST(
      rpc(PLATFORM, 'tools/list', {}, {
        'x-grid-internal-token': SECRET,
        [GRID_HEADER_NAMES.REQUEST_CONTEXT]: header,
        [GRID_HEADER_NAMES.REQUEST_CONTEXT_SIG]: signature ?? '',
      }),
    )
    expect(response.status).toBe(403)
    expect(resolvePinnedRequesterSession).not.toHaveBeenCalled()
  })

  it('answers a JSON 503 the agent can retry while WorkOS does not answer', async () => {
    vi.mocked(resolvePinnedRequesterSession).mockRejectedValueOnce(new Error('fetch failed: api.workos.com'))
    const response = await POST(rpc(PLATFORM, 'tools/list', {}, await bearer()))
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: 'SERVICE_UNAVAILABLE' })
  })

  it('answers 503 while the platform organization cannot be resolved', async () => {
    vi.mocked(getPlatformOrganizationId).mockResolvedValue(null)
    expect((await POST(rpc(PLATFORM, 'tools/list', {}, await bearer()))).status).toBe(503)
  })

  it('rejects a browser origin that is not the app, before anything else', async () => {
    const response = await POST(rpc(PLATFORM, 'tools/list', {}, { origin: 'https://evil.example', ...(await bearer()) }))
    expect(response.status).toBe(403)
    expect(resolvePinnedRequesterSession).not.toHaveBeenCalled()
  })

  it('answers GET and DELETE with 405: stateless', async () => {
    for (const handler of [GET, DELETE]) expect((await handler()).status).toBe(405)
  })
})

describe('what it offers', () => {
  it('charges the agent budget once, to the operator', async () => {
    await toolsOf(POST, PLATFORM, await bearer())
    expect(enforceLimit).toHaveBeenCalledTimes(1)
    expect(enforceLimit).toHaveBeenCalledWith(MCP_REQUEST_LIMIT, memberSubject(operator))
  })

  it('lists exactly the platform domain in tools mode: no office operation, no agent read tool', async () => {
    const tools = await toolsOf(POST, `${PLATFORM}?mode=tools`, await bearer())
    // platform-audit-portal-link is `secret`: hidden until the step-up scope is enforced, as on the office door.
    expect(tools.map((tool) => tool.name)).toEqual(['platform-overview-get', 'platform-kill-runs', 'report-missing-operation'])
  })

  it('marks a fleet-wide write destructive, so the client asks the person', async () => {
    const tools = await toolsOf(POST, `${PLATFORM}?mode=tools`, await bearer())
    expect(tools.find((tool) => tool.name === 'platform-kill-runs')?.annotations).toMatchObject({ destructiveHint: true })
  })

  it('offers only the platform domain to search', async () => {
    const tools = await toolsOf(POST, PLATFORM, await bearer())
    const search = tools.find((tool) => tool.name === 'search-operations')
    expect(search?.inputSchema?.properties?.domain?.enum).toEqual(['platform'])
  })

  it('serves the console’s own instructions under its own name', async () => {
    const response = await POST(
      rpc(PLATFORM, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'spec', version: '1' } }, await bearer()),
    )
    const body = await messageOf<{ result: { instructions: string; serverInfo: { name: string } } }>(response)
    expect(body.result.serverInfo.name).toBe('piloti-platform')
    expect(body.result.instructions).toMatch(/platform console/)
  })

  it('runs a platform operation through the dispatcher and records it on the platform door', async () => {
    const response = await POST(
      rpc(PLATFORM, 'tools/call', { name: 'call-operation', arguments: { name: 'platform-overview-get' } }, await bearer()),
    )
    const body = await messageOf<{ result: { isError?: boolean } }>(response)
    expect(body.result.isError).toBeFalsy()
    expect(platformOverviewCalls).toHaveLength(1)
    expect(recordOperationCalled).toHaveBeenCalledWith(
      expect.objectContaining({ principal: expect.objectContaining({ door: 'platform' }) }),
      expect.objectContaining({ operation: 'platform-overview-get', status: 200 }),
    )
  })

  it('reads an office operation as unknown', async () => {
    const response = await POST(
      rpc(PLATFORM, 'tools/call', { name: 'call-operation', arguments: { name: 'project-list' } }, await bearer()),
    )
    const body = await messageOf<{ result: { isError?: boolean; content: { text: string }[] } }>(response)
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0]?.text).toMatch(/Unknown operation "project-list"/)
  })
})

describe('the office door, for the same operator', () => {
  it('does not list the platform domain', async () => {
    const tools = await toolsOf(officePOST, `${OFFICE}?mode=tools`, await bearer({ aud: OFFICE }))
    const names = tools.map((tool) => tool.name)
    expect(names).toContain('project-list')
    expect(names.filter((name) => name.startsWith('platform-'))).toEqual([])
    expect(isOrgFeatureEnabled).toHaveBeenCalledWith('agent-mcp', PLATFORM_ORG)
  })
})

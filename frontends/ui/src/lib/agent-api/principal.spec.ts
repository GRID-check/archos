/**
 * @vitest-environment node
 */
/**
 * Who may knock on the agent door (ADR-0122).
 *
 * The external door's whole security argument is in these cases: a token for
 * another audience, an expired one, one without an organization, or one from an
 * organization that has not opted in gets nothing, and the 401 carries the
 * challenge an MCP client needs to start OAuth. Piloti's door is the internal
 * envelope's, unchanged.
 */

import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/auth/pinned-session', () => ({ resolvePinnedRequesterSession: vi.fn() }))
vi.mock('@/lib/workos/feature-flags', () => ({ isOrgFeatureEnabled: vi.fn() }))

import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import type { AuthorizedSession } from '@/lib/auth/types'
import { MEMBERSHIP_TTL_MS } from '@/lib/authz/project-membership'
import { buildGridRequestContextEnvelope, GRID_HEADER_NAMES } from '@/lib/request-context'
import { isOrgFeatureEnabled } from '@/lib/workos/feature-flags'
import {
  ANSWER_MESSAGE_HEADER,
  type AgentPrincipal,
  type AuthChallenge,
  isChallenge,
  resolvePrincipal,
  tokenVerifier,
} from './principal'

const DOMAIN = 'auth.piloti.test'
const ISSUER = `https://${DOMAIN}`
const RESOURCE = 'https://app.piloti.test/api/mcp'
const A2A_RESOURCE = 'https://app.piloti.test/api/a2a'
const SECRET = 'internal-token-for-tests' // pragma: allowlist secret
const KID = 'test-key'

const session: AuthorizedSession = {
  userId: 'user_1',
  email: 'a@piloti.test',
  name: null,
  accessToken: '',
  organizationId: 'org_1',
  organizationMembershipId: 'om_1',
  role: 'admin',
  permissions: [],
  featureFlags: null,
}

let privateKey: CryptoKey
let jwks: ReturnType<typeof createLocalJWKSet>

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  privateKey = pair.privateKey as CryptoKey
  jwks = createLocalJWKSet({ keys: [{ ...(await exportJWK(pair.publicKey)), kid: KID, alg: 'RS256', use: 'sig' }] })
})

async function token(claims: Record<string, unknown> = {}, options: { aud?: string; exp?: number | string; iss?: string } = {}) {
  const jwt = new SignJWT({ client_id: 'client_claude', scope: 'openid profile', org_id: 'org_1', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: KID })
    .setSubject('user_1')
    .setIssuer(options.iss ?? ISSUER)
    .setAudience(options.aud ?? RESOURCE)
    .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
    .setExpirationTime(options.exp ?? '10m')
  return jwt.sign(privateKey)
}

const bearerAt = (url: string, jwt: string) =>
  new Request(url, { method: 'POST', headers: { authorization: `Bearer ${jwt}` } })
const bearer = (jwt: string) => bearerAt(RESOURCE, jwt)

function challengeOf(result: AgentPrincipal | AuthChallenge): AuthChallenge {
  if (!isChallenge(result)) throw new Error('expected a challenge')
  return result
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.WORKOS_AUTHKIT_DOMAIN = DOMAIN
  process.env.GRID_MCP_RESOURCE_URL = RESOURCE
  process.env.GRID_INTERNAL_API_TOKEN = SECRET
  vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(session)
  vi.mocked(isOrgFeatureEnabled).mockResolvedValue(true)
})

describe('external agent (bearer token)', () => {
  it('resolves a valid AuthKit token to the person, from live membership', async () => {
    const result = await resolvePrincipal(bearer(await token()), { jwks })

    expect(result).toEqual({
      actor: 'external_agent',
      session,
      clientId: 'client_claude',
      scopes: ['openid', 'profile'],
      sensitiveOptIns: ['access', 'secret', 'control'],
    })
    // The membership lookup is at most a minute old: a removed member's token stops working within a minute (L7).
    expect(resolvePinnedRequesterSession).toHaveBeenCalledWith({ userId: 'user_1', email: null, organizationId: 'org_1' })
    expect(MEMBERSHIP_TTL_MS).toBeLessThanOrEqual(60_000)
    expect(isOrgFeatureEnabled).toHaveBeenCalledWith('agent-mcp', 'org_1')
  })

  it('reads the organization’s opt-in per sensitivity class, each on its own', async () => {
    vi.mocked(isOrgFeatureEnabled).mockImplementation(async (flag) => flag !== 'agent-mcp-secrets')
    const result = (await resolvePrincipal(bearer(await token()), { jwks })) as AgentPrincipal
    expect(result.sensitiveOptIns).toEqual(['access', 'control'])
    expect(isOrgFeatureEnabled).toHaveBeenCalledWith('agent-mcp-access', 'org_1')
    expect(isOrgFeatureEnabled).toHaveBeenCalledWith('agent-mcp-secrets', 'org_1')
    expect(isOrgFeatureEnabled).toHaveBeenCalledWith('agent-mcp-controls', 'org_1')
  })

  it('never carries the token into the session', async () => {
    const result = await resolvePrincipal(bearer(await token()), { jwks })
    expect(isChallenge(result) ? null : result.session.accessToken).toBe('')
  })

  it('refuses a request with no bearer token and tells the client where to start OAuth', async () => {
    const { response } = challengeOf(await resolvePrincipal(new Request(RESOURCE, { method: 'POST' }), { jwks }))
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toMatch(/^Bearer /)
    expect(response.headers.get('www-authenticate')).toContain(
      'resource_metadata="https://app.piloti.test/.well-known/oauth-protected-resource/api/mcp"',
    )
  })

  it('refuses a token minted for another audience', async () => {
    const { response } = challengeOf(
      await resolvePrincipal(bearer(await token({}, { aud: 'https://other.example/api/mcp' })), { jwks }),
    )
    expect(response.status).toBe(401)
    expect(resolvePinnedRequesterSession).not.toHaveBeenCalled()
  })

  it('takes a token for the A2A door on either door: both are this server’s resources (ADR-0124)', async () => {
    const forA2a = await token({}, { aud: A2A_RESOURCE })
    expect(isChallenge(await resolvePrincipal(bearer(forA2a), { jwks }))).toBe(false)
    expect(isChallenge(await resolvePrincipal(bearerAt(A2A_RESOURCE, forA2a), { jwks }))).toBe(false)
    expect(isChallenge(await resolvePrincipal(bearerAt(A2A_RESOURCE, await token()), { jwks }))).toBe(false)
  })

  it('takes either door’s audience spelled with a trailing slash', async () => {
    for (const aud of [`${A2A_RESOURCE}/`, `${RESOURCE}/`]) {
      const jwt = await token({}, { aud })
      expect(isChallenge(await resolvePrincipal(bearer(jwt), { jwks })), aud).toBe(false)
      expect(isChallenge(await resolvePrincipal(bearerAt(A2A_RESOURCE, jwt), { jwks })), aud).toBe(false)
    }
  })

  it('names the audience the token carries as its resource, not the door it was sent to', async () => {
    const verifier = tokenVerifier(DOMAIN, ISSUER, { jwks })
    expect((await verifier.verifyAccessToken(await token({}, { aud: A2A_RESOURCE }))).resource?.href).toBe(A2A_RESOURCE)
    expect((await verifier.verifyAccessToken(await token())).resource?.href).toBe(RESOURCE)
  })

  it('keeps the platform door’s audience apart from the office doors’, both ways (ADR-0126)', async () => {
    const PLATFORM_RESOURCE = 'https://app.piloti.test/api/platform/mcp'
    const office = tokenVerifier(DOMAIN, ISSUER, { jwks }, 'mcp')
    const platform = tokenVerifier(DOMAIN, ISSUER, { jwks }, 'platform')
    await expect(office.verifyAccessToken(await token({}, { aud: PLATFORM_RESOURCE }))).rejects.toThrow()
    await expect(tokenVerifier(DOMAIN, ISSUER, { jwks }, 'a2a').verifyAccessToken(await token({}, { aud: PLATFORM_RESOURCE }))).rejects.toThrow()
    for (const aud of [RESOURCE, A2A_RESOURCE]) {
      await expect(platform.verifyAccessToken(await token({}, { aud })), aud).rejects.toThrow()
    }
    expect((await platform.verifyAccessToken(await token({}, { aud: PLATFORM_RESOURCE }))).resource?.href).toBe(PLATFORM_RESOURCE)
  })

  it('refuses a foreign audience on the A2A door too, and points it at the A2A door’s metadata', async () => {
    for (const aud of ['https://other.example/api/a2a', 'https://other.example/api/mcp', 'https://app.piloti.test/api/other']) {
      const { response } = challengeOf(await resolvePrincipal(bearerAt(A2A_RESOURCE, await token({}, { aud })), { jwks }))
      expect(response.status, aud).toBe(401)
      expect(response.headers.get('www-authenticate')).toContain(
        'resource_metadata="https://app.piloti.test/.well-known/oauth-protected-resource/api/a2a"',
      )
    }
    expect(resolvePinnedRequesterSession).not.toHaveBeenCalled()
  })

  it('refuses an expired token', async () => {
    const expired = await token({}, { exp: Math.floor(Date.now() / 1000) - 60 })
    const { response } = challengeOf(await resolvePrincipal(bearer(expired), { jwks }))
    expect(response.status).toBe(401)
  })

  it('refuses a token from another issuer', async () => {
    const { response } = challengeOf(
      await resolvePrincipal(bearer(await token({}, { iss: 'https://evil.example' })), { jwks }),
    )
    expect(response.status).toBe(401)
  })

  it('refuses a token signed by an unknown key', async () => {
    const other = await generateKeyPair('RS256')
    const forged = await new SignJWT({ org_id: 'org_1' })
      .setProtectedHeader({ alg: 'RS256', kid: KID })
      .setSubject('user_1')
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setExpirationTime('10m')
      .sign(other.privateKey)
    const { response } = challengeOf(await resolvePrincipal(bearer(forged), { jwks }))
    expect(response.status).toBe(401)
  })

  it('answers 403 with a clear message when the token has no organization', async () => {
    const { response } = challengeOf(await resolvePrincipal(bearer(await token({ org_id: undefined })), { jwks }))
    expect(response.status).toBe(403)
    expect(((await response.json()) as { error: string }).error).toMatch(/not bound to an organization/)
  })

  it('answers 403 when the organization has not enabled agent access', async () => {
    vi.mocked(isOrgFeatureEnabled).mockResolvedValue(false)
    const { response } = challengeOf(await resolvePrincipal(bearer(await token()), { jwks }))
    expect(response.status).toBe(403)
    expect(resolvePinnedRequesterSession).not.toHaveBeenCalled()
  })

  it('answers 403 when the person is no longer a member', async () => {
    vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(null)
    const { response } = challengeOf(await resolvePrincipal(bearer(await token()), { jwks }))
    expect(response.status).toBe(403)
  })

  it('answers 503 while the deployment has no AuthKit domain', async () => {
    delete process.env.WORKOS_AUTHKIT_DOMAIN
    const { response } = challengeOf(await resolvePrincipal(bearer(await token()), { jwks }))
    expect(response.status).toBe(503)
  })
})

describe('Piloti in-product (internal token and envelope)', () => {
  function envelope(overrides: { issuedAt?: number } = {}) {
    const { header, signature } = buildGridRequestContextEnvelope(
      {
        organizationId: 'org_1',
        userId: 'user_1',
        projectId: 'proj_1',
        conversationId: 'conv_1',
        issuedAt: overrides.issuedAt ?? Date.now(),
      },
      SECRET,
    )
    return {
      [GRID_HEADER_NAMES.REQUEST_CONTEXT]: header,
      [GRID_HEADER_NAMES.REQUEST_CONTEXT_SIG]: signature ?? '',
    }
  }

  const piloti = (headers: Record<string, string>) =>
    new Request(RESOURCE, { method: 'POST', headers: { 'x-grid-internal-token': SECRET, ...headers } })

  it('resolves a verified envelope to Piloti, with its conversation and project', async () => {
    const result = await resolvePrincipal(piloti(envelope()), { jwks })
    expect(result).toEqual({
      actor: 'piloti',
      session,
      clientId: null,
      scopes: [],
      conversationId: 'conv_1',
      projectId: 'proj_1',
      answerMessageId: null,
    })
    // The product itself is not an opt-in feature.
    expect(isOrgFeatureEnabled).not.toHaveBeenCalled()
  })

  it('reads the answer id the turn names, and ignores one that is not a uuid', async () => {
    const answer = '0b8f3c2e-5d1a-4c6b-9e7f-1a2b3c4d5e6f'
    const named = await resolvePrincipal(piloti({ ...envelope(), [ANSWER_MESSAGE_HEADER]: answer }), { jwks })
    expect(named).toMatchObject({ actor: 'piloti', answerMessageId: answer })
    const junk = await resolvePrincipal(piloti({ ...envelope(), [ANSWER_MESSAGE_HEADER]: 'drop table' }), { jwks })
    expect(junk).toMatchObject({ actor: 'piloti', answerMessageId: null })
  })

  it('refuses the service token alone', async () => {
    const { response } = challengeOf(await resolvePrincipal(piloti({}), { jwks }))
    expect(response.status).toBe(401)
  })

  it('refuses a wrong service token', async () => {
    const request = new Request(RESOURCE, {
      method: 'POST',
      headers: { 'x-grid-internal-token': 'nope', ...envelope() },
    })
    const { response } = challengeOf(await resolvePrincipal(request, { jwks }))
    expect(response.status).toBe(403)
  })

  it('refuses an envelope outside its window', async () => {
    const stale = envelope({ issuedAt: Date.now() - 7 * 60 * 60 * 1000 })
    const { response } = challengeOf(await resolvePrincipal(piloti(stale), { jwks }))
    expect(response.status).toBe(401)
  })

  it('refuses an envelope whose person has left', async () => {
    vi.mocked(resolvePinnedRequesterSession).mockResolvedValue(null)
    const { response } = challengeOf(await resolvePrincipal(piloti(envelope()), { jwks }))
    expect(response.status).toBe(403)
  })
})

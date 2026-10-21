import 'server-only'
/**
 * Who is calling the agent door, and with what rights (ADR-0121).
 *
 * Two doors lead to the same server, and each ends in the same thing: an
 * {@link AgentPrincipal} whose `session` is a role-bearing, live-resolved
 * `AuthorizedSession`, which `dispatch.ts` then binds as the acting session of
 * the route it runs.
 *
 *  - An EXTERNAL agent (Claude, Cursor, ChatGPT) sends a WorkOS AuthKit access
 *    token (MCP Auth). It is verified here against the AuthKit JWKS, with the
 *    issuer and with THIS server's URL as audience (RFC 8707), so a token minted
 *    for another resource is worthless here. The token has no permissions
 *    claim; the person's membership, role and permissions are read from WorkOS
 *    as they are now (`resolvePinnedRequesterSession`). The token is never
 *    forwarded anywhere: the session carries an empty `accessToken` (the MCP
 *    specification forbids token passthrough).
 *  - PILOTI in-product echoes the turn's signed request-context envelope next to
 *    the service token, exactly as it does for `/api/internal/*`. It never signs
 *    one; the envelope names the person, and its project and conversation.
 *
 * Failure is returned, not thrown: a {@link AuthChallenge} carries the response
 * the route sends (401 with the `WWW-Authenticate` challenge, 403, 503).
 */

import {
  OAuthError,
  OAuthErrorCode,
  type AuthInfo,
  type OAuthTokenVerifier,
  bearerAuthChallengeResponse,
  getOAuthProtectedResourceMetadataUrl,
  verifyBearerToken,
} from '@modelcontextprotocol/server'
import { type JWTVerifyGetKey, createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose'
import { ApiError } from '@/lib/api/errors'
import { requireVerifiedContext, requirePinnedSession } from '@/lib/api/internal-envelope'
import { resolvePinnedRequesterSession } from '@/lib/auth/pinned-session'
import type { AuthorizedSession } from '@/lib/auth/types'
import { FEATURE_FLAGS } from '@/lib/authz/feature-flags'
import { INTERNAL_TOKEN_HEADER, requireInternalToken } from '@/lib/internal-auth'
import { isOrgFeatureEnabled } from '@/lib/workos/feature-flags'
import { authkitDomain, authkitIssuer, mcpResourceUrl } from './mcp-config'

export interface AgentPrincipal {
  /** `person`: an external agent acting for a person. `piloti`: the in-product agent. */
  kind: 'person' | 'piloti'
  session: AuthorizedSession
  /** The OAuth client that holds the token; `null` for Piloti. */
  clientId: string | null
  scopes: string[]
  /** The chat the call belongs to (Piloti only). */
  conversationId?: string | null
  /** The project the turn runs in (Piloti only). */
  projectId?: string | null
}

/** A request that did not authenticate, with the answer to send. */
export interface AuthChallenge {
  kind: 'challenge'
  response: Response
}

export function isChallenge(value: AgentPrincipal | AuthChallenge): value is AuthChallenge {
  return value.kind === 'challenge'
}

/** Test seam: replaces the remote AuthKit key set. */
export interface PrincipalDeps {
  jwks?: JWTVerifyGetKey
}

const challenge = (response: Response): AuthChallenge => ({ kind: 'challenge', response })

const refuse = (status: number, message: string): AuthChallenge =>
  challenge(Response.json({ error: message, code: status === 403 ? 'FORBIDDEN' : 'UNAVAILABLE' }, { status }))

const remoteKeys = new Map<string, JWTVerifyGetKey>()

function keysFor(domain: string, deps: PrincipalDeps): JWTVerifyGetKey {
  if (deps.jwks) return deps.jwks
  let keys = remoteKeys.get(domain)
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`https://${domain}/oauth2/jwks`))
    remoteKeys.set(domain, keys)
  }
  return keys
}

function stringClaim(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** Verifies an AuthKit access token as an MCP Auth token for `resource`. */
function tokenVerifier(
  domain: string,
  issuer: string,
  resource: URL,
  deps: PrincipalDeps,
): OAuthTokenVerifier {
  // A client may spell the resource with or without a trailing slash.
  const audiences = [resource.href, resource.href.replace(/\/$/, '')]
  return {
    async verifyAccessToken(token): Promise<AuthInfo> {
      try {
        const { payload } = await jwtVerify(token, keysFor(domain, deps), {
          issuer,
          audience: audiences,
          algorithms: ['RS256'],
        })
        const scope = stringClaim(payload.scope)
        return {
          token,
          clientId: stringClaim(payload.client_id) ?? '',
          scopes: scope ? scope.split(/\s+/) : [],
          expiresAt: payload.exp,
          resource,
          extra: { sub: payload.sub ?? null, orgId: stringClaim(payload.org_id) },
        }
      } catch (error) {
        // jose's messages name the failed check (audience, expiry, signature),
        // which helps an integrator and tells an attacker nothing new.
        const reason = error instanceof joseErrors.JOSEError ? error.message : 'token could not be verified'
        throw new OAuthError(OAuthErrorCode.InvalidToken, reason)
      }
    },
  }
}

async function externalPrincipal(request: Request, deps: PrincipalDeps): Promise<AgentPrincipal | AuthChallenge> {
  const domain = authkitDomain()
  const issuer = authkitIssuer()
  const resource = mcpResourceUrl()
  if (!domain || !issuer || !resource) {
    return refuse(
      503,
      'The agent door is not configured on this deployment (WORKOS_AUTHKIT_DOMAIN / GRID_MCP_RESOURCE_URL).',
    )
  }
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resource)

  let auth: AuthInfo
  try {
    auth = await verifyBearerToken(request.headers.get('authorization'), {
      verifier: tokenVerifier(domain, issuer, resource, deps),
      expectedResource: resource,
      resourceMetadataUrl,
    })
  } catch (error) {
    return challenge(bearerAuthChallengeResponse(error, { resourceMetadataUrl }))
  }

  const userId = stringClaim(auth.extra?.sub)
  const organizationId = stringClaim(auth.extra?.orgId)
  if (!userId) return refuse(403, 'The token names no user.')
  if (!organizationId) {
    return refuse(
      403,
      'The token is not bound to an organization. Sign in to Piloti with an organization and authorize the client again.',
    )
  }

  if (!(await isOrgFeatureEnabled(FEATURE_FLAGS.agentMcp, organizationId))) {
    return refuse(403, 'Agent access (MCP) is not enabled for this organization.')
  }

  const session = await resolvePinnedRequesterSession({ userId, email: null, organizationId })
  if (!session) return refuse(403, 'You are not a member of this organization.')

  return { kind: 'person', session, clientId: auth.clientId || null, scopes: auth.scopes }
}

async function pilotiPrincipal(request: Request): Promise<AgentPrincipal | AuthChallenge> {
  const denied = requireInternalToken(request, 'mcp')
  if (denied) return challenge(denied)
  try {
    const context = requireVerifiedContext(request)
    const session = await requirePinnedSession(context)
    return {
      kind: 'piloti',
      session,
      clientId: null,
      scopes: [],
      conversationId: context.conversationId,
      projectId: context.projectId,
    }
  } catch (error) {
    if (error instanceof ApiError) {
      return challenge(Response.json({ error: error.message, code: error.code }, { status: error.status }))
    }
    throw error
  }
}

/**
 * The principal behind `request`, or the response that refuses it. The door is
 * chosen by the credential the request carries: the service-token header is
 * Piloti's, anything else is judged as a bearer token.
 */
export async function resolvePrincipal(
  request: Request,
  deps: PrincipalDeps = {},
): Promise<AgentPrincipal | AuthChallenge> {
  if (request.headers.has(INTERNAL_TOKEN_HEADER)) return pilotiPrincipal(request)
  return externalPrincipal(request, deps)
}

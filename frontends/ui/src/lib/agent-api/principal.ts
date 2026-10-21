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
 *  - A PLATFORM OPERATOR's agent knocks on the platform door
 *    (`/api/platform/mcp`, ADR-0126) with an AuthKit token for that door's
 *    audience alone, issued in the GRID Platform organization, held by a person
 *    who is platform staff. Its principal carries `door: 'platform'`, which is
 *    all the policy needs to offer the operator console and nothing else.
 *    Piloti's credential never opens it.
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
import { FRESH_MEMBERSHIP_TTL_MS } from '@/lib/authz/project-membership'
import { FEATURE_FLAGS, type KnownFeatureFlag } from '@/lib/authz/feature-flags'
import { getPlatformOrganizationId, isPlatformStaff } from '@/lib/authz/platform'
import { isUuid } from '@/lib/ids'
import { INTERNAL_TOKEN_HEADER, requireInternalToken } from '@/lib/internal-auth'
import { isOrgFeatureEnabled } from '@/lib/workos/feature-flags'
import { type DoorResource, acceptedAudiences, authkitDomain, authkitIssuer, doorOf, doorResourceUrl } from './mcp-config'
import { SENSITIVITIES, type Sensitivity } from './operation'
import type { AgentDoor } from './policy'

/**
 * Who acts, in the words of OAuth token exchange (RFC 8693): the SUBJECT is the
 * person the call is for (`session`), the ACTOR is the agent doing it, and the
 * CLIENT is the OAuth client that holds the token (`clientId`). `external_agent`:
 * an agent outside Piloti (Claude, Cursor, ChatGPT) on the person's OAuth token.
 * `piloti`: the in-product agent, echoing the turn's signed envelope.
 */
export type AgentActor = 'external_agent' | 'piloti'

export interface AgentPrincipal {
  /** The agent that acts ({@link AgentActor}). Until October 2026 this was `kind: 'person' | 'piloti'`. */
  actor: AgentActor
  /** The subject: the person the call acts for, as a live-resolved session with their rights. */
  session: AuthorizedSession
  /** The OAuth client that holds the token; `null` for Piloti. */
  clientId: string | null
  scopes: string[]
  /** The chat the call belongs to (Piloti only). */
  conversationId?: string | null
  /** The project the turn runs in (Piloti only). */
  projectId?: string | null
  /**
   * The answer the turn is writing (Piloti only), from {@link ANSWER_MESSAGE_HEADER}: the id the
   * agent mints for it (`turn_answer_message_id`), marked in `message_restricted_use` when a read
   * runs in a conversation that drew on a restricted folder (ADR-0093). Unsigned, like the
   * `answerMessageId` the internal routes take in their bodies: it only ever narrows.
   */
  answerMessageId?: string | null
  /**
   * The sensitivity classes the organization switched on for its agents
   * ({@link SENSITIVE_OPT_IN_FLAGS}), read when the token is verified. Absent or
   * empty: no operation with a `sensitivity` is offered. Never set for Piloti.
   */
  sensitiveOptIns?: readonly Sensitivity[]
  /**
   * The catalog door the principal was resolved on (`policy.ts`, `DOOR_DOMAINS`):
   * `platform` on the platform door, absent on an office door. Set here from the
   * endpoint the verified token's audience binds, never from anything a request says.
   */
  door?: AgentDoor
}

/** The organization's opt-in per sensitivity class (ADR-0121, "Sensitive operations"). */
export const SENSITIVE_OPT_IN_FLAGS: Readonly<Record<Sensitivity, KnownFeatureFlag>> = {
  access: FEATURE_FLAGS.agentMcpAccess,
  secret: FEATURE_FLAGS.agentMcpSecrets,
  control: FEATURE_FLAGS.agentMcpControls,
}

/** The classes whose opt-in flag is on for `organizationId`; a failed lookup reads as off. */
async function sensitiveOptInsOf(organizationId: string): Promise<Sensitivity[]> {
  const on = await Promise.all(
    SENSITIVITIES.map((sensitivity) => isOrgFeatureEnabled(SENSITIVE_OPT_IN_FLAGS[sensitivity], organizationId)),
  )
  return SENSITIVITIES.filter((_, index) => on[index] === true)
}

/** The header Piloti names the turn's answer in; anything but a uuid is ignored. */
export const ANSWER_MESSAGE_HEADER = 'x-grid-answer-message-id'

/** A request that did not authenticate, with the answer to send. */
export interface AuthChallenge {
  kind: 'challenge'
  response: Response
}

export function isChallenge(value: AgentPrincipal | AuthChallenge): value is AuthChallenge {
  return 'kind' in value && value.kind === 'challenge'
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

/** The audience of `aud` (a string or a list) that this server accepts, as a URL; null when none is. */
function acceptedAudienceOf(aud: unknown, accepted: readonly string[]): URL | null {
  const named = (Array.isArray(aud) ? aud : [aud]).filter((value): value is string => typeof value === 'string')
  const match = named.find((value) => accepted.includes(value))
  return match ? new URL(match) : null
}

/**
 * Verifies an AuthKit access token as an MCP Auth token for `door`. On an office
 * door its `aud` may name either office door (`acceptedAudiences`): both are this
 * server's resources and act with the same rights. On the platform door it must
 * name the platform door, and a platform-door token is refused on an office door.
 * `jwtVerify`'s audience check is the binding (RFC 8707), and `AuthInfo.resource`
 * is the audience the token really names, not the door it was sent to. Exported
 * for the spec.
 */
export function tokenVerifier(
  domain: string,
  issuer: string,
  deps: PrincipalDeps,
  door: DoorResource = 'mcp',
): OAuthTokenVerifier {
  const audiences = acceptedAudiences(door)
  return {
    async verifyAccessToken(token): Promise<AuthInfo> {
      try {
        const { payload } = await jwtVerify(token, keysFor(domain, deps), {
          issuer,
          audience: audiences,
          algorithms: ['RS256'],
        })
        const scope = stringClaim(payload.scope)
        const resource = acceptedAudienceOf(payload.aud, audiences)
        if (!resource) throw new OAuthError(OAuthErrorCode.InvalidToken, 'Token was not issued for this resource')
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
  const door = doorOf(request)
  const domain = authkitDomain()
  const issuer = authkitIssuer()
  const resource = doorResourceUrl(door)
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
      // No `expectedResource`: the door's audience group is accepted, and the verifier checks it.
      verifier: tokenVerifier(domain, issuer, deps, door),
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

  if (door === 'platform') return platformPrincipal(auth, userId, organizationId)

  if (!(await isOrgFeatureEnabled(FEATURE_FLAGS.agentMcp, organizationId))) {
    return refuse(403, 'Agent access (MCP) is not enabled for this organization.')
  }

  const session = await freshSession(userId, organizationId)
  if (!session) return refuse(403, 'You are not a member of this organization.')

  return {
    actor: 'external_agent',
    session,
    clientId: auth.clientId || null,
    scopes: auth.scopes,
    sensitiveOptIns: await sensitiveOptInsOf(organizationId),
  }
}

/**
 * A token outlives the membership it was issued for; the fresh lookup makes a
 * removal or a role change bite within a minute here, not the session cache's ten.
 */
function freshSession(userId: string, organizationId: string): Promise<AuthorizedSession | null> {
  return resolvePinnedRequesterSession({ userId, email: null, organizationId }, { membershipTtlMs: FRESH_MEMBERSHIP_TTL_MS })
}

/**
 * The platform door's caller (ADR-0126): a token issued in the GRID Platform
 * organization, which has switched the door on (`platform-agent-mcp`), for a
 * person who is platform staff there now. Staff is the precondition only, as in
 * the console: every operation's route still asks for its own `platform:*`
 * permission. A token of any other organization is refused, platform staff's
 * own included, since only the platform organization's membership carries the
 * platform role.
 */
async function platformPrincipal(auth: AuthInfo, userId: string, organizationId: string): Promise<AgentPrincipal | AuthChallenge> {
  const platformOrganizationId = await getPlatformOrganizationId()
  // Not provisioned, or WorkOS did not answer: the door cannot tell who is staff, so it is closed for now.
  if (!platformOrganizationId) return refuse(503, 'The platform organization could not be resolved. Try again shortly.')
  if (organizationId !== platformOrganizationId) {
    return refuse(
      403,
      'The platform door takes tokens of the GRID Platform organization only. Sign in to Piloti in that organization and authorize the client again.',
    )
  }
  if (!(await isOrgFeatureEnabled(FEATURE_FLAGS.platformAgentMcp, organizationId))) {
    return refuse(403, 'Agent access to the platform console (MCP) is not enabled.')
  }
  const session = await freshSession(userId, organizationId)
  if (!session) return refuse(403, 'You are not a member of the GRID Platform organization.')
  if (!(await isPlatformStaff(session))) return refuse(403, 'You hold no platform permission.')

  return {
    actor: 'external_agent',
    session,
    clientId: auth.clientId || null,
    scopes: auth.scopes,
    sensitiveOptIns: await sensitiveOptInsOf(organizationId),
    door: 'platform',
  }
}

function answerMessageIdOf(request: Request): string | null {
  const value = request.headers.get(ANSWER_MESSAGE_HEADER)?.trim()
  return value && isUuid(value) ? value : null
}

async function pilotiPrincipal(request: Request): Promise<AgentPrincipal | AuthChallenge> {
  const denied = requireInternalToken(request, 'mcp')
  if (denied) return challenge(denied)
  try {
    const context = requireVerifiedContext(request)
    const session = await requirePinnedSession(context)
    return {
      actor: 'piloti',
      session,
      clientId: null,
      scopes: [],
      conversationId: context.conversationId,
      projectId: context.projectId,
      answerMessageId: answerMessageIdOf(request),
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
 * Piloti's, anything else is judged as a bearer token. Piloti's credential never
 * opens the platform door: in-product Piloti works for an office.
 */
export async function resolvePrincipal(
  request: Request,
  deps: PrincipalDeps = {},
): Promise<AgentPrincipal | AuthChallenge> {
  if (request.headers.has(INTERNAL_TOKEN_HEADER)) {
    if (doorOf(request) === 'platform') return refuse(403, 'Piloti does not use the platform door.')
    return pilotiPrincipal(request)
  }
  return externalPrincipal(request, deps)
}

/**
 * Where the agent doors live and who vouches for the tokens they accept
 * (ADR-0121, ADR-0123).
 *
 * One module, because three things must agree to the character: the audience a
 * bearer token has to carry, the `resource` the protected-resource metadata
 * advertises, and the URL the 401 challenge points a client at. Read from the
 * environment at call time so a spec can set it and a deployment change needs no
 * rebuild.
 *
 * Two doors, two resources (RFC 8707): the MCP server at `/api/mcp` and the A2A
 * server at `/api/a2a`. Both are this server, verify a token the same way and
 * act as the same person with the same rights, so each accepts a token issued
 * for either (`acceptedAudiences`); a token for anything else is refused.
 */

import { type OAuthMetadata, buildOAuthProtectedResourceMetadata } from '@modelcontextprotocol/server'
import { configuredAppOrigin } from '@/lib/app-origin'

export const MCP_PATH = '/api/mcp'
export const A2A_PATH = '/api/a2a'

/** The two doors an external agent knocks on, each its own protected resource. */
export type AgentDoor = 'mcp' | 'a2a'

/** Scopes a client may ask WorkOS for. `piloti:sensitive` is not among them until WorkOS defines it. */
export const MCP_SCOPES_SUPPORTED = ['openid', 'profile', 'email', 'offline_access'] as const

type Env = Record<string, string | undefined>

/** The AuthKit domain without scheme or trailing slash, or `null` when unset. */
export function authkitDomain(env: Env = process.env): string | null {
  const raw = env.WORKOS_AUTHKIT_DOMAIN?.trim()
  if (!raw) return null
  const bare = raw.replace(/^https?:\/\//, '').replace(/\/+$/, '')
  return bare || null
}

/** The issuer WorkOS puts in `iss`, or `null` when no AuthKit domain is configured. */
export function authkitIssuer(env: Env = process.env): string | null {
  const domain = authkitDomain(env)
  return domain ? `https://${domain}` : null
}

/**
 * The canonical URL of the MCP server: `GRID_MCP_RESOURCE_URL`, else the
 * deployment's pinned app origin plus `/api/mcp`. `null` when neither exists
 * (a local dev server with no redirect URI), in which case the external door is
 * closed rather than guessing an audience.
 */
export function mcpResourceUrl(env: Env = process.env): URL | null {
  const configured = env.GRID_MCP_RESOURCE_URL?.trim()
  try {
    if (configured) return new URL(configured)
    const origin = configuredAppOrigin(env)
    return origin ? new URL(MCP_PATH, origin) : null
  } catch {
    return null
  }
}

/** The A2A server's resource: the MCP resource's origin plus `/api/a2a`, or `null` when there is none. */
export function a2aResourceUrl(env: Env = process.env): URL | null {
  const mcp = mcpResourceUrl(env)
  return mcp ? new URL(A2A_PATH, mcp.origin) : null
}

/** The resource `door` is. */
export function doorResourceUrl(door: AgentDoor, env: Env = process.env): URL | null {
  return door === 'a2a' ? a2aResourceUrl(env) : mcpResourceUrl(env)
}

/** The door a request knocks on, by its path. */
export function doorOf(request: Request): AgentDoor {
  return new URL(request.url).pathname.startsWith(A2A_PATH) ? 'a2a' : 'mcp'
}

/**
 * Every `aud` a token may carry on either door: both resources, each with and
 * without a trailing slash, since a client may spell it either way.
 */
export function acceptedAudiences(env: Env = process.env): string[] {
  const resources = [mcpResourceUrl(env), a2aResourceUrl(env)].filter((url): url is URL => url !== null)
  return [...new Set(resources.flatMap((url) => [url.href, url.href.replace(/\/$/, '')]))]
}

/** Hostnames a browser request to the endpoint may come from; the app's own. */
export function allowedOriginHostnames(env: Env = process.env): string[] {
  const hosts = new Set<string>()
  const origin = configuredAppOrigin(env)
  if (origin) hosts.add(new URL(origin).hostname)
  const resource = mcpResourceUrl(env)
  if (resource) hosts.add(resource.hostname)
  if (hosts.size === 0) return ['localhost', '127.0.0.1', '[::1]']
  return [...hosts]
}

/** The RFC 9728 document for `door`, or `null` while no AuthKit domain or resource URL is set. */
export function protectedResourceMetadata(env: Env = process.env, door: AgentDoor = 'mcp') {
  const issuer = authkitIssuer(env)
  const resource = doorResourceUrl(door, env)
  if (!issuer || !resource) return null
  // `buildOAuthProtectedResourceMetadata` wants the authorization server's
  // metadata and reads only its `issuer`; the endpoints are AuthKit's own.
  const oauthMetadata: OAuthMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/oauth2/authorize`,
    token_endpoint: `${issuer}/oauth2/token`,
    registration_endpoint: `${issuer}/oauth2/register`,
    response_types_supported: ['code'],
  }
  return {
    ...buildOAuthProtectedResourceMetadata({
      oauthMetadata,
      resourceServerUrl: resource,
      scopesSupported: [...MCP_SCOPES_SUPPORTED],
      resourceName: 'Piloti',
    }),
    bearer_methods_supported: ['header'],
  }
}

/** The metadata response the `.well-known` routes answer with: the MCP door's unless `door` says otherwise. */
export function protectedResourceMetadataResponse(door: AgentDoor = 'mcp'): Response {
  const metadata = protectedResourceMetadata(process.env, door)
  if (!metadata) {
    return Response.json(
      { error: 'The agent door is not configured on this deployment (WORKOS_AUTHKIT_DOMAIN)' },
      { status: 503 },
    )
  }
  return Response.json(metadata, {
    headers: {
      // Public by specification: an MCP client reads it before it has a credential.
      'access-control-allow-origin': '*',
      'cache-control': 'public, max-age=300',
    },
  })
}

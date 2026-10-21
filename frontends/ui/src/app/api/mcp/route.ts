/**
 * The agent door: Piloti's MCP server (ADR-0121).
 *
 * `POST /api/mcp` speaks MCP (spec 2026-07-28, stateless; 2025-era clients are
 * served by the SDK's stateless legacy fallback). One endpoint serves every
 * agent: an external one holding a WorkOS AuthKit token, and Piloti in-product
 * echoing the turn's signed envelope. `lib/agent-api/principal.ts` tells them
 * apart and resolves who they act for; the operations then run the browser's own
 * route handlers as that person, so each route's `authz` still decides.
 *
 * Hand-rolled instead of `apiRoute`: the response is the SDK's, and the
 * authentication is a bearer challenge with `WWW-Authenticate`, not the cookie
 * session the factory resolves (see `authz-coverage.spec.ts`).
 */

import { type AuthInfo, createMcpHandler, originValidationResponse } from '@modelcontextprotocol/server'
import { allowedOriginHostnames } from '@/lib/agent-api/mcp-config'
import { buildMcpServer, resolveMode } from '@/lib/agent-api/mcp-server'
import { type AgentPrincipal, isChallenge, resolvePrincipal } from '@/lib/agent-api/principal'
import type { McpMode } from '@/lib/agent-api/telemetry'
import { tenantSlotRoute } from '@/lib/db/tenant-context'

export const dynamic = 'force-dynamic'

/**
 * One handler for the process; the principal reaches the per-request server
 * factory through the SDK's `authInfo` pass-through, the documented way to key
 * a factory off the caller. (A handler per request would also repeat the SDK's
 * one-time `responseMode` warning on every call.)
 */
const handler = createMcpHandler(
  (context) => {
    const { principal, mode } = context.authInfo?.extra as { principal: AgentPrincipal; mode: McpMode }
    return buildMcpServer(principal, mode)
  },
  {
    legacy: 'stateless',
    responseMode: 'json',
    onerror: (error) => console.error('[mcp]', error.message),
  },
)

export const POST = tenantSlotRoute(async (request: Request): Promise<Response> => {
  // Browsers attach Origin; agents and desktop clients do not. A page on another
  // origin must not be able to drive a signed-in person's agent.
  const rejected = originValidationResponse(request, allowedOriginHostnames())
  if (rejected) return rejected

  const principal = await resolvePrincipal(request)
  if (isChallenge(principal)) return principal.response

  // Not the bearer token: nothing downstream may be able to forward it.
  const authInfo: AuthInfo = {
    token: '',
    clientId: principal.clientId ?? 'piloti',
    scopes: principal.scopes,
    extra: { principal, mode: resolveMode(request) },
  }
  return handler.fetch(request, { authInfo })
})

/** Stateless: there is no session to resume (GET) or end (DELETE). */
const methodNotAllowed = (): Response =>
  new Response('Method not allowed.', { status: 405, headers: { Allow: 'POST' } })

export const GET = methodNotAllowed
export const DELETE = methodNotAllowed

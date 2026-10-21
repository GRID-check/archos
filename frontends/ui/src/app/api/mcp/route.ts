/**
 * The agent door: Piloti's MCP server (ADR-0122).
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

import { type AuthInfo, originValidationResponse } from '@modelcontextprotocol/server'
import { allowedOriginHostnames } from '@/lib/agent-api/mcp-config'
import { principalOrRefusal } from '@/lib/agent-api/door-principal'
import { createAgentDoorHandler, resolveMode } from '@/lib/agent-api/mcp-server'
import { errorResponse } from '@/lib/api/handler'
import { tenantSlotRoute } from '@/lib/db/tenant-context'
import { MCP_REQUEST_LIMIT, enforceLimit, memberSubject } from '@/lib/limits'

export const dynamic = 'force-dynamic'

/**
 * One handler for the process; the principal reaches the per-request server
 * factory through the SDK's `authInfo` pass-through, the documented way to key
 * a factory off the caller. A legacy-protocol client that accepts only
 * `application/json` gets one JSON body (`createAgentDoorHandler`).
 */
const handler = createAgentDoorHandler((error) => console.error('[mcp]', error.message))

/**
 * A JSON-RPC batch (a body that is an array). MCP dropped batching in its
 * 2025-06-18 revision; the SDK still accepts one for older clients, and a
 * batch would run up to the SDK's hundred calls under the ONE charge below.
 * Read from a clone, so the handler still reads the body.
 */
async function isBatch(request: Request): Promise<boolean> {
  try {
    return (await request.clone().text()).trimStart().startsWith('[')
  } catch {
    return false
  }
}

/** One JSON-RPC message per POST, so one charge of the request limit covers one call. */
const batchRefused = (): Response =>
  Response.json(
    {
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32600,
        message: 'Batch requests are not supported: send one JSON-RPC message per POST.',
      },
    },
    { status: 400 },
  )

export const POST = tenantSlotRoute(async (request: Request): Promise<Response> => {
  // Browsers attach Origin; agents and desktop clients do not. A page on another
  // origin must not be able to drive a signed-in person's agent.
  const rejected = originValidationResponse(request, allowedOriginHostnames())
  if (rejected) return rejected

  if (await isBatch(request)) return batchRefused()

  const principal = await principalOrRefusal(request, 'mcp')
  if (principal instanceof Response) return principal

  // Once per HTTP request, after the caller is known and before any tool runs
  // (ADR-0040). The routes it dispatches to still charge their own rules.
  try {
    await enforceLimit(MCP_REQUEST_LIMIT, memberSubject(principal.session))
  } catch (error) {
    return errorResponse(error, request)
  }

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

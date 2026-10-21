import 'server-only'
/**
 * The HTTP edge of an MCP door, shared by the office door (`/api/mcp`, ADR-0121)
 * and the platform door (`/api/platform/mcp`, ADR-0126). One edge, so the two
 * cannot drift: the origin check, the batch refusal, the principal (and its JSON
 * 503 while WorkOS cannot answer), one charge of the agent budget, then the same
 * handler factory, catalog and dispatch. What differs is decided before this
 * runs, by the principal: which audience its token carries, which organization
 * it belongs to, and so which door's operations it is offered.
 *
 * Hand-rolled instead of `apiRoute`: the response is the SDK's, and the
 * authentication is a bearer challenge with `WWW-Authenticate`, not the cookie
 * session the factory resolves (see `authz-coverage.spec.ts`).
 */

import { type AuthInfo, originValidationResponse } from '@modelcontextprotocol/server'
import { errorResponse } from '@/lib/api/handler'
import { tenantSlotRoute } from '@/lib/db/tenant-context'
import { MCP_REQUEST_LIMIT, enforceLimit, memberSubject } from '@/lib/limits'
import { principalOrRefusal } from './door-principal'
import { allowedOriginHostnames } from './mcp-config'
import { createAgentDoorHandler, resolveMode } from './mcp-server'
import { type AgentDoor, doorOfPrincipal } from './policy'

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

/**
 * The `POST` handler of the MCP door for `door`. `label` names the door in logs.
 *
 * One handler for the process; the principal reaches the per-request server
 * factory through the SDK's `authInfo` pass-through, the documented way to key
 * a factory off the caller. A legacy-protocol client that accepts only
 * `application/json` gets one JSON body (`createAgentDoorHandler`).
 */
export function mcpDoorPost(door: AgentDoor, label: string) {
  const handler = createAgentDoorHandler((error) => console.error(`[${label}]`, error.message))
  return tenantSlotRoute(async (request: Request): Promise<Response> => {
    // Browsers attach Origin; agents and desktop clients do not. A page on another
    // origin must not be able to drive a signed-in person's agent.
    const rejected = originValidationResponse(request, allowedOriginHostnames())
    if (rejected) return rejected

    if (await isBatch(request)) return batchRefused()

    const principal = await principalOrRefusal(request, label)
    if (principal instanceof Response) return principal
    // The principal's door follows from the token's audience, which follows from
    // the path; this holds the two together should either ever change.
    if (doorOfPrincipal(principal) !== door) {
      return Response.json({ error: 'This credential is for another door.', code: 'FORBIDDEN' }, { status: 403 })
    }

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
}

/** Stateless: there is no session to resume (GET) or end (DELETE). */
export const mcpDoorMethodNotAllowed = (): Response =>
  new Response('Method not allowed.', { status: 405, headers: { Allow: 'POST' } })

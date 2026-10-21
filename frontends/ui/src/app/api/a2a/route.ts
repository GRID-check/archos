/**
 * The A2A door (ADR-0123): Piloti as an A2A server, JSON-RPC over HTTP, for
 * agents that speak the Agent2Agent protocol rather than MCP.
 *
 * `POST /api/a2a` takes A2A 1.0 (`SendMessage`, `SendStreamingMessage`,
 * `GetTask`, `CancelTask`, `SubscribeToTask`) when the request says
 * `A2A-Version: 1.0`, and 0.3 (`message/send`, `message/stream`, `tasks/get`,
 * `tasks/cancel`, `tasks/resubscribe`) when it says 0.3 or nothing, as the
 * specification has it. The official SDK (`@a2a-js/sdk`) parses and
 * serializes; `PilotiA2ARequestHandler` answers each method by calling the ask
 * routes as the person, through the dispatcher.
 *
 * Authenticated exactly as `/api/mcp`: `resolvePrincipal` verifies the WorkOS
 * AuthKit bearer token (issuer, the agent door's audience, the `agent-mcp`
 * flag, the live membership) and answers the RFC 9728 challenge. Piloti's own
 * credential (the internal token with the turn's envelope) is refused: Piloti
 * never asks Piloti (the recursion lock). One unit of the agent door's budget
 * (`mcp-request`) per request; each ask then pays `chat-turn` at its route.
 *
 * Hand-rolled instead of `apiRoute`, for the reasons `/api/mcp` is: a bearer
 * challenge instead of the cookie session, and a body that is the protocol's
 * (`authz-coverage.spec.ts`, `HAND_ROLLED`).
 */

import { LegacyJsonRpcTransportHandler } from '@a2a-js/sdk/compat/v0_3/server'
import { JsonRpcTransportHandler, ServerCallContext } from '@a2a-js/sdk/server'
import { originValidationResponse } from '@modelcontextprotocol/server'
import { buildAgentCard } from '@/lib/a2a/agent-card'
import {
  jsonRpcErrorResponse,
  jsonRpcResponse,
  PARSE_ERROR,
  PILOTI_DOOR_REFUSAL,
  protocolVersionOf,
  VERSION_NOT_SUPPORTED,
} from '@/lib/a2a/http'
import { PilotiA2ARequestHandler } from '@/lib/a2a/request-handler'
import { principalOrRefusal } from '@/lib/agent-api/door-principal'
import { allowedOriginHostnames } from '@/lib/agent-api/mcp-config'
import { errorResponse } from '@/lib/api/handler'
import { tenantSlotRoute } from '@/lib/db/tenant-context'
import { MCP_REQUEST_LIMIT, enforceLimit, memberSubject } from '@/lib/limits'

export const dynamic = 'force-dynamic'

export const POST = tenantSlotRoute(async (request: Request): Promise<Response> => {
  // Browsers attach Origin; agents do not. A page on another origin must not drive a signed-in person's agent.
  const rejected = originValidationResponse(request, allowedOriginHostnames())
  if (rejected) return rejected

  const card = buildAgentCard()
  if (!card) {
    return Response.json(
      { error: 'The agent door is not configured on this deployment (WORKOS_AUTHKIT_DOMAIN)' },
      { status: 503 },
    )
  }

  const principal = await principalOrRefusal(request, 'a2a')
  if (principal instanceof Response) return principal
  if (principal.actor !== 'external_agent') {
    return Response.json({ error: PILOTI_DOOR_REFUSAL, code: 'FORBIDDEN' }, { status: 403 })
  }

  try {
    await enforceLimit(MCP_REQUEST_LIMIT, memberSubject(principal.session))
  } catch (error) {
    return errorResponse(error, request)
  }

  const version = protocolVersionOf(request)
  if (!version) return jsonRpcErrorResponse(VERSION_NOT_SUPPORTED, 'Piloti speaks A2A 1.0 and 0.3.')

  let body: string
  try {
    body = await request.text()
  } catch {
    return jsonRpcErrorResponse(PARSE_ERROR, 'The request body could not be read.')
  }

  const handler = new PilotiA2ARequestHandler(principal.session, card)
  const context = new ServerCallContext({ requestedVersion: version })
  const transport =
    version === '1.0' ? new JsonRpcTransportHandler(handler) : new LegacyJsonRpcTransportHandler(handler)
  return jsonRpcResponse(await transport.handle(body, context))
})

/** JSON-RPC over POST only; the agent card is at `/.well-known/agent-card.json`. */
const methodNotAllowed = (): Response =>
  new Response('Method not allowed.', { status: 405, headers: { Allow: 'POST' } })

export const GET = methodNotAllowed
export const DELETE = methodNotAllowed

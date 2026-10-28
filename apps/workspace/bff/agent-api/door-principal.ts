import 'server-only'
import { ApiError, ServiceUnavailableError } from '@/lib/api/errors'
import { errorResponse } from '@/lib/api/handler'
import { type AgentPrincipal, isChallenge, resolvePrincipal } from './principal'

/**
 * Who calls a door (`/api/mcp`, `/api/a2a`), or the response that refuses them.
 * Resolving the principal asks WorkOS (the signing keys, the membership, the
 * feature flags); when it cannot answer, the agent gets a JSON 503 it can
 * retry, not an unexplained 500.
 */
export async function principalOrRefusal(request: Request, door: string): Promise<AgentPrincipal | Response> {
  try {
    const principal = await resolvePrincipal(request)
    return isChallenge(principal) ? principal.response : principal
  } catch (error) {
    if (error instanceof ApiError) return errorResponse(error, request)
    console.error(`[${door}] could not resolve the caller`, error)
    return errorResponse(
      new ServiceUnavailableError('Who is calling could not be checked right now. Try again shortly.'),
      request,
    )
  }
}

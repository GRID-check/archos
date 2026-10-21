/**
 * The agent-reachable API as an OpenAPI 3.1 document (ADR-0121).
 *
 * Built from the operation catalog on each request, so it never disagrees with
 * what `/api/mcp` offers. It describes routes that already exist and opens no
 * new access; signed in rather than public, because nothing outside the office
 * needs it.
 */

import { configuredAppOrigin } from '@/lib/app-origin'
import { apiRoute } from '@/lib/api/handler'
import { AGENT_OPERATIONS } from '@/lib/agent-api/catalog'
import { buildOpenApiDocument } from '@/lib/agent-api/openapi'

export const GET = apiRoute(
  async ({ request }) =>
    buildOpenApiDocument(AGENT_OPERATIONS, {
      serverUrl: configuredAppOrigin() ?? new URL(request.url).origin,
    }),
  { authz: { sessionOnly: true, why: 'describes the shape of the API only, no tenant data' } },
)

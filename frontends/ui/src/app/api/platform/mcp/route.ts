/**
 * The platform door: the operator console's MCP server (ADR-0126).
 *
 * `POST /api/platform/mcp` is the same MCP server as `/api/mcp` (spec
 * 2026-07-28, stateless, with the SDK's legacy fallback), built by the same
 * handler factory over the same catalog and dispatcher, offering exactly the
 * `platform` domain. It sits beside the routes it serves, under `/api/platform`,
 * because it is their door and nobody else's; it is not a `platformApiRoute`,
 * since it authenticates a bearer token rather than the console's cookie session.
 *
 * Who gets in (`lib/agent-api/principal.ts`): a WorkOS AuthKit token for THIS
 * resource's audience (an office door's token is refused, and this door's token
 * is refused there), issued in the GRID Platform organization with the
 * `platform-agent-mcp` flag on, for a person who is platform staff now. Piloti's
 * own credential is refused. Every operation then runs its console route as that
 * person, and the route's own `platform:*` permission decides, as in the browser.
 */

import { mcpDoorMethodNotAllowed, mcpDoorPost } from '@/lib/agent-api/mcp-door-route'

export const dynamic = 'force-dynamic'

export const POST = mcpDoorPost('platform', 'platform-mcp')

export const GET = mcpDoorMethodNotAllowed
export const DELETE = mcpDoorMethodNotAllowed

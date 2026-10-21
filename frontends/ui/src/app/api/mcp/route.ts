/**
 * The agent door: Piloti's MCP server (ADR-0121).
 *
 * `POST /api/mcp` speaks MCP (spec 2026-07-28, stateless; 2025-era clients are
 * served by the SDK's stateless legacy fallback). One endpoint serves every
 * agent of an office: an external one holding a WorkOS AuthKit token, and
 * Piloti in-product echoing the turn's signed envelope. `lib/agent-api/principal.ts`
 * tells them apart and resolves who they act for; the operations then run the
 * browser's own route handlers as that person, so each route's `authz` still
 * decides. The operator console has its own door, `/api/platform/mcp`
 * (ADR-0126), and a token for it is refused here.
 *
 * The edge (origin, batch, principal, budget, handler) is `mcpDoorPost`, shared
 * with the platform door so the two cannot drift.
 */

import { mcpDoorMethodNotAllowed, mcpDoorPost } from '@/lib/agent-api/mcp-door-route'

export const dynamic = 'force-dynamic'

export const POST = mcpDoorPost('office', 'mcp')

export const GET = mcpDoorMethodNotAllowed
export const DELETE = mcpDoorMethodNotAllowed

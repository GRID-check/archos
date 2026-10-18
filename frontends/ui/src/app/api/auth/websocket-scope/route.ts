/**
 * Internal WebSocket Collection Scope Endpoint
 *
 * Called by server.js during the WebSocket upgrade handshake. It resolves the
 * current Grid session from the encrypted WorkOS cookie, builds the ordered
 * collection scope, and returns the base64url-encoded header value.
 *
 * The authenticated handshake carries only identity, scope and policy. Prompt blocks are
 * loaded by the authenticated per-turn POST /api/internal/turn-context route,
 * never here: base64 expansion alone can exceed the upstream header-line limit.
 * Anonymous upgrades retain their legacy inline prompt blocks.
 *
 * Every project-scoped lookup uses the EFFECTIVE project id (the authorized
 * scope's project, falling back to the query param) — never the raw query
 * param — so an implicit project from the stored active-project preference is
 * not silently dropped from budget, prompt, Bundesland, memory or decisions.
 */

import { NextResponse } from 'next/server'
import { tenantSlotRoute } from '@/lib/db/tenant-context'
import { getGridSession } from '@/lib/auth/session'
import { resolveTurnContext, TurnBudgetExhaustedError } from '@/lib/turns/turn-context'
import { isAuthzError } from '@/lib/auth-utils'
import { isAuthRequired } from '@/lib/backend-proxy'

export const GET = tenantSlotRoute(async function GET(req: Request): Promise<Response> {
  try {
    const { searchParams } = new URL(req.url)
    const projectId = searchParams.get('projectId') || undefined
    const conversationId = searchParams.get('conversationId') || undefined

    const session = await getGridSession()

    if (isAuthRequired() && !session) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    // The body of this route is `resolveTurnContext`, shared with the wake job
    // that opens a turn as a person (ADR-0106): one resolution, two callers.
    return NextResponse.json(await resolveTurnContext(session, { projectId, conversationId }), { status: 200 })
  } catch (error) {
    if (error instanceof TurnBudgetExhaustedError) {
      return NextResponse.json({ error: 'Budget exhausted', reason: error.message }, { status: 403 })
    }
    if (isAuthzError(error)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    }

    console.error('[WebSocket Scope API] Error:', error)

    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
})

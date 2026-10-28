import { NextResponse } from 'next/server'
import { internalApiRoute, parseJsonBody } from '@/lib/api/handler'
import { requirePinnedSession, requireVerifiedContext } from '@/lib/api/internal-envelope'
import { withTenant } from '@/lib/db/tenant-context'
import { loadTurnContext } from '@/lib/turn-context/service'
import { TurnContextTiming } from '@/lib/turn-context/timing'
import { turnContextRequestSchema } from '@/lib/turn-context/wire'

/**
 * The context one chat turn starts from. `Server-Timing` says where the build's
 * time went (`session`, `access`, each read, `total`); the agent records it on
 * its `setup.project_context` phase in Langfuse.
 */
export const POST = internalApiRoute(
  'Internal Turn Context',
  async ({ request }) => {
    const context = requireVerifiedContext(request)
    const input = await parseJsonBody(request, turnContextRequestSchema)
    const timing = new TurnContextTiming()
    const session = await timing.time('session', () => requirePinnedSession(context))
    const data = await withTenant({ organizationId: context.organizationId, userId: context.userId }, () =>
      loadTurnContext(session, context, input, timing),
    )
    return NextResponse.json({ data }, { headers: { 'Server-Timing': timing.header() } })
  },
  {
    tenancy: { fromPayload: 'verified X-Grid-Request-Context envelope, never the body' },
  },
)

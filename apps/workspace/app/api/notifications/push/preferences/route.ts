/**
 * `/api/notifications/push/preferences` — what the signed-in person wants pushed
 * and whether the lock screen shows content (ADR-0112). Their own, from the
 * session; the answer is always the resolved choices, defaults filled in.
 */

import { apiRoute, parseJsonBody } from '@/lib/api/handler'
import { pushPreferencesPatchSchema } from '@/lib/inbox/push-categories'
import { getPushPreferences, updatePushPreferences } from '@/lib/push/service'

export const GET = apiRoute(async ({ session }) => ({ preferences: await getPushPreferences(session) }), {
  authz: { sessionOnly: true, why: 'the caller’s own preferences, keyed to session.userId' },
})

export const PUT = apiRoute(
  async ({ session, request }) => {
    const patch = await parseJsonBody(request, pushPreferencesPatchSchema)
    return { preferences: await updatePushPreferences(session, patch) }
  },
  { authz: { sessionOnly: true, why: 'the caller’s own preferences, keyed to session.userId' } }
)

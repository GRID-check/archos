/**
 * `GET /api/notifications/push/config` — whether this deployment sends system
 * notifications, and the public key a browser subscribes with (ADR-0112).
 *
 * The public half of the VAPID pair is public by design: it is the
 * `applicationServerKey` every subscription is bound to.
 */

import { apiRoute } from '@/lib/api/handler'
import { getPushConfig } from '@/lib/push/service'

export const GET = apiRoute(async () => getPushConfig(), {
  authz: { sessionOnly: true, why: 'a deployment-wide setting and a public key, nothing scoped below the organization' },
})
